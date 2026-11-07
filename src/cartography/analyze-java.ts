import type { CodeIndex } from '../sdk/core/incident-contracts.js';
import { analyzeJavaSource, fileConstants, resolveCalls, sourceConstants } from '../incident/code/index.js';
import { readSpringConfig } from './config.js';
import {
  parseJava,
  sourceText,
  type JavaAnnotation,
  type JavaFile,
  type JavaTypeDecl,
} from '../incident/code/java-parser.js';
import type { ReadFile } from './files.js';
import { classifyQuery, dataAccessOf } from './data-access.js';
import { javaHierarchy, type ExternalParsed, type Parsed } from './java-hierarchy.js';
import type {
  JavaClass,
  JavaClientBase,
  JavaDataAccess,
  JavaComputed,
  JavaDecision,
  JavaExposure,
  JavaFacts,
  JavaField,
  JavaMapping,
  JavaMethod,
  JavaOutgoing,
  JavaRepositoryAccess,
  JavaRole,
} from './facts.js';

/**
 * JAVA SPRING ET JPA : l'analyseur de code des investigations donne les endpoints servis, les méthodes,
 * les appels entre méthodes (résolus par type) et les appels HTTP sortants (RestTemplate, WebClient,
 * RestClient, Feign). S'y ajoutent ici, lus dans l'arbre syntaxique : les DTO et leurs champs (validations,
 * @JsonProperty), les entités JPA (table, colonnes, @Column), les dépôts Spring Data et les correspondances
 * EXPLICITES entre champs (`a.setX(b.getY())`, `Type.builder().x(b.getY())`). Rien n'est exécuté.
 */
/** Les clés qui préfixent toutes les routes exposées par l'application. */
const EXPOSURE_KEYS = ['server.servlet.context-path', 'spring.webflux.base-path', 'spring.mvc.servlet.path'];
const WRITE_OPERATION = /^(save|delete|remove|update|insert|persist|merge)/;
const REPOSITORY_BASE =
  /^(JpaRepository|CrudRepository|PagingAndSortingRepository|ListCrudRepository|Repository)$/;
const VALIDATION = new Set([
  'NotNull',
  'NotBlank',
  'NotEmpty',
  'Size',
  'Length',
  'Min',
  'Max',
  'Email',
  'Pattern',
  'Positive',
  'PositiveOrZero',
  'Past',
  'Future',
  'Digits',
  'DecimalMin',
  'DecimalMax',
]);

const has = (annotations: readonly JavaAnnotation[], ...names: string[]): JavaAnnotation | undefined =>
  annotations.find((annotation) => names.includes(annotation.name));

const stringArg = (annotation: JavaAnnotation | undefined, key: string): string | undefined => {
  const part = annotation?.args[key]?.[0]?.parts[0];
  return part && 'string' in part ? part.string : undefined;
};

const numberArg = (annotation: JavaAnnotation | undefined, key: string): number | undefined => {
  const text = annotation?.args[key]?.[0]?.text;
  return text !== undefined && /^\d+$/.test(text) ? Number(text) : undefined;
};

/** Le nommage par défaut de Spring Boot : camelCase → snake_case. */
export const snake = (name: string): string =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();

function roleOf(decl: JavaTypeDecl): JavaRole {
  const names = new Set(decl.annotations.map((annotation) => annotation.name));
  if (names.has('Entity')) return 'ENTITY';
  if (names.has('RestController') || names.has('Controller')) return 'CONTROLLER';
  if (names.has('FeignClient')) return 'CLIENT';
  if (names.has('Repository') || decl.extends.some((type) => REPOSITORY_BASE.test(type.name)))
    return 'REPOSITORY';
  if (names.has('Service') || names.has('Component')) return 'SERVICE';
  if (decl.kind === 'record') return 'DTO';
  if (/(Dto|DTO|Request|Response|Payload|Command|Form|View)$/.test(decl.simpleName)) return 'DTO';
  if (names.has('Data') || names.has('Value') || names.has('Getter')) return 'DTO';
  return 'OTHER';
}

