/**
 * UN LECTEUR DE BALISAGE XML / XHTML restreint et tolérant (sans dépendance) : assez pour le format
 * « storage » de Confluence et le XML des documents Office. Il construit un arbre d'éléments et de
 * textes ; il ne résout aucune entité externe, ne charge rien et n'exécute rien. Une balise mal
 * fermée est refermée au mieux (le contenu n'est jamais perdu en silence : `repaired` le compte).
 */
export interface MarkupElement {
  type: 'element';
  name: string;
  attributes: Record<string, string>;
  children: MarkupNode[];
}
export interface MarkupText {
  type: 'text';
  text: string;
}
export type MarkupNode = MarkupElement | MarkupText;

const VOID = new Set(['br', 'hr', 'img', 'col', 'input', 'meta', 'link', 'area', 'base', 'wbr', 'source']);

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  eacute: 'é',
  egrave: 'è',
  ecirc: 'ê',
  euml: 'ë',
  agrave: 'à',
  acirc: 'â',
  auml: 'ä',
  ccedil: 'ç',
  icirc: 'î',
  iuml: 'ï',
  ocirc: 'ô',
  ouml: 'ö',
  ugrave: 'ù',
  ucirc: 'û',
  uuml: 'ü',
  Eacute: 'É',
  Egrave: 'È',
  Ecirc: 'Ê',
  Agrave: 'À',
  Ccedil: 'Ç',
  oelig: 'œ',
  OElig: 'Œ',
  laquo: '«',
  raquo: '»',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  hellip: '…',
  ndash: '–',
  mdash: '—',
  euro: '€',
  deg: '°',
  middot: '·',
  times: '×',
  copy: '©',
  reg: '®',
  trade: '™',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) return safeCode(parseInt(body.slice(2), 16), whole);
    if (body.startsWith('#')) return safeCode(parseInt(body.slice(1), 10), whole);
    return NAMED[body] ?? whole;
  });
}

function safeCode(code: number, fallback: string): string {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))
    return fallback;
  return String.fromCodePoint(code);
}

export interface ParsedMarkup {
  root: MarkupElement;
  /** Nombre de balises refermées ou ignorées pour réparer un balisage incorrect. */
  repaired: number;
}

export function parseMarkup(source: string, options: { html?: boolean } = {}): ParsedMarkup {
  const root: MarkupElement = { type: 'element', name: '#root', attributes: {}, children: [] };
  const stack: MarkupElement[] = [root];
  let repaired = 0;
  let position = 0;
  const top = (): MarkupElement => stack[stack.length - 1] as MarkupElement;
  const text = (value: string): void => {
    if (value) top().children.push({ type: 'text', text: value });
  };
  while (position < source.length) {
    const open = source.indexOf('<', position);
    if (open < 0) {
      text(decodeEntities(source.slice(position)));
      break;
    }
    if (open > position) text(decodeEntities(source.slice(position, open)));
    if (source.startsWith('<!--', open)) {
      const end = source.indexOf('-->', open + 4);
      position = end < 0 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', open)) {
      const end = source.indexOf(']]>', open + 9);
      text(source.slice(open + 9, end < 0 ? source.length : end));
      position = end < 0 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith('<?', open) || source.startsWith('<!', open)) {
      // Déclaration, instruction, DOCTYPE : ignorés (aucune entité externe n'est résolue).
      const end = source.indexOf('>', open);
      position = end < 0 ? source.length : end + 1;
      continue;
    }
    const end = tagEnd(source, open);
    if (end < 0) {
      text(decodeEntities(source.slice(open)));
      repaired += 1;
      break;
    }
    const raw = source.slice(open + 1, end);
    position = end + 1;
    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim().toLowerCase();
      const index = stack.map((element) => element.name).lastIndexOf(name);
      if (index <= 0) {
        repaired += 1;
        continue;
      }
      repaired += stack.length - 1 - index;
      stack.length = index;
      continue;
    }
    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const nameMatch = /^\s*([A-Za-z_][\w:.-]*)/.exec(body);
    if (!nameMatch) {
      text(decodeEntities(`<${raw}>`));
      continue;
    }
    const name = (nameMatch[1] ?? '').toLowerCase();
    const element: MarkupElement = {
      type: 'element',
      name,
      attributes: attributesOf(body.slice(nameMatch[0].length)),
      children: [],
    };
    top().children.push(element);
    if (!selfClosing && !(options.html && VOID.has(name))) stack.push(element);
  }
  repaired += stack.length - 1;
  return { root, repaired };
}

/** La fin d'une balise, en sautant les valeurs d'attribut entre guillemets. */
function tagEnd(source: string, open: number): number {
  let quote = '';
  for (let index = open + 1; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '>') return index;
  }
  return -1;
}

function attributesOf(text: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of text.matchAll(/([A-Za-z_][\w:.-]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    const name = (match[1] ?? '').toLowerCase();
    attributes[name] = decodeEntities(match[3] ?? match[4] ?? match[5] ?? '');
  }
  return attributes;
}

/** Le texte d'un nœud, ses descendants compris. */
export function textOf(node: MarkupNode): string {
  if (node.type === 'text') return node.text;
  if (node.name === 'br') return '\n';
  return node.children.map(textOf).join('');
}

export function childElements(node: MarkupElement, name?: string): MarkupElement[] {
  return node.children.filter(
    (child): child is MarkupElement =>
      child.type === 'element' && (name === undefined || child.name === name),
  );
}

export function findAll(node: MarkupElement, name: string): MarkupElement[] {
  const found: MarkupElement[] = [];
  for (const child of childElements(node)) {
    if (child.name === name) found.push(child);
    found.push(...findAll(child, name));
  }
  return found;
}
