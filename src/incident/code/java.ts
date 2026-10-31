import type {
  CodeCall,
  CodeEndpoint,
  CodeIndex,
  CodeSymbol,
  CodeSymbolKind,
  OutgoingHttpCall,
  RelationStatus,
} from '../model.js';
import type { JavaToken } from './java-lexer.js';
import {
  matchClose,
  parseJava,
  sourceText,
  splitTopLevel,
  type JavaAnnotation,
  type JavaAnnotationValue,
  type JavaFile,
  type JavaMethod,
  type JavaParam,
  type JavaTypeDecl,
  type JavaTypeRef,
} from './java-parser.js';
import { joinPaths, urlPath } from './paths.js';
import { resolvePlaceholders } from './properties.js';

/**
 * L'analyse SPRING d'un fichier Java (BFF ou backend), sur la structure du parseur : controllers et
 * routes (préfixe de classe + chaque style de mapping), DTO et validations par champ, services,
 * mappers, clients HTTP sortants (RestTemplate, WebClient, RestClient, Feign) avec résolution des
 * `@Value("${…}")` par la configuration, repositories Spring Data, `@Transactional`, `@Query`,
 * exceptions et handlers, chaînes de déréférencement (`book.getPublisher().getName()`).
 *
 * Tout ce qui est lu est STATICALLY_RESOLVED (littéral, sans ambiguïté), INFERRED (reconstruit :
 * propriété, constante, chemin dynamique) ou UNKNOWN. OBSERVED n'est jamais produit ici : c'est du
 * code lu, pas une exécution. Un appel vers un champ est laissé UNKNOWN : `resolveCalls` le relie
 * quand tout l'index est connu.
 */

type Detail = NonNullable<CodeSymbol['detail']>;
type JavaResult = Pick<CodeIndex, 'symbols' | 'endpoints' | 'outgoing' | 'calls'>;

const MAPPINGS: Record<string, string> = {
  GetMapping: 'GET',
  PostMapping: 'POST',
  PutMapping: 'PUT',
  DeleteMapping: 'DELETE',
  PatchMapping: 'PATCH',
};

export const VALIDATION_ANNOTATIONS = new Set([
  'NotNull',
  'NotBlank',
  'NotEmpty',
  'Null',
  'Size',
  'Length',
  'Min',
  'Max',
  'DecimalMin',
  'DecimalMax',
  'Digits',
  'Positive',
  'PositiveOrZero',
  'Negative',
  'NegativeOrZero',
  'Pattern',
  'Email',
  'Past',
  'PastOrPresent',
  'Future',
  'FutureOrPresent',
  'AssertTrue',
  'AssertFalse',
  'Range',
  'URL',
  'ISBN',
  'Valid',
]);
const REQUIRED_ANNOTATIONS = new Set(['NotNull', 'NotBlank', 'NotEmpty']);
const PRIMITIVES = new Set(['int', 'long', 'short', 'byte', 'char', 'boolean', 'double', 'float']);

const REPOSITORY_BASE =
  /^(Jpa|Crud|ListCrud|PagingAndSorting|ListPagingAndSorting|ReactiveCrud|ReactiveSorting|R2dbc|Mongo|ReactiveMongo|Elasticsearch|Neo4j|Cassandra|Couchbase|KeyValue|Revision)?Repository$/;

const HTTP_CLIENT_TYPES = new Set([
  'RestTemplate',
  'TestRestTemplate',
  'RestOperations',
  'WebClient',
  'RestClient',
]);
const REST_TEMPLATE_METHODS: Record<string, string | undefined> = {
  getForObject: 'GET',
  getForEntity: 'GET',
  postForObject: 'POST',
  postForEntity: 'POST',
  postForLocation: 'POST',
  put: 'PUT',
  patchForObject: 'PATCH',
  delete: 'DELETE',
  headForHeaders: 'HEAD',
  optionsForAllow: 'OPTIONS',
  exchange: undefined,
  execute: undefined,
};
const FLUENT_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

/** Types de bibliothèque dont les appels ne sont pas des relations du code applicatif. */
const LIBRARY_FIELD_TYPES = new Set([
  'Logger',
  'Log',
  'ObjectMapper',
  'String',
  'Clock',
  'MeterRegistry',
  'ApplicationEventPublisher',
  'Environment',
  'JdbcTemplate',
  'NamedParameterJdbcTemplate',
  'EntityManager',
  'Validator',
  'List',
  'Map',
  'Set',
  'Optional',
  ...HTTP_CLIENT_TYPES,
]);
const LIBRARY_PACKAGE =
  /^(java|javax|jakarta|org\.springframework|reactor|com\.fasterxml|org\.slf4j|lombok|org\.junit|org\.mockito|org\.assertj|org\.apache|io\.micrometer|org\.hibernate|feign|io\.swagger|org\.mapstruct)\./;
const JAVA_LANG = new Set([
  'String',
  'Integer',
  'Long',
  'Short',
  'Byte',
  'Double',
  'Float',
  'Boolean',
  'Character',
  'Math',
  'System',
  'Thread',
  'Object',
  'Class',
  'Enum',
  'Record',
  'StringBuilder',
  'Runtime',
  'Objects',
]);
/** Types courants du JDK et de Spring, souvent importés à l'étoile. */
const COMMON_LIBRARY_TYPES = new Set([
  'Optional',
  'List',
  'Map',
  'Set',
  'Collections',
  'Arrays',
  'Stream',
  'Collectors',
  'ResponseEntity',
  'HttpStatus',
  'HttpHeaders',
  'MediaType',
  'UUID',
  'Instant',
  'LocalDate',
  'LocalDateTime',
  'Duration',
  'BigDecimal',
  'URI',
  'UriComponentsBuilder',
  'Mono',
  'Flux',
  'Assertions',
  'Mockito',
  'LoggerFactory',
  'Map.Entry',
]);
const KEYWORDS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'synchronized',
  'return',
  'throw',
  'new',
  'else',
  'case',
  'try',
  'do',
  'super',
  'instanceof',
  'yield',
  'assert',
  'null',
  'true',
  'false',
]);

export const HTTP_STATUS_CODES: Record<string, number> = {
  OK: 200,
  CREATED: 201,
  ACCEPTED: 202,
  NO_CONTENT: 204,
  MOVED_PERMANENTLY: 301,
  FOUND: 302,
  NOT_MODIFIED: 304,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  NOT_ACCEPTABLE: 406,
  CONFLICT: 409,
  GONE: 410,
  PRECONDITION_FAILED: 412,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  UNPROCESSABLE_ENTITY: 422,
  UNPROCESSABLE_CONTENT: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  NOT_IMPLEMENTED: 501,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
  GATEWAY_TIMEOUT: 504,
};
const RESPONSE_ENTITY_SHORTCUTS: Record<string, number> = {
  ok: 200,
  created: 201,
  accepted: 202,
  noContent: 204,
  badRequest: 400,
  notFound: 404,
  unprocessableEntity: 422,
  internalServerError: 500,
};

type Role =
  | 'CONTROLLER'
  | 'EXCEPTION_HANDLER'
  | 'HTTP_CLIENT'
  | 'REPOSITORY'
  | 'MAPPER'
  | 'EXCEPTION'
  | 'SERVICE'
  | 'DTO'
  | 'OTHER';

interface FieldInfo {
  type: JavaTypeRef;
  /** `@Value("${…}")` du champ (ou du paramètre de constructeur affecté au champ). */
  property?: string;
  /** L'expression `baseUrl(…)` d'un WebClient / RestClient construit dans la classe. */
  baseUrl?: { start: number; end: number };
}

