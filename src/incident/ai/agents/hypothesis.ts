import type { AiRef, AiSourceLocation } from '../../../sdk/core/incident-ai-contracts.js';
import type { Hypothesis } from '../../../sdk/core/incident-contracts.js';
import type {
  AgentLoopResult,
  AgentOutcome,
  AgentRunContext,
  InvestigationAgent,
  InvestigationToolName,
} from '../agent.js';
import {
  assignHypothesisIds,
  refLookupOf,
  sameHypothesis,
  validateCitations,
  type RefLookup,
} from '../merge.js';
import { dataSection } from '../prompts/evidence.js';
import { HYPOTHESIS_SYSTEM, HYPOTHESIS_TASK } from '../prompts/hypothesis.js';
import {
  HYPOTHESIS_PROPOSALS_JSON_SCHEMA,
  HypothesisProposalsModelSchema,
  type HypothesisProposal,
  type HypothesisProposals,
  type HypothesisProposalsModel,
} from '../schemas/analysis.js';
import { agentBounds } from './evidence-analysis.js';

/**
 * L'AGENT D'HYPOTHÈSES : des propositions au contrat `Hypothesis` (titre, description, cause, couche,
 * fichiers, références favorables et contraires avec leurs faits, confiance indicative ≤ 0,7, pistes de
 * vérification). Les identifiants `hyp-ai-<n>` sont attribués par le moteur à la suite des existants ; une
 * proposition qui recoupe une hypothèse existante (titre ou cause) reprend l'identifiant de celle-ci, pour que
 * la fusion lui apporte ses références sans créer de doublon.
 */

export const HYPOTHESIS_TOOLS: readonly InvestigationToolName[] = [
  'get_evidence',
  'get_request',
  'find_symbol',
  'read_source',
];

/** Les hypothèses déjà proposées plus tôt dans le run (ré-évaluation AI_AGENTIC), si l'orchestrateur les garde. */
function previousProposals(ctx: Pick<AgentRunContext, 'previous'>): HypothesisProposal[] {
  const previous = ctx.previous.HYPOTHESIS as Partial<HypothesisProposals> | undefined;
  return (previous?.hypotheses ?? []).filter(
    (item): item is HypothesisProposal => typeof item.id === 'string',
  );
}

export function hypothesisRefs(output: HypothesisProposalsModel): {
  refs: AiRef[];
  locations: AiSourceLocation[];
} {
  return {
    refs: [
      ...output.hypotheses.flatMap((item) =>
        [...item.supporting, ...item.contradicting].map((cited) => cited.ref),
      ),
      ...output.existing.flatMap((item) => item.refs),
    ],
    locations: output.hypotheses.flatMap((item) => item.locations),
  };
}

export function validateHypotheses(
  output: HypothesisProposalsModel,
  lookup: RefLookup,
  knownHypothesisIds: readonly string[],
): string[] {
  const { refs, locations } = hypothesisRefs(output);
  const reasons = validateCitations(lookup, refs, locations);
  for (const item of output.existing)
    if (!knownHypothesisIds.includes(item.hypothesisId))
      reasons.push(`unknown hypothesis "${item.hypothesisId}" in existing: assess only listed hypotheses`);
  return [...new Set(reasons)];
}

/** Attribue les identifiants : celui de l'hypothèse existante recoupée, sinon le prochain `hyp-ai-<n>`. */
export function identifyProposals(
  output: HypothesisProposalsModel,
  existing: readonly Pick<Hypothesis, 'id' | 'title' | 'suspectedCause'>[],
  previous: readonly HypothesisProposal[] = [],
): HypothesisProposals {
  const known = [...existing, ...previous];
  const fresh = output.hypotheses.filter((item) => !known.some((other) => sameHypothesis(other, item)));
  const identified = assignHypothesisIds(
    fresh,
    known.map((item) => item.id),
  );
  const hypotheses = output.hypotheses.map((item) => {
    const match = known.find((other) => sameHypothesis(other, item));
    return match
      ? { ...item, id: match.id }
      : (identified.find((other) => other.title === item.title) ?? { ...item, id: '' });
  });
  return { ...output, hypotheses: hypotheses.filter((item) => item.id !== '') };
}

