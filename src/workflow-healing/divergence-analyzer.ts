import type { StepEffects } from '../config/flow-schema.js';
import type {
  DivergenceAnalysis,
  DivergenceCategory,
  DivergenceSymptom,
  Evidence,
  FunctionalState,
  GoalProgress,
  RootCauseCandidate,
  ScreenControl,
  WorkflowPrerequisite,
} from './model.js';
import { labelSimilarity, round } from './similarity.js';

/** Ce que l'analyse reçoit : le symptôme, l'écran, le réseau, et l'étape d'avant. */
export interface DivergenceInput {
  actionId: string;
  stepIndex: number;
  symptom: DivergenceSymptom;
  expected: { label: string; role?: string; kind: string };
  effects?: StepEffects;
  screen: {
    route: string;
    controls: readonly ScreenControl[];
    /** Court extrait du texte visible (jamais une valeur de champ). */
    text: string;
    overlay?: string;
    /** Un champ mot de passe visible : un écran de connexion. */
    loginFormVisible: boolean;
  };
  /** Les échanges récents du parcours (méthode + chemin + statut), sans corps. */
  network: readonly { request: string; status?: number }[];
  /** L'étape précédente : son effet n'a été que provisoirement accepté (attendu ≠ observé). */
  previous?: { index: number; deferredEffect: boolean; description: string };
  /** Progression de l'objectif fonctionnel au moment de la divergence. */
  goal?: GoalProgress;
  /** La route enregistrée de l'étape (effects.route), si elle diffère de la route courante. */
  expectedRoute?: string;
}

