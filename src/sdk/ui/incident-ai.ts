import type {
  AiAgentName,
  AiAgentStatus,
  AiCapabilities,
  AiExperimentProposal,
  AiFinding,
  AiInvestigationMode,
  AiInvestigationRun,
  AiRef,
  AiRunStatus,
  AiSourceLocation,
  CoverageEntry,
  GeneratedExperiment,
  Hypothesis,
  HypothesisExploration,
  Incident,
  InvestigationDepth,
  InvestigationMemory,
  InvestigationStrategy,
} from '../core/incident-contracts.js';
import { AI_INVESTIGATION_MODES, DEPTH_MODES, INVESTIGATION_DEPTHS } from '../core/incident-contracts.js';
import { formatDate, icon } from './dashboard-parts.js';
import type { SelectionKind } from './incident-links.js';
import { SELECTION_KINDS } from './incident-links.js';
import {
  panelState,
  selectable,
  selectionClass,
  sourceLink,
  type Lang,
  type WorkspaceContext,
} from './incident-parts.js';
import { esc } from './view.js';

/**
 * L'INVESTIGATION IA DANS L'ESPACE D'INVESTIGATION (sous-onglet Diagnostic › Investigation IA) : le mode
 * (DETERMINISTIC par défaut, IA assistée, IA agentique) et la profondeur (QUICK, STANDARD, DEEP) avec les
 * raisons d'indisponibilité ; les commandes (lancer, pause, reprendre, annuler) ; la progression du run (plan,
 * agents, consommation, limites) ; les constats et leurs références (sélection synchronisée avec le graphe, le
 * code et les preuves) ; la file des vérifications proposées (approbation ou refus d'une personne, DECIDE) ;
 * l'explorateur d'hypothèses (rôles d'après le validateur déterministe) ; les contradictions ; la couverture par
 * dimension (jamais un pourcentage global) ; la chronologie de la mémoire ; l'assistant qui cite ses sources.
 *
 * Tout ce qui vient d'un agent est dit « proposé » : rien ici n'affiche une cause comme confirmée.
 * Rendu en chaînes HTML pures ; les interactions passent par `data-action` (préfixe `ws-ai-`).
 * `reduceAi` ne traite que l'état local ; les opérations (`AI_OPERATIONS`) sont laissées au contrôleur.
 */

export const AI_SECTIONS = [
  'plan',
  'findings',
  'proposals',
  'hypotheses',
  'contradictions',
  'coverage',
  'timeline',
  'assistant',
] as const;
export type AiSection = (typeof AI_SECTIONS)[number];

export const AI_OPERATIONS = [
  'ws-ai-start',
  'ws-ai-pause',
  'ws-ai-resume',
  'ws-ai-cancel-yes',
  'ws-ai-ask',
  'ws-ai-approve',
  'ws-ai-refuse',
  'ws-ai-extend',
  'ws-ai-reload',
] as const;

export const AI_BUDGET_KEYS = [
  'maxIterations',
  'maxModelCalls',
  'maxToolCalls',
  'maxExperiments',
  'maxFiles',
] as const;
export type AiBudgetKey = (typeof AI_BUDGET_KEYS)[number];

/** Événements de la chronologie montrés au plus. */
export const MAX_TIMELINE_SHOWN = 80;

export type AiLoadState = 'loading' | 'denied' | { error: string };

export interface AiUi {
  mode: AiInvestigationMode;
  depth: InvestigationDepth;
  section: AiSection;
  /** Le run affiché (id) ; absent : le dernier. */
  runId?: string;
  question: string;
  extendKey: AiBudgetKey;
  extendValue: string;
  /** « Annuler le run » demande une confirmation dans la page. */
  confirmCancel: boolean;
  /** Les erreurs à afficher, par emplacement : `start`, `control`, `ask`, `decide:<id>`, `extend`, `capabilities`, `memory`. */
  errors: Record<string, string>;
  /** L'opération en cours (`aiBusyKey(action, ref)`). */
  busy?: string;
  capabilities?: AiCapabilities;
  capabilitiesState?: AiLoadState;
  /** La mémoire d'investigation lue (`null` : le serveur n'en a pas). */
  memory?: InvestigationMemory | null;
  memoryState?: AiLoadState;
  /** La révision de l'incident pour laquelle la mémoire a été lue. */
  memoryRevision?: number;
}

export function emptyAiUi(): AiUi {
  return {
    mode: 'DETERMINISTIC',
    depth: 'STANDARD',
    section: 'plan',
    question: '',
    extendKey: 'maxExperiments',
    extendValue: '2',
    confirmCancel: false,
    errors: {},
  };
}

export const aiBusyKey = (action: string, ref?: string): string => (ref ? `${action}:${ref}` : action);

const isMode = (value: string | undefined): value is AiInvestigationMode =>
  (AI_INVESTIGATION_MODES as readonly string[]).includes(value ?? '');
const isDepth = (value: string | undefined): value is InvestigationDepth =>
  (INVESTIGATION_DEPTHS as readonly string[]).includes(value ?? '');
const isSection = (value: string | undefined): value is AiSection =>
  (AI_SECTIONS as readonly string[]).includes(value ?? '');
const isBudgetKey = (value: string | undefined): value is AiBudgetKey =>
  (AI_BUDGET_KEYS as readonly string[]).includes(value ?? '');

/** L'état local (sections, choix, brouillons, confirmation) ; `undefined` quand l'action n'est pas la sienne. */
export function reduceAi(
  ui: AiUi,
  action: string,
  dataset: Record<string, string | undefined>,
): AiUi | undefined {
  switch (action) {
    case 'ws-ai-section':
      return isSection(dataset.section) ? { ...ui, section: dataset.section } : undefined;
    case 'ws-ai-mode': {
      if (!isMode(dataset.mode)) return undefined;
      const depth = DEPTH_MODES[ui.depth].includes(dataset.mode) ? ui.depth : 'STANDARD';
      return { ...ui, mode: dataset.mode, depth };
    }
    case 'ws-ai-depth':
      return isDepth(dataset.depth) ? { ...ui, depth: dataset.depth } : undefined;
    case 'ws-ai-run':
      return dataset.run ? { ...ui, runId: dataset.run } : undefined;
    case 'ws-ai-cancel':
      return { ...ui, confirmCancel: true };
    case 'ws-ai-cancel-no':
      return { ...ui, confirmCancel: false };
    case 'ws-ai-dismiss': {
      const slot = dataset.slot;
      if (!slot) return undefined;
      const { [slot]: _dropped, ...errors } = ui.errors;
      return { ...ui, errors };
    }
    case 'ws-ai-field': {
      const value = dataset.value ?? '';
      switch (dataset.field) {
        case 'ai.question':
          return { ...ui, question: value.slice(0, 1000) };
        case 'ai.extendKey':
          return isBudgetKey(value) ? { ...ui, extendKey: value } : undefined;
        case 'ai.extendValue':
          return { ...ui, extendValue: value.replace(/[^0-9]/g, '').slice(0, 6) };
        default:
          return undefined;
      }
    }
    default:
      return undefined;
  }
}

// ── Lectures ─────────────────────────────────────────────────────────────────────────────────

export function aiRuns(incident: Pick<Incident, 'investigation'>): AiInvestigationRun[] {
  return incident.investigation.ai?.runs ?? [];
}

/** Le run affiché : celui choisi, sinon le dernier. */
export function shownRun(
  incident: Pick<Incident, 'investigation'>,
  ui: Pick<AiUi, 'runId'>,
): AiInvestigationRun | undefined {
  const runs = aiRuns(incident);
  return (ui.runId ? runs.find((run) => run.id === ui.runId) : undefined) ?? runs.at(-1);
}

export const aiRunning = (incident: Pick<Incident, 'investigation'>): boolean =>
  aiRuns(incident).some((run) => run.status === 'RUNNING');

/** Le mode effectivement choisi pour un lancement : celui de la page, sinon le défaut annoncé par le serveur. */
export function chosenMode(ui: Pick<AiUi, 'mode' | 'capabilities'>): AiInvestigationMode {
  if (ui.mode !== 'DETERMINISTIC') return ui.mode;
  return ui.capabilities?.defaultMode ?? 'DETERMINISTIC';
}

export function modeAvailable(ui: Pick<AiUi, 'capabilities'>, mode: AiInvestigationMode): boolean {
  if (mode === 'DETERMINISTIC') return true;
  return ui.capabilities?.availableModes.includes(mode) ?? false;
}

/** Les vérifications proposées : celles des runs (agents) puis celles générées par la boucle (mémoire), dédoublonnées. */
export function proposalQueue(
  incident: Pick<Incident, 'investigation'>,
  memory: InvestigationMemory | null | undefined,
): (AiExperimentProposal | GeneratedExperiment)[] {
  const seen = new Set<string>();
  const out: (AiExperimentProposal | GeneratedExperiment)[] = [];
  for (const run of [...aiRuns(incident)].reverse())
    for (const proposal of run.proposals) {
      if (seen.has(proposal.id)) continue;
      seen.add(proposal.id);
      out.push(proposal);
    }
  for (const experiment of memory?.experiments ?? []) {
    if (seen.has(experiment.id)) continue;
    seen.add(experiment.id);
    out.push(experiment);
  }
  return out;
}

export const stepsDone = (run: Pick<AiInvestigationRun, 'steps'>): number =>
  run.steps.filter((step) => step.status !== 'RUNNING' && step.status !== 'PENDING').length;

