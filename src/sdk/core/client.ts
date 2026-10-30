import type {
  AssertionProposalView,
  Capabilities,
  DataBindingInput,
  DataBindingResult,
  ErrorBody,
  ExplorationEvent,
  ExplorationSnapshot,
  ExplorationSummary,
  FlowStudioView,
  FlowView,
  GenerationInput,
  RegressionView,
  RunComparisonView,
  TraceabilityView,
  GenerationResult,
  GeneratedTestsView,
  GeneratedFileEditInput,
  GeneratedFileRestoreInput,
  GeneratedFileView,
  GeneratedFileCheckView,
  GeneratedFileDiagnostic,
  GenerationPreview,
  TestRunInput,
  TestRunView,
  GraphView,
  GroupCommandInput,
  ComposeScenarioInput,
  CorrectionView,
  CompositionCheck,
  CompositionDrift,
  DeclaredContract,
  LibraryAddInput,
  LibraryBlockView,
  LibrarySourcePreview,
  GroupCheckView,
  GroupEditResult,
  IntentDecisionInput,
  IntentReviewView,
  RowColumnInput,
  RowSourceView,
  GroupProposalView,
  RecordingReplayView,
  GroupViewDto,
  Project,
  ProjectDraft,
  ProposalDecisionInput,
  RecordingSnapshot,
  RecordingStreamEvent,
  ReportEntry,
  ReportEntryKind,
  ReportLink,
  RunLogEvent,
  TestDataView,
  UrlCheck,
  ValidationReport,
  DraftIssue,
  Environment,
  EnvironmentCheck,
  EnvironmentInput,
  ExecutionDetail,
  ExecutionRecord,
  ExecutionStartInput,
  ExplorationStartInput,
  OverviewView,
  ProjectDetail,
  ProjectSummary,
  ScenarioHistoryView,
  ScenarioView,
  AccessMe,
  ConfluenceImportInput,
  FileImportInput,
  JournalEntry,
  JournalKind,
  MemberCreated,
  MemberView,
  Role,
  ImportBatch,
  ImportProfile,
  ImportSummary,
  TraceabilityLink,
  LinkAddInput,
  MatrixRow,
  RequirementConnectorView,
  RequirementDecisionInput,
  RequirementsIndicators,
  RequirementsPublishResult,
  RequirementsView,
  TrendsView,
} from './contracts.js';
import { SDK_API_VERSION } from './contracts.js';

/**
 * LE CLIENT DU SDK : les appels à l'API du serveur QA-CRAWLER, depuis le navigateur (ou Node 20+).
 * Aucune dépendance : `fetch` et un lecteur de flux pour les événements (le flux d'événements passe
 * par fetch et non EventSource, qui ne peut pas envoyer l'en-tête d'autorisation).
 */
export interface ClientOptions {
  /** L'adresse de l'API, par exemple https://qa.example/qa-crawler/api */
  endpoint: string;
  /** Le jeton d'accès du serveur, transmis par le back-end de l'hôte. */
  token?: string;
  /** Remplace le fetch global (tests, intercepteurs de l'hôte). */
  fetch?: typeof fetch;
}

export class QaCrawlerError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: string[];
  readonly issues: DraftIssue[];
  readonly diagnostics: GeneratedFileDiagnostic[];

  constructor(body: ErrorBody) {
    super(body.error);
    this.name = 'QaCrawlerError';
    this.status = body.status;
    this.code = body.code;
    this.details = body.details ?? [];
    this.issues = body.issues ?? [];
    this.diagnostics = body.diagnostics ?? [];
  }
}

export interface Subscription {
  /** Arrête l'écoute (l'exploration, elle, continue sur le serveur). */
  close(): void;
  /** Résolue quand le flux se termine (exploration terminée, échouée ou écoute fermée). */
  done: Promise<void>;
}

export interface SubscribeOptions {
  /** Reprendre après cet événement (numéro `seq`) : les événements déjà reçus ne sont pas renvoyés. */
  after?: number;
  onError?: (error: Error) => void;
  /**
   * Après une coupure (réseau, serveur redémarré, réponse 5xx) avant l'événement de fin, le flux est
   * rouvert après le dernier `seq` reçu ; un événement déjà reçu n'est jamais transmis deux fois.
   * `retries: 0` désactive la reprise. Par défaut : 3 tentatives, 1 s puis 2 s puis 4 s.
   */
  reconnect?: { retries?: number; delayMs?: number };
  /** Appelé avant chaque nouvelle tentative, avec le dernier `seq` reçu. */
  onReconnect?: (attempt: number, after: number) => void;
}

/** Un statut qui termine un flux : après lui, le serveur ferme et rien ne doit être rouvert. */
const TERMINAL_STATUSES = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'STORED']);

function isEndEvent(event: unknown): boolean {
  if (!event || typeof event !== 'object') return false;
  const { type, status } = event as { type?: unknown; status?: unknown };
  return (
    type === 'completed' ||
    type === 'failed' ||
    // Le journal d'une exécution de test : sa fin, ou l'absence de journal conservé.
    type === 'RUN_FINISHED' ||
    type === 'UNAVAILABLE' ||
    (type === 'status' && TERMINAL_STATUSES.has(String(status)))
  );
}

/** Le serveur parle-t-il la version de contrat de ce client ? */
export function isCompatible(capabilities: Pick<Capabilities, 'apiVersion'>): boolean {
  return capabilities.apiVersion === SDK_API_VERSION;
}

export interface RecordingStartInput {
  /** Le nom du parcours (le dossier `recordings/<nom>/`). */
  name: string;
  /** Le chemin de départ dans l'application (défaut : le départ du projet). */
  startPath?: string;
  /** Rejouer le flow généré tout de suite (REPLAY_CONFIRMED / REPLAY_FAILED). */
  validate?: boolean;
}

