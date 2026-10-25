/** Les textes du Run Monitor. Aucun ne promet ce que le moteur ne fait pas. */
const fr = {
  dateLocale: 'fr-FR',
  title: 'Suivi de l’exécution',
  idle: 'Aucune exploration choisie.',
  loading: 'Connexion…',
  failed: 'Échec : ',
  status: {
    QUEUED: 'En attente',
    RUNNING: 'En cours',
    COMPLETED: 'Terminée',
    FAILED: 'Échouée',
    CANCELLED: 'Annulée',
  } as Record<string, string>,
  connection: {
    connecting: 'Connexion au flux…',
    live: 'En direct',
    reconnecting: (attempt: number) => `Reconnexion (tentative ${String(attempt)})…`,
    closed: 'Flux terminé',
    lost: 'Flux interrompu : les derniers événements peuvent manquer',
  },
  counters: {
    states: 'écrans',
    actions: 'actions',
    blocked: 'refusées',
    issues: 'anomalies',
    steps: 'étapes de flow',
  },
  flowsTitle: 'Flows imposés',
  noFlows: 'Aucun flow imposé n’a encore commencé.',
  running: 'en cours',
  show: 'Afficher',
  flow: 'Flow',
  stepStatus: 'Statut d’étape',
  type: 'Type d’événement',
  issueType: 'Type d’anomalie',
  all: 'Tous',
  shown: (shown: number, matching: number, total: number) =>
    matching === total
      ? `${String(shown)} sur ${String(total)} événements`
      : `${String(shown)} affichés, ${String(matching)} correspondent, ${String(total)} reçus`,
  noEvents: 'Aucun événement ne correspond.',
  groupsNote:
    'Les groupes métier d’un enregistrement ne sont pas portés par les événements d’exploration : le suivi se fait par flow et par étape.',
  types: {
    'flow-step': 'Étape',
    flow: 'Flow',
    state: 'Écran',
    transition: 'Action',
    blocked: 'Refus',
    issue: 'Anomalie',
    status: 'Statut',
  } as Record<string, string>,
  flowStart: 'commence',
  flowEnd: 'terminé',
  step: 'étape',
};

export type MonitorStrings = typeof fr;

const en: MonitorStrings = {
  dateLocale: 'en-GB',
  title: 'Run monitor',
  idle: 'No exploration selected.',
  loading: 'Connecting…',
  failed: 'Failed: ',
  status: {
    QUEUED: 'Queued',
    RUNNING: 'Running',
    COMPLETED: 'Completed',
    FAILED: 'Failed',
    CANCELLED: 'Cancelled',
  },
  connection: {
    connecting: 'Connecting to the stream…',
    live: 'Live',
    reconnecting: (attempt) => `Reconnecting (attempt ${String(attempt)})…`,
    closed: 'Stream ended',
    lost: 'Stream interrupted: the latest events may be missing',
  },
  counters: {
    states: 'screens',
    actions: 'actions',
    blocked: 'refused',
    issues: 'issues',
    steps: 'flow steps',
  },
  flowsTitle: 'Imposed flows',
  noFlows: 'No imposed flow has started yet.',
  running: 'running',
  show: 'Show',
  flow: 'Flow',
  stepStatus: 'Step status',
  type: 'Event type',
  issueType: 'Issue type',
  all: 'All',
  shown: (shown, matching, total) =>
    matching === total
      ? `${String(shown)} of ${String(total)} events`
      : `${String(shown)} shown, ${String(matching)} matching, ${String(total)} received`,
  noEvents: 'No event matches.',
  groupsNote:
    'The business groups of a recording are not carried by exploration events: the monitor follows flows and steps.',
  types: {
    'flow-step': 'Step',
    flow: 'Flow',
    state: 'Screen',
    transition: 'Action',
    blocked: 'Refused',
    issue: 'Issue',
    status: 'Status',
  },
  flowStart: 'starts',
  flowEnd: 'ended',
  step: 'step',
};

export function monitorStrings(locale: string | null | undefined): MonitorStrings {
  return (locale ?? '').toLowerCase().startsWith('en') ? en : fr;
}
