import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  importSource,
  PdfConnector,
  PDFJS_SAFE_OPTIONS,
  pdfToBlocks,
  RequirementsStore,
  type Block,
  type PdfInput,
} from '../../src/requirements/index.js';
import { buildPdf } from '../fixtures/pdf-builder.js';

/**
 * LE CONNECTEUR PDF : de vrais documents (générés par le test, contenu fictif) lus par pdf.js dans son
 * worker durci ; la reconstruction en blocs ; ce qui n'est pas lu (pages sans texte, au-delà de la
 * limite, documents protégés) est dit, jamais inventé.
 */
let dir = '';
const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
/** pdf.js demande Node 22.13 ou plus ; en dessous, l'import PDF doit se dire indisponible. */
const supported = major > 22 || (major === 22 && minor >= 13);
const context = { now: new Date('2026-10-27T10:00:00Z'), env: {} };
const connector = new PdfConnector();
const summary = (blocks: Block[]): string[] =>
  blocks.map((block) =>
    block.type === 'heading'
      ? `p${String(block.location.page)} h${String(block.level)} ${block.text}`
      : block.type === 'paragraph'
        ? `p${String(block.location.page)} ${block.text}`
        : block.type === 'list'
          ? `p${String(block.location.page)} list ${block.items.join(' | ')}`
          : 'table',
  );

const SPEC = buildPdf(
  [
    {
      lines: [
        [20, 'Gestion des demandes'],
        [11, 'Ce document est un exemple fictif.'],
        [15, 'Exigences'],
        [11, 'REQ-201 Le système doit enregistrer une demande'],
        [11, 'avec son titre et sa date.'],
        [11, '• Étant donné un titre vide, quand on enregistre,'],
        [11, 'alors la demande est refusée'],
        [11, '• RG-21 Le titre fait au plus 80 caractères'],
      ],
    },
    {
      lines: [
        [15, 'Critères d’acceptation'],
        [11, 'CA-5 La demande créée apparaît dans la liste.'],
      ],
    },
    { image: true },
  ],
  { title: 'Specification demandes (fictive)', modified: 'D:20261020083000Z' },
);

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'req-pdf-'));
  await writeFile(path.join(dir, 'spec.pdf'), SPEC);
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('PDF connector — hardening', () => {
  it('reads with fixed safe options: no generated code, no fonts, no network, no XFA', () => {
    expect(PDFJS_SAFE_OPTIONS).toMatchObject({
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      disableAutoFetch: true,
      disableStream: true,
      disableRange: true,
      enableXfa: false,
    });
    expect(connector.describe().capabilities.ocr).toBe(false);
  });
});

