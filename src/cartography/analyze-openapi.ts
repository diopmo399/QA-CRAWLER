import { parse as parseYaml } from 'yaml';
import { isOpenApi } from './detect.js';
import type { ReadFile } from './files.js';
import type { ApiDocument, ApiOperation, ApiSchema, OpenApiFacts } from './facts.js';

/**
 * LES CONTRATS D'API (OpenAPI 3, Swagger 2), en JSON ou YAML : les opérations (méthode, chemin,
 * operationId, résumé, étiquettes, schémas de requête et de réponse) et les schémas (propriétés, types,
 * obligatoires, longueur, motif). Le document est lu comme une donnée, jamais exécuté ; ses références
 * externes ne sont pas suivies (seules `#/components/schemas/…` et `#/definitions/…` sont résolues).
 */
type Raw = Record<string, unknown>;
const isObject = (value: unknown): value is Raw =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

/** Le nom du schéma d'une référence locale (`#/components/schemas/Request` → `Request`). */
const refName = (schema: unknown): string | undefined => {
  if (!isObject(schema)) return undefined;
  if (typeof schema.$ref === 'string')
    return /#\/(?:components\/schemas|definitions)\/(.+)$/.exec(schema.$ref)?.[1];
  if (schema.type === 'array') return refName(schema.items);
  return undefined;
};

/** La ligne (1…n) où le texte apparaît d'abord ; 1 si introuvable. */
const lineOf = (text: string, needle: string): number => {
  const at = text.indexOf(needle);
  return at < 0 ? 1 : text.slice(0, at).split('\n').length;
};

const contentSchema = (body: unknown): string | undefined => {
  if (!isObject(body)) return undefined;
  if (isObject(body.content))
    for (const media of Object.values(body.content)) {
      const name = isObject(media) ? refName(media.schema) : undefined;
      if (name) return name;
    }
  return refName(body.schema);
};

function readDocument(file: ReadFile): Raw | undefined {
  try {
    const value: unknown = /\.json$/i.test(file.path) ? JSON.parse(file.text) : parseYaml(file.text);
    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function analyzeOpenApi(files: readonly ReadFile[]): OpenApiFacts {
  const operations: ApiOperation[] = [];
  const schemas: ApiSchema[] = [];
  const documents: ApiDocument[] = [];
  const warnings: string[] = [];
  for (const file of files.filter((entry) => /\.(json|ya?ml)$/i.test(entry.path) && isOpenApi(entry))) {
    const doc = readDocument(file);
    if (!doc) {
      warnings.push(`unreadable API contract: ${file.path}`);
      continue;
    }
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
    });
    // Swagger 2 : basePath préfixe les chemins.
    const base = typeof doc.basePath === 'string' ? doc.basePath.replace(/\/$/, '') : '';
    if (isObject(doc.paths))
      for (const [route, item] of Object.entries(doc.paths)) {
        if (!isObject(item)) continue;
        for (const verb of METHODS) {
          const op = item[verb];
          if (!isObject(op)) continue;
          const path = `${base}${route}` || '/';
          const ok = isObject(op.responses)
            ? (op.responses['200'] ?? op.responses['201'] ?? op.responses.default)
            : undefined;
          const parameters: unknown[] = Array.isArray(op.parameters) ? (op.parameters as unknown[]) : [];
          const bodyParam = parameters.find((param) => isObject(param) && param.in === 'body');
          const request = contentSchema(op.requestBody) ?? contentSchema(bodyParam);
          const response = contentSchema(ok);
          operations.push({
            id: `${verb.toUpperCase()} ${path}`,
            method: verb.toUpperCase(),
            path,
            ...(typeof op.operationId === 'string' ? { operationId: op.operationId } : {}),
            ...(typeof op.summary === 'string' ? { summary: op.summary } : {}),
            tags: Array.isArray(op.tags)
              ? op.tags.filter((tag): tag is string => typeof tag === 'string')
              : [],
            ...(request ? { request } : {}),
            ...(response ? { response } : {}),
            loc: { file: file.path, line: lineOf(file.text, route) },
          });
        }
      }
    const definitions =
      isObject(doc.components) && isObject(doc.components.schemas) ? doc.components.schemas : doc.definitions;
    if (isObject(definitions))
      for (const [name, schema] of Object.entries(definitions)) {
        if (!isObject(schema) || !isObject(schema.properties)) continue;
        const required = new Set(
          Array.isArray(schema.required)
            ? schema.required.filter((key): key is string => typeof key === 'string')
            : [],
        );
        schemas.push({
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
          loc: { file: file.path, line: lineOf(file.text, `${name}:`) },
        });
      }
  }
  return { operations, schemas, documents, warnings };
}
