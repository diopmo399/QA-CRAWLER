import type {
  AiAgentName,
  AiContradiction,
  AiFinding,
  AiInvestigationMode,
  AiRef,
  ContradictionKind,
  HypothesisExploration,
  InvestigationDepth,
  InvestigationMemory,
  InvestigationStrategy,
  RiskLevel,
  StrategyCategory,
  StrategyExecutionMode,
  StrategyStatus,
} from '../../../sdk/core/incident-ai-contracts.js';
import { DEPTH_MODES, MAX_STRATEGIES } from '../../../sdk/core/incident-ai-contracts.js';
import type {
  EnvironmentCapabilities,
  ExperimentKind,
  Hypothesis,
  Incident,
  ScopePermissions,
} from '../../../sdk/core/incident-contracts.js';
import type { InvestigationToolName } from '../agent.js';

/**
 * LE MOTEUR DE STRATÉGIES DE L'INVESTIGATION APPROFONDIE : un catalogue de façons d'avancer (preuves, code,
 * contrat, données, configuration, historique Git, comparaisons, exceptions, explications alternatives,
 * vérifications), découvertes d'après l'incident, le périmètre et les capacités ; bloquées quand une
 * précondition manque (la raison le dit) ; non applicables quand la couche n'existe pas dans le périmètre ;
 * jamais répétées sans justification ; priorisées par le gain d'information attendu (départager des
 * hypothèses, trancher des contradictions), le risque et le coût ne départageant qu'à gain égal, la lecture
 * seule avant ce qui demande une approbation. Tout est pur : aucune fonction ne lit un fichier, n'appelle un
 * modèle ni ne modifie ses arguments ; l'orchestrateur adaptatif décide, exécute et enregistre.
 */

export type StrategyLayer = InvestigationStrategy['applicableLayers'][number];

/** Un fait de l'incident qu'une stratégie exige (précondition vérifiée sur les données, jamais supposée). */
export const INCIDENT_FACTS = [
  'REPRODUCTION',
  'FAILING_REQUEST',
  'PASSING_RUN',
  'SECOND_SCENARIO',
  'CODE_INDEX',
  'EXCEPTION',
  'HYPOTHESES',
  'OPEN_HYPOTHESES',
  'CONFIRMED_HYPOTHESIS',
  'DENIED_PATHS',
  'TIMELINE',
] as const;
export type IncidentFact = (typeof INCIDENT_FACTS)[number];

/** Une exigence d'une stratégie : outil, permission du périmètre, commande autorisée, capacité, fait de l'incident. */
export type StrategyRequirement =
  | { kind: 'TOOL'; tool: InvestigationToolName }
  | { kind: 'PERMISSION'; permission: keyof ScopePermissions; accepts: readonly (string | boolean)[] }
  | { kind: 'COMMAND'; command: string }
  | { kind: 'ENVIRONMENT'; capability: 'tests' | 'logs' | 'repositories' }
  | { kind: 'INCIDENT'; fact: IncidentFact };

/** Comment une stratégie choisit les hypothèses qu'elle peut départager. */
export type HypothesisSelection =
  'BY_LAYER' | 'BY_VERIFICATION_KIND' | 'ALL_OPEN' | 'ALL' | 'SUPPORTED_OR_CONFIRMED' | 'NONE';

/** Une entrée du catalogue : ce qui est stable, avant toute évaluation sur un incident. */
export interface StrategyTemplate {
  id: string;
  name: string;
  category: StrategyCategory;
  applicableLayers: StrategyLayer[];
  /** Les profondeurs qui l'incluent (QUICK ⊂ STANDARD ⊂ DEEP). */
  depths: readonly InvestigationDepth[];
  executionMode: StrategyExecutionMode;
  estimatedCost: number;
  estimatedRisk: RiskLevel;
  /** Le gain d'information de base, 0 à 1 ; la priorisation l'ajuste d'après les hypothèses et contradictions. */
  informationGain: number;
  via: InvestigationStrategy['via'];
  requirements: readonly StrategyRequirement[];
  selects: HypothesisSelection;
}

export interface DiscoveryContext {
  incident: Incident;
  depth: InvestigationDepth;
  mode: AiInvestigationMode;
  /** Absentes : inconnues, donc jamais supposées (une stratégie qui en dépend est BLOCKED). */
  capabilities: EnvironmentCapabilities | undefined;
  scopePermissions: ScopePermissions;
  tools: readonly InvestigationToolName[];
  memory?: InvestigationMemory;
  /** Une reprise justifiée d'une stratégie déjà tentée : identifiant → justification (enregistrée dans `reason`). */
  justify?: Readonly<Record<string, string>>;
}

export interface StrategyOutcome {
  status: Extract<StrategyStatus, 'COMPLETED' | 'FAILED' | 'SKIPPED' | 'BLOCKED'>;
  at: string;
  refs?: readonly AiRef[];
  reason?: string;
}

export type ScoredStrategy = InvestigationStrategy & {
  /** Le gain ajusté qui a servi au classement (hypothèses départagées, contradictions tranchées). */
  score: number;
};

const ALL_DEPTHS: readonly InvestigationDepth[] = ['QUICK', 'STANDARD', 'DEEP'];
const FROM_STANDARD: readonly InvestigationDepth[] = ['STANDARD', 'DEEP'];
const DEEP_ONLY: readonly InvestigationDepth[] = ['DEEP'];
const CODE_LAYERS: StrategyLayer[] = ['FRONTEND', 'BFF', 'BACKEND'];
const JAVA_LAYERS: StrategyLayer[] = ['BFF', 'BACKEND'];

const READ_SOURCES: StrategyRequirement = { kind: 'PERMISSION', permission: 'readSources', accepts: [true] };
const NAVIGATE: StrategyRequirement = { kind: 'PERMISSION', permission: 'navigate', accepts: [true] };
const CODE_TOOLS: readonly StrategyRequirement[] = [
  READ_SOURCES,
  { kind: 'TOOL', tool: 'read_source' },
  { kind: 'TOOL', tool: 'find_symbol' },
  { kind: 'INCIDENT', fact: 'CODE_INDEX' },
];

export const DERIVED_STRATEGY_PREFIX = 'strat-derived-';
/** Le plafond de stratégies dérivées par appel : au-delà, le reste attend l'itération suivante. */
export const MAX_DERIVED_STRATEGIES = 12;
/** Le gain par hypothèse supplémentaire qu'une stratégie départage, et le plafond de ce bonus. */
const SPLIT_GAIN = 0.1;
const MAX_SPLIT_GAIN = 0.3;
/** Le gain par contradiction ouverte qu'une stratégie peut trancher, et le plafond de ce bonus. */
const CONTRADICTION_GAIN = 0.15;
const MAX_CONTRADICTION_GAIN = 0.3;
/** Une stratégie qui ne vise que des hypothèses réfutées n'apprend presque rien. */
const REFUTED_ONLY_FACTOR = 0.3;

/**
 * LE CATALOGUE. Les coûts sont des unités de budget (appels d'outils, fichiers, une expérience) ; le gain est
 * indicatif et relatif entre stratégies, jamais une probabilité mesurée.
 */
