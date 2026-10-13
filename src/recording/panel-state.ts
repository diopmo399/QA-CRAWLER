import type { FlowStep, FlowTarget } from '../config/flow-schema.js';
import type {
  LiveAction,
  LiveActionStatus,
  LiveCandidate,
  LiveQuality,
  LiveSummary,
} from './live-timeline.js';
import type { RecordedFlow, RecordedFlowStep } from './model.js';
import { VALIDATED_STATUSES, type TargetValidationStatus } from './target-validator.js';
import { describeTarget, hasTarget } from './target-correction.js';

/**
 * L'ÉTAT DU PANNEAU « QA-CRAWLER Recorder » : tout ce que la fenêtre affiche, sérialisable, construit
 * côté Node. Deux zones qui ne se mélangent jamais :
 *
 *   ENREGISTREMENT  les actions réellement faites (timeline en direct, puis les étapes du flow)
 *   ANALYSE         intention métier, constats de l'audit, suggestions — jamais dans la timeline
 */
export type PanelPhase = 'RECORDING' | 'PAUSED' | 'FINALIZING' | 'REVIEW';

export interface PanelStep {
  id: string;
  index: number;
  /** click, fill, check… (l'icône de la ligne). */
  kind: string;
  /** La validation dite point par point (panneau de détails) : uniquement ce qui a été vérifié. */
  checks: { ok: boolean; text: string }[];
  description: string;
  detail?: string;
  status: LiveActionStatus;
  statusText: string;
  technical: Record<string, string>;
  candidates?: LiveCandidate[];
  resolution?: 'RESOLVED' | 'IGNORED' | 'CORRECTED';
  /** Revue : l'étape peut être retirée du flow (une action humaine ; jamais une vérification). */
  removable?: boolean;
  /** CORRECTION MANAGER : l'étape vise un élément, l'humain peut le corriger dans le navigateur. */
  correctable?: boolean;
  /** La cible courante (lisible), l'original si elle a été corrigée, l'historique. */
  correction?: PanelCorrection;
  /** Le groupe affiché au-dessus de l'étape : l'étape métier (revue) ou l'écran (en direct). */
  group?: string;
  /** Les requêtes reliées à l'action (analyse HTTP) : l'inspecteur les montre à côté de la cible. */
  network?: PanelNetwork[];
  /** Revue d'une SAISIE : la source de sa valeur (fixe, générée, réutilisée) et les variables réutilisables. */
  data?: PanelStepData;
}

/** La cible d'une étape telle que la fenêtre la montre : courante, originale (si corrigée), historique. */
export interface PanelCorrection {
  current: string;
  original?: string;
  corrected: boolean;
  history: { at: number; from: string; to: string }[];
}

/**
 * LE MODE SÉLECTION en cours (correction manager) : l'étape visée, l'état (la page attend un clic, un
 * élément a été désigné, annulé, impossible), et la proposition construite à partir de l'élément désigné.
 */
