import type { FlowGraph } from '../graph/flow-graph.js';

/**
 * Where the flow graph lives between steps and between runs. The explorer
 * only knows this interface, so a SQLite/PostgreSQL implementation can
 * replace the JSON file without touching it.
 */
export interface FlowMemory {
  load(): Promise<FlowGraph>;
  save(graph: FlowGraph): Promise<void>;
  /** Human-readable location (file path, connection name…). */
  readonly location: string;
}
