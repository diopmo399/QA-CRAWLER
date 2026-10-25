import type {
  AssertionProposalView,
  Capabilities,
  ErrorBody,
  ExplorationEvent,
  ExplorationSnapshot,
  ExplorationSummary,
  FlowView,
  GenerationInput,
  GenerationResult,
  GraphView,
  GroupCommandInput,
  GroupEditResult,
  GroupViewDto,
  Project,
  ProjectDraft,
  ProposalDecisionInput,
  RecordingSnapshot,
  RecordingStreamEvent,
  ReportEntry,
  ReportEntryKind,
  ReportLink,
  UrlCheck,
  ValidationReport,
  DraftIssue,
} from './contracts.js';

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

export interface RecordingStartInput {
  /** Le nom du parcours (le dossier `recordings/<nom>/`). */
  name: string;
  /** Le chemin de départ dans l'application (défaut : le départ du projet). */
  startPath?: string;
  /** Rejouer le flow généré tout de suite (REPLAY_CONFIRMED / REPLAY_FAILED). */
  validate?: boolean;
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
  /** Un humain joue le parcours dans le Chromium ouvert par le serveur ; le moteur en fait un flow. */
  recordings: {
    start(projectId: string, input: RecordingStartInput): Promise<RecordingSnapshot>;
    list(projectId: string): Promise<RecordingSnapshot[]>;
    get(projectId: string, name: string): Promise<RecordingSnapshot>;
    /** Arrête la session en cours (comme le bouton de la barre d'enregistrement). */
    stop(projectId: string, name: string): Promise<RecordingSnapshot>;
    subscribe(
      projectId: string,
      name: string,
      onEvent: (event: RecordingStreamEvent) => void,
      options?: SubscribeOptions,
    ): Subscription;
    flow(projectId: string, name: string): Promise<FlowView>;
  };
  /** Les propositions d'assertions d'un enregistrement et les décisions humaines. */
  assertions: {
    list(projectId: string, recording: string): Promise<AssertionProposalView[]>;
    decide(
      projectId: string,
      recording: string,
      proposalId: string,
      input: ProposalDecisionInput,
    ): Promise<AssertionProposalView[]>;
  };
  /** Les groupes métier d'étapes d'un enregistrement. */
  groups: {
    list(projectId: string, recording: string): Promise<GroupViewDto[]>;
    edit(
      projectId: string,
      recording: string,
      command: GroupCommandInput,
      options?: { force?: boolean },
    ): Promise<GroupEditResult>;
  };
  /** Les tests générés depuis un enregistrement (YAML, Gherkin, Playwright TypeScript, Java). */
  generation: {
    run(projectId: string, recording: string, input: GenerationInput): Promise<GenerationResult>;
  };
  /** Le graphe des écrans et transitions, d'une exploration ou d'un enregistrement. */
  graph: {
    exploration(id: string): Promise<GraphView>;
    of(projectId: string, kind: ReportEntryKind, name: string): Promise<GraphView>;
  };
  /** Les rapports d'un projet sur disque, explorations et enregistrements. */
  reports: {
    list(projectId: string): Promise<ReportEntry[]>;
    link(projectId: string, kind: ReportEntryKind, name: string): Promise<ReportLink>;
  };
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

  function stream(
    path: string,
    onEvent: (event: unknown) => void,
    subscribeOptions: SubscribeOptions = {},
  ): Subscription {
    const controller = new AbortController();
    controllers.add(controller);
    const query = subscribeOptions.after !== undefined ? `?after=${String(subscribeOptions.after)}` : '';
    const done = (async () => {
      try {
        const response = await doFetch(`${endpoint}${path}${query}`, {
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
        for await (const event of readEventStream<unknown>(response.body)) onEvent(event);
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

  const project = (id: string): string => `/projects/${encodeURIComponent(id)}`;
  const recording = (projectId: string, name: string): string =>
    `${project(projectId)}/recordings/${encodeURIComponent(name)}`;

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
      subscribe: (id, onEvent, subscribeOptions) =>
        stream(
          `/explorations/${encodeURIComponent(id)}/events`,
          (event) => {
            onEvent(event as ExplorationEvent);
          },
          subscribeOptions,
        ),
      reportLink: (id) => request('POST', `/explorations/${encodeURIComponent(id)}/report-links`, {}),
    },
    recordings: {
      start: (projectId, input) => request('POST', `${project(projectId)}/recordings`, input),
      list: (projectId) => request('GET', `${project(projectId)}/recordings`),
      get: (projectId, name) => request('GET', recording(projectId, name)),
      stop: (projectId, name) => request('POST', `${recording(projectId, name)}/stop`, {}),
      subscribe: (projectId, name, onEvent, subscribeOptions) =>
        stream(
          `${recording(projectId, name)}/events`,
          (event) => {
            onEvent(event as RecordingStreamEvent);
          },
          subscribeOptions,
        ),
      flow: (projectId, name) => request('GET', `${recording(projectId, name)}/flow`),
    },
    assertions: {
      list: (projectId, name) => request('GET', `${recording(projectId, name)}/assertions`),
      decide: (projectId, name, proposalId, input) =>
        request('POST', `${recording(projectId, name)}/assertions/${encodeURIComponent(proposalId)}`, input),
    },
    groups: {
      list: (projectId, name) => request('GET', `${recording(projectId, name)}/groups`),
      edit: (projectId, name, command, editOptions = {}) =>
        request('POST', `${recording(projectId, name)}/groups`, { command, ...editOptions }),
    },
    generation: {
      run: (projectId, name, input) => request('POST', `${recording(projectId, name)}/generation`, input),
    },
    graph: {
      exploration: (id) => request('GET', `/explorations/${encodeURIComponent(id)}/graph`),
      of: (projectId, kind, name) =>
        request('GET', `${project(projectId)}/reports/${kind}/${encodeURIComponent(name)}/graph`),
    },
    reports: {
      list: (projectId) => request('GET', `${project(projectId)}/reports`),
      link: (projectId, kind, name) =>
        request('POST', `${project(projectId)}/reports/${kind}/${encodeURIComponent(name)}/links`, {}),
    },
    dispose() {
      disposed = true;
      for (const controller of controllers) controller.abort();
      controllers.clear();
    },
  };
}

/** Lit un flux `text/event-stream` : un événement par bloc `data:` (JSON), les commentaires ignorés. */
export async function* readEventStream<T = ExplorationEvent>(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<T> {
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
        if (event !== undefined) yield event as T;
        boundary = buffer.indexOf('\n\n');
      }
    }
    const last = parseBlock(buffer);
    if (last !== undefined) yield last as T;
  } finally {
    reader.releaseLock();
  }
}

function parseBlock(block: string): unknown {
  const data = block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''))
    .join('\n');
  if (!data) return undefined;
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return undefined;
  }
}
