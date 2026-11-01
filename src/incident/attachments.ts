import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ATTACHMENT_TYPES, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_NAME, type AttachmentType } from './model.js';

/**
 * LES PIÈCES JOINTES D'UN INCIDENT : captures (PNG, JPEG, WEBP) et textes (journaux, exports JSON). Le
 * type déclaré n'est jamais cru sur parole : les octets sont examinés (signature des images, texte UTF-8
 * valide sans octet nul, JSON lisible). Le fichier est rangé sous `<projet>/incidents/<id>/attachments/`
 * sous son identifiant, jamais sous le nom donné (nettoyé, il ne sert qu'à l'affichage).
 */

export type AttachmentErrorCode =
  'INVALID' | 'TOO_LARGE' | 'UNSUPPORTED_TYPE' | 'CONTENT_MISMATCH' | 'TOO_MANY';

export class AttachmentError extends Error {
  constructor(
    readonly code: AttachmentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AttachmentError';
  }
}

const ATTACHMENT_ID = /^att_[A-Za-z0-9_-]{12}$/;

export function isAttachmentId(value: string): boolean {
  return ATTACHMENT_ID.test(value);
}

export function newAttachmentId(): string {
  return `att_${randomBytes(9).toString('base64url')}`;
}

export function isAttachmentType(value: unknown): value is AttachmentType {
  return typeof value === 'string' && (ATTACHMENT_TYPES as readonly string[]).includes(value);
}

/** Le dossier des pièces jointes d'un incident (l'identifiant de l'incident est déjà validé par le store). */
export function attachmentsDir(projectDir: string, incidentId: string): string {
  return path.join(projectDir, 'incidents', incidentId, 'attachments');
}

/** Caractères de contrôle et de mise en forme invisibles (C0, C1, largeur nulle, sens d'écriture). */
const INVISIBLE = new RegExp('[\\p{Cc}\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069]', 'gu');
/** L'indicateur d'ordre des octets en tête d'un texte. */
const BOM = new RegExp('^\\ufeff');

/**
 * Le nom affiché : le dernier segment seulement (aucun dossier, aucune remontée), sans caractère de
 * contrôle ni caractère réservé, borné en conservant l'extension. Vide après nettoyage : refusé.
 */
export function sanitizeAttachmentName(raw: unknown): string {
  if (typeof raw !== 'string') throw new AttachmentError('INVALID', 'name must be a text');
  const last = raw.split(/[\\/]/).pop() ?? '';
  const cleaned = last
    .normalize('NFC')
    .replace(INVISIBLE, '')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+/, '')
    .replace(/[\s.]+$/, '');
  if (cleaned === '') throw new AttachmentError('INVALID', 'name is empty once cleaned (no path allowed)');
  if (cleaned.length <= MAX_ATTACHMENT_NAME) return cleaned;
  const extension = path.extname(cleaned).slice(0, 16);
  return `${cleaned.slice(0, MAX_ATTACHMENT_NAME - extension.length)}${extension}`;
}

/** Le plus long texte base64 qui peut porter MAX_ATTACHMENT_BYTES octets. */
const MAX_BASE64_LENGTH = Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4;

/** Décode le base64 reçu (strict : alphabet standard, remplissage correct) en bornant la taille AVANT. */
export function decodeAttachment(raw: unknown): Buffer {
  if (typeof raw !== 'string') throw new AttachmentError('INVALID', 'dataBase64 must be a text');
  const compact = raw.replace(/\s+/g, '');
  if (compact.length > MAX_BASE64_LENGTH + 4)
    throw new AttachmentError(
      'TOO_LARGE',
      `an attachment is limited to ${String(MAX_ATTACHMENT_BYTES)} bytes`,
    );
  if (compact.length === 0 || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact))
    throw new AttachmentError('INVALID', 'dataBase64 is not valid base64');
  const bytes = Buffer.from(compact, 'base64');
  if (bytes.byteLength === 0) throw new AttachmentError('INVALID', 'the attachment is empty');
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES)
    throw new AttachmentError(
      'TOO_LARGE',
      `an attachment is limited to ${String(MAX_ATTACHMENT_BYTES)} bytes`,
    );
  return bytes;
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0): boolean =>
  bytes.length >= offset + signature.length &&
  signature.every((byte, index) => bytes[offset + index] === byte);

const ascii = (bytes: Uint8Array, offset: number, text: string): boolean =>
  startsWith(bytes, Array.from(Buffer.from(text, 'latin1')), offset);

/** Le texte UTF-8 valide et sans octet nul ; undefined sinon. */
function utf8Text(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** Vérifie que les octets sont bien du type déclaré ; lève CONTENT_MISMATCH sinon. */
export function sniffAttachment(type: AttachmentType, bytes: Uint8Array): void {
  const mismatch = (what: string): never => {
    throw new AttachmentError('CONTENT_MISMATCH', `the content is not ${what} (declared ${type})`);
  };
  switch (type) {
    case 'image/png':
      if (!startsWith(bytes, PNG)) mismatch('a PNG image');
      return;
    case 'image/jpeg':
      if (!startsWith(bytes, JPEG)) mismatch('a JPEG image');
      return;
    case 'image/webp':
      if (!(ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP'))) mismatch('a WEBP image');
      return;
    case 'text/plain':
      if (utf8Text(bytes) === undefined) mismatch('UTF-8 text without NUL bytes');
      return;
    case 'application/json': {
      const text = utf8Text(bytes);
      if (text === undefined) mismatch('UTF-8 text without NUL bytes');
      try {
        JSON.parse((text ?? '').replace(BOM, ''));
      } catch {
        mismatch('valid JSON');
      }
      return;
    }
  }
}

export const isImageType = (type: AttachmentType): boolean => type.startsWith('image/');

/** Écrit le contenu sous son identifiant (jamais d'écrasement). */
export async function writeAttachment(directory: string, id: string, bytes: Uint8Array): Promise<void> {
  if (!isAttachmentId(id)) throw new AttachmentError('INVALID', 'invalid attachment id');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, id), bytes, { flag: 'wx', mode: 0o600 });
}

/** Lit le contenu : un fichier ordinaire (jamais un lien), borné. */
export async function readAttachment(directory: string, id: string): Promise<Buffer> {
  if (!isAttachmentId(id)) throw new AttachmentError('INVALID', 'invalid attachment id');
  const file = path.join(directory, id);
  const info = await lstat(file);
  if (!info.isFile()) throw new AttachmentError('INVALID', 'the attachment is not a regular file');
  if (info.size > MAX_ATTACHMENT_BYTES)
    throw new AttachmentError('TOO_LARGE', 'the stored attachment exceeds the limit');
  return readFile(file);
}

export async function deleteAttachment(directory: string, id: string): Promise<void> {
  if (!isAttachmentId(id)) return;
  await rm(path.join(directory, id), { force: true });
}
