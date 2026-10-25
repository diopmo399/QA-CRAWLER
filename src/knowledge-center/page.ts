import { esc } from '../reporting/html-common.js';
import {
  THEME_BASE_CSS,
  THEME_BOOT_SCRIPT,
  THEME_TOGGLE_SCRIPT,
  THEME_TOKENS_CSS,
  brandBlock,
  themeToggle,
} from '../reporting/theme.js';

/**
 * LA PAGE DU KNOWLEDGE CENTER : une seule page, construite comme la fenêtre du recorder et les rapports
 * (HTML + CSS + JS dans un gabarit, le thème QA-CRAWLER, aucune bibliothèque), qui lit l'API JSON locale.
 * Rien n'est calculé ici : la page montre ce que le serveur rend, page par page.
 */
export interface PageOptions {
  language: 'fr' | 'en';
  token: string;
  readOnly: boolean;
  docsUrl?: string;
}

const TEXTS = {
  fr: {
    title: 'Knowledge Center',
    tagline: 'La mémoire de QA-CRAWLER',
    nav: {
      overview: "Vue d'ensemble",
      explorer: 'Explorateur',
      flows: 'Flows et transitions',
      variables: 'Variables métier',
      quality: 'Qualité',
      history: 'Historique',
      persistence: 'Persistance',
    },
    application: 'Application',
    memoryMode: {
      legacy: 'mémoire : base fichier (comme avant)',
      isolated: 'mémoire : run isolé',
      'current-run': 'mémoire : run courant',
      historical: 'mémoire : historique préchargé',
    },
    readOnly: 'Lecture seule',
    refresh: 'Actualiser',
    loading: 'Chargement…',
    empty: 'Rien à montrer.',
    error: 'Erreur',
    retry: 'Réessayer',
    unavailable: 'Non disponible',
    formula: 'Formule',
    metrics: {
      total: 'Connaissances',
      flows: 'Flows connus',
      states: 'États',
      transitions: 'Transitions',
      validated: 'Validées (humain)',
      invalidated: 'Invalidées (humain)',
      toVerify: 'À vérifier',
      stale: 'Obsolètes',
      runs: 'Runs persistés',
      runsUsingKnowledge: 'Runs ayant utilisé la mémoire',
      reuseRate: 'Taux de réutilisation (%)',
      lastSave: 'Dernière sauvegarde',
      lastLearning: 'Dernier apprentissage',
    },
    byType: 'Par type',
    byStatus: 'Par fiabilité',
    activity: {
      recent: 'Dernières connaissances modifiées',
      runs: 'Derniers runs',
      transitions: 'Dernières transitions découvertes',
      reused: 'Connaissances réutilisées',
      resolutionFailures: 'Échecs de résolution de cibles',
      persistenceErrors: 'Erreurs de persistance',
      attention: 'Nécessite une intervention',
    },
    warnings: 'Avertissements de lecture',
    search: 'Rechercher (titre, clé, description)',
    all: 'Tous',
    type: 'Type',
    status: 'Fiabilité',
    origin: 'Origine',
    source: 'Source',
    review: 'Décision humaine',
    reviewNone: 'Sans décision',
    sort: 'Tri',
    sorts: {
      updatedAt: 'Dernière vue',
      createdAt: 'Première vue',
      title: 'Titre',
      type: 'Type',
      status: 'Fiabilité',
      evidence: 'Preuves',
    },
    columns: {
      title: 'Connaissance',
      type: 'Type',
      status: 'Fiabilité',
      evidence: 'Preuves',
      updatedAt: 'Dernière vue',
      origin: 'Origine',
      review: 'Décision',
    },
    results: 'résultat(s)',
    page: 'Page',
    previous: 'Précédent',
    next: 'Suivant',
    export: 'Exporter cette liste (CSV)',
    detail: 'Détail',
    close: 'Fermer',
    fields: {
      id: 'Identifiant stable',
      key: 'Clé réelle',
      source: 'Source',
      location: 'Emplacement',
      application: 'Application',
      environment: 'Environnement',
      createdAt: 'Créée',
      updatedAt: 'Modifiée',
      appVersion: "Version de l'application",
      origin: 'Origine',
      description: 'Description',
    },
    evidence: 'Preuves',
    evidenceFields: {
      seen: 'vue',
      successes: 'succès',
      failures: 'échecs',
      blocked: 'bloquée',
      confirmations: 'confirmations',
      contradictions: 'contradictions',
      runIds: 'runs',
    },
    reliability: 'Fiabilité calculée',
    data: 'Données réelles',
    executions: 'Exécutions des derniers runs',
    executionsCols: {
      at: 'Date',
      run: 'Run',
      status: 'Résultat',
      oracle: 'Oracle',
      duration: 'Durée',
      version: 'Version',
    },
    decision: 'Décision humaine',
    decisionNone: 'Aucune décision : la fiabilité calculée fait foi.',
    decisionNote: 'Note (facultative)',
    validate: 'Valider',
    invalidate: 'Invalider',
    reset: 'Réinitialiser',
    decisionHint:
      'Une décision est une annotation gardée dans le registre de revue : elle ne change pas les décisions du moteur.',
    itemHistory: 'Historique de cette connaissance',
    confirmTitle: 'Confirmer',
    confirm: 'Confirmer',
    cancel: 'Annuler',
    confirmInvalidate:
      'Invalider cette connaissance ? Elle restera affichée, marquée invalidée, jusqu’à une réinitialisation.',
    confirmReset: 'Retirer la décision humaine ?',
    flowsTabs: { flows: 'Flows', runs: 'Runs', states: 'États', transitions: 'Transitions', graph: 'Graphe' },
    flowCols: {
      name: 'Flow',
      source: 'Source',
      steps: 'Étapes',
      lastRun: 'Dernier rejeu',
      produces: 'Produit',
      consumes: 'Consomme',
    },
    runCols: {
      started: 'Démarré',
      mission: 'Mission',
      mode: 'Mode',
      status: 'Statut',
      states: 'États',
      actions: 'Actions',
      transitions: 'Transitions',
      anomalies: 'Anomalies',
      version: 'Version',
    },
    stateCols: {
      signature: 'Signature',
      outgoing: 'Sortantes',
      incoming: 'Entrantes',
      lastSeen: 'Dernière vue',
    },
    transitionCols: {
      from: 'Depuis',
      action: 'Action',
      to: 'Vers',
      seen: 'Vue',
      successes: 'Succès',
      failures: 'Échecs',
      blocked: 'Bloquée',
      status: 'Fiabilité',
    },
    graphHint:
      'Une transition observée n’est pas une transition garantie : la couleur dit la fiabilité calculée. Cliquez un écran ou une flèche.',
    graphTruncated: 'Graphe limité aux transitions les plus vues.',
    graphNone: '(aucun nouvel écran)',
    ledgerSummary: {
      sections: 'sections',
      added: 'ajoutées',
      replaced: 'remplacées',
      skipped: 'ignorées',
      backup: 'sauvegarde',
      target: 'application',
    },
    sourceLabels: { RECORDING: 'enregistrement', FLOW_RUN_MEMORY: 'mémoire des rejeux' },
    variableCols: {
      key: 'Variable',
      flow: 'Flow',
      strategy: 'Stratégie',
      producedBy: 'Produite par',
      usedBy: 'Consommée par',
      mappings: 'Correspondance UI ↔ API',
      issues: 'Signaux',
    },
    issueLabels: {
      NEVER_CONSUMED: 'jamais consommée',
      NO_PRODUCER: 'sans producteur',
      AMBIGUOUS_MAPPING: 'correspondance ambiguë',
      STATIC_REUSED: 'valeur fixe réutilisée',
      BROKEN_DEPENDENCY: 'dépendance cassée',
    },
    issuesFilter: 'Signal',
    variablesNone: 'Aucun enregistrement avec un jeu de données : rien à montrer.',
    variablesHint:
      'Lu dans recordings/<nom>/ (recorded-flow.json, test-data.yaml, human-review.json). Rien n’est modifié automatiquement.',
    humanBinding: 'Liaison humaine',
    value: 'Valeur',
    sensitive: 'sensible (jamais affichée)',
    qualityHint:
      'Les statuts sont calculés à partir des compteurs réels (formules documentées) ; une décision humaine est montrée à côté, jamais à la place.',
    signals: 'Signaux à vérifier',
    categories: 'Catégories de fiabilité',
    showAll: 'Voir dans l’explorateur',
    historyTabs: { ledger: 'Opérations de gestion', learning: 'Apprentissages' },
    ledgerCols: {
      at: 'Date',
      operation: 'Opération',
      item: 'Connaissance',
      before: 'Avant',
      after: 'Après',
      reason: 'Motif',
      errors: 'Erreurs',
    },
    learningCols: { at: 'Date', type: 'Type', title: 'Connaissance', detail: 'Détail', status: 'Statut' },
    persistence: {
      state: 'État de la persistance',
      memory: 'Mémoire (configuration effective, lecture seule)',
      providers: 'Fournisseurs',
      counts: 'Enregistrements',
      health: 'Santé',
      errors: 'Erreurs récentes',
      backups: 'Sauvegardes',
      exchange: 'Export et import',
      configured: 'Configuré',
      actual: 'Utilisé',
      reason: 'Raison',
      latency: 'Latence',
      schema: 'Version du schéma',
      lastWrite: 'Dernière écriture',
      lastBackup: 'Dernière sauvegarde',
      lastRestore: 'Dernière restauration',
      disabled:
        'Persistance désactivée (persistence.enabled: false) : rien n’est enregistré, le moteur fonctionne comme avant.',
      available: 'implémenté',
      planned: 'non implémenté',
      exportBtn: 'Exporter la Knowledge (JSON versionné)',
      importBtn: 'Importer un export…',
      backupBtn: 'Créer une sauvegarde',
      restoreBtn: 'Restaurer',
      preview: 'Aperçu de l’import',
      applyBtn: 'Importer',
      policyReplaceable: 'Lignes remplaçables (évolution, anomalies, mémoire des flows) déjà présentes',
      policyFiles: 'Fichiers (base de connaissances, fonctionnel, règles) déjà présents',
      skip: 'ignorer',
      replace: 'remplacer',
      backupFirst: 'Sauvegarder avant l’import',
      previewCols: {
        section: 'Section',
        total: 'Total',
        added: 'Ajoutées',
        identical: 'Identiques',
        conflicts: 'Conflits',
        skipped: 'Ignorées',
        onConflict: 'En cas de conflit',
      },
      resultCols: {
        section: 'Section',
        added: 'Ajoutées',
        replaced: 'Remplacées',
        skipped: 'Ignorées',
        errors: 'Erreurs',
      },
      confirmApply:
        'Importer ? Les lignes de connaissance déjà présentes ne sont jamais recomptées ; ce qui est remplacé l’est selon la politique choisie.',
      confirmRestore:
        'Restaurer cette sauvegarde ? Une sauvegarde de l’état courant est faite d’abord ; les lignes et fichiers remplaçables sont remplacés, le reste est dit.',
      restored: 'Restauration terminée',
      imported: 'Import terminé',
      backupDone: 'Sauvegarde écrite',
      noBackup: 'Aucune sauvegarde.',
      readOnlyHint: 'Lecture seule : aucune écriture possible (relancer sans --read-only).',
      memoryFields: {
        mode: 'Mode',
        enabled: 'memory.enabled',
        historical: 'memory.historicalKnowledge',
        preload: 'Budget de préchargement',
        file: 'Base de connaissances fichier',
        fileEnabled: 'Fichier utilisé par le moteur',
      },
      notSet: 'absent',
    },
    yes: 'activé',
    no: 'désactivé',
    statusLabels: {
      OBSERVED: 'observée',
      CONFIRMED: 'confirmée',
      FRAGILE: 'fragile',
      CONTRADICTED: 'contredite',
      STALE: 'obsolète',
      HYPOTHESIS: 'hypothèse',
      UNVERIFIED: 'non vérifiée',
    },
    originLabels: {
      EXPLORATION: 'exploration',
      REPLAY: 'rejeu',
      RECORDING: 'enregistrement',
      HUMAN: 'humain',
      NETWORK_LEARNING: 'réseau',
      STATIC_ANALYSIS: 'analyse statique',
      ANALYSIS: 'analyse',
      UNKNOWN: 'inconnue',
    },
    reviewLabels: { VALIDATED: 'validée', INVALIDATED: 'invalidée' },
  },
  en: {
    title: 'Knowledge Center',
    tagline: 'The memory of QA-CRAWLER',
    nav: {
      overview: 'Overview',
      explorer: 'Explorer',
      flows: 'Flows and transitions',
      variables: 'Business variables',
      quality: 'Quality',
      history: 'History',
      persistence: 'Persistence',
    },
    application: 'Application',
    memoryMode: {
      legacy: 'memory: knowledge file (as before)',
      isolated: 'memory: isolated run',
      'current-run': 'memory: current run',
      historical: 'memory: history preloaded',
    },
    readOnly: 'Read-only',
    refresh: 'Refresh',
    loading: 'Loading…',
    empty: 'Nothing to show.',
    error: 'Error',
    retry: 'Retry',
    unavailable: 'Not available',
    formula: 'Formula',
    metrics: {
      total: 'Knowledge rows',
      flows: 'Known flows',
      states: 'States',
      transitions: 'Transitions',
      validated: 'Validated (human)',
      invalidated: 'Invalidated (human)',
      toVerify: 'To verify',
      stale: 'Stale',
      runs: 'Persisted runs',
      runsUsingKnowledge: 'Runs that used the memory',
      reuseRate: 'Reuse rate (%)',
      lastSave: 'Last save',
      lastLearning: 'Last learning',
    },
    byType: 'By type',
    byStatus: 'By reliability',
    activity: {
      recent: 'Recently changed knowledge',
      runs: 'Latest runs',
      transitions: 'Latest discovered transitions',
      reused: 'Reused knowledge',
      resolutionFailures: 'Target resolution failures',
      persistenceErrors: 'Persistence errors',
      attention: 'Needs attention',
    },
    warnings: 'Read warnings',
    search: 'Search (title, key, description)',
    all: 'All',
    type: 'Type',
    status: 'Reliability',
    origin: 'Origin',
    source: 'Source',
    review: 'Human decision',
    reviewNone: 'No decision',
    sort: 'Sort',
    sorts: {
      updatedAt: 'Last seen',
      createdAt: 'First seen',
      title: 'Title',
      type: 'Type',
      status: 'Reliability',
      evidence: 'Evidence',
    },
    columns: {
      title: 'Knowledge',
      type: 'Type',
      status: 'Reliability',
      evidence: 'Evidence',
      updatedAt: 'Last seen',
      origin: 'Origin',
      review: 'Decision',
    },
    results: 'result(s)',
    page: 'Page',
    previous: 'Previous',
    next: 'Next',
    export: 'Export this list (CSV)',
    detail: 'Detail',
    close: 'Close',
    fields: {
      id: 'Stable id',
      key: 'Real key',
      source: 'Source',
      location: 'Location',
      application: 'Application',
      environment: 'Environment',
      createdAt: 'Created',
      updatedAt: 'Updated',
      appVersion: 'Application version',
      origin: 'Origin',
      description: 'Description',
    },
    evidence: 'Evidence',
    evidenceFields: {
      seen: 'seen',
      successes: 'successes',
      failures: 'failures',
      blocked: 'blocked',
      confirmations: 'confirmations',
      contradictions: 'contradictions',
      runIds: 'runs',
    },
    reliability: 'Computed reliability',
    data: 'Real data',
    executions: 'Executions in the latest runs',
    executionsCols: {
      at: 'Date',
      run: 'Run',
      status: 'Result',
      oracle: 'Oracle',
      duration: 'Duration',
      version: 'Version',
    },
    decision: 'Human decision',
    decisionNone: 'No decision: the computed reliability stands.',
    decisionNote: 'Note (optional)',
    validate: 'Validate',
    invalidate: 'Invalidate',
    reset: 'Reset',
    decisionHint:
      'A decision is an annotation kept in the review ledger: it does not change the engine decisions.',
    itemHistory: 'History of this knowledge',
    confirmTitle: 'Confirm',
    confirm: 'Confirm',
    cancel: 'Cancel',
    confirmInvalidate: 'Invalidate this knowledge? It stays visible, marked invalidated, until a reset.',
    confirmReset: 'Remove the human decision?',
    flowsTabs: { flows: 'Flows', runs: 'Runs', states: 'States', transitions: 'Transitions', graph: 'Graph' },
    flowCols: {
      name: 'Flow',
      source: 'Source',
      steps: 'Steps',
      lastRun: 'Last replay',
      produces: 'Produces',
      consumes: 'Consumes',
    },
    runCols: {
      started: 'Started',
      mission: 'Mission',
      mode: 'Mode',
      status: 'Status',
      states: 'States',
      actions: 'Actions',
      transitions: 'Transitions',
      anomalies: 'Anomalies',
      version: 'Version',
    },
    stateCols: { signature: 'Signature', outgoing: 'Outgoing', incoming: 'Incoming', lastSeen: 'Last seen' },
    transitionCols: {
      from: 'From',
      action: 'Action',
      to: 'To',
      seen: 'Seen',
      successes: 'Successes',
      failures: 'Failures',
      blocked: 'Blocked',
      status: 'Reliability',
    },
    graphHint:
      'An observed transition is not a guaranteed one: the color is the computed reliability. Click a screen or an arrow.',
    graphTruncated: 'Graph limited to the most seen transitions.',
    graphNone: '(no new screen)',
    ledgerSummary: {
      sections: 'sections',
      added: 'added',
      replaced: 'replaced',
      skipped: 'skipped',
      backup: 'backup',
      target: 'application',
    },
    sourceLabels: { RECORDING: 'recording', FLOW_RUN_MEMORY: 'replay memory' },
    variableCols: {
      key: 'Variable',
      flow: 'Flow',
      strategy: 'Strategy',
      producedBy: 'Produced by',
      usedBy: 'Consumed by',
      mappings: 'UI ↔ API mapping',
      issues: 'Signals',
    },
    issueLabels: {
      NEVER_CONSUMED: 'never consumed',
      NO_PRODUCER: 'no producer',
      AMBIGUOUS_MAPPING: 'ambiguous mapping',
      STATIC_REUSED: 'static value reused',
      BROKEN_DEPENDENCY: 'broken dependency',
    },
    issuesFilter: 'Signal',
    variablesNone: 'No recording with a data set: nothing to show.',
    variablesHint:
      'Read from recordings/<name>/ (recorded-flow.json, test-data.yaml, human-review.json). Nothing is changed automatically.',
    humanBinding: 'Human binding',
    value: 'Value',
    sensitive: 'sensitive (never shown)',
    qualityHint:
      'Statuses are computed from real counters (documented formulas); a human decision is shown next to them, never instead.',
    signals: 'Signals to verify',
    categories: 'Reliability categories',
    showAll: 'Open in the explorer',
    historyTabs: { ledger: 'Management operations', learning: 'Learning' },
    ledgerCols: {
      at: 'Date',
      operation: 'Operation',
      item: 'Knowledge',
      before: 'Before',
      after: 'After',
      reason: 'Reason',
      errors: 'Errors',
    },
    learningCols: { at: 'Date', type: 'Type', title: 'Knowledge', detail: 'Detail', status: 'Status' },
    persistence: {
      state: 'Persistence state',
      memory: 'Memory (effective configuration, read-only)',
      providers: 'Providers',
      counts: 'Records',
      health: 'Health',
      errors: 'Recent errors',
      backups: 'Backups',
      exchange: 'Export and import',
      configured: 'Configured',
      actual: 'Used',
      reason: 'Reason',
      latency: 'Latency',
      schema: 'Schema version',
      lastWrite: 'Last write',
      lastBackup: 'Last backup',
      lastRestore: 'Last restore',
      disabled:
        'Persistence disabled (persistence.enabled: false): nothing is recorded, the engine works as before.',
      available: 'implemented',
      planned: 'not implemented',
      exportBtn: 'Export the knowledge (versioned JSON)',
      importBtn: 'Import an export…',
      backupBtn: 'Create a backup',
      restoreBtn: 'Restore',
      preview: 'Import preview',
      applyBtn: 'Apply the import',
      policyReplaceable: 'Replaceable rows (evolution, anomalies, flow memory) already present',
      policyFiles: 'Files (knowledge base, functional, rules) already present',
      skip: 'skip',
      replace: 'replace',
      backupFirst: 'Back up before applying',
      previewCols: {
        section: 'Section',
        total: 'Total',
        added: 'Added',
        identical: 'Identical',
        conflicts: 'Conflicts',
        skipped: 'Skipped',
        onConflict: 'On conflict',
      },
      resultCols: {
        section: 'Section',
        added: 'Added',
        replaced: 'Replaced',
        skipped: 'Skipped',
        errors: 'Errors',
      },
      confirmApply:
        'Apply the import? Knowledge rows already present are never recounted; what is replaced follows the chosen policy.',
      confirmRestore:
        'Restore this backup? The current state is backed up first; replaceable rows and files are replaced, the rest is reported.',
      restored: 'Restore finished',
      imported: 'Import finished',
      backupDone: 'Backup written',
      noBackup: 'No backup.',
      readOnlyHint: 'Read-only: no write is possible (start again without --read-only).',
      memoryFields: {
        mode: 'Mode',
        enabled: 'memory.enabled',
        historical: 'memory.historicalKnowledge',
        preload: 'Preload budget',
        file: 'Knowledge file',
        fileEnabled: 'File used by the engine',
      },
      notSet: 'not set',
    },
    yes: 'enabled',
    no: 'disabled',
    statusLabels: {
      OBSERVED: 'observed',
      CONFIRMED: 'confirmed',
      FRAGILE: 'fragile',
      CONTRADICTED: 'contradicted',
      STALE: 'stale',
      HYPOTHESIS: 'hypothesis',
      UNVERIFIED: 'unverified',
    },
    originLabels: {
      EXPLORATION: 'exploration',
      REPLAY: 'replay',
      RECORDING: 'recording',
      HUMAN: 'human',
      NETWORK_LEARNING: 'network',
      STATIC_ANALYSIS: 'static analysis',
      ANALYSIS: 'analysis',
      UNKNOWN: 'unknown',
    },
    reviewLabels: { VALIDATED: 'validated', INVALIDATED: 'invalidated' },
  },
} as const;

