import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import type { FlowRunReport } from '../../src/model/flow-run.js';
import { runMission } from '../../src/orchestrator.js';

/**
 * Le cas d'un vrai run : un panneau de filtre (attribut, opérateur, puis un champ VALEUR sans nom,
 * `#valueInput`). Dans la nouvelle version de l'écran, le champ valeur n'est rendu qu'une fois la
 * section « Value options » dépliée. Avant : TARGET_FINGERPRINT_MISMATCH → LOCATOR_STALE →
 * candidats sans rapport → budget épuisé. Attendu : la cible est ABSENTE, la section parente est
 * fermée → on l'ouvre (SAFE) → le champ apparaît → le parcours continue.
 */
const PAGE = (
  layout: string,
): string => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Requests</title>
<style>.hidden{display:none}</style></head><body><main>
<h1>Requests</h1>
<button type="button">Language</button>
<button type="button">Help</button>
<button type="button">Start date</button>
<button type="button" id="filter">Filter</button>
<section id="panel" class="hidden">
  <label>Attribute <select id="attribute"><option value="">--</option><option>Name</option><option>Code</option></select></label>
  <label>Operator <select id="operator"><option value="">--</option><option>Like</option><option>Equals</option></select></label>
  ${layout === 'section' ? '<button type="button" id="more" aria-expanded="false">Value options</button><div id="value" class="hidden"><input id="valueInput"></div>' : '<input id="valueInput">'}
  <button type="button" id="apply">Apply</button>
</section>
<p id="done" class="hidden">Results filtered</p>
</main><script>
  document.getElementById('filter').addEventListener('click', () => document.getElementById('panel').classList.remove('hidden'));
  const more = document.getElementById('more');
  if (more) more.addEventListener('click', () => {
    more.setAttribute('aria-expanded', 'true');
    document.getElementById('value').classList.remove('hidden');
  });
  document.getElementById('apply').addEventListener('click', () => {
    if (document.getElementById('valueInput').value) document.getElementById('done').classList.remove('hidden');
  });
</script></body></html>`;

const FLOW = `      - click: { role: button, name: Filter }
      - select: { label: Attribute, option: Name }
      - select: { label: Operator, option: Like }
      - fill: { css: "#valueInput", value: alpha }
        fingerprint: { role: textbox, tag: input }
      - click: { role: button, name: Apply }
        allow: [MUTATION]
      - expect: { text: Results filtered }`;

describe('Functional goal recovery end to end (real browser)', () => {
  let server: Server;
  let url: string;
  beforeAll(async () => {
    server = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(PAGE(new URL(request.url ?? '/', 'http://x').searchParams.get('layout') ?? 'flat'));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const replay = async (layout: string): Promise<FlowRunReport> => {
    const reportsDir = await mkdtemp(path.join(tmpdir(), 'qa-functional-recovery-'));
    const { config } = parseConfig(
      `mission: { name: functional-recovery }
target: { baseUrl: ${url}, startAt: "/?layout=${layout}" }
exploration: { autonomous: false, actionTimeoutMs: 2000, settleTimeMs: 100 }
report: { failOnSeverity: NONE }
replay:
  effectTimeoutMs: 800
  intelligentRecovery: { budgets: { maxSafeExperiments: 2, maxRecoveryActions: 2 } }
output: { reportsDir: ${reportsDir} }
flows:
  - name: Filter requests
    steps:
${FLOW}
`,
      {},
      {},
    );
    const { result } = await runMission(config, { env: {} });
    const flow = result.flows[0];
    if (!flow) throw new Error('no flow report');
    return flow;
  };

  it('the recorded layout passes as is (no recovery)', async () => {
    const flow = await replay('flat');
    expect(
      flow.status,
      flow.steps.map((step) => `${step.status} ${step.description} ${step.reason ?? ''}`).join('\n'),
    ).toBe('PASSED');
    expect(flow.steps.some((step) => step.recovery)).toBe(false);
  }, 120_000);

  it('§41 the value field moved into a collapsed section: the unavailable target is recovered functionally (SAFE section opened, field verified by its locator), no unrelated retries', async () => {
    const flow = await replay('section');
    const describe = flow.steps
      .map((step) => `${step.status} ${step.description} ${step.reason ?? ''}`)
      .join('\n');
    expect(flow.status, describe).toBe('PASSED');
    // La récupération part de la PREMIÈRE divergence fonctionnelle : après le choix de l'opérateur,
    // la cible suivante (#valueInput) n'est pas disponible — pas d'essais de localisateur à l'étape 4.
    const recovered = flow.steps.filter((entry) => entry.recovery);
    expect(recovered).toHaveLength(1);
    const recovery = recovered[0]?.recovery;
    expect(recovery?.outcome.status).toBe('GOAL_REACHED');
    expect(recovery?.outcome.path).toEqual([
      { kind: 'click', role: 'button', name: 'Value options', part: 'INSERTED_PREREQUISITE' },
    ]);
    expect(recovery?.divergence.category).toBe('PREREQUISITE_MISSING');
    // Les boutons sans rapport (langue, aide, date) n'ont pas été essayés.
    expect(recovery?.outcome.attempts.map((attempt) => attempt.path)).toEqual(['click button:value options']);
    // Le champ sans nom est vérifié par son localisateur enregistré (#valueInput), jamais pris pour un nom.
    expect(recovery?.goalVerification?.status).toBe('REACHED');
    expect(recovery?.goalVerification?.satisfied).toContain('field "#valueInput" visible');
    expect(flow.steps[3]?.status).toBe('PASSED');
  }, 120_000);
});
