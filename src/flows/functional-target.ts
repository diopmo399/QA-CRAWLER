import type { Locator, Page } from 'playwright';
import type { FlowStep, FlowTarget, TargetFingerprint } from '../config/flow-schema.js';
import { describeTarget } from '../config/flow-schema.js';
import { toLocator } from '../execution/locator-resolver.js';
import { sectionPathOf } from '../recording/semantic-dom.js';
import { resolveWorkflowContext } from '../workflow-healing/workflow-context.js';
import { normalize, readTarget, sectionMatch, type ObservedTarget } from './action-effect-verifier.js';
import { redactText } from '../security/redactor.js';

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
  | 'TARGET_CONTRADICTORY_EVIDENCE'
  | 'TARGET_CONTEXTUAL_MATCH'
  | 'TARGET_NO_CANDIDATE'
  | 'TARGET_RUNTIME_CONFIRMED'
  | 'TARGET_RUNTIME_REJECTED'
  | 'TARGET_REQUIRES_REPLAY_VALIDATION';

export type TargetInteraction = 'FILL' | 'SELECT' | 'CLICK' | 'CHECK';

/** Pourquoi une cible est résolue par ses candidats : empreinte qui diffère, localisateur non unique, introuvable. */
export type TargetResolutionTrigger = 'FINGERPRINT_MISMATCH' | 'LOCATOR_NON_UNIQUE' | 'LOCATOR_NOT_FOUND';

/** Le résultat d'une résolution, en une ligne : EXACT … NOT_FOUND / MISMATCH. */
export type TargetResolutionOutcome =
  'EXACT' | 'CONTEXTUAL_MATCH' | 'HEALED' | 'AMBIGUOUS' | 'NOT_FOUND' | 'MISMATCH';

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
  // IDENTITÉ CONTEXTUALISÉE (empreinte enrichie ; absente d'un ancien enregistrement).
  testId?: string;
  /** Le libellé du champ fonctionnel (mat-form-field, fieldset). */
  formField?: string;
  /** L'id enregistré : un indice faible (un id peut être partagé). */
  id?: string;
  stableAttributes?: Record<string, string>;
  nearbyText?: string[];
  /** Le localisateur enregistré est un chemin de positions (nth-…) : une preuve faible. */
  fragileLocator?: boolean;
  // INTERACTION OWNER et contexte structurel enregistrés (absents d'un ancien enregistrement).
  /** « dialog:Filter », « listbox:Operator », « row:Request 42 ». */
  owner?: string;
  tab?: string;
  accordion?: string;
  form?: string;
  row?: string;
  /** Le contrôle qui porte une option (SELECT d'une liste maison). */
  listbox?: string;
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
  /** Le propriétaire et le contexte structurel, lus comme à l'enregistrement. */
  owner?: string;
  tab?: string;
  /** L'onglet du candidat est-il sélectionné ? */
  tabSelected?: boolean;
  accordion?: string;
  accordionExpanded?: boolean;
  form?: string;
  row?: string;
  /** L'id ressemble à un id généré (mat-input-12, :r3:) : jamais une preuve d'identité. */
  generatedId?: boolean;
}

export interface ScoredCandidate extends FunctionalCandidate {
  score: number;
  /** Chaque preuve, ce qu'elle a apporté (ou retiré). */
  components: Record<string, number>;
  /** Les preuves POSITIVES et NÉGATIVES, identifiées (E_T1_RECORDED_LOCATOR_MATCH…) : citables par le conseiller. */
  evidence?: TargetEvidence[];
  /** Les preuves négatives (identifiants) : une cible peut être retenue AVEC des contradictions, jamais en les cachant. */
  contradictions?: string[];
  /** Écarté avant tout score : invisible, désactivé, non éditable, autre contexte (section ET fenêtre). */
  rejected?: string;
}

