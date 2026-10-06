import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cp, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ScenarioConfig } from '../../src/config/config.js';
import { parseConfig } from '../../src/config/config-loader.js';
import { prepareGitSources } from '../../src/static-analysis/sources/prepared-source.js';
import type { ExplorationResult } from '../../src/model/exploration-result.js';
import { runMission } from '../../src/orchestrator.js';

const FIXTURE = path.resolve('tests/fixtures/static-apps/angular');

/** Trois champs muets (formcontrolname seulement) : seul le code de l'application dit lequel est le courriel. */
const PAGE = `<!doctype html><html><body>
<h1>New user</h1>
<form>
  <input type="text" formcontrolname="firstName">
  <input type="text" formcontrolname="contact">
  <input type="tel" formcontrolname="phone">
  <button type="submit">Save</button>
</form>
<p id="echo"></p>
<script>
  document.querySelector('form').addEventListener('submit', (event) => event.preventDefault());
  const contact = document.querySelector('[formcontrolname="contact"]');
  contact.addEventListener('input', () => { document.getElementById('echo').textContent = 'contact=' + contact.value; });
</script>
</body></html>`;

/**
 * GIT SOURCE : l'analyse statique lit le code depuis le DÉPÔT git de l'application (clone léger,
 * lecture seule), sans `source.root` local ni source map — le champ muet est résolu par ce code.
 * Par défaut (`gitFetch: command`), récupération et analyse sont faites par `qa-crawler sources`,
 * une fois : le run lit la connaissance préparée, sans git ni lecture du code.
 */
