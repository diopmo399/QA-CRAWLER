import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cp, mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
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
 */
describe('static analysis from the git repository of the application (Chromium)', () => {
  let server: Server;
  let url: string;
  let dir: string;
  let repository: string;

  const run = async (git: string): Promise<{ result: ExplorationResult; reports: string }> => {
    const reports = await mkdtemp(path.join(dir, 'run-'));
    const { config } = parseConfig(
      `
mission: { name: static-git }
target: { baseUrl: ${url}, startAt: /administration/users/new }
exploration: { autonomous: false, actionTimeoutMs: 3000, settleTimeMs: 50 }
gherkin: { semanticResolution: { enabled: true } }
openapi: { enabled: true, source: ${path.join(FIXTURE, 'openapi.yaml')} }
staticAnalysis:
  enabled: true
  source:
    git: ${git}
    gitDirectory: ${path.join(dir, 'sources')}
flows:
  - name: yaml-email
    startAt: /administration/users/new
    steps:
      - fill: { label: courriel, value: git@example.test }
      - expect: { text: contact=git@example.test }
report: { failOnSeverity: NONE }
output:
  reportsDir: ${path.join(reports, 'reports')}
  screenshotsDir: ${path.join(reports, 'screenshots')}
`,
      {},
      {},
    );
    return { result: (await runMission(config, { env: {} })).result, reports };
  };

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'qa-static-git-'));
    // Le dépôt de l'application : le code Angular dans un sous-dossier, comme un mono-repo.
    repository = path.join(dir, 'app-repo');
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

  it('the repository is cloned (ref + path), analysed, and the mute input is resolved by its code; the next run updates the clone', async () => {
    const git = JSON.stringify({ url: `file://${repository}`, ref: 'main', path: 'frontend' });
    const { result } = await run(git);
    const flow = result.flows.find((entry) => entry.name === 'yaml-email');
    expect(flow?.status, JSON.stringify(flow?.steps.map((step) => [step.description, step.reason]))).toBe(
      'PASSED',
    );
    expect(result.staticAnalysis).toMatchObject({ status: 'USED', framework: 'ANGULAR', mode: 'SOURCE' });
    expect(result.staticAnalysis?.confirmedFields).toContain('CreateUserComponent#contact');
    // Un dossier par ensemble de dépôts, le clone dedans ; le run suivant le met à jour (pas de re-clone).
    const sets = await readdir(path.join(dir, 'sources'));
    expect(sets).toHaveLength(1);
    expect(await readdir(path.join(dir, 'sources', sets[0] ?? ''))).toHaveLength(1);

    const again = await run(git);
    expect(again.result.flows.find((entry) => entry.name === 'yaml-email')?.status).toBe('PASSED');
    expect(await findLog(again.reports)).toMatch(/GIT_SOURCE_FETCHED[^\n]*updated/);
  }, 180_000);

  it('a repository that cannot be read: the run continues without the code, the reason is reported (never an exception)', async () => {
    const { result, reports } = await run(
      JSON.stringify({ url: `file://${path.join(dir, 'missing-repo')}` }),
    );
    expect(result.flows).toHaveLength(1);
    expect(result.staticAnalysis?.status).not.toBe('USED');
    expect(await findLog(reports)).toMatch(/GIT_SOURCE_FAILED[^\n]*fatal:/);
  }, 180_000);
});

async function findLog(root: string): Promise<string> {
  const entries = await readdir(root, { recursive: true });
  const file = entries.find((entry) => entry.endsWith('engine-log.jsonl'));
  return file ? readFile(path.join(root, file), 'utf8') : '';
}
