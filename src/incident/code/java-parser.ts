import { tokenizeJava, type JavaToken } from './java-lexer.js';

/**
 * Le PARSEUR Java (niveau jetons) : la structure d'un fichier sans grammaire complète. Il lit le
 * package, les imports, les types (classes, interfaces, enums, records, annotations — imbriqués
 * compris) avec leurs annotations et arguments, les champs et leurs types (génériques compris), les
 * constructeurs, les méthodes (annotations, paramètres, `throws`, ligne, corps). Le corps d'une
 * méthode reste une plage de jetons : l'analyse Spring y cherche appels, URL, exceptions. Un
 * morceau illisible est sauté jusqu'au prochain `;` ou bloc équilibré, jamais deviné.
 */

export interface JavaTypeRef {
  /** Le texte du type, espaces retirés (« List<Map<String,Long>> »). */
  text: string;
  /** Le nom simple de la base (« List », « JpaRepository », « Map.Entry » → « Entry »). */
  name: string;
  args: JavaTypeRef[];
  array: boolean;
}

/** Une valeur d'argument d'annotation : ses morceaux séparés par `+` (chaînes ou noms). */
export interface JavaAnnotationValue {
  parts: ({ string: string } | { name: string })[];
  text: string;
}

export interface JavaAnnotation {
  /** Nom simple (« GetMapping »). */
  name: string;
  qualified: string;
  line: number;
  /** Arguments par clé ; un argument unique sans clé est `value`. Un tableau `{a, b}` donne plusieurs valeurs. */
  args: Record<string, JavaAnnotationValue[]>;
  /** Le texte de l'annotation, espaces normalisés (« @Size(max = 200) »). */
  text: string;
}

export interface JavaParam {
  name: string;
  type: JavaTypeRef;
  annotations: JavaAnnotation[];
  line: number;
}

export interface JavaField {
  name: string;
  type: JavaTypeRef;
  annotations: JavaAnnotation[];
  modifiers: string[];
  line: number;
  /** Les jetons de l'initialiseur (sans `=` ni `;`). */
  initializer?: { start: number; end: number };
}

export interface JavaMethod {
  name: string;
  constructor: boolean;
  returnType?: JavaTypeRef;
  params: JavaParam[];
  annotations: JavaAnnotation[];
  modifiers: string[];
  throws: string[];
  line: number;
  endLine: number;
  /** Les jetons du corps, accolades exclues ; absent pour une méthode abstraite. */
  body?: { start: number; end: number };
}

export type JavaTypeKind = 'class' | 'interface' | 'enum' | 'record' | 'annotation';

export interface JavaTypeDecl {
  kind: JavaTypeKind;
  /** Nom simple, préfixé par le type englobant pour un type imbriqué (« Outer.Inner »). */
  name: string;
  simpleName: string;
  qualifiedName: string;
  outer?: string;
  annotations: JavaAnnotation[];
  modifiers: string[];
  extends: JavaTypeRef[];
  implements: JavaTypeRef[];
  /** Composants d'un record. */
  components: JavaParam[];
  fields: JavaField[];
  methods: JavaMethod[];
  enumConstants: string[];
  line: number;
  endLine: number;
}

export interface JavaFile {
  package?: string;
  imports: string[];
  staticImports: string[];
  types: JavaTypeDecl[];
  tokens: JavaToken[];
  source: string;
}

const MODIFIERS = new Set([
  'public',
  'private',
  'protected',
  'static',
  'final',
  'abstract',
  'native',
  'synchronized',
  'transient',
  'volatile',
  'strictfp',
  'default',
  'sealed',
]);

const TYPE_KEYWORDS = new Set(['class', 'interface', 'enum', 'record']);

export function parseJava(source: string): JavaFile {
  const tokens = tokenizeJava(source);
  const parser = new Parser(tokens, source);
  return parser.parseFile();
}

/** Le texte d'une plage de jetons tel qu'écrit dans la source, espaces normalisés. */
export function sourceText(file: Pick<JavaFile, 'tokens' | 'source'>, start: number, end: number): string {
  const first = file.tokens[start];
  const last = file.tokens[end - 1];
  if (!first || !last || end <= start) return '';
  return compactCode(file.source.slice(first.start, last.end));
}

