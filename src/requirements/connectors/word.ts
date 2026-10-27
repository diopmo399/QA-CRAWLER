import { createHash } from 'node:crypto';
import {
  ConnectorError,
  type ConnectorDescription,
  type ExtractionContext,
  type SourceConnector,
} from '../connector.js';
import { cleanText, type Block, type ExtractedDocument } from '../document.js';
import type { ImportIssue, SourceLocation } from '../model.js';
import { fileNameOf, readSourceFile, type FileInput } from './files.js';
import { childElements, parseMarkup, textOf, type MarkupElement } from './markup.js';
import { openZip, type ZipArchive } from './zip.js';

/**
 * LE CONNECTEUR WORD (.docx, décision D2) : le document Office Open XML lu sans dépendance, dans
 * l'ordre de lecture, en blocs (titres par style ou niveau de plan, paragraphes, listes numérotées
 * ou à puces, tableaux). Le fichier original n'est jamais modifié.
 *
 * Signalés, non lus : images, objets intégrés, en-têtes, pieds de page, notes et commentaires ;
 * tableaux imbriqués et cellules fusionnées (lus, mais leurs colonnes peuvent se décaler) ;
 * modifications suivies (le texte inséré est lu, le texte supprimé ne l'est pas).
 * Refusés : fichiers protégés par mot de passe ou anciens .doc (format composé), .docm.
 */
export type WordInput = FileInput;

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

interface Context {
  headingLevels: Map<string, number>;
  numberingOrdered: Map<string, boolean>;
  relationships: Map<string, string>;
  blocks: Block[];
  links: { text: string; target: string; location: SourceLocation }[];
  flags: Set<'image' | 'object' | 'tracked' | 'merged' | 'nested' | 'field'>;
  list?: { numId: string; ordered: boolean; items: string[] };
}

export class WordConnector implements SourceConnector<WordInput> {
  readonly kind = 'WORD';

  describe(): ConnectorDescription {
    return {
      kind: this.kind,
      label: 'Word (.docx)',
      formats: ['.docx'],
      maxBytes: DEFAULT_MAX_BYTES,
      capabilities: {
        headings: true,
        lists: true,
        tables: true,
        pages: false,
        versions: false,
        refresh: true,
        ocr: false,
      },
      limits: [
        'images and embedded objects are not read',
        'headers, footers, footnotes and comments are not read',
        'merged cells and nested tables are flattened (columns may shift)',
        'password-protected documents and legacy .doc files are refused',
      ],
    };
  }

  validate(input: WordInput): ImportIssue[] {
    const name = fileNameOf(input);
    if (!/\.docx$/i.test(name))
      return [
        {
          severity: 'ERROR',
          code: 'INVALID_INPUT',
          message: `${name} is not a .docx file (legacy .doc and macro-enabled .docm are not read)`,
        },
      ];
    return [];
  }