export interface PanelPick {
  stepId: string;
  /** PREPARING : la session de correction rejoue les étapes précédentes (revue) ; UNREACHABLE : le chemin s'est arrêté avant l'étape. */
  status: 'PREPARING' | 'PICKING' | 'PICKED' | 'CANCELLED' | 'UNAVAILABLE' | 'UNREACHABLE';
  /** Ce que l'humain est en train de remplacer (le libellé de l'étape). */
  label: string;
  /** PREPARING : étapes précédentes rejouées / à rejouer. */
  progress?: { executed: number; total: number };
  /** UNREACHABLE : l'étape précédente qui a arrêté le chemin et pourquoi. */
  stoppedAt?: { index: number; label: string; reason: string };
  /** UNAVAILABLE : pourquoi la page n'est pas disponible. */
  reason?: string;
  proposal?: {
    target: string;
    /**
     * La cible est dans une ligne de tableau : comment identifier la ligne. `bound` : par une donnée du
     * run (`via` : sa clé ou la valeur saisie) ; `key` : par la clé lue dans le tableau, `fixed` quand
     * elle est propre à ce run (le prochain rejeu ne la retrouvera pas).
     */
    rowOptions?: {
      id: 'bound' | 'key' | 'manual';
      target: string;
      row: string;
      via?: string;
      match?: 'exact' | 'contains';
      fixed?: boolean;
    }[];
    /** La cible sans sa ligne (la liaison manuelle y ajoute la sienne). */
    baseTarget?: string;
    /** LIAISON MANUELLE : les cellules de la ligne et les données du run (clé → valeur actuelle, non sensibles). */
    rowCells?: { column: string; value: string }[];
    variables?: { key: string; value: string }[];
    quality: string;
    label: string;
    order: string[];
    alternatives: string[];
    ambiguous: boolean;
    traits: {
      role: string;
      name?: string;
      label?: string;
      text?: string;
      testId?: string;
      css: string;
      section?: string;
      tag: string;
    };
  };
  /** L'ancienne cible, lisible. */
  previous?: string;
}

/** La liaison de données d'une saisie, telle que la fenêtre la montre (jamais un secret). */
export interface PanelStepData {
  key?: string;
  source: 'FIXED' | 'GENERATED' | 'REFERENCE' | 'SENSITIVE';
  generator?: string;
  reference?: string;
  recordedValue?: string;
  /** Les variables produites par une étape ANTÉRIEURE. */
  options: { key: string; stepIndex: number; label: string }[];
  /** La liaison trouvée automatiquement (une proposition). */
  suggestion?: string;
  /** Un choix explicite de l'humain est en vigueur. */
  manual: boolean;
  generators: string[];
}

/** Une requête reliée à une action : ce que l'inspecteur en montre (jamais une valeur saisie). */
export interface PanelNetwork {
  api: string;
  status?: number;
  operation: string;
  /** TRIGGERED / CANDIDATE / AMBIGUOUS · confiance. */
  link: string;
  /** « Search companies » → companyName CONTAINS. */
  criteria: string[];
  /** Ce qui n'est pas un critère : tri, pagination, options. */
  extras: string[];
}

export interface PanelReplay {
  status: 'RUNNING' | 'PASSED' | 'FAILED';
  executed: number;
  total: number;
  /** Les vérifications d'un rejeu réussi (toutes les cibles retrouvées, aucune ambiguïté…). */
  checks?: { ok: boolean; text: string }[];
  failure?: {
    /** Position de l'étape (1…total) et sa description humaine. */
    index: number;
    stepId?: string;
    description: string;
    /** La cause en mots simples ; les détails techniques sont secondaires. */
    cause: string;
    details: string[];
  };
  report?: string;
  /**
   * LA REPRISE après une correction (contexte gardé) : la stratégie décidée, l'étape où le rejeu a repris,
   * pourquoi, les étapes rejouées pour restaurer ou reconstruire, et ce qui bloque une reprise manuelle.
   */
  recovery?: {
    strategy: 'RESTORE' | 'REBUILD' | 'REVALIDATE' | 'MANUAL_RECOVERY';
    from: number;
    reasons: string[];
    recovered: number[];
    blockedBy?: { step?: number; reason: string }[];
  };
}