export const STRATEGY_CATALOG: readonly StrategyTemplate[] = [
  {
    id: 'strat-first-symptom-evidence',
    name: 'Identifier le premier symptôme observable et ce qui le précède',
    category: 'EVIDENCE',
    applicableLayers: [],
    depths: ALL_DEPTHS,
    executionMode: 'READ_ONLY',
    estimatedCost: 2,
    estimatedRisk: 'LOW',
    informationGain: 0.6,
    via: { agent: 'EVIDENCE_ANALYSIS' },
    requirements: [
      { kind: 'INCIDENT', fact: 'REPRODUCTION' },
      { kind: 'TOOL', tool: 'get_evidence' },
    ],
    selects: 'ALL_OPEN',
  },
  {
    id: 'strat-earlier-errors-timeline',
    name: 'Chercher dans la chronologie une erreur antérieure au symptôme',
    category: 'EVIDENCE',
    applicableLayers: [],
    depths: ALL_DEPTHS,
    executionMode: 'READ_ONLY',
    estimatedCost: 2,
    estimatedRisk: 'LOW',
    informationGain: 0.4,
    via: { agent: 'EVIDENCE_ANALYSIS' },
    requirements: [
      { kind: 'INCIDENT', fact: 'TIMELINE' },
      { kind: 'TOOL', tool: 'get_evidence' },
    ],
    selects: 'ALL_OPEN',
  },
  {
    id: 'strat-frontend-chain',
    name: 'Suivre la chaîne frontend : bouton → composant → handler → service → requête',
    category: 'CODE',
    applicableLayers: ['FRONTEND'],
    depths: FROM_STANDARD,
    executionMode: 'READ_ONLY',
    estimatedCost: 6,
    estimatedRisk: 'LOW',
    informationGain: 0.5,
    via: { agent: 'FRONTEND' },
    requirements: [...CODE_TOOLS, { kind: 'INCIDENT', fact: 'FAILING_REQUEST' }],
    selects: 'BY_LAYER',
  },
  {
    id: 'strat-payload-vs-contract',
    name: 'Comparer la charge utile envoyée au contrat attendu par le serveur',
    category: 'CONTRACT',
    applicableLayers: ['FRONTEND', 'BFF'],
    depths: ALL_DEPTHS,
    executionMode: 'READ_ONLY',
    estimatedCost: 3,
    estimatedRisk: 'LOW',
    informationGain: 0.7,
    via: { agent: 'CROSS_LAYER', experimentKind: 'COMPARE_REQUESTS' },
    requirements: [
      { kind: 'INCIDENT', fact: 'FAILING_REQUEST' },
      { kind: 'TOOL', tool: 'get_request' },
    ],
    selects: 'BY_LAYER',
  },
  {
    id: 'strat-dto-mapping-chain',
    name: 'Suivre la correspondance des DTO Frontend ↔ BFF ↔ Backend (champs perdus, transformés)',
    category: 'CONTRACT',
    applicableLayers: CODE_LAYERS,
    depths: FROM_STANDARD,
    executionMode: 'READ_ONLY',
    estimatedCost: 8,
    estimatedRisk: 'LOW',
    informationGain: 0.6,
    via: { agent: 'CROSS_LAYER' },
    requirements: [...CODE_TOOLS, { kind: 'TOOL', tool: 'find_references' }],
    selects: 'BY_LAYER',
  },
  {
    id: 'strat-bff-exception-propagation',
    name: 'Examiner la propagation des exceptions et des statuts dans le BFF',
    category: 'EXCEPTION',
    applicableLayers: ['BFF'],
    depths: FROM_STANDARD,
    executionMode: 'READ_ONLY',
    estimatedCost: 5,
    estimatedRisk: 'LOW',
    informationGain: 0.5,
    via: { agent: 'BFF' },
    requirements: [...CODE_TOOLS, { kind: 'INCIDENT', fact: 'EXCEPTION' }],
    selects: 'BY_LAYER',
  },
  {
    id: 'strat-backend-exception-path',
    name: "Remonter le chemin de l'exception dans le backend jusqu'à la ligne qui la lève",
    category: 'EXCEPTION',
    applicableLayers: ['BACKEND'],
    depths: ALL_DEPTHS,
    executionMode: 'READ_ONLY',
    estimatedCost: 5,
    estimatedRisk: 'LOW',
    informationGain: 0.7,
    via: { agent: 'BACKEND' },
    requirements: [...CODE_TOOLS, { kind: 'INCIDENT', fact: 'EXCEPTION' }],
    selects: 'BY_LAYER',
  },
  {
    id: 'strat-validation-per-layer',
    name: 'Vérifier la présence des validations, couche par couche, pour le champ en cause',
    category: 'CONTRACT',
    applicableLayers: CODE_LAYERS,
    depths: FROM_STANDARD,
    executionMode: 'READ_ONLY',
    estimatedCost: 4,
    estimatedRisk: 'LOW',
    informationGain: 0.55,
    via: { agent: 'CROSS_LAYER', experimentKind: 'CHECK_VALIDATION' },
    requirements: [...CODE_TOOLS],
    selects: 'BY_VERIFICATION_KIND',
  },
  {
    id: 'strat-data-preconditions',
    name: 'Relever les préconditions de données (relations, contraintes, valeurs nulles) en lecture seule',
    category: 'DATA',
    applicableLayers: ['DATABASE'],
    depths: DEEP_ONLY,
    executionMode: 'READ_ONLY',
    estimatedCost: 6,
    estimatedRisk: 'LOW',
    informationGain: 0.45,
    via: { agent: 'BACKEND' },
    requirements: [...CODE_TOOLS, { kind: 'TOOL', tool: 'search_code' }],
    selects: 'BY_LAYER',
  },
  {
    id: 'strat-repository-query-review',
    name: 'Relire les dépôts de données et les requêtes déclarées (JPA, SQL) du chemin en échec',
    category: 'DATA',
    applicableLayers: ['DATABASE'],
    depths: DEEP_ONLY,
    executionMode: 'READ_ONLY',
    estimatedCost: 5,
    estimatedRisk: 'LOW',
    informationGain: 0.4,
    via: { agent: 'BACKEND' },
    requirements: [...CODE_TOOLS, { kind: 'TOOL', tool: 'find_references' }],
    selects: 'BY_LAYER',
  },
  {
    id: 'strat-configuration-review',
    name: 'Relire la configuration (profils, URL des clients, délais) des applications Java',
    category: 'CONFIGURATION',
    applicableLayers: JAVA_LAYERS,
    depths: DEEP_ONLY,
    executionMode: 'READ_ONLY',
    estimatedCost: 5,
    estimatedRisk: 'LOW',
    informationGain: 0.35,
    via: { agent: 'BFF' },
    requirements: [
      READ_SOURCES,
      { kind: 'TOOL', tool: 'list_files' },
      { kind: 'TOOL', tool: 'search_code' },
      { kind: 'TOOL', tool: 'read_source' },
    ],
    selects: 'BY_LAYER',
  },
  {
    id: 'strat-git-changes-touched-files',
    name: 'Relire les changements Git récents des fichiers touchés par le chemin en échec',
    category: 'HISTORY',
    applicableLayers: CODE_LAYERS,
    depths: DEEP_ONLY,
    executionMode: 'READ_ONLY',
    estimatedCost: 4,
    estimatedRisk: 'LOW',
    informationGain: 0.5,
    via: { agent: 'EVIDENCE_ANALYSIS' },
    requirements: [
      READ_SOURCES,
      { kind: 'PERMISSION', permission: 'readGitHistory', accepts: [true] },
      { kind: 'COMMAND', command: 'git' },
      { kind: 'TOOL', tool: 'git_changes' },
      { kind: 'INCIDENT', fact: 'CODE_INDEX' },
    ],
    selects: 'ALL_OPEN',
  },
  {
    id: 'strat-compare-passing-vs-failing',
    name: 'Rejouer un scénario qui aboutit et le comparer à la reproduction en échec',
    category: 'COMPARISON',
    applicableLayers: [],
    depths: ALL_DEPTHS,
    executionMode: 'SANDBOX',
    estimatedCost: 10,
    estimatedRisk: 'MEDIUM',
    informationGain: 0.8,
    via: { experimentKind: 'COMPARE_WITH_PASSING' },
    requirements: [
      NAVIGATE,
      { kind: 'INCIDENT', fact: 'REPRODUCTION' },
      { kind: 'INCIDENT', fact: 'SECOND_SCENARIO' },
    ],
    selects: 'BY_VERIFICATION_KIND',
  },
  {
    id: 'strat-response-comparison',
    name: "Comparer les réponses d'une exécution en échec et d'une exécution qui aboutit",
    category: 'COMPARISON',
    applicableLayers: JAVA_LAYERS,
    depths: FROM_STANDARD,
    executionMode: 'READ_ONLY',
    estimatedCost: 3,
    estimatedRisk: 'LOW',
    informationGain: 0.45,
    via: { experimentKind: 'COMPARE_RESPONSES' },
    requirements: [
      { kind: 'INCIDENT', fact: 'FAILING_REQUEST' },
      { kind: 'INCIDENT', fact: 'PASSING_RUN' },
    ],
    selects: 'BY_VERIFICATION_KIND',
  },
  {
    id: 'strat-differential-replay',
    name: 'Rejouer le scénario avec et sans la donnée soupçonnée (rejeu différentiel, sans effet de bord)',
    category: 'COMPARISON',
    applicableLayers: [],
    depths: DEEP_ONLY,
    executionMode: 'SANDBOX',
    estimatedCost: 12,
    estimatedRisk: 'MEDIUM',
    informationGain: 0.7,
    via: { experimentKind: 'REPLAY' },
    requirements: [
      NAVIGATE,
      { kind: 'INCIDENT', fact: 'REPRODUCTION' },
      { kind: 'INCIDENT', fact: 'FAILING_REQUEST' },
    ],
    selects: 'BY_VERIFICATION_KIND',
  },
  {
    id: 'strat-targeted-unit-test',
    name: 'Lancer un test unitaire ciblé sur le symbole soupçonné',
    category: 'VERIFICATION',
    applicableLayers: JAVA_LAYERS,
    depths: ALL_DEPTHS,
    executionMode: 'SANDBOX',
    estimatedCost: 8,
    estimatedRisk: 'MEDIUM',
    informationGain: 0.75,
    via: { experimentKind: 'UNIT_TEST' },
    requirements: [
      { kind: 'PERMISSION', permission: 'runTests', accepts: ['UNIT', 'INTEGRATION'] },
      { kind: 'ENVIRONMENT', capability: 'tests' },
      { kind: 'INCIDENT', fact: 'CODE_INDEX' },
    ],
    selects: 'BY_VERIFICATION_KIND',
  },
  {
    id: 'strat-integration-test',
    name: "Lancer un test d'intégration ciblé (effets de bord possibles : approbation exigée)",
    category: 'VERIFICATION',
    applicableLayers: JAVA_LAYERS,
    depths: DEEP_ONLY,
    executionMode: 'APPROVAL_REQUIRED',
    estimatedCost: 15,
    estimatedRisk: 'HIGH',
    informationGain: 0.7,
    via: { experimentKind: 'INTEGRATION_TEST' },
    requirements: [
      { kind: 'PERMISSION', permission: 'runTests', accepts: ['INTEGRATION'] },
      { kind: 'ENVIRONMENT', capability: 'tests' },
      { kind: 'INCIDENT', fact: 'CODE_INDEX' },
    ],
    selects: 'BY_VERIFICATION_KIND',
  },
  {
    id: 'strat-logs-exception-trace',
    name: "Chercher l'exception et la requête en échec dans les journaux autorisés",
    category: 'EXCEPTION',
    applicableLayers: JAVA_LAYERS,
    depths: ALL_DEPTHS,
    executionMode: 'READ_ONLY',
    estimatedCost: 3,
    estimatedRisk: 'LOW',
    informationGain: 0.55,
    via: { experimentKind: 'INSPECT_LOGS' },
    requirements: [
      { kind: 'PERMISSION', permission: 'readLogs', accepts: [true] },
      { kind: 'ENVIRONMENT', capability: 'logs' },
    ],
    selects: 'BY_VERIFICATION_KIND',
  },
  {
    id: 'strat-alternative-explanation-search',
    name: 'Chercher une explication alternative que les règles ne prévoient pas',
    category: 'ALTERNATIVE',
    applicableLayers: [],
    depths: FROM_STANDARD,
    executionMode: 'READ_ONLY',
    estimatedCost: 6,
    estimatedRisk: 'LOW',
    informationGain: 0.5,
    via: { agent: 'HYPOTHESIS' },
    requirements: [
      { kind: 'INCIDENT', fact: 'HYPOTHESES' },
      { kind: 'TOOL', tool: 'get_incident_summary' },
    ],
    selects: 'ALL',
  },
  {
    id: 'strat-contradiction-hunt',
    name: 'Contester les conclusions : chercher ce qui contredit chaque hypothèse',
    category: 'ALTERNATIVE',
    applicableLayers: [],
    depths: FROM_STANDARD,
    executionMode: 'READ_ONLY',
    estimatedCost: 6,
    estimatedRisk: 'LOW',
    informationGain: 0.65,
    via: { agent: 'CONTRADICTION_HUNTER' },
    requirements: [
      { kind: 'INCIDENT', fact: 'OPEN_HYPOTHESES' },
      { kind: 'TOOL', tool: 'get_evidence' },
    ],
    selects: 'ALL_OPEN',
  },
  {
    id: 'strat-contributing-causes',
    name: 'Après une cause confirmée, chercher les causes contributives (validation, contrat, propagation)',
    category: 'ALTERNATIVE',
    applicableLayers: [],
    depths: DEEP_ONLY,
    executionMode: 'READ_ONLY',
    estimatedCost: 6,
    estimatedRisk: 'LOW',
    informationGain: 0.4,
    via: { agent: 'HYPOTHESIS' },
    requirements: [
      { kind: 'INCIDENT', fact: 'CONFIRMED_HYPOTHESIS' },
      { kind: 'TOOL', tool: 'get_incident_summary' },
    ],
    selects: 'SUPPORTED_OR_CONFIRMED',
  },
  {
    id: 'strat-denied-paths-review',
    name: 'Demander une extension de périmètre pour les chemins refusés qui bloquent la lecture',
    category: 'CODE',
    applicableLayers: CODE_LAYERS,
    depths: FROM_STANDARD,
    executionMode: 'APPROVAL_REQUIRED',
    estimatedCost: 1,
    estimatedRisk: 'LOW',
    informationGain: 0.3,
    via: { agent: 'PLANNER' },
    requirements: [
      { kind: 'INCIDENT', fact: 'DENIED_PATHS' },
      { kind: 'TOOL', tool: 'request_scope_extension' },
    ],
    selects: 'ALL_OPEN',
  },
];