// ── Textes ───────────────────────────────────────────────────────────────────────────────────

const TEXT = {
  fr: {
    title: 'Investigation IA',
    sub: 'Des agents lisent les preuves et le code permis, proposent des hypothèses et des vérifications ; rien n’est confirmé par l’IA : seul le validateur déterministe confirme une cause.',
    deterministicNote:
      'Le mode DETERMINISTIC est le défaut : aucun fournisseur n’est appelé, l’investigation est celle des règles.',
    unavailable: (reason: string) => `IA indisponible : ${reason}`,
    capabilitiesLoading: 'Lecture des capacités du serveur…',
    capabilitiesError: (error: string) => `Capacités illisibles : ${error}`,
    mode: 'Mode',
    modes: {
      DETERMINISTIC: 'Déterministe',
      AI_ASSISTED: 'IA assistée',
      AI_AGENTIC: 'IA agentique',
    } as Record<AiInvestigationMode, string>,
    modeHints: {
      DETERMINISTIC: 'règles seulement, aucun appel au modèle',
      AI_ASSISTED: 'une passe de chaque agent, lecture seule, propositions',
      AI_AGENTIC: 'boucle bornée ; les vérifications sans effet de bord déjà permises sont lancées',
    } as Record<AiInvestigationMode, string>,
    depth: 'Profondeur',
    depths: { QUICK: 'Rapide', STANDARD: 'Standard', DEEP: 'Approfondie' } as Record<
      InvestigationDepth,
      string
    >,
    depthHints: {
      QUICK: 'preuves essentielles, hypothèses initiales',
      STANDARD: 'trois couches, corrélation, vérifications ciblées',
      DEEP: 'stratégies, contradictions, mémoire, boucle adaptative (IA agentique seulement)',
    } as Record<InvestigationDepth, string>,
    depthNeeds: (modes: string) => `exige ${modes}`,
    provider: 'Fournisseur',
    budget: 'Budget',
    budgetLine: (calls: number, tools: number, experiments: number, minutes: number) =>
      `${String(calls)} appels au modèle, ${String(tools)} appels d’outils, ${String(experiments)} vérification(s), ${String(minutes)} min au plus`,
    dataPolicy: 'Données transmises',
    dataPolicyLine: (code: boolean, bodies: boolean, logs: boolean) =>
      `code source : ${code ? 'avec' : 'sans'} ; corps HTTP : ${bodies ? 'avec' : 'sans'} ; journaux : ${logs ? 'avec' : 'sans'} ; captures : jamais`,
    start: 'Lancer l’investigation',
    resume: 'Reprendre',
    pause: 'Mettre en pause',
    cancel: 'Annuler le run',
    cancelConfirm: 'Annuler le run en cours ? Les résultats déjà acquis sont conservés.',
    cancelYes: 'Annuler le run',
    cancelNo: 'Garder',
    running: 'Investigation en cours',
    noRun: 'Aucune investigation IA pour cet incident.',
    runs: 'Runs',
    run: (id: string) => `Run ${id}`,
    status: {
      RUNNING: 'En cours',
      DONE: 'Terminé',
      PARTIAL: 'Partiel',
      FAILED: 'Échec',
      CANCELLED: 'Annulé',
    } as Record<AiRunStatus, string>,
    stop: 'Arrêt',
    startedBy: (actor: string, at: string) => `lancé par ${actor} le ${at}`,
    usage: 'Consommation',
    usageCells: {
      modelCalls: 'appels au modèle',
      toolCalls: 'appels d’outils',
      files: 'fichiers lus',
      experiments: 'vérifications',
      inputTokens: 'jetons en entrée',
      outputTokens: 'jetons en sortie',
    } as Record<string, string>,
    of: (used: number, max: number) => `${String(used)} / ${String(max)}`,
    progress: (done: number, total: number) => `${String(done)} agent(s) sur ${String(total)} terminé(s)`,
    limitations: (count: number) => `Limites du run (${String(count)})`,
    error: 'Erreur',
    sections: {
      plan: 'Plan et agents',
      findings: 'Constats',
      proposals: 'Vérifications proposées',
      hypotheses: 'Hypothèses',
      contradictions: 'Contradictions',
      coverage: 'Couverture',
      timeline: 'Chronologie',
      assistant: 'Assistant',
    } as Record<AiSection, string>,
    agents: {
      PLANNER: 'Planificateur',
      EVIDENCE_ANALYSIS: 'Analyse des preuves',
      FRONTEND: 'Frontend',
      BFF: 'BFF',
      BACKEND: 'Backend',
      CROSS_LAYER: 'Inter-couches',
      HYPOTHESIS: 'Hypothèses',
      VERIFICATION_PLANNING: 'Plan de vérification',
      SYNTHESIS: 'Synthèse',
      ASSISTANT: 'Assistant',
      CONTRADICTION_HUNTER: 'Chasseur de contradictions',
      STRATEGY: 'Stratégies',
      EXPERIMENT_GENERATION: 'Génération d’expériences',
    } as Record<AiAgentName, string>,
    agentStatus: {
      PENDING: 'En attente',
      RUNNING: 'En cours',
      DONE: 'Terminé',
      FAILED: 'Échec',
      SKIPPED: 'Sauté',
      CANCELLED: 'Annulé',
      APPROVAL_REQUIRED: 'Autorisation requise',
    } as Record<AiAgentStatus, string>,
    plan: 'Plan d’investigation',
    planEmpty: 'Le plan n’est pas encore établi.',
    agentsTitle: 'Agents',
    toolCalls: (count: number) => `${String(count)} appel(s) d’outils`,
    strategies: 'Stratégies (investigation approfondie)',
    strategyCols: ['Stratégie', 'Catégorie', 'Statut', 'Gain attendu', 'Tentatives', 'Raison'],
    findingsEmpty: 'Aucun constat.',
    basis: { OBSERVED: 'Observé', STATICALLY_RESOLVED: 'Lu dans le code', INFERRED: 'Déduit' } as Record<
      AiFinding['basis'],
      string
    >,
    refs: 'Références',
    locations: 'Emplacements',
    forHypothesis: 'Hypothèse',
    synthesis: 'Synthèse (proposition de l’agent)',
    ranking: 'Ordre de vraisemblance',
    missing: 'Ce qui manque',
    proposalsEmpty: 'Aucune vérification proposée.',
    proposalsNote:
      'Une vérification sans effet de bord déjà permise par le périmètre peut être lancée par la boucle (IA agentique) ; toute autre attend une personne. Approuver planifie et lance par le chemin ordinaire.',
    proposalStatus: {
      PROPOSED: 'Proposée',
      PLANNED: 'Planifiée',
      REFUSED: 'Refusée',
      DONE: 'Faite',
    } as Record<AiExperimentProposal['status'], string>,
    sideEffects: 'Effets de bord',
    needsApproval: 'Approbation nécessaire',
    approve: 'Approuver',
    refuse: 'Refuser',
    decideRight: 'Le droit DECIDE est nécessaire pour trancher.',
    planned: (id: string) => `Vérification ${id}`,
    expected: 'Attendu',
    confirmIf: 'Confirme si',
    refuteIf: 'Réfute si',
    operations: 'Opérations déclarées',
    hypothesesEmpty: 'Aucune hypothèse.',
    origin: { RULE: 'Règle', AI: 'IA' } as Record<'RULE' | 'AI', string>,
    roles: {
      CONFIRMED_CAUSE: 'Cause confirmée (validateur)',
      PROBABLE_CAUSE: 'Cause probable',
      CONTRIBUTING_FACTOR: 'Facteur contributif',
      REFUTED: 'Réfutée',
      UNVERIFIED: 'Non vérifiée',
      UNKNOWN: 'Inconnue',
    } as Record<HypothesisExploration['role'], string>,
    verifications: (count: number) => `${String(count)} vérification(s)`,
    unknowns: 'Inconnues',
    relations: 'Relations',
    relationKinds: {
      COMPETES: 'en concurrence avec',
      CONTRIBUTES: 'contribue à',
      IMPLIES: 'implique',
      EXCLUDES: 'exclut',
      REFINES: 'précise',
    } as Record<string, string>,
    rolesNote:
      'Les rôles viennent du validateur déterministe et des vérifications menées ; une hypothèse soutenue n’en écarte jamais une autre.',
    contradictionsEmpty: 'Aucune contradiction trouvée.',
    openQuestion: 'Question ouverte',
    contradictionStatus: {
      OPEN: 'Ouverte',
      RESOLVED_SUPPORTS: 'Tranchée : l’hypothèse tient',
      RESOLVED_CONTRADICTS: 'Tranchée : l’hypothèse est contredite',
      DISMISSED: 'Écartée',
    } as Record<string, string>,
    decisive: (id: string) => `Vérification décisive : ${id}`,
    coverageEmpty: 'Couverture non calculée (une investigation approfondie la produit).',
    coverageNote: 'Par dimension, avec son dénominateur ; aucun pourcentage global n’est calculé.',
    coverageCols: ['Dimension', 'État', 'Examiné', 'Total', 'Dénominateur', 'Raison'],
    coverageState: {
      EXAMINED: 'Examinée',
      PARTIAL: 'Partielle',
      NOT_EXAMINED: 'Non examinée',
      NOT_APPLICABLE: 'Sans objet',
      BLOCKED: 'Bloquée',
    } as Record<CoverageEntry['state'], string>,
    dimensions: {
      USER_JOURNEY: 'Parcours utilisateur',
      FRONTEND_EVENTS: 'Événements frontend',
      HTTP_REQUESTS: 'Requêtes HTTP',
      BFF_CONTROLLERS: 'Contrôleurs BFF',
      MAPPINGS: 'Mappings',
      BACKEND_SERVICES: 'Services backend',
      REPOSITORIES: 'Dépôts (repositories)',
      DATA_PRECONDITIONS: 'Préconditions de données',
      EXCEPTIONS: 'Exceptions',
      CONFIGURATIONS: 'Configurations',
      GIT_CHANGES: 'Changements Git',
      COMPARATIVE_SCENARIOS: 'Scénarios comparés',
      ALTERNATIVE_HYPOTHESES: 'Hypothèses alternatives',
      EXECUTED_VERIFICATIONS: 'Vérifications exécutées',
    } as Record<CoverageEntry['dimension'], string>,
    timelineEmpty: 'Aucun événement en mémoire.',
    memoryLoading: 'Lecture de la mémoire d’investigation…',
    memoryError: (error: string) => `Mémoire illisible : ${error}`,
    memoryStatus: 'Mémoire',
    remaining: 'Ce qui reste à faire',
    limits: 'Limites atteintes',
    limitLine: (limit: string, remaining: number) => `${limit} — ${String(remaining)} piste(s) restante(s)`,
    extend: 'Prolonger le budget',
    extendHint: 'Une prolongation est une décision (DECIDE) ; elle n’est jamais automatique.',
    extendKeys: {
      maxIterations: 'itérations',
      maxModelCalls: 'appels au modèle',
      maxToolCalls: 'appels d’outils',
      maxExperiments: 'vérifications',
      maxFiles: 'fichiers',
    } as Record<AiBudgetKey, string>,
    extendDo: 'Prolonger',
    permissions: 'Décisions (opération et paramètres)',
    assistantSub:
      'L’assistant répond à partir des preuves, du graphe, du code et des hypothèses de cette investigation ; il cite ses références et dit quand il ne peut pas répondre.',
    question: 'Votre question',
    questionPlaceholder: 'Quelle requête a échoué, et que dit le code à ce sujet ?',
    ask: 'Poser la question',
    answersEmpty: 'Aucune question posée.',
    unavailableAnswer: (reason: string) => `Pas de réponse : ${reason}`,
    askedBy: (actor: string, at: string) => `${actor}, ${at}`,
    reload: 'Relire',
    busy: 'Une opération est en cours.',
    dismiss: 'Fermer le message',
    needsRun: 'Le droit RUN est nécessaire pour lancer une investigation.',
    runPill: (depth: string, mode: string) => `${depth} · ${mode}`,
  },
  en: {
    title: 'AI investigation',
    sub: 'Agents read the permitted evidence and code, propose hypotheses and verifications; nothing is confirmed by AI: only the deterministic validator confirms a cause.',
    deterministicNote:
      'DETERMINISTIC is the default: no provider is called, the investigation is the rule-based one.',
    unavailable: (reason: string) => `AI unavailable: ${reason}`,
    capabilitiesLoading: 'Reading server capabilities…',
    capabilitiesError: (error: string) => `Capabilities unreadable: ${error}`,
    mode: 'Mode',
    modes: { DETERMINISTIC: 'Deterministic', AI_ASSISTED: 'AI assisted', AI_AGENTIC: 'AI agentic' } as Record<
      AiInvestigationMode,
      string
    >,
    modeHints: {
      DETERMINISTIC: 'rules only, no model call',
      AI_ASSISTED: 'one pass per agent, read-only, proposals',
      AI_AGENTIC: 'bounded loop; already permitted side-effect-free verifications are run',
    } as Record<AiInvestigationMode, string>,
    depth: 'Depth',
    depths: { QUICK: 'Quick', STANDARD: 'Standard', DEEP: 'Deep' } as Record<InvestigationDepth, string>,
    depthHints: {
      QUICK: 'essential evidence, initial hypotheses',
      STANDARD: 'three layers, correlation, targeted verifications',
      DEEP: 'strategies, contradictions, memory, adaptive loop (AI agentic only)',
    } as Record<InvestigationDepth, string>,
    depthNeeds: (modes: string) => `requires ${modes}`,
    provider: 'Provider',
    budget: 'Budget',
    budgetLine: (calls: number, tools: number, experiments: number, minutes: number) =>
      `${String(calls)} model calls, ${String(tools)} tool calls, ${String(experiments)} verification(s), at most ${String(minutes)} min`,
    dataPolicy: 'Data sent',
    dataPolicyLine: (code: boolean, bodies: boolean, logs: boolean) =>
      `source code: ${code ? 'yes' : 'no'}; HTTP bodies: ${bodies ? 'yes' : 'no'}; logs: ${logs ? 'yes' : 'no'}; screenshots: never`,
    start: 'Start the investigation',
    resume: 'Resume',
    pause: 'Pause',
    cancel: 'Cancel the run',
    cancelConfirm: 'Cancel the running investigation? Results gathered so far are kept.',
    cancelYes: 'Cancel the run',
    cancelNo: 'Keep',
    running: 'Investigation running',
    noRun: 'No AI investigation for this incident.',
    runs: 'Runs',
    run: (id: string) => `Run ${id}`,
    status: {
      RUNNING: 'Running',
      DONE: 'Done',
      PARTIAL: 'Partial',
      FAILED: 'Failed',
      CANCELLED: 'Cancelled',
    } as Record<AiRunStatus, string>,
    stop: 'Stop',
    startedBy: (actor: string, at: string) => `started by ${actor} on ${at}`,
    usage: 'Usage',
    usageCells: {
      modelCalls: 'model calls',
      toolCalls: 'tool calls',
      files: 'files read',
      experiments: 'verifications',
      inputTokens: 'input tokens',
      outputTokens: 'output tokens',
    } as Record<string, string>,
    of: (used: number, max: number) => `${String(used)} / ${String(max)}`,
    progress: (done: number, total: number) => `${String(done)} of ${String(total)} agent(s) finished`,
    limitations: (count: number) => `Run limitations (${String(count)})`,
    error: 'Error',
    sections: {
      plan: 'Plan and agents',
      findings: 'Findings',
      proposals: 'Proposed verifications',
      hypotheses: 'Hypotheses',
      contradictions: 'Contradictions',
      coverage: 'Coverage',
      timeline: 'Timeline',
      assistant: 'Assistant',
    } as Record<AiSection, string>,
    agents: {
      PLANNER: 'Planner',
      EVIDENCE_ANALYSIS: 'Evidence analysis',
      FRONTEND: 'Frontend',
      BFF: 'BFF',
      BACKEND: 'Backend',
      CROSS_LAYER: 'Cross-layer',
      HYPOTHESIS: 'Hypotheses',
      VERIFICATION_PLANNING: 'Verification planning',
      SYNTHESIS: 'Synthesis',
      ASSISTANT: 'Assistant',
      CONTRADICTION_HUNTER: 'Contradiction hunter',
      STRATEGY: 'Strategies',
      EXPERIMENT_GENERATION: 'Experiment generation',
    } as Record<AiAgentName, string>,
    agentStatus: {
      PENDING: 'Pending',
      RUNNING: 'Running',
      DONE: 'Done',
      FAILED: 'Failed',
      SKIPPED: 'Skipped',
      CANCELLED: 'Cancelled',
      APPROVAL_REQUIRED: 'Approval required',
    } as Record<AiAgentStatus, string>,
    plan: 'Investigation plan',
    planEmpty: 'The plan is not established yet.',
    agentsTitle: 'Agents',
    toolCalls: (count: number) => `${String(count)} tool call(s)`,
    strategies: 'Strategies (deep investigation)',
    strategyCols: ['Strategy', 'Category', 'Status', 'Expected gain', 'Attempts', 'Reason'],
    findingsEmpty: 'No finding.',
    basis: { OBSERVED: 'Observed', STATICALLY_RESOLVED: 'Read in code', INFERRED: 'Inferred' } as Record<
      AiFinding['basis'],
      string
    >,
    refs: 'References',
    locations: 'Locations',
    forHypothesis: 'Hypothesis',
    synthesis: 'Synthesis (agent proposal)',
    ranking: 'Likelihood order',
    missing: 'What is missing',
    proposalsEmpty: 'No proposed verification.',
    proposalsNote:
      'A side-effect-free verification already permitted by the scope may be run by the loop (AI agentic); anything else waits for a person. Approving plans and runs it through the ordinary path.',
    proposalStatus: { PROPOSED: 'Proposed', PLANNED: 'Planned', REFUSED: 'Refused', DONE: 'Done' } as Record<
      AiExperimentProposal['status'],
      string
    >,
    sideEffects: 'Side effects',
    needsApproval: 'Approval needed',
    approve: 'Approve',
    refuse: 'Refuse',
    decideRight: 'The DECIDE right is needed to decide.',
    planned: (id: string) => `Verification ${id}`,
    expected: 'Expected',
    confirmIf: 'Confirms if',
    refuteIf: 'Refutes if',
    operations: 'Declared operations',
    hypothesesEmpty: 'No hypothesis.',
    origin: { RULE: 'Rule', AI: 'AI' } as Record<'RULE' | 'AI', string>,
    roles: {
      CONFIRMED_CAUSE: 'Confirmed cause (validator)',
      PROBABLE_CAUSE: 'Probable cause',
      CONTRIBUTING_FACTOR: 'Contributing factor',
      REFUTED: 'Refuted',
      UNVERIFIED: 'Unverified',
      UNKNOWN: 'Unknown',
    } as Record<HypothesisExploration['role'], string>,
    verifications: (count: number) => `${String(count)} verification(s)`,
    unknowns: 'Unknowns',
    relations: 'Relations',
    relationKinds: {
      COMPETES: 'competes with',
      CONTRIBUTES: 'contributes to',
      IMPLIES: 'implies',
      EXCLUDES: 'excludes',
      REFINES: 'refines',
    } as Record<string, string>,
    rolesNote:
      'Roles come from the deterministic validator and the verifications run; a supported hypothesis never removes another.',
    contradictionsEmpty: 'No contradiction found.',
    openQuestion: 'Open question',
    contradictionStatus: {
      OPEN: 'Open',
      RESOLVED_SUPPORTS: 'Settled: the hypothesis holds',
      RESOLVED_CONTRADICTS: 'Settled: the hypothesis is contradicted',
      DISMISSED: 'Dismissed',
    } as Record<string, string>,
    decisive: (id: string) => `Decisive verification: ${id}`,
    coverageEmpty: 'Coverage not computed (a deep investigation produces it).',
    coverageNote: 'Per dimension, with its denominator; no global percentage is computed.',
    coverageCols: ['Dimension', 'State', 'Examined', 'Total', 'Denominator', 'Reason'],
    coverageState: {
      EXAMINED: 'Examined',
      PARTIAL: 'Partial',
      NOT_EXAMINED: 'Not examined',
      NOT_APPLICABLE: 'Not applicable',
      BLOCKED: 'Blocked',
    } as Record<CoverageEntry['state'], string>,
    dimensions: {
      USER_JOURNEY: 'User journey',
      FRONTEND_EVENTS: 'Frontend events',
      HTTP_REQUESTS: 'HTTP requests',
      BFF_CONTROLLERS: 'BFF controllers',
      MAPPINGS: 'Mappings',
      BACKEND_SERVICES: 'Backend services',
      REPOSITORIES: 'Repositories',
      DATA_PRECONDITIONS: 'Data preconditions',
      EXCEPTIONS: 'Exceptions',
      CONFIGURATIONS: 'Configurations',
      GIT_CHANGES: 'Git changes',
      COMPARATIVE_SCENARIOS: 'Compared scenarios',
      ALTERNATIVE_HYPOTHESES: 'Alternative hypotheses',
      EXECUTED_VERIFICATIONS: 'Executed verifications',
    } as Record<CoverageEntry['dimension'], string>,
    timelineEmpty: 'No event in memory.',
    memoryLoading: 'Reading the investigation memory…',
    memoryError: (error: string) => `Memory unreadable: ${error}`,
    memoryStatus: 'Memory',
    remaining: 'What remains to do',
    limits: 'Limits reached',
    limitLine: (limit: string, remaining: number) => `${limit} — ${String(remaining)} lead(s) remaining`,
    extend: 'Extend the budget',
    extendHint: 'An extension is a decision (DECIDE); it is never automatic.',
    extendKeys: {
      maxIterations: 'iterations',
      maxModelCalls: 'model calls',
      maxToolCalls: 'tool calls',
      maxExperiments: 'verifications',
      maxFiles: 'files',
    } as Record<AiBudgetKey, string>,
    extendDo: 'Extend',
    permissions: 'Decisions (operation and parameters)',
    assistantSub:
      'The assistant answers from the evidence, graph, code and hypotheses of this investigation; it cites its references and says when it cannot answer.',
    question: 'Your question',
    questionPlaceholder: 'Which request failed, and what does the code say about it?',
    ask: 'Ask',
    answersEmpty: 'No question asked.',
    unavailableAnswer: (reason: string) => `No answer: ${reason}`,
    askedBy: (actor: string, at: string) => `${actor}, ${at}`,
    reload: 'Reload',
    busy: 'An operation is running.',
    dismiss: 'Dismiss',
    needsRun: 'The RUN right is needed to start an investigation.',
    runPill: (depth: string, mode: string) => `${depth} · ${mode}`,
  },
} as const;