describe('static analysis from the git repository of the application (Chromium)', () => {
  let server: Server;
  let url: string;
  let dir: string;

  const mission = (git: string, sources: string, extra = ''): string => `
mission: { name: static-git }
target: { baseUrl: ${url}, startAt: /administration/users/new }
exploration: { autonomous: false, actionTimeoutMs: 3000, settleTimeMs: 50 }
gherkin: { semanticResolution: { enabled: true } }
openapi: { enabled: true, source: ${path.join(FIXTURE, 'openapi.yaml')} }
staticAnalysis:
  enabled: true
  source:
    git: ${git}
    gitDirectory: ${sources}
${extra}
flows:
  - name: yaml-email
    startAt: /administration/users/new
    steps:
      - fill: { label: courriel, value: git@example.test }
      - expect: { text: contact=git@example.test }
report: { failOnSeverity: NONE }
output:
  reportsDir: REPORTS/reports
  screenshotsDir: REPORTS/screenshots
`;
  const configOf = (text: string, reports: string): ScenarioConfig =>
    parseConfig(text.replaceAll('REPORTS', reports), {}, {}).config;
  const run = async (text: string): Promise<{ result: ExplorationResult; reports: string; log: string }> => {
    const reports = await mkdtemp(path.join(dir, 'run-'));
    const { result } = await runMission(configOf(text, reports), { env: {} });
    return { result, reports, log: await findLog(reports) };
  };
  const flowStatus = (result: ExplorationResult): string | undefined =>
    result.flows.find((entry) => entry.name === 'yaml-email')?.status;

  /** Le dépôt de l'application : le code Angular dans un sous-dossier, comme un mono-repo. */
  const repositoryOf = async (name: string): Promise<string> => {
    const repository = path.join(dir, name);
    await cp(FIXTURE, path.join(repository, 'frontend'), { recursive: true });
    const git = (...args: string[]): void => {
      execFileSync('git', ['-c', 'user.email=qa@example.test', '-c', 'user.name=qa', ...args], {
        cwd: repository,
        stdio: 'ignore',
      });
    };
    git('init', '-q', '-b', 'main');
    git('add', '.');
    git('commit', '-q', '-m', 'app');
    return repository;
  };

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'qa-static-git-'));
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

  it('`sources` prepares the code once; the run reads the prepared knowledge — no git, no source read (repository and clones deleted)', async () => {
    const repository = await repositoryOf('prepared-repo');
    const sources = path.join(dir, 'prepared-sources');
    const text = mission(
      JSON.stringify({ url: `file://${repository}`, ref: 'main', path: 'frontend' }),
      sources,
    );
    const prepared = await prepareGitSources({ config: configOf(text, dir), env: {} });
    expect(prepared.knowledge?.graph.fields.length).toBeGreaterThan(0);
    // Plus de dépôt, plus de clone : seule la connaissance préparée reste.
    await rm(repository, { recursive: true, force: true });
    for (const entry of await readdir(sources))
      if (!entry.endsWith('.knowledge.json')) await rm(path.join(sources, entry), { recursive: true });

    const { result, log } = await run(text);
    expect(flowStatus(result), JSON.stringify(result.flows[0]?.steps.map((step) => step.reason))).toBe(
      'PASSED',
    );
    expect(result.staticAnalysis).toMatchObject({ status: 'USED', framework: 'ANGULAR', mode: 'SOURCE' });
    expect(result.staticAnalysis?.confirmedFields).toContain('CreateUserComponent#contact');
    expect(log).toMatch(/GIT_SOURCE_PREPARED[^\n]*prepared-repo \(main\) @ [0-9a-f]{12}/);
    expect(log).not.toContain('GIT_SOURCE_FETCHED');
  }, 180_000);

  it('not prepared: the run says so (run `qa-crawler sources`), never fetches, and continues without the code', async () => {
    const repository = await repositoryOf('unprepared-repo');
    const { result, log } = await run(
      mission(JSON.stringify({ url: `file://${repository}` }), path.join(dir, 'unprepared-sources')),
    );
    expect(result.flows).toHaveLength(1);
    expect(result.staticAnalysis?.status).not.toBe('USED');
    expect(log).toMatch(/GIT_SOURCE_NOT_PREPARED[^\n]*qa-crawler sources/);
    expect(log).not.toContain('GIT_SOURCE_FETCHED');
  }, 180_000);

  it('gitFetch: run — the repository is cloned (ref + path) and analysed at the start of the run; the next run updates the clone', async () => {
    const repository = await repositoryOf('run-repo');
    const sources = path.join(dir, 'run-sources');
    const text = mission(
      JSON.stringify({ url: `file://${repository}`, ref: 'main', path: 'frontend' }),
      sources,
    ).replace('    gitDirectory:', '    gitFetch: run\n    gitDirectory:');
    const { result } = await run(text);
    expect(flowStatus(result)).toBe('PASSED');
    expect(result.staticAnalysis).toMatchObject({ status: 'USED', framework: 'ANGULAR', mode: 'SOURCE' });
    // Un dossier par ensemble de dépôts, le clone dedans ; le run suivant le met à jour (pas de re-clone).
    const sets = await readdir(sources);
    expect(sets).toHaveLength(1);
    expect(await readdir(path.join(sources, sets[0] ?? ''))).toHaveLength(1);

    const again = await run(text);
    expect(flowStatus(again.result)).toBe('PASSED');
    expect(again.log).toMatch(/GIT_SOURCE_FETCHED[^\n]*updated/);
  }, 180_000);

  it('gitFetch: run — a repository that cannot be read: the run continues without the code, the reason is reported', async () => {
    const text = mission(
      JSON.stringify({ url: `file://${path.join(dir, 'missing-repo')}` }),
      path.join(dir, 'missing-sources'),
    ).replace('    gitDirectory:', '    gitFetch: run\n    gitDirectory:');
    const { result, log } = await run(text);
    expect(result.flows).toHaveLength(1);
    expect(result.staticAnalysis?.status).not.toBe('USED');
    expect(log).toMatch(/GIT_SOURCE_FAILED[^\n]*fatal:/);
  }, 180_000);
});

async function findLog(root: string): Promise<string> {
  const entries = await readdir(root, { recursive: true });
  const file = entries.find((entry) => entry.endsWith('engine-log.jsonl'));
  return file ? readFile(path.join(root, file), 'utf8') : '';
}
