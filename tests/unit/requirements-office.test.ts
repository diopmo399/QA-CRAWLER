import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cellRef,
  columnName,
  ExcelConnector,
  importSource,
  openZip,
  RequirementsStore,
  WordConnector,
  type Block,
  type ExcelInput,
  type WordInput,
} from '../../src/requirements/index.js';
import { buildDocx, buildXlsx, buildZip, wp, wtable } from '../fixtures/office-builder.js';

/**
 * WORD, EXCEL ET LE LECTEUR ZIP : de vrais fichiers .docx et .xlsx (écrits par le test, contenu
 * fictif) ; les archives piégées (bombe, chiffrement, CRC, format composé) sont refusées ; ce qui
 * n'est pas lu est dit.
 */
let dir = '';
const context = { now: new Date('2026-10-27T10:00:00Z'), env: {} };
const word = new WordConnector();
const excel = new ExcelConnector();

const summary = (blocks: Block[]): string[] =>
  blocks.map((block) =>
    block.type === 'heading'
      ? `h${String(block.level)} ${block.text}`
      : block.type === 'paragraph'
        ? `p ${block.text}`
        : block.type === 'list'
          ? `${block.ordered ? 'ol' : 'ul'} ${block.items.join(' | ')}`
          : `table ${block.header.join(',')} / ${block.rows.map((row) => row.join(',')).join(';')}`,
  );

const SPEC_DOCX = buildDocx(
  [
    wp('Gestion des demandes', { style: 'Heading1' }),
    wp('Document fictif de démonstration.'),
    wp('Exigences', { style: 'Titre2' }),
    wp('REQ-301 Le système doit enregistrer une demande avec son titre.'),
    wp('Le titre est obligatoire', { numId: 1 }),
    wp('Le titre fait au plus 80 caractères', { numId: 1 }),
    wp('Saisir le titre', { numId: 2 }),
    wp('Enregistrer', { numId: 2 }),
    wp('Critères d’acceptation', { style: 'MonTitre' }),
    '<w:p><w:r><w:t>CA-31 Étant donné un titre vide, quand on enregistre, alors </w:t></w:r><w:del><w:r><w:delText>tout va bien</w:delText></w:r></w:del><w:ins><w:r><w:t>la demande est refusée</w:t></w:r></w:ins></w:p>',
    '<w:p><w:r><w:t>Voir </w:t></w:r><w:hyperlink r:id="rId9"><w:r><w:t>la norme</w:t></w:r></w:hyperlink><w:r><w:drawing/></w:r></w:p>',
    wtable(
      [
        ['ID', 'Titre', 'Priorité'],
        ['REQ-302', 'Rechercher une demande', 'Haute'],
      ],
      { mergeFirstCell: true },
    ),
  ].join(''),
  { title: 'Spécification demandes (fictive)', modified: '2026-10-20T08:30:00Z', footnotes: true },
);

const WORKBOOK = buildXlsx(
  [
    {
      name: 'Exigences',
      rows: [
        ['Liste fictive des exigences'],
        ['ID', 'Titre', 'Priorité', 'Règle métier'],
        ['REQ-401', 'Créer une demande', 'Haute', 'Le titre est obligatoire'],
        [null, null, null, null],
        ['REQ-402', 'Rechercher une demande', { formula: 'IF(1,"Basse","")', value: 'Basse' }, null],
        ['REQ-403', { formula: 'A5&" bis"' }, 'Moyenne', null],
        ['REQ-404', { error: '#REF!' }, 'Basse', null],
      ],
      merges: ['A1:D1'],
    },
    {
      name: 'Critères',
      rows: [
        ['Réf', 'Critère d’acceptation'],
        ['CA-41', 'La demande créée apparaît dans la liste'],
      ],
    },
    { name: 'Brouillon', hidden: true, rows: [['ID'], ['REQ-999']] },
  ],
  { title: 'Exigences demandes (fictives)' },
);

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'req-office-'));
  await writeFile(path.join(dir, 'spec.docx'), SPEC_DOCX);
  await writeFile(path.join(dir, 'exigences.xlsx'), WORKBOOK);
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ZIP reader — hostile archives', () => {
  const code = (archive: Buffer): string => {
    try {
      const zip = openZip(new Uint8Array(archive));
      for (const name of zip.names) zip.text(name);
      return 'read';
    } catch (error) {
      return (error as { code: string }).code;
    }
  };

  it('reads stored and deflated entries, checks their checksum', () => {
    const zip = openZip(
      new Uint8Array(
        buildZip([
          { name: 'a.txt', content: 'stocké', method: 0 },
          { name: 'b.txt', content: 'compressé '.repeat(50) },
        ]),
      ),
    );
    expect(zip.text('a.txt')).toBe('stocké');
    expect(zip.text('b.txt')).toBe('compressé '.repeat(50));
    expect(zip.text('missing')).toBeUndefined();
  });

  it('refuses a decompression bomb, an encrypted entry, a bad checksum, a legacy Office file and garbage', () => {
    const bomb = Buffer.alloc(5 * 1024 * 1024, 0x41);
    expect(code(buildZip([{ name: 'bomb.xml', content: bomb }]))).toBe('TOO_LARGE');
    expect(code(buildZip([{ name: 'lie.xml', content: 'x'.repeat(5000), declaredSize: 10 }]))).toBe(
      'TOO_LARGE',
    );
    expect(code(buildZip([{ name: 'secret.xml', content: 'x', encrypted: true }]))).toBe('UNSUPPORTED');
    expect(code(buildZip([{ name: 'bad.xml', content: 'contenu', badCrc: true }]))).toBe('CORRUPTED');
    const ole = Buffer.alloc(64);
    ole.writeUInt32BE(0xd0cf11e0, 0);
    expect(code(ole)).toBe('UNSUPPORTED');
    expect(code(Buffer.from('not a zip at all'))).toBe('CORRUPTED');
  });
});