type Text = (typeof TEXT)['fr'];
const text = (lang: Lang): Text => TEXT[lang] as Text;
const domId = (prefix: string, id: string): string => `${prefix}-${id.replace(/[^A-Za-z0-9_-]/g, '_')}`;

// ── Rendu ────────────────────────────────────────────────────────────────────────────────────

/** Le sous-onglet « Investigation IA » en entier. */
export function renderAiInvestigation(ctx: WorkspaceContext, ui: AiUi): string {
  const run = shownRun(ctx.incident, ui);
  return `<div class="ws-ai">${header(ctx, ui)}${controls(ctx, ui, run)}${run ? runCard(ctx, ui, run) : ''}${sectionTabs(ctx, ui)}<div class="ws-ai-section" id="ws-ai-section" role="region" aria-labelledby="ws-ai-sec-${ui.section}">${sectionBody(ctx, ui, run)}</div></div>`;
}

function header(ctx: WorkspaceContext, ui: AiUi): string {
  const t = text(ctx.lang);
  const caps = ui.capabilities;
  const state = ui.capabilitiesState;
  const note =
    state === 'loading'
      ? `<p class="mu">${esc(t.capabilitiesLoading)}</p>`
      : state && typeof state === 'object'
        ? `<p class="mu" role="note">${esc(t.capabilitiesError(state.error))}</p>`
        : caps?.unavailableReason
          ? `<p class="note warn ws-ai-unavailable" role="note">${icon('alert')}<span>${esc(t.unavailable(caps.unavailableReason))}</span></p>`
          : '';
  const facts = caps
    ? `<dl class="ws-ai-facts">${
        caps.provider || caps.model
          ? `<div><dt>${esc(t.provider)}</dt><dd>${esc([caps.provider, caps.model].filter(Boolean).join(' / '))}</dd></div>`
          : ''
      }<div><dt>${esc(t.budget)}</dt><dd>${esc(
        t.budgetLine(
          caps.budget.maxModelCalls,
          caps.budget.maxToolCalls,
          caps.budget.maxExperiments,
          Math.round(caps.budget.maxDurationMs / 60_000),
        ),
      )}</dd></div><div><dt>${esc(t.dataPolicy)}</dt><dd>${esc(
        t.dataPolicyLine(
          caps.dataPolicy.sendSourceCode,
          caps.dataPolicy.sendHttpBodies,
          caps.dataPolicy.sendLogs,
        ),
      )}</dd></div></dl>`
    : '';
  return `<section class="card wide ws-ai-intro" aria-labelledby="ws-ai-title"><h2 id="ws-ai-title">${esc(t.title)}</h2><p class="mu">${esc(t.sub)}</p>${note}${facts}</section>`;
}

