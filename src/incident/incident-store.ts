import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { writeFileAtomic } from '../memory/atomic-write.js';
import {
  EXECUTION_TARGETS,
  INCIDENT_SEVERITIES,
  INCIDENT_STATES,
  SCOPE_MODES,
  type Incident,
  type IncidentEvent,
  type IncidentInput,
  type IncidentState,
  type IncidentSummary,
  type InvestigationScope,
} from './model.js';
import { defaultScope, LIMIT_CAPS, MAX_DEPTH, MIN_DEPTH } from './scope.js';

/**
 * LE STOCKAGE DES INCIDENTS : un fichier JSON par incident (`<projet>/incidents/<id>.json`), écrit
 * atomiquement. Toute modification passe par une file d'attente par incident (jamais deux écritures
 * concurrentes du même fichier dans ce programme), incrémente la révision et laisse une trace dans
 * l'historique ; une modification sur une révision périmée est refusée (409).
 */

export class IncidentConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IncidentConflictError';
  }
}

export class IncidentNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IncidentNotFoundError';
  }
}

export class IncidentStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IncidentStateError';
  }
}

/** Saisie invalide (HTTP 400) : les champs en cause et pourquoi. */
export class IncidentValidationError extends Error {
  readonly issues: { field: string; message: string }[];

  constructor(issues: { field: string; message: string }[]) {
    super(`Incident invalide : ${issues.map((issue) => `${issue.field} : ${issue.message}`).join(' ; ')}`);
    this.name = 'IncidentValidationError';
    this.issues = issues;
  }
}

/** Les transitions permises (CANCELLED n'en sort que par resume). */
export const INCIDENT_TRANSITIONS: Readonly<Record<IncidentState, readonly IncidentState[]>> = {
  DRAFT: ['SCOPED', 'CANCELLED'],
  SCOPED: ['REPRODUCING', 'INVESTIGATING', 'CANCELLED', 'DRAFT'],
  REPRODUCING: ['REPRODUCED', 'NOT_REPRODUCED', 'FAILED', 'CANCELLED'],
  REPRODUCED: ['REPRODUCING', 'INVESTIGATING', 'CANCELLED'],
  NOT_REPRODUCED: ['REPRODUCING', 'INVESTIGATING', 'CANCELLED'],
  INVESTIGATING: ['DIAGNOSED', 'INCONCLUSIVE', 'REPRODUCING', 'FAILED', 'CANCELLED'],
  DIAGNOSED: ['INVESTIGATING', 'REPRODUCING', 'CANCELLED'],
  INCONCLUSIVE: ['INVESTIGATING', 'REPRODUCING', 'CANCELLED'],
  FAILED: ['SCOPED', 'REPRODUCING', 'CANCELLED'],
  CANCELLED: [],
};

export function canTransition(from: IncidentState, to: IncidentState): boolean {
  return INCIDENT_TRANSITIONS[from].includes(to);
}

// ── Validation de la saisie ──────────────────────────────────────────────────────────────────

const DNS_1123_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const text = (max: number) => z.string().trim().min(1).max(max);
const absolutePath = z
  .string()
  .max(4096)
  .refine((value) => path.isAbsolute(value), 'chemin absolu attendu');
const httpUrl = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }, 'URL http(s) attendue');
const namespace = z.string().regex(DNS_1123_LABEL, 'namespace DNS-1123 attendu');
const limit = (cap: number) => z.number().int().positive().max(cap);

const applicationSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][\w.-]{0,63}$/, 'identifiant invalide'),
  name: text(200),
  layer: z.enum(['FRONTEND', 'BFF', 'BACKEND']),
  repository: z.object({
    root: absolutePath,
    include: z.array(z.string().max(1024)).max(200).default([]),
    classes: z.array(z.string().max(300)).max(500).optional(),
  }),
  baseUrl: httpUrl.optional(),
  logFiles: z.array(z.string().max(4096)).max(50).optional(),
  openshift: z.object({ namespace, selector: text(300) }).optional(),
});

