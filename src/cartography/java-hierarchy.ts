import type { JavaAnnotation, JavaFile, JavaMethod, JavaTypeDecl } from '../incident/code/java-parser.js';
import { joinPaths } from '../incident/code/paths.js';
import type { JavaClientCall, JavaEndpoint, JavaImplementation, JavaOutgoing, Loc } from './facts.js';

/**
 * LES ROUTES HÉRITÉES ET LES TYPES ABSENTS d'une source Java, lus sur toute la source (un contrôleur, son
 * interface et sa classe de base sont souvent dans des fichiers différents) :
 *
 * - une route déclarée sur une interface (générée et versionnée, ou écrite) ou une classe de base est
 *   exposée par le contrôleur concret qui en hérite (Spring lit les annotations dans la hiérarchie) ; le
 *   gestionnaire est l'implémentation la plus dérivée ;
 * - une interface implémentée mais ABSENTE de la source (générée au build) est notée, avec les méthodes
 *   `@Override` qui l'implémentent : leur route ne peut venir que du contrat d'où elle est générée ;
 * - un appel sur un objet dont le type est importé mais absent (client généré) est noté.
 *
 * Rien n'est supposé : une route n'est produite que si une annotation la déclare.
 */
export interface Parsed {
  file: string;
  java: JavaFile;
}

/**
 * Un type lu hors des sources (dépendance Maven : jar de sources ou classe compilée) : il sert à résoudre la
 * hiérarchie (routes héritées, clients HTTP déclarés) ; il n'est jamais lui-même un contrôleur de l'application.
 */
export interface ExternalParsed extends Parsed {
  /** `groupe:artefact:version`. */
  artifact: string;
  read: 'SOURCES_JAR' | 'CLASS';
}

type Handler = (
  owner: string,
  method: string,
  arity: number,
) => { id: string; file: string; line: number } | undefined;

const VERBS: Record<string, string> = {
  GetMapping: 'GET',
  PostMapping: 'POST',
  PutMapping: 'PUT',
  PatchMapping: 'PATCH',
  DeleteMapping: 'DELETE',
};
const LIBRARY =
  /^(java|javax|jakarta|org\.springframework|lombok|org\.slf4j|com\.fasterxml|reactor|io\.swagger)\./;
const isController = (decl: JavaTypeDecl): boolean =>
  decl.annotations.some((a) => a.name === 'RestController' || a.name === 'Controller');
const has = (list: readonly JavaAnnotation[], ...names: string[]): JavaAnnotation | undefined =>
  list.find((a) => names.includes(a.name));

/** `${clé:défaut}` → la valeur de la configuration, sinon le défaut ; sans valeur ni défaut : `{}`. */
function placeholders(text: string, properties: Readonly<Record<string, string>>): string {
  return text.replace(/\$\{([^}:]+)(?::([^}]*))?\}/g, (_whole, key: string, fallback?: string) =>
    key in properties ? (properties[key] ?? '') : fallback !== undefined ? fallback : '{}',
  );
}

function strings(
  ann: JavaAnnotation | undefined,
  keys: string[],
  properties: Readonly<Record<string, string>>,
  constants?: ReadonlyMap<string, string>,
): string[] {
  if (!ann) return [];
  const out: string[] = [];
  for (const key of keys)
    for (const value of ann.args[key] ?? []) {
      let text = '';
      // Une constante (du fichier, ou importée d'un autre) est remplacée par sa valeur ; sinon `{}`.
      for (const part of value.parts)
        text += 'string' in part ? part.string : (constants?.get(part.name) ?? '{}');
      out.push(placeholders(text, properties));
    }
  return out;
}

