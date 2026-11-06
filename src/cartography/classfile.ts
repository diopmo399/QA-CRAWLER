import type {
  JavaAnnotation,
  JavaAnnotationValue,
  JavaFile,
  JavaMethod,
  JavaParam,
  JavaTypeDecl,
  JavaTypeRef,
} from '../incident/code/java-parser.js';

/**
 * LE LECTEUR DE FICHIERS .class : la structure d'une classe compilée, lue octet par octet (format JVM), sans
 * jamais la charger ni l'exécuter. Il rend les mêmes structures que le parseur de sources (type, parents,
 * méthodes, paramètres, annotations), pour que l'analyse des routes héritées vaille pour une interface
 * de contrat livrée seulement compilée. Seules les annotations conservées à l'exécution (RUNTIME, cas des
 * annotations Spring) sont présentes dans le bytecode ; les noms de paramètres ne le sont qu'avec
 * `-parameters` ; les constantes sont déjà remplacées par leur valeur. Ce qui manque n'est jamais deviné.
 */

export class ClassFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClassFileError';
  }
}

const ACC_STATIC = 0x0008;
const ACC_BRIDGE = 0x0040;
const ACC_INTERFACE = 0x0200;
const ACC_ABSTRACT = 0x0400;
const ACC_SYNTHETIC = 0x1000;
const ACC_ANNOTATION = 0x2000;
const ACC_ENUM = 0x4000;
const MAX_CONSTANTS = 65_535;

type Constant =
  | { tag: 1; text: string }
  | { tag: 3 | 4; value: number }
  | { tag: 5 | 6; value: string }
  | { tag: 7 | 8 | 16 | 19 | 20; index: number }
  | { tag: 9 | 10 | 11 | 12 | 17 | 18; a: number; b: number }
  | { tag: 15; kind: number; index: number };

class Reader {
  pos = 0;
  constructor(private readonly data: Uint8Array) {}
  need(n: number): void {
    if (this.pos + n > this.data.length) throw new ClassFileError('truncated class file');
  }
  u1(): number {
    this.need(1);
    return this.data[this.pos++] ?? 0;
  }
  u2(): number {
    this.need(2);
    const v = ((this.data[this.pos] ?? 0) << 8) | (this.data[this.pos + 1] ?? 0);
    this.pos += 2;
    return v;
  }
  u4(): number {
    this.need(4);
    const v =
      (((this.data[this.pos] ?? 0) << 24) >>> 0) +
      ((this.data[this.pos + 1] ?? 0) << 16) +
      ((this.data[this.pos + 2] ?? 0) << 8) +
      (this.data[this.pos + 3] ?? 0);
    this.pos += 4;
    return v;
  }
  bytes(n: number): Uint8Array {
    this.need(n);
    const out = this.data.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  skip(n: number): void {
    this.need(n);
    this.pos += n;
  }
}

/** UTF-8 modifié de la JVM (le nul sur deux octets, les caractères supplémentaires en paires de substitution). */
function modifiedUtf8(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length;) {
    const a = bytes[i] ?? 0;
    if (a < 0x80) {
      out += String.fromCharCode(a);
      i += 1;
    } else if ((a & 0xe0) === 0xc0) {
      out += String.fromCharCode(((a & 0x1f) << 6) | ((bytes[i + 1] ?? 0) & 0x3f));
      i += 2;
    } else {
      out += String.fromCharCode(
        ((a & 0x0f) << 12) | (((bytes[i + 1] ?? 0) & 0x3f) << 6) | ((bytes[i + 2] ?? 0) & 0x3f),
      );
      i += 3;
    }
  }
  return out;
}

const PRIMITIVES: Record<string, string> = {
  B: 'byte',
  C: 'char',
  D: 'double',
  F: 'float',
  I: 'int',
  J: 'long',
  S: 'short',
  Z: 'boolean',
  V: 'void',
};