function controls(ctx: WorkspaceContext, ui: AiUi, run: AiInvestigationRun | undefined): string {
  const t = text(ctx.lang);
  const running = aiRunning(ctx.incident);
  const canRun = ctx.can('RUN') && !ctx.demo;
  const chosen = chosenMode(ui);
  const busy = ui.busy !== undefined;
  const modeButtons = AI_INVESTIGATION_MODES.map((mode) => {
    const available = modeAvailable(ui, mode);
    const pressed = chosen === mode;
    const hint = available ? t.modeHints[mode] : (ui.capabilities?.unavailableReason ?? t.modeHints[mode]);
    return `<button type="button" class="chip ws-ai-choice" data-action="ws-ai-mode" data-mode="${mode}" aria-pressed="${String(pressed)}"${available && !running ? '' : ' disabled'} title="${esc(hint)}">${esc(t.modes[mode])}</button>`;
  }).join('');
  const depthButtons = INVESTIGATION_DEPTHS.map((depth) => {
    const allowed = DEPTH_MODES[depth].includes(chosen) && chosen !== 'DETERMINISTIC';
    const hint = allowed
      ? t.depthHints[depth]
      : t.depthNeeds(
          DEPTH_MODES[depth]
            .filter((mode) => mode !== 'DETERMINISTIC')
            .map((mode) => t.modes[mode])
            .join(' / '),
        );
    return `<button type="button" class="chip ws-ai-choice" data-action="ws-ai-depth" data-depth="${depth}" aria-pressed="${String(ui.depth === depth)}"${allowed && !running ? '' : ' disabled'} title="${esc(hint)}">${esc(t.depths[depth])}</button>`;
  }).join('');
  const startable = canRun && chosen !== 'DETERMINISTIC' && modeAvailable(ui, chosen) && !running && !busy;
  const resumable =
    startable &&
    (ui.memory?.status === 'PAUSED' || ui.memory?.status === 'PARTIAL' || run?.status === 'PARTIAL');
  const actions = running
    ? `<button type="button" class="btn" data-action="ws-ai-pause"${canRun && !busy && ui.memory?.status !== 'PAUSED' ? '' : ' disabled'}>${icon('pause')}<span>${esc(t.pause)}</span></button>${
        ui.confirmCancel
          ? `<div class="ws-ai-confirm" role="group" aria-label="${esc(t.cancel)}"><p>${esc(t.cancelConfirm)}</p><button type="button" class="btn ghost" data-action="ws-ai-cancel-no">${esc(t.cancelNo)}</button><button type="button" class="btn danger" data-action="ws-ai-cancel-yes"${canRun && !busy ? '' : ' disabled'}>${esc(t.cancelYes)}</button></div>`
          : `<button type="button" class="btn danger" data-action="ws-ai-cancel"${canRun && !busy ? '' : ' disabled'}>${icon('stop')}<span>${esc(t.cancel)}</span></button>`
      }`
    : `<button type="button" class="btn primary" data-action="ws-ai-start"${startable ? '' : ' disabled'} title="${esc(canRun ? '' : t.needsRun)}">${icon('play')}<span>${esc(t.start)}</span></button>${
        resumable
          ? `<button type="button" class="btn" data-action="ws-ai-resume">${icon('play')}<span>${esc(t.resume)}</span></button>`
          : ''
      }`;
  const error = ui.errors.start ?? ui.errors.control;
  return `<section class="card wide ws-ai-controls" aria-label="${esc(t.mode)}"><div class="ws-ai-row"><span class="ws-ai-label" id="ws-ai-mode-l">${esc(t.mode)}</span><div class="ws-ai-choices" role="group" aria-labelledby="ws-ai-mode-l">${modeButtons}</div></div><div class="ws-ai-row"><span class="ws-ai-label" id="ws-ai-depth-l">${esc(t.depth)}</span><div class="ws-ai-choices" role="group" aria-labelledby="ws-ai-depth-l">${depthButtons}</div></div>${
    chosen === 'DETERMINISTIC' ? `<p class="mu">${esc(t.deterministicNote)}</p>` : ''
  }<div class="ws-ai-actions row-acts">${actions}${busy ? `<span class="pill live" aria-live="polite">${esc(t.busy)}</span>` : ''}</div>${
    error ? errorBox(t, error, ui.errors.start ? 'start' : 'control') : ''
  }</section>`;
}

