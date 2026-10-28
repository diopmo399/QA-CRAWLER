import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExplorationResult } from '../../src/model/exploration-result.js';
import { renderFlowGraphHtml } from '../../src/reporting/flow-graph-html-reporter.js';
import { branching, large } from '../fixtures/flow-map.js';

/**
 * LA CARTE DES ÉCRANS VISITÉS DANS CHROMIUM : le texte réel tient dans chaque carte et chaque étiquette, aucune
 * carte n'en recouvre une autre ; l'ajustement suit la taille du cadre, le zoom et le déplacement marchent ;
 * cliquer un écran montre ses détails et ses transitions sans rapetisser la carte ; la mise en avant par statut ;
 * sans JavaScript, la carte se lit et les détails s'ouvrent par ancre.
 */
let browser: Browser;
let dir: string;

beforeAll(async () => {
  browser = await chromium.launch();
  dir = await mkdtemp(path.join(tmpdir(), 'qa-flow-map-'));
});

afterAll(async () => {
  await browser.close();
  await rm(dir, { recursive: true, force: true });
});

async function open(
  result: ExplorationResult,
  viewport = { width: 1360, height: 900 },
  javaScriptEnabled = true,
): Promise<Page> {
  const file = path.join(dir, `map-${String(Math.random()).slice(2)}.html`);
  await writeFile(file, renderFlowGraphHtml(result, 'fr'));
  const context = await browser.newContext({ viewport, javaScriptEnabled });
  const page = await context.newPage();
  await page.goto(`file://${file}`);
  return page;
}

/** Ce que Chromium a réellement dessiné : texte hors de sa carte ou de son étiquette, cartes superposées. */
async function renderedProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const problems: string[] = [];
    const cards = [...document.querySelectorAll<SVGGElement>('.fm-node')].map((node) => {
      const box = (node.querySelector('.fm-card') as SVGRectElement).getBBox();
      for (const text of node.querySelectorAll<SVGTextElement>('text')) {
        const inner = text.getBBox();
        if (
          inner.x < box.x + 4 ||
          inner.x + inner.width > box.x + box.width - 4 ||
          inner.y < box.y ||
          inner.y + inner.height > box.y + box.height
        )
          problems.push(`texte « ${text.textContent} » hors de sa carte`);
      }
      return { id: node.getAttribute('aria-label') ?? '', box };
    });
    for (let i = 0; i < cards.length; i += 1)
      for (let j = i + 1; j < cards.length; j += 1) {
        const a = (cards[i] as (typeof cards)[number]).box;
        const b = (cards[j] as (typeof cards)[number]).box;
        if (a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height)
          problems.push(`cartes superposées : ${cards[i]?.id} / ${cards[j]?.id}`);
      }
    for (const label of document.querySelectorAll<SVGGElement>('.fm-label')) {
      const box = (label.querySelector('rect') as SVGRectElement).getBBox();
      const text = (label.querySelector('text') as SVGTextElement).getBBox();
      if (text.x < box.x + 2 || text.x + text.width > box.x + box.width - 2)
        problems.push(`étiquette « ${label.textContent} » trop étroite`);
      for (const card of cards)
        if (
          box.x < card.box.x + card.box.width &&
          card.box.x < box.x + box.width &&
          box.y < card.box.y + card.box.height &&
          card.box.y < box.y + box.height
        )
          problems.push(`étiquette sur la carte ${card.id}`);
    }
    return problems;
  });
}

const svgWidth = (page: Page): Promise<number> =>
  page.evaluate(
    () => (document.querySelector('.fm-view svg') as SVGSVGElement).getBoundingClientRect().width,
  );
const viewWidth = (page: Page): Promise<number> =>
  page.evaluate(() => (document.querySelector('.fm-view') as HTMLElement).clientWidth);

