import { z } from 'zod';
import { normalize as normalizeControl } from '../flows/action-effect-verifier.js';
import type { Evidence } from './evidence.js';
import type { HypothesisEngine } from './hypothesis-engine.js';

/**
 * Le PROBLÈME soumis à un conseiller : construit, borné — jamais tout le DOM ni tout le code.
 * Aucune valeur saisie, aucun secret : des libellés, des identifiants de preuve, des règles.
 */
export type AdvisorActionKind = 'click' | 'check' | 'select' | 'fill';

export interface ReasoningProblem {
  goal: string;
  functionalState: string;
  visibleControls: { kind: AdvisorActionKind; label: string; role?: string }[];
  previousActions: string[];
  nextActions: string[];
  knownRules: string[];
  staticEvidence: { id: string; summary: string }[];
  runtimeEvidence: { id: string; summary: string }[];
  historicalEvidence: { id: string; summary: string }[];
  contradictions: string[];
  allowedActions: { kind: AdvisorActionKind; label: string; role?: string }[];
  /** Pourquoi le conseiller est consulté (ambiguïté, écran inattendu…). */
  trigger: AdvisorTrigger;
}

export type AdvisorTrigger =
  | 'SEMANTIC_AMBIGUITY'
  | 'INTENT_UNRESOLVED'
  | 'UNEXPECTED_SCREEN'
  | 'MULTIPLE_PLANS'
  | 'UNKNOWN_ERROR'
  | 'UNRESOLVED_CONTRADICTION'
  | 'HYPOTHESIS_GENERATION';

/** LLM OUTPUT STRICTEMENT STRUCTURÉ (§76) — validé, sinon rejeté. */
export const advisorProposalSchema = z
  .object({
    hypothesis: z.string().max(300).optional(),
    candidateIntent: z.string().max(120).optional(),
    candidateActions: z
      .array(
        z
          .object({
            kind: z.enum(['click', 'check', 'select', 'fill']),
            label: z.string().min(1).max(160),
            role: z.string().max(40).optional(),
          })
          .strict(),
      )
      .max(5),
    expectedGoal: z.string().max(120).optional(),
    evidenceIds: z.array(z.string().max(60)).max(20),
    uncertainties: z.array(z.string().max(200)).max(10),
  })
  .strict();
export type AdvisorProposal = z.infer<typeof advisorProposalSchema>;

/** Un conseiller : il PROPOSE. Il ne clique jamais, ne voit jamais Playwright, ne décide pas. */
export interface ReasoningAdvisor {
  readonly name: string;
  advise(problem: ReasoningProblem): Promise<unknown>;
}

/** Le conseiller par défaut : aucune proposition nouvelle, rien d'externe (déterministe). */
export class DeterministicReasoningAdvisor implements ReasoningAdvisor {
  readonly name = 'deterministic';

  advise(problem: ReasoningProblem): Promise<AdvisorProposal> {
    // Rien d'inventé : une action autorisée qui partage des mots avec le but, si elle existe.
    const goalWords = new Set(
      normalizeControl(problem.goal)
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length > 2),
    );
    const match = problem.allowedActions.find((action) =>
      normalizeControl(action.label)
        .split(/[^a-z0-9]+/)
        .some((word) => goalWords.has(word)),
    );
    return Promise.resolve({
      candidateActions: match ? [match] : [],
      evidenceIds: [],
      uncertainties: match ? [] : ['no allowed action relates to the goal'],
    });
  }
}

/**
 * Le conseiller LLM, OPTIONNEL : aucune dépendance à un fournisseur dans le cœur. Il ne peut
 * exister que si l'appelant lui donne une fonction `complete` (le code d'intégration reste
 * hors de QA-Crawler). Le prompt est construit à partir du ReasoningProblem borné.
 */
export class LLMReasoningAdvisor implements ReasoningAdvisor {
  readonly name = 'llm';

  constructor(private readonly complete: (prompt: string) => Promise<string>) {}

  async advise(problem: ReasoningProblem): Promise<unknown> {
    const prompt = [
      'You advise a QA crawler. Answer ONLY with JSON matching:',
      '{"hypothesis"?: string, "candidateIntent"?: string, "candidateActions": [{"kind": "click"|"check"|"select"|"fill", "label": string, "role"?: string}], "expectedGoal"?: string, "evidenceIds": string[], "uncertainties": string[]}',
      'Only propose actions from allowedActions. Cite evidence ids you rely on.',
      JSON.stringify(problem),
    ].join('\n');
    const text = await this.complete(prompt);
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return { invalid: 'no JSON object in the answer' };
    try {
      return JSON.parse(text.slice(start, end + 1)) as unknown;
    } catch {
      return { invalid: 'unparseable JSON' };
    }
  }
}