  async extract(input: WordInput, context: ExtractionContext): Promise<ExtractedDocument> {
    if (context.signal?.aborted) throw new ConnectorError('CANCELLED', 'import cancelled');
    const data = await readSourceFile(input, input.maxBytes ?? DEFAULT_MAX_BYTES);
    const zip = openZip(data);
    const documentXml = zip.text('word/document.xml');
    if (documentXml === undefined)
      throw new ConnectorError('CORRUPTED', 'no word/document.xml: not a Word document');
    const ctx: Context = {
      headingLevels: headingStyles(zip.text('word/styles.xml')),
      numberingOrdered: numbering(zip.text('word/numbering.xml')),
      relationships: relationships(zip.text('word/_rels/document.xml.rels')),
      blocks: [],
      links: [],
      flags: new Set(),
    };
    const { root, repaired } = parseMarkup(documentXml);
    const body = findFirst(root, 'w:body');
    if (!body) throw new ConnectorError('CORRUPTED', 'the document has no body');
    walkBody(ctx, body);
    closeList(ctx);
    const issues = issuesOf(ctx, zip, repaired);
    const core = coreProperties(zip.text('docProps/core.xml'));
    const name = fileNameOf(input);
    return {
      source: {
        kind: this.kind,
        sourceId: input.sourceId ?? `word:${name}`,
        title: core.title || name,
        ...(core.modified ? { modifiedAt: core.modified } : {}),
        documentFingerprint: createHash('sha256').update(data).digest('hex').slice(0, 24),
      },
      blocks: ctx.blocks,
      metadata: {},
      links: ctx.links,
      issues,
      completeness: ctx.blocks.length === 0 ? 'EMPTY' : 'COMPLETE',
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

const attr = (node: MarkupElement | undefined, name: string): string | undefined => node?.attributes[name];

function walkBody(ctx: Context, node: MarkupElement): void {
  for (const child of childElements(node)) {
    if (child.name === 'w:p') paragraph(ctx, child);
    else if (child.name === 'w:tbl') {
      closeList(ctx);
      table(ctx, child);
    } else if (child.name === 'w:sdt') {
      const content = childElements(child, 'w:sdtcontent')[0];
      if (content) walkBody(ctx, content);
    } else if (child.name === 'w:customxml' || child.name === 'w:ins') walkBody(ctx, child);
  }
}

function paragraph(ctx: Context, node: MarkupElement): void {
  const properties = childElements(node, 'w:ppr')[0];
  const styleId = attr(properties && childElements(properties, 'w:pstyle')[0], 'w:val');
  const outline = attr(properties && childElements(properties, 'w:outlinelvl')[0], 'w:val');
  const numbering = properties && childElements(properties, 'w:numpr')[0];
  const numId = attr(numbering && childElements(numbering, 'w:numid')[0], 'w:val');
  const text = cleanText(runText(ctx, node));
  if (!text) return;
  const level =
    outline !== undefined && Number(outline) < 9
      ? Number(outline) + 1
      : styleId
        ? ctx.headingLevels.get(styleId)
        : undefined;
  if (level !== undefined && !numId) {
    closeList(ctx);
    ctx.blocks.push({ type: 'heading', level, text, location: { block: ctx.blocks.length } });
    return;
  }
  if (numId && numId !== '0') {
    if (ctx.list?.numId !== numId) {
      closeList(ctx);
      ctx.list = { numId, ordered: ctx.numberingOrdered.get(numId) ?? false, items: [] };
    }
    ctx.list.items.push(text);
    return;
  }
  closeList(ctx);
  ctx.blocks.push({ type: 'paragraph', text, location: { block: ctx.blocks.length } });
}

function closeList(ctx: Context): void {
  if (ctx.list && ctx.list.items.length > 0)
    ctx.blocks.push({
      type: 'list',
      ordered: ctx.list.ordered,
      items: ctx.list.items,
      location: { block: ctx.blocks.length },
    });
  ctx.list = undefined;
}

/** Le texte des « runs » d'un paragraphe : texte inséré compris, texte supprimé et codes de champ exclus. */
function runText(ctx: Context, node: MarkupElement): string {
  const parts: string[] = [];
  const visit = (current: MarkupElement): void => {
    for (const child of current.children) {
      if (child.type === 'text') continue;
      switch (child.name) {
        case 'w:t':
          parts.push(textOf(child));
          break;
        case 'w:tab':
        case 'w:br':
        case 'w:cr':
          parts.push(' ');
          break;
        case 'w:nobreakhyphen':
          parts.push('-');
          break;
        case 'w:del':
        case 'w:deltext':
        case 'w:ppr':
        case 'w:rpr':
          if (child.name === 'w:del') ctx.flags.add('tracked');
          break;
        case 'w:instrtext':
          ctx.flags.add('field');
          break;
        case 'w:drawing':
        case 'w:pict':
          ctx.flags.add('image');
          break;
        case 'w:object':
          ctx.flags.add('object');
          break;
        case 'w:ins':
          ctx.flags.add('tracked');
          visit(child);
          break;
        case 'w:hyperlink': {
          const before = parts.length;
          visit(child);
          const target =
            ctx.relationships.get(child.attributes['r:id'] ?? '') ??
            (child.attributes['w:anchor'] ? `#${child.attributes['w:anchor']}` : undefined);
          if (target)
            ctx.links.push({
              text: cleanText(parts.slice(before).join('')),
              target,
              location: { block: ctx.blocks.length },
            });
          break;
        }
        default:
          visit(child);
      }
    }
  };
  visit(node);
  return parts.join('');
}

function table(ctx: Context, node: MarkupElement): void {
  const rows = childElements(node, 'w:tr').map((row) =>
    childElements(row, 'w:tc').map((cell) => {
      const cellProperties = childElements(cell, 'w:tcpr')[0];
      if (
        cellProperties &&
        (childElements(cellProperties, 'w:gridspan')[0] || childElements(cellProperties, 'w:vmerge')[0])
      )
        ctx.flags.add('merged');
      if (findFirst(cell, 'w:tbl')) ctx.flags.add('nested');
      const texts: string[] = [];
      const collect = (current: MarkupElement): void => {
        for (const child of childElements(current))
          if (child.name === 'w:p') texts.push(cleanText(runText(ctx, child)));
          else collect(child);
      };
      collect(cell);
      return texts.filter(Boolean).join(' ');
    }),
  );
  if (rows.length === 0) return;
  ctx.blocks.push({
    type: 'table',
    header: rows[0] ?? [],
    rows: rows.slice(1),
    location: { block: ctx.blocks.length },
  });
}

function issuesOf(ctx: Context, zip: ZipArchive, repaired: number): ImportIssue[] {
  const issues: ImportIssue[] = [];
  const warn = (code: string, message: string): void => {
    issues.push({ severity: 'WARNING', code, message });
  };
  if (repaired > 0)
    warn(
      'MARKUP_REPAIRED',
      `${String(repaired)} malformed element(s) in the document were closed or ignored`,
    );
  if (ctx.flags.has('image'))
    warn('IMAGE_NOT_READ', 'the document contains images: their content is not read');
  if (ctx.flags.has('object'))
    warn('OBJECT_NOT_READ', 'the document contains embedded objects: their content is not read');
  if (ctx.flags.has('merged'))
    warn('TABLE_MERGED_CELLS', 'a table has merged cells: its columns may be shifted, check the rows');
  if (ctx.flags.has('nested'))
    warn('NESTED_TABLE', 'a table contains another table: its text is flattened into the cell');
  if (ctx.flags.has('tracked'))
    warn(
      'TRACKED_CHANGES',
      'the document has tracked changes: inserted text is read, deleted text is not; accept or reject them in Word first',
    );
  const unread = ['word/footnotes.xml', 'word/endnotes.xml', 'word/comments.xml'].filter((name) =>
    zip.has(name),
  );
  if (unread.length > 0 || zip.names.some((name) => /^word\/(header|footer)\d*\.xml$/.test(name)))
    issues.push({
      severity: 'INFO',
      code: 'PARTS_NOT_READ',
      message: 'headers, footers, footnotes and comments are not read',
    });
  return issues;
}

/** Les styles de titre : niveau de plan du style (ou de son parent), sinon son nom (« heading 2 », « Titre 2 », « Title »). */
function headingStyles(xml: string | undefined): Map<string, number> {
  const levels = new Map<string, number>();
  if (!xml) return levels;
  const { root } = parseMarkup(xml);
  const styles = findFirst(root, 'w:styles');
  const all = styles ? childElements(styles, 'w:style') : [];
  const byId = new Map(all.map((style) => [style.attributes['w:styleid'] ?? '', style]));
  const levelOf = (style: MarkupElement | undefined, depth = 0): number | undefined => {
    if (!style || depth > 5) return undefined;
    const properties = childElements(style, 'w:ppr')[0];
    const outline = attr(properties && childElements(properties, 'w:outlinelvl')[0], 'w:val');
    if (outline !== undefined && Number(outline) < 9) return Number(outline) + 1;
    const name = (attr(childElements(style, 'w:name')[0], 'w:val') ?? '').toLowerCase();
    const named = /^(?:heading|titre|title)\s*(\d)$/.exec(name);
    if (named?.[1]) return Number(named[1]);
    if (name === 'title' || name === 'titre') return 1;
    return levelOf(byId.get(attr(childElements(style, 'w:basedon')[0], 'w:val') ?? ''), depth + 1);
  };
  for (const [id, style] of byId) {
    if (style.attributes['w:type'] !== 'paragraph') continue;
    const level = levelOf(style);
    if (level !== undefined) levels.set(id, level);
  }
  return levels;
}

/** Les listes numérotées (ordonnées) ou à puces, par identifiant de numérotation (niveau 0). */
function numbering(xml: string | undefined): Map<string, boolean> {
  const ordered = new Map<string, boolean>();
  if (!xml) return ordered;
  const { root } = parseMarkup(xml);
  const numberingRoot = findFirst(root, 'w:numbering');
  if (!numberingRoot) return ordered;
  const abstract = new Map<string, boolean>();
  for (const definition of childElements(numberingRoot, 'w:abstractnum')) {
    const first = childElements(definition, 'w:lvl')[0];
    const format = attr(first && childElements(first, 'w:numfmt')[0], 'w:val') ?? 'bullet';
    abstract.set(definition.attributes['w:abstractnumid'] ?? '', format !== 'bullet' && format !== 'none');
  }
  for (const num of childElements(numberingRoot, 'w:num'))
    ordered.set(
      num.attributes['w:numid'] ?? '',
      abstract.get(attr(childElements(num, 'w:abstractnumid')[0], 'w:val') ?? '') ?? false,
    );
  return ordered;
}

export function relationships(xml: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!xml) return map;
  const { root } = parseMarkup(xml);
  const container = findFirst(root, 'relationships');
  for (const relationship of container ? childElements(container, 'relationship') : [])
    map.set(relationship.attributes.id ?? '', relationship.attributes.target ?? '');
  return map;
}

export function coreProperties(xml: string | undefined): { title?: string; modified?: string } {
  if (!xml) return {};
  const { root } = parseMarkup(xml);
  const title = findFirst(root, 'dc:title');
  const modified = findFirst(root, 'dcterms:modified');
  return {
    ...(title && cleanText(textOf(title)) ? { title: cleanText(textOf(title)) } : {}),
    ...(modified && cleanText(textOf(modified)) ? { modified: cleanText(textOf(modified)) } : {}),
  };
}