const PERMISSION_TEXT =
  /\b(forbidden|not authori[sz]ed|unauthori[sz]ed|access denied|permission denied|(?:do not|don't|no longer) have (?:the )?permissions?|not allowed to|insufficient (?:rights|privileges|permissions)|acc[eè]s (?:refus[ée]|interdit)|non autoris[ée]e?|droits? insuffisants?|vous n'avez pas (?:les droits|l'autorisation))\b/i;
const LOADING_TEXT = /\b(loading|chargement|please wait|veuillez patienter)\b/i;

/**
 * DIVERGENCE ANALYZER : le SYMPTÔME (« X introuvable ») n'est pas la CAUSE.
 *
 * Toutes les hypothèses sont évaluées au même endroit, chacune avec ses preuves et une
 * confiance 0..1 ; la catégorie retenue est la plus probable, les autres restent visibles.
 * La première divergence fonctionnelle peut précéder l'étape qui a échoué (étape d'avant
 * dont l'effet attendu n'a pas été observé). Aucune hypothèse faible n'est présentée comme
 * une certitude, et une cause qui interdit la récupération (droits, session, comportement
 * de l'application) le dit : on ne contourne ni une autorisation, ni une régression.
 */
export function analyzeDivergence(input: DivergenceInput): DivergenceAnalysis {
  const causes: RootCauseCandidate[] = [];
  const add = (category: DivergenceCategory, confidence: number, evidence: Evidence[]): void => {
    if (confidence <= 0) return;
    const existing = causes.find((cause) => cause.category === category);
    if (existing) {
      existing.confidence = Math.max(existing.confidence, round(confidence));
      existing.evidence.push(...evidence);
    } else causes.push({ category, confidence: round(confidence), evidence });
  };
  const { expected, screen } = input;
  const visible = screen.controls.filter((control) => control.visible);
  const sameName = screen.controls.filter((control) => labelSimilarity(control.name, expected.label) >= 0.99);
  const sameRole = (control: ScreenControl): boolean => !expected.role || control.role === expected.role;

  // Session, droits : la récupération est interdite (jamais de contournement d'une autorisation).
  const unauthorized = input.network.filter((exchange) => exchange.status === 401);
  const forbidden = input.network.filter((exchange) => exchange.status === 403);
  if (screen.loginFormVisible || unauthorized.length > 0)
    add('AUTH_STATE_CHANGED', screen.loginFormVisible && unauthorized.length > 0 ? 0.92 : 0.8, [
      ...(screen.loginFormVisible
        ? [{ source: 'RUNTIME' as const, detail: 'a sign-in form is displayed' }]
        : []),
      ...unauthorized.slice(0, 2).map((exchange) => ({
        source: 'NETWORK' as const,
        detail: `${exchange.request} answered 401`,
      })),
    ]);
  const permissionText = PERMISSION_TEXT.exec(screen.text)?.[0];
  if (forbidden.length > 0 || permissionText)
    add(
      'ROLE_PERMISSION_CHANGED',
      forbidden.length > 0 && permissionText ? 0.93 : forbidden.length > 0 ? 0.82 : 0.75,
      [
        ...forbidden.slice(0, 2).map((exchange) => ({
          source: 'NETWORK' as const,
          detail: `${exchange.request} answered 403`,
        })),
        ...(permissionText
          ? [{ source: 'RUNTIME' as const, detail: `the screen says "${permissionText}"` }]
          : []),
      ],
    );

  // L'action d'origine a été exécutée, et l'application a mal répondu : une régression possible.
  const serverErrors = input.network.filter((exchange) => (exchange.status ?? 0) >= 500);
  if (input.symptom === 'MUTATION_AMBIGUOUS')
    add('APPLICATION_BEHAVIOR_CHANGED', 0.9, [
      {
        source: 'RUNTIME',
        detail: 'the original action exists and was executed; its write had no clear answer',
      },
      ...serverErrors.slice(0, 2).map((exchange) => ({
        source: 'NETWORK' as const,
        detail: `${exchange.request} answered ${String(exchange.status)}`,
      })),
    ]);
  else if (serverErrors.length > 0 && (input.symptom === 'NO_EFFECT' || input.symptom === 'WRONG_EFFECT'))
    add('APPLICATION_BEHAVIOR_CHANGED', 0.85, [
      { source: 'RUNTIME', detail: 'the original action exists and was executed' },
      ...serverErrors.slice(0, 2).map((exchange) => ({
        source: 'NETWORK' as const,
        detail: `${exchange.request} answered ${String(exchange.status)}`,
      })),
    ]);

  // La cible est là, mais pas utilisable.
  const disabled = sameName.find((control) => control.disabled && sameRole(control));
  if (input.symptom === 'TARGET_DISABLED' || disabled) {
    add('TARGET_DISABLED', 0.9, [
      { source: 'RUNTIME', detail: `"${expected.label}" is displayed but disabled` },
    ]);
    add('PREREQUISITE_MISSING', 0.6, [
      { source: 'RUNTIME', detail: 'a disabled control usually waits for an earlier choice' },
    ]);
  }
  const hidden = sameName.find((control) => !control.visible && !control.disabled);
  if (hidden)
    add('TARGET_HIDDEN', 0.75, [{ source: 'RUNTIME', detail: `"${expected.label}" exists but is hidden` }]);
  if (screen.overlay && (input.symptom === 'TARGET_NOT_FOUND' || input.symptom === 'NO_EFFECT'))
    add('OVERLAY_BLOCKING', 0.6, [
      { source: 'RUNTIME', detail: `a layer covers the page ("${screen.overlay}")` },
    ]);

  // Le même contrôle, ailleurs ; un localisateur périmé.
  const exact = visible.find(
    (control) => sameRole(control) && labelSimilarity(control.name, expected.label) >= 0.99,
  );
  if (exact && input.symptom === 'TARGET_NOT_FOUND')
    add('TARGET_MOVED', 0.85, [
      { source: 'RUNTIME', detail: `"${exact.role}:${exact.name}" is on screen, the locator missed it` },
    ]);
  if (input.symptom === 'TARGET_MISMATCH')
    add('LOCATOR_STALE', 0.8, [
      { source: 'RUNTIME', detail: 'the recorded locator now designates another element' },
    ]);

  // Renommé (même rôle, autre nom) ; remplacé (autre rôle : bouton → onglet).
  if (input.symptom === 'TARGET_NOT_FOUND' || input.symptom === 'TARGET_MISMATCH') {
    for (const control of visible) {
      if (control.field || control.disabled) continue;
      const similarity = labelSimilarity(control.name, expected.label);
      if (similarity < 0.3 || similarity >= 0.99) continue;
      if (sameRole(control))
        add('TARGET_RENAMED', 0.35 + similarity * 0.5, [
          {
            source: 'RUNTIME',
            detail: `"${control.role}:${control.name}" is close to "${expected.label}" (${similarity})`,
          },
        ]);
      else
        add('TARGET_REPLACED', 0.3 + similarity * 0.5, [
          {
            source: 'RUNTIME',
            detail: `"${control.role}:${control.name}" (${control.role}, not ${expected.role ?? 'the same kind'}) is close to "${expected.label}" (${similarity})`,
          },
        ]);
    }
    if (visible.some((control) => control.role === 'tab' && control.selected === false))
      add('WRONG_TAB_SELECTED', 0.35, [
        { source: 'RUNTIME', detail: 'the screen has tabs that are not selected' },
      ]);
    if (visible.some((control) => control.expanded === false))
      add('PARENT_SECTION_CLOSED', 0.35, [
        { source: 'RUNTIME', detail: 'the screen has collapsed sections' },
      ]);
    if (!exact && sameName.length === 0)
      add('TARGET_NOT_RENDERED', 0.3, [
        { source: 'RUNTIME', detail: `no element named "${expected.label}"` },
      ]);
  }

  // L'étape d'avant n'a pas produit l'écran attendu : la vraie divergence est là.
  if (input.previous?.deferredEffect)
    add('WRONG_WORKFLOW_STATE', 0.55, [
      {
        source: 'CONTEXT',
        detail: `step ${String(input.previous.index)} "${input.previous.description}" did not produce its recorded effect`,
      },
    ]);
  if (input.symptom === 'WRONG_EFFECT')
    add('EXPECTED_EFFECT_CHANGED', 0.55, [
      { source: 'RUNTIME', detail: 'the screen changed, but not as during the recording' },
    ]);
  if (input.expectedRoute && input.expectedRoute !== screen.route)
    add('ROUTE_CHANGED', 0.45, [
      { source: 'RUNTIME', detail: `route ${screen.route}, recorded ${input.expectedRoute}` },
    ]);
  const pending = input.network.filter((exchange) => exchange.status === undefined);
  if (pending.length > 0 || LOADING_TEXT.test(screen.text))
    add(pending.length > 0 ? 'NETWORK_DEPENDENCY_NOT_READY' : 'ASYNC_DATA_NOT_READY', 0.45, [
      pending.length > 0
        ? { source: 'NETWORK', detail: `${String(pending.length)} request(s) without an answer yet` }
        : { source: 'RUNTIME', detail: 'the screen says it is loading' },
    ]);
  if (causes.length === 0)
    add('UNKNOWN_DIVERGENCE', 0.2, [{ source: 'RUNTIME', detail: 'no specific cause found' }]);

  causes.sort((a, b) => b.confidence - a.confidence || a.category.localeCompare(b.category));
  const [top] = causes;
  const blocking = new Set<DivergenceCategory>([
    'AUTH_STATE_CHANGED',
    'ROLE_PERMISSION_CHANGED',
    'APPLICATION_BEHAVIOR_CHANGED',
  ]);
  const recoverable = !causes.some((cause) => blocking.has(cause.category) && cause.confidence >= 0.7);
  const missingPrerequisites: WorkflowPrerequisite[] = causes.some(
    (cause) => cause.category === 'PREREQUISITE_MISSING',
  )
    ? [{ label: expected.label, kind: 'CONTROL', reason: 'disabled until an earlier choice is made' }]
    : [];
  const observedState: FunctionalState = {
    route: screen.route,
    controls: visible.slice(0, 30).map((control) => `${control.role}:${control.name}`),
    selectedTabs: visible
      .filter((control) => control.role === 'tab' && control.selected)
      .map((control) => control.name),
  };
  const expectedState: FunctionalState | undefined =
    input.effects?.appears || input.goal
      ? {
          route: input.effects?.route ?? screen.route,
          controls: [...(input.effects?.appears ?? []), ...(input.goal?.missing ?? [])].slice(0, 30),
        }
      : undefined;
  const deferred = input.previous?.deferredEffect === true;
  return {
    actionId: input.actionId,
    stepIndex: input.stepIndex,
    symptom: input.symptom,
    category: top?.category ?? 'UNKNOWN_DIVERGENCE',
    confidence: top?.confidence ?? 0.2,
    evidence: top?.evidence ?? [],
    ...(expectedState ? { expectedState } : {}),
    observedState,
    ...(missingPrerequisites.length > 0 ? { missingPrerequisites } : {}),
    possibleCauses: causes.slice(0, 5),
    rootStepIndex: deferred && input.previous ? input.previous.index : input.stepIndex,
    recoverable,
  };
}

/**
 * Après la récupération, la cause CONFIRMÉE par le runtime remplace l'hypothèse :
 * l'analyse garde ses autres hypothèses, avec leur confiance d'origine.
 */
export function confirmCause(
  analysis: DivergenceAnalysis,
  category: DivergenceCategory,
  evidence: Evidence[],
  confidence = 0.95,
): DivergenceAnalysis {
  return {
    ...analysis,
    category,
    confidence,
    evidence: [...evidence, ...analysis.evidence].slice(0, 8),
    possibleCauses: [
      { category, confidence, evidence },
      ...analysis.possibleCauses.filter((cause) => cause.category !== category),
    ].slice(0, 5),
  };
}
