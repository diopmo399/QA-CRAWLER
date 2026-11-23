import type { MapConfidence, MapLayer, MapPage } from './cartography.js';

/**
 * RISK & ANOMALY DETECTION ENGINE — les contrats. Un risque est une HYPOTHÈSE étayée par des preuves, jamais
 * une anomalie affirmée : son statut dit jusqu'où il a été vérifié, sa confiance (0 à 1) dit la force des
 * preuves, et sa sévérité (indépendante de la confiance) dit la gravité s'il se réalise. Aucune règle
 * n'appelle un modèle de langage : faits lus dans l'AST, liens du graphe de la cartographie, simulations.
 */

/** Version du moteur : un rapport d'une autre version est recalculé (les règles ont pu changer). */
export const RISK_ENGINE = 'risk-engine-1';

/**
 * POTENTIAL : un motif est vu, toutes les conditions ne sont pas prouvées. CORROBORATED : plusieurs preuves
 * indépendantes et un chemin plausible. REPRODUCED : un test ou une exécution contrôlée a reproduit le
 * comportement. REFUTED : une vérification valide montre qu'il ne se produit pas DANS LES CONDITIONS
 * TESTÉES (jamais une garantie d'absence). INCONCLUSIVE : les preuves ne permettent pas de conclure.
 */
export const RISK_STATUSES = ['POTENTIAL', 'CORROBORATED', 'REPRODUCED', 'REFUTED', 'INCONCLUSIVE'] as const;
export type RiskStatus = (typeof RISK_STATUSES)[number];

export const RISK_SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;
export type RiskSeverity = (typeof RISK_SEVERITIES)[number];

/** État partagé, traitements asynchrones, nettoyage des ressources, reprise après erreur, couches Java. */
export const RISK_CATEGORIES = ['STATE', 'ASYNC', 'CLEANUP', 'ERROR', 'BACKEND'] as const;
export type RiskCategory = (typeof RISK_CATEGORIES)[number];

/**
 * Une preuve : ce qui a été lu, où, comment, avec quelle fiabilité, et ce qu'elle fait à l'hypothèse
 * (la soutient, l'affaiblit, ou la situe seulement).
 */
export interface RiskEvidence {
  kind: 'STATIC_FACT' | 'GRAPH_LINK' | 'ABSENCE' | 'SIMULATION' | 'TEST_RESULT' | 'DECLARATION';
  /** La source de la cartographie (id) ; absente pour une preuve du moteur lui-même (simulation). */
  source?: string;
  file?: string;
  line?: number;
  /** Méthode de collecte : « AST TypeScript », « graphe de la cartographie », « simulation des transitions »… */
  method: string;
  reliability: 'HIGH' | 'MEDIUM' | 'LOW';
  relation: 'SUPPORTS' | 'WEAKENS' | 'CONTEXT';
  text: string;
}

/** Un nœud du graphe d'impact d'un risque (repris du graphe de la cartographie quand il y existe). */
export interface RiskImpactNode {
  id: string;
  name: string;
  /** SOURCE (origine du risque), DATA (donnée concernée), STATE (traitement ou état affecté), CONSUMER
   * (composant, méthode, condition qui lit), FEATURE (fonctionnalité impactée), DOWNSTREAM (appel, couche aval). */
  role: 'SOURCE' | 'DATA' | 'STATE' | 'CONSUMER' | 'FEATURE' | 'DOWNSTREAM';
  layer?: MapLayer;
  /** Profondeur depuis la source (0 = la source). */
  depth: number;
  /** Il reste des voisins non affichés (développer ce nœud). */
  more?: number;
}

/**
 * Un lien du graphe d'impact. PROVEN : relation confirmée par le code ; INFERRED : probable ; UNCERTAIN : non
 * démontrée ; TESTED : chemin rejoué par une vérification ; REFUTED : chemin écarté par une vérification.
 */
export interface RiskImpactEdge {
  from: string;
  to: string;
  link: 'PROVEN' | 'INFERRED' | 'UNCERTAIN' | 'TESTED' | 'REFUTED';
  reason: string;
  /** La condition qui doit être vraie pour que l'impact passe (lue dans le code, jamais évaluée). */
  condition?: string;
}

