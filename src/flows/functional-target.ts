import type { Page } from 'playwright';
import type { FlowStep, FlowTarget, TargetFingerprint } from '../config/flow-schema.js';
import { describeTarget } from '../config/flow-schema.js';
import { toLocator } from '../execution/locator-resolver.js';
import { sectionPathOf } from '../recording/semantic-dom.js';
import { resolveWorkflowContext } from '../workflow-healing/workflow-context.js';
import { normalize, sectionMatch } from './action-effect-verifier.js';

/**
 * RÉSOLUTION FONCTIONNELLE DE CIBLE (rejeu).
 *
 * Un TARGET_FINGERPRINT_MISMATCH n'est plus terminal : un élément re-rendu par le framework
 * (Angular, Material) peut être un NOUVEAU nœud DOM et rester EXACTEMENT le même champ métier.
 * L'identité fonctionnelle (rôle sémantique, concept métier, section, fenêtre, contexte du
 * parcours : actions précédentes et suivantes, préconditions) est plus importante que l'identité
 * du nœud. Mais aucun signal n'est une vérité : le localisateur enregistré est une PREUVE, la
 * suite du parcours est une PREUVE, l'historique et l'analyse statique aussi ; seul l'effet
 * observé au runtime prouve. Jamais le premier candidat parce qu'il existe.
 */

export type TargetResolutionStatus =
  | 'TARGET_EXACT'
  | 'TARGET_STRONG_MATCH'
  | 'TARGET_RERENDERED'
  | 'TARGET_FUNCTIONALLY_EQUIVALENT'
  | 'TARGET_HEALED'
  | 'TARGET_AI_ASSISTED'
  | 'TARGET_AMBIGUOUS'
  | 'TARGET_CONTEXT_MISMATCH'
  | 'TARGET_FUNCTIONAL_MISMATCH'
  | 'TARGET_RUNTIME_CONFIRMED'
  | 'TARGET_RUNTIME_REJECTED'
  | 'TARGET_REQUIRES_REPLAY_VALIDATION';

export type TargetInteraction = 'FILL' | 'SELECT' | 'CLICK' | 'CHECK';

/** Ce que l'élément FAIT dans le parcours, pas le nœud qui le porte. */
export interface FunctionalTargetIdentity {
  /** FILTER_VALUE, FILL_COMPANY_NAME… */
  semanticRole: string;
  /** filter.value (semanticId enregistré) : un nom stable, pas un localisateur. */
  businessConcept?: string;
  interaction: TargetInteraction;
  label?: string;
  role?: string;
  tag?: string;
  section?: string;
  dialog?: string;
  /** Les choix faits juste avant dans la même section (libellé → option) : field, operator… */
  configuration: Record<string, string>;
}

/** Le moment du parcours : avant, maintenant, après — des preuves, jamais des vérités. */
export interface TemporalActionContext {
  previousActions: { type: string; target: string; value?: string; result?: string }[];
  currentAction: { type: TargetInteraction; recordedTarget: string; semanticIntent: string };
  nextActions: { type: string; target: string }[];
  workflowPhase: string;
  activeSection?: string;
  /** FIELD_SELECTED, OPERATOR_SELECTED, VALUE_INPUT_AVAILABLE… */
  preconditions: string[];
  expectedEffects: string[];
  previousObservedEffects: string[];
}

/** L'écran, compact : jamais le DOM complet. */
export interface ScreenSemanticContext {
  route: string;
  title: string;
  dialog?: string;
  activeSection?: string;
  visibleControls: string[];
  /** Les choix affichés (listes) : libellé → valeur affichée (jamais une saisie libre). */
  selectedValues: Record<string, string>;
  availableActions: string[];
}

/** Un candidat découvert à l'écran : une DESCRIPTION de son voisinage, pas un localisateur. */
export interface FunctionalCandidate {
  id: string;
  tag: string;
  role: string;
  name: string;
  label?: string;
  section?: string;
  dialog?: string;
  visible: boolean;
  enabled: boolean;
  editable: boolean;
  /** Le localisateur enregistré désigne-t-il (encore) cet élément ? Une preuve structurelle. */
  matchesRecordedLocator: boolean;
  /** Le parent sémantique (mat-form-field, fieldset…) et son libellé. */
  parent?: string;
  /** Le contrôle qui le PRÉCÈDE (« operator: Like ») et celui qui le SUIT (« button: Apply »). */
  previousControl?: string;
  nextControl?: string;
  nearText: string[];
  stableAttributes: Record<string, string>;
  /** L'indice CSS (id stable…) : affiché, jamais une vérité. */
  cssHint?: string;
}

