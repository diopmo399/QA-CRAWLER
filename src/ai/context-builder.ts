import type { BusinessSituation } from '../cognitive/business-state-engine.js';
import type { KnowledgeContradiction } from '../cognitive/contradictions.js';
import type { Evidence } from '../cognitive/evidence.js';
import type { Hypothesis } from '../cognitive/hypothesis-engine.js';
import { normalize } from '../flows/action-effect-verifier.js';
import type {
  ActionSafety,
  IntelligenceAction,
  IntelligenceEvidence,
  IntelligenceRequest,
  IntelligenceToolContext,
  IntelligenceTriggerReason,
} from './model.js';

/** Une action telle que QA-Crawler l'a découverte et jugée (SafetyPolicy comprise). */
export interface DiscoveredCandidate {
  /** Clé interne (identifiant d'action, ou role:nom) : jamais envoyée au fournisseur. */
  key: string;
  kind: IntelligenceAction['kind'];
  role?: string;
  name: string;
  safety: ActionSafety;
  allowed: boolean;
  disabled?: boolean;
  score?: number;
}

export interface ContextSources {
  mission?: string;
  goal?: { id: string; conditions: string[] };
  situation?: BusinessSituation;
  functionalState?: string;
  workflow?: { previous: string[]; next: string[]; requiredFields: string[]; intent?: string };
  plan?: { steps: string[]; confidence: number };
  candidates: DiscoveredCandidate[];
  evidence: readonly Evidence[];
  hypotheses: readonly Hypothesis[];
  contradictions: readonly KnowledgeContradiction[];
  coverageGaps?: string[];
  failure?: IntelligenceRequest['failure'];
  deterministic?: { key?: string; confidence: number; status: string };
}

export interface ContextLimits {
  maxActions: number;
  maxEvidence: number;
  maxHypotheses: number;
  maxPlanSteps: number;
}

export interface BuiltContext {
  request: IntelligenceRequest;
  /** A17 → la clé interne de l'action (pour l'exécuteur existant). */
  keyOf(actionId: string): string | undefined;
  idOf(key: string): string | undefined;
  candidateOf(actionId: string): DiscoveredCandidate | undefined;
}

const FORBIDDEN = [
  'executing browser actions (click, fill, submit, goto, JavaScript)',
  'inventing UI elements, CSS selectors, XPath or Playwright code',
  'changing a safety classification',
  'citing evidence ids that were not provided',
];

const terms = (text: string): string[] =>
  normalize(text.replace(/_/g, ' '))
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2);

/**
 * INTELLIGENCE CONTEXT BUILDER (§28) : un contexte MINIMAL mais suffisant — l'écran sous forme
 * sémantique (contrôles, rôles, sûreté), le but, l'état métier, le contexte du parcours, les
 * preuves et hypothèses PERTINENTES (celles qui partagent des mots avec le but, la suite du
 * parcours ou les actions candidates). Jamais le DOM, jamais une valeur saisie.
 */
export class IntelligenceContextBuilder {
  private next = 1;

  constructor(private readonly limits: ContextLimits) {}

