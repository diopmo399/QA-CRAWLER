import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildIndex, traceOf } from '../../src/cartography/explorer.js';
import { runScan } from '../../src/cartography/scan.js';
import type { CartographyModel } from '../../src/sdk/core/cartography.js';

/**
 * LES BORNES DU MOTEUR sur un store central : une seule méthode `dispatch` reçoit des centaines de types
 * d'action. Chaque méthode du composant ne doit atteindre que l'appel de son type, sans que la borne de
 * contextes par méthode fasse retomber les suivantes sur « toutes les branches possibles ».
 */
const TYPES = 200;
let dir: string;
let model: CartographyModel;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'flow-engine-bounds-'));
  const app = path.join(dir, 'front/src/app');
  await mkdir(app, { recursive: true });
  const ids = Array.from({ length: TYPES }, (_, i) => i);
  await writeFile(
    path.join(dir, 'front/package.json'),
    '{"dependencies":{"@angular/core":"^17.0.0","rxjs":"^7.8.0"}}',
  );
  await writeFile(
    path.join(app, 'hub.api.ts'),
    `import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
@Injectable({ providedIn: 'root' })
export class HubApi {
  constructor(private http: HttpClient) {}
${ids.map((i) => `  m${String(i)}() { return this.http.post('/api/hub/${String(i)}', {}); }`).join('\n')}
}
`,
  );
  await writeFile(
    path.join(app, 'hub.store.ts'),
    `import { Injectable } from '@angular/core';
import { HubApi } from './hub.api';
@Injectable({ providedIn: 'root' })
export class HubStore {
  constructor(private api: HubApi) {}
  dispatch(action: { type: string }): void {
    switch (action.type) {
${ids.map((i) => `      case 'T${String(i)}': this.api.m${String(i)}().subscribe(); break;`).join('\n')}
    }
  }
}
`,
  );
  await writeFile(
    path.join(app, 'hub.component.ts'),
    `import { Component } from '@angular/core';
import { HubStore } from './hub.store';
@Component({ selector: 'app-hub', template: '<button (click)="a0()">x</button>' })
export class HubComponent {
  constructor(private store: HubStore) {}
${ids.map((i) => `  a${String(i)}(): void { this.store.dispatch({ type: 'T${String(i)}' }); }`).join('\n')}
}
`,
  );
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
}, 120_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe(`a central store with ${String(TYPES)} action types`, () => {
  it('every caller reaches the call of its own type, and only that one', () => {
    const index = buildIndex(model);
    const short = (id: string): string => id.split(':').slice(2).join(':');
    const wrong: string[] = [];
    for (let i = 0; i < TYPES; i += 1) {
      const id = model.nodes.find(
        (n) => n.kind === 'METHOD' && short(n.id) === `HubComponent#a${String(i)}`,
      )?.id;
      const reached = (traceOf(index, id ?? '', { direction: 'DOWN' })?.nodes ?? [])
        .map((n) => short(n.id))
        .filter((name) => name.startsWith('HubApi#m'));
      if (reached.length !== 1 || reached[0] !== `HubApi#m${String(i)}`)
        wrong.push(`a${String(i)} → ${reached.slice(0, 3).join(', ')}`);
    }
    expect(wrong).toEqual([]);
  });

  it('no context bound is reached: the source is complete, nothing falls back to every branch', () => {
    expect(model.scan.sources.map((s) => s.state)).toEqual(['SCANNED']);
    expect(model.scan.resolution?.diagnostics.LIMIT).toBeUndefined();
  });
});