export interface ScoredCandidate extends FunctionalCandidate {
  score: number;
  /** Chaque preuve, ce qu'elle a apporté (ou retiré). */
  components: Record<string, number>;
  /** Écarté avant tout score : invisible, non éditable, autre section… */
  rejected?: string;
}

export interface FunctionalDecision {
  status: 'RESOLVED' | 'AMBIGUOUS' | 'NONE';
  chosen?: ScoredCandidate;
  ranked: ScoredCandidate[];
  reason: string;
}

export interface RerenderAnalysis {
  detected: boolean;
  evidence: string[];
}

/** La trace lisible d'une résolution (rapport, journal, target-resolution). */
export interface TargetResolutionTrace {
  action: string;
  recorded: { locator: string; fingerprint?: TargetFingerprint };
  runtime: { locator: string; fingerprintVerdict: string; reasons: string[] };
  rerender: RerenderAnalysis;
  identity: FunctionalTargetIdentity;
  temporal: TemporalActionContext;
  screen?: ScreenSemanticContext;
  candidates: { id: string; score: number; summary: string; rejected?: string }[];
  decision: FunctionalDecision['status'];
  resolution?: string;
  reason: string;
  ai: {
    requested: boolean;
    mode?: string;
    proposal?: string;
    confidence?: number;
    outcome?: 'VALIDATED' | 'REJECTED' | 'RECORDED_ONLY' | 'NOT_REQUIRED' | 'UNAVAILABLE';
    auditId?: string;
  };
  status: TargetResolutionStatus;
  runtimeVerification?: { status: 'CONFIRMED' | 'REJECTED' | 'NOT_VERIFIED'; detail: string };
  nextAction?: 'AVAILABLE' | 'NOT_AVAILABLE' | 'NOT_CHECKED';
  final?: 'TARGET_RECOVERED_AND_CONFIRMED' | 'TARGET_RECOVERY_REJECTED' | 'TARGET_UNRESOLVED';
  /** Une connaissance CANDIDATE (jamais une vérité globale) : à confirmer par d'autres rejeux. */
  knowledge?: {
    functionalTarget: string;
    context: Record<string, string>;
    knownRepresentations: string[];
    rerenderSensitive: boolean;
    status: 'CANDIDATE';
    globallyTrusted: false;
  };
}

const INTERACTION: Record<string, TargetInteraction> = {
  fill: 'FILL',
  select: 'SELECT',
  click: 'CLICK',
  check: 'CHECK',
  uncheck: 'CHECK',
};

function slug(text: string): string {
  return normalize(text)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}

/** Le libellé humain d'une étape (jamais une valeur saisie). */
function labelOf(step: FlowStep): string {
  return 'target' in step ? (step.target.name ?? step.target.value ?? '') : '';
}

/**
 * LE CONTEXTE TEMPOREL : les actions précédentes (avec l'option choisie et leur résultat), l'action
 * courante, les suivantes, la phase, les préconditions qu'elles impliquent et les effets observés.
 */
