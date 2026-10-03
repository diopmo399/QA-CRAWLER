import type { ElementHandle, JSHandle, Locator, Page } from 'playwright';
import type { FlowTarget, TargetFingerprint } from '../config/flow-schema.js';
import { describeTarget } from '../config/flow-schema.js';
import { toLocator } from '../execution/locator-resolver.js';
import {
  isFragileTarget,
  matchFingerprint,
  normalize,
  readTarget,
  sectionMatch,
  type ObservedTarget,
} from '../flows/action-effect-verifier.js';
import type {
  PreActionCandidate,
  PreActionContext,
  RawRecordedEvent,
  RecordedElement,
  RecordedTarget,
} from './model.js';
import { resolveRecordedTarget } from './recorded-target.js';
import {
  goalOf,
  ValidationMode,
  type RecordingVerdict,
  type TargetIdentitySource,
} from './validation-mode.js';
import type {
  ContextAction,
  ContextCandidate,
  EvidenceSources,
  RecordingContextInput,
} from './recording-intelligence-context.js';
import {
  elementTraits,
  semanticScanExpression,
  type ElementTraits,
  type SemanticScanResult,
} from './semantic-dom.js';

/**
 * RECORDING TARGET VALIDATOR — RECORD → RESOLVE → VALIDATE → ENRICH → REVALIDATE → PERSIST.
 *
 * Juste après une action humaine : « si je n'avais plus que la représentation que je viens de
 * construire, retrouverais-je EXACTEMENT l'élément que l'humain a utilisé ? ». Une RECHERCHE À
 * SEC : le localisateur du rejeu (toLocator / ContextualTargetResolver) est résolu, comparé à
 * l'élément original, et l'empreinte à ce que le rejeu en lira (readTarget). Jamais click, fill,
 * press, selectOption, glisser, submit ni dispatchEvent : l'identité de la cible, pas l'action.
 */

export type TargetValidationStatus =
  | 'VALIDATED'
  | 'VALIDATED_FRAGILE'
  | 'VALIDATED_AFTER_RERENDER'
  | 'VALIDATED_AFTER_AI_AUDIT'
  /** L'élément a disparu avec l'action, mais il était UNIQUE juste avant (contexte pré-action). */
  | 'VALIDATED_PRE_ACTION'
  /** Identité prouvée avant l'action ET effet fonctionnel observé après (fenêtre ouverte, route…). */
  | 'VALIDATED_WITH_EFFECT'
  | 'AMBIGUOUS'
  | 'MISMATCH'
  | 'NOT_FOUND'
  | 'CONTEXT_MISMATCH'
  | 'SEMANTIC_MISMATCH'
  | 'STALE_BEFORE_VALIDATION'
  | 'NOT_VALIDATABLE';

export const VALIDATED_STATUSES: ReadonlySet<TargetValidationStatus> = new Set([
  'VALIDATED',
  'VALIDATED_FRAGILE',
  'VALIDATED_AFTER_RERENDER',
  'VALIDATED_AFTER_AI_AUDIT',
  'VALIDATED_PRE_ACTION',
  'VALIDATED_WITH_EFFECT',
]);

/** Ce que le rejeu lira de l'élément (rôle, nom, balise, test id, section) : jamais une valeur. */
export interface TargetIdentity {
  role?: string;
  tag?: string;
  name?: string;
  testId?: string;
  section?: string;
  /** Ce qui le distingue de ses pareils (attributs stables, texte voisin, focus, fenêtre). */
  traits?: ElementTraits;
}

export interface TargetDifference {
  property: 'role' | 'tag' | 'name' | 'testId' | 'section' | 'element';
  expected?: string;
  actual?: string;
}

/** Un essai : une représentation résolue à sec et comparée à l'original. */
export interface TargetCheck {
  status: TargetValidationStatus;
  confidence: number;
  reason: string;
  candidateCount: number;
  sameElement?: boolean;
  /** Le nœud original a été remplacé, mais l'élément résolu a la même identité (instantané). */
  sameIdentity?: boolean;
  /** Le résultat vient du contexte PRÉ-ACTION (la cible n'existe plus au runtime). */
  preAction?: boolean;
  /** Ce que le localisateur trouvait APRÈS l'action : une preuve complémentaire, jamais un verdict d'identité. */
  postState?: { status: TargetValidationStatus; reason: string };
  resolved?: TargetIdentity;
  differences: TargetDifference[];
  /** AMBIGUOUS : les candidats (identité, et lequel est l'original). */
  candidates?: (TargetIdentity & { index: number; original: boolean; visible?: boolean })[];
}

export interface TargetRepair {
  type: 'DETERMINISTIC' | 'AI';
  reason: string;
  changes: { property: string; before?: string; after?: string }[];
  evidence: string[];
}

export interface TargetAiAudit {
  decisionId?: string;
  outcome:
    | 'AI_PROPOSAL_RUNTIME_CONFIRMED'
    | 'AI_PROPOSAL_RUNTIME_REJECTED'
    | 'INCONCLUSIVE'
    | 'UNAVAILABLE'
    | 'NOT_CALLED';
  proposedTarget?: string;
  citedEvidence: string[];
  reason: string;
  /** Ce qui a été envoyé au conseiller (assaini) : ai-context-summary.json. */
  context?: Record<string, unknown>;
  /** Ce que la proposition affirmait mais que le runtime contredit (ignoré). */
  ignored?: string[];
  /** Le candidat proposé (T…), quand il en a choisi un. */
  candidate?: string;
}

/**
 * Le résultat d'une validation immédiate (target-validation.json) : avant, réparation, après,
 * audit, et la représentation FINALE (celle qui ira dans le flow).
 */
export interface RecordingTargetValidation {
  /** Toujours RECORDING : l'action humaine est déjà faite (jamais rejouée, jamais « récupérée »). */
  mode: typeof ValidationMode.RECORDING;
  /** CIBLE, EFFET, OBJECTIF : trois verdicts séparés (un effet ou un objectif ne valide jamais une cible). */
  verdict: RecordingVerdict;
  rawEventId: string;
  humanActionId?: string;
  action: string;
  timestamp: number;
  status: TargetValidationStatus;
  confidence: number;
  attempts: number;
  original: TargetIdentity & { label?: string; stale: boolean };
  targetBefore?: FlowTarget;
  fingerprintBefore?: TargetFingerprint;
  validationBefore: TargetCheck;
  repair?: TargetRepair;
  targetAfter?: FlowTarget;
  fingerprintAfter?: TargetFingerprint;
  validationAfter?: TargetCheck;
  aiAudit?: TargetAiAudit;
  repairApplied: boolean;
  aiAudited: boolean;
  originalTargetMatch: boolean;
  /** UNRESOLVED : gardée, à confirmer au rejeu (jamais supprimée). */
  requiresReplayValidation: boolean;
  /** La capture AVANT mutation : complète (la cible originale est un candidat) ou diagnostiquée. */
  preActionCapture?: PreActionCaptureSummary;
  /** Ce qui existe MAINTENANT (une autre preuve que ce qui existait quand l'humain a agi). */
  currentRuntime?: { originalStillPresent: boolean };
  /** Le statut publié : VALIDATED_LIVE, VALIDATED_PRE_ACTION(_WITH_EFFECT), AMBIGUOUS_PRE_ACTION, NOT_CAPTURED… */
  validationStatus?: string;
  /** Le candidat pré-action retenu (T1 : la cible originale). */
  validatedCandidate?: string;
  /** Prouvée dans CE runtime ; la connaissance universelle attend le rejeu. */
  knowledge: { recordingValidated: boolean; replayValidated: false };
  /** Les effets observés entre l'écran d'avant et celui d'après (fenêtre, route, titre, cible disparue). */
  effects?: string[];
  /** ACTION_SEMANTICALLY_CONFIRMED : cible validée ET effet observé. */
  semanticallyConfirmed?: boolean;
  /** Glisser-déposer : l'élément et la zone retrouvés, et le déplacement observé (preuve). */
  drag?: {
    item: TargetValidationStatus;
    destination: TargetValidationStatus;
    movedObserved: boolean;
    lists?: {
      sourceBefore: string[];
      sourceAfter: string[];
      destinationAfter: string[];
      destinationBefore?: string[];
    };
    destinationCandidate?: string;
    dropZoneCandidates?: number;
  };
  log: string[];
}

export interface PreActionCaptureSummary {
  captured: boolean;
  complete: boolean;
  phase?: string;
  captureId?: string;
  domGeneration?: number;
  sentGeneration?: number;
  postGeneration?: number;
  candidateCount: number;
  originalCandidateId?: string;
  /** PRE_ACTION_CAPTURE_INCOMPLETE / NOT_CAPTURED : pourquoi. */
  diagnostic?: string;
}

/**
 * L'INVARIANT de la capture : une action humaine sur un élément, capturée, a au moins un candidat
 * et la cible originale en fait partie. Sinon : PRE_ACTION_CAPTURE_INCOMPLETE, diagnostiqué.
 */
export function preActionCaptureOf(event: RawRecordedEvent): PreActionCaptureSummary {
  const pre = event.pre;
  if (!pre)
    return {
      captured: false,
      complete: false,
      candidateCount: 0,
      diagnostic: 'NOT_CAPTURED: no pre-action context was received for this action',
    };
  const candidates = pre.candidates ?? [];
  const original = candidates.find(
    (candidate) => candidate.id === pre.originalCandidateId && candidate.origin === 'ORIGINAL_HUMAN_TARGET',
  );
  const diagnostic = !pre.candidates
    ? 'PRE_ACTION_CAPTURE_INCOMPLETE: no candidate set was captured (capture disabled or an older page script)'
    : candidates.length === 0
      ? 'PRE_ACTION_CAPTURE_INCOMPLETE: candidates=0 although the human target was an element'
      : !original
        ? 'PRE_ACTION_CAPTURE_INCOMPLETE: the original human target is missing from the candidate set'
        : undefined;
  return {
    captured: true,
    complete: diagnostic === undefined,
    ...(pre.phase ? { phase: pre.phase } : {}),
    ...(pre.captureId ? { captureId: pre.captureId } : {}),
    ...(pre.generation !== undefined ? { domGeneration: pre.generation } : {}),
    ...(pre.sentGeneration !== undefined ? { sentGeneration: pre.sentGeneration } : {}),
    candidateCount: candidates.length,
    ...(original ? { originalCandidateId: original.id } : {}),
    ...(diagnostic ? { diagnostic } : {}),
  };
}

/** Un candidat pré-action devenu représentation : test id, libellé ou rôle + nom dans sa section ; l'id stable sinon. */
export function targetOfCandidate(candidate: PreActionCandidate): FlowTarget {
  const section = candidate.section ? { section: candidate.section } : {};
  const testId = candidate.stableAttributes['data-testid'];
  if (testId) return { strategy: 'testId', value: testId };
  if (candidate.label && candidate.editable) return { strategy: 'label', value: candidate.label, ...section };
  if (candidate.name && candidate.role)
    return { strategy: 'role', role: candidate.role, name: candidate.name, ...section };
  const id = candidate.stableAttributes.id;
  if (id) return { strategy: 'css', value: `#${id}` };
  return { strategy: 'css', value: candidate.cssHint ?? candidate.tag };
}

/** L'identité fonctionnelle d'un candidat (rôle, libellé ou nom, section) : ce qui le distingue. */
function candidateKey(candidate: PreActionCandidate): string {
  return `${candidate.role}|${normalize(candidate.label ?? candidate.name)}|${candidate.section ?? ''}`;
}

/** Le statut publié (sans toucher aux statuts internes) : LIVE, PRE_ACTION, AVEC EFFET, AMBIGU PRÉ-ACTION, NON CAPTURÉ. */
export function publishedStatus(
  result: Omit<RecordingTargetValidation, 'verdict'>,
  effect: RecordingVerdict['effect'],
): string {
  const check = result.validationAfter ?? result.validationBefore;
  if (result.status === 'VALIDATED' && !check.preAction) return 'VALIDATED_LIVE';
  if (result.status === 'VALIDATED_WITH_EFFECT') return 'VALIDATED_PRE_ACTION_WITH_EFFECT';
  if (result.status === 'VALIDATED_PRE_ACTION')
    return effect.status === 'CONFIRMED' ? 'VALIDATED_PRE_ACTION_WITH_EFFECT' : 'VALIDATED_PRE_ACTION';
  if (result.status === 'AMBIGUOUS' && check.preAction) return 'AMBIGUOUS_PRE_ACTION';
  if (
    result.status === 'NOT_VALIDATABLE' &&
    result.original.stale &&
    result.preActionCapture?.captured === false
  )
    return 'NOT_CAPTURED';
  return result.status;
}

