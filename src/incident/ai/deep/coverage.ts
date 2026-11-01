import {
  COVERAGE_DIMENSIONS,
  type AiInvestigationRun,
  type AiRef,
  type CoverageDimension,
  type CoverageEntry,
  type CoverageState,
  type InvestigationMemory,
  type InvestigationStrategy,
  type StrategyCategory,
} from '../../../sdk/core/incident-ai-contracts.js';
import {
  incidentReproduction,
  type CodeSymbol,
  type CodeSymbolKind,
  type Experiment,
  type ExperimentKind,
  type Incident,
} from '../../../sdk/core/incident-contracts.js';

/**
 * LA COUVERTURE DE L'INVESTIGATION : par dimension, avec son dénominateur NOMMÉ et explicite, jamais un
 * pourcentage global. Pour chaque dimension on compte ce qui existe dans l'incident (actions rejouées, requêtes,
 * contrôleurs du BFF, services du backend, hypothèses, vérifications proposées…) et ce que l'investigation a
 * réellement examiné (cité dans un constat, une exploration, une contradiction, un résultat de stratégie, une
 * vérification). Ce qu'une permission ou une capacité interdit est BLOCKED avec sa règle ; ce qui n'existe pas
 * est NOT_APPLICABLE avec la raison. Fonction pure.
 */
const MAX_REFS_PER_ENTRY = 20;

const COMPARATIVE_KINDS: readonly ExperimentKind[] = [
  'COMPARE_WITH_PASSING',
  'COMPARE_REQUESTS',
  'COMPARE_RESPONSES',
];
const CONTROLLER_KINDS: readonly CodeSymbolKind[] = ['ENDPOINT', 'CONTROLLER'];
const MAPPING_KINDS: readonly CodeSymbolKind[] = ['DTO', 'MAPPER', 'PAYLOAD_TRANSFORM'];
const REPOSITORY_KINDS: readonly CodeSymbolKind[] = ['REPOSITORY', 'SQL_QUERY'];
const EXCEPTION_KINDS: readonly CodeSymbolKind[] = ['EXCEPTION', 'EXCEPTION_HANDLER'];

const normalizeFile = (file: string): string =>
  file.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');

/** Tout ce que l'investigation a cité : identifiants (toutes sortes confondues) et fichiers. */
class Cited {
  readonly ids = new Set<string>();
  readonly files = new Set<string>();

  add(id: string | undefined): void {
    if (typeof id === 'string' && id !== '') this.ids.add(id);
  }

  ref(ref: AiRef): void {
    this.add(ref.id);
    if (ref.kind === 'file') this.file(ref.id.includes(':') ? ref.id.slice(ref.id.indexOf(':') + 1) : ref.id);
    if (ref.kind === 'symbol') {
      const hash = ref.id.indexOf('#');
      const colon = ref.id.indexOf(':');
      if (hash > 0 && colon >= 0 && colon < hash) this.file(ref.id.slice(colon + 1, hash));
    }
  }

  file(file: string | undefined): void {
    if (typeof file === 'string' && file !== '') this.files.add(normalizeFile(file));
  }

  hasFile(file: string | undefined): boolean {
    return typeof file === 'string' && this.files.has(normalizeFile(file));
  }

  symbol(symbol: Pick<CodeSymbol, 'id' | 'file'>): boolean {
    return this.ids.has(symbol.id) || this.hasFile(symbol.file);
  }
}

function citedBy(
  incident: Incident,
  memory: InvestigationMemory,
  run: AiInvestigationRun | undefined,
): Cited {
  const cited = new Cited();
  for (const finding of run?.findings ?? []) {
    for (const ref of finding.refs) cited.ref(ref);
    for (const location of finding.locations) cited.file(location.file);
  }
  for (const event of memory.timeline) for (const ref of event.refs) cited.ref(ref);
  for (const exploration of memory.explorations) {
    for (const location of exploration.locations) cited.file(location.file);
    for (const verification of exploration.verifications) for (const ref of verification.refs) cited.ref(ref);
  }
  for (const contradiction of memory.contradictions) for (const ref of contradiction.refs) cited.ref(ref);
  for (const strategy of memory.strategies) for (const ref of strategy.outcomeRefs) cited.ref(ref);
  for (const experiment of memory.experiments) for (const ref of experiment.requiredEvidence) cited.ref(ref);
  for (const hypothesis of incident.investigation.hypotheses) {
    for (const item of [...hypothesis.supporting, ...hypothesis.contradicting]) cited.add(item.ref);
    for (const file of hypothesis.files) cited.file(file);
  }
  for (const experiment of incident.investigation.experiments)
    if (experiment.status === 'DONE') for (const evidence of experiment.evidence) cited.add(evidence.id);
  return cited;
}