describe('Word connector (.docx)', () => {
  it('reads headings (style name, custom style through its outline level), paragraphs, lists, tables, in order', async () => {
    const document = await word.extract({ file: path.join(dir, 'spec.docx') }, context);
    expect(summary(document.blocks)).toEqual([
      'h1 Gestion des demandes',
      'p Document fictif de démonstration.',
      'h2 Exigences',
      'p REQ-301 Le système doit enregistrer une demande avec son titre.',
      'ul Le titre est obligatoire | Le titre fait au plus 80 caractères',
      'ol Saisir le titre | Enregistrer',
      'h3 Critères d’acceptation',
      'p CA-31 Étant donné un titre vide, quand on enregistre, alors la demande est refusée',
      'p Voir la norme',
      'table ID,Titre,Priorité / REQ-302,Rechercher une demande,Haute',
    ]);
    expect(document.source).toMatchObject({
      kind: 'WORD',
      sourceId: 'word:spec.docx',
      title: 'Spécification demandes (fictive)',
      modifiedAt: '2026-10-20T08:30:00Z',
    });
    expect(document.links).toEqual([
      expect.objectContaining({ text: 'la norme', target: 'https://example.test/norme' }),
    ]);
    expect(document.issues.map((issue) => issue.code)).toEqual([
      'IMAGE_NOT_READ',
      'TABLE_MERGED_CELLS',
      'TRACKED_CHANGES',
      'PARTS_NOT_READ',
    ]);
    expect(document.completeness).toBe('COMPLETE');
  });

  it('imports into candidates with Word provenance', async () => {
    const store = new RequirementsStore(path.join(dir, 'repo-word'));
    const batch = await importSource(store, word, { file: path.join(dir, 'spec.docx') }, context);
    expect(
      batch.items
        .filter((item) => item.externalId)
        .map((item) => [item.externalId, item.kind, item.confidence]),
    ).toEqual([
      ['REQ-301', 'REQUIREMENT', 'HIGH'],
      ['CA-31', 'ACCEPTANCE_CRITERION', 'HIGH'],
      ['REQ-302', 'REQUIREMENT', 'HIGH'],
    ]);
    expect(batch.items.find((item) => item.externalId === 'CA-31')?.criterion).toMatchObject({
      then: ['la demande est refusée'],
      negative: true,
    });
  });

  it('refuses other formats, legacy or protected files, and a zip that is not a Word document', async () => {
    const codes = async (input: WordInput): Promise<string> => {
      try {
        await word.extract(input, context);
        return 'read';
      } catch (error) {
        return (error as { code: string }).code;
      }
    };
    expect(word.validate({ file: 'spec.doc' }).map((issue) => issue.code)).toEqual(['INVALID_INPUT']);
    expect(word.validate({ file: 'spec.docm' }).map((issue) => issue.code)).toEqual(['INVALID_INPUT']);
    const ole = Buffer.alloc(64);
    ole.writeUInt32BE(0xd0cf11e0, 0);
    expect(await codes({ data: new Uint8Array(ole), name: 'locked.docx' })).toBe('UNSUPPORTED');
    expect(
      await codes({
        data: new Uint8Array(buildZip([{ name: 'readme.txt', content: 'x' }])),
        name: 'empty.docx',
      }),
    ).toBe('CORRUPTED');
    expect(await codes({ file: path.join(dir, 'spec.docx'), maxBytes: 100 })).toBe('TOO_LARGE');
  });
});