/** Les entrées du catalogue qu'une profondeur inclut. */
export function catalogForDepth(depth: InvestigationDepth): StrategyTemplate[] {
  return STRATEGY_CATALOG.filter((template) => template.depths.includes(depth));
}

// ── Faits de l'incident et couches présentes ──────────────────────────────────────────────────

const DATABASE_SYMBOL_KINDS = new Set(['REPOSITORY', 'SQL_QUERY', 'TRANSACTION']);
const OPEN_HYPOTHESIS_STATUSES = new Set<Hypothesis['status']>([
  'PROPOSED',
  'INVESTIGATING',
  'SUPPORTED',
  'INCONCLUSIVE',
]);

/** Les couches dont une stratégie peut parler : celles des applications du périmètre, et DATABASE si le code en montre. */
export function presentLayers(incident: Incident): Set<StrategyLayer> {
  const layers = new Set<StrategyLayer>(incident.scope.applications.map((application) => application.layer));
  const code = incident.investigation.code;
  const graph = incident.investigation.graph;
  if (
    code?.symbols.some((symbol) => DATABASE_SYMBOL_KINDS.has(symbol.kind)) === true ||
    graph?.nodes.some((node) => node.kind === 'REPOSITORY') === true
  ) {
    layers.add('DATABASE');
  }
  return layers;
}

