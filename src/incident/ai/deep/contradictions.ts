import { redactText } from '../../../security/redactor.js';
import {
  MAX_CONTRADICTIONS,
  type AiAgentName,
  type AiContradiction,
  type AiExperimentProposal,
  type AiRef,
  type InvestigationMemory,
  type InvestigationMemoryEvent,
} from '../../../sdk/core/incident-ai-contracts.js';
import type { Experiment, Incident, ProposedVerification } from '../../../sdk/core/incident-contracts.js';
import { verificationParamsProblems } from '../schemas/analysis.js';
import type { ContradictionFindings, ContradictionRefLookup } from '../schemas/contradiction.js';

/**
 * LES CONTRADICTIONS DE L'INVESTIGATION APPROFONDIE : de la sortie du chasseur vers le contrat `AiContradiction`,
 * puis leur vie dans la mémoire.
 *
 * - `toContradictions` / `convertContradictions` : une sortie validée vers des `AiContradiction` OPEN, identifiées
 *   `ctr-<n>` à la suite de celles déjà en mémoire, dédoublonnées ; une hypothèse inconnue est écartée (jamais
 *   inventée), une référence inconnue est retirée, et un élément qui n'en garde aucune devient une question
 *   ouverte ; les résumés sont masqués ; le total reste sous MAX_CONTRADICTIONS.
 * - `dedupeContradictions` : même hypothèse, même sorte, et même résumé normalisé ou mêmes références.
 * - `resolveContradiction` : seule l'expérience liée (`proposalId`) tranche, et seulement DONE avec un résultat :
 *   SUPPORTS l'hypothèse ⇒ RESOLVED_SUPPORTS, REFUTES ⇒ RESOLVED_CONTRADICTS, NEUTRAL ⇒ reste OPEN. Rien d'autre
 *   ne ferme une contradiction, sauf une personne (`dismissContradiction`).
 * - `openContradictions`, `decisiveOpenContradictions` : ce que la politique d'arrêt regarde.
 */

export const CONTRADICTION_ID_PREFIX = 'ctr-';

/** Un indice de vérification décisive, rattaché à la contradiction qu'il trancherait. */
export interface ContradictionVerificationHint {
  contradictionId: string;
  hypothesisId: string;
  verification: ProposedVerification;
}

export interface ContradictionConversion {
  contradictions: AiContradiction[];
  hints: ContradictionVerificationHint[];
  /** Ce qui a été écarté et pourquoi (pour les limites du run). */
  dropped: string[];
}

export interface ConvertContradictionsOptions {
  /** Les contradictions déjà en mémoire : numérotation à la suite, dédoublonnage, plafond. */
  existing?: readonly AiContradiction[];
  /** L'incident, pour vérifier les paramètres des indices de vérification (sans lui, les indices passent tels quels). */
  incident?: Incident;
}

