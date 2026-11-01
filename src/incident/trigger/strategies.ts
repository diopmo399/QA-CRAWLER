import type {
  AngularModel,
  ExplorationStrategy,
  TriggerAction,
  TriggerDepth,
  TriggerTrial,
} from '../../sdk/core/incident-trigger-contracts.js';
import { SUBMIT_WORDS, type ActionCatalog, type Factor } from './model.js';

/**
 * LES STRATÉGIES D'EXPLORATION : chacune propose des essais (facteurs ordonnés puis sondes) avec une priorité
 * et un coût ; l'orchestrateur choisit, évite les doublons, suit la couverture et s'arrête selon le budget.
 * Jamais un produit cartésien complet : un facteur à la fois (guidée), les limites de données, les paires
 * (pairwise), les séquences avec état, les variations de temps ; les erreurs observées et le code Angular
 * orientent les essais suivants ; l'IA, quand elle existe, propose des essais validés comme les autres.
 */
export interface TrialPlan {
  strategy: ExplorationStrategy;
  factors: Factor[];
  /** Les sondes de l'essai (par défaut, celles du catalogue). */
  probes?: TriggerAction[];
  priority: number;
  note?: string;
}

export interface StrategyContext {
  depth: TriggerDepth;
  catalog: ActionCatalog;
  trials: readonly TriggerTrial[];
  angular?: AngularModel[];
  /** Les facteurs dont un essai a montré une erreur de page ou de console (ids). */
  errorFactors: ReadonlySet<string>;
  /** Les facteurs présents dans un essai qui a reproduit (ids). */
  reproducingFactors: ReadonlySet<string>;
  /** Les clés de séquences déjà jouées. */
  played: ReadonlySet<string>;
  /** Les essais déjà proposés par l'IA (séquences validées), à consommer. */
  aiProposals?: Factor[][];
}

const STRATEGIES_BY_DEPTH: Record<TriggerDepth, ExplorationStrategy[]> = {
  QUICK: ['GUIDED', 'CODE_GUIDED'],
  STANDARD: ['GUIDED', 'CODE_GUIDED', 'BOUNDARY', 'ERROR_GUIDED', 'PAIRWISE'],
  DEEP: [
    'GUIDED',
    'CODE_GUIDED',
    'BOUNDARY',
    'ERROR_GUIDED',
    'PAIRWISE',
    'STATEFUL_SEQUENCE',
    'MODEL_BASED',
    'AI_GUIDED',
    'DIFFERENTIAL',
  ],
};

export const strategiesFor = (depth: TriggerDepth): ExplorationStrategy[] => STRATEGIES_BY_DEPTH[depth];

const compatible = (factors: readonly Factor[]): boolean => {
  const targets = factors
    .map((factor) => factor.target)
    .filter((target): target is string => target !== undefined);
  return new Set(targets).size === targets.length;
};

const byPriority = (a: Factor, b: Factor): number => b.priority - a.priority || a.id.localeCompare(b.id);

/** Guidée : la référence perturbée par un seul facteur proche de la zone connue. */
function guided(ctx: StrategyContext): TrialPlan[] {
  return [...ctx.catalog.factors]
    .filter((factor) => factor.dimension !== 'DATA' || /vide|modifié/.test(factor.label))
    .sort(byPriority)
    .map((factor) => ({ strategy: 'GUIDED' as const, factors: [factor], priority: 100 + factor.priority }));
}

/** Limites : chaque valeur limite ou spéciale, seule. */
function boundary(ctx: StrategyContext): TrialPlan[] {
  return [...ctx.catalog.factors]
    .filter((factor) => factor.dimension === 'DATA' && !/vide|modifié|cocher|=/.test(factor.label))
    .sort(byPriority)
    .map((factor) => ({ strategy: 'BOUNDARY' as const, factors: [factor], priority: 60 + factor.priority }));
}

/** Le libellé d'un facteur ou d'un nœud, normalisé pour les rapprochements (minuscules, sans accents). */
const normalize = (text: string): string =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();

/**
 * Guidée par le code : ce que l'analyse Angular rend suspect passe devant.
 * 1. Un contrôle requis (Validators.required) : le vider est une limite que le code lui-même désigne.
 * 2. Un bouton dont le gestionnaire partage un service avec celui de la sonde : son état peut influencer la sonde.
 * Les deux se combinent en paires (les deux ordres) : le code désigne les facteurs, l'exécution tranche.
 */