function failingRequests(incident: Incident) {
  return incident.investigation.reproductions.flatMap((reproduction) =>
    reproduction.requests.filter((request) => (request.status ?? 0) >= 400 || request.failure !== undefined),
  );
}

function hasException(incident: Incident): boolean {
  const investigation = incident.investigation;
  if (investigation.graph?.nodes.some((node) => node.kind === 'EXCEPTION') === true) return true;
  if (failingRequests(incident).some((request) => (request.status ?? 0) >= 500)) return true;
  return investigation.reproductions.some((reproduction) =>
    reproduction.evidence.some(
      (evidence) => evidence.kind === 'JS_ERROR' || /exception/i.test(evidence.summary),
    ),
  );
}

/** Un fait de l'incident est-il établi par ses données ? */
export function hasIncidentFact(incident: Incident, fact: IncidentFact): boolean {
  const investigation = incident.investigation;
  switch (fact) {
    case 'REPRODUCTION':
      return investigation.reproductions.some((reproduction) => reproduction.status === 'COMPLETED');
    case 'FAILING_REQUEST':
      return failingRequests(incident).length > 0;
    case 'PASSING_RUN':
      return investigation.reproductions.some(
        (reproduction) => reproduction.status === 'COMPLETED' && reproduction.reproduced === false,
      );
    case 'SECOND_SCENARIO': {
      const scenarios = new Set(incident.scope.scenarios);
      if (incident.scenario !== undefined) scenarios.delete(incident.scenario);
      return scenarios.size > 0 || hasIncidentFact(incident, 'PASSING_RUN');
    }
    case 'CODE_INDEX':
      return (investigation.code?.symbols.length ?? 0) > 0;
    case 'EXCEPTION':
      return hasException(incident);
    case 'HYPOTHESES':
      return investigation.hypotheses.length > 0;
    case 'OPEN_HYPOTHESES':
      return investigation.hypotheses.some((hypothesis) => OPEN_HYPOTHESIS_STATUSES.has(hypothesis.status));
    case 'CONFIRMED_HYPOTHESIS':
      return investigation.hypotheses.some((hypothesis) => hypothesis.status === 'CONFIRMED');
    case 'DENIED_PATHS':
      return (investigation.code?.denied.length ?? 0) > 0;
    case 'TIMELINE':
      return (
        (investigation.timeline?.length ?? 0) > 0 ||
        investigation.reproductions.some((reproduction) => reproduction.evidence.length > 0)
      );
  }
}

const FACT_LABELS: Record<IncidentFact, string> = {
  REPRODUCTION: 'une reproduction terminée',
  FAILING_REQUEST: 'une requête en échec observée',
  PASSING_RUN: 'une exécution qui aboutit (reproduction non reproduite)',
  SECOND_SCENARIO: 'un second scénario du périmètre (ou une exécution qui aboutit)',
  CODE_INDEX: 'une analyse du code (symboles indexés)',
  EXCEPTION: 'une exception observée (réponse 5xx, nœud EXCEPTION, erreur JavaScript)',
  HYPOTHESES: 'au moins une hypothèse',
  OPEN_HYPOTHESES: 'au moins une hypothèse non réfutée ni confirmée',
  CONFIRMED_HYPOTHESIS: 'une hypothèse CONFIRMED par le validateur déterministe',
  DENIED_PATHS: "des chemins refusés par le périmètre pendant l'analyse du code",
  TIMELINE: 'une chronologie ou des preuves de reproduction',
};

function describePrerequisite(requirement: StrategyRequirement): string {
  switch (requirement.kind) {
    case 'TOOL':
      return `outil ${requirement.tool} disponible`;
    case 'PERMISSION':
      return `permission ${requirement.permission} ∈ {${requirement.accepts.map(String).join(', ')}}`;
    case 'COMMAND':
      return `commande « ${requirement.command} » autorisée (allowedCommands)`;
    case 'ENVIRONMENT':
      return `capacité de l'environnement « ${requirement.capability} »`;
    case 'INCIDENT':
      return FACT_LABELS[requirement.fact];
  }
}

function describeCapability(requirement: StrategyRequirement): string | undefined {
  switch (requirement.kind) {
    case 'TOOL':
      return `tool:${requirement.tool}`;
    case 'PERMISSION':
      return `permission:${requirement.permission}=${requirement.accepts.map(String).join('|')}`;
    case 'COMMAND':
      return `command:${requirement.command}`;
    case 'ENVIRONMENT':
      return `environment:${requirement.capability}`;
    case 'INCIDENT':
      return undefined;
  }
}

function environmentAllows(
  capabilities: EnvironmentCapabilities,
  capability: 'tests' | 'logs' | 'repositories',
) {
  switch (capability) {
    case 'tests':
      return capabilities.tests;
    case 'logs':
      return capabilities.logs !== 'NONE';
    case 'repositories':
      return capabilities.repositories === 'LOCAL';
  }
}

/** Ce qui manque à une exigence, ou rien quand elle est satisfaite. */
export function missingRequirement(
  requirement: StrategyRequirement,
  ctx: Pick<DiscoveryContext, 'incident' | 'capabilities' | 'scopePermissions' | 'tools'>,
): string | undefined {
  switch (requirement.kind) {
    case 'TOOL':
      return ctx.tools.includes(requirement.tool)
        ? undefined
        : `outil ${requirement.tool} absent du registre`;
    case 'PERMISSION': {
      const value = ctx.scopePermissions[requirement.permission] ?? false;
      return requirement.accepts.includes(value)
        ? undefined
        : `permission ${requirement.permission} = ${String(value)} (attendu : ${requirement.accepts.map(String).join(' ou ')})`;
    }
    case 'COMMAND':
      return ctx.incident.scope.allowedCommands.includes(requirement.command)
        ? undefined
        : `commande « ${requirement.command} » absente de allowedCommands`;
    case 'ENVIRONMENT':
      if (ctx.capabilities === undefined) return "capacités de l'environnement inconnues (jamais supposées)";
      return environmentAllows(ctx.capabilities, requirement.capability)
        ? undefined
        : `l'environnement ne permet pas « ${requirement.capability} »`;
    case 'INCIDENT':
      return hasIncidentFact(ctx.incident, requirement.fact)
        ? undefined
        : `il manque ${FACT_LABELS[requirement.fact]}`;
  }
}

