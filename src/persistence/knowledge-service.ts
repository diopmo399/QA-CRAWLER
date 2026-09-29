import type { HistoricalTransitionRecord } from '../knowledge/json-knowledge-base.js';
import type { ObservedKnowledgeContext, TransitionKnowledge } from '../knowledge/knowledge-model.js';
import { fit, knowledgeKey, LIMITS, NO_TARGET, type TransitionObservation } from './model.js';
import type { KnowledgeRepository } from './persistence-provider.js';

/**
 * MÉMOIRE DE TRAVAIL : ce dont le run courant a besoin, en RAM. C'est la KnowledgeBase du
 * moteur (JsonKnowledgeBase) : le DecisionEngine, le scorer et l'oracle historique la lisent
 * de façon synchrone — jamais une requête SQL par bouton comparé.
 */
export interface WorkingMemory {
  importHistory(records: readonly HistoricalTransitionRecord[]): void;
  getTransitionKnowledge(
    fromStateSignature: string,
    actionSignature: string,
  ): TransitionKnowledge | undefined;
}

/** Où mène, historiquement, une action depuis un écran : des observations, pas une vérité métier. */
export interface TransitionDistribution {
  executions: number;
  targets: { stateSignature: string; count: number; probability: number }[];
}

export interface PreloadBudget {
  maxStates: number;
  maxTransitions: number;
}

export interface KnowledgeStats {
  historicalStatesLoaded: number;
  historicalTransitionsLoaded: number;
  newStatesLearned: number;
  newTransitionsLearned: number;
}

/** Une transition observée pendant le run. */
export interface ObservedTransition {
  fromStateSignature: string;
  actionSignature: string;
  /** Absent : aucun nouvel état (bloquée, échouée). */
  toStateSignature?: string;
  result: 'SUCCESS' | 'FAILED' | 'BLOCKED';
  durationMs?: number;
  at: string;
}

/**
 * KnowledgeService : entre la mémoire de travail (RAM) et la mémoire long terme (le
 * KnowledgeRepository du provider).
 *
 *   préchargement : KnowledgeRepository → (budget) → mémoire de travail → DecisionEngine
 *   pendant le run : observation → tampon d'incréments → écriture par lots (flush)
 *
 * Les écritures sont des INCRÉMENTS : l'historique préchargé n'est jamais recompté. Un
 * crash peut perdre les observations pas encore écrites (au plus `flushEvery`).
 */
export class KnowledgeService {
  private readonly buffer: TransitionObservation[] = [];
  private readonly knownTransitions = new Set<string>();
  private readonly knownStates = new Set<string>();
  private readonly stats: KnowledgeStats = {
    historicalStatesLoaded: 0,
    historicalTransitionsLoaded: 0,
    newStatesLearned: 0,
    newTransitionsLearned: 0,
  };

  constructor(
    private readonly repository: KnowledgeRepository,
    readonly applicationId: string,
    private readonly memory: WorkingMemory,
    /** Contexte des observations de ce run (acteur, version, navigateur…), gardé comme « dernier contexte ». */
    private readonly context?: ObservedKnowledgeContext,
  ) {}

  /**
   * Charge la connaissance la plus récente, dans le budget : au plus `maxTransitions` lignes,
   * et seulement celles des `maxStates` écrans les plus récemment vus. Jamais toute la base.
   */
  async preload(budget: PreloadBudget): Promise<{ states: number; transitions: number }> {
    const rows = await this.repository.load(this.applicationId, budget.maxTransitions);
    const states = new Set<string>();
    const kept = rows.filter((row) => {
      if (states.has(row.fromStateSignature)) return true;
      if (states.size >= budget.maxStates) return false;
      states.add(row.fromStateSignature);
      return true;
    });
    this.memory.importHistory(kept);
    for (const row of kept) {
      this.knownTransitions.add(knowledgeKey(row));
      this.knownStates.add(row.fromStateSignature);
      if (row.toStateSignature !== NO_TARGET) this.knownStates.add(row.toStateSignature);
    }
    this.stats.historicalStatesLoaded = this.knownStates.size;
    this.stats.historicalTransitionsLoaded = kept.length;
    return { states: this.knownStates.size, transitions: kept.length };
  }

  /** Répartition des destinations connues, lue dans la mémoire de travail (aucun accès au stockage). */
  getTransitionKnowledge(
    fromStateSignature: string,
    actionSignature: string,
  ): TransitionDistribution | undefined {
    const entry = this.memory.getTransitionKnowledge(fromStateSignature, actionSignature);
    if (!entry) return undefined;
    return distributionOf(entry.targets);
  }

  /** Un écran vu pendant le run (pour compter ce qui est nouveau). */
  observeState(stateSignature: string): void {
    if (this.knownStates.has(stateSignature)) return;
    this.knownStates.add(stateSignature);
    this.stats.newStatesLearned += 1;
  }

  /** Une transition vue pendant le run : mise en tampon (un incrément), écrite au prochain flush. */
  observeTransition(observed: ObservedTransition): void {
    const observation: TransitionObservation = {
      applicationId: this.applicationId,
      fromStateSignature: fit(observed.fromStateSignature, LIMITS.signature) ?? NO_TARGET,
      actionSignature: fit(observed.actionSignature, LIMITS.signature) ?? NO_TARGET,
      toStateSignature:
        observed.result === 'SUCCESS' && observed.toStateSignature
          ? (fit(observed.toStateSignature, LIMITS.signature) ?? NO_TARGET)
          : NO_TARGET,
      seen: 1,
      success: observed.result === 'SUCCESS' ? 1 : 0,
      failure: observed.result === 'FAILED' ? 1 : 0,
      blocked: observed.result === 'BLOCKED' ? 1 : 0,
      durationTotalMs:
        observed.result !== 'BLOCKED' && observed.durationMs !== undefined ? observed.durationMs : 0,
      durationCount: observed.result !== 'BLOCKED' && observed.durationMs !== undefined ? 1 : 0,
      firstSeenAt: observed.at,
      lastSeenAt: observed.at,
      ...(this.context ? { lastContext: { ...this.context } } : {}),
    };
    const key = knowledgeKey(observation);
    if (!this.knownTransitions.has(key)) {
      this.knownTransitions.add(key);
      this.stats.newTransitionsLearned += 1;
    }
    this.buffer.push(observation);
  }

  get pending(): number {
    return this.buffer.length;
  }

  /** Écrit le tampon (atomiquement). En cas d'échec, le tampon est gardé pour la prochaine tentative. */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0, this.buffer.length);
    try {
      await this.repository.record(batch);
    } catch (error) {
      this.buffer.unshift(...batch);
      throw error;
    }
  }

  get statistics(): Readonly<KnowledgeStats> {
    return this.stats;
  }
}

/** Probabilités calculées sur les observations (count / total), destinations les plus fréquentes d'abord. */
export function distributionOf(targets: Readonly<Record<string, number>>): TransitionDistribution {
  const executions = Object.values(targets).reduce((sum, count) => sum + count, 0);
  return {
    executions,
    targets: Object.entries(targets)
      .map(([stateSignature, count]) => ({
        stateSignature,
        count,
        probability: executions === 0 ? 0 : count / executions,
      }))
      .sort((a, b) => b.count - a.count || a.stateSignature.localeCompare(b.stateSignature)),
  };
}
