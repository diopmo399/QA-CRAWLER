import type {
  CodeLayer,
  CodeSymbol,
  CodeSymbolKind,
  Experiment,
  GraphNode,
  HttpExchange,
  Hypothesis,
  HypothesisStatus,
  InvestigationGraph,
  SourceFileView,
  SourceLocation,
  SourceTree,
  TimelineEvent,
} from '../core/incident-contracts.js';
import { fileId, SELECTION_KINDS, selectionKey, sourceOf, type SelectionKind } from './incident-links.js';
import {
  demoBanner,
  panelState,
  partsText,
  selectable,
  selectionClass,
  type Lang,
  type WorkspaceContext,
} from './incident-parts.js';
import { esc, icon } from './view.js';

/**
 * L'EXPLORATEUR DE CODE DE L'ESPACE D'INVESTIGATION. Un visualiseur en lecture seule, rendu en HTML (pas
 * d'éditeur) : il n'affiche que ce que le serveur a renvoyé, déjà restreint au périmètre et masqué. On y
 * trouve l'arborescence du périmètre par application, le fichier avec ses numéros de ligne, sa coloration
 * (un petit analyseur lexical, linéaire et qui ne lève jamais), les lignes signalées par l'investigation
 * (erreur, chemin analysé, hypothèse, symbole), la ligne sélectionnée, les symboles du fichier et ce qui
 * pointe sur la ligne (nœuds du graphe, hypothèses, événements, requêtes). Aucun contrôle d'édition.
 *
 * Le contrôleur (intégration) lit le fichier à afficher par `codeTarget()` puis le passe aux rendus ;
 * ce module ne lit rien lui-même.
 */

// ── Analyse lexicale ─────────────────────────────────────────────────────────────────────────

export const TOKEN_TYPES = [
  'keyword',
  'string',
  'comment',
  'number',
  'annotation',
  'type',
  'tag',
  'punct',
  'plain',
] as const;
export type CodeTokenType = (typeof TOKEN_TYPES)[number];

export interface CodeToken {
  type: CodeTokenType;
  text: string;
}

export type CodeLanguage = SourceFileView['language'];
/** Les langages de l'analyseur : ceux du contrat, plus les fichiers `.properties` (clé=valeur). */
export type TokenLanguage = CodeLanguage | 'properties';

export interface TokenizeOptions {
  /** Balises JSX/TSX (vrai par défaut) ; faux pour un `.ts` où `<T>` est un type générique. */
  jsx?: boolean;
}

/** Ajoute les jetons en fusionnant ceux de même type qui se suivent. */
class Sink {
  readonly tokens: CodeToken[] = [];
  push(type: CodeTokenType, text: string): void {
    if (text === '') return;
    const last = this.tokens.at(-1);
    if (last?.type === type) last.text += text;
    else this.tokens.push({ type, text });
  }
}

const isSpace = (code: number): boolean =>
  code === 32 ||
  (code >= 9 && code <= 13) ||
  code === 0xa0 ||
  code === 0xfeff ||
  (code >= 0x2000 && code <= 0x200a) ||
  code === 0x2028 ||
  code === 0x2029 ||
  code === 0x3000;
const isDigit = (code: number): boolean => code >= 48 && code <= 57;
const identStart = (code: number): boolean =>
  (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code === 36 || code >= 0xc0;
const identPart = (code: number): boolean => identStart(code) || isDigit(code);
const tagNamePart = (code: number): boolean => identPart(code) || code === 45 || code === 46 || code === 58;

function readWhile(src: string, from: number, accept: (code: number) => boolean): number {
  let j = from;
  while (j < src.length && accept(src.charCodeAt(j))) j += 1;
  return j;
}

function lineEnd(src: string, from: number): number {
  const j = src.indexOf('\n', from);
  return j < 0 ? src.length : j;
}

/** La fin d'un bloc fermé par `close` (inclus), ou la fin du texte s'il n'est pas fermé. */
function blockEnd(src: string, from: number, close: string): number {
  const j = src.indexOf(close, from);
  return j < 0 ? src.length : j + close.length;
}

/** La fin d'une chaîne ouverte en `from` : guillemet fermant, fin de ligne (non fermée) ou fin du texte. */
function quotedEnd(src: string, from: number, quote: string, multiline = false): number {
  let j = from + 1;
  while (j < src.length) {
    const c = src.charAt(j);
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === quote) return j + 1;
    if (c === '\n' && !multiline) return j;
    j += 1;
  }
  return src.length;
}

const NUMBER =
  /(?:0[xX][\da-fA-F_]*|0[bB][01_]*|0[oO][0-7_]*|\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?[nNlLfFdD]?/y;

function matchLength(re: RegExp, src: string, at: number): number {
  re.lastIndex = at;
  const found = re.exec(src);
  return found ? found[0].length : 0;
}

const words = (text: string): ReadonlySet<string> => new Set(text.split(' '));

const TS_KEYWORDS = words(
  'abstract as async await break case catch class const continue debugger declare default delete do else enum export extends finally for from function get if implements import in infer instanceof interface is keyof let module namespace new of package private protected public readonly return satisfies set static super switch this throw try type typeof var void while with yield',
);
const TS_TYPES = words('any bigint boolean never number object string symbol unknown');
const TS_LITERALS = words('true false null undefined NaN Infinity');
const JAVA_KEYWORDS = words(
  'abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new non-sealed package permits private protected public record return sealed short static strictfp super switch synchronized this throw throws transient try var void volatile while yield',
);
const JAVA_LITERALS = words('true false null');
/** Les mots après lesquels vient une valeur (pas un opérateur) : `/` y est une division, `<` une comparaison. */
const VALUE_WORDS = words('this super');

function classifyWord(word: string, java: boolean): CodeTokenType {
  if ((java ? JAVA_LITERALS : TS_LITERALS).has(word)) return 'number';
  if ((java ? JAVA_KEYWORDS : TS_KEYWORDS).has(word)) return 'keyword';
  if (!java && TS_TYPES.has(word)) return 'type';
  const first = word.charCodeAt(0);
  // Une classe, une interface, un composant : PascalCase (les CONSTANTES restent du texte).
  if (first >= 65 && first <= 90 && /[a-z]/.test(word)) return 'type';
  return 'plain';
}

/** La fin d'une expression régulière littérale sur la ligne, ou -1 (avec la position atteinte). */
function regexEnd(src: string, from: number): { end: number; reached: number } {
  let j = from + 1;
  let inClass = false;
  while (j < src.length) {
    const c = src.charAt(j);
    if (c === '\n') return { end: -1, reached: j };
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) return { end: j + 1, reached: j };
    j += 1;
  }
  return { end: -1, reached: src.length };
}

/** TypeScript/JavaScript (balises TSX approchées) et Java (annotations, blocs de texte). */
function scanCode(src: string, sink: Sink, java: boolean, jsx: boolean): void {
  const n = src.length;
  let i = 0;
  let depth = 0;
  /** Les profondeurs d'accolades où une interpolation `${` de gabarit s'est ouverte. */
  const templates: number[] = [];
  /** Les profondeurs d'accolades des éléments JSX ouverts (leur contenu est du texte). */
  const elements: number[] = [];
  let tag: 'open' | 'close' | undefined;
  let tagDepth = 0;
  /** Ce qui précède : une valeur (identifiant, littéral, `)`) ou un opérateur (`/` y ouvre une regex, `<` une balise). */
  let prev: 'value' | 'operator' = 'operator';
  let regexBlockedUntil = -1;

  const template = (from: number, start: number): number => {
    let j = from;
    while (j < n) {
      const c = src.charAt(j);
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (c === '`') {
        sink.push('string', src.slice(start, j + 1));
        return j + 1;
      }
      if (c === '$' && src.charAt(j + 1) === '{') {
        sink.push('string', src.slice(start, j));
        sink.push('punct', '${');
        templates.push(depth);
        depth += 1;
        return j + 2;
      }
      j += 1;
    }
    sink.push('string', src.slice(start));
    return n;
  };

  while (i < n) {
    const code = src.charCodeAt(i);
    const c = src.charAt(i);
    const children = jsx && tag === undefined && elements.length > 0 && elements.at(-1) === depth;

    // Le contenu d'un élément JSX : du texte jusqu'à une balise ou une expression.
    if (children && c !== '<') {
      if (c === '{') {
        sink.push('punct', c);
        depth += 1;
        i += 1;
        prev = 'operator';
        continue;
      }
      let j = i;
      while (j < n && src.charAt(j) !== '<' && src.charAt(j) !== '{') j += 1;
      sink.push('plain', src.slice(i, j));
      i = j;
      continue;
    }

    // Les attributs d'une balise JSX.
    if (tag !== undefined && depth === tagDepth) {
      if (isSpace(code)) {
        const j = readWhile(src, i, isSpace);
        sink.push('plain', src.slice(i, j));
        i = j;
      } else if (c === '/' && src.charAt(i + 1) === '>') {
        sink.push('tag', '/>');
        tag = undefined;
        prev = 'value';
        i += 2;
      } else if (c === '>') {
        sink.push('tag', '>');
        if (tag === 'open') elements.push(depth);
        tag = undefined;
        prev = 'value';
        i += 1;
      } else if (c === '"' || c === "'") {
        const j = quotedEnd(src, i, c);
        sink.push('string', src.slice(i, j));
        i = j;
      } else if (c === '{') {
        sink.push('punct', c);
        depth += 1;
        prev = 'operator';
        i += 1;
      } else if (identStart(code)) {
        const j = readWhile(src, i, tagNamePart);
        sink.push('type', src.slice(i, j));
        i = j;
      } else if (c === '<') {
        // Balise mal formée : on la quitte, le `<` est relu normalement.
        tag = undefined;
      } else {
        sink.push('punct', c);
        i += 1;
      }
      continue;
    }

    // Une balise JSX qui commence (là où une expression peut commencer).
    if (jsx && c === '<' && (children || prev === 'operator')) {
      const next = src.charAt(i + 1);
      if (next === '>') {
        sink.push('tag', '<>');
        elements.push(depth);
        i += 2;
        continue;
      }
      if (next === '/' && src.charAt(i + 2) === '>') {
        sink.push('tag', '</>');
        if (children) elements.pop();
        prev = 'value';
        i += 3;
        continue;
      }
      if (next === '/' && identStart(src.charCodeAt(i + 2))) {
        const j = readWhile(src, i + 2, tagNamePart);
        sink.push('tag', src.slice(i, j));
        if (children) elements.pop();
        tag = 'close';
        tagDepth = depth;
        i = j;
        continue;
      }
      if (identStart(src.charCodeAt(i + 1))) {
        const j = readWhile(src, i + 1, tagNamePart);
        sink.push('tag', src.slice(i, j));
        tag = 'open';
        tagDepth = depth;
        i = j;
        continue;
      }
    }

    if (isSpace(code)) {
      const j = readWhile(src, i, isSpace);
      sink.push('plain', src.slice(i, j));
      i = j;
      continue;
    }
    if (c === '/' && src.charAt(i + 1) === '/') {
      const j = lineEnd(src, i);
      sink.push('comment', src.slice(i, j));
      i = j;
      continue;
    }
    if (c === '/' && src.charAt(i + 1) === '*') {
      const j = blockEnd(src, i + 2, '*/');
      sink.push('comment', src.slice(i, j));
      i = j;
      continue;
    }
    if (java && src.startsWith('"""', i)) {
      let j = i + 3;
      while (j < n && !src.startsWith('"""', j)) j += src.charAt(j) === '\\' ? 2 : 1;
      j = Math.min(n, j + 3);
      sink.push('string', src.slice(i, j));
      prev = 'value';
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      const j = quotedEnd(src, i, c);
      sink.push('string', src.slice(i, j));
      prev = 'value';
      i = j;
      continue;
    }
    if (!java && c === '`') {
      i = template(i + 1, i);
      prev = 'value';
      continue;
    }
    if (c === '{') {
      sink.push('punct', c);
      depth += 1;
      prev = 'operator';
      i += 1;
      continue;
    }
    if (c === '}') {
      if (templates.length > 0 && templates.at(-1) === depth - 1) {
        templates.pop();
        depth -= 1;
        sink.push('punct', c);
        i = template(i + 1, i + 1);
        prev = 'value';
        continue;
      }
      depth = Math.max(0, depth - 1);
      sink.push('punct', c);
      prev = 'operator';
      i += 1;
      continue;
    }
    if (isDigit(code) || (c === '.' && isDigit(src.charCodeAt(i + 1)))) {
      const length = Math.max(1, matchLength(NUMBER, src, i));
      sink.push('number', src.slice(i, i + length));
      prev = 'value';
      i += length;
      continue;
    }
    if (c === '@' && identStart(src.charCodeAt(i + 1))) {
      const j = readWhile(src, i + 1, (k) => identPart(k) || k === 46);
      const text = src.slice(i, j);
      sink.push(java && text === '@interface' ? 'keyword' : 'annotation', text);
      prev = 'operator';
      i = j;
      continue;
    }
    if (identStart(code)) {
      const j = readWhile(src, i, identPart);
      const word = src.slice(i, j);
      const type = classifyWord(word, java);
      sink.push(type, word);
      prev = type === 'keyword' && !VALUE_WORDS.has(word) ? 'operator' : 'value';
      i = j;
      continue;
    }
    if (!java && c === '/' && prev === 'operator' && i > regexBlockedUntil) {
      const { end, reached } = regexEnd(src, i);
      if (end > 0) {
        const j = readWhile(src, end, identPart);
        sink.push('string', src.slice(i, j));
        prev = 'value';
        i = j;
        continue;
      }
      // Pas de regex fermée sur la ligne : on n'y cherche plus (temps linéaire).
      regexBlockedUntil = reached;
    }
    sink.push('punct', c);
    prev = c === ')' || c === ']' ? 'value' : 'operator';
    i += 1;
  }
}

