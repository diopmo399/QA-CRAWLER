import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FlowGraphData } from '../model/flow.js';

/** Where a baseline comes from. Branch, commit and environment are optional. */
export interface BaselineMetadata {
  /** Id of the run that produced it (also its folder under runs/). */
  runId: string;
  application: string;
  mission: string;
  targetUrl: string;
  createdAt: string;
  branch?: string;
  commit?: string;
  environment?: string;
  crawlerVersion?: string;
  states: number;
  transitions: number;
}

export interface Baseline {
  graph: FlowGraphData;
  metadata?: BaselineMetadata;
}

/**
 * The reference knowledge of the application, versioned:
 *
 *   baseline/
 *     flow-graph.json       ← latest baseline (what verify and explore compare with)
 *     metadata.json
 *     runs/<runId>/flow-graph.json, metadata.json   ← every learned run, newest kept
 *
 * Saving never overwrites history: the previous baselines stay in runs/
 * (up to `keepRuns`).
 */
export class BaselineStore {
  constructor(
    readonly directory: string,
    private readonly keepRuns = 20,
  ) {}

  get graphFile(): string {
    return path.join(this.directory, 'flow-graph.json');
  }

  /** The latest baseline, or undefined when none was learned yet. */
  async load(): Promise<Baseline | undefined> {
    let text: string;
    try {
      text = await readFile(this.graphFile, 'utf8');
    } catch {
      return undefined;
    }
    const graph = JSON.parse(text) as Partial<FlowGraphData>;
    if (graph.version !== 1 || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
      throw new Error(`${this.graphFile} is not a flow graph (version 1)`);
    }
    const metadata = await readFile(path.join(this.directory, 'metadata.json'), 'utf8')
      .then((raw) => JSON.parse(raw) as BaselineMetadata)
      .catch(() => undefined);
    return { graph: graph as FlowGraphData, ...(metadata ? { metadata } : {}) };
  }

  /** Stores a new baseline: it becomes the latest, and is archived under runs/. */
  async save(graph: FlowGraphData, metadata: BaselineMetadata): Promise<string> {
    const runDir = path.join(this.directory, 'runs', safeName(metadata.runId));
    await mkdir(runDir, { recursive: true });
    await writeJson(path.join(runDir, 'flow-graph.json'), graph);
    await writeJson(path.join(runDir, 'metadata.json'), metadata);
    await writeJson(this.graphFile, graph);
    await writeJson(path.join(this.directory, 'metadata.json'), metadata);
    await this.prune();
    return runDir;
  }

  /** Metadata of the archived runs, newest first. */
  async runs(): Promise<BaselineMetadata[]> {
    const root = path.join(this.directory, 'runs');
    const names = await readdir(root).catch(() => [] as string[]);
    const all = await Promise.all(
      names.map((name) =>
        readFile(path.join(root, name, 'metadata.json'), 'utf8')
          .then((raw) => JSON.parse(raw) as BaselineMetadata)
          .catch(() => undefined),
      ),
    );
    return all
      .filter((entry): entry is BaselineMetadata => entry !== undefined)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private async prune(): Promise<void> {
    const runs = await this.runs();
    for (const old of runs.slice(this.keepRuns)) {
      await rm(path.join(this.directory, 'runs', safeName(old.runId)), { recursive: true, force: true });
    }
  }
}

/** 2026-09-27T10:32:05.123Z + commit → 2026-09-27T10-32-05Z-1a2b3c4 */
export function runIdOf(createdAt: string, commit?: string): string {
  const stamp = createdAt.replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');
  return commit ? `${stamp}-${commit.slice(0, 7)}` : stamp;
}

function safeName(name: string): string {
  return name.replace(/[^\w.-]+/g, '_');
}

async function writeJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, file);
}