/** La cible que l'étape sémantique produira pour cet événement (même règle que semantic-recording). */
export function candidateTargetOf(event: RawRecordedEvent): RecordedTarget | undefined {
  const element = event.element;
  if (!element || event.noise) return undefined;
  if (event.type === 'click' || event.type === 'submit') return resolveRecordedTarget(element, 'click');
  if (event.type === 'input' || event.type === 'change') {
    if (element.inputType === 'file') return undefined;
    const check =
      element.inputType === 'checkbox' || element.inputType === 'radio' || element.role === 'switch';
    return resolveRecordedTarget(element, check ? 'check' : 'field');
  }
  return undefined;
}

const FIELD_ROLES = new Set(['textbox', 'combobox', 'searchbox', 'spinbutton']);

/** Le conseiller : choisit une candidate fournie (T…) ; jamais un élément du DOM directement. */
export type TargetAuditAdvisor = (input: {
  event: RawRecordedEvent;
  original: TargetIdentity & { label?: string };
  check: TargetCheck;
  candidates: (ContextCandidate & { description: string })[];
  previousActions: string[];
  /** CONTEXT BEFORE DECISION : écran, actions d'avant et d'après, effets, indices (voir RecordingIntelligenceContextBuilder). */
  context?: Omit<RecordingContextInput, 'candidates'>;
}) => Promise<{
  decisionId?: string;
  selectedKey?: string;
  outcome: 'PROPOSAL' | 'INCONCLUSIVE' | 'UNAVAILABLE';
  citedEvidence: string[];
  confidence?: number;
  semanticTarget?: { semanticId?: string; role?: string };
  /** Ce qui a été envoyé (assaini) : pour ai-context-summary.json. */
  contextSummary?: Record<string, unknown>;
  contextStats?: {
    candidates: number;
    evidence: number;
    previousActions: number;
    futureActions: number;
    redactions: number;
  };
}>;

export interface TargetValidatorOptions {
  maxDeterministicRepairAttempts: number;
  /** Statuts qui déclenchent l'audit (SUSPICIOUS_ONLY) ; vide : jamais. */
  auditOn: ReadonlySet<TargetValidationStatus>;
  advisor?: TargetAuditAdvisor;
  log?: (line: string) => void;
  /** Le nom du parcours (contexte du conseiller). */
  flowName?: string;
  /** Indices statiques / historiques (jamais une vérité runtime) ; aucun par défaut. */
  sources?: EvidenceSources;
}

export class RecordingTargetValidator {
  private tokens = 0;
  private lastField: { key: string; result: RecordingTargetValidation } | undefined;
  /** Les dernières actions comprises (contexte : un champ « valeur » après « champ » et « opérateur »). */
  private readonly previous: string[] = [];

  constructor(private readonly options: TargetValidatorOptions) {}

  /** Le sel des empreintes de la session : l'effet d'une saisie se compare sans jamais lire la valeur en clair. */
  private salt: string | undefined;
  useValueSalt(salt: string): void {
    this.salt = salt;
  }