export interface RiskImpact {
  nodes: RiskImpactNode[];
  edges: RiskImpactEdge[];
  /** Les frontières : liens écartés parce qu'ils ne propagent pas la donnée (structure seule, erreur…). */
  blocked: string[];
  /** Exploration bornée atteinte (profondeur ou nombre de nœuds). */
  truncated: boolean;
  /** Nœuds visités pour la calculer. */
  explored: number;
}

export interface RiskFeature {
  id: string;
  name: string;
  /** Comment la fonctionnalité atteint la donnée (le plus faible lien du chemin). */
  confidence: MapConfidence;
  /** Atteinte par un consommateur direct, ou seulement plus loin dans le graphe. */
  direct: boolean;
}

/**
 * Une vérification ciblée. STATE_SIMULATION : les transitions de la donnée rejouées sur les faits lus (aucun
 * code de l'application exécuté) ; EXTERNAL_TEST : le résultat d'un test ciblé exécuté hors du serveur (dans
 * le projet), déclaré avec son auteur. Le test proposé est fourni pour être exécuté là.
 */
export interface RiskVerification {
  id: string;
  at: string;
  method: 'STATE_SIMULATION' | 'EXTERNAL_TEST';
  outcome: RiskStatus;
  /** Les étapes jouées (simulation) ou décrites (test externe). */
  steps: string[];
  observed: string;
  /** L'attendu métier : jamais déduit du code ; inconnu, le résultat reste inconclusif. */
  expected?: string;
  note?: string;
  by?: string;
  durationMs: number;
  /** L'empreinte du risque au moment de la vérification : si le code a changé depuis, elle est périmée. */
  fingerprint?: string;
  /** Périmée : le risque a changé depuis (le résultat ne compte plus pour son statut). */
  stale?: boolean;
}

/** Les transitions que la vérification ciblée rejoue (données lues dans les faits, aucun code exécuté). */
export interface RiskScenario {
  kind: 'STALE_STATE' | 'LOADING_FLAG' | 'BROKEN_CHAIN' | 'SUBSCRIPTION_LEAK' | 'STALE_RESPONSE';
  subject: string;
  writer?: string;
  reader?: string;
  trigger?: string;
  source?: string;
  /** Le lecteur écrit la donnée avant de la lire (la simulation le montre : réfuté). */
  readerWritesFirst?: boolean;
}

/** Une suppression justifiée (faux positif, comportement voulu) : tracée, réversible. */
export interface RiskSuppression {
  by: string;
  at: string;
  reason: string;
}

export interface Risk {
  /** Stable d'un scan à l'autre : règle, source, entité, ancre (méthode ou membre) — jamais une ligne. */
  id: string;
  ruleId: string;
  category: RiskCategory;
  /** POSSIBLE_STALE_STATE, LOADING_STUCK_AFTER_ERROR… */
  type: string;
  title: string;
  description: string;
  /** La cause technique suspectée. */
  cause: string;
  /** L'entité source (`ClientStore.selectedClient`, `OrderComponent#save`). */
  entity: string;
  /** Le nœud du graphe de la cartographie qui la représente, quand il existe. */
  node?: string;
  layer: MapLayer;
  sourceId: string;
  file: string;
  line: number;
  /** Ce qui déclenche le risque. */
  trigger: string;
  /** Les conditions nécessaires pour qu'il se réalise. */
  conditions: string[];
  /** Le chemin de propagation, du plus proche au plus loin (noms lisibles). */
  propagation: string[];
  affectedFeatures: RiskFeature[];
  evidence: RiskEvidence[];
  /** Ce que la règle suppose sans l'avoir prouvé. */
  assumptions: string[];
  /** Ce que l'analyse n'a pas pu établir. */
  unknowns: string[];
  /** Les limites de la règle elle-même. */
  limits: string[];
  severity: RiskSeverity;
  /** 0..1, calculée par `riskConfidence` (règles documentées), séparée de la sévérité. */
  confidence: number;
  /** Comment la confiance a été obtenue (chaque terme). */
  confidenceWhy: string[];
  status: RiskStatus;
  suggestion?: string;
  /** Une vérification ciblée est possible (simulation sur les faits). */
  verifiable: boolean;
  /** Le test ciblé proposé (à exécuter dans le projet), quand la règle en fournit un. */
  testPlan?: string[];
  verifications: RiskVerification[];
  suppressed?: RiskSuppression;
  /** Empreinte des preuves et conditions : sert à comparer deux scans et à périmer une vérification. */
  fingerprint: string;
  scenario?: RiskScenario;
  /** Le graphe d'impact par défaut (borné) ; absent des listes, développable par l'API. */
  impact?: RiskImpact;
  /** Premier scan où il a été vu ; NEW / UNCHANGED / CHANGED face au scan précédent. */
  firstSeen: string;
  change?: 'NEW' | 'UNCHANGED' | 'CHANGED';
}

