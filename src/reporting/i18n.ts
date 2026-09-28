/**
 * Langues des rapports HTML. result.json et flow-graph.json restent toujours en
 * anglais (clés et valeurs stables pour les outils et la CI).
 */
export const REPORT_LANGUAGES = ['en', 'fr'] as const;
export type ReportLanguage = (typeof REPORT_LANGUAGES)[number];

export interface BaselineTexts {
  mode: string;
  baseline: string;
  learned: string;
  verificationTitle: string;
  verificationHint: string;
  regressions: string;
  expected: string;
  actual: string;
  diffTitle: string;
  diffHintExplore: string;
  diffHintVerify: string;
  diffHintLearn: string;
  addedStates: string;
  removedStates: string;
  addedTransitions: string;
  removedTransitions: string;
  changedTransitions: string;
  noDifference: string;
}

export interface ReportTexts {
  lang: ReportLanguage;
  baselineTexts: BaselineTexts;
  reportTitle: string;
  stopped: string;
  engine: string;
  flowGraphLink: string;
  backToReport: string;
  status: { critical: string; errors: string; warnings: string; none: string };
  cards: {
    states: string;
    transitions: string;
    actionsExecuted: string;
    actionsBlocked: string;
    blocked: string;
    failed: string;
    maxDepth: string;
    backtracks: string;
    issues: string;
    flowsPassed: string;
    duration: string;
  };
  discoveredFlow: string;
  discoveredFlowHint: string;
  issueSections: { flow: string; forms: string; http: string; js: string; navigation: string };
  noneDetected: string;
  columns: {
    severity: string;
    status: string;
    request: string;
    message: string;
    stateActionFlow: string;
    count: string;
    shot: string;
    state: string;
    urlRoute: string;
    depth: string;
    actions: string;
    forms: string;
    issues: string;
    class: string;
    type: string;
    category: string;
    label: string;
    locator: string;
    reason: string;
    from: string;
    action: string;
    to: string;
    result: string;
    duration: string;
    step: string;
  };
  after: string;
  view: string;
  noLabel: string;
  sameState: string;
  optional: string;
  suggestion: string;
  onScreen: string;
  actionCount: (count: number) => string;
  issueCount: (count: number) => string;
  statesTitle: string;
  noState: string;
  executedTitle: string;
  noExecuted: string;
  blockedTitle: string;
  blockedHint: string;
  noBlocked: string;
  screenshotsTitle: string;
  noScreenshots: string;
  generatedBy: string;
  flowsTitle: string;
  flowsHint: string;
  lastScreenExplored: string;
  flowGraphTitle: string;
  applicationMap: string;
  textView: string;
  movesTitle: string;
  othersTitle: string;
  othersHint: string;
  interactionsTitle: string;
  interactionsHint: string;
  noInteractions: string;
  interactionColumns: {
    type: string;
    status: string;
    outcome: string;
    handler: string;
    origin: string;
    source: string;
    target: string;
    attempt: string;
    reason: string;
    details: string;
  };
}

