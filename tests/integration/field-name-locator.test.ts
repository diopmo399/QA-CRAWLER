import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import { runMission } from '../../src/orchestrator.js';

/**
 * Un champ d'AUTOCOMPLÉTION comme ceux d'Angular Material : pas de <label>, un placeholder et
 * le rôle ARIA combobox. Son nom accessible est « My tasks » — l'écran le montre ainsi —, mais
 * getByLabel seul ne le trouvait pas : `fill label="My tasks"` échouait (élément introuvable),
 * puis la récupération cherchait des boutons. Le nom accessible du champ doit suffire.
 */
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Tasks</title>
<style>.hidden{display:none}</style></head><body><main>
<h1>Task list</h1>
<div class="selector">
  <input role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="views" placeholder="My tasks" id="views-input">
  <ul role="listbox" id="views" class="hidden">
    <li role="option" id="opt-requests">My requests</li>
    <li role="option" id="opt-team">Team tasks</li>
  </ul>
</div>
<button type="button">Refresh tasks</button>
<button type="button">Task name</button>
<section id="requests" class="hidden"><h2>Requests view</h2></section>
</main><script>
  const input = document.getElementById('views-input');
  const list = document.getElementById('views');
  input.addEventListener('input', () => {
    list.classList.toggle('hidden', input.value.length === 0);
    input.setAttribute('aria-expanded', String(input.value.length > 0));
  });
  document.getElementById('opt-requests').addEventListener('click', () => {
    input.value = 'My requests';
    list.classList.add('hidden');
    document.getElementById('requests').classList.remove('hidden');
  });
</script></body></html>`;

describe('A field found by its accessible name (placeholder / combobox), not only by a <label>', () => {
  let server: Server;
  let url: string;

  beforeAll(async () => {
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

  it('fill label="My tasks" on an autocomplete combobox, then pick the option: the flow passes', async () => {
    const reportsDir = await mkdtemp(path.join(tmpdir(), 'qa-field-name-'));
    const { config } = parseConfig(
      `mission: { name: field-name }
target: { baseUrl: ${url}, startAt: "/" }
exploration: { autonomous: false, actionTimeoutMs: 3000, settleTimeMs: 100 }
report: { failOnSeverity: NONE }
output: { reportsDir: ${reportsDir} }
flows:
  - name: Open my requests
    steps:
      - fill: { label: My tasks, value: My requests }
      - click: { role: option, name: My requests }
      - expect: { text: Requests view }
`,
      {},
      {},
    );
    const { result } = await runMission(config, { env: {} });
    const flow = result.flows[0];
    expect(flow?.steps.map((step) => `${step.status} ${step.description} ${step.reason ?? ''}`)).toEqual([
      expect.stringMatching(/^PASSED fill label="My tasks"/),
      expect.stringMatching(/^PASSED click/),
      expect.stringMatching(/^PASSED/),
    ]);
    expect(flow?.status).toBe('PASSED');
  }, 120_000);
});