const YAML_SCALAR =
  /^(?:[-+]?(?:\d[\d_]*(?:\.\d*)?(?:[eE][-+]?\d+)?|\.inf|0x[\da-fA-F]+)|\.nan|true|false|yes|no|on|off|null|~)$/i;

/** YAML : clés, chaînes, nombres et booléens, ancres, commentaires, blocs littéraux, `${…}` (Spring). */
function scanYaml(src: string, sink: Sink): void {
  let block: number | undefined;
  const lines = src.split('\n');
  lines.forEach((line, index) => {
    const indent = readWhile(line, 0, (k) => k === 32 || k === 9);
    if (block !== undefined) {
      if (line.trim() === '' || indent > block) {
        sink.push('string', `\n${line}`);
        return;
      }
      block = undefined;
    }
    if (index > 0) sink.push('plain', '\n');
    sink.push('plain', line.slice(0, indent));
    let i = indent;
    if (line.charAt(i) === '#') {
      sink.push('comment', line.slice(i));
      return;
    }
    if (i === 0 && /^(?:---|\.\.\.)(?:\s|$)/.test(line)) {
      sink.push('keyword', line.slice(0, 3));
      i = 3;
    }
    // Les tirets d'une séquence.
    while (line.charAt(i) === '-' && (i + 1 >= line.length || isSpace(line.charCodeAt(i + 1)))) {
      sink.push('punct', '-');
      const j = readWhile(line, i + 1, isSpace);
      sink.push('plain', line.slice(i + 1, j));
      i = j;
    }
    // Une clé : jusqu'au premier `:` suivi d'un blanc ou de la fin de ligne (hors guillemets, avant un commentaire).
    const first = line.charAt(i);
    if (i < line.length && first !== '{' && first !== '[' && first !== '#') {
      let j = i;
      let quote = '';
      let keyEnd = -1;
      if (first === '"' || first === "'") {
        j = quotedEnd(line, i, first);
        quote = first;
      }
      while (j < line.length) {
        const c = line.charAt(j);
        if (c === '#' && j > i && isSpace(line.charCodeAt(j - 1))) break;
        if (c === ':' && (j + 1 >= line.length || isSpace(line.charCodeAt(j + 1)))) {
          keyEnd = j;
          break;
        }
        if (quote) break;
        j += 1;
      }
      if (keyEnd > i) {
        sink.push('keyword', line.slice(i, keyEnd));
        sink.push('punct', ':');
        i = keyEnd + 1;
      }
    }
    // La valeur.
    const valueStart = readWhile(line, i, isSpace);
    while (i < line.length) {
      const c = line.charAt(i);
      const code = line.charCodeAt(i);
      if (isSpace(code)) {
        const j = readWhile(line, i, isSpace);
        sink.push('plain', line.slice(i, j));
        i = j;
      } else if (c === '#' && (i === 0 || isSpace(line.charCodeAt(i - 1)))) {
        sink.push('comment', line.slice(i));
        i = line.length;
      } else if (c === '"' || c === "'") {
        const j = quotedEnd(line, i, c);
        sink.push('string', line.slice(i, j));
        i = j;
      } else if (
        (c === '|' || c === '>') &&
        i === valueStart &&
        /^[|>][-+0-9]*\s*(?:#.*)?$/.test(line.slice(i))
      ) {
        const j = readWhile(line, i + 1, (k) => k === 43 || k === 45 || isDigit(k));
        sink.push('punct', line.slice(i, j));
        block = indent;
        i = j;
      } else if ((c === '&' || c === '*' || c === '!') && i === valueStart) {
        const j = readWhile(
          line,
          i + 1,
          (k) => !isSpace(k) && k !== 44 && k !== 91 && k !== 93 && k !== 123 && k !== 125,
        );
        sink.push('annotation', line.slice(i, j));
        i = j;
      } else if (c === '$' && line.charAt(i + 1) === '{') {
        const j = blockEnd(line, i + 2, '}');
        sink.push('annotation', line.slice(i, j));
        i = j;
      } else if ('{}[],'.includes(c)) {
        sink.push('punct', c);
        i += 1;
      } else {
        let j = i + 1;
        while (j < line.length) {
          const k = line.charCodeAt(j);
          if (isSpace(k) || '{}[],'.includes(line.charAt(j))) break;
          if (k === 36 && line.charAt(j + 1) === '{') break;
          j += 1;
        }
        const word = line.slice(i, j);
        sink.push(YAML_SCALAR.test(word) ? 'number' : 'plain', word);
        i = j;
      }
    }
  });
}

/** `.properties` : commentaires, clé, séparateur, valeur (lignes continuées par `\`). */
function scanProperties(src: string, sink: Sink): void {
  let continued = false;
  const oddBackslash = (line: string): boolean => (line.length - line.replace(/\\+$/, '').length) % 2 === 1;
  const value = (text: string): void => {
    if (/^\s*(?:-?\d+(?:\.\d+)?|true|false)\s*$/i.test(text)) {
      sink.push('number', text);
      return;
    }
    let i = 0;
    while (i < text.length) {
      const at = text.indexOf('${', i);
      if (at < 0) {
        sink.push('string', text.slice(i));
        return;
      }
      sink.push('string', text.slice(i, at));
      const end = blockEnd(text, at + 2, '}');
      sink.push('annotation', text.slice(at, end));
      i = end;
    }
  };
  src.split('\n').forEach((line, index) => {
    if (index > 0) sink.push('plain', '\n');
    if (continued) {
      value(line);
      continued = oddBackslash(line);
      return;
    }
    const indent = readWhile(line, 0, isSpace);
    sink.push('plain', line.slice(0, indent));
    const c = line.charAt(indent);
    if (c === '#' || c === '!') {
      sink.push('comment', line.slice(indent));
      return;
    }
    let j = indent;
    while (j < line.length) {
      const k = line.charAt(j);
      if (k === '\\') {
        j += 2;
        continue;
      }
      if (k === '=' || k === ':' || isSpace(line.charCodeAt(j))) break;
      j += 1;
    }
    j = Math.min(j, line.length);
    sink.push('keyword', line.slice(indent, j));
    const sep = /^[ \t\f]*[=:]?[ \t\f]*/.exec(line.slice(j))?.[0] ?? '';
    sink.push('punct', sep);
    value(line.slice(j + sep.length));
    continued = oddBackslash(line);
  });
}

/** XML : commentaires, CDATA, instructions, balises et attributs, entités, `${…}` (Maven). */
function scanXml(src: string, sink: Sink): void {
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src.charAt(i);
    if (src.startsWith('<!--', i)) {
      const j = blockEnd(src, i + 4, '-->');
      sink.push('comment', src.slice(i, j));
      i = j;
    } else if (src.startsWith('<![CDATA[', i)) {
      const j = blockEnd(src, i + 9, ']]>');
      sink.push('string', src.slice(i, j));
      i = j;
    } else if (src.startsWith('<?', i)) {
      const j = blockEnd(src, i + 2, '?>');
      sink.push('annotation', src.slice(i, j));
      i = j;
    } else if (src.startsWith('<!', i)) {
      const j = blockEnd(src, i + 2, '>');
      sink.push('annotation', src.slice(i, j));
      i = j;
    } else if (
      c === '<' &&
      (identStart(src.charCodeAt(i + 1)) || (src.charAt(i + 1) === '/' && identStart(src.charCodeAt(i + 2))))
    ) {
      let j = readWhile(src, i + (src.charAt(i + 1) === '/' ? 2 : 1), tagNamePart);
      sink.push('tag', src.slice(i, j));
      // Les attributs, jusqu'à `>` ou `/>` (un `<` met fin à une balise mal formée).
      while (j < n) {
        const k = src.charAt(j);
        if (k === '>') {
          sink.push('tag', k);
          j += 1;
          break;
        }
        if (k === '/' && src.charAt(j + 1) === '>') {
          sink.push('tag', '/>');
          j += 2;
          break;
        }
        if (k === '<') break;
        if (isSpace(src.charCodeAt(j))) {
          const end = readWhile(src, j, isSpace);
          sink.push('plain', src.slice(j, end));
          j = end;
        } else if (k === '"' || k === "'") {
          let end = j + 1;
          while (end < n && src.charAt(end) !== k && src.charAt(end) !== '<') end += 1;
          if (src.charAt(end) === k) end += 1;
          sink.push('string', src.slice(j, end));
          j = end;
        } else if (k === '=') {
          sink.push('punct', k);
          j += 1;
        } else {
          const end = Math.max(
            j + 1,
            readWhile(
              src,
              j,
              (code) => !isSpace(code) && code !== 61 && code !== 62 && code !== 47 && code !== 60,
            ),
          );
          sink.push('type', src.slice(j, end));
          j = end;
        }
      }
      i = j;
    } else if (c === '&') {
      const j = readWhile(src, i + 1, (code) => identPart(code) || code === 35);
      const end = src.charAt(j) === ';' ? j + 1 : j;
      sink.push(end > i + 1 ? 'annotation' : 'plain', src.slice(i, Math.max(end, i + 1)));
      i = Math.max(end, i + 1);
    } else if (c === '$' && src.charAt(i + 1) === '{') {
      const close = src.indexOf('}', i + 2);
      const stop = src.indexOf('<', i + 2);
      const j = close >= 0 && (stop < 0 || close < stop) ? close + 1 : i + 2;
      sink.push(j > i + 2 ? 'annotation' : 'plain', src.slice(i, j));
      i = j;
    } else if (c === '<') {
      sink.push('punct', c);
      i += 1;
    } else {
      let j = i + 1;
      while (j < n && src.charAt(j) !== '<' && src.charAt(j) !== '&' && src.charAt(j) !== '$') j += 1;
      sink.push('plain', src.slice(i, j));
      i = j;
    }
  }
}

/**
 * Découpe un texte en jetons colorables. Linéaire, sans perte (la concaténation des jetons redonne le
 * texte), robuste aux chaînes et commentaires non fermés ; ne lève jamais (au pire : un seul jeton `plain`).
 */
export function tokenize(text: string, language: TokenLanguage, options: TokenizeOptions = {}): CodeToken[] {
  const src = typeof text === 'string' ? text : String(text);
  if (src === '') return [];
  try {
    const sink = new Sink();
    switch (language) {
      case 'typescript':
        scanCode(src, sink, false, options.jsx ?? true);
        break;
      case 'java':
        scanCode(src, sink, true, false);
        break;
      case 'yaml':
        scanYaml(src, sink);
        break;
      case 'xml':
        scanXml(src, sink);
        break;
      case 'properties':
        scanProperties(src, sink);
        break;
      default:
        sink.push('plain', src);
    }
    return sink.tokens;
  } catch {
    return [{ type: 'plain', text: src }];
  }
}

