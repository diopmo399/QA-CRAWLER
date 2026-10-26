import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FlowStep } from '../../src/config/flow-schema.js';
import type { RecordedFlow, RecordedFlowStep } from '../../src/recording/model.js';
import { emptyQuality } from '../../src/recording/model.js';
import type { StoredRecording } from '../../src/recording/recording-workspace.js';
import { applyGroupCommand, groupViews } from '../../src/recording/step-groups.js';
import type { FlowStudioView, GroupViewDto } from '../../src/sdk/core/contracts.js';
import { studioView } from '../../src/sdk/server/recordings.js';
import { studioStrings } from '../../src/sdk/ui/studio-i18n.js';
import {
  fitView,
  layoutStudio,
  MAX_ZOOM,
  NODE_WIDTH,
  searchStudio,
  zoomAt,
} from '../../src/sdk/ui/studio-layout.js';
import { renderStudio, type StudioState } from '../../src/sdk/ui/studio-view.js';

/**
 * LE FLOW STUDIO sans navigateur : la vue que le serveur bâtit avec le moteur (dépendances, conflits
 * d'ordre, dernier rejeu), la disposition du graphe, la recherche et le rendu échappé.
 */
const C: Pick<FlowStep, 'allow' | 'optional'> = { allow: [], optional: false };

function step(id: string, action: string, flowStep: FlowStep, label = id): RecordedFlowStep {
  return {
    id,
    step: flowStep,
    label,
    actionIds: [action],
    rawEventIds: [`r-${action}`],
    provenance: 'HUMAN_RECORDED',
    confidence: 0.9,
    explanation: 'fixture',
  };
}

function fixture(): RecordedFlow {
  return {
    name: 'create then find',
    recordingSessionId: 'rec-studio',
    startAt: '/items',
    steps: [
      step(
        's1',
        'a1',
        { ...C, kind: 'click', target: { strategy: 'role', role: 'link', name: 'New item' } },
        'open the form',
      ),
      step(
        's2',
        'a2',
        {
          ...C,
          kind: 'fill',
          target: { strategy: 'label', value: 'Title' },
          value: { testData: 'item.title' },
        },
        'type the title',
      ),
      step(
        's3',
        'a3',
        { ...C, kind: 'click', target: { strategy: 'role', role: 'button', name: 'Save' } },
        'save the item',
      ),
      step('s4', 'a4', { ...C, kind: 'goto', url: '/items' }, ''),
      step(
        's5',
        'a5',
        {
          ...C,
          kind: 'fill',
          target: { strategy: 'label', value: 'Search' },
          value: { testData: 'item.title' },
        },
        'search <b>the title</b>',
      ),
      step('s6', 'a5', { ...C, kind: 'expect', expect: { text: '${testData:item.title}' } }),
    ],
    assertions: [],
    intent: { transitions: [], confidence: 0, evidence: [] },
    negative: false,
    quality: emptyQuality(),
  };
}

function dtos(flow: RecordedFlow): GroupViewDto[] {
  return groupViews(flow).map((group) => ({
    id: group.id,
    name: group.name,
    stepIds: group.stepIds,
    positions: group.positions,
    ...(group.collapsed !== undefined ? { collapsed: group.collapsed } : {}),
    startAt: group.startAt,
    checks: group.checks,
    assertionIds: group.assertionIds,
    runnableAlone: group.runnableAlone,
    data: group.data,
  }));
}