function fieldOf(
  name: string,
  type: string,
  annotations: readonly JavaAnnotation[],
  line: number,
  entity: boolean,
): JavaField {
  const column = has(annotations, 'Column', 'JoinColumn');
  const size = has(annotations, 'Size', 'Length');
  const json = has(annotations, 'JsonProperty');
  const required =
    has(annotations, 'NotNull', 'NotBlank', 'NotEmpty') !== undefined ||
    column?.args.nullable?.[0]?.text === 'false';
  const columnName = stringArg(column, 'name');
  const maxLength = numberArg(size, 'max') ?? numberArg(column, 'length');
  const jsonName = stringArg(json, 'value');
  return {
    name,
    type,
    ...(jsonName ? { jsonName } : {}),
    required,
    validations: annotations
      .filter((annotation) => VALIDATION.has(annotation.name))
      .map((annotation) => annotation.text),
    ...(entity && !has(annotations, 'Transient')
      ? columnName
        ? { column: columnName, columnHow: 'annotation' as const }
        : { column: snake(name), columnHow: 'default' as const }
      : {}),
    ...(maxLength !== undefined ? { maxLength } : {}),
    line,
  };
}

function classesOf(file: string, java: JavaFile): JavaClass[] {
  return java.types
    .filter((decl) => decl.kind !== 'annotation' && decl.kind !== 'enum')
    .map((decl): JavaClass => {
      const role = roleOf(decl);
      const entity = role === 'ENTITY';
      const table = has(decl.annotations, 'Table');
      const tableName = stringArg(table, 'name');
      const repository = decl.extends.find((type) => REPOSITORY_BASE.test(type.name));
      const managed = role === 'REPOSITORY' ? repository?.args[0]?.name : undefined;
      const fields =
        decl.kind === 'record'
          ? decl.components.map((component) =>
              fieldOf(
                component.name,
                component.type.text,
                component.annotations,
                decl.methods[0]?.line ?? 0,
                false,
              ),
            )
          : decl.fields
              .filter((field) => !field.modifiers.includes('static'))
              .map((field) => fieldOf(field.name, field.type.text, field.annotations, field.line, entity));
      return {
        name: decl.simpleName,
        qualified: decl.qualifiedName,
        role,
        ...(entity
          ? tableName
            ? { table: tableName, tableHow: 'annotation' as const }
            : { table: snake(decl.simpleName), tableHow: 'default' as const }
          : {}),
        ...(managed ? { repositoryOf: managed } : {}),
        fields,
        loc: { file, line: decl.methods[0]?.line ?? decl.fields[0]?.line ?? 1 },
      };
    });
}

/** Le nom d'un champ lu par un accesseur (`getCompanyName` → `companyName`, record `companyName()`). */
const accessorField = (name: string): string =>
  /^(get|is)[A-Z]/.test(name) ? name.replace(/^(get|is)/, '').replace(/^./, (c) => c.toLowerCase()) : name;

/**
 * La ligne d'une expression dans le fichier : le texte du corps est reconstitué à partir des jetons (sans
 * ses sauts de ligne), la ligne est donc cherchée dans le fichier, à partir de la déclaration de la méthode.
 */