describe('flow map in Chromium', () => {
  it('real text fits every card and label; no card overlaps another (branching and large journeys)', async () => {
    for (const result of [branching(), large(80)]) {
      const page = await open(result);
      expect(await renderedProblems(page)).toEqual([]);
      expect(await page.locator('.fm-node').count()).toBe(Math.min(80, result.states.length));
      await page.context().close();
    }
  });

  it('fit follows the size of the frame; zoom and actual size; the layout itself never moves', async () => {
    const page = await open(branching());
    const root = page.locator('.fm');
    await expect.poll(() => root.getAttribute('data-mode')).toBe('fit');
    const natural = Number(await page.locator('.fm-view svg').getAttribute('width'));
    expect(await svgWidth(page)).toBeLessThanOrEqual(await viewWidth(page));
    const before = await page.locator('.fm-node').first().getAttribute('aria-label');
    // Le cadre rétrécit : la carte est ajustée de nouveau.
    const wide = await svgWidth(page);
    await page.setViewportSize({ width: 980, height: 900 });
    await expect.poll(() => svgWidth(page)).toBeLessThan(wide);
    expect(await svgWidth(page)).toBeLessThanOrEqual(await viewWidth(page));
    // Taille réelle, zoom avant, zoom arrière, puis de nouveau ajustée.
    await page.click('[data-fm="reset"]');
    expect(await root.getAttribute('data-mode')).toBe('free');
    expect(Math.round(await svgWidth(page))).toBe(natural);
    await page.click('[data-fm="in"]');
    expect(await root.getAttribute('data-scale')).toBe('125');
    await expect.poll(() => page.locator('.fm-scale').textContent()).toBe('125 %');
    await page.click('[data-fm="out"]');
    await page.click('[data-fm="out"]');
    expect(await root.getAttribute('data-scale')).toBe('80');
    await page.click('[data-fm="fit"]');
    expect(await root.getAttribute('data-mode')).toBe('fit');
    await expect.poll(() => page.locator('[data-fm="fit"]').getAttribute('aria-pressed')).toBe('true');
    // La disposition est celle du serveur : seule l'échelle change.
    expect(await page.locator('.fm-node').first().getAttribute('aria-label')).toBe(before);
    expect(Number(await page.locator('.fm-view svg').getAttribute('width'))).toBe(natural);
    await page.context().close();
  });

  it('dragging the background moves the map at actual size', async () => {
    const page = await open(branching(), { width: 900, height: 700 });
    await page.click('[data-fm="reset"]');
    const view = page.locator('.fm-view');
    const box = await view.boundingBox();
    if (!box) throw new Error('no frame');
    // Un point du fond, sans carte dessous.
    await page.mouse.move(box.x + box.width - 20, box.y + 20);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 220, box.y + 20, { steps: 6 });
    await page.mouse.up();
    expect(await view.evaluate((el) => el.scrollLeft)).toBeGreaterThan(100);
    await page.context().close();
  });

  it('a click on a screen shows its details and its transitions, without shrinking the map', async () => {
    const page = await open(branching());
    const root = page.locator('.fm');
    await expect.poll(() => root.getAttribute('data-scale')).not.toBeNull();
    const scale = await root.getAttribute('data-scale');
    const node = page.locator('.fm-node[aria-label^="Fiche de l’élément"]');
    const index = await node.getAttribute('data-node');
    await expect.poll(() => page.locator('.fm-panel').isVisible()).toBe(false);
    await node.click();
    const detail = page.locator(`.fm-detail[data-node="${index ?? ''}"]`);
    await expect.poll(() => detail.isVisible()).toBe(true);
    await expect.poll(() => detail.locator('h3').textContent()).toBe('Fiche de l’élément');
    await expect.poll(() => detail.textContent()).toContain('Actions depuis cet écran (2)');
    await expect.poll(() => detail.textContent()).toContain('clic « Modifier » → Modifier l’élément');
    await expect.poll(() => detail.textContent()).toContain('Arrivées sur cet écran (3)');
    await expect.poll(() => detail.locator('a[href="screenshots/item.png"]').isVisible()).toBe(true);
    await expect.poll(() => node.getAttribute('class')).toMatch(/sel/);
    // Ses transitions sont mises en avant, les autres non.
    const lit = await page
      .locator('.fm-edge.fm-on')
      .evaluateAll((edges) =>
        edges.map((edge) => [edge.getAttribute('data-from'), edge.getAttribute('data-to')]),
      );
    expect(lit.length).toBeGreaterThanOrEqual(4);
    expect(lit.every(([from, to]) => from === index || to === index)).toBe(true);
    // Le panneau est à côté de la carte (écran large) et l'échelle n'a pas changé.
    const panel = await page.locator('.fm-panel').boundingBox();
    const view = await page.locator('.fm-view').boundingBox();
    expect((panel?.x ?? 0) >= (view?.x ?? 0) + (view?.width ?? 0)).toBe(true);
    expect(await root.getAttribute('data-scale')).toBe(scale);
    // Un autre écran remplace le premier ; Échap ferme.
    await page.locator('.fm-node[aria-label^="Paramètres"]').click();
    await expect.poll(() => page.locator('.fm-detail.on h3').textContent()).toBe('Paramètres');
    await expect.poll(() => page.locator('.fm-node.sel').count()).toBe(1);
    await page.keyboard.press('Escape');
    await expect.poll(() => page.locator('.fm-panel').isVisible()).toBe(false);
    await expect.poll(() => page.locator('.fm-node.sel').count()).toBe(0);
    await page.context().close();
  });

  it('on a phone the details come under the map; the map keeps its own frame', async () => {
    const page = await open(branching(), { width: 390, height: 844 });
    await page.locator('.fm-node[aria-label^="Profil"]').click();
    const panel = await page.locator('.fm-panel').boundingBox();
    const view = await page.locator('.fm-view').boundingBox();
    expect((panel?.y ?? 0) >= (view?.y ?? 0) + (view?.height ?? 0)).toBe(true);
    // Rien ne déborde de la page en largeur.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(
      true,
    );
    await page.context().close();
  });

  it('filters by status dim the other screens and transitions', async () => {
    const page = await open(branching());
    await page.click('[data-fm-filter="FAIL"]');
    await expect
      .poll(() => page.locator('[data-fm-filter="FAIL"]').getAttribute('aria-pressed'))
      .toBe('true');
    await expect
      .poll(() => page.locator('.fm-node[data-status="FAIL"]').getAttribute('class'))
      .not.toMatch(/fm-dim/);
    expect(await page.locator('.fm-node.fm-dim').count()).toBe(10);
    expect(await page.locator('.fm-node[data-status="FAIL"]').count()).toBe(1);
    await page.click('[data-fm-filter="ALL"]');
    expect(await page.locator('.fm-dim').count()).toBe(0);
    await page.context().close();
  });

  it('without JavaScript the map still reads, and a screen opens its details through its anchor', async () => {
    const page = await open(branching(), { width: 1360, height: 900 }, false);
    await expect.poll(() => page.locator('.fm-tools').isVisible()).toBe(false);
    await expect.poll(() => page.locator('.fm-view svg').isVisible()).toBe(true);
    await expect.poll(() => page.locator('.fm-panel').isVisible()).toBe(false);
    await page.locator('.fm-node[aria-label^="Commandes"]').click();
    await expect.poll(() => page.locator('.fm-detail:target h3').textContent()).toBe('Commandes');
    await expect.poll(() => page.locator('.fm-panel').isVisible()).toBe(true);
    await page.context().close();
  });
});
