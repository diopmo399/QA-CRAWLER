import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { FlowGraph } from '../graph/flow-graph.js';
import type { FlowGraphData } from '../model/flow.js';
import type { FlowMemory } from './flow-memory.js';

/** Enregistre le graphe des flows en JSON (reports/flow-graph.json). Les écritures sont atomiques (fichier temporaire + renommage). */
export class JsonFlowMemory implements FlowMemory {
  constructor(readonly location: string) {}

  /** Le graphe enregistré, ou un graphe vide quand il n'y en a pas (ou qu'il est illisible). */
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
