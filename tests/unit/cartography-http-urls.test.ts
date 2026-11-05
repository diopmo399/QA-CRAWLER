import path from 'node:path';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterAll, describe, expect, it } from 'vitest';
import type { CartographyConfig } from '../../src/sdk/core/cartography.js';
import { runScan } from '../../src/cartography/scan.js';
import { extractFacts } from '../../src/static-analysis/ts-facts.js';
import { loadTypeScript } from '../../src/static-analysis/typescript-loader.js';

/**
 * LES URL D'APPEL HTTP RANGÉES AILLEURS QUE DANS L'APPEL : constante locale, constante du module, propriété
 * de la classe (initialisée ou assignée dans le constructeur), callback de pipe. Avant, ces appels étaient
 * perdus sans le dire et la chaîne Front → BFF restait « lien non démontré ».
 */
const SERVICE = `
import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { environment } from '../environments/environment';

const COMPANIES = '/api/companies';

@Injectable({ providedIn: 'root' })
export class CompanyService {
  private readonly base = \`\${environment.apiUrl}/api\`;
  private readonly root: string;
  private changing = '/a';

  constructor(private http: HttpClient) {
    this.root = '/api/root';
    this.changing = '/b';
  }

  local(id: string) {
    const url = \`\${this.base}/companies/\${id}\`;
    return this.http.get(url);
  }
  moduleConstant(company: unknown) {
    return this.http.post(COMPANIES, company);
  }
  property() {
    return this.http.get(this.root + '/list');
  }
  inCallback(id$: { pipe: (f: unknown) => unknown }) {
    return id$.pipe((id: string) => {
      const target = \`/api/companies/\${id}/history\`;
      return this.http.get(target);
    });
  }
  ambiguous() {
    return this.http.get(this.changing);
  }
  unknown(url: string) {
    return this.http.get(url);
  }
}
`;

describe('HTTP call URLs kept in constants and properties', () => {
  it('are read back; an ambiguous or unknown value is never invented', async () => {
    const ts = await loadTypeScript();
    if (!ts) throw new Error('typescript is required by the cartography');
    const facts = extractFacts(ts, 'company.service.ts', SERVICE, { remaining: 100_000 });
    const calls = Object.fromEntries(
      (facts.classes[0]?.methods ?? []).map((m) => [
        m.name,
        m.httpCalls.map((c) => `${c.method} ${c.route}`),
      ]),
    );
    expect(calls.local).toEqual(['GET {base}/api/companies/{param}']);
    expect(calls.moduleConstant).toEqual(['POST /api/companies']);
    expect(calls.property).toEqual(['GET /api/root/list']);
    expect(calls.inCallback).toEqual(['GET /api/companies/{param}/history']);
    // Assignée deux fois : aucune valeur sûre, l'appel n'est pas relié au hasard.
    expect(calls.ambiguous).toEqual([]);
    expect(calls.unknown).toEqual([]);
  });
});

describe('a screen whose service keeps the URL in a constant', () => {
  let root: string;
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('is linked to the BFF endpoint: the chain has no gap at the BFF', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'carto-urls-'));
    const fixture = path.resolve('tests/fixtures/cartography');
    await cp(path.join(fixture, 'front'), path.join(root, 'front'), { recursive: true });
    await cp(path.join(fixture, 'bff'), path.join(root, 'bff'), { recursive: true });
    await writeFile(
      path.join(root, 'front/src/app/companies/company.service.ts'),
      `import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { NewCompany } from './company.models';

@Injectable({ providedIn: 'root' })
export class CompanyService {
  private readonly api = '/api';

  constructor(private http: HttpClient) {}

  create(company: NewCompany) {
    const url = \`\${this.api}/companies\`;
    return this.http.post(url, company);
  }
}
`,
    );
    const config: CartographyConfig = {
      schema: 1,
      sources: [
        {
          id: 'front',
          name: 'Front',
          layer: 'FRONTEND',
          path: path.join(root, 'front'),
          include: [],
          enabled: true,
        },
        { id: 'bff', name: 'BFF', layer: 'BFF', path: path.join(root, 'bff'), include: [], enabled: true },
      ],
    };
    const { model } = await runScan({ config, allowedRoots: [root], incremental: false });
    const company = model.features.find((f) => f.name === 'Company form');
    expect(
      company?.chain.some((step) => step.layer === 'FRONTEND' && /POST \/api\/companies/.test(step.label)),
    ).toBe(true);
    const bff = company?.chain.filter((step) => step.layer === 'BFF') ?? [];
    expect(bff.length).toBeGreaterThan(0);
    expect(bff.every((step) => !step.gap)).toBe(true);
  });
});