/** Le résumé des hypothèses déjà présentes, pour que le modèle ne les duplique pas (données). */
export function hypothesesDigest(
  hypotheses: readonly Pick<
    Hypothesis,
    'id' | 'title' | 'suspectedCause' | 'layer' | 'status' | 'confidence'
  >[],
): {
  id: string;
  title: string;
  suspectedCause: string;
  layer: string;
  status: string;
  confidence: number;
}[] {
  return hypotheses.map(({ id, title, suspectedCause, layer, status, confidence }) => ({
    id,
    title,
    suspectedCause,
    layer,
    status,
    confidence,
  }));
}

export function createHypothesisAgent(): InvestigationAgent<HypothesisProposals> {
  return {
    name: 'HYPOTHESIS',
    applies(ctx) {
      const { reproductions } = ctx.incident.investigation;
      const previous = ctx.previous;
      return (
        reproductions.length > 0 ||
        previous.EVIDENCE_ANALYSIS !== undefined ||
        previous.CROSS_LAYER !== undefined ||
        previous.FRONTEND !== undefined ||
        previous.BFF !== undefined ||
        previous.BACKEND !== undefined
      );
    },
    async run(ctx): Promise<AgentOutcome<HypothesisProposals>> {
      const existing = ctx.incident.investigation.hypotheses;
      const previous = previousProposals(ctx);
      const knownIds = [...existing.map((item) => item.id), ...previous.map((item) => item.id)];
      const packs = [
        ctx.packs.incident(),
        ctx.packs.requests({ errorsOnly: true }),
        ctx.packs.hypotheses(),
        ctx.packs.experiments(),
      ];
      const packRefs = packs.flatMap((pack) => pack.refs);
      const user = [
        ...packs.map((pack) => pack.text),
        dataSection('Existing hypotheses (ids to assess, never to duplicate)', hypothesesDigest(existing)),
        previous.length > 0
          ? dataSection(
              'Hypotheses proposed earlier in this run',
              previous.map((item) => ({
                id: item.id,
                title: item.title,
                suspectedCause: item.suspectedCause,
              })),
            )
          : '',
        dataSection('Evidence analysis (previous agent output)', ctx.previous.EVIDENCE_ANALYSIS),
        dataSection('Frontend findings (previous agent output)', ctx.previous.FRONTEND),
        dataSection('BFF findings (previous agent output)', ctx.previous.BFF),
        dataSection('Backend findings (previous agent output)', ctx.previous.BACKEND),
        dataSection('Cross-layer findings (previous agent output)', ctx.previous.CROSS_LAYER),
        HYPOTHESIS_TASK,
      ]
        .filter((part) => part.length > 0)
        .join('\n\n');
      const raw = await ctx.loop<HypothesisProposalsModel>({
        agent: 'HYPOTHESIS',
        system: HYPOTHESIS_SYSTEM,
        user,
        tools: HYPOTHESIS_TOOLS,
        schema: HypothesisProposalsModelSchema,
        outputSchema: HYPOTHESIS_PROPOSALS_JSON_SCHEMA,
        ...agentBounds(ctx),
        validate: (output) => validateHypotheses(output, refLookupOf(ctx, packRefs), knownIds),
      });
      const limitations = [...new Set(packs.flatMap((pack) => pack.omitted))];
      const identified = raw.output ? identifyProposals(raw.output, existing, previous) : undefined;
      if (raw.output && identified)
        for (const item of identified.hypotheses)
          if (existing.some((other) => other.id === item.id))
            limitations.push(
              `Proposition IA « ${item.title} » recoupe l'hypothèse ${item.id} : ses références lui sont ajoutées, aucun doublon créé.`,
            );
      const { output: _dropped, ...rest } = raw;
      const result: AgentLoopResult<HypothesisProposals> = identified
        ? { ...rest, output: identified }
        : rest;
      return { agent: 'HYPOTHESIS', result, limitations };
    },
  };
}

export const hypothesisAgent = createHypothesisAgent();
