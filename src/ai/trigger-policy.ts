import type { EvidenceReference, IntelligenceTriggerReason } from './model.js';

/** Quels déclencheurs sont actifs (configuration `ai.triggers`). */
export interface TriggerSettings {
  ambiguousTarget: boolean;
  unknownScreen: boolean;
  flowDivergence: boolean;
  recoveryFailed: boolean;
  multiplePlans: boolean;
  unresolvedHypothesis: boolean;
  unknownBusinessError: boolean;
  lowConfidence: boolean;
  knowledgeContradiction: boolean;
  unknownBlockingPrecondition: boolean;
  hypothesisAnalysis: boolean;
  recordingEnrichment: boolean;
}

/** Ce que QA-Crawler sait de la situation, au moment de décider s'il faut demander de l'aide. */
export interface TriggerSituation {
  /** Confiance du raisonnement déterministe (0..1). */
  deterministicConfidence: number;
  /** Les meilleurs scores déterministes (pour mesurer l'ambiguïté). */
  topScores?: number[];
  knownState?: boolean;
  knownGoal?: boolean;
  expectedEffectKnown?: boolean;
  /** Le raisonnement déterministe n'a rien conclu. */
  inconclusive?: boolean;
  ambiguousTarget?: boolean;
  unknownScreen?: boolean;
  unknownWorkflowState?: boolean;
  flowDivergence?: boolean;
  /** La récupération déterministe a échoué (budget, aucun chemin sûr, ambiguïté). */
  recoveryExhausted?: boolean;
  multiplePlans?: boolean;
  unresolvedIntent?: boolean;
  unresolvedHypothesis?: boolean;
  contradiction?: boolean;
  unknownBusinessError?: boolean;
  /** L'objectif reste bloqué et aucune précondition connue ne l'explique. */
  unknownBlockingPrecondition?: boolean;
  /** Une hypothèse contredite, sans alternative claire. */
  contradictedHypothesis?: boolean;
  /** Un enregistrement dont le sens fonctionnel reste ambigu. */
  recordingAmbiguity?: boolean;
  evidence?: EvidenceReference[];
}

export interface IntelligenceTriggerDecision {
  shouldInvoke: boolean;
  reason?: IntelligenceTriggerReason;
  /** FAST_PATH, TRIGGER_DISABLED… : pourquoi on n'appelle pas (pour l'audit). */
  skippedBecause?: string;
  evidence: EvidenceReference[];
}

/**
 * INTELLIGENCE TRIGGER POLICY : décider SI un appel est utile. Le chemin par défaut est le
 * FAST PATH déterministe ; le raisonnement profond n'est demandé que pour une situation
 * réellement difficile, dans l'ordre de gravité ci-dessous.
 */
export class IntelligenceTriggerPolicy {
  constructor(
    private readonly settings: TriggerSettings,
    private readonly deterministicConfidence: number,
  ) {}

  evaluate(situation: TriggerSituation): IntelligenceTriggerDecision {
    const evidence = situation.evidence ?? [];
    const hard: [boolean | undefined, keyof TriggerSettings, IntelligenceTriggerReason][] = [
      [situation.recoveryExhausted, 'recoveryFailed', 'RECOVERY_EXHAUSTED'],
      [situation.unknownBusinessError, 'unknownBusinessError', 'UNKNOWN_BUSINESS_ERROR'],
      [situation.flowDivergence, 'flowDivergence', 'FLOW_DIVERGENCE'],
      [situation.contradiction, 'knowledgeContradiction', 'KNOWLEDGE_CONTRADICTION'],
      [situation.unknownBlockingPrecondition, 'unknownBlockingPrecondition', 'UNKNOWN_BLOCKING_PRECONDITION'],
      [situation.contradictedHypothesis, 'hypothesisAnalysis', 'HYPOTHESIS_ANALYSIS'],
      [situation.recordingAmbiguity, 'recordingEnrichment', 'RECORDING_ENRICHMENT'],
    ];
    for (const [active, setting, reason] of hard)
      if (active) {
        if (!this.settings[setting])
          return { shouldInvoke: false, skippedBecause: `TRIGGER_DISABLED ${reason}`, evidence };
        return { shouldInvoke: true, reason, evidence };
      }

    // FAST PATH : état connu, but connu, confiance suffisante → jamais d'appel.
    const confident = situation.deterministicConfidence >= this.deterministicConfidence;
    if (confident && !situation.inconclusive && situation.knownState !== false)
      return { shouldInvoke: false, skippedBecause: 'FAST_PATH', evidence };

    const scores = [...(situation.topScores ?? [])].sort((a, b) => b - a);
    const close = scores.length >= 2 && (scores[0] ?? 0) - (scores[1] ?? 0) < 0.05;
    const soft: [boolean | undefined, keyof TriggerSettings, IntelligenceTriggerReason][] = [
      [situation.ambiguousTarget ?? close, 'ambiguousTarget', 'AMBIGUOUS_TARGET'],
      [situation.multiplePlans, 'multiplePlans', 'MULTIPLE_PLAUSIBLE_PLANS'],
      [situation.unknownScreen, 'unknownScreen', 'UNKNOWN_SCREEN'],
      [situation.unknownWorkflowState, 'unknownScreen', 'UNKNOWN_WORKFLOW_STATE'],
      [situation.unresolvedIntent, 'lowConfidence', 'UNRESOLVED_BUSINESS_INTENT'],
      [situation.unresolvedHypothesis, 'unresolvedHypothesis', 'UNRESOLVED_HYPOTHESIS'],
      [!confident || situation.inconclusive, 'lowConfidence', 'LOW_DECISION_CONFIDENCE'],
    ];
    for (const [active, setting, reason] of soft)
      if (active && this.settings[setting]) return { shouldInvoke: true, reason, evidence };
    return { shouldInvoke: false, skippedBecause: 'NO_ENABLED_TRIGGER', evidence };
  }
}
