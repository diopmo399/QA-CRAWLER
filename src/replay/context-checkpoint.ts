import type { FlowStep } from '../config/flow-schema.js';
import type { ObservedFunctionalState, StepPrecondition } from './model.js';

/**
 * RESTAURATION DU CONTEXTE — le modèle de CHECKPOINT DE CONTEXTE et la DÉCISION de reprise.
 *
 * Quand une étape du rejeu échoue et que l'humain la corrige, reprendre « à la même URL » ne suffit
 * pas : une application monopage garde son état en mémoire, un critère de recherche vit dans une
 * requête, une entité créée pendant le run porte un identifiant que le prochain run n'aura pas.
 * Avant chaque étape, le rejeu capture donc un checkpoint de contexte (URL complète, route, cadres,
 * onglet actif, dialogue, champs et critères, position de défilement, état fonctionnel observé,
 * données produites par le run, préconditions de l'étape), et à la reprise il DÉCIDE :
 *
 *   REVALIDATE   la page tenue est encore dans l'état du checkpoint : vérifier les préconditions,
 *                puis rejouer l'étape corrigée ;
 *   RESTORE      la page est là, seuls des états sérialisables ont changé (des champs perdus dont la
 *                valeur est connue) : les étapes qui les posent sont rejouées, puis REVALIDATE ;
 *   REBUILD      la page est perdue ou l'état ne correspond plus (route, dialogue, cadre, onglet) :
 *                les étapes 1 à N-1 sont rejouées par le moteur, avec les MÊMES données du run ;
 *   MANUAL       la reprise ne peut pas être fiable sans l'humain : session expirée, étape à effet
 *                métier déjà exécutée qu'il faudrait répéter, précondition dure non satisfaite.
 *
 * Tout ici est pur (testable sans navigateur). Rien de JavaScript n'est « restauré » de force : un
 * état en mémoire se reconstruit par le rejeu des étapes, jamais par l'écriture d'un objet.
 */

export const CONTEXT_CHECKPOINT_SCHEMA = 1;

export interface ContextLocation {
  href: string;
  path: string;
  query: Record<string, string>;
  fragment: string;
  /** La route applicative (le chemin, sans origine ni paramètres). */
  route: string;
  title: string;
}

export interface ContextField {
  /** Le libellé (ou le nom) du champ. */
  key: string;
  kind: 'text' | 'checkbox' | 'radio' | 'select' | 'other';
  filled: boolean;
  checked?: boolean;
  /** Mot de passe, secret, jeton, carte… : jamais de valeur. */
  sensitive: boolean;
  /** La valeur (non sensible, courte) : une donnée de test, restaurable. */
  value?: string;
}

/** Ce que la page donne à un instant (Playwright) : sérialisable, jamais une valeur sensible. */
export interface ContextSnapshot {
  capturedAt: string;
  location: ContextLocation;
  /** Les cadres (iframes, micro-frontends) : leurs routes. */
  frames: string[];
  /** Les onglets sélectionnés (role=tab, aria-selected). */
  activeTabs: string[];
  dialog?: string;
  overlay?: string;
  scroll: { x: number; y: number };
  fields: ContextField[];
  /** Les lignes sélectionnées (aria-selected) : leur première cellule. */
  selectedRows: string[];
  historyLength?: number;
  /** L'état fonctionnel observé par l'explorateur (contrôles, requêtes…), quand il est disponible. */
  functional?: ObservedFunctionalState;
}

export interface ContextCheckpoint {
  schema: typeof CONTEXT_CHECKPOINT_SCHEMA;
  scenario: string;
  runId: string;
  /** L'étape (1..n) AVANT laquelle le checkpoint a été pris. */
  stepIndex: number;
  capturedAt: string;
  snapshot: ContextSnapshot;
  /** Les données produites par le run jusqu'ici (clé → valeur) : en mémoire ; sur disque, des empreintes. */
  runData: { key: string; value: string }[];
  confirmedCheckpoints: string[];
  /** Les étapes (1..n) à effet métier déjà exécutées pendant ce run : jamais répétées sans décision. */
  executedMutations: number[];
  preconditions: StepPrecondition[];
}

