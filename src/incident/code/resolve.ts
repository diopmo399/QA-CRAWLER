import path from 'node:path';
import type { CodeCall, CodeIndex, CodeSymbol } from '../model.js';

/**
 * Relie les appels de l'index une fois tous les fichiers lus. Java : `champ.methode(…)` par le type
 * du champ (injecté ou paramètre de constructeur), `Type.methode(…)` / `Type::methode` par le type ;
 * frontend : imports relatifs (fonctions, espaces de noms) et services injectés (`this.api.m()`).
 *
 * STATICALLY_RESOLVED : le type est indexé (sans ambiguïté) et déclare la méthode ; INFERRED : le
 * type est indexé mais la méthode est héritée (Spring Data `save`, `findById`), générée (Lombok) ou
 * surchargée sans arité unique ; sinon l'appel reste tel quel (UNKNOWN, sans cible). Une seule
 * relation ajoutée : interface → son implémentation unique (INFERRED).
 */
export function resolveCalls(index: CodeIndex): CodeIndex {
  const ctx = buildContext(index.symbols);
  // Un appel déjà relié (avec sa cible) garde son statut : la résolution est idempotente.
  const calls = index.calls.map((call) => (call.to ? call : resolveOne(ctx, call)));
  const extra: CodeCall[] = [];
  for (const call of calls) {
    const implementation = call.to ? implementationOf(ctx, call.to) : undefined;
    if (!implementation || !call.to) continue;
    const exists = [...calls, ...extra].some((c) => c.from === call.to && c.to === implementation.id);
    if (exists) continue;
    const target = ctx.byId.get(call.to);
    extra.push({
      from: call.to,
      to: implementation.id,
      text: `${implementation.name} (implémentation unique de ${target?.name ?? call.to})`,
      status: 'INFERRED',
      file: implementation.file,
      line: implementation.line,
    });
  }
  return { ...index, calls: [...calls, ...extra] };
}

interface ResolveContext {
  byId: Map<string, CodeSymbol>;
  children: Map<string, CodeSymbol[]>;
  /** Types déclarés par application et nom simple. */
  types: Map<string, Map<string, CodeSymbol[]>>;
  /** Symboles par application et fichier. */
  files: Map<string, Map<string, CodeSymbol[]>>;
}

function buildContext(symbols: CodeSymbol[]): ResolveContext {
  const byId = new Map<string, CodeSymbol>();
  const children = new Map<string, CodeSymbol[]>();
  const types = new Map<string, Map<string, CodeSymbol[]>>();
  const files = new Map<string, Map<string, CodeSymbol[]>>();
  for (const symbol of symbols) {
    byId.set(symbol.id, symbol);
    if (symbol.parent) children.set(symbol.parent, [...(children.get(symbol.parent) ?? []), symbol]);
    if (typeof symbol.detail?.declaration === 'string') {
      const simple = symbol.name.split('.').pop() ?? symbol.name;
      const byName = types.get(symbol.applicationId) ?? new Map<string, CodeSymbol[]>();
      byName.set(simple, [...(byName.get(simple) ?? []), symbol]);
      types.set(symbol.applicationId, byName);
    }
    const byFile = files.get(symbol.applicationId) ?? new Map<string, CodeSymbol[]>();
    byFile.set(symbol.file, [...(byFile.get(symbol.file) ?? []), symbol]);
    files.set(symbol.applicationId, byFile);
  }
  return { byId, children, types, files };
}

function list(symbol: CodeSymbol | undefined, key: string): string[] {
  const value = symbol?.detail?.[key];
  return Array.isArray(value) ? value : [];
}

/** Le nom de méthode d'un symbole (« Classe.methode(Type)~2 » → « methode »). */
function memberName(symbol: CodeSymbol): string {
  const last = symbol.name.replace(/~\d+$/, '').replace(/\(.*\)$/, '');
  return last.split('.').pop() ?? last;
}

/** Nombre d'arguments du premier appel du texte (`a.b(x, f(y, z))` → 2). */
export function countArguments(text: string): number | undefined {
  const open = text.indexOf('(');
  if (open < 0) return undefined;
  let depth = 0;
  let count = 0;
  let any = false;
  let quote: string | undefined;
  for (let i = open + 1; i < text.length; i++) {
    const c = text[i] ?? '';
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = undefined;
      any = true;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      any = true;
    } else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return any ? count + 1 : 0;
      depth--;
    } else if (c === ',' && depth === 0) count++;
    else if (!/\s/.test(c)) any = true;
  }
  return undefined;
}

function resolveOne(ctx: ResolveContext, call: CodeCall): CodeCall {
  const from = ctx.byId.get(call.from);
  if (!from) return call;
  return from.layer === 'FRONTEND' ? resolveFrontend(ctx, call, from) : resolveJava(ctx, call, from);
}