const EN: ReportTexts = {
  baselineTexts: {
    mode: 'Mode',
    baseline: 'Baseline',
    learned: 'Baseline stored',
    verificationTitle: 'Verification of the baseline',
    verificationHint:
      'Every transition learned by the baseline, replayed: same start state, same action, is the same state reached?',
    regressions: 'regression(s)',
    expected: 'Expected',
    actual: 'Reached',
    diffTitle: 'Flow diff',
    diffHintExplore:
      'What this run found that the baseline did not know, and the known transitions that changed. What was not revisited is not listed: explore goes to new ground first.',
    diffHintVerify: 'Compared with the baseline, from the transitions replayed.',
    diffHintLearn: 'Compared with the previous baseline.',
    addedStates: 'New states',
    removedStates: 'States not found',
    addedTransitions: 'New transitions',
    removedTransitions: 'Transitions not found',
    changedTransitions: 'Changed transitions',
    noDifference: 'No difference.',
  },
  lang: 'en',
  reportTitle: 'QA Flow Explorer',
  stopped: 'stopped',
  engine: 'engine',
  flowGraphLink: 'Flow graph →',
  backToReport: '← Report',
  status: {
    critical: 'CRITICAL issues found',
    errors: 'Errors found',
    warnings: 'Warnings only',
    none: 'No issues',
  },
  cards: {
    states: 'States',
    transitions: 'Transitions',
    actionsExecuted: 'Actions executed',
    actionsBlocked: 'Actions blocked',
    blocked: 'Blocked',
    failed: 'Failed',
    maxDepth: 'Max depth',
    backtracks: 'Backtracks',
    issues: 'Issues',
    flowsPassed: 'Flows passed',
    duration: 'Duration',
  },
  discoveredFlow: 'Discovered flow',
  discoveredFlowHint:
    'Each state appears under the state from which it was first reached, with the action that led there.',
  issueSections: {
    flow: 'Flow failures',
    forms: 'Form validation',
    http: 'HTTP errors & broken pages',
    js: 'JavaScript errors',
    navigation: 'Navigation problems',
  },
  noneDetected: 'None detected.',
  columns: {
    severity: 'Severity',
    status: 'Status',
    request: 'Request',
    message: 'Message',
    stateActionFlow: 'State · action · flow',
    count: 'Count',
    shot: 'Shot',
    state: 'State',
    urlRoute: 'URL · route',
    depth: 'Depth',
    actions: 'Actions',
    forms: 'Forms',
    issues: 'Issues',
    class: 'Class',
    type: 'Type',
    category: 'Category',
    label: 'Label',
    locator: 'Locator',
    reason: 'Reason',
    from: 'From',
    action: 'Action',
    to: 'To',
    result: 'Result',
    duration: 'Duration',
    step: 'Step',
  },
  after: 'after',
  view: 'view',
  noLabel: '(no label)',
  sameState: '(same state)',
  optional: '(optional)',
  suggestion: 'Suggested step (element found on the screen, to paste in the YAML):',
  onScreen: 'On the screen:',
  actionCount: (count) => `${count} action(s)`,
  issueCount: (count) => `${count} issue(s)`,
  statesTitle: 'States',
  noState: 'No state discovered.',
  executedTitle: 'Executed actions',
  noExecuted: 'No action executed.',
  blockedTitle: 'Blocked actions',
  blockedHint: 'Refused by the safety policy (after the decision engine chose them, before Playwright).',
  noBlocked: 'No action was blocked.',
  screenshotsTitle: 'Screenshots',
  noScreenshots: 'No screenshots were captured.',
  generatedBy: 'Generated by qa-crawler (flow explorer)',
  flowsTitle: 'Imposed flows',
  flowsHint:
    'Steps written in the mission, run in order. Each step still goes through the safety policy: MUTATION actions run only with <code>allow: MUTATION</code>, DANGEROUS ones only with <code>allow: DANGEROUS</code> and DANGEROUS in the mission’s allowedActionClasses.',
  lastScreenExplored: 'last screen explored',
  flowGraphTitle: 'Flow graph',
  applicationMap: 'Application map',
  textView: 'Text view',
  movesTitle: 'Transitions between states',
  othersTitle: 'Other attempts',
  othersHint: 'Actions without visible effect, failed or blocked by the safety policy.',
  interactionsTitle: 'Browser interactions',
  interactionsHint:
    'Raised by the browser outside the DOM (native sign-in dialog, JS dialogs, popups, downloads, file chooser, permissions, external navigation): detected, classified and handled according to the safety policy. No credential is ever recorded.',
  noInteractions: 'No browser interaction.',
  interactionColumns: {
    type: 'Type',
    status: 'Status',
    outcome: 'Outcome',
    handler: 'Handler · action',
    origin: 'Origin',
    source: 'State · action',
    target: 'Target',
    attempt: 'Attempt',
    reason: 'Reason',
    details: 'Details',
  },
};

