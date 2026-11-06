import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { isOpenApi } from './detect.js';
import type { ReadFile } from './files.js';
import type { ApiDocument, ApiOperation, ApiParameter, ApiSchema, OpenApiFacts } from './facts.js';

/**
 * LES CONTRATS D'API (OpenAPI 3, Swagger 2), en JSON ou YAML : les opérations (méthode, chemin, bases
 * déclarées, operationId, étiquettes, paramètres, schémas de requête et de réponse, extensions) et les
 * schémas. Le document est lu comme une donnée, jamais exécuté. Ses références `$ref` sont suivies dans le
 * document et vers les autres fichiers DE LA MÊME SOURCE ; une référence distante, hors de la source ou vers
 * un fichier absent n'est pas suivie et reste notée avec sa cause.
 */
type Raw = Record<string, unknown>;
const isObject = (value: unknown): value is Raw =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
/** Combien de références imbriquées sont suivies au plus (cycles, chaînes très longues). */
const MAX_REF_DEPTH = 12;
const MAX_EXTENSIONS = 10;

/** La ligne (1…n) où le texte apparaît d'abord ; 1 si introuvable. */
const lineOf = (text: string, needle: string): number => {
  const at = text.indexOf(needle);
  return at < 0 ? 1 : text.slice(0, at).split('\n').length;
};