function ownerClass(ctx: ResolveContext, symbol: CodeSymbol): CodeSymbol | undefined {
  let current: CodeSymbol | undefined = symbol;
  for (let depth = 0; current && depth < 10; depth++) {
    if (typeof current.detail?.declaration === 'string') return current;
    current = current.parent ? ctx.byId.get(current.parent) : undefined;
  }
  return undefined;
}

function fieldType(owner: CodeSymbol | undefined, field: string): string | undefined {
  const entry = list(owner, 'fields').find((f) => f.startsWith(`${field}:`));
  return entry?.slice(field.length + 1).replace(/<.*$/, '');
}

function pickJavaType(
  ctx: ResolveContext,
  app: string,
  name: string,
  owner: CodeSymbol | undefined,
): CodeSymbol | undefined {
  const candidates = ctx.types.get(app)?.get(name) ?? [];
  if (candidates.length <= 1) return candidates[0];
  const imports = list(owner, 'imports');
  const imported = candidates.filter((c) => imports.includes(String(c.detail?.qualifiedName)));
  if (imported.length === 1) return imported[0];
  const samePackage = candidates.filter((c) => c.detail?.package === owner?.detail?.package);
  // Plusieurs types du même nom sans import qui tranche : pas de relation inventée.
  return samePackage.length === 1 ? samePackage[0] : undefined;
}

function resolveJava(ctx: ResolveContext, call: CodeCall, from: CodeSymbol): CodeCall {
  const match = /^(?:this\s*\.\s*)?([A-Za-z_$][\w$]*)\s*(\.|::)\s*([A-Za-z_$][\w$]*)/.exec(call.text);
  if (!match) return call;
  const receiver = match[1] ?? '';
  const reference = match[2] === '::';
  const method = match[3] ?? '';
  const owner = ownerClass(ctx, from);
  const typeName = fieldType(owner, receiver) ?? (/^[A-Z]/.test(receiver) ? receiver : undefined);
  if (!typeName) return call;
  const type = pickJavaType(ctx, from.applicationId, typeName, owner);
  if (!type) return call;
  return resolveMember(ctx, call, type, method, reference ? undefined : countArguments(call.text));
}

function resolveMember(
  ctx: ResolveContext,
  call: CodeCall,
  type: CodeSymbol,
  method: string,
  arity: number | undefined,
): CodeCall {
  const methods = (ctx.children.get(type.id) ?? []).filter(
    (s) => s.kind !== 'VALIDATION' && s.kind !== 'ERROR_HANDLER' && memberName(s) === method,
  );
  if (methods.length > 0) {
    const exact = arity === undefined ? methods : methods.filter((m) => list(m, 'params').length === arity);
    const params = (m: CodeSymbol): number | undefined =>
      Array.isArray(m.detail?.params) ? m.detail.params.length : undefined;
    const usable = exact.length > 0 ? exact : methods.filter((m) => params(m) === undefined);
    const target = usable[0] ?? methods[0];
    if (!target) return call;
    const unique = usable.length === 1 || (methods.length === 1 && arity === undefined);
    return { ...call, to: target.id, status: unique ? 'STATICALLY_RESOLVED' : 'INFERRED' };
  }
  // Accesseur implicite d'un record : déclaré par le langage.
  if (list(type, 'components').includes(method))
    return { ...call, to: type.id, status: 'STATICALLY_RESOLVED' };
  // Accesseurs générés (Lombok) ou méthode héritée (Spring Data, classe parente) : déduits.
  const lombok = list(type, 'lombok');
  const accessor = /^(get|set|is)([A-Z]\w*)$/.exec(method);
  if (lombok.length > 0 && accessor) {
    const field = (accessor[2] ?? '').charAt(0).toLowerCase() + (accessor[2] ?? '').slice(1);
    if (list(type, 'fields').some((f) => f.startsWith(`${field}:`)))
      return { ...call, to: type.id, status: 'INFERRED' };
  }
  if (list(type, 'extends').length > 0 || list(type, 'implements').length > 0)
    return { ...call, to: type.id, status: 'INFERRED' };
  return call;
}

function implementationOf(ctx: ResolveContext, methodId: string): CodeSymbol | undefined {
  const method = ctx.byId.get(methodId);
  const type = method?.parent ? ctx.byId.get(method.parent) : undefined;
  if (!method || !type || type.detail?.declaration !== 'interface' || type.layer === 'FRONTEND')
    return undefined;
  if (type.kind === 'REPOSITORY' || type.kind === 'HTTP_CLIENT') return undefined;
  const simple = type.name.split('.').pop() ?? type.name;
  const implementations = [...ctx.byId.values()].filter(
    (s) =>
      s.applicationId === type.applicationId &&
      s.detail?.declaration === 'class' &&
      list(s, 'implements').some((i) => i.replace(/<.*$/, '').split('.').pop() === simple),
  );
  if (implementations.length !== 1 || !implementations[0]) return undefined;
  const name = memberName(method);
  const candidates = (ctx.children.get(implementations[0].id) ?? []).filter((s) => memberName(s) === name);
  return candidates.length === 1 ? candidates[0] : undefined;
}

