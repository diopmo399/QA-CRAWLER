import type { FlowGraph } from '../graph/flow-graph.js';

/**
 * Où vit le graphe des flows entre les étapes et entre les runs. L'explorateur ne
 * connaît que cette interface : une implémentation SQLite/PostgreSQL peut remplacer
 * le fichier JSON sans le toucher.
 */
export interface FlowMemory {
  load(): Promise<FlowGraph>;
  save(graph: FlowGraph): Promise<void>;
  /** Emplacement lisible (chemin de fichier, nom de connexion…). */
  readonly location: string;
}