function parseDocument(file: ReadFile): Raw | undefined {
  try {
    const value: unknown = /\.json$/i.test(file.path) ? JSON.parse(file.text) : parseYaml(file.text);
    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Le chemin d'une URL de `servers` (`https://h/api/v1` → `/api/v1`, `{base}` → sa valeur par défaut). */
export function serverPath(url: string, variables?: unknown): string {
  let text = url.replace(/\{([^}]+)\}/g, (whole, name: string) => {
    const variable = isObject(variables) ? variables[name] : undefined;
    return isObject(variable) && typeof variable.default === 'string' ? variable.default : whole;
  });
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '').replace(/^\/\/[^/]*/, '');
  const cut = text.search(/[?#]/);
  if (cut >= 0) text = text.slice(0, cut);
  const segments = text.split('/').filter(Boolean);
  return segments.length ? `/${segments.join('/')}` : '';
}

interface Located {
  value: unknown;
  /** Le fichier où la valeur est écrite (les références relatives qu'elle contient partent de lui). */
  file: string;
  /** Le nom donné par la référence (dernier segment du pointeur, ou nom du fichier). */
  name?: string;
}

/**
 * Les documents de la source, lus à la demande, et la résolution des `$ref` : pointeur local (`#/…`),
 * fichier voisin (`./schemas.yaml#/…`). Rien n'est lu hors des fichiers de la source.
 */
class Resolver {
  private readonly parsed = new Map<string, Raw | null>();
  readonly unresolved = new Map<string, { ref: string; cause: string }[]>();
  readonly refs = new Map<string, Set<string>>();
  /** Les références non suivies pendant la lecture d'une opération (toutes, même déjà notées). */
  trace: string[] | undefined;
  constructor(private readonly files: ReadonlyMap<string, ReadFile>) {}

  doc(file: string): Raw | undefined {
    if (!this.parsed.has(file)) {
      const entry = this.files.get(file);
      this.parsed.set(file, entry ? (parseDocument(entry) ?? null) : null);
    }
    return this.parsed.get(file) ?? undefined;
  }

  private miss(root: string, ref: string, cause: string): void {
    this.trace?.push(ref);
    const list = this.unresolved.get(root) ?? [];
    if (!list.some((entry) => entry.ref === ref)) list.push({ ref, cause });
    this.unresolved.set(root, list);
  }

  /** La valeur d'un nœud, références suivies ; `root` est le document dont l'analyse a commencé. */
  deref(value: unknown, file: string, root: string, depth = 0): Located | undefined {
    if (!isObject(value) || typeof value.$ref !== 'string') return { value, file };
    const ref = value.$ref;
    if (depth >= MAX_REF_DEPTH) {
      this.miss(root, ref, 'chaîne de références trop longue ou cyclique');
      return;
    }
    const [target = '', pointer = ''] = ref.split('#');
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
      this.miss(root, ref, 'référence distante non suivie (aucun accès réseau)');
      return;
    }
    if (target.startsWith('/')) {
      this.miss(root, ref, 'chemin absolu non suivi');
      return;
    }
    let docFile = file;
    if (target) {
      docFile = path.posix.normalize(path.posix.join(path.posix.dirname(file), target));
      if (docFile.startsWith('..')) {
        this.miss(root, ref, 'fichier hors de la source analysée');
        return;
      }
      if (!this.files.has(docFile)) {
        this.miss(root, ref, `fichier absent de la source (${docFile})`);
        return;
      }
      if (docFile !== root) this.refs.set(root, (this.refs.get(root) ?? new Set()).add(docFile));
    }
    const doc = this.doc(docFile);
    if (!doc) {
      this.miss(root, ref, `document illisible (${docFile})`);
      return;
    }
    let cur: unknown = doc;
    const parts = pointer
      .split('/')
      .filter(Boolean)
      .map((part) => decodeURIComponent(part).replace(/~1/g, '/').replace(/~0/g, '~'));
    for (const part of parts) {
      cur = isObject(cur) ? cur[part] : Array.isArray(cur) ? (cur as unknown[])[Number(part)] : undefined;
      if (cur === undefined) {
        this.miss(root, ref, `pointeur introuvable dans ${docFile}`);
        return;
      }
    }
    const next = this.deref(cur, docFile, root, depth + 1);
    if (!next) return undefined;
    const name =
      parts.length > 0 ? parts[parts.length - 1] : path.posix.basename(docFile).replace(/\.[^.]+$/, '');
    return { ...next, name: next.name ?? name };
  }
}

export function analyzeOpenApi(files: readonly ReadFile[]): OpenApiFacts {
  const operations: ApiOperation[] = [];
  const schemas: ApiSchema[] = [];
  const documents: ApiDocument[] = [];
  const warnings: string[] = [];
  const byPath = new Map(files.filter((f) => /\.(json|ya?ml)$/i.test(f.path)).map((f) => [f.path, f]));
  const resolver = new Resolver(byPath);
  const schemaFiles = new Set<string>();

  for (const file of files.filter((entry) => /\.(json|ya?ml)$/i.test(entry.path) && isOpenApi(entry))) {
    const doc = resolver.doc(file.path);
    if (!doc) {
      warnings.push(`unreadable API contract: ${file.path}`);
      continue;
    }
    const root = file.path;
    const at = (value: unknown, from = root): Located | undefined => resolver.deref(value, from, root);
    /** Le nom du schéma d'un corps ou d'une réponse : référence suivie, tableau, contenu JSON. */
    const schemaName = (schema: unknown, from: string): string | undefined => {
      if (isObject(schema) && typeof schema.$ref === 'string') {
        const found = at(schema, from);
        if (found?.name && found.file !== root) schemaFiles.add(found.file);
        return found?.name;
      }
      if (isObject(schema) && schema.type === 'array') return schemaName(schema.items, from);
      return undefined;
    };
    const contentSchema = (body: unknown, from: string): string | undefined => {
      const found = at(body, from);
      if (!found || !isObject(found.value)) return undefined;
      const value = found.value;
      if (isObject(value.content))
        for (const media of Object.values(value.content)) {
          const name = isObject(media) ? schemaName(media.schema, found.file) : undefined;
          if (name) return name;
        }
      return schemaName(value.schema, found.file);
    };
    const paramsOf = (list: unknown, from: string): ApiParameter[] =>
      (Array.isArray(list) ? (list as unknown[]) : []).flatMap((entry) => {
        const found = at(entry, from);
        const p = found && isObject(found.value) ? found.value : undefined;
        if (!found || !p || typeof p.name !== 'string' || typeof p.in !== 'string') return [];
        const schema = isObject(p.schema) ? at(p.schema, found.file)?.value : undefined;
        const type =
          typeof p.type === 'string'
            ? p.type
            : isObject(schema) && typeof schema.type === 'string'
              ? schema.type
              : undefined;
        return [
          {
            name: p.name,
            in: p.in,
            required: p.required === true || p.in === 'path',
            ...(type ? { type } : {}),
          },
        ];
      });
    const serversOf = (list: unknown): string[] | undefined =>
      Array.isArray(list) && list.length > 0
        ? [
            ...new Set(
              (list as unknown[]).flatMap((entry) =>
                isObject(entry) && typeof entry.url === 'string'
                  ? [serverPath(entry.url, entry.variables)]
                  : [],
              ),
            ),
          ]
        : undefined;

    // Le document lui-même : format, version, titre, serveurs et documentation qu'il déclare.
    const info = isObject(doc.info) ? doc.info : {};
    const docs =
      isObject(doc.externalDocs) && typeof doc.externalDocs.url === 'string'
        ? doc.externalDocs.url
        : undefined;
    const servers = Array.isArray(doc.servers)
      ? doc.servers
          .map((entry) => (isObject(entry) && typeof entry.url === 'string' ? entry.url : ''))
          .filter(Boolean)
      : [];
    // Swagger 2 : basePath préfixe les chemins (le chemin comparé l'inclut, comme avant) ; OpenAPI 3 : servers.
    const base = typeof doc.basePath === 'string' ? doc.basePath.replace(/\/$/, '') : '';
    const docBases = base ? [base] : (serversOf(doc.servers) ?? []);
    if (isObject(doc.paths))
      for (const [route, rawItem] of Object.entries(doc.paths)) {
        const itemAt = at(rawItem);
        const item = itemAt && isObject(itemAt.value) ? itemAt.value : undefined;
        if (!item || !itemAt) continue;
        resolver.trace = [];
        const shared = paramsOf(item.parameters, itemAt.file);
        const sharedMisses = [...resolver.trace];
        const itemBases = base ? undefined : serversOf(item.servers);
        for (const verb of METHODS) {
          const op = item[verb];
          if (!isObject(op)) continue;
          resolver.trace = [];
          const routePath = route.startsWith('/') ? route : `/${route}`;
          const p = `${base}${route}` || '/';
          const responses = at(op.responses, itemAt.file);
          const okRaw =
            responses && isObject(responses.value)
              ? (responses.value['200'] ?? responses.value['201'] ?? responses.value.default)
              : undefined;
          const own = paramsOf(op.parameters, itemAt.file);
          // Un paramètre de l'opération remplace celui du chemin de même nom et même emplacement.
          const params = [
            ...shared.filter((s) => !own.some((o) => o.name === s.name && o.in === s.in)),
            ...own,
          ];
          const bodyParam = (Array.isArray(op.parameters) ? (op.parameters as unknown[]) : [])
            .map((entry) => at(entry, itemAt.file)?.value)
            .find((entry) => isObject(entry) && entry.in === 'body');
          const request = contentSchema(op.requestBody, itemAt.file) ?? contentSchema(bodyParam, itemAt.file);
          const response = contentSchema(okRaw, responses?.file ?? itemAt.file);
          const bases = base ? docBases : (serversOf(op.servers) ?? itemBases ?? docBases);
          const extensions = Object.fromEntries(
            Object.entries(op)
              .filter(
                ([key, value]) =>
                  key.startsWith('x-') && ['string', 'number', 'boolean'].includes(typeof value),
              )
              .slice(0, MAX_EXTENSIONS)
              .map(([key, value]) => [key, String(value)]),
          );
          operations.push({
            id: `${verb.toUpperCase()} ${p}`,
            method: verb.toUpperCase(),
            path: p,
            route: routePath,
            ...(bases.some(Boolean) ? { bases: bases.filter(Boolean) } : {}),
            ...(typeof op.operationId === 'string' ? { operationId: op.operationId } : {}),
            ...(typeof op.summary === 'string' ? { summary: op.summary } : {}),
            tags: Array.isArray(op.tags)
              ? op.tags.filter((tag): tag is string => typeof tag === 'string')
              : [],
            ...(request ? { request } : {}),
            ...(response ? { response } : {}),
            ...(params.length ? { params } : {}),
            ...(Object.keys(extensions).length ? { extensions } : {}),
            ...((): { unresolved?: string[] } => {
              const misses = [...new Set([...sharedMisses, ...resolver.trace])];
              resolver.trace = undefined;
              return misses.length ? { unresolved: misses } : {};
            })(),
            document: root,
            loc: { file: itemAt.file, line: lineOf(byPath.get(itemAt.file)?.text ?? file.text, route) },
          });
        }
      }
    collectSchemas(doc, file.path, file.text, schemas);
    const unresolved = resolver.unresolved.get(root);
    const refs = resolver.refs.get(root);
    documents.push({
      file: file.path,
      format:
        typeof doc.openapi === 'string'
          ? `OpenAPI ${doc.openapi}`
          : typeof doc.swagger === 'string'
            ? `Swagger ${doc.swagger}`
            : 'OpenAPI',
      ...(typeof info.title === 'string' ? { title: info.title } : {}),
      ...(typeof info.version === 'string' || typeof info.version === 'number'
        ? { version: String(info.version) }
        : {}),
      ...(docs && /^https?:\/\//i.test(docs) ? { documentation: docs } : {}),
      servers,
      ...(refs?.size ? { refs: [...refs].sort() } : {}),
      ...(unresolved?.length ? { unresolved } : {}),
    });
    for (const miss of unresolved ?? [])
      warnings.push(`unresolved $ref in ${file.path}: ${miss.ref} (${miss.cause})`);
  }
  // Les schémas des fichiers voisins atteints par une référence (un fichier de schémas partagés).
  for (const file of schemaFiles) {
    const doc = resolver.doc(file);
    if (doc) collectSchemas(doc, file, byPath.get(file)?.text ?? '', schemas);
  }
  return { operations, schemas, documents, warnings };
}

/** Le nom du schéma d'une propriété : référence (locale ou vers un fichier voisin) ou tableau de références. */
const refName = (schema: unknown): string | undefined => {
  if (!isObject(schema)) return undefined;
  if (typeof schema.$ref === 'string')
    return /([^/#]+)$/.exec(schema.$ref)?.[1]?.replace(/\.(ya?ml|json)$/i, '');
  if (schema.type === 'array') return refName(schema.items);
  return undefined;
};

function collectSchemas(doc: Raw, file: string, text: string, out: ApiSchema[]): void {
  const definitions =
    isObject(doc.components) && isObject(doc.components.schemas) ? doc.components.schemas : doc.definitions;
  if (!isObject(definitions)) return;
  for (const [name, schema] of Object.entries(definitions)) {
    if (!isObject(schema) || !isObject(schema.properties)) continue;
    if (out.some((entry) => entry.name === name && entry.loc.file === file)) continue;
    const required = new Set(
      Array.isArray(schema.required)
        ? schema.required.filter((key): key is string => typeof key === 'string')
        : [],
    );
    out.push({
      name,
      properties: Object.entries(schema.properties).map(([property, raw]) => {
        const value = isObject(raw) ? raw : {};
        const ref = refName(value);
        return {
          name: property,
          type: typeof value.type === 'string' ? value.type : (ref ?? 'object'),
          ...(typeof value.format === 'string' ? { format: value.format } : {}),
          required: required.has(property),
          ...(typeof value.maxLength === 'number' ? { maxLength: value.maxLength } : {}),
          ...(typeof value.pattern === 'string' ? { pattern: value.pattern } : {}),
        };
      }),
      loc: { file, line: lineOf(text, `${name}:`) },
    });
  }
}