export interface PanelAnalysis {
  available: boolean;
  /** LA LIGNÉE DES DONNÉES : chaque variable, l'étape qui la produit, celles qui la saisissent ou la citent. */
  dataLineage?: {
    key: string;
    strategy: string;
    generator?: string;
    producedBy?: string;
    uses: string[];
  }[];
  /** Les intents MÉTIER (après corrélation : une écriture métier acceptée). */
  intents: { label: string; detail?: string; confidence?: number; evidence: string[] }[];
  /** Les intents TECHNIQUES (ACQUIRE_TOKEN, DISCOVER_PROVIDER…) : séparés, jamais métier. */
  technicalIntents?: { label: string; detail?: string; evidence: string[] }[];
  /**
   * L'ANALYSE HTTP CONSOLIDÉE (après l'arrêt) : son état, ses compteurs, les opérations, les
   * correspondances champ ↔ propriété (avec leur état), les incohérences et les révisions du direct.
   */
  http?: {
    status: 'COMPLETE' | 'FAILED';
    errors: string[];
    counts: {
      events: number;
      network: number;
      correlated: number;
      independent: number;
      hypotheses: number;
      inconsistencies: number;
      revisions: number;
    };
    operations: string[];
    mappings: { label: string; property: string; state: string; transformation: string }[];
    inconsistencies: string[];
    revisions: string[];
    /** Les recherches reconnues : critères, logique, tri, paramètres, preuves. */
    searches?: PanelSearch[];
  };
  /**
   * LA REVUE DES INTENTIONS : chaque action, son intention finale, sa confiance, sa provenance
   * (SYSTEM, HUMAN), l'original et l'historique — l'humain corrige, confirme ou réinitialise.
   */
  intentReview?: { choices: string[]; rows: PanelIntentRow[] };
  /** Les intents de RECHERCHE (interprétation métier d'une requête, distincte de sa classification technique). */
  searchIntents?: PanelSearch[];
  findings: { severity: string; message: string; suggestion?: string; origin: string }[];
  aiCandidates: number;
  /** L'analyse du conseiller tourne encore en arrière-plan (la revue n'attend pas). */
  running?: boolean;
  /**
   * L'INTERPRÉTATION MÉTIER : chaque étape (créer, rechercher, ouvrir…), les actions enregistrées
   * qu'elle regroupe, ce qui a été OBSERVÉ (réseau, écran, navigation) et ce qui est DÉDUIT.
   */
  /** LE MODÈLE DE L'APPLICATION, en arbre (les actions techniques restent dans le parcours). */
  application?: {
    tree: PanelTreeNode[];
    /** Les trois niveaux des actions : enregistrées, validées, interprétées (le reste : UNKNOWN). */
    counts?: { recorded: number; validated: number; interpreted: number; uninterpreted: number };
  };
  business?: {
    steps: PanelBusinessStep[];
    unresolved: { type: string; status: string; candidates?: string[]; recorded: string[] }[];
    /** Les entités observées et leur PROVENANCE (créée, découverte, existante, inconnue, ambiguë). */
    entities?: PanelBusinessEntity[];
  };
}

/** Une action dans la revue des intentions. */
export interface PanelIntentRow {
  actionId: string;
  /** Le genre de l'action enregistrée (CLICK, TYPE, NAVIGATE…) : seulement pour son icône. */
  kind?: string;
  label: string;
  intent: string;
  status: 'INFERRED' | 'HUMAN_CORRECTED' | 'HUMAN_CONFIRMED';
  source: 'SYSTEM' | 'HUMAN';
  confidence?: number;
  original?: string;
  originalConfidence?: number;
  reason?: string;
  proposal?: string;
  history: string[];
}

/** Une recherche reconnue dans une requête : ce que la fenêtre en montre. */
export interface PanelSearch {
  api: string;
  /** La classification technique (si le chemin en a une) : gardée à part, jamais à la place de la recherche. */
  technical?: string;
  logic?: string;
  criteria: {
    /** Le libellé du champ d'interface (si une saisie l'a fourni). */
    label?: string;
    property: string;
    operator?: string;
    /** La valeur montrée : la donnée de test (déjà dans test-data.yaml), un jeton de structure, ou « saisie ». */
    value: string;
    testData?: string;
    fromCreation?: boolean;
    state: string;
    confidence: number;
  }[];
  sort: string[];
  parameters: { role: string; paths: string[] }[];
  interpretation?: string;
  evidence: string[];
  confidence: number;
  state: string;
}