/** Le prochain numéro libre de `ctr-<n>` parmi des identifiants existants. */
export function nextContradictionNumber(existing: Iterable<{ id: string }>): number {
  let max = 0;
  for (const { id } of existing) {
    if (!id.startsWith(CONTRADICTION_ID_PREFIX)) continue;
    const n = Number(id.slice(CONTRADICTION_ID_PREFIX.length));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return max + 1;
}

/** La sortie validée du chasseur vers des `AiContradiction` (voir `convertContradictions` pour les indices). */
export function toContradictions(
  output: ContradictionFindings,
  refIndex: ContradictionRefLookup,
  agent: AiAgentName,
  now: string,
  options: ConvertContradictionsOptions = {},
): AiContradiction[] {
  return convertContradictions(output, refIndex, agent, now, options).contradictions;
}

export function convertContradictions(
  output: ContradictionFindings,
  refIndex: ContradictionRefLookup,
  agent: AiAgentName,
  now: string,
  options: ConvertContradictionsOptions = {},
): ContradictionConversion {
  const existing = options.existing ?? [];
  const dropped: string[] = [];
  const hints: ContradictionVerificationHint[] = [];
  const candidates: { contradiction: AiContradiction; verification?: ProposedVerification }[] = [];
  let next = nextContradictionNumber(existing);

  output.contradictions.forEach((item, position) => {
    const where = `contradictions[${String(position)}]`;
    if (!refIndex.has({ kind: 'hypothesis', id: item.hypothesisId })) {
      dropped.push(`${where}: hypothèse inconnue « ${item.hypothesisId} », élément écarté`);
      return;
    }
    const refs: AiRef[] = [];
    const seen = new Set<string>();
    for (const ref of item.refs) {
      const key = `${ref.kind}:${ref.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (refIndex.has(ref)) refs.push({ kind: ref.kind, id: ref.id });
      else dropped.push(`${where}: référence inconnue ${ref.kind} « ${ref.id} », retirée`);
    }
    const openQuestion = item.openQuestion || refs.length === 0;
    if (openQuestion && !item.openQuestion)
      dropped.push(`${where}: aucune référence connue, requalifié en question ouverte`);
    const contradiction: AiContradiction = {
      id: `${CONTRADICTION_ID_PREFIX}${String(next)}`,
      hypothesisId: item.hypothesisId,
      kind: item.kind,
      summary: redactText(item.summary),
      refs,
      openQuestion,
      status: 'OPEN',
      foundBy: agent,
      at: now,
    };
    let verification: ProposedVerification | undefined;
    if (item.decisiveVerification) {
      const problems = options.incident
        ? verificationParamsProblems(
            item.decisiveVerification.kind,
            item.decisiveVerification.params,
            options.incident,
          )
        : [];
      if (problems.length === 0)
        verification = {
          kind: item.decisiveVerification.kind,
          description: redactText(item.decisiveVerification.description),
          params: { ...item.decisiveVerification.params },
        };
      else dropped.push(`${where}.decisiveVerification écartée : ${problems.join(' ; ')}`);
    }
    candidates.push(verification ? { contradiction, verification } : { contradiction });
    next += 1;
  });

  const kept = dedupeContradictions(
    candidates.map((candidate) => candidate.contradiction),
    existing,
  );
  const room = Math.max(0, MAX_CONTRADICTIONS - existing.length);
  if (kept.length > room)
    dropped.push(
      `${String(kept.length - room)} contradiction(s) au-delà du plafond (${String(MAX_CONTRADICTIONS)}) écartée(s)`,
    );
  const contradictions = renumber(kept.slice(0, room), nextContradictionNumber(existing));
  const idByOriginal = new Map<string, string>();
  kept.slice(0, room).forEach((original, index) => {
    const renumbered = contradictions[index];
    if (renumbered) idByOriginal.set(original.id, renumbered.id);
  });
  for (const candidate of candidates) {
    const id = idByOriginal.get(candidate.contradiction.id);
    if (id && candidate.verification)
      hints.push({
        contradictionId: id,
        hypothesisId: candidate.contradiction.hypothesisId,
        verification: candidate.verification,
      });
  }
  const duplicates = candidates.length - kept.length;
  if (duplicates > 0) dropped.push(`${String(duplicates)} doublon(s) de contradiction écarté(s)`);
  return { contradictions, hints, dropped };
}

function renumber(items: readonly AiContradiction[], from: number): AiContradiction[] {
  return items.map((item, index) => ({ ...item, id: `${CONTRADICTION_ID_PREFIX}${String(from + index)}` }));
}

/** Un résumé normalisé pour le dédoublonnage : minuscules, sans ponctuation ni espaces multiples. */
export function normalizeSummary(summary: string): string {
  return summary
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const refsKey = (refs: readonly AiRef[]): string =>
  [...new Set(refs.map((ref) => `${ref.kind}:${ref.id}`))].sort().join(',');

/** Deux contradictions sont les mêmes : même hypothèse, même sorte, et même résumé normalisé ou mêmes références (non vides). */
export function sameContradiction(
  left: Pick<AiContradiction, 'hypothesisId' | 'kind' | 'summary' | 'refs'>,
  right: Pick<AiContradiction, 'hypothesisId' | 'kind' | 'summary' | 'refs'>,
): boolean {
  if (left.hypothesisId !== right.hypothesisId || left.kind !== right.kind) return false;
  if (normalizeSummary(left.summary) === normalizeSummary(right.summary)) return true;
  const leftRefs = refsKey(left.refs);
  return leftRefs !== '' && leftRefs === refsKey(right.refs);
}

/** Les nouvelles contradictions qui ne doublent ni une existante ni une précédente de la même liste. */
export function dedupeContradictions(
  incoming: readonly AiContradiction[],
  existing: readonly AiContradiction[] = [],
): AiContradiction[] {
  const kept: AiContradiction[] = [];
  for (const candidate of incoming) {
    if (existing.some((item) => sameContradiction(item, candidate))) continue;
    if (kept.some((item) => sameContradiction(item, candidate))) continue;
    kept.push(candidate);
  }
  return kept;
}

/** La contradiction rattachée à la proposition de vérification qui la trancherait. */
export function linkDecisiveProposal(contradiction: AiContradiction, proposalId: string): AiContradiction {
  return contradiction.proposalId === proposalId ? contradiction : { ...contradiction, proposalId };
}

/**
 * Le résultat d'une expérience sur une contradiction. Seule l'expérience LIÉE tranche : `experiment.id` est le
 * `proposalId`, ou la proposition passée porte ce `proposalId` et son `experimentId` est celui de l'expérience.
 * Il faut une expérience DONE avec un résultat ; une contradiction déjà fermée ne change plus. SUPPORTS
 * (l'hypothèse tient) ⇒ RESOLVED_SUPPORTS ; REFUTES ⇒ RESOLVED_CONTRADICTS ; NEUTRAL ⇒ reste OPEN, l'expérience
 * est citée. Sans lien ou sans résultat : le même objet est rendu.
 */
export function resolveContradiction(
  contradiction: AiContradiction,
  experiment: Experiment,
  options: { proposal?: Pick<AiExperimentProposal, 'id' | 'experimentId'> } = {},
): AiContradiction {
  if (contradiction.status !== 'OPEN') return contradiction;
  if (!isLinked(contradiction, experiment, options.proposal)) return contradiction;
  if (experiment.status !== 'DONE' || experiment.outcome === undefined) return contradiction;
  const ref: AiRef = { kind: 'experiment', id: experiment.id };
  const refs = contradiction.refs.some((item) => item.kind === ref.kind && item.id === ref.id)
    ? contradiction.refs
    : [...contradiction.refs, ref];
  switch (experiment.outcome) {
    case 'SUPPORTS':
      return { ...contradiction, refs, status: 'RESOLVED_SUPPORTS' };
    case 'REFUTES':
      return { ...contradiction, refs, status: 'RESOLVED_CONTRADICTS' };
    case 'NEUTRAL':
      return { ...contradiction, refs };
  }
}

function isLinked(
  contradiction: AiContradiction,
  experiment: Experiment,
  proposal: Pick<AiExperimentProposal, 'id' | 'experimentId'> | undefined,
): boolean {
  if (contradiction.proposalId === undefined) return false;
  if (contradiction.proposalId === experiment.id) return true;
  return (
    proposal !== undefined &&
    proposal.id === contradiction.proposalId &&
    proposal.experimentId === experiment.id
  );
}

/** Toutes les contradictions, mises à jour par les expériences liées (celles qui ne le sont pas restent identiques). */
export function resolveContradictions(
  contradictions: readonly AiContradiction[],
  experiments: readonly Experiment[],
  proposals: readonly Pick<AiExperimentProposal, 'id' | 'experimentId'>[] = [],
): AiContradiction[] {
  return contradictions.map((contradiction) => {
    let current = contradiction;
    for (const experiment of experiments) {
      const proposal = proposals.find((item) => item.id === current.proposalId);
      current = resolveContradiction(current, experiment, proposal ? { proposal } : {});
      if (current.status !== 'OPEN') break;
    }
    return current;
  });
}

/** Une personne écarte une contradiction (la raison est ajoutée au résumé, masquée) ; jamais le modèle. */
export function dismissContradiction(contradiction: AiContradiction, reason?: string): AiContradiction {
  if (contradiction.status === 'DISMISSED') return contradiction;
  const summary = reason
    ? `${contradiction.summary} — écartée : ${redactText(reason)}`
    : contradiction.summary;
  return { ...contradiction, summary, status: 'DISMISSED' };
}

/** Les contradictions encore ouvertes (toutes, ou celles d'une hypothèse). */
export function openContradictions(
  memory: Pick<InvestigationMemory, 'contradictions'>,
  hypothesisId?: string,
): AiContradiction[] {
  return memory.contradictions.filter(
    (item) => item.status === 'OPEN' && (hypothesisId === undefined || item.hypothesisId === hypothesisId),
  );
}

/** Les contradictions ouvertes qu'une vérification identifiée trancherait (ce que la politique d'arrêt regarde). */
export function decisiveOpenContradictions(
  memory: Pick<InvestigationMemory, 'contradictions'>,
): AiContradiction[] {
  return openContradictions(memory).filter((item) => item.proposalId !== undefined);
}

/** Les contradictions d'une hypothèse, quel que soit leur statut. */
export function contradictionsOf(
  memory: Pick<InvestigationMemory, 'contradictions'>,
  hypothesisId: string,
): AiContradiction[] {
  return memory.contradictions.filter((item) => item.hypothesisId === hypothesisId);
}

/** L'événement de chronologie d'une contradiction (structuré, avec ses références ; jamais une transcription). */
export function contradictionEvent(
  contradiction: AiContradiction,
  eventId: string,
): InvestigationMemoryEvent {
  const label = contradiction.openQuestion ? 'Question ouverte' : 'Contradiction';
  return {
    id: eventId,
    at: contradiction.at,
    kind: 'CONTRADICTION',
    agent: contradiction.foundBy,
    summary: `${label} (${contradiction.kind}) sur ${contradiction.hypothesisId} : ${contradiction.summary}`,
    refs: [{ kind: 'hypothesis', id: contradiction.hypothesisId }, ...contradiction.refs],
    hypothesisId: contradiction.hypothesisId,
  };
}