/** Le langage d'un fichier, d'après son extension (pour `SourceFileView.language`). */
export function languageOf(file: string): CodeLanguage {
  const name = (file.split(/[\\/]/).at(-1) ?? file).toLowerCase();
  const dot = name.lastIndexOf('.');
  const extension = dot >= 0 ? name.slice(dot + 1) : '';
  if (['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'vue'].includes(extension)) return 'typescript';
  if (extension === 'java') return 'java';
  if (extension === 'yml' || extension === 'yaml') return 'yaml';
  if (['xml', 'pom', 'xsd'].includes(extension) || name === 'pom') return 'xml';
  return 'text';
}

/** Le langage de l'analyseur pour un fichier affiché : `.properties` a sa coloration clé=valeur. */
export function tokenLanguageOf(file: string, language: CodeLanguage): TokenLanguage {
  return language === 'text' && /\.properties$/i.test(file) ? 'properties' : language;
}

/** Répartit des jetons par ligne (un jeton sur plusieurs lignes est coupé). */
export function splitLines(tokens: readonly CodeToken[]): CodeToken[][] {
  let current: CodeToken[] = [];
  const lines: CodeToken[][] = [current];
  for (const token of tokens) {
    const parts = token.text.split('\n');
    parts.forEach((part, index) => {
      if (index > 0) {
        current = [];
        lines.push(current);
      }
      if (part !== '') current.push({ type: token.type, text: part });
    });
  }
  return lines;
}

const LINE_CACHE = new Map<string, CodeToken[][]>();

/** Les lignes colorées d'un fichier affiché (les derniers fichiers sont gardés : un dessin ne refait pas l'analyse). */
function linesOf(view: Pick<SourceFileView, 'file' | 'language' | 'text'>): CodeToken[][] {
  const language = tokenLanguageOf(view.file, view.language);
  const jsx = !/\.(?:ts|mts|cts)$/i.test(view.file);
  const key = `${language}|${String(jsx)}|${view.file}|${view.text}`;
  const known = LINE_CACHE.get(key);
  if (known) return known;
  const text = view.text.replace(/\r\n?/g, '\n');
  const lines = splitLines(tokenize(text, language, { jsx }));
  if (text.endsWith('\n') && lines.length > 1) lines.pop();
  LINE_CACHE.set(key, lines);
  if (LINE_CACHE.size > 6) {
    const oldest = LINE_CACHE.keys().next().value;
    if (oldest !== undefined) LINE_CACHE.delete(oldest);
  }
  return lines;
}

// ── État local et réducteur ──────────────────────────────────────────────────────────────────

/** Un fichier ouvert : l'application, le chemin, la ligne visée, et la sélection d'alors (`anchor`). */
export interface CodeCursor {
  applicationId: string;
  file: string;
  line?: number;
  /**
   * La clé de la sélection partagée au moment de l'ouverture (`data-sel`, vide si rien n'était sélectionné).
   * Tant que la sélection n'a pas changé, le fichier ouvert l'emporte ; dès qu'elle change, l'endroit du
   * code de la nouvelle sélection l'emporte (s'il est dans la même couche).
   */
  anchor: string;
}

export interface CodeUi {
  /** Les fichiers ouverts, le plus récent d'abord, au plus un par application (donc un par couche affichée). */
  open: CodeCursor[];
  /** Dossiers repliés (false) ou dépliés (true) explicitement : `applicationId:chemin`. */
  folders: Record<string, boolean>;
  /** La recherche de fichiers par nom. */
  search: string;
}

export function emptyCodeUi(): CodeUi {
  return { open: [], folders: {}, search: '' };
}

const MAX_CURSORS = 8;
const MAX_LINE = 10_000_000;

function lineOf(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value.trim())) return undefined;
  const line = Number.parseInt(value, 10);
  return line >= 1 && line <= MAX_LINE ? line : undefined;
}

/**
 * Le réducteur de l'explorateur (pur). Actions :
 * - `ws-code-open` (et `ws-code`, le lien de `sourceLink`) : `app`, `file`, `line?`, `sel?` — ouvre le fichier ;
 * - `ws-code-goto` : `line`, `app?`, `file?`, `sel?` — va à la ligne (du fichier ouvert le plus récent sinon) ;
 * - `ws-code-folder` : `folder`, `open` (l'état affiché) — replie ou déplie ;
 * - `ws-code-search` : `value` — le champ `data-ws-field="code-search"` ; `ws-code-search-clear`.
 * Le contrôleur peut ajouter `sel` (la clé de la sélection courante) au dataset des liens d'autres vues.
 * `ws-code-reload` (réessayer la lecture) n'est pas une transition d'état : rendu `undefined`.
 */
export function reduceCode(
  ui: CodeUi,
  action: string,
  dataset: Record<string, string | undefined>,
): CodeUi | undefined {
  switch (action) {
    case 'ws-code':
    case 'ws-code-open': {
      const applicationId = dataset.app;
      const file = dataset.file;
      if (!applicationId || !file) return ui;
      const line = lineOf(dataset.line);
      const cursor: CodeCursor = { applicationId, file, anchor: dataset.sel ?? '' };
      if (line !== undefined) cursor.line = line;
      return {
        ...ui,
        open: [cursor, ...ui.open.filter((entry) => entry.applicationId !== applicationId)].slice(
          0,
          MAX_CURSORS,
        ),
      };
    }
    case 'ws-code-goto': {
      const line = lineOf(dataset.line);
      if (line === undefined) return ui;
      const current =
        dataset.app && dataset.file ? { applicationId: dataset.app, file: dataset.file } : ui.open[0];
      if (!current) return ui;
      return reduceCode(ui, 'ws-code-open', {
        app: current.applicationId,
        file: current.file,
        line: String(line),
        sel: dataset.sel,
      });
    }
    case 'ws-code-folder': {
      const key = dataset.folder;
      if (!key) return ui;
      return { ...ui, folders: { ...ui.folders, [key]: dataset.open !== 'true' } };
    }
    case 'ws-code-search':
      return { ...ui, search: (dataset.value ?? '').slice(0, 200) };
    case 'ws-code-search-clear':
      return { ...ui, search: '' };
    default:
      return undefined;
  }
}

// ── Textes ───────────────────────────────────────────────────────────────────────────────────

const TEXT = {
  fr: {
    readOnly: 'Lecture seule',
    readOnlyHint:
      'Le code tel que le serveur l’a lu dans le périmètre, valeurs sensibles masquées : aucune modification possible.',
    codeOf: (file: string) => `Code source de ${file} (lecture seule)`,
    crumbs: 'Emplacement du fichier',
    lines: (count: number) => `${String(count)} ligne(s)`,
    languages: {
      typescript: 'TypeScript',
      java: 'Java',
      yaml: 'YAML',
      xml: 'XML',
      text: 'Texte',
      properties: 'Properties',
    } as Record<TokenLanguage, string>,
    windowed: (from: number, to: number, total: number) =>
      `Fichier long : lignes ${String(from)} à ${String(to)} sur ${String(total)}, autour de la ligne visée.`,
    lineCut: 'Ligne coupée à l’affichage',
    noFile:
      'Sélectionnez un fichier dans l’arborescence, ou un élément de l’investigation, pour lire son code.',
    startHere: (file: string, line: number) => `Point de départ : ${file}, ligne ${String(line)}`,
    loadingFile: 'Lecture du fichier…',
    deniedCode: 'Votre rôle ne permet pas de lire le code du périmètre.',
    emptyFile: 'Ce fichier est vide.',
    highlightKinds: {
      ERROR: 'Erreur',
      PATH: 'Chemin analysé',
      HYPOTHESIS: 'Hypothèse',
      SYMBOL: 'Symbole',
    } as Record<HighlightKind, string>,
    highlightHints: {
      ERROR: 'L’erreur observée ou l’exception en cause',
      PATH: 'Relié à l’incident par le graphe (lu dans le code ou déduit) : pas une trace d’exécution',
      HYPOTHESIS: 'Cité par une hypothèse',
      SYMBOL: 'Un symbole de l’index de code',
    } as Record<HighlightKind, string>,
    marks: 'Lignes signalées',
    line: (line: number) => `Ligne ${String(line)}`,
    gotoLine: (line: number) => `Aller à la ligne ${String(line)}`,
    selectedLine: 'ligne sélectionnée',
    symbols: 'Symboles du fichier',
    noSymbols: 'Aucun symbole indexé dans ce fichier.',
    selectSymbol: (name: string) => `Sélectionner ${name}`,
    kinds: {
      COMPONENT: 'Composant',
      EVENT_HANDLER: 'Gestionnaire d’événement',
      FUNCTION: 'Fonction',
      HTTP_CLIENT_CALL: 'Appel HTTP',
      VALIDATION: 'Validation',
      PAYLOAD_TRANSFORM: 'Transformation des données',
      ERROR_HANDLER: 'Gestion d’erreur',
      CONTROLLER: 'Contrôleur',
      ENDPOINT: 'Endpoint',
      DTO: 'DTO',
      SERVICE: 'Service',
      MAPPER: 'Conversion',
      HTTP_CLIENT: 'Client HTTP',
      BACKEND_CALL: 'Appel au backend',
      REPOSITORY: 'Repository',
      TRANSACTION: 'Transaction',
      SQL_QUERY: 'Requête SQL',
      EXCEPTION: 'Exception',
      EXCEPTION_HANDLER: 'Gestion des exceptions',
    } as Record<CodeSymbolKind, string>,
    pointsHere: (line: number) => `Ce qui mène à la ligne ${String(line)}`,
    evidenceTitle: 'Liens avec l’investigation',
    pickLine: 'Sélectionnez une ligne signalée ou un symbole pour voir ce qui y mène.',
    nothingHere: 'Aucun élément de l’investigation ne pointe sur cette ligne.',
    nearest: 'Symbole englobant',
    groups: {
      reasons: 'Signalements',
      nodes: 'Nœuds du graphe',
      hypotheses: 'Hypothèses',
      events: 'Chronologie',
      requests: 'Requêtes HTTP',
      experiments: 'Vérifications',
    },
    fileHypotheses: 'Hypothèses qui citent ce fichier',
    hypothesisStatus: {
      PROPOSED: 'Proposée',
      INVESTIGATING: 'En cours d’examen',
      SUPPORTED: 'Étayée',
      REFUTED: 'Réfutée',
      INCONCLUSIVE: 'Non concluante',
      CONFIRMED: 'Confirmée',
    } as Record<HypothesisStatus, string>,
    step: (index: number) => `étape ${String(index)}`,
    tree: 'Arborescence du périmètre',
    search: 'Rechercher un fichier par nom',
    searchPlaceholder: 'Nom du fichier…',
    clearSearch: 'Effacer la recherche',
    matches: (count: number) => `${String(count)} fichier(s) trouvé(s)`,
    noMatch: 'Aucun fichier ne correspond à la recherche.',
    concerned: 'concerné',
    concernedHint: 'Cité par le graphe, une hypothèse ou la chronologie',
    files: (count: number) => `${String(count)} fichier(s)`,
    appTruncated: 'Liste partielle : la limite de fichiers du périmètre est atteinte.',
    shownFirst: (shown: number, total: number) =>
      `${String(shown)} fichiers listés sur ${String(total)} : précisez la recherche.`,
    denied: (count: number) => `Hors périmètre (${String(count)})`,
    deniedHint: 'Chemins refusés par le périmètre d’investigation, avec la règle retenue.',
    noTree: 'Aucune application lisible dans le périmètre.',
    loadingTree: 'Lecture de l’arborescence…',
    folder: (name: string, open: boolean) => `${open ? 'Replier' : 'Déplier'} le dossier ${name}`,
    openFile: (file: string) => `Ouvrir ${file}`,
    current: 'fichier affiché',
    layerCode: (layer: string) => `Code ${layer}`,
    noLayerApp: (layer: string) => `Aucune application ${layer} dans le périmètre.`,
    involved: 'En jeu dans l’investigation',
    noInvolved: 'Aucun élément de cette couche n’est encore relié à l’investigation.',
    start: 'Point de départ',
    openInExplorer: 'Ouvrir dans l’explorateur',
    excerpt: (file: string, line: number) => `Extrait de ${file} autour de la ligne ${String(line)}`,
  },
  en: {
    readOnly: 'Read only',
    readOnlyHint:
      'The code as the server read it inside the scope, sensitive values masked: it cannot be modified.',
    codeOf: (file: string) => `Source code of ${file} (read only)`,
    crumbs: 'File location',
    lines: (count: number) => `${String(count)} line(s)`,
    languages: {
      typescript: 'TypeScript',
      java: 'Java',
      yaml: 'YAML',
      xml: 'XML',
      text: 'Text',
      properties: 'Properties',
    } as Record<TokenLanguage, string>,
    windowed: (from: number, to: number, total: number) =>
      `Long file: lines ${String(from)} to ${String(to)} of ${String(total)}, around the target line.`,
    lineCut: 'Line cut for display',
    noFile: 'Select a file in the tree, or an item of the investigation, to read its code.',
    startHere: (file: string, line: number) => `Starting point: ${file}, line ${String(line)}`,
    loadingFile: 'Reading the file…',
    deniedCode: 'Your role does not allow you to read the code of the scope.',
    emptyFile: 'This file is empty.',
    highlightKinds: {
      ERROR: 'Error',
      PATH: 'Analysed path',
      HYPOTHESIS: 'Hypothesis',
      SYMBOL: 'Symbol',
    } as Record<HighlightKind, string>,
    highlightHints: {
      ERROR: 'The observed error or the exception at stake',
      PATH: 'Linked to the incident by the graph (read in the code or inferred): not an execution trace',
      HYPOTHESIS: 'Cited by a hypothesis',
      SYMBOL: 'A symbol of the code index',
    } as Record<HighlightKind, string>,
    marks: 'Flagged lines',
    line: (line: number) => `Line ${String(line)}`,
    gotoLine: (line: number) => `Go to line ${String(line)}`,
    selectedLine: 'selected line',
    symbols: 'Symbols of the file',
    noSymbols: 'No indexed symbol in this file.',
    selectSymbol: (name: string) => `Select ${name}`,
    kinds: {
      COMPONENT: 'Component',
      EVENT_HANDLER: 'Event handler',
      FUNCTION: 'Function',
      HTTP_CLIENT_CALL: 'HTTP call',
      VALIDATION: 'Validation',
      PAYLOAD_TRANSFORM: 'Payload transform',
      ERROR_HANDLER: 'Error handler',
      CONTROLLER: 'Controller',
      ENDPOINT: 'Endpoint',
      DTO: 'DTO',
      SERVICE: 'Service',
      MAPPER: 'Mapper',
      HTTP_CLIENT: 'HTTP client',
      BACKEND_CALL: 'Backend call',
      REPOSITORY: 'Repository',
      TRANSACTION: 'Transaction',
      SQL_QUERY: 'SQL query',
      EXCEPTION: 'Exception',
      EXCEPTION_HANDLER: 'Exception handler',
    } as Record<CodeSymbolKind, string>,
    pointsHere: (line: number) => `What leads to line ${String(line)}`,
    evidenceTitle: 'Links with the investigation',
    pickLine: 'Select a flagged line or a symbol to see what leads there.',
    nothingHere: 'No item of the investigation points at this line.',
    nearest: 'Enclosing symbol',
    groups: {
      reasons: 'Flags',
      nodes: 'Graph nodes',
      hypotheses: 'Hypotheses',
      events: 'Timeline',
      requests: 'HTTP requests',
      experiments: 'Verifications',
    },
    fileHypotheses: 'Hypotheses citing this file',
    hypothesisStatus: {
      PROPOSED: 'Proposed',
      INVESTIGATING: 'Under review',
      SUPPORTED: 'Supported',
      REFUTED: 'Refuted',
      INCONCLUSIVE: 'Inconclusive',
      CONFIRMED: 'Confirmed',
    } as Record<HypothesisStatus, string>,
    step: (index: number) => `step ${String(index)}`,
    tree: 'Scope tree',
    search: 'Search a file by name',
    searchPlaceholder: 'File name…',
    clearSearch: 'Clear the search',
    matches: (count: number) => `${String(count)} file(s) found`,
    noMatch: 'No file matches the search.',
    concerned: 'involved',
    concernedHint: 'Cited by the graph, a hypothesis or the timeline',
    files: (count: number) => `${String(count)} file(s)`,
    appTruncated: 'Partial list: the file limit of the scope was reached.',
    shownFirst: (shown: number, total: number) =>
      `${String(shown)} files listed out of ${String(total)}: refine the search.`,
    denied: (count: number) => `Out of scope (${String(count)})`,
    deniedHint: 'Paths refused by the investigation scope, with the rule that decided.',
    noTree: 'No readable application in the scope.',
    loadingTree: 'Reading the tree…',
    folder: (name: string, open: boolean) => `${open ? 'Collapse' : 'Expand'} the folder ${name}`,
    openFile: (file: string) => `Open ${file}`,
    current: 'displayed file',
    layerCode: (layer: string) => `${layer} code`,
    noLayerApp: (layer: string) => `No ${layer} application in the scope.`,
    involved: 'At stake in the investigation',
    noInvolved: 'No item of this layer is linked to the investigation yet.',
    start: 'Starting point',
    openInExplorer: 'Open in the explorer',
    excerpt: (file: string, line: number) => `Excerpt of ${file} around line ${String(line)}`,
  },
};