interface LocalInfo {
  type: string;
  init?: { start: number; end: number };
  nullable: boolean;
}

interface FileContext {
  app: string;
  layer: 'BFF' | 'BACKEND';
  file: string;
  java: JavaFile;
  properties: Record<string, string>;
  /** Constantes `static final String` du fichier : par nom simple et `Classe.NOM`. */
  constants: Map<string, string>;
  ids: Set<string>;
  out: JavaResult;
}

interface UrlPiece {
  kind: 'literal' | 'resolved' | 'dynamic';
  text: string;
}

interface UrlEvaluation {
  /** L'URL reconstruite (paramètres `{nom}`) ; absente si dynamique. */
  url?: string;
  status: RelationStatus;
  /** Les propriétés lues (`catalog.url`). */
  properties: string[];
}

export function analyzeJavaSource(
  applicationId: string,
  layer: 'BFF' | 'BACKEND',
  file: string,
  text: string,
  properties: Record<string, string> = {},
): JavaResult {
  const out: JavaResult = { symbols: [], endpoints: [], outgoing: [], calls: [] };
  let java: JavaFile;
  try {
    java = parseJava(text);
  } catch {
    return out;
  }
  const ctx: FileContext = {
    app: applicationId,
    layer,
    file,
    java,
    properties,
    constants: collectConstants(java),
    ids: new Set(),
    out,
  };
  for (const decl of java.types) analyzeType(ctx, decl);
  return out;
}

function symbolId(ctx: FileContext, name: string): string {
  return `${ctx.app}:${ctx.file}#${name}`;
}

function uniqueName(ctx: FileContext, name: string): string {
  let candidate = name;
  for (let n = 2; ctx.ids.has(symbolId(ctx, candidate)); n++) candidate = `${name}~${n}`;
  ctx.ids.add(symbolId(ctx, candidate));
  return candidate;
}

function annotation(list: JavaAnnotation[], ...names: string[]): JavaAnnotation | undefined {
  return list.find((a) => names.includes(a.name));
}

function collectConstants(java: JavaFile): Map<string, string> {
  const constants = new Map<string, string>();
  for (const decl of java.types) {
    for (const field of decl.fields) {
      const isConstant =
        (field.modifiers.includes('static') && field.modifiers.includes('final')) ||
        decl.kind === 'interface';
      if (!isConstant || !field.initializer || field.type.name !== 'String') continue;
      const value = literalConcat(java.tokens, field.initializer.start, field.initializer.end, constants);
      if (value === undefined) continue;
      constants.set(field.name, value);
      constants.set(`${decl.simpleName}.${field.name}`, value);
    }
  }
  return constants;
}

/** Une concaténation de littéraux et de constantes déjà connues ; undefined sinon. */
function literalConcat(
  tokens: JavaToken[],
  start: number,
  end: number,
  constants: Map<string, string>,
): string | undefined {
  let out = '';
  for (const part of splitTopLevel(tokens, start, end, '+')) {
    const slice = tokens.slice(part.start, part.end);
    if (slice.length === 1 && slice[0]?.kind === 'string') out += slice[0].value ?? '';
    else {
      const name = slice.map((t) => t.text).join('');
      const value = constants.get(name);
      if (value === undefined) return undefined;
      out += value;
    }
  }
  return out;
}

/** Les chaînes d'un argument d'annotation (constantes du fichier et `${…}` résolus) ; `{}` pour l'inconnu. */
function annotationStrings(
  ctx: FileContext,
  ann: JavaAnnotation | undefined,
  keys: string[],
): { values: string[]; inferred: boolean } {
  const values: string[] = [];
  let inferred = false;
  if (!ann) return { values, inferred };
  for (const key of keys) {
    for (const value of ann.args[key] ?? []) {
      let text = '';
      for (const part of value.parts) {
        if ('string' in part) text += part.string;
        else {
          const constant = ctx.constants.get(part.name);
          inferred = true;
          text += constant ?? '{}';
        }
      }
      if (text.includes('${')) {
        text = resolvePlaceholders(text, ctx.properties).value;
        inferred = true;
      }
      values.push(text);
    }
  }
  return { values, inferred };
}

/** Les noms d'un argument d'annotation (`RequestMethod.POST` → POST, `X.class` → X). */
function annotationNames(ann: JavaAnnotation | undefined, key: string): string[] {
  const values: JavaAnnotationValue[] = ann?.args[key] ?? [];
  return values.flatMap((v) =>
    v.parts.flatMap((p) => ('name' in p ? [p.name.split('.').pop() ?? p.name] : [])),
  );
}

function statusOf(ann: JavaAnnotation | undefined): number | undefined {
  for (const key of ['value', 'code']) {
    for (const name of annotationNames(ann, key)) {
      const code = HTTP_STATUS_CODES[name];
      if (code) return code;
    }
  }
  return undefined;
}

function annotationNamesOf(list: JavaAnnotation[]): string[] {
  return list.map((a) => a.name);
}

function classRole(decl: JavaTypeDecl, fields: Map<string, FieldInfo>): Role {
  const names = new Set(annotationNamesOf(decl.annotations));
  if (names.has('RestController') || names.has('Controller')) return 'CONTROLLER';
  if (names.has('RestControllerAdvice') || names.has('ControllerAdvice')) return 'EXCEPTION_HANDLER';
  if (names.has('FeignClient') || names.has('HttpExchange')) return 'HTTP_CLIENT';
  if (names.has('Repository') || decl.extends.some((e) => REPOSITORY_BASE.test(e.name))) return 'REPOSITORY';
  if (names.has('Mapper') || /Mapper$/.test(decl.simpleName)) return 'MAPPER';
  if (decl.kind === 'class' && decl.extends.some((e) => /(Exception|Error|Throwable)$/.test(e.name)))
    return 'EXCEPTION';
  const httpField = [...fields.values()].some((f) => HTTP_CLIENT_TYPES.has(f.type.name));
  if (httpField && (!names.has('Service') || /(Client|Gateway|Adapter|Proxy)$/.test(decl.simpleName)))
    return 'HTTP_CLIENT';
  if (names.has('Service') || names.has('Component') || names.has('Configuration')) return 'SERVICE';
  if (decl.kind === 'interface' && /Service$/.test(decl.simpleName)) return 'SERVICE';
  if (names.has('Entity') || names.has('Embeddable') || names.has('Document')) return 'DTO';
  if (decl.kind === 'record' || decl.kind === 'enum') return 'DTO';
  if (/(Dto|DTO|Request|Response|View|Payload|Command|Form|Resource)$/.test(decl.simpleName)) return 'DTO';
  if (names.has('Data') || names.has('Value') || names.has('Getter')) return 'DTO';
  // Une classe qui ne porte que des champs et des accesseurs : une structure de données.
  const accessorsOnly =
    decl.kind === 'class' &&
    decl.fields.length > 0 &&
    decl.methods.every(
      (m) => m.constructor || /^(get|set|is|with)[A-Z]|^(equals|hashCode|toString)$/.test(m.name),
    );
  return accessorsOnly ? 'DTO' : 'OTHER';
}

const ROLE_KIND: Record<Role, CodeSymbolKind> = {
  CONTROLLER: 'CONTROLLER',
  EXCEPTION_HANDLER: 'EXCEPTION_HANDLER',
  HTTP_CLIENT: 'HTTP_CLIENT',
  REPOSITORY: 'REPOSITORY',
  MAPPER: 'MAPPER',
  EXCEPTION: 'EXCEPTION',
  SERVICE: 'SERVICE',
  DTO: 'DTO',
  OTHER: 'FUNCTION',
};

