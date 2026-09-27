import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import type { ExplorationResult } from '../../src/model/exploration-result.js';
import { runMission } from '../../src/orchestrator.js';

/**
 * A request-creation dialog like an Angular Material one: no <form>, fields
 * with hints and error messages shown on blur, styled radios, a custom list
 * (role=combobox) opened in an overlay, a prefilled date, a password field,
 * and a "Soumettre" button that POSTs the request.
 */
const APP = `<!doctype html><html><head><meta charset="utf-8"><title>Demandes</title>
<style>
  .radio input { opacity: 0; position: absolute; }
  .overlay { position: fixed; inset: 0; background: rgba(0,0,0,.4); z-index: 10; }
  .box { margin: 5vh auto; width: 640px; background: #fff; padding: 16px; }
  .pane { position: absolute; top: 120px; left: 200px; z-index: 30; background: #eee; }
  .mat-mdc-form-field { display: block; margin: 6px 0; }
</style></head><body>
<h1>Demandes</h1>
<button onclick="openDialog()">Créer un dossier</button>
<div id="dlg" class="overlay" style="display:none">
  <div class="box" role="dialog" aria-modal="true" aria-labelledby="title">
    <h2 id="title">Nouveau dossier</h2>
    <div class="mat-mdc-form-field"><label for="agence">Code agence *</label>
      <input id="agence" required data-rule="^\\d{5}$" data-msg="Ce champ est obligatoire">
      <span class="mat-mdc-form-field-hint">99999</span></div>
    <div class="mat-mdc-form-field"><label for="nom">Raison sociale *</label>
      <input id="nom" required data-rule="." data-msg="Ce champ est obligatoire"></div>
    <div class="mat-mdc-form-field"><label for="dossier">Numéro de dossier *</label>
      <input id="dossier" required data-rule="^[A-Z]{2}-\\d{4}$" data-msg="Format attendu : AB-1234"></div>
    <label id="canalLabel">* Canal de contact</label>
    <div role="radiogroup" aria-labelledby="canalLabel" aria-required="true">
      <label class="radio"><input type="radio" name="canal" value="telephone"> Téléphone</label>
      <label class="radio"><input type="radio" name="canal" value="courriel"> Courriel</label>
    </div>
    <div class="mat-mdc-form-field"><span id="typeLabel">Type de dossier</span>
      <div id="type" role="combobox" tabindex="0" aria-labelledby="typeLabel" aria-haspopup="listbox" onclick="openList()"
        style="border:1px solid #999;padding:4px;width:200px;cursor:pointer"><span class="select-placeholder">Choisir</span></div></div>
    <div class="mat-mdc-form-field"><label for="date">Date de réception</label>
      <input id="date" class="mat-datepicker-input" value="2026-09-26">
      <span class="mat-mdc-form-field-hint">AAAA-MM-JJ</span></div>
    <div class="mat-mdc-form-field"><label for="heure">Heure</label>
      <input id="heure" data-rule="^\\d{2}:\\d{2}$" data-msg="Heure invalide">
      <span class="mat-mdc-form-field-hint">HH:MM</span></div>
    <div class="mat-mdc-form-field"><label for="secret">Mot de passe</label><input id="secret" type="password"></div>
    <button onclick="submitRequest()">Soumettre</button>
    <button onclick="closeDialog()">Annuler</button>
  </div>
</div>
<script>
  function openDialog() { document.getElementById('dlg').style.display = 'block'; }
  function closeDialog() { document.getElementById('dlg').style.display = 'none'; }
  for (const input of document.querySelectorAll('input[data-rule]')) {
    input.addEventListener('blur', () => {
      const container = input.closest('.mat-mdc-form-field');
      container.querySelector('.mat-mdc-form-field-error')?.remove();
      const ok = new RegExp(input.dataset.rule).test(input.value);
      input.setAttribute('aria-invalid', String(!ok));
      if (!ok) {
        const error = document.createElement('div');
        error.className = 'mat-mdc-form-field-error';
        error.textContent = input.dataset.msg;
        container.append(error);
      }
    });
  }
  function openList() {
    const pane = document.createElement('div');
    pane.className = 'cdk-overlay-pane pane';
    pane.setAttribute('role', 'listbox');
    for (const label of ['Ouverture', 'Fermeture']) {
      const option = document.createElement('div');
      option.setAttribute('role', 'option');
      option.textContent = label;
      option.style.cursor = 'pointer';
      option.onclick = () => { document.getElementById('type').textContent = label; pane.remove(); };
      pane.append(option);
    }
    document.body.append(pane);
  }
  async function submitRequest() {
    const body = {
      agence: document.getElementById('agence').value,
      nom: document.getElementById('nom').value,
      dossier: document.getElementById('dossier').value,
      canal: document.querySelector('input[name="canal"]:checked')?.value ?? '',
      type: document.getElementById('type').textContent,
      date: document.getElementById('date').value,
      heure: document.getElementById('heure').value,
      secret: document.getElementById('secret').value,
    };
    await fetch('/api/demandes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    closeDialog();
  }
</script></body></html>`;