type HighlightKind = SourceFileView['highlights'][number]['kind'];
type Highlight = SourceFileView['highlights'][number];
const codeText = (lang: Lang): (typeof TEXT)['fr'] => TEXT[lang];

/** Le chargement d'un panneau : en cours, ou en échec (avec le message). */
export type CodeLoadState = 'loading' | { error: string };

// ── Liens entre le code et l'investigation ───────────────────────────────────────────────────

const baseName = (file: string): string => file.split('/').at(-1) ?? file;
const selectionKeyOf = (ctx: WorkspaceContext): string => (ctx.selection ? selectionKey(ctx.selection) : '');

/** La couche d'une application (arborescence, périmètre, index de code). */
function layerOfApp(ctx: WorkspaceContext, applicationId: string, tree?: SourceTree): CodeLayer | undefined {
  return (
    tree?.applications.find((entry) => entry.applicationId === applicationId)?.layer ??
    ctx.incident.scope.applications.find((entry) => entry.id === applicationId)?.layer ??
    ctx.incident.investigation.code?.applications.find((entry) => entry.id === applicationId)?.layer
  );
}

function appName(ctx: WorkspaceContext, applicationId: string, tree?: SourceTree): string {
  return (
    tree?.applications.find((entry) => entry.applicationId === applicationId)?.name ??
    ctx.incident.scope.applications.find((entry) => entry.id === applicationId)?.name ??
    applicationId
  );
}

/** L'endroit du code d'un nœud du graphe (le sien, sinon celui de son symbole). */
function nodeSource(ctx: WorkspaceContext, node: GraphNode): SourceLocation | undefined {
  return node.source ?? ctx.links.sources.get(`node:${node.id}`);
}

/**
 * Les nœuds du chemin de l'erreur et leur profondeur depuis les racines : les exceptions observées (à
 * défaut, toutes les exceptions) et tout ce qui y mène.
 */
function errorPath(graph: InvestigationGraph | undefined): Map<string, number> {
  const result = new Map<string, number>();
  if (!graph || graph.nodes.length === 0) return result;
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const edge of graph.edges) {
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
    incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge.from]);
  }
  const depth = new Map<string, number>();
  const roots = graph.nodes.filter((node) => !incoming.has(node.id)).map((node) => node.id);
  const queue = [...roots];
  for (const root of roots) depth.set(root, 0);
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index] ?? '';
    const next = (depth.get(id) ?? 0) + 1;
    for (const target of outgoing.get(id) ?? [])
      if (!depth.has(target)) {
        depth.set(target, next);
        queue.push(target);
      }
  }
  const exceptions = graph.nodes.filter((node) => node.kind === 'EXCEPTION');
  const observed = exceptions.filter((node) => node.id.startsWith('exception:observed:'));
  const back = (observed.length > 0 ? observed : exceptions).map((node) => node.id);
  const seen = new Set(back);
  for (let index = 0; index < back.length; index += 1)
    for (const source of incoming.get(back[index] ?? '') ?? [])
      if (!seen.has(source)) {
        seen.add(source);
        back.push(source);
      }
  for (const id of seen) result.set(id, depth.get(id) ?? 0);
  return result;
}

/**
 * Le fichier par lequel ouvrir une couche : le nœud le plus profond de cette couche sur le chemin de
 * l'erreur, sinon le premier nœud de cette couche ; pour le frontend, à défaut, le handler de la
 * traçabilité frontend.
 */
export function defaultFileFor(ctx: WorkspaceContext, layer: CodeLayer): SourceLocation | undefined {
  const graph = ctx.incident.investigation.graph;
  const candidates = (graph?.nodes ?? []).flatMap((node) => {
    const source = nodeSource(ctx, node);
    return source?.layer === layer ? [{ node, source }] : [];
  });
  if (candidates.length > 0) {
    const path = errorPath(graph);
    let best: { source: SourceLocation; depth: number } | undefined;
    for (const { node, source } of candidates) {
      const depth = path.get(node.id);
      if (depth !== undefined && (best === undefined || depth > best.depth)) best = { source, depth };
    }
    return best?.source ?? candidates[0]?.source;
  }
  if (layer !== 'FRONTEND') return undefined;
  const steps = ctx.incident.investigation.frontendTrace?.steps ?? [];
  for (const step of [...steps].reverse())
    for (const link of [step.handler, step.component, ...step.services, ...step.httpClients])
      if (link?.source?.layer === 'FRONTEND') return link.source;
  return undefined;
}

/** Le fichier ouvert le plus récent d'une couche. */
export function openFor(
  ctx: WorkspaceContext,
  ui: CodeUi,
  layer: CodeLayer,
  tree?: SourceTree,
): CodeCursor | undefined {
  return ui.open.find((cursor) => layerOfApp(ctx, cursor.applicationId, tree) === layer);
}

/**
 * Ce que l'onglet d'une couche doit afficher (le contrôleur lit ce fichier) : le fichier ouvert tant que
 * la sélection n'a pas changé depuis, sinon l'endroit du code de la sélection s'il est dans la couche,
 * sinon le fichier ouvert, sinon le point de départ (`defaultFileFor`).
 */
export function codeTarget(
  ctx: WorkspaceContext,
  ui: CodeUi,
  layer: CodeLayer,
  tree?: SourceTree,
): SourceLocation | undefined {
  const cursor = openFor(ctx, ui, layer, tree);
  const selected = sourceOf(ctx.links, ctx.selection);
  const here =
    selected && (layerOfApp(ctx, selected.applicationId, tree) ?? selected.layer) === layer
      ? selected
      : undefined;
  if (cursor && (cursor.anchor === selectionKeyOf(ctx) || !here)) {
    const fallback = defaultFileFor(ctx, layer);
    const sameFile = (source: SourceLocation | undefined): boolean =>
      source?.applicationId === cursor.applicationId && source.file === cursor.file;
    const line = cursor.line ?? (sameFile(here) ? here?.line : sameFile(fallback) ? fallback?.line : 1) ?? 1;
    return { applicationId: cursor.applicationId, layer, file: cursor.file, line };
  }
  return here ?? defaultFileFor(ctx, layer);
}

/** La ligne sélectionnée d'un fichier affiché (même règle que `codeTarget`). */
export function selectedLineOf(ctx: WorkspaceContext, ui: CodeUi, view: SourceFileView): number | undefined {
  const same = (source: { applicationId: string; file: string } | undefined): boolean =>
    source?.applicationId === view.applicationId && source.file === view.file;
  const cursor = ui.open.find((entry) => same(entry));
  const selected = sourceOf(ctx.links, ctx.selection);
  const here = same(selected) ? selected : undefined;
  if (cursor?.line !== undefined && (cursor.anchor === selectionKeyOf(ctx) || !here)) return cursor.line;
  if (here) return here.line;
  const fallback = defaultFileFor(ctx, view.layer);
  return same(fallback) ? fallback?.line : undefined;
}

/** Les fichiers cités par l'investigation (graphe, chronologie, hypothèses, diagnostic) : `app:fichier` et chemins seuls. */
export function concernedFiles(ctx: WorkspaceContext): { ids: Set<string>; paths: Set<string> } {
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const [key, source] of ctx.links.sources)
    if (key.startsWith('node:') || key.startsWith('event:'))
      ids.add(fileId(source.applicationId, source.file));
  for (const node of ctx.incident.investigation.graph?.nodes ?? []) if (node.file) paths.add(node.file);
  for (const hypothesis of ctx.incident.investigation.hypotheses)
    for (const file of hypothesis.files) paths.add(file);
  for (const file of ctx.incident.investigation.diagnosis?.rootCause?.files ?? []) paths.add(file);
  return { ids, paths };
}

const isConcerned = (
  concerned: { ids: Set<string>; paths: Set<string> },
  applicationId: string,
  file: string,
): boolean => concerned.ids.has(fileId(applicationId, file)) || concerned.paths.has(file);