/**
 * Un nœud de l'arbre de l'application (Workspace → Task → MFE → Entity → actions) : son statut
 * (observé, déduit, confirmé, incertain), sa confiance, ses preuves et les actions enregistrées.
 */
export interface PanelTreeNode {
  label: string;
  detail?: string;
  status?: 'OBSERVED' | 'DEDUCED' | 'CONFIRMED' | 'UNCERTAIN';
  confidence?: number;
  evidence: string[];
  recorded: string[];
  children: PanelTreeNode[];
}

export interface PanelBusinessEntity {
  key: string;
  name: string;
  identity?: string;
  provenance: string;
  confidence: number;
  reason: string;
  lifecycle: string[];
  contradictions?: string[];
}

export interface PanelBusinessStep {
  action: string;
  entity: string;
  provenance?: string;
  status: 'CONFIRMED' | 'PROBABLE' | 'AMBIGUOUS' | 'UNKNOWN';
  confidence: number;
  output?: string;
  outputValue?: string;
  reference?: string;
  recorded: string[];
  observed: string[];
  deduced: string[];
  ai: boolean;
}

export interface PanelState {
  language: 'fr' | 'en';
  name: string;
  phase: PanelPhase;
  startedAt: number;
  endedAt?: number;
  actions: PanelStep[];
  /** Revue : les vérifications du flow (déduites des résultats observés), séparées des actions. */
  checks: { id: string; description: string }[];
  summary: LiveSummary;
  quality: LiveQuality;
  progress?: { label: string; step: number; total: number; detail?: string };
  highlight?: { actionId: string; result: 'ORIGINAL' | 'SELECTOR' | 'NOT_FOUND' };
  notice?: { actionId?: string; kind: 'error' | 'info'; message: string };
  replay?: PanelReplay;
  /** CORRECTION MANAGER : le mode sélection en cours ou la proposition à valider. */
  pick?: PanelPick;
  saved?: { directory: string; files: string[] };
  /**
   * L'APERÇU de l'application (une image de la page, en mémoire seulement) et le cadre de l'élément
   * sélectionné, à sa position réelle.
   */
  preview?: {
    image: string;
    url: string;
    width: number;
    height: number;
    highlight?: { actionId: string; x: number; y: number; width: number; height: number; label?: string };
  };
  analysis: PanelAnalysis;
  /** L'ANALYSE HTTP EN DIRECT (provisoire) : des compteurs, jamais une vérité. */
  http?: {
    network: number;
    correlated: number;
    hypotheses: number;
    inconsistencies: number;
    pending: number;
    failed: boolean;
    /** La dernière recherche reconnue, en une ligne (provisoire) : « "Search companies" → companyName CONTAINS ». */
    search?: string;
  };
  directory?: string;
  /** La disposition demandée au démarrage (recording.panelLayout) ; la fenêtre garde ensuite le choix de l'humain. */
  layout?: 'full' | 'compact';
  /** L'étape à montrer (sélectionnée, défilée) à l'ouverture de la fenêtre depuis le dock (« Résoudre »). */
  focus?: string;
  /** Une correction validée dans une page tenue : le rejeu peut REPRENDRE à cette étape (contexte gardé). */
  resume?: { stepId: string; index: number; description: string; running?: boolean };
  /** L'aperçu est ouvert dans sa propre fenêtre (la fenêtre principale garde le parcours et les détails). */
  previewDetached?: boolean;
}