let dir: string;
let view: FlowStudioView;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'qa-studio-'));
  const flow = fixture();
  expect(
    applyGroupCommand(flow, { op: 'create', name: 'Create', stepIds: ['s1', 's2', 's3'] }),
  ).toMatchObject({
    ok: true,
  });
  expect(applyGroupCommand(flow, { op: 'create', name: 'Find', stepIds: ['s4', 's5', 's6'] })).toMatchObject({
    ok: true,
  });
  await writeFile(path.join(dir, 'recorded-flow.json'), JSON.stringify(flow));
  const replayDir = path.join(dir, 'replay', 'dry-run', 'run-1');
  await mkdir(replayDir, { recursive: true });
  await writeFile(
    path.join(replayDir, 'reconciliation.json'),
    JSON.stringify({
      status: 'PARTIALLY_MATCHED',
      findings: [
        { intentId: 'flow#1', outcome: 'MATCHED', reasons: [] },
        { intentId: 'flow#2', outcome: 'MATCHED', reasons: [] },
        { intentId: 'flow#3', outcome: 'NOT_FOUND', reasons: ['no button named Save'] },
        { intentId: 'flow#9', outcome: 'MATCHED', reasons: [] },
        { intentId: 'flow#4', outcome: 'INVENTED', reasons: [] },
      ],
    }),
  );
  // Le rejeu est plus récent que le flow : il n'est pas périmé.
  const past = new Date(Date.now() - 60_000);
  await utimes(path.join(dir, 'recorded-flow.json'), past, past);
  const stored: StoredRecording = {
    directory: dir,
    flow,
    startedAt: new Date().toISOString(),
    format: 'yaml',
  };
  view = await studioView(stored, dtos(flow));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('Flow Studio — the view the server builds with the engine', () => {
  it('gives each step its produced and used data keys, and the producer → consumer links', () => {
    const byId = new Map(view.steps.map((entry) => [entry.id, entry]));
    expect(byId.get('s2')).toMatchObject({
      position: 2,
      produces: ['item.title'],
      consumes: [],
      groupId: expect.any(String) as unknown,
    });
    expect(byId.get('s5')).toMatchObject({ consumes: ['item.title'], produces: [] });
    expect(view.dependencies).toEqual(
      expect.arrayContaining([
        { from: 's2', to: 's5', key: 'item.title' },
        { from: 's2', to: 's6', key: 'item.title' },
      ]),
    );
    expect(view.violations).toEqual([]);
    expect(view.groups.map((group) => group.name)).toEqual(['Create', 'Find']);
    expect(view.groups[1]?.data?.inputs).toEqual([
      expect.objectContaining({ key: 'item.title', producerStepId: 's2' }),
    ]);
  });

  it('links the last replay result to the step of the same position, and ignores unknown outcomes', () => {
    const byId = new Map(view.steps.map((entry) => [entry.id, entry]));
    expect(byId.get('s1')?.replay?.outcome).toBe('MATCHED');
    expect(byId.get('s3')?.replay).toEqual({ outcome: 'NOT_FOUND', reasons: ['no button named Save'] });
    expect(byId.get('s4')?.replay).toBeUndefined();
    expect(view.replay).toMatchObject({ status: 'PARTIALLY_MATCHED', stale: false });
  });

  it('without any replay, says so: no result is invented', async () => {
    const empty = await mkdtemp(path.join(tmpdir(), 'qa-studio-empty-'));
    try {
      const flow = fixture();
      const bare = await studioView(
        { directory: empty, flow, startedAt: new Date().toISOString(), format: 'yaml' },
        dtos(flow),
      );
      expect(bare.replay).toBeUndefined();
      expect(bare.steps.every((entry) => entry.replay === undefined)).toBe(true);
      expect(bare.groups).toEqual([]);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});

describe('Flow Studio — layout', () => {
  it('draws one frame per group, the steps inside it in order, and arrows between consecutive steps', () => {
    const layout = layoutStudio(view);
    expect(layout.groups.map((group) => group.name)).toEqual(['Create', 'Find']);
    const [create, find] = layout.groups;
    const s1 = layout.steps.find((entry) => entry.id === 's1');
    const s4 = layout.steps.find((entry) => entry.id === 's4');
    expect(s1 && create && s1.x >= create.x && s1.x + NODE_WIDTH <= create.x + create.width).toBe(true);
    expect(s4 && find && s4.x >= find.x).toBe(true);
    expect(layout.edges.filter((edge) => edge.kind === 'sequence')).toHaveLength(5);
    expect(layout.edges.filter((edge) => edge.kind === 'data').map((edge) => edge.key)).toEqual([
      'item.title',
      'item.title',
    ]);
  });

  it('a collapsed group shows one summary card that stands for its steps', () => {
    const layout = layoutStudio(view, { collapsed: { [view.groups[0]?.id ?? '']: true } });
    expect(layout.summaries).toHaveLength(1);
    expect(layout.summaries[0]?.stepIds).toEqual(['s1', 's2', 's3']);
    expect(layout.nodeOf.s2).toBe(layout.summaries[0]?.id);
    expect(layout.steps.map((entry) => entry.id)).toEqual(['s4', 's5', 's6']);
    // Le lien de données part désormais du résumé.
    expect(layout.edges.find((edge) => edge.kind === 'data')?.from).toBe(layout.summaries[0]?.id);
  });

  it('wraps a long group into several columns, and a hand-moved card moves alone', () => {
    const wrapped = layoutStudio(view, { maxRows: 2 });
    const xs = new Set(
      wrapped.steps.filter((entry) => ['s1', 's2', 's3'].includes(entry.id)).map((entry) => entry.x),
    );
    expect(xs.size).toBe(2);
    const base = layoutStudio(view);
    const moved = layoutStudio(view, { offsets: { s5: { dx: 40, dy: 300 } } });
    const before = base.steps.find((entry) => entry.id === 's5');
    const after = moved.steps.find((entry) => entry.id === 's5');
    expect(after?.x).toBe((before?.x ?? 0) + 40);
    expect(after?.y).toBe((before?.y ?? 0) + 300);
    expect(moved.steps.find((entry) => entry.id === 's4')?.y).toBe(
      base.steps.find((entry) => entry.id === 's4')?.y,
    );
    expect(moved.height).toBeGreaterThan(base.height);
  });

  it('keeps a long journey readable: 150 steps stay within the row limit and lay out fast', () => {
    const steps = Array.from({ length: 150 }, (_, index) => ({
      id: `n${String(index)}`,
      position: index + 1,
      kind: index % 3 === 0 ? 'fill' : 'click',
      description: `step ${String(index)}`,
      groupId: `g${String(Math.floor(index / 50))}`,
      consumes: [],
      produces: [],
    }));
    const groups = [0, 1, 2].map((index) => ({
      id: `g${String(index)}`,
      name: `group ${String(index)}`,
      stepIds: steps.slice(index * 50, index * 50 + 50).map((entry) => entry.id),
      positions: [],
      startAt: '/',
      checks: [],
      assertionIds: [],
      runnableAlone: { ok: true, missing: [] },
    }));
    const started = performance.now();
    const layout = layoutStudio({ steps, groups, dependencies: [], violations: [] });
    expect(performance.now() - started).toBeLessThan(50);
    expect(layout.steps).toHaveLength(150);
    expect(layout.groups).toHaveLength(3);
    // Au plus 10 cartes par colonne : le graphe s'étend en largeur, pas en hauteur.
    expect(layout.height).toBeLessThan(10 * 44 + 140);
    expect(new Set(layout.steps.map((entry) => `${String(entry.x)},${String(entry.y)}`)).size).toBe(150);
  });

  it('marks a data link used before it is produced as a violation', () => {
    const layout = layoutStudio({
      ...view,
      violations: [{ stepId: 's5', key: 'item.title', producerStepId: 's2', message: 'x' }],
    });
    expect(layout.edges.filter((edge) => edge.kind === 'violation').map((edge) => edge.to)).toEqual(['s5']);
  });

  it('fits the whole graph without enlarging it, and zooms around the pointer', () => {
    const layout = layoutStudio(view);
    const fitted = fitView(layout, 4000, 4000);
    expect(fitted.k).toBe(1);
    const small = fitView(layout, 300, 200);
    expect(small.k).toBeLessThan(1);
    const zoomed = zoomAt({ x: 10, y: 20, k: 1 }, 2, { x: 110, y: 120 });
    // Le point sous le pointeur reste sous le pointeur.
    expect((110 - zoomed.x) / zoomed.k).toBeCloseTo(100);
    expect(zoomAt({ x: 0, y: 0, k: 2 }, 100, { x: 0, y: 0 }).k).toBe(MAX_ZOOM);
  });

  it('searches steps by text, data key and group name', () => {
    expect(searchStudio(view, 'item.title')).toEqual(['s2', 's5', 's6']);
    expect(searchStudio(view, 'find')).toEqual(['s4', 's5', 's6']);
    expect(searchStudio(view, 'save')).toEqual(['s3']);
    expect(searchStudio(view, '   ')).toEqual([]);
  });
});

describe('Flow Studio — rendering', () => {
  const state = (patch: Partial<StudioState> = {}): StudioState => ({
    t: studioStrings('fr'),
    phase: 'ready',
    view,
    layout: layoutStudio(view),
    viewport: { x: 0, y: 0, k: 1 },
    selected: [],
    query: '',
    matches: [],
    matchIndex: 0,
    busy: false,
    moved: false,
    tab: 'flow',
    ...patch,
  });

  it('escapes the text of steps, labels every card for assistive technology', () => {
    const html = renderStudio(state());
    expect(html).not.toContain('<b>the title</b>');
    expect(html).toContain('search &lt;b&gt;the title&lt;/b&gt;');
    expect(html).toMatch(/data-node="s3"[^>]*aria-label="Étape 3 : save the item[^"]*Rejeu : introuvable/);
    // Sans libellé, l'étape est décrite par ce qu'elle fait.
    expect(view.steps.find((entry) => entry.id === 's4')?.description).toBe('goto /items');
    expect(html).toContain('role="button"');
    expect(html).toContain('Dernier rejeu : PARTIALLY_MATCHED');
  });

  it('shows the step panel with the data it produces and uses, and the replay reason', () => {
    const html = renderStudio(state({ selected: ['s3'] }));
    expect(html).toContain('no button named Save');
    const second = renderStudio(state({ selected: ['s2'] }));
    expect(second).toMatch(/Produit<\/dt><dd><code>item\.title<\/code>/);
  });

  it('explains a refusal with the step, the data and a proposal, and says nothing changed', () => {
    const html = renderStudio(
      state({
        notice: {
          kind: 'refused',
          message: 'the order uses a value before it exists',
          violations: [{ stepId: 's5', key: 'item.title', producerStepId: 's2', message: 'x' }],
        },
      }),
    );
    expect(html).toContain('Le moteur a refusé : rien n’a été modifié.');
    expect(html).toContain('cite item.title avant');
    expect(html).toContain('Proposition : placez d’abord');
    expect(html).toContain('role="alert"');
  });

  it('dims the cards that do not match a search and marks the current one', () => {
    const html = renderStudio(state({ query: 'save', matches: ['s3'], matchIndex: 0 }));
    expect(html).toMatch(/class="node[^"]*cur[^"]*" data-node="s3"/);
    expect(html).toMatch(/class="node[^"]*dim[^"]*" data-node="s1"/);
    expect(html).toContain('1 / 1');
  });

  it('asks for the project and recording, shows loading and errors in words', () => {
    expect(renderStudio(state({ phase: 'idle' }))).toContain('attributs project et recording');
    expect(renderStudio(state({ phase: 'loading' }))).toContain('aria-busy="true"');
    expect(renderStudio(state({ phase: 'error', error: 'recording <x> not found' }))).toContain(
      'recording &lt;x&gt; not found',
    );
  });
});