export function buildTemporalContext(
  steps: readonly FlowStep[],
  position: number,
  previousResults: readonly { status: string; observed?: readonly string[] }[] = [],
): TemporalActionContext {
  const workflow = resolveWorkflowContext(steps, position);
  const step = steps[position];
  const fingerprint = step && 'fingerprint' in step ? step.fingerprint : undefined;
  const section = fingerprint?.section ?? (step && 'target' in step ? step.target.section : undefined);
  const previousSteps = steps.slice(Math.max(0, position - 3), position);
  const previousActions = previousSteps.map((previous, offset) => {
    const result = previousResults[previousResults.length - previousSteps.length + offset];
    return {
      type: previous.kind.toUpperCase(),
      target: labelOf(previous) || previous.kind,
      ...(previous.kind === 'select' ? { value: previous.option } : {}),
      ...(result ? { result: result.status === 'PASSED' ? 'CONFIRMED' : result.status } : {}),
    };
  });
  const interaction = INTERACTION[step?.kind ?? ''] ?? 'CLICK';
  const concept = fingerprint?.semanticId;
  const subject = concept?.split('.').at(-1) ?? (step ? labelOf(step) : '');
  // Les préconditions : chaque choix précédent de la même section, puis la disponibilité de la cible.
  const preconditions = [
    ...previousSteps
      .filter(
        (previous) =>
          previous.kind === 'select' &&
          (!section ||
            !('fingerprint' in previous) ||
            sectionMatch(previous.fingerprint?.section, section) !== 'OTHER'),
      )
      .map((previous) => `${slug(labelOf(previous)) || 'OPTION'}_SELECTED`),
    `${slug(subject) || 'TARGET'}_${interaction === 'FILL' ? 'INPUT' : 'CONTROL'}_AVAILABLE`,
  ];
  const phase = concept?.includes('.')
    ? `${slug(concept.split('.')[0] ?? '')}_CONFIGURATION`
    : (workflow.businessIntent?.name ?? 'UNKNOWN');
  return {
    previousActions,
    currentAction: {
      type: interaction,
      recordedTarget: step && 'target' in step ? describeTarget(step.target) : '',
      semanticIntent: concept
        ? `${interaction === 'FILL' ? 'ENTER' : interaction}_${slug(concept)}`
        : (workflow.businessIntent?.name ?? interaction),
    },
    // Une vérification attendue peut répéter une donnée de test : son texte n'est jamais repris.
    nextActions: workflow.nextActions.map((action) => ({
      type: action.kind.toUpperCase(),
      target: action.kind === 'expect' ? 'expected outcome (text not sent)' : action.label,
    })),
    workflowPhase: phase,
    ...(section ? { activeSection: section } : {}),
    preconditions,
    expectedEffects: workflow.expectedEffects,
    previousObservedEffects: [...(previousResults.at(-1)?.observed ?? [])].slice(0, 6),
  };
}

/** L'identité FONCTIONNELLE de la cible d'une étape : son rôle, son concept, son contexte. */
export function functionalIdentityOf(
  step: Extract<FlowStep, { target: unknown }>,
  steps: readonly FlowStep[],
  position: number,
): FunctionalTargetIdentity {
  const fingerprint = step.fingerprint;
  const interaction = INTERACTION[step.kind] ?? 'CLICK';
  const section = fingerprint?.section ?? step.target.section;
  const configuration: Record<string, string> = {};
  for (const previous of steps.slice(Math.max(0, position - 3), position))
    if (
      previous.kind === 'select' &&
      (!section || sectionMatch(previous.fingerprint?.section, section) !== 'OTHER')
    )
      configuration[labelOf(previous) || 'option'] = previous.option;
  const concept = fingerprint?.semanticId ?? step.target.semanticId;
  const label =
    fingerprint?.label ??
    fingerprint?.name ??
    step.target.name ??
    (step.target.strategy === 'label' ? step.target.value : undefined);
  return {
    semanticRole: concept ? slug(concept) : `${interaction}_${slug(label ?? '') || 'TARGET'}`,
    ...(concept ? { businessConcept: concept } : {}),
    interaction,
    ...(label ? { label } : {}),
    ...(fingerprint?.role ? { role: fingerprint.role } : {}),
    ...(fingerprint?.tag ? { tag: fingerprint.tag } : {}),
    ...(section ? { section } : {}),
    ...(fingerprint?.context ? { dialog: fingerprint.context } : {}),
    configuration,
  };
}

/**
 * CANDIDATE DISCOVERY, dans la page (autonome, lecture seule) : les éléments compatibles avec
 * l'action, décrits par leur voisinage sémantique. Chacun est marqué d'un jeton pour pouvoir être
 * utilisé ensuite ; le localisateur enregistré marque ses propres éléments (une preuve de plus).
 */