/** Espaces normalisés ; aucun espace autour des points d'une chaîne d'appels écrite sur plusieurs lignes. */
export function compactCode(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\s*\.\s*/g, '.')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .trim();
}

/** L'indice du jeton qui referme celui ouvert en `open` (`(`, `{`, `[`, `<`), ou la fin. */
export function matchClose(tokens: JavaToken[], open: number, limit = tokens.length): number {
  const opener = tokens[open]?.text;
  const closer = opener === '(' ? ')' : opener === '{' ? '}' : opener === '[' ? ']' : '>';
  let depth = 0;
  for (let i = open; i < limit; i++) {
    const t = tokens[i];
    if (!t || t.kind !== 'punct') continue;
    if (t.text === opener) depth++;
    else if (t.text === closer) {
      depth--;
      if (depth === 0) return i;
    } else if (opener === '<' && (t.text === ';' || t.text === '{' || t.text === '(' || t.text === '=')) {
      // Pas un générique : `a < b` dans une expression.
      return -1;
    }
  }
  return limit;
}

/** Découpe une plage de jetons sur les virgules de profondeur 0 (parenthèses, accolades, crochets). */
export function splitTopLevel(
  tokens: JavaToken[],
  start: number,
  end: number,
  separator = ',',
): { start: number; end: number }[] {
  const parts: { start: number; end: number }[] = [];
  let depth = 0;
  let from = start;
  for (let i = start; i < end; i++) {
    const t = tokens[i];
    if (!t || t.kind !== 'punct') continue;
    if (t.text === '(' || t.text === '{' || t.text === '[') depth++;
    else if (t.text === ')' || t.text === '}' || t.text === ']') depth--;
    else if (t.text === separator && depth === 0) {
      parts.push({ start: from, end: i });
      from = i + 1;
    }
  }
  if (end > from) parts.push({ start: from, end });
  return parts;
}

class Parser {
  private pos = 0;
  private readonly types: JavaTypeDecl[] = [];
  private packageName: string | undefined;

  constructor(
    private readonly t: JavaToken[],
    private readonly source: string,
  ) {}

  parseFile(): JavaFile {
    const imports: string[] = [];
    const staticImports: string[] = [];
    while (this.pos < this.t.length) {
      const tok = this.t[this.pos];
      if (!tok) break;
      if (tok.text === 'package' && tok.kind === 'ident') {
        const end = this.findSemicolon(this.pos);
        this.packageName = this.joinNames(this.pos + 1, end);
        this.pos = end + 1;
        continue;
      }
      if (tok.text === 'import' && tok.kind === 'ident') {
        const end = this.findSemicolon(this.pos);
        const isStatic = this.t[this.pos + 1]?.text === 'static';
        const name = this.joinNames(this.pos + (isStatic ? 2 : 1), end);
        (isStatic ? staticImports : imports).push(name);
        this.pos = end + 1;
        continue;
      }
      if (tok.text === ';') {
        this.pos++;
        continue;
      }
      const before = this.pos;
      const annotations = this.parseAnnotations();
      const modifiers = this.parseModifiers();
      if (this.isTypeStart()) {
        this.parseType(annotations, modifiers, undefined);
      } else if (this.pos === before) {
        // Jeton inattendu au niveau du fichier (`module-info`, erreur) : sauté.
        this.skipStatement();
      }
    }
    const file: JavaFile = { imports, staticImports, types: this.types, tokens: this.t, source: this.source };
    if (this.packageName) file.package = this.packageName;
    return file;
  }

  private joinNames(start: number, end: number): string {
    let out = '';
    for (let i = start; i < end; i++) out += this.t[i]?.text ?? '';
    return out;
  }

  private findSemicolon(from: number): number {
    for (let i = from; i < this.t.length; i++) if (this.t[i]?.text === ';') return i;
    return this.t.length;
  }

  private peek(offset = 0): JavaToken | undefined {
    return this.t[this.pos + offset];
  }

  private isTypeStart(): boolean {
    const tok = this.peek();
    if (!tok) return false;
    if (tok.text === '@' && this.peek(1)?.text === 'interface') return true;
    if (tok.kind !== 'ident' || !TYPE_KEYWORDS.has(tok.text)) return false;
    // `record` et `enum` contextuels : suivis d'un nom puis de `(`, `<`, `{`, `implements`.
    if (tok.text === 'record') {
      return this.peek(1)?.kind === 'ident' && ['(', '<'].includes(this.peek(2)?.text ?? '');
    }
    return this.peek(1)?.kind === 'ident';
  }

