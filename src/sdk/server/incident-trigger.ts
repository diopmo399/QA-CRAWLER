import {
  TRIGGER_DEPTHS,
  type TriggerBudget,
  type TriggerDepth,
  type TriggerInvestigationInput,
} from '../core/incident-trigger-contracts.js';
import type { IncidentRouteContext } from './incidents.js';

/**
 * LES ROUTES DE LA DÉCOUVERTE DES DÉCLENCHEURS (`…/incidents/:id/trigger/…`), au-dessus du service. Les
 * droits (access.ts) : RUN pour décrire, lancer, mettre en pause, reprendre, annuler et lire le rapport ;
 * DECIDE pour trancher une vérification proposée et pour prolonger un budget. Le mode déterministe ne
 * dépend d'aucune IA : le serveur n'ajoute le crochet IA que lorsqu'un modèle est configuré.
 *
 *   POST …/trigger/describe {text}                         → Incident (description interprétée)
 *   POST …/trigger/start {description?, depth?, budget?, repeats?, confidenceThreshold?} → Incident (202)
 *   POST …/trigger/pause | …/trigger/resume | …/trigger/cancel → Incident
 *   POST …/trigger/experiments/:e/decision {approve, reason?} → Incident
 *   POST …/trigger/extend-budget {added}                   → Incident
 *   GET  …/trigger/report[/:run]                           → TriggerRunReport
 */
export async function handleIncidentTriggerRoutes(
  ctx: IncidentRouteContext,
  id: string,
  part: string | undefined,
  item: string | undefined,
  decision: string | undefined,
): Promise<boolean> {
  const { service, method, actor, json } = ctx;
  if (method === 'GET') {
    if (part === 'report' && decision === undefined) {
      json(await service.triggerReport(id, item));
      return true;
    }
    return false;
  }
  if (method !== 'POST') return false;
  const body = await ctx.body();
  switch (part) {
    case 'describe': {
      if (item !== undefined) return false;
      const text = body.text;
      if (typeof text !== 'string' || text.trim() === '' || text.length > 20_000)
        throw ctx.fail(400, 'BAD_REQUEST', 'text must be a non-empty text of at most 20000 characters');
      json(await service.describeIncident(id, text, actor));
      return true;
    }
    case 'start':
      if (item !== undefined) return false;
      json(await service.discoverTrigger(id, actor, inputOf(ctx, body)), 202);
      return true;
    case 'resume':
      if (item !== undefined) return false;
      json(await service.resumeTrigger(id, actor, inputOf(ctx, body)), 202);
      return true;
    case 'pause':
      if (item !== undefined) return false;
      json(await service.pauseTrigger(id, actor));
      return true;
    case 'cancel':
      if (item !== undefined) return false;
      json(await service.cancelTrigger(id, actor));
      return true;
    case 'experiments': {
      if (item === undefined || decision !== 'decision') return false;
      if (typeof body.approve !== 'boolean') throw ctx.fail(400, 'BAD_REQUEST', 'approve must be a boolean');
      const reason = body.reason;
      if (reason !== undefined && (typeof reason !== 'string' || reason.length > 1000))
        throw ctx.fail(400, 'BAD_REQUEST', 'reason must be a text of at most 1000 characters');
      json(
        await service.decideTriggerExperiment(id, item, body.approve, actor, {
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
      json(await service.extendTriggerBudget(id, budgetOf(ctx, added), actor));
      return true;
    }
    default:
      return false;
  }
}

const BUDGET_KEYS = new Set<string>([
  'maxDurationMs',
  'maxTrials',
  'maxActions',
  'maxRepeats',
  'maxExperiments',
  'maxEvents',
  'maxAiCalls',
  'maxBrowsers',
]);

function budgetOf(ctx: IncidentRouteContext, raw: object): Partial<TriggerBudget> {
  const out: Partial<TriggerBudget> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!BUDGET_KEYS.has(key)) throw ctx.fail(400, 'BAD_REQUEST', `unknown budget key: ${key}`);
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
      throw ctx.fail(400, 'BAD_REQUEST', `budget.${key} must be a positive number`);
    out[key as keyof TriggerBudget] = value;
  }
  return out;
}

function inputOf(ctx: IncidentRouteContext, body: Record<string, unknown>): TriggerInvestigationInput {
  const { description, depth, budget, repeats, confidenceThreshold } = body;
  if (description !== undefined && (typeof description !== 'string' || description.length > 20_000))
    throw ctx.fail(400, 'BAD_REQUEST', 'description must be a text of at most 20000 characters');
  if (
    depth !== undefined &&
    (typeof depth !== 'string' || !(TRIGGER_DEPTHS as readonly string[]).includes(depth))
  )
    throw ctx.fail(400, 'BAD_REQUEST', `depth must be one of ${TRIGGER_DEPTHS.join(', ')}`);
  if (budget !== undefined && (!budget || typeof budget !== 'object' || Array.isArray(budget)))
    throw ctx.fail(400, 'BAD_REQUEST', 'budget must be an object of budget keys');
  if (
    repeats !== undefined &&
    (typeof repeats !== 'number' || !Number.isInteger(repeats) || repeats < 1 || repeats > 50)
  )
    throw ctx.fail(400, 'BAD_REQUEST', 'repeats must be an integer between 1 and 50');
  if (
    confidenceThreshold !== undefined &&
    (typeof confidenceThreshold !== 'number' || confidenceThreshold <= 0 || confidenceThreshold > 1)
  )
    throw ctx.fail(400, 'BAD_REQUEST', 'confidenceThreshold must be a number in (0, 1]');
  return {
    ...(typeof description === 'string' ? { description } : {}),
    ...(depth !== undefined ? { depth: depth as TriggerDepth } : {}),
    ...(budget !== undefined ? { budget: budgetOf(ctx, budget) } : {}),
    ...(typeof repeats === 'number' ? { repeats } : {}),
    ...(typeof confidenceThreshold === 'number' ? { confidenceThreshold } : {}),
  };
}