async function startApp(): Promise<{
  url: string;
  posts: Record<string, string>[];
  close: () => Promise<void>;
}> {
  const posts: Record<string, string>[] = [];
  const server: Server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/demandes') {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        posts.push(JSON.parse(body) as Record<string, string>);
        res.writeHead(201).end();
      });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(APP);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    posts,
    close: () =>
      new Promise((resolve) =>
        server.close(() => {
          resolve();
        }),
      ),
  };
}

async function explore(url: string, extra: string): Promise<ExplorationResult> {
  const outputDir = await mkdtemp(path.join(tmpdir(), 'qa-forms-'));
  const { config } = parseConfig(
    `
mission: { name: forms }
target: { baseUrl: ${url} }
exploration: { maxStates: 15, maxActions: 30, actionTimeoutMs: 3000, settleTimeMs: 100 }
safety: { allowedActionClasses: [SAFE, MUTATION] }
output:
  reportsDir: ${path.join(outputDir, 'reports')}
  screenshotsDir: ${path.join(outputDir, 'screenshots')}
${extra}
`,
    {},
    {},
  );
  return (await runMission(config)).result;
}

describe('forms in a dialog (fill, check, never send by default)', () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  let result: ExplorationResult;

  beforeAll(async () => {
    app = await startApp();
    result = await explore(app.url, '');
  });
  afterAll(async () => {
    await app.close();
  });

  it('fills the dialog form, which has no <form>, once', () => {
    const filled = result.transitions.filter(
      (edge) => edge.action.type === 'fill' && edge.action.text === 'Nouveau dossier',
    );
    expect(filled.length).toBeGreaterThanOrEqual(1);
    expect(filled[0]?.result).toBe('SUCCESS');
    // Its fields are not tried again one by one.
    const fields = result.transitions.filter(
      (edge) => edge.result !== 'BLOCKED' && ['check', 'select'].includes(edge.action.type),
    );
    expect(fields).toEqual([]);
  });

  it('reports the fields the application still rejects, with its own message', () => {
    const issues = result.issues.filter((issue) => issue.type === 'FORM_VALIDATION');
    const dossier = issues.find((issue) => issue.message.includes('Numéro de dossier'));
    expect(dossier?.message).toBe(
      'form "Nouveau dossier": field "Numéro de dossier" (value "QA Test"): Format attendu : AB-1234',
    );
    expect(dossier?.severity).toBe('WARNING');
    // Values that follow the hints are accepted: 99999 → 5 digits, HH:MM → 10:00.
    expect(issues.find((issue) => issue.message.includes('Code agence'))).toBeUndefined();
    expect(issues.find((issue) => issue.message.includes('Heure'))).toBeUndefined();
    // Sensitive fields are neither filled nor reported.
    expect(issues.find((issue) => issue.message.includes('Mot de passe'))).toBeUndefined();
  });

  it('never clicks "Soumettre": nothing is sent', () => {
    expect(app.posts).toEqual([]);
    const submit = result.transitions.find((edge) => edge.action.text === 'Soumettre');
    expect(submit?.result).toBe('BLOCKED');
    expect(submit?.reason).toContain('form-submit');
  });
});

describe('forms with test data per field and forms.submit: true', () => {
  let app: Awaited<ReturnType<typeof startApp>>;

  beforeAll(async () => {
    app = await startApp();
    await explore(
      app.url,
      `forms: { submit: true }
testData:
  runId: t1
  fields:
    "Numéro de dossier": AB-1234
    "canal de contact": Courriel`,
    );
  });
  afterAll(async () => {
    await app.close();
  });

  it('sends what a user would have typed, following the hints and the configured values', () => {
    expect(app.posts.length).toBeGreaterThanOrEqual(1);
    expect(app.posts[0]).toEqual({
      agence: '12345', // hint "99999"
      nom: 'QA-CRAWLER-t1', // company name: tagged with the run id
      dossier: 'AB-1234', // testData.fields
      canal: 'courriel', // radio group, by its label
      type: 'Ouverture', // custom list: first option
      date: '2026-09-26', // prefilled: left as it is
      heure: '10:00', // hint "HH:MM"
      secret: '', // sensitive: never filled
    });
  });
});