function codeGuided(ctx: StrategyContext): TrialPlan[] {
  const plans: TrialPlan[] = [];
  const factors = ctx.catalog.factors;
  const probeNames = ctx.catalog.probes.map((probe) =>
    normalize((probe.target ?? '').replace(/^[a-z]+:/, '')),
  );
  const requiredFactors: Factor[] = [];
  const sharedFactors: Factor[] = [];
  for (const model of ctx.angular ?? []) {
    for (const node of model.nodes)
      if (node.kind === 'CONTROL' && node.detail?.required === true) {
        const control = normalize(node.name);
        for (const factor of factors)
          if (
            factor.dimension === 'DATA' &&
            /vide/.test(factor.label) &&
            normalize(factor.target ?? '').includes(control)
          )
            requiredFactors.push(factor);
      }
    // Les gestionnaires des sondes, puis les services qu'ils appellent, puis les autres boutons liés à ces services.
    const bindingText = (node: (typeof model.nodes)[number]): string =>
      normalize(`${node.name} ${String(node.detail?.text ?? '')}`);
    const probeIsSubmit = ctx.catalog.probes.some((probe) =>
      SUBMIT_WORDS.test((probe.target ?? '').replace(/^[a-z]+:/, '')),
    );
    const probeBindings = model.nodes.filter(
      (node) =>
        node.kind === 'BINDING' &&
        (probeNames.some((name) => name.length >= 3 && bindingText(node).includes(name)) ||
          (probeIsSubmit && /^(submit|ngSubmit)$/.test(String(node.detail?.event ?? '')))),
    );
    const handlerOf = (bindingId: string) =>
      model.links.filter((link) => link.kind === 'HANDLES' && link.from === bindingId).map((link) => link.to);
    const servicesOf = (handlerId: string) =>
      model.links
        .filter((link) => link.kind === 'CALLS' && link.from === handlerId)
        .map((link) => model.nodes.find((node) => node.id === link.to))
        .filter((node): node is (typeof model.nodes)[number] => node !== undefined)
        .map((node) => (node.kind === 'SERVICE' ? node.name : (node.name.split('.')[0] ?? node.name)));
    const probeServices = new Set(
      probeBindings.flatMap((binding) => handlerOf(binding.id).flatMap(servicesOf)),
    );
    if (probeServices.size === 0) continue;
    for (const binding of model.nodes.filter(
      (node) => node.kind === 'BINDING' && !probeBindings.includes(node),
    )) {
      const shared = handlerOf(binding.id)
        .flatMap(servicesOf)
        .some((service) => probeServices.has(service));
      if (!shared) continue;
      const text = normalize(String(binding.detail?.text ?? ''));
      if (text.length < 2) continue;
      for (const factor of factors)
        if (factor.dimension === 'STATES' && normalize(factor.target ?? '').includes(text))
          sharedFactors.push(factor);
    }
  }
  const unique = (items: Factor[]) =>
    [...new Map(items.map((item) => [item.id, item])).values()].sort(byPriority);
  const required = unique(requiredFactors);
  const shared = unique(sharedFactors);
  for (const factor of required)
    plans.push({
      strategy: 'CODE_GUIDED',
      factors: [factor],
      priority: 95 + factor.priority,
      note: 'contrôle requis dans le code',
    });
  for (const factor of shared)
    plans.push({
      strategy: 'CODE_GUIDED',
      factors: [factor],
      priority: 93 + factor.priority,
      note: 'gestionnaire partageant un service avec la sonde',
    });
  for (const a of required)
    for (const b of shared) {
      if (!compatible([a, b])) continue;
      plans.push({
        strategy: 'CODE_GUIDED',
        factors: [a, b],
        priority: 97 + a.priority + b.priority,
        note: 'contrôle requis × service partagé',
      });
      plans.push({
        strategy: 'CODE_GUIDED',
        factors: [b, a],
        priority: 96 + a.priority + b.priority,
        note: 'service partagé × contrôle requis',
      });
    }
  return plans;
}

