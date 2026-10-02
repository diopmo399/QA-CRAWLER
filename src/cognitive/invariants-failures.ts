import type { BusinessSituation } from './business-state-engine.js';

// ------------------------------------------------------------------ invariants

export const DISCOVERED_INVARIANT_STATUSES = [
  'CANDIDATE',
  'OBSERVED_MULTIPLE_TIMES',
  'SUPPORTED',
  'CONFIRMED',
  'VIOLATED',
  'STALE',
] as const;
export type DiscoveredInvariantStatus = (typeof DISCOVERED_INVARIANT_STATUSES)[number];

export interface DiscoveredInvariant {
  id: string;
  /** « Submit disabled UNTIL required fields valid » */
  statement: string;
  template: 'SUBMIT_DISABLED_UNTIL_COMPLETE' | 'ACTION_PRESERVES_FIELD';
  subject: string;
  observations: number;
  runs: string[];
  versions: string[];
  counterexamples: { run: string; detail: string; at: string }[];
  status: DiscoveredInvariantStatus;
  firstSeen: string;
  lastSeen: string;
}

export interface InvariantThresholds {
  /** Observations pour OBSERVED_MULTIPLE_TIMES, SUPPORTED, CONFIRMED. */
  multiple: number;
  supported: number;
  confirmed: number;
  /** Runs distincts exigés pour SUPPORTED / CONFIRMED (une seule session ne suffit pas). */
  runsForSupported: number;
  runsForConfirmed: number;
}

export const DEFAULT_INVARIANT_THRESHOLDS: InvariantThresholds = {
  multiple: 3,
  supported: 5,
  confirmed: 10,
  runsForSupported: 2,
  runsForConfirmed: 3,
};

/**
 * INVARIANT DISCOVERY ENGINE : des régularités OBSERVÉES deviennent progressivement des
 * invariants — jamais à partir d'une seule observation.
 *
 *   « L'envoi reste désactivé tant que les champs requis ne sont pas valides »
 *   « Changer la devise NE DOIT PAS vider le nom de l'entreprise »
 *
 * CANDIDATE → OBSERVED_MULTIPLE_TIMES → SUPPORTED (plusieurs runs) → CONFIRMED ; un contre-
 * exemple sur un invariant soutenu ou confirmé → VIOLATED (la provenance reste : quand, quel
 * run, quelle version) ; un invariant d'une autre version non revu → STALE.
 */
export class InvariantDiscoveryEngine {
  private readonly invariants = new Map<string, DiscoveredInvariant>();

  constructor(
    private readonly context: { run: string; version?: string; now?: () => string },
    private readonly thresholds: InvariantThresholds = DEFAULT_INVARIANT_THRESHOLDS,
    private readonly onChange?: (
      invariant: DiscoveredInvariant,
      previous?: DiscoveredInvariantStatus,
    ) => void,
  ) {}

  restore(saved: readonly DiscoveredInvariant[]): void {
    for (const invariant of saved) {
      const copy = structuredClone(invariant);
      if (
        this.context.version &&
        copy.versions.length > 0 &&
        !copy.versions.includes(this.context.version) &&
        (copy.status === 'CONFIRMED' || copy.status === 'SUPPORTED')
      )
        copy.status = 'STALE';
      this.invariants.set(copy.id, copy);
    }
  }

  /** Un écran observé : l'envoi est-il actif alors que des conditions manquent ? */
  observeSituation(situation: BusinessSituation): void {
    if (situation.submission === 'NOT_VISIBLE' || !situation.mission) return;
    const subject = situation.mission;
    const id = `SUBMIT_DISABLED_UNTIL_COMPLETE:${subject}`;
    const statement = `${subject}: submit disabled UNTIL required fields valid`;
    if (situation.submission === 'ALLOWED_WHILE_INCOMPLETE')
      this.counterexample(
        id,
        'SUBMIT_DISABLED_UNTIL_COMPLETE',
        subject,
        statement,
        `submit enabled while missing ${situation.missing.join(', ')}`,
      );
    else if (situation.submission === 'BLOCKED' && situation.missing.length > 0)
      this.support(id, 'SUBMIT_DISABLED_UNTIL_COMPLETE', subject, statement);
  }

