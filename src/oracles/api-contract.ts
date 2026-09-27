import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

/** One operation of an API contract: what the server may answer. */
export interface ContractOperation {
  method: string;
  /** Path template as written (/users/{id}). */
  path: string;
  /** Matches concrete paths (with or without the servers' base path). */
  matcher: RegExp;
  /** Declared statuses: "201", "4XX", "default"… */
  responses: string[];
  /** Properties of the JSON request body, when described. */
  requestFields: Record<string, ContractFieldSchema>;
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
}

export interface ApiContract {
  source: string;
  operations: ContractOperation[];
}

/** Where the API contract comes from (OpenAPI file, internal URL…). */
export interface ApiContractProvider {
  load(): Promise<ApiContract>;
}

/**
 * OpenAPI 3 (YAML or JSON), from a local file or an allowed URL. A URL is
 * fetched only when its host is allowed by the mission (never an external
 * site); no credential is sent.
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
  responses?: Record<string, unknown>;
  requestBody?: { content?: Record<string, { schema?: Schema } | undefined> };
}
interface Schema {
  $ref?: string;
  type?: string;
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
      const requestFields: Record<string, ContractFieldSchema> = {};
      for (const [name, raw] of Object.entries(body?.properties ?? {})) {
        const schema = resolve(raw);
        if (!schema) continue;
        requestFields[name] = {
          ...(schema.type ? { type: schema.type } : {}),
          ...(schema.format ? { format: schema.format } : {}),
          ...(schema.minLength !== undefined ? { minLength: schema.minLength } : {}),
          ...(schema.maxLength !== undefined ? { maxLength: schema.maxLength } : {}),
          ...(schema.minimum !== undefined ? { minimum: schema.minimum } : {}),
          ...(schema.maximum !== undefined ? { maximum: schema.maximum } : {}),
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
      });
    }
  }
  return { source, operations };
}

/** Is this status declared ("201", "2XX", "default")? */
export function declares(responses: readonly string[], status: number): boolean {
  const code = String(status);
  return responses.some(
    (declared) =>
      declared === 'default' || declared === code || (/^\dXX$/i.test(declared) && declared[0] === code[0]),
  );
}