function lineIn(lines: readonly string[], pattern: RegExp, from: number, fallback: number): number {
  for (let index = Math.max(0, from - 1); index < lines.length; index += 1)
    if (pattern.test(lines[index] ?? '')) return index + 1;
  return fallback;
}
const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Les correspondances explicites et les types des corps envoyés, méthode par méthode. */
function mappingsOf(
  file: string,
  java: JavaFile,
  source: string,
): {
  mappings: JavaMapping[];
  bodies: Map<string, string>;
  uses: { method: string; type: string; operation: string; loc: { file: string; line: number } }[];
  computed: JavaComputed[];
  decisions: JavaDecision[];
} {
  const lines = source.split(/\r?\n/);
  const computed: JavaComputed[] = [];
  const decisions: JavaDecision[] = [];
  const mappings: JavaMapping[] = [];
  const bodies = new Map<string, string>();
  const uses: { method: string; type: string; operation: string; loc: { file: string; line: number } }[] = [];
  for (const decl of java.types)
    for (const method of decl.methods) {
      if (!method.body) continue;
      const text = sourceText(java, method.body.start, method.body.end);
      const types = new Map<string, string>(method.params.map((param) => [param.name, param.type.name]));
      for (const field of decl.fields) types.set(field.name, field.type.name);
      for (const local of text.matchAll(/\b([A-Z]\w*)(?:<[^;=()]*>)?\s+([a-z]\w*)\s*=/g))
        if (local[1] && local[2]) types.set(local[2], local[1]);
      for (const local of text.matchAll(/\bvar\s+([a-z]\w*)\s*=\s*new\s+([A-Z]\w*)/g))
        if (local[1] && local[2]) types.set(local[1], local[2]);
      // La variable d'une boucle « for (Type x : … ) ».
      for (const local of text.matchAll(/\bfor\s*\(\s*(?:final\s+)?([A-Z]\w*)(?:<[^>]*>)?\s+([a-z]\w*)\s*:/g))
        if (local[1] && local[2]) types.set(local[2], local[1]);
      const name = `${decl.simpleName}.${method.name}`;
      // a.setX(b.getY()) / a.setX(b.y())
      for (const match of text.matchAll(
        /\b([a-z]\w*)\s*\.\s*set([A-Z]\w*)\s*\(\s*([a-z]\w*)\s*\.\s*(\w+)\s*\(\s*\)\s*\)/g,
      )) {
        const toClass = types.get(match[1] ?? '');
        const fromClass = types.get(match[3] ?? '');
        if (!toClass || !fromClass) continue;
        mappings.push({
          fromClass,
          fromField: accessorField(match[4] ?? ''),
          toClass,
          toField: (match[2] ?? '').replace(/^./, (c) => c.toLowerCase()),
          how: 'setter',
          method: name,
          loc: {
            file,
            line: lineIn(
              lines,
              new RegExp(`\\.\\s*set${escapeRe(match[2] ?? '')}\\s*\\(`),
              method.line,
              method.line,
            ),
          },
        });
      }
      // a.setX(b.m(…)) / Type.builder().x(b.m(…)) : un champ dont la valeur est calculée par une méthode.
      for (const match of text.matchAll(
        /(?:\b([a-z]\w*)\s*\.\s*set([A-Z]\w*)|\.\s*([a-z]\w*))\s*\(\s*(?:([a-z]\w*)\s*\.\s*)?([a-z]\w*)\s*\(([^()]*)\)\s*\)/g,
      )) {
        const [, target, setField, builderField, receiver, called = '', args = ''] = match;
        // Un accesseur sans argument est une correspondance de champ (déjà lue plus haut), pas un calcul.
        if (!args.trim() && /^(get|is)[A-Z]/.test(called)) continue;
        if (
          builderField &&
          ['build', 'builder', 'set', 'get', 'orElse', 'orElseThrow', 'map'].includes(builderField)
        )
          continue;
        const toClass = setField ? types.get(target ?? '') : builderTarget(text, match.index);
        const calleeClass = receiver ? types.get(receiver) : decl.simpleName;
        if (!toClass || !calleeClass || /^[A-Z]/.test(called)) continue;
        computed.push({
          toClass,
          toField: (setField ?? builderField ?? '').replace(/^./, (c) => c.toLowerCase()),
          callee: `${calleeClass}.${called}`,
          method: name,
          loc: {
            file,
            line: lineIn(lines, new RegExp(`\\b${escapeRe(called)}\\s*\\(`), method.line, method.line),
          },
        });
      }
      // Une méthode qui rend un booléen : une décision (hors accesseur qui rend un champ tel quel).
      const returns = method.returnType?.name;
      const trivial = /^\{?\s*return\s+(?:this\.)?\w+\s*;\s*\}?$/.test(text.trim());
      if (
        (returns === 'boolean' || returns === 'Boolean') &&
        !trivial &&
        method.params.length + text.length > 40
      ) {
        const clip = (value: string): string => value.replace(/\s+/g, ' ').trim().slice(0, 140);
        const predicates = [
          ...[...text.matchAll(/\bif\s*\(((?:[^()]|\((?:[^()]|\([^()]*\))*\))*)\)/g)].map(
            (m) => `si ${clip(m[1] ?? '')}`,
          ),
          ...[...text.matchAll(/\breturn\s+([^;]+);/g)].map((m) => `rend ${clip(m[1] ?? '')}`),
        ].slice(0, 6);
        const reads = [
          ...new Set(
            [...text.matchAll(/\b([a-z]\w*)\s*\.\s*((?:get|is)[A-Z]\w*)\s*\(\s*\)/g)].map(
              (m) => `${types.get(m[1] ?? '') ?? m[1] ?? ''}.${accessorField(m[2] ?? '')}`,
            ),
          ),
        ].slice(0, 12);
        decisions.push({
          owner: decl.simpleName,
          name: method.name,
          loops: (
            text.match(
              /\bfor\s*\(|\bwhile\s*\(|\.stream\s*\(|\.forEach\s*\(|\.(?:any|all|none)Match\s*\(/g,
            ) ?? []
          ).length,
          predicates,
          reads,
          params: method.params.map((param) => param.type.name),
          loc: { file, line: method.line },
        });
      }
      // Type.builder().x(b.getY())… jusqu'au point-virgule.
      for (const statement of text.matchAll(/\b([A-Z]\w*)\s*\.\s*builder\s*\(\s*\)([^;]*);/g)) {
        const toClass = statement[1] ?? '';
        for (const part of (statement[2] ?? '').matchAll(
          /\.\s*(\w+)\s*\(\s*([a-z]\w*)\s*\.\s*(\w+)\s*\(\s*\)\s*\)/g,
        )) {
          const fromClass = types.get(part[2] ?? '');
          if (!fromClass || part[1] === 'build') continue;
          mappings.push({
            fromClass,
            fromField: accessorField(part[3] ?? ''),
            toClass,
            toField: part[1] ?? '',
            how: 'builder',
            method: name,
            loc: {
              file,
              line: lineIn(
                lines,
                new RegExp(`\\.\\s*${escapeRe(part[1] ?? '')}\\s*\\(\\s*${escapeRe(part[2] ?? '')}\\b`),
                method.line,
                method.line,
              ),
            },
          });
        }
      }
      // Le corps envoyé : postForObject(url, body, …), postForEntity, exchange(…, new HttpEntity<>(body)…), bodyValue(body), body(body).
      const sent =
        /\b(?:postForObject|postForEntity|put|patchForObject)\s*\(\s*[^,]+,\s*([a-z]\w*)\s*[,)]/.exec(
          text,
        )?.[1] ??
        /\bnew\s+HttpEntity\s*<[^>]*>\s*\(\s*([a-z]\w*)/.exec(text)?.[1] ??
        /\.\s*(?:bodyValue|body)\s*\(\s*([a-z]\w*)\s*\)/.exec(text)?.[1];
      const sentType = sent ? types.get(sent) : undefined;
      if (sentType) bodies.set(name, sentType);
      // Les appels sur une variable typée (`repository.save(…)`) : gardés pour reconnaître les dépôts.
      for (const call of text.matchAll(/\b([a-z]\w*)\s*\.\s*([a-z]\w*)\s*\(/g)) {
        const type = types.get(call[1] ?? '');
        if (type)
          uses.push({
            method: name,
            type,
            operation: call[2] ?? '',
            loc: {
              file,
              line: lineIn(
                lines,
                new RegExp(`\\b${escapeRe(call[1] ?? '')}\\s*\\.\\s*${escapeRe(call[2] ?? '')}\\s*\\(`),
                method.line,
                method.line,
              ),
            },
          });
      }
    }
  return { mappings, bodies, uses, computed, decisions };
}

/** Le type construit par le `Type.builder()` qui précède une position (même instruction). */
function builderTarget(text: string, at: number): string | undefined {
  const start = Math.max(text.lastIndexOf(';', at), text.lastIndexOf('{', at));
  return /\b([A-Z]\w*)\s*\.\s*builder\s*\(\s*\)/.exec(text.slice(start + 1, at))?.[1];
}

export function analyzeJava(
  sourceId: string,
  layer: 'BFF' | 'BACKEND',
  files: readonly ReadFile[],
  /** Les types des dépendances Maven résolues (jars de contrats) : routes héritées et clients HTTP. */
  external: readonly ExternalParsed[] = [],
): JavaFacts {
  const warnings: string[] = [];
  // La variante par défaut seulement (entrées sans profil) : les valeurs d'un profil ne sont jamais
  // mélangées à celles du défaut ; elles sont lues par variante dans le modèle de configuration.
  const config = readSpringConfig(files);
  const properties: Record<string, string> = {};
  for (const entry of config.entries)
    if (!entry.profile && !entry.secret) properties[entry.key] = entry.value;
  let index: CodeIndex = {
    applications: [],
    symbols: [],
    endpoints: [],
    outgoing: [],
    calls: [],
    denied: [],
    truncated: [],
  };
  const classes: JavaClass[] = [];
  const mappings: JavaMapping[] = [];
  const bodies = new Map<string, string>();
  const uses: ReturnType<typeof mappingsOf>['uses'] = [];
  const computed: JavaComputed[] = [];
  const decisions: JavaDecision[] = [];
  const parsed: Parsed[] = [];
  // Les constantes de toute la source d'abord : une route citée par import statique ou `Classe.CHAMP`
  // d'un autre fichier est ainsi résolue (sinon elle resterait un segment inconnu `{}`).
  const javaFiles = files.filter((entry) => entry.path.endsWith('.java'));
  const shared = sourceConstants(javaFiles);
  for (const file of javaFiles) {
    const result = analyzeJavaSource(sourceId, layer, file.path, file.text, properties, shared);
    index = {
      ...index,
      symbols: [...index.symbols, ...result.symbols],
      endpoints: [...index.endpoints, ...result.endpoints],
      outgoing: [...index.outgoing, ...result.outgoing],
      calls: [...index.calls, ...result.calls],
    };
    let java: JavaFile;
    try {
      java = parseJava(file.text);
    } catch {
      warnings.push(`unreadable Java file: ${file.path}`);
      continue;
    }
    parsed.push({ file: file.path, java });
    classes.push(...classesOf(file.path, java));
    const found = mappingsOf(file.path, java, file.text);
    mappings.push(...found.mappings);
    for (const [key, value] of found.bodies) bodies.set(key, value);
    uses.push(...found.uses);
    computed.push(...found.computed);
    decisions.push(...found.decisions);
  }
  // Une classe sans rôle reconnu, mais envoyée comme corps ou lue/écrite par un mapping explicite, est un
  // objet de transfert : ses champs sont nécessaires pour suivre la donnée.
  const carried = new Set([
    ...bodies.values(),
    ...mappings.flatMap((mapping) => [mapping.fromClass, mapping.toClass]),
    // Le type rendu par un endpoint, ou dont un champ est calculé, transporte aussi la donnée.
    ...computed.map((entry) => entry.toClass),
    ...index.endpoints.map((endpoint) => {
      const returns = index.symbols.find((symbol) => symbol.id === endpoint.symbolId)?.detail?.returns;
      return typeof returns === 'string' ? returns.replace(/^.*<\s*|\s*>.*$/g, '') : '';
    }),
  ]);
  for (const cls of classes) if (cls.role === 'OTHER' && carried.has(cls.name)) cls.role = 'DTO';
  index = resolveCalls(index);
  const roleByClass = new Map(classes.map((entry) => [entry.name, entry.role]));
  const symbols = new Map(index.symbols.map((symbol) => [symbol.id, symbol]));
  const ownerOf = (symbolId: string): string => symbols.get(symbols.get(symbolId)?.parent ?? '')?.name ?? '';
  const methods: JavaMethod[] = index.symbols
    .filter((symbol) => symbol.parent && typeof symbol.detail?.declaration !== 'string')
    .map((symbol) => {
      const owner = ownerOf(symbol.id).split('.').pop() ?? '';
      const role = roleByClass.get(owner) ?? 'OTHER';
      const simple =
        symbol.name
          .replace(/~\d+$/, '')
          .replace(/\(.*\)$/, '')
          .split('.')
          .pop() ?? symbol.name;
      return {
        id: symbol.id,
        name: simple,
        owner,
        role,
        // Une requête `@Query` lisible décide de l'accès ; sinon le nom de l'opération Spring Data.
        ...((): Pick<JavaMethod, 'access' | 'query'> => {
          if (role !== 'REPOSITORY') return {};
          const sql = typeof symbol.detail?.sql === 'string' ? symbol.detail.sql : undefined;
          const shape = sql ? classifyQuery(sql) : undefined;
          return {
            access:
              shape && shape.operation !== 'UNKNOWN'
                ? shape.operation === 'SELECT'
                  ? 'READ'
                  : 'WRITE'
                : WRITE_OPERATION.test(simple)
                  ? 'WRITE'
                  : 'READ',
            ...(sql ? { query: { text: sql, native: symbol.detail?.nativeQuery === true } } : {}),
          };
        })(),
        loc: { file: symbol.file, line: symbol.line },
      };
    });
  // Les accès aux dépôts Spring Data depuis une méthode (`repository.save(entity)`) : la méthode héritée
  // n'est pas déclarée, l'accès est donc lu à l'appel ; lecture ou écriture d'après le nom de l'opération.
  const repositories = new Map(
    classes
      .filter((cls) => cls.role === 'REPOSITORY' && cls.repositoryOf)
      .map((cls) => [cls.name, cls.repositoryOf ?? '']),
  );
  // Les méthodes des fragments d'un dépôt (interfaces de la source qu'il étend, `OrderRepositoryCustom`) :
  // écrites à la main, leur accès est lu dans leur implémentation, jamais déduit de leur nom.
  const fragmentOps = new Map<string, Set<string>>();
  const declOf = new Map(parsed.flatMap((p) => p.java.types.map((t) => [t.simpleName, t] as const)));
  for (const repository of repositories.keys()) {
    const decl = declOf.get(repository);
    const ops = new Set<string>();
    for (const parent of [...(decl?.extends ?? []), ...(decl?.implements ?? [])]) {
      const fragment = declOf.get(parent.name);
      if (fragment && fragment.kind === 'interface' && !repositories.has(fragment.simpleName))
        for (const m of fragment.methods) ops.add(m.name);
    }
    if (ops.size > 0) fragmentOps.set(repository, ops);
  }
  const repositoryAccess: JavaRepositoryAccess[] = [];
  for (const use of uses) {
    const entity = repositories.get(use.type);
    if (!entity) continue;
    if (fragmentOps.get(use.type)?.has(use.operation)) continue;
    const [owner, name] = use.method.split('.');
    const from = methods.find((method) => method.owner === owner && method.name === name);
    if (!from) continue;
    const access = WRITE_OPERATION.test(use.operation) ? ('WRITE' as const) : ('READ' as const);
    if (
      !repositoryAccess.some(
        (entry) => entry.from === from.id && entry.entity === entity && entry.access === access,
      )
    )
      repositoryAccess.push({
        from: from.id,
        repository: use.type,
        entity,
        operation: use.operation,
        access,
        loc: use.loc,
      });
  }
  const texts = new Map(files.map((file) => [file.path, file.text.split(/\r?\n/)]));
  const known = new Set(classes.map((cls) => cls.name));
  const outgoing: JavaOutgoing[] = index.outgoing.map((call) => {
    const symbol = symbols.get(call.symbolId);
    const key = symbol
      ? `${ownerOf(call.symbolId).split('.').pop() ?? ''}.${
          symbol.name
            .replace(/~\d+$/, '')
            .replace(/\(.*\)$/, '')
            .split('.')
            .pop() ?? ''
        }`
      : '';
    const bodyType = bodies.get(key);
    // La réponse attendue : le dernier `Type.class` de la ligne de l'appel, s'il désigne une classe lue.
    const lineText = (texts.get(call.file) ?? [])[call.line - 1] ?? '';
    const responseType = [...lineText.matchAll(/\b([A-Z]\w*)\.class\b/g)]
      .map((match) => match[1] ?? '')
      .filter((name) => known.has(name))
      .pop();
    return {
      from: call.symbolId,
      ...(call.method ? { method: call.method } : {}),
      ...(call.path ? { path: call.path } : {}),
      status: call.status === 'STATICALLY_RESOLVED' || call.status === 'INFERRED' ? call.status : 'UNKNOWN',
      ...(bodyType ? { bodyType } : {}),
      ...(responseType ? { responseType } : {}),
      ...(call.origin ? { origin: call.origin } : {}),
      ...(call.client ? { client: call.client } : {}),
      ...(call.properties?.length ? { properties: call.properties } : {}),
      loc: { file: call.file, line: call.line },
    };
  });
  // Les routes héritées (interface, classe de base), les interfaces absentes (générées au build) et les appels
  // sur un client généré : lus sur toute la source.
  const arityOf = (id: string): number | undefined => {
    const params = symbols.get(id)?.detail?.params;
    return Array.isArray(params) ? params.length : undefined;
  };
  const hierarchy = javaHierarchy(
    parsed,
    properties,
    (owner, name, arity) => {
      const all = methods.filter((m) => m.owner === owner && m.name === name);
      const hit = all.find((m) => arityOf(m.id) === arity) ?? (all.length === 1 ? all[0] : undefined);
      return hit ? { id: hit.id, file: hit.loc.file, line: hit.loc.line } : undefined;
    },
    uses,
    (owner, name) => methods.find((m) => m.owner === owner && m.name === name)?.id,
    (java) => fileConstants(java, shared),
    external,
  );
  // Le préfixe d'exposition de l'application (context-path, base-path), lu dans sa configuration.
  // Par profil : une valeur d'un profil est une variante, jamais fusionnée avec celle du défaut.
  const exposure: JavaExposure[] = config.entries
    .filter((e) => EXPOSURE_KEYS.includes(e.key) && e.value.trim() !== '' && !e.secret)
    .map((e) => ({
      key: e.key,
      value: e.value.trim(),
      file: e.file,
      line: e.line,
      ...(e.profile ? { profile: e.profile } : {}),
    }));

  return {
    classes,
    endpoints: index.endpoints
      .map((endpoint) => {
        const handler = symbols.get(endpoint.symbolId);
        const detail = handler?.detail ?? {};
        return {
          id: `${endpoint.method} ${endpoint.path}`,
          method: endpoint.method,
          path: endpoint.path,
          handler: endpoint.symbolId,
          handlerName: `${ownerOf(endpoint.symbolId).split('.').pop() ?? ''}.${
            handler?.name
              .replace(/~\d+$/, '')
              .replace(/\(.*\)$/, '')
              .split('.')
              .pop() ?? ''
          }`,
          ...(typeof detail.requestBody === 'string' ? { requestBody: detail.requestBody } : {}),
          ...(typeof detail.returns === 'string' ? { returns: detail.returns } : {}),
          ...(typeof detail.validated === 'boolean' ? { validated: detail.validated } : {}),
          loc: { file: handler?.file ?? '', line: handler?.line ?? 1 },
        };
      })
      .concat(
        hierarchy.endpoints.filter(
          (e) => !index.endpoints.some((x) => x.symbolId === e.handler && `${x.method} ${x.path}` === e.id),
        ),
      ),
    methods,
    outgoing: [...outgoing, ...hierarchy.outgoing],
    calls: index.calls.map((call) => ({
      from: call.from,
      ...(call.to ? { to: call.to } : {}),
      status: call.status === 'STATICALLY_RESOLVED' || call.status === 'INFERRED' ? call.status : 'UNKNOWN',
      ...(call.via ? { via: call.via } : {}),
      ...(call.candidates ? { candidates: call.candidates } : {}),
      loc: { file: call.file, line: call.line },
    })),
    mappings,
    repositoryAccess,
    computed,
    decisions,
    ...(hierarchy.implementations.length ? { implementations: hierarchy.implementations } : {}),
    ...(hierarchy.clients.length ? { clients: hierarchy.clients } : {}),
    ...((): { dataAccess?: JavaDataAccess[] } => {
      const found = dataAccessOf(
        parsed,
        (java) => fileConstants(java, shared),
        (owner, name, arity) => {
          const all = methods.filter((m) => m.owner === owner && m.name === name);
          return (all.find((m) => arityOf(m.id) === arity) ?? (all.length === 1 ? all[0] : undefined))?.id;
        },
      );
      return found.length ? { dataAccess: found } : {};
    })(),
    ...((): { clientBases?: JavaClientBase[] } => {
      const bases = clientBasesOf(files);
      return bases.length ? { clientBases: bases } : {};
    })(),
    ...(exposure.length ? { exposure } : {}),
    warnings,
  };
}

/**
 * Les bases d'URL des clients générés réglées dans un bean : `client.setBasePath(url)`, `.basePath(url)`,
 * `.setRootUri(url)`. L'argument est un paramètre ou un champ `@Value("${clé}")` (propriété), ou un texte.
 * Le `@Profile` du bean (ou de sa classe) et son `@ConditionalOnProperty` sont gardés : jamais évalués ici.
 */
function clientBasesOf(files: readonly ReadFile[]): JavaClientBase[] {
  const out: JavaClientBase[] = [];
  for (const file of files) {
    if (!file.path.endsWith('.java') || !/\.(setBasePath|basePath|setRootUri)\s*\(/.test(file.text)) continue;
    const text = file.text;
    const classProfile = /@Profile\(\s*"([^"]+)"\s*\)[\s\S]*?\bclass\s/.exec(text)?.[1];
    for (const m of text.matchAll(
      /\b(\w+)\.(setBasePath|basePath|setRootUri)\s*\(\s*("([^"]*)"|\w+)\s*\)/g,
    )) {
      const at = m.index;
      const variable = m[1] ?? '';
      const arg = m[3] ?? '';
      // Le type configuré : la déclaration de la variable (`ApiClient client = …`).
      const type = new RegExp(`\\b([A-Z]\\w*)\\s+${variable}\\s*=`).exec(text)?.[1] ?? variable;
      const literal = m[4];
      const property = literal
        ? undefined
        : new RegExp(
            `@Value\\(\\s*"\\$\\{([^}:"]+)(?::[^}"]*)?\\}"\\s*\\)\\s*(?:final\\s+)?String\\s+${arg}\\b`,
          ).exec(text)?.[1];
      // Le bean qui contient l'appel : ses annotations, entre le `@Bean` précédent et l'appel.
      const bean = text.lastIndexOf('@Bean', at);
      const head = bean >= 0 ? text.slice(bean, at) : '';
      const profile = /@Profile\(\s*"([^"]+)"\s*\)/.exec(head)?.[1] ?? classProfile;
      const condition = /@ConditionalOnProperty\(([^)]*)\)/.exec(head)?.[1]?.trim();
      if (!literal && !property) continue;
      out.push({
        type,
        ...(property ? { property } : {}),
        ...(literal !== undefined ? { value: literal } : {}),
        ...(profile ? { profile } : {}),
        ...(condition ? { condition } : {}),
        loc: { file: file.path, line: text.slice(0, at).split('\n').length },
      });
    }
  }
  return out;
}
