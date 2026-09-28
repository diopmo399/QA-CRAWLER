import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfigFile } from '../../src/config/config-loader.js';
import type { ExplorationResult } from '../../src/model/exploration-result.js';
import { runMission } from '../../src/orchestrator.js';

/**
 * Un dossier créé sur place (POST), puis son code modifié (PUT). Le serveur refuse le
 * code 99999 (422) et l'écran affiche alors un message d'erreur.
 */
const PAGE = `<h1>Dossiers</h1>
  <button id="new">Nouveau dossier</button>
  <section id="dossier" hidden>
    <label>Nom <input name="nom"></label>
    <button id="save">Enregistrer</button>
    <p id="created"></p>
    <label>Code <input name="code"></label>
    <button id="code">Valider le code</button>
    <p id="shown"></p>
    <p id="error" class="error-message" hidden></p>
  </section>
  <script>
    let id;
    const box = document.getElementById('dossier');
    document.getElementById('new').onclick = () => (box.hidden = false);
    document.getElementById('save').onclick = async () => {
      const response = await fetch('/api/dossiers', { method: 'POST', body: box.querySelector('[name=nom]').value });
      id = (await response.json()).id;
      document.getElementById('created').textContent = 'Dossier ' + id + ' créé';
    };
    document.getElementById('code').onclick = async () => {
      const code = box.querySelector('[name=code]').value;
      const response = await fetch('/api/dossiers/' + id + '/code', { method: 'PUT', body: code });
      const error = document.getElementById('error');
      if (response.ok) {
        document.getElementById('shown').textContent = 'Code : ' + code;
        error.hidden = true;
      } else {
        error.textContent = 'Code refusé';
        error.hidden = false;
      }
    };
  </script>`;

const FEATURE = `Feature: Code du dossier
  Scenario Outline: Modifier le code
    Given un dossier est créé avec succès
    When l'utilisateur modifie le code de <ancien> à <nouveau>
    Then la requête PUT "/api/dossiers/*/code" réussit
    And aucun message d'erreur n'est affiché
    And le code <nouveau> est affiché dans le dossier
    And aucune autre donnée du dossier n'est modifiée

    Examples:
      | ancien | nouveau |
      | 11111  | 22222   |
      | 11111  | 99999   |

  Scenario: Un code refusé affiche une erreur
    Given un dossier est créé avec succès
    When l'utilisateur modifie le code de 11111 à 99999
    Then aucun message d'erreur n'est affiché
`;

describe('Gherkin with team sentences: precondition flow, unquoted values, network and error checks, manual checks', () => {
  let server: Server;
  let result: ExplorationResult;
  let created = 0;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = req.url ?? '/';
      if (url === '/api/dossiers' && req.method === 'POST') {
        created += 1;
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: created }));
        return;
      }
      if (/^\/api\/dossiers\/\d+\/code$/.test(url) && req.method === 'PUT') {
        let body = '';
        req.on('data', (chunk: Buffer) => (body += chunk.toString()));
        req.on('end', () => {
          res.writeHead(body === '99999' ? 422 : 200, { 'content-type': 'application/json' });
          res.end('{}');
        });
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        `<!doctype html><html><head><meta charset="utf-8"><title>App</title></head><body>${PAGE}</body></html>`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const dir = await mkdtemp(path.join(tmpdir(), 'qa-glue-run-'));
    await writeFile(path.join(dir, 'code.feature'), FEATURE);
    await writeFile(
      path.join(dir, 'mission.yaml'),
      `
mission: { name: glue }
target: { baseUrl: ${url} }
exploration: { autonomous: false, maxStates: 20, maxActions: 40, actionTimeoutMs: 2000, settleTimeMs: 100 }
flows:
  - name: creer-dossier
    reusable: true
    steps:
      - click: { role: button, name: Nouveau dossier }
        allow: MUTATION
      - fill: { label: Nom, value: Essai }
      - click: { role: button, name: Enregistrer }
        allow: MUTATION
      - expect: { text: créé }
  - gherkin: ./code.feature
gherkin:
  steps:
    - pattern: un dossier est créé avec succès
      steps: [{ run: creer-dossier }]
    - pattern: "l'utilisateur modifie le code de {ancien:mot} à {nouveau:mot}"
      steps:
        - fill: { label: Code, value: "{nouveau}" }
        - click: { role: button, name: Valider le code }
      allow: MUTATION
    - pattern: "le code {code:mot} est affiché dans le dossier"
      step: { expect: { text: "Code : {code}" } }
    - pattern: aucune autre donnée du dossier n'est modifiée
      manual: true
output:
  reportsDir: ${path.join(dir, 'reports')}
  screenshotsDir: ${path.join(dir, 'screenshots')}
`,
    );
    const { config } = await loadConfigFile(path.join(dir, 'mission.yaml'));
    result = (await runMission(config)).result;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('only the scenarios run (the precondition flow is replayed inside them, never alone)', () => {
    expect(result.flows.map((flow) => flow.name)).toEqual([
      'Modifier le code [11111, 22222]',
      'Modifier le code [11111, 99999]',
      'Un code refusé affiche une erreur',
    ]);
  });

  it('accepted code: every sentence passes, the manual check is left to a person', () => {
    const accepted = result.flows[0];
    expect(accepted?.status).toBe('PASSED');
    expect(accepted?.steps.map((step) => step.status)).toEqual([
      'PASSED', // précondition : Nouveau dossier
      'PASSED', // … Nom
      'PASSED', // … Enregistrer (POST permis par le flow rejoué)
      'PASSED', // … « créé »
      'PASSED', // fill Code
      'PASSED', // Valider le code (PUT permis par la phrase d'équipe)
      'PASSED', // la requête PUT réussit
      'PASSED', // aucun message d'erreur
      'PASSED', // le code est affiché
      'MANUAL',
    ]);
    expect(accepted?.steps.at(-1)?.reason).toBe(
      "to check manually: aucune autre donnée du dossier n'est modifiée",
    );
  });

  it('refused code: the request check fails with the status, the rest is skipped', () => {
    const refused = result.flows[1];
    expect(refused?.status).toBe('FAILED');
    const failed = refused?.steps.find((step) => step.status === 'FAILED');
    expect(failed?.description).toBe('Then la requête PUT "/api/dossiers/*/code" réussit');
    expect(failed?.reason).toMatch(/PUT "\/api\/dossiers\/\*\/code" answered 422 \(expected 2xx\)/);
    expect(refused?.steps.slice(-3).map((step) => step.status)).toEqual(['SKIPPED', 'SKIPPED', 'SKIPPED']);
  });

  it('an error message on the screen fails "aucun message d\'erreur n\'est affiché", with the message', () => {
    const shown = result.flows[2];
    expect(shown?.status).toBe('FAILED');
    expect(shown?.steps.at(-1)?.reason).toBe('expectation not met: error message shown: "Code refusé"');
  });
});