const FR: ReportTexts = {
  baselineTexts: {
    mode: 'Mode',
    baseline: 'Baseline',
    learned: 'Baseline enregistrée',
    verificationTitle: 'Vérification de la baseline',
    verificationHint:
      'Chaque transition apprise par la baseline, rejouée : même état de départ, même action, arrive-t-on au même état ?',
    regressions: 'régression(s)',
    expected: 'Attendu',
    actual: 'Atteint',
    diffTitle: 'Différences de flows',
    diffHintExplore:
      'Ce que ce passage a trouvé et que la baseline ne connaissait pas, et les transitions connues qui ont changé. Ce qui n’a pas été revu n’est pas listé : explore va d’abord vers l’inconnu.',
    diffHintVerify: 'Comparé à la baseline, d’après les transitions rejouées.',
    diffHintLearn: 'Comparé à la baseline précédente.',
    addedStates: 'Nouveaux états',
    removedStates: 'États non retrouvés',
    addedTransitions: 'Nouvelles transitions',
    removedTransitions: 'Transitions non retrouvées',
    changedTransitions: 'Transitions modifiées',
    noDifference: 'Aucune différence.',
  },
  lang: 'fr',
  reportTitle: 'Rapport QA',
  stopped: 'arrêt',
  engine: 'moteur',
  flowGraphLink: 'Graphe des flows →',
  backToReport: '← Rapport',
  status: {
    critical: 'Anomalies CRITIQUES',
    errors: 'Erreurs détectées',
    warnings: 'Avertissements seulement',
    none: 'Aucune anomalie',
  },
  cards: {
    states: 'États',
    transitions: 'Transitions',
    actionsExecuted: 'Actions exécutées',
    actionsBlocked: 'Actions bloquées',
    blocked: 'Bloquées',
    failed: 'Échouées',
    maxDepth: 'Profondeur max',
    backtracks: 'Retours arrière',
    issues: 'Anomalies',
    flowsPassed: 'Flows réussis',
    duration: 'Durée',
  },
  discoveredFlow: 'Parcours découvert',
  discoveredFlowHint:
    "Chaque état apparaît sous l'état depuis lequel il a été atteint la première fois, avec l'action qui y a mené.",
  issueSections: {
    flow: 'Échecs des flows',
    forms: 'Validation des formulaires',
    http: 'Erreurs HTTP et pages cassées',
    js: 'Erreurs JavaScript',
    navigation: 'Problèmes de navigation',
  },
  noneDetected: 'Aucune détectée.',
  columns: {
    severity: 'Gravité',
    status: 'Statut',
    request: 'Requête',
    message: 'Message',
    stateActionFlow: 'État · action · parcours',
    count: 'Nb',
    shot: 'Capture',
    state: 'État',
    urlRoute: 'URL · route',
    depth: 'Profondeur',
    actions: 'Actions',
    forms: 'Formulaires',
    issues: 'Anomalies',
    class: 'Classe',
    type: 'Type',
    category: 'Catégorie',
    label: 'Libellé',
    locator: 'Localisateur',
    reason: 'Raison',
    from: 'Depuis',
    action: 'Action',
    to: 'Vers',
    result: 'Résultat',
    duration: 'Durée',
    step: 'Étape',
  },
  after: 'après',
  view: 'voir',
  noLabel: '(sans libellé)',
  sameState: '(même état)',
  optional: '(optionnelle)',
  suggestion: 'Étape suggérée (élément trouvé à l’écran, à copier dans le YAML) :',
  onScreen: 'À l’écran :',
  actionCount: (count) => `${count} action(s)`,
  issueCount: (count) => `${count} anomalie(s)`,
  statesTitle: 'États',
  noState: 'Aucun état découvert.',
  executedTitle: 'Actions exécutées',
  noExecuted: 'Aucune action exécutée.',
  blockedTitle: 'Actions bloquées',
  blockedHint:
    'Refusées par la politique de sécurité (après le choix du moteur de décision, avant Playwright).',
  noBlocked: "Aucune action n'a été bloquée.",
  screenshotsTitle: "Captures d'écran",
  noScreenshots: "Aucune capture d'écran.",
  generatedBy: 'Généré par qa-crawler (explorateur de flows)',
  flowsTitle: 'Flows imposés',
  flowsHint:
    'Étapes écrites dans la mission, exécutées dans l’ordre. Chaque étape passe par la politique de sécurité : les MODIFICATIONS seulement avec <code>allow: MUTATION</code>, les actions DANGEREUSES seulement avec <code>allow: DANGEROUS</code> et DANGEROUS dans allowedActionClasses de la mission.',
  lastScreenExplored: 'dernier écran exploré',
  flowGraphTitle: 'Graphe des flows',
  applicationMap: "Carte de l'application",
  textView: 'Vue texte',
  movesTitle: 'Transitions entre états',
  othersTitle: 'Autres tentatives',
  othersHint: 'Actions sans effet visible, échouées ou bloquées par la politique de sécurité.',
  interactionsTitle: 'Interactions navigateur',
  interactionsHint:
    'Déclenchées par le navigateur hors du DOM (fenêtre native d’authentification, dialogues JS, popups, téléchargements, choix de fichier, permissions, navigation externe) : détectées, classées et traitées selon la politique de sécurité. Aucun identifiant n’est jamais enregistré.',
  noInteractions: 'Aucune interaction navigateur.',
  interactionColumns: {
    type: 'Type',
    status: 'Statut',
    outcome: 'Résultat',
    handler: 'Gestionnaire · action',
    origin: 'Origine',
    source: 'État · action',
    target: 'Cible',
    attempt: 'Tentative',
    reason: 'Raison',
    details: 'Détails',
  },
};