function entry(
  dimension: CoverageDimension,
  examined: number,
  total: number,
  denominator: string,
  refs: AiRef[],
  options: { emptyReason?: string; reason?: string } = {},
): CoverageEntry {
  const state: CoverageState =
    total === 0
      ? 'NOT_APPLICABLE'
      : examined >= total
        ? 'EXAMINED'
        : examined > 0
          ? 'PARTIAL'
          : 'NOT_EXAMINED';
  const reason = total === 0 ? options.emptyReason : options.reason;
  return {
    dimension,
    state,
    examined: Math.min(examined, total),
    total,
    denominator,
    ...(reason ? { reason } : {}),
    refs: refs.slice(0, MAX_REFS_PER_ENTRY),
  };
}

function blocked(dimension: CoverageDimension, reason: string, denominator?: string): CoverageEntry {
  return { dimension, state: 'BLOCKED', ...(denominator ? { denominator } : {}), reason, refs: [] };
}

function notApplicable(dimension: CoverageDimension, reason: string): CoverageEntry {
  return { dimension, state: 'NOT_APPLICABLE', reason, refs: [] };
}

function notExamined(dimension: CoverageDimension, reason: string, denominator?: string): CoverageEntry {
  return { dimension, state: 'NOT_EXAMINED', ...(denominator ? { denominator } : {}), reason, refs: [] };
}

/** Une dimension couverte par une catégorie de stratégies : terminées / connues ; bloquée si rien n'a pu tourner. */
function fromStrategies(
  dimension: CoverageDimension,
  category: StrategyCategory,
  strategies: readonly InvestigationStrategy[],
  denominator: string,
  emptyReason: string,
): CoverageEntry {
  const own = strategies.filter((strategy) => strategy.category === category);
  const relevant = own.filter((strategy) => strategy.status !== 'NOT_APPLICABLE');
  if (own.length > 0 && relevant.length === 0)
    return notApplicable(dimension, own.find((strategy) => strategy.reason)?.reason ?? emptyReason);
  if (relevant.length === 0) return notExamined(dimension, emptyReason, denominator);
  const completed = relevant.filter((strategy) => strategy.status === 'COMPLETED');
  const blockedOnes = relevant.filter((strategy) => strategy.status === 'BLOCKED');
  if (completed.length === 0 && blockedOnes.length === relevant.length)
    return blocked(dimension, blockedOnes[0]?.reason ?? 'stratégies bloquées', denominator);
  const refs = completed.flatMap((strategy) => strategy.outcomeRefs);
  const reason =
    blockedOnes.length > 0
      ? `${String(blockedOnes.length)} stratégie(s) bloquée(s) : ${blockedOnes.map((strategy) => strategy.reason ?? strategy.name).join(' ; ')}`
      : undefined;
  return entry(dimension, completed.length, relevant.length, denominator, refs, {
    ...(reason ? { reason } : {}),
  });
}

function symbolsOf(
  incident: Incident,
  kinds: readonly CodeSymbolKind[],
  layer?: CodeSymbol['layer'],
): CodeSymbol[] {
  return (incident.investigation.code?.symbols ?? []).filter(
    (symbol) => kinds.includes(symbol.kind) && (layer === undefined || symbol.layer === layer),
  );
}

function hasLayer(incident: Incident, layer: CodeSymbol['layer']): boolean {
  return incident.scope.applications.some((application) => application.layer === layer);
}

/** Une dimension du code : symboles existants / symboles cités (par id ou par fichier). */
function fromSymbols(
  dimension: CoverageDimension,
  incident: Incident,
  cited: Cited,
  kinds: readonly CodeSymbolKind[],
  denominator: string,
  options: { layer?: CodeSymbol['layer']; missingLayer: string; none: string },
): CoverageEntry {
  if (options.layer !== undefined && !hasLayer(incident, options.layer))
    return notApplicable(dimension, options.missingLayer);
  if (!incident.scope.permissions.readSources)
    return blocked(
      dimension,
      'lecture des sources non permise par le périmètre (permissions.readSources)',
      denominator,
    );
  if (!incident.investigation.code)
    return notExamined(dimension, 'code non indexé (analyse non lancée)', denominator);
  const symbols = symbolsOf(incident, kinds, options.layer);
  const examined = symbols.filter((symbol) => cited.symbol(symbol));
  return entry(
    dimension,
    examined.length,
    symbols.length,
    denominator,
    examined.map((symbol) => ({ kind: 'symbol', id: symbol.id })),
    { emptyReason: options.none },
  );
}