  /** Une action sur un champ : les autres champs remplis le restent-ils ? */
  observePreservation(action: string, field: string, preserved: boolean): void {
    const id = `ACTION_PRESERVES_FIELD:${action}|${field}`;
    const statement = `"${action}" MUST NOT clear "${field}"`;
    if (preserved) this.support(id, 'ACTION_PRESERVES_FIELD', `${action}|${field}`, statement);
    else
      this.counterexample(
        id,
        'ACTION_PRESERVES_FIELD',
        `${action}|${field}`,
        statement,
        `"${field}" was cleared by "${action}"`,
      );
  }

  all(): DiscoveredInvariant[] {
    return [...this.invariants.values()];
  }

  /** Les invariants assez confirmés pour alimenter un oracle (avec leur provenance). */
  oracleInvariants(): DiscoveredInvariant[] {
    return this.all().filter(
      (invariant) => invariant.status === 'CONFIRMED' || invariant.status === 'SUPPORTED',
    );
  }

  private entry(
    id: string,
    template: DiscoveredInvariant['template'],
    subject: string,
    statement: string,
  ): DiscoveredInvariant {
    const now = this.now();
    let invariant = this.invariants.get(id);
    if (!invariant) {
      invariant = {
        id,
        statement,
        template,
        subject,
        observations: 0,
        runs: [],
        versions: [],
        counterexamples: [],
        status: 'CANDIDATE',
        firstSeen: now,
        lastSeen: now,
      };
      this.invariants.set(id, invariant);
    }
    return invariant;
  }

  private support(
    id: string,
    template: DiscoveredInvariant['template'],
    subject: string,
    statement: string,
  ): void {
    const invariant = this.entry(id, template, subject, statement);
    const previous = invariant.status;
    invariant.observations += 1;
    invariant.lastSeen = this.now();
    if (!invariant.runs.includes(this.context.run)) invariant.runs.push(this.context.run);
    if (this.context.version && !invariant.versions.includes(this.context.version))
      invariant.versions.push(this.context.version);
    if (invariant.status === 'VIOLATED') return; // un invariant violé ne redevient pas vrai en silence
    const t = this.thresholds;
    invariant.status =
      invariant.observations >= t.confirmed && invariant.runs.length >= t.runsForConfirmed
        ? 'CONFIRMED'
        : invariant.observations >= t.supported && invariant.runs.length >= t.runsForSupported
          ? 'SUPPORTED'
          : invariant.observations >= t.multiple
            ? 'OBSERVED_MULTIPLE_TIMES'
            : invariant.status === 'STALE'
              ? 'OBSERVED_MULTIPLE_TIMES'
              : 'CANDIDATE';
    if (invariant.status !== previous) this.onChange?.(invariant, previous);
  }

  private counterexample(
    id: string,
    template: DiscoveredInvariant['template'],
    subject: string,
    statement: string,
    detail: string,
  ): void {
    const invariant = this.entry(id, template, subject, statement);
    const previous = invariant.status;
    invariant.counterexamples.push({ run: this.context.run, detail, at: this.now() });
    invariant.lastSeen = this.now();
    // Un candidat contredit n'était qu'une coïncidence ; un invariant soutenu contredit est VIOLÉ.
    invariant.status =
      previous === 'SUPPORTED' ||
      previous === 'CONFIRMED' ||
      previous === 'STALE' ||
      previous === 'VIOLATED' ||
      previous === 'OBSERVED_MULTIPLE_TIMES'
        ? 'VIOLATED'
        : 'CANDIDATE';
    if (invariant.status !== previous) this.onChange?.(invariant, previous);
  }

  private now(): string {
    return this.context.now?.() ?? new Date().toISOString();
  }
}

// ------------------------------------------------------------------ failures