function selectHypotheses(template: StrategyTemplate, incident: Incident): string[] {
  const hypotheses = incident.investigation.hypotheses;
  const open = hypotheses.filter((hypothesis) => OPEN_HYPOTHESIS_STATUSES.has(hypothesis.status));
  switch (template.selects) {
    case 'NONE':
      return [];
    case 'ALL':
      return hypotheses.map((hypothesis) => hypothesis.id);
    case 'ALL_OPEN':
      return open.map((hypothesis) => hypothesis.id);
    case 'SUPPORTED_OR_CONFIRMED':
      return hypotheses
        .filter((hypothesis) => hypothesis.status === 'SUPPORTED' || hypothesis.status === 'CONFIRMED')
        .map((hypothesis) => hypothesis.id);
    case 'BY_LAYER': {
      const layers = new Set<string>(template.applicableLayers);
      return open
        .filter((hypothesis) => layers.size === 0 || layers.has(hypothesis.layer))
        .map((hypothesis) => hypothesis.id);
    }
    case 'BY_VERIFICATION_KIND': {
      const kind = template.via.experimentKind;
      return open
        .filter(
          (hypothesis) =>
            kind === undefined || hypothesis.verifications.some((verification) => verification.kind === kind),
        )
        .map((hypothesis) => hypothesis.id);
    }
  }
}

// ── Découverte ────────────────────────────────────────────────────────────────────────────────

interface Evaluation {
  status: StrategyStatus;
  reason?: string;
  prerequisites: string[];
  requiredCapabilities: string[];
}

function evaluate(
  template: Pick<StrategyTemplate, 'applicableLayers' | 'requirements'>,
  ctx: Pick<DiscoveryContext, 'incident' | 'capabilities' | 'scopePermissions' | 'tools'>,
  layers: Set<StrategyLayer>,
): Evaluation {
  const prerequisites = template.requirements.map(describePrerequisite);
  const requiredCapabilities = template.requirements
    .map(describeCapability)
    .filter((capability): capability is string => capability !== undefined);
  if (template.applicableLayers.length > 0 && !template.applicableLayers.some((layer) => layers.has(layer))) {
    return {
      status: 'NOT_APPLICABLE',
      reason: `aucune couche ${template.applicableLayers.join('/')} dans le périmètre`,
      prerequisites,
      requiredCapabilities,
    };
  }
  const missing = template.requirements
    .map((requirement) => missingRequirement(requirement, ctx))
    .filter((reason): reason is string => reason !== undefined);
  if (missing.length > 0) {
    return { status: 'BLOCKED', reason: missing.join(' ; '), prerequisites, requiredCapabilities };
  }
  return { status: 'AVAILABLE', prerequisites, requiredCapabilities };
}

/** En mode assisté, une personne lance les vérifications : une stratégie portée par une expérience attend son approbation. */
function executionModeFor(
  template: Pick<StrategyTemplate, 'executionMode' | 'via'>,
  mode: AiInvestigationMode,
) {
  if (mode === 'AI_ASSISTED' && template.via.experimentKind !== undefined) return 'APPROVAL_REQUIRED';
  return template.executionMode;
}

function instantiate(
  template: StrategyTemplate,
  ctx: DiscoveryContext,
  layers: Set<StrategyLayer>,
): InvestigationStrategy {
  const evaluation = evaluate(template, ctx, layers);
  return {
    id: template.id,
    name: template.name,
    category: template.category,
    applicableLayers: [...template.applicableLayers],
    prerequisites: evaluation.prerequisites,
    requiredCapabilities: evaluation.requiredCapabilities,
    estimatedCost: template.estimatedCost,
    estimatedRisk: template.estimatedRisk,
    expectedInformationGain: template.informationGain,
    executionMode: executionModeFor(template, ctx.mode),
    status: evaluation.status,
    ...(evaluation.reason !== undefined ? { reason: evaluation.reason } : {}),
    hypothesisIds: selectHypotheses(template, ctx.incident),
    via: { ...template.via },
    attempts: 0,
    outcomeRefs: [],
  };
}

/**
 * Ce que la mémoire sait déjà d'une stratégie décide de sa reprise : tentée (COMPLETED, FAILED, SKIPPED) ⇒ gardée
 * telle quelle, jamais AVAILABLE à nouveau sauf justification ; interrompue (RUNNING) ⇒ reprise ; bloquée ou non
 * applicable ⇒ réévaluée (le périmètre a pu changer).
 */
function reconcile(
  fresh: InvestigationStrategy,
  remembered: InvestigationStrategy | undefined,
  justify: Readonly<Record<string, string>> | undefined,
): InvestigationStrategy {
  if (remembered === undefined) return fresh;
  const carried = {
    attempts: remembered.attempts,
    outcomeRefs: [...remembered.outcomeRefs],
    ...(remembered.lastAttemptAt !== undefined ? { lastAttemptAt: remembered.lastAttemptAt } : {}),
  };
  const attempted =
    remembered.status === 'COMPLETED' || remembered.status === 'FAILED' || remembered.status === 'SKIPPED';
  if (!attempted) {
    if (remembered.status === 'RUNNING' && fresh.status === 'AVAILABLE') {
      return { ...fresh, ...carried, reason: 'interrompue avant sa fin : reprise' };
    }
    return { ...fresh, ...carried };
  }
  const justification = justify?.[fresh.id];
  if (justification !== undefined && fresh.status === 'AVAILABLE') {
    return { ...fresh, ...carried, reason: `reprise justifiée : ${justification}` };
  }
  if (fresh.status === 'AVAILABLE') {
    return {
      ...fresh,
      ...carried,
      status: remembered.status,
      reason: `déjà tentée (${remembered.status}) : non répétée sans justification`,
    };
  }
  return {
    ...fresh,
    ...carried,
    status: remembered.status,
    ...(remembered.reason ? { reason: remembered.reason } : {}),
  };
}

/**
 * Découvre les stratégies pour un incident : le catalogue de la profondeur, chaque entrée évaluée (applicabilité
 * par couche, préconditions ⇒ BLOCKED avec la raison), réconciliée avec la mémoire (jamais répétée sans
 * justification), puis les stratégies dérivées que la mémoire porte déjà. Rien ne tourne en DETERMINISTIC ni dans
 * une combinaison profondeur/mode que `DEPTH_MODES` ne permet pas : la liste est vide.
 */