export function reportTexts(language: ReportLanguage = 'en'): ReportTexts {
  return language === 'fr' ? FR : EN;
}

/** Libellés français des valeurs d'énumération affichées dans les rapports (statuts, classes, gravités…). */
const FR_VALUES: Record<string, string> = {
  // résultats des flows et des transitions
  PASSED: 'RÉUSSI',
  FAILED: 'ÉCHOUÉ',
  BLOCKED: 'BLOQUÉ',
  SKIPPED: 'IGNORÉ',
  MANUAL: 'À VÉRIFIER',
  SUCCESS: 'RÉUSSIE',
  // classements
  SAFE: 'SÛRE',
  MUTATION: 'MODIFICATION',
  DANGEROUS: 'DANGEREUSE',
  UNKNOWN: 'INCONNUE',
  // gravités
  INFO: 'INFO',
  WARNING: 'AVERTISSEMENT',
  ERROR: 'ERREUR',
  CRITICAL: 'CRITIQUE',
  // types d'anomalies
  HTTP: 'HTTP',
  REQUEST_FAILED: 'REQUÊTE ÉCHOUÉE',
  BROKEN_LINK: 'LIEN CASSÉ',
  CONSOLE: 'CONSOLE',
  PAGE_ERROR: 'ERREUR JS',
  PAGE_CRASH: 'PLANTAGE',
  NAVIGATION: 'NAVIGATION',
  FLOW: 'FLOW',
  learn: 'apprentissage',
  verify: 'vérification',
  explore: 'exploration',
  CHANGED: 'MODIFIÉE',
  ACTION_MISSING: 'ACTION ABSENTE',
  UNREACHABLE: 'INACCESSIBLE',
  FORM_VALIDATION: 'FORMULAIRE',
  UI_ERROR: 'ERREUR ÉCRAN',
  REGRESSION: 'RÉGRESSION',
  CONTRACT: 'CONTRAT API',
  ACCESSIBILITY: 'ACCESSIBILITÉ',
  AUTHORIZATION: 'AUTORISATION',
  INVARIANT: 'INVARIANT',
  WRITE_BLOCKED: 'ÉCRITURE BLOQUÉE',
  UNEXPECTED_BEHAVIOR: 'COMPORTEMENT INHABITUEL',
  PERFORMANCE: 'PERFORMANCE',
  // catégories de verdict
  CONFIRMED_FAILURE: 'ÉCHEC CONFIRMÉ',
  CONTRACT_VIOLATION: 'VIOLATION DU CONTRAT',
  INVARIANT_VIOLATION: 'VIOLATION D’INVARIANT',
  POTENTIAL_REGRESSION: 'RÉGRESSION POTENTIELLE',
  ACCEPTED: 'ACCEPTÉE',
  REJECTED: 'REFUSÉE',
  NOT_ENTERED: 'NON SAISIE',
  // statuts d'objectif et de couverture
  PENDING: 'EN ATTENTE',
  ACTIVE: 'ACTIF',
  REACHED: 'ATTEINT',
  DISCOVERED: 'DÉCOUVERT',
  EXECUTED: 'EXÉCUTÉ',
  // types d'actions
  click: 'clic',
  navigate: 'navigation',
  fill: 'saisie',
  select: 'sélection',
  check: 'cocher',
  uncheck: 'décocher',
  // genres d'étapes
  goto: 'aller à',
  expect: 'vérification',
  screenshot: 'capture',
  // catégories
  navigation: 'navigation',
  tab: 'onglet',
  menu: 'menu',
  details: 'détails',
  pagination: 'pagination',
  search: 'recherche',
  filter: 'filtre',
  'form-input': 'champ',
  'form-step': 'étape de formulaire',
  submit: 'envoi',
  toggle: 'bascule',
  other: 'autre',
  // statuts des interactions du navigateur
  HANDLED: 'TRAITÉE',
  DETECTED: 'DÉTECTÉE',
  UNSUPPORTED: 'NON GÉRÉE',
  // raisons d'arrêt
  exhausted: 'tout exploré',
  'flows-only': 'flows uniquement',
  'max-states': 'nombre max d’états atteint',
  'max-actions': 'nombre max d’actions atteint',
  'max-duration': 'durée max atteinte',
  'engine-stop': 'arrêt du moteur',
  'unreachable-start': 'page de départ inaccessible',
  'rule-based': 'à règles',
};

