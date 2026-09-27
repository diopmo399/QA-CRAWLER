import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import type { FlowRunReport } from '../../src/model/flow-run.js';
import { runMission } from '../../src/orchestrator.js';

/** Libellés affichés au-dessus des champs mais pas reliés à eux (pas de <label for>, pas d'aria) : getByLabel ne trouve rien. */
const APP = `<!doctype html><html><head><meta charset="utf-8"><title>Dossiers</title></head><body>
<h1>Dossiers</h1>
<div role="dialog" aria-label="Nouveau dossier">
  <div class="row"><div class="title">* Code agence</div><input formcontrolname="agence"><small>99999</small></div>
  <div class="row"><div class="title">* Raison sociale</div><input class="big"></div>
  <div class="row"><div class="title">Canal de contact</div>
    <div><input type="radio" name="canal" value="tel"><span>Téléphone</span></div>
    <div><input type="radio" name="canal" value="mail"><span>Courriel</span></div></div>
  <button>Enregistrer le brouillon</button>
</div></body></html>`;

describe('a flow step that cannot find its element suggests what to write', () => {
  let server: Server;
  let url: string;

  const run = async (steps: string): Promise<FlowRunReport | undefined> => {
    const outputDir = await mkdtemp(path.join(tmpdir(), 'qa-suggest-'));
    const { config } = parseConfig(
      `
mission: { name: suggestions }
target: { baseUrl: ${url} }
exploration: { autonomous: false, actionTimeoutMs: 1500, settleTimeMs: 50 }
output:
  reportsDir: ${path.join(outputDir, 'reports')}
  screenshotsDir: ${path.join(outputDir, 'screenshots')}
flows:
  - name: dossier
    steps:
${steps}
`,
      {},
      {},
    );
    return (await runMission(config)).result.flows[0];
  };

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(APP);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('inspects the screen and proposes the step, ready to paste', async () => {
    const flow = await run(`      - fill: { label: Code agence, value: "12345" }`);
    const step = flow?.steps[0];
    expect(step?.status).toBe('FAILED');
    expect(step?.suggestions).toEqual([
      '- fill: { css: "input[formcontrolname=\\"agence\\"]", value: "12345" }',
      `- fill: { css: "xpath=//*[text()[contains(normalize-space(.),'Code agence')]]/following::*[self::input[not(@type='hidden')] or self::textarea or self::select or @role='combobox'][1]", value: "12345" }`,
    ]);
    expect(step?.onScreen).toEqual(expect.arrayContaining(['Code agence', 'Raison sociale']));
  });

  it('the suggested steps work once pasted in the YAML', async () => {
    // optional : les deux étapes s'exécutent, donc les deux reçoivent une suggestion.
    const first = await run(`      - fill: { label: Raison sociale, value: QA }
        optional: true
      - check: { role: radio, name: Courriel }
        optional: true`);
    const suggestions = first?.steps.map((step) => step.suggestions?.[0] ?? '') ?? [];
    expect(suggestions[0]).toContain('Raison sociale');
    expect(suggestions[1]).toContain('Courriel');
    const fixed = await run(suggestions.map((line) => `      ${line}`).join('\n'));
    expect(fixed?.steps.map((step) => step.status)).toEqual(['PASSED', 'PASSED']);
  });

  it('lists the buttons on screen when nothing looks like the wanted one', async () => {
    const flow = await run(`      - click: { role: button, name: Sauvegarder }`);
    expect(flow?.steps[0]?.suggestions).toBeUndefined();
    expect(flow?.steps[0]?.onScreen).toEqual(['Enregistrer le brouillon']);
  });
});
