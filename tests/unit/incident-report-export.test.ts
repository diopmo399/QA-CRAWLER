import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InvestigationReport, ReportSection } from '../../src/incident/model.js';
import { proposeRegressionTest } from '../../src/incident/regression.js';
import { reportMarkdown, reportPart } from '../../src/incident/report.js';
import {
  escapeHtml,
  PdfTimeoutError,
  PdfUnavailableError,
  renderPdf,
  reportHtml,
} from '../../src/incident/report-export.js';
import { IncidentService, type IncidentHost } from '../../src/incident/service.js';
import { REPORT_SECTIONS } from '../../src/sdk/core/incident-contracts.js';
import { handleIncidentRoutes, type IncidentRouteContext } from '../../src/sdk/server/incidents.js';

/**
 * LES EXPORTS DU RAPPORT : sections choisies (absentes, jamais vides), HTML autonome échappé et sans
 * script, PDF imprimé par Chromium (indisponible : 501 PDF_UNAVAILABLE, jamais simulé), paramètres
 * refusés ; et le test Playwright TypeScript généré depuis le flow du test de non-régression proposé.
 */

const report: InvestigationReport = {
  version: 1,
  generatedAt: '2026-10-30T12:00:00.000Z',
  incident: {
    id: 'inc_catalogue01',
    projectId: 'catalogue',
    title: 'Erreur <script>alert(1)</script> & "500"',
    description: 'Après <b>Enregistrer</b>',
    observed: 'HTTP 500',
    expected: 'Livre créé',
    severity: 'HIGH',
    state: 'DIAGNOSED',
  },
  environment: { execution: { target: 'LOCAL' }, baseUrl: 'http://catalogue.test' },
  scope: {
    mode: 'GUIDED',
    applications: [
      {
        id: 'bff',
        name: 'BFF <livres>',
        layer: 'BFF',
        repository: { root: '/repos/bff', include: ['src/main/java'] },
      },
    ],
    scenarios: ['creer-livre'],
    steps: [],
    endpoints: ['POST /api/books'],
    depth: 3,
    allowedHosts: [],
    logRoots: [],
    allowedCommands: [],
    permissions: {
      readSources: true,
      navigate: true,
      httpRequests: 'NONE',
      runTests: 'NONE',
      localCommands: false,
      readLogs: false,
      openshift: 'NONE',
      sideEffects: false,
    },
    limits: {
      maxFiles: 10,
      maxFileBytes: 1000,
      maxDurationMs: 60_000,
      maxRequests: 5,
      maxExperiments: 2,
      maxMemoryMb: 512,
    },
    extensions: [],
  },
  scenario: 'creer-livre',
  timeline: [{ step: 3, kind: 'ACTION', summary: 'click "Enregistrer" : PASSED', ref: 'rep_1:ev-action-3' }],
  requests: [
    {
      id: 'rep_1:req-3-1',
      method: 'POST',
      url: '/api/books',
      path: '/api/books',
      status: 500,
      resourceType: 'fetch',
      step: 3,
      correlation: 'OBSERVED',
      responseBody: '{"message":"</pre><img src=x onerror=alert(1)>"}',
    },
  ],
  code: { files: [], symbols: [], denied: [], truncated: [] },
  hypotheses: [],
  experiments: [],
  diagnosis: {
    status: 'PROBABLE',
    rootCause: {
      statement: 'book.getPublisher() est nul',
      layer: 'BACKEND',
      confidence: 0.7,
      evidence: [],
    },
    alternatives: [],
    missing: ['une seconde vérification'],
    recommendations: [],
    at: '2026-10-30T12:00:00.000Z',
  } as unknown as InvestigationReport['diagnosis'],
  limitations: ['Aucune vérification exécutée.'],
};