  /** Valide la cible d'un événement humain. Ne lève jamais : une validation impossible n'arrête pas l'enregistrement. */
  /** Une validation à la fois, dans l'ordre des actions humaines (le contexte précédent compte). */
  validate(
    page: Page,
    event: RawRecordedEvent,
    ref: string | undefined,
  ): Promise<RecordingTargetValidation | undefined> {
    const next = this.queue.then(() => this.validateNow(page, event, ref));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private queue: Promise<unknown> = Promise.resolve();

  private async validateNow(
    page: Page,
    event: RawRecordedEvent,
    ref: string | undefined,
  ): Promise<RecordingTargetValidation | undefined> {
    try {
      if (event.type === 'drag') return await this.validateDrag(page, event, ref);
      const candidate = candidateTargetOf(event);
      const element = event.element;
      if (!candidate || !element) return undefined;
      // Une saisie arrive en plusieurs événements (frappe, pause) : la même cible n'est validée qu'une fois.
      const key = `${element.css}|${JSON.stringify(candidate.target)}`;
      if ((event.type === 'input' || event.type === 'change') && this.lastField?.key === key) {
        // La cible est déjà validée ; l'EFFET, lui, se relit à chaque saisie (la valeur finale compte).
        const known = this.lastField.result;
        const effect = await this.effectOf(
          page,
          event,
          await this.original(page, ref),
          known.targetAfter ?? known.targetBefore,
          known.effects ?? [],
        );
        const result = { ...known, rawEventId: event.id, verdict: verdictOf(known, effect), log: [] };
        this.lastField = { key, result };
        return result;
      }
      const result = await this.validateTarget(page, event, element, candidate, ref);
      if (event.type === 'input' || event.type === 'change') this.lastField = { key, result };
      else this.lastField = undefined;
      this.remember(event, element);
      return result;
    } catch (error) {
      this.options.log?.(
        `[TARGET_NOT_VALIDATABLE] ${event.id} ${error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error)}`,
      );
      return undefined;
    }
  }

  private remember(event: RawRecordedEvent, element: RecordedElement): void {
    const label = element.label ?? element.name;
    const option = event.value?.option?.label;
    this.previous.push(`${event.type} "${label}"${option ? ` = "${option}"` : ''}`);
    if (this.previous.length > 6) this.previous.shift();
  }

  /** Toutes les actions humaines reçues (dans l'ordre) : l'historique et les actions SUIVANTES. */
  private readonly observed: RawRecordedEvent[] = [];
  private lastEffects: string[] = [];

  /** Appelé dès la réception d'un événement (avant sa validation) : une action suivante devient une preuve. */
  observe(event: RawRecordedEvent): void {
    if (event.type === 'navigation' || event.type === 'control' || event.noise) return;
    this.observed.push(event);
    if (this.observed.length > 60) this.observed.shift();
  }

  private contextAction(event: RawRecordedEvent): ContextAction {
    const element = event.element;
    const option =
      event.value?.option?.label ??
      (event.value?.checked !== undefined ? (event.value.checked ? 'checked' : 'unchecked') : undefined);
    const section =
      element?.sectionPath && element.sectionPath.length > 0 ? element.sectionPath.join(' > ') : undefined;
    return {
      id: event.id,
      type:
        event.type === 'change' && option !== undefined && !event.value?.checked
          ? 'SELECT'
          : event.type.toUpperCase(),
      target:
        event.drag?.item ?? element?.label ?? element?.guessedLabel ?? element?.name ?? element?.tag ?? '',
      ...(option !== undefined ? { value: option } : {}),
      // Une saisie libre : son TYPE seulement, jamais sa valeur.
      ...(option === undefined && event.value
        ? { valueType: event.value.sensitive ? 'SENSITIVE' : event.value.shape }
        : {}),
      ...(section ? { section } : {}),
      ...(event.pre?.dialog
        ? { dialog: event.pre.dialog }
        : element?.dialogName
          ? { dialog: element.dialogName }
          : {}),
      at: event.at,
    };
  }

  private async original(
    page: Page,
    ref: string | undefined,
    suffix = '',
  ): Promise<ElementHandle | undefined> {
    if (!ref) return undefined;
    const handle: JSHandle = await page.evaluateHandle((key) => {
      const lookup = (window as unknown as Record<string, unknown>).__qaCrawlerOriginal;
      const el = typeof lookup === 'function' ? (lookup as (k: string) => Element | null)(key) : null;
      return el && el.isConnected ? el : null;
    }, `${ref}${suffix}`);
    const element = handle.asElement();
    if (!element) {
      await handle.dispose().catch(() => undefined);
      return undefined;
    }
    return element as ElementHandle;
  }

  private async validateTarget(
    page: Page,
    event: RawRecordedEvent,
    element: RecordedElement,
    candidate: RecordedTarget,
    ref: string | undefined,
  ): Promise<RecordingTargetValidation> {
    const log: string[] = [];
    const say = (line: string): void => {
      log.push(line);
      this.options.log?.(line);
    };
    const label = element.label ?? element.guessedLabel ?? element.name;
    say(`[TARGET_CAPTURED] ${event.id} ${event.type.toUpperCase()} "${label || element.tag}"`);
    say(`[TARGET_VALIDATING] ${event.id} ${describeTarget(candidate.target)}`);
    // LA CAPTURE PRÉ-ACTION (faite par la page au premier événement du geste) : son bilan d'abord.
    const capture = preActionCaptureOf(event);
    const postGeneration = await page
      .evaluate(() => {
        const read = (window as unknown as Record<string, unknown>).__qaCrawlerDomGeneration;
        return typeof read === 'function' ? (read as () => number)() : undefined;
      })
      .catch(() => undefined);
    if (postGeneration !== undefined) capture.postGeneration = postGeneration;
    if (capture.complete)
      say(
        `[PRE_ACTION_CAPTURE] action=${event.id} type=${event.type.toUpperCase()} target=${element.tag}${element.elementId && !element.generatedId ? `#${element.elementId}` : ''} phase=${capture.phase ?? '-'} generation=${String(capture.domGeneration ?? '-')} candidates=${String(capture.candidateCount)} originalCandidate=${capture.originalCandidateId ?? '-'}`,
      );
    else if (capture.captured)
      say(`[PRE_ACTION_CAPTURE_INCOMPLETE] action=${event.id} ${capture.diagnostic ?? ''}`);
    if (
      capture.domGeneration !== undefined &&
      postGeneration !== undefined &&
      postGeneration !== capture.domGeneration
    )
      say(
        `[DOM_GENERATION_CHANGED] action=${event.id} ${String(capture.domGeneration)} → ${String(postGeneration)} (the pre-action candidates describe the screen BEFORE the action: historical evidence, not stale)`,
      );
    const original = await this.original(page, ref);
    const observed = original ? await readTarget(original, page) : undefined;
    const traits = original
      ? await original.evaluate(elementTraits).catch(() => snapshotTraits(element))
      : snapshotTraits(element);
    const originalIdentity: RecordingTargetValidation['original'] = {
      ...identityOf(observed ?? fromSnapshot(element)),
      traits,
      ...(label ? { label } : {}),
      stale: !original,
    };
    const fingerprintBefore = candidate.fingerprint;
    let target = candidate.target;
    let fingerprint = fingerprintBefore;
    let before = await this.check(page, target, fingerprint, original, observed, element);
    // L'action a CHANGÉ l'élément (un bouton renommé après le clic) : la représentation enregistrée
    // décrit l'élément tel que l'humain l'a vu ; l'écran d'après n'est pas une preuve contre elle.
    // L'action a MASQUÉ l'élément (un panneau qui se referme, un bouton remplacé par un autre) :
    // le rejeu, lui, le trouvera visible avant l'action. Ce n'est pas une erreur de représentation.
    const hidden =
      original && !VALIDATED_STATUSES.has(before.status)
        ? !(await original.isVisible().catch(() => true))
        : false;
    if (hidden)
      before = {
        ...before,
        status: 'NOT_VALIDATABLE',
        confidence: 0.5,
        reason:
          'TARGET_HIDDEN_BY_ACTION: the element the human used is no longer visible after the action (kept as recorded)',
      };
    const capturedName = normalize(element.label ?? element.name);
    const nowName = normalize(observed?.name ?? observed?.text);
    if (
      !VALIDATED_STATUSES.has(before.status) &&
      before.status !== 'NOT_VALIDATABLE' &&
      capturedName &&
      nowName &&
      !nowName.includes(capturedName) &&
      !capturedName.includes(nowName)
    )
      before = {
        ...before,
        status: 'NOT_VALIDATABLE',
        confidence: 0.5,
        reason: `TARGET_CHANGED_BY_ACTION: "${element.label ?? element.name}" became "${observed?.name ?? observed?.text ?? ''}" after the action (kept as recorded)`,
      };
    // L'ÉCRAN APRÈS l'action, comparé à celui d'avant : les effets observés (une preuve, jamais
    // à la place de l'identité de la cible).
    const post = await postActionSummary(page);
    const effects = event.pre ? observedEffects(event.pre, post, original === undefined) : [];
    this.lastEffects = effects;
    // PRIORITÉ DES PREUVES D'IDENTITÉ (ValidationMode.RECORDING) : le nœud original au moment exact
    // de l'action d'abord ; s'il n'existe plus (re-rendu, disparu), son instantané et le contexte
    // PRÉ-ACTION font foi. Ce que le localisateur trouve APRÈS l'action n'est qu'une preuve
    // complémentaire : un nœud B qui porte maintenant le même sélecteur ne prouve pas que
    // l'humain visait le mauvais élément (jamais MISMATCH → réparation sur la seule foi de l'après).
    let liveCheck: TargetCheck | undefined;
    let reconstruction: { target: FlowTarget; repair: TargetRepair } | undefined;
    if (event.pre && (!original || before.status === 'NOT_VALIDATABLE')) {
      const pre = preActionCheck(target, element, event.pre);
      const live = before;
      liveCheck = live;
      const postState = { status: live.status, reason: live.reason };
      if (pre.unique && VALIDATED_STATUSES.has(live.status))
        before = { ...live, reason: `${live.reason}; pre-action: ${pre.reason}`, postState };
      else if (pre.unique)
        before = {
          ...live,
          status: effects.length > 0 ? 'VALIDATED_WITH_EFFECT' : 'VALIDATED_PRE_ACTION',
          confidence: effects.length > 0 ? 0.92 : 0.8,
          reason: `TARGET_VALIDATED_PRE_ACTION: ${pre.reason}${effects.length > 0 ? `; effect observed: ${effects.join(', ')}` : ''}`,
          preAction: true,
          // L'après ne contredit pas l'identité prouvée avant : il est gardé comme preuve, sans écart.
          differences: [],
          postState,
        };
      else {
        // RECONSTRUCTION depuis le candidat original : son identité (rôle, libellé, section) était-elle
        // la seule parmi les candidats figés avant l'action ? Alors elle devient la représentation.
        const candidates = event.pre.candidates ?? [];
        const originalCandidate = candidates.find((entry) => entry.id === capture.originalCandidateId);
        const twins = originalCandidate
          ? candidates.filter((entry) => candidateKey(entry) === candidateKey(originalCandidate)).length
          : 0;
        const rebuilt =
          originalCandidate && twins === 1 && normalize(originalCandidate.label ?? originalCandidate.name)
            ? targetOfCandidate(originalCandidate)
            : undefined;
        if (originalCandidate && rebuilt && JSON.stringify(rebuilt) !== JSON.stringify(target)) {
          reconstruction = {
            target: rebuilt,
            repair: {
              type: 'DETERMINISTIC',
              reason: 'PRE_ACTION_CANDIDATE_RECONSTRUCTION',
              changes: [
                { property: 'target', before: describeTarget(target), after: describeTarget(rebuilt) },
              ],
              evidence: ['pre-action-original-candidate', 'pre-action-candidates'],
            },
          };
          before = {
            ...live,
            status: effects.length > 0 ? 'VALIDATED_WITH_EFFECT' : 'VALIDATED_PRE_ACTION',
            confidence: 0.75,
            reason: `TARGET_VALIDATED_PRE_ACTION: ${pre.reason}; the original candidate ${originalCandidate.id} was the only "${originalCandidate.label ?? originalCandidate.name}"${originalCandidate.section ? ` in "${originalCandidate.section}"` : ''} before the action`,
            preAction: true,
            differences: [],
            postState,
          };
        } else
          before = {
            ...live,
            status: 'AMBIGUOUS',
            confidence: 0.6,
            reason: `PRE_ACTION_AMBIGUOUS: ${pre.reason} (the original element is gone: no exact match can be proven${VALIDATED_STATUSES.has(live.status) ? '; the post-action match is not an identity proof' : ''})`,
            preAction: true,
            differences: [],
            postState,
            candidates:
              candidates.length > 0
                ? candidates.slice(0, 8).map((entry, index) => ({
                    index,
                    role: entry.role,
                    name: entry.label ?? entry.name,
                    ...(entry.section ? { section: entry.section } : {}),
                    original: entry.origin === 'ORIGINAL_HUMAN_TARGET',
                  }))
                : event.pre.peers.slice(0, 6).map((peer, index) => ({
                    index,
                    role: peer.role,
                    name: peer.name,
                    ...(peer.section ? { section: peer.section } : {}),
                    original: false,
                  })),
          };
      }
    }
    let after: TargetCheck | undefined;
    let repair: TargetRepair | undefined = reconstruction?.repair;
    let attempts = reconstruction ? 2 : 1;
    if (reconstruction) {
      target = reconstruction.target;
      say(`[TARGET_REPAIRED] ${event.id} PRE_ACTION_CANDIDATE_RECONSTRUCTION: ${describeTarget(target)}`);
    }
    const report = (check: TargetCheck, prefix: string): void => {
      if (VALIDATED_STATUSES.has(check.status))
        say(
          `[${prefix}] ${event.id} ${check.status} (${check.reason}) confidence=${String(check.confidence)}`,
        );
      else
        say(
          `[TARGET_${check.status}] ${event.id} ${check.reason}${check.differences
            .map((d) => ` · ${d.property} recorded=${d.expected ?? '-'} runtime=${d.actual ?? '-'}`)
            .join('')}`,
        );
    };
    report(before, 'TARGET_VALIDATED');
    let current = before;

    const tried = new Set([JSON.stringify(target)]);
    // ---- ALIGNEMENT DE LA REPRÉSENTATION (identité prouvée AVANT l'action) : le nœud re-rendu a
    // l'identité de l'instantané mais le rejeu en lirait une autre empreinte (rôle, nom). L'identité
    // reste pré-action ; seule la représentation est alignée sur ce que le rejeu lira, puis revalidée.
    if (
      current.preAction === true &&
      VALIDATED_STATUSES.has(current.status) &&
      liveCheck &&
      (liveCheck.status === 'MISMATCH' || liveCheck.status === 'SEMANTIC_MISMATCH')
    ) {
      const proposal = this.repairOf(
        liveCheck,
        target,
        fingerprint,
        candidate,
        element,
        observed,
        tried,
        originalIdentity,
      );
      if (proposal) {
        attempts += 1;
        tried.add(JSON.stringify(proposal.target));
        const check = await this.check(
          page,
          proposal.target,
          proposal.fingerprint,
          original,
          observed,
          element,
        );
        if (VALIDATED_STATUSES.has(check.status)) {
          target = proposal.target;
          fingerprint = proposal.fingerprint;
          repair = {
            ...proposal.repair,
            reason: `REPRESENTATION_ALIGNED_POST_STATE: ${proposal.repair.reason}`,
            // L'identité vient d'AVANT l'action ; l'après ne fournit que ce que le rejeu lira.
            evidence: ['pre-action-identity', 'post-state-rerendered-node'],
          };
          say(
            `[TARGET_REPRESENTATION_ALIGNED] ${event.id} ${proposal.repair.reason} (identity proven before the action)`,
          );
          after = { ...current, reason: `${current.reason}; representation aligned: ${check.status}` };
          current = after;
        } else say(`[TARGET_REPAIR_REJECTED] ${event.id} ${proposal.repair.reason}: still ${check.status}`);
      }
    }

    // ---- RÉPARATION DÉTERMINISTE (bornée), puis REVALIDATION obligatoire.
    while (
      !VALIDATED_STATUSES.has(current.status) &&
      current.preAction !== true &&
      attempts <= this.options.maxDeterministicRepairAttempts &&
      current.status !== 'NOT_VALIDATABLE'
    ) {
      const proposal = this.repairOf(
        current,
        target,
        fingerprint,
        candidate,
        element,
        observed,
        tried,
        originalIdentity,
      );
      if (!proposal) break;
      attempts += 1;
      tried.add(JSON.stringify(proposal.target));
      const check = await this.check(
        page,
        proposal.target,
        proposal.fingerprint,
        original,
        observed,
        element,
      );
      if (VALIDATED_STATUSES.has(check.status)) {
        target = proposal.target;
        fingerprint = proposal.fingerprint;
        repair = proposal.repair;
        say(
          `[TARGET_REPAIRED] ${event.id} ${proposal.repair.reason}: ${proposal.repair.changes
            .map((change) => `${change.property} ${change.before ?? '-'} → ${change.after ?? '-'}`)
            .join(', ')}`,
        );
        report(check, 'TARGET_REVALIDATED');
        after = check;
        current = check;
        break;
      }
      say(`[TARGET_REPAIR_REJECTED] ${event.id} ${proposal.repair.reason}: still ${check.status}`);
    }

    // ---- AUDIT par le conseiller (seulement si le déterministe ne suffit pas), puis REVALIDATION.
    let aiAudit: TargetAiAudit | undefined;
    // Une cible disparue ne peut pas être RE-PROUVÉE au runtime : un résultat pré-action validé n'est
    // jamais audité ; une ambiguïté PRÉ-ACTION, si : la proposition est revalidée contre les preuves
    // d'avant l'action (jamais contre l'effet ou un objectif atteint).
    if (
      this.options.advisor &&
      this.options.auditOn.has(current.status) &&
      (current.preAction !== true || current.status === 'AMBIGUOUS')
    ) {
      const outcome = await this.audit(
        page,
        event,
        candidate,
        target,
        fingerprint,
        current,
        original,
        observed,
        element,
        originalIdentity,
      );
      aiAudit = outcome.audit;
      say(`[TARGET_AI_AUDIT] ${event.id} ${outcome.audit.outcome}: ${outcome.audit.reason}`);
      if (outcome.validated) {
        target = outcome.validated.target;
        fingerprint = outcome.validated.fingerprint;
        repair = outcome.validated.repair;
        after = { ...outcome.validated.check, status: 'VALIDATED_AFTER_AI_AUDIT' };
        current = after;
        attempts += 1;
        report(after, 'TARGET_REVALIDATED');
      }
    }

    const validated = VALIDATED_STATUSES.has(current.status);
    const changed =
      JSON.stringify(target) !== JSON.stringify(candidate.target) ||
      JSON.stringify(fingerprint) !== JSON.stringify(fingerprintBefore);
    const effect = await this.effectOf(page, event, original, target, effects);
    const result: Omit<RecordingTargetValidation, 'verdict'> = {
      mode: ValidationMode.RECORDING,
      preActionCapture: capture,
      currentRuntime: { originalStillPresent: original !== undefined },
      rawEventId: event.id,
      action: event.type,
      timestamp: Date.now(),
      status: current.status,
      confidence: current.confidence,
      attempts,
      original: originalIdentity,
      targetBefore: candidate.target,
      ...(fingerprintBefore ? { fingerprintBefore } : {}),
      validationBefore: before,
      ...(repair ? { repair } : {}),
      ...(changed ? { targetAfter: target, ...(fingerprint ? { fingerprintAfter: fingerprint } : {}) } : {}),
      ...(after ? { validationAfter: after } : {}),
      ...(aiAudit ? { aiAudit } : {}),
      ...(effects.length > 0 ? { effects } : {}),
      ...(validated && effects.length > 0 ? { semanticallyConfirmed: true } : {}),
      repairApplied: changed,
      aiAudited: aiAudit !== undefined && aiAudit.outcome !== 'NOT_CALLED',
      // Prouvé sur le nœud original au runtime (pas un re-rendu, pas le seul contexte pré-action).
      originalTargetMatch:
        validated && current.status !== 'VALIDATED_AFTER_RERENDER' && current.preAction !== true
          ? true
          : current.sameElement === true,
      requiresReplayValidation: !validated,
      knowledge: { recordingValidated: validated, replayValidated: false },
      log,
    };
    const verdict = verdictOf(result, effect);
    const published = publishedStatus(result, effect);
    const validatedCandidate =
      VALIDATED_STATUSES.has(current.status) && current.preAction === true
        ? aiAudit?.outcome === 'AI_PROPOSAL_RUNTIME_CONFIRMED'
          ? aiAudit.candidate
          : capture.originalCandidateId
        : undefined;
    if (published.startsWith('VALIDATED_LIVE') || published.startsWith('VALIDATED_PRE_ACTION'))
      say(
        `[TARGET_${published}] action=${event.id}${validatedCandidate ? ` candidate=${validatedCandidate}` : ''} confidence=${String(current.confidence)}`,
      );
    say(
      `[RECORDING_VERDICT] ${event.id} target=${verdict.target.status} (${verdict.target.source}) effect=${verdict.effect.status} goal=${verdict.goal.status}`,
    );
    return {
      ...result,
      validationStatus: published,
      ...(validatedCandidate ? { validatedCandidate } : {}),
      verdict,
    };
  }

  /**
   * L'EFFET de l'action, lu sur l'écran d'APRÈS (lecture seule) : une preuve complémentaire, jamais
   * l'identité de la cible. Une saisie se compare par empreinte salée (jamais la valeur en clair,
   * jamais pour un champ sensible) ; le champ re-rendu est relu par son localisateur.
   */
  private async effectOf(
    page: Page,
    event: RawRecordedEvent,
    original: ElementHandle | undefined,
    target: FlowTarget | undefined,
    screen: readonly string[],
  ): Promise<RecordingVerdict['effect']> {
    const value = event.value;
    const field = event.type === 'input' || event.type === 'change';
    if (!field || !value)
      return screen.length > 0
        ? { status: 'CONFIRMED', evidence: [...screen] }
        : { status: 'NOT_OBSERVED', evidence: [] };
    if (value.sensitive)
      return { status: 'NOT_VERIFIABLE', evidence: ['sensitive field: its value is never read'] };
    const label =
      event.element?.label ||
      event.element?.guessedLabel ||
      event.element?.name ||
      (target ? describeTarget(target) : 'field');
    let handle: ElementHandle | Locator | undefined = original;
    let cleanup: (() => Promise<void>) | undefined;
    if (!handle && target) {
      const live = await postStateLocator(page, target, () => {
        this.tokens += 1;
        return `effect-${String(this.tokens)}`;
      });
      handle = live?.locator;
      cleanup = live?.cleanup;
    }
    if (!handle) return { status: 'NOT_VERIFIABLE', evidence: ['the field is no longer on the screen'] };
    const where = original ? '' : ' (post-state: the re-rendered field)';
    try {
      const salt = this.salt ?? '';
      const state = await (
        'asElement' in handle ? handle.evaluate(readFieldState, salt) : handle.evaluate(readFieldState, salt)
      ).catch(() => undefined);
      if (!state) return { status: 'NOT_VERIFIABLE', evidence: [] };
      if (value.checked !== undefined)
        return state.checked === value.checked
          ? {
              status: 'CONFIRMED',
              evidence: [`"${label}" is ${value.checked ? 'checked' : 'unchecked'}${where}`],
            }
          : { status: 'NOT_OBSERVED', evidence: [] };
      if (value.option) {
        const wanted = normalize(value.option.label);
        const shown = normalize(state.selected);
        return wanted && shown && (shown === wanted || shown.includes(wanted))
          ? { status: 'CONFIRMED', evidence: [`"${label}" = "${value.option.label}"${where}`] }
          : { status: 'NOT_OBSERVED', evidence: [] };
      }
      if (!value.digest || !this.salt) return { status: 'NOT_VERIFIABLE', evidence: [] };
      return state.digest === value.digest
        ? { status: 'CONFIRMED', evidence: [`"${label}" holds the typed value${where}`] }
        : { status: 'NOT_OBSERVED', evidence: [`"${label}" does not hold the typed value yet`] };
    } finally {
      await cleanup?.();
    }
  }

  /**
   * DRY RESOLVE + COMPARAISON : la cible est résolue comme au rejeu, puis comparée à l'original
   * (même nœud quand il existe encore ; sinon l'instantané : identité sémantique, section).
   */
  async check(
    page: Page,
    target: FlowTarget,
    fingerprint: TargetFingerprint | undefined,
    original: ElementHandle | undefined,
    observed: ObservedTarget | undefined,
    snapshot: RecordedElement,
  ): Promise<TargetCheck> {
    const resolution = await this.resolve(page, target, original);
    if (resolution.count === 0)
      return {
        status: original ? 'NOT_FOUND' : 'NOT_VALIDATABLE',
        confidence: original ? 0.9 : 0.3,
        reason: original
          ? `${describeTarget(target)} finds no element (the human target is still on the screen)`
          : 'the screen changed before the validation (original element and target both gone)',
        candidateCount: 0,
        differences: [],
      };
    if (resolution.count > 1 && resolution.chosen === undefined) {
      return {
        status: 'AMBIGUOUS',
        confidence: 0.9,
        reason: `${String(resolution.count)} elements match ${describeTarget(target)}: never the first one by chance`,
        candidateCount: resolution.count,
        differences: [],
        candidates: resolution.candidates,
      };
    }
    const resolved = resolution.observed ?? {};
    const resolvedIdentity = identityOf(resolved);
    if (original) {
      if (!resolution.sameElement) {
        const context = sectionMatch(observed?.section, resolved.section);
        return {
          status: context === 'OTHER' ? 'CONTEXT_MISMATCH' : 'MISMATCH',
          confidence: 0.95,
          reason:
            context === 'OTHER'
              ? `RESOLVED_IN_OTHER_SECTION: "${resolved.section ?? ''}" instead of "${observed?.section ?? ''}"`
              : 'RESOLVED_OTHER_ELEMENT: the representation finds another element than the one the human used',
          candidateCount: resolution.count,
          sameElement: false,
          resolved: resolvedIdentity,
          differences: [
            {
              property: 'element',
              expected: describeIdentity(identityOf(observed ?? {})),
              actual: describeIdentity(resolvedIdentity),
            },
          ],
        };
      }
      return this.compareFingerprint(
        target,
        fingerprint,
        observed ?? resolved,
        resolution.count,
        resolvedIdentity,
        false,
      );
    }
    // L'élément original a été remplacé (re-rendu) : l'instantané fait foi.
    const snap = fromSnapshot(snapshot);
    const sameTag = !snap.tag || !resolved.tag || snap.tag === resolved.tag;
    const wantedName = normalize(snapshot.label ?? snapshot.guessedLabel ?? snapshot.name);
    const foundName = normalize(resolved.name ?? resolved.text);
    const sameName =
      !wantedName ||
      !foundName ||
      foundName === wantedName ||
      foundName.includes(wantedName) ||
      wantedName.includes(foundName);
    const sameSection = sectionMatch(snap.section, resolved.section) !== 'OTHER';
    if (!sameTag || !sameName || !sameSection)
      return {
        status: 'STALE_BEFORE_VALIDATION',
        confidence: 0.5,
        reason:
          'the original element was replaced before the validation and the resolved one differs from its snapshot',
        candidateCount: resolution.count,
        resolved: resolvedIdentity,
        differences: [
          ...(!sameTag ? [{ property: 'tag' as const, expected: snap.tag, actual: resolved.tag }] : []),
          ...(!sameName ? [{ property: 'name' as const, expected: wantedName, actual: foundName }] : []),
          ...(!sameSection
            ? [{ property: 'section' as const, expected: snap.section, actual: resolved.section }]
            : []),
        ],
      };
    const compared = this.compareFingerprint(
      target,
      fingerprint,
      resolved,
      resolution.count,
      resolvedIdentity,
      true,
    );
    return compared.status === 'VALIDATED'
      ? { ...compared, status: 'VALIDATED_AFTER_RERENDER', confidence: 0.85 }
      : compared;
  }

  /** Le même élément : l'empreinte dit-elle ce que le rejeu en lira ? (CSS stable ≠ identité correcte). */
  private compareFingerprint(
    target: FlowTarget,
    fingerprint: TargetFingerprint | undefined,
    actual: ObservedTarget,
    count: number,
    resolved: TargetIdentity,
    rerendered: boolean,
  ): TargetCheck {
    const differences: TargetDifference[] = [];
    if (fingerprint?.role && actual.role && fingerprint.role !== actual.role)
      differences.push({ property: 'role', expected: fingerprint.role, actual: actual.role });
    if (fingerprint?.tag && actual.tag && fingerprint.tag !== actual.tag)
      differences.push({ property: 'tag', expected: fingerprint.tag, actual: actual.tag });
    if (fingerprint?.testId && actual.testId && fingerprint.testId !== actual.testId)
      differences.push({ property: 'testId', expected: fingerprint.testId, actual: actual.testId });
    const wanted = normalize(fingerprint?.name ?? fingerprint?.text);
    const found = [normalize(actual.name), normalize(actual.text)].filter(Boolean);
    if (
      wanted &&
      found.length > 0 &&
      !found.some(
        (text) => text === wanted || text.includes(wanted) || (text.length >= 3 && wanted.includes(text)),
      )
    )
      differences.push({
        property: 'name',
        expected: fingerprint?.name ?? fingerprint?.text,
        actual: actual.name ?? actual.text,
      });
    if (fingerprint?.section && sectionMatch(fingerprint.section, actual.section) === 'OTHER')
      differences.push({ property: 'section', expected: fingerprint.section, actual: actual.section });
    // Le contrôle du rejeu lui-même : ce qui y échouerait doit échouer maintenant.
    const replay = fingerprint ? matchFingerprint(fingerprint, actual) : undefined;
    const base = {
      candidateCount: count,
      sameElement: !rerendered,
      ...(rerendered ? { sameIdentity: true } : {}),
      resolved,
      differences,
    };
    if (differences.some((d) => d.property === 'section'))
      return { ...base, status: 'CONTEXT_MISMATCH', confidence: 0.95, reason: 'RECORDED_SECTION_INCORRECT' };
    if (differences.some((d) => d.property === 'role'))
      return { ...base, status: 'MISMATCH', confidence: 0.99, reason: 'RECORDED_ROLE_INCORRECT' };
    if (differences.some((d) => d.property === 'tag' || d.property === 'testId'))
      return {
        ...base,
        status: 'MISMATCH',
        confidence: 0.95,
        reason: `RECORDED_${differences[0]?.property.toUpperCase() ?? 'IDENTITY'}_INCORRECT`,
      };
    if (differences.some((d) => d.property === 'name'))
      return { ...base, status: 'SEMANTIC_MISMATCH', confidence: 0.9, reason: 'RECORDED_NAME_INCORRECT' };
    if (replay?.verdict === 'MISMATCH')
      return {
        ...base,
        status: 'MISMATCH',
        confidence: 0.85,
        reason: `REPLAY_FINGERPRINT_CHECK_WOULD_FAIL (${replay.reasons.join('; ')})`,
      };
    if (isFragileTarget(target) || target.nth !== undefined)
      return {
        ...base,
        status: 'VALIDATED_FRAGILE',
        confidence: 0.7,
        reason: 'FRAGILE_TARGET: found only by its position in the page',
      };
    return {
      ...base,
      status: 'VALIDATED',
      confidence: 0.97,
      reason: rerendered ? 'semantic snapshot match' : 'exact element match',
    };
  }

  /** Résolution À SEC, comme au rejeu : jamais une action, seulement compter, lire, comparer. */
  private async resolve(
    page: Page,
    target: FlowTarget,
    original: ElementHandle | undefined,
  ): Promise<{
    count: number;
    chosen?: number;
    sameElement?: boolean;
    observed?: ObservedTarget;
    candidates?: (TargetIdentity & { index: number; original: boolean })[];
  }> {
    if (
      target.section !== undefined &&
      target.nth === undefined &&
      target.strategy !== 'css' &&
      target.strategy !== 'testId'
    ) {
      this.tokens += 1;
      const token = `validate-${String(this.tokens)}`;
      const label = target.strategy === 'role' ? (target.name ?? '') : (target.value ?? '');
      const kind =
        target.strategy === 'label' || (target.strategy === 'role' && FIELD_ROLES.has(target.role ?? ''))
          ? 'field'
          : 'control';
      const scan = (await page
        .evaluate(
          semanticScanExpression({
            kind,
            label,
            ...(target.strategy === 'role' && target.role ? { role: target.role } : {}),
            section: target.section,
            token,
          }),
        )
        .catch(() => undefined)) as SemanticScanResult | undefined;
      if (!scan || scan.status === 'NOT_FOUND') return { count: 0 };
      if (scan.status === 'AMBIGUOUS')
        return {
          count: scan.candidates.length,
          candidates: scan.candidates.map((candidate, index) => ({
            index,
            role: candidate.role,
            name: candidate.label,
            section: candidate.section,
            original: false,
          })),
        };
      const locator = page.locator(`[data-qa-crawler-target="${token}"]`).first();
      const sameElement = original
        ? await locator
            .evaluate((el, orig) => {
              if (el === orig) return true;
              const INTERACTIVE =
                'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], [role="combobox"], [role="checkbox"], [role="radio"], [role="switch"], [contenteditable]:not([contenteditable="false"])';
              // Le texte d'un contrôle (le libellé dans un mat-select) : le rejeu agit sur le contrôle englobant.
              return orig.contains(el) && el.closest(INTERACTIVE) === orig;
            }, original)
            .catch(() => false)
        : undefined;
      const observed = await readTarget(locator);
      await locator
        .evaluate((el) => {
          el.removeAttribute('data-qa-crawler-target');
        })
        .catch(() => undefined);
      return { count: 1, chosen: 0, ...(sameElement !== undefined ? { sameElement } : {}), observed };
    }
    const base = toLocator(page, {
      strategy: target.strategy,
      ...(target.role !== undefined ? { role: target.role } : {}),
      ...(target.name !== undefined ? { name: target.name } : {}),
      ...(target.value !== undefined ? { value: target.value } : {}),
      ...(target.exact !== undefined ? { exact: target.exact } : {}),
    });
    const count = await base.count().catch(() => 0);
    if (count === 0) return { count };
    const matches = original
      ? await base
          .evaluateAll((els, orig) => {
            const INTERACTIVE =
              'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], [role="combobox"], [role="checkbox"], [role="radio"], [role="switch"], [contenteditable]:not([contenteditable="false"])';
            return els
              .slice(0, 20)
              .map((el) => el === orig || (orig.contains(el) && el.closest(INTERACTIVE) === orig));
          }, original)
          .catch(() => [] as boolean[])
      : [];
    if (target.nth === undefined && count > 1) {
      // LE CHOIX DU REJEU, simulé : l'élément visible de la fenêtre ouverte d'abord, sinon le premier.
      // Sans équivoque (un seul candidat visible, un seul dans la fenêtre) : ce n'est pas une ambiguïté.
      const info = await base
        .evaluateAll((els) => {
          const MODAL =
            '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open], .cdk-overlay-pane';
          return els.slice(0, 20).map((el) => {
            const rect = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            const boxed = rect.width > 0 || rect.height > 0;
            return {
              visible: boxed && style.visibility !== 'hidden' && style.display !== 'none',
              modal: boxed && el.closest(MODAL) !== null,
            };
          });
        })
        .catch(() => [] as { visible: boolean; modal: boolean }[]);
      const modals = info.filter((entry) => entry.modal).length;
      const visibles = info.filter((entry) => entry.visible).length;
      const pick = modals > 0 ? info.findIndex((entry) => entry.modal) : 0;
      if (info[pick]?.visible && (modals > 0 ? modals === 1 : visibles === 1)) {
        const chosen = base.nth(pick);
        return {
          count,
          chosen: pick,
          ...(original ? { sameElement: matches[pick] === true } : {}),
          observed: await readTarget(chosen),
        };
      }
      const candidates: (TargetIdentity & { index: number; original: boolean; visible?: boolean })[] = [];
      for (let index = 0; index < Math.min(count, 6); index += 1)
        candidates.push({
          index,
          ...identityOf(await readTarget(base.nth(index))),
          traits: await base
            .nth(index)
            .evaluate(elementTraits)
            .catch(() => ({ visible: false, inDialog: false, focused: false })),
          original: matches[index] === true,
          visible: info[index]?.visible === true,
        });
      return { count, candidates };
    }
    const index = target.nth ?? 0;
    if (index >= count) return { count: 0 };
    const chosen = base.nth(index);
    return {
      count,
      chosen: index,
      ...(original ? { sameElement: matches[index] === true } : {}),
      observed: await readTarget(chosen),
    };
  }

  /**
   * RÉPARATION DÉTERMINISTE, à partir des preuves runtime : l'empreinte prend ce que le rejeu lira
   * de l'élément original ; une cible qui trouve un autre élément est remplacée par une alternative
   * sémantique (section d'abord) — jamais par une position (nth) : celle-ci reste au conseiller.
   */
  private repairOf(
    check: TargetCheck,
    target: FlowTarget,
    fingerprint: TargetFingerprint | undefined,
    candidate: RecordedTarget,
    element: RecordedElement,
    observed: ObservedTarget | undefined,
    tried: ReadonlySet<string>,
    originalIdentity?: TargetIdentity,
  ): { target: FlowTarget; fingerprint: TargetFingerprint | undefined; repair: TargetRepair } | undefined {
    // La vérité runtime : l'élément original lu comme au rejeu ; après un re-rendu, l'élément de même identité.
    const truth: ObservedTarget | undefined = observed ?? (check.sameIdentity ? check.resolved : undefined);
    const corrected = (
      base: TargetFingerprint | undefined,
    ): { fingerprint: TargetFingerprint | undefined; changes: TargetRepair['changes'] } => {
      if (!base || !truth) return { fingerprint: base, changes: [] };
      const next: TargetFingerprint = { ...base };
      const changes: TargetRepair['changes'] = [];
      for (const difference of check.differences) {
        if (difference.property === 'element') continue;
        const value = truth[difference.property];
        if (difference.property === 'name') {
          const name = truth.name ?? truth.text;
          if (name) {
            changes.push({ property: 'name', ...(base.name ? { before: base.name } : {}), after: name });
            next.name = name;
          }
          continue;
        }
        if (value === undefined) continue;
        changes.push({
          property: difference.property,
          ...(base[difference.property] ? { before: base[difference.property] } : {}),
          after: value,
        });
        next[difference.property] = value;
      }
      return { fingerprint: next, changes };
    };
    const reasonOf = check.reason.split(':')[0]?.split(' ')[0] ?? check.status;
    // 1. Le bon élément, une empreinte fausse : l'empreinte prend la vérité runtime.
    if ((check.sameElement || check.sameIdentity) && check.differences.length > 0) {
      const { fingerprint: repaired, changes } = corrected(fingerprint);
      if (changes.length === 0) return undefined;
      return {
        target,
        fingerprint: repaired,
        repair: { type: 'DETERMINISTIC', reason: reasonOf, changes, evidence: ['runtime-original-target'] },
      };
    }
    // 1 bis. Le bon élément, mais le contrôle d'empreinte du rejeu échouerait (un nom que le rejeu
    // ne lit pas) : l'empreinte dit ce que le rejeu lira — jamais une autre cible.
    if (
      (check.sameElement || check.sameIdentity) &&
      check.reason.startsWith('REPLAY_FINGERPRINT_CHECK_WOULD_FAIL') &&
      fingerprint &&
      truth
    ) {
      const next: TargetFingerprint = { ...fingerprint, ...identityPatch(truth) };
      const changes: TargetRepair['changes'] = [];
      const name = truth.name ?? truth.text;
      if (name && name !== fingerprint.name) {
        next.name = name;
        changes.push({
          property: 'name',
          ...(fingerprint.name ? { before: fingerprint.name } : {}),
          after: name,
        });
      } else if (!name && fingerprint.name) {
        delete next.name;
        delete next.text;
        changes.push({
          property: 'name',
          before: fingerprint.name,
          after: '(not readable at replay: label, section and role identify it)',
        });
      }
      if (changes.length === 0) return undefined;
      return {
        target,
        fingerprint: next,
        repair: {
          type: 'DETERMINISTIC',
          reason: 'RECORDED_NAME_NOT_READABLE_AT_REPLAY',
          changes,
          evidence: ['runtime-original-target'],
        },
      };
    }
    // Le bon élément : seule l'empreinte pouvait être corrigée ; jamais une autre cible à sa place.
    if (check.sameElement || check.sameIdentity) return undefined;
    // 2. Un autre élément, aucun, ou plusieurs : une représentation SÉMANTIQUE plus précise.
    // La section VRAIE est celle de l'élément original (lue comme au rejeu), pas celle de l'instantané.
    const section =
      truth?.section ??
      (element.sectionPath && element.sectionPath.length > 0 ? element.sectionPath.join(' > ') : undefined);
    const options: FlowTarget[] = [];
    // Des copies cachées (gabarit, panneau fermé) : la cible restreinte aux éléments VISIBLES,
    // quand l'original est le seul visible — jamais une position.
    const onlyVisibleIsOriginal =
      check.candidates !== undefined &&
      check.candidates.filter((candidate) => candidate.visible).length === 1 &&
      check.candidates.some((candidate) => candidate.visible && candidate.original);
    if (onlyVisibleIsOriginal && target.strategy === 'css' && !target.value?.includes('visible=true'))
      options.push({ ...target, value: `${target.value ?? ''} >> visible=true` });
    if (onlyVisibleIsOriginal && target.strategy === 'text')
      options.push({ strategy: 'css', value: `text=${JSON.stringify(target.value ?? '')} >> visible=true` });
    if (
      section &&
      (target.strategy === 'label' || target.strategy === 'role' || target.strategy === 'text') &&
      target.section !== section
    )
      options.push({ ...target, section });
    // L'ATTRIBUT STABLE qui distingue l'original de ses pareils (formControlName, name, id,
    // placeholder) : une représentation précise, jamais une position.
    const own = originalIdentity?.traits;
    const others = (check.candidates ?? []).filter((entry) => !entry.original).map((entry) => entry.traits);
    const tag = originalIdentity?.tag ?? element.tag;
    const quote = (value: string): string => JSON.stringify(value);
    const distinguishing: [
      string | undefined,
      (value: string) => string,
      (traits: ElementTraits | undefined) => string | undefined,
    ][] = [
      [
        own?.formControl,
        (value) => `${tag}[formcontrolname=${quote(value)}]`,
        (traits) => traits?.formControl,
      ],
      [own?.name, (value) => `${tag}[name=${quote(value)}]`, (traits) => traits?.name],
      [own?.id, (value) => `${tag}[id=${quote(value)}]`, (traits) => traits?.id],
      [own?.placeholder, (value) => `${tag}[placeholder=${quote(value)}]`, (traits) => traits?.placeholder],
    ];
    for (const [value, selector, of] of distinguishing)
      if (value && !others.some((traits) => of(traits) === value)) {
        const css = selector(value);
        if (target.strategy !== 'css' || target.value !== css) options.push({ strategy: 'css', value: css });
      }
    for (const alternative of candidate.alternatives) {
      if (alternative.target.nth !== undefined || isFragileTarget(alternative.target)) continue;
      options.push(alternative.target);
      if (section && alternative.target.strategy === 'label' && alternative.target.section !== section)
        options.push({ ...alternative.target, section });
    }
    const next = options.find((option) => !tried.has(JSON.stringify(option)));
    if (!next) return undefined;
    const fingerprintAfter = truth && fingerprint ? { ...fingerprint, ...identityPatch(truth) } : fingerprint;
    return {
      target: next,
      fingerprint: fingerprintAfter,
      repair: {
        type: 'DETERMINISTIC',
        reason:
          check.status === 'AMBIGUOUS'
            ? 'AMBIGUOUS_TARGET_DISAMBIGUATED'
            : check.status === 'CONTEXT_MISMATCH'
              ? 'TARGET_CONTEXT_REPAIRED'
              : 'TARGET_REPRESENTATION_REPAIRED',
        changes: [{ property: 'target', before: describeTarget(target), after: describeTarget(next) }],
        evidence: ['runtime-original-target', ...(section ? [`section "${section}"`] : [])],
      },
    };
  }

  /** Le conseiller choisit une candidate fournie ; QA-CRAWLER la RÉSOUT puis la compare à l'original. */
  private async audit(
    page: Page,
    event: RawRecordedEvent,
    candidate: RecordedTarget,
    target: FlowTarget,
    fingerprint: TargetFingerprint | undefined,
    check: TargetCheck,
    original: ElementHandle | undefined,
    observed: ObservedTarget | undefined,
    element: RecordedElement,
    originalIdentity: TargetIdentity & { label?: string },
  ): Promise<{
    audit: TargetAiAudit;
    validated?: {
      target: FlowTarget;
      fingerprint: TargetFingerprint | undefined;
      check: TargetCheck;
      repair: TargetRepair;
    };
  }> {
    const advisor = this.options.advisor;
    if (!advisor) return { audit: { outcome: 'NOT_CALLED', citedEvidence: [], reason: 'no advisor' } };
    const candidates: (ContextCandidate & { description: string })[] = [];
    // AMBIGUÏTÉ PRÉ-ACTION : l'élément original n'existe plus ; les candidates sont les éléments du
    // même genre visibles JUSTE AVANT l'action (jamais ce que le localisateur trouve après).
    const preAction = check.preAction === true && event.pre !== undefined;
    const captured = event.pre?.candidates ?? [];
    if (preAction && captured.length > 0)
      // Les candidats FIGÉS AVANT l'action, avec leur identifiant de capture (T1 = la cible originale).
      for (const entry of captured.slice(0, 12)) {
        const name = entry.label ?? entry.name;
        candidates.push({
          key: entry.id,
          target: targetOfCandidate(entry),
          found:
            entry.origin === 'ORIGINAL_HUMAN_TARGET'
              ? 'the element the human used (captured before the action)'
              : 'visible before the action',
          identity: {
            role: entry.role,
            tag: entry.tag,
            name,
            ...(entry.section ? { section: entry.section } : {}),
          },
          preAction: {
            origin: entry.origin,
            relationship: entry.relationship,
            ...(entry.nearby ? { nearby: entry.nearby } : {}),
            ...(entry.container
              ? {
                  container: `${entry.container.tag}${entry.container.label ? ` "${entry.container.label}"` : ''}`,
                }
              : {}),
            ...(entry.cssHint ? { cssHint: entry.cssHint } : {}),
          },
          description: `before the action: ${entry.role || entry.tag} "${shorten(name, 40)}"${entry.section ? ` in "${shorten(entry.section, 40)}"` : ''}${entry.nearby?.length ? ` near "${shorten(entry.nearby.join(', '), 40)}"` : ''}`,
        });
      }
    else if (preAction)
      for (const [index, peer] of (event.pre?.peers ?? []).slice(0, 8).entries())
        candidates.push({
          key: `T${String(index + 1)}`,
          target: {
            strategy: 'role',
            role: peer.role,
            name: peer.name,
            ...(peer.section ? { section: peer.section } : {}),
          },
          found: 'visible before the action',
          identity: { role: peer.role, name: peer.name, ...(peer.section ? { section: peer.section } : {}) },
          description: `before the action: ${peer.role} "${shorten(peer.name, 40)}"${peer.section ? ` in "${shorten(peer.section, 40)}"` : ''}`,
        });
    const options: FlowTarget[] = [];
    const add = (option: FlowTarget): void => {
      if (!options.some((known) => JSON.stringify(known) === JSON.stringify(option))) options.push(option);
    };
    if (!preAction) add(target);
    if (!preAction) for (const alternative of candidate.alternatives) add(alternative.target);
    // Plusieurs éléments correspondent : chacun devient une candidate (par sa position), décrite par son identité.
    if (check.candidates && !preAction)
      for (const entry of check.candidates) add({ ...target, nth: entry.index });
    // Chaque candidate est décrite par ce qu'elle trouve VRAIMENT (combien, et ses traits) : sans cela
    // le conseiller ne peut que parier entre des « textbox » identiques.
    for (const [index, option] of options.slice(0, 8).entries()) {
      const identity = check.candidates?.find(
        (entry) => option.nth === entry.index && option.strategy === target.strategy,
      );
      let found = identity ? describeIdentity(identity) : '';
      let resolvedIdentity: ContextCandidate['identity'] = identity;
      if (!identity) {
        const resolution: { count: number; chosen?: number; observed?: ObservedTarget } = await this.resolve(
          page,
          option,
          undefined,
        ).catch(() => ({ count: 0 }));
        found =
          resolution.count === 0
            ? 'finds nothing'
            : resolution.count > 1 && resolution.chosen === undefined
              ? `finds ${String(resolution.count)} elements`
              : 'finds 1 element';
        if (resolution.observed) resolvedIdentity = identityOf(resolution.observed);
      }
      candidates.push({
        key: `T${String(index + 1)}`,
        target: option,
        found,
        ...(resolvedIdentity ? { identity: resolvedIdentity } : {}),
        // Ce qui départage d'abord (identité, traits), le localisateur ensuite, raccourci.
        description: `${found} ← ${shorten(describeTarget({ ...option, nth: undefined }), 48)}${option.nth ? ` [${String(option.nth)}]` : ''}`,
      });
    }
    // CONTEXT BEFORE DECISION : l'historique et les actions SUIVANTES déjà reçues (des preuves).
    const position = this.observed.findIndex((entry) => entry.id === event.id);
    const history = (
      position >= 0 ? this.observed.slice(0, position) : this.observed.filter((entry) => entry.at < event.at)
    ).map((entry) => this.contextAction(entry));
    const next = (position >= 0 ? this.observed.slice(position + 1) : []).map((entry) =>
      this.contextAction(entry),
    );
    // AUCUN CANDIDAT : le conseiller ne peut pas inventer la cible (il n'est jamais consulté).
    if (candidates.length === 0)
      return {
        audit: {
          outcome: 'NOT_CALLED',
          citedEvidence: [],
          reason: 'PRE_ACTION_CAPTURE_INCOMPLETE: no captured candidate — the advisor never invents a target',
        },
      };
    if (preAction)
      this.options.log?.(
        `[AI_PRE_ACTION_AUDIT_REQUESTED] action=${event.id} candidates=${String(candidates.length)}${event.pre?.originalCandidateId ? ` originalCandidate=${event.pre.originalCandidateId}` : ''}`,
      );
    const answer = await advisor({
      event,
      original: originalIdentity,
      check,
      candidates,
      previousActions: [...this.previous],
      context: {
        flowName: this.options.flowName ?? 'recording',
        event: {
          id: event.id,
          type: event.type,
          at: event.at,
          ...(event.value && !event.value.option
            ? { valueType: event.value.sensitive ? 'SENSITIVE' : event.value.shape }
            : {}),
        },
        original: originalIdentity,
        ...(fingerprint ? { fingerprint } : {}),
        recordedTarget: target,
        validation: {
          status: check.status,
          reason: check.reason,
          confidence: check.confidence,
          candidateCount: check.candidateCount,
          differences: check.differences,
        },
        ...(event.pre ? { pre: event.pre } : {}),
        effects: this.lastEffects,
        history,
        next,
        ...(this.options.sources ? { sources: this.options.sources } : {}),
      },
    });
    if (answer.contextStats)
      this.options.log?.(
        `[AI_CONTEXT_BUILT] trigger=TARGET_${check.status} action=${event.id} candidates=${String(answer.contextStats.candidates)} evidence=${String(answer.contextStats.evidence)} previousActions=${String(answer.contextStats.previousActions)} futureActions=${String(answer.contextStats.futureActions)}`,
      );
    if (answer.contextStats)
      this.options.log?.(
        `[AI_CONTEXT_SANITIZED] action=${event.id} redactions=${String(answer.contextStats.redactions)}`,
      );
    this.options.log?.(`[AI_TARGET_AUDIT_REQUESTED] action=${event.id}`);
    if (answer.selectedKey)
      this.options.log?.(
        `[${preAction ? 'AI_PRE_ACTION_PROPOSAL' : 'AI_TARGET_PROPOSAL'}] action=${event.id} candidate=${answer.selectedKey}${answer.confidence !== undefined ? ` confidence=${String(answer.confidence)}` : ''}`,
      );
    const base = {
      ...(answer.decisionId ? { decisionId: answer.decisionId } : {}),
      citedEvidence: answer.citedEvidence,
    };
    if (answer.outcome === 'UNAVAILABLE')
      return {
        audit: { ...base, outcome: 'UNAVAILABLE', reason: 'advisor unavailable: deterministic result kept' },
      };
    if (answer.contextSummary) Object.assign(base, { context: answer.contextSummary });
    const chosen = candidates.find((entry) => entry.key === answer.selectedKey);
    if (!chosen)
      return {
        audit: {
          ...base,
          outcome: 'INCONCLUSIVE',
          reason: 'no candidate selected: deterministic result kept',
        },
      };
    if (preAction) return this.revalidatePreAction(event, element, target, fingerprint, chosen, answer, base);
    // LE CONSEILLER PROPOSE, QA-CRAWLER RÉSOUT, LE RUNTIME CONFIRME. Son identité sémantique n'est
    // reprise qu'après confirmation ; un rôle qui contredit le runtime est ignoré (le runtime gagne).
    const runtimeFingerprint =
      observed && fingerprint ? { ...fingerprint, ...identityPatch(observed) } : fingerprint;
    const semanticId = answer.semanticTarget?.semanticId;
    const proposedFingerprint =
      runtimeFingerprint && semanticId ? { ...runtimeFingerprint, semanticId } : runtimeFingerprint;
    const recheck = await this.check(page, chosen.target, proposedFingerprint, original, observed, element);
    if (!VALIDATED_STATUSES.has(recheck.status))
      return {
        audit: {
          ...base,
          outcome: 'AI_PROPOSAL_RUNTIME_REJECTED',
          ...(answer.contextSummary ? { context: answer.contextSummary } : {}),
          proposedTarget: chosen.description,
          reason: `the proposed candidate does not find the human target (${recheck.status}): human action preserved, no silent correction`,
        },
      };
    return {
      audit: {
        ...base,
        outcome: 'AI_PROPOSAL_RUNTIME_CONFIRMED',
        proposedTarget: chosen.description,
        ...(answer.contextSummary ? { context: answer.contextSummary } : {}),
        ...(answer.semanticTarget?.role && observed?.role && answer.semanticTarget.role !== observed.role
          ? {
              ignored: [
                `role "${answer.semanticTarget.role}" contradicts the runtime role "${observed.role}"`,
              ],
            }
          : {}),
        reason: 'the proposed candidate resolves to the original human target',
      },
      validated: {
        target: chosen.target,
        fingerprint: proposedFingerprint,
        check: recheck,
        repair: {
          type: 'AI',
          reason: 'AI_PROPOSAL_RUNTIME_CONFIRMED',
          changes: [
            { property: 'target', before: describeTarget(target), after: describeTarget(chosen.target) },
          ],
          evidence: ['ai-proposal', 'runtime-original-target', ...answer.citedEvidence],
        },
      },
    };
  }

  /**
   * Une proposition sur une ambiguïté PRÉ-ACTION ne peut pas être confirmée par le runtime (l'élément
   * original n'existe plus) : elle est REVALIDÉE contre les preuves d'avant l'action. La candidate doit
   * avoir l'identité de l'instantané (rôle, libellé, section) et être la SEULE ainsi avant l'action.
   * Un effet ou un objectif atteint ne compte jamais : seule l'identité pré-action valide une cible.
   */
  private revalidatePreAction(
    event: RawRecordedEvent,
    element: RecordedElement,
    target: FlowTarget,
    fingerprint: TargetFingerprint | undefined,
    chosen: ContextCandidate & { description: string },
    answer: Awaited<ReturnType<TargetAuditAdvisor>>,
    base: { decisionId?: string; citedEvidence: string[]; context?: Record<string, unknown> },
  ): {
    audit: TargetAiAudit;
    validated?: {
      target: FlowTarget;
      fingerprint: TargetFingerprint | undefined;
      check: TargetCheck;
      repair: TargetRepair;
    };
  } {
    const log = (outcome: 'CONFIRMED' | 'REJECTED', reason: string): void => {
      this.options.log?.(
        `[AI_PRE_ACTION_PROPOSAL_${outcome}] action=${event.id} candidate=${chosen.key} ${reason}`,
      );
    };
    // LA CIBLE ORIGINALE A ÉTÉ CAPTURÉE (T1) : la proposition est jugée contre elle, rien d'autre.
    const originalId = event.pre?.originalCandidateId;
    const captured = event.pre?.candidates ?? [];
    if (originalId && captured.some((entry) => entry.id === chosen.key)) {
      if (chosen.key !== originalId) {
        const reason = `${chosen.key} is not the original human target ${originalId} captured before the action`;
        log('REJECTED', reason);
        return {
          audit: {
            ...base,
            outcome: 'AI_PROPOSAL_RUNTIME_REJECTED',
            candidate: chosen.key,
            proposedTarget: chosen.description,
            reason: `${reason}: human action preserved, no silent correction`,
          },
        };
      }
      const semanticId = answer.semanticTarget?.semanticId;
      log('CONFIRMED', 'the original human target captured before the action');
      return {
        audit: {
          ...base,
          outcome: 'AI_PROPOSAL_RUNTIME_CONFIRMED',
          candidate: chosen.key,
          proposedTarget: chosen.description,
          reason: `the proposed candidate is the original human target ${originalId} captured before the action`,
        },
        validated: {
          // La représentation enregistrée reste (l'identité est prouvée) ; seul le sens est ajouté.
          target,
          fingerprint: fingerprint && semanticId ? { ...fingerprint, semanticId } : fingerprint,
          check: {
            status: 'VALIDATED_AFTER_AI_AUDIT',
            confidence: 0.85,
            reason: `pre-action identity: ${chosen.key} is the original human target captured before the action`,
            candidateCount: captured.length,
            preAction: true,
            resolved: chosen.identity ?? {},
            differences: [],
          },
          repair: {
            type: 'AI',
            reason: 'AI_PRE_ACTION_PROPOSAL_CONFIRMED',
            changes: semanticId ? [{ property: 'semanticId', after: semanticId }] : [],
            evidence: ['ai-proposal', 'pre-action-original-candidate', ...answer.citedEvidence],
          },
        },
      };
    }
    const peers = event.pre?.peers ?? [];
    const proposed = chosen.identity ?? {};
    const wantedName = normalize(element.label ?? element.guessedLabel ?? element.name);
    const name = normalize(proposed.name);
    const sameName =
      !!wantedName &&
      !!name &&
      (name === wantedName || name.includes(wantedName) || wantedName.includes(name));
    const snapshotSection =
      element.sectionPath && element.sectionPath.length > 0 ? element.sectionPath.join(' > ') : undefined;
    const sameSection = sectionMatch(snapshotSection, proposed.section) !== 'OTHER';
    const sameRole = !element.role || !proposed.role || element.role === proposed.role;
    const twins = peers.filter(
      (peer) =>
        peer.role === proposed.role && peer.name === proposed.name && peer.section === proposed.section,
    ).length;
    const reject = (reason: string): { audit: TargetAiAudit } => ({
      audit: {
        ...base,
        outcome: 'AI_PROPOSAL_RUNTIME_REJECTED',
        proposedTarget: chosen.description,
        reason: `${reason}: human action preserved, no silent correction`,
      },
    });
    if (!sameRole || !sameName || !sameSection) {
      log('REJECTED', 'identity differs from the pre-action snapshot');
      return reject('the proposed candidate does not have the pre-action identity of the human target');
    }
    if (twins !== 1)
      return {
        audit: {
          ...base,
          outcome: 'INCONCLUSIVE',
          proposedTarget: chosen.description,
          reason: `${String(twins)} elements had this identity before the action: the pre-action evidence cannot single one out`,
        },
      };
    const semanticId = answer.semanticTarget?.semanticId;
    const proposedFingerprint = fingerprint && semanticId ? { ...fingerprint, semanticId } : fingerprint;
    log('CONFIRMED', 'unique pre-action identity');
    return {
      audit: {
        ...base,
        outcome: 'AI_PROPOSAL_RUNTIME_CONFIRMED',
        candidate: chosen.key,
        proposedTarget: chosen.description,
        reason:
          'the proposed candidate was the only element with the human target identity before the action',
      },
      validated: {
        target: chosen.target,
        fingerprint: proposedFingerprint,
        check: {
          status: 'VALIDATED_AFTER_AI_AUDIT',
          confidence: 0.75,
          reason: `pre-action identity: ${chosen.description} was unique before the action`,
          candidateCount: 1,
          preAction: true,
          resolved: proposed,
          differences: [],
        },
        repair: {
          type: 'AI',
          reason: 'AI_PROPOSAL_PRE_ACTION_REVALIDATED',
          changes: [
            { property: 'target', before: describeTarget(target), after: describeTarget(chosen.target) },
          ],
          evidence: ['ai-proposal', 'pre-action-peers', ...answer.citedEvidence],
        },
      },
    };
  }

  /**
   * DRAG_AND_DROP : jamais un second glisser. L'élément est-il retrouvé (dans sa zone d'arrivée
   * s'il a bougé), la zone de dépôt est-elle retrouvée par sa section ? Le déplacement observé est une preuve.
   */
  private async validateDrag(
    page: Page,
    event: RawRecordedEvent,
    ref: string | undefined,
  ): Promise<RecordingTargetValidation | undefined> {
    const drag = event.drag;
    if (!drag) return undefined;
    const log: string[] = [];
    const say = (line: string): void => {
      log.push(line);
      this.options.log?.(line);
    };
    say(`[TARGET_CAPTURED] ${event.id} DRAG "${drag.item}"`);
    // LA PREUVE DU DÉPART : l'élément (T1), les zones candidates (D…) et leurs listes d'AVANT.
    const capture = preActionCaptureOf(event);
    const zones = event.pre?.dropZones ?? [];
    if (capture.complete)
      say(
        `[PRE_ACTION_CAPTURE] action=${event.id} type=DRAG target="${drag.item}" phase=${capture.phase ?? '-'} candidates=${String(capture.candidateCount)} originalCandidate=${capture.originalCandidateId ?? '-'} dropZones=${String(zones.length)}${drag.destinationCandidateId ? ` destination=${drag.destinationCandidateId}` : ''}`,
      );
    else if (capture.captured)
      say(`[PRE_ACTION_CAPTURE_INCOMPLETE] action=${event.id} ${capture.diagnostic ?? ''}`);
    // Le déplacement PROUVÉ par les listes : absent de la zone d'arrivée avant, présent après.
    const norm = (text: string): string => normalize(text);
    const lists = drag.lists;
    const movedProven =
      lists?.destinationBefore !== undefined &&
      !lists.destinationBefore.map(norm).includes(norm(drag.item)) &&
      lists.destinationAfter.map(norm).includes(norm(drag.item));
    const item = await this.original(page, ref);
    const zone = await this.original(page, ref, ':zone');
    const itemSection = (drag.moved ? drag.destination : drag.source)?.section;
    const scan = async (
      spec: Parameters<typeof semanticScanExpression>[0],
      original: ElementHandle | undefined,
    ): Promise<TargetValidationStatus> => {
      const result = (await page.evaluate(semanticScanExpression(spec)).catch(() => undefined)) as
        SemanticScanResult | undefined;
      if (!result || result.status === 'NOT_FOUND') return original ? 'NOT_FOUND' : 'NOT_VALIDATABLE';
      if (result.status === 'AMBIGUOUS') return 'AMBIGUOUS';
      const locator = page.locator(`[data-qa-crawler-target="${spec.token}"]`).first();
      const same = original
        ? await locator
            .evaluate((el, orig) => {
              if (el === orig) return true;
              const INTERACTIVE =
                'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], [role="combobox"], [role="checkbox"], [role="radio"], [role="switch"], [contenteditable]:not([contenteditable="false"])';
              // Le texte d'un contrôle (le libellé dans un mat-select) : le rejeu agit sur le contrôle englobant.
              return orig.contains(el) && el.closest(INTERACTIVE) === orig;
            }, original)
            .catch(() => false)
        : undefined;
      await locator
        .evaluate((el) => {
          el.removeAttribute('data-qa-crawler-target');
        })
        .catch(() => undefined);
      return same === false ? 'MISMATCH' : same === true ? 'VALIDATED' : 'VALIDATED_AFTER_RERENDER';
    };
    this.tokens += 1;
    const itemStatus = await scan(
      {
        kind: 'item',
        label: drag.item,
        ...(itemSection ? { section: itemSection } : {}),
        token: `validate-${String(this.tokens)}-item`,
      },
      item,
    );
    const destinationStatus = drag.destination
      ? await scan(
          {
            kind: 'container',
            ...(drag.destination.label ? { label: drag.destination.label } : {}),
            ...(drag.destination.section ? { section: drag.destination.section } : {}),
            token: `validate-${String(this.tokens)}-zone`,
          },
          zone,
        )
      : 'NOT_FOUND';
    // Les nœuds recréés après le dépôt : l'élément et la zone figés au départ, avec le déplacement
    // prouvé par les listes d'avant / après, valident l'action (jamais un second glisser).
    const preActionProof =
      capture.complete &&
      movedProven &&
      drag.destinationCandidateId !== undefined &&
      (!VALIDATED_STATUSES.has(itemStatus) || !VALIDATED_STATUSES.has(destinationStatus));
    const ok =
      preActionProof || (VALIDATED_STATUSES.has(itemStatus) && VALIDATED_STATUSES.has(destinationStatus));
    const status: TargetValidationStatus = ok
      ? preActionProof
        ? 'VALIDATED_PRE_ACTION'
        : itemStatus === 'VALIDATED' && destinationStatus === 'VALIDATED'
          ? 'VALIDATED'
          : 'VALIDATED_AFTER_RERENDER'
      : ([itemStatus, destinationStatus].find((value) => !VALIDATED_STATUSES.has(value)) ??
        'NOT_VALIDATABLE');
    const check: TargetCheck = {
      status,
      confidence: ok ? (drag.moved ? 0.95 : 0.8) : 0.6,
      reason: `item ${itemStatus}, drop zone ${destinationStatus}${drag.moved ? ', ITEM_MOVED observed' : ''}${movedProven ? `, moved into ${drag.destinationCandidateId ?? 'the drop zone'} (absent before, present after)` : ''}${preActionProof ? ' — validated from the pre-action capture' : ''}`,
      candidateCount: Math.max(1, zones.length),
      ...(preActionProof ? { preAction: true } : {}),
      differences: [],
    };
    say(`[TARGET_${ok ? 'VALIDATED' : status}] ${event.id} ${check.reason}`);
    this.previous.push(`drag "${drag.item}"`);
    const result: Omit<RecordingTargetValidation, 'verdict'> = {
      mode: ValidationMode.RECORDING,
      preActionCapture: capture,
      currentRuntime: { originalStillPresent: item !== undefined },
      ...(preActionProof && capture.originalCandidateId
        ? { validatedCandidate: capture.originalCandidateId }
        : {}),
      rawEventId: event.id,
      action: 'drag',
      timestamp: Date.now(),
      status,
      confidence: check.confidence,
      attempts: 1,
      original: {
        name: drag.item,
        ...(drag.source?.section ? { section: drag.source.section } : {}),
        stale: !item,
      },
      validationBefore: check,
      repairApplied: false,
      aiAudited: false,
      originalTargetMatch: ok,
      requiresReplayValidation: !ok,
      knowledge: { recordingValidated: ok, replayValidated: false },
      drag: {
        item: itemStatus,
        destination: destinationStatus,
        movedObserved: drag.moved || movedProven,
        ...(drag.destinationCandidateId ? { destinationCandidate: drag.destinationCandidateId } : {}),
        ...(zones.length > 0 ? { dropZoneCandidates: zones.length } : {}),
        // AVANT / APRÈS : la preuve du déplacement (listes d'interface, jamais un second glisser).
        ...(drag.lists ? { lists: drag.lists } : {}),
      },
      log,
    };
    const effect: RecordingVerdict['effect'] =
      drag.moved || movedProven
        ? {
            status: 'CONFIRMED',
            evidence: [
              `"${drag.item}" moved${drag.destination?.label ? ` to "${drag.destination.label}"` : ''}`,
              ...(movedProven
                ? [`absent from ${drag.destinationCandidateId ?? 'the drop zone'} before, present after`]
                : []),
            ],
          }
        : { status: 'NOT_OBSERVED', evidence: [] };
    const published = publishedStatus(result, effect);
    if (published.startsWith('VALIDATED_'))
      say(
        `[TARGET_${published}] action=${event.id}${result.validatedCandidate ? ` candidate=${result.validatedCandidate}` : ''}`,
      );
    return { ...result, validationStatus: published, verdict: verdictOf(result, effect) };
  }
}

/**
 * Les trois verdicts : l'IDENTITÉ vient des seules preuves de cible (par priorité), l'EFFET de
 * l'écran d'après, l'OBJECTIF de l'effet. VALIDATED_WITH_EFFECT réunit les deux : la cible, elle,
 * est VALIDATED_PRE_ACTION.
 */
export function verdictOf(
  result: Omit<RecordingTargetValidation, 'verdict'>,
  effect: RecordingVerdict['effect'],
): RecordingVerdict {
  const check = result.validationAfter ?? result.validationBefore;
  const validated = VALIDATED_STATUSES.has(result.status);
  const source: TargetIdentitySource = !validated
    ? 'NONE'
    : result.repair?.type === 'AI'
      ? 'ADVISOR_REVALIDATED'
      : check.preAction
        ? 'PRE_ACTION_CONTEXT'
        : result.repair?.type === 'DETERMINISTIC'
          ? 'DETERMINISTIC_RECONSTRUCTION'
          : result.status === 'VALIDATED_AFTER_RERENDER'
            ? 'PRE_ACTION_TARGET_SNAPSHOT'
            : result.original.stale
              ? 'TARGET_FINGERPRINT'
              : 'ORIGINAL_HUMAN_TARGET';
  return {
    mode: ValidationMode.RECORDING,
    target: {
      status: result.status === 'VALIDATED_WITH_EFFECT' ? 'VALIDATED_PRE_ACTION' : result.status,
      source,
      confidence: result.confidence,
      reason: check.reason,
    },
    effect,
    goal: goalOf(effect, result.fingerprintAfter?.semanticId ?? result.fingerprintBefore?.semanticId),
  };
}

/** L'état d'un champ, lu dans la page (autonome) : empreinte salée de sa valeur, coché, choix affiché. */
function readFieldState(
  el: Element,
  salt: string,
): { digest?: string; checked?: boolean; selected?: string } {
  const digestOf = (value: string): string | undefined => {
    if (value.trim() === '' || salt === '') return undefined;
    const text = `${salt}\u0000${value.trim()}`;
    let a = 0x811c9dc5;
    let b = 0x01000193 ^ 0x5bd1e995;
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      a = Math.imul(a ^ code, 0x01000193) >>> 0;
      b = Math.imul(b ^ code, 0x01000193) >>> 0;
    }
    return `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`;
  };
  const field =
    el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement
      ? el
      : el.querySelector('input, textarea, select');
  if (field instanceof HTMLInputElement && (field.type === 'checkbox' || field.type === 'radio'))
    return { checked: field.checked };
  const ariaChecked = el.getAttribute('aria-checked');
  if (ariaChecked === 'true' || ariaChecked === 'false') return { checked: ariaChecked === 'true' };
  if (field instanceof HTMLSelectElement)
    return { selected: (field.selectedOptions[0]?.textContent ?? '').replace(/\s+/g, ' ').trim() };
  if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
    const digest = digestOf(field.value);
    return digest ? { digest } : {};
  }
  if (el instanceof HTMLElement && el.isContentEditable) {
    const digest = digestOf(el.innerText);
    return digest ? { digest } : {};
  }
  // Une liste déroulante composée (combobox) : le choix affiché.
  return { selected: el.textContent.replace(/\s+/g, ' ').trim().slice(0, 120) };
}

