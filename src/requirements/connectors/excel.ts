import { createHash } from 'node:crypto';
import {
  ConnectorError,
  type ConnectorDescription,
  type ExtractionContext,
  type SourceConnector,
} from '../connector.js';
import { cleanText, type Block, type ExtractedDocument } from '../document.js';
import type { ImportIssue } from '../model.js';
import { fileNameOf, readSourceFile, type FileInput } from './files.js';
import { childElements, parseMarkup, textOf, type MarkupElement } from './markup.js';
import { coreProperties, relationships } from './word.js';
import { openZip } from './zip.js';

/**
 * LE CONNECTEUR EXCEL (.xlsx, décision D2) : chaque feuille devient un titre (son nom) puis un
 * tableau (en-tête, lignes, et la cellule d'origine de chaque valeur). La correspondance des colonnes
 * (ID, titre, description, règle, critère, priorité, statut…) est celle de la normalisation commune,
 * réglable par un profil d'importation (`classify.columns`). Les feuilles n'ont pas à avoir le même
 * format : chacune a son propre en-tête.
 *
 * Dits explicitement : cellule calculée sans valeur enregistrée (formule non calculée), cellule en
 * erreur, cellules fusionnées, feuilles masquées ignorées, lignes au-delà de la limite.
 * Limite : une date est lue telle qu'Excel l'enregistre (un nombre de jours), sans conversion.
 */
export type ExcelInput = FileInput & {
  /** Les feuilles à lire (défaut : toutes les feuilles visibles). */
  sheets?: string[];
  /**
   * La ligne d'en-tête, 1 = première ligne : une pour toutes les feuilles, ou une par feuille
   * (`{ "Exigences": 2 }`). Défaut : la première ligne non vide de chaque feuille.
   */
  headerRow?: number | Record<string, number>;
  /** Lignes de données lues au plus par feuille. */
  maxRows?: number;
};

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_ROWS = 50_000;

export class ExcelConnector implements SourceConnector<ExcelInput> {
  readonly kind = 'EXCEL';

  describe(): ConnectorDescription {
    return {
      kind: this.kind,
      label: 'Excel (.xlsx)',
      formats: ['.xlsx'],
      maxBytes: DEFAULT_MAX_BYTES,
      capabilities: {
        headings: true,
        lists: false,
        tables: true,
        pages: false,
        versions: false,
        refresh: true,
        ocr: false,
      },
      limits: [
        'formulas are read through their last saved value (a formula never calculated has none)',
        'dates are read as Excel stores them (serial numbers)',
        'merged cells keep their value in the first cell only',
        'hidden sheets are skipped unless they are selected',
        'password-protected workbooks and legacy .xls files are refused',
      ],
    };
  }

  validate(input: ExcelInput): ImportIssue[] {
    const issues: ImportIssue[] = [];
    const name = fileNameOf(input);
    if (!/\.xlsx$/i.test(name))
      issues.push({
        severity: 'ERROR',
        code: 'INVALID_INPUT',
        message: `${name} is not a .xlsx file (legacy .xls and macro-enabled .xlsm are not read)`,
      });
    const rows =
      typeof input.headerRow === 'object'
        ? Object.values(input.headerRow)
        : input.headerRow === undefined
          ? []
          : [input.headerRow];
    if (rows.some((row) => !Number.isInteger(row) || row < 1))
      issues.push({
        severity: 'ERROR',
        code: 'INVALID_INPUT',
        message: 'headerRow must be a row number (1 or more)',
      });
    return issues;
  }