export function discoverStrategies(ctx: DiscoveryContext): InvestigationStrategy[] {
  if (ctx.mode === 'DETERMINISTIC' || !DEPTH_MODES[ctx.depth].includes(ctx.mode)) return [];
  const layers = presentLayers(ctx.incident);
  const remembered = new Map((ctx.memory?.strategies ?? []).map((strategy) => [strategy.id, strategy]));
  const catalog = catalogForDepth(ctx.depth).map((template) =>
    reconcile(instantiate(template, ctx, layers), remembered.get(template.id), ctx.justify),
  );
  const catalogIds = new Set(catalog.map((strategy) => strategy.id));
  const derived = [...remembered.values()]
    .filter((strategy) => !catalogIds.has(strategy.id))
    .map((strategy) => {
      const evaluation = evaluate(
        { applicableLayers: strategy.applicableLayers, requirements: requirementsOf(strategy) },
        ctx,
        layers,
      );
      const fresh: InvestigationStrategy = {
        ...strategy,
        status: evaluation.status,
        executionMode: executionModeFor(strategy, ctx.mode),
        outcomeRefs: [...strategy.outcomeRefs],
        ...(evaluation.reason !== undefined ? { reason: evaluation.reason } : {}),
      };
      if (evaluation.reason === undefined) delete fresh.reason;
      return reconcile(fresh, strategy, ctx.justify);
    });
  return [...catalog, ...derived].slice(0, MAX_STRATEGIES);
}

/** Les exigences qu'une stratégie dérivée porte dans `requiredCapabilities` (les faits de l'incident n'y sont pas). */
function requirementsOf(strategy: InvestigationStrategy): StrategyRequirement[] {
  const requirements: StrategyRequirement[] = [];
  for (const capability of strategy.requiredCapabilities) {
    const [kind, rest] = splitOnce(capability, ':');
    if (rest === undefined) continue;
    if (kind === 'tool') requirements.push({ kind: 'TOOL', tool: rest as InvestigationToolName });
    else if (kind === 'command') requirements.push({ kind: 'COMMAND', command: rest });
    else if (kind === 'environment' && (rest === 'tests' || rest === 'logs' || rest === 'repositories')) {
      requirements.push({ kind: 'ENVIRONMENT', capability: rest });
    } else if (kind === 'permission') {
      const [permission, values] = splitOnce(rest, '=');
      requirements.push({
        kind: 'PERMISSION',
        permission: permission as keyof ScopePermissions,
        accepts: (values ?? 'true')
          .split('|')
          .map((value) => (value === 'true' ? true : value === 'false' ? false : value)),
      });
    }
  }
  return requirements;
}

function splitOnce(text: string, separator: string): [string, string | undefined] {
  const index = text.indexOf(separator);
  return index < 0 ? [text, undefined] : [text.slice(0, index), text.slice(index + separator.length)];
}

// ── Priorisation ──────────────────────────────────────────────────────────────────────────────

/** La contradiction qu'une catégorie de stratégie peut trancher. */
const CATEGORY_RESOLVES: Record<StrategyCategory, readonly ContradictionKind[]> = {
  EVIDENCE: ['MISSING_EVIDENCE', 'EARLIER_ERROR'],
  CODE: ['INCOMPATIBLE_CODE_PATH'],
  CONTRACT: ['INCOMPATIBLE_CODE_PATH', 'REFUTING_EVIDENCE'],
  DATA: ['ALTERNATIVE_EXPLANATION', 'REFUTING_EVIDENCE'],
  CONFIGURATION: ['ENVIRONMENT_DIFFERENCE'],
  HISTORY: ['ALTERNATIVE_EXPLANATION'],
  COMPARISON: ['PASSING_SCENARIO', 'ENVIRONMENT_DIFFERENCE', 'REFUTING_EVIDENCE'],
  EXCEPTION: ['LOG_TRACE_MISMATCH', 'EARLIER_ERROR'],
  ALTERNATIVE: ['ALTERNATIVE_EXPLANATION', 'MISSING_EVIDENCE'],
  VERIFICATION: ['REFUTING_EVIDENCE', 'PASSING_SCENARIO', 'INCOMPATIBLE_CODE_PATH'],
};

const UNDECIDED_ROLES = new Set<HypothesisExploration['role']>([
  'UNVERIFIED',
  'UNKNOWN',
  'PROBABLE_CAUSE',
  'CONTRIBUTING_FACTOR',
]);
const STATUS_ORDER: Record<StrategyStatus, number> = {
  AVAILABLE: 0,
  RUNNING: 1,
  BLOCKED: 2,
  SKIPPED: 3,
  NOT_APPLICABLE: 4,
  COMPLETED: 5,
  FAILED: 6,
};
const MODE_ORDER: Record<StrategyExecutionMode, number> = { READ_ONLY: 0, SANDBOX: 1, APPROVAL_REQUIRED: 2 };
const RISK_ORDER: Record<RiskLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

/**
 * Le gain ajusté d'une stratégie : son gain de base, plus ce qu'elle départage (hypothèses encore indécises
 * qu'elle vise, au-delà de la première), plus les contradictions ouvertes qu'elle peut trancher ; réduit quand
 * elle ne vise que des hypothèses réfutées. Toujours dans [0, 1].
 */
export function informationGainOf(
  strategy: InvestigationStrategy,
  explorations: readonly HypothesisExploration[],
  contradictions: readonly AiContradiction[],
): number {
  const roles = new Map(explorations.map((exploration) => [exploration.hypothesisId, exploration.role]));
  const targeted = strategy.hypothesisIds;
  const undecided = targeted.filter((id) => UNDECIDED_ROLES.has(roles.get(id) ?? 'UNKNOWN')).length;
  const refutedOnly = targeted.length > 0 && targeted.every((id) => roles.get(id) === 'REFUTED');
  const split = Math.min(MAX_SPLIT_GAIN, Math.max(0, undecided - 1) * SPLIT_GAIN);
  const resolves = CATEGORY_RESOLVES[strategy.category];
  const targetedSet = new Set(targeted);
  const open = contradictions.filter(
    (contradiction) =>
      contradiction.status === 'OPEN' &&
      resolves.includes(contradiction.kind) &&
      (targetedSet.size === 0 || targetedSet.has(contradiction.hypothesisId)),
  ).length;
  const resolved = Math.min(MAX_CONTRADICTION_GAIN, open * CONTRADICTION_GAIN);
  const base = refutedOnly
    ? strategy.expectedInformationGain * REFUTED_ONLY_FACTOR
    : strategy.expectedInformationGain;
  return Math.min(1, Math.max(0, base + split + resolved));
}

/**
 * Classe les stratégies : les disponibles d'abord ; parmi elles, le gain ajusté (au dixième près, pour que le
 * risque et le coût départagent des gains voisins), puis la lecture seule avant le bac à sable avant l'approbation,
 * puis le risque le plus faible, puis le coût le plus bas, puis l'identifiant (ordre stable). Rend des copies.
 */
export function prioritizeStrategies(
  strategies: readonly InvestigationStrategy[],
  explorations: readonly HypothesisExploration[],
  contradictions: readonly AiContradiction[],
): ScoredStrategy[] {
  const scored: ScoredStrategy[] = strategies.map((strategy) => ({
    ...strategy,
    applicableLayers: [...strategy.applicableLayers],
    hypothesisIds: [...strategy.hypothesisIds],
    outcomeRefs: [...strategy.outcomeRefs],
    via: { ...strategy.via },
    score: informationGainOf(strategy, explorations, contradictions),
  }));
  return scored.sort(
    (left, right) =>
      STATUS_ORDER[left.status] - STATUS_ORDER[right.status] ||
      Math.round(right.score * 10) - Math.round(left.score * 10) ||
      MODE_ORDER[left.executionMode] - MODE_ORDER[right.executionMode] ||
      RISK_ORDER[left.estimatedRisk] - RISK_ORDER[right.estimatedRisk] ||
      left.estimatedCost - right.estimatedCost ||
      right.score - left.score ||
      left.id.localeCompare(right.id),
  );
}