/** Une preuve de résolution : d'où elle vient, dans quel sens elle pèse. */
export interface TargetEvidence {
  id: string;
  kind: string;
  polarity: 'POSITIVE' | 'NEGATIVE';
  detail: string;
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
  /** L'identité d'interaction (type, intention, propriétaire, contexte) et la clé d'action en contexte. */
  interaction?: { type: string; semanticIntent: string; adapter: string; owner?: string; confidence: number };
  actionContext?: { key: string; parts: Record<string, string> };
  temporal: TemporalActionContext;
  screen?: ScreenSemanticContext;
  candidates: {
    id: string;
    score: number;
    summary: string;
    rejected?: string;
    /** PAGE_SCAN, ou RECORDED_LOCATOR (le localisateur enregistré, gardé même si le scan l'ignore). */
    source?: string;
    positive?: string[];
    negative?: string[];
  }[];
  /**
   * La synchronisation de l'étape PRÉCÉDENTE (transition, signaux, ce qui manquait, stabilité) : le
   * conseiller ne juge qu'APRÈS attente, stabilisation, observation fraîche et relecture de la cible.
   */
  previousTransition?: { status: string; signals: string[]; missing: string[]; stable: boolean };
  /** Pourquoi la résolution a eu lieu, et combien d'éléments le localisateur enregistré trouvait. */
  trigger?: TargetResolutionTrigger;
  rawMatches?: number;
  /** EXACT / CONTEXTUAL_MATCH / HEALED / AMBIGUOUS / NOT_FOUND / MISMATCH. */
  outcome?: TargetResolutionOutcome;
  /** Le score du candidat retenu (ou du meilleur), et l'écart avec le deuxième. */
  confidence?: number;
  ambiguity?: { bestScore: number; secondBestScore: number; scoreGap: number };
  /** Le scan de la page a échoué : la raison (jamais avalée en silence). */
  scanError?: string;
  /** CONTRADICTORY_EVIDENCE : la cible retenue (ou la meilleure) a des preuves positives ET négatives. */
  evidenceStatus?: 'CONSISTENT' | 'CONTRADICTORY_EVIDENCE';
  decision: FunctionalDecision['status'];
  resolution?: string;
  reason: string;
  ai: {
    requested: boolean;
    /** Pourquoi le conseiller est consulté (TARGET_AMBIGUOUS, TARGET_FUNCTIONAL_MISMATCH, CONTRADICTORY_TARGET_EVIDENCE…). */
    trigger?: string;
    mode?: string;
    proposal?: string;
    confidence?: number;
    outcome?: 'VALIDATED' | 'REJECTED' | 'RECORDED_ONLY' | 'NOT_REQUIRED' | 'UNAVAILABLE' | 'INCONCLUSIVE';
    /** AI_PROPOSAL_INVALID_CANDIDATE, AI_PROPOSAL_RUNTIME_REJECTED… */
    rejection?: string;
    auditId?: string;
    citedEvidence?: string[];
  };
  status: TargetResolutionStatus;
  runtimeVerification?: { status: 'CONFIRMED' | 'REJECTED' | 'NOT_VERIFIED'; detail: string };
  nextAction?: 'AVAILABLE' | 'NOT_AVAILABLE' | 'NOT_CHECKED';
  final?:
    | 'TARGET_RECOVERED_AND_CONFIRMED'
    | 'TARGET_RECOVERY_REJECTED'
    | 'TARGET_RESOLVED_NOT_VERIFIED'
    | 'TARGET_UNRESOLVED';
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
    ...((fingerprint?.dialog ?? fingerprint?.context)
      ? { dialog: fingerprint.dialog ?? fingerprint.context }
      : {}),
    configuration,
    ...(fingerprint?.testId ? { testId: fingerprint.testId } : {}),
    ...(fingerprint?.formField ? { formField: fingerprint.formField } : {}),
    ...(fingerprint?.id ? { id: fingerprint.id } : {}),
    ...(fingerprint?.stableAttributes ? { stableAttributes: fingerprint.stableAttributes } : {}),
    ...(fingerprint?.nearbyText ? { nearbyText: fingerprint.nearbyText } : {}),
    ...(step.target.strategy === 'css' && /:nth-(of-type|child)|>\s*div/.test(step.target.value ?? '')
      ? { fragileLocator: true }
      : {}),
    ...(fingerprint?.owner ? { owner: fingerprint.owner } : {}),
    ...(fingerprint?.tab ? { tab: fingerprint.tab } : {}),
    ...(fingerprint?.accordion ? { accordion: fingerprint.accordion } : {}),
    ...(fingerprint?.form ? { form: fingerprint.form } : {}),
    ...(fingerprint?.row ? { row: fingerprint.row } : {}),
    ...(fingerprint?.listbox ? { listbox: fingerprint.listbox } : {}),
  };
}

/**
 * CANDIDATE DISCOVERY, dans la page (autonome, lecture seule) : les éléments compatibles avec
 * l'action, décrits par leur voisinage sémantique. Chacun est marqué d'un jeton pour pouvoir être
 * utilisé ensuite ; le localisateur enregistré marque ses propres éléments (une preuve de plus).
 */