/**
 * L'élément que le localisateur désigne APRÈS l'action (une preuve d'effet, jamais d'identité) :
 * unique ou rien. Le marqueur temporaire est retiré après lecture.
 */
async function postStateLocator(
  page: Page,
  target: FlowTarget,
  token: () => string,
): Promise<{ locator: Locator; cleanup?: () => Promise<void> } | undefined> {
  if (
    target.section !== undefined &&
    target.nth === undefined &&
    target.strategy !== 'css' &&
    target.strategy !== 'testId'
  ) {
    const mark = token();
    const label = target.strategy === 'role' ? (target.name ?? '') : (target.value ?? '');
    const kind =
      target.strategy === 'label' || (target.strategy === 'role' && FIELD_ROLES.has(target.role ?? ''))
        ? 'field'
        : 'control';
    const scan = (await page
      .evaluate(
        semanticScanExpression({
          kind,
          label,
          ...(target.strategy === 'role' && target.role ? { role: target.role } : {}),
          section: target.section,
          token: mark,
        }),
      )
      .catch(() => undefined)) as SemanticScanResult | undefined;
    if (scan?.status !== 'RESOLVED') return undefined;
    const locator = page.locator(`[data-qa-crawler-target="${mark}"]`).first();
    return {
      locator,
      cleanup: async () => {
        await locator
          .evaluate((el) => {
            el.removeAttribute('data-qa-crawler-target');
          })
          .catch(() => undefined);
      },
    };
  }
  const base = toLocator(page, {
    strategy: target.strategy,
    ...(target.role !== undefined ? { role: target.role } : {}),
    ...(target.name !== undefined ? { name: target.name } : {}),
    ...(target.value !== undefined ? { value: target.value } : {}),
    ...(target.exact !== undefined ? { exact: target.exact } : {}),
  });
  if (target.nth !== undefined) return { locator: base.nth(target.nth) };
  const count = await base.count().catch(() => 0);
  return count === 1 ? { locator: base.first() } : undefined;
}