function collectFields(ctx: FileContext, decl: JavaTypeDecl): Map<string, FieldInfo> {
  const tokens = ctx.java.tokens;
  const fields = new Map<string, FieldInfo>();
  for (const component of decl.components) fields.set(component.name, { type: component.type });
  for (const field of decl.fields) {
    if (field.modifiers.includes('static') && field.type.name !== 'Logger') continue;
    const info: FieldInfo = { type: field.type };
    const value = annotation(field.annotations, 'Value');
    const property = value?.args.value?.[0]?.parts.map((p) => ('string' in p ? p.string : '')).join('');
    if (property) info.property = property;
    if (field.initializer) {
      const base = findBaseUrl(tokens, field.initializer.start, field.initializer.end);
      if (base) info.baseUrl = base;
    }
    fields.set(field.name, info);
  }
  for (const ctor of decl.methods.filter((m) => m.constructor)) {
    const body = ctor.body;
    for (const param of ctor.params) {
      const value = annotation(param.annotations, 'Value');
      const property = value?.args.value?.[0]?.parts.map((p) => ('string' in p ? p.string : '')).join('');
      // `this.catalogUrl = catalogUrl;` : la propriété du paramètre passe au champ.
      const target = body ? assignedField(tokens, body.start, body.end, param.name) : undefined;
      const fieldName = target ?? param.name;
      const info = fields.get(fieldName);
      if (info && property) info.property = property;
      if (!info && !fields.has(param.name)) {
        const created: FieldInfo = { type: param.type };
        if (property) created.property = property;
        if (target === undefined) fields.set(param.name, created);
      }
    }
    if (!body) continue;
    // `this.webClient = builder.baseUrl(catalogUrl).build();`
    for (let i = body.start; i < body.end; i++) {
      if (tokens[i]?.text !== 'this' || tokens[i + 1]?.text !== '.' || tokens[i + 3]?.text !== '=') continue;
      const name = tokens[i + 2]?.text ?? '';
      const info = fields.get(name);
      if (!info) continue;
      const stop = statementEnd(tokens, i + 4, body.end);
      const base = findBaseUrl(tokens, i + 4, stop);
      if (base) {
        info.baseUrl = base;
        // Le paramètre `@Value` utilisé dans baseUrl(…) devient lisible depuis le champ.
        const arg = tokens[base.start];
        const param = ctor.params.find((p) => p.name === arg?.text);
        const value = param ? annotation(param.annotations, 'Value') : undefined;
        const property = value?.args.value?.[0]?.parts.map((p) => ('string' in p ? p.string : '')).join('');
        if (property && base.end === base.start + 1) info.property = property;
      }
    }
  }
  return fields;
}

function assignedField(tokens: JavaToken[], start: number, end: number, param: string): string | undefined {
  for (let i = start; i < end; i++) {
    if (
      tokens[i]?.text === 'this' &&
      tokens[i + 1]?.text === '.' &&
      tokens[i + 3]?.text === '=' &&
      tokens[i + 4]?.text === param &&
      tokens[i + 5]?.text === ';'
    )
      return tokens[i + 2]?.text;
  }
  return undefined;
}

function statementEnd(tokens: JavaToken[], from: number, end: number): number {
  let depth = 0;
  for (let i = from; i < end; i++) {
    const t = tokens[i]?.text;
    if (t === '(' || t === '{' || t === '[') depth++;
    else if (t === ')' || t === '}' || t === ']') depth--;
    else if (t === ';' && depth <= 0) return i;
  }
  return end;
}

function findBaseUrl(
  tokens: JavaToken[],
  start: number,
  end: number,
): { start: number; end: number } | undefined {
  for (let i = start; i < end; i++) {
    if ((tokens[i]?.text === 'baseUrl' || tokens[i]?.text === 'rootUri') && tokens[i + 1]?.text === '(') {
      const close = matchClose(tokens, i + 1, end);
      const first = splitTopLevel(tokens, i + 2, close)[0];
      if (first) return first;
    }
  }
  return undefined;
}

