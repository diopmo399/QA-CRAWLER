import { inflateRawSync } from 'node:zlib';
import { ConnectorError } from '../connector.js';

/**
 * UN LECTEUR ZIP MINIMAL ET DÉFENSIF (décision D2) pour les documents Office Open XML (.docx, .xlsx).
 * Il lit en mémoire, n'écrit jamais de fichier (aucun chemin d'entrée n'est utilisé sur le disque) et
 * borne tout ce qu'un fichier hostile pourrait faire grossir :
 *   - nombre d'entrées, taille de chaque entrée et taille totale décompressée ;
 *   - taux de compression suspect (bombe de décompression), vérifié AVANT de décompresser ;
 *   - décompression plafonnée à la taille déclarée (zlib `maxOutputLength`), CRC vérifié.
 * Refusés : archives chiffrées, ZIP64, multi-volumes, méthodes autres que « stockée » et « deflate ».
 */
export interface ZipLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
  /** Taux décompressé / compressé au-delà duquel une entrée de plus d'1 Mo est refusée. */
  maxRatio: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 20_000,
  maxEntryBytes: 100 * 1024 * 1024,
  maxTotalBytes: 300 * 1024 * 1024,
  maxRatio: 200,
};

interface Entry {
  name: string;
  method: number;
  flags: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

export interface ZipArchive {
  names: string[];
  has(name: string): boolean;
  /** Le contenu d'une entrée (texte UTF-8), ou undefined si elle n'existe pas. */
  text(name: string): string | undefined;
}

const corrupted = (message: string): ConnectorError => new ConnectorError('CORRUPTED', message);

export function openZip(data: Uint8Array, limits: ZipLimits = DEFAULT_ZIP_LIMITS): ZipArchive {
  const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (buffer.length >= 8 && buffer.readUInt32BE(0) === 0xd0cf11e0)
    throw new ConnectorError(
      'UNSUPPORTED',
      'this is a protected or legacy Office file (compound document), not an Office Open XML archive: save it as .docx/.xlsx without a password',
    );
  const eocd = findEndOfCentralDirectory(buffer);
  const disk = buffer.readUInt16LE(eocd + 4);
  const count = buffer.readUInt16LE(eocd + 10);
  const directorySize = buffer.readUInt32LE(eocd + 12);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  if (disk !== 0) throw new ConnectorError('UNSUPPORTED', 'multi-volume archives are not supported');
  if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff)
    throw new ConnectorError('UNSUPPORTED', 'ZIP64 archives are not supported');
  if (count > limits.maxEntries)
    throw new ConnectorError('TOO_LARGE', `more than ${String(limits.maxEntries)} entries in the archive`);
  if (directoryOffset + directorySize > eocd) throw corrupted('the archive directory is out of bounds');
  const entries = new Map<string, Entry>();
  let position = directoryOffset;
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    if (position + 46 > buffer.length || buffer.readUInt32LE(position) !== 0x02014b50)
      throw corrupted('broken archive directory');
    const flags = buffer.readUInt16LE(position + 8);
    const nameLength = buffer.readUInt16LE(position + 28);
    const extraLength = buffer.readUInt16LE(position + 30);
    const commentLength = buffer.readUInt16LE(position + 32);
    const nameBytes = buffer.subarray(position + 46, position + 46 + nameLength);
    const entry: Entry = {
      name: nameBytes.toString(flags & 0x0800 ? 'utf8' : 'latin1'),
      method: buffer.readUInt16LE(position + 10),
      flags,
      crc: buffer.readUInt32LE(position + 16),
      compressedSize: buffer.readUInt32LE(position + 20),
      size: buffer.readUInt32LE(position + 24),
      localOffset: buffer.readUInt32LE(position + 42),
    };
    if (entry.size === 0xffffffff || entry.compressedSize === 0xffffffff || entry.localOffset === 0xffffffff)
      throw new ConnectorError('UNSUPPORTED', 'ZIP64 entries are not supported');
    total += entry.size;
    if (entry.size > limits.maxEntryBytes || total > limits.maxTotalBytes)
      throw new ConnectorError('TOO_LARGE', 'the archive expands beyond the size limit');
    entries.set(entry.name, entry);
    position += 46 + nameLength + extraLength + commentLength;
  }
  const read = (name: string): Buffer | undefined => {
    const entry = entries.get(name);
    if (!entry) return undefined;
    if (entry.flags & 0x0001)
      throw new ConnectorError('UNSUPPORTED', 'the archive is encrypted (password protected)');
    if (entry.size > 1024 * 1024 && entry.size / Math.max(1, entry.compressedSize) > limits.maxRatio)
      throw new ConnectorError('TOO_LARGE', `${name}: suspicious compression ratio (decompression bomb?)`);
    const local = entry.localOffset;
    if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== 0x04034b50)
      throw corrupted(`${name}: broken local header`);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const raw = buffer.subarray(start, start + entry.compressedSize);
    if (raw.length !== entry.compressedSize) throw corrupted(`${name}: truncated entry`);
    let content: Buffer;
    if (entry.method === 0) content = raw;
    else if (entry.method === 8) {
      try {
        content = inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.size) });
      } catch (error) {
        throw (error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE'
          ? new ConnectorError('TOO_LARGE', `${name}: expands beyond its declared size (decompression bomb?)`)
          : corrupted(`${name}: invalid compressed data`);
      }
    } else
      throw new ConnectorError(
        'UNSUPPORTED',
        `${name}: compression method ${String(entry.method)} is not supported`,
      );
    if (content.length !== entry.size || crc32(content) !== entry.crc)
      throw corrupted(`${name}: content does not match its checksum`);
    return content;
  };
  return {
    names: [...entries.keys()],
    has: (name) => entries.has(name),
    text: (name) => read(name)?.toString('utf8'),
  };
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const lowest = Math.max(0, buffer.length - 22 - 0xffff);
  for (let position = buffer.length - 22; position >= lowest; position -= 1)
    if (buffer.readUInt32LE(position) === 0x06054b50) return position;
  throw corrupted('not a ZIP archive (no end of central directory)');
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
