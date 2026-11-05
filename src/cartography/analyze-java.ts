import type { CodeIndex } from '../sdk/core/incident-contracts.js';
import { analyzeJavaSource, readSpringProperties, resolveCalls } from '../incident/code/index.js';
import {
  parseJava,
  sourceText,
  type JavaAnnotation,
  type JavaFile,
  type JavaTypeDecl,
} from '../incident/code/java-parser.js';
import type { ReadFile } from './files.js';
import type {
  JavaClass,
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
const SPRING_CONFIG = /(^|\/)application(-[\w.-]+)?\.(ya?ml|properties)$/i;
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
} {
  const lines = source.split(/\r?\n/);
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
  return { mappings, bodies, uses };
}

export function analyzeJava(
  sourceId: string,
  layer: 'BFF' | 'BACKEND',
  files: readonly ReadFile[],
): JavaFacts {
  const warnings: string[] = [];
  const properties: Record<string, string> = {};
  for (const file of files.filter((entry) => SPRING_CONFIG.test(entry.path)))
    for (const [key, value] of Object.entries(readSpringProperties(file.path, file.text)))
      if (!(key in properties)) properties[key] = value;
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
  for (const file of files.filter((entry) => entry.path.endsWith('.java'))) {
    const result = analyzeJavaSource(sourceId, layer, file.path, file.text, properties);
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
    classes.push(...classesOf(file.path, java));
    const found = mappingsOf(file.path, java, file.text);
    mappings.push(...found.mappings);
    for (const [key, value] of found.bodies) bodies.set(key, value);
    uses.push(...found.uses);
  }
  // Une classe sans rôle reconnu, mais envoyée comme corps ou lue/écrite par un mapping explicite, est un
  // objet de transfert : ses champs sont nécessaires pour suivre la donnée.
  const carried = new Set([
    ...bodies.values(),
    ...mappings.flatMap((mapping) => [mapping.fromClass, mapping.toClass]),
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
        ...(role === 'REPOSITORY'
          ? { access: WRITE_OPERATION.test(simple) ? ('WRITE' as const) : ('READ' as const) }
          : {}),
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
  const repositoryAccess: JavaRepositoryAccess[] = [];
  for (const use of uses) {
    const entity = repositories.get(use.type);
    if (!entity) continue;
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
  return {
    classes,
    endpoints: index.endpoints.map((endpoint) => {
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
    }),
    methods,
    outgoing,
    calls: index.calls.map((call) => ({
      from: call.from,
      ...(call.to ? { to: call.to } : {}),
      status: call.status === 'STATICALLY_RESOLVED' || call.status === 'INFERRED' ? call.status : 'UNKNOWN',
      loc: { file: call.file, line: call.line },
    })),
    mappings,
    repositoryAccess,
    warnings,
  };
}
