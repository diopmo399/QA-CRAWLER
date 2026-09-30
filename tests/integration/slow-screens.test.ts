import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { ActionDiscovery } from '../../src/discovery/action-discovery.js';
import { runDryRun } from '../../src/dry-run/dry-run-orchestrator.js';
import { UIObserver } from '../../src/observation/ui-observer.js';
import { waitForScreenReady } from '../../src/observation/screen-ready.js';
import { SafetyPolicy } from '../../src/policies/safety-policy.js';
import { testConfig } from '../helpers.js';

/**
 * Une application lente, faite comme beaucoup d'applications Angular :
 * - « Traiter la demande » est un <a> SANS href, avec un gestionnaire de clic ;
 * - chaque écran affiche d'abord une roue de chargement (plus d'une seconde) ;
 * - le formulaire n'a pas de <form> et ses deux champs n'ont aucun libellé ;
 * - « Suivant » refuse d'avancer tant que les deux champs sont vides.
 */
const PAGE = `<!doctype html><html><body><div id="app"></div>
<a name="haut">ancre sans action</a>
<script>
  const app = document.getElementById('app');
  const later = (render) => {
    app.innerHTML = '<div class="spinner">Chargement…</div>';
    setTimeout(render, 1200);
  };
  const screens = {
    '': () => later(() => {
      app.innerHTML = '<h1>Demandes</h1><table>' + [7, 8, 9].map((n) =>
        '<tr><td>Demande ' + n + '</td><td><a class="lien" style="cursor:pointer">Traiter la demande</a></td></tr>').join('') + '</table>';
      app.querySelectorAll('a.lien').forEach((a) => a.addEventListener('click', () => { location.hash = '#/traiter'; }));
    }),
    '#/traiter': () => later(() => {
      app.innerHTML = '<h1>Dossier à traiter</h1><div class="grid"><input id="a"><input id="b"></div>'
        + '<p id="err"></p><button type="button">Suivant</button>';
      app.querySelector('button').addEventListener('click', () => {
        const filled = ['a', 'b'].every((id) => document.getElementById(id).value.trim() !== '');
        if (filled) location.hash = '#/fin';
        else document.getElementById('err').textContent = 'Champs obligatoires';
      });
    }),
    '#/fin': () => later(() => { app.innerHTML = '<h1>Traitement terminé</h1><p>Étape 2 terminée</p>'; }),
  };
  const route = () => (screens[location.hash] ?? screens[''])();
  window.addEventListener('hashchange', route);
  route();
</script></body></html>`;

describe('slow screens, links without href, forms without <form>', () => {
  let server: Server;
  let url: string;
  let browser: Browser;

  beforeAll(async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(PAGE);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  });

  it('waits for the screen: no spinner, a page that no longer moves', async () => {
    const page = await browser.newPage();
    await page.goto(`${url}/`);
    expect(await page.getByText('Chargement…').isVisible()).toBe(true);
    await waitForScreenReady(page, 5000);
    expect(await page.getByRole('heading', { name: 'Demandes' }).isVisible()).toBe(true);
    await page.close();
  });

  it('a link without href that looks clickable is an action; a bare anchor is not', async () => {
    const page = await browser.newPage();
    await page.goto(`${url}/`);
    await waitForScreenReady(page, 5000);
    const snapshot = await new UIObserver(400).observe(page);
    const labels = new ActionDiscovery(new SafetyPolicy(testConfig().safety))
      .discover(snapshot, 's0')
      .map((action) => action.text ?? action.label);
    expect(labels).toContain('Traiter la demande');
    expect(labels).not.toContain('ancre sans action');
    await page.close();
  });

  it('dry run: follows the link, fills the unlabelled fields, reaches the end', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'qa-slow-screens-'));
    await writeFile(
      path.join(dir, 'traiter.flow.yaml'),
      `name: Traiter une demande
steps:
  - goto: /
  - expect: { text: Étape 2 terminée }
`,
    );
    await writeFile(
      path.join(dir, 'mission.yaml'),
      `mission: { name: slow-screens }
target: { baseUrl: ${url}, startAt: / }
exploration: { actionTimeoutMs: 3000, settleTimeMs: 50 }
report: { failOnSeverity: NONE }
output: { reportsDir: ${path.join(dir, 'reports')} }
`,
    );
    const result = await runDryRun({
      scenarioFile: path.join(dir, 'traiter.flow.yaml'),
      missionFile: path.join(dir, 'mission.yaml'),
    });
    const entries = result.flows[0]?.reconciliation.entries ?? [];
    const rows = entries.map(
      (entry) => `${entry.expectedIntent?.label ?? entry.observedTarget?.label ?? '?'} ${entry.status}`,
    );
    expect(rows).toContain('Étape 2 terminée MATCHED');
    expect(rows).toContain('Traiter la demande INSERTED');
    expect(rows).toContain('Suivant INSERTED');
    const suivant = result.flows[0]?.suggested.steps.find((step) => step.label === 'Suivant');
    expect(suivant?.fillFormBefore).toBe(true);
  }, 120_000);

  it('Gherkin, semantic sentence: a link repeated on every row clicks the first row', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'qa-slow-screens-gherkin-'));
    await writeFile(
      path.join(dir, 'traiter.feature'),
      `# language: fr
Fonctionnalité: Demandes
  Scénario: Traiter une demande
    Étant donné que je suis sur "/"
    Quand je clique sur traiter la demande
    Alors je vois "Dossier à traiter"
`,
    );
    await writeFile(
      path.join(dir, 'mission.yaml'),
      `mission: { name: slow-screens-gherkin }
target: { baseUrl: ${url}, startAt: / }
exploration: { actionTimeoutMs: 3000, settleTimeMs: 50 }
report: { failOnSeverity: NONE }
output: { reportsDir: ${path.join(dir, 'reports')} }
`,
    );
    const result = await runDryRun({
      scenarioFile: path.join(dir, 'traiter.feature'),
      missionFile: path.join(dir, 'mission.yaml'),
    });
    const rows = (result.flows[0]?.reconciliation.entries ?? []).map(
      (entry) => `${entry.expectedIntent?.label ?? entry.observedTarget?.label ?? '?'} ${entry.status}`,
    );
    expect(rows).toContain('traiter la demande MATCHED');
    expect(result.flows[0]?.reconciliation.status).toBe('FULLY_MATCHED');
  }, 120_000);
});