export interface RiskRuleInfo {
  id: string;
  category: RiskCategory;
  severity: RiskSeverity;
  type: string;
  title: string;
  description: string;
  /** Les faits nécessaires (sans eux, la règle ne conclut pas). */
  prerequisites: string[];
  layers: MapLayer[];
  enabled: boolean;
}

export interface RiskMetrics {
  durationMs: number;
  sources: number;
  /** Sources dont les faits de risque manquent (scan antérieur au moteur : relancer un scan). */
  sourcesWithoutFacts: string[];
  filesExamined: number;
  rulesRun: number;
  risks: number;
  pathsExplored: number;
  /** Sources dont les faits ont été repris du scan précédent (inchangées), sur le total. */
  reusedSources: number;
  verificationsMs: number;
}

export interface RiskReport {
  schema: 1;
  engine: string;
  scanId: string;
  generatedAt: string;
  previousScanId?: string;
  /** Le scan et l'état des décisions d'où vient ce rapport (un changement le fait recalculer). */
  stateKey?: string;
  rules: RiskRuleInfo[];
  risks: Risk[];
  /** Risques du scan précédent qui n'apparaissent plus (identifiants). */
  resolved: string[];
  metrics: RiskMetrics;
}

/** Les comptes de la vue principale. */
export interface RiskSummary {
  scanId: string;
  previousScanId?: string;
  total: number;
  critical: number;
  corroborated: number;
  reproduced: number;
  suppressed: number;
  features: number;
  byCategory: Partial<Record<RiskCategory, number>>;
  byLayer: Partial<Record<MapLayer, number>>;
  byStatus: Partial<Record<RiskStatus, number>>;
  bySeverity: Partial<Record<RiskSeverity, number>>;
  /** Face au scan précédent. */
  diff?: { added: number; resolved: number; unchanged: number };
  metrics: RiskMetrics;
  rules: RiskRuleInfo[];
}

export interface RiskQuery {
  q?: string;
  category?: RiskCategory;
  severity?: RiskSeverity;
  status?: RiskStatus;
  layer?: MapLayer;
  feature?: string;
  source?: string;
  /** Confiance minimale (0..1). */
  minConfidence?: number;
  /** Inclure les risques supprimés (exclus par défaut). */
  suppressed?: boolean;
  scan?: string;
  page?: number;
  size?: number;
}

export interface RiskPage extends MapPage<Risk> {
  summary: RiskSummary;
}

/** Une demande de vérification : simulation sur les faits, ou résultat d'un test exécuté dans le projet. */
export interface RiskVerifyInput {
  method?: 'STATE_SIMULATION' | 'EXTERNAL_TEST';
  /** EXTERNAL_TEST : le résultat constaté (REPRODUCED ou REFUTED) et ce qui a été observé. */
  outcome?: 'REPRODUCED' | 'REFUTED' | 'INCONCLUSIVE';
  observed?: string;
  /** L'attendu métier, quand il est connu (jamais déduit du code). */
  expected?: string;
  note?: string;
}

/** Une suppression (ou sa levée : `reason` vide), avec sa justification. */
export interface RiskSuppressInput {
  reason: string;
}

/** Les réglages des règles : activées ou non, une par une. */
export interface RiskRulesInput {
  disabled: string[];
}
