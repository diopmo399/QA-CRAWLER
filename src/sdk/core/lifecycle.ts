import type { ExplorationCounters, ExplorationEvent, ExplorationStatus, Severity } from './contracts.js';

/**
 * LE CYCLE DE VIE d'une exploration : QUEUED → RUNNING → COMPLETED | FAILED. CANCELLED est
 * réservé (aucune transition n'y mène tant que le moteur n'a pas d'arrêt à la demande).
 */
const NEXT: Record<ExplorationStatus, readonly ExplorationStatus[]> = {
  QUEUED: ['RUNNING', 'FAILED'],
  RUNNING: ['COMPLETED', 'FAILED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

export function canTransition(from: ExplorationStatus, to: ExplorationStatus): boolean {
  return NEXT[from].includes(to);
}

export function isTerminal(status: ExplorationStatus): boolean {
  return NEXT[status].length === 0;
}

export function emptyCounters(): ExplorationCounters {
  return {
    states: 0,
    transitions: 0,
    actions: 0,
    blocked: 0,
    issues: { INFO: 0, WARNING: 0, ERROR: 0, CRITICAL: 0 },
  };
}

/**
 * Fait avancer les compteurs avec un événement du moteur. À la fin (`completed`), les chiffres du
 * résultat du moteur remplacent ceux des événements : ce sont eux qui font foi.
 */
export function applyEvent(counters: ExplorationCounters, event: ExplorationEvent): ExplorationCounters {
  switch (event.type) {
    case 'state':
      return { ...counters, states: counters.states + 1 };
    case 'transition':
      return {
        ...counters,
        actions: counters.actions + 1,
        transitions: counters.transitions + (event.changed ? 1 : 0),
      };
    case 'blocked':
      return { ...counters, blocked: counters.blocked + 1 };
    case 'issue':
      return {
        ...counters,
        issues: { ...counters.issues, [event.severity]: counters.issues[event.severity] + 1 },
      };
    case 'completed': {
      const stats = event.summary.stats;
      return {
        states: stats.states,
        transitions: stats.transitions,
        actions: stats.actionsExecuted,
        blocked: stats.actionsBlocked,
        issues: { ...stats.issuesBySeverity },
      };
    }
    default:
      return counters;
  }
}

export function totalIssues(issues: Record<Severity, number>): number {
  return issues.INFO + issues.WARNING + issues.ERROR + issues.CRITICAL;
}
