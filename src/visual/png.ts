import { deflateSync, inflateSync } from 'node:zlib';

/**
 * PNG minimal, sans dépendance : lecture des images que Playwright produit (8 bits, RGB ou RGBA,
 * niveaux de gris, non entrelacées) et écriture d'une image RGBA. Suffisant pour comparer deux
 * captures pixel à pixel et dessiner l'image des différences.
 */
export interface RgbaImage {
  width: number;
  height: number;
  /** RGBA, 4 octets par pixel, ligne par ligne. */
  data: Uint8Array;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Décode un PNG 8 bits non entrelacé (gris, gris+alpha, RGB, RGBA) en RGBA. */
export function decodePng(file: Uint8Array): RgbaImage {
  if (SIGNATURE.some((byte, index) => file[index] !== byte)) throw new Error('not a PNG file');
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  let bitDepth = 0;
  const chunks: Uint8Array[] = [];
  while (offset + 8 <= file.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...file.subarray(offset + 4, offset + 8));
    const body = file.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      bitDepth = file[offset + 16] ?? 0;
      colorType = file[offset + 17] ?? 0;
      if ((file[offset + 20] ?? 0) !== 0) throw new Error('interlaced PNG files are not supported');
    } else if (type === 'IDAT') chunks.push(body);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${String(bitDepth)}`);
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (channels === undefined) throw new Error(`unsupported PNG colour type ${String(colorType)}`);
  const raw = inflateSync(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
  const stride = width * channels;
  const pixels = new Uint8Array(stride * height);
  let position = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[position] ?? 0;
    position += 1;
    const row = y * stride;
    const previous = row - stride;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[position + x] ?? 0;
      const left = x >= channels ? (pixels[row + x - channels] ?? 0) : 0;
      const up = y > 0 ? (pixels[previous + x] ?? 0) : 0;
      const upLeft = y > 0 && x >= channels ? (pixels[previous + x - channels] ?? 0) : 0;
      let decoded = value;
      if (filter === 1) decoded = value + left;
      else if (filter === 2) decoded = value + up;
      else if (filter === 3) decoded = value + ((left + up) >> 1);
      else if (filter === 4) decoded = value + paeth(left, up, upLeft);
      pixels[row + x] = decoded & 0xff;
    }
    position += stride;
  }
  const data = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const source = index * channels;
    const target = index * 4;
    if (channels === 1) {
      const gray = pixels[source] ?? 0;
      data.set([gray, gray, gray, 255], target);
    } else if (channels === 2) {
      const gray = pixels[source] ?? 0;
      data.set([gray, gray, gray, pixels[source + 1] ?? 255], target);
    } else if (channels === 3)
      data.set([pixels[source] ?? 0, pixels[source + 1] ?? 0, pixels[source + 2] ?? 0, 255], target);
    else data.set(pixels.subarray(source, source + 4), target);
  }
  return { width, height, data };
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  out.set(
    type.split('').map((char) => char.charCodeAt(0)),
    4,
  );
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

/** Encode une image RGBA en PNG (sans filtre, compression zlib). */
export function encodePng(image: RgbaImage): Uint8Array {
  const stride = image.width * 4;
  const raw = new Uint8Array((stride + 1) * image.height);
  for (let y = 0; y < image.height; y += 1) {
    raw[y * (stride + 1)] = 0;
    raw.set(image.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, image.width);
  view.setUint32(4, image.height);
  header.set([8, 6, 0, 0, 0], 8);
  const parts = [
    new Uint8Array(SIGNATURE),
    chunk('IHDR', header),
    chunk('IDAT', new Uint8Array(deflateSync(Buffer.from(raw)))),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
