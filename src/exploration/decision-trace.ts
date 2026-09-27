import type { ScoreBreakdown } from '../decision/score-breakdown.js';

/** Un candidat tel que jugé lors d'une décision. */
export interface CandidateScore {
  stateId: string;
  actionId: string;
  label: string;
  score: number;
  breakdown?: ScoreBreakdown;
  /** Pourquoi il n'était pas proposable (déjà essayé, bloqué…). */
  excluded?: string;
}

/** Une décision du moteur, avec tous ses candidats et ses raisons. */
export interface DecisionTrace {
  at: string;
  stateId: string;
  strategy: string;
  candidates: CandidateScore[];
  selectedActionId?: string;
  /** L'état où se trouve l'action choisie (différent de stateId quand on change d'écran). */
  selectedStateId?: string;
  decision: 'EXECUTE' | 'BACKTRACK' | 'STOP';
  reasons: string[];
}

/**
 * Garde les décisions du run : les dernières (en mémoire, bornées) pour le fichier
 * decision-trace.json, et chaque action choisie avec sa décomposition pour le rapport
 * (« SELECTED ACTION Create User, Score 184, +70 goal relevance… »).
 */
export class DecisionTraceRecorder {
  private readonly traces: DecisionTrace[] = [];
  private readonly selected: {
    at: string;
    stateId: string;
    label: string;
    score: number;
    breakdown?: ScoreBreakdown;
  }[] = [];

  constructor(private readonly maxTraces = 2000) {}

  record(trace: DecisionTrace): void {
    this.traces.push(trace);
    if (this.traces.length > this.maxTraces) this.traces.shift();
    if (trace.decision === 'EXECUTE' && trace.selectedActionId) {
      const chosen = trace.candidates.find(
        (candidate) =>
          candidate.actionId === trace.selectedActionId &&
          candidate.stateId === (trace.selectedStateId ?? trace.stateId),
      );
      if (chosen)
        this.selected.push({
          at: trace.at,
          stateId: chosen.stateId,
          label: chosen.label,
          score: chosen.score,
          ...(chosen.breakdown ? { breakdown: chosen.breakdown } : {}),
        });
    }
  }

  all(): DecisionTrace[] {
    return [...this.traces];
  }

  /** Les actions choisies, dans l'ordre, avec leur décomposition. */
  selections(): { at: string; stateId: string; label: string; score: number; breakdown?: ScoreBreakdown }[] {
    return [...this.selected];
  }
}