const scopeSchema = z.object({
  mode: z.enum(SCOPE_MODES).optional(),
  applications: z
    .array(applicationSchema)
    .max(50)
    .refine(
      (list) => new Set(list.map((application) => application.id)).size === list.length,
      'identifiants en double',
    )
    .optional(),
  scenarios: z.array(text(300)).max(100).optional(),
  steps: z.array(z.number().int().positive()).max(500).optional(),
  endpoints: z.array(text(500)).max(200).optional(),
  depth: z.number().int().min(MIN_DEPTH).max(MAX_DEPTH).optional(),
  allowedHosts: z.array(text(300)).max(100).optional(),
  logRoots: z.array(absolutePath).max(50).optional(),
  allowedCommands: z.array(text(100)).max(50).optional(),
  permissions: z
    .object({
      readSources: z.boolean(),
      navigate: z.boolean(),
      httpRequests: z.enum(['NONE', 'READ_ONLY', 'ALL']),
      runTests: z.enum(['NONE', 'UNIT', 'INTEGRATION']),
      localCommands: z.boolean(),
      readLogs: z.boolean(),
      openshift: z.enum(['NONE', 'READ']),
      sideEffects: z.boolean(),
    })
    .partial()
    .optional(),
  limits: z
    .object({
      maxFiles: limit(LIMIT_CAPS.maxFiles),
      maxFileBytes: limit(LIMIT_CAPS.maxFileBytes),
      maxDurationMs: limit(LIMIT_CAPS.maxDurationMs),
      maxRequests: limit(LIMIT_CAPS.maxRequests),
      maxExperiments: limit(LIMIT_CAPS.maxExperiments),
    })
    .partial()
    .optional(),
  // Les extensions ne se saisissent pas : elles se demandent puis se décident.
  extensions: z.unknown().optional(),
});

const executionSchema = z
  .object({
    target: z.enum(EXECUTION_TARGETS),
    remote: z
      .object({
        openshift: z
          .object({ apiServer: httpUrl.optional(), namespace, context: text(200).optional() })
          .optional(),
      })
      .optional(),
    aro: z
      .object({
        namespace,
        serviceAccount: z.string().regex(DNS_1123_LABEL, 'nom DNS-1123 attendu'),
        image: text(500),
        repositoriesMount: absolutePath,
        apiServer: httpUrl.optional(),
      })
      .optional(),
  })
  .refine((execution) => execution.target !== 'ARO' || execution.aro !== undefined, {
    message: 'la cible ARO exige sa configuration (aro)',
    path: ['aro'],
  });

const inputSchema = z.object({
  title: text(300),
  description: z.string().max(20_000),
  observed: text(5000),
  expected: z.string().max(5000),
  severity: z.enum(INCIDENT_SEVERITIES),
  scenario: text(300).optional(),
  environmentId: text(200).optional(),
  execution: executionSchema.optional(),
  scope: scopeSchema.optional(),
});
const patchSchema = inputSchema.partial();

type ParsedScope = z.infer<typeof scopeSchema>;

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new IncidentValidationError(
    result.error.issues.map((issue) => ({
      field: issue.path.join('.') || '(racine)',
      message: issue.message,
    })),
  );
}

/** Le périmètre saisi, sans extension (gérées à part), sans champ absent. */
function scopePatch(scope: ParsedScope | undefined): Partial<InvestigationScope> {
  if (!scope) return {};
  const { extensions: _ignored, ...rest } = scope;
  return Object.fromEntries(
    Object.entries(rest as Record<string, unknown>).filter(([, value]) => value !== undefined),
  );
}

function mergeScope(current: InvestigationScope, patch: Partial<InvestigationScope>): InvestigationScope {
  return {
    ...current,
    ...patch,
    permissions: { ...current.permissions, ...patch.permissions },
    limits: { ...current.limits, ...patch.limits },
    extensions: current.extensions,
  };
}