function experimentsOf(
  incident: Incident,
  memory: InvestigationMemory,
): { id: string; kind: ExperimentKind; done: boolean }[] {
  const byId = new Map<string, { id: string; kind: ExperimentKind; done: boolean }>();
  const doneIds = new Set(
    incident.investigation.experiments.filter((experiment) => experiment.status === 'DONE').map((e) => e.id),
  );
  for (const generated of memory.experiments)
    byId.set(generated.id, {
      id: generated.id,
      kind: generated.kind,
      done:
        generated.status === 'DONE' ||
        (generated.experimentId !== undefined && doneIds.has(generated.experimentId)),
    });
  for (const experiment of incident.investigation.experiments) {
    const planned = memory.experiments.find((generated) => generated.experimentId === experiment.id);
    if (planned) continue;
    byId.set(experiment.id, { id: experiment.id, kind: experiment.kind, done: experiment.status === 'DONE' });
  }
  return [...byId.values()];
}

const EXPERIMENT_REF = /^experiment:/;

function verified(incident: Incident, memory: InvestigationMemory, hypothesisId: string): boolean {
  const hypothesis = incident.investigation.hypotheses.find((candidate) => candidate.id === hypothesisId);
  const byExperiment =
    hypothesis !== undefined &&
    [...hypothesis.supporting, ...hypothesis.contradicting].some((item) => EXPERIMENT_REF.test(item.ref));
  const byExploration =
    memory.explorations.find((exploration) => exploration.hypothesisId === hypothesisId)?.verifications
      .length ?? 0;
  const byDone = incident.investigation.experiments.some(
    (experiment: Experiment) => experiment.hypothesisId === hypothesisId && experiment.status === 'DONE',
  );
  return byExperiment || byExploration > 0 || byDone;
}