  build(trigger: IntelligenceTriggerReason, sources: ContextSources): BuiltContext {
    const requestId = `R-${String(this.next)}`;
    this.next += 1;
    // Identifiants STABLES dans la requête : l'ordre de découverte, les mieux classées d'abord si un score existe.
    const ordered = sources.candidates
      .map((candidate, index) => ({ candidate, index }))
      .sort((a, b) => (b.candidate.score ?? 0) - (a.candidate.score ?? 0) || a.index - b.index)
      .slice(0, this.limits.maxActions)
      .sort((a, b) => a.index - b.index)
      .map((entry) => entry.candidate);
    const ids = new Map<string, DiscoveredCandidate>();
    const byKey = new Map<string, string>();
    const actions: IntelligenceAction[] = ordered.map((candidate, index) => {
      const id = `A${String(index + 1)}`;
      ids.set(id, candidate);
      byKey.set(candidate.key, id);
      return {
        id,
        kind: candidate.kind,
        type: (candidate.role ?? candidate.kind).toUpperCase(),
        name: candidate.name.slice(0, 120),
        safety: candidate.safety,
        allowed: candidate.allowed,
        ...(candidate.disabled ? { disabled: true } : {}),
        ...(candidate.score !== undefined
          ? { deterministicScore: Math.round(candidate.score * 100) / 100 }
          : {}),
      };
    });

    const focus = new Set([
      ...terms(sources.goal?.id ?? ''),
      ...(sources.goal?.conditions ?? []).flatMap(terms),
      ...(sources.workflow?.next ?? []).flatMap(terms),
      ...(sources.workflow?.requiredFields ?? []).flatMap(terms),
      ...terms(sources.workflow?.intent ?? ''),
      ...actions.flatMap((action) => terms(action.name)),
    ]);
    const relevance = (text: string): number => terms(text).filter((word) => focus.has(word)).length;
    const evidenceText = (evidence: Evidence): string =>
      `${evidence.type} ${evidence.source} ${Object.entries(evidence.details)
        .filter(([, value]) => typeof value === 'string' || Array.isArray(value))
        .map(([key, value]) => `${key}=${Array.isArray(value) ? value.slice(0, 4).join('|') : String(value)}`)
        .join(' ')}`;
    const weight: Record<string, number> = {
      RUNTIME: 3,
      DOM: 3,
      NETWORK: 2,
      STATIC_SOURCE: 2,
      OPENAPI: 2,
      HUMAN_RECORDING: 2,
    };
    const relevantEvidence: IntelligenceEvidence[] = [...sources.evidence]
      .map((evidence, index) => ({ evidence, index, score: relevance(evidenceText(evidence)) }))
      .filter((entry) => entry.score > 0)
      .sort(
        (a, b) =>
          b.score + (weight[b.evidence.type] ?? 1) - (a.score + (weight[a.evidence.type] ?? 1)) ||
          b.index - a.index,
      )
      .slice(0, this.limits.maxEvidence)
      .map(({ evidence }) => ({
        id: evidence.id,
        type: evidence.type,
        summary: evidenceText(evidence).slice(0, 200),
      }));
    const hypotheses = [...sources.hypotheses]
      .filter((hypothesis) => hypothesis.status !== 'REJECTED')
      .map((hypothesis) => {
        const statement = `${hypothesis.proposition.subject} ${hypothesis.proposition.relation} ${hypothesis.proposition.object}`;
        return { hypothesis, statement, score: relevance(statement) };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || b.hypothesis.confidence - a.hypothesis.confidence)
      .slice(0, this.limits.maxHypotheses)
      .map(({ hypothesis, statement }) => ({
        id: hypothesis.id,
        statement: statement.slice(0, 200),
        status: hypothesis.status,
        confidence: Math.round(hypothesis.confidence * 100) / 100,
      }));
    const situation = sources.situation;
    const deterministicId = sources.deterministic?.key ? byKey.get(sources.deterministic.key) : undefined;
    const request: IntelligenceRequest = {
      requestId,
      trigger,
      ...(sources.mission ? { mission: sources.mission } : {}),
      ...(sources.goal
        ? { goal: { id: sources.goal.id, conditions: sources.goal.conditions.slice(0, 10) } }
        : {}),
      ...(situation
        ? {
            businessState: {
              ...(situation.phase ? { phase: situation.phase } : {}),
              submission: situation.submission,
              missing: situation.missing.slice(0, 10),
              facts: situation.facts.slice(0, 10).map((fact) => `${fact.name}: ${fact.value}`.slice(0, 120)),
            },
          }
        : {}),
      ...(sources.functionalState ? { functionalState: sources.functionalState } : {}),
      ...(sources.workflow
        ? {
            workflowContext: {
              previous: sources.workflow.previous.slice(-5),
              next: sources.workflow.next.slice(0, 5),
              requiredFields: sources.workflow.requiredFields.slice(0, 10),
              ...(sources.workflow.intent ? { intent: sources.workflow.intent } : {}),
            },
          }
        : {}),
      ...(sources.plan
        ? { currentPlan: { steps: sources.plan.steps.slice(0, 10), confidence: sources.plan.confidence } }
        : {}),
      ...(sources.deterministic
        ? {
            deterministic: {
              ...(deterministicId ? { selectedActionId: deterministicId } : {}),
              confidence: Math.round(sources.deterministic.confidence * 100) / 100,
              status: sources.deterministic.status,
            },
          }
        : {}),
      availableActions: actions,
      relevantEvidence,
      hypotheses,
      contradictions: sources.contradictions.slice(0, 5).map((contradiction) => ({
        id: contradiction.id,
        summary:
          `${contradiction.property}: ${contradiction.types.join(', ')} — ${contradiction.investigation}`.slice(
            0,
            200,
          ),
      })),
      ...(sources.coverageGaps && sources.coverageGaps.length > 0
        ? { coverageContext: { gaps: sources.coverageGaps.slice(0, 10) } }
        : {}),
      ...(sources.failure ? { failure: sources.failure } : {}),
      constraints: {
        allowedActionIds: actions.filter((action) => !action.disabled).map((action) => action.id),
        forbidden: FORBIDDEN,
        maxPlanSteps: this.limits.maxPlanSteps,
      },
    };
    return {
      request,
      keyOf: (actionId) => ids.get(actionId)?.key,
      idOf: (key) => byKey.get(key),
      candidateOf: (actionId) => ids.get(actionId),
    };
  }
}

/**
 * Le contexte des OUTILS DE LECTURE pour une requête : il lit la requête construite et les
 * services existants (preuves, hypothèses), sans en faire une deuxième représentation.
 */
export function toolContextOf(built: BuiltContext, sources: ContextSources): IntelligenceToolContext {
  const { request } = built;
  return {
    currentGoal: () => request.goal ?? 'no current goal',
    businessState: () => request.businessState ?? 'unknown',
    availableActions: () => request.availableActions,
    actionDetails: (actionId) => {
      const action = request.availableActions.find((candidate) => candidate.id === actionId);
      if (!action) return `${actionId} does not exist`;
      const name = normalize(action.name);
      return {
        ...action,
        evidence: sources.evidence
          .filter((evidence) =>
            normalize(`${evidence.source} ${JSON.stringify(evidence.details)}`).includes(name),
          )
          .slice(-5)
          .map((evidence) => ({
            id: evidence.id,
            type: evidence.type,
            source: evidence.source.slice(0, 160),
          })),
      };
    },
    relevantEvidence: (query) => {
      const wanted = new Set(terms(query));
      return sources.evidence
        .map((evidence) => ({
          evidence,
          score: terms(`${evidence.type} ${evidence.source} ${JSON.stringify(evidence.details)}`).filter(
            (word) => wanted.has(word),
          ).length,
        }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 10)
        .map(({ evidence }) => ({
          id: evidence.id,
          type: evidence.type,
          source: evidence.source.slice(0, 160),
        }));
    },
    hypotheses: () => request.hypotheses,
    contradictions: () => request.contradictions,
    functionalCoverage: () => request.coverageContext ?? { gaps: [] },
    previousActions: () => request.workflowContext?.previous ?? [],
    nextActions: () => request.workflowContext?.next ?? [],
  };
}