function analyzeType(ctx: FileContext, decl: JavaTypeDecl): void {
  const fields = collectFields(ctx, decl);
  const role = classRole(decl, fields);
  const className = uniqueName(ctx, decl.name);
  const classId = symbolId(ctx, className);
  const annotations = annotationNamesOf(decl.annotations);
  const detail: Detail = {
    declaration: decl.kind,
    qualifiedName: decl.qualifiedName,
    annotations,
    fields: [...fields.entries()].map(([name, info]) => `${name}:${info.type.name}`),
    imports: ctx.java.imports,
  };
  if (ctx.java.package) detail.package = ctx.java.package;
  if (decl.extends.length > 0) detail.extends = decl.extends.map((e) => e.text);
  if (decl.implements.length > 0) detail.implements = decl.implements.map((e) => e.text);
  if (decl.components.length > 0) detail.components = decl.components.map((c) => c.name);
  if (decl.enumConstants.length > 0) detail.constants = decl.enumConstants;
  const stereotype = annotations.find((a) =>
    [
      'RestController',
      'Controller',
      'Service',
      'Component',
      'Configuration',
      'Repository',
      'SpringBootApplication',
    ].includes(a),
  );
  if (stereotype) detail.stereotype = stereotype;
  const lombok = annotations.filter((a) =>
    ['Data', 'Getter', 'Setter', 'Builder', 'RequiredArgsConstructor', 'AllArgsConstructor'].includes(a),
  );
  const lombokValue = decl.annotations.some(
    (a) => a.name === 'Value' && Object.keys(a.args).length === 0 && !a.qualified.includes('springframework'),
  );
  if (lombokValue) lombok.push('Value');
  if (lombok.length > 0) detail.lombok = lombok;
  if (/\/src\/test\//.test('/' + ctx.file)) detail.test = true;

  const classRequestMapping = annotation(decl.annotations, 'RequestMapping');
  const basePaths = annotationStrings(ctx, classRequestMapping, ['value', 'path']);
  if (role === 'CONTROLLER') detail.basePaths = basePaths.values.length > 0 ? basePaths.values : ['/'];
  if (role === 'REPOSITORY') {
    const base = decl.extends.find((e) => REPOSITORY_BASE.test(e.name));
    if (base) {
      detail.repositoryBase = base.name;
      if (base.args[0]) detail.entity = base.args[0].name;
      if (base.args[1]) detail.idType = base.args[1].name;
    }
  }
  const feign = annotation(decl.annotations, 'FeignClient');
  if (feign) {
    const name = annotationStrings(ctx, feign, ['name', 'value']).values[0];
    if (name) detail.feignName = name;
    const url = annotationStrings(ctx, feign, ['url']).values[0];
    if (url) detail.baseUrl = url;
  }
  if (role === 'EXCEPTION') {
    const status = statusOf(annotation(decl.annotations, 'ResponseStatus'));
    if (status) detail.responseStatus = status;
  }
  if (annotations.includes('Entity')) {
    detail.entity = true;
    const table = annotationStrings(ctx, annotation(decl.annotations, 'Table'), ['name', 'value']).values[0];
    if (table) detail.table = table;
  }
  if (role === 'DTO') Object.assign(detail, dtoDetail(ctx, decl, className, classId));
  const classTransactional = annotation(decl.annotations, 'Transactional');
  if (classTransactional) detail.transactional = true;

  ctx.out.symbols.push({
    id: classId,
    applicationId: ctx.app,
    layer: ctx.layer,
    kind: ROLE_KIND[role],
    name: className,
    file: ctx.file,
    line: decl.line,
    detail,
  });

  const methods = decl.methods.filter((m) => !m.constructor);
  const counts = new Map<string, number>();
  for (const m of methods) counts.set(m.name, (counts.get(m.name) ?? 0) + 1);
  const methodNames = new Map<string, { name: string; arity: number }[]>();
  const names = methods.map((m) => {
    const overloaded = (counts.get(m.name) ?? 0) > 1;
    const base = `${className}.${m.name}${overloaded ? `(${m.params.map((p) => p.type.name).join(',')})` : ''}`;
    const unique = uniqueName(ctx, base);
    const list = methodNames.get(m.name) ?? [];
    list.push({ name: unique, arity: m.params.length });
    methodNames.set(m.name, list);
    return unique;
  });
  methods.forEach((m, k) => {
    analyzeMethod(ctx, {
      decl,
      role,
      method: m,
      name: names[k] ?? m.name,
      classId,
      fields,
      methodNames,
      basePaths: basePaths.values.length > 0 ? basePaths.values : [''],
      basePathsInferred: basePaths.inferred,
      classTransactional,
    });
  });
}

function dtoDetail(ctx: FileContext, decl: JavaTypeDecl, className: string, classId: string): Detail {
  const members: { name: string; type: JavaTypeRef; annotations: JavaAnnotation[]; line: number }[] = [
    ...decl.components,
    ...decl.fields.filter((f) => !f.modifiers.includes('static')),
  ];
  const fields: string[] = [];
  const validated: string[] = [];
  const unvalidated: string[] = [];
  const required: string[] = [];
  const optional: string[] = [];
  const validations: string[] = [];
  const relations: string[] = [];
  const nullableRelations: string[] = [];
  for (const member of members) {
    fields.push(`${member.name}:${member.type.text}`);
    const constraints = member.annotations.filter((a) => VALIDATION_ANNOTATIONS.has(a.name));
    const isRequired = constraints.some((a) => REQUIRED_ANNOTATIONS.has(a.name));
    if (constraints.length > 0) {
      validated.push(member.name);
      validations.push(`${member.name}: ${constraints.map((c) => c.text).join(' ')}`);
      const name = uniqueName(ctx, `${className}.${member.name}`);
      ctx.out.symbols.push({
        id: symbolId(ctx, name),
        applicationId: ctx.app,
        layer: ctx.layer,
        kind: 'VALIDATION',
        name,
        file: ctx.file,
        line: member.line,
        parent: classId,
        detail: {
          field: member.name,
          type: member.type.text,
          constraints: constraints.map((c) => c.text),
          required: isRequired,
        },
      });
    } else unvalidated.push(member.name);
    if (isRequired) required.push(member.name);
    else if (!PRIMITIVES.has(member.type.text)) optional.push(member.name);
    const relation = annotation(member.annotations, 'ManyToOne', 'OneToOne', 'OneToMany', 'ManyToMany');
    if (relation) {
      relations.push(`${member.name}:${member.type.name} ${relation.text}`);
      const optionalFalse = (relation.args.optional ?? []).some((v) => v.text === 'false');
      const join = annotation(member.annotations, 'JoinColumn');
      const notNullable = (join?.args.nullable ?? []).some((v) => v.text === 'false');
      if ((relation.name === 'ManyToOne' || relation.name === 'OneToOne') && !optionalFalse && !notNullable)
        nullableRelations.push(member.name);
    }
  }
  const detail: Detail = { dataFields: fields, validatedFields: validated, unvalidatedFields: unvalidated };
  if (validations.length > 0) detail.validations = validations;
  detail.requiredFields = required;
  detail.optionalFields = optional;
  if (relations.length > 0) detail.relations = relations;
  if (nullableRelations.length > 0) detail.nullableRelations = nullableRelations;
  return detail;
}

interface MethodInput {
  decl: JavaTypeDecl;
  role: Role;
  method: JavaMethod;
  name: string;
  classId: string;
  fields: Map<string, FieldInfo>;
  methodNames: Map<string, { name: string; arity: number }[]>;
  basePaths: string[];
  basePathsInferred: boolean;
  classTransactional: JavaAnnotation | undefined;
}

function mappingOf(
  ctx: FileContext,
  annotations: JavaAnnotation[],
): { methods: string[]; paths: string[]; inferred: boolean } | undefined {
  for (const ann of annotations) {
    const verb = MAPPINGS[ann.name];
    if (verb || ann.name === 'RequestMapping') {
      const paths = annotationStrings(ctx, ann, ['value', 'path']);
      const methods = verb ? [verb] : annotationNames(ann, 'method').map((m) => m.toUpperCase());
      return {
        methods: methods.length > 0 ? methods : ['*'],
        paths: paths.values.length > 0 ? paths.values : [''],
        inferred: paths.inferred,
      };
    }
  }
  return undefined;
}

function analyzeMethod(ctx: FileContext, input: MethodInput): void {
  const { decl, role, method, name, classId } = input;
  const id = symbolId(ctx, name);
  const annotations = annotationNamesOf(method.annotations);
  const detail: Detail = {
    annotations,
    params: method.params.map((p) => `${p.type.text} ${p.name}`),
    endLine: method.endLine,
  };
  if (method.returnType) detail.returns = method.returnType.text;
  if (method.throws.length > 0) detail.declaredThrows = method.throws;
  if (method.annotations.some((a) => a.name === 'Test' || a.name === 'ParameterizedTest')) detail.test = true;
  let kind: CodeSymbolKind = role === 'MAPPER' ? 'PAYLOAD_TRANSFORM' : 'FUNCTION';

  // Transaction : sur la méthode, ou héritée de la classe pour les méthodes publiques.
  const tx = annotation(method.annotations, 'Transactional');
  const classTx =
    input.classTransactional && method.modifiers.includes('public') ? input.classTransactional : undefined;
  if (tx ?? classTx) {
    detail.transactional = true;
    detail.transaction = (tx ?? classTx)?.text ?? '@Transactional';
    if (!tx) detail.transactionSource = 'class';
    if (/readOnly\s*=\s*true/.test(detail.transaction)) detail.readOnly = true;
    if (kind === 'FUNCTION') kind = 'TRANSACTION';
  }

  const query = annotation(method.annotations, 'Query');
  if (query) {
    const sql = annotationStrings(ctx, query, ['value']).values.join(' ');
    detail.sql = sql.replace(/\s+/g, ' ').trim();
    detail.nativeQuery = (query.args.nativeQuery ?? []).some((v) => v.text === 'true');
    const params = [...new Set([...sql.matchAll(/:([A-Za-z_]\w*)|\?(\d+)/g)].map((m) => m[0]))];
    if (params.length > 0) detail.queryParams = params;
    if (annotation(method.annotations, 'Modifying')) detail.modifying = true;
    kind = 'SQL_QUERY';
  } else if (
    role === 'REPOSITORY' &&
    /^(find|get|read|query|search|stream|count|exists|delete|remove)\w*By/.test(method.name)
  ) {
    detail.derivedQuery = true;
  }

  // Routes servies (controller) et appels déclarés (client Feign).
  const mapping = mappingOf(ctx, method.annotations);
  if (mapping && role === 'CONTROLLER') {
    kind = 'ENDPOINT';
    const paths = input.basePaths.flatMap((base) => mapping.paths.map((p) => joinPaths(base, p)));
    detail.httpMethods = mapping.methods;
    detail.paths = paths;
    for (const verb of mapping.methods) {
      for (const path of paths) {
        const endpoint: CodeEndpoint = {
          applicationId: ctx.app,
          layer: ctx.layer,
          method: verb,
          path,
          symbolId: id,
        };
        ctx.out.endpoints.push(endpoint);
      }
    }
    const body = method.params.find((p) => annotation(p.annotations, 'RequestBody'));
    if (body) {
      detail.requestBody = body.type.name;
      detail.validated = Boolean(annotation(body.annotations, 'Valid', 'Validated'));
    }
    const pathVariables = method.params
      .filter((p) => annotation(p.annotations, 'PathVariable'))
      .map((p) => p.name);
    if (pathVariables.length > 0) detail.pathVariables = pathVariables;
    const requestParams = method.params
      .filter((p) => annotation(p.annotations, 'RequestParam'))
      .map((p) => p.name);
    if (requestParams.length > 0) detail.requestParams = requestParams;
  }
  if (mapping && role === 'HTTP_CLIENT' && decl.kind === 'interface') {
    kind = 'BACKEND_CALL';
    const feign = annotation(decl.annotations, 'FeignClient');
    const feignPath = annotationStrings(ctx, feign, ['path']);
    const prefixes = feignPath.values.length > 0 ? feignPath.values : [''];
    const inferred = feignPath.inferred || mapping.inferred || input.basePathsInferred;
    for (const prefix of prefixes) {
      for (const base of input.basePaths) {
        for (const p of mapping.paths) {
          for (const verb of mapping.methods) {
            const call: OutgoingHttpCall = {
              applicationId: ctx.app,
              layer: ctx.layer,
              symbolId: id,
              path: joinPaths(prefix, base, p),
              status: inferred ? 'INFERRED' : 'STATICALLY_RESOLVED',
              file: ctx.file,
              line: method.line,
            };
            if (verb !== '*') call.method = verb;
            else call.status = 'INFERRED';
            ctx.out.outgoing.push(call);
          }
        }
      }
    }
    detail.httpClient = 'Feign';
  }
  const status = statusOf(annotation(method.annotations, 'ResponseStatus'));
  if (status) detail.responseStatus = status;

  const handler = annotation(method.annotations, 'ExceptionHandler');
  if (handler) {
    kind = 'EXCEPTION_HANDLER';
    const handled = annotationNames(handler, 'value');
    detail.handles =
      handled.length > 0
        ? handled
        : method.params
            .filter((p) => /(Exception|Error|Throwable)$/.test(p.type.name))
            .map((p) => p.type.name);
  }

  if (method.body) {
    const facts = analyzeBody(ctx, input, id, method.body, Boolean(handler));
    if (facts.throws.length > 0) detail.throws = facts.throws;
    if (facts.dereferences.length > 0) detail.dereferences = facts.dereferences;
    if (facts.guardedDereferences.length > 0) detail.guardedDereferences = facts.guardedDereferences;
    if (facts.nullable.length > 0) detail.nullable = facts.nullable;
    if (facts.messages.length > 0) detail.messages = facts.messages;
    if (facts.http.length > 0) {
      detail.http = facts.http;
      detail.httpClient = facts.httpClient.join(',');
      if (kind === 'FUNCTION' || kind === 'TRANSACTION' || kind === 'PAYLOAD_TRANSFORM')
        kind = 'BACKEND_CALL';
    }
    if (facts.properties.length > 0) detail.properties = facts.properties;
    if (handler && facts.statuses.length > 0) {
      const codes = [...new Set(facts.statuses)];
      if (codes.length === 1 && typeof codes[0] === 'number' && !detail.responseStatus)
        detail.responseStatus = codes[0];
      else detail.responseStatuses = codes.map(String);
    }
  }

  ctx.out.symbols.push({
    id,
    applicationId: ctx.app,
    layer: ctx.layer,
    kind,
    name,
    file: ctx.file,
    line: method.line,
    parent: classId,
    detail,
  });
}

interface BodyFacts {
  throws: string[];
  dereferences: string[];
  guardedDereferences: string[];
  nullable: string[];
  messages: string[];
  http: string[];
  httpClient: string[];
  properties: string[];
  statuses: (number | string)[];
}

interface ChainSegment {
  name: string;
  nameIndex: number;
  /** Indices de `(` et `)` quand le segment est un appel. */
  call?: { open: number; close: number };
}

function analyzeBody(
  ctx: FileContext,
  input: MethodInput,
  methodId: string,
  body: { start: number; end: number },
  isHandler: boolean,
): BodyFacts {
  const tokens = ctx.java.tokens;
  const facts: BodyFacts = {
    throws: [],
    dereferences: [],
    guardedDereferences: [],
    nullable: [],
    messages: [],
    http: [],
    httpClient: [],
    properties: [],
    statuses: [],
  };
  const locals = collectLocals(tokens, body.start, body.end, input.method.params);
  for (const [name, local] of locals) if (local.nullable) facts.nullable.push(name);
  const add = (list: string[], value: string, max = 20): void => {
    if (!list.includes(value) && list.length < max) list.push(value);
  };

  for (let i = body.start; i < body.end; i++) {
    const t = tokens[i];
    if (!t) continue;
    if (t.kind === 'string' && isHandler) add(facts.messages, truncate(t.value ?? '', 120), 5);
    if (t.kind !== 'ident') continue;
    const prev = tokens[i - 1];

    // Exceptions levées : `throw new X(…)`, `orElseThrow(() -> new X(…))`.
    if (t.text === 'new' && tokens[i + 1]?.kind === 'ident') {
      const thrown = prev?.text === 'throw' || isInsideOrElseThrow(tokens, i, body.start);
      if (thrown) {
        let k = i + 1;
        let typeName = '';
        while (tokens[k]?.kind === 'ident') {
          typeName += tokens[k]?.text ?? '';
          if (tokens[k + 1]?.text === '.' && tokens[k + 2]?.kind === 'ident') {
            typeName += '.';
            k += 2;
          } else break;
        }
        add(facts.throws, typeName);
        const open = k + 1;
        if (tokens[open]?.text === '(') {
          const close = matchClose(tokens, open, body.end);
          for (let s = open; s < close; s++) {
            const lit = tokens[s];
            if (lit?.kind === 'string') add(facts.messages, truncate(lit.value ?? '', 120), 5);
          }
        }
      }
      continue;
    }

    if (isHandler) collectStatus(tokens, i, facts.statuses);

    if (prev && (prev.text === '.' || prev.text === '::' || prev.text === 'new')) continue;
    if (KEYWORDS.has(t.text) && t.text !== 'this') continue;
    // Référence de méthode : `this::helper`, `mapper::toView`, `CatalogBookResponse::from`.
    const member = tokens[i + 2];
    if (tokens[i + 1]?.text === '::' && member?.kind === 'ident' && member.text !== 'new') {
      methodReference(ctx, input, methodId, locals, t, member);
      continue;
    }
    const chain = readChain(tokens, i, body.end);
    if (!chain) continue;
    analyzeChain(ctx, input, methodId, locals, i, chain, facts);
  }
  return facts;
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

function isInsideOrElseThrow(tokens: JavaToken[], at: number, start: number): boolean {
  let depth = 0;
  for (let i = at - 1; i >= start; i--) {
    const t = tokens[i]?.text;
    if (t === ')') depth++;
    else if (t === '(') {
      if (depth === 0) return tokens[i - 1]?.text === 'orElseThrow';
      depth--;
    } else if (t === ';' || t === '{' || t === '}') return false;
  }
  return false;
}

function collectStatus(tokens: JavaToken[], i: number, statuses: (number | string)[]): void {
  const t = tokens[i];
  if (!t) return;
  if (t.text === 'HttpStatus' && tokens[i + 1]?.text === '.') {
    const code = HTTP_STATUS_CODES[tokens[i + 2]?.text ?? ''];
    if (code) statuses.push(code);
  } else if (t.text === 'ResponseEntity' && tokens[i + 1]?.text === '.') {
    const member = tokens[i + 2]?.text ?? '';
    const code = RESPONSE_ENTITY_SHORTCUTS[member];
    if (code) statuses.push(code);
    if (member === 'status' && tokens[i + 3]?.text === '(' && tokens[i + 4]?.kind === 'number')
      statuses.push(Number(tokens[i + 4]?.text));
  } else if (t.text === 'getStatusCode' || t.text === 'getRawStatusCode') statuses.push('propagated');
}

function methodReference(
  ctx: FileContext,
  input: MethodInput,
  methodId: string,
  locals: Map<string, LocalInfo>,
  target: JavaToken,
  member: JavaToken,
): void {
  const text = `${target.text}::${member.text}`;
  const base = { from: methodId, text, file: ctx.file, line: target.line };
  if (target.text === 'this') {
    const candidates = input.methodNames.get(member.text) ?? [];
    const first = candidates[0];
    if (first) {
      const status: RelationStatus = candidates.length === 1 ? 'STATICALLY_RESOLVED' : 'INFERRED';
      ctx.out.calls.push({ ...base, to: symbolId(ctx, first.name), status });
    }
    return;
  }
  const field = locals.has(target.text) ? undefined : input.fields.get(target.text);
  const applicative = field
    ? !LIBRARY_FIELD_TYPES.has(field.type.name)
    : /^[A-Z]/.test(target.text) && !locals.has(target.text) && isApplicationType(ctx, target.text);
  if (applicative) ctx.out.calls.push({ ...base, status: 'UNKNOWN' });
}

/** Une chaîne `racine(.membre(args)?)*` à partir d'une racine (identifiant ou `this`). */
function readChain(
  tokens: JavaToken[],
  start: number,
  end: number,
):
  | { root: string; rootCall?: { open: number; close: number }; segments: ChainSegment[]; end: number }
  | undefined {
  const root = tokens[start];
  if (!root || root.kind !== 'ident') return undefined;
  let k = start + 1;
  let rootCall: { open: number; close: number } | undefined;
  if (tokens[k]?.text === '(') {
    const close = matchClose(tokens, k, end);
    rootCall = { open: k, close };
    k = close + 1;
  }
  const segments: ChainSegment[] = [];
  while (tokens[k]?.text === '.' && k < end) {
    let nameIndex = k + 1;
    // Arguments de type explicites : `.<T>method(`.
    if (tokens[nameIndex]?.text === '<') {
      const close = matchClose(tokens, nameIndex, end);
      if (close < 0) break;
      nameIndex = close + 1;
    }
    const name = tokens[nameIndex];
    if (!name || name.kind !== 'ident') break;
    const segment: ChainSegment = { name: name.text, nameIndex };
    k = nameIndex + 1;
    if (tokens[k]?.text === '(') {
      const close = matchClose(tokens, k, end);
      segment.call = { open: k, close };
      k = close + 1;
    }
    segments.push(segment);
  }
  const chain: {
    root: string;
    rootCall?: { open: number; close: number };
    segments: ChainSegment[];
    end: number;
  } = {
    root: root.text,
    segments,
    end: k,
  };
  if (rootCall) chain.rootCall = rootCall;
  return chain;
}

function analyzeChain(
  ctx: FileContext,
  input: MethodInput,
  methodId: string,
  locals: Map<string, LocalInfo>,
  start: number,
  chain: NonNullable<ReturnType<typeof readChain>>,
  facts: BodyFacts,
): void {
  const tokens = ctx.java.tokens;
  const text = (segments: number): string => renderChain(ctx.java, chain, segments);

  // Appel d'une méthode de la classe : `helper(x)` ou `this.helper(x)`.
  const sameClass =
    chain.rootCall && !locals.has(chain.root)
      ? { name: chain.root, call: chain.rootCall }
      : chain.root === 'this' && chain.segments[0]?.call
        ? { name: chain.segments[0].name, call: chain.segments[0].call }
        : undefined;
  if (sameClass) {
    const candidates = input.methodNames.get(sameClass.name);
    if (candidates && candidates.length > 0) {
      const arity = splitTopLevel(tokens, sameClass.call.open + 1, sameClass.call.close).length;
      const exact = candidates.filter((c) => c.arity === arity);
      const target = exact[0] ?? candidates[0];
      if (target) {
        ctx.out.calls.push({
          from: methodId,
          to: symbolId(ctx, target.name),
          text: text(chain.rootCall ? 0 : 1),
          status: exact.length === 1 ? 'STATICALLY_RESOLVED' : 'INFERRED',
          file: ctx.file,
          line: tokens[start]?.line ?? 0,
        });
      }
    }
  }

  // Le receveur : un champ (`field.m(` ou `this.field.m(`), non masqué par une variable locale.
  let fieldName: string | undefined;
  let segIndex = 0;
  if (
    chain.root === 'this' &&
    chain.segments[0] &&
    !chain.segments[0].call &&
    input.fields.has(chain.segments[0].name)
  ) {
    fieldName = chain.segments[0].name;
    segIndex = 1;
  } else if (!chain.rootCall && input.fields.has(chain.root) && !locals.has(chain.root)) {
    fieldName = chain.root;
  }
  const field = fieldName ? input.fields.get(fieldName) : undefined;
  const methodSeg = chain.segments[segIndex];
  if (field && fieldName && methodSeg?.call) {
    const typeName = field.type.name;
    if (typeName === 'RestTemplate' || typeName === 'TestRestTemplate' || typeName === 'RestOperations') {
      restTemplateCall(ctx, input, methodId, locals, methodSeg, facts);
    } else if (typeName === 'WebClient' || typeName === 'RestClient') {
      fluentCall(ctx, input, methodId, locals, field, typeName, chain.segments.slice(segIndex), facts);
    } else if (!LIBRARY_FIELD_TYPES.has(typeName)) {
      const call: CodeCall = {
        from: methodId,
        text: text(segIndex + 1),
        status: 'UNKNOWN',
        file: ctx.file,
        line: tokens[start]?.line ?? 0,
      };
      ctx.out.calls.push(call);
    }
  }

  // Appel statique vers un type applicatif : `CatalogBookResponse.from(saved)`.
  const first = chain.segments[0];
  if (
    !chain.rootCall &&
    /^[A-Z]/.test(chain.root) &&
    first?.call &&
    !locals.has(chain.root) &&
    !input.fields.has(chain.root) &&
    isApplicationType(ctx, chain.root)
  ) {
    ctx.out.calls.push({
      from: methodId,
      text: text(1),
      status: 'UNKNOWN',
      file: ctx.file,
      line: tokens[start]?.line ?? 0,
    });
  }

  // Déréférencement du résultat d'un appel : `book.getPublisher().getName()`.
  if (/^[a-z_$]/.test(chain.root) || chain.root === 'this') {
    let lastDeref = -1;
    let sawCall = Boolean(chain.rootCall);
    chain.segments.forEach((segment, k) => {
      if (sawCall) lastDeref = k;
      if (segment.call) sawCall = true;
    });
    const rootType = locals.get(chain.root)?.type ?? input.fields.get(chain.root)?.type.name ?? '';
    // Un constructeur fluide (`builder.a().b().build()`) ne déréférence rien d'utile au diagnostic.
    if (lastDeref >= 0 && !/Builder$/.test(rootType) && !isTestFile(ctx.file)) {
      const deref = text(lastDeref + 1);
      // `x.getY() == null ? … : x.getY().getZ()` : déréférencement protégé dans la même instruction.
      const guardedBy = text(lastDeref);
      const statement = statementText(ctx.java, start);
      const guarded = [
        `${guardedBy} == null`,
        `${guardedBy} != null`,
        `null == ${guardedBy}`,
        `null != ${guardedBy}`,
      ].some((pattern) => statement.includes(pattern));
      const list = guarded ? facts.guardedDereferences : facts.dereferences;
      if (!list.includes(deref) && list.length < 30) list.push(deref);
    }
  }
}

function isTestFile(file: string): boolean {
  return /(^|\/)src\/test\//.test(file);
}

/** L'instruction qui contient le jeton `at` (de la limite `;` `{` `}` précédente au `;` suivant). */
function statementText(java: JavaFile, at: number): string {
  const tokens = java.tokens;
  let start = at;
  while (
    start > 0 &&
    !(['{', '}', ';'].includes(tokens[start - 1]?.text ?? '') && tokens[start - 1]?.kind === 'punct')
  )
    start--;
  const end = statementEnd(tokens, at, tokens.length);
  return sourceText(java, start, end);
}

/** Le texte d'une chaîne d'appels : arguments longs ou lambdas abrégés en `(…)`. */
function renderChain(
  java: JavaFile,
  chain: NonNullable<ReturnType<typeof readChain>>,
  segments: number,
): string {
  const args = (call: { open: number; close: number }): string => {
    const inner = sourceText(java, call.open + 1, call.close);
    return `(${inner.includes('->') || inner.length > 60 ? '…' : inner})`;
  };
  let out = chain.root + (chain.rootCall ? args(chain.rootCall) : '');
  for (const segment of chain.segments.slice(0, segments)) {
    out += '.' + segment.name + (segment.call ? args(segment.call) : '');
  }
  return truncate(out, 200);
}

function isApplicationType(ctx: FileContext, name: string): boolean {
  if (JAVA_LANG.has(name) || COMMON_LIBRARY_TYPES.has(name) || /^[A-Z][A-Z0-9_]*$/.test(name)) return false;
  const imported = ctx.java.imports.find((i) => i.endsWith(`.${name}`));
  // Sans import explicite : même package, import à l'étoile ou type du fichier ; resolveCalls tranche.
  return imported ? !LIBRARY_PACKAGE.test(imported) : true;
}

function collectLocals(
  tokens: JavaToken[],
  start: number,
  end: number,
  params: JavaParam[],
): Map<string, LocalInfo> {
  const locals = new Map<string, LocalInfo>();
  for (const p of params) locals.set(p.name, { type: p.type.name, nullable: false });
  for (let i = start; i < end; i++) {
    const t = tokens[i];
    const nameTok = tokens[i + 1];
    const after = tokens[i + 2]?.text;
    if (!t || nameTok?.kind !== 'ident' || KEYWORDS.has(nameTok.text)) continue;
    if (after !== '=' && after !== ';' && after !== ':') continue;
    let typeName: string | undefined;
    if (t.kind === 'ident' && !KEYWORDS.has(t.text)) typeName = t.text;
    else if (t.text === '>' || t.text === ']') {
      // `List<String> names =`, `String[] parts =` : la base du type.
      let depth = 0;
      let k = i;
      for (; k >= start; k--) {
        const x = tokens[k]?.text;
        if (x === '>' || x === ']') depth++;
        else if (x === '<' || x === '[') {
          depth--;
          if (depth === 0) break;
        }
      }
      const base = tokens[k - 1];
      if (base?.kind === 'ident') typeName = base.text;
    }
    if (!typeName) continue;
    const info: LocalInfo = { type: typeName, nullable: false };
    if (after === '=') {
      const stop = statementEnd(tokens, i + 3, end);
      info.init = { start: i + 3, end: stop };
      info.nullable = mayBeNull(tokens, i + 3, stop);
    }
    locals.set(nameTok.text, info);
  }
  return locals;
}

/** Un initialiseur qui peut valoir null : `null`, `orElse(null)`, une branche `: null` / `? null`. */
function mayBeNull(tokens: JavaToken[], start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    if (tokens[i]?.text !== 'null') continue;
    const prev = tokens[i - 1]?.text;
    const next = tokens[i + 1]?.text;
    if (end - start === 1) return true;
    if (prev === '(' && tokens[i - 2]?.text === 'orElse' && next === ')') return true;
    if (prev === ':' || prev === '?') return true;
  }
  return false;
}

/** Évalue une expression d'URL Java (concaténation de littéraux, champs `@Value`, constantes, variables). */
function evaluateUrl(
  ctx: FileContext,
  input: MethodInput,
  locals: Map<string, LocalInfo>,
  start: number,
  end: number,
  depth = 0,
): UrlEvaluation & { pieces: UrlPiece[] } {
  const tokens = ctx.java.tokens;
  const pieces: UrlPiece[] = [];
  const properties: string[] = [];
  for (const part of splitTopLevel(tokens, start, end, '+')) {
    const slice = tokens.slice(part.start, part.end);
    const first = slice[0];
    if (!first) continue;
    if (slice.length === 1 && first.kind === 'string') {
      pieces.push({ kind: 'literal', text: first.value ?? '' });
      continue;
    }
    const simple =
      slice.length === 1 && first.kind === 'ident'
        ? first.text
        : slice.length === 3 && first.text === 'this' && slice[2]?.kind === 'ident'
          ? slice[2].text
          : undefined;
    if (simple) {
      const local = first.text === 'this' ? undefined : locals.get(simple);
      if (local?.init && depth < 4) {
        const nested = evaluateUrl(ctx, input, locals, local.init.start, local.init.end, depth + 1);
        properties.push(...nested.properties);
        if (nested.url !== undefined && nested.pieces.every((p) => p.kind !== 'dynamic'))
          pieces.push({ kind: 'resolved', text: nested.url });
        else
          pieces.push(
            ...nested.pieces.map((p) => (p.kind === 'literal' ? { ...p, kind: 'resolved' as const } : p)),
          );
        continue;
      }
      const field = local ? undefined : input.fields.get(simple);
      if (field?.property) {
        const resolved = resolvePlaceholders(field.property, ctx.properties);
        properties.push(...placeholderKeys(field.property));
        pieces.push(
          resolved.resolved ? { kind: 'resolved', text: resolved.value } : { kind: 'dynamic', text: simple },
        );
        continue;
      }
      const constant = local ? undefined : ctx.constants.get(simple);
      if (constant !== undefined) {
        pieces.push({ kind: 'resolved', text: constant });
        continue;
      }
      pieces.push({ kind: 'dynamic', text: simple });
      continue;
    }
    const dotted = slice.map((t) => t.text).join('');
    const constant = ctx.constants.get(dotted);
    if (constant !== undefined) {
      pieces.push({ kind: 'resolved', text: constant });
      continue;
    }
    // UriComponentsBuilder.fromHttpUrl(base).path("/x")… : base puis segments littéraux.
    const builder = slice.findIndex((t) => ['fromHttpUrl', 'fromUriString', 'fromUri'].includes(t.text));
    if (builder >= 0 && slice[builder + 1]?.text === '(') {
      const open = part.start + builder + 1;
      const close = matchClose(tokens, open, part.end);
      const base = evaluateUrl(ctx, input, locals, open + 1, close, depth + 1);
      properties.push(...base.properties);
      pieces.push(
        ...base.pieces.map((p) => (p.kind === 'literal' ? { ...p, kind: 'resolved' as const } : p)),
      );
      for (let k = close; k < part.end; k++) {
        if (
          (tokens[k]?.text === 'path' || tokens[k]?.text === 'pathSegment') &&
          tokens[k + 1]?.text === '('
        ) {
          const lit = tokens[k + 2];
          if (lit?.kind === 'string') pieces.push({ kind: 'resolved', text: lit.value ?? '' });
        }
      }
      continue;
    }
    const lastIdent = [...slice]
      .reverse()
      .find((t) => t.kind === 'ident' && !['valueOf', 'toString'].includes(t.text));
    pieces.push({ kind: 'dynamic', text: lastIdent?.text ?? '' });
  }
  return { ...assembleUrl(pieces), properties: [...new Set(properties)], pieces };
}

function placeholderKeys(text: string): string[] {
  return [...text.matchAll(/\$\{([^}:]+)/g)].map((m) => m[1] ?? '').filter(Boolean);
}

function assembleUrl(input: UrlPiece[]): Omit<UrlEvaluation, 'properties'> {
  const pieces = [...input];
  if (pieces.length === 0) return { status: 'UNKNOWN' };
  let status: RelationStatus = 'STATICALLY_RESOLVED';
  const head = pieces[0];
  if (head?.kind === 'dynamic') {
    // Une base inconnue suivie d'un chemin absolu : le chemin reste lisible (reconstruit).
    const next = pieces[1];
    if (next && next.kind !== 'dynamic' && next.text.startsWith('/')) {
      pieces.shift();
      status = 'INFERRED';
    } else return { status: 'UNKNOWN' };
  }
  let url = '';
  for (const piece of pieces) {
    if (piece.kind === 'literal') url += piece.text;
    else if (piece.kind === 'resolved') {
      url += piece.text;
      status = 'INFERRED';
    } else {
      url += `{${piece.text || 'param'}}`;
      status = 'INFERRED';
    }
  }
  return { url, status };
}

function restTemplateCall(
  ctx: FileContext,
  input: MethodInput,
  methodId: string,
  locals: Map<string, LocalInfo>,
  segment: ChainSegment,
  facts: BodyFacts,
): void {
  if (!segment.call || !(segment.name in REST_TEMPLATE_METHODS)) return;
  const tokens = ctx.java.tokens;
  const args = splitTopLevel(tokens, segment.call.open + 1, segment.call.close);
  const urlArg = args[0];
  let method = REST_TEMPLATE_METHODS[segment.name];
  if (!method) {
    for (const arg of args) {
      for (let k = arg.start; k < arg.end; k++) {
        if (tokens[k]?.text === 'HttpMethod' && tokens[k + 1]?.text === '.') method = tokens[k + 2]?.text;
      }
    }
  }
  const evaluation = urlArg
    ? evaluateUrl(ctx, input, locals, urlArg.start, urlArg.end)
    : { status: 'UNKNOWN' as RelationStatus, properties: [], pieces: [] };
  pushOutgoing(
    ctx,
    methodId,
    method,
    evaluation,
    tokens[segment.nameIndex]?.line ?? 0,
    facts,
    'RestTemplate',
  );
}

function fluentCall(
  ctx: FileContext,
  input: MethodInput,
  methodId: string,
  locals: Map<string, LocalInfo>,
  field: FieldInfo,
  client: string,
  segments: ChainSegment[],
  facts: BodyFacts,
): void {
  const tokens = ctx.java.tokens;
  let method: string | undefined;
  let uri: (UrlEvaluation & { pieces: UrlPiece[] }) | undefined;
  for (const segment of segments) {
    if (!segment.call) continue;
    if (FLUENT_VERBS.has(segment.name) && segment.call.close === segment.call.open + 1)
      method = segment.name.toUpperCase();
    else if (segment.name === 'method') {
      for (let k = segment.call.open; k < segment.call.close; k++) {
        if (tokens[k]?.text === 'HttpMethod' && tokens[k + 1]?.text === '.') method = tokens[k + 2]?.text;
      }
    } else if (segment.name === 'uri' && !uri) {
      const arg = splitTopLevel(tokens, segment.call.open + 1, segment.call.close)[0];
      if (!arg) continue;
      const isLambda = tokens.slice(arg.start, arg.end).some((t) => t.text === '->');
      if (isLambda) {
        // uri(b -> b.path("/x/{id}").build(id)) : les segments littéraux de `path(…)`.
        const pieces: UrlPiece[] = [];
        for (let k = arg.start; k < arg.end; k++) {
          if (tokens[k]?.text === 'path' && tokens[k + 1]?.text === '(' && tokens[k + 2]?.kind === 'string')
            pieces.push({ kind: 'resolved', text: tokens[k + 2]?.value ?? '' });
        }
        uri =
          pieces.length > 0
            ? { ...assembleUrl(pieces), properties: [], pieces }
            : { status: 'UNKNOWN', properties: [], pieces };
      } else uri = evaluateUrl(ctx, input, locals, arg.start, arg.end);
    }
  }
  if (!method && !uri) return;
  let evaluation: UrlEvaluation = uri ?? { status: 'UNKNOWN', properties: [] };
  // Base du client (`baseUrl(...)`) : un chemin relatif s'y ajoute.
  if (uri?.url !== undefined && field.baseUrl && !/^[a-z]+:\/\//i.test(uri.url)) {
    const base = evaluateUrl(ctx, input, new Map(), field.baseUrl.start, field.baseUrl.end);
    const property = field.property ? resolvePlaceholders(field.property, ctx.properties) : undefined;
    const baseUrl = property?.resolved ? property.value : base.url;
    if (baseUrl !== undefined) {
      evaluation = {
        url: baseUrl.replace(/\/$/, '') + uri.url,
        status: 'INFERRED',
        properties: [
          ...uri.properties,
          ...base.properties,
          ...(field.property ? placeholderKeys(field.property) : []),
        ],
      };
    } else evaluation = { ...uri, status: uri.status === 'UNKNOWN' ? 'UNKNOWN' : 'INFERRED' };
  }
  const line = tokens[segments[0]?.nameIndex ?? 0]?.line ?? 0;
  pushOutgoing(ctx, methodId, method, evaluation, line, facts, client);
}

function pushOutgoing(
  ctx: FileContext,
  methodId: string,
  method: string | undefined,
  evaluation: UrlEvaluation,
  line: number,
  facts: BodyFacts,
  client: string,
): void {
  const call: OutgoingHttpCall = {
    applicationId: ctx.app,
    layer: ctx.layer,
    symbolId: methodId,
    status: evaluation.status,
    file: ctx.file,
    line,
  };
  if (method) call.method = method.toUpperCase();
  else if (call.status === 'STATICALLY_RESOLVED') call.status = 'INFERRED';
  if (evaluation.url !== undefined && evaluation.status !== 'UNKNOWN') call.path = urlPath(evaluation.url);
  ctx.out.outgoing.push(call);
  // Jamais d'identifiants d'URL (`user:secret@hôte`) dans le détail.
  const shown = (evaluation.url ?? '?').replace(/\/\/[^/@\s]*@/, '//');
  facts.http.push(`${call.method ?? '?'} ${shown}`);
  if (!facts.httpClient.includes(client)) facts.httpClient.push(client);
  for (const p of evaluation.properties) if (!facts.properties.includes(p)) facts.properties.push(p);
}
