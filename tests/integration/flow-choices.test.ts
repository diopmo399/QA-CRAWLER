import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import { runMission } from '../../src/orchestrator.js';

/** Styled radios: the drawing (a positioned span) covers the native input and takes the click. */
const APP = `<!doctype html><html><head><meta charset="utf-8"><title>Dossier</title></head><body>
<h1>Dossier</h1>
<div role="radiogroup" aria-label="Canal de contact">
  <label for="tel" style="position:relative;display:inline-block;padding-left:24px">
    <input id="tel" type="radio" name="canal" value="tel" style="position:absolute;left:0;top:0">
    <span class="drawing" style="position:absolute;left:0;top:0;width:20px;height:20px"></span>Téléphone</label>
  <label for="mail" style="position:relative;display:inline-block;padding-left:24px">
    <input id="mail" type="radio" name="canal" value="mail" style="position:absolute;left:0;top:0">
    <span class="drawing" style="position:absolute;left:0;top:0;width:20px;height:20px"></span>Courriel</label>
</div>
<p id="choice"></p>
<script>
  for (const radio of document.querySelectorAll('input[name="canal"]'))
    radio.addEventListener('change', () => (document.getElementById('choice').textContent = 'Choix : ' + radio.value));
</script></body></html>`;

describe('flow steps on styled radios', () => {
  let server: Server;
  let url: string;

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

  it('checks a radio whose drawing covers the input, through its label', async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), 'qa-choices-'));
    const { config } = parseConfig(
      `
mission: { name: choices }
target: { baseUrl: ${url} }
exploration: { autonomous: false, actionTimeoutMs: 10000, settleTimeMs: 50 }
output:
  reportsDir: ${path.join(outputDir, 'reports')}
  screenshotsDir: ${path.join(outputDir, 'screenshots')}
flows:
  - name: canal
    steps:
      - check: { role: radio, name: Courriel }
      - expect: { text: "Choix : mail" }
`,
      {},
      {},
    );
    const flow = (await runMission(config)).result.flows[0];
    expect(flow?.steps.map((step) => step.status)).toEqual(['PASSED', 'PASSED']);
    // Well before the action timeout.
    expect(flow?.steps[0]?.durationMs).toBeLessThan(8000);
  });
});
