import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BaselineStore, runIdOf, type BaselineMetadata } from '../../src/baseline/baseline-store.js';
import { sourceInfo } from '../../src/baseline/source-info.js';
import type { FlowGraphData } from '../../src/model/flow.js';

const graph = (states: number): FlowGraphData => ({
  version: 1,
  nodes: Array.from({ length: states }, (_, i) => ({
    id: `s${i}`,
    label: `S${i}`,
    url: 'http://app.test/',
    route: '/',
    headings: [],
    depth: 0,
    discoveredActions: [],
    actions: {},
    firstSeenAt: '',
    lastSeenAt: '',
    visits: 1,
    issueIds: [],
  })),
  edges: [],
});
const metadata = (createdAt: string, extra: Partial<BaselineMetadata> = {}): BaselineMetadata => ({
  runId: runIdOf(createdAt, extra.commit),
  application: 'example',
  mission: 'example',
  targetUrl: 'http://app.test',
  createdAt,
  states: 1,
  transitions: 0,
  ...extra,
});

describe('BaselineStore', () => {
  it('stores a baseline without losing the previous ones', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'qa-baseline-'));
    const store = new BaselineStore(dir, 2);
    expect(await store.load()).toBeUndefined();

    await store.save(
      graph(1),
      metadata('2026-09-25T08:00:00.000Z', { branch: 'main', commit: 'abcdef1234567' }),
    );
    await store.save(graph(2), metadata('2026-09-26T08:00:00.000Z'));
    await store.save(graph(3), metadata('2026-09-27T08:00:00.000Z', { environment: 'qa' }));

    const latest = await store.load();
    expect(latest?.graph.nodes).toHaveLength(3);
    expect(latest?.metadata).toMatchObject({ runId: '2026-09-27T08-00-00Z', environment: 'qa' });
    // Historique : les plus récents d'abord, seulement keepRuns conservés.
    expect((await store.runs()).map((run) => run.runId)).toEqual([
      '2026-09-27T08-00-00Z',
      '2026-09-26T08-00-00Z',
    ]);
    expect((await readdir(path.join(dir, 'runs'))).sort()).toEqual([
      '2026-09-26T08-00-00Z',
      '2026-09-27T08-00-00Z',
    ]);
    const archived = JSON.parse(
      await readFile(path.join(dir, 'runs', '2026-09-26T08-00-00Z', 'flow-graph.json'), 'utf8'),
    ) as FlowGraphData;
    expect(archived.nodes).toHaveLength(2);
  });

  it('names runs after their date and commit', () => {
    expect(runIdOf('2026-09-27T10:32:05.123Z', '1a2b3c4d5e6f')).toBe('2026-09-27T10-32-05Z-1a2b3c4');
    expect(runIdOf('2026-09-27T10:32:05.123Z')).toBe('2026-09-27T10-32-05Z');
  });
});

describe('sourceInfo', () => {
  it('takes the mission first, then QA_* variables, then CI variables; all optional', async () => {
    expect(await sourceInfo({ branch: 'release' }, { QA_BRANCH: 'x', GITHUB_SHA: 'sha1' })).toEqual({
      branch: 'release',
      commit: 'sha1',
    });
    expect(await sourceInfo({}, { CI_COMMIT_REF_NAME: 'develop', CI_COMMIT_SHA: 'sha2' })).toEqual({
      branch: 'develop',
      commit: 'sha2',
    });
    expect(await sourceInfo({}, {})).toEqual({});
  });
});