interface Index {
  nodes: Map<string, GraphNode>;
  hypotheses: Map<string, Hypothesis>;
  events: Map<string, TimelineEvent>;
  requests: Map<string, HttpExchange>;
  experiments: Map<string, Experiment>;
  symbols: Map<string, CodeSymbol>;
}

function indexOf(ctx: WorkspaceContext, view?: SourceFileView): Index {
  const investigation = ctx.incident.investigation;
  return {
    nodes: new Map((investigation.graph?.nodes ?? []).map((node) => [node.id, node])),
    hypotheses: new Map(investigation.hypotheses.map((entry) => [entry.id, entry])),
    events: new Map((investigation.timeline ?? []).map((event) => [event.id, event])),
    requests: new Map(
      investigation.reproductions.flatMap((run) =>
        run.requests.map((request) => [request.id, request] as const),
      ),
    ),
    experiments: new Map(investigation.experiments.map((entry) => [entry.id, entry])),
    symbols: new Map(
      [...(investigation.code?.symbols ?? []), ...(view?.symbols ?? [])].map((symbol) => [symbol.id, symbol]),
    ),
  };
}

/** La clé de sélection d'une référence libre (`kind:id`, ou un id de nœud, d'hypothèse, de symbole…). */
function refKey(ctx: WorkspaceContext, index: Index, ref: string): string | undefined {
  const colon = ref.indexOf(':');
  if (colon > 0 && (SELECTION_KINDS as readonly string[]).includes(ref.slice(0, colon))) {
    const kind = ref.slice(0, colon);
    const id = ref.slice(colon + 1);
    const known =
      ctx.links.neighbors.has(ref) ||
      (kind === 'node' && index.nodes.has(id)) ||
      (kind === 'hypothesis' && index.hypotheses.has(id)) ||
      (kind === 'event' && index.events.has(id));
    if (known) return ref;
  }
  if (index.nodes.has(ref)) return `node:${ref}`;
  if (index.hypotheses.has(ref)) return `hypothesis:${ref}`;
  if (index.events.has(ref)) return `event:${ref}`;
  if (index.requests.has(ref)) return `request:${ref}`;
  if (index.symbols.has(ref)) return `symbol:${ref}`;
  if (index.experiments.has(ref)) return `experiment:${ref}`;
  return undefined;
}

const covers = (highlight: Highlight, line: number): boolean =>
  line >= highlight.line && line <= Math.max(highlight.line, highlight.endLine ?? highlight.line);

/** Le symbole qui englobe une ligne : le plus proche déclaré avant (ou sur) elle. */
function enclosingSymbol(view: SourceFileView, line: number): CodeSymbol | undefined {
  let best: CodeSymbol | undefined;
  for (const symbol of view.symbols)
    if (symbol.line <= line && (best === undefined || symbol.line >= best.line)) best = symbol;
  return best;
}

/** Ce qui pointe sur une ligne : les clés dont l'endroit du code la couvre, leurs voisines, les signalements. */
function pointersAt(
  ctx: WorkspaceContext,
  index: Index,
  view: SourceFileView,
  line: number,
): { keys: Set<string>; reasons: Highlight[]; enclosing?: CodeSymbol } {
  const anchors = new Set<string>();
  for (const [key, source] of ctx.links.sources) {
    if (key.startsWith('file:')) continue;
    if (source.applicationId !== view.applicationId || source.file !== view.file) continue;
    if (line >= source.line && line <= Math.max(source.line, source.endLine ?? source.line)) anchors.add(key);
  }
  const enclosing = enclosingSymbol(view, line);
  if (enclosing) anchors.add(`symbol:${enclosing.id}`);
  const reasons = view.highlights.filter((highlight) => covers(highlight, line));
  for (const highlight of reasons)
    for (const ref of highlight.refs) {
      const key = refKey(ctx, index, ref);
      if (key) anchors.add(key);
    }
  const keys = new Set(anchors);
  for (const anchor of anchors)
    for (const neighbor of ctx.links.neighbors.get(anchor) ?? []) keys.add(neighbor);
  return enclosing ? { keys, reasons, enclosing } : { keys, reasons };
}

// ── Rendu : lignes de code ───────────────────────────────────────────────────────────────────

/** Au plus autant de lignes rendues (autour de la ligne visée). */
export const MAX_RENDERED_LINES = 2000;
/** Au plus autant de caractères rendus par ligne (fichiers minifiés). */
const MAX_LINE_CHARS = 4000;

const TOKEN_CLASS: Record<CodeTokenType, string> = {
  keyword: 'ws-code-k',
  string: 'ws-code-s',
  comment: 'ws-code-c',
  number: 'ws-code-n',
  annotation: 'ws-code-a',
  type: 'ws-code-y',
  tag: 'ws-code-g',
  punct: '',
  plain: '',
};

const HIGHLIGHT_ORDER: readonly HighlightKind[] = ['ERROR', 'HYPOTHESIS', 'PATH', 'SYMBOL'];
const MARKER: Record<HighlightKind, string> = { ERROR: '!', HYPOTHESIS: '?', PATH: '›', SYMBOL: '•' };

/** Les lignes à afficher : tout le fichier, ou une fenêtre de `max` lignes centrée sur la ligne visée. */
export function lineWindow(
  total: number,
  target: number,
  max = MAX_RENDERED_LINES,
): { from: number; to: number } {
  if (total <= max) return { from: 1, to: Math.max(total, 1) };
  let from = Math.max(1, target - Math.floor(max / 2));
  let to = from + max - 1;
  if (to > total) {
    to = total;
    from = total - max + 1;
  }
  return { from, to };
}

function lineHtml(lang: Lang, tokens: readonly CodeToken[]): string {
  let html = '';
  let used = 0;
  for (const token of tokens) {
    const room = MAX_LINE_CHARS - used;
    const text = token.text.length > room ? token.text.slice(0, room) : token.text;
    const cls = TOKEN_CLASS[token.type];
    html += cls ? `<span class="${cls}">${esc(text)}</span>` : esc(text);
    used += text.length;
    if (used >= MAX_LINE_CHARS) {
      html += `<span class="ws-code-cut" title="${esc(codeText(lang).lineCut)}">…</span>`;
      break;
    }
  }
  return html;
}

/** Les signalements par ligne, dans la fenêtre seulement. */
function marksIn(highlights: readonly Highlight[], from: number, to: number): Map<number, Highlight[]> {
  const marks = new Map<number, Highlight[]>();
  for (const highlight of highlights) {
    const start = Math.max(highlight.line, from);
    const end = Math.min(Math.max(highlight.line, highlight.endLine ?? highlight.line), to);
    for (let line = start; line <= end; line += 1) marks.set(line, [...(marks.get(line) ?? []), highlight]);
  }
  return marks;
}

function rowsHtml(
  lang: Lang,
  lines: readonly CodeToken[][],
  range: { from: number; to: number },
  marks: Map<number, Highlight[]>,
  selected: number | undefined,
): string {
  const t = codeText(lang);
  let html = '';
  for (let line = range.from; line <= range.to; line += 1) {
    const found = marks.get(line) ?? [];
    const kinds = HIGHLIGHT_ORDER.filter((kind) => found.some((entry) => entry.kind === kind));
    const isSelected = line === selected;
    const cls = [
      'ws-code-row',
      ...kinds.map((kind) => `ws-code-hl-${kind.toLowerCase()}`),
      isSelected ? 'ws-code-sel' : '',
    ]
      .filter(Boolean)
      .join(' ');
    const reasons = found.map((entry) => `${t.highlightKinds[entry.kind]} : ${entry.reason}`).join('\n');
    const spoken =
      found.length > 0 || isSelected
        ? `<span class="ws-code-sr">${esc(t.line(line))}${isSelected ? `, ${esc(t.selectedLine)}` : ''}${reasons ? ` — ${esc(reasons)}` : ''}. </span>`
        : '';
    const marker = kinds[0] ? `<span class="ws-code-m">${MARKER[kinds[0]]}</span>` : '';
    html += `<tr class="${cls}" data-code-line="${String(line)}"${reasons ? ` title="${esc(reasons)}"` : ''}><td class="ws-code-num" aria-hidden="true">${String(line)}</td><td class="ws-code-mark" aria-hidden="true">${marker}</td><td class="ws-code-src"><pre>${spoken}${lineHtml(lang, lines[line - 1] ?? [])}</pre></td></tr>`;
  }
  return html;
}

function readOnlyBadge(lang: Lang): string {
  const t = codeText(lang);
  return `<span class="ws-code-ro" title="${esc(t.readOnlyHint)}">${icon('lock')}${esc(t.readOnly)}</span>`;
}

function breadcrumb(ctx: WorkspaceContext, view: SourceFileView, tree?: SourceTree): string {
  const t = codeText(ctx.lang);
  const parts = view.file.split('/').filter(Boolean);
  const last = parts.pop() ?? view.file;
  return `<nav class="ws-code-crumbs" aria-label="${esc(t.crumbs)}"><ol><li><b class="ws-code-appname">${esc(appName(ctx, view.applicationId, tree))}</b></li><li><span class="ws-code-layer">${esc(partsText(ctx.lang).layers[view.layer])}</span></li>${parts.map((part) => `<li>${esc(part)}</li>`).join('')}<li aria-current="page"><b>${esc(last)}</b></li></ol></nav>`;
}

/** Un bouton « aller à la ligne » du fichier affiché. */
function gotoButton(
  ctx: WorkspaceContext,
  view: SourceFileView,
  line: number,
  content: string,
  cls = '',
  named = false,
): string {
  const label = esc(codeText(ctx.lang).gotoLine(line));
  return `<button type="button" class="ws-code-btn${cls ? ` ${cls}` : ''}" data-action="ws-code-goto" data-app="${esc(view.applicationId)}" data-file="${esc(view.file)}" data-line="${String(line)}" data-sel="${esc(selectionKeyOf(ctx))}" title="${label}"${named ? ` aria-label="${label}"` : ''}>${content}</button>`;
}

function marksList(ctx: WorkspaceContext, view: SourceFileView, selected: number | undefined): string {
  if (view.highlights.length === 0) return '';
  const t = codeText(ctx.lang);
  const sorted = [...view.highlights].sort((a, b) => a.line - b.line).slice(0, 60);
  return `<section class="ws-code-box" aria-label="${esc(t.marks)}"><h4>${esc(t.marks)}</h4><ul class="ws-code-list">${sorted
    .map(
      (entry) =>
        `<li class="ws-code-item${entry.line === selected ? ' ws-code-on' : ''}">${gotoButton(
          ctx,
          view,
          entry.line,
          `<span class="ws-code-hk ws-code-hk-${entry.kind.toLowerCase()}" title="${esc(t.highlightHints[entry.kind])}">${MARKER[entry.kind]} ${esc(t.highlightKinds[entry.kind])}</span> <span class="ws-code-ln">${esc(t.line(entry.line))}</span> <span class="ws-code-why">${esc(entry.reason)}</span>`,
          'ws-code-mk',
        )}</li>`,
    )
    .join('')}</ul></section>`;
}

function symbolNavigator(
  ctx: WorkspaceContext,
  view: SourceFileView,
  selected: number | undefined,
  involved: Set<string>,
): string {
  const t = codeText(ctx.lang);
  const symbols = [...view.symbols].sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
  const declared = new Set(symbols.map((symbol) => symbol.id));
  const items = symbols
    .map((symbol) => {
      const child = symbol.parent !== undefined && declared.has(symbol.parent);
      const hit = involved.has(symbol.id)
        ? ` <span class="ws-code-hit" title="${esc(t.concernedHint)}">${esc(t.concerned)}</span>`
        : '';
      return `<li class="ws-code-item ws-code-sym${child ? ' ws-code-child' : ''}${symbol.line === selected ? ' ws-code-on' : ''}"><span class="ws-code-kind">${esc(t.kinds[symbol.kind])}</span><button type="button" class="ws-code-btn ws-code-name ${selectionClass(ctx, 'symbol', symbol.id)}" ${selectable(ctx, 'symbol', symbol.id)} data-app="${esc(symbol.applicationId)}" data-file="${esc(symbol.file)}" data-line="${String(symbol.line)}" title="${esc(t.selectSymbol(symbol.name))}">${esc(symbol.name)}</button>${hit}${gotoButton(ctx, view, symbol.line, `:${String(symbol.line)}`, 'ws-code-ln', true)}</li>`;
    })
    .join('');
  return `<section class="ws-code-box" aria-label="${esc(t.symbols)}"><h4>${esc(t.symbols)}</h4>${
    items ? `<ul class="ws-code-list">${items}</ul>` : `<p class="mu ws-code-small">${esc(t.noSymbols)}</p>`
  }</section>`;
}