export const FAILURE_CLASSES = [
  'EXPECTED_VALIDATION',
  'EXPECTED_BUSINESS_REJECTION',
  'UI_FAILURE',
  'FUNCTIONAL_FAILURE',
  'API_FAILURE',
  'TECHNICAL_FAILURE',
  'CONTRACT_FAILURE',
  'PERMISSION_FAILURE',
  'DATA_FAILURE',
  'TIMEOUT_FAILURE',
  'WORKFLOW_FAILURE',
  'UNKNOWN_FAILURE',
] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

/** Ce que l'on sait d'un échec (jamais un corps de requête : un statut, un message d'écran court). */
export interface FailureSignal {
  status?: number;
  /** Route de l'API (modèle), si une requête a échoué. */
  request?: string;
  /** Message affiché ou d'exception (court, déjà nettoyé). */
  message?: string;
  /** Le scénario attendait un refus (test négatif). */
  expectedRejection?: boolean;
  /** Un rôle qui ne devrait pas avoir accès. */
  unauthorizedRole?: boolean;
  timedOut?: boolean;
  /** L'action a répondu OK mais l'effet métier attendu manque (rien créé…). */
  effectMissing?: boolean;
  /** La réponse ne respecte pas le contrat. */
  contractMismatch?: boolean;
  /** L'élément visé n'a pas pu être utilisé. */
  uiProblem?: boolean;
  /** Divergence de parcours (étape manquante, ordre changé). */
  workflowDivergence?: boolean;
  /** Divergence d'origine (catégorie du DivergenceAnalyzer), si connue. */
  divergence?: string;
}

export interface FailureUnderstanding {
  class: FailureClass;
  expected: boolean;
  reasons: string[];
  signature: string;
  /** FAILURE CAUSAL GRAPH : échec → symptôme → divergence → cause probable → preuves → récupération → déjà vu. */
  chain: {
    symptom: string;
    firstDivergence?: string;
    probableCause: string;
    knownRecovery?: string;
    occurrences: number;
  };
}

const VALIDATION_TEXT = /\b(invalid|required|must|format|invalide|obligatoire|doit|requis)\b/i;
const TECHNICAL_TEXT =
  /\b(exception|nullpointer|stack ?trace|internal server error|undefined is not|cannot read|segmentation)\b/i;
const DATA_TEXT = /\b(already exists|duplicate|conflict|not found|existe d[ée]j[aà]|introuvable)\b/i;

/**
 * FAILURE UNDERSTANDING ENGINE : classer un échec avant d'en parler.
 *
 *   400 « Business number invalid » pendant un test négatif → EXPECTED_VALIDATION
 *   500 NullPointerException                               → TECHNICAL_FAILURE
 *   200 mais rien de créé                                  → FUNCTIONAL_FAILURE
 *   403 sous un mauvais rôle                               → PERMISSION_FAILURE
 *
 * FailureKnowledge (KnowledgeBase) reconnaît « j'ai déjà vu cette classe de panne ici ».
 */
