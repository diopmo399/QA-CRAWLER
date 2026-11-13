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
  const known = new Set(calls.map((c) => `${c.from}>${c.to ?? ''}`));
  for (const call of calls)
    for (const next of call.to ? dispatchOf(ctx, call) : []) {
      const key = `${next.from}>${next.to ?? ''}`;
      if (known.has(key)) continue;
      known.add(key);
      extra.push(next);
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
  /** Mémo : les types parents d'un type (classes puis interfaces, directs ou non), et ses sous-types concrets. */
  ancestors: Map<string, CodeSymbol[]>;
  concrete: Map<string, CodeSymbol[]>;
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
  return { byId, children, types, files, ancestors: new Map(), concrete: new Map() };
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
  const written = name.replace(/<.*$/, '').trim();
  const simple = written.split('.').pop() ?? written;
  const candidates = ctx.types.get(app)?.get(simple) ?? [];
  // Un nom qualifié écrit dans le code désigne ce type et aucun autre.
  if (written.includes('.')) return candidates.find((c) => c.detail?.qualifiedName === written);
  if (candidates.length <= 1) return candidates[0];
  const imports = list(owner, 'imports');
  const imported = candidates.filter((c) => imports.includes(String(c.detail?.qualifiedName)));
  if (imported.length === 1) return imported[0];
  const samePackage = candidates.filter((c) => c.detail?.package === owner?.detail?.package);
  if (samePackage.length === 1) return samePackage[0];
  // Puis un import à la demande (`import a.b.*;`), comme en Java : il ne tranche que s'il en désigne un seul.
  const onDemand = new Set(imports.filter((i) => i.endsWith('.*')).map((i) => i.slice(0, -2)));
  const wildcard = candidates.filter((c) => onDemand.has(String(c.detail?.package)));
  // Plusieurs types du même nom sans import qui tranche : pas de relation inventée.
  return wildcard.length === 1 ? wildcard[0] : undefined;
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
  // Méthode héritée d'un type parent présent dans la source (classe de base, interface parente) : la
  // déclaration est trouvée dans la hiérarchie, comme le compilateur la trouve ; le plus proche l'emporte.
  for (const parent of ancestorsOf(ctx, type)) {
    const inherited = (ctx.children.get(parent.id) ?? []).filter(
      (s) => s.kind !== 'VALIDATION' && s.kind !== 'ERROR_HANDLER' && memberName(s) === method,
    );
    if (inherited.length === 0) continue;
    const exact =
      arity === undefined ? inherited : inherited.filter((m) => list(m, 'params').length === arity);
    const target = exact[0] ?? inherited[0];
    if (!target) break;
    return { ...call, to: target.id, status: exact.length === 1 ? 'STATICALLY_RESOLVED' : 'INFERRED' };
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

/** Les types parents d'un type lus dans la source : classes de base d’abord, puis interfaces, directs ou non. */
function ancestorsOf(ctx: ResolveContext, type: CodeSymbol): CodeSymbol[] {
  const cached = ctx.ancestors.get(type.id);
  if (cached) return cached;
  const out: CodeSymbol[] = [];
  const seen = new Set<string>([type.id]);
  const queue: CodeSymbol[] = [type];
  for (let current = queue.shift(); current && out.length < 40; current = queue.shift()) {
    for (const name of [...list(current, 'extends'), ...list(current, 'implements')]) {
      const parent = pickJavaType(ctx, current.applicationId, name, current);
      if (!parent || seen.has(parent.id)) continue;
      seen.add(parent.id);
      out.push(parent);
      queue.push(parent);
    }
  }
  ctx.ancestors.set(type.id, out);
  return out;
}

/** Les classes concrètes (ni interface, ni abstraite) qui sont un sous-type du type, directement ou non. */
function concreteSubtypes(ctx: ResolveContext, type: CodeSymbol): CodeSymbol[] {
  const cached = ctx.concrete.get(type.id);
  if (cached) return cached;
  const out = [...(ctx.types.get(type.applicationId)?.values() ?? [])]
    .flat()
    .filter(
      (s) =>
        s.detail?.declaration === 'class' &&
        s.detail.abstract !== true &&
        ancestorsOf(ctx, s).some((a) => a.id === type.id),
    );
  ctx.concrete.set(type.id, out);
  return out;
}

/** La méthode qu'une classe concrète exécute pour ce nom et cette arité : la plus dérivée qui a un corps. */
function executedIn(
  ctx: ResolveContext,
  cls: CodeSymbol,
  name: string,
  arity: number,
): CodeSymbol | undefined {
  for (const owner of [cls, ...ancestorsOf(ctx, cls)]) {
    const found = (ctx.children.get(owner.id) ?? []).find(
      (s) => memberName(s) === name && list(s, 'params').length === arity && s.detail?.bodyless !== true,
    );
    if (found) return found;
  }
  return undefined;
}

/** Le type statique du receveur d'un appel Java (`champ.m()`, `Type.m()`), s'il est indexé. */
function receiverOf(
  ctx: ResolveContext,
  call: CodeCall,
): { type: CodeSymbol; field?: string; qualifier?: string } | undefined {
  const from = ctx.byId.get(call.from);
  if (!from || from.layer === 'FRONTEND') return undefined;
  const match = /^(?:this\s*\.\s*)?([A-Za-z_$][\w$]*)\s*(?:\.|::)/.exec(call.text);
  if (!match) return undefined;
  const receiver = match[1] ?? '';
  const owner = ownerClass(ctx, from);
  const declared = fieldType(owner, receiver);
  const typeName = declared ?? (/^[A-Z]/.test(receiver) ? receiver : undefined);
  const type = typeName ? pickJavaType(ctx, from.applicationId, typeName, owner) : undefined;
  // `@Qualifier("nom")` sur le champ (ou le paramètre de constructeur qui l'alimente).
  const qualifier = declared
    ? list(owner, 'qualifiers')
        .find((entry) => entry.startsWith(`${receiver}:`))
        ?.slice(receiver.length + 1)
    : undefined;
  return type
    ? { type, ...(declared ? { field: receiver } : {}), ...(qualifier ? { qualifier } : {}) }
    : undefined;
}

/**
 * Le nom de bean Spring d'une classe : celui que son annotation écrit (`@Service("mail")`), sinon le nom par
 * défaut (`MailNotifier` → `mailNotifier`, `URLReader` inchangé).
 */
function beanName(cls: CodeSymbol): string {
  if (typeof cls.detail?.bean === 'string') return cls.detail.bean;
  const simple = cls.name.split('.').pop() ?? cls.name;
  return /^[A-Z]{2}/.test(simple) ? simple : simple.charAt(0).toLowerCase() + simple.slice(1);
}

/**
 * L'EXÉCUTION D'UN APPEL SUR UNE INTERFACE OU UNE CLASSE ABSTRAITE : les classes concrètes de la source qui
 * en sont un sous-type (même par une classe abstraite intermédiaire), et la méthode que chacune exécute
 * (même nom, même arité, la plus dérivée qui a un corps, méthode `default` comprise). INFERRED toujours : un
 * bean d'une bibliothèque pourrait aussi exister. Une seule candidate : elle ; plusieurs : le bean que le
 * point d'injection demande (`@Qualifier`, `@Named`), sinon `@Primary`, sinon le bean nommé comme le champ
 * injecté (règle de Spring) ; sinon toutes, marquées ambiguës (`candidates`), jamais une choisie au hasard,
 * avec les profils (`@Profile`) qui les distinguent quand ils sont écrits. La relation part de la déclaration
 * quand le choix vaut pour tous les appelants ; de l'appelant quand il dépend de lui (qualificateur, nom du
 * champ, méthode héritée d'un type parent).
 */
function dispatchOf(ctx: ResolveContext, call: CodeCall): CodeCall[] {
  const target = call.to ? ctx.byId.get(call.to) : undefined;
  const declaring = target?.parent ? ctx.byId.get(target.parent) : undefined;
  if (!target || !declaring || declaring.layer === 'FRONTEND') return [];
  if (typeof declaring.detail?.declaration !== 'string') return [];
  const receiver = receiverOf(ctx, call);
  // Un dépôt Spring Data n'a pas d'implémentation dans la source, sauf pour ses fragments (interfaces écrites
  // à la main qu'il étend) : l'appel d'une méthode de fragment s'exécute dans l'implémentation du fragment.
  const fragment =
    receiver?.type.kind === 'REPOSITORY' &&
    declaring.id !== receiver.type.id &&
    declaring.kind !== 'REPOSITORY' &&
    declaring.detail.declaration === 'interface';
  const type = fragment ? declaring : (receiver?.type ?? declaring);
  const dispatched = type.detail?.declaration === 'interface' || type.detail?.abstract === true;
  if (!dispatched || type.kind === 'REPOSITORY' || type.kind === 'HTTP_CLIENT') return [];
  // L'appel doit bien viser ce type ou un de ses parents (pas une réécriture de l'appel).
  if (type.id !== declaring.id && !ancestorsOf(ctx, type).some((a) => a.id === declaring.id)) return [];
  const name = memberName(target);
  const arity = list(target, 'params').length;
  const all = concreteSubtypes(ctx, type)
    .map((cls) => ({ cls, method: executedIn(ctx, cls, name, arity) }))
    .filter((c): c is { cls: CodeSymbol; method: CodeSymbol } => !!c.method && c.method.id !== target.id);
  if (all.length === 0) return [];
  let chosen = all;
  let why: string;
  let perCaller = false;
  if (all.length === 1) why = `implémentation unique de ${target.name}`;
  else {
    const primary = all.filter((c) => list(c.cls, 'annotations').includes('Primary'));
    const named = receiver?.field ? all.filter((c) => beanName(c.cls) === receiver.field) : [];
    const asked = receiver?.qualifier ? all.filter((c) => beanName(c.cls) === receiver.qualifier) : [];
    if (asked.length === 1) {
      // Le point d'injection nomme son bean : il l'emporte sur @Primary.
      chosen = asked;
      perCaller = true;
      why = `@Qualifier("${receiver?.qualifier ?? ''}") sur « ${receiver?.field ?? ''} » parmi ${String(all.length)} implémentations de ${target.name}`;
    } else if (primary.length === 1) {
      chosen = primary;
      why = `@Primary parmi ${String(all.length)} implémentations de ${target.name}`;
    } else if (named.length === 1) {
      chosen = named;
      perCaller = true;
      why = `bean nommé comme le champ « ${receiver?.field ?? ''} » parmi ${String(all.length)} implémentations de ${target.name}`;
    } else {
      why = `une des ${String(all.length)} implémentations de ${target.name} ; aucune n’est désignée (@Qualifier, @Primary, nom du champ)`;
      // Des profils écrits distinguent les candidates : le profil actif à l'exécution choisit, pas le scan.
      const byProfile = all
        .filter((c) => list(c.cls, 'profiles').length > 0)
        .map(
          (c) =>
            `${c.cls.name.split('.').pop() ?? c.cls.name} sous @Profile(${list(c.cls, 'profiles').join(', ')})`,
        );
      if (byProfile.length > 0) why += ` ; selon le profil actif : ${byProfile.join(' ; ')}`;
    }
  }
  const from = perCaller || type.id !== declaring.id ? call.from : target.id;
  const candidates = chosen.length > 1 ? chosen.map((c) => c.method.id) : undefined;
  return chosen.map(({ method }) => ({
    from,
    to: method.id,
    text: `${method.name} (${why})`,
    status: 'INFERRED',
    file: method.file,
    line: method.line,
    via: why,
    ...(candidates ? { candidates } : {}),
  }));
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
