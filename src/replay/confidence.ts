import { round } from '../workflow-healing/similarity.js';
import type { PreconditionCheck, ReplayConfidence, ReplayStepVerdict } from './model.js';

export interface ConfidenceInput {
  /** Correspondance de la cible (empreinte, contexte, healing) : 0..1 ; absente : non vérifiée. */
  targetScore?: number;
  targetVerdict: ReplayStepVerdict['target'];
  /** L'intention enregistrée : sa confiance et son statut. */
  intent?: { confidence: number; status: string };
  preconditions: readonly PreconditionCheck[];
  effect: { status: string; deferred?: boolean } | undefined;
  /** Les checkpoints de l'étape : CONFIRMED / FAILED / INCONCLUSIVE… */
  checkpoints: readonly { status: string; progress: number; strength?: string }[];
  /** Sous ce seuil, le rejeu ne continue jamais en silence (défaut 0.6). */
  minConfidence?: number;
}

const DEFAULT_MIN = 0.6;

/**
 * REPLAY CONFIDENCE : cible × intention × préconditions × effet × état, puis une combinaison
 * prudente (moyenne géométrique pondérée : une dimension faible tire tout vers le bas).
 *
 *   target 0.98 · intent 0.95 · preconditions 1.00 · effect 0.93 · state 0.97 → 0.96
 *   target 0.92 · intent 0.54 · effect 0.30                              → 0.52 : pas en silence.
 */
export function replayConfidence(input: ConfidenceInput): ReplayConfidence {
  const reasons: string[] = [];
  const target = targetConfidence(input, reasons);
  const intent = intentConfidence(input, reasons);
  const preconditions = preconditionConfidence(input.preconditions, reasons);
  const effect = effectConfidence(input.effect, reasons);
  const state = stateConfidence(input.checkpoints, reasons);
  const weights = { target: 1, intent: 0.5, preconditions: 0.75, effect: 1, state: 1 };
  const values = { target, intent, preconditions, effect, state };
  let logSum = 0;
  let weightSum = 0;
  for (const [name, weight] of Object.entries(weights) as [keyof typeof values, number][]) {
    logSum += weight * Math.log(Math.max(0.01, values[name]));
    weightSum += weight;
  }
  const overall = round(Math.exp(logSum / weightSum));
  const min = input.minConfidence ?? DEFAULT_MIN;
  const continueSilently = overall >= min && effect >= 0.5 && state >= 0.4;
  if (!continueSilently)
    reasons.push(
      `overall ${String(overall)} below ${String(min)} (or effect / state too weak): not continued silently`,
    );
  return { target, intent, preconditions, effect, state, overall, continueSilently, reasons };
}

function targetConfidence(input: ConfidenceInput, reasons: string[]): number {
  switch (input.targetVerdict) {
    case 'CORRECT':
      return clamp(input.targetScore ?? 0.95, 0.6, 1);
    case 'HEALED':
      reasons.push('target healed: confirmed by the effect, not by its score');
      return clamp(input.targetScore ?? 0.7, 0.4, 0.9);
    case 'PLANNED':
      reasons.push('target chosen by the planner (historical or semantic): confirmed by the effect only');
      return clamp(input.targetScore ?? 0.6, 0.3, 0.85);
    case 'MISMATCH':
    case 'NOT_FOUND':
      return 0.05;
    case 'NOT_VERIFIED':
      return 0.5;
  }
}

function intentConfidence(input: ConfidenceInput, reasons: string[]): number {
  if (!input.intent) return 0.7;
  if (input.intent.status === 'AMBIGUOUS' || input.intent.status === 'UNKNOWN') {
    reasons.push(`recorded intent ${input.intent.status}`);
    return clamp(input.intent.confidence, 0.2, 0.55);
  }
  return clamp(input.intent.confidence, 0.5, 1);
}

function preconditionConfidence(checks: readonly PreconditionCheck[], reasons: string[]): number {
  if (checks.length === 0) return 0.8;
  const unmet = checks.filter((check) => check.satisfied === false);
  const unknown = checks.filter((check) => check.satisfied === undefined);
  if (unmet.some((check) => check.precondition.severity === 'HARD')) {
    reasons.push(
      `hard precondition not met: ${unmet.map((check) => `${check.precondition.kind} "${check.precondition.value}"`).join(', ')}`,
    );
    return 0.1;
  }
  if (unmet.length > 0)
    reasons.push(`soft precondition not met: ${unmet.map((check) => check.precondition.kind).join(', ')}`);
  return round(clamp(1 - unmet.length * 0.3 - unknown.length * 0.05, 0.2, 1));
}

function effectConfidence(effect: ConfidenceInput['effect'], reasons: string[]): number {
  if (!effect) return 0.7;
  switch (effect.status) {
    case 'CONFIRMED':
      return 0.95;
    case 'NOT_REQUIRED':
      return 0.8;
    case 'NOT_VERIFIED':
      return 0.6;
    case 'EXPECTATION_SUSPECT':
      reasons.push('recorded expectation suspect: the effect was not what was recorded');
      return 0.55;
    case 'AMBIGUOUS':
      reasons.push('effect ambiguous');
      return 0.4;
    case 'WRONG_EFFECT':
      reasons.push(effect.deferred ? 'effect changed (deferred to the next step)' : 'wrong effect');
      return effect.deferred ? 0.45 : 0.2;
    case 'NO_EFFECT':
      reasons.push('no effect observed');
      return 0.1;
    case 'TARGET_MISMATCH':
      return 0.05;
    default:
      return 0.5;
  }
}

function stateConfidence(checkpoints: ConfidenceInput['checkpoints'], reasons: string[]): number {
  if (checkpoints.length === 0) return 0.75;
  let total = 0;
  for (const checkpoint of checkpoints) {
    if (checkpoint.status === 'CONFIRMED') total += 1;
    else if (checkpoint.status === 'FAILED') {
      total += 0.05;
      reasons.push('functional checkpoint failed');
    } else if (checkpoint.status === 'INCONCLUSIVE') total += 0.35 + checkpoint.progress * 0.4;
    else total += 0.6;
  }
  return round(clamp(total / checkpoints.length, 0.05, 1));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
