import { ZodError } from 'zod';
import { AttachmentError } from '../../incident/attachments.js';
import { PdfTimeoutError, PdfUnavailableError } from '../../incident/report-export.js';
import {
  IncidentConflictError,
  IncidentNotFoundError,
  IncidentStateError,
  IncidentValidationError,
} from '../../incident/incident-store.js';
import {
  EXPERIMENT_KINDS,
  REPORT_FORMATS,
  REPORT_SECTIONS,
  SCOPE_EXTENSION_KINDS,
  SCOPE_TREE_DEFAULT_DEPTH,
  SCOPE_TREE_MAX_DEPTH,
  type AttachmentType,
  type ExperimentKind,
  type IncidentInput,
  type ReportFormat,
  type ReportSection,
  type ScopeExtensionKind,
} from '../../incident/model.js';
import { ScopeExtensionError } from '../../incident/scope.js';
import { ScopeDeniedError } from '../../incident/scope-policy.js';
import { IncidentServiceError, type IncidentService } from '../../incident/service.js';
import { handleIncidentAiRoutes } from './incident-ai.js';
import { handleIncidentTriggerRoutes } from './incident-trigger.js';

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
  if (id !== undefined && action === 'attachments') return attachmentRoutes(ctx, id, part, item);
  if (id !== undefined && action === 'ai') return handleIncidentAiRoutes(ctx, id, part, item, decision);
  if (id !== undefined && action === 'trigger')
    return handleIncidentTriggerRoutes(ctx, id, part, item, decision);
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
    if (action === 'sources' && part === undefined) {
      json(await service.sourceTree(id));
      return true;
    }
    if (action === 'source' && part === undefined) {
      const application = ctx.url.searchParams.get('application');
      const file = ctx.url.searchParams.get('file');
      if (!application || !file) throw ctx.fail(400, 'BAD_REQUEST', 'application and file are required');
      json(await service.source(id, application, file));
      return true;
    }
    if (action === 'screenshot' && part === undefined) {
      const reproduction = ctx.url.searchParams.get('reproduction');
      const file = ctx.url.searchParams.get('file');
      if (!reproduction || !file) throw ctx.fail(400, 'BAD_REQUEST', 'reproduction and file are required');
      json(await service.screenshot(id, reproduction, file));
      return true;
    }
    if (action === 'report' && part === undefined) {
      const format = reportFormat(ctx);
      const sections = reportSections(ctx);
      if (format === 'markdown') json({ markdown: await service.reportMarkdown(id, sections) });
      else if (format === 'html') json({ html: await service.reportHtml(id, sections) });
      else if (format === 'pdf') json(await service.reportPdf(id, sections));
      else json(sections ? await service.reportPart(id, sections) : await service.report(id));
      return true;
    }
    if (action === 'scope' && part === 'tree' && item === undefined) {
      const application = ctx.url.searchParams.get('application');
      if (!application) throw ctx.fail(400, 'BAD_REQUEST', 'application is required');
      const raw = ctx.url.searchParams.get('depth');
      const depth = raw === null ? SCOPE_TREE_DEFAULT_DEPTH : /^\d{1,2}$/.test(raw) ? Number(raw) : NaN;
      if (!Number.isInteger(depth) || depth < 1 || depth > SCOPE_TREE_MAX_DEPTH)
        throw ctx.fail(
          400,
          'BAD_REQUEST',
          `depth must be an integer between 1 and ${String(SCOPE_TREE_MAX_DEPTH)}`,
        );
      json(await service.scopeTree(id, application, depth));
      return true;
    }
    if (action === 'regression' && part === 'spec' && item === undefined) {
      json(await service.regressionSpec(id));
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

/**
 * Les pièces jointes : POST …/attachments (ajout, RUN), GET …/attachments/:a (contenu, RUN), DELETE
 * …/attachments/:a (retrait, RUN). Les droits sont vérifiés par access.ts.
 */
async function attachmentRoutes(
  ctx: IncidentRouteContext,
  id: string,
  attachmentId: string | undefined,
  extra: string | undefined,
): Promise<boolean> {
  if (extra !== undefined) return false;
  if (attachmentId === undefined) {
    if (ctx.method !== 'POST') return false;
    const body = await ctx.body();
    ctx.json(
      await ctx.service.addAttachment(
        id,
        {
          name: body.name as string,
          type: body.type as AttachmentType,
          dataBase64: body.dataBase64 as string,
        },
        ctx.actor,
      ),
      201,
    );
    return true;
  }
  if (ctx.method === 'GET') {
    ctx.json(await ctx.service.attachment(id, attachmentId));
    return true;
  }
  if (ctx.method === 'DELETE') {
    ctx.json(await ctx.service.removeAttachment(id, attachmentId, ctx.actor));
    return true;
  }
  return false;
}

function reportFormat(ctx: IncidentRouteContext): ReportFormat {
  const format = ctx.url.searchParams.get('format') ?? 'json';
  if (!(REPORT_FORMATS as readonly string[]).includes(format))
    throw ctx.fail(400, 'BAD_REQUEST', `format must be one of ${REPORT_FORMATS.join(', ')}`);
  return format as ReportFormat;
}

/** `sections=a,b` : un sous-ensemble de REPORT_SECTIONS, rendu dans l'ordre du rapport ; absent : toutes. */
function reportSections(ctx: IncidentRouteContext): ReportSection[] | undefined {
  const raw = ctx.url.searchParams.get('sections');
  if (raw === null) return undefined;
  const asked = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  const unknown = asked.filter((entry) => !(REPORT_SECTIONS as readonly string[]).includes(entry));
  if (asked.length === 0 || unknown.length > 0)
    throw ctx.fail(
      400,
      'BAD_REQUEST',
      `sections must list at least one of ${REPORT_SECTIONS.join(', ')}${unknown.length > 0 ? ` (unknown: ${unknown.slice(0, 5).join(', ')})` : ''}`,
    );
  return REPORT_SECTIONS.filter((section) => asked.includes(section));
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
  if (error instanceof AttachmentError) {
    const status = {
      INVALID: 400,
      TOO_LARGE: 413,
      UNSUPPORTED_TYPE: 415,
      CONTENT_MISMATCH: 415,
      TOO_MANY: 409,
    }[error.code];
    return ctx.fail(status, error.code === 'INVALID' ? 'BAD_REQUEST' : error.code, error.message);
  }
  if (error instanceof PdfUnavailableError) return ctx.fail(501, 'PDF_UNAVAILABLE', error.message);
  if (error instanceof PdfTimeoutError) return ctx.fail(504, 'PDF_TIMEOUT', error.message);
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