export interface QaCrawlerClient {
  capabilities(): Promise<Capabilities>;
  /** Les capacités, après vérification de la version du contrat (`API_VERSION_MISMATCH` sinon). */
  connect(): Promise<Capabilities>;
  checks: {
    url(url: string): Promise<UrlCheck>;
    env(names: string[]): Promise<Record<string, boolean>>;
  };
  projects: {
    validate(draft: ProjectDraft): Promise<ValidationReport>;
    create(draft: ProjectDraft): Promise<Project>;
    get(id: string): Promise<Project>;
    /** Les projets de l'espace de travail (les archivés avec `archived: true`), comptés sur disque. */
    list(options?: { archived?: boolean }): Promise<ProjectSummary[]>;
    /** La fiche, la configuration, les environnements et les scénarios d'un projet. */
    detail(id: string): Promise<ProjectDetail>;
    /** Remplace la configuration (validée par le moteur, comme à la création) ; l'identifiant reste. */
    update(id: string, draft: ProjectDraft): Promise<ProjectDetail>;
    /** Une copie : configuration, environnements et scénarios ; ni exécutions ni enregistrements. */
    duplicate(id: string, input: { name: string }): Promise<ProjectDetail>;
    /** Archivé : gardé sur disque, en lecture seule, restaurable. Rien n'est supprimé. */
    archive(id: string): Promise<ProjectDetail>;
    restore(id: string): Promise<ProjectDetail>;
  };
  /** Les environnements d'un projet (dev, test, certification, préproduction) : les cibles d'une exécution. */
  environments: {
    list(projectId: string): Promise<Environment[]>;
    /** `selfId` : vérifier un environnement existant (son propre nom n'est pas un doublon). */
    check(
      projectId: string,
      input: EnvironmentInput,
      options?: { reach?: boolean; selfId?: string },
    ): Promise<EnvironmentCheck>;
    create(projectId: string, input: EnvironmentInput): Promise<Environment>;
    update(projectId: string, id: string, input: EnvironmentInput): Promise<Environment>;
    /** Irréversible : `confirm: true` est exigé par le serveur. */
    remove(projectId: string, id: string, input: { confirm: true }): Promise<{ removed: string }>;
  };
  /** Les scénarios d'un projet (ses flows) ; un enregistrement devient un scénario par promotion. */
  scenarios: {
    list(projectId: string): Promise<ScenarioView[]>;
    promote(projectId: string, recording: string): Promise<ScenarioView>;
    /** La stabilité des scénarios : leurs statuts dans les derniers runs (10 par défaut, 50 au plus). */
    history(projectId: string, options?: { limit?: number }): Promise<ScenarioHistoryView[]>;
    /** Un nouveau scénario fait de blocs de la bibliothèque, rejoués dans l'ordre par `run:` (vérifié d'abord). */
    compose(projectId: string, input: ComposeScenarioInput): Promise<ScenarioView>;
    /** Vérifie un parcours sans rien écrire ni exécuter : ordre, dépendances, données, erreurs. */
    checkComposition(projectId: string, input: ComposeScenarioInput): Promise<CompositionCheck>;
    /**
     * Insère un bloc de la bibliothèque au début ou à la fin d'un scénario (ses données suivent).
     * Avec `revision` (celle de ScenarioView), refusé (409) si le scénario a changé depuis sa lecture.
     */
    insert(
      projectId: string,
      scenario: string,
      input: { block: string; at: 'start' | 'end'; revision?: string },
    ): Promise<ScenarioView>;
    /** Accepte la version actuelle des blocs d'un parcours suivi, après l'avoir vérifié de nouveau. */
    acceptBlocks(projectId: string, scenario: string): Promise<CompositionCheck>;
  };
  /** La bibliothèque : des blocs réutilisables (`reusable: true`), rejoués par d'autres scénarios. */
  library: {
    list(projectId: string): Promise<LibraryBlockView[]>;
    add(projectId: string, input: LibraryAddInput): Promise<LibraryBlockView>;
    /** Retire un bloc (refusé tant qu'un scénario le rejoue ; `details` nomme ces scénarios). */
    remove(projectId: string, name: string): Promise<{ removed: string }>;
    /** Ce qu'un scénario deviendrait en bloc (étapes, données sans valeur, contrat dérivé). */
    preview(projectId: string, scenario: string): Promise<LibrarySourcePreview>;
    /** Déclare le contrat d'un bloc (null : de nouveau dérivé de son contenu). */
    declareContract(
      projectId: string,
      name: string,
      contract: DeclaredContract | null,
    ): Promise<LibraryBlockView>;
    /** Valide le contenu modifié d'un bloc : il devient sa version suivante. */
    validateVersion(projectId: string, name: string): Promise<LibraryBlockView>;
    /** Les parcours suivis dont un bloc a changé depuis leur composition. */
    drift(projectId: string): Promise<CompositionDrift[]>;
  };
  /** Les exécutions : le rejeu des scénarios par le moteur, suivi comme une exploration. */
  executions: {
    start(projectId: string, input?: ExecutionStartInput): Promise<ExplorationSnapshot>;
    list(projectId: string): Promise<ExecutionRecord[]>;
    get(projectId: string, run: string): Promise<ExecutionDetail>;
  };
  /** La vue d'ensemble, calculée sur disque (périmètre du taux de réussite : voir `definition`). */
  overview: {
    get(options?: { days?: number }): Promise<OverviewView>;
  };
  /**
   * Le référentiel d'exigences d'un projet. Rien n'y entre sans décision humaine : un import produit
   * des candidats, une personne décide, la publication écrit le référentiel.
   */
  requirements: {
    get(projectId: string): Promise<RequirementsView>;
    connectors(projectId: string): Promise<RequirementConnectorView[]>;
    profiles(projectId: string): Promise<ImportProfile[]>;
    imports(projectId: string): Promise<ImportSummary[]>;
    importBatch(projectId: string, batchId: string): Promise<ImportBatch>;
    /** Une page Confluence, lue par le serveur avec les variables nommées (jamais une valeur de secret). */
    importConfluence(projectId: string, input: ConfluenceImportInput): Promise<ImportBatch>;
    /** Un fichier Word, Excel ou PDF, envoyé tel quel (25 Mo au plus). */
    importFile(projectId: string, input: FileImportInput): Promise<ImportBatch>;
    decide(projectId: string, batchId: string, decisions: RequirementDecisionInput[]): Promise<ImportBatch>;
    /** Une lecture partielle n'est publiée qu'avec `acknowledgePartial: true`. */
    publish(
      projectId: string,
      batchId: string,
      options?: { acknowledgePartial?: boolean },
    ): Promise<RequirementsPublishResult>;
    matrix(projectId: string): Promise<MatrixRow[]>;
    /** La matrice en CSV (cellules protégées contre l'interprétation en formule). */
    matrixCsv(projectId: string): Promise<string>;
    indicators(projectId: string, options?: { days?: number }): Promise<RequirementsIndicators>;
    /** Un lien ajouté à la main est confirmé ; il demande une justification. */
    addLink(projectId: string, input: LinkAddInput): Promise<TraceabilityLink>;
    decideLink(
      projectId: string,
      linkId: string,
      action: 'CONFIRM' | 'REJECT',
      options?: { note?: string },
    ): Promise<TraceabilityLink>;
  };
  /**
   * Les accès : qui appelle et ses droits ; les membres (jetons nominatifs, rôles par projet) et le
   * journal, réservés à l'administration (MANAGE_ACCESS).
   */
  access: {
    me(options?: { projectId?: string }): Promise<AccessMe>;
    members(): Promise<MemberView[]>;
    /** Le jeton du membre n'est rendu qu'ici, une seule fois. */
    createMember(input: { name: string; role: Role }): Promise<MemberCreated>;
    /** Avec `projectId`, un rôle propre au projet (`null` le retire). */
    setRole(memberId: string, role: Role | null, options?: { projectId?: string }): Promise<MemberView>;
    revoke(memberId: string): Promise<MemberView>;
    journal(options?: { projectId?: string; kind?: JournalKind; limit?: number }): Promise<JournalEntry[]>;
  };
  /** Les tendances par semaine ISO : rejeux, anomalies, durée médiane, couverture, scénarios instables. */
  trends: {
    get(options?: { weeks?: number; projectId?: string }): Promise<TrendsView>;
  };
  explorations: {
    start(projectId: string, input?: ExplorationStartInput): Promise<ExplorationSnapshot>;
    status(id: string): Promise<ExplorationSnapshot>;
    result(id: string): Promise<ExplorationSummary>;
    subscribe(
      id: string,
      onEvent: (event: ExplorationEvent) => void,
      options?: SubscribeOptions,
    ): Subscription;
    reportLink(id: string): Promise<ReportLink>;
    /** Annule une exploration ou un rejeu (`capabilities.cancellation`) : CANCELLED quand le moteur s'est arrêté. */
    cancel(id: string): Promise<ExplorationSnapshot>;
  };
  /** Un humain joue le parcours dans le Chromium ouvert par le serveur ; le moteur en fait un flow. */
  recordings: {
    start(projectId: string, input: RecordingStartInput): Promise<RecordingSnapshot>;
    list(projectId: string): Promise<RecordingSnapshot[]>;
    get(projectId: string, name: string): Promise<RecordingSnapshot>;
    /** Arrête la session en cours (comme le bouton de la barre d'enregistrement). */
    stop(projectId: string, name: string): Promise<RecordingSnapshot>;
    /** Met la session en pause (les gestes ne sont plus enregistrés) ; `resume` la reprend. */
    pause(projectId: string, name: string): Promise<RecordingSnapshot>;
    resume(projectId: string, name: string): Promise<RecordingSnapshot>;
    /** Retire le dernier geste de l'enregistrement (l'application n'est pas remise en arrière). */
    undo(projectId: string, name: string): Promise<RecordingSnapshot>;
    /** Pose un point de contrôle « vérifier ici » sur l'écran courant. */
    checkpoint(projectId: string, name: string, label?: string): Promise<RecordingSnapshot>;
    /** Cible ambiguë : confirme l'élément voulu parmi ceux qui correspondent, ou laisse l'ambiguïté. */
    resolve(projectId: string, name: string, actionId: string, candidate: number): Promise<RecordingSnapshot>;
    ignore(projectId: string, name: string, actionId: string): Promise<RecordingSnapshot>;
    subscribe(
      projectId: string,
      name: string,
      onEvent: (event: RecordingStreamEvent) => void,
      options?: SubscribeOptions,
    ): Subscription;
    flow(projectId: string, name: string): Promise<FlowView>;
    /** Le Flow Studio : étapes, données produites et citées, dépendances, groupes, dernier rejeu. */
    studio(projectId: string, name: string): Promise<FlowStudioView>;
    /** Retire une étape d'action (et ses vérifications) du flow ; rend la vue à jour. */
    removeStep(projectId: string, name: string, stepId: string): Promise<FlowStudioView>;
    /** Le rejeu de validation : le lancer (dry run, sans fenêtre), puis le suivre. */
    replay(projectId: string, name: string): Promise<RecordingReplayView>;
    replayStatus(projectId: string, name: string): Promise<RecordingReplayView>;
    /** La revue des intentions : chaque action, son intention et sa provenance ; corriger, confirmer, réinitialiser. */
    intents(projectId: string, name: string): Promise<IntentReviewView>;
    reviewIntent(projectId: string, name: string, input: IntentDecisionInput): Promise<IntentReviewView>;
    /** La ligne visée par une étape (cellules enregistrées) ; la redéfinir colonne par colonne, sans navigateur. */
    rowSource(projectId: string, name: string, stepId: string): Promise<RowSourceView>;
    editRow(
      projectId: string,
      name: string,
      stepId: string,
      columns: RowColumnInput[],
    ): Promise<FlowStudioView>;
    /** « Restaurer l'original » : la cible redevient celle de l'enregistrement. */
    restoreTarget(projectId: string, name: string, stepId: string): Promise<FlowStudioView>;
  };
  /**
   * La correction d'une cible : le serveur rejoue jusqu'à l'étape dans un navigateur ouvert sur sa
   * machine ; l'humain y désigne l'élément ; la cible n'est remplacée qu'à `apply`. Une à la fois.
   */
  corrections: {
    start(projectId: string, recording: string, stepId: string): Promise<CorrectionView>;
    get(projectId: string, recording: string): Promise<CorrectionView>;
    pick(projectId: string, recording: string): Promise<CorrectionView>;
    apply(
      projectId: string,
      recording: string,
      choice?: { option?: string; binding?: { column: string; key: string } },
    ): Promise<CorrectionView>;
    resume(projectId: string, recording: string): Promise<CorrectionView>;
    close(projectId: string, recording: string): Promise<{ closed: true }>;
  };
  /** Les propositions d'assertions d'un enregistrement et les décisions humaines. */
  assertions: {
    list(projectId: string, recording: string): Promise<AssertionProposalView[]>;
    decide(
      projectId: string,
      recording: string,
      proposalId: string,
      input: ProposalDecisionInput,
    ): Promise<AssertionProposalView[]>;
  };
  /** Les données de test d'un enregistrement : lignée, source de chaque saisie, liaisons. */
  data: {
    get(projectId: string, recording: string): Promise<TestDataView>;
    /** Choisir la source d'une saisie (fixe, générée, reprise d'une étape antérieure) ; le moteur vérifie. */
    bind(projectId: string, recording: string, input: DataBindingInput): Promise<DataBindingResult>;
  };
  /** Les groupes métier d'étapes d'un enregistrement. */
  groups: {
    list(projectId: string, recording: string): Promise<GroupViewDto[]>;
    edit(
      projectId: string,
      recording: string,
      command: GroupCommandInput,
      options?: { force?: boolean },
    ): Promise<GroupEditResult>;
    /** Les groupes proposés d'après les étapes métier ; `acceptProposals` les crée tous d'un coup. */
    proposals(projectId: string, recording: string): Promise<GroupProposalView[]>;
    acceptProposals(projectId: string, recording: string): Promise<GroupEditResult>;
    /** Les vérifications suggérées par groupe ; `addCheck` en ajoute une (proposition acceptée). */
    checks(projectId: string, recording: string): Promise<GroupCheckView[]>;
    addCheck(
      projectId: string,
      recording: string,
      input: { groupId: string; key: string },
    ): Promise<AssertionProposalView[]>;
  };
  /** Les tests générés depuis un enregistrement (YAML, Gherkin, Playwright TypeScript, Java). */
  generation: {
    run(projectId: string, recording: string, input: GenerationInput): Promise<GenerationResult>;
    /** Les fichiers générés sur disque, les exécutions passées et les outils disponibles. */
    view(projectId: string, recording: string): Promise<GeneratedTestsView>;
    /** Exécute pour de vrai les tests générés d'un format (202 : en file). */
    execute(projectId: string, recording: string, input: TestRunInput): Promise<TestRunView>;
    runOf(projectId: string, recording: string, runId: string): Promise<TestRunView>;
    /**
     * Le journal d'une exécution (console) : les événements conservés, puis, en cours, ceux qui
     * arrivent jusqu'à RUN_FINISHED. Une coupure est reprise après le dernier `seq` reçu, sans doublon.
     */
    runEvents(
      projectId: string,
      recording: string,
      runId: string,
      onEvent: (event: RunLogEvent) => void,
      options?: SubscribeOptions,
    ): Subscription;
    /** Le journal d'une exécution en fichier (masqué comme à l'écran) : JSON ou texte. */
    runLogs(
      projectId: string,
      recording: string,
      runId: string,
      format: 'json' | 'text',
    ): Promise<{ name: string; type: string; content: string }>;
    cancel(projectId: string, recording: string, runId: string): Promise<TestRunView>;
    /** Le rapport QA-CRAWLER d'un rejeu (YAML, Gherkin). */
    reportLink(projectId: string, recording: string, runId: string): Promise<ReportLink>;
    /** Modifie un fichier généré, vérifié avant d'être écrit (422 avec les raisons sinon). */
    editFile(projectId: string, recording: string, input: GeneratedFileEditInput): Promise<GeneratedFileView>;
    /** Revient à la version générée d'un fichier modifié à la main. */
    restoreFile(
      projectId: string,
      recording: string,
      input: GeneratedFileRestoreInput,
    ): Promise<GeneratedFileView>;
    /** Vérifie un contenu sans l'écrire (diagnostics positionnés). */
    checkFile(
      projectId: string,
      recording: string,
      input: { path: string; content: string },
    ): Promise<GeneratedFileCheckView>;
    /** La version générée d'un fichier (sa sauvegarde s'il a été modifié à la main). */
    original(projectId: string, recording: string, path: string): Promise<{ path: string; content: string }>;
    /** Ce qu'une régénération écrirait, sans rien écrire. */
    preview(projectId: string, recording: string, input: GenerationInput): Promise<GenerationPreview>;
  };
  /** Le graphe des écrans et transitions, d'une exploration ou d'un enregistrement. */
  graph: {
    exploration(id: string): Promise<GraphView>;
    of(projectId: string, kind: ReportEntryKind, name: string): Promise<GraphView>;
  };
  /** Les rapports d'un projet sur disque, explorations et enregistrements. */
  reports: {
    list(projectId: string): Promise<ReportEntry[]>;
    link(projectId: string, kind: ReportEntryKind, name: string): Promise<ReportLink>;
    /** Deux explorations (`run-…`) comparées flow par flow et exigence par exigence ; rien n'est rejoué. */
    compare(projectId: string, base: string, head: string): Promise<RunComparisonView>;
    /** La traçabilité d'une exploration (404 quand la mission ne déclare pas d'exigence). */
    traceability(projectId: string, run: string): Promise<TraceabilityView>;
    /** L'analyse de régression d'une exploration, par rapport à l'historique du moteur. */
    regression(projectId: string, run: string): Promise<RegressionView>;
  };
  dispose(): void;
}

