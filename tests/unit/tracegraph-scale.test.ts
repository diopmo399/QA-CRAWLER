import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildIndex, traceOf, type MapIndex } from '../../src/cartography/explorer.js';
import { runScan } from '../../src/cartography/scan.js';
import type { CartographyModel } from '../../src/sdk/core/cartography.js';
import { generateLargeAngularApp, type FeatureTruth, type LargeAppTruth } from '../large-angular-app.js';

/**
 * La cartographie éprouvée sur une application Angular synthétique de grande taille, cinq styles RxJS mélangés
 * (voir tests/large-angular-app.ts). Chaque parcours est comparé à la vérité de l'application générée : ce
 * que submit et reload doivent atteindre, ce qu'ils ne doivent jamais atteindre (autre action du même store,
 * API d'un autre module), la route de chaque composant homonyme, et les ruptures injectées. La taille se
 * règle par QA_TG_SCALE_FEATURES (défaut 60 modules, environ 25 000 lignes).
 */
const FEATURES = Number(process.env.QA_TG_SCALE_FEATURES ?? 60);

let dir: string;
let truth: LargeAppTruth;
let model: CartographyModel;
let index: MapIndex;
let scanMs: number;

const short = (id: string): string => id.split(':').slice(2).join(':');
const componentKey = (f: FeatureTruth): string =>
  f.component === 'ListComponent' ? `ListComponent(${f.folder}/list)` : f.component;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'tracegraph-scale-'));
  truth = await generateLargeAngularApp(path.join(dir, 'front'), { features: FEATURES, missingEvery: 20 });
  const started = performance.now();
  ({ model } = await runScan({
    incremental: false,
    allowedRoots: [dir],
    config: {
      schema: 1,
      sources: [
        {
          id: 'front',
          name: 'front',
          layer: 'FRONTEND',
          path: path.join(dir, 'front'),
          include: [],
          enabled: true,
        },
      ],
    },
  }));
  scanMs = performance.now() - started;
  index = buildIndex(model);
}, 300_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const reach = (f: FeatureTruth, method: string): Set<string> => {
  const id = model.nodes.find(
    (n) => n.kind === 'METHOD' && short(n.id) === `${componentKey(f)}#${method}`,
  )?.id;
  expect(id, `${componentKey(f)}#${method}`).toBeDefined();
  const trace = traceOf(index, id ?? '', { direction: 'DOWN' });
  expect(trace?.truncated ?? false).toBe(false);
  return new Set((trace?.nodes ?? []).map((n) => short(n.id)));
};

describe(`TraceGraph on a large mixed-RxJS Angular application (${String(FEATURES)} modules)`, () => {
  it('reads and analyses every file: no limit reached, the source is complete', () => {
    expect(model.scan.errors).toEqual([]);
    expect(model.scan.sources.map((s) => s.state)).toEqual(['SCANNED']);
    expect(model.scan.sources[0]?.errors.filter((e) => /BUDGET|limite/.test(e))).toEqual([]);
    expect(truth.lines).toBeGreaterThan(FEATURES * 300);
  });

  it('every submit and reload reaches its own calls and never another action or another module', () => {
    const wrong: string[] = [];
    for (const f of truth.features) {
      const submit = reach(f, 'submit');
      const reload = reach(f, 'reload');
      for (const m of f.submitReaches)
        if (!submit.has(m)) wrong.push(`${f.prefix} (${f.style}) submit misses ${m}`);
      for (const m of f.submitNever)
        if (submit.has(m)) wrong.push(`${f.prefix} (${f.style}) submit reaches ${m}`);
      for (const m of f.reloadReaches)
        if (!reload.has(m)) wrong.push(`${f.prefix} (${f.style}) reload misses ${m}`);
      for (const m of f.reloadNever)
        if (reload.has(m)) wrong.push(`${f.prefix} (${f.style}) reload reaches ${m}`);
      for (const s of [...submit, ...reload])
        if (/Api#/.test(s) && !s.startsWith(`${f.prefix}Api#`)) wrong.push(`${f.prefix} reaches ${s}`);
    }
    expect(wrong).toEqual([]);
  });

  it('each homonymous component keeps its own route; each injected break is a kept unresolved link', () => {
    const displays = new Set(
      model.edges.filter((e) => e.kind === 'DISPLAYS').map((e) => `${short(e.from)}->${short(e.to)}`),
    );
    const missing = truth.features.filter((f) => !displays.has(`${f.route}->${componentKey(f)}`));
    expect(missing.map((f) => f.route)).toEqual([]);
    const kept = (model.unresolved ?? []).filter((u) => u.kind === 'DISPLAYS').map((u) => short(u.from));
    expect(kept.sort()).toEqual([...truth.missingRoutes].sort());
  });

  it('a shared action stream is split by emitted type: an emission reaches only the pipes that accept it', () => {
    const c = truth.features.find((f) => f.style === 'C');
    expect(c).toBeDefined();
    const prefix = c?.prefix ?? '';
    const out = (from: string): string[] =>
      model.edges.filter((e) => short(e.from) === from).map((e) => short(e.to));
    expect(out(`${prefix}Store.actions⟨type='SAVE'⟩`)).toContain(`${prefix}Store.saved$`);
    expect(out(`${prefix}Store.actions⟨type='SAVE'⟩`)).not.toContain(`${prefix}Store.loaded$`);
    expect(out(`${prefix}Store.actions⟨type='LOAD'⟩`)).not.toContain(`${prefix}Store.saved$`);
  });

  it('stays within a time budget proportional to the size', () => {
    // Borne large (machines de CI lentes) : environ 60 ms par module.
    expect(scanMs).toBeLessThan(Math.max(30_000, FEATURES * 60));
  });
});
