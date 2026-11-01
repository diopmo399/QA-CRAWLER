/**
 * Le LEXEUR Java de l'analyse de code : découpe une source en jetons (identifiants, nombres,
 * chaînes, caractères, ponctuation) avec leur ligne et leur position. Les commentaires (ligne,
 * bloc, Javadoc) disparaissent ; les littéraux (chaînes, caractères, blocs de texte `"""`) sont lus
 * en entier, échappements compris, pour qu'une accolade ou un `//` dans une chaîne ne trompe jamais
 * l'analyse. `<` et `>` restent des jetons isolés : les génériques imbriqués (`List<Map<K, V>>`) se
 * referment jeton par jeton. Aucune exécution, aucune évaluation : une source invalide donne des
 * jetons, jamais une exception.
 */

export type JavaTokenKind = 'ident' | 'number' | 'string' | 'char' | 'punct';

export interface JavaToken {
  kind: JavaTokenKind;
  /** Le texte source du jeton (guillemets compris pour une chaîne). */
  text: string;
  /** La valeur d'un littéral chaîne ou caractère, échappements résolus. */
  value?: string;
  textBlock?: boolean;
  /** Ligne (1-based) du début du jeton. */
  line: number;
  start: number;
  end: number;
}

const PUNCT3 = ['...', '<<='];
const PUNCT2 = [
  '->',
  '::',
  '==',
  '!=',
  '<=',
  '&&',
  '||',
  '++',
  '--',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '&=',
  '|=',
  '^=',
];

const IDENT_START = /[\p{L}_$]/u;
const IDENT_PART = /[\p{L}\p{N}_$]/u;

export function tokenizeJava(source: string): JavaToken[] {
  const tokens: JavaToken[] = [];
  const n = source.length;
  let i = 0;
  let line = 1;

  const countLines = (from: number, to: number): number => {
    let count = 0;
    for (let k = from; k < to; k++) if (source.charCodeAt(k) === 10) count++;
    return count;
  };

  while (i < n) {
    const c = source[i] ?? '';
    const next = source[i + 1] ?? '';
    if (c === '\n') {
      line++;
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f') {
      i++;
      continue;
    }
    // Commentaires : ligne (jusqu'au saut de ligne, non consommé) et bloc (Javadoc compris).
    if (c === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      i = end < 0 ? n : end;
      continue;
    }
    if (c === '/' && next === '*') {
      const close = source.indexOf('*/', i + 2);
      const end = close < 0 ? n : close + 2;
      line += countLines(i, end);
      i = end;
      continue;
    }
    if (c === '"') {
      const start = i;
      const startLine = line;
      if (source.startsWith('"""', i)) {
        let j = i + 3;
        while (j < n && !source.startsWith('"""', j)) j += source[j] === '\\' ? 2 : 1;
        const raw = source.slice(i + 3, Math.min(j, n));
        const end = Math.min(j + 3, n);
        line += countLines(i, end);
        i = end;
        tokens.push({
          kind: 'string',
          text: source.slice(start, end),
          value: textBlockValue(raw),
          textBlock: true,
          line: startLine,
          start,
          end,
        });
        continue;
      }
      let j = i + 1;
      while (j < n && source[j] !== '"' && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1;
      const end = j < n && source[j] === '"' ? j + 1 : Math.min(j, n);
      tokens.push({
        kind: 'string',
        text: source.slice(start, end),
        value: unescapeJava(source.slice(i + 1, Math.min(j, n))),
        line: startLine,
        start,
        end,
      });
      i = end;
      continue;
    }
    if (c === "'") {
      const start = i;
      let j = i + 1;
      while (j < n && source[j] !== "'" && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1;
      const end = j < n && source[j] === "'" ? j + 1 : Math.min(j, n);
      tokens.push({
        kind: 'char',
        text: source.slice(start, end),
        value: unescapeJava(source.slice(i + 1, Math.min(j, n))),
        line,
        start,
        end,
      });
      i = end;
      continue;
    }
    if (IDENT_START.test(c)) {
      let j = i + 1;
      while (j < n && IDENT_PART.test(source[j] ?? '')) j++;
      tokens.push({ kind: 'ident', text: source.slice(i, j), line, start: i, end: j });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(next))) {
      let j = i + 1;
      while (j < n) {
        const d = source[j] ?? '';
        const hex = /^0[xX]/.test(source.slice(i, j + 1));
        if (/[0-9a-zA-Z_]/.test(d)) j++;
        // Un point appartient au nombre s'il est suivi d'un chiffre (1.5) ou d'un exposant / suffixe (1.e3, 1.f).
        else if (d === '.' && /[0-9eEfFdD]/.test(source[j + 1] ?? '')) j++;
        else if ((d === '+' || d === '-') && (hex ? /[pP]/ : /[eE]/).test(source[j - 1] ?? '')) j++;
        else break;
      }
      tokens.push({ kind: 'number', text: source.slice(i, j), line, start: i, end: j });
      i = j;
      continue;
    }
    const three = source.slice(i, i + 3);
    const two = source.slice(i, i + 2);
    // `>>>` et `>>` restent des `>` isolés (génériques) ; `...` et `<<=` sont gardés entiers.
    const punct = PUNCT3.includes(three) ? three : PUNCT2.includes(two) ? two : c;
    tokens.push({ kind: 'punct', text: punct, line, start: i, end: i + punct.length });
    i += punct.length;
  }
  return tokens;
}

/** Résout les échappements d'un littéral Java (\n, \t, \", \\, octal, \uXXXX, \s, continuation de ligne). */
export function unescapeJava(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i] ?? '';
    if (c !== '\\') {
      out += c;
      continue;
    }
    const e = raw[i + 1] ?? '';
    i++;
    switch (e) {
      case 'n':
        out += '\n';
        break;
      case 't':
        out += '\t';
        break;
      case 'r':
        out += '\r';
        break;
      case 'b':
        out += '\b';
        break;
      case 'f':
        out += '\f';
        break;
      case 's':
        out += ' ';
        break;
      case '\n':
        break;
      case 'u': {
        let j = i;
        while (raw[j] === 'u') j++;
        const hex = raw.slice(j, j + 4);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i = j + 3;
        } else out += 'u';
        break;
      }
      default:
        if (/[0-7]/.test(e)) {
          const octal = /^[0-7]{1,3}/.exec(raw.slice(i))?.[0] ?? e;
          out += String.fromCharCode(parseInt(octal, 8));
          i += octal.length - 1;
        } else out += e;
    }
  }
  return out;
}

/** La valeur d'un bloc de texte : indentation commune retirée, espaces de fin de ligne ôtés. */
function textBlockValue(raw: string): string {
  // Le contenu commence après le saut de ligne qui suit `"""`.
  const firstBreak = raw.indexOf('\n');
  const body = firstBreak < 0 ? '' : raw.slice(firstBreak + 1);
  const lines = body.split('\n').map((l) => l.replace(/\r$/, ''));
  const closingOnOwnLine = lines.length > 0 && /^[ \t]*$/.test(lines[lines.length - 1] ?? '');
  const significant = lines.filter((l, k) => l.trim() !== '' || (k === lines.length - 1 && closingOnOwnLine));
  const indent = significant.reduce(
    (min, l) => Math.min(min, /^[ \t]*/.exec(l)?.[0].length ?? 0),
    Number.POSITIVE_INFINITY,
  );
  const cut = Number.isFinite(indent) ? indent : 0;
  const stripped = lines.map((l) => l.slice(cut).replace(/[ \t]+$/, ''));
  if (closingOnOwnLine) stripped[stripped.length - 1] = '';
  return unescapeJava(stripped.join('\n'));
}