/** Les symboles cités par l'investigation (nœuds du graphe, hypothèses, chronologie, traçabilité). */
function involvedSymbolIds(ctx: WorkspaceContext): Set<string> {
  const ids = new Set<string>();
  const investigation = ctx.incident.investigation;
  for (const node of investigation.graph?.nodes ?? []) if (node.symbolId) ids.add(node.symbolId);
  for (const hypothesis of investigation.hypotheses)
    for (const { ref } of [...hypothesis.supporting, ...hypothesis.contradicting]) ids.add(ref);
  for (const event of investigation.timeline ?? [])
    if (event.source?.symbolId) ids.add(event.source.symbolId);
  for (const step of investigation.frontendTrace?.steps ?? [])
    for (const link of [step.element, step.component, step.handler, ...step.services, ...step.httpClients])
      if (link?.symbolId) ids.add(link.symbolId);
  return ids;
}

function evidencePanel(
  ctx: WorkspaceContext,
  view: SourceFileView,
  selected: number | undefined,
  index: Index,
): string {
  const t = codeText(ctx.lang);
  const layers = partsText(ctx.lang).layers;
  const fileHypotheses = [...(ctx.links.neighbors.get(`file:${fileId(view.applicationId, view.file)}`) ?? [])]
    .filter((key) => key.startsWith('hypothesis:'))
    .map((key) => key.slice('hypothesis:'.length));
  const hypothesisButton = (id: string): string => {
    const hypothesis = index.hypotheses.get(id);
    if (!hypothesis) return '';
    return `<li class="ws-code-item"><button type="button" class="ws-code-btn ${selectionClass(ctx, 'hypothesis', id)}" ${selectable(ctx, 'hypothesis', id)}>${esc(hypothesis.title)}</button> <small class="mu">${esc(t.hypothesisStatus[hypothesis.status])}</small></li>`;
  };
  if (selected === undefined) {
    const files = fileHypotheses.map(hypothesisButton).join('');
    return `<section class="ws-code-box ws-code-ev" aria-label="${esc(t.evidenceTitle)}"><p class="mu ws-code-small">${esc(t.pickLine)}</p>${
      files ? `<h5>${esc(t.fileHypotheses)}</h5><ul class="ws-code-list">${files}</ul>` : ''
    }</section>`;
  }
  const { keys, reasons, enclosing } = pointersAt(ctx, index, view, selected);
  const ids = (prefix: string): string[] =>
    [...keys].filter((key) => key.startsWith(`${prefix}:`)).map((key) => key.slice(prefix.length + 1));
  const group = (title: string, items: string[]): string =>
    items.length > 0
      ? `<h5>${esc(title)}</h5><ul class="ws-code-list">${items.slice(0, 8).join('')}</ul>`
      : '';
  const nodes = ids('node').flatMap((id) => {
    const node = index.nodes.get(id);
    return node
      ? [
          `<li class="ws-code-item"><button type="button" class="ws-code-btn ${selectionClass(ctx, 'node', id)}" ${selectable(ctx, 'node', id)}>${esc(node.label)}</button> <small class="mu">${esc(layers[node.layer])}</small></li>`,
        ]
      : [];
  });
  const hypothesisIds = ids('hypothesis');
  const hypotheses = hypothesisIds.map(hypothesisButton).filter(Boolean);
  const events = ids('event').flatMap((id) => {
    const event = index.events.get(id);
    return event
      ? [
          `<li class="ws-code-item"><button type="button" class="ws-code-btn ${selectionClass(ctx, 'event', id)}" ${selectable(ctx, 'event', id)}>${esc(event.summary)}</button>${event.step !== undefined ? ` <small class="mu">${esc(t.step(event.step))}</small>` : ''}</li>`,
        ]
      : [];
  });
  const requests = ids('request').flatMap((id) => {
    const request = index.requests.get(id);
    return request
      ? [
          `<li class="ws-code-item"><button type="button" class="ws-code-btn ${selectionClass(ctx, 'request', id)}" ${selectable(ctx, 'request', id)}><code>${esc(request.method.toUpperCase())} ${esc(request.path)}</code></button>${request.status !== undefined ? ` <small class="mu">${String(request.status)}</small>` : ''}</li>`,
        ]
      : [];
  });
  const experiments = ids('experiment').flatMap((id) => {
    const experiment = index.experiments.get(id);
    return experiment
      ? [
          `<li class="ws-code-item"><button type="button" class="ws-code-btn ${selectionClass(ctx, 'experiment', id)}" ${selectable(ctx, 'experiment', id)}>${esc(experiment.description)}</button></li>`,
        ]
      : [];
  });
  const flagged = reasons.map(
    (entry) =>
      `<li class="ws-code-item"><span class="ws-code-hk ws-code-hk-${entry.kind.toLowerCase()}">${MARKER[entry.kind]} ${esc(t.highlightKinds[entry.kind])}</span> <span class="ws-code-why">${esc(entry.reason)}</span></li>`,
  );
  const fileOnly = fileHypotheses.filter((id) => !hypothesisIds.includes(id)).map(hypothesisButton);
  const body =
    group(t.groups.reasons, flagged) +
    group(t.groups.nodes, nodes) +
    group(t.groups.hypotheses, hypotheses) +
    group(t.groups.events, events) +
    group(t.groups.requests, requests) +
    group(t.groups.experiments, experiments);
  const near = enclosing
    ? `<p class="ws-code-small"><span class="mu">${esc(t.nearest)} :</span> <button type="button" class="ws-code-btn ${selectionClass(ctx, 'symbol', enclosing.id)}" ${selectable(ctx, 'symbol', enclosing.id)}>${esc(enclosing.name)}</button></p>`
    : '';
  return `<section class="ws-code-box ws-code-ev" aria-label="${esc(t.pointsHere(selected))}"><h4>${esc(t.pointsHere(selected))}</h4>${near}${
    body || `<p class="mu ws-code-small">${esc(t.nothingHere)}</p>`
  }${group(t.fileHypotheses, fileOnly)}</section>`;
}

/**
 * LE VISUALISEUR : chemin (application, couche, dossiers), badge « Lecture seule », numéros de ligne en
 * gouttière (non sélectionnables, masqués aux lecteurs d'écran), coloration, lignes signalées (style et
 * repère par nature, raison en infobulle et en liste), ligne sélectionnée (`.ws-code-sel`, que le
 * contrôleur fait défiler en vue), symboles du fichier, ce qui mène à la ligne. Les fichiers longs sont
 * rendus par fenêtre de 2 000 lignes autour de la ligne visée.
 */
export function renderSourceView(
  ctx: WorkspaceContext,
  ui: CodeUi,
  view: SourceFileView | undefined,
  state?: CodeLoadState,
  tree?: SourceTree,
): string {
  const t = codeText(ctx.lang);
  if (!ctx.can('RUN')) return panelState(ctx.lang, 'denied', t.deniedCode);
  if (state === 'loading') return panelState(ctx.lang, 'loading', t.loadingFile);
  if (state !== undefined) return panelState(ctx.lang, 'error', state.error, 'ws-code-reload');
  if (!view) return panelState(ctx.lang, 'empty', t.noFile);

  const lines = linesOf(view);
  const total = view.text === '' ? 0 : lines.length;
  const selected = selectedLineOf(ctx, ui, view);
  const firstMark = [...view.highlights].sort((a, b) => a.line - b.line)[0]?.line;
  const target = Math.min(Math.max(1, selected ?? firstMark ?? 1), Math.max(total, 1));
  const range = lineWindow(total, target);
  const windowed = total > range.to - range.from + 1;
  const index = indexOf(ctx, view);
  const involved = involvedSymbolIds(ctx);
  const head = `<header class="ws-code-head">${breadcrumb(ctx, view, tree)}<span class="ws-code-meta">${readOnlyBadge(ctx.lang)}<span class="ws-code-kind">${esc(t.languages[tokenLanguageOf(view.file, view.language)])}</span><span class="mu ws-code-small">${esc(t.lines(total))}</span></span></header>`;
  const notice = windowed
    ? `<p class="ws-code-note" role="note">${esc(t.windowed(range.from, range.to, total))}</p>`
    : '';
  const code =
    total === 0
      ? `<p class="mu ws-code-small">${esc(t.emptyFile)}</p>`
      : `<div class="ws-code-scroll" tabindex="0" role="region" aria-label="${esc(t.codeOf(view.file))}"><table class="ws-code-table" role="presentation"><tbody>${rowsHtml(ctx.lang, lines, range, marksIn(view.highlights, range.from, range.to), selected)}</tbody></table></div>`;
  return `<section class="ws-code" data-app="${esc(view.applicationId)}" data-file="${esc(view.file)}" aria-label="${esc(t.codeOf(view.file))}">${head}${notice}<div class="ws-code-body"><div class="ws-code-main">${code}</div><aside class="ws-code-side">${marksList(ctx, view, selected)}${evidencePanel(ctx, view, selected, index)}${symbolNavigator(ctx, view, selected, involved)}</aside></div></section>`;
}

// ── Rendu : arborescence ─────────────────────────────────────────────────────────────────────

interface Folder {
  name: string;
  path: string;
  folders: Map<string, Folder>;
  files: string[];
}

function folderTree(files: readonly string[]): Folder {
  const root: Folder = { name: '', path: '', folders: new Map(), files: [] };
  for (const file of files) {
    const parts = file.split('/').filter(Boolean);
    parts.pop();
    let current = root;
    for (const part of parts) {
      const path = current.path ? `${current.path}/${part}` : part;
      let next = current.folders.get(part);
      if (!next) {
        next = { name: part, path, folders: new Map(), files: [] };
        current.folders.set(part, next);
      }
      current = next;
    }
    current.files.push(file);
  }
  return root;
}

/** Les fichiers listés par application au plus (au-delà : préciser la recherche). */
const MAX_TREE_FILES = 1500;
/** Une application d'au plus autant de fichiers a ses dossiers dépliés par défaut. */
const SMALL_APP = 60;

function matchesSearch(file: string, search: string): boolean {
  const query = search.trim().toLowerCase();
  if (!query) return true;
  return (query.includes('/') ? file : baseName(file)).toLowerCase().includes(query);
}

/**
 * L'ARBORESCENCE DU PÉRIMÈTRE : par application (nom, couche), dossiers repliables (`ws-code-folder`),
 * fichiers (`ws-code-open`, état de sélection `file`, fichier affiché en `aria-current`), fichiers cités
 * par l'investigation marqués « concerné », recherche par nom (`data-ws-field="code-search"`), chemins
 * refusés par le périmètre (« Hors périmètre ») avec leur raison, listes partielles signalées.
 * `layer` restreint l'arborescence à une couche (onglets Frontend, BFF, Backend).
 */