  async extract(input: ExcelInput, context: ExtractionContext): Promise<ExtractedDocument> {
    if (context.signal?.aborted) throw new ConnectorError('CANCELLED', 'import cancelled');
    const data = await readSourceFile(input, input.maxBytes ?? DEFAULT_MAX_BYTES);
    const zip = openZip(data);
    const workbookXml = zip.text('xl/workbook.xml');
    if (workbookXml === undefined)
      throw new ConnectorError('CORRUPTED', 'no xl/workbook.xml: not an Excel workbook');
    const targets = relationships(zip.text('xl/_rels/workbook.xml.rels'));
    const shared = sharedStrings(zip.text('xl/sharedStrings.xml'));
    const { root } = parseMarkup(workbookXml);
    const sheetsNode = findFirst(root, 'sheets');
    const sheets = (sheetsNode ? childElements(sheetsNode, 'sheet') : []).map((sheet) => ({
      name: sheet.attributes.name ?? '',
      hidden: (sheet.attributes.state ?? 'visible') !== 'visible',
      target: targets.get(sheet.attributes['r:id'] ?? '') ?? '',
    }));
    const issues: ImportIssue[] = [];
    const blocks: Block[] = [];
    let partial = false;
    for (const wanted of input.sheets ?? [])
      if (!sheets.some((sheet) => sheet.name === wanted)) {
        partial = true;
        issues.push({
          severity: 'WARNING',
          code: 'SHEET_NOT_FOUND',
          message: `sheet "${wanted}" is not in the workbook (sheets: ${sheets.map((sheet) => sheet.name).join(', ')})`,
        });
      }
    for (const sheet of sheets) {
      if (input.sheets ? !input.sheets.includes(sheet.name) : sheet.hidden) {
        if (!input.sheets && sheet.hidden)
          issues.push({
            severity: 'INFO',
            code: 'HIDDEN_SHEET_SKIPPED',
            message: `hidden sheet "${sheet.name}" skipped (select it to read it)`,
            location: { block: blocks.length, sheet: sheet.name },
          });
        continue;
      }
      const path = sheet.target.startsWith('/')
        ? sheet.target.slice(1)
        : `xl/${sheet.target.replace(/^\.\//, '')}`;
      const xml = zip.text(path);
      if (xml === undefined) {
        partial = true;
        issues.push({
          severity: 'WARNING',
          code: 'SHEET_NOT_READ',
          message: `sheet "${sheet.name}" has no readable content (${path})`,
          location: { block: blocks.length, sheet: sheet.name },
        });
        continue;
      }
      const result = readSheet(xml, shared, sheet.name, input, blocks.length);
      issues.push(...result.issues);
      partial ||= result.truncated;
      blocks.push({
        type: 'heading',
        level: 1,
        text: sheet.name,
        location: { block: blocks.length, sheet: sheet.name },
      });
      if (result.table)
        blocks.push({ ...result.table, location: { ...result.table.location, block: blocks.length } });
    }
    const core = coreProperties(zip.text('docProps/core.xml'));
    const name = fileNameOf(input);
    const hasRows = blocks.some((block) => block.type === 'table' && block.rows.length > 0);
    return {
      source: {
        kind: this.kind,
        sourceId: input.sourceId ?? `excel:${name}`,
        title: core.title || name,
        ...(core.modified ? { modifiedAt: core.modified } : {}),
        documentFingerprint: createHash('sha256').update(data).digest('hex').slice(0, 24),
      },
      blocks,
      metadata: { sheets: sheets.map((sheet) => sheet.name).join(', ') },
      links: [],
      issues,
      completeness: !hasRows && !partial ? 'EMPTY' : partial ? 'PARTIAL' : 'COMPLETE',
    };
  }
}

function findFirst(node: MarkupElement, name: string): MarkupElement | undefined {
  for (const child of childElements(node)) {
    if (child.name === name) return child;
    const found = findFirst(child, name);
    if (found) return found;
  }
  return undefined;
}

function sharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  const { root } = parseMarkup(xml);
  const table = findFirst(root, 'sst');
  return (table ? childElements(table, 'si') : []).map((item) => {
    // Texte simple (t) ou texte enrichi (r > t) ; les annotations phonétiques (rPh) sont ignorées.
    const parts: string[] = [];
    for (const child of childElements(item))
      if (child.name === 't') parts.push(textOf(child));
      else if (child.name === 'r') parts.push(...childElements(child, 't').map(textOf));
    return parts.join('');
  });
}

/** « B12 » → colonne 1 (0 = A), ligne 12. */
export function cellRef(ref: string): { column: number; row: number } | undefined {
  const match = /^([A-Z]{1,3})(\d+)$/.exec(ref.toUpperCase());
  if (!match?.[1] || !match[2]) return undefined;
  let column = 0;
  for (const char of match[1]) column = column * 26 + (char.charCodeAt(0) - 64);
  return { column: column - 1, row: Number(match[2]) };
}

export function columnName(index: number): string {
  let name = '';
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26))
    name = String.fromCharCode(65 + ((value - 1) % 26)) + name;
  return name;
}

