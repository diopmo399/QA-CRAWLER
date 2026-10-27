import { createHash } from 'node:crypto';
import { open, realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import {
  ConnectorError,
  type ConnectorDescription,
  type ExtractionContext,
  type SourceConnector,
} from '../connector.js';
import { cleanText, type Block, type ExtractedDocument } from '../document.js';
import type { ImportIssue } from '../model.js';

/**
 * LE CONNECTEUR PDF (décision D3) : le texte de chaque page, lu par pdf.js (`pdfjs-dist`, dépendance
 * FACULTATIVE, version exacte, Node ≥ 22.13), reconstruit en titres, paragraphes et listes avec le
 * numéro de page de chaque bloc.
 *
 * DURCISSEMENT (pdf.js lit un fichier qui peut être hostile) :
 *   - lecture dans un worker thread à part : mémoire bornée (resourceLimits), délai, nombre de pages
 *     borné ; un PDF piégé qui boucle ou gonfle est arrêté sans toucher le programme ;
 *   - `isEvalSupported: false` (pas de code généré : la classe de failles de CVE-2024-4367),
 *     `disableFontFace`, aucune police système, aucun chargement réseau (données en mémoire,
 *     ni flux ni plages), XFA désactivé ;
 *   - fichier : chemin résolu, fichier ordinaire, en-tête `%PDF-`, taille bornée avant lecture.
 *
 * LIMITES, dites : aucun OCR (une page sans couche texte est signalée, jamais inventée) ; les
 * tableaux sont lus comme des lignes de texte ; un PDF protégé par mot de passe est refusé.
 */
export type PdfInput = ({ file: string } | { data: Uint8Array; name: string }) & {
  /** Identifiant stable de la source (défaut : `pdf:<nom du fichier>`). */
  sourceId?: string;
  maxBytes?: number;
  maxPages?: number;
  timeoutMs?: number;
  /** Mémoire du worker, en Mo. */
  maxMemoryMb?: number;
};

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_PAGES = 500;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MEMORY_MB = 512;
const PDFJS_MODULE = 'pdfjs-dist/legacy/build/pdf.mjs';

/**
 * Les options de pdf.js, fixes : aucun code généré (CVE-2024-4367), aucune police chargée, aucun
 * accès réseau (le document est en mémoire : ni flux, ni plages, ni chargement automatique), pas de XFA.
 */
export const PDFJS_SAFE_OPTIONS = {
  isEvalSupported: false,
  disableFontFace: true,
  useSystemFonts: false,
  disableAutoFetch: true,
  disableStream: true,
  disableRange: true,
  enableXfa: false,
  verbosity: 0,
} as const;

/** Un fragment de texte d'une page, tel que pdf.js le donne (position verticale, hauteur, fin de ligne). */
export interface PdfTextItem {
  str: string;
  y: number;
  height: number;
  eol: boolean;
}

export interface PdfPage {
  number: number;
  items: PdfTextItem[];
  hasImages: boolean;
}

export interface PdfRaw {
  numPages: number;
  pages: PdfPage[];
  title?: string;
  modifiedAt?: string;
}

export class PdfConnector implements SourceConnector<PdfInput> {
  readonly kind = 'PDF';

  constructor(
    private readonly reader: (data: Uint8Array, input: PdfInput) => Promise<PdfRaw> = readInWorker,
  ) {}

  describe(): ConnectorDescription {
    return {
      kind: this.kind,
      label: 'PDF',
      formats: ['.pdf'],
      maxBytes: DEFAULT_MAX_BYTES,
      capabilities: {
        headings: true,
        lists: true,
        tables: false,
        pages: true,
        versions: false,
        refresh: true,
        ocr: false,
      },
      limits: [
        'needs the optional dependency pdfjs-dist and Node 22.13 or later',
        'no OCR: a page without a text layer (scan) is reported and not read',
        'tables are read as lines of text',
        'headings are guessed from the font size (medium confidence at best)',
        'password-protected documents are refused',
      ],
    };
  }

  validate(input: PdfInput): ImportIssue[] {
    const issues: ImportIssue[] = [];
    const name = 'file' in input ? input.file : input.name;
    if (!/\.pdf$/i.test(name))
      issues.push({
        severity: 'ERROR',
        code: 'INVALID_INPUT',
        message: `${path.basename(name)} is not a .pdf file`,
      });
    if ('data' in input && input.data.byteLength > (input.maxBytes ?? DEFAULT_MAX_BYTES))
      issues.push({
        severity: 'ERROR',
        code: 'TOO_LARGE',
        message: `the document is larger than ${String(input.maxBytes ?? DEFAULT_MAX_BYTES)} bytes`,
      });
    return issues;
  }

  async extract(input: PdfInput, context: ExtractionContext): Promise<ExtractedDocument> {
    if (context.signal?.aborted) throw new ConnectorError('CANCELLED', 'import cancelled');
    const data =
      'file' in input ? await readFileLimited(input.file, input.maxBytes ?? DEFAULT_MAX_BYTES) : input.data;
    if (data.byteLength > (input.maxBytes ?? DEFAULT_MAX_BYTES))
      throw new ConnectorError(
        'TOO_LARGE',
        `the document is larger than ${String(input.maxBytes ?? DEFAULT_MAX_BYTES)} bytes`,
      );
    if (Buffer.from(data.subarray(0, 5)).toString('latin1') !== '%PDF-')
      throw new ConnectorError('CORRUPTED', 'the file does not start with %PDF-: not a PDF document');
    const raw = await this.reader(data, input);
    const name = path.basename('file' in input ? input.file : input.name);
    const { blocks, issues } = pdfToBlocks(raw);
    const unread = issues.some(
      (issue) => issue.code === 'PAGE_WITHOUT_TEXT' || issue.code === 'PAGES_NOT_READ',
    );
    return {
      source: {
        kind: this.kind,
        sourceId: input.sourceId ?? `pdf:${name}`,
        title: raw.title?.trim() || name,
        ...(raw.modifiedAt ? { modifiedAt: raw.modifiedAt } : {}),
        documentFingerprint: createHash('sha256').update(data).digest('hex').slice(0, 24),
      },
      blocks,
      metadata: { pages: String(raw.numPages) },
      links: [],
      issues,
      completeness: blocks.length === 0 && !unread ? 'EMPTY' : unread ? 'PARTIAL' : 'COMPLETE',
    };
  }
}

/** Un fichier lu entièrement, seulement s'il est ordinaire et sous la taille maximale. */
async function readFileLimited(file: string, maxBytes: number): Promise<Uint8Array> {
  let resolved: string;
  try {
    resolved = await realpath(file);
  } catch {
    throw new ConnectorError('NOT_FOUND', `${path.basename(file)} not found`);
  }
  const info = await stat(resolved);
  if (!info.isFile())
    throw new ConnectorError('INVALID_INPUT', `${path.basename(file)} is not a regular file`);
  if (info.size > maxBytes)
    throw new ConnectorError('TOO_LARGE', `the document is larger than ${String(maxBytes)} bytes`);
  const handle = await open(resolved, 'r');
  try {
    const buffer = Buffer.alloc(info.size);
    await handle.read(buffer, 0, info.size, 0);
    return new Uint8Array(buffer);
  } finally {
    await handle.close();
  }
}

/**
 * Les pages vers des blocs. Une ligne = les fragments jusqu'à une fin de ligne ; un écart vertical
 * plus grand que la ligne précédente sépare deux paragraphes ; une ligne nettement plus grande que le
 * corps du texte est un titre ; une ligne qui commence par une puce ou un numéro est un élément de liste.
 */
export function pdfToBlocks(raw: PdfRaw): { blocks: Block[]; issues: ImportIssue[] } {
  const blocks: Block[] = [];
  const issues: ImportIssue[] = [];
  const heights = raw.pages.flatMap((page) =>
    page.items.filter((item) => item.str.trim()).map((item) => Math.round(item.height)),
  );
  const body = mode(heights) ?? 12;
  let withoutText = 0;
  for (const page of raw.pages) {
    const lines = linesOf(page.items);
    if (lines.length === 0) {
      if (page.hasImages) {
        withoutText += 1;
        issues.push({
          severity: 'WARNING',
          code: 'PAGE_WITHOUT_TEXT',
          message: `page ${String(page.number)} has images but no text layer (scanned?): not read, no OCR available`,
          location: { block: blocks.length, page: page.number },
        });
      }
      continue;
    }
    let paragraph: string[] = [];
    let list: string[] = [];
    let previousY: number | undefined;
    let previousHeight = body;
    const flush = (): void => {
      if (paragraph.length > 0)
        blocks.push({
          type: 'paragraph',
          text: cleanText(paragraph.join(' ')),
          location: { block: blocks.length, page: page.number },
        });
      if (list.length > 0)
        blocks.push({
          type: 'list',
          ordered: false,
          items: list,
          location: { block: blocks.length, page: page.number },
        });
      paragraph = [];
      list = [];
    };
    for (const line of lines) {
      const gap = previousY === undefined ? 0 : Math.abs(previousY - line.y);
      const bullet = /^\s*(?:[•▪◦‣\-–*]|\d+[.)]|[a-z][.)])\s+/.exec(line.text);
      if (line.height >= body * 1.25 && line.text.length <= 160) {
        flush();
        blocks.push({
          type: 'heading',
          level: line.height >= body * 1.6 ? 1 : 2,
          text: cleanText(line.text),
          location: { block: blocks.length, page: page.number },
        });
      } else if (bullet) {
        if (paragraph.length > 0) {
          blocks.push({
            type: 'paragraph',
            text: cleanText(paragraph.join(' ')),
            location: { block: blocks.length, page: page.number },
          });
          paragraph = [];
        }
        list.push(cleanText(line.text.slice(bullet[0].length)));
      } else if (list.length > 0 && gap <= previousHeight * 1.6 && !/^[A-Z0-9]/.test(line.text.trim())) {
        // Suite d'un élément de liste sur la ligne suivante.
        list[list.length - 1] = cleanText(`${list[list.length - 1] ?? ''} ${line.text}`);
      } else {
        if (list.length > 0 || (previousY !== undefined && gap > previousHeight * 1.6)) flush();
        paragraph.push(line.text);
      }
      previousY = line.y;
      previousHeight = Math.max(line.height, 1);
    }
    flush();
  }
  if (raw.numPages > raw.pages.length)
    issues.push({
      severity: 'WARNING',
      code: 'PAGES_NOT_READ',
      message: `only the first ${String(raw.pages.length)} of ${String(raw.numPages)} pages were read (page limit)`,
    });
  if (raw.pages.length > 0 && withoutText / raw.pages.length > 0.5)
    issues.push({
      severity: 'WARNING',
      code: 'SCANNED_DOCUMENT',
      message: `${String(withoutText)} of ${String(raw.pages.length)} pages have no text layer: the document is mostly images`,
    });
  return { blocks, issues };
}