const CHECKS = {
  fr: {
    confirmed: 'Action confirmée',
    found: (n: number) => `Élément retrouvé (${String(n)} correspondance${n > 1 ? 's' : ''})`,
    ambiguous: (n: number) => `${String(n)} éléments correspondent`,
    notFound: 'Élément non retrouvé',
    pending: 'Validation en cours',
    navigation: (route: string) => `Navigation déclenchée → ${route}`,
    effect: (effect: string) => `Effet observé : ${effect}`,
    resolved: "Élément touché confirmé par l'utilisateur",
    ignored: "Ambiguïté laissée par l'utilisateur",
    corrected: "Cible corrigée par l'utilisateur dans la page",
    unverified: 'Cible non vérifiable',
    stable: 'Sélecteur stable',
    fragile: 'Sélecteur fragile',
  },
  en: {
    confirmed: 'Action confirmed',
    found: (n: number) => `Element found (${String(n)} match${n > 1 ? 'es' : ''})`,
    ambiguous: (n: number) => `${String(n)} elements match`,
    notFound: 'Element not found again',
    pending: 'Being validated',
    navigation: (route: string) => `Navigation triggered → ${route}`,
    effect: (effect: string) => `Effect observed: ${effect}`,
    resolved: 'Touched element confirmed by the user',
    ignored: 'Ambiguity left by the user',
    corrected: 'Target corrected by the user in the page',
    unverified: 'Target not verifiable',
    stable: 'Stable selector',
    fragile: 'Fragile selector',
  },
} as const;

/** La validation d'une action dite point par point — seulement ce qui a vraiment été vérifié. */
export function checksOf(action: LiveAction, language: 'fr' | 'en'): { ok: boolean; text: string }[] {
  const text = CHECKS[language];
  const checks: { ok: boolean; text: string }[] = [];
  if (action.status === 'PENDING') return [{ ok: false, text: text.pending }];
  if (action.status === 'CONFIRMED') checks.push({ ok: true, text: text.confirmed });
  if (action.status === 'UNVERIFIED') checks.push({ ok: false, text: text.unverified });
  if (action.status === 'FAILED') checks.push({ ok: false, text: text.notFound });
  const count = action.evidence.candidates;
  if (action.status === 'AMBIGUOUS' || (count !== undefined && count > 1 && action.resolution === undefined))
    checks.push({ ok: false, text: text.ambiguous(Math.max(count ?? 2, 2)) });
  else if (count !== undefined && action.status !== 'FAILED')
    checks.push({ ok: true, text: text.found(count) });
  if (action.resolution === 'RESOLVED') checks.push({ ok: true, text: text.resolved });
  if (action.resolution === 'IGNORED') checks.push({ ok: false, text: text.ignored });
  if (action.resolution === 'CORRECTED') checks.push({ ok: true, text: text.corrected });
  if (action.kind !== 'open' && action.kind !== 'navigate')
    checks.push({
      ok: action.facts.stableSelector,
      text: action.facts.stableSelector ? text.stable : text.fragile,
    });
  if (action.evidence.navigatedTo)
    checks.push({ ok: true, text: text.navigation(action.evidence.navigatedTo) });
  for (const effect of (action.evidence.effects ?? []).slice(0, 3))
    checks.push({ ok: true, text: text.effect(effect) });
  return checks;
}

export function liveStep(action: LiveAction, language: 'fr' | 'en' = 'fr'): PanelStep {
  return {
    id: action.id,
    index: action.index,
    kind: action.kind,
    checks: checksOf(action, language),
    description: action.description,
    ...(action.detail ? { detail: action.detail } : {}),
    status: action.status,
    statusText: action.statusText,
    technical: action.technical,
    ...(action.candidates ? { candidates: action.candidates } : {}),
    ...(action.resolution ? { resolution: action.resolution } : {}),
    ...(LIVE_CORRECTABLE.has(action.kind) ? { correctable: true } : {}),
    ...(action.resolution === 'CORRECTED' && action.technical.target
      ? { correction: { current: action.technical.target, corrected: true, history: [] } }
      : {}),
  };
}

/** Les gestes en direct qui visent un élément (une page ouverte, une touche, une boîte de dialogue : non). */
const LIVE_CORRECTABLE = new Set<string>(['click', 'fill', 'check', 'uncheck', 'choose', 'select', 'upload']);