export function computeCoverage(
  incident: Incident,
  memory: InvestigationMemory,
  run?: AiInvestigationRun,
): CoverageEntry[] {
  const cited = citedBy(incident, memory, run);
  const reproduction = incidentReproduction(incident);
  const strategies = memory.strategies;
  const entries = new Map<CoverageDimension, CoverageEntry>();

  // Parcours utilisateur : les actions rejouées de la reproduction.
  if (!reproduction)
    entries.set(
      'USER_JOURNEY',
      notExamined('USER_JOURNEY', 'aucune reproduction terminée', 'actions rejouées'),
    );
  else {
    const stepCited = (index: number): boolean =>
      cited.ids.has(`${reproduction.id}:step-${String(index)}`) ||
      cited.ids.has(`${reproduction.id}:${String(index)}`) ||
      cited.ids.has(`reproduction:step-${String(index)}`) ||
      cited.ids.has(`reproduction:${String(index)}`);
    const examined = reproduction.actions.filter(
      (action) => stepCited(action.index) || action.requestIds.some((id) => cited.ids.has(id)),
    );
    entries.set(
      'USER_JOURNEY',
      entry(
        'USER_JOURNEY',
        examined.length,
        reproduction.actions.length,
        `actions rejouées de la reproduction ${reproduction.id}`,
        examined.map((action) => ({ kind: 'step', id: `${reproduction.id}:step-${String(action.index)}` })),
        {
          emptyReason: 'la reproduction ne contient aucune action',
          ...(reproduction.reproduced === false
            ? { reason: 'symptôme non reproduit : parcours examiné sans l’erreur' }
            : {}),
        },
      ),
    );
  }

  // Événements frontend : les étapes de la traçabilité frontend.
  if (!hasLayer(incident, 'FRONTEND'))
    entries.set(
      'FRONTEND_EVENTS',
      notApplicable('FRONTEND_EVENTS', 'aucune application frontend dans le périmètre'),
    );
  else {
    const trace = incident.investigation.frontendTrace;
    if (!trace)
      entries.set(
        'FRONTEND_EVENTS',
        notExamined(
          'FRONTEND_EVENTS',
          'aucune traçabilité frontend construite',
          'étapes de la traçabilité frontend',
        ),
      );
    else {
      const examined = trace.steps.filter((step) => {
        const files = [
          step.component?.source?.file,
          step.handler?.source?.file,
          ...step.services.map((s) => s.source?.file),
          ...step.httpClients.map((s) => s.source?.file),
        ];
        return (
          files.some((file) => cited.hasFile(file)) ||
          step.requests.some((request) => cited.ids.has(request.requestId)) ||
          step.action.evidence.some((id) => cited.ids.has(id))
        );
      });
      entries.set(
        'FRONTEND_EVENTS',
        entry(
          'FRONTEND_EVENTS',
          examined.length,
          trace.steps.length,
          'étapes de la traçabilité frontend',
          examined.flatMap((step) =>
            step.requests.map((request) => ({ kind: 'request' as const, id: request.requestId })),
          ),
          { emptyReason: 'la traçabilité frontend ne contient aucune étape' },
        ),
      );
    }
  }

  // Requêtes HTTP de la reproduction.
  if (!reproduction)
    entries.set(
      'HTTP_REQUESTS',
      notExamined('HTTP_REQUESTS', 'aucune reproduction terminée', 'requêtes HTTP'),
    );
  else {
    const examined = reproduction.requests.filter((request) => cited.ids.has(request.id));
    entries.set(
      'HTTP_REQUESTS',
      entry(
        'HTTP_REQUESTS',
        examined.length,
        reproduction.requests.length,
        `requêtes HTTP de la reproduction ${reproduction.id}`,
        examined.map((request) => ({ kind: 'request', id: request.id })),
        { emptyReason: 'la reproduction n’a capturé aucune requête' },
      ),
    );
  }

  entries.set(
    'BFF_CONTROLLERS',
    fromSymbols(
      'BFF_CONTROLLERS',
      incident,
      cited,
      CONTROLLER_KINDS,
      'contrôleurs et endpoints du BFF indexés',
      {
        layer: 'BFF',
        missingLayer: 'aucune application BFF dans le périmètre',
        none: 'aucun contrôleur indexé dans le BFF',
      },
    ),
  );
  entries.set(
    'MAPPINGS',
    fromSymbols(
      'MAPPINGS',
      incident,
      cited,
      MAPPING_KINDS,
      'DTO, mappers et transformations de charge utile indexés',
      {
        missingLayer: '',
        none: 'aucun DTO, mapper ni transformation indexé',
      },
    ),
  );
  entries.set(
    'BACKEND_SERVICES',
    fromSymbols('BACKEND_SERVICES', incident, cited, ['SERVICE'], 'services du backend indexés', {
      layer: 'BACKEND',
      missingLayer: 'aucune application backend dans le périmètre',
      none: 'aucun service indexé dans le backend',
    }),
  );
  entries.set(
    'REPOSITORIES',
    fromSymbols(
      'REPOSITORIES',
      incident,
      cited,
      REPOSITORY_KINDS,
      'dépôts de données et requêtes SQL indexés',
      {
        layer: 'BACKEND',
        missingLayer: 'aucune application backend dans le périmètre',
        none: 'aucun dépôt de données ni requête SQL indexé',
      },
    ),
  );

  entries.set(
    'DATA_PRECONDITIONS',
    fromStrategies(
      'DATA_PRECONDITIONS',
      'DATA',
      strategies,
      'stratégies de préconditions de données',
      'aucune stratégie de préconditions de données tentée',
    ),
  );

  // Exceptions : les nœuds d'exception du graphe et les gestionnaires d'exception du code.
  {
    const nodes = (incident.investigation.graph?.nodes ?? []).filter((node) => node.kind === 'EXCEPTION');
    const symbols = incident.scope.permissions.readSources ? symbolsOf(incident, EXCEPTION_KINDS) : [];
    const total = nodes.length + symbols.length;
    if (total === 0) {
      const strategic = strategies.some((strategy) => strategy.category === 'EXCEPTION');
      entries.set(
        'EXCEPTIONS',
        strategic
          ? fromStrategies(
              'EXCEPTIONS',
              'EXCEPTION',
              strategies,
              'stratégies sur le chemin des exceptions',
              'aucune stratégie sur les exceptions',
            )
          : notApplicable('EXCEPTIONS', 'aucune exception observée dans le graphe ni gestionnaire indexé'),
      );
    } else {
      const examinedNodes = nodes.filter(
        (node) =>
          cited.ids.has(node.id) || node.evidence.some((id) => cited.ids.has(id)) || cited.hasFile(node.file),
      );
      const examinedSymbols = symbols.filter((symbol) => cited.symbol(symbol));
      entries.set(
        'EXCEPTIONS',
        entry(
          'EXCEPTIONS',
          examinedNodes.length + examinedSymbols.length,
          total,
          'exceptions observées (graphe) et gestionnaires d’exception indexés',
          [
            ...examinedNodes.map((node) => ({ kind: 'node' as const, id: node.id })),
            ...examinedSymbols.map((symbol) => ({ kind: 'symbol' as const, id: symbol.id })),
          ],
        ),
      );
    }
  }

  entries.set(
    'CONFIGURATIONS',
    fromStrategies(
      'CONFIGURATIONS',
      'CONFIGURATION',
      strategies,
      'stratégies de revue de configuration',
      'aucune revue de configuration tentée',
    ),
  );

  // Changements Git : permission explicite ET commande `git` autorisée, sinon BLOCKED avec la règle.
  {
    const permissions = incident.scope.permissions;
    if (permissions.readGitHistory !== true)
      entries.set(
        'GIT_CHANGES',
        blocked(
          'GIT_CHANGES',
          'lecture de l’historique Git non permise (permissions.readGitHistory absent ou faux)',
          'stratégies sur l’historique Git',
        ),
      );
    else if (!incident.scope.allowedCommands.includes('git'))
      entries.set(
        'GIT_CHANGES',
        blocked(
          'GIT_CHANGES',
          'la commande « git » n’est pas dans allowedCommands',
          'stratégies sur l’historique Git',
        ),
      );
    else
      entries.set(
        'GIT_CHANGES',
        fromStrategies(
          'GIT_CHANGES',
          'HISTORY',
          strategies,
          'stratégies sur l’historique Git',
          'aucune analyse des changements Git tentée',
        ),
      );
  }

  // Scénarios comparatifs : les vérifications de comparaison (proposées / exécutées), sinon les stratégies.
  {
    const comparative = experimentsOf(incident, memory).filter((experiment) =>
      COMPARATIVE_KINDS.includes(experiment.kind),
    );
    if (comparative.length === 0)
      entries.set(
        'COMPARATIVE_SCENARIOS',
        fromStrategies(
          'COMPARATIVE_SCENARIOS',
          'COMPARISON',
          strategies,
          'vérifications comparatives proposées',
          'aucune comparaison avec un scénario qui réussit proposée',
        ),
      );
    else {
      const done = comparative.filter((experiment) => experiment.done);
      entries.set(
        'COMPARATIVE_SCENARIOS',
        entry(
          'COMPARATIVE_SCENARIOS',
          done.length,
          comparative.length,
          'vérifications comparatives proposées (COMPARE_WITH_PASSING, COMPARE_REQUESTS, COMPARE_RESPONSES)',
          done.map((experiment) => ({ kind: 'experiment', id: experiment.id })),
        ),
      );
    }
  }

  // Hypothèses alternatives : chaque hypothèse (règle ou IA) a-t-elle reçu au moins une vérification ?
  {
    const hypotheses = incident.investigation.hypotheses;
    const examined = hypotheses.filter((hypothesis) => verified(incident, memory, hypothesis.id));
    entries.set(
      'ALTERNATIVE_HYPOTHESES',
      entry(
        'ALTERNATIVE_HYPOTHESES',
        examined.length,
        hypotheses.length,
        'hypothèses de l’investigation (règles et IA)',
        examined.map((hypothesis) => ({ kind: 'hypothesis', id: hypothesis.id })),
        { emptyReason: 'aucune hypothèse proposée' },
      ),
    );
  }

  // Vérifications exécutées : parmi celles proposées.
  {
    const all = experimentsOf(incident, memory);
    const done = all.filter((experiment) => experiment.done);
    entries.set(
      'EXECUTED_VERIFICATIONS',
      entry(
        'EXECUTED_VERIFICATIONS',
        done.length,
        all.length,
        'vérifications proposées (générées par l’investigation ou planifiées dans l’incident)',
        done.map((experiment) => ({ kind: 'experiment', id: experiment.id })),
        { emptyReason: 'aucune vérification proposée' },
      ),
    );
  }

  return COVERAGE_DIMENSIONS.map(
    (dimension) => entries.get(dimension) ?? notExamined(dimension, 'dimension non évaluée'),
  );
}

/** Ce que la couverture laisse à faire, lisible (pour `remaining[]` et le rapport) ; jamais un pourcentage. */
export function coverageGaps(coverage: readonly CoverageEntry[]): string[] {
  return coverage.flatMap((item) => {
    if (item.state === 'EXAMINED' || item.state === 'NOT_APPLICABLE') return [];
    const counts =
      item.examined !== undefined && item.total !== undefined
        ? ` (${String(item.examined)}/${String(item.total)} ${item.denominator ?? ''})`.replace(/\s+\)/, ')')
        : '';
    const reason = item.reason ? ` : ${item.reason}` : '';
    return [`${item.dimension} ${item.state}${counts}${reason}`];
  });
}