export type ProposalVerdict =
  | {
      status: 'ACCEPTED';
      actions: AdvisorProposal['candidateActions'];
      hypothesisId?: string;
      reasons: string[];
    }
  | { status: 'REJECTED'; reasons: string[]; hypothesisId?: string };

/**
 * LE LLM NE CLIQUE JAMAIS (§77) :
 *
 *   proposition → validation du schéma → validation des preuves → résolution des candidats
 *   → (l'appelant) SafetyPolicy → exécuteur déterministe → vérification de l'effet au runtime
 *
 * - une action qui n'existe ni à l'écran (ActionDiscovery) ni dans une source fiable est
 *   REJETÉE (hallucination) ;
 * - une preuve citée qui n'existe pas fait rejeter la proposition ;
 * - une affirmation (hypothesis) devient au plus une HYPOTHÈSE (preuve LLM_PROPOSAL), jamais
 *   une connaissance confirmée.
 */
export function validateProposal(
  raw: unknown,
  problem: ReasoningProblem,
  knownEvidence: (id: string) => boolean,
  hypotheses?: { engine: HypothesisEngine; addEvidence: (input: Omit<Evidence, 'id'>) => Evidence },
): ProposalVerdict {
  const parsed = advisorProposalSchema.safeParse(raw);
  if (!parsed.success)
    return {
      status: 'REJECTED',
      reasons: [
        `schema: ${parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; ')}`,
      ],
    };
  const proposal = parsed.data;
  const unknownEvidence = proposal.evidenceIds.filter((id) => !knownEvidence(id));
  if (unknownEvidence.length > 0)
    return { status: 'REJECTED', reasons: [`unknown evidence: ${unknownEvidence.join(', ')}`] };
  let hypothesisId: string | undefined;
  if (proposal.hypothesis && hypotheses) {
    const proof = hypotheses.addEvidence({
      type: 'LLM_PROPOSAL',
      source: 'reasoning advisor',
      confidence: 0.5,
      details: { trigger: problem.trigger, evidenceIds: proposal.evidenceIds },
    });
    hypothesisId = hypotheses.engine.propose(
      { kind: 'BUSINESS_RULE', subject: 'advisor', relation: 'CLAIMS', object: proposal.hypothesis },
      proof,
      { testable: false, reason: 'an advisor claim: to be verified at runtime' },
    ).id;
  }
  const exists = (action: AdvisorProposal['candidateActions'][number]): boolean =>
    problem.allowedActions.some(
      (allowed) =>
        normalizeControl(allowed.label) === normalizeControl(action.label) &&
        allowed.kind === action.kind &&
        (!action.role || !allowed.role || allowed.role === action.role),
    );
  const unknown = proposal.candidateActions.filter((action) => !exists(action));
  if (unknown.length > 0)
    return {
      status: 'REJECTED',
      reasons: unknown.map(
        (action) => `hallucinated action: ${action.kind} "${action.label}" exists in no evidence source`,
      ),
      ...(hypothesisId ? { hypothesisId } : {}),
    };
  if (proposal.candidateActions.length === 0)
    return {
      status: 'REJECTED',
      reasons: ['no candidate action'],
      ...(hypothesisId ? { hypothesisId } : {}),
    };
  return {
    status: 'ACCEPTED',
    actions: proposal.candidateActions,
    reasons: ['schema valid', 'evidence ids exist', 'every action exists on screen'],
    ...(hypothesisId ? { hypothesisId } : {}),
  };
}

/** QUAND consulter (§73–§74) : seulement si le déterministe ne suffit pas, et dans le budget. */
export function shouldConsultAdvisor(input: {
  exactLocatorFound: boolean;
  planKnown: boolean;
  confidence: number;
  trigger?: AdvisorTrigger;
  callsUsed: number;
  maxCalls: number;
}): boolean {
  if (input.callsUsed >= input.maxCalls) return false;
  if (input.exactLocatorFound || input.planKnown || input.confidence >= 0.8) return false;
  return input.trigger !== undefined;
}
