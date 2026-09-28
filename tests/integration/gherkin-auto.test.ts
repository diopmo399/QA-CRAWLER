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
 * Un onglet, un panneau repliable qui contient une section, un champ, un bouton qui
 * enregistre (PUT). Le serveur refuse le code 99999 (422).
 */
const PAGE = `<h1>Profil</h1>
  <div role="tablist"><button role="tab" aria-selected="true">Général</button><button role="tab" id="tab">Organisation</button></div>
  <div id="org" hidden>
    <button id="panel">Renseignements</button>
    <div id="sections" hidden><button id="section">Activité</button></div>
    <div id="activity" hidden>
      <label>Code d'activité <input name="code"></label>
      <p>Taux : 60</p>
      <button id="save">Enregistrer</button>
      <p id="shown"></p>
      <p id="error" class="error-message" hidden></p>
    </div>
  </div>
  <script>
    const show = (id) => (document.getElementById(id).hidden = false);
    document.getElementById('tab').onclick = () => show('org');
    document.getElementById('panel').onclick = () => show('sections');
    document.getElementById('section').onclick = () => show('activity');
    document.getElementById('save').onclick = async () => {
      const code = document.querySelector('[name=code]').value;
      const response = await fetch('/api/profil/code', { method: 'PUT', body: code });
      const error = document.getElementById('error');
      if (response.ok) document.getElementById('shown').textContent = 'Code : ' + code;
      else { error.textContent = 'Code refusé'; error.hidden = false; }
    };
  </script>`;

/** Aucune phrase n'est traduite dans la mission : tout passe par le mode automatique. */
const FEATURE = `Feature: Code d'activité
  @mutation
  Scenario Outline: Modifier le code d'activité
    Given l'utilisateur est sur "/"
    When l'utilisateur accède à l'onglet "Organisation" et à la section "Activité" du panneau "Renseignements"
    And modifie le code d'activité de <ancien> à <nouveau>
    And clique sur "Enregistrer"
    Then le code d'activité est mis à jour avec succès
    And le code <nouveau> est affiché
    And le taux demeure à 60
    And aucune autre donnée n'est modifiée

    Examples:
      | ancien | nouveau |
      | 11111  | 22222   |
      | 11111  | 99999   |
`;

describe('Gherkin automatic mode (gherkin.auto: true): no translation written', () => {
  let server: Server;
  let result: ExplorationResult;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/api/profil/code' && req.method === 'PUT') {
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
    const dir = await mkdtemp(path.join(tmpdir(), 'qa-auto-'));
    await writeFile(path.join(dir, 'code.feature'), FEATURE);
    await writeFile(
      path.join(dir, 'mission.yaml'),
      `
mission: { name: auto }
target: { baseUrl: ${url} }
exploration: { autonomous: false, maxStates: 30, maxActions: 60, actionTimeoutMs: 2000, settleTimeMs: 100 }
flows:
  - gherkin: ./code.feature
gherkin:
  auto: true
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

  it('each sentence is interpreted on the screen and says how', () => {
    const accepted = result.flows[0];
    expect(accepted?.name).toBe("Modifier le code d'activité [11111, 22222]");
    expect(accepted?.status).toBe('PASSED');
    expect(accepted?.steps.map((step) => [step.status, step.interpretation])).toEqual([
      ['PASSED', undefined], // phrase intégrée : l'utilisateur est sur "/"
      // Le nom « Activité » n'est cliquable qu'une fois le panneau ouvert : il est réessayé après.
      ['PASSED', 'click tab "Organisation" → click button "Renseignements" → click button "Activité"'],
      ['PASSED', 'fill role=textbox[name="Code d\'activité"] = "22222"'],
      ['PASSED', 'click button "Enregistrer"'],
      ['PASSED', 'check no error message, last write PUT answered 2xx'],
      ['PASSED', 'check text "22222"'],
      ['PASSED', 'check text "60"'],
      ['MANUAL', undefined],
    ]);
    expect(accepted?.steps.at(-1)?.reason).toMatch(/^not understood automatically: /);
  });

  it('a refused save fails the success check with the status', () => {
    const refused = result.flows[1];
    expect(refused?.status).toBe('FAILED');
    const failed = refused?.steps.find((step) => step.status === 'FAILED');
    expect(failed?.description).toBe("Then le code d'activité est mis à jour avec succès");
    expect(failed?.reason).toMatch(/error message shown: "Code refusé"/);
    expect(failed?.reason).toMatch(/last write PUT \/api\/profil\/code answered 422/);
  });
});
