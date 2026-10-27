/**
 * TESTS UNIQUEMENT : un générateur de PDF minimal et lisible (police Helvetica, flux non compressés),
 * pour produire des documents réels lus par pdf.js. Une page est une liste de lignes (taille de
 * police, texte) ou `{ image: true }` (une page scannée : une image, aucun texte).
 */
/** WinAnsiEncoding : les signes hors Latin-1 (puce, apostrophe typographique, tirets) ont leur propre code. */
const WIN_ANSI: Record<string, number> = {
  '•': 0x95,
  '’': 0x92,
  '‘': 0x91,
  '–': 0x96,
  '—': 0x97,
  '…': 0x85,
  '€': 0x80,
  œ: 0x9c,
};
const winAnsi = (text: string): string =>
  text.replace(/[•’‘–—…€œ]/g, (char) => String.fromCharCode(WIN_ANSI[char] ?? 0x3f));

export type PdfPageSpec = { lines: [size: number, text: string][] } | { image: true };

export function buildPdf(
  pages: PdfPageSpec[],
  options: { title?: string; modified?: string; encrypted?: boolean } = {},
): Buffer {
  const objects: string[] = [];
  const add = (body: string): number => objects.push(body);
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const image = add(
    '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\n\u0080\nendstream',
  );
  const pagesId = objects.length + pages.length * 2 + 1;
  const kids: number[] = [];
  for (const page of pages) {
    let ops: string;
    if ('image' in page) ops = 'q 200 0 0 200 100 400 cm /Im1 Do Q';
    else {
      let y = 740;
      ops = page.lines
        .map(([size, text]) => {
          y -= size * 1.5;
          return `BT /F1 ${String(size)} Tf 72 ${String(y)} Td (${winAnsi(text).replace(/[()\\]/g, (c) => `\\${c}`)}) Tj ET`;
        })
        .join('\n');
    }
    const content = add(
      `<< /Length ${String(Buffer.byteLength(ops, 'latin1'))} >>\nstream\n${ops}\nendstream`,
    );
    kids.push(
      add(
        `<< /Type /Page /Parent ${String(pagesId)} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${String(font)} 0 R >> /XObject << /Im1 ${String(image)} 0 R >> >> /Contents ${String(content)} 0 R >>`,
      ),
    );
  }
  add(
    `<< /Type /Pages /Kids [${kids.map((id) => `${String(id)} 0 R`).join(' ')}] /Count ${String(kids.length)} >>`,
  );
  const catalog = add(`<< /Type /Catalog /Pages ${String(pagesId)} 0 R >>`);
  const info = add(
    `<< ${options.title ? `/Title (${options.title})` : ''} ${options.modified ? `/ModDate (${options.modified})` : ''} >>`,
  );
  const encrypt = options.encrypted
    ? add(`<< /Filter /Standard /V 1 /R 2 /O <${'ab'.repeat(32)}> /U <${'cd'.repeat(32)}> /P -4 >>`)
    : undefined;
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${String(index + 1)} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${String(objects.length + 1)} /Root ${String(catalog)} 0 R /Info ${String(info)} 0 R${encrypt ? ` /Encrypt ${String(encrypt)} 0 R /ID [<${'01'.repeat(16)}> <${'01'.repeat(16)}>]` : ''} >>\nstartxref\n${String(xref)}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
