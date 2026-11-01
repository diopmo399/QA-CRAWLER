import { redactText } from '../../security/redactor.js';
import {
  MAX_AI_HYPOTHESIS_CONFIDENCE,
  type AiExperimentProposal,
  type AiFinding,
  type AiRef,
  type AiSourceLocation,
  type AiSuggestedRelation,
} from '../../sdk/core/incident-ai-contracts.js';
import type {
  GraphEdge,
  Hypothesis,
  Incident,
  InvestigationGraph,
  ProposedVerification,
} from '../../sdk/core/incident-contracts.js';
import type { AgentRunContext } from './agent.js';
import {
  hasSideEffects,
  verificationParamsProblems,
  type CrossLayerFindings,
  type EvidenceAnalysis,
  type HypothesisProposal,
  type HypothesisProposals,
  type VerificationPlan,
} from './schemas/analysis.js';

/**
 * LA FUSION DES SORTIES IA DANS L'INCIDENT : des propositions vers les contrats déterministes.
 *
 * - `toHypotheses` : des propositions validées vers des `Hypothesis` `hyp-ai-<n>`, origin AI, PROPOSED,
 *   confiance plafonnée, références inconnues écartées (jamais fabriquées).
 * - `mergeHypotheses` : la fusion par titre ou cause, à la manière de `service.analyze` ; l'hypothèse de
 *   règle existante gagne toujours, le doublon IA lui apporte ses références.
 * - `toProposals` : le plan de vérification vers des `AiExperimentProposal` exécutables par le chemin ordinaire.
 * - `toGraphRelations` : les relations suggérées vers des arêtes INFERRED, seulement entre nœuds existants.
 * - `resolveContradictions` : les constats qui se contredisent, signalés dans les limites du run.
 * Rien ici n'écrit un statut autre que PROPOSED ni ne touche au diagnostic.
 */

export const AI_HYPOTHESIS_PREFIX = 'hyp-ai-';
export const AI_RELATION_PREFIX = 'IA : ';

/** Ce qu'il faut savoir pour valider une référence (satisfait par `RefIndex` de refs.ts). */
export interface RefLookup {
  has(ref: AiRef): boolean;
  hasLocation(location: AiSourceLocation): boolean;
}