function scanCandidates(
  spec: { kind: TargetInteraction; token: string; recorded: string; max: number },
  sectionPath: (el: Element) => string[],
): { screen: ScreenSemanticContext; candidates: FunctionalCandidate[] } {
  const clean = (text: string | null | undefined, max = 60): string =>
    (text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const visible = (node: Element): boolean => {
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = getComputedStyle(node);
    return style.visibility !== 'hidden' && style.display !== 'none';
  };
  const FIELD =
    'input:not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]), textarea, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"]';
  const SELECT = 'select, mat-select, [role="combobox"], [role="listbox"]';
  const CLICK =
    'button, a[href], [role="button"], [role="link"], [role="tab"], [role="menuitem"], input[type="button"], input[type="submit"]';
  const CHECK =
    'input[type="checkbox"], input[type="radio"], [role="checkbox"], [role="radio"], [role="switch"]';
  const CONTROL = `${FIELD}, ${SELECT}, ${CLICK}, ${CHECK}`;
  const selector =
    spec.kind === 'FILL' ? FIELD : spec.kind === 'SELECT' ? SELECT : spec.kind === 'CHECK' ? CHECK : CLICK;
  const DIALOG =
    '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open], .cdk-overlay-pane';
  const roleOf = (el: Element): string => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.split(' ')[0] ?? '';
    const tag = el.tagName.toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'a') return 'link';
    if (tag === 'select' || tag === 'mat-select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (['button', 'submit'].includes(type)) return 'button';
      return el.hasAttribute('list') ? 'combobox' : 'textbox';
    }
    return (el as HTMLElement).isContentEditable ? 'textbox' : '';
  };
  const labelOf = (el: Element): string => {
    const labelled = el.getAttribute('aria-labelledby');
    if (labelled)
      return clean(
        labelled
          .split(/\s+/)
          .map((key) => document.getElementById(key)?.textContent ?? '')
          .join(' '),
      );
    const own = (el as HTMLInputElement).labels?.[0] ?? el.closest('label');
    if (own) {
      const copy = own.cloneNode(true) as Element;
      for (const control of Array.from(copy.querySelectorAll('select, input, textarea, option')))
        control.remove();
      return clean(copy.textContent);
    }
    const field = el.closest('mat-form-field, .mat-mdc-form-field');
    const matLabel = field?.querySelector('mat-label, label');
    if (matLabel) return clean(matLabel.textContent);
    return clean(el.getAttribute('aria-label') ?? el.getAttribute('placeholder'));
  };
  const nameOf = (el: Element): string => {
    const label = labelOf(el);
    if (label) return label;
    if (el instanceof HTMLInputElement && ['button', 'submit'].includes(el.type)) return clean(el.value);
    return clean((el as HTMLElement).innerText || el.textContent);
  };
  const shown = (el: Element): string => {
    if (el instanceof HTMLSelectElement) return clean(el.selectedOptions[0]?.textContent);
    if (el.tagName.toLowerCase() === 'mat-select' || el.getAttribute('role') === 'combobox')
      return el instanceof HTMLInputElement ? '' : clean(el.textContent);
    return '';
  };
  const describeControl = (el: Element): string => {
    const value = shown(el);
    const name = nameOf(el);
    return `${roleOf(el) || el.tagName.toLowerCase()}: ${name}${value && value !== name ? ` = ${value}` : ''}`.slice(
      0,
      80,
    );
  };
  // Le localisateur enregistré a marqué ses éléments (data-qa-crawler-recorded) avant ce scan.
  const controls = Array.from(document.querySelectorAll(CONTROL)).filter(
    (el) => !el.closest('[data-qa-crawler-overlay]'),
  );
  const openDialog = Array.from(document.querySelectorAll(DIALOG)).find(visible);
  const dialogName = (node: Element | null | undefined): string =>
    node
      ? clean(
          node.getAttribute('aria-label') ??
            node.querySelector('h1, h2, h3, [role="heading"], legend')?.textContent,
        )
      : '';
  const candidates: FunctionalCandidate[] = [];
  for (const el of Array.from(document.querySelectorAll(selector))) {
    if (candidates.length >= spec.max) break;
    if (el.closest('[data-qa-crawler-overlay]')) continue;
    const isVisible = visible(el);
    // Un élément invisible n'est candidat que si le localisateur enregistré le désigne (preuve à montrer).
    const recorded = el.getAttribute('data-qa-crawler-recorded') === spec.recorded;
    if (!isVisible && !recorded) continue;
    const id = `T${String(candidates.length + 1)}`;
    el.setAttribute('data-qa-crawler-candidate', `${spec.token}-${id}`);
    const at = controls.indexOf(el);
    const before =
      at > 0
        ? controls
            .slice(0, at)
            .reverse()
            .find((other) => !other.contains(el) && !el.contains(other) && visible(other))
        : undefined;
    const after =
      at >= 0
        ? controls.slice(at + 1).find((other) => visible(other) && roleOf(other) === 'button')
        : undefined;
    const input = el as HTMLInputElement;
    const container = el.closest('mat-form-field, .mat-mdc-form-field, fieldset, [role="group"]');
    const path = sectionPath(el);
    const dialog = el.closest(DIALOG);
    const stable: Record<string, string> = {};
    for (const name of ['id', 'name', 'formcontrolname', 'placeholder', 'data-testid'])
      if (el.getAttribute(name)) stable[name] = clean(el.getAttribute(name));
    const near = [
      el.previousElementSibling?.textContent,
      el.parentElement?.previousElementSibling?.textContent,
    ]
      .map((text) => clean(text))
      .filter((text) => text && text.length <= 60);
    const label = labelOf(el);
    const elementId = el.getAttribute('id');
    candidates.push({
      id,
      tag: el.tagName.toLowerCase(),
      role: roleOf(el),
      name: nameOf(el),
      ...(label ? { label } : {}),
      ...(path.length > 0 ? { section: path.join(' > ') } : {}),
      ...(dialogName(dialog) ? { dialog: dialogName(dialog) } : {}),
      visible: isVisible,
      enabled: !(input.disabled || el.getAttribute('aria-disabled') === 'true'),
      editable: !(input.readOnly || input.disabled || el.getAttribute('aria-readonly') === 'true'),
      matchesRecordedLocator: recorded,
      ...(container
        ? {
            parent: `${container.tagName.toLowerCase()}${dialogName(container) ? ` "${dialogName(container)}"` : ''}`,
          }
        : {}),
      ...(before ? { previousControl: describeControl(before) } : {}),
      ...(after ? { nextControl: describeControl(after) } : {}),
      nearText: [...new Set(near)].slice(0, 3),
      stableAttributes: stable,
      ...(elementId ? { cssHint: `#${elementId}` } : {}),
    });
  }
  // L'ÉCRAN, compact : la fenêtre ouverte, les choix affichés, les contrôles et actions visibles.
  const scope = openDialog ?? document.body;
  const selectedValues: Record<string, string> = {};
  for (const el of Array.from(scope.querySelectorAll(SELECT)).filter(visible).slice(0, 8)) {
    const value = shown(el);
    const label = labelOf(el) || nameOf(el);
    if (label && value && value !== '--') selectedValues[label] = value;
  }
  const visibleControls = Array.from(scope.querySelectorAll(CONTROL))
    .filter(visible)
    .slice(0, 14)
    .map((el) => `${roleOf(el) || el.tagName.toLowerCase()}: ${nameOf(el)}`.slice(0, 60));
  const availableActions = Array.from(scope.querySelectorAll(CLICK))
    .filter(visible)
    .slice(0, 8)
    .map((el) => nameOf(el))
    .filter(Boolean);
  return {
    screen: {
      route: location.pathname,
      title: clean(document.title, 80),
      ...(dialogName(openDialog) ? { dialog: dialogName(openDialog) } : {}),
      ...(openDialog && sectionPath(openDialog).length > 0
        ? { activeSection: sectionPath(openDialog).join(' > ') }
        : {}),
      visibleControls,
      selectedValues,
      availableActions,
    },
    candidates,
  };
}

