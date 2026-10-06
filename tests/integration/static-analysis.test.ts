import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { chromium } from 'playwright';
import { parseConfig } from '../../src/config/config-loader.js';
import { runDryRun } from '../../src/dry-run/dry-run-orchestrator.js';
import { playwrightFetcher, runtimeScriptUrls } from '../../src/static-analysis/bundle.js';
import { RuntimeBundleSourceProvider } from '../../src/static-analysis/sources/source-providers.js';
import { StaticSourceDiscovery } from '../../src/static-analysis/sources/source-discovery.js';
import { StaticApplicationAnalyzer } from '../../src/static-analysis/static-analyzer.js';
import { staticAnalyzerOptions } from '../helpers.js';
import type { ExplorationResult } from '../../src/model/exploration-result.js';
import { runMission } from '../../src/orchestrator.js';

const FIXTURE = path.resolve('tests/fixtures/static-apps/angular');

/**
 * Le rendu de CreateUserComponent tel qu'Angular le produit : trois champs sans libellé,
 * sans aria-label, sans placeholder, sans name — seulement formcontrolname. La page
 * affiche ce qui est tapé dans « contact » pour que le test vérifie le bon champ.
 */
const PAGE = `<!doctype html><html><body>
<h1>Nouvel utilisateur</h1>
<form>
  <input type="text" formcontrolname="firstName">
  <input type="text" formcontrolname="contact">
  <input type="tel" formcontrolname="phone">
  <button type="submit">Enregistrer</button>
</form>
<p id="echo"></p>
<script>
  document.querySelector('form').addEventListener('submit', (event) => event.preventDefault());
  const contact = document.querySelector('[formcontrolname="contact"]');
  contact.addEventListener('input', () => { document.getElementById('echo').textContent = 'contact=' + contact.value; });
</script>
</body></html>`;

const FEATURE = `# language: fr
Fonctionnalité: Utilisateurs
  Scénario: Le courriel d'un nouvel utilisateur
    Étant donné que je suis sur "/administration/users/new"
    Quand je renseigne le courriel avec "test@example.com"
    Alors je vois "contact=test@example.com"
`;

describe('static analysis end to end (Chromium): a mute input resolved by the code', () => {
  let server: Server;
  let url: string;
  let dir: string;

  const run = async (staticEnabled: boolean): Promise<{ result: ExplorationResult; reports: string }> => {
    const reports = await mkdtemp(path.join(dir, 'run-'));
    const { config } = parseConfig(
      `
mission: { name: static-e2e }
target: { baseUrl: ${url}, startAt: /administration/users/new }
exploration: { autonomous: false, actionTimeoutMs: 3000, settleTimeMs: 50 }
gherkin: { semanticResolution: { enabled: true } }
openapi: { enabled: true, source: ${path.join(FIXTURE, 'openapi.yaml')} }
staticAnalysis:
  enabled: ${String(staticEnabled)}
  source: { root: ${FIXTURE} }
flows:
  - gherkin: ${path.join(dir, 'courriel.feature')}
  - name: yaml-courriel
    startAt: /administration/users/new
    steps:
      - fill: { label: courriel, value: yaml@example.test }
      - expect: { text: contact=yaml@example.test }
report: { failOnSeverity: NONE }
output:
  reportsDir: ${path.join(reports, 'reports')}
  screenshotsDir: ${path.join(reports, 'screenshots')}
`,
      {},
      {},
    );
    return { result: (await runMission(config)).result, reports };
  };

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'qa-static-e2e-'));
    await writeFile(path.join(dir, 'courriel.feature'), FEATURE);
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(PAGE);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('Gherkin « je renseigne le courriel » and flow.yaml « fill: courriel » both select the contact input, explained', async () => {
    const { result, reports } = await run(true);
    const gherkin = result.flows.find((flow) => flow.name.includes('courriel'));
    expect(gherkin?.status).toBe('PASSED');
    const step = gherkin?.steps.find((entry) => entry.kind === 'intent');
    const explanation = step?.resolution?.explanation?.join('\n') ?? '';
    expect(explanation).toContain('static evidence means email');
    expect(explanation).toContain('contact → request.email → CreateUserRequest.email → POST /api/users');
    expect(explanation).toContain('format=email');

    const yaml = result.flows.find((flow) => flow.name === 'yaml-courriel');
    expect(yaml?.status).toBe('PASSED');
    expect(yaml?.steps[0]?.interpretation).toContain('no element labelled "courriel": resolved as an intent');

    // Rapport : la connaissance statique a servi, le champ est confirmé par l'exécution.
    expect(result.staticAnalysis).toMatchObject({ status: 'USED', framework: 'ANGULAR', mode: 'SOURCE' });
    expect(result.staticAnalysis?.confirmedFields).toContain('CreateUserComponent#contact');
    const html = await readFile(path.join(reports, 'reports', 'index.html'), 'utf8');
    expect(html).toContain('Static analysis (application code)');

    // Journal du moteur : analyse (cache), preuve confirmée à l'exécution ; jamais un secret.
    const log = await findLog(reports);
    expect(log).toContain('STATIC_ANALYSIS_COMPLETED');
    expect(log).toContain('SEMANTIC_EVIDENCE_ADDED');
    expect(log).not.toContain('fixture-constant-not-a-real-key');
  });

  it('staticAnalysis disabled (non-regression): the same sentence is not resolved on three mute inputs', async () => {
    const { result } = await run(false);
    const gherkin = result.flows.find((flow) => flow.name.includes('courriel'));
    expect(gherkin?.status).not.toBe('PASSED');
  });
});

