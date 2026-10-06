import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clickRobust } from '../../src/execution/robust-click.js';

/**
 * ROBUST CLICK, vrai navigateur : le contrôle d'une cible posé sur elle (input natif invisible d'un
 * radio sur son libellé) n'est jamais un obstacle — le clic d'un humain au même endroit ; un VRAI
 * calque étranger n'est jamais forcé, et l'erreur dit ce qui recouvre la cible.
 */
let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
});
beforeEach(async () => {
  page = await browser.newPage();
});

/** Un radio de bibliothèque de composants : input natif fixe et invisible, posé exactement sur son libellé. */
const RADIOS = `<main><h1>Request</h1>
<app-radio-group>
  <app-radio style="display:inline-block;margin:8px"><label id="yes" style="display:inline-block;padding:4px 4px 4px 24px">Yes</label>
    <input type="radio" name="g" value="YES" style="position:fixed;opacity:0;margin:0"></app-radio>
  <app-radio style="display:inline-block;margin:8px"><label id="no" style="display:inline-block;padding:4px 4px 4px 24px">No</label>
    <input type="radio" name="g" value="NO" style="position:fixed;opacity:0;margin:0"></app-radio>
</app-radio-group></main>
<script>
  for (const radio of document.querySelectorAll('app-radio')) {
    const box = radio.querySelector('label').getBoundingClientRect();
    Object.assign(radio.querySelector('input').style, { left: box.left + 'px', top: box.top + 'px', width: box.width + 'px', height: box.height + 'px' });
  }
</script>`;

describe('robust click (real browser)', () => {
  it('the label "No" is covered by its own invisible radio input: the option is selected, explained in the debug log', async () => {
    await page.setContent(RADIOS);
    const lines: string[] = [];
    await clickRobust(page.getByText('No', { exact: true }), 4000, (line) => lines.push(line));
    expect(await page.locator('input[value="NO"]').isChecked()).toBe(true);
    expect(await page.locator('input[value="YES"]').isChecked()).toBe(false);
    expect(lines.join('\n')).toMatch(/on top <input\[type=radio\] name=g> \(OWN_CONTROL\)/);
    expect(lines.join('\n')).toContain('clicking at the same point (force)');
  });

  it('a clickable target: one normal click, nothing forced', async () => {
    await page.setContent('<button onclick="this.textContent=\'done\'">Go</button>');
    const lines: string[] = [];
    await clickRobust(page.getByRole('button', { name: 'Go' }), 4000, (line) => lines.push(line));
    expect(await page.locator('button').textContent()).toBe('done');
    expect(lines).toEqual(['click: target actionable — normal click']);
  });

  it('a REAL foreign layer over the target: never forced — the error says what covers the target', async () => {
    await page.setContent(`<button onclick="this.textContent='done'">Go</button>
      <div class="backdrop" style="position:fixed;inset:0;background:rgba(0,0,0,.3)"></div>`);
    const lines: string[] = [];
    const error = await clickRobust(page.getByRole('button', { name: 'Go' }), 2500, (line) =>
      lines.push(line),
    ).catch((failure: unknown) => failure as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/on top of the target: <div> \(FOREIGN\)/);
    expect(await page.locator('button').textContent()).toBe('Go');
    expect(lines.join('\n')).not.toContain('force');
  });

  it('the layer goes away: the waiting click goes through (no force)', async () => {
    await page.setContent(`<button onclick="this.textContent='done'">Go</button>
      <div id="layer" style="position:fixed;inset:0"></div>
      <script>setTimeout(() => document.getElementById('layer').remove(), 1800)</script>`);
    const lines: string[] = [];
    await clickRobust(page.getByRole('button', { name: 'Go' }), 5000, (line) => lines.push(line));
    expect(await page.locator('button').textContent()).toBe('done');
    expect(lines.join('\n')).toContain('obstacle gone — normal click');
  });
});
