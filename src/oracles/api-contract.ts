import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

/** Une opération d'un contrat d'API : ce que le serveur peut répondre. */
export interface ContractOperation {
  method: string;
  /** Modèle de chemin tel qu'écrit (/users/{id}). */
  path: string;
  /** Correspond aux chemins concrets (avec ou sans le chemin de base des serveurs). */
  matcher: RegExp;
  /** Statuts déclarés : "201", "4XX", "default"… */
  responses: string[];
  /** Propriétés du corps JSON de la requête, quand elles sont décrites. */
  requestFields: Record<string, ContractFieldSchema>;
  /** Schéma JSON des réponses décrites, par statut ("200") : propriétés et obligatoires. */
  responseSchemas?: Record<string, { fields: Record<string, ContractFieldSchema>; required: string[] }>;
}

export interface ContractFieldSchema {
  type?: string;
  format?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  enum?: string[];
  required?: boolean;
  /** Borne exclue : la valeur doit être strictement supérieure (OpenAPI 3.1, ou 3.0 avec exclusiveMinimum: true). */
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  /** null est accepté (OpenAPI 3.0 nullable: true, ou 3.1 type: [..., "null"]). */
  nullable?: boolean;
}

export interface ApiContract {
  source: string;
  operations: ContractOperation[];
}

/** D'où vient le contrat d'API (fichier OpenAPI, URL interne…). */
export interface ApiContractProvider {
  load(): Promise<ApiContract>;
}

/**
 * OpenAPI 3 (YAML ou JSON), depuis un fichier local ou une URL autorisée. Une URL
 * n'est lue que si son hôte est autorisé par la mission (jamais un site externe) ;
 * aucun identifiant n'est envoyé.
 */
export class OpenApiContractProvider implements ApiContractProvider {
  constructor(
    private readonly source: string,
    private readonly isAllowedUrl: (url: string) => boolean,
    private readonly baseDir = process.cwd(),
  ) {}

  async load(): Promise<ApiContract> {
    let text: string;
    if (/^https?:\/\//i.test(this.source)) {
      if (!this.isAllowedUrl(this.source))
        throw new Error(`OpenAPI URL ${this.source} is not on an allowed host`);
      const response = await fetch(this.source, { signal: AbortSignal.timeout(10_000), redirect: 'error' });
      if (!response.ok) throw new Error(`OpenAPI URL answered HTTP ${response.status}`);
      text = await response.text();
    } else {
      text = await readFile(path.resolve(this.baseDir, this.source), 'utf8');
    }
    return parseOpenApi(text, this.source);
  }
}

