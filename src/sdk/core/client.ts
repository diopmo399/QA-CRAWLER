import type {
  Capabilities,
  ErrorBody,
  ExplorationEvent,
  ExplorationSnapshot,
  ExplorationSummary,
  ExtensionName,
  Project,
  ProjectDraft,
  ReportLink,
  UrlCheck,
  ValidationReport,
  DraftIssue,
} from './contracts.js';
import { EXTENSION_NAMES } from './contracts.js';

/**
 * LE CLIENT DU SDK : les appels à l'API du serveur QA-CRAWLER, depuis le navigateur (ou Node 20+).
 * Aucune dépendance : `fetch` et un lecteur de flux pour les événements (le flux d'événements passe
 * par fetch et non EventSource, qui ne peut pas envoyer l'en-tête d'autorisation).
 */
export interface ClientOptions {
  /** L'adresse de l'API, par exemple https://qa.example/qa-crawler/api */
  endpoint: string;
  /** Le jeton d'accès du serveur, transmis par le back-end de l'hôte. */
  token?: string;
  /** Remplace le fetch global (tests, intercepteurs de l'hôte). */
  fetch?: typeof fetch;
}

export class QaCrawlerError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: string[];
  readonly issues: DraftIssue[];

  constructor(body: ErrorBody) {
    super(body.error);
    this.name = 'QaCrawlerError';
    this.status = body.status;
    this.code = body.code;
    this.details = body.details ?? [];
    this.issues = body.issues ?? [];
  }
}

export interface Subscription {
  /** Arrête l'écoute (l'exploration, elle, continue sur le serveur). */
  close(): void;
  /** Résolue quand le flux se termine (exploration terminée, échouée ou écoute fermée). */
  done: Promise<void>;
}

export interface SubscribeOptions {
  /** Reprendre après cet événement (numéro `seq`) : les événements déjà reçus ne sont pas renvoyés. */
  after?: number;
  onError?: (error: Error) => void;
}

/** Un espace de noms prévu dans le SDK, pas encore exposé : il le dit au lieu de simuler. */
export interface ReservedNamespace {
  readonly available: false;
}

export interface QaCrawlerClient {
  capabilities(): Promise<Capabilities>;
  checks: {
    url(url: string): Promise<UrlCheck>;
    env(names: string[]): Promise<Record<string, boolean>>;
  };
  projects: {
    validate(draft: ProjectDraft): Promise<ValidationReport>;
    create(draft: ProjectDraft): Promise<Project>;
    get(id: string): Promise<Project>;
  };
  explorations: {
    start(projectId: string): Promise<ExplorationSnapshot>;
    status(id: string): Promise<ExplorationSnapshot>;
    result(id: string): Promise<ExplorationSummary>;
    subscribe(
      id: string,
      onEvent: (event: ExplorationEvent) => void,
      options?: SubscribeOptions,
    ): Subscription;
    reportLink(id: string): Promise<ReportLink>;
  };
  extensions: Record<ExtensionName, ReservedNamespace>;
  dispose(): void;
}

export function createQaCrawler(options: ClientOptions): QaCrawlerClient {
  const endpoint = options.endpoint.replace(/\/+$/, '');
  const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const controllers = new Set<AbortController>();
  let disposed = false;

  const headers = (json: boolean): Record<string, string> => ({
    accept: 'application/json',
    'x-qa-crawler-sdk': '1',
    ...(json ? { 'content-type': 'application/json' } : {}),
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
  });

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (disposed) throw new QaCrawlerError({ error: 'client disposed', status: 0, code: 'DISPOSED' });
    let response: Response;
    try {
      response = await doFetch(`${endpoint}${path}`, {
        method,
        headers: headers(body !== undefined),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      throw new QaCrawlerError({
        error: `QA-CRAWLER server unreachable: ${error instanceof Error ? error.message : String(error)}`,
        status: 0,
        code: 'UNREACHABLE',
      });
    }
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    if (!response.ok) {
      const errorBody = (parsed ?? {}) as Partial<ErrorBody>;
      throw new QaCrawlerError({
        error: errorBody.error ?? `HTTP ${String(response.status)}`,
        status: response.status,
        code: errorBody.code ?? 'HTTP_ERROR',
        ...(errorBody.details ? { details: errorBody.details } : {}),
        ...(errorBody.issues ? { issues: errorBody.issues } : {}),
      });
    }
    return parsed as T;
  }

  function subscribe(
    id: string,
    onEvent: (event: ExplorationEvent) => void,
    subscribeOptions: SubscribeOptions = {},
  ): Subscription {
    const controller = new AbortController();
    controllers.add(controller);
    const query = subscribeOptions.after !== undefined ? `?after=${String(subscribeOptions.after)}` : '';
    const done = (async () => {
      try {
        const response = await doFetch(`${endpoint}/explorations/${encodeURIComponent(id)}/events${query}`, {
          headers: { ...headers(false), accept: 'text/event-stream' },
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          const text = await response.text().catch(() => '');
          let message = `HTTP ${String(response.status)}`;
          try {
            message = (JSON.parse(text) as Partial<ErrorBody>).error ?? message;
          } catch {
            // corps non JSON : le statut suffit
          }
          throw new QaCrawlerError({ error: message, status: response.status, code: 'STREAM_REFUSED' });
        }
        for await (const event of readEventStream(response.body)) onEvent(event);
      } catch (error) {
        if (controller.signal.aborted) return;
        subscribeOptions.onError?.(error instanceof Error ? error : new Error(String(error)));
      } finally {
        controllers.delete(controller);
      }
    })();
    return {
      close: () => {
        controller.abort();
      },
      done,
    };
  }

  const reserved = Object.fromEntries(
    EXTENSION_NAMES.map((name) => [name, Object.freeze({ available: false as const })]),
  ) as Record<ExtensionName, ReservedNamespace>;

  return {
    capabilities: () => request('GET', '/capabilities'),
    checks: {
      url: (url) => request('POST', '/checks/url', { url }),
      env: (names) => request('POST', '/checks/env', { names }),
    },
    projects: {
      validate: (draft) => request('POST', '/projects/validate', { draft }),
      create: (draft) => request('POST', '/projects', { draft }),
      get: (id) => request('GET', `/projects/${encodeURIComponent(id)}`),
    },
    explorations: {
      start: (projectId) => request('POST', `/projects/${encodeURIComponent(projectId)}/explorations`, {}),
      status: (id) => request('GET', `/explorations/${encodeURIComponent(id)}`),
      result: (id) => request('GET', `/explorations/${encodeURIComponent(id)}/result`),
      subscribe,
      reportLink: (id) => request('POST', `/explorations/${encodeURIComponent(id)}/report-links`, {}),
    },
    extensions: reserved,
    dispose() {
      disposed = true;
      for (const controller of controllers) controller.abort();
      controllers.clear();
    },
  };
}

/** Lit un flux `text/event-stream` : un événement par bloc `data:` (JSON), les commentaires ignorés. */
export async function* readEventStream(body: ReadableStream<Uint8Array>): AsyncGenerator<ExplorationEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseBlock(block);
        if (event) yield event;
        boundary = buffer.indexOf('\n\n');
      }
    }
    const last = parseBlock(buffer);
    if (last) yield last;
  } finally {
    reader.releaseLock();
  }
}

function parseBlock(block: string): ExplorationEvent | undefined {
  const data = block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''))
    .join('\n');
  if (!data) return undefined;
  try {
    return JSON.parse(data) as ExplorationEvent;
  } catch {
    return undefined;
  }
}