const normalizeFile = (file: string): string => file.replace(/\\/g, '/').replace(/^\.\//, '');

/**
 * Un `RefLookup` construit depuis l'incident seul (requêtes, preuves — vérifications comprises —, symboles,
 * fichiers de l'index, nœuds et arêtes, hypothèses, vérifications), complété par les identifiants permis
 * (`extra`, par exemple les `refs` des paquets de preuves) et les fichiers lus pendant le run.
 */
export function incidentRefLookup(
  incident: Incident,
  options: { extra?: Iterable<AiRef>; files?: Iterable<AiSourceLocation> } = {},
): RefLookup {
  const ids = new Map<string, Set<string>>();
  const add = (kind: AiRef['kind'], id: string): void => {
    const set = ids.get(kind) ?? new Set<string>();
    set.add(id);
    ids.set(kind, set);
  };
  const files = new Set<string>();
  const addFile = (applicationId: string | undefined, file: string | undefined): void => {
    if (!file) return;
    const clean = normalizeFile(file);
    files.add(clean);
    if (applicationId) files.add(`${applicationId}:${clean}`);
  };
  const { investigation } = incident;
  for (const run of investigation.reproductions) {
    add('evidence', run.id);
    for (const request of run.requests) add('request', request.id);
    for (const item of run.evidence) add('evidence', item.id);
  }
  for (const experiment of investigation.experiments) {
    add('experiment', experiment.id);
    for (const item of experiment.evidence) add('evidence', item.id);
  }
  for (const hypothesis of investigation.hypotheses) {
    add('hypothesis', hypothesis.id);
    for (const file of hypothesis.files) addFile(undefined, file);
  }
  for (const symbol of investigation.code?.symbols ?? []) {
    add('symbol', symbol.id);
    addFile(symbol.applicationId, symbol.file);
  }
  for (const node of investigation.graph?.nodes ?? []) {
    add('node', node.id);
    addFile(node.source?.applicationId, node.file ?? node.source?.file);
  }
  for (const edge of investigation.graph?.edges ?? []) add('edge', `${edge.from}->${edge.to}`);
  for (const step of investigation.ai?.runs.flatMap((run) => run.plan) ?? []) add('step', step.id);
  for (const ref of options.extra ?? []) add(ref.kind, ref.id);
  for (const location of options.files ?? []) addFile(location.applicationId, location.file);
  const knownFile = (id: string): boolean => {
    const clean = normalizeFile(id);
    if (files.has(clean)) return true;
    // « application:chemin » : le chemin seul suffit quand il est connu.
    const colon = clean.indexOf(':');
    return colon > 0 && files.has(clean.slice(colon + 1));
  };
  return {
    has(ref) {
      if (ref.kind === 'file') return knownFile(ref.id) || (ids.get('file')?.has(ref.id) ?? false);
      return ids.get(ref.kind)?.has(ref.id) ?? false;
    },
    hasLocation(location) {
      return knownFile(`${location.applicationId}:${location.file}`) || knownFile(location.file);
    },
  };
}

/** Les fichiers lus par un outil de lecture pendant ce run (traces du registre), pour les citer. */
export function filesReadDuring(ctx: Pick<AgentRunContext, 'tools' | 'incident'>): AiSourceLocation[] {
  const apps = ctx.incident.scope.applications;
  return ctx.tools.calls
    .filter((call) => call.allowed && call.name === 'read_source')
    .map((call) => {
      const colon = call.target.indexOf(':');
      const applicationId = colon > 0 ? call.target.slice(0, colon) : undefined;
      const known = applicationId !== undefined && apps.some((app) => app.id === applicationId);
      return {
        applicationId: known ? applicationId : (apps[0]?.id ?? ''),
        file: normalizeFile(known ? call.target.slice(colon + 1) : call.target),
      };
    });
}

/** Le `RefLookup` d'un agent : l'incident, les paquets qu'il a reçus et les fichiers lus pendant le run. */
export function refLookupOf(ctx: AgentRunContext, packRefs: Iterable<AiRef> = []): RefLookup {
  return incidentRefLookup(ctx.incident, { extra: packRefs, files: filesReadDuring(ctx) });
}

/** Les raisons de rejet d'une sortie : chaque référence et chaque localisation doit exister. */
export function validateCitations(
  lookup: RefLookup,
  refs: Iterable<AiRef>,
  locations: Iterable<AiSourceLocation> = [],
): string[] {
  const reasons: string[] = [];
  for (const ref of refs)
    if (!lookup.has(ref)) reasons.push(`unknown ${ref.kind} reference "${ref.id}": cite only existing ids`);
  for (const location of locations)
    if (!lookup.hasLocation(location))
      reasons.push(
        `unknown file "${location.applicationId}:${location.file}": cite only files of the code index or files you read`,
      );
  return [...new Set(reasons)];
}

// ── Hypothèses ─────────────────────────────────────────────────────────────────────────────────

const round = (value: number): number => Math.round(value * 100) / 100;
const clampConfidence = (value: number): number =>
  round(Math.max(0.05, Math.min(MAX_AI_HYPOTHESIS_CONFIDENCE, value)));

/** Le prochain numéro libre de `hyp-ai-<n>` parmi des identifiants existants. */
export function nextAiHypothesisNumber(existingIds: Iterable<string>): number {
  let max = 0;
  for (const id of existingIds) {
    if (!id.startsWith(AI_HYPOTHESIS_PREFIX)) continue;
    const n = Number(id.slice(AI_HYPOTHESIS_PREFIX.length));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return max + 1;
}

/** Attribue les identifiants `hyp-ai-<n>` aux propositions, à la suite de ceux déjà pris. */
export function assignHypothesisIds<T extends object>(
  proposals: readonly T[],
  takenIds: Iterable<string>,
): (T & { id: string })[] {
  let next = nextAiHypothesisNumber(takenIds);
  return proposals.map((proposal) => ({ ...proposal, id: `${AI_HYPOTHESIS_PREFIX}${String(next++)}` }));
}

function toVerifications(
  proposal: HypothesisProposal,
  plan: VerificationPlan | undefined,
  incident: Incident,
): ProposedVerification[] {
  const planned = (plan?.proposals ?? [])
    .filter(
      (item) =>
        item.hypothesisId === proposal.id &&
        verificationParamsProblems(item.kind, item.params, incident).length === 0,
    )
    .sort((left, right) => left.priority - right.priority)
    .map((item) => ({
      kind: item.kind,
      description: redactText(item.description),
      params: { ...item.params },
    }));
  const hints = proposal.verificationHints
    .filter((hint) => verificationParamsProblems(hint.kind, hint.params, incident).length === 0)
    .map((hint) => ({
      kind: hint.kind,
      description: redactText(hint.description),
      params: { ...hint.params },
    }));
  const all = [...planned, ...hints];
  // Une sorte ne compte qu'une fois : la version planifiée d'abord.
  return all.filter((item, index) => all.findIndex((other) => other.kind === item.kind) === index);
}

/**
 * Des propositions vers des hypothèses du contrat : `hyp-ai-<n>`, origin AI, aiRunId, PROPOSED, confiance
 * plafonnée, références et fichiers validés (les inconnus sont écartés et listés dans `dropped`). Les
 * identifiants déjà portés par les propositions sont gardés ; sinon ils suivent `options.existing`.
 */
export function toHypotheses(
  proposals:
    HypothesisProposals | { hypotheses: readonly (HypothesisProposal | Omit<HypothesisProposal, 'id'>)[] },
  refIndex: RefLookup,
  runId: string,
  _now: string,
  options: { existing?: readonly Hypothesis[]; plan?: VerificationPlan; incident?: Incident } = {},
): { hypotheses: Hypothesis[]; dropped: string[] } {
  const existing = options.existing ?? [];
  const dropped: string[] = [];
  const taken = existing.map((hypothesis) => hypothesis.id);
  let next = nextAiHypothesisNumber(taken);
  const incident = options.incident ?? emptyIncidentFor(existing);
  const hypotheses: Hypothesis[] = [];
  for (const raw of proposals.hypotheses) {
    const id =
      'id' in raw && typeof raw.id === 'string' ? raw.id : `${AI_HYPOTHESIS_PREFIX}${String(next++)}`;
    const proposal: HypothesisProposal = { ...raw, id };
    const cite = (items: HypothesisProposal['supporting'], side: string): Hypothesis['supporting'] =>
      items.flatMap((item) => {
        if (refIndex.has(item.ref)) return [{ ref: item.ref.id, fact: redactText(item.fact) }];
        dropped.push(`${id}: ${side} reference "${item.ref.kind}:${item.ref.id}" unknown, dropped`);
        return [];
      });
    const supporting = cite(proposal.supporting, 'supporting');
    const contradicting = cite(proposal.contradicting, 'contradicting');
    if (supporting.length === 0) {
      dropped.push(`${id}: no valid supporting reference, hypothesis dropped (${proposal.title})`);
      continue;
    }
    const files = [
      ...new Set(
        proposal.locations.flatMap((location) => {
          if (refIndex.hasLocation(location)) return [normalizeFile(location.file)];
          dropped.push(`${id}: file "${location.applicationId}:${location.file}" unknown, dropped`);
          return [];
        }),
      ),
    ];
    hypotheses.push({
      id,
      title: redactText(proposal.title),
      description: redactText(proposal.description),
      suspectedCause: redactText(proposal.suspectedCause),
      layer: proposal.layer,
      files,
      supporting,
      contradicting,
      confidence: clampConfidence(proposal.confidence),
      verifications: toVerifications(proposal, options.plan, incident),
      status: 'PROPOSED',
      origin: 'AI',
      aiRunId: runId,
    });
  }
  return { hypotheses, dropped };
}

/** Un incident minimal pour valider des paramètres quand l'appelant n'en donne pas. */
function emptyIncidentFor(hypotheses: readonly Hypothesis[]): Incident {
  return {
    scope: { applications: [] },
    execution: { target: 'LOCAL' },
    investigation: { reproductions: [], hypotheses: [...hypotheses], experiments: [] },
  } as unknown as Incident;
}

const normalizeText = (text: string): string =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Deux hypothèses parlent de la même chose : même titre ou même cause (texte normalisé). */
export function sameHypothesis(
  left: Pick<Hypothesis, 'title' | 'suspectedCause'>,
  right: typeof left,
): boolean {
  return (
    normalizeText(left.title) === normalizeText(right.title) ||
    normalizeText(left.suspectedCause) === normalizeText(right.suspectedCause)
  );
}

function addRefs(target: Hypothesis, source: Hypothesis): Hypothesis {
  const known = new Set([...target.supporting, ...target.contradicting].map((item) => item.ref));
  const supporting = source.supporting.filter((item) => !known.has(item.ref));
  const contradicting = source.contradicting.filter((item) => !known.has(item.ref));
  const files = source.files.filter((file) => !target.files.includes(file));
  if (supporting.length === 0 && contradicting.length === 0 && files.length === 0) return target;
  return {
    ...target,
    supporting: [...target.supporting, ...supporting],
    contradicting: [...target.contradicting, ...contradicting],
    files: [...target.files, ...files],
  };
}

/**
 * La fusion à la manière de `service.analyze` : une hypothèse entrante dont le titre ou la cause existe
 * déjà n'est pas ajoutée ; l'existante (de règle ou IA) garde son identifiant, son statut et sa confiance et
 * reçoit les références de la doublonne. Les entrantes doublonnes entre elles sont fusionnées de même.
 */
export function mergeHypotheses(
  existing: readonly Hypothesis[],
  incoming: readonly Hypothesis[],
): Hypothesis[] {
  const result = [...existing];
  for (const candidate of incoming) {
    const index = result.findIndex((item) => sameHypothesis(item, candidate));
    if (index === -1) result.push(candidate);
    else {
      const current = result[index];
      if (current) result[index] = addRefs(current, candidate);
    }
  }
  return result;
}

// ── Propositions de vérification ───────────────────────────────────────────────────────────────

/**
 * Le plan de vérification vers des `AiExperimentProposal` PROPOSED : l'hypothèse doit exister (règle ou IA
 * du run), les paramètres doivent être ceux que l'exécuteur comprend ; le reste est écarté et expliqué.
 */
export function toProposals(
  plan: VerificationPlan,
  hypotheses: readonly Hypothesis[],
  incident: Incident,
  runId: string,
): { proposals: AiExperimentProposal[]; dropped: string[] } {
  const dropped: string[] = [];
  const proposals: AiExperimentProposal[] = [];
  const sorted = [...plan.proposals].sort((left, right) => left.priority - right.priority);
  for (const item of sorted) {
    const label = `${item.kind} for ${item.hypothesisId}`;
    if (!hypotheses.some((hypothesis) => hypothesis.id === item.hypothesisId)) {
      dropped.push(`${label}: unknown hypothesis, dropped`);
      continue;
    }
    const problems = verificationParamsProblems(item.kind, item.params, incident);
    if (problems.length > 0) {
      dropped.push(`${label}: ${problems.join('; ')}`);
      continue;
    }
    if (proposals.some((other) => other.hypothesisId === item.hypothesisId && other.kind === item.kind)) {
      dropped.push(`${label}: duplicate kind for the same hypothesis, dropped`);
      continue;
    }
    proposals.push({
      id: `${runId}:prop-${String(proposals.length + 1)}`,
      hypothesisId: item.hypothesisId,
      kind: item.kind,
      objective: redactText(item.objective),
      verification: {
        kind: item.kind,
        description: redactText(item.description),
        params: { ...item.params },
      },
      resources: item.resources.map(redactText),
      permissions: item.permissions.map(redactText),
      risks: item.risks.map(redactText),
      sideEffects: item.sideEffects || hasSideEffects(item.kind, item.params),
      expected: redactText(item.expected),
      confirmIf: redactText(item.confirmIf),
      refuteIf: redactText(item.refuteIf),
      status: 'PROPOSED',
    });
  }
  return { proposals, dropped };
}

// ── Relations ──────────────────────────────────────────────────────────────────────────────────

/**
 * Les relations suggérées vers des arêtes INFERRED (raison préfixée « IA : »), seulement quand les deux
 * nœuds existent et qu'aucune arête ne relie déjà ces nœuds ; jamais OBSERVED ni STATICALLY_RESOLVED.
 */
export function toGraphRelations(
  relations: readonly AiSuggestedRelation[],
  graph: InvestigationGraph | undefined,
): { edges: GraphEdge[]; skipped: string[] } {
  const edges: GraphEdge[] = [];
  const skipped: string[] = [];
  if (!graph)
    return { edges, skipped: relations.map((relation) => `${relation.from} → ${relation.to}: no graph`) };
  const nodes = new Set(graph.nodes.map((node) => node.id));
  const linked = (from: string, to: string): boolean =>
    [...graph.edges, ...edges].some((edge) => edge.from === from && edge.to === to);
  for (const relation of relations) {
    if (!nodes.has(relation.from) || !nodes.has(relation.to)) {
      skipped.push(`${relation.from} → ${relation.to}: unknown node`);
      continue;
    }
    if (relation.from === relation.to || linked(relation.from, relation.to)) {
      skipped.push(`${relation.from} → ${relation.to}: already linked`);
      continue;
    }
    edges.push({
      from: relation.from,
      to: relation.to,
      status: 'INFERRED',
      reason: `${AI_RELATION_PREFIX}${redactText(relation.reason)}`,
      evidence: relation.refs
        .filter((ref) => ref.kind === 'evidence' || ref.kind === 'request')
        .map((ref) => ref.id),
    });
  }
  return { edges, skipped };
}

// ── Contradictions ─────────────────────────────────────────────────────────────────────────────

const NEGATION =
  /\b(absent|absente|manque|manquant|manquante|missing|never|jamais|not|no|aucun|aucune|sans|without|pas)\b/;
const STOP_WORDS = new Set([
  'the',
  'and',
  'with',
  'from',
  'that',
  'this',
  'into',
  'dans',
  'pour',
  'avec',
  'cette',
  'field',
  'champ',
  'request',
  'requete',
  'response',
  'reponse',
  'value',
  'valeur',
]);
const BASIS_RANK = { OBSERVED: 0, STATICALLY_RESOLVED: 1, INFERRED: 2 } as const;

const subjectWords = (finding: AiFinding): Set<string> =>
  new Set(
    normalizeText(`${finding.title} ${finding.summary}`)
      .split(' ')
      .filter((word) => word.length >= 5 && !STOP_WORDS.has(word)),
  );

/** Deux constats se contredisent : même ancre (hypothèse ou référence), même sujet, polarités opposées. */
export function contradicts(left: AiFinding, right: AiFinding): boolean {
  const anchored =
    (left.hypothesisId !== undefined && left.hypothesisId === right.hypothesisId) ||
    left.refs.some((ref) => right.refs.some((other) => other.kind === ref.kind && other.id === ref.id));
  if (!anchored) return false;
  const leftNegated = NEGATION.test(normalizeText(`${left.title} ${left.summary}`));
  const rightNegated = NEGATION.test(normalizeText(`${right.title} ${right.summary}`));
  if (leftNegated === rightNegated) return false;
  const words = subjectWords(left);
  return [...subjectWords(right)].some((word) => words.has(word));
}

/**
 * Les constats en contradiction sont tous gardés (un constat est une donnée), l'observé passe devant le
 * déduit, et chaque paire est signalée dans les limites du run pour qu'une personne arbitre.
 */
export function resolveContradictions(findings: readonly AiFinding[]): {
  findings: AiFinding[];
  limitations: string[];
} {
  const limitations: string[] = [];
  const ordered = [...findings].sort((left, right) => BASIS_RANK[left.basis] - BASIS_RANK[right.basis]);
  for (let i = 0; i < ordered.length; i += 1)
    for (let j = i + 1; j < ordered.length; j += 1) {
      const left = ordered[i];
      const right = ordered[j];
      if (left && right && contradicts(left, right))
        limitations.push(
          `Constats contradictoires à arbitrer : « ${left.title} » (${left.agent}, ${left.basis}) et « ${right.title} » (${right.agent}, ${right.basis})${left.hypothesisId ? ` sur ${left.hypothesisId}` : ''}.`,
        );
    }
  // L'ordre d'origine est conservé pour l'affichage ; seul le tri de la détection privilégie l'observé.
  return { findings: [...findings], limitations };
}

// ── Constats (AiFinding) depuis les sorties des agents de corrélation ──────────────────────────

const finding = (
  agent: AiFinding['agent'],
  index: number,
  partial: Omit<AiFinding, 'id' | 'agent'>,
): AiFinding => ({ id: `${agent.toLowerCase()}-${String(index)}`, agent, ...partial });

/** L'analyse des preuves vers des constats : symptôme, incohérences et événements observés, pistes déduites. */
export function evidenceFindings(analysis: EvidenceAnalysis): AiFinding[] {
  const items: Omit<AiFinding, 'id' | 'agent'>[] = [
    {
      layer: 'UNKNOWN',
      title: 'Premier symptôme observable',
      summary: analysis.firstSymptom.summary,
      refs: analysis.firstSymptom.refs,
      locations: [],
      basis: 'OBSERVED',
    },
    ...analysis.inconsistencies.map((item) => ({
      layer: 'UNKNOWN' as const,
      title: 'Incohérence entre preuves',
      summary: item.summary,
      refs: item.refs,
      locations: [],
      basis: 'OBSERVED' as const,
    })),
    ...analysis.leads.map((lead) => ({
      layer: lead.layer,
      title: lead.title,
      summary: lead.summary,
      refs: lead.refs,
      locations: [],
      basis: 'INFERRED' as const,
    })),
  ];
  return items.map((item, index) => finding('EVIDENCE_ANALYSIS', index + 1, item));
}

/** La comparaison inter-couches vers des constats (la couche affichée est la dernière de la chaîne). */
export function crossLayerFindings(output: CrossLayerFindings): AiFinding[] {
  return output.findings.map((item, index) =>
    finding('CROSS_LAYER', index + 1, {
      layer: item.layers.at(-1) ?? 'UNKNOWN',
      title: item.title,
      summary: item.field ? `${item.summary} (champ : ${item.field})` : item.summary,
      refs: item.refs,
      locations: item.locations,
      basis: item.basis,
    }),
  );
}