describe.runIf(supported)('PDF connector — real documents read by pdf.js', () => {
  it('rebuilds headings, paragraphs and lists with their page, and says what has no text', async () => {
    const document = await connector.extract({ file: path.join(dir, 'spec.pdf') }, context);
    expect(summary(document.blocks)).toEqual([
      'p1 h1 Gestion des demandes',
      'p1 Ce document est un exemple fictif.',
      'p1 h2 Exigences',
      'p1 REQ-201 Le système doit enregistrer une demande avec son titre et sa date.',
      'p1 list Étant donné un titre vide, quand on enregistre, alors la demande est refusée | RG-21 Le titre fait au plus 80 caractères',
      'p2 h2 Critères d’acceptation',
      'p2 CA-5 La demande créée apparaît dans la liste.',
    ]);
    expect(document.source).toMatchObject({
      kind: 'PDF',
      sourceId: 'pdf:spec.pdf',
      title: 'Specification demandes (fictive)',
      modifiedAt: '2026-10-20T08:30:00.000Z',
    });
    expect(document.metadata).toEqual({ pages: '3' });
    expect(document.issues.map((issue) => [issue.code, issue.location?.page])).toEqual([
      ['PAGE_WITHOUT_TEXT', 3],
    ]);
    expect(document.completeness).toBe('PARTIAL');
  });

  it('a mostly scanned document is reported as such, never invented', async () => {
    const scanned = buildPdf([{ image: true }, { image: true }, { lines: [[11, 'Annexe']] }]);
    const document = await connector.extract({ data: new Uint8Array(scanned), name: 'scan.pdf' }, context);
    expect(document.issues.map((issue) => issue.code)).toEqual([
      'PAGE_WITHOUT_TEXT',
      'PAGE_WITHOUT_TEXT',
      'SCANNED_DOCUMENT',
    ]);
    expect(document.completeness).toBe('PARTIAL');
  });

  it('the page limit makes the read partial', async () => {
    const document = await connector.extract({ file: path.join(dir, 'spec.pdf'), maxPages: 1 }, context);
    expect(document.blocks.every((block) => block.location.page === 1)).toBe(true);
    expect(document.issues.map((issue) => issue.code)).toEqual(['PAGES_NOT_READ']);
    expect(document.completeness).toBe('PARTIAL');
  });

  it('refuses a password-protected document', async () => {
    const encrypted = buildPdf([{ lines: [[11, 'secret']] }], { encrypted: true });
    await expect(
      connector.extract({ data: new Uint8Array(encrypted), name: 'locked.pdf' }, context),
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED',
      message: expect.stringContaining('password') as string,
    });
  });

  it('refuses what is not a readable PDF, too large, too slow, or not a regular file', async () => {
    const codes = async (input: PdfInput): Promise<string> => {
      try {
        await connector.extract(input, context);
        return 'read';
      } catch (error) {
        return (error as { code: string }).code;
      }
    };
    expect(
      await codes({ data: new Uint8Array(Buffer.from('<html>not a pdf</html>')), name: 'fake.pdf' }),
    ).toBe('CORRUPTED');
    expect(
      await codes({
        data: new Uint8Array(Buffer.from('%PDF-1.4\ngarbage without objects')),
        name: 'broken.pdf',
      }),
    ).toBe('CORRUPTED');
    expect(await codes({ file: path.join(dir, 'spec.pdf'), maxBytes: 100 })).toBe('TOO_LARGE');
    expect(await codes({ file: path.join(dir, 'spec.pdf'), timeoutMs: 1 })).toBe('TIMEOUT');
    expect(await codes({ file: path.join(dir, 'missing.pdf') })).toBe('NOT_FOUND');
    expect(await codes({ file: dir })).toBe('INVALID_INPUT');
    expect(connector.validate({ file: 'notes.docx' }).map((issue) => issue.code)).toEqual(['INVALID_INPUT']);
  });

  it('imports a PDF into a batch: candidates located by page, partial read flagged', async () => {
    const store = new RequirementsStore(path.join(dir, 'repository'));
    const batch = await importSource(store, connector, { file: path.join(dir, 'spec.pdf') }, context);
    expect(batch).toMatchObject({ connector: 'PDF', status: 'PARTIAL' });
    const located = batch.items
      .filter((item) => item.externalId)
      .map((item) => [item.externalId, item.kind, item.source.location.page]);
    expect(located).toEqual([
      ['REQ-201', 'REQUIREMENT', 1],
      ['RG-21', 'BUSINESS_RULE', 1],
      ['CA-5', 'ACCEPTANCE_CRITERION', 2],
    ]);
    expect(
      batch.items.find((item) => item.kind === 'ACCEPTANCE_CRITERION' && !item.externalId)?.criterion
        ?.negative,
    ).toBe(true);
  });
});

describe.runIf(!supported)('PDF connector — Node older than 22.13', () => {
  it('says the PDF import is unsupported instead of failing', async () => {
    await expect(connector.extract({ file: path.join(dir, 'spec.pdf') }, context)).rejects.toMatchObject({
      code: 'UNSUPPORTED',
      message: expect.stringContaining('Node 22.13') as string,
    });
  });
});

describe('PDF blocks — reconstruction rules', () => {
  it('continues a list item, separates paragraphs by the vertical gap, reports unread pages', () => {
    const { blocks, issues } = pdfToBlocks({
      numPages: 4,
      pages: [
        {
          number: 1,
          hasImages: false,
          items: [
            { str: 'Premier paragraphe', y: 700, height: 11, eol: true },
            { str: 'suite du premier.', y: 686, height: 11, eol: true },
            { str: 'Second paragraphe.', y: 640, height: 11, eol: true },
            { str: '1. premier point', y: 626, height: 11, eol: true },
            { str: 'qui continue', y: 612, height: 11, eol: true },
          ],
        },
        { number: 2, hasImages: false, items: [] },
      ],
    });
    expect(summary(blocks)).toEqual([
      'p1 Premier paragraphe suite du premier.',
      'p1 Second paragraphe.',
      'p1 list premier point qui continue',
    ]);
    expect(issues.map((issue) => issue.code)).toEqual(['PAGES_NOT_READ']);
  });

  it('starts a new paragraph at a line that opens with an identifier, even without a gap', () => {
    const { blocks } = pdfToBlocks({
      numPages: 1,
      pages: [
        {
          number: 1,
          hasImages: false,
          items: [
            { str: 'ENF-02 La recherche répond en moins de deux secondes', y: 700, height: 11, eol: true },
            { str: 'pour 95 % des requêtes.', y: 686, height: 11, eol: true },
            { str: 'ENF-03 Le portail reste disponible.', y: 672, height: 11, eol: true },
            { str: 'AB-CD et 12-3 ne sont pas des identifiants.', y: 658, height: 11, eol: true },
          ],
        },
      ],
    });
    expect(summary(blocks)).toEqual([
      'p1 ENF-02 La recherche répond en moins de deux secondes pour 95 % des requêtes.',
      'p1 ENF-03 Le portail reste disponible. AB-CD et 12-3 ne sont pas des identifiants.',
    ]);
  });
});