/** La prochaine stratégie à tenter : la première AVAILABLE dont le gain ajusté atteint le seuil ; sinon rien. */
export function nextStrategy(
  strategies: readonly InvestigationStrategy[],
  explorations: readonly HypothesisExploration[],
  contradictions: readonly AiContradiction[],
  options: { gainThreshold?: number; executionModes?: readonly StrategyExecutionMode[] } = {},
): ScoredStrategy | undefined {
  const threshold = options.gainThreshold ?? 0;
  const modes = options.executionModes;
  return prioritizeStrategies(strategies, explorations, contradictions).find(
    (strategy) =>
      strategy.status === 'AVAILABLE' &&
      strategy.score >= threshold &&
      (modes === undefined || modes.includes(strategy.executionMode)),
  );
}

// ── Stratégies dérivées ───────────────────────────────────────────────────────────────────────

interface DerivedTemplate {
  slug: string;
  name: (contradiction: AiContradiction) => string;
  category: StrategyCategory;
  informationGain: number;
  via: (layer: string | undefined) => InvestigationStrategy['via'];
  executionMode: StrategyExecutionMode;
  estimatedCost: number;
  estimatedRisk: RiskLevel;
  requirements: readonly StrategyRequirement[];
}

function layerAgent(layer: string | undefined): AiAgentName {
  if (layer === 'FRONTEND') return 'FRONTEND';
  if (layer === 'BFF') return 'BFF';
  return 'BACKEND';
}

const CONTRADICTION_TEMPLATES: Record<ContradictionKind, DerivedTemplate> = {
  PASSING_SCENARIO: {
    slug: 'compare-passing',
    name: (c) => `Comparer le scénario qui aboutit à l'échec pour ${c.hypothesisId}`,
    category: 'COMPARISON',
    informationGain: 0.75,
    via: () => ({ experimentKind: 'COMPARE_WITH_PASSING' }),
    executionMode: 'SANDBOX',
    estimatedCost: 10,
    estimatedRisk: 'MEDIUM',
    requirements: [NAVIGATE, { kind: 'INCIDENT', fact: 'SECOND_SCENARIO' }],
  },
  INCOMPATIBLE_CODE_PATH: {
    slug: 'trace-code-path',
    name: (c) => `Suivre le chemin de code réel contesté pour ${c.hypothesisId}`,
    category: 'CODE',
    informationGain: 0.65,
    via: (layer) => ({ agent: layerAgent(layer) }),
    executionMode: 'READ_ONLY',
    estimatedCost: 5,
    estimatedRisk: 'LOW',
    requirements: [
      READ_SOURCES,
      { kind: 'TOOL', tool: 'read_source' },
      { kind: 'TOOL', tool: 'find_references' },
    ],
  },
  REFUTING_EVIDENCE: {
    slug: 'decisive-verification',
    name: (c) => `Trancher la preuve contraire par une vérification décisive pour ${c.hypothesisId}`,
    category: 'VERIFICATION',
    informationGain: 0.7,
    via: () => ({ agent: 'EXPERIMENT_GENERATION' }),
    executionMode: 'READ_ONLY',
    estimatedCost: 6,
    estimatedRisk: 'LOW',
    requirements: [{ kind: 'INCIDENT', fact: 'OPEN_HYPOTHESES' }],
  },
  EARLIER_ERROR: {
    slug: 'earlier-error',
    name: (c) => `Examiner l'erreur antérieure qui précède le symptôme (${c.hypothesisId})`,
    category: 'EVIDENCE',
    informationGain: 0.6,
    via: () => ({ agent: 'EVIDENCE_ANALYSIS' }),
    executionMode: 'READ_ONLY',
    estimatedCost: 3,
    estimatedRisk: 'LOW',
    requirements: [{ kind: 'TOOL', tool: 'get_evidence' }],
  },
  ENVIRONMENT_DIFFERENCE: {
    slug: 'environment-difference',
    name: (c) => `Relire la configuration pour la différence d'environnement contestée (${c.hypothesisId})`,
    category: 'CONFIGURATION',
    informationGain: 0.5,
    via: (layer) => ({ agent: layerAgent(layer) }),
    executionMode: 'READ_ONLY',
    estimatedCost: 5,
    estimatedRisk: 'LOW',
    requirements: [
      READ_SOURCES,
      { kind: 'TOOL', tool: 'search_code' },
      { kind: 'TOOL', tool: 'read_source' },
    ],
  },
  LOG_TRACE_MISMATCH: {
    slug: 'log-trace-mismatch',
    name: (c) => `Rapprocher journaux et trace pour l'écart signalé (${c.hypothesisId})`,
    category: 'EXCEPTION',
    informationGain: 0.55,
    via: () => ({ experimentKind: 'INSPECT_LOGS' }),
    executionMode: 'READ_ONLY',
    estimatedCost: 3,
    estimatedRisk: 'LOW',
    requirements: [
      { kind: 'PERMISSION', permission: 'readLogs', accepts: [true] },
      { kind: 'ENVIRONMENT', capability: 'logs' },
    ],
  },
  MISSING_EVIDENCE: {
    slug: 'collect-missing-evidence',
    name: (c) => `Rassembler la preuve manquante signalée pour ${c.hypothesisId}`,
    category: 'EVIDENCE',
    informationGain: 0.6,
    via: () => ({ agent: 'EVIDENCE_ANALYSIS' }),
    executionMode: 'READ_ONLY',
    estimatedCost: 4,
    estimatedRisk: 'LOW',
    requirements: [
      { kind: 'TOOL', tool: 'get_evidence' },
      { kind: 'TOOL', tool: 'get_request' },
    ],
  },
  ALTERNATIVE_EXPLANATION: {
    slug: 'explore-alternative',
    name: (c) => `Explorer l'explication alternative opposée à ${c.hypothesisId}`,
    category: 'ALTERNATIVE',
    informationGain: 0.6,
    via: () => ({ agent: 'HYPOTHESIS' }),
    executionMode: 'READ_ONLY',
    estimatedCost: 6,
    estimatedRisk: 'LOW',
    requirements: [{ kind: 'TOOL', tool: 'get_incident_summary' }],
  },
};

/** Le gain d'une stratégie née d'une question ouverte (aucune preuve ne la porte encore) est réduit d'autant. */
const OPEN_QUESTION_FACTOR = 0.8;

function layerOf(hypothesisId: string, incident: Incident | undefined): string | undefined {
  return incident?.investigation.hypotheses.find((hypothesis) => hypothesis.id === hypothesisId)?.layer;
}

function strategyLayers(layer: string | undefined): StrategyLayer[] {
  return layer === 'FRONTEND' || layer === 'BFF' || layer === 'BACKEND' || layer === 'DATABASE'
    ? [layer]
    : [];
}