function scanCandidates(
  spec: {
    kind: TargetInteraction;
    token: string;
    recorded: string;
    max: number;
    /** Seulement les éléments du localisateur enregistré (seconde passe), numérotés à partir d'offset. */
    onlyRecorded?: boolean;
    offset?: number;
  },
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
  // Le DOM entier, y compris les shadow roots OUVERTS (web components, design systems) : dans l'ordre.
  const deepAll = (selector: string): Element[] => {
    const out: Element[] = [];
    const visit = (parent: ParentNode): void => {
      for (const child of Array.from(parent.children)) {
        if (child.matches(selector)) out.push(child);
        if (child.shadowRoot) visit(child.shadowRoot);
        visit(child);
      }
    };
    visit(document);
    return out;
  };
  // closest() à travers les frontières de shadow root.
  const composedClosest = (el: Element, selector: string): Element | null => {
    for (let node: Element | null = el; node;) {
      if (node.matches(selector)) return node;
      const parent: Element | null = node.parentElement;
      if (parent) node = parent;
      else {
        const root = node.getRootNode();
        node = root instanceof ShadowRoot ? root.host : null;
      }
    }
    return null;
  };
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
  const controls = deepAll(CONTROL).filter((el) => !composedClosest(el, '[data-qa-crawler-overlay]'));
  const openDialog = deepAll(DIALOG).find(visible);
  const dialogName = (node: Element | null | undefined): string =>
    node
      ? clean(
          node.getAttribute('aria-label') ??
            node.querySelector('h1, h2, h3, [role="heading"], legend')?.textContent,
        )
      : '';
  const candidates: FunctionalCandidate[] = [];
  const pool = spec.onlyRecorded
    ? deepAll(`[data-qa-crawler-recorded="${spec.recorded}"]`).filter(
        (el) => !el.hasAttribute('data-qa-crawler-candidate'),
      )
    : deepAll(selector);
  for (const el of pool) {
    if (candidates.length >= spec.max) break;
    if (composedClosest(el, '[data-qa-crawler-overlay]')) continue;
    const isVisible = visible(el);
    // Un élément invisible n'est candidat que si le localisateur enregistré le désigne (preuve à montrer).
    const recorded = el.getAttribute('data-qa-crawler-recorded') === spec.recorded;
    if (!isVisible && !recorded) continue;
    const id = `T${String((spec.offset ?? 0) + candidates.length + 1)}`;
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
    const container = composedClosest(el, 'mat-form-field, .mat-mdc-form-field, fieldset, [role="group"]');
    const path = sectionPath(el);
    const dialog = composedClosest(el, DIALOG);
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
    // INTERACTION OWNER, lu comme à l'enregistrement : onglet, accordéon, formulaire, ligne, propriétaire.
    const context: Record<string, string | boolean> = {};
    const panel = composedClosest(el, '[role="tabpanel"], mat-tab-body');
    if (panel) {
      const panelId = panel.getAttribute('id');
      const by = panel.getAttribute('aria-labelledby');
      const tab =
        (panelId ? document.querySelector(`[role="tab"][aria-controls="${CSS.escape(panelId)}"]`) : null) ??
        (by ? document.getElementById(by.split(/\s+/)[0] ?? '') : null);
      if (tab) {
        context.tab = clean(tab.textContent);
        context.tabSelected = tab.getAttribute('aria-selected') === 'true';
      }
    }
    const expansion = composedClosest(el, 'mat-expansion-panel, details');
    if (expansion) {
      const header = expansion.querySelector(':scope > mat-expansion-panel-header, :scope > summary');
      context.accordion = clean(header?.textContent);
      context.accordionExpanded =
        expansion.tagName.toLowerCase() === 'details'
          ? (expansion as HTMLDetailsElement).open
          : expansion.classList.contains('mat-expanded') || header?.getAttribute('aria-expanded') === 'true';
    } else
      for (let node = el.parentElement, depth = 0; node && depth < 8; node = node.parentElement, depth += 1) {
        if (!node.id) continue;
        const controller = document.querySelector(`[aria-controls="${CSS.escape(node.id)}"][aria-expanded]`);
        if (controller && !controller.contains(el)) {
          context.accordion = clean(controller.textContent);
          context.accordionExpanded = controller.getAttribute('aria-expanded') === 'true';
          break;
        }
      }
    const form = composedClosest(el, 'form, [role="form"]');
    const formName = form
      ? clean(form.getAttribute('aria-label') ?? form.getAttribute('name')) || dialogName(form)
      : '';
    if (formName) context.form = formName;
    const row = composedClosest(el, 'tr, [role="row"]');
    const cell = row
      ? Array.from(row.querySelectorAll('th, td, [role="cell"], [role="gridcell"], [role="rowheader"]')).find(
          (candidate) => !candidate.contains(el) && clean(candidate.textContent),
        )
      : undefined;
    if (cell) context.row = clean(cell.textContent, 40);
    const owner = composedClosest(
      el,
      '[role="dialog"], [role="alertdialog"], dialog, mat-dialog-container, [role="tabpanel"], mat-tab-body, mat-expansion-panel, details, [role="menu"], [role="listbox"], [role="toolbar"], mat-toolbar, tr, [role="row"], fieldset, form, [role="form"], mat-card, [role="region"], section',
    );
    if (owner) {
      const tag = owner.tagName.toLowerCase();
      const role = owner.getAttribute('role') ?? '';
      const kind =
        /dialog/.test(role) || tag === 'dialog' || tag === 'mat-dialog-container'
          ? 'dialog'
          : role === 'tabpanel' || tag === 'mat-tab-body'
            ? 'tab'
            : tag === 'mat-expansion-panel' || tag === 'details'
              ? 'accordion'
              : role === 'menu'
                ? 'menu'
                : role === 'listbox'
                  ? 'listbox'
                  : role === 'toolbar' || tag === 'mat-toolbar'
                    ? 'toolbar'
                    : tag === 'tr' || role === 'row'
                      ? 'row'
                      : tag === 'fieldset'
                        ? 'fieldset'
                        : tag === 'form' || role === 'form'
                          ? 'form'
                          : tag === 'mat-card'
                            ? 'card'
                            : 'section';
      const name =
        kind === 'tab'
          ? context.tab
          : kind === 'accordion'
            ? context.accordion
            : kind === 'row'
              ? context.row
              : dialogName(owner);
      if (typeof name === 'string' && name) context.owner = `${kind}:${name}`;
    }
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
      ...context,
      ...(elementId && /^(mat-|cdk-|ng-|mui-|:r)|\d{3,}|[-_]\d+$/.test(elementId)
        ? { generatedId: true }
        : {}),
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
): Promise<{
  token: string;
  screen: ScreenSemanticContext;
  candidates: (FunctionalCandidate & { source?: CandidateSource })[];
  scanError?: string;
}> {
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
  let scanError: string | undefined;
  const result = (await page.evaluate(expression).catch((error: unknown) => {
    scanError = error instanceof Error ? (error.message.split('\n')[0] ?? error.message) : String(error);
    return undefined;
  })) as { screen: ScreenSemanticContext; candidates: FunctionalCandidate[] } | undefined;
  const candidates: (FunctionalCandidate & { source?: CandidateSource })[] = (result?.candidates ?? []).map(
    (candidate) => ({ ...candidate, source: 'PAGE_SCAN' }),
  );
  // LE LOCALISATEUR ENREGISTRÉ trouve un élément que le scan n'a pas retenu (autre genre de contrôle,
  // scan en échec) : il devient candidat quand même, avec ses preuves contradictoires — jamais perdu.
  if (!candidates.some((candidate) => candidate.matchesRecordedLocator)) {
    const second = [
      '(() => { if (typeof globalThis.__name !== "function") { globalThis.__name = function (fn) { return fn; }; }',
      `return (${scanCandidates.toString()})(${JSON.stringify({ kind: INTERACTION[step.kind] ?? 'CLICK', token, recorded, max: 3, onlyRecorded: true, offset: candidates.length })}, ${sectionPathOf.toString()}); })()`,
    ].join('\n');
    const extra = (await page.evaluate(second).catch(() => undefined)) as
      { candidates: FunctionalCandidate[] } | undefined;
    for (const candidate of extra?.candidates ?? [])
      candidates.push({ ...candidate, source: 'RECORDED_LOCATOR' });
  }
  await page
    .evaluate((mark) => {
      const visit = (parent: ParentNode): void => {
        for (const child of Array.from(parent.children)) {
          if (child.getAttribute('data-qa-crawler-recorded') === mark)
            child.removeAttribute('data-qa-crawler-recorded');
          if (child.shadowRoot) visit(child.shadowRoot);
          visit(child);
        }
      };
      visit(document);
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
    candidates,
    ...(scanError ? { scanError } : {}),
  };
}

/**
 * DERNIER RECOURS : le scan de la page a échoué ou n'a rien rendu, mais le localisateur enregistré
 * tient encore un élément. Il est décrit par l'API Playwright (rôle, nom, visibilité, éditabilité) et
 * marqué pour pouvoir être utilisé : CandidateSet ≥ 1 dès qu'un élément runtime est retrouvé.
 */
export async function recordedLocatorCandidate(
  located: Locator,
  token: string,
  id: string,
): Promise<(FunctionalCandidate & { source: CandidateSource }) | undefined> {
  const marked = await located
    .evaluate((el, mark) => {
      el.setAttribute('data-qa-crawler-candidate', mark);
      return { tag: el.tagName.toLowerCase(), id: el.getAttribute('id') ?? '' };
    }, `${token}-${id}`)
    .catch(() => undefined);
  if (!marked) return undefined;
  const observed = await readTarget(located).catch((): ObservedTarget => ({}));
  const visible = await located.isVisible().catch(() => false);
  const enabled = await located.isEnabled().catch(() => false);
  const editable = await located.isEditable().catch(() => false);
  return {
    id,
    tag: marked.tag,
    role: observed.role ?? '',
    name: observed.name ?? observed.text ?? '',
    ...(observed.name ? { label: observed.name } : {}),
    ...(observed.section ? { section: observed.section } : {}),
    visible,
    enabled,
    editable,
    matchesRecordedLocator: true,
    nearText: [],
    stableAttributes: marked.id ? { id: marked.id } : {},
    ...(marked.id ? { cssHint: `#${marked.id}` } : {}),
    source: 'RECORDED_LOCATOR',
  };
}

/** D'où vient un candidat : le scan de la page, ou le localisateur enregistré (seconde passe / API). */
export type CandidateSource = 'PAGE_SCAN' | 'RECORDED_LOCATOR';

/** Le sélecteur d'un candidat marqué par la découverte. */
export function candidateSelector(token: string, id: string): string {
  return `[data-qa-crawler-candidate="${token}-${id}"]`;
}

/** Retire les marques de la découverte (après usage). */
export async function clearCandidateMarks(page: Page, token: string, keep?: string): Promise<void> {
  await page
    .evaluate(
      ({ prefix, kept }) => {
        const visit = (parent: ParentNode): void => {
          for (const child of Array.from(parent.children)) {
            const mark = child.getAttribute('data-qa-crawler-candidate') ?? '';
            if (mark.startsWith(`${prefix}-`) && mark !== `${prefix}-${kept}`)
              child.removeAttribute('data-qa-crawler-candidate');
            if (child.shadowRoot) visit(child.shadowRoot);
            visit(child);
          }
        };
        visit(document);
      },
      { prefix: token, kept: keep ?? '' },
    )
    .catch(() => undefined);
}

/**
 * LES POIDS du scoring des candidats, centralisés (jamais dispersés dans le code) — du plus fort au
 * plus faible : testId stable, rôle + nom / libellé, champ fonctionnel, concept métier, contexte
 * (section, fenêtre), attributs métier stables, voisinage et parcours, puis la structure (id partagé,
 * localisateur positionnel : une confiance faible). Les pénalités sont des preuves NÉGATIVES ; les
 * contradictions DURES (caché, désactivé, autre contexte) écartent avant tout score.
 */
export const TARGET_SCORE_WEIGHTS = {
  testIdMatch: 0.3,
  testIdMismatch: -0.3,
  labelExact: 0.25,
  labelPartial: 0.15,
  labelMismatch: -0.1,
  section: 0.2,
  formField: 0.1,
  previousAction: 0.15,
  locatorIdentity: 0.15,
  /** Un localisateur positionnel (nth-…) qui désigne un candidat : presque rien. */
  fragileLocatorIdentity: 0.03,
  roleExact: 0.1,
  roleCompatible: 0.05,
  roleMismatch: -0.1,
  dialogMatch: 0.05,
  dialogMismatch: -0.15,
  businessConcept: 0.1,
  stableAttribute: 0.1,
  nearbyText: 0.05,
  workflowContext: 0.05,
  nextAction: 0.1,
  unlabelledTarget: 0.15,
  contextMismatchPenalty: -0.2,
  sharedId: 0.02,
  // INTERACTION OWNER et contexte : ce qui distingue deux « Apply » de deux dialogues, deux listes
  // pareilles de deux formulaires, une case d'une ligne d'une autre.
  ownerMatch: 0.15,
  ownerMismatch: -0.2,
  tabMatch: 0.1,
  tabMismatch: -0.25,
  accordionMatch: 0.1,
  accordionMismatch: -0.2,
  formMatch: 0.1,
  formMismatch: -0.15,
  rowMatch: 0.15,
  rowMismatch: -0.3,
  generatedIdPenalty: -0.05,
} as const;

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
  /** Le localisateur enregistré a été lu au runtime et son empreinte ne correspond plus. */
  fingerprintMismatch?: { score?: number; reasons: readonly string[] },
): ScoredCandidate[] {
  const lastChoice = Object.values(identity.configuration).at(-1);
  const nextTarget = temporal.nextActions.find((action) => action.type === 'CLICK')?.target;
  return candidates
    .map((candidate): ScoredCandidate => {
      const components: Record<string, number> = {};
      const evidence: TargetEvidence[] = [];
      const prove = (kind: string, polarity: TargetEvidence['polarity'], detail: string): void => {
        evidence.push({ id: `E_${candidate.id}_${kind}`, kind, polarity, detail });
      };
      // Le localisateur enregistré et l'empreinte : une preuve positive ET une preuve négative.
      if (candidate.matchesRecordedLocator) {
        prove('RECORDED_LOCATOR_MATCH', 'POSITIVE', 'the recorded locator resolves to this element');
        if (fingerprintMismatch)
          prove(
            'FINGERPRINT_MISMATCH',
            'NEGATIVE',
            `recorded fingerprint differs${fingerprintMismatch.score !== undefined ? ` (score ${String(fingerprintMismatch.score)})` : ''}: ${fingerprintMismatch.reasons.slice(0, 2).join('; ')}`,
          );
      }
      if (candidate.visible) prove('VISIBLE', 'POSITIVE', 'visible');
      if (candidate.enabled) prove('ENABLED', 'POSITIVE', 'enabled');
      if (identity.interaction === 'FILL' && candidate.editable) prove('EDITABLE', 'POSITIVE', 'editable');
      const reject = (reason: string): ScoredCandidate => {
        prove('HARD_CONTRADICTION', 'NEGATIVE', reason);
        return { ...candidate, score: 0, components, evidence, contradictions: [reason], rejected: reason };
      };
      // DURS : jamais actionnable (invisible, désactivé, non éditable pour une saisie).
      if (!candidate.visible) return reject('hidden');
      if (!candidate.enabled) return reject('disabled');
      if (identity.interaction === 'FILL' && !candidate.editable) return reject('not editable');
      const sameDialog =
        identity.dialog !== undefined &&
        candidate.dialog !== undefined &&
        normalize(candidate.dialog) === normalize(identity.dialog);
      const section = sectionMatch(identity.section, candidate.section);
      // Une AUTRE section ET une autre fenêtre : un autre contexte (jamais « récupéré »). Une autre
      // section DANS la même fenêtre : un chemin de sections qui a changé — une preuve négative, pas une exclusion.
      if (section === 'OTHER' && !sameDialog)
        return reject(
          `section "${candidate.section ?? ''}" instead of "${identity.section ?? ''}" (context mismatch)`,
        );
      if (section === 'OTHER') {
        components.contextMismatchPenalty = TARGET_SCORE_WEIGHTS.contextMismatchPenalty;
        prove(
          'SECTION_PATH_CHANGED',
          'NEGATIVE',
          `section "${candidate.section ?? ''}" instead of "${identity.section ?? ''}" (same dialog)`,
        );
      }
      const wanted = normalize(identity.label);
      const found = normalize(candidate.label ?? candidate.name);
      if (wanted) {
        components.label =
          found === wanted
            ? TARGET_SCORE_WEIGHTS.labelExact
            : found && (found.includes(wanted) || wanted.includes(found))
              ? TARGET_SCORE_WEIGHTS.labelPartial
              : TARGET_SCORE_WEIGHTS.labelMismatch;
        prove(
          components.label > 0 ? 'LABEL_MATCH' : 'LABEL_CHANGED',
          components.label > 0 ? 'POSITIVE' : 'NEGATIVE',
          `label "${candidate.label ?? candidate.name}" (recorded "${identity.label ?? ''}")`,
        );
      }
      if (section === 'SAME') {
        components.section = TARGET_SCORE_WEIGHTS.section;
        prove('SECTION_MATCH', 'POSITIVE', `section "${candidate.section ?? ''}"`);
      }
      // Le contrôle précédent porte le dernier choix fait (« operator: Like ») : la cible est la suite.
      if (
        lastChoice &&
        candidate.previousControl &&
        normalize(candidate.previousControl).includes(normalize(lastChoice))
      ) {
        components.previousActionCompatibility = TARGET_SCORE_WEIGHTS.previousAction;
        prove('PREVIOUS_ACTION', 'POSITIVE', `right after ${candidate.previousControl}`);
      }
      // UNIQUE CSS SELECTOR ≠ STABLE TARGET : un chemin de positions n'est qu'une preuve faible.
      if (candidate.matchesRecordedLocator)
        components.locatorIdentity = identity.fragileLocator
          ? TARGET_SCORE_WEIGHTS.fragileLocatorIdentity
          : TARGET_SCORE_WEIGHTS.locatorIdentity;
      if (identity.role && candidate.role) {
        components.role =
          identity.role === candidate.role
            ? TARGET_SCORE_WEIGHTS.roleExact
            : ['textbox', 'combobox', 'searchbox'].includes(identity.role) &&
                ['textbox', 'combobox', 'searchbox'].includes(candidate.role)
              ? TARGET_SCORE_WEIGHTS.roleCompatible
              : TARGET_SCORE_WEIGHTS.roleMismatch;
        if (identity.role !== candidate.role)
          prove('ROLE_CHANGED', 'NEGATIVE', `role ${candidate.role} instead of ${identity.role}`);
      }
      // La fenêtre : la cible était dans « Filter » ; un champ hors de toute fenêtre n'est pas du contexte.
      if (identity.dialog) {
        components.dialog = sameDialog
          ? TARGET_SCORE_WEIGHTS.dialogMatch
          : TARGET_SCORE_WEIGHTS.dialogMismatch;
        prove(
          sameDialog ? 'DIALOG_MATCH' : 'DIALOG_MISMATCH',
          sameDialog ? 'POSITIVE' : 'NEGATIVE',
          `dialog "${candidate.dialog ?? 'none'}" (recorded "${identity.dialog}")`,
        );
      }
      // Le concept métier (filter.value) nommé par le libellé actuel (« Value ») : une preuve sémantique.
      const concept = normalize(identity.businessConcept?.split('.').at(-1)?.replace(/[_-]+/g, ' '));
      if (concept && found && (found === concept || found.split(' ').includes(concept))) {
        components.businessConceptMatch = TARGET_SCORE_WEIGHTS.businessConcept;
        prove('BUSINESS_CONCEPT', 'POSITIVE', `"${found}" names ${identity.businessConcept ?? ''}`);
      }
      if (
        nextTarget &&
        candidate.nextControl &&
        normalize(candidate.nextControl).includes(normalize(nextTarget))
      ) {
        components.nextActionCompatibility = TARGET_SCORE_WEIGHTS.nextAction;
        prove(
          'NEXT_ACTION',
          'POSITIVE',
          `the next action "${nextTarget}" follows it (${candidate.nextControl})`,
        );
      }
      // Un champ sans libellé enregistré : son identité tient au contexte (section, parcours, structure).
      // IDENTITÉ CONTEXTUALISÉE : testId, champ fonctionnel, attributs métier, voisinage, parcours.
      const testId = candidate.stableAttributes['data-testid'];
      if (identity.testId && testId) {
        components.testId =
          testId === identity.testId ? TARGET_SCORE_WEIGHTS.testIdMatch : TARGET_SCORE_WEIGHTS.testIdMismatch;
        prove(
          testId === identity.testId ? 'TEST_ID_MATCH' : 'TEST_ID_CHANGED',
          testId === identity.testId ? 'POSITIVE' : 'NEGATIVE',
          `data-testid "${testId}" (recorded "${identity.testId}")`,
        );
      }
      if (identity.formField && found && normalize(identity.formField) === found) {
        components.formField = TARGET_SCORE_WEIGHTS.formField;
        prove('FORM_FIELD_MATCH', 'POSITIVE', `field "${identity.formField}"`);
      }
      const stable = Object.entries(identity.stableAttributes ?? {}).filter(
        ([key, value]) => candidate.stableAttributes[key] === value,
      );
      if (stable.length > 0) {
        components.stableAttribute = TARGET_SCORE_WEIGHTS.stableAttribute;
        prove(
          'STABLE_ATTRIBUTE_MATCH',
          'POSITIVE',
          stable.map(([key, value]) => `${key}="${value}"`).join(' '),
        );
      }
      if (identity.id && candidate.stableAttributes.id === identity.id)
        components.sharedId = TARGET_SCORE_WEIGHTS.sharedId;
      const around = [candidate.previousControl, candidate.nextControl, ...candidate.nearText]
        .filter((text): text is string => Boolean(text))
        .map((text) => normalize(text));
      const near = (identity.nearbyText ?? []).filter((text) =>
        around.some((other) => other.includes(normalize(text))),
      );
      if (near.length > 0) {
        components.nearbyText = TARGET_SCORE_WEIGHTS.nearbyText;
        prove('NEARBY_TEXT_MATCH', 'POSITIVE', near.slice(0, 3).join(', '));
      }
      // Le parcours : le libellé du candidat nomme un choix fait juste avant (l'attribut choisi).
      const chosen = Object.values(identity.configuration).map((value) => normalize(value));
      if (found && chosen.includes(found)) {
        components.workflowContext = TARGET_SCORE_WEIGHTS.workflowContext;
        prove('WORKFLOW_CONTEXT_MATCH', 'POSITIVE', `"${found}" was chosen just before`);
      }
      // INTERACTION OWNER et contexte structurel : chaque dimension connue des DEUX côtés est une
      // preuve (positive ou négative) ; inconnue d'un côté, elle ne pèse pas.
      const contextual = (
        dimension: 'owner' | 'tab' | 'accordion' | 'form' | 'row',
        match: number,
        mismatch: number,
      ): void => {
        const recorded = identity[dimension];
        const observed = candidate[dimension];
        if (!recorded || !observed) return;
        const same = normalize(recorded) === normalize(observed);
        components[`${dimension}Context`] = same ? match : mismatch;
        prove(
          `${dimension.toUpperCase()}_${same ? 'MATCH' : 'MISMATCH'}`,
          same ? 'POSITIVE' : 'NEGATIVE',
          `${dimension} "${observed}" (recorded "${recorded}")`,
        );
      };
      contextual('owner', TARGET_SCORE_WEIGHTS.ownerMatch, TARGET_SCORE_WEIGHTS.ownerMismatch);
      contextual('tab', TARGET_SCORE_WEIGHTS.tabMatch, TARGET_SCORE_WEIGHTS.tabMismatch);
      contextual('accordion', TARGET_SCORE_WEIGHTS.accordionMatch, TARGET_SCORE_WEIGHTS.accordionMismatch);
      contextual('form', TARGET_SCORE_WEIGHTS.formMatch, TARGET_SCORE_WEIGHTS.formMismatch);
      contextual('row', TARGET_SCORE_WEIGHTS.rowMatch, TARGET_SCORE_WEIGHTS.rowMismatch);
      // Un id généré (mat-input-12) qui correspond n'est pas une preuve ; il ne retire rien sinon.
      if (candidate.generatedId && identity.id && candidate.stableAttributes.id === identity.id) {
        components.generatedId = TARGET_SCORE_WEIGHTS.generatedIdPenalty;
        prove('GENERATED_ID', 'NEGATIVE', `id "${identity.id}" looks generated: not an identity`);
      }
      const base = wanted ? 0 : TARGET_SCORE_WEIGHTS.unlabelledTarget;
      if (base) components.unlabelledTarget = base;
      // Jamais plafonné à 1 pour CLASSER : deux candidats « saturés » (empreinte riche) resteraient
      // indiscernables et la preuve qui les départage (le parcours) serait perdue. La confiance
      // affichée, elle, est bornée (resolutionOutcomeOf).
      const score = Math.max(
        0,
        Object.values(components).reduce((sum, value) => sum + value, 0),
      );
      const contradictions = evidence
        .filter((entry) => entry.polarity === 'NEGATIVE')
        .map((entry) => entry.id);
      return { ...candidate, score: Number(score.toFixed(2)), components, evidence, contradictions };
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
    reason:
      best.score < minScore
        ? `${best.id} ${String(best.score)} is not strong enough on its own (minimum ${String(minScore)})`
        : second
          ? `${best.id} ${String(best.score)} and ${second.id} ${String(second.score)} are too close: never the first one by chance`
          : `${best.id} ${String(best.score)} is not strong enough on its own`,
  };
}

/**
 * QUAND CONSULTER LE CONSEILLER (lent, seulement si le déterministe ne prouve rien) : une ambiguïté,
 * un candidat retrouvé mais aux preuves contradictoires, ou aucun candidat assez fort alors qu'au
 * moins un élément actionnable existe. Jamais quand la cible est résolue ; jamais sans candidat
 * actionnable (le conseiller ne peut pas inventer un élément).
 */
export function aiTriggerOf(decision: FunctionalDecision): string | undefined {
  if (decision.status === 'RESOLVED') return undefined;
  const viable = decision.ranked.filter((candidate) => !candidate.rejected);
  if (viable.length === 0) return undefined;
  // Deux candidats proches : une ambiguïté. Un seul, trop faible : une confiance basse, dont la cause
  // est dite (preuves contradictoires sur la cible enregistrée, ou aucune fonction équivalente).
  if (decision.status === 'AMBIGUOUS' && viable.length >= 2) return 'TARGET_AMBIGUOUS';
  const best = viable[0];
  if (best?.matchesRecordedLocator && (best.contradictions?.length ?? 0) > 0)
    return 'CONTRADICTORY_TARGET_EVIDENCE';
  return decision.status === 'AMBIGUOUS' ? 'TARGET_LOW_CONFIDENCE' : 'TARGET_FUNCTIONAL_MISMATCH';
}

/**
 * L'issue d'une résolution : CONTEXTUAL_MATCH (le contexte a départagé plusieurs éléments du même
 * localisateur), HEALED (le localisateur ne trouvait plus rien, ou un autre élément), AMBIGUOUS
 * (jamais un choix arbitraire), NOT_FOUND (aucun candidat), MISMATCH (aucun ne remplit la fonction).
 */
export function resolutionOutcomeOf(
  trace: Pick<TargetResolutionTrace, 'status' | 'decision'>,
  ranked: readonly ScoredCandidate[],
  chosen: ScoredCandidate | undefined,
  trigger: TargetResolutionTrigger,
): Pick<TargetResolutionTrace, 'outcome' | 'confidence' | 'ambiguity'> {
  const viable = ranked.filter((candidate) => !candidate.rejected);
  const [best, second] = viable;
  const ambiguity =
    best && second
      ? {
          bestScore: best.score,
          secondBestScore: second.score,
          scoreGap: Number((best.score - second.score).toFixed(2)),
        }
      : undefined;
  const outcome: TargetResolutionOutcome = chosen
    ? trigger === 'LOCATOR_NOT_FOUND' ||
      (trigger === 'FINGERPRINT_MISMATCH' && !chosen.matchesRecordedLocator)
      ? 'HEALED'
      : 'CONTEXTUAL_MATCH'
    : ranked.length === 0
      ? 'NOT_FOUND'
      : trace.status === 'TARGET_AMBIGUOUS' || (trace.decision === 'AMBIGUOUS' && viable.length >= 2)
        ? 'AMBIGUOUS'
        : 'MISMATCH';
  return {
    outcome,
    confidence: Math.min(1, (chosen ?? best)?.score ?? 0),
    ...(ambiguity ? { ambiguity } : {}),
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

/** [TARGET_CONTEXT] : previous ✓ (confirmé) / ✗, current ?, next →. */
export function temporalLine(temporal: TemporalActionContext): string {
  return [
    ...temporal.previousActions.map(
      (action) =>
        `previous ${action.result === 'CONFIRMED' ? '✓' : action.result ? '✗' : '·'} ${action.type} ${action.target}${action.value ? ` = ${action.value}` : ''}`,
    ),
    `current ? ${temporal.currentAction.type} ${temporal.currentAction.recordedTarget}`,
    ...temporal.nextActions.map((action) => `next → ${action.type} ${action.target}`),
  ].join(' | ');
}

/** Une structure assainie en profondeur (chaque chaîne passe par le redactor) : pour les artefacts. */
export function redactDeep<T>(value: T): T {
  const walk = (entry: unknown): unknown => {
    if (typeof entry === 'string') return redactText(entry);
    if (Array.isArray(entry)) return entry.map(walk);
    if (entry !== null && typeof entry === 'object')
      return Object.fromEntries(
        Object.entries(entry as Record<string, unknown>).map(([key, item]) => [key, walk(item)]),
      );
    return entry;
  };
  return walk(value) as T;
}

/** La trace en texte (journal) : TARGET_RESOLUTION, lisible d'un coup d'œil. */
export function traceText(trace: TargetResolutionTrace): string[] {
  return [
    `[TARGET_RESOLUTION] action=${trace.action}`,
    `recordedLocator=${trace.recorded.locator}${trace.rawMatches !== undefined ? ` rawMatches=${String(trace.rawMatches)}` : ''}${trace.trigger ? ` trigger=${trace.trigger}` : ''}`,
    `runtime: ${trace.runtime.locator} fingerprint=${trace.runtime.fingerprintVerdict}`,
    `rerender: ${trace.rerender.detected ? 'DETECTED' : 'not detected'}`,
    `functional identity: ${trace.identity.businessConcept ?? trace.identity.semanticRole}`,
    ...(trace.interaction
      ? [
          `interaction: ${trace.interaction.type} ${trace.interaction.semanticIntent} (${trace.interaction.adapter}${trace.interaction.owner ? `, owner ${trace.interaction.owner}` : ''}, confidence ${String(trace.interaction.confidence)})${trace.actionContext ? ` ${trace.actionContext.key}` : ''}`,
        ]
      : []),
    `context: ${[trace.identity.dialog ? `dialog=${trace.identity.dialog}` : '', trace.identity.tab ? `tab=${trace.identity.tab}` : '', trace.identity.accordion ? `accordion=${trace.identity.accordion}` : '', trace.identity.form ? `form=${trace.identity.form}` : '', trace.identity.row ? `row=${trace.identity.row}` : '', ...Object.entries(trace.identity.configuration).map(([key, value]) => `${key}=${value}`)].filter(Boolean).join(' ') || '—'}`,
    `previous: ${trace.temporal.previousActions.map((action) => `${action.type} ${action.target}${action.value ? ` = ${action.value}` : ''}`).join(', ') || '—'}`,
    `next: ${trace.temporal.nextActions.map((action) => `${action.type} ${action.target}`).join(', ') || '—'}`,
    `candidates: ${trace.candidates.map((candidate) => `${candidate.id} ${String(candidate.score)}${candidate.rejected ? ' (rejected)' : ''}`).join(', ') || 'none'}`,
    `resolution: ${trace.resolution ?? trace.decision} — ${trace.reason}`,
    `AI: ${trace.ai.requested ? `${trace.ai.outcome ?? 'requested'}${trace.ai.proposal ? ` proposal=${trace.ai.proposal}` : ''}` : 'not required'}`,
    `status: ${trace.status}${trace.outcome ? ` (${trace.outcome}${trace.confidence !== undefined ? `, confidence ${String(trace.confidence)}` : ''})` : ''}${trace.final ? ` → ${trace.final}` : ''}`,
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
    mission: {
      type: 'TARGET_RESOLUTION',
      context: 'REPLAY_RECORDED_HUMAN_JOURNEY',
      goal: 'Replay faithfully the recorded human workflow',
      flow: flowName,
    },
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
    ...(trace.previousTransition ? { transitionSignalsObserved: trace.previousTransition } : {}),
    ...(trace.screen ? { screen: trace.screen } : {}),
    resolutionFailure: {
      type: trace.status,
      reason: trace.reason,
      ...(trace.ai.trigger ? { trigger: trace.ai.trigger } : {}),
    },
    knownFacts: [
      ...(candidates.some((candidate) => candidate.matchesRecordedLocator)
        ? ['The recorded locator resolves to a runtime element']
        : ['The recorded locator does not resolve to an actionable runtime element']),
      ...(trace.temporal.previousActions.every((action) => action.result === 'CONFIRMED') &&
      trace.temporal.previousActions.length > 0
        ? ['The previous actions were confirmed at runtime']
        : []),
      `The current expected action is a ${trace.identity.interaction}`,
      ...(trace.temporal.nextActions[0]
        ? [
            `The next recorded action is ${trace.temporal.nextActions[0].type} "${trace.temporal.nextActions[0].target}"`,
          ]
        : []),
    ],
    constraints: {
      mustChooseExistingCandidate: true,
      mustNotInventElement: true,
      mustNotExecuteAction: true,
      runtimeMustValidateProposal: true,
    },
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
      // Les preuves citables (identifiants) : positives, et les contradictions — jamais cachées.
      evidence: (candidate.evidence ?? [])
        .filter((entry) => entry.polarity === 'POSITIVE')
        .map((entry) => entry.id),
      contradictions: (candidate.evidence ?? [])
        .filter((entry) => entry.polarity === 'NEGATIVE')
        .map((entry) => `${entry.id}: ${entry.detail}`),
    })),
    authority: 'RUNTIME_EFFECT_IS_THE_FINAL_PROOF',
  };
}
