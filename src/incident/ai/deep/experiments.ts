import path from 'node:path';
import type {
  AiContradiction,
  AiExperimentProposal,
  EnvironmentCapabilities,
  ExperimentKind,
  GeneratedExperiment,
  Hypothesis,
  HypothesisExploration,
  Incident,
  InvestigationMemory,
  InvestigationStrategy,
  PolicyDecision,
  PolicyOperation,
  ProposedVerification,
  ReproductionRun,
  RiskLevel,
  ScopeApplication,
} from '../../../sdk/core/incident-contracts.js';
import type { ScopePolicy } from '../../scope-policy.js';
import { findIdenticalExperiment } from './memory.js';

/**
 * LE GÉNÉRATEUR D'EXPÉRIENCES DE L'INVESTIGATION APPROFONDIE : des vérifications déclarées entièrement AVANT
 * qu'une politique ne les laisse passer — nature, paramètres, opérations exactes (`PolicyOperation[]`), coût,
 * risque, ce qui confirmerait et ce qui réfuterait.
 *
 * Familles : A charge utile vs contrat (COMPARE_REQUESTS, CHECK_VALIDATION) ; B comparaison des réponses
 * (COMPARE_RESPONSES) ; C rejeu différentiel (COMPARE_WITH_PASSING, sans effet de bord, seulement quand un
 * scénario qui réussit est connu) ; D rejeu de référence (REPLAY) ; E test unitaire ciblé (UNIT_TEST) ;
 * F journaux (INSPECT_LOGS) ; G test d'intégration (INTEGRATION_TEST : toujours avec effets de bord, donc jamais
 * exécutable sans approbation) ; H (git) passe par l'outil `git_changes`, pas par une expérience.
 *
 * Règles : chaque opération est évaluée par `ScopePolicy.check` ; un refus, un effet de bord, une nature inconnue
 * de l'environnement rendent l'expérience « à approuver » (`permissions` non vide), jamais exécutable d'office.
 * Rien de destructif n'est généré. Une expérience identique (nature + paramètres + hypothèse) à une autre déjà en
 * mémoire n'est pas regénérée sans justification. Les durées et coûts ne sont jamais inventés : `estimatedCost`
 * compte des unités de budget (1 par expérience, 2 pour un rejeu ou un test), rien d'autre.
 */
export interface ExperimentGenerationContext {
  incident: Incident;
  policy: ScopePolicy;
  explorations: readonly HypothesisExploration[];
  strategies: readonly InvestigationStrategy[];
  contradictions: readonly AiContradiction[];
  /** La stratégie qu'on met en œuvre ; absente : toutes les stratégies disponibles portant une expérience. */
  strategy?: InvestigationStrategy;
  /** Les propositions des agents (plan de vérification) : converties quand elles visent la nature voulue. */
  proposals?: readonly AiExperimentProposal[];
  capabilities?: EnvironmentCapabilities;
  memory?: InvestigationMemory;
  /** Justifications d'une répétition (clé : id d'hypothèse) ; sans elle, une expérience identique est écartée. */
  justify?: Readonly<Record<string, string>>;
  now: string;
  /** Expériences au plus par stratégie (défaut 3). */
  maxPerStrategy?: number;
}

export interface ExperimentGeneration {
  experiments: GeneratedExperiment[];
  /** Ce qui n'a pas été généré, et pourquoi (pour les limites du run). */
  skipped: string[];
  /** Les décisions de politique par expérience (pour la trace ; jamais rendues au modèle). */
  decisions: Record<string, PolicyDecision[]>;
}

export const GENERATED_EXPERIMENT_PREFIX = 'gen-';
const DEFAULT_MAX_PER_STRATEGY = 3;
const DYNAMIC: ReadonlySet<ExperimentKind> = new Set([
  'REPLAY',
  'COMPARE_WITH_PASSING',
  'UNIT_TEST',
  'INTEGRATION_TEST',
]);
const RISK: Readonly<Record<ExperimentKind, RiskLevel>> = {
  REPLAY: 'LOW',
  COMPARE_REQUESTS: 'LOW',
  COMPARE_RESPONSES: 'LOW',
  COMPARE_WITH_PASSING: 'LOW',
  CHECK_VALIDATION: 'LOW',
  INSPECT_LOGS: 'LOW',
  UNIT_TEST: 'MEDIUM',
  INTEGRATION_TEST: 'HIGH',
};
const LIVE_HYPOTHESIS = new Set<Hypothesis['status']>(['PROPOSED', 'INVESTIGATING', 'SUPPORTED']);
const PRODUCTION_LIKE = /prod|preprod|pre-prod|staging|recette|uat|live/i;