function errorBox(t: Text, message: string, slot: string): string {
  return `<div class="err-box ws-ai-err" role="alert"><p class="err">${esc(message)}</p><button type="button" class="btn small ghost" data-action="ws-ai-dismiss" data-slot="${esc(slot)}" aria-label="${esc(t.dismiss)}">${icon('close')}</button></div>`;
}

function runCard(ctx: WorkspaceContext, ui: AiUi, run: AiInvestigationRun): string {
  const t = text(ctx.lang);
  const runs = aiRuns(ctx.incident);
  const tone =
    run.status === 'DONE'
      ? 'ok'
      : run.status === 'RUNNING'
        ? 'live'
        : run.status === 'FAILED'
          ? 'ko'
          : 'warn';
  const picker =
    runs.length > 1
      ? `<div class="ws-ai-runs" role="group" aria-label="${esc(t.runs)}">${[...runs]
          .reverse()
          .map(
            (entry) =>
              `<button type="button" class="chip small" data-action="ws-ai-run" data-run="${esc(entry.id)}" aria-pressed="${String(entry.id === run.id)}">${esc(t.run(entry.id))}</button>`,
          )
          .join('')}</div>`
      : '';
  // Les agents relancés par la boucle (planificateur, hypothèses, plan de vérification) comptent chacun leur passage.
  const total = Math.max(run.plan.length, run.steps.length);
  const done = stepsDone(run);
  const usage = (['modelCalls', 'toolCalls', 'files', 'experiments'] as const)
    .map((key) => {
      const max =
        key === 'modelCalls'
          ? run.budget.maxModelCalls
          : key === 'toolCalls'
            ? run.budget.maxToolCalls
            : key === 'files'
              ? run.budget.maxFiles
              : run.budget.maxExperiments;
      return `<div class="ws-ai-cell"><dt>${esc(t.usageCells[key] ?? key)}</dt><dd>${esc(t.of(run.usage[key], max))}</dd></div>`;
    })
    .join('');
  const tokens = `<div class="ws-ai-cell"><dt>${esc(t.usageCells.inputTokens ?? '')}</dt><dd>${String(run.usage.inputTokens)}</dd></div><div class="ws-ai-cell"><dt>${esc(t.usageCells.outputTokens ?? '')}</dt><dd>${String(run.usage.outputTokens)}</dd></div>`;
  const limitations =
    run.limitations.length > 0
      ? `<details class="ws-ai-limits"><summary>${esc(t.limitations(run.limitations.length))}</summary><ul class="plain tight">${run.limitations.map((entry) => `<li>${esc(entry)}</li>`).join('')}</ul></details>`
      : '';
  const memory = ui.memory;
  const memoryLine = memory
    ? `<p class="ws-ai-memory mu"><b>${esc(t.memoryStatus)}</b> : ${esc(memory.status)}${memory.stopReason ? ` (${esc(memory.stopReason)})` : ''} — ${esc(t.runPill(t.depths[memory.depth], t.modes[memory.mode]))}</p>`
    : '';
  return `<section class="card wide ws-ai-run" aria-labelledby="ws-ai-run-t">${picker}<div class="ws-ai-head"><h3 id="ws-ai-run-t">${esc(t.run(run.id))} <span class="pill mu">${esc(t.runPill(t.depths[run.depth ?? 'STANDARD'], t.modes[run.mode]))}</span></h3><span class="ws-ai-meta"><span class="pill ${tone}">${esc(t.status[run.status])}</span>${
    run.stopReason ? `<span class="pill mu" title="${esc(t.stop)}">${esc(run.stopReason)}</span>` : ''
  }</span></div><p class="mu">${esc(t.startedBy(run.startedBy, formatDate(run.startedAt, ctx.lang)))}${
    run.provider || run.model ? ` — ${esc([run.provider, run.model].filter(Boolean).join(' / '))}` : ''
  }</p><div class="ws-ai-progress" role="progressbar" aria-valuemin="0" aria-valuemax="${String(total)}" aria-valuenow="${String(done)}" aria-label="${esc(t.progress(done, total))}"><span class="ws-ai-bar" style="width:${String(total > 0 ? Math.round((done / total) * 100) : 0)}%"></span></div><p class="mu ws-ai-progress-t">${esc(t.progress(done, total))}</p><dl class="ws-ai-usage">${usage}${tokens}</dl>${
    run.error ? `<p class="err"><b>${esc(t.error)}</b> : ${esc(run.error)}</p>` : ''
  }${limitations}${memoryLine}${extendForm(ctx, ui)}</section>`;
}

function extendForm(ctx: WorkspaceContext, ui: AiUi): string {
  const t = text(ctx.lang);
  if (!ui.memory || !ctx.can('DECIDE') || ctx.demo) return '';
  const limits = ui.memory.limits;
  const limitsText =
    limits.length > 0
      ? `<ul class="plain tight ws-ai-limitlist">${limits
          .slice(-5)
          .map((limit) => `<li>${esc(t.limitLine(limit.limit, limit.remaining.length))}</li>`)
          .join('')}</ul>`
      : '';
  return `<details class="ws-ai-extend" data-ws-details="ai-extend"><summary>${esc(t.extend)}</summary><p class="mu">${esc(t.extendHint)}</p>${limitsText}<div class="row-acts ws-ai-extend-form"><label class="mu" for="ws-ai-extend-key">${esc(t.extend)}</label><select id="ws-ai-extend-key" data-ws-field="ai.extendKey">${AI_BUDGET_KEYS.map((key) => `<option value="${key}"${ui.extendKey === key ? ' selected' : ''}>${esc(t.extendKeys[key])}</option>`).join('')}</select><input type="text" inputmode="numeric" class="mono ws-ai-extend-value" data-ws-field="ai.extendValue" value="${esc(ui.extendValue)}" aria-label="${esc(t.extendKeys[ui.extendKey])}"><button type="button" class="btn small" data-action="ws-ai-extend"${ui.busy !== undefined || !/^[1-9][0-9]*$/.test(ui.extendValue) ? ' disabled' : ''}>${esc(t.extendDo)}</button></div>${
    ui.errors.extend ? errorBox(t, ui.errors.extend, 'extend') : ''
  }</details>`;
}

function sectionTabs(ctx: WorkspaceContext, ui: AiUi): string {
  const t = text(ctx.lang);
  const run = shownRun(ctx.incident, ui);
  const memory = ui.memory ?? undefined;
  const counts: Partial<Record<AiSection, number>> = {
    findings: run?.findings.length,
    proposals: proposalQueue(ctx.incident, memory).length,
    hypotheses: ctx.incident.investigation.hypotheses.length,
    contradictions: memory?.contradictions.length,
    timeline: memory?.timeline.length,
    assistant: ctx.incident.investigation.ai?.answers.length,
  };
  return `<div class="ws-ai-tabs" role="group" aria-label="${esc(t.title)}">${AI_SECTIONS.map((section) => {
    const count = counts[section];
    return `<button type="button" class="chip small ws-ai-tab" id="ws-ai-sec-${section}" data-action="ws-ai-section" data-section="${section}" aria-pressed="${String(ui.section === section)}" aria-controls="ws-ai-section">${esc(t.sections[section])}${count !== undefined && count > 0 ? ` <span class="count">${String(count)}</span>` : ''}</button>`;
  }).join('')}</div>`;
}