async function findLog(root: string): Promise<string> {
  const entries = await readdir(root, { recursive: true });
  const file = entries.find((entry) => entry.endsWith('engine-log.jsonl'));
  return file ? readFile(path.join(root, file), 'utf8') : '';
}

/** Le tableau de bord : trois liens ; seul « Administration » mène à « Users ». */
const pages: Record<string, string> = {
  '/dashboard':
    '<h1>Dashboard</h1><a href="/accueil">Accueil</a> <a href="/actualites">Actualités</a> <a href="/administration">Administration</a>',
  '/accueil': '<h1>Accueil</h1><a href="/aide">Aide</a>',
  '/actualites': '<h1>Actualités</h1><a href="/aide">Archives</a>',
  '/aide': '<h1>Aide</h1>',
  '/administration': '<h1>Administration</h1><a href="/administration/users">Users</a>',
  '/administration/users': '<h1>Users list</h1>',
};

describe('static analysis end to end (Chromium): Dry Run guided by the routes, confirmed by the UI', () => {
  let server: Server;
  let url: string;

  beforeAll(async () => {
    server = createServer((request, response) => {
      const body = pages[(request.url ?? '/').split('?')[0] ?? '/'];
      response.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><body>${body ?? 'not found'}</body></html>`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const dryRun = async (staticEnabled: boolean): Promise<{ rows: string[]; reasons: string }> => {
    const dir = await mkdtemp(path.join(tmpdir(), 'qa-static-dry-run-'));
    await writeFile(
      path.join(dir, 'users.flow.yaml'),
      `name: Aller aux utilisateurs
steps:
  - goto: /dashboard
  - click: { text: Users }
  - expect: { text: Users list }
`,
    );
    await writeFile(
      path.join(dir, 'mission.yaml'),
      `mission: { name: static-dry-run }
target: { baseUrl: ${url}, startAt: /dashboard }
exploration: { actionTimeoutMs: 3000, settleTimeMs: 50 }
dryRun: { maxAlternativePaths: 2 }
staticAnalysis: { enabled: ${String(staticEnabled)}, source: { root: ${FIXTURE} } }
report: { failOnSeverity: NONE }
output: { reportsDir: ${path.join(dir, 'reports')} }
`,
    );
    const result = await runDryRun({
      scenarioFile: path.join(dir, 'users.flow.yaml'),
      missionFile: path.join(dir, 'mission.yaml'),
      isolatedMemory: true,
    });
    const entries = result.flows[0]?.reconciliation.entries ?? [];
    return {
      rows: entries.map(
        (entry) => `${entry.expectedIntent?.label ?? entry.observedTarget?.label ?? '?'} ${entry.status}`,
      ),
      reasons: entries.flatMap((entry) => entry.reasons).join(' '),
    };
  };

  it('the code suggests Dashboard → Administration → Users; Administration is clicked for real, then Users is found', async () => {
    const { rows, reasons } = await dryRun(true);
    expect(rows).toEqual(
      expect.arrayContaining(['Administration INSERTED', 'Users MATCHED', 'Users list MATCHED']),
    );
    expect(reasons).toContain('path suggested by the application code');
    expect(reasons).toContain('confirmed at runtime: Administration');
  }, 120_000);

  it('without static analysis (non-regression): same reconciliation, no static hint', async () => {
    const { rows, reasons } = await dryRun(false);
    expect(rows).toEqual(expect.arrayContaining(['Administration INSERTED', 'Users MATCHED']));
    expect(reasons).not.toContain('application code');
  }, 120_000);
});

describe('source maps: from a deployed URL only, the mute contact input is resolved as EMAIL', () => {
  let server: Server;
  let url: string;
  let dir: string;
  let sources: Record<string, string>;
  const MARKER = 'UNIQUE_SOURCE_BODY_MARKER_e2e';
  const files = [
    'src/app/users/create-user/create-user.component.ts',
    'src/app/users/create-user/create-user.component.html',
    'src/app/users/user.service.ts',
    'src/app/users/user.models.ts',
  ];

  /** Micro-frontend : le code de l'application servi par un autre hôte (localhost) que la page. */
  let remoteMode = false;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'qa-sourcemap-e2e-'));
    await writeFile(path.join(dir, 'courriel.feature'), FEATURE);
    sources = Object.fromEntries(
      await Promise.all(
        files.map(async (file) => [file, await readFile(path.join(FIXTURE, file), 'utf8')] as const),
      ),
    );
    const map = JSON.stringify({
      version: 3,
      sources: [
        ...files.map((file) => `webpack:///./${file}`),
        'webpack:///./node_modules/@angular/core/fesm2022/core.mjs',
      ],
      sourcesContent: [
        ...files.map((file) => `${sources[file] ?? ''}\n// ${MARKER}`),
        'export const ignored = 1;',
      ],
      mappings: '',
    });
    const lazyMap = JSON.stringify({
      version: 3,
      sources: ['webpack:///./src/app/reports/reports.component.ts'],
      sourcesContent: ['export class ReportsComponent {}'],
      mappings: '',
    });
    // Le déploiement : la page, son bundle (avec sourceMappingURL), la source map, et
    // un chunk chargé plus tard (route à la demande). Aucun accès au dépôt.
    const page = PAGE.replace(
      '</body>',
      '<script src="/main.js"></script><script>setTimeout(() => { const s = document.createElement("script"); s.src = "/chunk-reports.js"; document.body.appendChild(s); }, 50);</script></body>',
    );
    server = createServer((request, response) => {
      const route = request.url ?? '/';
      if (route === '/main.js') {
        response.writeHead(200, { 'content-type': 'application/javascript' });
        response.end('console.log("app");\n//# sourceMappingURL=main.js.map\n');
      } else if (route === '/main.js.map') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(map);
      } else if (route === '/chunk-reports.js') {
        response.writeHead(200, { 'content-type': 'application/javascript' });
        response.end('console.log("reports");\n//# sourceMappingURL=chunk-reports.js.map\n');
      } else if (route === '/chunk-reports.js.map') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(lazyMap);
      } else if (route === '/plain.js') {
        response.writeHead(200, { 'content-type': 'application/javascript' });
        response.end('class a{constructor(t){this.http=t}create(e){return this.http.post("/api/users",e)}}');
      } else if (route === '/plain') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(
          '<!doctype html><html><body><h1>App</h1><script src="/plain.js"></script></body></html>',
        );
      } else if (remoteMode) {
        // Micro-frontend : le code de l'application est servi par un AUTRE hôte que la page.
        const port = String((server.address() as AddressInfo).port);
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(
          PAGE.replace('</body>', `<script src="http://localhost:${port}/main.js"></script></body>`),
        );
      } else {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(page);
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('runtime bundles → source map → sourcesContent → virtual workspace → existing analyzer → contact = EMAIL', async () => {
    const reports = await mkdtemp(path.join(dir, 'run-'));
    const { config } = parseConfig(
      `
mission: { name: sourcemap-e2e }
target: { baseUrl: ${url}, startAt: /administration/users/new }
exploration: { autonomous: false, actionTimeoutMs: 3000, settleTimeMs: 50 }
gherkin: { semanticResolution: { enabled: true } }
staticAnalysis:
  enabled: true
  mode: auto
  cache: { enabled: false }
flows:
  - gherkin: ${path.join(dir, 'courriel.feature')}
report: { failOnSeverity: NONE }
output:
  reportsDir: ${path.join(reports, 'reports')}
  screenshotsDir: ${path.join(reports, 'screenshots')}
`,
      {},
      {},
    );
    const { result } = await runMission(config);
    const gherkin = result.flows.find((flow) => flow.name.includes('courriel'));
    expect(gherkin?.status).toBe('PASSED');
    const explanation =
      gherkin?.steps.find((entry) => entry.kind === 'intent')?.resolution?.explanation?.join('\n') ?? '';
    expect(explanation).toContain('static evidence means email');
    expect(explanation).toContain('contact → request.email → CreateUserRequest.email → POST /api/users');
    expect(explanation).toContain(`[code from SOURCE_MAP ${url}/main.js.map]`);

    expect(result.staticAnalysis).toMatchObject({ status: 'USED', framework: 'ANGULAR', mode: 'SOURCE_MAP' });
    expect(result.staticAnalysis?.confirmedFields).toContain('CreateUserComponent#contact');
    const discovery = result.staticAnalysis?.discovery;
    expect(discovery).toMatchObject({ strategy: 'auto', origins: ['SOURCE_MAP'] });
    expect(discovery?.sourceMaps.loaded).toBeGreaterThanOrEqual(1);
    expect(discovery?.extractedSources).toBeGreaterThanOrEqual(files.length);
    expect(discovery?.entries.find((entry) => entry.url === `${url}/main.js`)).toMatchObject({
      status: 'SOURCE_MAP',
      sourceMap: `${url}/main.js.map`,
      extracted: files.length,
    });

    // Le code source n'apparaît NULLE PART : rapport HTML, result.json, journal.
    const html = await readFile(path.join(reports, 'reports', 'index.html'), 'utf8');
    expect(html).toContain('Static source discovery');
    const log = await findLog(reports);
    expect(log).toContain('SOURCE_MAP_LOADED');
    expect(log).toContain('VIRTUAL_WORKSPACE_CREATED');
    const everything = [html, log, JSON.stringify(result)].join('\n');
    expect(everything).not.toContain(MARKER);
    expect(everything).not.toContain('fixture-constant-not-a-real-key');
  }, 120_000);

  it('MICRO-FRONTEND: the application code served by another host is read only when that host is allowed for reading (staticAnalysis.bundle.allowedHosts) — never navigated', async () => {
    const run = async (allowed: string) => {
      const reports = await mkdtemp(path.join(dir, 'remote-'));
      const { config } = parseConfig(
        `
mission: { name: sourcemap-remote }
target: { baseUrl: ${url}, startAt: /administration/users/new }
exploration: { autonomous: false, actionTimeoutMs: 3000, settleTimeMs: 50 }
gherkin: { semanticResolution: { enabled: true } }
flows:
  - gherkin: ${path.join(dir, 'courriel.feature')}
staticAnalysis:
  enabled: true
  mode: auto
  cache: { enabled: false }
  bundle: { allowedHosts: [${allowed}] }
report: { failOnSeverity: NONE }
output:
  reportsDir: ${path.join(reports, 'reports')}
  screenshotsDir: ${path.join(reports, 'screenshots')}
`,
        {},
        {},
      );
      return (await runMission(config)).result;
    };
    const remote = `${url.replace('127.0.0.1', 'localhost')}/main.js`;
    remoteMode = true;
    onTestFinished(() => {
      remoteMode = false;
    });
    const blocked = await run('');
    const skipped = blocked.staticAnalysis?.discovery?.entries.find((entry) => entry.url === remote);
    expect(skipped).toMatchObject({ status: 'SKIPPED' });
    expect(skipped?.reason).toMatch(
      /^origin not allowed: localhost \(add it to staticAnalysis\.bundle\.allowedHosts/,
    );
    const read = await run('localhost');
    expect(read.staticAnalysis?.discovery?.entries.find((entry) => entry.url === remote)).toMatchObject({
      status: 'SOURCE_MAP',
    });
    // Le seul code de l'application vient de l'autre hôte : c'est lui qui a été analysé.
    expect(read.staticAnalysis?.discovery?.entries.map((entry) => new URL(entry.url).hostname)).toEqual([
      'localhost',
    ]);
    expect(read.staticAnalysis?.confirmedFields).toContain('CreateUserComponent#contact');
    // Lire n'est pas naviguer : aucun état visité sur l'autre hôte.
    expect(JSON.stringify(read.states)).not.toContain('localhost');
  }, 120_000);

  const runtimeWorkspace = async (pagePath: string, lazyWait = 0) => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(`${url}${pagePath}`);
      if (lazyWait) await page.waitForTimeout(lazyWait);
      const runtime = new RuntimeBundleSourceProvider({
        fetch: playwrightFetcher(page),
        isAllowedUrl: (candidate) => new URL(candidate).hostname === '127.0.0.1',
        sourceMaps: { enabled: true, inline: true, external: true },
        bundleFallback: true,
        budgets: {
          maxBundles: 50,
          maxSourceMaps: 50,
          maxSourceMapBytes: 20_000_000,
          maxFileSizeBytes: 2_000_000,
        },
      });
      for (const script of await runtimeScriptUrls(page)) runtime.observe(script);
      const discovery = new StaticSourceDiscovery({
        strategy: 'auto',
        runtime,
        workspace: { maxExtractedSources: 100, maxFileSizeBytes: 2_000_000 },
        settingsKey: '',
      });
      await discovery.prepare();
      await discovery.complete();
      return discovery;
    } finally {
      await browser.close();
    }
  };

  it('the scripts the browser loaded (lazy chunk included) are read through the browser session', async () => {
    const discovery = await runtimeWorkspace('/administration/users/new', 300);
    expect(
      discovery.workspace
        .toSourceSet()
        .files.map((file) => file.path)
        .sort(),
    ).toEqual([...files, 'src/app/reports/reports.component.ts'].sort());
    expect(discovery.analysisMode()).toBe('SOURCE_MAP');
  }, 60_000);

  it('without a source map: the bundle itself (minified, no original names), LIMITED — still no exception', async () => {
    const discovery = await runtimeWorkspace('/plain');
    expect(discovery.workspace.toSourceSet().files.map((file) => file.path)).toEqual(['bundle/plain.js']);
    expect(discovery.analysisMode()).toBe('BUNDLE');
    const { graph } = await new StaticApplicationAnalyzer(staticAnalyzerOptions()).analyzeSet(
      discovery.workspace.toSourceSet(),
      discovery.analysisMode(),
    );
    expect(graph.coverage).toBe('LIMITED');
    expect(graph.apiCalls.map((call) => `${call.method} ${call.route}`)).toContain('POST /api/users');
  }, 60_000);
});