function identityOf(observed: ObservedTarget): TargetIdentity {
  const name = observed.name ?? observed.text;
  return {
    ...(observed.role ? { role: observed.role } : {}),
    ...(observed.tag ? { tag: observed.tag } : {}),
    ...(name ? { name } : {}),
    ...(observed.testId ? { testId: observed.testId } : {}),
    ...(observed.section ? { section: observed.section } : {}),
  };
}

/** Ce qui, dans l'empreinte, doit dire ce que le rejeu lira (rôle, balise ; le nom s'il existe). */
function identityPatch(observed: ObservedTarget): Partial<TargetFingerprint> {
  return {
    ...(observed.role ? { role: observed.role } : {}),
    ...(observed.tag ? { tag: observed.tag } : {}),
    ...(observed.section ? { section: observed.section } : {}),
  };
}

function fromSnapshot(element: RecordedElement): ObservedTarget {
  const name = element.label ?? element.guessedLabel ?? element.name;
  const section =
    element.sectionPath && element.sectionPath.length > 0 ? element.sectionPath.join(' > ') : undefined;
  return {
    tag: element.tag,
    ...(element.role ? { role: element.role } : {}),
    ...(name ? { name } : {}),
    ...(element.testId ? { testId: element.testId } : {}),
    ...(section ? { section } : {}),
  };
}