const ICONS: Record<string, string> = {
  overview: '<path d="M3 13h8V3H3zM13 21h8v-6h-8zM13 3v8h8V3zM3 21h8v-4H3z"/>',
  explorer: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  flows:
    '<circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="12" cy="18" r="2"/><path d="M7 6h10M6 8l5 8M18 8l-5 8"/>',
  variables: '<path d="M4 7h16M4 12h10M4 17h7"/><circle cx="18" cy="16" r="3"/>',
  quality: '<path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z"/><path d="M9 12l2 2 4-4"/>',
  history: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  persistence:
    '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>',
  close: '<path d="M18 6L6 18M6 6l12 12"/>',
};

function icon(name: string, size = 18): string {
  return `<svg width="${String(size)}" height="${String(size)}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ''}</svg>`;
}

const CSS = `
${THEME_TOKENS_CSS}
${THEME_BASE_CSS}
*{box-sizing:border-box}
html{height:100%}
body{margin:0;height:100%;font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--text);-webkit-font-smoothing:antialiased}
a{color:var(--accent-ink)}
button,input,select,textarea{font:inherit;color:inherit}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;background:var(--grey-soft);padding:1px 5px;border-radius:5px;overflow-wrap:anywhere}
pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.5;background:var(--surface-2);border:1px solid var(--border);border-radius:10px;padding:10px 12px;overflow:auto;max-height:360px;margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.app{display:grid;grid-template-columns:232px minmax(0,1fr);min-height:100%}
.side{background:var(--chrome);border-right:1px solid var(--border);padding:16px 12px;display:flex;flex-direction:column;gap:14px;position:sticky;top:0;height:100vh;overflow:auto}
.side .qa-brand-name{font-size:17px}
.nav{display:flex;flex-direction:column;gap:2px}
.nav a{display:flex;align-items:center;gap:10px;min-height:40px;padding:6px 10px;border-radius:10px;color:var(--text-2);text-decoration:none;font-weight:600;font-size:13px}
.nav a:hover{background:var(--nav-hover);color:var(--text)}
.nav a[aria-current=page]{background:var(--accent-soft);color:var(--accent-ink)}
.side .foot{margin-top:auto;font-size:11px;color:var(--muted);line-height:1.4}
main{min-width:0;display:flex;flex-direction:column}
.top{display:flex;align-items:center;gap:12px;padding:12px 24px;background:var(--chrome);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:5;flex-wrap:wrap}
.top h1{margin:0;font-size:18px;font-weight:800;letter-spacing:-.01em}
.top .ctx{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-left:auto}
.sel{height:36px;border:1px solid var(--border-strong);border-radius:9px;background:var(--surface);padding:0 10px;min-width:0;max-width:100%}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:36px;padding:0 12px;border:1px solid var(--border-strong);border-radius:9px;background:var(--surface);color:var(--text-2);font-weight:600;font-size:13px;cursor:pointer;white-space:nowrap}
.btn:hover{background:var(--nav-hover)}
.btn.p{background:var(--accent);border-color:var(--accent);color:#fff}
.btn.p:hover{filter:brightness(1.06)}
.btn.ok{background:var(--ok-ink);border-color:var(--ok-ink);color:#fff}
.btn.danger{color:var(--red-ink);border-color:var(--red-border)}
.btn.sm{min-height:30px;padding:0 10px;font-size:12px}
.btn.ic{width:36px;padding:0}
.btn:disabled{opacity:.55;cursor:not-allowed}
.chip{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;background:var(--surface-2);border:1px solid var(--border);color:var(--text-2);font-size:12px;font-weight:600;white-space:nowrap}
.chip .dot{width:7px;height:7px;border-radius:50%;background:var(--ok)}
.chip.warn .dot{background:var(--warn)}
.chip.off .dot{background:var(--red)}
.content{padding:20px 24px 48px;display:flex;flex-direction:column;gap:18px;min-width:0}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:14px 16px;box-shadow:var(--shadow);min-width:0}
.card .label{font-size:12px;color:var(--muted);font-weight:600}
.card .value{font-size:26px;font-weight:800;line-height:1.2;margin-top:4px;font-variant-numeric:tabular-nums;letter-spacing:-.02em;overflow-wrap:anywhere}
.card .value.na{font-size:14px;color:var(--muted);font-weight:600}
.card .value.date{font-size:15px}
.card .formula{font-size:11px;color:var(--muted);margin-top:6px;line-height:1.4}
.panel{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:16px 18px;box-shadow:var(--shadow);min-width:0}
.panel h2{margin:0 0 12px;font-size:15px;font-weight:700;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.panel h2 .count{font-size:11px;color:var(--grey-ink);background:var(--grey-soft);border-radius:999px;padding:0 8px;font-weight:700;min-width:20px;text-align:center}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:14px}
.hint{color:var(--muted);font-size:12.5px;margin:0 0 10px}
.list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.list li{display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-bottom:1px solid var(--border);min-width:0}
.list li:last-child{border-bottom:0}
.list .t{flex:1;min-width:0;overflow-wrap:anywhere}
.list .t small{display:block;color:var(--muted);font-size:12px}
.list .at{color:var(--muted);font-size:12px;white-space:nowrap;font-variant-numeric:tabular-nums}
.list a{color:var(--text);text-decoration:none;font-weight:600}
.list a:hover{color:var(--accent-ink)}
.empty{color:var(--muted);padding:14px;text-align:center;border:1px dashed var(--border-strong);border-radius:10px}
.bars{display:flex;flex-direction:column;gap:6px}
.bar{display:grid;grid-template-columns:150px minmax(0,1fr) 50px;gap:8px;align-items:center;font-size:12.5px}
.bar .track{height:8px;border-radius:4px;background:var(--grey-soft);overflow:hidden}
.bar .fill{height:100%;background:var(--accent);border-radius:4px}
.bar .n{text-align:right;font-variant-numeric:tabular-nums;color:var(--muted)}
.toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.toolbar input[type=search]{flex:1 1 240px;min-width:0;height:36px;border:1px solid var(--border-strong);border-radius:9px;background:var(--surface);padding:0 12px}
.tablewrap{overflow-x:auto;border:1px solid var(--border);border-radius:12px;background:var(--surface)}
table{width:100%;border-collapse:separate;border-spacing:0;font-size:13px;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--border);vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.05em;background:var(--surface-2);white-space:nowrap;position:sticky;top:0}
th button{border:0;background:transparent;padding:0;font:inherit;color:inherit;cursor:pointer;text-transform:inherit;letter-spacing:inherit}
tbody tr:last-child>td{border-bottom:0}
tbody tr.row{cursor:pointer}
tbody tr.row:hover>td{background:var(--surface-2)}
tbody tr[aria-selected=true]>td{background:var(--accent-soft)}
td.w{overflow-wrap:anywhere;min-width:220px}
td.n{text-align:right;white-space:nowrap}
.st{display:inline-block;padding:1px 9px;border-radius:6px;font-size:11px;font-weight:700;letter-spacing:.02em;white-space:nowrap}
.st.CONFIRMED,.st.VALIDATED,.st.PASSED,.st.COMPLETED,.st.SUCCESS,.st.CONNECTED{background:var(--ok-soft);color:var(--ok-ink)}
.st.OBSERVED,.st.RUNNING{background:var(--blue-soft);color:var(--blue-ink)}
.st.FRAGILE,.st.STALE,.st.FALLBACK,.st.BLOCKED{background:var(--warn-soft);color:var(--warn-ink)}
.st.CONTRADICTED,.st.INVALIDATED,.st.FAILED,.st.UNAVAILABLE{background:var(--red-soft);color:var(--red-ink)}
.st.HYPOTHESIS{background:var(--purple-soft);color:var(--purple-ink)}
.st.UNVERIFIED,.st.DISABLED,.st.none{background:var(--grey-soft);color:var(--grey-ink)}
.tag{display:inline-block;padding:1px 7px;border-radius:5px;font-size:11px;font-weight:700;background:var(--grey-soft);color:var(--grey-ink);white-space:nowrap}
.pager{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:13px;color:var(--muted)}
.pager .sp{flex:1}
.drawer{position:fixed;top:0;right:0;bottom:0;width:min(560px,96vw);background:var(--surface);border-left:1px solid var(--border);box-shadow:-12px 0 32px rgba(16,24,40,.18);z-index:20;display:flex;flex-direction:column;transform:translateX(102%);transition:transform .18s ease}
.drawer[data-open=true]{transform:none}
.drawer .dh{display:flex;align-items:flex-start;gap:10px;padding:14px 16px;border-bottom:1px solid var(--border)}
.drawer .dh h2{margin:0;font-size:15px;flex:1;min-width:0;overflow-wrap:anywhere}
.drawer .db{padding:14px 16px;overflow:auto;display:flex;flex-direction:column;gap:14px}
.backdrop{position:fixed;inset:0;background:rgba(16,24,40,.28);z-index:19;display:none}
.backdrop[data-open=true]{display:block}
.kv{display:grid;grid-template-columns:minmax(120px,190px) minmax(0,1fr);gap:4px 12px;font-size:13px}
.kv dt{color:var(--muted);overflow-wrap:anywhere}
.kv dd{margin:0;overflow-wrap:anywhere}
h3{font-size:13px;font-weight:700;margin:0 0 6px;color:var(--text-2);text-transform:uppercase;letter-spacing:.05em}
.reasons{margin:4px 0 0;padding-left:18px;color:var(--text-2);font-size:12.5px}
textarea{width:100%;min-height:60px;border:1px solid var(--border-strong);border-radius:9px;background:var(--surface);padding:8px 10px;resize:vertical}
.actions{display:flex;gap:8px;flex-wrap:wrap}
.tabs{display:flex;gap:2px;border-bottom:1px solid var(--border);margin-bottom:12px;flex-wrap:wrap}
.tabs button{border:0;background:transparent;padding:8px 12px;font-weight:600;color:var(--muted);border-bottom:2px solid transparent;margin-bottom:-1px;cursor:pointer}
.tabs button[aria-selected=true]{color:var(--text);border-color:var(--accent)}
.graph{width:100%;height:560px;border:1px solid var(--border);border-radius:12px;background:var(--surface-2);overflow:hidden}
.graph svg{width:100%;height:100%;cursor:grab}
.graph .node rect{fill:var(--surface);stroke:var(--border-strong);stroke-width:1.2}
.graph .node text{font-size:11px;fill:var(--text)}
.graph .node.none rect{stroke-dasharray:4 3}
.graph .edge{fill:none;stroke-width:1.6;opacity:.85}
.graph .edge.CONFIRMED{stroke:var(--ok)}.graph .edge.OBSERVED{stroke:var(--blue)}.graph .edge.FRAGILE,.graph .edge.STALE{stroke:var(--warn)}.graph .edge.CONTRADICTED{stroke:var(--red)}.graph .edge.UNVERIFIED,.graph .edge.HYPOTHESIS{stroke:var(--link)}
.graph .edge:hover{stroke-width:3;opacity:1}
.legend{display:flex;gap:12px;flex-wrap:wrap;font-size:12px;color:var(--muted);margin-top:8px}
.legend i{display:inline-block;width:14px;height:3px;border-radius:2px;vertical-align:middle;margin-right:5px}
.modal{position:fixed;inset:0;display:none;align-items:center;justify-content:center;z-index:30;background:rgba(16,24,40,.35)}
.modal[data-open=true]{display:flex}
.modal .box{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:18px 20px;width:min(480px,92vw);box-shadow:0 20px 50px rgba(16,24,40,.3)}
.modal h2{margin:0 0 8px;font-size:16px}
.modal p{margin:0 0 14px;color:var(--text-2)}
.toast{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);background:var(--text);color:var(--bg);padding:10px 16px;border-radius:10px;font-weight:600;z-index:40;display:none;max-width:min(640px,92vw)}
.toast[data-open=true]{display:block}
.toast.err{background:var(--red-ink);color:#fff}
.warnbox{background:var(--warn-bg);border:1px solid var(--warn-border);color:var(--warn-ink);border-radius:10px;padding:10px 12px;font-size:12.5px}
.errbox{background:var(--red-bg);border:1px solid var(--red-border);color:var(--red-ink);border-radius:10px;padding:10px 12px}
.okbox{background:var(--ok-bg);border:1px solid var(--ok-border);color:var(--ok-ink);border-radius:10px;padding:10px 12px}
.field{display:flex;flex-direction:column;gap:4px;font-size:13px}
.field label{color:var(--muted);font-weight:600;font-size:12px}
.vis{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.menu-btn{display:none}
@media (max-width:980px){
  .app{grid-template-columns:1fr}
  .side{position:fixed;left:0;top:0;bottom:0;width:240px;transform:translateX(-100%);transition:transform .18s;z-index:25;height:100vh}
  .side[data-open=true]{transform:none}
  .menu-btn{display:inline-flex}
  .content{padding:14px 16px 40px}
  .kv{grid-template-columns:1fr}
  .bar{grid-template-columns:110px minmax(0,1fr) 44px}
  .top{padding:10px 16px}
}
@media (prefers-reduced-motion:reduce){.drawer,.side{transition:none}}
`;