interface OpenApiDocument {
  servers?: { url?: string }[];
  paths?: Record<string, Record<string, OpenApiOperation | undefined> | undefined>;
  components?: { schemas?: Record<string, Schema | undefined> };
}
interface OpenApiOperation {
  responses?: Record<string, { content?: Record<string, { schema?: Schema } | undefined> } | undefined>;
  requestBody?: { content?: Record<string, { schema?: Schema } | undefined> };
}
interface Schema {
  $ref?: string;
  type?: string | string[];
  nullable?: boolean;
  exclusiveMinimum?: number | boolean;
  exclusiveMaximum?: number | boolean;
  format?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, Schema | undefined>;
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

export function parseOpenApi(text: string, source = 'openapi'): ApiContract {
  const document = parseYaml(text) as OpenApiDocument | null;
  if (!document || typeof document !== 'object' || !document.paths)
    throw new Error(`${source} is not an OpenAPI document`);
  const schemas = document.components?.schemas ?? {};
  const resolve = (schema: Schema | undefined): Schema | undefined => {
    const name = schema?.$ref?.split('/').pop();
    return name ? schemas[name] : schema;
  };
  const prefixes = (document.servers ?? [])
    .map((server) => {
      try {
        return new URL(server.url ?? '', 'http://x').pathname.replace(/\/$/, '');
      } catch {
        return '';
      }
    })
    .filter(Boolean);
  const operations: ContractOperation[] = [];
  for (const [template, item] of Object.entries(document.paths)) {
    if (!item) continue;
    for (const method of METHODS) {
      const operation = item[method];
      if (!operation) continue;
      const pattern = template
        .split('/')
        .map((segment) =>
          /^\{.+\}$/.test(segment) ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        )
        .join('/');
      const bases = ['', ...prefixes.map((prefix) => prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))];
      const body = resolve(operation.requestBody?.content?.['application/json']?.schema);
      const fieldsOf = (object: Schema | undefined): Record<string, ContractFieldSchema> => {
        const fields: Record<string, ContractFieldSchema> = {};
        for (const [name, raw] of Object.entries(object?.properties ?? {})) {
          const schema = resolve(raw);
          if (schema)
            fields[name] = {
              ...fieldType(schema),
              ...(object?.required?.includes(name) ? { required: true } : {}),
            };
        }
        return fields;
      };
      const responseSchemas: NonNullable<ContractOperation['responseSchemas']> = {};
      for (const [status, response] of Object.entries(operation.responses ?? {})) {
        const schema = resolve(response?.content?.['application/json']?.schema);
        if (schema?.properties)
          responseSchemas[status] = { fields: fieldsOf(schema), required: schema.required ?? [] };
      }
      const requestFields: Record<string, ContractFieldSchema> = {};
      for (const [name, raw] of Object.entries(body?.properties ?? {})) {
        const schema = resolve(raw);
        if (!schema) continue;
        requestFields[name] = {
          ...fieldType(schema),
          ...(schema.format ? { format: schema.format } : {}),
          ...(schema.minLength !== undefined ? { minLength: schema.minLength } : {}),
          ...(schema.maxLength !== undefined ? { maxLength: schema.maxLength } : {}),
          ...bounds(schema),
          ...(schema.pattern ? { pattern: schema.pattern } : {}),
          ...(schema.enum ? { enum: schema.enum.map(String) } : {}),
          ...(body?.required?.includes(name) ? { required: true } : {}),
        };
      }
      operations.push({
        method: method.toUpperCase(),
        path: template,
        matcher: new RegExp(`^(?:${bases.join('|')})${pattern}/?$`),
        responses: Object.keys(operation.responses ?? {}),
        requestFields,
        ...(Object.keys(responseSchemas).length > 0 ? { responseSchemas } : {}),
      });
    }
  }
  return { source, operations };
}

/** Ce statut est-il déclaré ("201", "2XX", "default") ? */
export function declares(responses: readonly string[], status: number): boolean {
  const code = String(status);
  return responses.some(
    (declared) =>
      declared === 'default' || declared === code || (/^\dXX$/i.test(declared) && declared[0] === code[0]),
  );
}

/** type (3.1 : ["string", "null"]) et nullable. */
function fieldType(schema: Schema): Pick<ContractFieldSchema, 'type' | 'nullable'> {
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const type = types.find((candidate) => candidate !== 'null');
  const nullable = schema.nullable === true || types.includes('null');
  return { ...(type ? { type } : {}), ...(nullable ? { nullable: true } : {}) };
}

/**
 * minimum / maximum, et leurs versions exclues : en 3.1 exclusiveMinimum est la borne
 * elle-même ; en 3.0 c'est un booléen qui rend `minimum` exclusif.
 */
function bounds(
  schema: Schema,
): Pick<ContractFieldSchema, 'minimum' | 'maximum' | 'exclusiveMinimum' | 'exclusiveMaximum'> {
  const result: Pick<ContractFieldSchema, 'minimum' | 'maximum' | 'exclusiveMinimum' | 'exclusiveMaximum'> =
    {};
  if (typeof schema.exclusiveMinimum === 'number') result.exclusiveMinimum = schema.exclusiveMinimum;
  else if (schema.exclusiveMinimum === true && schema.minimum !== undefined)
    result.exclusiveMinimum = schema.minimum;
  else if (schema.minimum !== undefined) result.minimum = schema.minimum;
  if (typeof schema.exclusiveMaximum === 'number') result.exclusiveMaximum = schema.exclusiveMaximum;
  else if (schema.exclusiveMaximum === true && schema.maximum !== undefined)
    result.exclusiveMaximum = schema.maximum;
  else if (schema.maximum !== undefined) result.maximum = schema.maximum;
  return result;
}