function sectionBody(ctx: WorkspaceContext, ui: AiUi, run: AiInvestigationRun | undefined): string {
  switch (ui.section) {
    case 'plan':
      return planSection(ctx, ui, run);
    case 'findings':
      return findingsSection(ctx, run);
    case 'proposals':
      return proposalsSection(ctx, ui);
    case 'hypotheses':
      return hypothesesSection(ctx, ui);
    case 'contradictions':
      return contradictionsSection(ctx, ui);
    case 'coverage':
      return coverageSection(ctx, ui);
    case 'timeline':
      return timelineSection(ctx, ui);
    case 'assistant':
      return assistantSection(ctx, ui);
  }
}

const statusTone = (status: AiAgentStatus): string =>
  status === 'DONE'
    ? 'ok'
    : status === 'RUNNING'
      ? 'live'
      : status === 'FAILED' || status === 'CANCELLED'
        ? 'ko'
        : 'mu';

function planSection(ctx: WorkspaceContext, ui: AiUi, run: AiInvestigationRun | undefined): string {
  const t = text(ctx.lang);
  if (!run) return panelState(ctx.lang, 'empty', t.noRun);
  const plan =
    run.plan.length === 0
      ? `<p class="mu">${esc(t.planEmpty)}</p>`
      : `<ol class="ws-ai-plan">${run.plan
          .map(
            (step) =>
              `<li class="ws-ai-step"><span class="pill ${statusTone(step.status)}">${esc(t.agentStatus[step.status])}</span><span class="ws-ai-step-t"><b>${esc(step.title)}</b> <small class="mu">${esc(t.agents[step.agent])}</small>${
                step.targets.length > 0
                  ? `<span class="ws-chips">${step.targets
                      .slice(0, 6)
                      .map((target) => `<span class="ws-chip static">${esc(target)}</span>`)
                      .join('')}</span>`
                  : ''
              }${step.summary ? `<span class="mu">${esc(step.summary)}</span>` : ''}</span></li>`,
          )
          .join('')}</ol>`;
  const agents = `<table class="ws-ai-table"><thead><tr><th scope="col">${esc(t.agentsTitle)}</th><th scope="col">${esc(t.agentStatus.PENDING)}</th><th scope="col"></th></tr></thead><tbody>${run.steps
    .map(
      (step) =>
        `<tr><th scope="row">${esc(t.agents[step.agent])}</th><td><span class="pill ${statusTone(step.status)}">${esc(t.agentStatus[step.status])}</span></td><td>${esc(step.summary ?? step.error ?? '')}${
          step.toolCalls.length > 0
            ? ` <small class="mu">(${esc(t.toolCalls(step.toolCalls.length))})</small>`
            : ''
        }</td></tr>`,
    )
    .join('')}</tbody></table>`;
  const synthesis = run.synthesis
    ? `<section class="ws-ai-synth"><h4>${esc(t.synthesis)}</h4><p>${esc(run.synthesis.summary)}</p>${
        run.synthesis.ranking.length > 0
          ? `<p><b>${esc(t.ranking)}</b> : ${run.synthesis.ranking.map((id) => hypothesisLink(ctx, id)).join(', ')}</p>`
          : ''
      }${run.synthesis.missing.length > 0 ? `<p><b>${esc(t.missing)}</b> : ${esc(run.synthesis.missing.join(' ; '))}</p>` : ''}</section>`
    : '';
  const memory = ui.memory;
  const strategies =
    memory && memory.strategies.length > 0
      ? `<h4>${esc(t.strategies)}</h4>${strategyTable(t, memory.strategies)}`
      : '';
  return `<h3 class="ws-ai-h">${esc(t.plan)}</h3>${plan}<h4>${esc(t.agentsTitle)}</h4>${agents}${synthesis}${strategies}`;
}

function strategyTable(t: Text, strategies: readonly InvestigationStrategy[]): string {
  return `<table class="ws-ai-table"><thead><tr>${t.strategyCols.map((col) => `<th scope="col">${esc(col)}</th>`).join('')}</tr></thead><tbody>${strategies
    .map(
      (strategy) =>
        `<tr><th scope="row">${esc(strategy.name)}</th><td>${esc(strategy.category)}</td><td><span class="pill ${strategy.status === 'COMPLETED' ? 'ok' : strategy.status === 'RUNNING' ? 'live' : strategy.status === 'FAILED' ? 'ko' : 'mu'}">${esc(strategy.status)}</span></td><td>${esc(strategy.expectedInformationGain.toFixed(2))}</td><td>${String(strategy.attempts)}</td><td class="mu">${esc(strategy.reason ?? '')}</td></tr>`,
    )
    .join('')}</tbody></table>`;
}

function hypothesisLink(ctx: WorkspaceContext, id: string): string {
  const hypothesis = ctx.incident.investigation.hypotheses.find((entry) => entry.id === id);
  const label = hypothesis?.title ?? id;
  return `<button type="button" class="lnk ${selectionClass(ctx, 'hypothesis', id)}" ${selectable(ctx, 'hypothesis', id)}>${esc(label)}</button>`;
}

const isSelectionKind = (value: string): value is SelectionKind =>
  (SELECTION_KINDS as readonly string[]).includes(value);

/** Les références d'un constat : des puces sélectionnables quand la sorte est connue de l'espace. */
export function refChips(ctx: WorkspaceContext, refs: readonly AiRef[], max = 6): string {
  if (refs.length === 0) return '';
  const shown = refs.slice(0, max);
  return `<span class="ws-chips">${shown
    .map((ref) => {
      const label = esc(ref.id.split(/[:#/]/).filter(Boolean).at(-1) ?? ref.id);
      if (!isSelectionKind(ref.kind))
        return `<span class="ws-chip static" title="${esc(ref.id)}">${label}</span>`;
      return `<button type="button" class="ws-chip ${selectionClass(ctx, ref.kind, ref.id)}" ${selectable(ctx, ref.kind, ref.id)} title="${esc(`${ref.kind} ${ref.id}`)}">${label}</button>`;
    })
    .join(
      '',
    )}${refs.length > shown.length ? `<span class="ws-chip more">+${String(refs.length - shown.length)}</span>` : ''}</span>`;
}

function locationLinks(ctx: WorkspaceContext, locations: readonly AiSourceLocation[]): string {
  if (locations.length === 0) return '';
  return `<span class="ws-ai-locs">${locations
    .slice(0, 6)
    .map((location) => {
      const layer =
        ctx.incident.scope.applications.find((application) => application.id === location.applicationId)
          ?.layer ?? 'BACKEND';
      return sourceLink(
        ctx.lang,
        { applicationId: location.applicationId, layer, file: location.file, line: location.line ?? 1 },
        `${location.file.split('/').at(-1) ?? location.file}${location.line !== undefined ? `:${String(location.line)}` : ''}`,
      );
    })
    .join(' ')}</span>`;
}

function findingsSection(ctx: WorkspaceContext, run: AiInvestigationRun | undefined): string {
  const t = text(ctx.lang);
  if (!run) return panelState(ctx.lang, 'empty', t.noRun);
  if (run.findings.length === 0) return panelState(ctx.lang, 'empty', t.findingsEmpty);
  return `<ul class="plain ws-ai-findings">${run.findings
    .map(
      (finding) =>
        `<li class="card ws-ai-finding" id="${domId('ws-ai-f', finding.id)}"><div class="ws-ai-head"><h4>${esc(finding.title)}</h4><span class="ws-ai-meta"><span class="pill mu">${esc(t.agents[finding.agent])}</span><span class="pill mu">${esc(finding.layer)}</span><span class="pill ${finding.basis === 'INFERRED' ? 'warn' : 'ok'}">${esc(t.basis[finding.basis])}</span></span></div><p>${esc(finding.summary)}</p>${
          finding.hypothesisId
            ? `<p class="mu"><b>${esc(t.forHypothesis)}</b> : ${hypothesisLink(ctx, finding.hypothesisId)}</p>`
            : ''
        }${finding.refs.length > 0 ? `<p class="ws-ai-refs"><b>${esc(t.refs)}</b> ${refChips(ctx, finding.refs)}</p>` : ''}${
          finding.locations.length > 0
            ? `<p class="ws-ai-refs"><b>${esc(t.locations)}</b> ${locationLinks(ctx, finding.locations)}</p>`
            : ''
        }</li>`,
    )
    .join('')}</ul>`;
}