function linesOf(items: PdfTextItem[]): { text: string; y: number; height: number }[] {
  const lines: { text: string; y: number; height: number }[] = [];
  let parts: string[] = [];
  let y = 0;
  let height = 0;
  const close = (): void => {
    const text = cleanText(parts.join(''));
    if (text) lines.push({ text, y, height });
    parts = [];
    height = 0;
  };
  for (const item of items) {
    // pdf.js marque une fin de ligne par un fragment vide placé à la position de la ligne SUIVANTE :
    // il coupe la ligne, sans donner sa taille ni sa position.
    if (item.str.trim()) {
      if (parts.length === 0) y = item.y;
      height = Math.max(height, item.height);
      parts.push(item.str);
    } else if (item.str && parts.length > 0) parts.push(item.str);
    if (item.eol) close();
  }
  close();
  return lines;
}

function mode(values: number[]): number | undefined {
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: number | undefined;
  for (const [value, count] of counts)
    if (best === undefined || count > (counts.get(best) ?? 0)) best = value;
  return best;
}

/** Le code du worker : JavaScript simple (pas de chargeur TypeScript), pdf.js importé par son chemin. */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  const pdfjs = await import(workerData.module);
  const task = pdfjs.getDocument({ data: workerData.data, ...workerData.options });
  let doc;
  try {
    doc = await task.promise;
  } catch (error) {
    parentPort.postMessage({ error: error && error.name === 'PasswordException' ? 'ENCRYPTED' : 'CORRUPTED', message: String(error && error.message) });
    return;
  }
  const images = new Set([pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintInlineImageXObject, pdfjs.OPS.paintImageMaskXObject, pdfjs.OPS.paintImageXObjectRepeat, pdfjs.OPS.paintInlineImageXObjectGroup].filter((op) => op !== undefined));
  const count = Math.min(doc.numPages, workerData.maxPages);
  const pages = [];
  for (let number = 1; number <= count; number += 1) {
    const page = await doc.getPage(number);
    const content = await page.getTextContent();
    const items = content.items
      .filter((item) => typeof item.str === 'string')
      .map((item) => ({ str: item.str, y: Math.round(item.transform[5]), height: Math.round(Math.abs(item.transform[3]) || item.height || 0), eol: Boolean(item.hasEOL) }));
    let hasImages = false;
    if (!items.some((item) => item.str.trim())) {
      const operators = await page.getOperatorList();
      hasImages = operators.fnArray.some((op) => images.has(op));
    }
    pages.push({ number, items, hasImages });
    page.cleanup();
  }
  let title;
  let modifiedAt;
  try {
    const meta = await doc.getMetadata();
    title = meta && meta.info && typeof meta.info.Title === 'string' ? meta.info.Title : undefined;
    const date = meta && meta.info && typeof meta.info.ModDate === 'string' ? pdfjs.PDFDateString.toDateObject(meta.info.ModDate) : null;
    modifiedAt = date ? date.toISOString() : undefined;
  } catch {}
  parentPort.postMessage({ raw: { numPages: doc.numPages, pages, title, modifiedAt } });
  await task.destroy();
})().catch((error) => parentPort.postMessage({ error: 'CORRUPTED', message: String(error && error.message) }));
`;

let resolvedModule: string | null | undefined;

/** Le chemin de pdf.js, ou null quand la dépendance facultative n'est pas installée. */
export function pdfjsModule(): string | null {
  if (resolvedModule !== undefined) return resolvedModule;
  try {
    resolvedModule = pathToFileURL(createRequire(import.meta.url).resolve(PDFJS_MODULE)).href;
  } catch {
    resolvedModule = null;
  }
  return resolvedModule;
}

function readInWorker(data: Uint8Array, input: PdfInput): Promise<PdfRaw> {
  const module = pdfjsModule();
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (!module)
    return Promise.reject(
      new ConnectorError('UNSUPPORTED', 'PDF import needs the optional dependency pdfjs-dist'),
    );
  if ((major ?? 0) < 22 || ((major ?? 0) === 22 && (minor ?? 0) < 13))
    return Promise.reject(
      new ConnectorError(
        'UNSUPPORTED',
        `PDF import needs Node 22.13 or later (this is ${process.versions.node})`,
      ),
    );
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: { module, data, maxPages: input.maxPages ?? DEFAULT_MAX_PAGES, options: PDFJS_SAFE_OPTIONS },
    resourceLimits: {
      maxOldGenerationSizeMb: input.maxMemoryMb ?? DEFAULT_MEMORY_MB,
      maxYoungGenerationSizeMb: 64,
    },
  });
  return new Promise<PdfRaw>((resolve, reject) => {
    let settled = false;
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
      void worker.terminate();
    };
    const timer = setTimeout(() => {
      settle(() => {
        reject(new ConnectorError('TIMEOUT', `the PDF was not read within ${String(timeoutMs)} ms`));
      });
    }, timeoutMs);
    worker.once('message', (message: { raw?: PdfRaw; error?: string; message?: string }) => {
      settle(() => {
        if (message.raw) resolve(message.raw);
        else if (message.error === 'ENCRYPTED')
          reject(new ConnectorError('UNSUPPORTED', 'the PDF is protected by a password: not read'));
        else
          reject(
            new ConnectorError(
              'CORRUPTED',
              `the PDF could not be read: ${message.message ?? 'unknown error'}`,
            ),
          );
      });
    });
    worker.once('error', (error) => {
      settle(() => {
        const memory =
          /memory|heap/i.test(error.message) ||
          (error as NodeJS.ErrnoException).code === 'ERR_WORKER_OUT_OF_MEMORY';
        reject(
          new ConnectorError(
            memory ? 'TOO_LARGE' : 'CORRUPTED',
            memory ? 'reading the PDF went over the memory limit' : `the PDF reader failed: ${error.message}`,
          ),
        );
      });
    });
    worker.once('exit', (code) => {
      settle(() => {
        reject(new ConnectorError('CORRUPTED', `the PDF reader stopped (${String(code)})`));
      });
    });
  });
}