let scans = 0;

/**
 * Découvre les candidats d'une action à l'écran. Le localisateur enregistré marque d'abord les
 * éléments qu'il trouve : « désigné par le localisateur enregistré » devient une preuve parmi
 * d'autres, jamais la décision.
 */
export async function discoverCandidates(
  page: Page,
  step: Extract<FlowStep, { target: unknown }>,
  max = 12,
): Promise<{ token: string; screen: ScreenSemanticContext; candidates: FunctionalCandidate[] }> {
  scans += 1;
  const token = `fr${String(scans)}`;
  const recorded = `${token}-recorded`;
  const target: FlowTarget = step.target;
  await toLocator(page, target)
    .evaluateAll((els, mark) => {
      for (const el of els) el.setAttribute('data-qa-crawler-recorded', mark);
    }, recorded)
    .catch(() => undefined);
  const expression = [
    '(() => { if (typeof globalThis.__name !== "function") { globalThis.__name = function (fn) { return fn; }; }',
    `return (${scanCandidates.toString()})(${JSON.stringify({ kind: INTERACTION[step.kind] ?? 'CLICK', token, recorded, max })}, ${sectionPathOf.toString()}); })()`,
  ].join('\n');
  const result = (await page.evaluate(expression).catch(() => undefined)) as
    { screen: ScreenSemanticContext; candidates: FunctionalCandidate[] } | undefined;
  await page
    .evaluate((mark) => {
      for (const el of Array.from(document.querySelectorAll(`[data-qa-crawler-recorded="${mark}"]`)))
        el.removeAttribute('data-qa-crawler-recorded');
    }, recorded)
    .catch(() => undefined);
  return {
    token,
    screen: result?.screen ?? {
      route: '',
      title: '',
      visibleControls: [],
      selectedValues: {},
      availableActions: [],
    },
    candidates: result?.candidates ?? [],
  };
}

