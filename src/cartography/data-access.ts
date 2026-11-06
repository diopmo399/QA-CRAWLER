import type { JavaToken } from '../incident/code/java-lexer.js';
import type { JavaFile } from '../incident/code/java-parser.js';
import type { JavaDataAccess, Loc } from './facts.js';

/**
 * LES ACCÈS AUX DONNÉES HORS SPRING DATA, lus dans le corps des méthodes (jamais exécutés) : `EntityManager`
 * (`createQuery` JPQL, `createNativeQuery` SQL, `find`, `persist`, `merge`, `remove`) et `JdbcTemplate` /
 * `NamedParameterJdbcTemplate` (`query…`, `update`, `batchUpdate`, `execute`). La requête n'est classée
 * (lecture, insertion, mise à jour, suppression) que si son texte est lisible (littéraux, constantes) ; sinon
 * l'opération reste indéterminée. Les cibles sont des entités (JPQL) ou des tables (SQL natif, JDBC).
 */
const ENTITY_MANAGER = new Set(['EntityManager']);
const JDBC = new Set(['JdbcTemplate', 'NamedParameterJdbcTemplate', 'JdbcClient']);
const EM_OPS: Record<string, JavaDataAccess['operation'] | 'QUERY' | 'NATIVE'> = {
  createQuery: 'QUERY',
  createNativeQuery: 'NATIVE',
  find: 'SELECT',
  getReference: 'SELECT',
  persist: 'INSERT',
  merge: 'UPDATE',
  remove: 'DELETE',
};
const JDBC_OPS = new Set([
  'query',
  'queryForObject',
  'queryForList',
  'queryForMap',
  'queryForRowSet',
  'queryForStream',
  'update',
  'batchUpdate',
  'execute',
  'sql',
]);

export interface QueryShape {
  operation: JavaDataAccess['operation'];
  targets: string[];
}