/** Prêt pour la reproduction : au moins une application et un scénario. */
function isScoped(incident: Pick<Incident, 'scope' | 'scenario'>): boolean {
  return (
    incident.scope.applications.length > 0 &&
    (incident.scenario !== undefined || incident.scope.scenarios.length > 0)
  );
}

/** Une valeur reçue de l'extérieur, affichable même si son type n'est pas celui attendu. */
const shown = (value: unknown): string => String(value);

const INCIDENT_ID = /^inc_[A-Za-z0-9_-]{12}$/;

function newIncidentId(): string {
  return `inc_${randomBytes(9).toString('base64url')}`;
}

/** Les files d'attente par fichier, partagées par toutes les instances du programme. */
const queues = new Map<string, Promise<unknown>>();

function exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const run = previous.then(work, work);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, settled);
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });
  return run;
}

function summaryOf(incident: Incident): IncidentSummary {
  return {
    id: incident.id,
    title: incident.title,
    severity: incident.severity,
    state: incident.state,
    ...(incident.scenario !== undefined ? { scenario: incident.scenario } : {}),
    target: incident.execution.target,
    updatedAt: incident.updatedAt,
    ...(incident.investigation.diagnosis ? { diagnosis: incident.investigation.diagnosis.status } : {}),
  };
}

function isIncident(value: unknown): value is Incident {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<Incident>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.revision === 'number' &&
    typeof candidate.state === 'string' &&
    (INCIDENT_STATES as readonly string[]).includes(candidate.state) &&
    Array.isArray(candidate.history)
  );
}

export class IncidentStore {
  private readonly directory: string;
  private readonly now: () => Date;

  constructor(projectDir: string, options: { now?: () => Date } = {}) {
    this.directory = path.join(projectDir, 'incidents');
    this.now = options.now ?? (() => new Date());
  }