export function renderSourceTree(
  ctx: WorkspaceContext,
  ui: CodeUi,
  tree: SourceTree | undefined,
  state?: CodeLoadState,
  layer?: CodeLayer,
): string {
  const t = codeText(ctx.lang);
  if (!ctx.can('RUN')) return panelState(ctx.lang, 'denied', t.deniedCode);
  if (state === 'loading' || (!tree && state === undefined))
    return panelState(ctx.lang, 'loading', t.loadingTree);
  if (state !== undefined) return panelState(ctx.lang, 'error', state.error, 'ws-code-reload');
  if (!tree) return panelState(ctx.lang, 'empty', t.noTree);

  const applications = tree.applications.filter((entry) => !layer || entry.layer === layer);
  const concerned = concernedFiles(ctx);
  const searching = ui.search.trim() !== '';
  const targets = new Map<CodeLayer, SourceLocation | undefined>();
  const targetOf = (codeLayer: CodeLayer): SourceLocation | undefined => {
    if (!targets.has(codeLayer)) targets.set(codeLayer, codeTarget(ctx, ui, codeLayer, tree));
    return targets.get(codeLayer);
  };
  let matched = 0;

  const appHtml = applications
    .map((application) => {
      const appId = application.applicationId;
      const target = targetOf(application.layer);
      const current = target?.applicationId === appId ? target.file : undefined;
      const files = application.files.filter((file) => matchesSearch(file, ui.search));
      matched += files.length;
      const shown = files.slice(0, MAX_TREE_FILES);
      // Les dossiers qui mènent à un fichier concerné ou au fichier affiché sont dépliés par défaut.
      const interesting = new Set<string>();
      for (const file of shown)
        if (file === current || isConcerned(concerned, appId, file)) {
          const parts = file.split('/');
          for (let size = 1; size < parts.length; size += 1) interesting.add(parts.slice(0, size).join('/'));
        }
      const fileHtml = (file: string): string => {
        const id = fileId(appId, file);
        const isCurrent = file === current;
        const hit = isConcerned(concerned, appId, file)
          ? `<span class="ws-code-hit" title="${esc(t.concernedHint)}">${esc(t.concerned)}</span>`
          : '';
        return `<li><button type="button" class="ws-code-file${isCurrent ? ' ws-code-cur' : ''} ${selectionClass(ctx, 'file', id)}" data-action="ws-code-open" data-app="${esc(appId)}" data-file="${esc(file)}" data-layer="${application.layer}" data-sel="${esc(selectionKeyOf(ctx))}" data-kind="file" data-ref="${esc(id)}"${isCurrent ? ' aria-current="true"' : ''} title="${esc(t.openFile(file))}">${icon('file')}<span class="ws-code-fname">${esc(baseName(file))}</span>${hit}</button></li>`;
      };
      const folderHtml = (folder: Folder): string => {
        const subfolders = [...folder.folders.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
        const sortedFiles = [...folder.files].sort((a, b) => (a < b ? -1 : 1));
        return `${subfolders
          .map((sub) => {
            // Une chaîne de dossiers sans fichier se lit d'un trait (src/main/java/org/example).
            let node = sub;
            let name = sub.name;
            while (node.files.length === 0 && node.folders.size === 1) {
              const only = [...node.folders.values()][0];
              if (!only) break;
              name = `${name}/${only.name}`;
              node = only;
            }
            const key = `${appId}:${node.path}`;
            const open =
              ui.folders[key] ??
              (searching || application.files.length <= SMALL_APP || interesting.has(node.path));
            return `<li><button type="button" class="ws-code-folder" data-action="ws-code-folder" data-folder="${esc(key)}" data-open="${String(open)}" aria-expanded="${String(open)}" aria-label="${esc(t.folder(name, open))}" title="${esc(name)}">${icon('folder')}<span class="ws-code-fname">${esc(name)}</span></button>${
              open ? `<ul class="ws-code-nodes">${folderHtml(node)}</ul>` : ''
            }</li>`;
          })
          .join('')}${sortedFiles.map(fileHtml).join('')}`;
      };
      const notes = [
        application.truncated ? `<p class="ws-code-note" role="note">${esc(t.appTruncated)}</p>` : '',
        files.length > shown.length
          ? `<p class="ws-code-note" role="note">${esc(t.shownFirst(shown.length, files.length))}</p>`
          : '',
      ].join('');
      return `<section class="ws-code-app" aria-label="${esc(application.name)}"><h4 class="ws-code-app-h"><span>${esc(application.name)}</span><span class="ws-code-layer">${esc(partsText(ctx.lang).layers[application.layer])}</span><small class="mu">${esc(t.files(application.files.length))}</small></h4>${notes}${
        shown.length > 0 ? `<ul class="ws-code-nodes ws-code-root">${folderHtml(folderTree(shown))}</ul>` : ''
      }</section>`;
    })
    .join('');

  const search = `<div class="ws-code-search" role="search"><input type="search" data-ws-field="code-search" value="${esc(ui.search)}" placeholder="${esc(t.searchPlaceholder)}" aria-label="${esc(t.search)}" autocomplete="off" spellcheck="false">${
    searching
      ? `<button type="button" class="ws-code-btn" data-action="ws-code-search-clear" aria-label="${esc(t.clearSearch)}" title="${esc(t.clearSearch)}">${icon('x')}</button>`
      : ''
  }</div>${
    searching
      ? `<p class="mu ws-code-small ws-code-count">${esc(matched > 0 ? t.matches(matched) : t.noMatch)}</p>`
      : ''
  }`;
  const denied =
    tree.denied.length > 0
      ? `<details class="ws-code-denied"${tree.denied.length <= 5 ? ' open' : ''}><summary>${icon('ban')}${esc(t.denied(tree.denied.length))}</summary><p class="mu ws-code-small">${esc(t.deniedHint)}</p><ul class="ws-code-list">${tree.denied
          .map(
            (entry) =>
              `<li class="ws-code-item"><code>${esc(entry.path)}</code><span class="mu ws-code-small">${esc(entry.reason)}</span></li>`,
          )
          .join('')}</ul></details>`
      : '';
  const body =
    applications.length > 0
      ? appHtml
      : panelState(ctx.lang, 'empty', layer ? t.noLayerApp(partsText(ctx.lang).layers[layer]) : t.noTree);
  return `<nav class="ws-code-tree" aria-label="${esc(t.tree)}">${search}${body}${denied}</nav>`;
}

// ── Rendu : onglets par couche ───────────────────────────────────────────────────────────────

interface Involved {
  kind: SelectionKind;
  id: string;
  label: string;
  detail: string;
  source: SourceLocation;
}

/** Ce qui, dans une couche, est en jeu dans l'investigation : nœuds du graphe, symboles des hypothèses, traçabilité, chronologie. */
function involvedIn(ctx: WorkspaceContext, layer: CodeLayer, index: Index): Involved[] {
  const t = codeText(ctx.lang);
  const found = new Map<string, Involved>();
  const add = (entry: Involved): void => {
    const key = `${entry.kind}:${entry.id}`;
    if (!found.has(key) && found.size < 24) found.set(key, entry);
  };
  const symbolDetail = (symbolId: string | undefined): string => {
    const symbol = symbolId ? index.symbols.get(symbolId) : undefined;
    return symbol ? t.kinds[symbol.kind] : '';
  };
  const investigation = ctx.incident.investigation;
  for (const node of investigation.graph?.nodes ?? []) {
    const source = nodeSource(ctx, node);
    if (source?.layer === layer)
      add({ kind: 'node', id: node.id, label: node.label, detail: symbolDetail(node.symbolId), source });
  }
  for (const hypothesis of investigation.hypotheses)
    for (const { ref } of [...hypothesis.supporting, ...hypothesis.contradicting]) {
      const symbol = index.symbols.get(ref);
      const source = ctx.links.sources.get(`symbol:${ref}`);
      if (symbol?.layer === layer && source)
        add({ kind: 'symbol', id: ref, label: symbol.name, detail: t.kinds[symbol.kind], source });
    }
  if (layer === 'FRONTEND')
    for (const step of investigation.frontendTrace?.steps ?? [])
      for (const link of [step.component, step.handler, ...step.services, ...step.httpClients])
        if (link?.symbolId && link.source?.layer === 'FRONTEND')
          add({
            kind: 'symbol',
            id: link.symbolId,
            label: link.label,
            detail: symbolDetail(link.symbolId),
            source: link.source,
          });
  for (const event of investigation.timeline ?? [])
    if (event.source?.layer === layer)
      add({ kind: 'event', id: event.id, label: event.summary, detail: '', source: event.source });
  return [...found.values()];
}

function involvedList(ctx: WorkspaceContext, layer: CodeLayer, start: SourceLocation | undefined): string {
  const t = codeText(ctx.lang);
  const items = involvedIn(ctx, layer, indexOf(ctx));
  const isStart = (source: SourceLocation): boolean =>
    start?.applicationId === source.applicationId && start.file === source.file && start.line === source.line;
  const list = items
    .map(
      (entry) =>
        `<li class="ws-code-item"><button type="button" class="ws-code-btn ws-code-name ${selectionClass(ctx, entry.kind, entry.id)}" ${selectable(ctx, entry.kind, entry.id)}>${esc(entry.label)}</button>${entry.detail ? `<span class="ws-code-kind">${esc(entry.detail)}</span>` : ''}<button type="button" class="ws-code-btn ws-code-ln" data-action="ws-code-open" data-app="${esc(entry.source.applicationId)}" data-file="${esc(entry.source.file)}" data-line="${String(entry.source.line)}" data-layer="${layer}" data-sel="${esc(selectionKeyOf(ctx))}" title="${esc(partsText(ctx.lang).openCode(entry.source.file, entry.source.line))}"><code>${esc(baseName(entry.source.file))}:${String(entry.source.line)}</code></button>${isStart(entry.source) ? `<span class="ws-code-start">${esc(t.start)}</span>` : ''}</li>`,
    )
    .join('');
  return `<section class="ws-code-box ws-code-inv" aria-label="${esc(t.involved)}"><h4>${esc(t.involved)}</h4>${
    list ? `<ul class="ws-code-list">${list}</ul>` : `<p class="mu ws-code-small">${esc(t.noInvolved)}</p>`
  }</section>`;
}

/**
 * L'ONGLET D'UNE COUCHE (Frontend, BFF, Backend) : ce qui y est en jeu dans l'investigation,
 * l'arborescence restreinte à la couche et le fichier visé (`codeTarget` : celui que le contrôleur lit et
 * passe en `view`). `state` est celui de la lecture du fichier, `treeState` celui de l'arborescence.
 */
export function renderLayerCode(
  ctx: WorkspaceContext,
  ui: CodeUi,
  layer: CodeLayer,
  tree: SourceTree | undefined,
  view: SourceFileView | undefined,
  state?: CodeLoadState,
  treeState?: CodeLoadState,
): string {
  const t = codeText(ctx.lang);
  const layerName = partsText(ctx.lang).layers[layer];
  const inScope =
    (tree?.applications.some((entry) => entry.layer === layer) ?? false) ||
    ctx.incident.scope.applications.some((entry) => entry.layer === layer);
  const head = `${demoBanner(ctx)}<h3 class="ws-code-title">${icon('code')}${esc(t.layerCode(layerName))} ${readOnlyBadge(ctx.lang)}</h3>`;
  if (!ctx.can('RUN'))
    return `<section class="ws-code-layer-tab" aria-label="${esc(t.layerCode(layerName))}">${head}${panelState(ctx.lang, 'denied', t.deniedCode)}</section>`;
  if (tree && !inScope)
    return `<section class="ws-code-layer-tab" aria-label="${esc(t.layerCode(layerName))}">${head}${panelState(ctx.lang, 'empty', t.noLayerApp(layerName))}</section>`;
  const start = defaultFileFor(ctx, layer);
  const target = codeTarget(ctx, ui, layer, tree);
  const shown = view && view.layer === layer ? view : undefined;
  const viewer =
    shown || state !== undefined
      ? renderSourceView(ctx, ui, shown, state, tree)
      : `${panelState(ctx.lang, 'empty', t.noFile)}${
          target
            ? `<p class="ws-code-small"><button type="button" class="btn small" data-action="ws-code-open" data-app="${esc(target.applicationId)}" data-file="${esc(target.file)}" data-line="${String(target.line)}" data-layer="${layer}" data-sel="${esc(selectionKeyOf(ctx))}">${esc(t.startHere(baseName(target.file), target.line))}</button></p>`
            : ''
        }`;
  return `<section class="ws-code-layer-tab" data-layer="${layer}" aria-label="${esc(t.layerCode(layerName))}">${head}${involvedList(ctx, layer, start)}<div class="ws-code-layer-grid"><div class="ws-code-layer-tree">${renderSourceTree(ctx, ui, tree, treeState, layer)}</div><div class="ws-code-layer-view">${viewer}</div></div></section>`;
}

// ── Rendu : extrait pour le panneau latéral ──────────────────────────────────────────────────

/** Quelques lignes autour d'un endroit du code (panneau contextuel), avec un lien vers l'explorateur. */
export function renderCodeExcerpt(
  ctx: WorkspaceContext,
  view: SourceFileView | undefined,
  line: number,
  around = 6,
): string {
  if (!view) return '';
  const t = codeText(ctx.lang);
  const lines = linesOf(view);
  const total = view.text === '' ? 0 : lines.length;
  if (total === 0) return `<p class="mu ws-code-small">${esc(t.emptyFile)}</p>`;
  const target = Math.min(Math.max(1, Number.isFinite(line) ? Math.trunc(line) : 1), total);
  const spread = Math.min(Math.max(0, Number.isFinite(around) ? Math.trunc(around) : 6), 200);
  const range = { from: Math.max(1, target - spread), to: Math.min(total, target + spread) };
  const label = t.excerpt(baseName(view.file), target);
  return `<figure class="ws-code-ex" aria-label="${esc(label)}"><figcaption class="ws-code-ex-h"><code title="${esc(view.file)}">${esc(baseName(view.file))}:${String(target)}</code>${readOnlyBadge(ctx.lang)}<button type="button" class="lnk ws-code-small" data-action="ws-code-open" data-app="${esc(view.applicationId)}" data-file="${esc(view.file)}" data-line="${String(target)}" data-layer="${view.layer}" data-sel="${esc(selectionKeyOf(ctx))}">${esc(t.openInExplorer)}</button></figcaption><div class="ws-code-scroll" tabindex="0" role="region" aria-label="${esc(label)}"><table class="ws-code-table" role="presentation"><tbody>${rowsHtml(ctx.lang, lines, range, marksIn(view.highlights, range.from, range.to), target)}</tbody></table></div></figure>`;
}

// ── Styles ───────────────────────────────────────────────────────────────────────────────────

/** Les styles de l'explorateur (jetons du thème : clair et sombre). */
export const INCIDENT_CODE_CSS = `
.ws-code,.ws-code-tree,.ws-code-layer-tab{display:flex;flex-direction:column;gap:10px;min-width:0}
.ws-code-title{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:0;font-size:16px}
.ws-code-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px}
.ws-code-meta{display:inline-flex;flex-wrap:wrap;align-items:center;gap:8px}
.ws-code-small{font-size:12px;margin:0}
.ws-code-crumbs ol{display:flex;flex-wrap:wrap;align-items:center;gap:2px 4px;list-style:none;margin:0;padding:0;font-size:13px;color:var(--qa-color-muted);overflow-wrap:break-word}
.ws-code-crumbs li+li::before{content:"/";margin-right:4px;color:var(--qa-color-muted)}
.ws-code-crumbs [aria-current]{color:var(--qa-color-text)}
.ws-code-appname{color:var(--qa-color-text)}
.ws-code-layer,.ws-code-kind,.ws-code-start{display:inline-block;padding:0 7px;border-radius:999px;font-size:11px;font-weight:600;white-space:nowrap;background:var(--qa-color-surface-2);color:var(--qa-color-muted);border:1px solid var(--qa-color-border)}
.ws-code-start{background:color-mix(in srgb,var(--qa-color-primary) 14%,transparent);color:color-mix(in srgb,var(--qa-color-primary) 80%,var(--qa-color-text));border-color:transparent}
.ws-code-ro{display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border-radius:999px;border:1px solid var(--qa-color-border);font-size:12px;font-weight:600;color:var(--qa-color-muted);background:var(--qa-color-surface)}
.ws-code-ro .ico{width:13px;height:13px}
.ws-code-note{margin:0;padding:6px 10px;border-radius:8px;font-size:13px;border:1px solid color-mix(in srgb,var(--qa-color-warning) 45%,transparent);background:color-mix(in srgb,var(--qa-color-warning) 12%,transparent)}
.ws-code-body,.ws-code-layer-grid{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start}
.ws-code-main{flex:3 1 420px;min-width:0}
.ws-code-side{flex:1 1 220px;min-width:0;display:flex;flex-direction:column;gap:10px}
.ws-code-layer-tree{flex:1 1 280px;min-width:min(100%,260px)}
.ws-code-layer-view{flex:3 1 440px;min-width:0}
@media (min-width:1100px){.ws-code-side{max-width:340px}.ws-code-layer-tree{max-width:380px}}
.ws-code-scroll{position:relative;max-height:min(62vh,700px);overflow-x:auto;overflow-y:auto;overscroll-behavior-x:contain;border:1px solid var(--qa-color-border);border-radius:10px;background:linear-gradient(to left,var(--qa-color-surface) 40%,transparent) right center/36px 100% no-repeat local,radial-gradient(farthest-side at 100% 50%,color-mix(in srgb,var(--qa-color-text) 22%,transparent),transparent) right center/14px 100% no-repeat scroll,var(--qa-color-surface)}
.ws-code-scroll:focus-visible{outline:2px solid var(--qa-color-primary);outline-offset:2px}
.ws-code-table{border-collapse:collapse;width:100%;font:13px/1.55 var(--qa-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace);color:var(--qa-color-text)}
.ws-code-table td{padding:0;vertical-align:top}
.ws-code-num{position:sticky;left:0;z-index:1;min-width:4ch;padding:0 8px 0 10px!important;text-align:right;color:var(--qa-color-muted);background:var(--qa-color-surface);border-right:1px solid var(--qa-color-border);user-select:none;-webkit-user-select:none}
.ws-code-mark{width:16px;min-width:16px;text-align:center;user-select:none;-webkit-user-select:none;font-weight:700}
.ws-code-src{width:100%}
.ws-code-src pre{margin:0;padding:0 14px 0 4px;white-space:pre;tab-size:4;font:inherit;color:inherit;background:none;border:0;min-height:1.55em}
.ws-code-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap}
.ws-code-cut{color:var(--qa-color-muted);padding:0 4px}
.ws-code-k{color:color-mix(in srgb,var(--qa-color-primary) 80%,var(--qa-color-text));font-weight:600}
.ws-code-s{color:color-mix(in srgb,var(--qa-color-success) 55%,var(--qa-color-text))}
.ws-code-c{color:var(--qa-color-muted);font-style:italic}
.ws-code-n{color:color-mix(in srgb,var(--qa-color-warning) 62%,var(--qa-color-text))}
.ws-code-a{color:color-mix(in srgb,color-mix(in srgb,var(--qa-color-primary) 55%,var(--qa-color-danger)) 75%,var(--qa-color-text))}
.ws-code-y{color:color-mix(in srgb,color-mix(in srgb,var(--qa-color-success) 45%,var(--qa-color-primary)) 75%,var(--qa-color-text))}
.ws-code-g{color:color-mix(in srgb,var(--qa-color-danger) 65%,var(--qa-color-text))}
.ws-code-hl-symbol{background:color-mix(in srgb,var(--qa-color-success) 8%,transparent)}
.ws-code-hl-symbol .ws-code-mark{color:color-mix(in srgb,var(--qa-color-success) 62%,var(--qa-color-text));box-shadow:inset 3px 0 0 color-mix(in srgb,var(--qa-color-success) 60%,transparent)}
.ws-code-hl-path{background:color-mix(in srgb,var(--qa-color-primary) 9%,transparent)}
.ws-code-hl-path .ws-code-mark{color:color-mix(in srgb,var(--qa-color-primary) 80%,var(--qa-color-text));box-shadow:inset 3px 0 0 var(--qa-color-primary)}
.ws-code-hl-hypothesis{background:color-mix(in srgb,var(--qa-color-warning) 14%,transparent)}
.ws-code-hl-hypothesis .ws-code-mark{color:color-mix(in srgb,var(--qa-color-warning) 62%,var(--qa-color-text));border-left:3px dashed var(--qa-color-warning)}
.ws-code-hl-error{background:color-mix(in srgb,var(--qa-color-danger) 15%,transparent)}
.ws-code-hl-error .ws-code-mark{color:color-mix(in srgb,var(--qa-color-danger) 70%,var(--qa-color-text));border-left:0;box-shadow:inset 4px 0 0 var(--qa-color-danger)}
.ws-code-sel{background:color-mix(in srgb,var(--qa-color-primary) 20%,transparent)}
.ws-code-sel td{box-shadow:inset 0 1px 0 color-mix(in srgb,var(--qa-color-primary) 55%,transparent),inset 0 -1px 0 color-mix(in srgb,var(--qa-color-primary) 55%,transparent)}
.ws-code-sel .ws-code-num{color:var(--qa-color-text);font-weight:700;background:color-mix(in srgb,var(--qa-color-primary) 22%,var(--qa-color-surface))}
.ws-code-box{border:1px solid var(--qa-color-border);border-radius:10px;padding:10px;background:var(--qa-color-surface);min-width:0}
.ws-code-box h4{margin:0 0 6px;font-size:13px}
.ws-code-box h5{margin:8px 0 4px;font-size:12px;color:var(--qa-color-muted)}
.ws-code-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px;max-height:320px;overflow:auto}
.ws-code-item{display:flex;flex-wrap:wrap;align-items:center;gap:4px 6px;min-width:0;border-radius:6px}
.ws-code-item.ws-code-on{background:color-mix(in srgb,var(--qa-color-primary) 12%,transparent)}
.ws-code-child{padding-left:14px}
.ws-code-btn,.ws-code-file,.ws-code-folder{appearance:none;border:0;background:none;color:var(--qa-color-text);font:inherit;font-size:13px;text-align:left;padding:3px 6px;border-radius:6px;cursor:pointer;min-width:0;min-height:28px;overflow-wrap:break-word}
.ws-code-btn:hover,.ws-code-file:hover,.ws-code-folder:hover{background:color-mix(in srgb,var(--qa-color-primary) 9%,transparent)}
.ws-code-btn:focus-visible,.ws-code-file:focus-visible,.ws-code-folder:focus-visible{outline:2px solid var(--qa-color-primary);outline-offset:1px}
.ws-code-name{font-weight:600}
.ws-code-ln{font:12px var(--qa-font-family-mono,ui-monospace,monospace);color:var(--qa-color-muted)}
.ws-code-ln code{background:none;border:0;padding:0}
.ws-code-mk{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 6px;width:100%}
.ws-code-why{color:var(--qa-color-text);font-size:12px}
.ws-code-hk{font-size:11px;font-weight:700;padding:0 6px;border-radius:999px;white-space:nowrap}
.ws-code-hk-error{color:color-mix(in srgb,var(--qa-color-danger) 70%,var(--qa-color-text));background:color-mix(in srgb,var(--qa-color-danger) 14%,transparent)}
.ws-code-hk-path{color:color-mix(in srgb,var(--qa-color-primary) 80%,var(--qa-color-text));background:color-mix(in srgb,var(--qa-color-primary) 12%,transparent)}
.ws-code-hk-hypothesis{color:color-mix(in srgb,var(--qa-color-warning) 62%,var(--qa-color-text));background:color-mix(in srgb,var(--qa-color-warning) 16%,transparent)}
.ws-code-hk-symbol{color:color-mix(in srgb,var(--qa-color-success) 62%,var(--qa-color-text));background:color-mix(in srgb,var(--qa-color-success) 12%,transparent)}
.ws-code-hit{font-size:11px;font-weight:600;padding:0 6px;border-radius:999px;white-space:nowrap;flex:none;color:color-mix(in srgb,var(--qa-color-danger) 55%,var(--qa-color-text));background:color-mix(in srgb,var(--qa-color-danger) 12%,transparent)}
.ws-code-search{display:flex;align-items:center;gap:6px}
.ws-code-search input{flex:1;min-width:0;padding:6px 10px;border:1px solid var(--qa-color-border);border-radius:8px;background:var(--qa-color-surface);color:var(--qa-color-text);font:inherit;font-size:13px}
.ws-code-search input:focus-visible{outline:2px solid var(--qa-color-primary);outline-offset:1px;border-color:var(--qa-color-primary)}
.ws-code-app{display:flex;flex-direction:column;gap:4px;min-width:0}
.ws-code-app-h{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:0;font-size:13px}
.ws-code-nodes{list-style:none;margin:0;padding:0 0 0 12px;min-width:0}
.ws-code-root{padding-left:0;max-height:min(60vh,640px);overflow:auto}
.ws-code-file,.ws-code-folder{display:flex;align-items:center;gap:6px;width:100%}
.ws-code-folder{color:var(--qa-color-muted);font-weight:600}
.ws-code-folder .ico,.ws-code-file .ico{flex:none;width:15px;height:15px}
.ws-code-folder[aria-expanded="true"] .ico{color:var(--qa-color-primary)}
.ws-code-fname{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ws-code-cur{background:color-mix(in srgb,var(--qa-color-primary) 15%,transparent);font-weight:600}
.ws-code-denied{border:1px dashed var(--qa-color-border-strong);border-radius:10px;padding:8px 10px}
.ws-code-denied summary{display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;font-weight:600}
.ws-code-denied .ico{width:15px;height:15px;color:var(--qa-color-danger)}
.ws-code-denied .ws-code-item{flex-direction:column;align-items:flex-start;padding:4px 0}
.ws-code-ex{margin:0;display:flex;flex-direction:column;gap:6px;min-width:0}
.ws-code-ex-h{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.ws-code-ex .ws-code-table{font-size:12px}
.ws-code-ex .ws-code-scroll{max-height:320px}
`;