const TEXT = {
  fr: {
    goto: (url: string) => `Aller à ${url}`,
    click: (name: string) => `Cliquer sur "${name}"`,
    fill: (field: string) => `Saisir dans "${field}"`,
    select: (option: string, field: string) => `Sélectionner "${option}" dans "${field}"`,
    check: (name: string) => `Cocher "${name}"`,
    uncheck: (name: string) => `Décocher "${name}"`,
    drag: (item: string) => `Glisser "${item}"`,
    manual: (text: string) => `À faire à la main : ${text}`,
    expect: 'Vérifier',
    confirmed: 'Cible confirmée',
    toCheck: 'À confirmer au rejeu',
    resolved: "Élément confirmé par l'utilisateur",
    left: "Ambiguïté laissée par l'utilisateur",
    corrected: "Cible corrigée par l'utilisateur",
    recorded: 'Enregistrée',
  },
  en: {
    goto: (url: string) => `Go to ${url}`,
    click: (name: string) => `Click "${name}"`,
    fill: (field: string) => `Type in "${field}"`,
    select: (option: string, field: string) => `Select "${option}" in "${field}"`,
    check: (name: string) => `Check "${name}"`,
    uncheck: (name: string) => `Uncheck "${name}"`,
    drag: (item: string) => `Drag "${item}"`,
    manual: (text: string) => `To do by hand: ${text}`,
    expect: 'Check',
    confirmed: 'Target confirmed',
    toCheck: 'To confirm at replay',
    resolved: 'Element confirmed by the user',
    left: 'Ambiguity left by the user',
    corrected: 'Target corrected by the user',
    recorded: 'Recorded',
  },
} as const;

function targetName(target: FlowTarget): string {
  return target.name ?? target.value ?? target.role ?? target.strategy;
}

/** Une étape du flow dite en langage courant (sans la valeur : la valeur vient de la timeline en direct). */
export function describeFlowStep(step: FlowStep, language: 'fr' | 'en'): string {
  const text = TEXT[language];
  switch (step.kind) {
    case 'goto':
      return text.goto(step.url);
    case 'click':
      return text.click(targetName(step.target));
    case 'fill':
      return text.fill(targetName(step.target));
    case 'select':
      return text.select(step.option, targetName(step.target));
    case 'check':
      return text.check(targetName(step.target));
    case 'uncheck':
      return text.uncheck(targetName(step.target));
    case 'dragAndDrop':
      return text.drag(step.item);
    case 'manual':
      return text.manual(step.text);
    case 'expect':
      return `${text.expect} : ${describeExpectation(step)}`;
    default:
      return step.kind;
  }
}

function describeExpectation(step: Extract<FlowStep, { kind: 'expect' }>): string {
  const expect = step.expect as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof expect.url === 'string') parts.push(`URL ${expect.url}`);
  const response = expect.response as { method?: string; url?: string; status?: string } | undefined;
  if (response)
    parts.push(`${response.method ?? ''} ${response.url ?? ''} → ${response.status ?? ''}`.trim());
  if (typeof expect.text === 'string') parts.push(`"${expect.text}"`);
  if (typeof expect.visible === 'string') parts.push(`"${expect.visible}"`);
  return parts.join(', ') || Object.keys(expect).join(', ');
}

/**
 * La revue : les étapes du FLOW FINAL (celui qui sera rejoué et sauvegardé), décrites avec les
 * mots de la timeline en direct quand elles viennent des mêmes événements bruts (la valeur saisie,
 * en mémoire seulement). Les vérifications sont rendues à part : ce ne sont pas des actions.
 */