  parseAnnotations(): JavaAnnotation[] {
    const annotations: JavaAnnotation[] = [];
    while (this.peek()?.text === '@' && this.peek(1)?.text !== 'interface') {
      const at = this.pos;
      const line = this.peek()?.line ?? 0;
      this.pos++;
      let qualified = '';
      while (this.peek()?.kind === 'ident') {
        qualified += this.peek()?.text ?? '';
        this.pos++;
        if (this.peek()?.text === '.' && this.peek(1)?.kind === 'ident') {
          qualified += '.';
          this.pos++;
        } else break;
      }
      const args: Record<string, JavaAnnotationValue[]> = {};
      if (this.peek()?.text === '(') {
        const close = matchClose(this.t, this.pos);
        this.readAnnotationArgs(this.pos + 1, close, args);
        this.pos = close + 1;
      }
      const name = qualified.split('.').pop() ?? qualified;
      annotations.push({
        name,
        qualified,
        line,
        args,
        text: sourceText({ tokens: this.t, source: this.source }, at, this.pos),
      });
    }
    return annotations;
  }

  private readAnnotationArgs(start: number, end: number, into: Record<string, JavaAnnotationValue[]>): void {
    for (const part of splitTopLevel(this.t, start, end)) {
      const key = this.t[part.start];
      const eq = this.t[part.start + 1];
      if (key?.kind === 'ident' && eq?.text === '=' && part.end > part.start + 2) {
        into[key.text] = this.annotationValues(part.start + 2, part.end);
      } else {
        into.value = [...(into.value ?? []), ...this.annotationValues(part.start, part.end)];
      }
    }
  }

  private annotationValues(start: number, end: number): JavaAnnotationValue[] {
    const first = this.t[start];
    if (first?.text === '{') {
      const close = matchClose(this.t, start, end);
      return splitTopLevel(this.t, start + 1, close).flatMap((p) => this.annotationValues(p.start, p.end));
    }
    const parts: JavaAnnotationValue['parts'] = [];
    for (const piece of splitTopLevel(this.t, start, end, '+')) {
      const tokens = this.t.slice(piece.start, piece.end);
      if (tokens.length === 1 && tokens[0]?.kind === 'string') parts.push({ string: tokens[0].value ?? '' });
      else {
        let text = tokens.map((t) => t.text).join('');
        if (text.endsWith('.class')) text = text.slice(0, -'.class'.length);
        parts.push({ name: text });
      }
    }
    return [{ parts, text: sourceText({ tokens: this.t, source: this.source }, start, end) }];
  }

  parseModifiers(): string[] {
    const modifiers: string[] = [];
    for (;;) {
      const tok = this.peek();
      if (!tok || tok.kind !== 'ident') break;
      if (MODIFIERS.has(tok.text)) {
        // `default` d'une méthode d'interface, pas un `default:` de switch (impossible ici).
        modifiers.push(tok.text);
        this.pos++;
        continue;
      }
      if (tok.text === 'non' && this.peek(1)?.text === '-' && this.peek(2)?.text === 'sealed') {
        modifiers.push('non-sealed');
        this.pos += 3;
        continue;
      }
      break;
    }
    return modifiers;
  }

  /** Un type : annotations de type sautées, nom qualifié, arguments génériques, tableaux, varargs. */
  parseTypeRef(): JavaTypeRef | undefined {
    this.parseAnnotations();
    const startTok = this.peek();
    if (!startTok || startTok.kind !== 'ident') return undefined;
    let text = '';
    let name = '';
    let args: JavaTypeRef[] = [];
    for (;;) {
      const tok = this.peek();
      if (!tok || tok.kind !== 'ident') break;
      name = tok.text;
      text += tok.text;
      this.pos++;
      if (this.peek()?.text === '<') {
        const parsed = this.parseTypeArgs();
        if (!parsed) break;
        args = parsed.args;
        text += parsed.text;
      }
      if (this.peek()?.text === '.' && this.peek(1)?.kind === 'ident') {
        text += '.';
        this.pos++;
        continue;
      }
      break;
    }
    let array = false;
    for (;;) {
      if (this.peek()?.text === '[' && this.peek(1)?.text === ']') {
        array = true;
        text += '[]';
        this.pos += 2;
      } else if (this.peek()?.text === '...') {
        array = true;
        text += '...';
        this.pos++;
      } else if (this.peek()?.text === '@') {
        // Annotation de type avant `...` (`String @NonNull ...`).
        this.parseAnnotations();
      } else break;
    }
    return { text, name, args, array };
  }