describe('report sections', () => {
  it('JSON: the keys of excluded sections are absent, the header and limitations stay', () => {
    const part = reportPart(report, ['requests', 'summary']);
    expect(part.sections).toEqual(['summary', 'requests']);
    expect(part.requests).toHaveLength(1);
    expect(part.incident.description).toBe('Après <b>Enregistrer</b>');
    expect(part.scenario).toBe('creer-livre');
    expect(part.limitations).toEqual(['Aucune vérification exécutée.']);
    for (const key of ['timeline', 'environment', 'scope', 'code', 'hypotheses', 'diagnosis'])
      expect(key in part).toBe(false);
    const bare = reportPart(report, ['diagnosis']);
    expect(bare.incident).toEqual({
      id: 'inc_catalogue01',
      projectId: 'catalogue',
      title: report.incident.title,
      severity: 'HIGH',
      state: 'DIAGNOSED',
    });
    expect(bare.diagnosis?.status).toBe('PROBABLE');
    // Une section demandée mais vide n'invente rien : pas de graphe construit, pas de clé.
    expect('graph' in reportPart(report, ['graph'])).toBe(false);
  });

  it('Markdown: only the chosen sections, always the limitations', () => {
    const markdown = reportMarkdown(report, ['requests']);
    expect(markdown).toContain('## Requêtes');
    expect(markdown).toContain('## Limites');
    for (const title of [
      '## Incident',
      '## Environnement',
      '## Chronologie',
      '## Diagnostic',
      '## Hypothèses',
    ])
      expect(markdown).not.toContain(title);
    expect(reportMarkdown(report)).toContain('## Diagnostic');
    expect(reportMarkdown(report)).toBe(reportMarkdown(report, REPORT_SECTIONS));
  });
});