export function reviewSteps(
  flow: RecordedFlow,
  live: readonly LiveAction[],
  language: 'fr' | 'en',
): { actions: PanelStep[]; checks: { id: string; description: string }[] } {
  const text = TEXT[language];
  const actions: PanelStep[] = [];
  const checks: { id: string; description: string }[] = [];
  for (const item of flow.steps) {
    if (item.step.kind === 'expect') {
      checks.push({ id: item.id, description: describeFlowStep(item.step, language) });
      continue;
    }
    const twin = live.find((action) => action.rawEventIds.some((id) => item.rawEventIds.includes(id)));
    const { status, statusText } = reviewStatus(item, text);
    const validated = item.targetValidation;
    actions.push({
      id: item.id,
      index: actions.length + 1,
      kind: item.step.kind,
      checks: [
        ...(twin ? checksOf(twin, language) : []),
        ...(!twin && validated ? [{ ok: status === 'CONFIRMED', text: statusText }] : []),
      ],
      description: twin && twin.kind !== 'open' ? twin.description : describeFlowStep(item.step, language),
      ...(twin?.detail ? { detail: twin.detail } : {}),
      status,
      statusText,
      ...(item.userDecision === 'TARGET_CORRECTED_BY_USER' ? { resolution: 'CORRECTED' as const } : {}),
      ...(hasTarget(item.step)
        ? { correctable: true, correction: correctionOf(item, item.step.target) }
        : {}),
      technical: {
        step: item.id,
        kind: item.step.kind,
        ...('target' in item.step ? { target: JSON.stringify(item.step.target) } : {}),
        provenance: item.provenance,
        ...(item.quality ? { locator: item.quality } : {}),
        ...(item.targetValidation ? { validation: item.targetValidation.status } : {}),
        raw: item.rawEventIds.join(','),
        ...(item.userDecision ? { decision: item.userDecision } : {}),
      },
      removable: true,
    });
  }
  return { actions, checks };
}

/** La cible d'une étape pour la fenêtre : courante, originale si corrigée, et l'historique lisible. */
function correctionOf(item: RecordedFlowStep, target: FlowTarget): PanelCorrection {
  const history = (item.corrections ?? []).map((entry) => ({
    at: entry.at,
    from: describeTarget(entry.previous),
    to: describeTarget(entry.next),
  }));
  const first = item.corrections?.[0];
  return {
    current: describeTarget(target),
    ...(first ? { original: describeTarget(first.previous) } : {}),
    corrected: item.userDecision === 'TARGET_CORRECTED_BY_USER',
    history,
  };
}

function reviewStatus(
  item: RecordedFlowStep,
  text: (typeof TEXT)['fr' | 'en'],
): { status: LiveActionStatus; statusText: string } {
  if (item.userDecision === 'TARGET_CORRECTED_BY_USER')
    return { status: 'CONFIRMED', statusText: text.corrected };
  if (item.userDecision === 'AMBIGUITY_CONFIRMED_BY_USER')
    return { status: 'CONFIRMED', statusText: text.resolved };
  if (item.userDecision === 'AMBIGUITY_LEFT_BY_USER') return { status: 'AMBIGUOUS', statusText: text.left };
  const validation = item.targetValidation;
  if (!validation) return { status: 'UNVERIFIED', statusText: text.recorded };
  if (VALIDATED_STATUSES.has(validation.status as TargetValidationStatus))
    return { status: 'CONFIRMED', statusText: text.confirmed };
  if (validation.status === 'AMBIGUOUS') return { status: 'AMBIGUOUS', statusText: text.toCheck };
  return { status: validation.requiresReplayValidation ? 'FAILED' : 'UNVERIFIED', statusText: text.toCheck };
}

/** Le résumé d'une liste d'étapes (revue). */
export function summaryOf(steps: readonly PanelStep[]): LiveSummary {
  const count = (status: LiveActionStatus): number => steps.filter((step) => step.status === status).length;
  const ambiguous = count('AMBIGUOUS');
  const failed = count('FAILED');
  return {
    actions: steps.length,
    confirmed: count('CONFIRMED'),
    pending: count('PENDING'),
    ambiguous,
    failed,
    unverified: count('UNVERIFIED'),
    attention:
      steps.filter((step) => step.status === 'AMBIGUOUS' && step.resolution !== 'IGNORED').length + failed,
  };
}
