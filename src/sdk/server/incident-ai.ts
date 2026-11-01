import {
  AI_INVESTIGATION_MODES,
  INVESTIGATION_DEPTHS,
  MAX_AI_QUESTION_CHARS,
  type AiBudget,
  type AiInvestigationMode,
  type InvestigationDepth,
} from '../core/incident-ai-contracts.js';
import type { IncidentRouteContext } from './incidents.js';

/**
 * LES ROUTES DE L'INVESTIGATION IA (`…/incidents/:id/ai/…`), au-dessus du service. Les droits (access.ts) :
 * RUN pour lire les capacités et la mémoire, lancer, mettre en pause, reprendre, annuler, questionner ;
 * DECIDE pour trancher une vérification proposée et pour prolonger un budget. Le serveur ne charge le module
 * IA que lorsqu'il est configuré : sans lui, `capabilities` dit pourquoi et tout lancement est refusé (422).
 *
 *   GET  …/ai/capabilities                      → AiCapabilities
 *   GET  …/ai/memory                            → InvestigationMemory | null
 *   POST …/ai/investigate {mode?, depth?, budget?} → Incident (202 ; le run est RUNNING)
 *   POST …/ai/pause | …/ai/resume | …/ai/cancel → Incident
 *   POST …/ai/ask {question}                    → AiAssistantAnswer
 *   POST …/ai/experiments/:e/decision {approve, reason?} → Incident
 *   POST …/ai/extend-budget {added}             → InvestigationMemory
 */
export async function handleIncidentAiRoutes(
  ctx: IncidentRouteContext,
  id: string,
  part: string | undefined,
  item: string | undefined,
  decision: string | undefined,
): Promise<boolean> {
  const { service, method, actor, json } = ctx;
  if (method === 'GET') {
    if (part === 'capabilities' && item === undefined) {
      json(await service.aiCapabilities(id));
      return true;
    }
    if (part === 'memory' && item === undefined) {
      json((await service.aiMemory(id)) ?? null);
      return true;
    }
    return false;
  }
  if (method !== 'POST') return false;
  const body = await ctx.body();
  switch (part) {
    case 'investigate':
      if (item !== undefined) return false;
      json(await service.investigate(id, actor, investigationInput(ctx, body)), 202);
      return true;
    case 'resume':
      if (item !== undefined) return false;
      json(await service.resumeInvestigation(id, actor, investigationInput(ctx, body)), 202);
      return true;
    case 'pause':
      if (item !== undefined) return false;
      json(await service.pauseInvestigation(id, actor));
      return true;
    case 'cancel':
      if (item !== undefined) return false;
      json(await service.cancelInvestigation(id, actor));
      return true;
    case 'ask': {
      if (item !== undefined) return false;
      const question = body.question;
      if (typeof question !== 'string' || question.trim() === '' || question.length > MAX_AI_QUESTION_CHARS)
        throw ctx.fail(
          400,
          'BAD_REQUEST',
          `question must be a non-empty text of at most ${String(MAX_AI_QUESTION_CHARS)} characters`,
        );
      json(await service.ask(id, actor, question));
      return true;
    }
    case 'experiments': {
      if (item === undefined || decision !== 'decision') return false;
      // L'identifiant d'une proposition porte un deux-points (« <run>:prop-n ») : le client l'encode dans l'URL.
      const experimentId = decodeSegment(item);
      if (typeof body.approve !== 'boolean') throw ctx.fail(400, 'BAD_REQUEST', 'approve must be a boolean');
      const reason = body.reason;
      if (reason !== undefined && (typeof reason !== 'string' || reason.length > 1000))
        throw ctx.fail(400, 'BAD_REQUEST', 'reason must be a text of at most 1000 characters');
      json(
        await service.decideAiExperiment(id, experimentId, body.approve, actor, {
          ...(typeof reason === 'string' ? { reason } : {}),
          canWrite: ctx.canWrite,
        }),
      );
      return true;
    }
    case 'extend-budget': {
      if (item !== undefined) return false;
      const added = body.added;
      if (!added || typeof added !== 'object' || Array.isArray(added))
        throw ctx.fail(400, 'BAD_REQUEST', 'added must be an object of budget keys');
      json(await service.extendAiBudget(id, budgetOf(ctx, added), actor));
      return true;
    }
    default:
      return false;
  }
}

function investigationInput(
  ctx: IncidentRouteContext,
  body: Record<string, unknown>,
): {
  mode?: Exclude<AiInvestigationMode, 'DETERMINISTIC'>;
  depth?: InvestigationDepth;
  budget?: Partial<AiBudget>;
} {
  const mode = body.mode;
  if (mode !== undefined) {
    if (
      typeof mode !== 'string' ||
      !(AI_INVESTIGATION_MODES as readonly string[]).includes(mode) ||
      mode === 'DETERMINISTIC'
    )
      throw ctx.fail(400, 'BAD_REQUEST', 'mode must be AI_ASSISTED or AI_AGENTIC');
  }
  const depth = body.depth;
  if (
    depth !== undefined &&
    (typeof depth !== 'string' || !(INVESTIGATION_DEPTHS as readonly string[]).includes(depth))
  )
    throw ctx.fail(400, 'BAD_REQUEST', `depth must be one of ${INVESTIGATION_DEPTHS.join(', ')}`);
  const budget = body.budget;
  if (budget !== undefined && (!budget || typeof budget !== 'object' || Array.isArray(budget)))
    throw ctx.fail(400, 'BAD_REQUEST', 'budget must be an object of budget keys');
  return {
    ...(mode !== undefined ? { mode: mode as Exclude<AiInvestigationMode, 'DETERMINISTIC'> } : {}),
    ...(depth !== undefined ? { depth: depth as InvestigationDepth } : {}),
    ...(budget !== undefined ? { budget: budgetOf(ctx, budget) } : {}),
  };
}

const BUDGET_KEYS = new Set<string>([
  'maxIterations',
  'maxModelCalls',
  'maxToolCalls',
  'maxInputTokens',
  'maxOutputTokens',
  'maxCost',
  'maxDurationMs',
  'maxFiles',
  'maxCommands',
  'maxExperiments',
]);

function budgetOf(ctx: IncidentRouteContext, raw: object): Partial<AiBudget> {
  const out: Partial<AiBudget> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!BUDGET_KEYS.has(key)) throw ctx.fail(400, 'BAD_REQUEST', `unknown budget key ${key}`);
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
      throw ctx.fail(400, 'BAD_REQUEST', `budget.${key} must be a non-negative number`);
    out[key as keyof AiBudget] = value;
  }
  return out;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