export function nextGeneratedNumber(existing: Iterable<{ id: string }>): number {
  let max = 0;
  for (const { id } of existing) {
    if (!id.startsWith(GENERATED_EXPERIMENT_PREFIX)) continue;
    const n = Number(id.slice(GENERATED_EXPERIMENT_PREFIX.length));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return max + 1;
}

/** Les hypothèses encore ouvertes qu'une stratégie vise (les siennes, sinon toutes celles qui ne sont ni réfutées ni confirmées). */
export function targetHypotheses(
  incident: Incident,
  strategy: InvestigationStrategy | undefined,
  explorations: readonly HypothesisExploration[],
): Hypothesis[] {
  const all = incident.investigation.hypotheses;
  const wanted = strategy && strategy.hypothesisIds.length > 0 ? new Set(strategy.hypothesisIds) : undefined;
  const refuted = new Set(
    explorations.filter((item) => item.role === 'REFUTED').map((item) => item.hypothesisId),
  );
  return all.filter(
    (hypothesis) =>
      (wanted ? wanted.has(hypothesis.id) : LIVE_HYPOTHESIS.has(hypothesis.status)) &&
      !refuted.has(hypothesis.id),
  );
}

function latestReproduction(incident: Incident): ReproductionRun | undefined {
  const all = incident.investigation.reproductions;
  const own = all.filter((run) => run.scenario === incident.scenario);
  return (own.length > 0 ? own : all).at(-1);
}

function failingEndpoint(incident: Incident): string | undefined {
  const run = latestReproduction(incident);
  const failing = run?.requests.find(
    (request) => (request.status !== undefined && request.status >= 400) || request.failure !== undefined,
  );
  return failing ? `${failing.method} ${failing.path}` : undefined;
}

/** Un scénario qui réussit (rejeu non reproduit d'un autre scénario), pour le rejeu différentiel. */
function passingScenario(incident: Incident): string | undefined {
  const other = incident.investigation.reproductions.find(
    (run) => run.reproduced === false && run.scenario !== incident.scenario,
  );
  return other?.scenario;
}

function applicationFor(incident: Incident, hypothesis: Hypothesis): ScopeApplication | undefined {
  const apps = incident.scope.applications;
  const byFile = apps.find((app) =>
    hypothesis.files.some((file) => path.isAbsolute(file) && file.startsWith(app.repository.root)),
  );
  if (byFile) return byFile;
  const byLayer = apps.filter((app) => app.layer === hypothesis.layer);
  return byLayer.length === 1 ? byLayer[0] : apps.length === 1 ? apps[0] : undefined;
}

function relativeFile(app: ScopeApplication, file: string): string {
  return path.isAbsolute(file) ? path.relative(app.repository.root, file) : file;
}

/** Les paramètres par défaut d'une nature pour une hypothèse, quand elle n'en propose pas elle-même. */
export function defaultVerification(
  kind: ExperimentKind,
  hypothesis: Hypothesis,
  incident: Incident,
): ProposedVerification | undefined {
  const app = applicationFor(incident, hypothesis);
  switch (kind) {
    case 'COMPARE_REQUESTS':
    case 'COMPARE_RESPONSES': {
      const endpoint = failingEndpoint(incident);
      if (!endpoint) return undefined;
      if (incident.investigation.reproductions.length < 2) return undefined;
      return {
        kind,
        description: `${kind === 'COMPARE_REQUESTS' ? 'Comparer les requêtes' : 'Comparer les réponses'} des reproductions sur ${endpoint}`,
        params: { endpoint },
      };
    }
    case 'COMPARE_WITH_PASSING': {
      const scenario = passingScenario(incident);
      const endpoint = failingEndpoint(incident);
      if (!scenario) return undefined;
      return {
        kind,
        description: `Rejouer « ${scenario} » (qui réussit) et le comparer à la reproduction en échec`,
        params: { passingScenario: scenario, ...(endpoint ? { endpoint } : {}) },
      };
    }
    case 'REPLAY':
      if (!incident.scenario) return undefined;
      return {
        kind,
        description: `Rejouer « ${incident.scenario} » et vérifier que le symptôme se reproduit`,
        params: { scenario: incident.scenario },
      };
    case 'CHECK_VALIDATION': {
      const file = hypothesis.files[0];
      if (!app || !file) return undefined;
      const field = fieldOf(hypothesis);
      if (!field) return undefined;
      return {
        kind,
        description: `Vérifier la validation de « ${field} » dans ${relativeFile(app, file)}`,
        params: { applicationId: app.id, file: relativeFile(app, file), field },
      };
    }
    case 'INSPECT_LOGS': {
      if (!app) return undefined;
      if (!app.openshift && !(app.logFiles && app.logFiles.length > 0)) return undefined;
      return {
        kind,
        description: `Chercher la trace de l'erreur dans les journaux de ${app.name}`,
        params: { applicationId: app.id },
      };
    }
    case 'UNIT_TEST':
    case 'INTEGRATION_TEST':
      // Aucun test n'est deviné : seule une proposition explicite (hypothèse, agent) nomme le test à lancer.
      return undefined;
  }
}

/** Le champ qu'une hypothèse met en cause, lu dans ses vérifications ou dans son titre (« champ x », « field x »). */
export function fieldOf(hypothesis: Hypothesis): string | undefined {
  for (const verification of hypothesis.verifications) {
    const field = verification.params.field;
    if (typeof field === 'string' && field.trim()) return field.trim();
  }
  const match = /(?:champ|field|propri[ée]t[ée]|attribut)\s+[«"'`]?\s*([A-Za-z_][\w.]*)/i.exec(
    `${hypothesis.title} ${hypothesis.description}`,
  );
  return match?.[1];
}

/** Les opérations exactes d'une vérification, telles que le moteur les déclare avant toute exécution. */
export function operationsOf(
  kind: ExperimentKind,
  params: ProposedVerification['params'],
  incident: Incident,
): PolicyOperation[] {
  const str = (key: string): string | undefined => {
    const value = params[key];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  };
  const app = (): ScopeApplication | undefined => {
    const id = str('applicationId');
    const apps = incident.scope.applications;
    return id ? apps.find((entry) => entry.id === id) : apps.length === 1 ? apps[0] : undefined;
  };
  switch (kind) {
    case 'REPLAY':
    case 'COMPARE_WITH_PASSING': {
      const baseUrl = str('baseUrl') ?? latestReproduction(incident)?.baseUrl;
      return baseUrl ? [{ kind: 'NAVIGATE', url: baseUrl }] : [];
    }
    case 'COMPARE_REQUESTS':
    case 'COMPARE_RESPONSES':
      return [];
    case 'UNIT_TEST':
    case 'INTEGRATION_TEST': {
      const target = app();
      if (!target) return [];
      const command = str('command') ?? (target.layer === 'FRONTEND' ? 'npm' : 'mvn');
      const test = str('test');
      const args =
        command === 'mvn' || command === 'mvnw' || command === './mvnw'
          ? ['-B', 'test', ...(test ? [`-Dtest=${test}`] : [])]
          : command.includes('gradle')
            ? ['test', ...(test ? ['--tests', test] : [])]
            : ['test', ...(test ? ['--', test] : [])];
      return [
        {
          kind: 'RUN_TEST',
          level: kind === 'INTEGRATION_TEST' ? 'INTEGRATION' : 'UNIT',
          command,
          args,
          cwd: target.repository.root,
        },
      ];
    }
    case 'INSPECT_LOGS': {
      const target = app();
      const file = str('path');
      if (file && target)
        return [
          { kind: 'READ_LOG', path: path.isAbsolute(file) ? file : path.join(target.repository.root, file) },
        ];
      if (target?.openshift)
        return [{ kind: 'OPENSHIFT', verb: 'logs', resource: 'pods', namespace: target.openshift.namespace }];
      return (target?.logFiles ?? []).map((entry): PolicyOperation => ({
        kind: 'READ_LOG',
        path: path.isAbsolute(entry) ? entry : path.join(target?.repository.root ?? '', entry),
      }));
    }
    case 'CHECK_VALIDATION': {
      const target = app();
      const file = str('file');
      if (!target || !file || file.split(/[\\/]/).includes('..')) return [];
      return [
        {
          kind: 'READ_FILE',
          path: path.isAbsolute(file) ? file : path.join(target.repository.root, file),
          applicationId: target.id,
        },
      ];
    }
  }
}

/** Un rejeu différentiel n'est permis que sur un environnement qui le permet : nature connue, hors production. */
function environmentRefusal(kind: ExperimentKind, ctx: ExperimentGenerationContext): string | undefined {
  if (!DYNAMIC.has(kind)) return undefined;
  const run = latestReproduction(ctx.incident);
  const name = `${ctx.incident.environmentId ?? ''} ${run?.baseUrl ?? ''}`;
  if (PRODUCTION_LIKE.test(name))
    return 'environnement de production ou assimilé : approbation d’une personne exigée';
  if (kind === 'INTEGRATION_TEST') return 'test d’intégration : effets de bord possibles, approbation exigée';
  return undefined;
}

export async function generateExperiments(ctx: ExperimentGenerationContext): Promise<ExperimentGeneration> {
  const skipped: string[] = [];
  const decisions: Record<string, PolicyDecision[]> = {};
  const experiments: GeneratedExperiment[] = [];
  const known: { id: string }[] = [...(ctx.memory?.experiments ?? []), ...(ctx.proposals ?? [])];
  let next = nextGeneratedNumber(known);
  const seen = new Set<string>();
  const maxPerStrategy = Math.max(1, ctx.maxPerStrategy ?? DEFAULT_MAX_PER_STRATEGY);

  const strategies = ctx.strategy
    ? [ctx.strategy]
    : ctx.strategies.filter(
        (strategy) => strategy.status === 'AVAILABLE' && strategy.via.experimentKind !== undefined,
      );
  for (const strategy of strategies) {
    const kind = strategy.via.experimentKind;
    if (!kind) {
      skipped.push(`${strategy.id} : aucune expérience à générer (stratégie menée par un agent)`);
      continue;
    }
    let generated = 0;
    for (const hypothesis of targetHypotheses(ctx.incident, strategy, ctx.explorations)) {
      if (generated >= maxPerStrategy) break;
      const verification = verificationFor(kind, hypothesis, ctx);
      if (!verification) {
        skipped.push(
          `${strategy.id} / ${hypothesis.id} : paramètres de ${kind} indéterminés, rien n’est deviné`,
        );
        continue;
      }
      const key = JSON.stringify([kind, hypothesis.id, verification.params]);
      if (seen.has(key)) continue;
      seen.add(key);
      const identical = ctx.memory
        ? findIdenticalExperiment(ctx.memory, kind, verification.params, hypothesis.id)
        : undefined;
      const justification = ctx.justify?.[hypothesis.id];
      if (identical && !justification) {
        skipped.push(
          `${strategy.id} / ${hypothesis.id} : expérience identique déjà menée (${identical.id}), non répétée sans justification`,
        );
        continue;
      }
      const operations = operationsOf(kind, verification.params, ctx.incident);
      const checked: PolicyDecision[] = [];
      for (const operation of operations) checked.push(await ctx.policy.check(operation));
      const refusals = checked.filter((decision) => !decision.allowed);
      const sideEffects = kind === 'INTEGRATION_TEST' || verification.params.sideEffects === true;
      const environment = environmentRefusal(kind, ctx);
      const permissions = [
        ...refusals.map((decision) => `${decision.rule} : ${decision.reason}`),
        ...(sideEffects ? ['effets de bord : approbation explicite (RUN_WRITES)'] : []),
        ...(environment ? [environment] : []),
      ];
      const id = `${GENERATED_EXPERIMENT_PREFIX}${String(next)}`;
      next += 1;
      decisions[id] = checked;
      const contradiction = ctx.contradictions.find(
        (item) => item.hypothesisId === hypothesis.id && item.status === 'OPEN',
      );
      experiments.push({
        id,
        hypothesisId: hypothesis.id,
        kind,
        objective: `${strategy.name} — ${hypothesis.title}`,
        verification,
        resources: resourcesOf(operations),
        permissions,
        risks: [
          ...(RISK[kind] !== 'LOW' ? [`risque ${RISK[kind]}`] : []),
          ...(sideEffects ? ['peut modifier des données'] : []),
        ],
        sideEffects,
        expected: expectedOf(kind, hypothesis),
        confirmIf: confirmOf(kind, hypothesis),
        refuteIf: refuteOf(kind, hypothesis),
        status: 'PROPOSED',
        strategyId: strategy.id,
        requiredEvidence: hypothesis.supporting
          .filter((item) => /^(ev|rep)_/.test(item.ref) || item.ref.includes(':req-'))
          .slice(0, 5)
          .map((item) => ({ kind: item.ref.includes(':req-') ? 'request' : 'evidence', id: item.ref })),
        prerequisites: [
          ...(DYNAMIC.has(kind) && !ctx.capabilities ? ['capacités de l’environnement inconnues'] : []),
          ...(kind === 'UNIT_TEST' && ctx.capabilities && !ctx.capabilities.tests
            ? ['aucun outil de test disponible dans l’environnement']
            : []),
          ...(contradiction ? [`tranche la contradiction ${contradiction.id}`] : []),
        ],
        operations,
        estimatedCost: DYNAMIC.has(kind) ? 2 : 1,
        risk: RISK[kind],
        ...(kind === 'COMPARE_WITH_PASSING' && !sideEffects
          ? {
              differential: {
                withData: Object.fromEntries(
                  Object.entries(verification.params)
                    .filter(([, value]) => typeof value === 'string')
                    .map(([name, value]) => [name, String(value)]),
                ),
                withoutData: [],
              },
            }
          : {}),
      });
      generated += 1;
    }
    if (generated === 0 && !skipped.some((text) => text.startsWith(strategy.id)))
      skipped.push(`${strategy.id} : aucune hypothèse ouverte à vérifier`);
  }
  return { experiments, skipped, decisions };
}

/** Une expérience générée peut tourner sans personne : toutes ses opérations sont permises et rien n'exige une approbation. */
export function isRunnable(experiment: GeneratedExperiment): boolean {
  return experiment.status === 'PROPOSED' && experiment.permissions.length === 0 && !experiment.sideEffects;
}

function verificationFor(
  kind: ExperimentKind,
  hypothesis: Hypothesis,
  ctx: ExperimentGenerationContext,
): ProposedVerification | undefined {
  const own = hypothesis.verifications.find((item) => item.kind === kind);
  if (own) return { kind, description: own.description, params: { ...own.params } };
  const proposed = ctx.proposals?.find(
    (item) => item.hypothesisId === hypothesis.id && item.kind === kind && item.status === 'PROPOSED',
  );
  if (proposed) return { ...proposed.verification, params: { ...proposed.verification.params } };
  return defaultVerification(kind, hypothesis, ctx.incident);
}

function resourcesOf(operations: readonly PolicyOperation[]): string[] {
  return operations.map((operation) => {
    switch (operation.kind) {
      case 'READ_FILE':
      case 'LIST_DIR':
      case 'READ_LOG':
        return `${operation.kind} ${operation.path}`;
      case 'NAVIGATE':
        return `NAVIGATE ${operation.url}`;
      case 'HTTP':
        return `HTTP ${operation.method} ${operation.url}`;
      case 'RUN_TEST':
      case 'COMMAND':
        return `${operation.kind} ${operation.command} ${operation.args.join(' ')} (${operation.cwd})`;
      case 'OPENSHIFT':
        return `OPENSHIFT ${operation.verb} ${operation.resource} ${operation.namespace}`;
    }
  });
}

function expectedOf(kind: ExperimentKind, hypothesis: Hypothesis): string {
  switch (kind) {
    case 'REPLAY':
      return 'le symptôme se reproduit à l’identique';
    case 'COMPARE_REQUESTS':
      return `la requête en échec diffère de la requête qui réussit sur ce que l’hypothèse met en cause (${hypothesis.suspectedCause})`;
    case 'COMPARE_RESPONSES':
      return 'la réponse en échec porte l’erreur que l’hypothèse prédit';
    case 'COMPARE_WITH_PASSING':
      return 'le scénario qui réussit n’émet pas la différence suspectée';
    case 'CHECK_VALIDATION':
      return 'la validation du champ est absente ou incomplète dans la couche visée';
    case 'INSPECT_LOGS':
      return 'les journaux portent la trace de l’exception à l’heure de l’échec';
    case 'UNIT_TEST':
    case 'INTEGRATION_TEST':
      return 'le test échoue sur le comportement que l’hypothèse décrit';
  }
}

function confirmOf(kind: ExperimentKind, hypothesis: Hypothesis): string {
  return `${expectedOf(kind, hypothesis)} → soutient ${hypothesis.id}`;
}

function refuteOf(kind: ExperimentKind, hypothesis: Hypothesis): string {
  switch (kind) {
    case 'REPLAY':
      return `le symptôme ne se reproduit pas → ${hypothesis.id} n’est pas la cause stable`;
    case 'COMPARE_REQUESTS':
    case 'COMPARE_WITH_PASSING':
      return `aucune différence sur ce que l’hypothèse met en cause → réfute ${hypothesis.id}`;
    case 'COMPARE_RESPONSES':
      return `la réponse ne porte pas l’erreur prédite → réfute ${hypothesis.id}`;
    case 'CHECK_VALIDATION':
      return `la validation est présente → réfute ${hypothesis.id}`;
    case 'INSPECT_LOGS':
      return `aucune trace de l’exception → affaiblit ${hypothesis.id}`;
    case 'UNIT_TEST':
    case 'INTEGRATION_TEST':
      return `le test passe → réfute ${hypothesis.id}`;
  }
}
