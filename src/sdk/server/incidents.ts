import { ZodError } from 'zod';
import {
  IncidentConflictError,
  IncidentNotFoundError,
  IncidentStateError,
  IncidentValidationError,
} from '../../incident/incident-store.js';
import {
  EXPERIMENT_KINDS,
  SCOPE_EXTENSION_KINDS,
  type ExperimentKind,
  type IncidentInput,
  type ScopeExtensionKind,
} from '../../incident/model.js';
import { ScopeExtensionError } from '../../incident/scope.js';
import { ScopeDeniedError } from '../../incident/scope-policy.js';
import { IncidentServiceError, type IncidentService } from '../../incident/service.js';

/**
 * LES ROUTES DES INCIDENTS (`/api/projects/:p/incidents/…`), au-dessus du service d'investigation. Les
 * droits sont vérifiés avant (access.ts : RUN, DECIDE pour une extension du périmètre, PUBLISH pour
 * ajouter le test à la bibliothèque) ; une vérification avec effets de bord demande en plus RUN_WRITES.
 */
export interface IncidentRouteContext {
  service: IncidentService;
  /** Les segments après `incidents` : [] , [id], [id, action, …]. */
  rest: readonly string[];
  method: string;
  url: URL;
  actor: string;
  body: () => Promise<Record<string, unknown>>;
  json: (body: unknown, status?: number) => void;
  /** Le droit de lancer des vérifications avec effets de bord (RUN_WRITES). */
  canWrite: boolean;
  fail: (status: number, code: string, message: string) => Error;
}

export async function handleIncidentRoutes(ctx: IncidentRouteContext): Promise<boolean> {
  try {
    return await route(ctx);
  } catch (error) {
    throw translate(ctx, error);
  }
}

async function route(ctx: IncidentRouteContext): Promise<boolean> {
  const { service, rest, method, actor, json } = ctx;
  const [id, action, part, item, decision] = rest;
  if (id === undefined) {
    if (method === 'GET') {
      json(await service.list());
      return true;
    }
    if (method === 'POST') {
      json(await service.create((await ctx.body()) as unknown as IncidentInput, actor), 201);
      return true;
    }
    return false;
  }
  if (action === undefined) {
    if (method !== 'GET') return false;
    json(await service.incident(id));
    return true;
  }
  if (method === 'GET') {
    if (action === 'capabilities' && part === undefined) {
      json(await service.capabilities(id));
      return true;
    }
    if (action === 'report' && part === undefined) {
      const format = ctx.url.searchParams.get('format') ?? 'json';
      if (format === 'markdown') json({ markdown: await service.reportMarkdown(id) });
      else if (format === 'json') json(await service.report(id));
      else throw ctx.fail(400, 'BAD_REQUEST', 'format must be json or markdown');
      return true;
    }
    return false;
  }
  if (method !== 'POST') return false;
  const body = await ctx.body();
  switch (action) {
    case 'update': {
      if (part !== undefined) return false;
      const revision = body.revision;
      if (typeof revision !== 'number') throw ctx.fail(400, 'BAD_REQUEST', 'revision must be a number');
      const patch = body.patch;
      if (!patch || typeof patch !== 'object') throw ctx.fail(400, 'BAD_REQUEST', 'patch must be an object');
      json(await service.update(id, revision, patch, actor));
      return true;
    }
    case 'scope': {
      if (part === 'validate' && item === undefined) {
        json(await service.validateScope(id));
        return true;
      }
      if (part === 'extensions' && item === undefined) {
        const kind = body.kind;
        if (typeof kind !== 'string' || !(SCOPE_EXTENSION_KINDS as readonly string[]).includes(kind))
          throw ctx.fail(400, 'BAD_REQUEST', `kind must be one of ${SCOPE_EXTENSION_KINDS.join(', ')}`);
        json(
          await service.requestExtension(
            id,
            {
              kind: kind as ScopeExtensionKind,
              target: text(ctx, body.target, 'target', 500),
              ...(typeof body.applicationId === 'string' ? { applicationId: body.applicationId } : {}),
              reason: text(ctx, body.reason, 'reason', 1000),
            },
            actor,
          ),
        );
        return true;
      }
      if (part === 'extensions' && item !== undefined && decision === 'decision') {
        if (typeof body.approve !== 'boolean')
          throw ctx.fail(400, 'BAD_REQUEST', 'approve must be a boolean');
        json(await service.decideExtension(id, item, body.approve, actor));
        return true;
      }
      return false;
    }
    case 'reproduce':
      if (part !== undefined) return false;
      json(
        await service.reproduce(id, actor, {
          ...(typeof body.headed === 'boolean' ? { headed: body.headed } : {}),
          ...(typeof body.slowMoMs === 'number' ? { slowMoMs: body.slowMoMs } : {}),
        }),
        202,
      );
      return true;
    case 'analyze':
      if (part !== undefined) return false;
      json(await service.analyze(id, actor));
      return true;
    case 'experiments': {
      if (part === undefined) {
        const kind = body.kind;
        if (typeof kind !== 'string' || !(EXPERIMENT_KINDS as readonly string[]).includes(kind))
          throw ctx.fail(400, 'BAD_REQUEST', `kind must be one of ${EXPERIMENT_KINDS.join(', ')}`);
        json(
          await service.planExperiment(
            id,
            {
              kind: kind as ExperimentKind,
              params: params(ctx, body.params),
              ...(typeof body.hypothesisId === 'string' ? { hypothesisId: body.hypothesisId } : {}),
            },
            actor,
          ),
          201,
        );
        return true;
      }
      if (item === 'run') {
        const approve = body.approve === true;
        const incident = await service.incident(id);
        const experiment = incident.investigation.experiments.find((entry) => entry.id === part);
        // Les effets de bord : une approbation explicite, par quelqu'un qui peut permettre des écritures.
        if (experiment?.sideEffects && approve && !ctx.canWrite)
          throw ctx.fail(
            403,
            'FORBIDDEN',
            'approving a verification with side effects needs the RUN_WRITES right',
          );
        json(await service.runExperiment(id, part, actor, { approve }), 202);
        return true;
      }
      return false;
    }
    case 'diagnose':
      if (part !== undefined) return false;
      json(await service.diagnose(id, actor));
      return true;
    case 'regression':
      if (part === undefined) json(await service.proposeRegression(id, actor));
      else if (part === 'run') json(await service.runRegression(id, actor), 202);
      else if (part === 'accept') json(await service.acceptRegression(id, actor));
      else if (part === 'reject') json(await service.rejectRegression(id, actor));
      else return false;
      return true;
    case 'cancel':
      if (part !== undefined) return false;
      json(await service.cancel(id, actor));
      return true;
    case 'resume':
      if (part !== undefined) return false;
      json(await service.resume(id, actor));
      return true;
    default:
      return false;
  }
}