/** Libellé affiché d'une valeur d'énumération (statut, classe, gravité, type d'action…). */
export function valueLabel(language: ReportLanguage, value: string): string {
  return language === 'fr' ? (FR_VALUES[value] ?? value) : value;
}

/**
 * Formulation française des raisons produites par la SafetyPolicy, l'exécuteur de
 * flows et l'explorateur. Appliquée à tout le texte, pour traduire aussi les raisons
 * imbriquées (« MUTATION action (matches mutation keyword "x"): … »). Le texte
 * inconnu (messages du navigateur…) est laissé tel quel.
 */
const FR_REASONS: [RegExp, string | ((...groups: string[]) => string)][] = [
  [
    /Flow "(.*?)" — step (\d+) "(.*)" (failed|blocked): /g,
    (_match, flow = '', step = '', description = '', status = '') =>
      `Flow « ${flow} » — étape ${step} « ${description} » ${status === 'failed' ? 'échouée' : 'bloquée'} : `,
  ],
  [/Flow "(.*?)" — could not start: /g, 'Flow « $1 » — démarrage impossible : '],
  [
    /:? add "allow: (MUTATION|UNKNOWN|DANGEROUS)" to this step to execute it/g,
    ' : ajoutez « allow: $1 » à cette étape pour l’exécuter',
  ],
  [/MUTATION action \(/g, 'action de MODIFICATION ('],
  [/UNKNOWN action \(/g, 'action INCONNUE ('],
  [/DANGEROUS action \(/g, 'action DANGEREUSE ('],
  [
    /DANGEROUS actions are not allowed by the mission/g,
    'les actions DANGEREUSES ne sont pas autorisées par la mission',
  ],
  [/: list DANGEROUS in safety\.allowedActionClasses/g, ' : ajoutez DANGEROUS à safety.allowedActionClasses'],
  [/DANGEROUS actions are never executed/g, 'les actions DANGEREUSES ne sont jamais exécutées'],
  [/DANGEROUS URL is never opened/g, 'une URL DANGEREUSE n’est jamais ouverte'],
  [
    /(SAFE|MUTATION|DANGEROUS|UNKNOWN) actions are not allowed/g,
    (_match, cls = '') => `les actions ${valueLabel('fr', cls)} ne sont pas autorisées`,
  ],
  [/URL matches dangerous keyword "(.*?)"/g, 'l’URL contient le mot-clé dangereux « $1 »'],
  [/matches dangerous keyword "(.*?)"/g, 'mot-clé dangereux « $1 »'],
  [/matches mutation keyword "(.*?)"/g, 'mot-clé de modification « $1 »'],
  [/risk "(.*?)" is blocked by the mission/g, 'le risque « $1 » est bloqué par la mission'],
  [/the mission does not allow "(.*?)" actions/g, 'la mission n’autorise pas les actions « $1 »'],
  [/navigation refused: /g, 'navigation refusée : '],
  [/\bexternal-host\b/g, 'hôte externe'],
  [/\bignored-path\b/g, 'chemin ignoré'],
  [/\bdangerous-url\b/g, 'URL dangereuse'],
  [/\bnon-html-resource\b/g, 'fichier, pas une page'],
  [/\bunsupported-scheme\b/g, 'protocole non pris en charge'],
  [/submits a search form/g, 'envoie un formulaire de recherche'],
  [/submits a form/g, 'envoie un formulaire'],
  [
    /sensitive field \(password, payment or secret data\): never filled/g,
    'champ sensible (mot de passe, paiement ou secret) : jamais rempli',
  ],
  [
    /sensitive field \(password, secret…\): its value must come from an environment variable \(\{ env: NAME \}\)/g,
    'champ sensible (mot de passe, secret…) : la valeur doit venir d’une variable d’environnement ({ env: NOM })',
  ],
  [
    /sensitive field filled from an environment variable \(value never logged\)/g,
    'champ sensible rempli depuis une variable d’environnement (valeur jamais journalisée)',
  ],
  [
    /payment field \(card, IBAN…\): never filled automatically/g,
    'champ de paiement (carte, IBAN…) : jamais rempli automatiquement',
  ],
  [
    /no readable label \(icon or symbol only\): never executed automatically/g,
    'aucun libellé lisible (icône ou symbole seul) : jamais exécuté automatiquement',
  ],
  [/element is disabled/g, 'élément désactivé'],
  [/element is not visible/g, 'élément non visible'],
  [
    /element not visible within (\d+) ms \((\d+) match\(es\)\)/g,
    'élément non visible après $1 ms ($2 correspondance(s))',
  ],
  [/element not found within (\d+) ms/g, 'élément introuvable après $1 ms'],
  [/element not found on the page/g, 'élément introuvable sur la page'],
  [/element still visible/g, 'élément toujours visible'],
  [/expected element: /g, 'élément attendu : '],
  [/environment variable (\S+) is not set/g, 'la variable d’environnement $1 n’est pas définie'],
  [/expectation not met: /g, 'vérification non satisfaite : '],
  [/text "(.*?)" not visible/g, 'texte « $1 » non visible'],
  [/URL does not contain "(.*?)"/g, 'l’URL ne contient pas « $1 »'],
  [/cannot inspect the element: /g, 'impossible d’inspecter l’élément : '],
  [/navigation to (\S+) failed/g, 'échec de la navigation vers $1'],
  [
    /left the allowed hosts(,)? or the page (failed to load|crashed)/g,
    'sortie des hôtes autorisés, ou la page n’a pas chargé',
  ],
  [/\bpage crashed\b/g, 'la page a planté'],
  [/action not available on this state/g, 'action absente de cet état'],
  [/invalid link target/g, 'cible de lien invalide'],
  [/invalid URL/g, 'URL invalide'],
  // formulaires
  [/form "(.*?)": field "(.*?)" \(value "(.*?)"\): /g, 'formulaire « $1 » : champ « $2 » (valeur « $3 ») : '],
  [/form "(.*?)": field "(.*?)" \(left empty\): /g, 'formulaire « $1 » : champ « $2 » (laissé vide) : '],
  [/form "(.*?)": field "(.*?)" \(filled\): /g, 'formulaire « $1 » : champ « $2 » (rempli) : '],
  [/: invalid value$/g, ' : valeur invalide'],
  [
    /(\d+) field\(s\) filled, (\d+) validation message\(s\), nothing sent/g,
    '$1 champ(s) rempli(s), $2 message(s) de validation, rien n’est envoyé',
  ],
  [/; not filled: /g, ' ; non remplis : '],
  [
    /click intercepted by (.*?): another layer covers the element/g,
    'clic intercepté par $1 : un autre calque couvre l’élément',
  ],
  [
    /\bstep (\d+) (failed|blocked)\b/g,
    (_match, step = '', status = '') => `étape ${step} ${status === 'failed' ? 'échouée' : 'bloquée'}`,
  ],
  [/\bflow stopped\b/g, 'flow arrêté'],
  [/mission limit reached \((.*?)\)/g, 'limite de la mission atteinte ($1)'],
  [/start page (\S+) could not be loaded/g, 'la page de départ $1 n’a pas pu être chargée'],
  [/the start page is unreachable/g, 'la page de départ est inaccessible'],
  [/in-page control \((.*?)\), no risky keyword/g, 'contrôle de la page ($1), aucun mot-clé risqué'],
  [/navigation \(GET, no data change\)/g, 'navigation (GET, aucune modification)'],
  [/link to another site/g, 'lien vers un autre site'],
  [/file download, not a screen/g, 'téléchargement de fichier, pas un écran'],
  [/fills a field locally \(nothing is sent\)/g, 'remplit un champ localement (rien n’est envoyé)'],
  [/wizard step "(.*?)" \(client-side form\)/g, 'étape d’assistant « $1 » (formulaire côté client)'],
  [/\bplain navigation\b/g, 'navigation simple'],
  [/\bnavigation allowed\b/g, 'navigation autorisée'],
  // interactions du navigateur
  [/confirm\(\) is dismissed by default/g, 'confirm() est refusé par défaut'],
  [/never confirmed automatically: /g, 'jamais confirmé automatiquement : '],
  [/harmless confirmation/g, 'confirmation sans risque'],
  [
    /no value for this prompt in browserInteractions\.dialogs\.promptValues: dismissed, nothing invented/g,
    'aucune valeur pour ce prompt dans browserInteractions.dialogs.promptValues : refusé, rien n’est inventé',
  ],
  [/recorded only: never saved nor opened/g, 'enregistré seulement : jamais sauvegardé ni ouvert'],
  [/download recorded, file not saved/g, 'téléchargement enregistré, fichier non sauvegardé'],
  [
    /a file is requested: the crawler never picks a file by itself/g,
    'un fichier est demandé : le crawler ne choisit jamais de fichier lui-même',
  ],
  [
    /"(.*?)" is not granted \(browserInteractions\.permissions\.grant\): denied/g,
    '« $1 » n’est pas accordée (browserInteractions.permissions.grant) : refusée',
  ],
  [
    /navigation outside the allowed origins is not explored/g,
    'navigation hors des origines autorisées : non explorée',
  ],
  [
    /new page outside the allowed origins: closed without being explored/g,
    'nouvelle page hors des origines autorisées : fermée sans être explorée',
  ],
  [/new page on an allowed origin/g, 'nouvelle page sur une origine autorisée'],
  [
    /no credentials available for profile "(.*?)": nothing is invented, authentication cancelled/g,
    'aucun identifiant pour le profil « $1 » : rien n’est inventé, authentification annulée',
  ],
  [/credentials rejected by the server/g, 'identifiants refusés par le serveur'],
  [
    /credentials rejected (\d+) time\(s\): authentication cancelled/g,
    'identifiants refusés $1 fois : authentification annulée',
  ],
  [
    /no credential profile configured for HTTP authentication/g,
    'aucun profil d’identifiants configuré pour l’authentification HTTP',
  ],
  [
    /no handler for this interaction: safe fallback applied/g,
    'aucun gestionnaire pour cette interaction : repli sûr appliqué',
  ],
  [
    /raised (\d+) times for the same origin and action/g,
    'déclenchée $1 fois pour la même origine et la même action',
  ],
];

/** Raison ou message dans la langue du rapport. */
export function translateReason(language: ReportLanguage, text: string): string {
  if (language !== 'fr') return text;
  let result = text;
  for (const [pattern, replacement] of FR_REASONS) {
    result =
      typeof replacement === 'string'
        ? result.replace(pattern, replacement)
        : result.replace(pattern, (...args: unknown[]) =>
            replacement(...args.slice(0, -2).map((value) => (typeof value === 'string' ? value : ''))),
          );
  }
  return result;
}