export type RecoveryStrategy = 'RESTORE' | 'REBUILD' | 'REVALIDATE' | 'MANUAL_RECOVERY';

export interface ContextDifference {
  kind:
    | 'PAGE_CLOSED'
    | 'SESSION_EXPIRED'
    | 'ROUTE'
    | 'QUERY'
    | 'FRAME'
    | 'TAB'
    | 'DIALOG'
    | 'OVERLAY'
    | 'FIELD_LOST'
    | 'FIELD_CHANGED'
    | 'ROW'
    | 'STALE';
  detail: string;
  severity: 'HARD' | 'SOFT';
}

export interface RecoveryDecision {
  strategy: RecoveryStrategy;
  differences: ContextDifference[];
  reasons: string[];
  /** REBUILD : rejouer depuis cette étape (1) jusqu'à l'étape visée exclue. */
  rebuildFrom?: number;
  /** RESTORE : les étapes à rejouer pour reposer les champs perdus. */
  restoreSteps?: number[];
  /** MANUAL : ce qui empêche une reprise automatique. */
  blockedBy?: { step?: number; reason: string }[];
}

const LOGIN_ROUTE = /(^|\/)(login|log-in|signin|sign-in|auth|connexion|authentification|sso|oauth)(\/|$)/i;

const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Les différences entre le checkpoint et la page vivante (aucune : la page est dans l'état attendu). */
export function compareContext(
  expected: ContextSnapshot,
  live: ContextSnapshot | undefined,
  options: { loginRoutes?: readonly string[] } = {},
): ContextDifference[] {
  if (!live) return [{ kind: 'PAGE_CLOSED', detail: 'the page is closed', severity: 'HARD' }];
  const differences: ContextDifference[] = [];
  const liveRoute = live.location.route;
  const login =
    [...(options.loginRoutes ?? [])].some((route) => same(route, liveRoute)) || LOGIN_ROUTE.test(liveRoute);
  if (login && !LOGIN_ROUTE.test(expected.location.route))
    differences.push({
      kind: 'SESSION_EXPIRED',
      detail: `the page is on ${liveRoute}: the session has expired or the user is signed out`,
      severity: 'HARD',
    });
  if (!same(expected.location.route, liveRoute))
    differences.push({
      kind: 'ROUTE',
      detail: `route ${expected.location.route} expected, ${liveRoute} found`,
      severity: 'HARD',
    });
  for (const [key, value] of Object.entries(expected.location.query))
    if (live.location.query[key] !== value)
      differences.push({
        kind: 'QUERY',
        detail: `query parameter ${key} differs`,
        severity: 'SOFT',
      });
  const frames = new Set(live.frames);
  for (const frame of expected.frames)
    if (!frames.has(frame))
      differences.push({ kind: 'FRAME', detail: `frame ${frame} is not loaded`, severity: 'HARD' });
  for (const tab of expected.activeTabs)
    if (!live.activeTabs.some((candidate) => same(candidate, tab)))
      differences.push({ kind: 'TAB', detail: `tab "${tab}" is not selected`, severity: 'HARD' });
  if ((expected.dialog ?? '') !== (live.dialog ?? ''))
    differences.push({
      kind: 'DIALOG',
      detail: expected.dialog
        ? `dialog "${expected.dialog}" is not open`
        : `an unexpected dialog is open ("${live.dialog ?? ''}")`,
      severity: 'HARD',
    });
  if (live.overlay && !expected.overlay)
    differences.push({
      kind: 'OVERLAY',
      detail: `an overlay blocks the page (${live.overlay})`,
      severity: 'SOFT',
    });
  const liveFields = new Map(live.fields.map((field) => [field.key.toLowerCase(), field]));
  for (const field of expected.fields) {
    const current = liveFields.get(field.key.toLowerCase());
    if (!current) continue;
    if (field.filled && !current.filled)
      differences.push({
        kind: 'FIELD_LOST',
        detail: `field "${field.key}" is empty again`,
        severity: 'SOFT',
      });
    else if (
      field.filled &&
      current.filled &&
      !field.sensitive &&
      field.value !== undefined &&
      current.value !== undefined &&
      !same(field.value, current.value)
    )
      differences.push({
        kind: 'FIELD_CHANGED',
        detail: `field "${field.key}" holds another value`,
        severity: 'SOFT',
      });
    else if (
      field.checked !== undefined &&
      current.checked !== undefined &&
      field.checked !== current.checked
    )
      differences.push({
        kind: 'FIELD_CHANGED',
        detail: `"${field.key}" is ${current.checked ? 'checked' : 'unchecked'}`,
        severity: 'SOFT',
      });
  }
  for (const row of expected.selectedRows)
    if (!live.selectedRows.some((candidate) => same(candidate, row)))
      differences.push({ kind: 'ROW', detail: `row "${row}" is no longer selected`, severity: 'SOFT' });
  return differences;
}

/** Les étapes (1..n) à EFFET MÉTIER : une requête d'écriture enregistrée ou une permission MUTATION / DANGEROUS. */
export function mutationSteps(steps: readonly FlowStep[]): number[] {
  const indexes: number[] = [];
  steps.forEach((step, position) => {
    const request = step.effects?.request ?? '';
    const writes = /^(POST|PUT|PATCH|DELETE)\b/i.test(request);
    // Une étape sans permission déclarée (un goto lu d'un ancien flow) n'en a aucune.
    const allowed = ((step.allow as FlowStep['allow'] | undefined) ?? []).some(
      (allowance) => allowance === 'MUTATION' || allowance === 'DANGEROUS',
    );
    if (writes || allowed) indexes.push(position + 1);
  });
  return indexes;
}

export interface RecoveryInput {
  checkpoint: ContextCheckpoint;
  /** La page tenue, observée maintenant ; absente : la page est fermée ou perdue. */
  live: ContextSnapshot | undefined;
  /** L'étape visée (1..n) : la reprise se fait sur elle. */
  stepIndex: number;
  /** Les étapes à effet métier du flow (mutationSteps). */
  mutations: readonly number[];
  /** La politique : répéter une étape à effet métier déjà exécutée pendant la reconstruction ? */
  repeatMutations: boolean;
  now: Date;
  /** Au-delà, le checkpoint est périmé : la page est revérifiée, jamais prise pour acquise. */
  maxAgeMs: number;
  loginRoutes?: readonly string[];
  /** Les étapes (1..n) qui remplissent chaque champ (clé → étape) : pour RESTORE. */
  fieldSteps?: ReadonlyMap<string, number>;
}

/** LA DÉCISION : quelle stratégie reprend le rejeu à l'étape visée, et pourquoi. */
export function decideRecovery(input: RecoveryInput): RecoveryDecision {
  const { checkpoint, stepIndex } = input;
  const differences = compareContext(checkpoint.snapshot, input.live, { loginRoutes: input.loginRoutes });
  const age = input.now.getTime() - new Date(checkpoint.capturedAt).getTime();
  const stale = age > input.maxAgeMs;
  if (stale)
    differences.push({
      kind: 'STALE',
      detail: `the checkpoint is ${String(Math.round(age / 60_000))} min old`,
      severity: 'SOFT',
    });
  const reasons: string[] = [];
  const expired = differences.find((difference) => difference.kind === 'SESSION_EXPIRED');
  if (expired)
    return {
      strategy: 'MANUAL_RECOVERY',
      differences,
      reasons: [expired.detail, 'an expired session is never restored automatically'],
      blockedBy: [{ reason: 'sign in again, then resume' }],
    };
  // Les étapes à effet métier déjà exécutées avant l'étape visée : une reconstruction les répéterait.
  const executed = input.mutations.filter(
    (index) => index < stepIndex && checkpoint.executedMutations.includes(index),
  );
  const rebuild = (): RecoveryDecision => {
    if (executed.length > 0 && !input.repeatMutations)
      return {
        strategy: 'MANUAL_RECOVERY',
        differences,
        reasons: [
          ...reasons,
          `rebuilding would repeat ${String(executed.length)} step(s) with a business effect already done in this run`,
        ],
        blockedBy: executed.map((step) => ({
          step,
          reason: 'already executed in this run (creation or change): not repeated without a decision',
        })),
      };
    return {
      strategy: 'REBUILD',
      differences,
      reasons: [...reasons, `steps 1 to ${String(stepIndex - 1)} are replayed with the same run data`],
      rebuildFrom: 1,
    };
  };
  const hard = differences.filter((difference) => difference.severity === 'HARD');
  if (hard.length > 0) {
    reasons.push(...hard.map((difference) => difference.detail));
    return rebuild();
  }
  const lost = differences.filter(
    (difference) => difference.kind === 'FIELD_LOST' || difference.kind === 'FIELD_CHANGED',
  );
  if (lost.length > 0) {
    const steps = new Set<number>();
    const unknown: string[] = [];
    for (const difference of lost) {
      const key = /"([^"]+)"/.exec(difference.detail)?.[1] ?? '';
      const step = input.fieldSteps?.get(key.toLowerCase());
      const field = checkpoint.snapshot.fields.find((entry) => same(entry.key, key));
      // Restaurable : un champ non sensible dont la valeur est connue (un texte, ou l'état coché d'une case).
      const known =
        field !== undefined && !field.sensitive && (field.value !== undefined || field.checked !== undefined);
      if (step !== undefined && known) steps.add(step);
      else unknown.push(key);
    }
    if (unknown.length > 0) {
      reasons.push(
        `field(s) ${unknown.map((key) => `"${key}"`).join(', ')} cannot be restored from known data`,
      );
      return rebuild();
    }
    return {
      strategy: 'RESTORE',
      differences,
      reasons: [...lost.map((difference) => difference.detail), 'the steps that fill them are replayed'],
      restoreSteps: [...steps].sort((a, b) => a - b),
    };
  }
  return {
    strategy: 'REVALIDATE',
    differences,
    reasons: [
      stale
        ? 'the checkpoint is old: the page is verified again'
        : 'the page is still in the checkpoint state',
      'the preconditions of the step are checked before resuming',
    ],
  };
}

/** Les étapes qui remplissent un champ (libellé → étape 1..n), lues dans le flow. */
export function fieldStepsOf(steps: readonly FlowStep[]): Map<string, number> {
  const map = new Map<string, number>();
  steps.forEach((step, position) => {
    if (step.kind !== 'fill' && step.kind !== 'select' && step.kind !== 'check' && step.kind !== 'uncheck')
      return;
    const target = step.target;
    const key = (target.strategy === 'role' ? target.name : target.value) ?? '';
    if (key) map.set(key.toLowerCase(), position + 1);
  });
  return map;
}

/** Le checkpoint tel qu'il peut être ÉCRIT : les valeurs des données du run et des champs deviennent des empreintes. */
export function redactedCheckpoint(
  checkpoint: ContextCheckpoint,
  digest: (value: string) => string,
): unknown {
  return {
    ...checkpoint,
    runData: checkpoint.runData.map((entry) => ({ key: entry.key, digest: digest(entry.value) })),
    snapshot: {
      ...checkpoint.snapshot,
      fields: checkpoint.snapshot.fields.map(({ value, ...field }) => ({
        ...field,
        ...(value !== undefined ? { digest: digest(value) } : {}),
      })),
    },
  };
}