/** Guidée par l'erreur : un facteur qui a produit une erreur de page ou de console est combiné avec les autres. */
function errorGuided(ctx: StrategyContext): TrialPlan[] {
  const plans: TrialPlan[] = [];
  const suspects = ctx.catalog.factors.filter((factor) => ctx.errorFactors.has(factor.id));
  for (const suspect of suspects)
    for (const other of [...ctx.catalog.factors].sort(byPriority).slice(0, 12)) {
      if (other.id === suspect.id || !compatible([suspect, other])) continue;
      plans.push({
        strategy: 'ERROR_GUIDED',
        factors: [suspect, other],
        priority: 85 + suspect.priority + other.priority,
      });
      plans.push({
        strategy: 'ERROR_GUIDED',
        factors: [other, suspect],
        priority: 84 + suspect.priority + other.priority,
      });
    }
  return plans;
}

/** Paires : interactions entre deux facteurs de dimensions différentes d'abord. */
function pairwise(ctx: StrategyContext): TrialPlan[] {
  const sorted = [...ctx.catalog.factors].sort(byPriority).slice(0, 16);
  const plans: TrialPlan[] = [];
  for (let i = 0; i < sorted.length; i += 1)
    for (let j = i + 1; j < sorted.length; j += 1) {
      const a = sorted[i];
      const b = sorted[j];
      if (!a || !b || !compatible([a, b])) continue;
      const cross = a.dimension !== b.dimension ? 6 : 0;
      // Un champ vidé combiné à un dialogue ouvert puis fermé : l'interaction la plus classique passe devant.
      const classic =
        [a, b].some((item) => item.id.startsWith('data:empty:')) &&
        [a, b].some((item) => item.id.startsWith('state:dialog:'))
          ? 10
          : 0;
      plans.push({
        strategy: 'PAIRWISE',
        factors: [a, b],
        priority: 40 + cross + classic + a.priority + b.priority,
      });
      plans.push({
        strategy: 'PAIRWISE',
        factors: [b, a],
        priority: 38 + cross + classic + a.priority + b.priority,
      });
    }
  return plans;
}

/** Séquences avec état : trois facteurs, ordres différents ; les facteurs d'un essai reproduisant d'abord. */
function stateful(ctx: StrategyContext): TrialPlan[] {
  const sorted = [...ctx.catalog.factors]
    .sort(
      (a, b) =>
        Number(ctx.reproducingFactors.has(b.id)) - Number(ctx.reproducingFactors.has(a.id)) ||
        byPriority(a, b),
    )
    .slice(0, 10);
  const plans: TrialPlan[] = [];
  for (let i = 0; i < sorted.length; i += 1)
    for (let j = 0; j < sorted.length; j += 1)
      for (let k = 0; k < sorted.length; k += 1) {
        if (i === j || j === k || i === k) continue;
        const factors = [sorted[i], sorted[j], sorted[k]].filter(
          (item): item is Factor => item !== undefined,
        );
        if (factors.length !== 3 || !compatible(factors)) continue;
        plans.push({
          strategy: 'STATEFUL_SEQUENCE',
          factors,
          priority: 20 + factors.reduce((sum, factor) => sum + factor.priority, 0),
        });
      }
  // Et les variations de temps combinées à chaque facteur d'état.
  for (const timing of ctx.catalog.factors.filter((factor) => factor.dimension === 'TIMING'))
    for (const state of ctx.catalog.factors.filter((factor) => factor.dimension === 'STATES').slice(0, 8))
      plans.push({
        strategy: 'STATEFUL_SEQUENCE',
        factors: [state, timing],
        priority: 30 + state.priority + timing.priority,
      });
  return plans;
}

/** Modèle : un parcours plus long qui visite chaque état (onglets, dialogues) avant la sonde. */
function modelBased(ctx: StrategyContext): TrialPlan[] {
  const states = ctx.catalog.factors.filter((factor) => factor.dimension === 'STATES').sort(byPriority);
  if (states.length < 2) return [];
  const plans: TrialPlan[] = [];
  for (let size = 2; size <= Math.min(4, states.length); size += 1) {
    const factors = states.slice(0, size);
    if (compatible(factors))
      plans.push({ strategy: 'MODEL_BASED', factors, priority: 25 + size, note: 'tous les états visités' });
    const reversed = [...factors].reverse();
    plans.push({ strategy: 'MODEL_BASED', factors: reversed, priority: 24 + size });
  }
  return plans;
}

