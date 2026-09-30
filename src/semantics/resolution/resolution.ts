import { confidenceLevel, type ConfidenceLevel } from '../../intelligence/confidence-engine.js';
import { slug } from '../../knowledge/signatures.js';

/**
 * RÉSOLUTION : d'une intention vers une cible, jamais d'une intention vers une action.
 *
 *   RESOLVED   : un candidat assez sûr ET assez loin du deuxième ;
 *   AMBIGUOUS  : des candidats, mais trop faibles ou trop proches (jamais le premier par défaut) ;
 *   NOT_FOUND  : aucun candidat acceptable ;
 *   BLOCKED    : la cible existe mais ne sera jamais utilisée (paiement, téléversement…).
 */
export const RESOLUTION_STATUSES = ['RESOLVED', 'AMBIGUOUS', 'NOT_FOUND', 'BLOCKED'] as const;
export type ResolutionStatus = (typeof RESOLUTION_STATUSES)[number];

/** Une composante du score d'un candidat : ses points et pourquoi. */
export interface ScoreComponent {
  factor:
    | 'label'
    | 'alias'
    | 'attribute'
    | 'autocomplete'
    | 'type'
    | 'value'
    | 'kind'
    | 'option'
    | 'role'
    | 'submit'
    | 'form'
    | 'context'
    | 'navigation'
    | 'static'
    | 'history';
  points: number;
  detail: string;
}

export interface ResolutionCandidate {
  /** Id de l'action (ou du groupe de radios). */
  id: string;
  /** Ce que l'utilisateur voit (libellé, nom accessible, texte). */
  label: string;
  /** 0..1 : points / POINTS_FOR_CERTAINTY, borné à [0, 1]. */
  score: number;
  /** Points bruts (non bornés) : classement et écart avec le deuxième. */
  points: number;
  components: ScoreComponent[];
}

/**
 * Points d'une certitude : un libellé identique (70) avec un indice de plus, ou un alias
 * exact et un attribut concordant. Au-delà, le score reste 1, mais les points bruts
 * départagent encore (« Nom » exact contre « Nom de famille »).
 */
export const POINTS_FOR_CERTAINTY = 80;

export interface ResolutionThresholds {
  /** Score minimal pour agir seul. */
  autoResolveThreshold: number;
  /** Écart minimal avec le deuxième candidat. */
  ambiguityMargin: number;
  /** En dessous : ce n'est pas un candidat. */
  minCandidateScore: number;
}

export const DEFAULT_THRESHOLDS: ResolutionThresholds = {
  autoResolveThreshold: 0.85,
  ambiguityMargin: 0.15,
  minCandidateScore: 0.25,
};

export interface Decision {
  status: Exclude<ResolutionStatus, 'BLOCKED'>;
  best?: ResolutionCandidate;
  second?: ResolutionCandidate;
  reason: string;
}

/** Points bruts d'un candidat : la somme de ses composantes. */
export function pointsOf(components: readonly ScoreComponent[]): number {
  return components.reduce((sum, component) => sum + component.points, 0);
}

/** Score d'un candidat : ses points ramenés à 0..1 (POINTS_FOR_CERTAINTY = 1). */
export function scoreOf(components: readonly ScoreComponent[]): number {
  return Math.round(Math.max(0, Math.min(1, pointsOf(components) / POINTS_FOR_CERTAINTY)) * 100) / 100;
}

/** Un candidat, avec son score et ses points. */
export function candidateOf(id: string, label: string, components: ScoreComponent[]): ResolutionCandidate {
  return { id, label, score: scoreOf(components), points: pointsOf(components), components };
}

/** Candidats classés : score décroissant, puis libellé, puis id (déterministe). */
export function rank(candidates: readonly ResolutionCandidate[]): ResolutionCandidate[] {
  return [...candidates].sort(
    (a, b) =>
      b.score - a.score || b.points - a.points || a.label.localeCompare(b.label) || a.id.localeCompare(b.id),
  );
}

/**
 * La règle d'ambiguïté, la même pour les champs, les options, les actions et la navigation :
 *
 *   meilleur ≥ seuil  ET  meilleur − deuxième ≥ marge  → RESOLVED
 *   (l'écart est mesuré sur les points bruts / POINTS_FOR_CERTAINTY : deux candidats au
 *   plafond restent départagés par leurs preuves)
 *   aucun candidat ≥ score minimal                       → NOT_FOUND
 *   sinon                                                → AMBIGUOUS
 */