  private parseTypeArgs(): { text: string; args: JavaTypeRef[] } | undefined {
    const open = this.pos;
    const close = matchClose(this.t, open);
    if (close < 0 || close >= this.t.length) return undefined;
    this.pos = open + 1;
    const args: JavaTypeRef[] = [];
    while (this.pos < close) {
      const tok = this.peek();
      if (!tok) break;
      if (tok.text === ',') {
        this.pos++;
        continue;
      }
      if (tok.text === '?') {
        this.pos++;
        if (this.peek()?.text === 'extends' || this.peek()?.text === 'super') {
          this.pos++;
          const bound = this.parseTypeRef();
          if (bound) args.push(bound);
        }
        continue;
      }
      const before = this.pos;
      const ref = this.parseTypeRef();
      if (ref) args.push(ref);
      // Bornes de paramètres de type (`T extends Comparable<T> & Serializable`).
      while (this.peek()?.text === 'extends' || this.peek()?.text === '&') {
        this.pos++;
        this.parseTypeRef();
      }
      if (this.pos === before) this.pos++;
    }
    this.pos = close + 1;
    let text = '';
    for (let i = open; i <= close; i++) {
      const tok = this.t[i];
      const prev = this.t[i - 1];
      // `? super T`, `T extends A & B` : les mots restent séparés.
      const word = (t: JavaToken | undefined): boolean =>
        t?.kind === 'ident' || t?.text === '?' || t?.text === '&';
      if (i > open && word(tok) && word(prev)) text += ' ';
      text += tok?.text ?? '';
    }
    return { text, args };
  }

  private parseTypeList(): JavaTypeRef[] {
    const refs: JavaTypeRef[] = [];
    for (;;) {
      const ref = this.parseTypeRef();
      if (!ref) break;
      refs.push(ref);
      if (this.peek()?.text === ',') {
        this.pos++;
        continue;
      }
      break;
    }
    return refs;
  }

  private parseType(
    annotations: JavaAnnotation[],
    modifiers: string[],
    outer: JavaTypeDecl | undefined,
  ): void {
    const keyword = this.peek();
    if (!keyword) return;
    let kind: JavaTypeKind;
    if (keyword.text === '@') {
      kind = 'annotation';
      this.pos += 2;
    } else {
      kind = keyword.text as JavaTypeKind;
      this.pos++;
    }
    const nameTok = this.peek();
    if (!nameTok || nameTok.kind !== 'ident') return;
    this.pos++;
    const simpleName = nameTok.text;
    const name = outer ? `${outer.name}.${simpleName}` : simpleName;
    const qualifiedName = [this.packageName, name].filter(Boolean).join('.');
    const decl: JavaTypeDecl = {
      kind,
      name,
      simpleName,
      qualifiedName,
      annotations,
      modifiers,
      extends: [],
      implements: [],
      components: [],
      fields: [],
      methods: [],
      enumConstants: [],
      line: nameTok.line,
      endLine: nameTok.line,
    };
    if (outer) decl.outer = outer.name;
    if (this.peek()?.text === '<') this.parseTypeArgs();
    if (kind === 'record' && this.peek()?.text === '(') {
      const close = matchClose(this.t, this.pos);
      decl.components = this.parseParams(this.pos + 1, close);
      this.pos = close + 1;
    }
    // En-tête : extends, implements, permits, jusqu'à `{`.
    while (this.pos < this.t.length && this.peek()?.text !== '{') {
      const tok = this.peek();
      if (tok?.text === 'extends') {
        this.pos++;
        decl.extends.push(...this.parseTypeList());
      } else if (tok?.text === 'implements') {
        this.pos++;
        decl.implements.push(...this.parseTypeList());
      } else if (tok?.text === 'permits') {
        this.pos++;
        this.parseTypeList();
      } else this.pos++;
    }
    if (this.peek()?.text !== '{') return;
    const bodyClose = matchClose(this.t, this.pos);
    this.types.push(decl);
    this.pos++;
    if (kind === 'enum') this.parseEnumConstants(decl, bodyClose);
    this.parseMembers(decl, bodyClose);
    decl.endLine = this.t[bodyClose]?.line ?? decl.line;
    this.pos = bodyClose + 1;
  }