  /** Les incidents, le plus récemment modifié d'abord ; un fichier illisible est ignoré. */
  async list(): Promise<IncidentSummary[]> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const incidents: Incident[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const incident = await this.get(name.slice(0, -'.json'.length));
      if (incident) incidents.push(incident);
    }
    return incidents
      .sort((a, b) =>
        a.updatedAt === b.updatedAt ? a.id.localeCompare(b.id) : a.updatedAt < b.updatedAt ? 1 : -1,
      )
      .map(summaryOf);
  }

  async get(id: string): Promise<Incident | undefined> {
    if (!INCIDENT_ID.test(id)) return undefined;
    let raw: string;
    try {
      raw = await readFile(this.fileOf(id), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    try {
      const value: unknown = JSON.parse(raw);
      return isIncident(value) && value.id === id ? value : undefined;
    } catch {
      return undefined;
    }
  }

  async create(projectId: string, input: IncidentInput, actor: string): Promise<Incident> {
    const parsed = parse(inputSchema, input);
    const at = this.now().toISOString();
    const scope = defaultScope(scopePatch(parsed.scope));
    if (parsed.scenario !== undefined && !scope.scenarios.includes(parsed.scenario)) {
      scope.scenarios.unshift(parsed.scenario);
    }
    await mkdir(this.directory, { recursive: true });
    let id = newIncidentId();
    while (await this.get(id)) id = newIncidentId();
    const incident: Incident = {
      id,
      projectId,
      title: parsed.title,
      description: parsed.description,
      observed: parsed.observed,
      expected: parsed.expected,
      severity: parsed.severity,
      ...(parsed.scenario !== undefined ? { scenario: parsed.scenario } : {}),
      ...(parsed.environmentId !== undefined ? { environmentId: parsed.environmentId } : {}),
      execution: parsed.execution ?? { target: 'LOCAL' },
      scope,
      state: 'DRAFT',
      revision: 1,
      createdAt: at,
      updatedAt: at,
      createdBy: actor,
      history: [],
      investigation: { reproductions: [], hypotheses: [], experiments: [] },
    };
    if (isScoped(incident)) incident.state = 'SCOPED';
    incident.history.push({ at, actor, kind: 'CREATED', message: `Incident créé (${incident.state}).` });
    await exclusive(this.fileOf(id), () => this.write(incident));
    return incident;
  }

  /** Modifie la saisie sur la révision lue ; DRAFT ↔ SCOPED suit la complétude du périmètre. */
  async update(
    id: string,
    revision: number,
    patch: Partial<IncidentInput>,
    actor: string,
  ): Promise<Incident> {
    const parsed = parse(patchSchema, patch);
    return exclusive(this.fileOf(id), async () => {
      const current = await this.load(id);
      if (current.revision !== revision) {
        throw new IncidentConflictError(
          `L'incident ${id} a changé (révision ${current.revision}, modification faite sur la révision ${revision}).`,
        );
      }
      if (current.state === 'CANCELLED') {
        throw new IncidentStateError(`L'incident ${id} est annulé : reprenez-le avant de le modifier.`);
      }
      const next = structuredClone(current);
      const at = this.now().toISOString();
      const changed: string[] = [];
      for (const key of [
        'title',
        'description',
        'observed',
        'expected',
        'severity',
        'scenario',
        'environmentId',
      ] as const) {
        const value = parsed[key];
        if (value !== undefined && value !== current[key]) {
          (next as unknown as Record<string, unknown>)[key] = value;
          changed.push(key);
        }
      }
      if (parsed.execution !== undefined) {
        next.execution = parsed.execution;
        if (JSON.stringify(next.execution) !== JSON.stringify(current.execution)) changed.push('execution');
      }
      let scopeChanged = false;
      if (parsed.scope !== undefined) {
        next.scope = mergeScope(current.scope, scopePatch(parsed.scope));
        scopeChanged = JSON.stringify(next.scope) !== JSON.stringify(current.scope);
      }
      if (next.scenario !== undefined && !next.scope.scenarios.includes(next.scenario)) {
        next.scope.scenarios.unshift(next.scenario);
        scopeChanged = true;
      }
      next.revision = current.revision + 1;
      next.updatedAt = at;
      if (changed.length > 0 || !scopeChanged) {
        next.history.push({
          at,
          actor,
          kind: 'UPDATED',
          message: changed.length > 0 ? `Modifié : ${changed.join(', ')}.` : 'Aucun changement.',
        });
      }
      if (scopeChanged) next.history.push({ at, actor, kind: 'SCOPE', message: 'Périmètre modifié.' });
      const scoped = isScoped(next);
      if (next.state === 'DRAFT' && scoped) this.moveTo(next, 'SCOPED', actor, at, 'Périmètre complet.');
      else if (next.state === 'SCOPED' && !scoped)
        this.moveTo(next, 'DRAFT', actor, at, 'Périmètre incomplet.');
      await this.write(next);
      return next;
    });
  }

  /**
   * Modification sérialisée par incident : `change` reçoit une copie ; identité, révision et historique
   * restent sous le contrôle du store ; un changement d'état doit respecter la table des transitions.
   */
  mutate(
    id: string,
    actor: string,
    change: (incident: Incident) => void | Promise<void>,
    event: { kind: IncidentEvent['kind']; message: string },
  ): Promise<Incident> {
    return exclusive(this.fileOf(id), async () => {
      const current = await this.load(id);
      const next = structuredClone(current);
      await change(next);
      const at = this.now().toISOString();
      const to = next.state;
      Object.assign(next, {
        id: current.id,
        projectId: current.projectId,
        createdAt: current.createdAt,
        createdBy: current.createdBy,
        state: current.state,
        revision: current.revision + 1,
        updatedAt: at,
        history: [...current.history, { at, actor, kind: event.kind, message: event.message }],
      });
      if (to !== current.state) {
        if (to === 'CANCELLED') throw new IncidentStateError('Utilisez cancel pour annuler un incident.');
        this.moveTo(next, to, actor, at, event.message);
      }
      await this.write(next);
      return next;
    });
  }

  transition(id: string, to: IncidentState, actor: string, message: string): Promise<Incident> {
    if (to === 'CANCELLED') return this.cancel(id, actor, message);
    return exclusive(this.fileOf(id), async () => {
      const next = structuredClone(await this.load(id));
      const at = this.now().toISOString();
      this.moveTo(next, to, actor, at, message);
      next.revision += 1;
      next.updatedAt = at;
      await this.write(next);
      return next;
    });
  }

  /** Annule depuis tout état non final ; l'état quitté est retenu pour la reprise. */
  cancel(id: string, actor: string, message = 'Investigation annulée.'): Promise<Incident> {
    return exclusive(this.fileOf(id), async () => {
      const next = structuredClone(await this.load(id));
      if (next.state === 'CANCELLED') throw new IncidentStateError(`L'incident ${id} est déjà annulé.`);
      const at = this.now().toISOString();
      next.cancelledFrom = next.state;
      next.state = 'CANCELLED';
      next.revision += 1;
      next.updatedAt = at;
      next.history.push({
        at,
        actor,
        kind: 'CANCELLED',
        message: `${message} (depuis ${next.cancelledFrom})`,
      });
      await this.write(next);
      return next;
    });
  }

  /**
   * Reprend un incident annulé dans l'état quitté ; une étape en cours (REPRODUCING, INVESTIGATING) est
   * interrompue : on revient à l'état stable qui la précède.
   */
  resume(id: string, actor: string): Promise<Incident> {
    return exclusive(this.fileOf(id), async () => {
      const next = structuredClone(await this.load(id));
      if (next.state !== 'CANCELLED') {
        throw new IncidentStateError(`L'incident ${id} n'est pas annulé (${next.state}).`);
      }
      const at = this.now().toISOString();
      const to = resumeState(next);
      next.state = to;
      delete next.cancelledFrom;
      next.revision += 1;
      next.updatedAt = at;
      next.history.push({ at, actor, kind: 'RESUMED', message: `Investigation reprise (${to}).` });
      await this.write(next);
      return next;
    });
  }

  private moveTo(incident: Incident, to: IncidentState, actor: string, at: string, message: string): void {
    const from = incident.state;
    if (!(INCIDENT_STATES as readonly string[]).includes(to) || !canTransition(from, to)) {
      throw new IncidentStateError(`Transition interdite : ${from} → ${shown(to)}.`);
    }
    incident.state = to;
    incident.history.push({
      at,
      actor,
      kind: 'STATE',
      message: `${from} → ${to}${message ? ` : ${message}` : ''}`,
    });
  }

  private async load(id: string): Promise<Incident> {
    const incident = await this.get(id);
    if (!incident) throw new IncidentNotFoundError(`Incident introuvable : ${id}.`);
    return incident;
  }

  private fileOf(id: string): string {
    if (!INCIDENT_ID.test(id)) return path.join(this.directory, '.invalid');
    return path.join(this.directory, `${id}.json`);
  }

  private async write(incident: Incident): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await writeFileAtomic(this.fileOf(incident.id), `${JSON.stringify(incident, null, 2)}\n`);
  }
}

/** L'état stable où reprendre un incident annulé. */
function resumeState(incident: Incident): IncidentState {
  const from = incident.cancelledFrom;
  if (from === 'REPRODUCING') return isScoped(incident) ? 'SCOPED' : 'DRAFT';
  if (from === 'INVESTIGATING') {
    const last = [...incident.investigation.reproductions].reverse().find((run) => run.reproduced !== null);
    if (last) return last.reproduced ? 'REPRODUCED' : 'NOT_REPRODUCED';
    return isScoped(incident) ? 'SCOPED' : 'DRAFT';
  }
  if (from === undefined || from === 'CANCELLED') return isScoped(incident) ? 'SCOPED' : 'DRAFT';
  return from;
}
