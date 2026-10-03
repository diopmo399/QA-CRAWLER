import type { ElementHandle, JSHandle, Page } from 'playwright';
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
import type { RawRecordedEvent, RecordedElement, RecordedTarget } from './model.js';
import { resolveRecordedTarget } from './recorded-target.js';
import { semanticScanExpression, type SemanticScanResult } from './semantic-dom.js';

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
]);

/** Ce que le rejeu lira de l'élément (rôle, nom, balise, test id, section) : jamais une valeur. */
export interface TargetIdentity {
  role?: string;
  tag?: string;
  name?: string;
  testId?: string;
  section?: string;
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
}

/**
 * Le résultat d'une validation immédiate (target-validation.json) : avant, réparation, après,
 * audit, et la représentation FINALE (celle qui ira dans le flow).
 */
export interface RecordingTargetValidation {
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
  /** Prouvée dans CE runtime ; la connaissance universelle attend le rejeu. */
  knowledge: { recordingValidated: boolean; replayValidated: false };
  /** Glisser-déposer : l'élément et la zone retrouvés, et le déplacement observé (preuve). */
  drag?: { item: TargetValidationStatus; destination: TargetValidationStatus; movedObserved: boolean };
  log: string[];
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
  candidates: { key: string; target: FlowTarget; description: string }[];
  previousActions: string[];
}) => Promise<{
  decisionId?: string;
  selectedKey?: string;
  outcome: 'PROPOSAL' | 'INCONCLUSIVE' | 'UNAVAILABLE';
  citedEvidence: string[];
}>;

export interface TargetValidatorOptions {
  maxDeterministicRepairAttempts: number;
  /** Statuts qui déclenchent l'audit (SUSPICIOUS_ONLY) ; vide : jamais. */
  auditOn: ReadonlySet<TargetValidationStatus>;
  advisor?: TargetAuditAdvisor;
  log?: (line: string) => void;
}

export class RecordingTargetValidator {
  private tokens = 0;
  private lastField: { key: string; result: RecordingTargetValidation } | undefined;
  /** Les dernières actions comprises (contexte : un champ « valeur » après « champ » et « opérateur »). */
  private readonly previous: string[] = [];

  constructor(private readonly options: TargetValidatorOptions) {}

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
      if ((event.type === 'input' || event.type === 'change') && this.lastField?.key === key)
        return { ...this.lastField.result, rawEventId: event.id, log: [] };
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
    const original = await this.original(page, ref);
    const observed = original ? await readTarget(original, page) : undefined;
    const originalIdentity: RecordingTargetValidation['original'] = {
      ...identityOf(observed ?? fromSnapshot(element)),
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
    let after: TargetCheck | undefined;
    let repair: TargetRepair | undefined;
    let attempts = 1;
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

    // ---- RÉPARATION DÉTERMINISTE (bornée), puis REVALIDATION obligatoire.
    const tried = new Set([JSON.stringify(target)]);
    while (
      !VALIDATED_STATUSES.has(current.status) &&
      attempts <= this.options.maxDeterministicRepairAttempts &&
      current.status !== 'NOT_VALIDATABLE'
    ) {
      const proposal = this.repairOf(current, target, fingerprint, candidate, element, observed, tried);
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
    if (this.options.advisor && this.options.auditOn.has(current.status)) {
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
    return {
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
      repairApplied: changed,
      aiAudited: aiAudit !== undefined && aiAudit.outcome !== 'NOT_CALLED',
      originalTargetMatch:
        validated && current.status !== 'VALIDATED_AFTER_RERENDER' ? true : current.sameElement === true,
      requiresReplayValidation: !validated,
      knowledge: { recordingValidated: validated, replayValidated: false },
      log,
    };
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
    const options: FlowTarget[] = [];
    const add = (option: FlowTarget): void => {
      if (!options.some((known) => JSON.stringify(known) === JSON.stringify(option))) options.push(option);
    };
    add(target);
    for (const alternative of candidate.alternatives) add(alternative.target);
    // Plusieurs éléments correspondent : chacun devient une candidate (par sa position), décrite par son identité.
    if (check.candidates) for (const entry of check.candidates) add({ ...target, nth: entry.index });
    const candidates = options.slice(0, 8).map((option, index) => {
      const identity = check.candidates?.find(
        (entry) => option.nth === entry.index && option.strategy === target.strategy,
      );
      return {
        key: `T${String(index + 1)}`,
        target: option,
        description: `${describeTarget(option)}${identity ? ` → ${describeIdentity(identity)}` : ''}`,
      };
    });
    const answer = await advisor({
      event,
      original: originalIdentity,
      check,
      candidates,
      previousActions: [...this.previous],
    });
    const base = {
      ...(answer.decisionId ? { decisionId: answer.decisionId } : {}),
      citedEvidence: answer.citedEvidence,
    };
    if (answer.outcome === 'UNAVAILABLE')
      return {
        audit: { ...base, outcome: 'UNAVAILABLE', reason: 'advisor unavailable: deterministic result kept' },
      };
    const chosen = candidates.find((entry) => entry.key === answer.selectedKey);
    if (!chosen)
      return {
        audit: {
          ...base,
          outcome: 'INCONCLUSIVE',
          reason: 'no candidate selected: deterministic result kept',
        },
      };
    // LE CONSEILLER PROPOSE, QA-CRAWLER RÉSOUT, LE RUNTIME CONFIRME.
    const proposedFingerprint =
      observed && fingerprint ? { ...fingerprint, ...identityPatch(observed) } : fingerprint;
    const recheck = await this.check(page, chosen.target, proposedFingerprint, original, observed, element);
    if (!VALIDATED_STATUSES.has(recheck.status))
      return {
        audit: {
          ...base,
          outcome: 'AI_PROPOSAL_RUNTIME_REJECTED',
          proposedTarget: chosen.description,
          reason: `the proposed candidate does not find the human target (${recheck.status}): human action preserved, no silent correction`,
        },
      };
    return {
      audit: {
        ...base,
        outcome: 'AI_PROPOSAL_RUNTIME_CONFIRMED',
        proposedTarget: chosen.description,
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
    const ok = VALIDATED_STATUSES.has(itemStatus) && VALIDATED_STATUSES.has(destinationStatus);
    const status: TargetValidationStatus = ok
      ? itemStatus === 'VALIDATED' && destinationStatus === 'VALIDATED'
        ? 'VALIDATED'
        : 'VALIDATED_AFTER_RERENDER'
      : ([itemStatus, destinationStatus].find((value) => !VALIDATED_STATUSES.has(value)) ??
        'NOT_VALIDATABLE');
    const check: TargetCheck = {
      status,
      confidence: ok ? (drag.moved ? 0.95 : 0.8) : 0.6,
      reason: `item ${itemStatus}, drop zone ${destinationStatus}${drag.moved ? ', ITEM_MOVED observed' : ''}`,
      candidateCount: 1,
      differences: [],
    };
    say(`[TARGET_${ok ? 'VALIDATED' : status}] ${event.id} ${check.reason}`);
    this.previous.push(`drag "${drag.item}"`);
    return {
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
      drag: { item: itemStatus, destination: destinationStatus, movedObserved: drag.moved },
      log,
    };
  }
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
  return [
    identity.role ?? identity.tag ?? '?',
    identity.name ? `"${identity.name}"` : '',
    identity.section ? `in "${identity.section}"` : '',
  ]
    .filter(Boolean)
    .join(' ');
}