export function decide(ranked: readonly ResolutionCandidate[], thresholds: ResolutionThresholds): Decision {
  const acceptable = ranked.filter((candidate) => candidate.score >= thresholds.minCandidateScore);
  const [best, second] = acceptable;
  if (!best) return { status: 'NOT_FOUND', reason: 'no candidate scored high enough' };
  const gap = second ? round2((best.points - second.points) / POINTS_FOR_CERTAINTY) : undefined;
  if (
    best.score >= thresholds.autoResolveThreshold &&
    (gap === undefined || gap >= thresholds.ambiguityMargin)
  )
    return {
      status: 'RESOLVED',
      best,
      ...(second ? { second } : {}),
      reason:
        gap === undefined
          ? `only candidate, score ${best.score} ≥ ${thresholds.autoResolveThreshold}`
          : `score ${best.score} ≥ ${thresholds.autoResolveThreshold}, ${gap} ahead of "${second?.label ?? ''}"`,
    };
  return {
    status: 'AMBIGUOUS',
    best,
    ...(second ? { second } : {}),
    reason:
      best.score < thresholds.autoResolveThreshold
        ? `best candidate "${best.label}" scores ${best.score} < ${thresholds.autoResolveThreshold}`
        : `"${best.label}" ${best.score} and "${second?.label ?? ''}" ${second?.score ?? 0} are closer than ${thresholds.ambiguityMargin}`,
  };
}

/** Le niveau de confiance d'un score (les mêmes niveaux que le ConfidenceEngine). */
export function levelOf(score: number): ConfidenceLevel {
  return confidenceLevel(score);
}

/** « +70 label "Courriel" = "courriel" ». */
export function renderComponent(component: ScoreComponent): string {
  return `${component.points > 0 ? '+' : ''}${component.points} ${component.detail}`;
}

/**
 * IDENTITÉ SÉMANTIQUE d'une cible, stable d'un run à l'autre : genre, libellé, name,
 * type, autocomplete — jamais un id DOM généré (« #mat-input-23 »). Les nombres sont
 * masqués (slug).
 */
export function targetSignature(parts: {
  kind: string;
  label?: string;
  name?: string;
  type?: string;
  autocomplete?: string;
}): string {
  return [
    parts.kind,
    slug(parts.label ?? ''),
    slug(parts.name ?? ''),
    parts.type ?? '',
    parts.autocomplete ?? '',
  ]
    .join('|')
    .slice(0, 180);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Ce qu'une explication montre d'une résolution (jamais une valeur saisie). */
export interface ExplainedResolution {
  /** « FIELD MATCH », « OPTION », « ACTION », « NAVIGATION », « ASSERTION ». */
  title: string;
  step?: string;
  intent: string;
  valueType?: string;
  /** Une valeur sensible est toujours [REDACTED] ; les autres ne sont pas affichées non plus. */
  valueRedacted?: boolean;
  status: ResolutionStatus;
  selected?: string;
  score: number;
  confidence: string;
  reasons: readonly string[];
  candidates: readonly Pick<ResolutionCandidate, 'label' | 'score'>[];
}

/**
 * GHERKIN RESOLUTION, en clair :
 *
 *   FIELD MATCH
 *   Step: je renseigne le courriel avec …
 *   Intent: FILL "courriel" · Value type: EMAIL
 *   Status: RESOLVED → "Adresse électronique" · Confidence: 0.97 VERY_HIGH
 *   Reasons: + semantic alias …
 *   Candidates: Adresse électronique 1 · Nom 0
 */
export function explainResolution(resolution: ExplainedResolution): string[] {
  const lines = [resolution.title];
  if (resolution.step) lines.push(`Step: ${resolution.step}`);
  lines.push(
    `Intent: ${resolution.intent}${resolution.valueType ? ` · Value type: ${resolution.valueType}` : ''}${resolution.valueRedacted ? ' · Value: [REDACTED]' : ''}`,
  );
  lines.push(
    `Status: ${resolution.status}${resolution.selected ? ` → "${resolution.selected}"` : ''} · Confidence: ${resolution.score} ${resolution.confidence}`,
  );
  for (const reason of resolution.reasons) lines.push(`  ${reason}`);
  if (resolution.candidates.length > 0)
    lines.push(
      `Candidates: ${resolution.candidates
        .slice(0, 5)
        .map((candidate) => `${candidate.label} ${candidate.score}`)
        .join(' · ')}`,
    );
  return lines;
}
