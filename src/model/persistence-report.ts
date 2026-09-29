/**
 * Persistance et mémoire, dans le rapport. Deux questions distinctes :
 * - persistance : OÙ ce run est enregistré (et le stockage réellement utilisé) ;
 * - mémoire : l'historique a-t-il influencé ce run ?
 * Jamais d'identifiants ni de chaîne de connexion.
 */
export interface PersistenceReport {
  enabled: boolean;
  status: 'DISABLED' | 'CONNECTED' | 'FALLBACK';
  configured?: { provider: 'memory' | 'file' | 'database'; database?: string };
  actual?: { provider: 'memory' | 'file' | 'database'; database?: string; location?: string };
  reason?: string;
  latencyMs?: number;
  schemaVersion?: number;
  /** Id du run dans le stockage (crawl_run.id). */
  runId?: string;
  applicationId?: string;
  writeErrors: string[];
  memory: MemoryReport;
}

export interface MemoryReport {
  /**
   * - legacy : pas de memory.enabled, la base de connaissances `knowledge` (fichier) comme avant ;
   * - isolated : memory.enabled: false, rien d'ancien n'est utilisé ;
   * - current-run : memory.enabled: true sans historique chargé (persistance absente ou historicalKnowledge: false) ;
   * - historical : l'historique du provider a été préchargé dans la mémoire de travail.
   */
  mode: 'legacy' | 'isolated' | 'current-run' | 'historical';
  enabled: boolean;
  historicalKnowledge: boolean;
  historicalStatesLoaded: number;
  historicalTransitionsLoaded: number;
  newStatesLearned: number;
  newTransitionsLearned: number;
}