export function createQaCrawler(options: ClientOptions): QaCrawlerClient {
  const endpoint = options.endpoint.replace(/\/+$/, '');
  const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const controllers = new Set<AbortController>();
  let disposed = false;

  const headers = (json: boolean): Record<string, string> => ({
    accept: 'application/json',
    'x-qa-crawler-sdk': '1',
    ...(json ? { 'content-type': 'application/json' } : {}),
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
  });

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const text = await send(method, path, {
      headers: headers(body !== undefined),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    try {
      return (text ? JSON.parse(text) : undefined) as T;
    } catch {
      return undefined as T;
    }
  }

  /** Une requête : son corps en texte, ou l'erreur de l'API (code, message, détails). */
  async function send(method: string, path: string, init: RequestInit): Promise<string> {
    if (disposed) throw new QaCrawlerError({ error: 'client disposed', status: 0, code: 'DISPOSED' });
    let response: Response;
    try {
      response = await doFetch(`${endpoint}${path}`, { method, ...init });
    } catch (error) {
      throw new QaCrawlerError({
        error: `QA-CRAWLER server unreachable: ${error instanceof Error ? error.message : String(error)}`,
        status: 0,
        code: 'UNREACHABLE',
      });
    }
    const text = await response.text();
    if (!response.ok) {
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : undefined;
      } catch {
        parsed = undefined;
      }
      const errorBody = (parsed ?? {}) as Partial<ErrorBody>;
      throw new QaCrawlerError({
        error: errorBody.error ?? `HTTP ${String(response.status)}`,
        status: response.status,
        code: errorBody.code ?? 'HTTP_ERROR',
        ...(errorBody.details ? { details: errorBody.details } : {}),
        ...(errorBody.diagnostics ? { diagnostics: errorBody.diagnostics } : {}),
        ...(errorBody.issues ? { issues: errorBody.issues } : {}),
      });
    }
    return text;
  }

  function stream(
    path: string,
    onEvent: (event: unknown) => void,
    subscribeOptions: SubscribeOptions = {},
  ): Subscription {
    const controller = new AbortController();
    controllers.add(controller);
    const retries = Math.max(0, subscribeOptions.reconnect?.retries ?? 3);
    const delayMs = Math.max(0, subscribeOptions.reconnect?.delayMs ?? 1000);
    let lastSeq = subscribeOptions.after ?? 0;
    let ended = false;
    const wait = (ms: number): Promise<void> =>
      new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        controller.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    /** Une ouverture du flux ; rend l'erreur qui l'a interrompu (undefined : fin normale). */
    const open = async (): Promise<{ error?: Error; retryable: boolean }> => {
      const query = lastSeq > 0 ? `?after=${String(lastSeq)}` : '';
      let response: Response;
      try {
        response = await doFetch(`${endpoint}${path}${query}`, {
          headers: { ...headers(false), accept: 'text/event-stream' },
          signal: controller.signal,
        });
      } catch (error) {
        return { error: error instanceof Error ? error : new Error(String(error)), retryable: true };
      }
      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => '');
        let message = `HTTP ${String(response.status)}`;
        try {
          message = (JSON.parse(text) as Partial<ErrorBody>).error ?? message;
        } catch {
          // corps non JSON : le statut suffit
        }
        return {
          error: new QaCrawlerError({ error: message, status: response.status, code: 'STREAM_REFUSED' }),
          // Un refus (jeton, origine, exploration inconnue) ne change pas en réessayant.
          retryable: response.status >= 500,
        };
      }
      try {
        for await (const event of readEventStream<unknown>(response.body)) {
          // Écoute fermée : les événements déjà lus du même paquet ne sont plus transmis.
          if (controller.signal.aborted) break;
          const seq = (event as { seq?: unknown }).seq;
          if (typeof seq === 'number') {
            if (seq <= lastSeq) continue;
            lastSeq = seq;
          }
          if (isEndEvent(event)) ended = true;
          onEvent(event);
        }
      } catch (error) {
        return { error: error instanceof Error ? error : new Error(String(error)), retryable: true };
      }
      return { retryable: true };
    };
    // Lus par fonction : les deux changent pendant les attentes (abandon, événement de fin).
    const aborted = (): boolean => controller.signal.aborted;
    const finished = (): boolean => ended;
    const done = (async () => {
      try {
        let attempt = 0;
        for (;;) {
          const before = lastSeq;
          const outcome = await open();
          if (aborted() || finished()) return;
          // Des événements sont arrivés : la connexion vivait, le compte des tentatives repart.
          if (lastSeq > before) attempt = 0;
          if (!outcome.retryable || attempt >= retries) {
            subscribeOptions.onError?.(
              outcome.error ??
                new QaCrawlerError({
                  error: 'event stream closed before the end',
                  status: 0,
                  code: 'STREAM_CLOSED',
                }),
            );
            return;
          }
          attempt += 1;
          await wait(delayMs * 2 ** (attempt - 1));
          if (aborted()) return;
          subscribeOptions.onReconnect?.(attempt, lastSeq);
        }
      } finally {
        controllers.delete(controller);
      }
    })();
    return {
      close: () => {
        controller.abort();
      },
      done,
    };
  }

  const project = (id: string): string => `/projects/${encodeURIComponent(id)}`;
  const recording = (projectId: string, name: string): string =>
    `${project(projectId)}/recordings/${encodeURIComponent(name)}`;

  return {
    capabilities: () => request('GET', '/capabilities'),
    async connect() {
      const capabilities = await request<Capabilities>('GET', '/capabilities');
      if (!isCompatible(capabilities))
        throw new QaCrawlerError({
          error: `the server speaks contract version ${String(capabilities.apiVersion)}, this SDK speaks ${String(SDK_API_VERSION)}`,
          status: 0,
          code: 'API_VERSION_MISMATCH',
        });
      return capabilities;
    },
    checks: {
      url: (url) => request('POST', '/checks/url', { url }),
      env: (names) => request('POST', '/checks/env', { names }),
    },
    projects: {
      validate: (draft) => request('POST', '/projects/validate', { draft }),
      create: (draft) => request('POST', '/projects', { draft }),
      get: (id) => request('GET', `/projects/${encodeURIComponent(id)}`),
      list: (listOptions = {}) => request('GET', `/projects${listOptions.archived ? '?archived=true' : ''}`),
      detail: (id) => request('GET', `${project(id)}/detail`),
      update: (id, draft) => request('POST', `${project(id)}/config`, { draft }),
      duplicate: (id, input) => request('POST', `${project(id)}/duplicate`, input),
      archive: (id) => request('POST', `${project(id)}/archive`, {}),
      restore: (id) => request('POST', `${project(id)}/restore`, {}),
    },
    environments: {
      list: (projectId) => request('GET', `${project(projectId)}/environments`),
      check: (projectId, input, checkOptions = {}) =>
        request('POST', `${project(projectId)}/environments/check`, { environment: input, ...checkOptions }),
      create: (projectId, input) =>
        request('POST', `${project(projectId)}/environments`, { environment: input }),
      update: (projectId, id, input) =>
        request('POST', `${project(projectId)}/environments/${encodeURIComponent(id)}`, {
          environment: input,
        }),
      remove: (projectId, id, input) =>
        request('POST', `${project(projectId)}/environments/${encodeURIComponent(id)}/remove`, input),
    },
    scenarios: {
      list: (projectId) => request('GET', `${project(projectId)}/scenarios`),
      promote: (projectId, name) => request('POST', `${project(projectId)}/scenarios`, { recording: name }),
      history: (projectId, historyOptions = {}) =>
        request(
          'GET',
          `${project(projectId)}/scenarios/history${historyOptions.limit ? `?limit=${String(historyOptions.limit)}` : ''}`,
        ),
      compose: (projectId, input) => request('POST', `${project(projectId)}/scenarios/compose`, input),
      checkComposition: (projectId, input) =>
        request('POST', `${project(projectId)}/scenarios/compose/check`, input),
      insert: (projectId, scenario, input) =>
        request('POST', `${project(projectId)}/scenarios/${encodeURIComponent(scenario)}/insert`, input),
      acceptBlocks: (projectId, scenario) =>
        request('POST', `${project(projectId)}/scenarios/${encodeURIComponent(scenario)}/accept`, {}),
    },
    library: {
      list: (projectId) => request('GET', `${project(projectId)}/library`),
      add: (projectId, input) => request('POST', `${project(projectId)}/library`, input),
      remove: (projectId, name) =>
        request('POST', `${project(projectId)}/library/${encodeURIComponent(name)}/remove`, {}),
      preview: (projectId, scenario) =>
        request('GET', `${project(projectId)}/library/preview?scenario=${encodeURIComponent(scenario)}`),
      declareContract: (projectId, name, contract) =>
        request('PUT', `${project(projectId)}/library/${encodeURIComponent(name)}/contract`, { contract }),
      validateVersion: (projectId, name) =>
        request('POST', `${project(projectId)}/library/${encodeURIComponent(name)}/version`, {}),
      drift: (projectId) => request('GET', `${project(projectId)}/library/drift`),
    },
    executions: {
      start: (projectId, input = {}) => request('POST', `${project(projectId)}/executions`, input),
      list: (projectId) => request('GET', `${project(projectId)}/executions`),
      get: (projectId, run) => request('GET', `${project(projectId)}/executions/${encodeURIComponent(run)}`),
    },
    overview: {
      get: (overviewOptions = {}) =>
        request('GET', `/overview${overviewOptions.days ? `?days=${String(overviewOptions.days)}` : ''}`),
    },
    requirements: {
      get: (projectId) => request('GET', `${project(projectId)}/requirements`),
      connectors: (projectId) => request('GET', `${project(projectId)}/requirements/connectors`),
      profiles: (projectId) => request('GET', `${project(projectId)}/requirements/profiles`),
      imports: (projectId) => request('GET', `${project(projectId)}/requirements/imports`),
      importBatch: (projectId, batchId) =>
        request('GET', `${project(projectId)}/requirements/imports/${encodeURIComponent(batchId)}`),
      importConfluence: (projectId, input) =>
        request('POST', `${project(projectId)}/requirements/imports`, input),
      importFile: async (projectId, input) => {
        const query = new URLSearchParams({ connector: input.connector, name: input.name });
        if (input.profile) query.set('profile', input.profile);
        const text = await send(
          'POST',
          `${project(projectId)}/requirements/imports/file?${query.toString()}`,
          {
            headers: { ...headers(false), 'content-type': 'application/octet-stream' },
            body: input.data as BodyInit,
          },
        );
        return JSON.parse(text) as ImportBatch;
      },
      decide: (projectId, batchId, decisions) =>
        request(
          'POST',
          `${project(projectId)}/requirements/imports/${encodeURIComponent(batchId)}/decisions`,
          {
            decisions,
          },
        ),
      publish: (projectId, batchId, publishOptions = {}) =>
        request(
          'POST',
          `${project(projectId)}/requirements/imports/${encodeURIComponent(batchId)}/publish`,
          publishOptions,
        ),
      matrix: (projectId) => request('GET', `${project(projectId)}/requirements/matrix`),
      matrixCsv: (projectId) =>
        send('GET', `${project(projectId)}/requirements/matrix?format=csv`, {
          headers: { ...headers(false), accept: 'text/csv' },
        }),
      indicators: (projectId, indicatorOptions = {}) =>
        request(
          'GET',
          `${project(projectId)}/requirements/indicators${indicatorOptions.days ? `?days=${String(indicatorOptions.days)}` : ''}`,
        ),
      addLink: (projectId, input) => request('POST', `${project(projectId)}/requirements/links`, input),
      decideLink: (projectId, linkId, action, linkOptions = {}) =>
        request('POST', `${project(projectId)}/requirements/links/${encodeURIComponent(linkId)}`, {
          action,
          ...linkOptions,
        }),
    },
    access: {
      me: (meOptions = {}) =>
        request(
          'GET',
          `/access/me${meOptions.projectId ? `?projectId=${encodeURIComponent(meOptions.projectId)}` : ''}`,
        ),
      members: () => request('GET', '/access/members'),
      createMember: (input) => request('POST', '/access/members', input),
      setRole: (memberId, role, roleOptions = {}) =>
        request('POST', `/access/members/${encodeURIComponent(memberId)}`, {
          role,
          ...(roleOptions.projectId ? { projectId: roleOptions.projectId } : {}),
        }),
      revoke: (memberId) => request('POST', `/access/members/${encodeURIComponent(memberId)}/revoke`, {}),
      journal: (journalOptions = {}) => {
        const query = new URLSearchParams();
        if (journalOptions.projectId) query.set('projectId', journalOptions.projectId);
        if (journalOptions.kind) query.set('kind', journalOptions.kind);
        if (journalOptions.limit) query.set('limit', String(journalOptions.limit));
        const suffix = query.toString();
        return request('GET', `/access/journal${suffix ? `?${suffix}` : ''}`);
      },
    },
    trends: {
      get: (trendOptions = {}) => {
        const query = new URLSearchParams();
        if (trendOptions.weeks) query.set('weeks', String(trendOptions.weeks));
        if (trendOptions.projectId) query.set('projectId', trendOptions.projectId);
        const suffix = query.toString();
        return request('GET', `/trends${suffix ? `?${suffix}` : ''}`);
      },
    },
    explorations: {
      start: (projectId, input = {}) =>
        request('POST', `/projects/${encodeURIComponent(projectId)}/explorations`, input),
      status: (id) => request('GET', `/explorations/${encodeURIComponent(id)}`),
      result: (id) => request('GET', `/explorations/${encodeURIComponent(id)}/result`),
      subscribe: (id, onEvent, subscribeOptions) =>
        stream(
          `/explorations/${encodeURIComponent(id)}/events`,
          (event) => {
            onEvent(event as ExplorationEvent);
          },
          subscribeOptions,
        ),
      reportLink: (id) => request('POST', `/explorations/${encodeURIComponent(id)}/report-links`, {}),
      cancel: (id) => request('POST', `/explorations/${encodeURIComponent(id)}/cancel`, {}),
    },
    recordings: {
      start: (projectId, input) => request('POST', `${project(projectId)}/recordings`, input),
      list: (projectId) => request('GET', `${project(projectId)}/recordings`),
      get: (projectId, name) => request('GET', recording(projectId, name)),
      stop: (projectId, name) => request('POST', `${recording(projectId, name)}/stop`, {}),
      pause: (projectId, name) => request('POST', `${recording(projectId, name)}/pause`, {}),
      resume: (projectId, name) => request('POST', `${recording(projectId, name)}/resume`, {}),
      undo: (projectId, name) => request('POST', `${recording(projectId, name)}/undo`, {}),
      checkpoint: (projectId, name, label) =>
        request('POST', `${recording(projectId, name)}/checkpoint`, label ? { label } : {}),
      resolve: (projectId, name, actionId, candidate) =>
        request('POST', `${recording(projectId, name)}/resolve`, { actionId, candidate }),
      ignore: (projectId, name, actionId) =>
        request('POST', `${recording(projectId, name)}/ignore`, { actionId }),
      subscribe: (projectId, name, onEvent, subscribeOptions) =>
        stream(
          `${recording(projectId, name)}/events`,
          (event) => {
            onEvent(event as RecordingStreamEvent);
          },
          subscribeOptions,
        ),
      flow: (projectId, name) => request('GET', `${recording(projectId, name)}/flow`),
      studio: (projectId, name) => request('GET', `${recording(projectId, name)}/studio`),
      removeStep: (projectId, name, stepId) =>
        request('POST', `${recording(projectId, name)}/steps/remove`, { stepId }),
      replay: (projectId, name) => request('POST', `${recording(projectId, name)}/replay`, {}),
      replayStatus: (projectId, name) => request('GET', `${recording(projectId, name)}/replay`),
      intents: (projectId, name) => request('GET', `${recording(projectId, name)}/intents`),
      reviewIntent: (projectId, name, input) =>
        request('POST', `${recording(projectId, name)}/intents`, input),
      rowSource: (projectId, name, stepId) =>
        request('GET', `${recording(projectId, name)}/steps/row?stepId=${encodeURIComponent(stepId)}`),
      editRow: (projectId, name, stepId, columns) =>
        request('POST', `${recording(projectId, name)}/steps/row`, { stepId, columns }),
      restoreTarget: (projectId, name, stepId) =>
        request('POST', `${recording(projectId, name)}/steps/restore`, { stepId }),
    },
    corrections: {
      start: (projectId, name, stepId) =>
        request('POST', `${recording(projectId, name)}/correction`, { stepId }),
      get: (projectId, name) => request('GET', `${recording(projectId, name)}/correction`),
      pick: (projectId, name) => request('POST', `${recording(projectId, name)}/correction/pick`, {}),
      apply: (projectId, name, choice = {}) =>
        request('POST', `${recording(projectId, name)}/correction/apply`, choice),
      resume: (projectId, name) => request('POST', `${recording(projectId, name)}/correction/resume`, {}),
      close: (projectId, name) => request('POST', `${recording(projectId, name)}/correction/close`, {}),
    },
    assertions: {
      list: (projectId, name) => request('GET', `${recording(projectId, name)}/assertions`),
      decide: (projectId, name, proposalId, input) =>
        request('POST', `${recording(projectId, name)}/assertions/${encodeURIComponent(proposalId)}`, input),
    },
    data: {
      get: (projectId, name) => request('GET', `${recording(projectId, name)}/data`),
      bind: (projectId, name, input) => request('POST', `${recording(projectId, name)}/data/bindings`, input),
    },
    groups: {
      list: (projectId, name) => request('GET', `${recording(projectId, name)}/groups`),
      edit: (projectId, name, command, editOptions = {}) =>
        request('POST', `${recording(projectId, name)}/groups`, { command, ...editOptions }),
      proposals: (projectId, name) => request('GET', `${recording(projectId, name)}/groups/proposals`),
      acceptProposals: (projectId, name) =>
        request('POST', `${recording(projectId, name)}/groups/proposals`, {}),
      checks: (projectId, name) => request('GET', `${recording(projectId, name)}/groups/checks`),
      addCheck: (projectId, name, input) =>
        request('POST', `${recording(projectId, name)}/groups/checks`, input),
    },
    generation: {
      run: (projectId, name, input) => request('POST', `${recording(projectId, name)}/generation`, input),
      view: (projectId, name) => request('GET', `${recording(projectId, name)}/generation`),
      editFile: (projectId, name, input) =>
        request('PUT', `${recording(projectId, name)}/generation/file`, input),
      restoreFile: (projectId, name, input) =>
        request('POST', `${recording(projectId, name)}/generation/restore`, input),
      checkFile: (projectId, name, input) =>
        request('POST', `${recording(projectId, name)}/generation/check`, input),
      original: (projectId, name, file) =>
        request('GET', `${recording(projectId, name)}/generation/original?path=${encodeURIComponent(file)}`),
      preview: (projectId, name, input) =>
        request('POST', `${recording(projectId, name)}/generation/preview`, input),
      execute: (projectId, name, input) => request('POST', `${recording(projectId, name)}/test-runs`, input),
      runOf: (projectId, name, runId) =>
        request('GET', `${recording(projectId, name)}/test-runs/${encodeURIComponent(runId)}`),
      runEvents: (projectId, name, runId, onEvent, subscribeOptions) =>
        stream(
          `${recording(projectId, name)}/test-runs/${encodeURIComponent(runId)}/events`,
          (event) => {
            onEvent(event as RunLogEvent);
          },
          subscribeOptions,
        ),
      runLogs: async (projectId, name, runId, format) => ({
        name: `qa-crawler-${runId}.${format === 'text' ? 'log' : 'json'}`,
        type: format === 'text' ? 'text/plain' : 'application/json',
        content: await send(
          'GET',
          `${recording(projectId, name)}/test-runs/${encodeURIComponent(runId)}/logs?format=${format}`,
          { headers: headers(false) },
        ),
      }),
      cancel: (projectId, name, runId) =>
        request('POST', `${recording(projectId, name)}/test-runs/${encodeURIComponent(runId)}/cancel`, {}),
      reportLink: (projectId, name, runId) =>
        request(
          'POST',
          `${recording(projectId, name)}/test-runs/${encodeURIComponent(runId)}/report-links`,
          {},
        ),
    },
    graph: {
      exploration: (id) => request('GET', `/explorations/${encodeURIComponent(id)}/graph`),
      of: (projectId, kind, name) =>
        request('GET', `${project(projectId)}/reports/${kind}/${encodeURIComponent(name)}/graph`),
    },
    reports: {
      list: (projectId) => request('GET', `${project(projectId)}/reports`),
      link: (projectId, kind, name) =>
        request('POST', `${project(projectId)}/reports/${kind}/${encodeURIComponent(name)}/links`, {}),
      compare: (projectId, base, head) =>
        request(
          'GET',
          `${project(projectId)}/reports/compare?base=${encodeURIComponent(base)}&head=${encodeURIComponent(head)}`,
        ),
      traceability: (projectId, run) =>
        request('GET', `${project(projectId)}/reports/exploration/${encodeURIComponent(run)}/traceability`),
      regression: (projectId, run) =>
        request('GET', `${project(projectId)}/reports/exploration/${encodeURIComponent(run)}/regression`),
    },
    dispose() {
      disposed = true;
      for (const controller of controllers) controller.abort();
      controllers.clear();
    },
  };
}

/** Lit un flux `text/event-stream` : un événement par bloc `data:` (JSON), les commentaires ignorés. */
export async function* readEventStream<T = ExplorationEvent>(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<T> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseBlock(block);
        if (event !== undefined) yield event as T;
        boundary = buffer.indexOf('\n\n');
      }
    }
    const last = parseBlock(buffer);
    if (last !== undefined) yield last as T;
  } finally {
    reader.releaseLock();
  }
}

function parseBlock(block: string): unknown {
  const data = block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''))
    .join('\n');
  if (!data) return undefined;
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return undefined;
  }
}
