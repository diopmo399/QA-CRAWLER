import type {
  AiAgentName,
  AiFinding,
  AiInvestigationRun,
  AiRef,
  AiSourceLocation,
  HypothesisExploration,
  HypothesisRelation,
  HypothesisVerificationResult,
  InvestigationMemory,
} from '../../../sdk/core/incident-ai-contracts.js';
import type {
  CodeIndex,
  Diagnosis,
  Experiment,
  Hypothesis,
  Incident,
  Layer,
} from '../../../sdk/core/incident-contracts.js';
import { meetsConfirmation, ruleOf, supportingExperiments } from '../../hypotheses.js';

/**
 * L'EXPLORATION DES HYPOTHÈSES de l'investigation approfondie : ce que la mémoire garde EN PLUS de `Hypothesis`,
 * qui reste la vérité du moteur.
 *
 * - `buildExplorations` : une exploration par hypothèse (règle ou IA) ; les inconnues viennent des manques réels
 *   (aucune vérification, preuves contraires, code non localisé, confirmation incomplète, contradictions ouvertes) ;
 *   les emplacements viennent des fichiers et des symboles cités, jamais d'ailleurs.
 * - `applyVerificationResult` : l'effet d'une expérience terminée (SUPPORTS / CONTRADICTS / NEUTRAL), ajouté à
 *   l'exploration visée ; les autres hypothèses sont toujours conservées — une hypothèse soutenue n'en retire
 *   jamais une autre.
 * - `relateHypotheses` : COMPETES (même couche ou même famille de cause), CONTRIBUTES (plusieurs causes soutenues),
 *   EXCLUDES (la preuve qui soutient l'une réfute l'autre), REFINES (une hypothèse IA précise une règle, ou un
 *   constat relie l'une à l'autre).
 * - `rolesOf` : le rôle d'après le validateur déterministe. CONFIRMED_CAUSE seulement quand le statut du moteur
 *   est CONFIRMED et que `meetsConfirmation` le reste ; PROBABLE_CAUSE pour la cause racine PROBABLE ; CONTRIBUTING
 *   pour une hypothèse soutenue qui n'est pas la racine ; REFUTED ; UNVERIFIED (rien d'exécuté) ; UNKNOWN (exécuté
 *   sans trancher, ou hypothèse disparue). Rien ici n'écrit un statut ni ne touche au diagnostic.
 * - `uncertaintiesOf`, `reportRoles` : ce qui reste à savoir et le classement par rôle pour le rapport.
 */

export type ExplorationRole = HypothesisExploration['role'];
export type VerificationEffect = HypothesisVerificationResult['effect'];

export const EXPLORATION_ROLES: readonly ExplorationRole[] = [
  'CONFIRMED_CAUSE',
  'PROBABLE_CAUSE',
  'CONTRIBUTING_FACTOR',
  'REFUTED',
  'UNVERIFIED',
  'UNKNOWN',
];

/** Les familles de cause reconnues dans le titre ou la cause suspectée d'une hypothèse IA. */
export const CAUSE_FAMILIES = [
  'null-relation',
  'missing-validation',
  'backend-propagated',
  'server-error',
  'client-error',
  'network-failure',
  'frontend-error',
  'test-data',
  'environment',
  'mapping',
  'configuration',
] as const;
export type CauseFamily = (typeof CAUSE_FAMILIES)[number];