  private parseEnumConstants(decl: JavaTypeDecl, end: number): void {
    let expectName = true;
    while (this.pos < end) {
      const tok = this.peek();
      if (!tok) return;
      if (tok.text === ';') {
        this.pos++;
        return;
      }
      if (tok.text === '@') {
        this.parseAnnotations();
        continue;
      }
      if (tok.text === '(' || tok.text === '{') {
        this.pos = matchClose(this.t, this.pos) + 1;
        continue;
      }
      if (tok.text === ',') {
        expectName = true;
        this.pos++;
        continue;
      }
      if (expectName && tok.kind === 'ident') decl.enumConstants.push(tok.text);
      expectName = false;
      this.pos++;
    }
  }

  private parseMembers(decl: JavaTypeDecl, end: number): void {
    while (this.pos < end) {
      const tok = this.peek();
      if (!tok) return;
      if (tok.text === ';') {
        this.pos++;
        continue;
      }
      const before = this.pos;
      const annotations = this.parseAnnotations();
      const modifiers = this.parseModifiers();
      const head = this.peek();
      if (!head) return;
      if (head.text === '{') {
        // Bloc d'initialisation (statique ou d'instance).
        this.pos = matchClose(this.t, this.pos, end) + 1;
        continue;
      }
      if (this.isTypeStart()) {
        this.parseType(annotations, modifiers, decl);
        continue;
      }
      try {
        this.parseMember(decl, annotations, modifiers, end);
      } catch {
        this.skipStatement(end);
      }
      if (this.pos === before) this.skipStatement(end);
    }
  }

  private parseMember(
    decl: JavaTypeDecl,
    annotations: JavaAnnotation[],
    modifiers: string[],
    end: number,
  ): void {
    if (this.peek()?.text === '<') this.parseTypeArgs();
    const head = this.peek();
    if (!head || head.kind !== 'ident') {
      this.skipStatement(end);
      return;
    }
    // Constructeur (`Nom(`) ou constructeur compact de record (`Nom {`).
    if (head.text === decl.simpleName && (this.peek(1)?.text === '(' || this.peek(1)?.text === '{')) {
      this.pos++;
      const params =
        this.peek()?.text === '('
          ? (() => {
              const close = matchClose(this.t, this.pos, end);
              const parsed = this.parseParams(this.pos + 1, close);
              this.pos = close + 1;
              return parsed;
            })()
          : decl.components;
      this.finishMethod(decl, {
        name: head.text,
        constructor: true,
        params,
        annotations,
        modifiers,
        line: head.line,
        end,
      });
      return;
    }
    const type = this.parseTypeRef();
    const nameTok = this.peek();
    if (!type || !nameTok || nameTok.kind !== 'ident') {
      this.skipStatement(end);
      return;
    }
    this.pos++;
    if (this.peek()?.text === '(') {
      const close = matchClose(this.t, this.pos, end);
      const params = this.parseParams(this.pos + 1, close);
      this.pos = close + 1;
      this.finishMethod(decl, {
        name: nameTok.text,
        constructor: false,
        returnType: type,
        params,
        annotations,
        modifiers,
        line: nameTok.line,
        end,
      });
      return;
    }
    // Champ(s) : `Type a = x, b;`
    let current = nameTok;
    for (;;) {
      while (this.peek()?.text === '[' && this.peek(1)?.text === ']') this.pos += 2;
      const field: JavaField = { name: current.text, type, annotations, modifiers, line: current.line };
      if (this.peek()?.text === '=') {
        this.pos++;
        const start = this.pos;
        const stop = this.findDeclaratorEnd(end);
        field.initializer = { start, end: stop };
        this.pos = stop;
      }
      decl.fields.push(field);
      const sep = this.peek();
      if (sep?.text === ',' && this.peek(1)?.kind === 'ident') {
        this.pos++;
        const nextName = this.peek();
        if (!nextName) return;
        current = nextName;
        this.pos++;
        continue;
      }
      if (sep?.text === ';') this.pos++;
      return;
    }
  }

