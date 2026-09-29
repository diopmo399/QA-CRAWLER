import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import type { ExplorationResult } from '../../src/model/exploration-result.js';
import { runMission } from '../../src/orchestrator.js';

/**
 * Un Plan du scénario écrit comme le métier l'écrit : à la 3e personne, sans guillemets
 * autour des valeurs d'exemples, avec une navigation en trois lieux (étape, onglet,
 * section) dans une seule phrase. Aucun sélecteur : tout est résolu sur l'écran.
 */
describe('a business Scenario Outline resolved semantically in a real browser', () => {
  let server: Server;
  let result: ExplorationResult;
  const saved: string[] = [];
  let code = '111';

  const page =
    (): string => `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Dossier</title></head><body>
<h1>Dossier 42</h1>
<nav aria-label="Étapes"><button type="button" id="s1">Réception</button> <button type="button" id="s2">Analyse</button></nav>
<div id="tabs" hidden>
  <div role="tablist"><button role="tab" id="t1" aria-selected="true">Résumé</button><button role="tab" id="t2" aria-selected="false">Détails</button></div>
  <div id="details" hidden>
    <button type="button" aria-expanded="false" id="sec">Activité</button>
    <form id="activity" method="post" action="/save" hidden>
      <label for="cat">Code de catégorie</label><input id="cat" name="categoryCode" value="${code}">
      <button type="submit">Valider</button>
    </form>
  </div>
</div>
<p id="current">Code actuel : ${code}</p>
<script>
  document.getElementById('s2').onclick = () => { document.getElementById('tabs').hidden = false; };
  document.getElementById('t2').onclick = (e) => { e.target.setAttribute('aria-selected', 'true'); document.getElementById('details').hidden = false; };
  document.getElementById('sec').onclick = (e) => { e.target.setAttribute('aria-expanded', 'true'); document.getElementById('activity').hidden = false; };
</script>
</body></html>`;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/save') {
        let body = '';
        req.on('data', (chunk: Buffer) => (body += chunk.toString()));
        req.on('end', () => {
          code = new URLSearchParams(body).get('categoryCode') ?? code;
          saved.push(code);
          res.writeHead(303, { location: '/' });
          res.end();
        });
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page());
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://localhost:${String((server.address() as AddressInfo).port)}`;
    const root = await mkdtemp(path.join(tmpdir(), 'qa-semantic-outline-'));
    await writeFile(
      path.join(root, 'code.feature'),
      `# language: fr
@mutation
Fonctionnalité: Code de catégorie
  Plan du scénario: Modifier le code de catégorie
    Étant donné que je suis sur "/"
    Quand l'utilisateur accède à l'étape "Analyse" à l'onglet "Détails" et à la section "Activité"
    Et modifie le code de catégorie de <Code> à <Nouveau code>
    Et valide le formulaire
    Alors le code <Nouveau code> est affiché

    Exemples:
      | Code | Nouveau code |
      | 111  | 222          |
`,
    );
    const { config } = parseConfig(
      `
mission: { name: semantic-outline, mode: explore }
target: { baseUrl: ${url} }
exploration: { autonomous: false, actionTimeoutMs: 4000, settleTimeMs: 100 }
gherkin: { auto: true, semanticResolution: { enabled: true } }
flows:
  - gherkin: ${path.join(root, 'code.feature')}
report: { language: fr, failOnSeverity: NONE }
output:
  reportsDir: ${path.join(root, 'reports')}
  screenshotsDir: ${path.join(root, 'screenshots')}
`,
      {},
      {},
    );
    result = (await runMission(config)).result;
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  });

  const steps = (): string =>
    (result.flows[0]?.steps ?? [])
      .map((step) => `${String(step.index)} ${step.status} ${step.description} ${step.reason ?? ''}`)
      .join('\n');

  it('every sentence passes, the flow passes', () => {
    expect(result.flows).toHaveLength(1);
    expect(result.flows[0]?.status, steps()).toBe('PASSED');
  });

  it('the new value of the example was saved once, the old one was never typed', () => {
    expect(saved).toEqual(['222']);
  });

  it('the three places were opened in order, by what they mean', () => {
    const navigations = (result.flows[0]?.steps ?? [])
      .filter((step) => step.resolution?.selected !== undefined)
      .map((step) => step.resolution?.selected);
    expect(navigations.slice(0, 3), steps()).toEqual(['Analyse', 'Détails', 'Activité']);
  });
});
