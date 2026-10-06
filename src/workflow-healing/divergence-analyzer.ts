import type { StepEffects } from '../config/flow-schema.js';
import type {
  AuthContextDivergence,
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
import type { ExpectedTargetAnalysis } from './expected-target.js';
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
  /** Le symptôme technique tel que rapporté (« TARGET_FINGERPRINT_MISMATCH: … »). */
  technicalSymptom?: string;
  /** La cible attendue comprise : présente ? voisine ? absente — et pourquoi. */
  expectedTarget?: ExpectedTargetAnalysis;
  /** L'acteur (rôle) attendu du parcours, s'il est connu (flows[].actor). */
  expectedRole?: string;
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
  // Un 401 isolé, sans écran de connexion, pendant que d'AUTRES requêtes réussissent : un appel de fond
  // refusé (un service annexe), pas une session perdue — un indice faible qui ne bloque pas la reprise.
  const succeeded = input.network.filter(
    (exchange) => exchange.status !== undefined && exchange.status >= 200 && exchange.status < 400,
  );
  const backgroundOnly = !screen.loginFormVisible && unauthorized.length > 0 && succeeded.length > 0;
  if (screen.loginFormVisible || unauthorized.length > 0)
    add(
      'AUTH_STATE_CHANGED',
      screen.loginFormVisible && unauthorized.length > 0 ? 0.92 : backgroundOnly ? 0.35 : 0.8,
      [
        ...(backgroundOnly
          ? [
              {
                source: 'NETWORK' as const,
                detail: `${String(succeeded.length)} other request(s) succeeded and no sign-in form is displayed: the session is still valid (a background request was refused)`,
              },
            ]
          : []),
        ...(screen.loginFormVisible
          ? [{ source: 'RUNTIME' as const, detail: 'a sign-in form is displayed' }]
          : []),
        ...unauthorized.slice(0, 2).map((exchange) => ({
          source: 'NETWORK' as const,
          detail: `${exchange.request} answered 401`,
        })),
      ],
    );
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
  // HYPOTHESIS REBALANCING : un localisateur qui ne correspond plus n'est pas une cause.
  // LOCATOR_STALE n'est fort que si le contrôle fonctionnel semble présent ; une cible absente
  // est TARGET_NOT_RENDERED, et la question devient POURQUOI (section, précondition, état).
  const target = input.expectedTarget;
  if (target) {
    for (const cause of target.rootCauses) {
      const existing = causes.find((candidate) => candidate.category === cause.category);
      if (existing) {
        existing.confidence = cause.confidence;
        existing.evidence = [...cause.evidence, ...existing.evidence].slice(0, 4);
      } else causes.push({ ...cause, evidence: [...cause.evidence] });
    }
    if (target.functionalRecovery)
      for (const cause of causes)
        if (['LOCATOR_STALE', 'TARGET_RENAMED', 'TARGET_REPLACED', 'TARGET_MOVED'].includes(cause.category))
          cause.confidence = Math.min(cause.confidence, 0.2);
  }
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
  const missingPrerequisites: WorkflowPrerequisite[] = target?.missingPreconditions.length
    ? target.missingPreconditions.map((condition) => ({
        label: condition,
        kind: 'STEP' as const,
        reason: `${target.target.label} is not rendered until ${condition}`,
      }))
    : causes.some((cause) => cause.category === 'PREREQUISITE_MISSING')
      ? [{ label: expected.label, kind: 'CONTROL', reason: 'disabled until an earlier choice is made' }]
      : [];
  const FUNCTIONAL = new Set<DivergenceCategory>([
    'PARENT_SECTION_CLOSED',
    'PREREQUISITE_MISSING',
    'WRONG_WORKFLOW_STATE',
    'WRONG_TAB_SELECTED',
    'BUSINESS_RULE_CHANGED',
  ]);
  const functionalRootCause = causes.find(
    (cause) => FUNCTIONAL.has(cause.category) && cause.confidence >= 0.5,
  );
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
  // AUTH_CONTEXT_DIVERGENCE : une cause d'autorisation qui bloque est décrite, jamais contournée.
  const auth = causes.find(
    (cause) =>
      (cause.category === 'AUTH_STATE_CHANGED' || cause.category === 'ROLE_PERMISSION_CHANGED') &&
      cause.confidence >= 0.7,
  );
  const authContext: AuthContextDivergence | undefined = auth
    ? {
        type: 'AUTH_CONTEXT_DIVERGENCE',
        cause: auth.category as AuthContextDivergence['cause'],
        ...(input.expectedRole ? { expectedRole: input.expectedRole } : {}),
        ...(screen.loginFormVisible ? { observedRole: 'signed out (sign-in form displayed)' } : {}),
        expectedCapabilities: [`${expected.kind} ${expected.label}`],
        observedCapabilities: [
          ...unauthorized.map((exchange) => `${exchange.request} → 401`),
          ...forbidden.map((exchange) => `${exchange.request} → 403`),
          ...(permissionText ? [`screen: "${permissionText}"`] : []),
        ].slice(0, 6),
        evidence: auth.evidence.map((entry) => entry.detail),
      }
    : undefined;
  return {
    ...(authContext ? { authContext } : {}),
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
    ...(input.technicalSymptom ? { technicalSymptom: input.technicalSymptom } : {}),
    ...(target ? { expectedTarget: target } : {}),
    ...(functionalRootCause ? { functionalRootCause } : {}),
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
