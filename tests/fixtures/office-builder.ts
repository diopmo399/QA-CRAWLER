import { deflateRawSync } from 'node:zlib';

/**
 * TESTS UNIQUEMENT : de vrais fichiers Office Open XML (.docx, .xlsx) et des archives piégées, écrits
 * sans bibliothèque. Indépendant du lecteur testé (sa propre table CRC). Contenu fictif.
 */
export interface ZipPart {
  name: string;
  content: string | Buffer;
  /** 0 : stockée ; 8 : deflate (défaut). */
  method?: 0 | 8;
  /** Drapeau « chiffré » posé (le contenu reste en clair : seul le refus est testé). */
  encrypted?: boolean;
  /** Fausse taille décompressée déclarée (bombe, incohérence). */
  declaredSize?: number;
  /** Faux CRC. */
  badCrc?: boolean;
}

const TABLE = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table.push(c >>> 0);
  }
  return table;
})();

function crc(data: Buffer): number {
  let value = 0xffffffff;
  for (const byte of data) value = (TABLE[(value ^ byte) & 0xff] ?? 0) ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

export function buildZip(parts: ZipPart[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const part of parts) {
    const content = Buffer.isBuffer(part.content) ? part.content : Buffer.from(part.content, 'utf8');
    const method = part.method ?? 8;
    const data = method === 8 ? deflateRawSync(content) : content;
    const name = Buffer.from(part.name, 'utf8');
    const flags = 0x0800 | (part.encrypted ? 1 : 0);
    const checksum = part.badCrc ? (crc(content) ^ 0xff) >>> 0 : crc(content);
    const size = part.declaredSize ?? content.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const escape = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const W =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

/** Un paragraphe Word : style, numérotation, texte (des runs). */
export function wp(text: string, options: { style?: string; numId?: number; outline?: number } = {}): string {
  const properties = [
    options.style ? `<w:pStyle w:val="${options.style}"/>` : '',
    options.numId !== undefined
      ? `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${String(options.numId)}"/></w:numPr>`
      : '',
    options.outline !== undefined ? `<w:outlineLvl w:val="${String(options.outline)}"/>` : '',
  ].join('');
  return `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ''}<w:r><w:t xml:space="preserve">${escape(text)}</w:t></w:r></w:p>`;
}

/** Un tableau Word : la première ligne sert d'en-tête. */
export function wtable(rows: string[][], options: { mergeFirstCell?: boolean } = {}): string {
  return `<w:tbl>${rows
    .map(
      (row, index) =>
        `<w:tr>${row
          .map(
            (cell, column) =>
              `<w:tc>${options.mergeFirstCell && index === 1 && column === 0 ? '<w:tcPr><w:gridSpan w:val="2"/></w:tcPr>' : ''}${wp(cell)}</w:tc>`,
          )
          .join('')}</w:tr>`,
    )
    .join('')}</w:tbl>`;
}

export function buildDocx(
  body: string,
  options: {
    title?: string;
    modified?: string;
    styles?: string;
    numbering?: string;
    rels?: string;
    footnotes?: boolean;
  } = {},
): Buffer {
  const parts: ZipPart[] = [
    {
      name: '[Content_Types].xml',
      content:
        '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    },
    {
      name: 'word/document.xml',
      content: `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${body}<w:sectPr/></w:body></w:document>`,
    },
    {
      name: 'word/styles.xml',
      content:
        options.styles ??
        `<w:styles ${W}><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Titre2"><w:name w:val="Titre 2"/></w:style><w:style w:type="paragraph" w:styleId="MonTitre"><w:name w:val="Mon titre"/><w:basedOn w:val="Base3"/></w:style><w:style w:type="paragraph" w:styleId="Base3"><w:name w:val="Base"/><w:pPr><w:outlineLvl w:val="2"/></w:pPr></w:style></w:styles>`,
    },
    {
      name: 'word/numbering.xml',
      content:
        options.numbering ??
        `<w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`,
    },
    {
      name: 'word/_rels/document.xml.rels',
      content:
        options.rels ??
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="hyperlink" Target="https://example.test/norme" TargetMode="External"/></Relationships>',
    },
  ];
  if (options.title || options.modified)
    parts.push({
      name: 'docProps/core.xml',
      content: `<cp:coreProperties xmlns:cp="x" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/">${options.title ? `<dc:title>${escape(options.title)}</dc:title>` : ''}${options.modified ? `<dcterms:modified>${options.modified}</dcterms:modified>` : ''}</cp:coreProperties>`,
    });
  if (options.footnotes) parts.push({ name: 'word/footnotes.xml', content: `<w:footnotes ${W}/>` });
  return buildZip(parts);
}

/** Une cellule Excel : texte, nombre, formule (avec ou sans valeur enregistrée), erreur. */
export type XlsxCell =
  string | number | null | { formula: string; value?: string | number } | { error: string };

export interface XlsxSheet {
  name: string;
  rows: XlsxCell[][];
  hidden?: boolean;
  merges?: string[];
}

const column = (index: number): string => {
  let name = '';
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26))
    name = String.fromCharCode(65 + ((value - 1) % 26)) + name;
  return name;
};

export function buildXlsx(sheets: XlsxSheet[], options: { title?: string } = {}): Buffer {
  const shared: string[] = [];
  const index = (text: string): number => {
    const found = shared.indexOf(text);
    if (found >= 0) return found;
    shared.push(text);
    return shared.length - 1;
  };
  const sheetXml = sheets.map(
    (sheet) =>
      `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheet.rows
        .map(
          (row, r) =>
            `<row r="${String(r + 1)}">${row
              .map((cell, c) => {
                const ref = `${column(c)}${String(r + 1)}`;
                if (cell === null) return '';
                if (typeof cell === 'string') return `<c r="${ref}" t="s"><v>${String(index(cell))}</v></c>`;
                if (typeof cell === 'number') return `<c r="${ref}"><v>${String(cell)}</v></c>`;
                if ('error' in cell) return `<c r="${ref}" t="e"><v>${cell.error}</v></c>`;
                const value = cell.value === undefined ? '' : `<v>${escape(String(cell.value))}</v>`;
                return `<c r="${ref}"${typeof cell.value === 'string' ? ' t="str"' : ''}><f>${escape(cell.formula)}</f>${value}</c>`;
              })
              .join('')}</row>`,
        )
        .join(
          '',
        )}</sheetData>${sheet.merges?.length ? `<mergeCells>${sheet.merges.map((ref) => `<mergeCell ref="${ref}"/>`).join('')}</mergeCells>` : ''}</worksheet>`,
  );
  const parts: ZipPart[] = [
    {
      name: '[Content_Types].xml',
      content:
        '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    },
    {
      name: 'xl/workbook.xml',
      content: `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
        .map(
          (sheet, i) =>
            `<sheet name="${escape(sheet.name)}" sheetId="${String(i + 1)}"${sheet.hidden ? ' state="hidden"' : ''} r:id="rId${String(i + 1)}"/>`,
        )
        .join('')}</sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      content: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
        .map(
          (_, i) =>
            `<Relationship Id="rId${String(i + 1)}" Type="worksheet" Target="worksheets/sheet${String(i + 1)}.xml"/>`,
        )
        .join('')}</Relationships>`,
    },
    ...sheetXml.map((content, i) => ({ name: `xl/worksheets/sheet${String(i + 1)}.xml`, content })),
  ];
  parts.push({
    name: 'xl/sharedStrings.xml',
    content: `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${shared.map((text) => `<si><t>${escape(text)}</t></si>`).join('')}</sst>`,
  });
  if (options.title)
    parts.push({
      name: 'docProps/core.xml',
      content: `<cp:coreProperties xmlns:cp="x" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${escape(options.title)}</dc:title></cp:coreProperties>`,
    });
  return buildZip(parts);
}
