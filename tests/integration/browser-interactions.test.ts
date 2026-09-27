import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import type { BrowserInteractionResult, BrowserInteractionType } from '../../src/interactions/types.js';
import type { ExplorationResult } from '../../src/model/exploration-result.js';
import { runMission } from '../../src/orchestrator.js';

/**
 * Interactions du navigateur hors du DOM sur une page locale : chaque bouton en lève
 * une. Les flows imposés cliquent sur les boutons (ordre déterministe) ; le
 * BrowserInteractionManager détecte, classe, applique la politique de sécurité,
 * traite et enregistre chaque interaction, et le flow continue.
 */
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Interactions</title></head><body>
<h1>Interactions</h1>
<p id="resultat">-</p>
<button onclick="alert('Bonjour')">Afficher l'alerte</button>
<button onclick="document.getElementById('resultat').textContent = confirm('Supprimer le dossier ?') ? 'confirmé' : 'annulé'">Question risquée</button>
<button onclick="document.getElementById('resultat').textContent = confirm('Continuer la lecture ?') ? 'suite' : 'arrêt'">Question simple</button>
<button onclick="document.getElementById('resultat').textContent = 'nom:' + prompt('Nom du dossier ?')">Nommer</button>
<button onclick="document.getElementById('resultat').textContent = 'code:' + prompt('Code secret ?')">Code</button>
<button onclick="window.open('/document')">Voir le document</button>
<a href="/aide" target="_blank" rel="noopener">Aide</a>
<a href="/rapport" download>Rapport</a>
<input type="file" id="piece" style="display:none">
<button onclick="document.getElementById('piece').click()">Joindre une pièce</button>
<button onclick="navigator.geolocation.getCurrentPosition(() => {}, () => { document.getElementById('resultat').textContent = 'position refusée'; })">Ma position</button>
<button onclick="location.href = window.EXTERNAL">Site partenaire</button>
</body></html>`;

describe('Browser interactions (outside the DOM)', () => {
  let server: Server;
  let external: Server;
  let url = '';
  let outputDir = '';
  let result: ExplorationResult;
  let downloadsDir = '';

  const listen = async (target: Server): Promise<string> => {
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    return String((target.address() as AddressInfo).port);
  };

  beforeAll(async () => {
    external = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<h1>Partenaire</h1>');
    });
    // Un autre hôte (127.0.0.1 au lieu de localhost) = une autre origine, hors d'allowedHosts.
    const externalUrl = `http://127.0.0.1:${await listen(external)}/`;
    server = createServer((req, res) => {
      const html = (body: string): void => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(body);
      };
      if (req.url === '/rapport') {
        res.writeHead(200, {
          'content-type': 'text/csv',
          'content-disposition': 'attachment; filename="rapport.csv"',
          'content-length': '11',
        });
        res.end('a,b\n1,2\n3,4');
        return;
      }
      if (req.url === '/document') {
        html('<!doctype html><title>Document</title><h1>Document partagé</h1>');
        return;
      }
      if (req.url === '/aide') {
        html('<!doctype html><title>Aide</title><h1>Centre d’aide</h1>');
        return;
      }
      html(
        PAGE.replace('<body>', `<body><script>window.EXTERNAL = ${JSON.stringify(externalUrl)};</script>`),
      );
    });
    url = `http://localhost:${await listen(server)}`;
    outputDir = await mkdtemp(path.join(tmpdir(), 'qa-interactions-'));
    downloadsDir = path.join(outputDir, 'reports');

    const click = (name: string, extra = ''): string =>
      `      - click: { role: button, name: "${name}" }\n${extra}`;
    const { config } = parseConfig(
      `
mission:
  name: interactions
target:
  baseUrl: ${url}
exploration:
  autonomous: false
  settleTimeMs: 150
  actionTimeoutMs: 5000
browserInteractions:
  dialogs:
    confirm: accept-safe
    promptValues:
      - { match: "Nom du dossier", value: "Dossier QA" }
report:
  language: fr
output:
  reportsDir: ${downloadsDir}
  screenshotsDir: ${path.join(outputDir, 'screenshots')}
flows:
  - name: interactions
    steps:
${click("Afficher l'alerte")}
${click('Question risquée')}
      - expect: { text: annulé }
${click('Question simple')}
      - expect: { text: suite }
${click('Nommer')}
      - expect: { text: "nom:Dossier QA" }
${click('Code')}
      - expect: { text: "code:null" }
${click('Voir le document')}
      - click: { role: link, name: Aide }
      - click: { role: link, name: Rapport }
${click('Joindre une pièce')}
${click('Ma position')}
      - expect: { text: position refusée }
${click('Site partenaire', '        optional: true\n')}
`,
      {},
      {},
    );
    ({ result } = await runMission(config));
  });

  afterAll(async () => {
    const close = (target: Server) =>
      new Promise<void>((resolve) => {
        target.close(() => {
          resolve();
        });
      });
    await close(server);
    await close(external);
  });

  const ofType = (type: BrowserInteractionType): BrowserInteractionResult[] =>
    result.browserInteractions.filter((interaction) => interaction.type === type);

  it('keeps the flow going through every interaction', () => {
    const steps = result.flows[0]?.steps ?? [];
    // Chaque étape a réussi sauf la dernière, qui quitte les origines autorisées.
    expect(steps.slice(0, -1).map((step) => [step.description, step.status])).toEqual(
      steps.slice(0, -1).map((step) => [step.description, 'PASSED']),
    );
  });

  it('JS alert: accepted and recorded', () => {
    expect(ofType('JS_ALERT')[0]).toMatchObject({
      status: 'HANDLED',
      outcome: 'DIALOG_ACCEPTED',
      handler: 'DialogHandler',
      details: { message: 'Bonjour' },
      flow: 'interactions',
    });
  });

  it('JS confirm: a destructive confirmation is never accepted, a harmless one is (accept-safe)', () => {
    const [risky, simple] = ofType('JS_CONFIRM');
    expect(risky).toMatchObject({ status: 'HANDLED', outcome: 'DIALOG_DISMISSED', action: 'DISMISS' });
    expect(risky?.reason).toContain('never confirmed automatically');
    expect(simple).toMatchObject({ status: 'HANDLED', outcome: 'DIALOG_ACCEPTED' });
  });

  it('JS prompt: answered only with a value from the mission, never invented', () => {
    const [named, secret] = ofType('JS_PROMPT');
    expect(named).toMatchObject({ status: 'HANDLED', outcome: 'PROMPT_ANSWERED' });
    expect(JSON.stringify(named)).not.toContain('Dossier QA');
    expect(secret).toMatchObject({ status: 'BLOCKED', outcome: 'PROMPT_VALUE_REQUIRED' });
  });

  it('popup: linked to the action, observed as a new state, then closed', () => {
    const [popup] = ofType('POPUP');
    expect(popup).toMatchObject({ status: 'HANDLED', outcome: 'POPUP_OBSERVED', originClass: 'SAME_ORIGIN' });
    expect(popup?.targetUrl).toBe(`${url}/document`);
    expect(popup?.actionId).toBeDefined();
    const state = result.states.find((candidate) => candidate.id === popup?.targetStateId);
    expect(state?.headings).toContain('Document partagé');
    const edge = result.transitions.find((transition) => transition.interaction?.id === popup?.id);
    expect(edge).toMatchObject({ from: popup?.stateId, to: popup?.targetStateId, result: 'SUCCESS' });
  });

  it('new tab (no opener): recorded as NEW_TAB and observed', () => {
    const [tab] = ofType('NEW_TAB');
    expect(tab).toMatchObject({ status: 'HANDLED', outcome: 'POPUP_OBSERVED', details: { opener: false } });
    expect(result.states.some((state) => state.headings.includes('Centre d’aide'))).toBe(true);
  });

  it('download: source action, file name, MIME type and size recorded; nothing saved', async () => {
    const [download] = ofType('DOWNLOAD');
    expect(download).toMatchObject({
      status: 'HANDLED',
      outcome: 'DOWNLOAD_RECORDED',
      details: { filename: 'rapport.csv', mimeType: 'text/csv', size: 11, saved: false },
    });
    expect(download?.actionId).toBeDefined();
    expect((await readdir(downloadsDir)).some((file) => file.endsWith('.csv'))).toBe(false);
  });

  it('file chooser: FILE_INPUT_REQUIRED, no file picked', () => {
    expect(ofType('FILE_CHOOSER')[0]).toMatchObject({
      status: 'BLOCKED',
      outcome: 'FILE_INPUT_REQUIRED',
      blocking: false,
    });
    expect(result.issues.some((issue) => issue.message.includes('FILE_INPUT_REQUIRED'))).toBe(true);
  });

  it('permission request: denied by the safety policy (not granted by the mission)', () => {
    expect(ofType('PERMISSION_REQUEST')[0]).toMatchObject({
      status: 'BLOCKED',
      outcome: 'PERMISSION_DENIED',
      details: { permission: 'geolocation' },
    });
  });

  it('external navigation: classified EXTERNAL_ORIGIN and not explored', () => {
    expect(ofType('EXTERNAL_NAVIGATION')[0]).toMatchObject({
      status: 'BLOCKED',
      outcome: 'EXTERNAL_ORIGIN',
      originClass: 'EXTERNAL_ORIGIN',
    });
    expect(result.states.some((state) => state.headings.includes('Partenaire'))).toBe(false);
  });

  it('reports the interactions in JSON and HTML', async () => {
    const json = JSON.parse(
      await readFile(path.join(downloadsDir, 'result.json'), 'utf8'),
    ) as ExplorationResult;
    expect(json.browserInteractions.length).toBe(result.browserInteractions.length);
    expect(json.stats.interactionsByType).toMatchObject({ JS_CONFIRM: 2, JS_PROMPT: 2, DOWNLOAD: 1 });
    const html = await readFile(path.join(downloadsDir, 'index.html'), 'utf8');
    for (const text of ['Interactions navigateur', 'JS_CONFIRM', 'FILE_INPUT_REQUIRED', 'rapport.csv']) {
      expect(html, text).toContain(text);
    }
  });
});