function proposalsSection(ctx: WorkspaceContext, ui: AiUi): string {
  const t = text(ctx.lang);
  const queue = proposalQueue(ctx.incident, ui.memory);
  if (queue.length === 0) return panelState(ctx.lang, 'empty', t.proposalsEmpty);
  const canDecide = ctx.can('DECIDE') && !ctx.demo;
  return `<p class="mu">${esc(t.proposalsNote)}</p>${canDecide ? '' : `<p class="mu">${esc(t.decideRight)}</p>`}<ul class="plain ws-ai-props">${queue
    .map((proposal) => {
      const generated = 'operations' in proposal ? proposal : undefined;
      const permissions = [...proposal.permissions, ...(proposal.sideEffects ? [t.sideEffects] : [])];
      const busy =
        ui.busy === aiBusyKey('ws-ai-approve', proposal.id) ||
        ui.busy === aiBusyKey('ws-ai-refuse', proposal.id);
      const tone =
        proposal.status === 'DONE'
          ? 'ok'
          : proposal.status === 'REFUSED'
            ? 'ko'
            : proposal.status === 'PLANNED'
              ? 'live'
              : 'warn';
      const decide =
        proposal.status === 'PROPOSED' && canDecide
          ? `<div class="row-acts"><button type="button" class="btn small primary" data-action="ws-ai-approve" data-proposal="${esc(proposal.id)}"${busy || ui.busy !== undefined ? ' disabled' : ''}>${esc(t.approve)}</button><button type="button" class="btn small ghost" data-action="ws-ai-refuse" data-proposal="${esc(proposal.id)}"${busy || ui.busy !== undefined ? ' disabled' : ''}>${esc(t.refuse)}</button></div>`
          : '';
      const planned = proposal.experimentId
        ? `<p class="mu"><button type="button" class="lnk ${selectionClass(ctx, 'experiment', proposal.experimentId)}" ${selectable(ctx, 'experiment', proposal.experimentId)}>${esc(t.planned(proposal.experimentId))}</button></p>`
        : '';
      const error = ui.errors[`decide:${proposal.id}`];
      return `<li class="card ws-ai-prop" id="${domId('ws-ai-p', proposal.id)}"><div class="ws-ai-head"><h4>${esc(proposal.objective)}</h4><span class="ws-ai-meta"><span class="pill mu">${esc(proposal.kind)}</span><span class="pill ${tone}">${esc(t.proposalStatus[proposal.status])}</span>${
        permissions.length > 0
          ? `<span class="pill warn" title="${esc(permissions.join(' ; '))}">${esc(t.needsApproval)}</span>`
          : ''
      }</span></div><p class="mu"><b>${esc(t.forHypothesis)}</b> : ${hypothesisLink(ctx, proposal.hypothesisId)}</p><p>${esc(proposal.verification.description)}</p><dl class="ws-ai-kv"><div><dt>${esc(t.expected)}</dt><dd>${esc(proposal.expected)}</dd></div><div><dt>${esc(t.confirmIf)}</dt><dd>${esc(proposal.confirmIf)}</dd></div><div><dt>${esc(t.refuteIf)}</dt><dd>${esc(proposal.refuteIf)}</dd></div></dl>${
        permissions.length > 0
          ? `<ul class="plain tight mu">${permissions.map((entry) => `<li>${esc(entry)}</li>`).join('')}</ul>`
          : ''
      }${
        generated && generated.operations.length > 0
          ? `<details class="ws-ai-ops"><summary>${esc(t.operations)}</summary><ul class="plain tight mono">${generated.operations.map((operation) => `<li>${esc(JSON.stringify(operation))}</li>`).join('')}</ul></details>`
          : ''
      }${proposal.refusal ? `<p class="mu">${esc(proposal.refusal)}</p>` : ''}${planned}${decide}${
        error ? errorBox(t, error, `decide:${proposal.id}`) : ''
      }</li>`;
    })
    .join('')}</ul>`;
}

/** La pastille d'origine d'une hypothèse (« IA » ou « Règle ») : toujours visible là où l'hypothèse l'est. */
export function originPill(hypothesis: Pick<Hypothesis, 'origin'>, lang: Lang): string {
  const t = text(lang);
  const origin = hypothesis.origin ?? 'RULE';
  return `<span class="pill ${origin === 'AI' ? 'warn' : 'mu'} ws-ai-origin" title="${esc(origin === 'AI' ? t.sub : t.deterministicNote)}">${esc(t.origin[origin])}</span>`;
}

function hypothesesSection(ctx: WorkspaceContext, ui: AiUi): string {
  const t = text(ctx.lang);
  const hypotheses = ctx.incident.investigation.hypotheses;
  if (hypotheses.length === 0) return panelState(ctx.lang, 'empty', t.hypothesesEmpty);
  const explorations = new Map((ui.memory?.explorations ?? []).map((entry) => [entry.hypothesisId, entry]));
  return `<p class="mu">${esc(t.rolesNote)}</p><ul class="plain ws-ai-hyps">${hypotheses
    .map((hypothesis) => {
      const exploration = explorations.get(hypothesis.id);
      const role = exploration?.role;
      const roleTone =
        role === 'CONFIRMED_CAUSE'
          ? 'ok'
          : role === 'REFUTED'
            ? 'ko'
            : role === 'PROBABLE_CAUSE' || role === 'CONTRIBUTING_FACTOR'
              ? 'warn'
              : 'mu';
      return `<li class="card ws-ai-hyp ${selectionClass(ctx, 'hypothesis', hypothesis.id)}"><div class="ws-ai-head"><h4><button type="button" class="lnk" ${selectable(ctx, 'hypothesis', hypothesis.id)}>${esc(hypothesis.title)}</button></h4><span class="ws-ai-meta">${originPill(hypothesis, ctx.lang)}<span class="pill mu">${esc(hypothesis.status)}</span>${
        role ? `<span class="pill ${roleTone}">${esc(t.roles[role])}</span>` : ''
      }</span></div><p class="mu">${esc(hypothesis.suspectedCause)}</p>${
        exploration
          ? `<p class="mu">${esc(t.verifications(exploration.verifications.length))}${
              exploration.contributors.length > 0
                ? ` — ${exploration.contributors.map((agent) => esc(t.agents[agent])).join(', ')}`
                : ''
            }</p>${
              exploration.unknowns.length > 0
                ? `<p><b>${esc(t.unknowns)}</b></p><ul class="plain tight">${exploration.unknowns.map((entry) => `<li>${esc(entry)}</li>`).join('')}</ul>`
                : ''
            }${
              exploration.relations.length > 0
                ? `<p><b>${esc(t.relations)}</b> : ${exploration.relations
                    .map(
                      (relation) =>
                        `${esc(t.relationKinds[relation.kind] ?? relation.kind)} ${hypothesisLink(ctx, relation.to === hypothesis.id ? relation.from : relation.to)}`,
                    )
                    .join(' ; ')}</p>`
                : ''
            }`
          : ''
      }</li>`;
    })
    .join('')}</ul>`;
}

function contradictionsSection(ctx: WorkspaceContext, ui: AiUi): string {
  const t = text(ctx.lang);
  const memory = ui.memory;
  if (ui.memoryState === 'loading') return panelState(ctx.lang, 'loading', t.memoryLoading);
  const list = memory?.contradictions ?? [];
  if (list.length === 0) return panelState(ctx.lang, 'empty', t.contradictionsEmpty);
  return `<ul class="plain ws-ai-ctrs">${list
    .map(
      (contradiction) =>
        `<li class="card ws-ai-ctr"><div class="ws-ai-head"><h4>${esc(contradiction.kind)}</h4><span class="ws-ai-meta">${
          contradiction.openQuestion ? `<span class="pill warn">${esc(t.openQuestion)}</span>` : ''
        }<span class="pill ${contradiction.status === 'OPEN' ? 'live' : 'mu'}">${esc(t.contradictionStatus[contradiction.status] ?? contradiction.status)}</span><span class="pill mu">${esc(t.agents[contradiction.foundBy])}</span></span></div><p>${esc(contradiction.summary)}</p><p class="mu"><b>${esc(t.forHypothesis)}</b> : ${hypothesisLink(ctx, contradiction.hypothesisId)}</p>${
          contradiction.refs.length > 0
            ? `<p class="ws-ai-refs"><b>${esc(t.refs)}</b> ${refChips(ctx, contradiction.refs)}</p>`
            : ''
        }${contradiction.proposalId ? `<p class="mu">${esc(t.decisive(contradiction.proposalId))}</p>` : ''}</li>`,
    )
    .join('')}</ul>`;
}

function coverageSection(ctx: WorkspaceContext, ui: AiUi): string {
  const t = text(ctx.lang);
  if (ui.memoryState === 'loading') return panelState(ctx.lang, 'loading', t.memoryLoading);
  const coverage = ui.memory?.coverage ?? [];
  if (coverage.length === 0) return panelState(ctx.lang, 'empty', t.coverageEmpty);
  return `<p class="mu">${esc(t.coverageNote)}</p><table class="ws-ai-table"><thead><tr>${t.coverageCols.map((col) => `<th scope="col">${esc(col)}</th>`).join('')}</tr></thead><tbody>${coverage
    .map(
      (entry) =>
        `<tr><th scope="row">${esc(t.dimensions[entry.dimension])}</th><td><span class="pill ${entry.state === 'EXAMINED' ? 'ok' : entry.state === 'PARTIAL' ? 'warn' : entry.state === 'BLOCKED' ? 'ko' : 'mu'}">${esc(t.coverageState[entry.state])}</span></td><td>${entry.examined !== undefined ? String(entry.examined) : '—'}</td><td>${entry.total !== undefined ? String(entry.total) : '—'}</td><td class="mu">${esc(entry.denominator ?? '')}</td><td class="mu">${esc(entry.reason ?? '')}</td></tr>`,
    )
    .join('')}</tbody></table>`;
}