/** Un type de descripteur (`Ljava/lang/String;`, `[I`) → sa référence (texte qualifié, nom simple). */
function typeOf(descriptor: string, at = 0): { ref: JavaTypeRef; next: number } {
  let dims = 0;
  let i = at;
  while (descriptor[i] === '[') {
    dims++;
    i++;
  }
  let text: string;
  if (descriptor[i] === 'L') {
    const end = descriptor.indexOf(';', i);
    if (end < 0) throw new ClassFileError(`bad descriptor ${descriptor}`);
    text = descriptor
      .slice(i + 1, end)
      .replace(/\//g, '.')
      .replace(/\$/g, '.');
    i = end + 1;
  } else {
    text = PRIMITIVES[descriptor[i] ?? ''] ?? '?';
    i += 1;
  }
  const name = text.split('.').pop() ?? text;
  return { ref: { text: text + '[]'.repeat(dims), name, args: [], array: dims > 0 }, next: i };
}

/** Les paramètres et le retour d'un descripteur de méthode (`(Ljava/lang/String;I)V`). */
export function methodTypes(descriptor: string): { params: JavaTypeRef[]; returns: JavaTypeRef } {
  if (descriptor[0] !== '(') throw new ClassFileError(`bad method descriptor ${descriptor}`);
  const params: JavaTypeRef[] = [];
  let i = 1;
  while (descriptor[i] !== ')' && i < descriptor.length) {
    const t = typeOf(descriptor, i);
    params.push(t.ref);
    i = t.next;
  }
  return { params, returns: typeOf(descriptor, i + 1).ref };
}

/** Le nom binaire (`com/a/Outer$Inner`) → nom qualifié Java (`com.a.Outer.Inner`). */
const javaName = (internal: string): string => internal.replace(/\//g, '.').replace(/\$/g, '.');

export interface ClassFileRead {
  file: JavaFile;
  decl: JavaTypeDecl;
  /** Le nom binaire (`com/a/Outer$Inner`) et le fichier source déclaré par le compilateur, s'il l'est. */
  internalName: string;
  sourceFile?: string;
}

/** Lit un fichier .class. Lève ClassFileError s'il est illisible ; ne charge ni n'exécute rien. */
export function readClassFile(data: Uint8Array): ClassFileRead {
  const r = new Reader(data);
  if (r.u4() !== 0xcafebabe) throw new ClassFileError('not a class file (bad magic)');
  r.u2();
  r.u2();
  const count = r.u2();
  if (count > MAX_CONSTANTS) throw new ClassFileError('constant pool too large');
  const pool: (Constant | undefined)[] = [undefined];
  for (let i = 1; i < count; i++) {
    const tag = r.u1();
    switch (tag) {
      case 1:
        pool[i] = { tag, text: modifiedUtf8(r.bytes(r.u2())) };
        break;
      case 3:
        pool[i] = { tag, value: r.u4() | 0 };
        break;
      case 4: {
        const view = new DataView(new ArrayBuffer(4));
        view.setUint32(0, r.u4());
        pool[i] = { tag, value: view.getFloat32(0) };
        break;
      }
      case 5:
      case 6: {
        const hi = r.u4();
        const lo = r.u4();
        const view = new DataView(new ArrayBuffer(8));
        view.setUint32(0, hi);
        view.setUint32(4, lo);
        pool[i] = {
          tag,
          value: tag === 5 ? view.getBigInt64(0).toString() : String(view.getFloat64(0)),
        };
        pool[++i] = undefined; // Un long ou un double occupe deux entrées.
        break;
      }
      case 7:
      case 8:
      case 16:
      case 19:
      case 20:
        pool[i] = { tag, index: r.u2() };
        break;
      case 9:
      case 10:
      case 11:
      case 12:
      case 17:
      case 18:
        pool[i] = { tag, a: r.u2(), b: r.u2() };
        break;
      case 15:
        pool[i] = { tag, kind: r.u1(), index: r.u2() };
        break;
      default:
        throw new ClassFileError(`unknown constant tag ${String(tag)}`);
    }
  }
  const utf8 = (index: number): string => {
    const c = pool[index];
    if (c?.tag !== 1) throw new ClassFileError(`constant ${String(index)} is not a string`);
    return c.text;
  };
  const className = (index: number): string => {
    const c = pool[index];
    if (c?.tag !== 7) throw new ClassFileError(`constant ${String(index)} is not a class`);
    return utf8(c.index);
  };
  const constant = (index: number): string => {
    const c = pool[index];
    if (!c) return '';
    if (c.tag === 1) return c.text;
    if (c.tag === 3 || c.tag === 4) return String(c.value);
    if (c.tag === 5 || c.tag === 6) return c.value;
    if (c.tag === 8) return utf8(c.index);
    return '';
  };

  const annotation = (): JavaAnnotation => {
    const type = typeOf(utf8(r.u2())).ref;
    const args: Record<string, JavaAnnotationValue[]> = {};
    const pairs = r.u2();
    const shown: string[] = [];
    for (let k = 0; k < pairs; k++) {
      const key = utf8(r.u2());
      const values = elementValue();
      args[key] = values;
      shown.push(
        `${key} = ${values.length === 1 ? (values[0]?.text ?? '') : `{${values.map((v) => v.text).join(', ')}}`}`,
      );
    }
    return {
      name: type.name,
      qualified: type.text,
      line: 0,
      args,
      text: `@${type.name}${shown.length ? `(${shown.join(', ')})` : ''}`,
    };
  };
  /** Une valeur d'élément d'annotation : une seule, ou plusieurs pour un tableau. */
  const elementValue = (): JavaAnnotationValue[] => {
    const tag = String.fromCharCode(r.u1());
    if (tag === 's') {
      const s = utf8(r.u2());
      return [{ parts: [{ string: s }], text: JSON.stringify(s) }];
    }
    if ('BCDFIJSZ'.includes(tag)) {
      const v = constant(r.u2());
      const text = tag === 'Z' ? (v === '0' ? 'false' : 'true') : v;
      return [{ parts: [{ name: text }], text }];
    }
    if (tag === 'e') {
      const enumType = typeOf(utf8(r.u2())).ref.name;
      const name = `${enumType}.${utf8(r.u2())}`;
      return [{ parts: [{ name }], text: name }];
    }
    if (tag === 'c') {
      const name = `${typeOf(utf8(r.u2())).ref.name}.class`;
      return [{ parts: [{ name }], text: name }];
    }
    if (tag === '@') {
      const nested = annotation();
      return [{ parts: [{ name: nested.text }], text: nested.text }];
    }
    if (tag === '[') {
      const n = r.u2();
      const out: JavaAnnotationValue[] = [];
      for (let k = 0; k < n; k++) out.push(...elementValue());
      return out;
    }
    throw new ClassFileError(`unknown annotation element tag ${tag}`);
  };
  const annotations = (): JavaAnnotation[] => {
    const n = r.u2();
    const out: JavaAnnotation[] = [];
    for (let k = 0; k < n; k++) out.push(annotation());
    return out;
  };

  const access = r.u2();
  const internalName = className(r.u2());
  const superIndex = r.u2();
  const superName = superIndex ? className(superIndex) : undefined;
  const interfaces: string[] = [];
  for (let n = r.u2(), k = 0; k < n; k++) interfaces.push(className(r.u2()));
  // Les champs : sautés (la cartographie d'un contrat compilé lit ses routes, pas ses champs).
  for (let n = r.u2(), k = 0; k < n; k++) {
    r.skip(6);
    for (let a = r.u2(), j = 0; j < a; j++) {
      r.u2();
      r.skip(r.u4());
    }
  }
  const methods: JavaMethod[] = [];
  for (let n = r.u2(), k = 0; k < n; k++) {
    const flags = r.u2();
    const name = utf8(r.u2());
    const types = methodTypes(utf8(r.u2()));
    let own: JavaAnnotation[] = [];
    let paramAnnotations: JavaAnnotation[][] = [];
    let names: string[] = [];
    let code = false;
    for (let a = r.u2(), j = 0; j < a; j++) {
      const attr = utf8(r.u2());
      const length = r.u4();
      const end = r.pos + length;
      if (attr === 'RuntimeVisibleAnnotations') own = annotations();
      else if (attr === 'RuntimeVisibleParameterAnnotations') {
        const count = r.u1();
        paramAnnotations = [];
        for (let p = 0; p < count; p++) paramAnnotations.push(annotations());
      } else if (attr === 'MethodParameters') {
        const count = r.u1();
        names = [];
        for (let p = 0; p < count; p++) {
          const index = r.u2();
          r.u2();
          names.push(index ? utf8(index) : '');
        }
      } else if (attr === 'Code') code = true;
      r.pos = end;
    }
    // Les méthodes produites par le compilateur (ponts, synthétiques) et les initialiseurs ne sont pas du contrat.
    if (flags & (ACC_BRIDGE | ACC_SYNTHETIC) || name === '<clinit>') continue;
    // Le constructeur d'une classe interne reçoit l'instance englobante en premier paramètre implicite.
    const offset = types.params.length - paramAnnotations.length;
    const params: JavaParam[] = types.params.map((type, p): JavaParam => ({
      name: names[p] ?? `arg${String(p)}`,
      type,
      annotations: paramAnnotations[p - (offset > 0 ? offset : 0)] ?? [],
      line: 0,
    }));
    methods.push({
      name: name === '<init>' ? (javaName(internalName).split('.').pop() ?? name) : name,
      constructor: name === '<init>',
      returnType: types.returns,
      params,
      annotations: own,
      modifiers: [
        ...(flags & ACC_STATIC ? ['static'] : []),
        ...(flags & ACC_ABSTRACT ? ['abstract'] : []),
        ...(flags & 0x0001 ? ['public'] : []),
      ],
      throws: [],
      line: 0,
      endLine: 0,
      // Un corps compilé : la méthode s'exécute ici (pas abstraite) ; ses instructions ne sont jamais lues.
      ...(code ? { body: { start: 0, end: 0 } } : {}),
    });
  }
  let classAnnotations: JavaAnnotation[] = [];
  let sourceFile: string | undefined;
  for (let a = r.u2(), j = 0; j < a; j++) {
    const attr = utf8(r.u2());
    const length = r.u4();
    const end = r.pos + length;
    if (attr === 'RuntimeVisibleAnnotations') classAnnotations = annotations();
    else if (attr === 'SourceFile') sourceFile = utf8(r.u2());
    r.pos = end;
  }

  const qualifiedName = javaName(internalName);
  const slash = internalName.lastIndexOf('/');
  const pkg = slash > 0 ? internalName.slice(0, slash).replace(/\//g, '.') : undefined;
  const nested = internalName.slice(slash + 1).split('$');
  const ref = (internal: string): JavaTypeRef => {
    const text = javaName(internal);
    return { text, name: text.split('.').pop() ?? text, args: [], array: false };
  };
  const kind: JavaTypeDecl['kind'] =
    access & ACC_ANNOTATION
      ? 'annotation'
      : access & ACC_INTERFACE
        ? 'interface'
        : access & ACC_ENUM
          ? 'enum'
          : superName === 'java/lang/Record'
            ? 'record'
            : 'class';
  const parents = interfaces.map(ref);
  const extendsClass =
    superName && !['java/lang/Object', 'java/lang/Enum', 'java/lang/Record'].includes(superName)
      ? [ref(superName)]
      : [];
  const decl: JavaTypeDecl = {
    kind,
    name: nested.join('.'),
    simpleName: nested[nested.length - 1] ?? internalName,
    qualifiedName,
    ...(nested.length > 1 ? { outer: nested.slice(0, -1).join('.') } : {}),
    annotations: classAnnotations,
    modifiers: [
      ...(access & ACC_ABSTRACT && kind === 'class' ? ['abstract'] : []),
      ...(access & 0x0001 ? ['public'] : []),
    ],
    // Comme dans une source : une interface « étend » ses interfaces parentes, une classe les « implémente ».
    extends: kind === 'interface' || kind === 'annotation' ? parents : extendsClass,
    implements: kind === 'interface' || kind === 'annotation' ? [] : parents,
    components: [],
    fields: [],
    methods,
    enumConstants: [],
    line: 0,
    endLine: 0,
  };
  return {
    internalName,
    ...(sourceFile ? { sourceFile } : {}),
    decl,
    file: {
      ...(pkg ? { package: pkg } : {}),
      imports: [],
      staticImports: [],
      types: [decl],
      tokens: [],
      source: '',
    },
  };
}