export function describeIdentity(identity: TargetIdentity): string {
  const traits = describeTraits(identity.traits);
  return `${baseIdentity(identity)}${traits ? ` [${traits}]` : ''}`;
}

function baseIdentity(identity: TargetIdentity): string {
  return [
    identity.role ?? identity.tag ?? '?',
    identity.name ? `"${identity.name}"` : '',
    identity.section ? `in "${identity.section}"` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/** Les traits de l'élément d'après l'instantané (quand le nœud original n'existe plus). */
function snapshotTraits(element: RecordedElement): ElementTraits {
  return {
    ...(element.elementId && !element.generatedId ? { id: element.elementId } : {}),
    ...(element.nameAttr ? { name: element.nameAttr } : {}),
    ...(element.formControlName ? { formControl: element.formControlName } : {}),
    ...(element.placeholder ? { placeholder: element.placeholder } : {}),
    ...(element.testId ? { testId: element.testId } : {}),
    ...(element.guessedLabel ? { nearText: element.guessedLabel } : {}),
    ...(element.componentTag ? { component: element.componentTag } : {}),
    visible: true,
    inDialog: element.inDialog,
    ...(element.dialogName ? { dialog: element.dialogName } : {}),
    focused: false,
  };
}

/** Les traits lisibles (pour le conseiller et le rapport) : seulement ce qui existe. */
export function describeTraits(traits: ElementTraits | undefined): string {
  if (!traits) return '';
  return [
    traits.formControl ? `formControl=${traits.formControl}` : '',
    traits.name ? `name=${traits.name}` : '',
    traits.id ? `id=${traits.id}` : '',
    traits.placeholder ? `placeholder="${traits.placeholder}"` : '',
    traits.nearText ? `text before="${traits.nearText}"` : '',
    traits.component ? `component=${traits.component}` : '',
    traits.inDialog ? `in dialog${traits.dialog ? ` "${traits.dialog}"` : ''}` : '',
    traits.visible ? 'visible' : 'hidden',
    traits.focused ? 'FOCUSED' : '',
  ]
    .filter(Boolean)
    .join(', ');
}

function shorten(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** L'écran maintenant (route, titre, fenêtre ouverte, titres) : lecture seule. */
async function postActionSummary(
  page: Page,
): Promise<{ route: string; title: string; dialog?: string; headings: string[] }> {
  return page
    .evaluate(() => {
      const visible = (node: Element): boolean => {
        const rect = node.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return false;
        const style = getComputedStyle(node);
        return style.visibility !== 'hidden' && style.display !== 'none';
      };
      const clean = (text: string | null | undefined): string =>
        (text ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
      const dialog = Array.from(
        document.querySelectorAll(
          '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open], .cdk-overlay-pane',
        ),
      ).find(visible);
      const name = dialog
        ? clean(
            dialog.getAttribute('aria-label') ??
              dialog.querySelector('h1, h2, h3, [role="heading"], legend')?.textContent,
          )
        : '';
      return {
        route: location.pathname,
        title: clean(document.title),
        ...(name ? { dialog: name } : {}),
        headings: Array.from(document.querySelectorAll('h1, h2, h3, [role="heading"]'))
          .filter(visible)
          .map((node) => clean(node.textContent))
          .filter(Boolean)
          .slice(0, 5),
      };
    })
    .catch(() => ({ route: '', title: '', headings: [] }));
}

/** Ce que l'action a changé à l'écran (fenêtre, route, titre, titres, cible disparue). */
export function observedEffects(
  pre: PreActionContext,
  post: { route: string; title: string; dialog?: string; headings: string[] },
  targetGone: boolean,
): string[] {
  const effects: string[] = [];
  if (post.route && post.route !== pre.route) effects.push(`route ${pre.route} → ${post.route}`);
  if (post.dialog && post.dialog !== pre.dialog) effects.push(`dialog "${post.dialog}" appeared`);
  if (pre.dialog && !post.dialog) effects.push(`dialog "${pre.dialog}" closed`);
  if (post.title && post.title !== pre.title) effects.push(`title "${post.title}"`);
  const appeared = post.headings.filter((heading) => !pre.headings.includes(heading));
  if (appeared.length > 0) effects.push(`heading "${appeared.slice(0, 2).join('", "')}" appeared`);
  if (targetGone && effects.length > 0) effects.push('the target itself left the screen');
  return effects;
}

/**
 * La cible était-elle UNIQUE juste avant l'action ? Les comptes sont faits par la capture,
 * avant l'effet : rôle + nom, libellé (dans sa section), texte, CSS. Une position n'en est pas une.
 */
export function preActionCheck(
  target: FlowTarget,
  element: RecordedElement,
  pre: PreActionContext,
): { unique: boolean; reason: string } {
  if (target.nth !== undefined) return { unique: false, reason: 'a position is not an identity' };
  switch (target.strategy) {
    case 'role':
      return element.sameRoleName <= 1
        ? {
            unique: true,
            reason: `${target.role ?? ''} "${target.name ?? ''}" was the only one before the action`,
          }
        : {
            unique: false,
            reason: `${String(element.sameRoleName)} "${target.name ?? ''}" before the action`,
          };
    case 'label': {
      const count = target.section ? (element.sameLabelInSection ?? 1) : element.sameLabel;
      return count <= 1
        ? {
            unique: true,
            reason: `label "${target.value ?? ''}"${target.section ? ` in "${target.section}"` : ''} was unique before the action`,
          }
        : {
            unique: false,
            reason: `${String(count)} fields labelled "${target.value ?? ''}" before the action`,
          };
    }
    case 'text':
      return pre.sameText <= 1
        ? { unique: true, reason: `text "${target.value ?? ''}" was unique before the action` }
        : {
            unique: false,
            reason: `${String(pre.sameText)} controls showed "${target.value ?? ''}" before the action`,
          };
    case 'css':
      return pre.cssCount === 1
        ? { unique: true, reason: `${target.value ?? ''} matched exactly one element before the action` }
        : {
            unique: false,
            reason: `${target.value ?? ''} matched ${String(pre.cssCount)} elements before the action`,
          };
    case 'testId':
      return { unique: true, reason: `test id "${target.value ?? ''}"` };
  }
}
