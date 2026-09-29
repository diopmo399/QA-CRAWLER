/**
 * L'HISTORIQUE vu par la résolution : un signal, jamais une vérité. Le resolver ne
 * connaît que cette interface — la KnowledgeBase en mémoire la fournit (jamais une
 * requête SQL).
 */
export interface HistoricalSignal {
  /** 0..1 : la confiance du ConfidenceEngine (échantillon × stabilité × récence × contexte). */
  confidence: number;
  successes: number;
  failures: number;
  /** « 147/148 successful, last seen 2 day(s) ago ». */
  detail: string;
}

export interface SemanticHistory {
  /** Le signal pour cette intention, sur cet écran, vers cette cible (signature sémantique). */
  signalFor(intentKey: string, targetSignature: string): HistoricalSignal | undefined;
}

/** Points maximaux de l'historique : il départage, il ne renverse jamais une preuve forte du DOM. */
export const MAX_HISTORY_POINTS = 15;