/** Le genre d'une requête (premier mot-clé) et les noms qu'elle cite après FROM, JOIN, UPDATE, INTO. */
export function classifyQuery(text: string): QueryShape {
  const q = text.replace(/\s+/g, ' ').trim();
  const first = /^\(?\s*(\w+)/.exec(q)?.[1]?.toLowerCase() ?? '';
  const operation: JavaDataAccess['operation'] =
    first === 'select' || first === 'with'
      ? 'SELECT'
      : first === 'insert'
        ? 'INSERT'
        : first === 'update' || first === 'merge'
          ? 'UPDATE'
          : first === 'delete'
            ? 'DELETE'
            : 'UNKNOWN';
  const targets = new Set<string>();
  for (const m of q.matchAll(/\b(?:from|join|update|into)\s+([A-Za-z_][\w.]*)/gi)) {
    const name = m[1] ?? '';
    // `from (select …)`, un mot-clé pris pour un nom : écartés.
    if (/^(select|where|set|values|the)$/i.test(name)) continue;
    targets.add(name.split('.').pop() ?? name);
  }
  return { operation, targets: [...targets] };
}

/** Le texte d'un argument : littéraux et constantes concaténés ; undefined si une partie est inconnue. */
function argumentText(
  tokens: readonly JavaToken[],
  start: number,
  end: number,
  constants: ReadonlyMap<string, string>,
): string | undefined {
  let out = '';
  let part: JavaToken[] = [];
  const flush = (): boolean => {
    if (part.length === 0) return true;
    const first = part[0];
    if (part.length === 1 && first?.kind === 'string') out += first.value ?? '';
    else {
      const value = constants.get(part.map((t) => t.text).join(''));
      if (value === undefined) return false;
      out += value;
    }
    part = [];
    return true;
  };
  for (let i = start; i < end; i++) {
    const t = tokens[i];
    if (!t) break;
    if (t.text === '+') {
      if (!flush()) return undefined;
    } else part.push(t);
  }
  return flush() && out ? out : undefined;
}

/** La fin d'un appel : la parenthèse fermante qui correspond à `open`. */
function closeOf(tokens: readonly JavaToken[], open: number, end: number): number {
  let depth = 0;
  for (let i = open; i < end; i++) {
    const t = tokens[i]?.text;
    if (t === '(') depth++;
    else if (t === ')' && --depth === 0) return i;
  }
  return end;
}

/** Le premier argument d'un appel : jusqu'à la virgule de premier niveau. */
function firstArgument(tokens: readonly JavaToken[], open: number, close: number): [number, number] {
  let depth = 0;
  for (let i = open + 1; i < close; i++) {
    const t = tokens[i]?.text;
    if (t === '(' || t === '{' || t === '[') depth++;
    else if (t === ')' || t === '}' || t === ']') depth--;
    else if (t === ',' && depth === 0) return [open + 1, i];
  }
  return [open + 1, close];
}

export function dataAccessOf(
  parsed: readonly { file: string; java: JavaFile }[],
  constantsOf: (java: JavaFile) => ReadonlyMap<string, string>,
  methodIdOf: (owner: string, name: string, arity: number) => string | undefined,
): JavaDataAccess[] {
  const out: JavaDataAccess[] = [];
  for (const { file, java } of parsed) {
    if (!/EntityManager|JdbcTemplate|JdbcClient/.test(java.source)) continue;
    const constants = constantsOf(java);
    const tokens = java.tokens;
    for (const decl of java.types) {
      // Les champs (injectés par constructeur ou par champ) qui portent un accès aux données.
      const fields = new Map<string, 'EM' | 'JDBC'>();
      for (const f of decl.fields)
        if (ENTITY_MANAGER.has(f.type.name)) fields.set(f.name, 'EM');
        else if (JDBC.has(f.type.name)) fields.set(f.name, 'JDBC');
      if (fields.size === 0) continue;
      for (const method of decl.methods) {
        if (!method.body || method.constructor) continue;
        const from = methodIdOf(decl.simpleName, method.name, method.params.length);
        if (!from) continue;
        for (let i = method.body.start; i < method.body.end; i++) {
          const t = tokens[i];
          if (t?.kind !== 'ident') continue;
          // `champ.op(` ou `this.champ.op(`
          const receiver = t.text === 'this' && tokens[i + 1]?.text === '.' ? tokens[i + 2] : t;
          const at = receiver === t ? i : i + 2;
          const kind = receiver ? fields.get(receiver.text) : undefined;
          if (!kind || tokens[at + 1]?.text !== '.' || tokens[at + 3]?.text !== '(') continue;
          const op = tokens[at + 2]?.text ?? '';
          const open = at + 3;
          const close = closeOf(tokens, open, method.body.end);
          const [aStart, aEnd] = firstArgument(tokens, open, close);
          const loc: Loc = { file, line: tokens[at]?.line ?? method.line };
          let access: JavaDataAccess | undefined;
          if (kind === 'EM' && op in EM_OPS) {
            const shape = EM_OPS[op];
            if (shape === 'QUERY' || shape === 'NATIVE') {
              const text = argumentText(tokens, aStart, aEnd, constants);
              const q = text ? classifyQuery(text) : undefined;
              access = {
                from,
                mechanism: shape === 'NATIVE' ? 'NATIVE_SQL' : 'JPQL',
                operation: q?.operation ?? 'UNKNOWN',
                targets: (q?.targets ?? []).map((name) => ({
                  name,
                  kind: shape === 'NATIVE' ? ('TABLE' as const) : ('ENTITY' as const),
                })),
                ...(text ? { statement: text.replace(/\s+/g, ' ').trim().slice(0, 240) } : {}),
                via: `${receiver?.text ?? ''}.${op}()`,
                loc,
              };
            } else if (shape) {
              // `find(Entite.class, id)` : l'entité est écrite ; `persist(x)` : le type de x n'est pas lu ici.
              const cls = tokens
                .slice(aStart, aEnd)
                .map((x) => x.text)
                .join('');
              const entity = /^([A-Z]\w*)\.class$/.exec(cls)?.[1];
              access = {
                from,
                mechanism: 'ENTITY_MANAGER',
                operation: shape,
                targets: entity ? [{ name: entity, kind: 'ENTITY' }] : [],
                via: `${receiver?.text ?? ''}.${op}()`,
                loc,
              };
            }
          } else if (kind === 'JDBC' && JDBC_OPS.has(op)) {
            const text = argumentText(tokens, aStart, aEnd, constants);
            const q = text ? classifyQuery(text) : undefined;
            access = {
              from,
              mechanism: 'JDBC',
              operation: q?.operation ?? 'UNKNOWN',
              targets: (q?.targets ?? []).map((name) => ({ name, kind: 'TABLE' as const })),
              ...(text ? { statement: text.replace(/\s+/g, ' ').trim().slice(0, 240) } : {}),
              via: `${receiver?.text ?? ''}.${op}()`,
              loc,
            };
          }
          if (access) out.push(access);
          i = close;
        }
      }
    }
  }
  return out;
}
