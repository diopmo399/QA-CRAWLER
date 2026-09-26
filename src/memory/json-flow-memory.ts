import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { FlowGraph } from '../graph/flow-graph.js';
import type { FlowGraphData } from '../model/flow.js';
import type { FlowMemory } from './flow-memory.js';

/** Stores the flow graph as JSON (reports/flow-graph.json). Writes are atomic (temp file + rename). */
export class JsonFlowMemory implements FlowMemory {
  constructor(readonly location: string) {}

  /** The persisted graph, or an empty one when there is none (or it is unreadable). */
  async load(): Promise<FlowGraph> {
    let text: string;
    try {
      text = await readFile(this.location, 'utf8');
    } catch {
      return new FlowGraph();
    }
    const data = JSON.parse(text) as Partial<FlowGraphData>;
    if (data.version !== 1 || !Array.isArray(data.nodes) || !Array.isArray(data.edges)) {
      throw new Error(`${this.location} is not a flow graph (version 1)`);
    }
    return FlowGraph.fromJSON(data as FlowGraphData);
  }

  async save(graph: FlowGraph): Promise<void> {
    await mkdir(path.dirname(this.location), { recursive: true });
    const temporary = `${this.location}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(graph.toJSON(), null, 2)}\n`, 'utf8');
    await rename(temporary, this.location);
  }
}
