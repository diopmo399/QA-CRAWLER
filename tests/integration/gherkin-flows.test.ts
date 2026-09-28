import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfigFile } from '../../src/config/config-loader.js';
import type { ExplorationResult } from '../../src/model/exploration-result.js';
import { runMission } from '../../src/orchestrator.js';

/** Une liste de clients avec un formulaire de création sur place (aucun appel réseau). */
const CLIENTS = `<h1>Clients</h1>
  <button id="new">Nouveau client</button>
  <form id="form" hidden>
    <label>Nom <input name="nom"></label>
    <label>Ville <input name="ville"></label>
    <label>Type <select name="type"><option>Particulier</option><option>Entreprise</option></select></label>
    <label><input type="checkbox" name="accord"> J'accepte les conditions</label>
    <button type="button" id="save">Enregistrer</button>
  </form>
  <p id="done" role="status"></p>
  <script>
    document.getElementById('new').onclick = () => (document.getElementById('form').hidden = false);
    document.getElementById('save').onclick = () => {
      const form = document.getElementById('form');
      const nom = form.nom.value;
      if (!form.accord.checked) return;
      document.getElementById('done').textContent = 'Client ' + nom + ' créé (' + form.type.value + ')';
      history.pushState({}, '', '/clients/1');
    };
  </script>`;

const FEATURE = `# language: fr
Fonctionnalité: Clients

  Contexte:
    Étant donné que je suis sur "/clients"

  @mutation
  Scénario: Création d'un client
    Quand je clique sur le bouton "Nouveau client"
    Et je remplis le formulaire :
      | champ | valeur    |
      | Nom   | Dupont    |
      | Ville | <env:QA_TEST_CITY> |
    Et je choisis "Entreprise" dans "Type"
    Et je coche la case "J'accepte les conditions"
    Et je clique sur le bouton "Enregistrer"
    Alors je vois "Client Dupont créé (Entreprise)"
    Et l'URL contient "/clients/1"

  Scénario: Un message qui n'existe pas
    Alors je vois "Bienvenue sur la page d'accueil"
    Et je prends une capture "après"
`;

describe('Gherkin scenarios run as imposed flows', () => {
  let server: Server;
  let result: ExplorationResult;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const body = (req.url ?? '').startsWith('/clients') ? CLIENTS : '<h1>Accueil</h1>';
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        `<!doctype html><html><head><meta charset="utf-8"><title>App</title></head><body>${body}</body></html>`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const dir = await mkdtemp(path.join(tmpdir(), 'qa-gherkin-run-'));
    await writeFile(path.join(dir, 'clients.feature'), FEATURE);
    await writeFile(
      path.join(dir, 'mission.yaml'),
      `
mission: { name: gherkin }
target: { baseUrl: ${url} }
exploration: { autonomous: false, maxStates: 10, maxActions: 20, actionTimeoutMs: 2000, settleTimeMs: 50 }
flows:
  - gherkin: ./clients.feature
output:
  reportsDir: ${path.join(dir, 'reports')}
  screenshotsDir: ${path.join(dir, 'screenshots')}
`,
    );
    const { config } = await loadConfigFile(path.join(dir, 'mission.yaml'));
    result = (await runMission(config, { env: { ...process.env, QA_TEST_CITY: 'Lyon' } })).result;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('a scenario passes sentence by sentence: table, select, checkbox, env value, checks', () => {
    const creation = result.flows.find((flow) => flow.name === "Création d'un client");
    expect(creation?.status).toBe('PASSED');
    expect(creation?.steps.map((step) => [step.description, step.status])).toEqual([
      ['Étant donné que je suis sur "/clients"', 'PASSED'],
      ['Quand je clique sur le bouton "Nouveau client"', 'PASSED'],
      ['Et je remplis le formulaire : (Nom)', 'PASSED'],
      ['Et je remplis le formulaire : (Ville)', 'PASSED'],
      ['Et je choisis "Entreprise" dans "Type"', 'PASSED'],
      ['Et je coche la case "J\'accepte les conditions"', 'PASSED'],
      ['Et je clique sur le bouton "Enregistrer"', 'PASSED'],
      ['Alors je vois "Client Dupont créé (Entreprise)"', 'PASSED'],
      ['Et l\'URL contient "/clients/1"', 'PASSED'],
    ]);
  });

  it('a failing check fails its scenario at that sentence; the next ones are skipped', () => {
    const failing = result.flows.find((flow) => flow.name === "Un message qui n'existe pas");
    expect(failing?.status).toBe('FAILED');
    expect(failing?.steps.map((step) => step.status)).toEqual(['PASSED', 'FAILED', 'SKIPPED']);
  });
});