/** Différentielle : un essai reproduisant moins un facteur (ce qui nourrit la minimisation et les conditions). */
function differential(ctx: StrategyContext): TrialPlan[] {
  const plans: TrialPlan[] = [];
  const reproducing = ctx.trials.filter((trial) => trial.verdict === 'FAILURE_REPRODUCED');
  for (const trial of reproducing.slice(-3)) {
    const ids = Object.keys(trial.factors);
    const factors = ids
      .map((id) => ctx.catalog.factors.find((factor) => factor.id === id))
      .filter((factor): factor is Factor => factor !== undefined);
    if (factors.length < 2) continue;
    for (let index = 0; index < factors.length; index += 1)
      plans.push({
        strategy: 'DIFFERENTIAL',
        factors: factors.filter((_, position) => position !== index),
        priority: 70,
        note: `sans « ${factors[index]?.label ?? ''} »`,
      });
  }
  return plans;
}

/** Guidée par l'IA : des séquences proposées, déjà validées contre le catalogue (facteurs connus seulement). */
function aiGuided(ctx: StrategyContext): TrialPlan[] {
  return (ctx.aiProposals ?? [])
    .filter((factors) => factors.length > 0 && compatible(factors))
    .map((factors) => ({
      strategy: 'AI_GUIDED' as const,
      factors,
      priority: 120,
      note: 'proposé par l’IA, joué et jugé comme les autres',
    }));
}

const GENERATORS: Record<ExplorationStrategy, (ctx: StrategyContext) => TrialPlan[]> = {
  REFERENCE: () => [],
  GUIDED: guided,
  MODEL_BASED: modelBased,
  BOUNDARY: boundary,
  PAIRWISE: pairwise,
  STATEFUL_SEQUENCE: stateful,
  DIFFERENTIAL: differential,
  ERROR_GUIDED: errorGuided,
  CODE_GUIDED: codeGuided,
  AI_GUIDED: aiGuided,
  MINIMIZATION: () => [],
  REPETITION: () => [],
  EXPERIMENT: () => [],
};

/** Les essais candidats, par priorité, sans ceux déjà joués (clé de séquence) ni les doublons. */
export function planTrials(
  ctx: StrategyContext,
  strategies: readonly ExplorationStrategy[] = strategiesFor(ctx.depth),
): TrialPlan[] {
  // Une même séquence proposée par plusieurs stratégies garde la priorité la plus haute (et cette stratégie).
  const byKey = new Map<string, TrialPlan>();
  for (const strategy of strategies)
    for (const plan of GENERATORS[strategy](ctx)) {
      const key = plan.factors.map((factor) => factor.id).join('→');
      const known = byKey.get(key);
      if (!known || plan.priority > known.priority) byKey.set(key, plan);
    }
  return [...byKey.values()].sort((a, b) => b.priority - a.priority);
}

/** Les actions d'un plan : navigation et remplissages de référence, facteurs, puis sondes. */
export function actionsOf(
  plan: TrialPlan,
  catalog: ActionCatalog,
  entry: TriggerAction[],
): { actions: TriggerAction[]; probes: number[] } {
  // La sonde principale est rejouée en fin de séquence : une perte de réaction se constate après coup,
  // sur au moins deux sondes indépendantes (la principale, une autre, puis la principale à nouveau).
  const base = plan.probes ?? catalog.probes;
  const primary = base[0];
  const probes = primary && base.length > 1 ? [...base, primary] : base;
  // Un facteur qui vide ou modifie un champ remplace le remplissage de référence de ce champ.
  const overridden = new Set(
    plan.factors.map((factor) => factor.target).filter((target): target is string => target !== undefined),
  );
  const fills = catalog.fills.filter((fill) => !overridden.has(fill.target ?? ''));
  const preparation = [
    ...entry.map((action) => ({ ...action, origin: 'reference' })),
    ...fills.map((action) => ({ ...action, origin: 'reference' })),
    ...plan.factors.flatMap((factor) => factor.actions.map((action) => ({ ...action, origin: factor.id }))),
  ];
  const actions = [...preparation, ...probes.map((probe) => ({ ...probe, origin: 'probe' }))];
  const probeIndexes = probes.map((_, index) => preparation.length + index);
  return { actions, probes: probeIndexes };
}