function text(ctx: IncidentRouteContext, raw: unknown, field: string, max: number): string {
  if (typeof raw !== 'string' || raw.trim() === '' || raw.length > max)
    throw ctx.fail(
      400,
      'BAD_REQUEST',
      `${field} must be a non-empty text of at most ${String(max)} characters`,
    );
  return raw.trim();
}

/** Les paramètres d'une vérification : des valeurs simples seulement (texte, nombre, booléen, liste de textes). */
function params(
  ctx: IncidentRouteContext,
  raw: unknown,
): Record<string, string | number | boolean | string[]> {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw ctx.fail(400, 'BAD_REQUEST', 'params must be an object');
  const out: Record<string, string | number | boolean | string[]> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
      out[key] = value;
    else if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) out[key] = value;
    else
      throw ctx.fail(
        400,
        'BAD_REQUEST',
        `params.${key} must be a text, a number, a boolean or a list of texts`,
      );
  }
  return out;
}

function translate(ctx: IncidentRouteContext, error: unknown): unknown {
  if (error instanceof IncidentServiceError) {
    const status = { NOT_FOUND: 404, INVALID: 422, BUSY: 409, STATE: 409, SCOPE: 403 }[error.code];
    return ctx.fail(status, error.code === 'SCOPE' ? 'OUT_OF_SCOPE' : error.code, error.message);
  }
  if (error instanceof IncidentNotFoundError) return ctx.fail(404, 'NOT_FOUND', error.message);
  if (error instanceof IncidentConflictError) return ctx.fail(409, 'CONFLICT', error.message);
  if (error instanceof IncidentStateError) return ctx.fail(409, 'STATE', error.message);
  if (error instanceof ScopeDeniedError) return ctx.fail(403, 'OUT_OF_SCOPE', error.message);
  if (error instanceof ScopeExtensionError) return ctx.fail(409, 'EXTENSION', error.message);
  if (error instanceof IncidentValidationError) return ctx.fail(400, 'BAD_REQUEST', error.message);
  if (error instanceof ZodError)
    return ctx.fail(
      400,
      'BAD_REQUEST',
      error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; '),
    );
  return error;
}
