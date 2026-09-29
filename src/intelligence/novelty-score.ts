import { sampleConfidence } from './confidence-engine.js';
import { ageInDays, effectiveObservations, type AgingOptions } from './knowledge-aging.js';

export const NOVELTY_LEVELS = ['NEW', 'RARE', 'KNOWN', 'FAMILIAR'] as const;
export type NoveltyLevel = (typeof NOVELTY_LEVELS)[number];

export interface NoveltyInput {
  /** Exécutions connues de la mémoire de travail (historique + run courant). */
  executions: number;
  /** Exécutions de ce run (CoverageTracker). */
  usedThisRun: number;
  lastExecutedAt?: string;
}

export interface NoveltyResult {
  /** 1 : jamais exécutée ; tend vers 0 avec les exécutions (jamais une rupture brutale). */
  score: number;
  level: NoveltyLevel;
  /** Exécutions des runs précédents, pondérées par la récence. */
  effectiveHistory: number;
  reasons: string[];
}

export interface NoveltyOptions {
  /** Exécutions pour une nouveauté de 0,5 : k / (k + n). */
  sampleHalfPoint: number;
  /** Absent : pas de vieillissement, une vieille exécution compte autant qu'une récente. */
  aging?: AgingOptions;
  now?: () => string;
}

/**
 * NOVELTY SCORE, déterministe : à quel point une action est encore inconnue.
 *
 *   nouveauté = k / (k + exécutions passées pondérées par la récence + exécutions de ce run)
 *
 * Une action exécutée 500 fois il y a un an redevient presque nouvelle ; une action
 * exécutée 3 fois hier ne l'est plus. Le résultat dit toujours d'où il vient.
 */
export function noveltyScore(input: NoveltyInput, options: NoveltyOptions): NoveltyResult {
  const now = options.now?.() ?? new Date().toISOString();
  const past = Math.max(0, input.executions - input.usedThisRun);
  const effectiveHistory = options.aging
    ? effectiveObservations(past, input.lastExecutedAt, now, options.aging)
    : past;
  const score = round(1 - sampleConfidence(effectiveHistory + input.usedThisRun, options.sampleHalfPoint));
  const reasons: string[] = [];
  if (past === 0) reasons.push('never executed in previous runs');
  else
    reasons.push(
      `${past} past execution(s)${options.aging && input.lastExecutedAt ? `, last ${Math.floor(ageInDays(input.lastExecutedAt, now))} day(s) ago` : ''} ≈ ${round(effectiveHistory)} effective`,
    );
  if (input.usedThisRun > 0) reasons.push(`${input.usedThisRun} execution(s) in this run`);
  return {
    score,
    level: noveltyLevel(score, past + input.usedThisRun),
    effectiveHistory: round(effectiveHistory),
    reasons,
  };
}

function noveltyLevel(score: number, executions: number): NoveltyLevel {
  if (executions === 0) return 'NEW';
  if (score >= 0.5) return 'RARE';
  if (score >= 0.2) return 'KNOWN';
  return 'FAMILIAR';
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