/** Les méthodes HTTP et les chemins d'une annotation de route de méthode. */
function mappingOf(
  method: JavaMethod,
  properties: Readonly<Record<string, string>>,
  constants?: ReadonlyMap<string, string>,
): { verbs: string[]; paths: string[] } | undefined {
  for (const ann of method.annotations) {
    const verb = VERBS[ann.name];
    if (!verb && ann.name !== 'RequestMapping') continue;
    const paths = strings(ann, ['value', 'path'], properties, constants);
    const verbs = verb
      ? [verb]
      : (ann.args.method ?? [])
          .flatMap((v) => v.text.split(/[\s,{}]+/).filter(Boolean))
          .map((t) => t.split('.').pop() ?? t);
    return {
      verbs: verbs.length ? verbs.map((v) => v.toUpperCase()) : ['*'],
      paths: paths.length ? paths : [''],
    };
  }
  return undefined;
}

export function javaHierarchy(
  parsed: readonly Parsed[],
  properties: Readonly<Record<string, string>>,
  handlerOf: Handler,
  uses: readonly { method: string; type: string; operation: string; loc: Loc }[],
  methodId: (owner: string, method: string) => string | undefined,
  /** Les constantes visibles dans un fichier (imports statiques, `Classe.CHAMP` d'autres fichiers). */
  constantsOf?: (java: JavaFile) => ReadonlyMap<string, string>,
  /** Les types des dépendances Maven résolues (jars), pour la hiérarchie seulement. */
  external: readonly ExternalParsed[] = [],
): {
  endpoints: JavaEndpoint[];
  implementations: JavaImplementation[];
  clients: JavaClientCall[];
  outgoing: JavaOutgoing[];
} {
  const scopes = new WeakMap<JavaFile, ReadonlyMap<string, string>>();
  const consts = (java: JavaFile): ReadonlyMap<string, string> | undefined => {
    if (!constantsOf) return undefined;
    const cached = scopes.get(java);
    if (cached) return cached;
    const scope = constantsOf(java);
    scopes.set(java, scope);
    return scope;
  };
  const types = new Map<string, { decl: JavaTypeDecl; file: string; java: JavaFile }[]>();
  for (const { file, java } of parsed)
    for (const decl of java.types)
      types.set(decl.simpleName, [...(types.get(decl.simpleName) ?? []), { decl, file, java }]);
  // Les types des dépendances : un type des sources de même nom qualifié l'emporte (la source est lue).
  const sourceNames = new Set([...types.values()].flat().map((t) => t.decl.qualifiedName));
  const externalOf = new Map<JavaTypeDecl, ExternalParsed>();
  for (const ext of external)
    for (const decl of ext.java.types) {
      if (sourceNames.has(decl.qualifiedName)) continue;
      externalOf.set(decl, ext);
      types.set(decl.simpleName, [
        ...(types.get(decl.simpleName) ?? []),
        { decl, file: ext.file, java: ext.java },
      ]);
    }
  const qualifiedOf = (java: JavaFile, simple: string): string | undefined =>
    java.imports.find((entry) => entry.endsWith(`.${simple}`)) ??
    (java.package ? `${java.package}.${simple}` : undefined);
  /** Le type désigné par un nom écrit dans un fichier : par l'import, sinon le seul de ce nom. */
  const resolveType = (java: JavaFile, written: string) => {
    const name = written.replace(/<.*$/, '').trim();
    const simple = name.split('.').pop() ?? name;
    const all = types.get(simple) ?? [];
    // Un nom qualifié (écrit, ou lu dans une classe compilée) désigne ce type et aucun autre.
    if (name.includes('.') && all.some((t) => t.decl.qualifiedName === name))
      return all.find((t) => t.decl.qualifiedName === name);
    const qualified = qualifiedOf(java, simple);
    const exact = all.find((t) => t.decl.qualifiedName === qualified);
    if (exact) return exact;
    if (all.length === 1) return all[0];
    // Import à la demande (`import a.b.*;`) : il ne tranche que s'il désigne un seul type de ce nom.
    const onDemand = all.filter((t) => java.imports.includes(`${t.java.package ?? ''}.*`));
    return onDemand.length === 1 ? onDemand[0] : undefined;
  };

  const endpoints: JavaEndpoint[] = [];
  const implementations: JavaImplementation[] = [];
  for (const { decl, file, java } of [...types.values()].flat()) {
    if (decl.kind !== 'class' || decl.modifiers.includes('abstract')) continue;
    // Une classe d'une dépendance n'est pas un contrôleur de l'application (rien ne montre qu'elle est chargée).
    if (externalOf.has(decl)) continue;
    // Les parents : classes (chaîne extends) puis interfaces, lus ou absents.
    const present: { decl: JavaTypeDecl; file: string; java: JavaFile }[] = [];
    const missing: { name: string; qualified?: string }[] = [];
    const queue: { from: JavaFile; name: string }[] = [
      ...decl.extends.map((t) => ({ from: java, name: t.text })),
      ...decl.implements.map((t) => ({ from: java, name: t.text })),
    ];
    const seen = new Set<string>([decl.qualifiedName]);
    while (queue.length > 0 && present.length + missing.length < 20) {
      const next = queue.shift();
      if (!next) break;
      const found = resolveType(next.from, next.name);
      if (!found) {
        const written = next.name.replace(/<.*$/, '').trim();
        const simple = written.split('.').pop() ?? written;
        const qualified = written.includes('.') ? written : qualifiedOf(next.from, simple);
        if (qualified && !LIBRARY.test(qualified) && !missing.some((m) => m.name === simple))
          missing.push({ name: simple, qualified });
        continue;
      }
      if (seen.has(found.decl.qualifiedName)) continue;
      seen.add(found.decl.qualifiedName);
      present.push(found);
      queue.push(
        ...found.decl.extends.map((t) => ({ from: found.java, name: t.text })),
        ...found.decl.implements.map((t) => ({ from: found.java, name: t.text })),
      );
    }
    const lineage = [{ decl, file, java }, ...present];
    if (!lineage.some((t) => isController(t.decl))) continue;
    // Le préfixe de type : la première `@RequestMapping` de type dans la hiérarchie (Spring).
    const typeMapping = lineage.find((t) => has(t.decl.annotations, 'RequestMapping'));
    const bases = typeMapping
      ? strings(
          has(typeMapping.decl.annotations, 'RequestMapping'),
          ['value', 'path'],
          properties,
          consts(typeMapping.java),
        )
      : [];
    const keys = new Map<string, { name: string; arity: number }>();
    for (const t of lineage)
      for (const m of t.decl.methods)
        if (!m.constructor && !m.modifiers.includes('static'))
          keys.set(`${m.name}/${String(m.params.length)}`, { name: m.name, arity: m.params.length });
    const ownMethods: JavaImplementation['methods'] = [];
    for (const [key, { name, arity }] of keys) {
      const sameIn = (t: { decl: JavaTypeDecl }) =>
        t.decl.methods.find((m) => `${m.name}/${String(m.params.length)}` === key);
      const declaring = lineage.find((t) => {
        const m = sameIn(t);
        return m !== undefined && mappingOf(m, properties, consts(t.java)) !== undefined;
      });
      // L'implémentation : la plus dérivée qui a un corps (une méthode `default` d'interface en est une).
      const implementing = lineage.find((t) => sameIn(t)?.body !== undefined);
      if (!declaring) {
        const own = implementing ? sameIn(implementing) : undefined;
        if (own && implementing && missing.length > 0 && has(own.annotations, 'Override')) {
          const handler = handlerOf(implementing.decl.simpleName, name, arity);
          if (handler)
            ownMethods.push({
              name,
              arity,
              handler: handler.id,
              loc: { file: handler.file, line: handler.line },
            });
        }
        continue;
      }
      // Une route écrite sur le contrôleur lui-même est déjà lue par l'analyseur de fichier.
      if (declaring.decl === decl) continue;
      const mapped = sameIn(declaring);
      const mapping = mapped ? mappingOf(mapped, properties, consts(declaring.java)) : undefined;
      const target = implementing ?? declaring;
      const handler = handlerOf(target.decl.simpleName, name, arity);
      if (!mapping || !mapped || !handler) continue;
      const implMethod = sameIn(target);
      const body = [...(implMethod?.params ?? []), ...mapped.params].find((p) =>
        has(p.annotations, 'RequestBody'),
      );
      for (const verb of mapping.verbs)
        for (const base of bases.length ? bases : [''])
          for (const p of mapping.paths) {
            const path = joinPaths(base, p);
            endpoints.push({
              id: `${verb} ${path}`,
              method: verb,
              path,
              handler: handler.id,
              handlerName: `${target.decl.simpleName}.${name}`,
              ...(body ? { requestBody: body.type.name } : {}),
              ...(mapped.returnType ? { returns: mapped.returnType.text } : {}),
              via: {
                type: declaring.decl.simpleName,
                file: declaring.file,
                line: mapped.line,
                ...((): { artifact?: string; read?: 'SOURCES_JAR' | 'CLASS' } => {
                  const ext = externalOf.get(declaring.decl);
                  return ext ? { artifact: ext.artifact, read: ext.read } : {};
                })(),
              },
              controller: decl.simpleName,
              loc: { file: handler.file, line: handler.line },
            });
          }
    }
    if (missing.length > 0) {
      const own = has(decl.annotations, 'RequestMapping');
      const basePath = own ? strings(own, ['value', 'path'], properties, consts(java))[0] : undefined;
      implementations.push({
        controller: decl.simpleName,
        ...(basePath !== undefined ? { basePath } : {}),
        missing,
        methods: ownMethods,
        loc: { file, line: decl.line },
      });
    }
  }

  // Les appels sur un objet d'un type importé mais absent de la source (client généré), et les appels par une
  // interface cliente HTTP déclarée (`@FeignClient`, `@HttpExchange`), lue dans la source ou une dépendance.
  const clients: JavaClientCall[] = [];
  const outgoing: JavaOutgoing[] = [];
  const javaOf = new Map(parsed.map((p) => [p.file, p.java]));
  for (const use of uses) {
    const java = javaOf.get(use.loc.file);
    const [owner = '', name = ''] = use.method.split('.');
    const from = methodId(owner, name);
    if (!java || !from) continue;
    const found = resolveType(java, use.type);
    if (found && found.decl.kind === 'interface') {
      const out = httpClientCall(found, use.operation);
      if (out) {
        if (!outgoing.some((o) => o.from === from && o.method === out.method && o.path === out.path))
          outgoing.push({ from, ...out, loc: use.loc });
        continue;
      }
    }
    // Un type des sources n'est pas un client généré ; un type d'une dépendance l'est peut-être.
    if (found && !externalOf.has(found.decl)) continue;
    const qualified =
      found?.decl.qualifiedName ?? java.imports.find((entry) => entry.endsWith(`.${use.type}`));
    if (!qualified || LIBRARY.test(qualified)) continue;
    if (clients.some((c) => c.from === from && c.type === use.type && c.operation === use.operation))
      continue;
    clients.push({ from, type: use.type, qualified, operation: use.operation, loc: use.loc });
  }
  return { endpoints, implementations, clients, outgoing };

  /**
   * L'appel HTTP qu'une méthode d'interface cliente déclare : `@FeignClient` (préfixe `path`, adresse `url`) et
   * annotations Spring MVC, ou `@HttpExchange` (préfixe de type) et `@GetExchange`… La méthode peut venir d'une
   * interface parente (contrat partagé). Plusieurs routes possibles pour ce nom (surcharges) : rien n'est choisi.
   */
  function httpClientCall(
    client: { decl: JavaTypeDecl; java: JavaFile },
    operation: string,
  ): Omit<JavaOutgoing, 'from' | 'loc'> | undefined {
    const feign = has(client.decl.annotations, 'FeignClient');
    const lineage = [client];
    for (let i = 0; i < lineage.length && lineage.length < 20; i++) {
      const cur = lineage[i];
      for (const parent of cur?.decl.extends ?? []) {
        const p = cur ? resolveType(cur.java, parent.text) : undefined;
        if (p && !lineage.some((x) => x.decl === p.decl)) lineage.push(p);
      }
    }
    const exchange =
      has(client.decl.annotations, 'HttpExchange') ??
      lineage.flatMap((t) => t.decl.methods).find((m) => exchangeOf(m) !== undefined)?.annotations[0];
    if (!feign && !exchange) return undefined;
    const routes = new Map<string, { method: string; path: string; inherited: boolean }>();
    for (const t of lineage)
      for (const m of t.decl.methods.filter((x) => x.name === operation)) {
        const map = feign ? mappingOf(m, properties, consts(t.java)) : exchangeOf(m);
        if (!map) continue;
        const typePrefix = feign
          ? [
              ...strings(feign, ['path'], properties, consts(client.java)),
              // Le préfixe de type d'un contrat parent hérité par le client Feign : repris, mais déduit.
              ...(t !== client
                ? strings(has(t.decl.annotations, 'RequestMapping'), ['value', 'path'], properties)
                : []),
            ].reduce((a, b) => joinPaths(a, b), '')
          : (strings(has(t.decl.annotations, 'HttpExchange'), ['value', 'url'], properties)[0] ?? '');
        for (const verb of map.verbs)
          for (const p of map.paths)
            routes.set(`${verb} ${joinPaths(typePrefix, p)}`, {
              method: verb,
              path: joinPaths(typePrefix, p),
              inherited: t !== client,
            });
      }
    if (routes.size !== 1) return undefined;
    const [route] = [...routes.values()];
    if (!route || route.method === '*') return undefined;
    const ext = externalOf.get(client.decl);
    // L'adresse du client Feign : une propriété (`${clé}`) gardée telle quelle pour la configuration.
    const url = feign
      ? (feign.args.url?.[0]?.parts.map((x) => ('string' in x ? x.string : '')).join('') ?? '')
      : '';
    const keys = [...url.matchAll(/\$\{([^}:]+)/g)].map((m) => m[1] ?? '');
    const origin = /^https?:\/\/[^/]+/.exec(placeholders(url, properties))?.[0];
    // L'adresse n'est démontrée que si elle est lue (propriété ou URL absolue) ; une interface HTTP reçoit sa
    // base à la création du proxy (à l'exécution) : la route est comparée seule, le lien reste probable.
    const addressed = keys.length > 0 || origin !== undefined;
    return {
      method: route.method,
      path: route.path,
      status: addressed && !(route.inherited && feign) ? 'STATICALLY_RESOLVED' : 'INFERRED',
      client: `${client.decl.simpleName} (${feign ? 'Feign' : 'interface HTTP'}${ext ? `, ${ext.artifact}` : ''}${addressed ? '' : ', adresse réglée à l’exécution'})`,
      ...(keys.length ? { properties: keys } : {}),
      ...(origin ? { origin } : {}),
      ...(addressed ? {} : { addressUnknown: true }),
    };
  }
}

const EXCHANGES: Record<string, string> = {
  GetExchange: 'GET',
  PostExchange: 'POST',
  PutExchange: 'PUT',
  PatchExchange: 'PATCH',
  DeleteExchange: 'DELETE',
};

/** La route d'une méthode d'interface HTTP (`@GetExchange("/x")`, `@HttpExchange(method = "GET")`). */
function exchangeOf(method: JavaMethod): { verbs: string[]; paths: string[] } | undefined {
  for (const ann of method.annotations) {
    const verb = EXCHANGES[ann.name];
    if (!verb && ann.name !== 'HttpExchange') continue;
    const paths = [...(ann.args.value ?? []), ...(ann.args.url ?? [])].map((v) =>
      v.parts.map((x) => ('string' in x ? x.string : '{}')).join(''),
    );
    const declared = (ann.args.method ?? []).map((v) =>
      v.parts.map((x) => ('string' in x ? x.string : '')).join(''),
    );
    return {
      verbs: verb ? [verb] : declared.length ? declared.map((v) => v.toUpperCase()) : ['*'],
      paths: paths.length ? paths : [''],
    };
  }
  return undefined;
}