export function understandFailure(
  signal: FailureSignal,
  knowledge?: { occurrences(signature: string): number; recoveryFor?(signature: string): string | undefined },
): FailureUnderstanding {
  const reasons: string[] = [];
  const message = signal.message ?? '';
  const status = signal.status;
  let failureClass: FailureClass;
  if (signal.timedOut) {
    failureClass = 'TIMEOUT_FAILURE';
    reasons.push('no answer within the time limit');
  } else if (status === 401 || status === 403) {
    failureClass =
      signal.expectedRejection && signal.unauthorizedRole
        ? 'EXPECTED_BUSINESS_REJECTION'
        : 'PERMISSION_FAILURE';
    reasons.push(`HTTP ${String(status)}${signal.unauthorizedRole ? ' under a role without access' : ''}`);
  } else if (
    status !== undefined &&
    status >= 400 &&
    status < 500 &&
    (status === 400 || status === 422) &&
    VALIDATION_TEXT.test(message)
  ) {
    failureClass = signal.expectedRejection ? 'EXPECTED_VALIDATION' : 'FUNCTIONAL_FAILURE';
    reasons.push(
      signal.expectedRejection
        ? 'validation rejection expected by a negative test'
        : 'unexpected validation rejection',
    );
  } else if (
    status === 409 ||
    (status !== undefined && status >= 400 && status < 500 && DATA_TEXT.test(message))
  ) {
    failureClass = signal.expectedRejection ? 'EXPECTED_BUSINESS_REJECTION' : 'DATA_FAILURE';
    reasons.push('the data was refused (conflict, duplicate, missing)');
  } else if (status !== undefined && status >= 500) {
    failureClass = TECHNICAL_TEXT.test(message) || status === 500 ? 'TECHNICAL_FAILURE' : 'API_FAILURE';
    reasons.push(`HTTP ${String(status)}${TECHNICAL_TEXT.test(message) ? ' with a technical error' : ''}`);
  } else if (signal.contractMismatch) {
    failureClass = 'CONTRACT_FAILURE';
    reasons.push('the response does not match the contract');
  } else if (signal.effectMissing) {
    failureClass = 'FUNCTIONAL_FAILURE';
    reasons.push('the action was accepted but its business effect is missing');
  } else if (signal.workflowDivergence) {
    failureClass = 'WORKFLOW_FAILURE';
    reasons.push('the journey diverged from the demonstrated workflow');
  } else if (signal.uiProblem) {
    failureClass = 'UI_FAILURE';
    reasons.push('the interface could not be used as expected');
  } else if (status !== undefined && status >= 400) {
    failureClass = signal.expectedRejection ? 'EXPECTED_BUSINESS_REJECTION' : 'API_FAILURE';
    reasons.push(`HTTP ${String(status)}`);
  } else {
    failureClass = 'UNKNOWN_FAILURE';
    reasons.push('not enough evidence to classify');
  }
  const signature = `${failureClass}|${signal.request ?? '-'}|${String(status ?? '-')}`;
  const occurrences = knowledge?.occurrences(signature) ?? 0;
  const knownRecovery = knowledge?.recoveryFor?.(signature);
  if (occurrences > 0) reasons.push(`seen ${String(occurrences)} time(s) before in this context`);
  return {
    class: failureClass,
    expected: failureClass === 'EXPECTED_VALIDATION' || failureClass === 'EXPECTED_BUSINESS_REJECTION',
    reasons,
    signature,
    chain: {
      symptom: `${signal.request ?? 'action'}${status !== undefined ? ` → ${String(status)}` : ''}${message ? ` « ${message.slice(0, 80)} »` : ''}`,
      ...(signal.divergence ? { firstDivergence: signal.divergence } : {}),
      probableCause: reasons[0] ?? 'unknown',
      ...(knownRecovery ? { knownRecovery } : {}),
      occurrences,
    },
  };
}

/** FAILURE KNOWLEDGE : les classes de panne vues, par signature et contexte (version, route). */
export interface FailureRecord {
  signature: string;
  class: FailureClass;
  occurrences: number;
  firstSeen: string;
  lastSeen: string;
  versions: string[];
  recovery?: string;
}

export class FailureKnowledge {
  private readonly records = new Map<string, FailureRecord>();

  constructor(saved: readonly FailureRecord[] = []) {
    for (const record of saved) this.records.set(record.signature, structuredClone(record));
  }

  occurrences(signature: string): number {
    return this.records.get(signature)?.occurrences ?? 0;
  }

  recoveryFor(signature: string): string | undefined {
    return this.records.get(signature)?.recovery;
  }

  record(
    understanding: FailureUnderstanding,
    at: string,
    version?: string,
    recovery?: string,
  ): FailureRecord {
    const existing = this.records.get(understanding.signature);
    const record: FailureRecord = {
      signature: understanding.signature,
      class: understanding.class,
      occurrences: (existing?.occurrences ?? 0) + 1,
      firstSeen: existing?.firstSeen ?? at,
      lastSeen: at,
      versions: [...new Set([...(existing?.versions ?? []), ...(version ? [version] : [])])],
      ...((recovery ?? existing?.recovery) ? { recovery: recovery ?? existing?.recovery } : {}),
    };
    this.records.set(record.signature, record);
    return record;
  }

  all(): FailureRecord[] {
    return [...this.records.values()];
  }
}