export function knowledgeCenterPage(options: PageOptions): string {
  const T = TEXTS[options.language];
  const nav = (Object.keys(T.nav) as (keyof typeof T.nav)[])
    .map(
      (view) => `<a href="#/${view}" data-view="${view}">${icon(view)}<span>${esc(T.nav[view])}</span></a>`,
    )
    .join('');
  return `<!doctype html>
<html lang="${options.language}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(T.title)} · QA-CRAWLER</title>
${THEME_BOOT_SCRIPT}
<style>${CSS}</style>
</head>
<body>
<div class="app">
  <aside class="side" id="side" aria-label="${esc(T.nav.overview)}">
    ${brandBlock(esc(T.title), 32)}
    <nav class="nav" aria-label="${esc(T.title)}">${nav}</nav>
    <div class="foot">${esc(T.tagline)}<br><span id="foot-version"></span>${options.docsUrl ? `<br><a href="${esc(options.docsUrl)}">docs/KNOWLEDGE_CENTER.md</a>` : ''}</div>
  </aside>
  <main>
    <div class="top">
      <button type="button" class="btn ic menu-btn" id="menu" aria-label="menu">${icon('explorer')}</button>
      <h1 id="view-title">${esc(T.nav.overview)}</h1>
      <div class="ctx">
        <label class="vis" for="app-select">${esc(T.application)}</label>
        <select id="app-select" class="sel" aria-label="${esc(T.application)}"></select>
        <span class="chip" id="memory-chip"><span class="dot"></span><span id="memory-text"></span></span>
        ${options.readOnly ? `<span class="chip warn"><span class="dot"></span>${esc(T.readOnly)}</span>` : ''}
        <button type="button" class="btn ic" id="refresh" aria-label="${esc(T.refresh)}" title="${esc(T.refresh)}">${icon('refresh')}</button>
        ${themeToggle(options.language)}
      </div>
    </div>
    <div class="content" id="content" aria-live="polite"></div>
  </main>
</div>
<div class="backdrop" id="backdrop"></div>
<aside class="drawer" id="drawer" aria-label="${esc(T.detail)}" role="dialog" aria-modal="false">
  <div class="dh"><h2 id="drawer-title"></h2><button type="button" class="btn ic" id="drawer-close" aria-label="${esc(T.close)}">${icon('close')}</button></div>
  <div class="db" id="drawer-body"></div>
</aside>
<div class="modal" id="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
  <div class="box"><h2 id="modal-title">${esc(T.confirmTitle)}</h2><p id="modal-text"></p><div class="actions"><button type="button" class="btn" id="modal-cancel">${esc(T.cancel)}</button><button type="button" class="btn p" id="modal-ok">${esc(T.confirm)}</button></div></div>
</div>
<div class="toast" id="toast" role="status"></div>
<script>
var T = ${JSON.stringify(T)};
var TOKEN = ${JSON.stringify(options.token)};
var READ_ONLY = ${JSON.stringify(options.readOnly)};
${SCRIPT}
</script>
${THEME_TOGGLE_SCRIPT}
</body>
</html>`;
}