function readSheet(
  xml: string,
  shared: string[],
  sheet: string,
  input: ExcelInput,
  block: number,
): { table?: Extract<Block, { type: 'table' }>; issues: ImportIssue[]; truncated: boolean } {
  const issues: ImportIssue[] = [];
  const { root } = parseMarkup(xml);
  const data = findFirst(root, 'sheetdata');
  const rows = new Map<number, Map<number, string>>();
  const formulasWithoutValue: string[] = [];
  const errors: string[] = [];
  for (const row of data ? childElements(data, 'row') : []) {
    for (const cell of childElements(row, 'c')) {
      const ref = cellRef(cell.attributes.r ?? '');
      if (!ref) continue;
      const type = cell.attributes.t ?? 'n';
      const value = childElements(cell, 'v')[0];
      const formula = childElements(cell, 'f')[0];
      let text = '';
      if (type === 's') text = shared[Number(value ? textOf(value) : -1)] ?? '';
      else if (type === 'inlinestr')
        text = childElements(childElements(cell, 'is')[0] ?? cell, 't')
          .map(textOf)
          .join('');
      else if (type === 'b') text = value ? (textOf(value) === '1' ? 'TRUE' : 'FALSE') : '';
      else if (type === 'e') {
        errors.push(cell.attributes.r ?? '');
        text = '';
      } else text = value ? textOf(value) : '';
      if (formula && !value) formulasWithoutValue.push(cell.attributes.r ?? '');
      text = cleanText(text);
      if (!text) continue;
      const cells = rows.get(ref.row) ?? new Map<number, string>();
      cells.set(ref.column, text);
      rows.set(ref.row, cells);
    }
  }
  const location = { block, sheet };
  if (formulasWithoutValue.length > 0)
    issues.push({
      severity: 'WARNING',
      code: 'FORMULA_NOT_CALCULATED',
      message: `sheet "${sheet}": ${String(formulasWithoutValue.length)} formula cell(s) without a saved value (${formulasWithoutValue.slice(0, 5).join(', ')}): open and save the workbook in Excel`,
      location,
    });
  if (errors.length > 0)
    issues.push({
      severity: 'WARNING',
      code: 'CELL_ERROR',
      message: `sheet "${sheet}": cell(s) in error (${errors.slice(0, 5).join(', ')}) read as empty`,
      location,
    });
  const merges = findFirst(root, 'mergecells');
  if (merges && childElements(merges, 'mergecell').length > 0)
    issues.push({
      severity: 'WARNING',
      code: 'TABLE_MERGED_CELLS',
      message: `sheet "${sheet}": merged cells (${childElements(merges, 'mergecell')
        .map((merge) => merge.attributes.ref ?? '')
        .slice(0, 5)
        .join(', ')}) keep their value in the first cell only`,
      location,
    });
  const numbers = [...rows.keys()].sort((a, b) => a - b);
  const imposed = typeof input.headerRow === 'object' ? input.headerRow[sheet] : input.headerRow;
  const headerNumber = imposed ?? numbers[0];
  if (headerNumber === undefined) {
    issues.push({ severity: 'INFO', code: 'EMPTY_SHEET', message: `sheet "${sheet}" is empty`, location });
    return { issues, truncated: false };
  }
  const width = Math.max(0, ...[...rows.values()].flatMap((cells) => [...cells.keys()])) + 1;
  const line = (number: number): string[] =>
    Array.from({ length: width }, (_, column) => rows.get(number)?.get(column) ?? '');
  const dataRows = numbers.filter((number) => number > headerNumber);
  const limit = input.maxRows ?? DEFAULT_MAX_ROWS;
  const truncated = dataRows.length > limit;
  if (truncated)
    issues.push({
      severity: 'WARNING',
      code: 'ROWS_NOT_READ',
      message: `sheet "${sheet}": only the first ${String(limit)} of ${String(dataRows.length)} rows were read`,
      location,
    });
  const kept = dataRows.slice(0, limit);
  return {
    table: {
      type: 'table',
      header: line(headerNumber),
      rows: kept.map(line),
      cells: kept.map((number) =>
        Array.from({ length: width }, (_, column) => `${columnName(column)}${String(number)}`),
      ),
      location,
    },
    issues,
    truncated,
  };
}