describe('report HTML', () => {
  it('is a standalone document: inline styles, no script, no external resource, everything escaped', () => {
    const html = reportHtml(report);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<style>');
    expect(html).toContain(`content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"`);
    // Aucune balise active ni ressource : le texte « src=x onerror=… » reste du texte échappé.
    expect(html).not.toMatch(/<(script|img|link|iframe|object|embed|svg)\b|\s(src|href)="/i);
    expect(html).toContain('Erreur &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;500&quot;');
    expect(html).toContain('&lt;/pre&gt;&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('BFF &lt;livres&gt;');
    expect(html).toContain('Mémoire maximale (Mio)');
    // Jamais « confirmée » quand le diagnostic ne l'est pas.
    expect(html).toContain('Cause racine (non confirmée)');
    expect(escapeHtml(`a'b`)).toBe('a&#39;b');
  });

  it('renders only the chosen sections', () => {
    const html = reportHtml(report, ['timeline']);
    expect(html).toContain('id="timeline"');
    expect(html).toContain('id="limitations"');
    for (const section of REPORT_SECTIONS.filter((entry) => entry !== 'timeline'))
      expect(html).not.toContain(`id="${section}"`);
  });
});

/** Chromium installé pour Playwright (PLAYWRIGHT_BROWSERS_PATH ou le cache par défaut) ? */
async function chromiumInstalled(): Promise<boolean> {
  try {
    const { chromium } = await import('playwright');
    await access(chromium.executablePath(), constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

describe('report PDF', () => {
  it('prints the HTML with headless Chromium, or says it is unavailable (never a fake PDF)', async () => {
    const html = reportHtml(report, ['summary']);
    if (await chromiumInstalled()) {
      const pdf = await renderPdf(html, { timeoutMs: 60_000 });
      expect(Buffer.from(pdf).subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(pdf.byteLength).toBeGreaterThan(1000);
    } else {
      await expect(renderPdf(html, { timeoutMs: 10_000 })).rejects.toBeInstanceOf(PdfUnavailableError);
    }
  }, 90_000);
});

// ── Le service et les routes ──────────────────────────────────────────────────────────────────

const LIBRARY_YAML = `flows:
  - name: creer-livre
    startAt: /books/new
    steps:
      - fill:
          label: Titre
          value: Le Petit Atlas
      - click:
          role: button
          name: Enregistrer
        allow: MUTATION
`;

let projectDir: string;
let service: IncidentService;
let printed: string[] = [];
let pdfFailure: Error | undefined;

beforeAll(async () => {
  projectDir = await mkdtemp(path.join(tmpdir(), 'incident-report-export-'));
  const host: IncidentHost = {
    projectId: 'catalogue',
    projectDir,
    replay: () => Promise.reject(new Error('no replay in this test')),
    scenarioYaml: (name) =>
      Promise.resolve(name === 'creer-livre' ? { file: 'books.flow.yaml', text: LIBRARY_YAML } : undefined),
    addScenario: () => Promise.reject(new Error('no library in this test')),
    environment: () => Promise.resolve({ baseUrl: 'http://catalogue.test/' }),
    runDir: (run) => path.join(projectDir, 'reports', run),
  };
  service = new IncidentService(host, {
    pdf: (html) => {
      if (pdfFailure) return Promise.reject(pdfFailure);
      printed.push(html);
      return Promise.resolve(new Uint8Array(Buffer.from('%PDF-1.7 fake for the test')));
    },
  });
});

afterAll(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

const declare = () =>
  service.create(
    {
      title: 'Erreur 500 <livre>',
      description: 'd',
      observed: 'erreur HTTP 500',
      expected: 'le livre est créé',
      severity: 'HIGH',
      scenario: 'creer-livre',
    },
    'alice',
  );

describe('IncidentService — exports', () => {
  it('prints the HTML of the chosen sections and returns the PDF in base64', async () => {
    printed = [];
    const incident = await declare();
    const { pdfBase64 } = await service.reportPdf(incident.id, ['summary', 'diagnosis']);
    expect(Buffer.from(pdfBase64, 'base64').toString('latin1')).toMatch(/^%PDF-/);
    expect(printed).toHaveLength(1);
    expect(printed[0]).toContain('id="summary"');
    expect(printed[0]).not.toContain('id="requests"');
    expect(printed[0]).toContain('Erreur 500 &lt;livre&gt;');
  });

  it('generates the Playwright TypeScript test of the proposed regression flow, with the real verdict', async () => {
    const incident = await declare();
    await expect(service.regressionSpec(incident.id)).rejects.toThrow(/no regression test proposed/);
    await service.store.mutate(
      incident.id,
      'alice',
      (current) => {
        current.investigation.regression = proposeRegressionTest({
          incident: current,
          scenarioName: 'creer-livre',
          scenarioYaml: LIBRARY_YAML,
        });
      },
      { kind: 'REGRESSION', message: 'proposed' },
    );
    const spec = await service.regressionSpec(incident.id);
    expect(spec.language).toBe('typescript');
    expect(spec.fileName).toMatch(/\.spec\.ts$/);
    expect(spec.baseUrl).toBe('http://catalogue.test/');
    expect(spec.code).toContain("import { test, expect } from '@playwright/test';");
    expect(spec.code).toContain('await page.goto("http://catalogue.test/books/new");');
    expect(spec.code).toContain('Run status at generation time: not executed.');
    expect(spec.steps).toBeGreaterThan(2);

    // Après une exécution réelle (son résultat est dans le dossier du run) : le verdict du moteur.
    const proposal = (await service.incident(incident.id)).investigation.regression;
    await mkdir(path.join(projectDir, 'reports', 'run-1'), { recursive: true });
    await writeFile(
      path.join(projectDir, 'reports', 'run-1', 'result.json'),
      JSON.stringify({
        flows: [
          { name: proposal?.name, status: 'FAILED', steps: [], states: [], issueIds: [], explored: false },
        ],
      }),
    );
    await service.store.mutate(
      incident.id,
      'alice',
      (current) => {
        if (current.investigation.regression)
          current.investigation.regression.execution = {
            run: 'run-1',
            passed: false,
            at: '2026-10-30T12:00:00Z',
          };
      },
      { kind: 'REGRESSION', message: 'executed' },
    );
    expect((await service.regressionSpec(incident.id)).code).toContain(
      'Run status at generation time: FAILED.',
    );
  });
});

describe('report route — formats, sections, PDF availability', () => {
  const call = async (
    query: string,
    fake: Partial<Record<'report' | 'reportPart' | 'reportMarkdown' | 'reportHtml' | 'reportPdf', unknown>>,
  ): Promise<{ status: number; code?: string; body?: unknown }> => {
    let body: unknown;
    let status = 200;
    const ctx: IncidentRouteContext = {
      service: fake as never,
      rest: ['inc_catalogue01', 'report'],
      method: 'GET',
      url: new URL(`http://localhost/api/projects/p/incidents/inc_catalogue01/report${query}`),
      actor: 'alice',
      body: () => Promise.resolve({}),
      json: (value, code = 200) => {
        body = value;
        status = code;
      },
      canWrite: false,
      fail: (code, error, message) => Object.assign(new Error(message), { status: code, code: error }),
    };
    try {
      await handleIncidentRoutes(ctx);
      return { status, body };
    } catch (error) {
      const failure = error as { status: number; code: string };
      return { status: failure.status, code: failure.code };
    }
  };

  it('answers 501 PDF_UNAVAILABLE without Chromium and 504 PDF_TIMEOUT beyond the delay', async () => {
    const unavailable = await call('?format=pdf', {
      reportPdf: () => Promise.reject(new PdfUnavailableError('Chromium cannot be started')),
    });
    expect(unavailable).toEqual({ status: 501, code: 'PDF_UNAVAILABLE' });
    const late = await call('?format=pdf', { reportPdf: () => Promise.reject(new PdfTimeoutError(10)) });
    expect(late).toEqual({ status: 504, code: 'PDF_TIMEOUT' });
    pdfFailure = new PdfUnavailableError('none');
    const incident = await declare();
    await expect(service.reportPdf(incident.id)).rejects.toBeInstanceOf(PdfUnavailableError);
    pdfFailure = undefined;
  });

  it('passes the sections in report order, and each format its own shape', async () => {
    let asked: ReportSection[] | undefined;
    const fake = {
      report: () => Promise.resolve({ whole: true }),
      reportPart: (_id: string, sections: ReportSection[]) => {
        asked = sections;
        return Promise.resolve({ sections });
      },
      reportMarkdown: (_id: string, sections?: ReportSection[]) => {
        asked = sections;
        return Promise.resolve('# md');
      },
      reportHtml: () => Promise.resolve('<!doctype html>'),
      reportPdf: () => Promise.resolve({ pdfBase64: 'JVBERi0=' }),
    };
    expect((await call('', fake)).body).toEqual({ whole: true });
    expect((await call('?sections=regression,%20summary', fake)).body).toEqual({
      sections: ['summary', 'regression'],
    });
    expect((await call('?format=markdown&sections=requests', fake)).body).toEqual({ markdown: '# md' });
    expect(asked).toEqual(['requests']);
    expect((await call('?format=html', fake)).body).toEqual({ html: '<!doctype html>' });
    expect((await call('?format=pdf', fake)).body).toEqual({ pdfBase64: 'JVBERi0=' });
  });

  it('refuses an unknown format and bad sections (400)', async () => {
    const fake = { report: () => Promise.resolve({}) };
    for (const query of [
      '?format=xml',
      '?format=PDF',
      '?sections=',
      '?sections=summary,secrets',
      '?sections=,,',
    ])
      expect(await call(query, fake)).toEqual({ status: 400, code: 'BAD_REQUEST' });
  });
});

describe('report through the SDK client and the server', () => {
  it('json with sections, markdown, html, pdf (or 501 PDF_UNAVAILABLE), bad sections refused', async () => {
    const { startSdkServer } = await import('../../src/sdk/server/server.js');
    const { createQaCrawler, QaCrawlerError } = await import('../../src/sdk/core/index.js');
    const { engineDefaults } = await import('../../src/sdk/server/project.js');
    const workspace = await mkdtemp(path.join(tmpdir(), 'incident-report-sdk-'));
    const server = await startSdkServer({ workspace, language: 'fr', env: {} });
    const client = createQaCrawler({ endpoint: `${server.url}/api`, token: server.token });
    try {
      const project = await client.projects.create({
        ...engineDefaults(),
        project: { name: 'Catalogue', targetUrl: 'http://127.0.0.1:9/', framework: 'other' },
      });
      const incident = await client.incidents.create(project.id, {
        title: 'Erreur <500>',
        description: 'd',
        observed: 'o',
        expected: 'e',
        severity: 'HIGH',
      });
      const whole = await client.incidents.report(project.id, incident.id);
      expect(whole.requests).toEqual([]);
      const part = await client.incidents.report(project.id, incident.id, {
        sections: ['diagnosis', 'summary'],
      });
      expect(part.sections).toEqual(['summary', 'diagnosis']);
      expect('requests' in part).toBe(false);
      const { markdown } = await client.incidents.report(project.id, incident.id, {
        format: 'markdown',
        sections: ['summary'],
      });
      expect(markdown).toContain('## Incident');
      expect(markdown).not.toContain('## Requêtes');
      const { html } = await client.incidents.report(project.id, incident.id, { format: 'html' });
      expect(html).toContain('Erreur &lt;500&gt;');
      const pdf = await client.incidents
        .report(project.id, incident.id, { format: 'pdf', sections: ['summary'] })
        .then(
          (body) => Buffer.from(body.pdfBase64, 'base64').subarray(0, 5).toString('latin1'),
          (error: unknown) =>
            error instanceof QaCrawlerError ? `${String(error.status)} ${error.code}` : 'other',
        );
      expect(pdf).toBe((await chromiumInstalled()) ? '%PDF-' : '501 PDF_UNAVAILABLE');
      await expect(
        client.incidents.report(project.id, incident.id, { sections: ['secrets' as ReportSection] }),
      ).rejects.toMatchObject({ status: 400, code: 'BAD_REQUEST' });
    } finally {
      client.dispose();
      await server.close();
      await rm(workspace, { recursive: true, force: true });
    }
  }, 90_000);
});