const FAMILY_PATTERNS: readonly { family: CauseFamily; pattern: RegExp }[] = [
  {
    family: 'null-relation',
    pattern: /null|nullpointer|d[ée]r[ée]f[ée]renc|optional\.get|absent[e]? |relation/i,
  },
  {
    family: 'missing-validation',
    pattern: /validation|@notnull|@notblank|@valid|non valid|champ (?:vide|manquant)/i,
  },
  {
    family: 'backend-propagated',
    pattern: /propag|renvoy[ée]e? telle quelle|transmise? telle quelle|backend .*(?:5\d\d|échoue)/i,
  },
  { family: 'mapping', pattern: /mapp|dto|transform|contrat|contract|champ perdu|lost field/i },
  { family: 'network-failure', pattern: /r[ée]seau|network|timeout|dns|connexion refus|connection refused/i },
  { family: 'client-error', pattern: /\b4\d\d\b|acc[èe]s refus|unauthorized|forbidden|bad request/i },
  { family: 'server-error', pattern: /\b5\d\d\b|erreur serveur|internal server error/i },
  { family: 'frontend-error', pattern: /javascript|console|react|composant|component|handler|rendu/i },
  { family: 'test-data', pattern: /donn[ée]es? de test|test data|jeu de donn|fixture|pr[ée]condition/i },
  { family: 'environment', pattern: /environnement|environment|configuration locale|profil|version/i },
  { family: 'configuration', pattern: /configur|propri[ée]t[ée]|property|yaml|yml|variable d['’]env/i },
];

/** La famille de cause : la règle du moteur quand l'id la porte, sinon ce que le texte de l'hypothèse dit. */
export function causeFamily(
  hypothesis: Pick<Hypothesis, 'id' | 'title' | 'suspectedCause'>,
): CauseFamily | undefined {
  const rule = ruleOf(hypothesis);
  if (rule) return rule;
  const text = `${hypothesis.title} ${hypothesis.suspectedCause}`;
  return FAMILY_PATTERNS.find((item) => item.pattern.test(text))?.family;
}

const SYMBOL_REF = /^([^:#\s]+):([^#\s]+)#(.+)$/;
const EXPERIMENT_REF = /^experiment:([A-Z_]+):(.+)$/;

const SUPPORTED_STATUSES: readonly Hypothesis['status'][] = ['SUPPORTED', 'CONFIRMED'];
const isSupported = (hypothesis: Hypothesis): boolean => SUPPORTED_STATUSES.includes(hypothesis.status);
const isLive = (hypothesis: Hypothesis): boolean => hypothesis.status !== 'REFUTED';

const byConfidence = (left: Hypothesis, right: Hypothesis): number =>
  right.confidence - left.confidence || left.id.localeCompare(right.id);

const unique = <T>(items: readonly T[], key: (item: T) => string): T[] => {
  const seen = new Set<string>();
  return items.filter((item) => {
    const id = key(item);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
};

const locationKey = (location: AiSourceLocation): string =>
  `${location.applicationId}|${location.file}|${String(location.line ?? '')}|${location.symbol ?? ''}`;
const relationKey = (relation: HypothesisRelation): string =>
  `${relation.from}|${relation.to}|${relation.kind}`;
const refKey = (ref: AiRef): string => `${ref.kind}:${ref.id}`;

// ── Effets des expériences ───────────────────────────────────────────────────────────────────

/** L'effet d'une expérience sur son hypothèse, dans le vocabulaire de l'exploration. */
export function effectOf(outcome: NonNullable<Experiment['outcome']>): VerificationEffect {
  return outcome === 'SUPPORTS' ? 'SUPPORTS' : outcome === 'REFUTES' ? 'CONTRADICTS' : 'NEUTRAL';
}

/** Le résultat de vérification d'une expérience terminée ; `undefined` tant qu'elle n'a pas tranché. */
export function verificationResultOf(
  experiment: Experiment,
  fallbackAt?: string,
): HypothesisVerificationResult | undefined {
  if (experiment.status !== 'DONE' || !experiment.outcome || !experiment.hypothesisId) return undefined;
  return {
    experimentId: experiment.id,
    at: experiment.finishedAt ?? experiment.startedAt ?? fallbackAt ?? new Date(0).toISOString(),
    effect: effectOf(experiment.outcome),
    summary: experiment.summary ?? `${experiment.kind} ${experiment.outcome} : ${experiment.description}`,
    refs: [
      { kind: 'experiment', id: experiment.id },
      ...experiment.evidence.map((item): AiRef => ({ kind: 'evidence', id: item.id })),
    ],
  };
}

// ── Emplacements ─────────────────────────────────────────────────────────────────────────────

function applicationOfFile(
  incident: Incident,
  code: CodeIndex | undefined,
  file: string,
  layer: Layer,
): string | undefined {
  const symbol = code?.symbols.find((item) => item.file === file);
  if (symbol) return symbol.applicationId;
  const applications = incident.scope.applications;
  if (applications.length === 1) return applications[0]?.id;
  const sameLayer = applications.filter((item) => item.layer === layer);
  if (sameLayer.length === 1) return sameLayer[0]?.id;
  const indexed = code?.applications ?? [];
  if (indexed.length === 1) return indexed[0]?.id;
  const indexedSameLayer = indexed.filter((item) => item.layer === layer);
  return indexedSameLayer.length === 1 ? indexedSameLayer[0]?.id : undefined;
}

/** Les emplacements d'une hypothèse : ses fichiers (application retrouvée, jamais devinée) et ses symboles cités. */
export function locationsOf(incident: Incident, hypothesis: Hypothesis): AiSourceLocation[] {
  const code = incident.investigation.code;
  const locations: AiSourceLocation[] = [];
  for (const item of [...hypothesis.supporting, ...hypothesis.contradicting]) {
    const match = SYMBOL_REF.exec(item.ref);
    if (!match) continue;
    const symbol = code?.symbols.find((candidate) => candidate.id === item.ref);
    if (symbol)
      locations.push({
        applicationId: symbol.applicationId,
        file: symbol.file,
        line: symbol.line,
        symbol: symbol.name,
      });
    else if (match[1] && match[2] && match[3])
      locations.push({ applicationId: match[1], file: match[2], symbol: match[3] });
  }
  for (const file of hypothesis.files) {
    const applicationId = applicationOfFile(incident, code, file, hypothesis.layer);
    if (!applicationId) continue;
    const symbol = code?.symbols.find(
      (candidate) => candidate.file === file && locations.some((loc) => loc.symbol === candidate.name),
    );
    locations.push(
      symbol ? { applicationId, file, line: symbol.line, symbol: symbol.name } : { applicationId, file },
    );
  }
  return unique(locations, locationKey);
}

// ── Inconnues ────────────────────────────────────────────────────────────────────────────────

/** Ce qu'on ne sait pas encore d'une hypothèse, d'après ses manques réels (jamais une liste générique). */
export function unknownsOf(
  hypothesis: Hypothesis,
  verifications: readonly HypothesisVerificationResult[],
  memory?: InvestigationMemory,
  diagnosis?: Diagnosis,
): string[] {
  const unknowns: string[] = [];
  if (hypothesis.status === 'REFUTED') return unknowns;
  const supports = supportingExperiments(hypothesis);
  const kinds = [...new Set(supports.map((item) => item.kind))];
  if (verifications.length === 0 && supports.length === 0)
    unknowns.push(
      'Aucune vérification exécutée : l’hypothèse repose seulement sur les preuves observées et le code lu.',
    );
  else if (hypothesis.status !== 'CONFIRMED' && kinds.length < 2)
    unknowns.push(
      `Confirmation incomplète : soutenue par ${kinds.length === 0 ? 'aucune vérification' : kinds.join(', ')} ; une seconde vérification d’une autre sorte est nécessaire.`,
    );
  if (verifications.length > 0 && verifications.every((item) => item.effect === 'NEUTRAL'))
    unknowns.push('Les vérifications exécutées n’ont rien tranché (résultats neutres).');
  if (hypothesis.contradicting.length > 0)
    unknowns.push(
      `Preuves contraires non expliquées : ${hypothesis.contradicting.map((item) => item.fact).join(' ; ')}.`,
    );
  if (hypothesis.files.length === 0)
    unknowns.push('Code non localisé : aucun fichier ne porte la cause suspectée.');
  if (hypothesis.layer === 'UNKNOWN')
    unknowns.push('Couche inconnue : la cause n’est rattachée à aucune application.');
  if (hypothesis.origin === 'AI' && supports.length === 0)
    unknowns.push('Hypothèse d’origine IA non éprouvée : sa confiance est indicative.');
  for (const contradiction of memory?.contradictions ?? [])
    if (contradiction.hypothesisId === hypothesis.id && contradiction.status === 'OPEN')
      unknowns.push(
        `${contradiction.openQuestion ? 'Question ouverte' : 'Contradiction non résolue'} (${contradiction.kind}) : ${contradiction.summary}`,
      );
  for (const missing of diagnosis?.missing ?? [])
    if (missing.includes(hypothesis.id) && !unknowns.some((item) => item.includes(missing)))
      unknowns.push(missing);
  return unique(unknowns, (item) => item);
}

// ── Rôles ────────────────────────────────────────────────────────────────────────────────────

/**
 * La cause racine telle que le moteur la verrait : celle du diagnostic quand il nomme une hypothèse encore vivante
 * et soutenue, sinon la meilleure hypothèse CONFIRMED (et qui le reste) puis la meilleure SUPPORTED.
 */
export function rootHypothesisId(
  hypotheses: readonly Hypothesis[],
  diagnosis?: Diagnosis,
): string | undefined {
  const live = hypotheses.filter(isLive).sort(byConfidence);
  const confirmed = live.find((item) => item.status === 'CONFIRMED' && meetsConfirmation(item));
  if (confirmed) return confirmed.id;
  const named = diagnosis?.rootCause?.hypothesisId;
  const fromDiagnosis = named ? live.find((item) => item.id === named && isSupported(item)) : undefined;
  if (fromDiagnosis) return fromDiagnosis.id;
  return live.find(isSupported)?.id;
}

/** Le rôle d'une hypothèse d'après son statut déterministe, la cause racine et ses vérifications. */
export function roleOf(
  hypothesis: Hypothesis | undefined,
  verifications: readonly HypothesisVerificationResult[],
  rootId: string | undefined,
): ExplorationRole {
  if (!hypothesis) return 'UNKNOWN';
  if (hypothesis.status === 'REFUTED') return 'REFUTED';
  if (hypothesis.status === 'CONFIRMED' && meetsConfirmation(hypothesis)) return 'CONFIRMED_CAUSE';
  if (isSupported(hypothesis)) return hypothesis.id === rootId ? 'PROBABLE_CAUSE' : 'CONTRIBUTING_FACTOR';
  if (hypothesis.status === 'INCONCLUSIVE') return 'UNKNOWN';
  // PROPOSED ou INVESTIGATING : rien d'exécuté → à vérifier ; exécuté sans trancher → inconnu.
  return verifications.length === 0 ? 'UNVERIFIED' : 'UNKNOWN';
}

/** Les explorations avec leur rôle recalculé ; même nombre, même ordre : rien n'est retiré. */
export function rolesOf(
  explorations: readonly HypothesisExploration[],
  diagnosis: Diagnosis | undefined,
  hypotheses: readonly Hypothesis[],
): HypothesisExploration[] {
  const rootId = rootHypothesisId(hypotheses, diagnosis);
  return explorations.map((exploration) => ({
    ...exploration,
    role: roleOf(
      hypotheses.find((item) => item.id === exploration.hypothesisId),
      exploration.verifications,
      rootId,
    ),
  }));
}

// ── Relations ────────────────────────────────────────────────────────────────────────────────

/**
 * Les relations entre hypothèses, déduites de ce qu'elles sont (couche, famille, origine), de leurs preuves et des
 * constats des agents ; les relations déjà connues sont conservées quand leurs deux extrémités existent.
 */
export function relateHypotheses(
  hypotheses: readonly Hypothesis[],
  findings: readonly AiFinding[] = [],
  relations: readonly HypothesisRelation[] = [],
): HypothesisRelation[] {
  const ids = new Set(hypotheses.map((item) => item.id));
  const result: HypothesisRelation[] = relations.filter((item) => ids.has(item.from) && ids.has(item.to));
  const pairs = new Set<string>();
  const pairKey = (left: string, right: string): string => [left, right].sort().join('|');

  for (const finding of findings) {
    if (!finding.hypothesisId || !ids.has(finding.hypothesisId)) continue;
    for (const ref of finding.refs)
      if (ref.kind === 'hypothesis' && ref.id !== finding.hypothesisId && ids.has(ref.id))
        result.push({
          from: finding.hypothesisId,
          to: ref.id,
          kind: 'REFINES',
          reason: `Constat ${finding.id} (${finding.agent}) : ${finding.title}`,
        });
  }

  const sorted = [...hypotheses].sort(byConfidence);
  for (const [index, left] of sorted.entries()) {
    for (const right of sorted.slice(index + 1)) {
      // La preuve qui soutient l'une réfute l'autre : elles s'excluent.
      for (const [supporter, refuted] of [
        [left, right],
        [right, left],
      ] as const) {
        const shared = supporter.supporting
          .map((item) => item.ref)
          .filter((ref) => refuted.contradicting.some((item) => item.ref === ref));
        if (shared.length > 0)
          result.push({
            from: supporter.id,
            to: refuted.id,
            kind: 'EXCLUDES',
            reason: `La preuve ${shared.join(', ')} soutient ${supporter.id} et réfute ${refuted.id}.`,
          });
      }
      if (!isLive(left) || !isLive(right)) continue;
      const key = pairKey(left.id, right.id);
      if (pairs.has(key)) continue;
      const leftFamily = causeFamily(left);
      const rightFamily = causeFamily(right);
      const sameFamily = leftFamily !== undefined && leftFamily === rightFamily;
      const sameLayer = left.layer !== 'UNKNOWN' && left.layer === right.layer;
      if (sameFamily && left.origin !== right.origin) {
        const ai = left.origin === 'AI' ? left : right;
        const rule = ai === left ? right : left;
        result.push({
          from: ai.id,
          to: rule.id,
          kind: 'REFINES',
          reason: `${ai.id} (IA) précise la règle ${rule.id} : même famille de cause (${leftFamily}).`,
        });
        pairs.add(key);
        continue;
      }
      if (sameFamily || sameLayer) {
        result.push({
          from: left.id,
          to: right.id,
          kind: 'COMPETES',
          reason: sameFamily
            ? `Même famille de cause (${leftFamily}) : deux explications du même symptôme.`
            : `Même couche (${left.layer}) : deux explications du même symptôme.`,
        });
        pairs.add(key);
        continue;
      }
      if (isSupported(left) && isSupported(right)) {
        result.push({
          from: right.id,
          to: left.id,
          kind: 'CONTRIBUTES',
          reason: `Deux causes soutenues de familles différentes (${rightFamily ?? right.layer} et ${leftFamily ?? left.layer}) : elles se cumulent.`,
        });
        pairs.add(key);
      }
    }
  }
  return unique(result, relationKey);
}

// ── Construction ─────────────────────────────────────────────────────────────────────────────

function contributorsOf(
  hypothesis: Hypothesis,
  findings: readonly AiFinding[],
  memory: InvestigationMemory | undefined,
  previous: HypothesisExploration | undefined,
): AiAgentName[] {
  const contributors: AiAgentName[] = [...(previous?.contributors ?? [])];
  if (hypothesis.origin === 'AI') contributors.push('HYPOTHESIS');
  for (const finding of findings)
    if (finding.hypothesisId === hypothesis.id) contributors.push(finding.agent);
  for (const event of memory?.timeline ?? [])
    if (event.hypothesisId === hypothesis.id && event.agent) contributors.push(event.agent);
  for (const contradiction of memory?.contradictions ?? [])
    if (contradiction.hypothesisId === hypothesis.id) contributors.push(contradiction.foundBy);
  return unique(contributors, (item) => item);
}

function nextProposalsOf(
  hypothesis: Hypothesis,
  run: AiInvestigationRun | undefined,
  memory: InvestigationMemory | undefined,
  done: ReadonlySet<string>,
): string[] {
  const pending = (status: string): boolean => status === 'PROPOSED' || status === 'PLANNED';
  const ids: string[] = [];
  for (const proposal of [...(run?.proposals ?? []), ...(memory?.experiments ?? [])])
    if (
      proposal.hypothesisId === hypothesis.id &&
      pending(proposal.status) &&
      !(proposal.experimentId && done.has(proposal.experimentId))
    )
      ids.push(proposal.id);
  for (const contradiction of memory?.contradictions ?? [])
    if (
      contradiction.hypothesisId === hypothesis.id &&
      contradiction.status === 'OPEN' &&
      contradiction.proposalId
    )
      ids.push(contradiction.proposalId);
  return unique(ids, (item) => item);
}

/**
 * Une exploration par hypothèse de l'incident (règles et IA). Les vérifications viennent des expériences terminées
 * de l'incident ; la mémoire et le run apportent contributeurs, propositions en attente, contradictions ouvertes et
 * emplacements des constats ; les relations relient les hypothèses entre elles ; le rôle suit le validateur.
 */
export function buildExplorations(
  incident: Incident,
  memory?: InvestigationMemory,
  run?: AiInvestigationRun,
): HypothesisExploration[] {
  const { hypotheses, experiments, diagnosis } = incident.investigation;
  const findings = run?.findings ?? [];
  const relations = relateHypotheses(
    hypotheses,
    findings,
    memory?.explorations.flatMap((item) => item.relations) ?? [],
  );
  const done = new Set(experiments.filter((item) => item.status === 'DONE').map((item) => item.id));
  const explorations = hypotheses.map((hypothesis): HypothesisExploration => {
    const previous = memory?.explorations.find((item) => item.hypothesisId === hypothesis.id);
    const verifications = unique(
      [
        ...(previous?.verifications ?? []),
        ...experiments
          .filter((item) => item.hypothesisId === hypothesis.id)
          .flatMap((item) => {
            const result = verificationResultOf(item, incident.updatedAt);
            return result ? [result] : [];
          }),
      ],
      (item) => item.experimentId,
    ).sort((left, right) => left.at.localeCompare(right.at));
    const locations = unique(
      [
        ...locationsOf(incident, hypothesis),
        ...findings.filter((item) => item.hypothesisId === hypothesis.id).flatMap((item) => item.locations),
        ...(previous?.locations ?? []),
      ],
      locationKey,
    );
    return {
      hypothesisId: hypothesis.id,
      origin: hypothesis.origin ?? 'RULE',
      unknowns: unknownsOf(hypothesis, verifications, memory, diagnosis),
      locations,
      contributors: contributorsOf(hypothesis, findings, memory, previous),
      verifications,
      nextProposalIds: nextProposalsOf(hypothesis, run, memory, done),
      relations: relations.filter((item) => item.from === hypothesis.id || item.to === hypothesis.id),
      role: 'UNVERIFIED',
    };
  });
  return rolesOf(explorations, diagnosis, hypotheses);
}

/**
 * L'effet d'une expérience terminée sur les explorations : son résultat est ajouté à l'hypothèse visée (une fois),
 * la proposition correspondante quitte les vérifications à faire, les inconnues et les rôles sont recalculés
 * d'après `hypotheses` — la liste DÉJÀ passée par `applyExperiment`, vérité du moteur. Aucune exploration n'est
 * retirée ; une hypothèse nouvelle reçoit la sienne.
 */
export function applyVerificationResult(
  explorations: readonly HypothesisExploration[],
  experiment: Experiment,
  hypotheses: readonly Hypothesis[],
  diagnosis?: Diagnosis,
): HypothesisExploration[] {
  const result = verificationResultOf(experiment);
  const known = new Set(explorations.map((item) => item.hypothesisId));
  const added = hypotheses
    .filter((item) => !known.has(item.id))
    .map((hypothesis): HypothesisExploration => ({
      hypothesisId: hypothesis.id,
      origin: hypothesis.origin ?? 'RULE',
      unknowns: [],
      locations: [],
      contributors: hypothesis.origin === 'AI' ? ['HYPOTHESIS'] : [],
      verifications: [],
      nextProposalIds: [],
      relations: [],
      role: 'UNVERIFIED',
    }));
  const updated = [...explorations, ...added].map((exploration): HypothesisExploration => {
    const hypothesis = hypotheses.find((item) => item.id === exploration.hypothesisId);
    const targeted = result !== undefined && exploration.hypothesisId === experiment.hypothesisId;
    const verifications = targeted
      ? unique([...exploration.verifications, result], (item) => item.experimentId)
      : exploration.verifications;
    const nextProposalIds = targeted
      ? exploration.nextProposalIds.filter((id) => id !== experiment.id)
      : exploration.nextProposalIds;
    const unknowns = hypothesis
      ? unknownsOf(hypothesis, verifications, undefined, diagnosis)
      : exploration.unknowns;
    return { ...exploration, verifications, nextProposalIds, unknowns };
  });
  return rolesOf(updated, diagnosis, hypotheses);
}

// ── Incertitudes et rapport ──────────────────────────────────────────────────────────────────

export interface HypothesisUncertainty {
  hypothesisId: string;
  unknown: string;
  /** Les vérifications proposées qui trancheraient (ids de propositions). */
  decisiveProposalIds: string[];
}

/** Ce qui reste à savoir, hypothèse par hypothèse (les hypothèses réfutées n'en ont plus). */
export function uncertaintiesOf(explorations: readonly HypothesisExploration[]): HypothesisUncertainty[] {
  return explorations
    .filter((item) => item.role !== 'REFUTED')
    .flatMap((item) =>
      item.unknowns.map((unknown) => ({
        hypothesisId: item.hypothesisId,
        unknown,
        decisiveProposalIds: [...item.nextProposalIds],
      })),
    );
}

export interface ReportedHypothesisRole {
  hypothesisId: string;
  role: ExplorationRole;
  title: string;
  statement: string;
  layer: Layer;
  origin: HypothesisExploration['origin'];
  confidence: number;
  status: Hypothesis['status'] | 'UNKNOWN';
  /** Les vérifications exécutées, par effet. */
  verifications: { supports: number; contradicts: number; neutral: number };
  unknowns: string[];
  relations: HypothesisRelation[];
}

export interface ReportedRoles {
  confirmed: ReportedHypothesisRole[];
  probable: ReportedHypothesisRole[];
  contributing: ReportedHypothesisRole[];
  refuted: ReportedHypothesisRole[];
  unverified: ReportedHypothesisRole[];
  unknown: ReportedHypothesisRole[];
}

const ROLE_BUCKET: Record<ExplorationRole, keyof ReportedRoles> = {
  CONFIRMED_CAUSE: 'confirmed',
  PROBABLE_CAUSE: 'probable',
  CONTRIBUTING_FACTOR: 'contributing',
  REFUTED: 'refuted',
  UNVERIFIED: 'unverified',
  UNKNOWN: 'unknown',
};

/** Le classement par rôle pour le rapport : chaque hypothèse une fois, par confiance décroissante dans son rôle. */
export function reportRoles(
  explorations: readonly HypothesisExploration[],
  hypotheses: readonly Hypothesis[],
): ReportedRoles {
  const report: ReportedRoles = {
    confirmed: [],
    probable: [],
    contributing: [],
    refuted: [],
    unverified: [],
    unknown: [],
  };
  for (const exploration of explorations) {
    const hypothesis = hypotheses.find((item) => item.id === exploration.hypothesisId);
    const count = (effect: VerificationEffect): number =>
      exploration.verifications.filter((item) => item.effect === effect).length;
    report[ROLE_BUCKET[exploration.role]].push({
      hypothesisId: exploration.hypothesisId,
      role: exploration.role,
      title: hypothesis?.title ?? exploration.hypothesisId,
      statement: hypothesis?.suspectedCause ?? 'Hypothèse absente de l’incident.',
      layer: hypothesis?.layer ?? 'UNKNOWN',
      origin: exploration.origin,
      confidence: hypothesis?.confidence ?? 0,
      status: hypothesis?.status ?? 'UNKNOWN',
      verifications: {
        supports: count('SUPPORTS'),
        contradicts: count('CONTRADICTS'),
        neutral: count('NEUTRAL'),
      },
      unknowns: [...exploration.unknowns],
      relations: [...exploration.relations],
    });
  }
  for (const bucket of Object.values(report) as ReportedHypothesisRole[][])
    bucket.sort(
      (left, right) =>
        right.confidence - left.confidence || left.hypothesisId.localeCompare(right.hypothesisId),
    );
  return report;
}

/** Les références que porte une exploration (vérifications et propositions), pour la mémoire et la couverture. */
export function refsOf(exploration: HypothesisExploration): AiRef[] {
  return unique(
    [
      { kind: 'hypothesis' as const, id: exploration.hypothesisId },
      ...exploration.verifications.flatMap((item) => item.refs),
      ...exploration.verifications.map((item): AiRef => ({ kind: 'experiment', id: item.experimentId })),
    ],
    refKey,
  );
}

/** Vrai quand la référence désigne une expérience (`experiment:<KIND>:<id>` dans les preuves d'une hypothèse). */
export const isExperimentRef = (ref: string): boolean => EXPERIMENT_REF.test(ref);