  /** Fin d'un initialiseur : `;` ou `,` de profondeur 0 suivie d'un autre déclarateur (`, b =`, `, b;`). */
  private findDeclaratorEnd(end: number): number {
    let depth = 0;
    for (let i = this.pos; i < end; i++) {
      const t = this.t[i];
      if (!t) break;
      if (t.text === '(' || t.text === '{' || t.text === '[') depth++;
      else if (t.text === ')' || t.text === '}' || t.text === ']') depth--;
      else if (depth === 0 && t.text === ';') return i;
      else if (depth === 0 && t.text === ',') {
        const name = this.t[i + 1];
        const after = this.t[i + 2]?.text;
        if (name?.kind === 'ident' && (after === '=' || after === ',' || after === ';' || after === '['))
          return i;
      }
    }
    return end;
  }

  private finishMethod(
    decl: JavaTypeDecl,
    m: {
      name: string;
      constructor: boolean;
      returnType?: JavaTypeRef;
      params: JavaParam[];
      annotations: JavaAnnotation[];
      modifiers: string[];
      line: number;
      end: number;
    },
  ): void {
    while (this.peek()?.text === '[' && this.peek(1)?.text === ']') this.pos += 2;
    const throws: string[] = [];
    if (this.peek()?.text === 'throws') {
      this.pos++;
      for (const ref of this.parseTypeList()) throws.push(ref.name);
    }
    const method: JavaMethod = {
      name: m.name,
      constructor: m.constructor,
      params: m.params,
      annotations: m.annotations,
      modifiers: m.modifiers,
      throws,
      line: m.line,
      endLine: m.line,
    };
    if (m.returnType) method.returnType = m.returnType;
    if (this.peek()?.text === 'default') {
      // Valeur par défaut d'un élément d'annotation.
      this.skipStatement(m.end);
    } else if (this.peek()?.text === '{') {
      const close = matchClose(this.t, this.pos, m.end);
      method.body = { start: this.pos + 1, end: close };
      method.endLine = this.t[close]?.line ?? m.line;
      this.pos = close + 1;
    } else if (this.peek()?.text === ';') {
      this.pos++;
    }
    decl.methods.push(method);
  }

  /** Paramètres lus en séquence : les virgules des génériques (`Map<K, V> m`) ne séparent rien. */
  private parseParams(start: number, end: number): JavaParam[] {
    const params: JavaParam[] = [];
    const saved = this.pos;
    this.pos = start;
    while (this.pos < end) {
      const before = this.pos;
      const annotations = this.parseAnnotations();
      this.parseModifiers();
      const annotationsAfter = this.parseAnnotations();
      const type = this.parseTypeRef();
      const nameTok = this.peek();
      if (type && nameTok?.kind === 'ident' && this.pos < end) {
        this.pos++;
        params.push({
          name: nameTok.text,
          type,
          annotations: [...annotations, ...annotationsAfter],
          line: nameTok.line,
        });
        // Tableau à l'ancienne (`String args[]`).
        while (this.peek()?.text === '[' && this.peek(1)?.text === ']') this.pos += 2;
      }
      // Jusqu'à la virgule suivante de profondeur 0 (génériques compris).
      let depth = 0;
      while (this.pos < end) {
        const t = this.peek()?.text;
        if (t === '(' || t === '<' || t === '[' || t === '{') depth++;
        else if (t === ')' || t === '>' || t === ']' || t === '}') depth--;
        else if (t === ',' && depth <= 0) break;
        this.pos++;
      }
      this.pos++;
      if (this.pos <= before) this.pos = before + 1;
    }
    this.pos = saved;
    return params;
  }

  private skipStatement(end = this.t.length): void {
    while (this.pos < end) {
      const tok = this.peek();
      if (!tok) return;
      if (tok.text === ';') {
        this.pos++;
        return;
      }
      if (tok.text === '{') {
        this.pos = matchClose(this.t, this.pos, end) + 1;
        return;
      }
      if (tok.text === '(' || tok.text === '[') {
        this.pos = matchClose(this.t, this.pos, end) + 1;
        continue;
      }
      this.pos++;
    }
  }
}