/** Le sélecteur d'un candidat marqué par la découverte. */
export function candidateSelector(token: string, id: string): string {
  return `[data-qa-crawler-candidate="${token}-${id}"]`;
}

/** Retire les marques de la découverte (après usage). */
export async function clearCandidateMarks(page: Page, token: string, keep?: string): Promise<void> {
  await page
    .evaluate(
      ({ prefix, kept }) => {
        for (const el of Array.from(document.querySelectorAll('[data-qa-crawler-candidate]'))) {
          const mark = el.getAttribute('data-qa-crawler-candidate') ?? '';
          if (mark.startsWith(`${prefix}-`) && mark !== `${prefix}-${kept}`)
            el.removeAttribute('data-qa-crawler-candidate');
        }
      },
      { prefix: token, kept: keep ?? '' },
    )
    .catch(() => undefined);
}

/**
 * FUNCTIONAL TARGET SCORER. Les poids reflètent la FORCE de chaque preuve :
 *  - identité (libellé 0.25, section 0.20, contrôle précédent portant le dernier choix 0.15, concept
 *    métier nommé par le libellé 0.10) : ce que l'humain voyait et ce qui distingue deux champs pareils ;
 *  - structure (localisateur enregistré 0.15, rôle 0.10, fenêtre 0.05 / hors fenêtre −0.15) : une preuve, mais fragile
 *    (un id réutilisé, un rôle lu différemment après re-rendu) ;
 *  - parcours (action suivante disponible juste après 0.10) : une preuve, jamais une vérité.
 * Un candidat invisible, non éditable pour une saisie, désactivé, ou d'une AUTRE section est
 * écarté avant tout score (jamais « récupéré » : ce serait masquer une régression).
 */