/* Le script de la page : routage par le hachage, appels à l'API, rendu des vues. Aucune bibliothèque. */
const SCRIPT = String.raw`
(function () {
  'use strict';
  var state = { app: null, meta: null, view: 'overview', query: {}, selected: null, flowsTab: 'flows', historyTab: 'ledger', issue: '' };
  var content = document.getElementById('content');
  var $ = function (id) { return document.getElementById(id); };

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtDate(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return esc(iso);
    return d.toLocaleString();
  }
  function fmtNum(n) { return typeof n === 'number' ? n.toLocaleString() : esc(n); }
  function statusPill(status, label) { return '<span class="st ' + esc(status) + '">' + esc(label || (T.statusLabels[status] || status)) + '</span>'; }
  function toast(message, isError) {
    var el = $('toast');
    el.textContent = message;
    el.className = 'toast' + (isError ? ' err' : '');
    el.dataset.open = 'true';
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.dataset.open = 'false'; }, 4000);
  }
  function confirmDialog(text) {
    return new Promise(function (resolve) {
      var modal = $('modal');
      $('modal-text').textContent = text;
      modal.dataset.open = 'true';
      var done = function (ok) { modal.dataset.open = 'false'; $('modal-ok').onclick = null; $('modal-cancel').onclick = null; resolve(ok); };
      $('modal-ok').onclick = function () { done(true); };
      $('modal-cancel').onclick = function () { done(false); };
      $('modal-ok').focus();
    });
  }
  function api(path, options) {
    options = options || {};
    var headers = { 'Accept': 'application/json' };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['X-QA-Knowledge-Center'] = '1';
      headers['Authorization'] = 'Bearer ' + TOKEN;
    }
    return fetch('/api' + path, { method: options.method || (options.body !== undefined ? 'POST' : 'GET'), headers: headers, body: options.body !== undefined ? JSON.stringify(options.body) : undefined })
      .then(function (response) {
        return response.text().then(function (text) {
          var data = {};
          try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { error: text }; }
          if (!response.ok) { var err = new Error(data.error || ('HTTP ' + response.status)); err.status = response.status; err.details = data.details || []; throw err; }
          return data;
        });
      });
  }
  function appPath(rest) { return '/apps/' + encodeURIComponent(state.app) + rest; }
  function errorBox(error, retry) {
    return '<div class="errbox"><b>' + esc(T.error) + '</b> : ' + esc(error.message) + (error.details && error.details.length ? '<ul>' + error.details.map(function (d) { return '<li>' + esc(d) + '</li>'; }).join('') + '</ul>' : '') + (retry ? ' <button type="button" class="btn sm" data-retry>' + esc(T.retry) + '</button>' : '') + '</div>';
  }
  function loading() { return '<div class="empty">' + esc(T.loading) + '</div>'; }
  function empty(text) { return '<div class="empty">' + esc(text || T.empty) + '</div>'; }
  function warningsBox(warnings) {
    if (!warnings || !warnings.length) return '';
    return '<div class="warnbox"><b>' + esc(T.warnings) + '</b><ul>' + warnings.map(function (w) { return '<li><code>' + esc(w.location || '') + '</code> ' + esc(w.message || w) + '</li>'; }).join('') + '</ul></div>';
  }
  function itemLink(entry) {
    return '<a href="#/explorer?item=' + encodeURIComponent(entry.id) + '">' + esc(entry.title) + '</a>';
  }

  /* ───────── routage ───────── */
  function parseHash() {
    var hash = location.hash.replace(/^#\/?/, '');
    var parts = hash.split('?');
    var view = parts[0] || 'overview';
    var params = {};
    if (parts[1]) parts[1].split('&').forEach(function (pair) { var kv = pair.split('='); params[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || ''); });
    return { view: T.nav[view] ? view : 'overview', params: params };
  }
  function navigate(view, params) {
    var query = Object.keys(params || {}).filter(function (k) { return params[k] !== undefined && params[k] !== ''; }).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&');
    location.hash = '#/' + view + (query ? '?' + query : '');
  }
  function render() {
    var route = parseHash();
    state.view = route.view;
    $('view-title').textContent = T.nav[route.view];
    document.querySelectorAll('.nav a').forEach(function (a) { if (a.dataset.view === route.view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    $('side').dataset.open = 'false';
    if (!state.app) { content.innerHTML = loading(); return; }
    var views = { overview: renderOverview, explorer: renderExplorer, flows: renderFlows, variables: renderVariables, quality: renderQuality, history: renderHistory, persistence: renderPersistence };
    views[route.view](route.params);
  }
  window.addEventListener('hashchange', render);

  /* ───────── meta ───────── */
  function loadMeta() {
    content.innerHTML = loading();
    return api('/meta').then(function (meta) {
      state.meta = meta;
      var select = $('app-select');
      select.innerHTML = meta.applications.map(function (app) { return '<option value="' + esc(app.id) + '"' + (app.current ? ' selected' : '') + '>' + esc(app.id) + (app.current ? ' ★' : '') + '</option>'; }).join('');
      if (!state.app || !meta.applications.some(function (app) { return app.id === state.app; })) {
        var current = meta.applications.filter(function (app) { return app.current; })[0] || meta.applications[0];
        state.app = current ? current.id : null;
      }
      select.value = state.app;
      var mem = meta.memory;
      $('memory-text').textContent = T.memoryMode[mem.mode] + ' · ' + (mem.persistence.enabled ? mem.persistence.status + (mem.persistence.actual ? ' (' + (mem.persistence.actual.database || mem.persistence.actual.provider) + ')' : '') : 'persistence off');
      $('memory-chip').className = 'chip' + (mem.persistence.status === 'FALLBACK' ? ' warn' : mem.persistence.enabled ? '' : ' off');
      $('foot-version').textContent = 'QA-CRAWLER ' + meta.crawlerVersion + ' · ' + meta.mission;
      render();
    }).catch(function (error) { content.innerHTML = errorBox(error, true); });
  }
  $('app-select').addEventListener('change', function (event) { state.app = event.target.value; state.selected = null; render(); });
  $('refresh').addEventListener('click', function () {
    api('/refresh', { body: {} }).catch(function () { return null; }).then(loadMeta);
  });
  $('menu').addEventListener('click', function () { var side = $('side'); side.dataset.open = side.dataset.open === 'true' ? 'false' : 'true'; });
  content.addEventListener('click', function (event) {
    if (event.target.closest('[data-retry]')) render();
  });

  /* ───────── vue d'ensemble ───────── */
  function metricCard(key, metric) {
    var label = T.metrics[key] || key;
    if (!metric || metric.unavailable) return '<div class="card"><div class="label">' + esc(label) + '</div><div class="value na">' + esc(T.unavailable) + '</div><div class="formula">' + esc(metric ? metric.reason : '') + '</div></div>';
    var isDate = /^\d{4}-\d{2}-\d{2}T/.test(String(metric.value));
    return '<div class="card"><div class="label">' + esc(label) + '</div><div class="value' + (isDate ? ' date' : '') + '">' + (isDate ? fmtDate(metric.value) : fmtNum(metric.value)) + '</div><div class="formula">' + esc(T.formula) + ' : ' + esc(metric.formula) + '</div></div>';
  }
  function bars(counts, labels, link) {
    var keys = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; });
    if (!keys.length) return empty();
    var max = Math.max.apply(null, keys.map(function (k) { return counts[k]; }));
    return '<div class="bars">' + keys.map(function (k) {
      var label = labels ? (labels[k] || k) : k;
      return '<div class="bar"><a href="' + link(k) + '" style="color:var(--text);text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(label) + '</a><div class="track"><div class="fill" style="width:' + Math.round(counts[k] / max * 100) + '%"></div></div><span class="n">' + fmtNum(counts[k]) + '</span></div>';
    }).join('') + '</div>';
  }
  function activityList(entries, extra) {
    if (!entries || !entries.length) return empty();
    return '<ul class="list">' + entries.map(function (e) {
      return '<li><div class="t">' + (e.id ? itemLink(e) : esc(e.title)) + (e.detail ? '<small>' + esc(e.detail) + '</small>' : '') + '</div>' + (e.status ? statusPill(e.status, T.statusLabels[e.status] || e.status) : '') + '<span class="at">' + fmtDate(e.at) + '</span></li>';
    }).join('') + '</ul>';
  }
  function renderOverview() {
    content.innerHTML = loading();
    api(appPath('/overview')).then(function (o) {
      var order = ['total', 'flows', 'states', 'transitions', 'validated', 'toVerify', 'stale', 'invalidated', 'runs', 'runsUsingKnowledge', 'reuseRate', 'lastSave', 'lastLearning'];
      var html = warningsBox(o.warnings);
      html += '<div class="cards">' + order.map(function (k) { return metricCard(k, o.metrics[k]); }).join('') + '</div>';
      html += '<div class="grid2"><div class="panel"><h2>' + esc(T.byType) + '</h2>' + bars(o.byType, null, function (k) { return '#/explorer?type=' + k; }) + '</div><div class="panel"><h2>' + esc(T.byStatus) + '</h2>' + bars(o.byStatus, T.statusLabels, function (k) { return '#/explorer?status=' + k; }) + '</div></div>';
      var a = o.activity;
      html += '<div class="grid2">';
      html += '<div class="panel"><h2>' + esc(T.activity.recent) + '</h2>' + activityList(a.recent) + '</div>';
      html += '<div class="panel"><h2>' + esc(T.activity.runs) + '</h2>' + (a.runs.length ? '<ul class="list">' + a.runs.map(function (r) { return '<li><div class="t"><a href="#/flows?tab=runs">' + esc(r.missionName) + ' · ' + esc(r.mode) + '</a><small>' + r.statesCount + ' ' + esc(T.runCols.states.toLowerCase()) + ', ' + r.transitionsCount + ' ' + esc(T.runCols.transitions.toLowerCase()) + ', ' + r.anomaliesCount + ' ' + esc(T.runCols.anomalies.toLowerCase()) + '</small></div>' + statusPill(r.status, r.status) + '<span class="at">' + fmtDate(r.startedAt) + '</span></li>'; }).join('') + '</ul>' : empty()) + '</div>';
      html += '<div class="panel"><h2>' + esc(T.activity.transitions) + '</h2>' + activityList(a.transitions) + '</div>';
      html += '<div class="panel"><h2>' + esc(T.activity.reused) + '</h2>' + activityList(a.reused) + '</div>';
      html += '<div class="panel"><h2>' + esc(T.activity.resolutionFailures) + '</h2>' + activityList(a.resolutionFailures) + '</div>';
      html += '<div class="panel"><h2>' + esc(T.activity.attention) + '</h2>' + activityList(a.attention) + '</div>';
      html += '<div class="panel"><h2>' + esc(T.activity.persistenceErrors) + '</h2>' + (a.persistenceErrors.unavailable ? '<div class="empty">' + esc(T.unavailable) + ' — ' + esc(a.persistenceErrors.reason) + '</div>' : '<div class="card"><div class="value">' + fmtNum(a.persistenceErrors.value) + '</div><div class="formula">' + esc(a.persistenceErrors.formula) + '</div><a href="#/persistence">' + esc(T.nav.persistence) + '</a></div>') + '</div>';
      html += '</div>';
      content.innerHTML = html;
    }).catch(function (error) { content.innerHTML = errorBox(error, true); });
  }

  /* ───────── explorateur ───────── */
  function selectHtml(id, label, options, value, allLabel) {
    return '<label class="vis" for="' + id + '">' + esc(label) + '</label><select class="sel" id="' + id + '" title="' + esc(label) + '"><option value="">' + esc(allLabel || (label + ' : ' + T.all)) + '</option>' + options.map(function (o) { return '<option value="' + esc(o.value) + '"' + (o.value === value ? ' selected' : '') + '>' + esc(o.label) + '</option>'; }).join('') + '</select>';
  }
  function evidenceText(e) {
    var parts = [];
    ['seen', 'successes', 'failures', 'blocked', 'confirmations', 'contradictions'].forEach(function (k) { if (typeof e[k] === 'number') parts.push(e[k] + ' ' + T.evidenceFields[k]); });
    return parts.join(' · ') || '—';
  }
  function renderExplorer(params) {
    var q = state.query = {
      text: params.text || '', type: params.type || '', status: params.status || '', origin: params.origin || '', source: params.source || '', review: params.review || '',
      sort: params.sort || 'updatedAt', direction: params.direction || 'desc', page: Number(params.page) || 1, pageSize: Number(params.pageSize) || 25
    };
    var voc = state.meta.vocabulary;
    var html = '<div class="toolbar">';
    html += '<input type="search" id="q-text" placeholder="' + esc(T.search) + '" value="' + esc(q.text) + '" aria-label="' + esc(T.search) + '">';
    html += selectHtml('q-type', T.type, voc.types.map(function (t) { return { value: t, label: t }; }), q.type);
    html += selectHtml('q-status', T.status, voc.statuses.map(function (s) { return { value: s, label: T.statusLabels[s] || s }; }), q.status);
    html += selectHtml('q-origin', T.origin, voc.origins.map(function (o) { return { value: o, label: T.originLabels[o] || o }; }), q.origin);
    html += selectHtml('q-source', T.source, ['PERSISTENCE', 'KNOWLEDGE_FILE', 'FUNCTIONAL_FILE', 'RULES_FILE'].map(function (s) { return { value: s, label: s.toLowerCase().replace('_', ' ') }; }), q.source);
    html += selectHtml('q-review', T.review, [{ value: 'VALIDATED', label: T.reviewLabels.VALIDATED }, { value: 'INVALIDATED', label: T.reviewLabels.INVALIDATED }, { value: 'NONE', label: T.reviewNone }], q.review);
    html += selectHtml('q-sort', T.sort, Object.keys(T.sorts).map(function (s) { return { value: s, label: T.sorts[s] }; }), q.sort, T.sort + ' : ' + T.sorts.updatedAt);
    html += '<button type="button" class="btn sm" id="q-csv">' + esc(T.export) + '</button>';
    html += '</div><div id="results">' + loading() + '</div>';
    content.innerHTML = html;
    var apply = function () {
      navigate('explorer', { text: $('q-text').value, type: $('q-type').value, status: $('q-status').value, origin: $('q-origin').value, source: $('q-source').value, review: $('q-review').value, sort: $('q-sort').value, direction: q.direction, page: 1, pageSize: q.pageSize });
    };
    ['q-type', 'q-status', 'q-origin', 'q-source', 'q-review', 'q-sort'].forEach(function (id) { $(id).addEventListener('change', apply); });
    var timer;
    $('q-text').addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(apply, 350); });
    $('q-text').addEventListener('keydown', function (event) { if (event.key === 'Enter') { clearTimeout(timer); apply(); } });
    $('q-csv').addEventListener('click', function () { exportCsv(); });
    loadResults(params.item);
  }
  function queryString(q) {
    return Object.keys(q).filter(function (k) { return q[k] !== '' && q[k] !== undefined; }).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(q[k]); }).join('&');
  }
  var lastPage = null;
  function loadResults(openItem) {
    var q = state.query;
    api(appPath('/items?' + queryString(q))).then(function (page) {
      lastPage = page;
      var cols = [['title', 'title'], ['type', 'type'], ['status', 'status'], ['evidence', 'evidence'], ['updatedAt', 'updatedAt'], ['origin', ''], ['review', '']];
      var html = '<div class="pager"><span>' + fmtNum(page.total) + ' ' + esc(T.results) + '</span><span class="sp"></span>' + pagerHtml(page) + '</div>';
      if (!page.items.length) html += empty();
      else {
        html += '<div class="tablewrap"><table><thead><tr>' + cols.map(function (c) {
          var sortable = c[1];
          var arrow = sortable === q.sort ? (q.direction === 'asc' ? ' ▲' : ' ▼') : '';
          return '<th' + (c[0] === 'evidence' ? '' : '') + '>' + (sortable ? '<button type="button" data-sort="' + sortable + '">' + esc(T.columns[c[0]]) + arrow + '</button>' : esc(T.columns[c[0]])) + '</th>';
        }).join('') + '</tr></thead><tbody>' + page.items.map(function (item) {
          return '<tr class="row" tabindex="0" data-id="' + esc(item.id) + '"' + (state.selected === item.id ? ' aria-selected="true"' : '') + '><td class="w"><b>' + esc(item.title) + '</b><br><small style="color:var(--muted)">' + esc(item.description || '') + '</small></td><td><span class="tag">' + esc(item.type) + '</span></td><td>' + statusPill(item.reliability.status) + '</td><td>' + esc(evidenceText(item.evidence)) + '</td><td style="white-space:nowrap">' + fmtDate(item.updatedAt || item.createdAt) + '</td><td>' + esc(T.originLabels[item.origin] || item.origin) + '</td><td>' + (item.review ? statusPill(item.review.status, T.reviewLabels[item.review.status]) : '') + '</td></tr>';
        }).join('') + '</tbody></table></div>';
        html += '<div class="pager"><span class="sp"></span>' + pagerHtml(page) + '</div>';
      }
      $('results').innerHTML = html;
      $('results').querySelectorAll('[data-sort]').forEach(function (button) {
        button.addEventListener('click', function () {
          var sort = button.dataset.sort;
          navigate('explorer', Object.assign({}, q, { sort: sort, direction: q.sort === sort && q.direction === 'desc' ? 'asc' : 'desc', page: 1 }));
        });
      });
      $('results').querySelectorAll('[data-page]').forEach(function (button) {
        button.addEventListener('click', function () { navigate('explorer', Object.assign({}, q, { page: Number(button.dataset.page) })); });
      });
      $('results').querySelectorAll('tr.row').forEach(function (row) {
        var open = function () { openItem_(row.dataset.id); };
        row.addEventListener('click', open);
        row.addEventListener('keydown', function (event) { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } });
      });
      if (openItem) openItem_(openItem);
    }).catch(function (error) { $('results').innerHTML = errorBox(error, true); });
  }
  function pagerHtml(page) {
    return '<button type="button" class="btn sm" data-page="' + (page.page - 1) + '"' + (page.page <= 1 ? ' disabled' : '') + '>' + esc(T.previous) + '</button><span>' + esc(T.page) + ' ' + page.page + ' / ' + page.pages + '</span><button type="button" class="btn sm" data-page="' + (page.page + 1) + '"' + (page.page >= page.pages ? ' disabled' : '') + '>' + esc(T.next) + '</button>';
  }
  function exportCsv() {
    if (!lastPage) return;
    var rows = [['id', 'type', 'status', 'title', 'key', 'origin', 'source', 'updatedAt', 'evidence', 'review']].concat(lastPage.items.map(function (i) {
      return [i.id, i.type, i.reliability.status, i.title, i.key, i.origin, i.source, i.updatedAt || '', evidenceText(i.evidence), i.review ? i.review.status : ''];
    }));
    var csv = rows.map(function (r) { return r.map(function (v) { return '"' + String(v).replace(/"/g, '""') + '"'; }).join(','); }).join('\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'knowledge-' + state.app + '-page' + lastPage.page + '.csv';
    document.body.appendChild(a); a.click(); a.remove();
  }

  /* ───────── détail ───────── */
  function openDrawer(title, body) {
    $('drawer-title').textContent = title;
    $('drawer-body').innerHTML = body;
    $('drawer').dataset.open = 'true';
    $('backdrop').dataset.open = 'true';
    $('drawer-close').focus();
  }
  function closeDrawer() {
    $('drawer').dataset.open = 'false';
    $('backdrop').dataset.open = 'false';
    state.selected = null;
    document.querySelectorAll('tr[aria-selected=true]').forEach(function (row) { row.removeAttribute('aria-selected'); });
  }
  $('drawer-close').addEventListener('click', closeDrawer);
  $('backdrop').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', function (event) { if (event.key === 'Escape') { if ($('modal').dataset.open === 'true') $('modal-cancel').click(); else closeDrawer(); } });

  function openItem_(id) {
    state.selected = id;
    document.querySelectorAll('tr.row').forEach(function (row) { if (row.dataset.id === id) row.setAttribute('aria-selected', 'true'); else row.removeAttribute('aria-selected'); });
    openDrawer(T.loading, loading());
    api(appPath('/items/' + encodeURIComponent(id))).then(function (detail) {
      renderItem(detail);
    }).catch(function (error) { $('drawer-body').innerHTML = errorBox(error); });
  }
  function renderItem(detail) {
    var item = detail.item;
    var html = '<div><span class="tag">' + esc(item.type) + '</span> ' + statusPill(item.reliability.status) + (item.review ? ' ' + statusPill(item.review.status, T.reviewLabels[item.review.status]) : '') + '</div>';
    html += '<dl class="kv">';
    [['id', item.id], ['key', item.key], ['source', item.source], ['location', item.location], ['application', item.application], ['environment', item.environment], ['origin', T.originLabels[item.origin] || item.origin], ['createdAt', item.createdAt ? fmtDate(item.createdAt) : null], ['updatedAt', item.updatedAt ? fmtDate(item.updatedAt) : null], ['appVersion', item.appVersion], ['description', item.description]].forEach(function (f) {
      if (f[1] === undefined || f[1] === null || f[1] === '') return;
      html += '<dt>' + esc(T.fields[f[0]]) + '</dt><dd>' + (f[0] === 'id' || f[0] === 'key' || f[0] === 'location' ? '<code>' + esc(f[1]) + '</code>' : esc(f[1])) + '</dd>';
    });
    html += '</dl>';
    html += '<div><h3>' + esc(T.evidence) + '</h3>' + esc(evidenceText(item.evidence)) + (item.evidence.runIds && item.evidence.runIds.length ? '<br><small>' + esc(T.evidenceFields.runIds) + ' : ' + item.evidence.runIds.map(function (r) { return '<code>' + esc(r) + '</code>'; }).join(' ') + '</small>' : '') + '</div>';
    html += '<div><h3>' + esc(T.reliability) + '</h3>' + statusPill(item.reliability.status) + '<ul class="reasons">' + item.reliability.reasons.map(function (r) { return '<li>' + esc(r) + '</li>'; }).join('') + '</ul></div>';
    html += '<div><h3>' + esc(T.executions) + '</h3>' + (detail.executions.length ? '<div class="tablewrap"><table><thead><tr><th>' + esc(T.executionsCols.at) + '</th><th>' + esc(T.executionsCols.run) + '</th><th>' + esc(T.executionsCols.status) + '</th><th>' + esc(T.executionsCols.oracle) + '</th><th>' + esc(T.executionsCols.duration) + '</th><th>' + esc(T.executionsCols.version) + '</th></tr></thead><tbody>' + detail.executions.map(function (e) { return '<tr><td style="white-space:nowrap">' + fmtDate(e.at) + '</td><td><code>' + esc(e.runId.slice(0, 8)) + '</code> ' + esc(e.missionName) + ' <span class="st ' + esc(e.runStatus) + '">' + esc(e.runStatus) + '</span></td><td>' + statusPill(e.status, e.status) + '</td><td>' + esc(e.oracleStatus || '—') + '</td><td class="n">' + (e.durationMs !== undefined ? e.durationMs + ' ms' : '—') + '</td><td>' + esc(e.version || '—') + '</td></tr>'; }).join('') + '</tbody></table></div>' : '<div class="empty">' + esc(detail.executionsNote || T.empty) + '</div>') + '</div>';
    html += '<div><h3>' + esc(T.decision) + '</h3>' + (item.review ? statusPill(item.review.status, T.reviewLabels[item.review.status]) + ' · ' + fmtDate(item.review.at) + (item.review.note ? '<br>' + esc(item.review.note) : '') : '<span style="color:var(--muted)">' + esc(T.decisionNone) + '</span>') + '<p class="hint" style="margin-top:8px">' + esc(T.decisionHint) + '</p>';
    if (!READ_ONLY) {
      html += '<div class="field"><label for="d-note">' + esc(T.decisionNote) + '</label><textarea id="d-note" maxlength="2000"></textarea></div><div class="actions" style="margin-top:8px"><button type="button" class="btn ok" data-decision="VALIDATE">' + esc(T.validate) + '</button><button type="button" class="btn danger" data-decision="INVALIDATE">' + esc(T.invalidate) + '</button>' + (item.review ? '<button type="button" class="btn" data-decision="RESET">' + esc(T.reset) + '</button>' : '') + '</div>';
    } else html += '<div class="warnbox">' + esc(T.persistence.readOnlyHint) + '</div>';
    html += '</div>';
    html += '<div><h3>' + esc(T.itemHistory) + '</h3>' + (detail.history.length ? '<ul class="list">' + detail.history.map(function (h) { return '<li><div class="t"><b>' + esc(h.operation) + '</b>' + (h.reason ? '<small>' + esc(h.reason) + '</small>' : '') + (h.after && h.after.note ? '<small>' + esc(h.after.note) + '</small>' : '') + '</div><span class="at">' + fmtDate(h.at) + '</span></li>'; }).join('') + '</ul>' : empty()) + '</div>';
    html += '<div><h3>' + esc(T.data) + '</h3><pre>' + esc(JSON.stringify(item.data, null, 2)) + '</pre></div>';
    openDrawer(item.title, html);
    $('drawer-body').querySelectorAll('[data-decision]').forEach(function (button) {
      button.addEventListener('click', function () {
        var operation = button.dataset.decision;
        var proceed = operation === 'VALIDATE' ? Promise.resolve(true) : confirmDialog(operation === 'INVALIDATE' ? T.confirmInvalidate : T.confirmReset);
        proceed.then(function (ok) {
          if (!ok) return;
          var note = $('d-note') ? $('d-note').value.trim() : '';
          button.disabled = true;
          api(appPath('/items/' + encodeURIComponent(item.id) + '/decision'), { body: { operation: operation, expectedVersion: item.review ? item.review.version : 0, note: note || undefined } })
            .then(function (result) { toast(T.decision + ' : ' + (result.item.review ? T.reviewLabels[result.item.review.status] : T.reviewNone)); openItem_(item.id); if (state.view === 'explorer') loadResults(); })
            .catch(function (error) { button.disabled = false; toast(error.message, true); if (error.status === 409) openItem_(item.id); });
        });
      });
    });
  }

  /* ───────── flows ───────── */
  function renderFlows(params) {
    state.flowsTab = params.tab || state.flowsTab || 'flows';
    content.innerHTML = loading();
    api(appPath('/flows')).then(function (f) {
      var html = warningsBox(f.warnings);
      html += '<div class="panel"><div class="tabs" role="tablist">' + Object.keys(T.flowsTabs).map(function (tab) { return '<button type="button" role="tab" data-tab="' + tab + '" aria-selected="' + (tab === state.flowsTab) + '">' + esc(T.flowsTabs[tab]) + ' <span class="count">' + (tab === 'graph' ? '' : fmtNum((f[tab] || []).length)) + '</span></button>'; }).join('') + '</div><div id="flows-body"></div></div>';
      content.innerHTML = html;
      var body = $('flows-body');
      var show = function () {
        document.querySelectorAll('[data-tab]').forEach(function (b) { b.setAttribute('aria-selected', String(b.dataset.tab === state.flowsTab)); });
        var tab = state.flowsTab;
        if (tab === 'flows') body.innerHTML = f.flows.length ? '<div class="tablewrap"><table><thead><tr><th>' + esc(T.flowCols.name) + '</th><th>' + esc(T.flowCols.source) + '</th><th>' + esc(T.flowCols.steps) + '</th><th>' + esc(T.flowCols.lastRun) + '</th><th>' + esc(T.flowCols.produces) + '</th><th>' + esc(T.flowCols.consumes) + '</th></tr></thead><tbody>' + f.flows.map(function (flow) { return '<tr><td class="w"><b>' + esc(flow.name) + '</b>' + (flow.location ? '<br><code>' + esc(flow.location) + '</code>' : '') + '</td><td>' + esc(T.sourceLabels[flow.source] || flow.source) + '</td><td class="n">' + flow.steps + '</td><td>' + (flow.lastRun ? statusPill(flow.lastRun.status, flow.lastRun.status) + ' ' + fmtDate(flow.lastRun.at) + ' · ' + flow.lastRun.durationMs + ' ms' : '—') + '</td><td>' + flow.produces.map(function (v) { return '<code>' + esc(v) + '</code>'; }).join(' ') + '</td><td>' + flow.consumes.map(function (v) { return '<code>' + esc(v) + '</code>'; }).join(' ') + '</td></tr>'; }).join('') + '</tbody></table></div>' : empty();
        else if (tab === 'runs') body.innerHTML = f.runs.length ? '<div class="tablewrap"><table><thead><tr><th>' + esc(T.runCols.started) + '</th><th>' + esc(T.runCols.mission) + '</th><th>' + esc(T.runCols.mode) + '</th><th>' + esc(T.runCols.status) + '</th><th>' + esc(T.runCols.states) + '</th><th>' + esc(T.runCols.actions) + '</th><th>' + esc(T.runCols.transitions) + '</th><th>' + esc(T.runCols.anomalies) + '</th><th>' + esc(T.runCols.version) + '</th></tr></thead><tbody>' + f.runs.map(function (r) { return '<tr><td style="white-space:nowrap">' + fmtDate(r.startedAt) + '<br><code>' + esc(r.id.slice(0, 8)) + '</code></td><td>' + esc(r.missionName) + '</td><td>' + esc(r.mode) + '</td><td>' + statusPill(r.status, r.status) + '</td><td class="n">' + r.statesCount + '</td><td class="n">' + r.actionsCount + '</td><td class="n">' + r.transitionsCount + '</td><td class="n">' + r.anomaliesCount + '</td><td>' + esc(r.commitSha || r.crawlerVersion || '—') + '</td></tr>'; }).join('') + '</tbody></table></div>' : empty();
        else if (tab === 'states') body.innerHTML = f.states.length ? '<div class="tablewrap"><table><thead><tr><th>' + esc(T.stateCols.signature) + '</th><th>' + esc(T.stateCols.outgoing) + '</th><th>' + esc(T.stateCols.incoming) + '</th><th>' + esc(T.stateCols.lastSeen) + '</th></tr></thead><tbody>' + f.states.map(function (s) { return '<tr><td class="w"><code>' + esc(s.signature) + '</code></td><td class="n">' + s.outgoing + '</td><td class="n">' + s.incoming + '</td><td>' + fmtDate(s.lastSeenAt) + '</td></tr>'; }).join('') + '</tbody></table></div>' : empty();
        else if (tab === 'transitions') body.innerHTML = f.transitions.length ? '<div class="tablewrap"><table><thead><tr><th>' + esc(T.transitionCols.from) + '</th><th>' + esc(T.transitionCols.action) + '</th><th>' + esc(T.transitionCols.to) + '</th><th>' + esc(T.transitionCols.seen) + '</th><th>' + esc(T.transitionCols.successes) + '</th><th>' + esc(T.transitionCols.failures) + '</th><th>' + esc(T.transitionCols.blocked) + '</th><th>' + esc(T.transitionCols.status) + '</th></tr></thead><tbody>' + f.transitions.map(function (t) { return '<tr class="row" tabindex="0" data-id="' + esc(t.id.split(':')[0]) + '"><td><code>' + esc(t.from) + '</code></td><td class="w">' + esc(t.action) + '</td><td><code>' + esc(t.to) + '</code></td><td class="n">' + t.seen + '</td><td class="n">' + t.successes + '</td><td class="n">' + t.failures + '</td><td class="n">' + t.blocked + '</td><td>' + statusPill(t.status) + '</td></tr>'; }).join('') + '</tbody></table></div>' : empty();
        else renderGraph(body);
        body.querySelectorAll('tr.row').forEach(function (row) { row.addEventListener('click', function () { openItem_(row.dataset.id); }); row.addEventListener('keydown', function (event) { if (event.key === 'Enter') openItem_(row.dataset.id); }); });
      };
      content.querySelectorAll('[data-tab]').forEach(function (button) { button.addEventListener('click', function () { state.flowsTab = button.dataset.tab; show(); }); });
      show();
    }).catch(function (error) { content.innerHTML = errorBox(error, true); });
  }
  function renderGraph(body) {
    body.innerHTML = '<p class="hint">' + esc(T.graphHint) + '</p><div class="graph" id="graph">' + loading() + '</div><div class="legend">' + ['CONFIRMED', 'OBSERVED', 'FRAGILE', 'CONTRADICTED', 'STALE', 'UNVERIFIED'].map(function (s) { return '<span><i class="edge ' + s + '" style="background:' + edgeColor(s) + '"></i>' + esc(T.statusLabels[s]) + '</span>'; }).join('') + '</div>';
    api(appPath('/graph')).then(function (g) {
      var box = $('graph');
      if (!g.nodes.length) { box.innerHTML = empty(); return; }
      var cols = Math.max(1, Math.ceil(Math.sqrt(g.nodes.length)));
      var W = 220, H = 90, PAD = 40;
      var pos = {};
      g.nodes.forEach(function (n, i) { pos[n.id] = { x: PAD + (i % cols) * W, y: PAD + Math.floor(i / cols) * H }; });
      var width = PAD * 2 + cols * W, height = PAD * 2 + Math.ceil(g.nodes.length / cols) * H;
      var svg = '<svg viewBox="0 0 ' + width + ' ' + height + '" role="img"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="currentColor"/></marker></defs>';
      g.edges.forEach(function (e) {
        var a = pos[e.from], b = pos[e.to];
        if (!a || !b) return;
        var x1 = a.x + 80, y1 = a.y + 18, x2 = b.x + 80, y2 = b.y + 18;
        var dx = x2 - x1, dy = y2 - y1;
        var cx = x1 + dx / 2 - dy * 0.2, cy = y1 + dy / 2 + dx * 0.2;
        if (e.from === e.to) { cx = x1 + 60; cy = y1 - 50; x2 = x1 + 10; }
        svg += '<path class="edge ' + esc(e.status) + '" d="M' + x1 + ' ' + y1 + ' Q' + cx + ' ' + cy + ' ' + x2 + ' ' + y2 + '" marker-end="url(#arrow)" data-id="' + esc(e.id.split(':')[0]) + '" tabindex="0" style="color:' + edgeColor(e.status) + '"><title>' + esc(e.label + ' (' + e.seen + ')') + '</title></path>';
      });
      g.nodes.forEach(function (n) {
        var p = pos[n.id];
        var raw = n.kind === 'none' ? T.graphNone : n.label;
        var label = raw.length > 26 ? raw.slice(0, 25) + '…' : raw;
        svg += '<g class="node ' + (n.kind === 'none' ? 'none' : '') + '" transform="translate(' + p.x + ',' + p.y + ')"><rect width="160" height="36" rx="9"/><text x="10" y="22">' + esc(label) + '</text><title>' + esc(n.id + ' · ' + n.outgoing + ' → · ← ' + n.incoming) + '</title></g>';
      });
      svg += '</svg>';
      box.innerHTML = svg + (g.truncated ? '<p class="hint">' + esc(T.graphTruncated) + '</p>' : '');
      box.querySelectorAll('.edge').forEach(function (edge) { edge.addEventListener('click', function () { openItem_(edge.dataset.id); }); edge.addEventListener('keydown', function (event) { if (event.key === 'Enter') openItem_(edge.dataset.id); }); });
      box.querySelectorAll('.node').forEach(function (node) { node.addEventListener('click', function () { navigate('explorer', { text: node.querySelector('title').textContent.split(' · ')[0], type: 'TRANSITION' }); }); });
      enablePanZoom(box.querySelector('svg'), width, height);
    }).catch(function (error) { $('graph').innerHTML = errorBox(error); });
  }
  function edgeColor(status) { return { CONFIRMED: 'var(--ok)', OBSERVED: 'var(--blue)', FRAGILE: 'var(--warn)', STALE: 'var(--warn)', CONTRADICTED: 'var(--red)' }[status] || 'var(--link)'; }
  function enablePanZoom(svg, width, height) {
    var view = { x: 0, y: 0, w: width, h: height };
    var apply = function () { svg.setAttribute('viewBox', view.x + ' ' + view.y + ' ' + view.w + ' ' + view.h); };
    svg.addEventListener('wheel', function (event) { event.preventDefault(); var k = event.deltaY > 0 ? 1.1 : 0.9; view.w *= k; view.h *= k; apply(); }, { passive: false });
    var drag = null;
    svg.addEventListener('pointerdown', function (event) { drag = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y }; });
    window.addEventListener('pointermove', function (event) { if (!drag) return; var scale = view.w / svg.clientWidth; view.x = drag.vx - (event.clientX - drag.x) * scale; view.y = drag.vy - (event.clientY - drag.y) * scale; apply(); });
    window.addEventListener('pointerup', function () { drag = null; });
  }

  /* ───────── variables ───────── */
  function renderVariables(params) {
    state.issue = params.issue || '';
    content.innerHTML = loading();
    api(appPath('/variables')).then(function (v) {
      var html = warningsBox(v.warnings) + '<p class="hint">' + esc(T.variablesHint) + '</p>';
      if (v.unavailable) { content.innerHTML = html + empty(T.variablesNone); return; }
      html += '<div class="cards">' + Object.keys(T.issueLabels).map(function (k) { return '<a class="card" href="#/variables?issue=' + k + '" style="text-decoration:none;color:inherit"><div class="label">' + esc(T.issueLabels[k]) + '</div><div class="value' + (v.issues[k] ? '' : ' na') + '">' + fmtNum(v.issues[k] || 0) + '</div></a>'; }).join('') + '</div>';
      var rows = v.variables.filter(function (x) { return !state.issue || x.issues.some(function (i) { return i.kind === state.issue; }); });
      html += '<div class="toolbar">' + selectHtml('v-issue', T.issuesFilter, Object.keys(T.issueLabels).map(function (k) { return { value: k, label: T.issueLabels[k] }; }), state.issue) + '<span class="chip">' + fmtNum(rows.length) + ' / ' + fmtNum(v.variables.length) + '</span></div>';
      html += rows.length ? '<div class="tablewrap"><table><thead><tr><th>' + esc(T.variableCols.key) + '</th><th>' + esc(T.variableCols.flow) + '</th><th>' + esc(T.variableCols.strategy) + '</th><th>' + esc(T.variableCols.producedBy) + '</th><th>' + esc(T.variableCols.usedBy) + '</th><th>' + esc(T.variableCols.mappings) + '</th><th>' + esc(T.variableCols.issues) + '</th></tr></thead><tbody>' + rows.map(function (x) {
        return '<tr><td><code>' + esc(x.key) + '</code>' + (x.sensitive ? '<br><small>' + esc(T.sensitive) + '</small>' : x.value !== undefined ? '<br><small>' + esc(T.value) + ' : ' + esc(x.value) + '</small>' : '') + (x.humanBinding ? '<br><small>' + esc(T.humanBinding) + ' : ' + esc(x.humanBinding.source) + ' → ' + esc(x.humanBinding.variable) + '</small>' : '') + '</td><td>' + esc(x.flow) + '</td><td><span class="tag">' + esc(x.strategy) + '</span>' + (x.generator ? ' <small>' + esc(x.generator) + '</small>' : '') + '</td><td class="w">' + (x.producedBy ? esc(x.producedBy.stepIndex + ' — ' + x.producedBy.label) : '—') + '</td><td class="w">' + (x.usedBy.length ? x.usedBy.map(function (u) { return esc(u.stepIndex + ' — ' + u.label) + ' <small>(' + esc(u.how.toLowerCase()) + ')</small>'; }).join('<br>') : '—') + '</td><td class="w">' + (x.mappings.length ? x.mappings.map(function (m) { return '<code>' + esc(m.uiLabel) + '</code> ↔ <code>' + esc(m.property) + '</code> <small>' + esc(m.api) + ' · ' + esc(m.transformation) + ' · ' + m.confirmations + '×</small>'; }).join('<br>') : '—') + '</td><td>' + (x.issues.length ? x.issues.map(function (i) { return '<span class="st FRAGILE" title="' + esc(i.message) + '">' + esc(T.issueLabels[i.kind]) + '</span><br><small>' + esc(i.message) + '</small>'; }).join('<br>') : '—') + '</td></tr>';
      }).join('') + '</tbody></table></div>' : empty();
      content.innerHTML = html;
      $('v-issue').addEventListener('change', function (event) { navigate('variables', { issue: event.target.value }); });
    }).catch(function (error) { content.innerHTML = errorBox(error, true); });
  }

  /* ───────── qualité ───────── */
  function itemsTable(items) {
    if (!items.length) return empty();
    return '<div class="tablewrap"><table><thead><tr><th>' + esc(T.columns.title) + '</th><th>' + esc(T.columns.type) + '</th><th>' + esc(T.columns.evidence) + '</th><th>' + esc(T.columns.updatedAt) + '</th><th>' + esc(T.columns.review) + '</th></tr></thead><tbody>' + items.map(function (item) { return '<tr class="row" tabindex="0" data-id="' + esc(item.id) + '"><td class="w"><b>' + esc(item.title) + '</b><br><small style="color:var(--muted)">' + esc(item.reliability.reasons.join('; ')) + '</small></td><td><span class="tag">' + esc(item.type) + '</span></td><td>' + esc(evidenceText(item.evidence)) + '</td><td style="white-space:nowrap">' + fmtDate(item.updatedAt || item.createdAt) + '</td><td>' + (item.review ? statusPill(item.review.status, T.reviewLabels[item.review.status]) : '') + '</td></tr>'; }).join('') + '</tbody></table></div>';
  }
  function bindRows(root) {
    root.querySelectorAll('tr.row').forEach(function (row) { row.addEventListener('click', function () { openItem_(row.dataset.id); }); row.addEventListener('keydown', function (event) { if (event.key === 'Enter') openItem_(row.dataset.id); }); });
  }
  function renderQuality() {
    content.innerHTML = loading();
    api(appPath('/quality')).then(function (q) {
      var html = '<p class="hint">' + esc(T.qualityHint) + '</p>';
      html += '<div class="cards">' + q.categories.map(function (c) { return '<a class="card" href="#/explorer?status=' + c.status + '" style="text-decoration:none;color:inherit"><div class="label">' + esc(c.label) + '</div><div class="value' + (c.total ? '' : ' na') + '">' + fmtNum(c.total) + '</div><div class="formula">' + esc(c.definition) + '</div></a>'; }).join('') + '</div>';
      html += '<div class="panel"><h2>' + esc(T.signals) + '</h2>' + q.signals.map(function (s) { return '<details' + (s.total ? ' open' : '') + '><summary style="cursor:pointer;font-weight:600;padding:6px 0">' + esc(s.title) + ' <span class="count">' + fmtNum(s.total) + '</span><br><small style="color:var(--muted);font-weight:400">' + esc(s.definition) + '</small></summary>' + itemsTable(s.items) + '</details>'; }).join('') + '</div>';
      html += '<div class="panel"><h2>' + esc(T.categories) + '</h2>' + q.categories.filter(function (c) { return c.total && c.status !== 'CONFIRMED' && c.status !== 'OBSERVED'; }).map(function (c) { return '<details open><summary style="cursor:pointer;font-weight:600;padding:6px 0">' + esc(c.label) + ' <span class="count">' + fmtNum(c.total) + '</span> <a href="#/explorer?status=' + c.status + '" style="font-weight:400;font-size:12px">' + esc(T.showAll) + '</a></summary>' + itemsTable(c.items) + '</details>'; }).join('') + '</div>';
      content.innerHTML = html;
      bindRows(content);
    }).catch(function (error) { content.innerHTML = errorBox(error, true); });
  }

  function ledgerDetails(e) {
    var d = e.details;
    if (!d) return '—';
    var parts = [];
    if (d.targetApplicationId) parts.push(T.ledgerSummary.target + ' ' + esc(d.targetApplicationId));
    if (d.backup) parts.push(T.ledgerSummary.backup + ' <code>' + esc(d.backup) + '</code>');
    if (d.id && e.operation === 'BACKUP') parts.push('<code>' + esc(d.id) + '</code>' + (d.bytes ? ' · ' + fmtNum(d.bytes) + ' B' : ''));
    if (Array.isArray(d.sections)) parts.push(d.sections.map(function (s) { return esc(s.section) + ' +' + s.added + ' ~' + s.replaced + ' −' + s.skipped; }).join(', '));
    if (!parts.length) parts.push('<code>' + esc(JSON.stringify(d).slice(0, 160)) + '</code>');
    return parts.join('<br>');
  }

  /* ───────── historique ───────── */
  function renderHistory(params) {
    state.historyTab = params.tab || state.historyTab || 'ledger';
    content.innerHTML = loading();
    api(appPath('/history')).then(function (h) {
      var html = '<div class="panel"><div class="tabs" role="tablist">' + Object.keys(T.historyTabs).map(function (tab) { return '<button type="button" role="tab" data-tab="' + tab + '" aria-selected="' + (tab === state.historyTab) + '">' + esc(T.historyTabs[tab]) + ' <span class="count">' + fmtNum(tab === 'ledger' ? h.total : h.learning.length) + '</span></button>'; }).join('') + '</div><div id="history-body"></div></div>';
      content.innerHTML = html;
      var show = function () {
        document.querySelectorAll('[data-tab]').forEach(function (b) { b.setAttribute('aria-selected', String(b.dataset.tab === state.historyTab)); });
        var body = $('history-body');
        if (state.historyTab === 'ledger') body.innerHTML = h.entries.length ? '<div class="tablewrap"><table><thead><tr><th>' + esc(T.ledgerCols.at) + '</th><th>' + esc(T.ledgerCols.operation) + '</th><th>' + esc(T.ledgerCols.item) + '</th><th>' + esc(T.ledgerCols.before) + '</th><th>' + esc(T.ledgerCols.after) + '</th><th>' + esc(T.ledgerCols.reason) + '</th><th>' + esc(T.ledgerCols.errors) + '</th></tr></thead><tbody>' + h.entries.map(function (e) { return '<tr><td style="white-space:nowrap">' + fmtDate(e.at) + '</td><td><span class="tag">' + esc(e.operation) + '</span></td><td class="w">' + (e.itemId ? '<a href="#/explorer?item=' + encodeURIComponent(e.itemId) + '">' + esc(e.itemTitle || e.itemId) + '</a>' : ledgerDetails(e)) + '</td><td>' + (e.before ? statusPill(e.before.status, T.reviewLabels[e.before.status] + ' v' + e.before.version) : '—') + '</td><td>' + (e.after ? statusPill(e.after.status, T.reviewLabels[e.after.status] + ' v' + e.after.version) + (e.after.note ? '<br><small>' + esc(e.after.note) + '</small>' : '') : '—') + '</td><td class="w">' + esc(e.reason || '') + '</td><td class="w">' + (e.errors ? e.errors.map(function (x) { return '<span class="st CONTRADICTED">' + esc(x) + '</span>'; }).join('<br>') : '') + '</td></tr>'; }).join('') + '</tbody></table></div>' : empty();
        else body.innerHTML = h.learning.length ? '<div class="tablewrap"><table><thead><tr><th>' + esc(T.learningCols.at) + '</th><th>' + esc(T.learningCols.type) + '</th><th>' + esc(T.learningCols.title) + '</th><th>' + esc(T.learningCols.detail) + '</th><th>' + esc(T.learningCols.status) + '</th></tr></thead><tbody>' + h.learning.map(function (e) { return '<tr><td style="white-space:nowrap">' + fmtDate(e.at) + '</td><td><span class="tag">' + esc(e.type) + '</span></td><td class="w">' + (e.type === 'RUN' ? esc(e.title) : itemLink(e)) + '</td><td class="w">' + esc(e.detail || '') + '</td><td>' + (e.status ? statusPill(e.status, T.statusLabels[e.status] || e.status) : '') + '</td></tr>'; }).join('') + '</tbody></table></div>' : empty();
      };
      content.querySelectorAll('[data-tab]').forEach(function (button) { button.addEventListener('click', function () { state.historyTab = button.dataset.tab; show(); }); });
      show();
    }).catch(function (error) { content.innerHTML = errorBox(error, true); });
  }

  /* ───────── persistance ───────── */
  function renderPersistence() {
    content.innerHTML = loading();
    Promise.all([api(appPath('/persistence')), api('/backups')]).then(function (results) {
      var p = results[0], backups = results[1].backups, mem = state.meta.memory, P = T.persistence;
      var html = '';
      if (READ_ONLY) html += '<div class="warnbox">' + esc(P.readOnlyHint) + '</div>';
      html += '<div class="grid2">';
      html += '<div class="panel"><h2>' + esc(P.state) + ' ' + statusPill(p.status, p.status) + '</h2>' + (p.enabled ? '<dl class="kv"><dt>' + esc(P.configured) + '</dt><dd>' + esc(p.configured ? (p.configured.database || p.configured.provider) : '—') + '</dd><dt>' + esc(P.actual) + '</dt><dd>' + esc(p.actual ? (p.actual.database || p.actual.provider) + (p.actual.location ? ' · ' + p.actual.location : '') : '—') + '</dd>' + (p.reason ? '<dt>' + esc(P.reason) + '</dt><dd>' + esc(p.reason) + '</dd>' : '') + '<dt>' + esc(P.health) + '</dt><dd>' + (p.health ? statusPill(p.health.status, p.health.status) + (p.health.latencyMs !== undefined ? ' · ' + p.health.latencyMs + ' ms' : '') + (p.health.detail ? ' · ' + esc(p.health.detail) : '') + ' · ' + fmtDate(p.health.checkedAt) : '—') + '</dd><dt>' + esc(P.schema) + '</dt><dd>' + esc(p.schemaVersion !== undefined ? p.schemaVersion : T.unavailable) + '</dd><dt>' + esc(P.lastWrite) + '</dt><dd>' + (p.lastWriteAt ? fmtDate(p.lastWriteAt) : esc(T.unavailable)) + '</dd><dt>' + esc(P.lastBackup) + '</dt><dd>' + (p.lastBackupAt ? fmtDate(p.lastBackupAt) : '—') + '</dd><dt>' + esc(P.lastRestore) + '</dt><dd>' + (p.lastRestoreAt ? fmtDate(p.lastRestoreAt) : '—') + '</dd></dl>' : '<div class="warnbox">' + esc(P.disabled) + '</div>') + '</div>';
      html += '<div class="panel"><h2>' + esc(P.memory) + '</h2><dl class="kv"><dt>' + esc(P.memoryFields.mode) + '</dt><dd>' + esc(T.memoryMode[mem.mode]) + '</dd><dt>' + esc(P.memoryFields.enabled) + '</dt><dd>' + esc(mem.memoryEnabled === undefined ? P.notSet : (mem.memoryEnabled ? T.yes : T.no)) + '</dd><dt>' + esc(P.memoryFields.historical) + '</dt><dd>' + esc(mem.historicalKnowledge ? T.yes : T.no) + '</dd><dt>' + esc(P.memoryFields.preload) + '</dt><dd>' + mem.preload.maxStates + ' states · ' + mem.preload.maxTransitions + ' transitions</dd><dt>' + esc(P.memoryFields.file) + '</dt><dd><code>' + esc(mem.knowledgeFile || '') + '</code></dd><dt>' + esc(P.memoryFields.fileEnabled) + '</dt><dd>' + esc(mem.knowledgeFileEnabled ? T.yes : T.no) + '</dd></dl></div>';
      html += '<div class="panel"><h2>' + esc(P.counts) + '</h2>' + (p.counts ? '<dl class="kv">' + Object.keys(p.counts).map(function (k) { return '<dt>' + esc(k) + '</dt><dd>' + fmtNum(p.counts[k]) + '</dd>'; }).join('') + '</dl>' : empty(T.unavailable)) + '</div>';
      html += '<div class="panel"><h2>' + esc(P.providers) + '</h2><ul class="list">' + p.providers.map(function (x) { return '<li><div class="t">' + esc(x.label) + (x.note ? '<small>' + esc(x.note) + '</small>' : '') + '</div>' + statusPill(x.available ? 'CONFIRMED' : 'none', x.available ? P.available : P.planned) + '</li>'; }).join('') + '</ul></div>';
      html += '<div class="panel"><h2>' + esc(P.errors) + '</h2>' + (p.recentErrors.length ? '<ul class="list">' + p.recentErrors.map(function (e) { return '<li><div class="t"><b>' + esc(e.operation) + '</b><small>' + esc(e.message) + '</small></div><span class="at">' + fmtDate(e.at) + '</span></li>'; }).join('') + '</ul>' : empty()) + '</div>';
      html += '<div class="panel"><h2>' + esc(P.backups) + '</h2><div class="actions" style="margin-bottom:10px"><button type="button" class="btn p" id="backup-btn"' + (READ_ONLY ? ' disabled' : '') + '>' + esc(P.backupBtn) + '</button></div>' + (backups.length ? '<ul class="list">' + backups.map(function (b) { return '<li><div class="t"><code>' + esc(b.id) + '</code><small>' + esc(b.applicationId) + ' · ' + fmtNum(b.bytes) + ' B</small></div><button type="button" class="btn sm danger" data-restore="' + esc(b.id) + '"' + (READ_ONLY ? ' disabled' : '') + '>' + esc(P.restoreBtn) + '</button></li>'; }).join('') + '</ul>' : empty(P.noBackup)) + '</div>';
      html += '<div class="panel"><h2>' + esc(P.exchange) + '</h2><div class="actions"><a class="btn" href="' + '/api' + appPath('/export') + '" download>' + esc(P.exportBtn) + '</a><label class="btn"' + (READ_ONLY ? ' aria-disabled="true"' : '') + '>' + esc(P.importBtn) + '<input type="file" id="import-file" accept="application/json,.json" class="vis"' + (READ_ONLY ? ' disabled' : '') + '></label></div><div id="import-area" style="margin-top:12px"></div></div>';
      html += '</div>';
      content.innerHTML = html;
      $('backup-btn').addEventListener('click', function () {
        $('backup-btn').disabled = true;
        api(appPath('/backups'), { body: {} }).then(function (b) { toast(P.backupDone + ' : ' + b.id); renderPersistence(); }).catch(function (error) { toast(error.message, true); $('backup-btn').disabled = false; });
      });
      content.querySelectorAll('[data-restore]').forEach(function (button) {
        button.addEventListener('click', function () {
          confirmDialog(P.confirmRestore).then(function (ok) {
            if (!ok) return;
            button.disabled = true;
            api('/backups/' + encodeURIComponent(button.dataset.restore) + '/restore', { body: {} }).then(function (result) { showResult(P.restored, result); }).catch(function (error) { toast(error.message, true); button.disabled = false; });
          });
        });
      });
      $('import-file').addEventListener('change', function (event) {
        var file = event.target.files[0];
        if (!file) return;
        var reader = new FileReader();
        reader.onload = function () {
          var document_;
          try { document_ = JSON.parse(String(reader.result)); } catch (e) { toast('invalid JSON', true); return; }
          importPreview(document_);
        };
        reader.readAsText(file);
      });
    }).catch(function (error) { content.innerHTML = errorBox(error, true); });
  }
  function policyFromForm() {
    return { replaceable: $('pol-replaceable').value, files: $('pol-files').value, backupFirst: $('pol-backup').checked };
  }
  function importPreview(document_) {
    var P = T.persistence;
    var area = $('import-area');
    area.innerHTML = '<div class="toolbar"><div class="field"><label for="pol-replaceable">' + esc(P.policyReplaceable) + '</label><select class="sel" id="pol-replaceable"><option value="skip">' + esc(P.skip) + '</option><option value="replace">' + esc(P.replace) + '</option></select></div><div class="field"><label for="pol-files">' + esc(P.policyFiles) + '</label><select class="sel" id="pol-files"><option value="skip">' + esc(P.skip) + '</option><option value="replace">' + esc(P.replace) + '</option></select></div><label class="field" style="flex-direction:row;align-items:center;gap:8px"><input type="checkbox" id="pol-backup" checked> ' + esc(P.backupFirst) + '</label></div><div id="preview">' + loading() + '</div>';
    var refresh = function () {
      $('preview').innerHTML = loading();
      api(appPath('/import/preview'), { body: { document: document_, policy: policyFromForm() } }).then(function (preview) {
        var html = '<h3 style="margin-top:12px">' + esc(P.preview) + ' — ' + esc(preview.application.id) + ' · ' + fmtDate(document_.exportedAt) + '</h3>';
        if (preview.problems.length) html += '<div class="warnbox">' + preview.problems.map(esc).join('<br>') + '</div>';
        html += '<div class="tablewrap"><table><thead><tr>' + ['section', 'total', 'added', 'identical', 'conflicts', 'skipped', 'onConflict'].map(function (c) { return '<th>' + esc(P.previewCols[c]) + '</th>'; }).join('') + '</tr></thead><tbody>' + preview.sections.map(function (s) { return '<tr><td><b>' + esc(s.section) + '</b>' + (s.note ? '<br><small style="color:var(--muted)">' + esc(s.note) + '</small>' : '') + (s.samples.length ? '<br><small>' + s.samples.map(function (x) { return '<code>' + esc(x) + '</code>'; }).join(' ') + '</small>' : '') + '</td><td class="n">' + s.total + '</td><td class="n">' + s.added + '</td><td class="n">' + s.identical + '</td><td class="n">' + s.conflicts + '</td><td class="n">' + s.skipped + '</td><td>' + esc(s.onConflict) + '</td></tr>'; }).join('') + '</tbody></table></div>';
        html += '<div class="actions" style="margin-top:10px"><button type="button" class="btn p" id="apply-btn">' + esc(P.applyBtn) + '</button></div>';
        $('preview').innerHTML = html;
        $('apply-btn').addEventListener('click', function () {
          confirmDialog(P.confirmApply).then(function (ok) {
            if (!ok) return;
            $('apply-btn').disabled = true;
            api(appPath('/import/apply'), { body: { document: document_, policy: policyFromForm() } }).then(function (result) { showResult(P.imported, result); }).catch(function (error) { toast(error.message, true); $('apply-btn').disabled = false; });
          });
        });
      }).catch(function (error) { $('preview').innerHTML = errorBox(error); });
    };
    ['pol-replaceable', 'pol-files', 'pol-backup'].forEach(function (id) { $(id).addEventListener('change', refresh); });
    refresh();
  }
  function showResult(title, result) {
    var P = T.persistence;
    var html = '<div class="' + (result.errors.length ? 'warnbox' : 'okbox') + '"><b>' + esc(title) + '</b>' + (result.backup ? ' · ' + esc(P.lastBackup) + ' : <code>' + esc(result.backup.id) + '</code>' : '') + (result.restoredFrom ? ' · <code>' + esc(result.restoredFrom) + '</code>' : '') + '</div>';
    html += '<div class="tablewrap"><table><thead><tr>' + ['section', 'added', 'replaced', 'skipped', 'errors'].map(function (c) { return '<th>' + esc(P.resultCols[c]) + '</th>'; }).join('') + '</tr></thead><tbody>' + result.sections.map(function (s) { return '<tr><td><b>' + esc(s.section) + '</b></td><td class="n">' + s.added + '</td><td class="n">' + s.replaced + '</td><td class="n">' + s.skipped + '</td><td>' + (s.errors.length ? s.errors.map(function (e) { return '<span class="st CONTRADICTED">' + esc(e) + '</span>'; }).join('<br>') : '—') + '</td></tr>'; }).join('') + '</tbody></table></div>';
    openDrawer(title, html);
    api('/refresh', { body: {} }).catch(function () { return null; }).then(function () { renderPersistence(); });
  }

  loadMeta();
})();
`;