function timelineSection(ctx: WorkspaceContext, ui: AiUi): string {
  const t = text(ctx.lang);
  if (ui.memoryState === 'loading') return panelState(ctx.lang, 'loading', t.memoryLoading);
  if (ui.memoryState && typeof ui.memoryState === 'object')
    return panelState(ctx.lang, 'error', t.memoryError(ui.memoryState.error), 'ws-ai-reload');
  const memory = ui.memory;
  const events = memory?.timeline ?? [];
  if (events.length === 0) return panelState(ctx.lang, 'empty', t.timelineEmpty);
  const shown = [...events].reverse().slice(0, MAX_TIMELINE_SHOWN);
  const remaining =
    memory && memory.remaining.length > 0
      ? `<h4>${esc(t.remaining)}</h4><ul class="plain tight">${memory.remaining
          .slice(0, 20)
          .map((entry) => `<li>${esc(entry)}</li>`)
          .join('')}</ul>`
      : '';
  const permissions =
    memory && memory.permissions.length > 0
      ? `<h4>${esc(t.permissions)}</h4><ul class="plain tight">${memory.permissions
          .slice(-20)
          .map(
            (permission) =>
              `<li><span class="pill ${permission.decision === 'APPROVED' ? 'ok' : 'ko'}">${esc(permission.decision)}</span> ${esc(permission.operation)} <code>${esc(
                Object.entries(permission.parameters)
                  .map(([key, value]) => `${key}=${value}`)
                  .join(' '),
              )}</code> <small class="mu">${esc(t.askedBy(permission.by, formatDate(permission.at, ctx.lang)))}</small></li>`,
          )
          .join('')}</ul>`
      : '';
  return `<ol class="ws-ai-timeline">${shown
    .map(
      (event) =>
        `<li class="ws-ai-ev"><time datetime="${esc(event.at)}" class="mu mono">${esc(formatDate(event.at, ctx.lang))}</time><span class="pill mu">${esc(event.kind)}</span>${
          event.agent ? `<span class="pill mu">${esc(t.agents[event.agent])}</span>` : ''
        }<span class="ws-ai-ev-t">${esc(event.summary)}${event.refs.length > 0 ? ` ${refChips(ctx, event.refs, 4)}` : ''}</span></li>`,
    )
    .join('')}</ol>${remaining}${permissions}`;
}

function assistantSection(ctx: WorkspaceContext, ui: AiUi): string {
  const t = text(ctx.lang);
  const answers = ctx.incident.investigation.ai?.answers ?? [];
  const canAsk = ctx.can('RUN') && !ctx.demo && ui.busy === undefined && chosenMode(ui) !== 'DETERMINISTIC';
  const form = `<form class="col ws-ai-ask" data-action="ws-ai-ask" novalidate><label for="ws-ai-question">${esc(t.question)}</label><textarea id="ws-ai-question" rows="3" maxlength="1000" data-ws-field="ai.question" placeholder="${esc(t.questionPlaceholder)}">${esc(ui.question)}</textarea><div class="row-acts"><button type="submit" class="btn primary" data-action="ws-ai-ask"${canAsk ? '' : ' disabled'}>${esc(t.ask)}</button></div>${
    ui.errors.ask ? errorBox(t, ui.errors.ask, 'ask') : ''
  }</form>`;
  const list =
    answers.length === 0
      ? `<p class="mu">${esc(t.answersEmpty)}</p>`
      : `<ul class="plain ws-ai-answers">${[...answers]
          .reverse()
          .map(
            (answer) =>
              `<li class="card ws-ai-answer"><p class="ws-ai-q"><b>${esc(answer.question)}</b> <small class="mu">${esc(t.askedBy(answer.askedBy, formatDate(answer.askedAt, ctx.lang)))}</small></p>${
                answer.unavailable
                  ? `<p class="mu">${esc(t.unavailableAnswer(answer.unavailable))}</p>`
                  : `<p>${esc(answer.answer)}</p>`
              }${answer.refs.length > 0 ? `<p class="ws-ai-refs"><b>${esc(t.refs)}</b> ${refChips(ctx, answer.refs)}</p>` : ''}${
                answer.locations.length > 0
                  ? `<p class="ws-ai-refs"><b>${esc(t.locations)}</b> ${locationLinks(ctx, answer.locations)}</p>`
                  : ''
              }</li>`,
          )
          .join('')}</ul>`;
  return `<p class="mu">${esc(t.assistantSub)}</p>${form}${list}`;
}

export const INCIDENT_AI_CSS = `
.ws-ai{display:flex;flex-direction:column;gap:12px;min-width:0}
.ws-ai-intro p,.ws-ai-controls p{margin:4px 0}
.ws-ai-unavailable{display:flex;gap:8px;align-items:flex-start}
.ws-ai-facts,.ws-ai-kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:6px 16px;margin:8px 0 0}
.ws-ai-facts dt,.ws-ai-kv dt{font-size:12px;color:var(--qa-color-muted)}
.ws-ai-facts dd,.ws-ai-kv dd{margin:0;overflow-wrap:anywhere}
.ws-ai-row{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;margin:0 0 8px}
.ws-ai-label{min-width:88px;font-weight:600;font-size:13px}
.ws-ai-choices{display:flex;flex-wrap:wrap;gap:6px}
.ws-ai-choice{min-height:32px;padding:0 12px;font-size:13px}
.ws-ai-choice[disabled]{opacity:.55;cursor:not-allowed}
.ws-ai-actions{margin-top:8px}
.ws-ai-confirm{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:8px 12px;border-radius:10px;border:2px solid var(--qa-color-warning);background:color-mix(in srgb,var(--qa-color-warning) 10%,transparent)}
.ws-ai-confirm p{margin:0;flex:1 1 240px}
.ws-ai-err{display:flex;gap:8px;align-items:flex-start;justify-content:space-between;margin-top:8px}
.ws-ai-runs{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
.ws-ai-head{display:flex;flex-wrap:wrap;gap:6px 16px;align-items:center;justify-content:space-between}
.ws-ai-head h3,.ws-ai-head h4{margin:0;min-width:0;overflow-wrap:anywhere}
.ws-ai-meta{display:inline-flex;flex-wrap:wrap;gap:6px;align-items:center}
.ws-ai-progress{position:relative;height:8px;border-radius:999px;background:var(--qa-color-surface-2);border:1px solid var(--qa-color-border);overflow:hidden;margin:8px 0 4px}
.ws-ai-bar{position:absolute;inset:0 auto 0 0;background:var(--qa-color-primary);transition:width .2s}
.ws-ai-progress-t{margin:0 0 8px;font-size:13px}
.ws-ai-usage{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:6px 12px;margin:0}
.ws-ai-cell dt{font-size:12px;color:var(--qa-color-muted)}
.ws-ai-cell dd{margin:0;font:600 13px var(--qa-font-family-mono)}
.ws-ai-limits,.ws-ai-extend,.ws-ai-ops{margin-top:8px}
.ws-ai-limits summary,.ws-ai-extend summary,.ws-ai-ops summary{cursor:pointer}
.ws-ai-extend-form{align-items:center;margin-top:6px}
.ws-ai-extend-form select,.ws-ai-extend-value{min-height:32px;padding:4px 8px;border:1px solid var(--qa-color-border);border-radius:8px;background:var(--qa-color-surface);color:var(--qa-color-text)}
.ws-ai-extend-value{width:90px}
.ws-ai-tabs{display:flex;flex-wrap:wrap;gap:6px}
.ws-ai-tab{min-height:32px;padding:0 12px;font-size:13px}
.ws-ai-tab .count{margin-left:4px;font-size:11px;opacity:.8}
.ws-ai-section{display:flex;flex-direction:column;gap:8px;min-width:0}
.ws-ai-h{margin:0;font-size:16px}
.ws-ai-plan{margin:0;padding:0 0 0 20px;display:flex;flex-direction:column;gap:6px}
.ws-ai-step{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:baseline}
.ws-ai-step-t{display:flex;flex-wrap:wrap;gap:4px 8px;align-items:baseline;min-width:0}
.ws-ai-table{width:100%;border-collapse:collapse;font-size:13px}
.ws-ai-table th,.ws-ai-table td{border-bottom:1px solid var(--qa-color-border);padding:6px 8px;text-align:left;vertical-align:top;overflow-wrap:anywhere}
.ws-ai-table th[scope="col"]{font-size:12px;color:var(--qa-color-muted);font-weight:600}
.ws-ai-synth{margin-top:8px;padding:10px 12px;border-radius:10px;border:1px dashed var(--qa-color-border)}
.ws-ai-synth h4{margin:0 0 6px}
.ws-ai-findings,.ws-ai-props,.ws-ai-hyps,.ws-ai-ctrs,.ws-ai-answers{display:flex;flex-direction:column;gap:10px;margin:0;padding:0}
.ws-ai-finding p,.ws-ai-prop p,.ws-ai-hyp p,.ws-ai-ctr p,.ws-ai-answer p{margin:4px 0;overflow-wrap:anywhere}
.ws-ai-refs{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.ws-ai-locs{display:inline-flex;flex-wrap:wrap;gap:6px}
.ws-ai-origin{text-transform:uppercase;letter-spacing:.04em}
.ws-ai-timeline{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px}
.ws-ai-ev{display:flex;flex-wrap:wrap;gap:4px 8px;align-items:baseline;padding:4px 0;border-bottom:1px solid var(--qa-color-border)}
.ws-ai-ev time{font-size:12px;white-space:nowrap}
.ws-ai-ev-t{flex:1 1 240px;min-width:0;overflow-wrap:anywhere}
.ws-ai-ask textarea{width:100%;min-height:72px;padding:8px;border:1px solid var(--qa-color-border);border-radius:8px;background:var(--qa-color-surface);color:var(--qa-color-text);font:inherit;resize:vertical}
.ws-ai-ask textarea:focus-visible{outline:2px solid var(--qa-color-primary);outline-offset:1px}
.ws-ai-q{margin:0 0 4px}
.ws-compact .ws-ai{gap:8px}
`;
