import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { parseConfig } from '../../src/config/config-loader.js';
import { ActionDiscovery } from '../../src/discovery/action-discovery.js';
import type { ExplorationResult } from '../../src/model/exploration-result.js';
import { UIObserver } from '../../src/observation/ui-observer.js';
import { runMission } from '../../src/orchestrator.js';
import { SafetyPolicy } from '../../src/policies/safety-policy.js';
import { testConfig } from '../helpers.js';

/**
 * Une fenêtre de création faite de <div>, comme beaucoup de design systems :
 * - les libellés sont des <div> posés au-dessus des champs, sans <label for> ni aria ;
 * - l'aide « 99999 » est un <div> sous le champ ; ce champ a un masque de saisie qui
 *   n'accepte que de vraies frappes de chiffres (une valeur posée d'un coup est effacée) ;
 * - les radios sont pilotées par l'application : le clic sur l'input est annulé et
 *   l'état n'est mis à jour qu'un peu plus tard (composant contrôlé).
 * Rien n'est envoyé : le bouton « Soumettre » reste bloqué par défaut.
 */
const DIALOG = `<h1>Accueil</h1>
<div role="dialog" aria-modal="true" aria-label="Nouvelle demande" style="position:fixed;inset:10%;background:#fff">
  <h2>Nouvelle demande</h2>
  <div class="row">
    <div class="field"><div class="lbl">* Code agence</div>
      <input id="f1" required maxlength="5">
      <div class="help">99999</div></div>
    <div class="field"><div class="lbl">Nom de l'agence</div><div>-</div></div>
  </div>
  <div class="field"><div class="lbl">* Raison sociale</div><input id="f2" required></div>
  <div class="field"><div class="lbl">Numéro de dossier</div><input id="f5" inputmode="numeric" maxlength="6"></div>
  <div class="row">
    <div class="field"><div class="lbl">* Prénom du contact</div><input id="f3" required></div>
    <div class="field"><div class="lbl">* Nom du contact</div><input id="f4" required></div>
  </div>
  <div class="field"><div class="lbl">* Canal</div>
    <label><input type="radio" name="canal" aria-label="Select an option: Téléphone" required> Téléphone</label>
    <label><input type="radio" name="canal" aria-label="Select an option: Courriel"> Courriel</label>
  </div>
  <button>Annuler</button> <button>Soumettre</button>
</div>
<script>
  // Masque de saisie : la valeur ne se construit qu'à partir des vraies frappes ; une valeur
  // posée d'un coup (sans touche) est effacée et le champ reste invalide.
  (() => {
    const input = document.getElementById('f1');
    let model = '';
    input.setAttribute('aria-invalid', 'true');
    input.addEventListener('keydown', (event) => {
      if (/^\\d$/.test(event.key) && model.length < 5) model += event.key;
      else if (event.key === 'Backspace') model = model.slice(0, -1);
    });
    input.addEventListener('input', () => {
      input.value = model;
      input.setAttribute('aria-invalid', model.length === 5 ? 'false' : 'true');
    });
  })();
  // Radios contrôlées : le clic natif est annulé, l'application coche un peu plus tard.
  document.querySelectorAll('input[type=radio]').forEach((radio) =>
    radio.addEventListener('click', (event) => {
      event.preventDefault();
      setTimeout(() => { radio.checked = true; }, 60);
    }));
</script>`;

describe('champs sans libellé relié (libellé et aide « visuels »), radios pilotées', () => {
  let server: Server;
  let browser: Browser;
  let url = '';
  let result: ExplorationResult;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        `<!doctype html><html><head><meta charset="utf-8"><title>App</title></head><body>${DIALOG}</body></html>`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch();
    const outputDir = await mkdtemp(path.join(tmpdir(), 'qa-unlabelled-'));
    const { config } = parseConfig(
      `
mission: { name: sans-libelle }
target: { baseUrl: ${url} }
exploration: { maxStates: 10, maxActions: 20, actionTimeoutMs: 2000, settleTimeMs: 50 }
output:
  reportsDir: ${path.join(outputDir, 'reports')}
  screenshotsDir: ${path.join(outputDir, 'screenshots')}
`,
      {},
      {},
    );
    result = (await runMission(config)).result;
  });
  afterAll(async () => {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  });

  it('trouve chaque champ avec le texte posé au-dessus comme libellé, et un id distinct', async () => {
    const page = await browser.newPage();
    await page.goto(url);
    const snapshot = await new UIObserver().observe(page);
    const actions = new ActionDiscovery(new SafetyPolicy(testConfig().safety)).discover(snapshot, 's');
    const fields = actions.filter((action) => action.type === 'fill');
    expect(fields.map((action) => action.field?.label)).toEqual([
      'Code agence',
      'Raison sociale',
      'Numéro de dossier',
      'Prénom du contact',
      'Nom du contact',
    ]);
    expect(new Set(fields.map((action) => action.id)).size).toBe(5);
    expect(fields[2]?.field?.inputMode).toBe('numeric');
    expect(fields[0]?.field?.hint).toBe('99999');
    // Libellé deviné : Playwright ne le connaît pas, le localisateur est un CSS qui trouve le champ seul.
    expect(fields.every((action) => action.locator.strategy === 'css')).toBe(true);
    await page.close();
  });

  it("remplit tout le formulaire : l'aide « 99999 » donne 5 chiffres, les radios pilotées sont cochées", () => {
    const form = result.formReports?.find((report) => report.name === 'Nouvelle demande');
    const byLabel = Object.fromEntries((form?.fields ?? []).map((field) => [field.label, field]));
    expect(Object.keys(byLabel)).toEqual(
      expect.arrayContaining(['Code agence', 'Raison sociale', 'Prénom du contact', 'Nom du contact']),
    );
    expect(byLabel['Code agence']?.filled).toMatch(/^fill "\d{5}"$/);
    // inputmode numeric : des chiffres à la longueur de maxlength, pas « QA Test ».
    expect(byLabel['Numéro de dossier']?.filled).toBe('fill "123456"');
    for (const label of ['Raison sociale', 'Prénom du contact', 'Nom du contact'])
      expect(byLabel[label]?.filled, label).toMatch(/^fill "/);
    const radios = (form?.fields ?? []).filter((field) => field.type === 'radio');
    expect(radios.some((field) => field.filled === 'check' && !field.error)).toBe(true);
    expect((form?.fields ?? []).every((field) => !field.error)).toBe(true);
    // Plus aucun champ obligatoire refusé une fois le formulaire rempli.
    expect(result.issues.filter((issue) => issue.type === 'FORM_VALIDATION')).toEqual([]);
  });
});