// ── Frontend ─────────────────────────────────────────────────────────────────────────────────

function importsOf(symbol: CodeSymbol | undefined): Map<string, { module: string; name: string }> {
  const map = new Map<string, { module: string; name: string }>();
  for (const entry of list(symbol, 'imports')) {
    const eq = entry.indexOf('=');
    const hash = entry.lastIndexOf('#');
    if (eq < 0 || hash < eq) continue;
    map.set(entry.slice(0, eq), { module: entry.slice(eq + 1, hash), name: entry.slice(hash + 1) });
  }
  return map;
}

const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.vue', '.mjs'];

/** Le fichier indexé d'un import : relatif (certain) ou alias `@/` / `~/` (déduit). */
function moduleFile(
  ctx: ResolveContext,
  app: string,
  fromFile: string,
  module: string,
): { file: string; aliased: boolean } | undefined {
  const files = ctx.files.get(app);
  if (!files) return undefined;
  if (module.startsWith('.')) {
    const joined = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), module));
    const base = joined.replace(/\.(m?js|jsx|ts|tsx)$/, '');
    const candidates = [
      joined,
      ...EXTENSIONS.map((e) => base + e),
      ...EXTENSIONS.map((e) => `${base}/index${e}`),
    ];
    const file = candidates.find((c) => files.has(c));
    return file ? { file, aliased: false } : undefined;
  }
  const alias = /^[@~]\/(.+)$/.exec(module)?.[1];
  if (!alias) return undefined;
  const base = alias.replace(/\.(m?js|jsx|ts|tsx)$/, '');
  const matches = [...files.keys()].filter((f) => {
    const stem = '/' + f.replace(/\.[^./]+$/, '');
    return stem.endsWith(`/src/${base}`) || stem.endsWith(`/src/${base}/index`);
  });
  return matches.length === 1 && matches[0] ? { file: matches[0], aliased: true } : undefined;
}

function exportedSymbol(
  ctx: ResolveContext,
  app: string,
  file: string,
  name: string,
): CodeSymbol | undefined {
  const symbols = ctx.files.get(app)?.get(file) ?? [];
  if (name === 'default') return symbols.find((s) => s.detail?.exportDefault === true);
  return symbols.find((s) => s.name === name && !s.parent);
}

function resolveFrontend(ctx: ResolveContext, call: CodeCall, from: CodeSymbol): CodeCall {
  const app = from.applicationId;
  const resolved = (target: CodeSymbol | undefined, aliased: boolean): CodeCall =>
    target ? { ...call, to: target.id, status: aliased ? 'INFERRED' : 'STATICALLY_RESOLVED' } : call;

  const field = /^this\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*[(<]/.exec(call.text);
  if (field) {
    const owner = ownerClass(ctx, from);
    const type = fieldType(owner, field[1] ?? '');
    const imported = type ? importsOf(owner).get(type) : undefined;
    if (!owner || !type || !imported) return call;
    const module = moduleFile(ctx, app, owner.file, imported.module);
    if (!module) return call;
    const cls = exportedSymbol(ctx, app, module.file, imported.name);
    if (!cls) return call;
    const method = (ctx.children.get(cls.id) ?? []).find((s) => memberName(s) === field[2]);
    return resolved(method, module.aliased);
  }
  const imports = importsOf(from);
  const namespaced = /^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*[(<]/.exec(call.text);
  if (namespaced) {
    const imported = imports.get(namespaced[1] ?? '');
    if (!imported) return call;
    const module = moduleFile(ctx, app, from.file, imported.module);
    if (!module) return call;
    if (imported.name === '*')
      return resolved(exportedSymbol(ctx, app, module.file, namespaced[2] ?? ''), module.aliased);
    // Import par défaut d'un objet ou d'une classe : la méthode de ce symbole.
    const target = exportedSymbol(ctx, app, module.file, imported.name);
    const member = target
      ? (ctx.children.get(target.id) ?? []).find((s) => memberName(s) === namespaced[2])
      : undefined;
    return resolved(member, module.aliased);
  }
  const direct = /^([A-Za-z_$][\w$]*)\s*[(<]/.exec(call.text);
  if (direct) {
    const imported = imports.get(direct[1] ?? '');
    if (!imported) return call;
    const module = moduleFile(ctx, app, from.file, imported.module);
    if (!module) return call;
    return resolved(exportedSymbol(ctx, app, module.file, imported.name), module.aliased);
  }
  return call;
}
