import type { JavaAnnotation, JavaFile, JavaMethod, JavaTypeDecl } from '../incident/code/java-parser.js';
import { joinPaths } from '../incident/code/paths.js';
import type { JavaClientCall, JavaEndpoint, JavaImplementation, Loc } from './facts.js';

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
): { endpoints: JavaEndpoint[]; implementations: JavaImplementation[]; clients: JavaClientCall[] } {
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
  const qualifiedOf = (java: JavaFile, simple: string): string | undefined =>
    java.imports.find((entry) => entry.endsWith(`.${simple}`)) ??
    (java.package ? `${java.package}.${simple}` : undefined);
  /** Le type désigné par un nom écrit dans un fichier : par l'import, sinon le seul de ce nom. */
  const resolveType = (java: JavaFile, name: string) => {
    const simple = name.split('.').pop() ?? name;
    const all = types.get(simple) ?? [];
    const qualified = qualifiedOf(java, simple);
    return all.find((t) => t.decl.qualifiedName === qualified) ?? (all.length === 1 ? all[0] : undefined);
  };

  const endpoints: JavaEndpoint[] = [];
  const implementations: JavaImplementation[] = [];
  for (const { decl, file, java } of [...types.values()].flat()) {
    if (decl.kind !== 'class' || decl.modifiers.includes('abstract')) continue;
    // Les parents : classes (chaîne extends) puis interfaces, lus ou absents.
    const present: { decl: JavaTypeDecl; file: string; java: JavaFile }[] = [];
    const missing: { name: string; qualified?: string }[] = [];
    const queue: { from: JavaFile; name: string }[] = [
      ...decl.extends.map((t) => ({ from: java, name: t.name })),
      ...decl.implements.map((t) => ({ from: java, name: t.name })),
    ];
    const seen = new Set<string>([decl.qualifiedName]);
    while (queue.length > 0 && present.length + missing.length < 20) {
      const next = queue.shift();
      if (!next) break;
      const found = resolveType(next.from, next.name);
      if (!found) {
        const simple = next.name.split('.').pop() ?? next.name;
        const qualified = qualifiedOf(next.from, simple);
        if (qualified && !LIBRARY.test(qualified) && !missing.some((m) => m.name === simple))
          missing.push({ name: simple, qualified });
        continue;
      }
      if (seen.has(found.decl.qualifiedName)) continue;
      seen.add(found.decl.qualifiedName);
      present.push(found);
      queue.push(
        ...found.decl.extends.map((t) => ({ from: found.java, name: t.name })),
        ...found.decl.implements.map((t) => ({ from: found.java, name: t.name })),
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
              via: { type: declaring.decl.simpleName, file: declaring.file, line: mapped.line },
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

  // Les appels sur un objet d'un type importé mais absent de la source (client généré).
  const clients: JavaClientCall[] = [];
  const javaOf = new Map(parsed.map((p) => [p.file, p.java]));
  for (const use of uses) {
    if (types.has(use.type)) continue;
    const java = javaOf.get(use.loc.file);
    const qualified = java?.imports.find((entry) => entry.endsWith(`.${use.type}`));
    if (!qualified || LIBRARY.test(qualified)) continue;
    const [owner = '', name = ''] = use.method.split('.');
    const from = methodId(owner, name);
    if (!from) continue;
    if (clients.some((c) => c.from === from && c.type === use.type && c.operation === use.operation))
      continue;
    clients.push({ from, type: use.type, qualified, operation: use.operation, loc: use.loc });
  }
  return { endpoints, implementations, clients };
}