function build(
  id: string,
  name: string,
  template: Pick<
    DerivedTemplate,
    'category' | 'executionMode' | 'estimatedCost' | 'estimatedRisk' | 'requirements'
  >,
  via: InvestigationStrategy['via'],
  gain: number,
  hypothesisIds: string[],
  layers: StrategyLayer[],
  ctx: DiscoveryContext | undefined,
): InvestigationStrategy {
  const evaluation = ctx
    ? evaluate(
        { applicableLayers: layers, requirements: template.requirements },
        ctx,
        presentLayers(ctx.incident),
      )
    : {
        status: 'AVAILABLE' as const,
        prerequisites: template.requirements.map(describePrerequisite),
        requiredCapabilities: template.requirements
          .map(describeCapability)
          .filter((capability): capability is string => capability !== undefined),
      };
  return {
    id,
    name,
    category: template.category,
    applicableLayers: layers,
    prerequisites: evaluation.prerequisites,
    requiredCapabilities: evaluation.requiredCapabilities,
    estimatedCost: template.estimatedCost,
    estimatedRisk: template.estimatedRisk,
    expectedInformationGain: Math.min(1, Math.max(0, gain)),
    executionMode: ctx
      ? executionModeFor({ executionMode: template.executionMode, via }, ctx.mode)
      : template.executionMode,
    status: evaluation.status,
    ...('reason' in evaluation && evaluation.reason !== undefined ? { reason: evaluation.reason } : {}),
    hypothesisIds,
    via,
    attempts: 0,
    outcomeRefs: [],
  };
}

/**
 * Dérive de nouvelles stratégies des résultats : une par contradiction OUVERTE (selon sa nature : comparer le
 * scénario qui aboutit, suivre le chemin de code contesté, trancher par une vérification, examiner l'erreur
 * antérieure, relire la configuration, rapprocher journaux et trace, rassembler la preuve manquante, explorer
 * l'alternative) ; une par découverte seulement déduite (INFERRED) rattachée à une hypothèse (l'établir dans le
 * code) ; une par découverte rattachée à aucune hypothèse (juger si elle explique le symptôme). Identifiants
 * déterministes (`strat-derived-<nature>:<id>`) : rien n'est redérivé de ce que `existing` contient déjà ; au plus
 * MAX_DERIVED_STRATEGIES par appel. Avec `ctx`, les préconditions sont évaluées comme pour le catalogue.
 */
export function deriveStrategies(
  fromFindings: readonly AiFinding[],
  fromContradictions: readonly AiContradiction[],
  options: { existing?: readonly InvestigationStrategy[]; ctx?: DiscoveryContext } = {},
): InvestigationStrategy[] {
  const known = new Set((options.existing ?? []).map((strategy) => strategy.id));
  const incident = options.ctx?.incident;
  const derived: InvestigationStrategy[] = [];
  const add = (strategy: InvestigationStrategy) => {
    if (known.has(strategy.id) || derived.length >= MAX_DERIVED_STRATEGIES) return;
    known.add(strategy.id);
    derived.push(strategy);
  };
  for (const contradiction of fromContradictions) {
    if (contradiction.status !== 'OPEN') continue;
    const template = CONTRADICTION_TEMPLATES[contradiction.kind];
    const layer = layerOf(contradiction.hypothesisId, incident);
    const gain = contradiction.openQuestion
      ? template.informationGain * OPEN_QUESTION_FACTOR
      : template.informationGain;
    add(
      build(
        `${DERIVED_STRATEGY_PREFIX}${template.slug}:${contradiction.hypothesisId}`,
        template.name(contradiction),
        template,
        template.via(layer),
        gain,
        [contradiction.hypothesisId],
        strategyLayers(layer),
        options.ctx,
      ),
    );
  }
  for (const finding of fromFindings) {
    const layers = strategyLayers(finding.layer);
    if (finding.hypothesisId !== undefined) {
      if (finding.basis !== 'INFERRED') continue;
      add(
        build(
          `${DERIVED_STRATEGY_PREFIX}establish-finding:${finding.id}`,
          `Établir dans le code la découverte déduite « ${finding.title} » (${finding.hypothesisId})`,
          {
            category: 'VERIFICATION',
            executionMode: 'READ_ONLY',
            estimatedCost: 4,
            estimatedRisk: 'LOW',
            requirements: [READ_SOURCES, { kind: 'TOOL', tool: 'read_source' }],
          },
          { agent: layerAgent(finding.layer) },
          0.55,
          [finding.hypothesisId],
          layers,
          options.ctx,
        ),
      );
      continue;
    }
    add(
      build(
        `${DERIVED_STRATEGY_PREFIX}assess-finding:${finding.id}`,
        `Juger si la découverte « ${finding.title} » explique le symptôme (hypothèse alternative)`,
        {
          category: 'ALTERNATIVE',
          executionMode: 'READ_ONLY',
          estimatedCost: 5,
          estimatedRisk: 'LOW',
          requirements: [{ kind: 'TOOL', tool: 'get_incident_summary' }],
        },
        { agent: 'HYPOTHESIS' },
        0.5,
        [],
        layers,
        options.ctx,
      ),
    );
  }
  return derived;
}

// ── Enregistrement ────────────────────────────────────────────────────────────────────────────

/** Marque une stratégie RUNNING (une tentative commence) ; les autres sont rendues telles quelles. Copie. */
export function markStrategyRunning(
  strategies: readonly InvestigationStrategy[],
  strategyId: string,
  at: string,
): InvestigationStrategy[] {
  return strategies.map((strategy) =>
    strategy.id === strategyId
      ? { ...strategy, status: 'RUNNING', lastAttemptAt: at, outcomeRefs: [...strategy.outcomeRefs] }
      : strategy,
  );
}

/**
 * Enregistre ce qu'une tentative a donné : le statut, la date, les références de résultat (dédoublonnées), la
 * raison ; COMPLETED et FAILED comptent une tentative. Une stratégie inconnue laisse la liste inchangée. Copie.
 */
export function recordStrategyOutcome(
  strategies: readonly InvestigationStrategy[],
  strategyId: string,
  outcome: StrategyOutcome,
): InvestigationStrategy[] {
  return strategies.map((strategy) => {
    if (strategy.id !== strategyId) return strategy;
    const seen = new Set(strategy.outcomeRefs.map((ref) => `${ref.kind}:${ref.id}`));
    const added = (outcome.refs ?? []).filter((ref) => {
      const key = `${ref.kind}:${ref.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const counts = outcome.status === 'COMPLETED' || outcome.status === 'FAILED';
    const updated: InvestigationStrategy = {
      ...strategy,
      status: outcome.status,
      attempts: strategy.attempts + (counts ? 1 : 0),
      lastAttemptAt: outcome.at,
      outcomeRefs: [...strategy.outcomeRefs, ...added.map((ref) => ({ ...ref }))],
    };
    if (outcome.reason !== undefined) updated.reason = outcome.reason;
    else delete updated.reason;
    return updated;
  });
}

/** Les stratégies encore disponibles (pour `remaining[]` de la mémoire et la politique d'arrêt). */
export function availableStrategies(strategies: readonly InvestigationStrategy[]): InvestigationStrategy[] {
  return strategies.filter((strategy) => strategy.status === 'AVAILABLE');
}

export type { ExperimentKind as StrategyExperimentKind };