export function scoreCandidates(
  identity: FunctionalTargetIdentity,
  temporal: TemporalActionContext,
  candidates: readonly FunctionalCandidate[],
): ScoredCandidate[] {
  const lastChoice = Object.values(identity.configuration).at(-1);
  const nextTarget = temporal.nextActions.find((action) => action.type === 'CLICK')?.target;
  return candidates
    .map((candidate): ScoredCandidate => {
      const components: Record<string, number> = {};
      const reject = (reason: string): ScoredCandidate => ({
        ...candidate,
        score: 0,
        components,
        rejected: reason,
      });
      if (!candidate.visible) return reject('hidden');
      if (!candidate.enabled) return reject('disabled');
      if (identity.interaction === 'FILL' && !candidate.editable) return reject('not editable');
      if (sectionMatch(identity.section, candidate.section) === 'OTHER')
        return reject(
          `section "${candidate.section ?? ''}" instead of "${identity.section ?? ''}" (context mismatch)`,
        );
      const wanted = normalize(identity.label);
      const found = normalize(candidate.label ?? candidate.name);
      if (wanted)
        components.label =
          found === wanted ? 0.25 : found && (found.includes(wanted) || wanted.includes(found)) ? 0.15 : -0.1;
      if (sectionMatch(identity.section, candidate.section) === 'SAME') components.section = 0.2;
      // Le contrôle précédent porte le dernier choix fait (« operator: Like ») : la cible est la suite.
      if (
        lastChoice &&
        candidate.previousControl &&
        normalize(candidate.previousControl).includes(normalize(lastChoice))
      )
        components.previousActionCompatibility = 0.15;
      if (candidate.matchesRecordedLocator) components.recordedLocator = 0.15;
      if (identity.role && candidate.role)
        components.role =
          identity.role === candidate.role
            ? 0.1
            : ['textbox', 'combobox', 'searchbox'].includes(identity.role) &&
                ['textbox', 'combobox', 'searchbox'].includes(candidate.role)
              ? 0.05
              : -0.1;
      // La fenêtre : la cible était dans « Filter » ; un champ hors de toute fenêtre n'est pas du contexte.
      if (identity.dialog)
        components.dialog =
          candidate.dialog && normalize(candidate.dialog) === normalize(identity.dialog) ? 0.05 : -0.15;
      // Le concept métier (filter.value) nommé par le libellé actuel (« Value ») : une preuve sémantique.
      const concept = normalize(identity.businessConcept?.split('.').at(-1)?.replace(/[_-]+/g, ' '));
      if (concept && found && (found === concept || found.split(' ').includes(concept)))
        components.businessConceptMatch = 0.1;
      if (
        nextTarget &&
        candidate.nextControl &&
        normalize(candidate.nextControl).includes(normalize(nextTarget))
      )
        components.futureWorkflowCompatibility = 0.1;
      // Un champ sans libellé enregistré : son identité tient au contexte (section, parcours, structure).
      const base = wanted ? 0 : 0.15;
      if (base) components.unlabelledTarget = base;
      const score = Math.max(
        0,
        Math.min(
          1,
          Object.values(components).reduce((sum, value) => sum + value, 0),
        ),
      );
      return { ...candidate, score: Number(score.toFixed(2)), components };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * La décision : un candidat assez fort ET nettement devant les autres. Deux candidats proches :
 * AMBIGUOUS — jamais le premier par hasard.
 */
export function decide(
  ranked: readonly ScoredCandidate[],
  minScore = 0.6,
  margin = 0.15,
): FunctionalDecision {
  const viable = ranked.filter((candidate) => !candidate.rejected);
  const [best, second] = viable;
  if (!best || best.score < 0.45)
    return {
      status: 'NONE',
      ranked: [...ranked],
      reason:
        viable.length === 0 && ranked.some((candidate) => candidate.rejected?.includes('context mismatch'))
          ? 'only candidates of another section: context mismatch'
          : 'no candidate fills the same function in this context',
    };
  if (best.score >= minScore && (!second || best.score - second.score >= margin))
    return {
      status: 'RESOLVED',
      chosen: best,
      ranked: [...ranked],
      reason: 'one candidate clearly fills the same function in this context',
    };
  return {
    status: 'AMBIGUOUS',
    ranked: [...ranked],
    reason: second
      ? `${best.id} ${String(best.score)} and ${second.id} ${String(second.score)} are too close: never the first one by chance`
      : `${best.id} ${String(best.score)} is not strong enough on its own`,
  };
}

/**
 * RERENDER DETECTOR : le localisateur enregistré désigne encore un élément de même fonction, mais
 * son empreinte structurelle a changé, juste après une action CAUSALE (un choix dans la même
 * section) : un nouveau nœud pour le même champ, pas un autre champ.
 */
export function analyzeRerender(
  chosen: ScoredCandidate | undefined,
  temporal: TemporalActionContext,
  fingerprintReasons: readonly string[],
): RerenderAnalysis {
  const evidence: string[] = [];
  if (!chosen?.matchesRecordedLocator) return { detected: false, evidence };
  evidence.push('the recorded locator still designates a functionally equivalent element');
  if (fingerprintReasons.length > 0)
    evidence.push(`structural fingerprint changed: ${fingerprintReasons.slice(0, 2).join('; ')}`);
  const causal = temporal.previousActions.at(-1);
  if (causal && ['SELECT', 'CLICK', 'CHECK'].includes(causal.type))
    evidence.push(
      `appeared after ${causal.type} "${causal.target}"${causal.value ? ` = "${causal.value}"` : ''}`,
    );
  if (chosen.parent?.startsWith('mat-form-field'))
    evidence.push('inside a mat-form-field (framework-rendered)');
  return { detected: evidence.length >= 2, evidence };
}

/** Une valeur saisie et la valeur lue sont-elles la même (casse, espaces, ponctuation, masque) ? */
export function sameFilledValue(held: string, expected: string): boolean {
  const loose = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  if (held.trim() === expected.trim()) return true;
  const a = loose(held);
  const b = loose(expected);
  if (a && b && a === b) return true;
  const digits = (text: string): string => text.replace(/\D+/g, '');
  return digits(expected).length >= 4 && digits(held) === digits(expected);
}

/** Le résumé d'un candidat pour le journal et le rapport. */
export function candidateSummary(candidate: FunctionalCandidate): string {
  return [
    `${candidate.role || candidate.tag}${candidate.name ? ` "${candidate.name}"` : ''}`,
    candidate.cssHint,
    candidate.section ? `section=${candidate.section}` : undefined,
    candidate.previousControl ? `after ${candidate.previousControl}` : undefined,
    candidate.nextControl ? `before ${candidate.nextControl}` : undefined,
    candidate.matchesRecordedLocator ? 'recorded locator' : undefined,
  ]
    .filter(Boolean)
    .join(' · ')
    .slice(0, 200);
}

/** La trace en texte (journal) : TARGET_RESOLUTION, lisible d'un coup d'œil. */
export function traceText(trace: TargetResolutionTrace): string[] {
  return [
    `[TARGET_RESOLUTION] action=${trace.action}`,
    `recorded: ${trace.recorded.locator}`,
    `runtime: ${trace.runtime.locator} fingerprint=${trace.runtime.fingerprintVerdict}`,
    `rerender: ${trace.rerender.detected ? 'DETECTED' : 'not detected'}`,
    `functional identity: ${trace.identity.businessConcept ?? trace.identity.semanticRole}`,
    `context: ${[trace.identity.dialog ? `dialog=${trace.identity.dialog}` : '', ...Object.entries(trace.identity.configuration).map(([key, value]) => `${key}=${value}`)].filter(Boolean).join(' ') || '—'}`,
    `previous: ${trace.temporal.previousActions.map((action) => `${action.type} ${action.target}${action.value ? ` = ${action.value}` : ''}`).join(', ') || '—'}`,
    `next: ${trace.temporal.nextActions.map((action) => `${action.type} ${action.target}`).join(', ') || '—'}`,
    `candidates: ${trace.candidates.map((candidate) => `${candidate.id} ${String(candidate.score)}${candidate.rejected ? ' (rejected)' : ''}`).join(', ') || 'none'}`,
    `resolution: ${trace.resolution ?? trace.decision} — ${trace.reason}`,
    `AI: ${trace.ai.requested ? `${trace.ai.outcome ?? 'requested'}${trace.ai.proposal ? ` proposal=${trace.ai.proposal}` : ''}` : 'not required'}`,
    `status: ${trace.status}${trace.final ? ` → ${trace.final}` : ''}`,
  ];
}

/**
 * TargetResolutionIntelligenceRequest : ce que le conseiller reçoit — structuré, compact, assaini
 * ensuite par la passerelle. Les candidats portent leurs IDENTIFIANTS PUBLICS (A1…) : il ne peut
 * répondre qu'avec l'un d'eux, jamais un nouveau localisateur.
 */
export function targetResolutionRequest(
  trace: TargetResolutionTrace,
  candidates: readonly ScoredCandidate[],
  publicId: (id: string) => string,
  flowName: string,
): Record<string, unknown> {
  return {
    trigger: 'TARGET_FINGERPRINT_MISMATCH',
    mission: { type: 'TARGET_RESOLUTION', flow: flowName },
    workflow: {
      phase: trace.temporal.workflowPhase,
      ...(trace.temporal.activeSection ? { activeSection: trace.temporal.activeSection } : {}),
    },
    previousActions: trace.temporal.previousActions,
    currentAction: trace.temporal.currentAction,
    nextActions: trace.temporal.nextActions,
    preconditions: trace.temporal.preconditions,
    expectedEffects:
      trace.identity.interaction === 'FILL'
        ? ['VALUE_CHANGED', ...trace.temporal.expectedEffects]
        : trace.temporal.expectedEffects,
    originalTarget: {
      ...(trace.recorded.fingerprint?.role ? { role: trace.recorded.fingerprint.role } : {}),
      ...(trace.recorded.fingerprint?.tag ? { tag: trace.recorded.fingerprint.tag } : {}),
      ...(trace.identity.label ? { label: trace.identity.label } : {}),
      ...(trace.identity.section ? { section: trace.identity.section } : {}),
      ...(trace.identity.businessConcept ? { businessConcept: trace.identity.businessConcept } : {}),
      semanticRole: trace.identity.semanticRole,
      configuration: trace.identity.configuration,
    },
    fingerprintMismatch: trace.runtime.reasons.slice(0, 4),
    ...(trace.screen ? { screen: trace.screen } : {}),
    runtimeCandidates: candidates.map((candidate) => ({
      id: publicId(candidate.id),
      tag: candidate.tag,
      role: candidate.role,
      ...(candidate.label ? { label: candidate.label } : {}),
      ...(candidate.cssHint ? { locatorHint: candidate.cssHint } : {}),
      visible: candidate.visible,
      editable: candidate.editable,
      enabled: candidate.enabled,
      ...(candidate.section ? { section: candidate.section } : {}),
      ...(candidate.dialog ? { dialog: candidate.dialog } : {}),
      ...(candidate.parent ? { parent: candidate.parent } : {}),
      ...(candidate.previousControl ? { previousControl: candidate.previousControl } : {}),
      ...(candidate.nextControl ? { nextVisibleControl: candidate.nextControl } : {}),
      ...(candidate.nearText.length > 0 ? { nearText: candidate.nearText } : {}),
      designatedByRecordedLocator: candidate.matchesRecordedLocator,
      deterministicScore: candidate.score,
    })),
    authority: 'RUNTIME_EFFECT_IS_THE_FINAL_PROOF',
  };
}
