import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readinessSummary, ScreenReadinessService } from '../../src/observation/screen-readiness.js';

/**
 * SCREEN READINESS, sur un vrai DOM : attendre ce qui empêche VRAIMENT d'agir (calque, chargeur,
 * cible absente / inactive, requête critique), jamais l'habillage du contrôle lui-même ; un délai
 * dépassé n'est jamais un échec (`proceed`).
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

const service = (overrides: Partial<ConstructorParameters<typeof ScreenReadinessService>[0]> = {}) =>
  new ScreenReadinessService({
    timeoutMs: 1500,
    stabilityWindowMs: 100,
    maxDomMutationWaitMs: 600,
    waitForCriticalNetwork: false,
    ...overrides,
  });
const setContent = async (body: string, script = ''): Promise<void> => {
  await page.setContent(`<main><h1>Request</h1>${body}</main>${script ? `<script>${script}</script>` : ''}`);
};

describe('ScreenReadinessService — the control’s own skin is never an obstacle', () => {
  it('a native radio hidden under a styled sibling div of its component (the real case): READY at once, no target_covered', async () => {
    await setContent(`
      <app-radio-group formcontrolname="needsFunding">
        <app-radio style="position:relative;display:inline-block;padding:4px">
          <input id="r1" type="radio" name="g" value="YES" style="position:absolute;opacity:0;width:1px;height:1px">
          <label for="r1" style="padding-left:24px">Yes</label>
          <div class="skin" style="position:absolute;inset:0"></div>
        </app-radio>
        <app-radio style="position:relative;display:inline-block;padding:4px">
          <input id="r2" type="radio" name="g" value="NO" style="position:absolute;opacity:0;width:1px;height:1px">
          <label for="r2" style="padding-left:24px">No</label>
          <div class="skin" style="position:absolute;inset:0"></div>
        </app-radio>
      </app-radio-group>`);
    const state = await service().waitUntilReady(page, {
      target: page.locator('app-radio-group[formcontrolname="needsFunding"] input[value="YES"]'),
      kind: 'check',
    });
    expect(state.status, readinessSummary(state)).toBe('READY');
    expect(state.reasons).not.toContain('target_covered');
    expect(state.advisories).toContain('covered_by_own_control');
    expect(state.durationMs).toBeLessThan(800);
  });

  it('the LABEL is the target ("click text=No") and its own radio input sits over it: READY, never target_covered', async () => {
    await setContent(`
      <app-radio-group formcontrolname="needsFunding">
        <app-radio style="position:relative;display:inline-block;padding:4px">
          <input id="n1" type="radio" name="g2" value="NO" style="position:absolute;inset:0;opacity:0;margin:0;width:100%;height:100%">
          <label for="n1" style="padding:4px 4px 4px 24px">No</label>
        </app-radio>
      </app-radio-group>`);
    const state = await service().waitUntilReady(page, {
      target: page.getByText('No', { exact: true }),
      kind: 'click',
    });
    expect(state.status, readinessSummary(state)).toBe('READY');
    expect(state.reasons).not.toContain('target_covered');
  });

  it('a design-system radio: the native input hidden with position:fixed + opacity:0 over its label (no for=): READY', async () => {
    await setContent(
      `
      <app-radio style="display:inline-block">
        <label id="lbl" style="display:inline-block;padding:4px 4px 4px 24px">Non</label>
        <input id="native" type="radio" name="g3" value="NON" style="position:fixed;opacity:0;margin:0">
      </app-radio>`,
      `const box = document.getElementById('lbl').getBoundingClientRect();
       Object.assign(document.getElementById('native').style, {
         left: box.left + 'px', top: box.top + 'px', width: box.width + 'px', height: box.height + 'px',
       });`,
    );
    const label = page.getByText('Non', { exact: true });
    // Le cas réel : le pointeur au centre du libellé tombe sur l'input natif (invisible, fixe).
    expect(
      await label.evaluate((el) => {
        const box = el.getBoundingClientRect();
        return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.id;
      }),
    ).toBe('native');
    const state = await service().waitUntilReady(page, { target: label, kind: 'click' });
    expect(state.status, readinessSummary(state)).toBe('READY');
    expect(state.reasons).not.toContain('target_covered');
  });

  it('a checkbox inside its <label> with a styled box over it, and a Material-like wrapper: READY', async () => {
    await setContent(`
      <label class="box" style="position:relative;display:inline-block;padding:4px 4px 4px 28px">
        <input type="checkbox" name="terms" style="position:absolute;left:4px;opacity:0">
        <span style="position:absolute;left:4px;top:4px;width:16px;height:16px;border:1px solid"></span> Accept terms
      </label>
      <mat-checkbox style="position:relative;display:inline-block;width:120px;height:24px">
        <input type="checkbox" name="news" style="position:absolute;inset:0;opacity:0">
        <div style="position:absolute;inset:0;background:#eee">Newsletter</div>
      </mat-checkbox>`);
    for (const selector of ['input[name="terms"]', 'input[name="news"]']) {
      const state = await service().waitUntilReady(page, { target: page.locator(selector), kind: 'check' });
      expect(state.status, `${selector}: ${readinessSummary(state)}`).toBe('READY');
    }
  });

  it('an in-flow decorative element over a button (layout, not a layer): advisory only', async () => {
    await setContent(`
      <div style="position:relative;width:160px;height:40px">
        <button id="go" style="width:160px;height:40px">Continue</button>
        <span style="position:absolute;inset:0;pointer-events:auto"></span>
      </div>`);
    const state = await service().waitUntilReady(page, { target: page.locator('#go'), kind: 'click' });
    expect(state.status, readinessSummary(state)).toBe('READY');
    expect(state.advisories).toContain('covered_by_in_flow_element');
  });
});

describe('ScreenReadinessService — real obstacles are waited for, never turned into a failure', () => {
  it('a fixed full-page layer over the target: target_covered (OVERLAY) until the bound, then TIMEOUT with proceed=true', async () => {
    await setContent(
      `<button id="go">Continue</button><div id="layer" style="position:fixed;inset:0;background:rgba(0,0,0,.3)"></div>`,
    );
    const state = await service({ timeoutMs: 600 }).waitUntilReady(page, {
      target: page.locator('#go'),
      kind: 'click',
    });
    expect(state.status).toBe('TIMEOUT');
    expect(state.proceed).toBe(true);
    expect(state.reasons).toContain('target_covered');
    expect(state.obstruction?.coveringKind).toBe('OVERLAY');
  });

  it('the layer goes away (a closing dialog backdrop): READY as soon as it is gone', async () => {
    await setContent(
      `<button id="go">Continue</button><div class="cdk-overlay-backdrop" style="position:fixed;inset:0"></div>`,
      `setTimeout(() => document.querySelector('.cdk-overlay-backdrop').remove(), 300);`,
    );
    const state = await service().waitUntilReady(page, { target: page.locator('#go'), kind: 'click' });
    expect(state.status, readinessSummary(state)).toBe('READY');
    expect(state.durationMs).toBeGreaterThanOrEqual(250);
  });

  it('a dialog that CONTAINS the target is not an obstacle; one that does not is a blocking modal', async () => {
    await setContent(`
      <button id="behind">Behind</button>
      <div role="dialog" aria-modal="true" style="position:fixed;inset:0;background:#fff">
        <button id="inside">Confirm</button>
      </div>`);
    const inside = await service().waitUntilReady(page, { target: page.locator('#inside'), kind: 'click' });
    expect(inside.status, readinessSummary(inside)).toBe('READY');
    const behind = await service({ timeoutMs: 400 }).waitUntilReady(page, {
      target: page.locator('#behind'),
      kind: 'click',
    });
    expect(behind.reasons).toContain('target_covered');
    expect(behind.obstruction?.modal).toBe(true);
  });

  it('a loader overlapping the target, then removed: application_loader_visible, then READY', async () => {
    await setContent(
      `<div style="position:relative"><button id="go">Save</button><div class="spinner" style="position:absolute;inset:0"></div></div>`,
      `setTimeout(() => document.querySelector('.spinner').remove(), 300);`,
    );
    const seen: string[][] = [];
    const state = await service().waitUntilReady(page, {
      target: page.locator('#go'),
      kind: 'click',
      onState: (current) => seen.push(current.reasons),
    });
    expect(state.status, readinessSummary(state)).toBe('READY');
    expect(seen.flat()).toContain('application_loader_visible');
  });

  it('a small spinner ELSEWHERE on the screen does not delay the target', async () => {
    await setContent(
      `<button id="go">Save</button><aside style="margin-top:300px"><span class="spinner" style="display:inline-block;width:16px;height:16px"></span></aside>`,
    );
    const state = await service().waitUntilReady(page, { target: page.locator('#go'), kind: 'click' });
    expect(state.status, readinessSummary(state)).toBe('READY');
  });

  it('a button enabled later is waited for; one disabled forever ends in TIMEOUT (proceed), not a failure', async () => {
    await setContent(
      `<button id="later" disabled>Next</button><button id="never" disabled>Never</button>`,
      `setTimeout(() => document.getElementById('later').disabled = false, 300);`,
    );
    const later = await service().waitUntilReady(page, { target: page.locator('#later'), kind: 'click' });
    expect(later.status, readinessSummary(later)).toBe('READY');
    const never = await service({ timeoutMs: 400 }).waitUntilReady(page, {
      target: page.locator('#never'),
      kind: 'click',
    });
    expect(never).toMatchObject({ status: 'TIMEOUT', proceed: true, reasons: ['target_disabled'] });
    // Une vérification (expect) n'exige pas une cible active.
    const check = await service().waitUntilReady(page, { target: page.locator('#never'), kind: 'expect' });
    expect(check.status).toBe('READY');
  });

  it('a read-only field blocks a fill only; a missing target that appears later is waited for', async () => {
    await setContent(
      `<input id="ro" readonly value="x">`,
      `setTimeout(() => { const i = document.createElement('input'); i.id = 'late'; document.querySelector('main').appendChild(i); }, 300);`,
    );
    const fill = await service({ timeoutMs: 400 }).waitUntilReady(page, {
      target: page.locator('#ro'),
      kind: 'fill',
    });
    expect(fill.reasons).toContain('target_not_editable');
    const click = await service().waitUntilReady(page, { target: page.locator('#ro'), kind: 'click' });
    expect(click.status).toBe('READY');
    const late = await service().waitUntilReady(page, { target: page.locator('#late'), kind: 'fill' });
    expect(late.status, readinessSummary(late)).toBe('READY');
  });

  it('a critical request still pending is waited for (network observer)', async () => {
    await setContent(`<button id="go">Save</button>`);
    const until = Date.now() + 300;
    const state = await service({ waitForCriticalNetwork: true }).waitUntilReady(page, {
      target: page.locator('#go'),
      kind: 'click',
      network: () => ({ pending: Date.now() < until ? 1 : 0 }),
    });
    expect(state.status, readinessSummary(state)).toBe('READY');
    expect(state.durationMs).toBeGreaterThanOrEqual(250);
  });
});

describe('ScreenReadinessService — screens that never stop moving', () => {
  it('a clock / live region / spinner updating forever is not "DOM unstable"', async () => {
    await setContent(
      `<button id="go">Save</button><span role="timer" id="t">0</span><div aria-live="polite" id="live"></div>`,
      `let n = 0; setInterval(() => { n += 1; document.getElementById('t').textContent = String(n); document.getElementById('live').textContent = 'tick ' + n; }, 30);`,
    );
    const state = await service().waitUntilReady(page, { target: page.locator('#go'), kind: 'click' });
    expect(state.status, readinessSummary(state)).toBe('READY');
    expect(state.durationMs).toBeLessThan(500);
  });

  it('an ordinary element changing forever: dom_unstable only until maxDomMutationWaitMs, then READY (dom_unstable_ignored)', async () => {
    await setContent(
      `<button id="go">Save</button><p id="p">0</p>`,
      `let n = 0; setInterval(() => { n += 1; document.getElementById('p').textContent = String(n); }, 30);`,
    );
    const state = await service().waitUntilReady(page, { target: page.locator('#go'), kind: 'click' });
    expect(state.status, readinessSummary(state)).toBe('READY');
    expect(state.advisories).toContain('dom_unstable_ignored');
    expect(state.durationMs).toBeGreaterThanOrEqual(550);
  });

  it('a target below the fold is scrolled into view once, then READY', async () => {
    await setContent(`<div style="height:3000px"></div><button id="far">Far away</button>`);
    const state = await service().waitUntilReady(page, { target: page.locator('#far'), kind: 'click' });
    expect(state.status, readinessSummary(state)).toBe('READY');
    expect(state.advisories).toContain('target_scrolled_into_view');
  });

  it('a moving target (slide-in animation) is waited for until it stops', async () => {
    await setContent(
      `<button id="go" style="position:relative;left:0">Save</button>`,
      `let x = 0; const id = setInterval(() => { x += 10; document.getElementById('go').style.left = x + 'px'; if (x >= 100) clearInterval(id); }, 30);`,
    );
    const state = await service().waitUntilReady(page, { target: page.locator('#go'), kind: 'click' });
    expect(state.status, readinessSummary(state)).toBe('READY');
    expect(await page.locator('#go').evaluate((el) => (el as HTMLElement).style.left)).toBe('100px');
  });

  it('after an action (no target): an open dialog is a normal state; only a full-screen loader is waited for', async () => {
    await setContent(`<div role="dialog" aria-modal="true" style="position:fixed;inset:0">Details</div>`);
    const dialog = await service().waitUntilReady(page);
    expect(dialog.status, readinessSummary(dialog)).toBe('READY');
    await setContent(
      `<div class="loading" style="position:fixed;inset:0"></div>`,
      `setTimeout(() => document.querySelector('.loading').remove(), 300);`,
    );
    const loader = await service().waitUntilReady(page);
    expect(loader.status, readinessSummary(loader)).toBe('READY');
    expect(loader.durationMs).toBeGreaterThanOrEqual(250);
  });

  it('a closed page: proceed=false (page_closed)', async () => {
    await setContent(`<button id="go">Save</button>`);
    const closing = service().waitUntilReady(page, { target: page.locator('#missing'), kind: 'click' });
    await page.close();
    const state = await closing;
    expect(state).toMatchObject({ proceed: false, reasons: ['page_closed'] });
  });
});