describe('Excel connector (.xlsx)', () => {
  it('reads each visible sheet with its own header row, cell references and explicit problems', async () => {
    const document = await excel.extract(
      { file: path.join(dir, 'exigences.xlsx'), headerRow: { Exigences: 2 } },
      context,
    );
    expect(summary(document.blocks)).toEqual([
      'h1 Exigences',
      'table ID,Titre,Priorité,Règle métier / REQ-401,Créer une demande,Haute,Le titre est obligatoire;REQ-402,Rechercher une demande,Basse,;REQ-403,,Moyenne,;REQ-404,,Basse,',
      'h1 Critères',
      'table Réf,Critère d’acceptation / CA-41,La demande créée apparaît dans la liste',
    ]);
    const table = document.blocks[1] as Extract<Block, { type: 'table' }>;
    expect(table.cells?.[0]?.[0]).toBe('A3');
    expect(document.issues.map((issue) => issue.code)).toEqual([
      'FORMULA_NOT_CALCULATED',
      'CELL_ERROR',
      'TABLE_MERGED_CELLS',
      'HIDDEN_SHEET_SKIPPED',
    ]);
    expect(document.issues[0]?.message).toContain('B6');
    expect(document.source).toMatchObject({ kind: 'EXCEL', title: 'Exigences demandes (fictives)' });
    expect(document.completeness).toBe('COMPLETE');
  });

  it('selected sheets only (hidden ones included), unknown sheet and row limit make the read partial', async () => {
    const selected = await excel.extract(
      { file: path.join(dir, 'exigences.xlsx'), sheets: ['Brouillon', 'Inconnue'] },
      context,
    );
    expect(summary(selected.blocks)).toEqual(['h1 Brouillon', 'table ID / REQ-999']);
    expect(selected.issues.map((issue) => issue.code)).toEqual(['SHEET_NOT_FOUND']);
    expect(selected.completeness).toBe('PARTIAL');
    const limited = await excel.extract(
      { file: path.join(dir, 'exigences.xlsx'), headerRow: 2, sheets: ['Exigences'], maxRows: 2 },
      context,
    );
    expect(limited.issues.map((issue) => issue.code)).toContain('ROWS_NOT_READ');
    expect(limited.completeness).toBe('PARTIAL');
  });

  it('a saved import profile maps the columns; candidates keep their sheet and cell', async () => {
    const store = new RequirementsStore(path.join(dir, 'repo-excel'));
    const first = await store.saveProfile(
      {
        name: 'demandes-xlsx',
        connector: 'EXCEL',
        classify: { columns: { id: 'Réf', criterion: 'Critère d’acceptation' } },
        options: { sheets: ['Critères'] },
      },
      new Date('2026-10-27T10:00:00Z'),
    );
    const updated = await store.saveProfile(
      { ...first, options: { sheets: ['Critères'], headerRow: 1 } },
      new Date('2026-10-27T11:00:00Z'),
    );
    expect(updated.createdAt).toBe(first.createdAt);
    expect((await store.listProfiles()).map((profile) => profile.name)).toEqual(['demandes-xlsx']);
    await expect(store.saveProfile({ ...first, name: '../evil' }, new Date())).rejects.toThrow(
      'invalid profile name',
    );

    const profile = await store.readProfile('demandes-xlsx');
    const input: ExcelInput = {
      file: path.join(dir, 'exigences.xlsx'),
      ...(profile?.options as Partial<ExcelInput>),
    };
    const batch = await importSource(store, excel, input, context, { classify: profile?.classify ?? {} });
    expect(
      batch.items.map((item) => [
        item.externalId,
        item.kind,
        item.description,
        item.source.location.sheet,
        item.source.location.cell,
      ]),
    ).toEqual([
      ['CA-41', 'ACCEPTANCE_CRITERION', 'La demande créée apparaît dans la liste', 'Critères', 'A2'],
    ]);
  });

  it('cell references both ways', () => {
    expect(cellRef('B12')).toEqual({ column: 1, row: 12 });
    expect(cellRef('AA3')).toEqual({ column: 26, row: 3 });
    expect(columnName(0)).toBe('A');
    expect(columnName(27)).toBe('AB');
    expect(excel.validate({ file: 'x.xls' }).map((issue) => issue.code)).toEqual(['INVALID_INPUT']);
    expect(excel.validate({ file: 'x.xlsx', headerRow: 0 }).map((issue) => issue.code)).toEqual([
      'INVALID_INPUT',
    ]);
  });
});
