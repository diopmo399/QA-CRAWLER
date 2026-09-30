import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { StaticAnalysisCache } from '../../src/static-analysis/cache.js';
import { sourceSetOf } from '../../src/static-analysis/source-set.js';
import { StaticApplicationAnalyzer } from '../../src/static-analysis/static-analyzer.js';
import { StaticKnowledge } from '../../src/static-analysis/static-knowledge.js';
import { staticAnalyzerOptions } from '../helpers.js';

/** Une application synthétique : N/4 composants de formulaire, N/4 services, N/4 DTO, N/4 gabarits. */
function application(files: number): { path: string; text: string }[] {
  const entries: { path: string; text: string }[] = [
    { path: 'package.json', text: '{"dependencies":{"@angular/core":"^18.0.0"}}' },
  ];
  const groups = Math.max(1, Math.floor(files / 4));
  for (let index = 0; index < groups; index++) {
    entries.push(
      {
        path: `src/app/f${String(index)}/f${String(index)}.component.ts`,
        text: `import { Component } from '@angular/core';
import { FormBuilder, Validators } from '@angular/forms';
import { S${String(index)}Service } from './s${String(index)}.service';
@Component({ selector: 'app-f${String(index)}', templateUrl: './f${String(index)}.component.html' })
export class F${String(index)}Component {
  form = this.fb.group({ contact${String(index)}: ['', [Validators.required, Validators.email]], name${String(index)}: ['', Validators.maxLength(50)] });
  constructor(private fb: FormBuilder, private service: S${String(index)}Service) {}
  save(): void {
    const request = { email: this.form.controls.contact${String(index)}.value, name: this.form.value.name${String(index)} };
    this.service.create(request);
  }
}`,
      },
      {
        path: `src/app/f${String(index)}/f${String(index)}.component.html`,
        text: `<input type="text" formControlName="contact${String(index)}"><input formControlName="name${String(index)}">`,
      },
      {
        path: `src/app/f${String(index)}/s${String(index)}.service.ts`,
        text: `import { HttpClient } from '@angular/common/http';
import { R${String(index)} } from './r${String(index)}';
export class S${String(index)}Service {
  constructor(private http: HttpClient) {}
  create(request: R${String(index)}) { return this.http.post('/api/r${String(index)}', request); }
}`,
      },
      {
        path: `src/app/f${String(index)}/r${String(index)}.ts`,
        text: `export interface R${String(index)} { email: string; name: string; }`,
      },
    );
  }
  return entries;
}

const conceptOf = (text: string): string | undefined => (/email/i.test(text) ? 'email' : undefined);

describe('static analysis performance: an index built once, queries in memory', () => {
  for (const files of [10, 100, 500, 1000]) {
    it(`${String(files)} files: parse + graph, cache write/read, targeted queries`, async () => {
      const set = sourceSetOf('bench', application(files));
      const analyzer = new StaticApplicationAnalyzer(
        staticAnalyzerOptions({
          budgets: {
            maxFiles: 5_000,
            maxDurationMs: 60_000,
            maxFileSizeBytes: 2_000_000,
            maxAstNodes: 50_000_000,
          },
        }),
      );
      let started = performance.now();
      const { graph } = await analyzer.analyzeSet(set, 'SOURCE');
      const analysisMs = performance.now() - started;
      expect(graph.fields.length).toBe(Math.floor(files / 4) * 2);

      const cache = new StaticAnalysisCache(await mkdtemp(path.join(tmpdir(), 'qa-static-bench-')));
      const identity = { application: 'bench', mode: 'SOURCE' as const, sourceHash: graph.sourceHash };
      started = performance.now();
      await cache.put(identity, graph);
      const writeMs = performance.now() - started;
      started = performance.now();
      const loaded = await cache.get(identity);
      const readMs = performance.now() - started;
      expect(loaded?.fields.length).toBe(graph.fields.length);

      started = performance.now();
      const knowledge = new StaticKnowledge(graph, conceptOf);
      const indexMs = performance.now() - started;
      started = performance.now();
      const queries = 10_000;
      for (let index = 0; index < queries; index++)
        knowledge.provenanceFor(`contact${String(index % Math.max(1, Math.floor(files / 4)))}`);
      const queryUs = ((performance.now() - started) * 1000) / queries;

      console.info(
        `static analysis ${String(files)} files: analysis ${analysisMs.toFixed(0)} ms · cache write ${writeMs.toFixed(0)} ms / read ${readMs.toFixed(0)} ms · index ${indexMs.toFixed(0)} ms · query ${queryUs.toFixed(2)} µs`,
      );
      // Bornes larges (machines de CI lentes) : l'ordre de grandeur, pas une mesure fine.
      expect(analysisMs).toBeLessThan(60_000);
      expect(queryUs).toBeLessThan(200);
    }, 120_000);
  }
});
