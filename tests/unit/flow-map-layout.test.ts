import { describe, expect, it } from 'vitest';
import type { ExplorationResult } from '../../src/model/exploration-result.js';
import {
  CARD,
  layoutFlowMap,
  textWidth,
  type Box,
  type MapLayout,
  type MapLink,
  type MapScreen,
  type Point,
} from '../../src/reporting/flow-map-layout.js';
import { renderFlowMap } from '../../src/reporting/flow-diagram.js';
import { branching, issue, journeyOf, large, linear, move, screen } from '../fixtures/flow-map.js';

/**
 * LA GÉOMÉTRIE DE LA CARTE DES ÉCRANS VISITÉS : cartes sans recouvrement et espacées, flèches orthogonales
 * qui partent et arrivent sur un bord, ne traversent aucune carte et ne partagent jamais un même trajet,
 * étiquettes hors des cartes, statuts fondés sur les preuves, parcours vides, linéaires, ramifiés, cycliques
 * et volumineux.
 */

const layoutOf = (result: ExplorationResult, orientation?: 'TB' | 'LR'): MapLayout => {
  const layout = layoutFlowMap(result, orientation ? { orientation } : {});
  if (!layout) throw new Error('no layout');
  return layout;
};
const byId = (layout: MapLayout, id: string): MapScreen => {
  const found = layout.screens.find((item) => item.id === id);
  if (!found) throw new Error(id);
  return found;
};
const segments = (link: MapLink): [Point, Point][] =>
  link.points.slice(1).map((point, index) => [link.points[index] as Point, point]);
const intersects = (a: Box, b: Box, gap = 0): boolean =>
  a.x < b.x + b.width + gap &&
  b.x < a.x + a.width + gap &&
  a.y < b.y + b.height + gap &&
  b.y < a.y + a.height + gap;
/** Un segment orthogonal entre-t-il dans l'intérieur d'une carte ? */
const crosses = ([a, b]: [Point, Point], box: Box): boolean => {
  const inner = { x: box.x + 0.5, y: box.y + 0.5, width: box.width - 1, height: box.height - 1 };
  const seg = {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x) || 0.01,
    height: Math.abs(a.y - b.y) || 0.01,
  };
  return intersects(seg, inner);
};
const onBorder = (point: Point, box: Box): boolean => {
  const within = (value: number, from: number, to: number): boolean =>
    value >= from - 0.5 && value <= to + 0.5;
  const onVertical =
    (Math.abs(point.x - box.x) < 0.5 || Math.abs(point.x - box.x - box.width) < 0.5) &&
    within(point.y, box.y, box.y + box.height);
  const onHorizontal =
    (Math.abs(point.y - box.y) < 0.5 || Math.abs(point.y - box.y - box.height) < 0.5) &&
    within(point.x, box.x, box.x + box.width);
  return onVertical || onHorizontal;
};

/** Les invariants de toute carte : la liste de ce qui les enfreint (vide quand la carte est lisible). */
function problemsOf(layout: MapLayout): string[] {
  const problems: string[] = [];
  const screens = layout.screens;
  // Aucune carte ne recouvre une autre, et chacune garde de l'air autour d'elle.
  for (let i = 0; i < screens.length; i += 1)
    for (let j = i + 1; j < screens.length; j += 1)
      if (intersects(screens[i] as Box, screens[j] as Box, 40))
        problems.push(`cartes trop proches : ${screens[i]?.id} / ${screens[j]?.id}`);
  // Tout est dans le cadre, avec la marge intérieure.
  for (const box of [...screens, ...layout.links.flatMap((link) => (link.label ? [link.label] : []))])
    if (
      box.x < 32 ||
      box.y < 32 ||
      box.x + box.width > layout.width - 32 ||
      box.y + box.height > layout.height - 32
    )
      problems.push(`hors de la marge : ${JSON.stringify(box)}`);
  const all = layout.links.flatMap((link) => segments(link).map((segment) => ({ link, segment })));
  for (const link of layout.links) {
    const name = `${link.from}→${link.to}`;
    const from = byId(layout, link.from);
    const to = byId(layout, link.to);
    if (link.points.length < 2) problems.push(`${name} : moins de deux points`);
    // Départ et arrivée sur un bord : jamais au centre ni à l'intérieur d'une carte.
    if (!onBorder(link.points[0] as Point, from)) problems.push(`${name} : départ hors du bord`);
    if (!onBorder(link.points.at(-1) as Point, to)) problems.push(`${name} : arrivée hors du bord`);
    for (const segment of segments(link)) {
      const [a, b] = segment;
      // Orthogonal : horizontal ou vertical.
      if (!(Math.abs(a.x - b.x) < 0.01 || Math.abs(a.y - b.y) < 0.01))
        problems.push(`${name} : segment oblique`);
      // Ne traverse aucune carte, ni celles de la transition ni les autres.
      for (const box of screens) if (crosses(segment, box)) problems.push(`${name} traverse ${box.id}`);
    }
    // Le dernier segment arrive perpendiculairement au bord, assez long pour la pointe : la direction se lit.
    const [beforeLast, last] = [link.points.at(-2) as Point, link.points.at(-1) as Point];
    if (Math.hypot(last.x - beforeLast.x, last.y - beforeLast.y) < 10)
      problems.push(`${name} : arrivée trop courte`);
  }
  // Deux transitions ne partagent jamais un même trajet (segments colinéaires qui se recouvrent).
  for (let i = 0; i < all.length; i += 1)
    for (let j = i + 1; j < all.length; j += 1) {
      const p = all[i] as (typeof all)[number];
      const q = all[j] as (typeof all)[number];
      if (p.link === q.link) continue;
      const [a, b] = p.segment;
      const [c, d] = q.segment;
      const vertical = Math.abs(a.x - b.x) < 0.01 && Math.abs(c.x - d.x) < 0.01 && Math.abs(a.x - c.x) < 1;
      const horizontal = Math.abs(a.y - b.y) < 0.01 && Math.abs(c.y - d.y) < 0.01 && Math.abs(a.y - c.y) < 1;
      const shared = vertical
        ? Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y)) - Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y))
        : horizontal
          ? Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) -
            Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x))
          : 0;
      if (shared > 2)
        problems.push(
          `trajet partagé (${shared.toFixed(0)} px) : ${p.link.from}→${p.link.to} / ${q.link.from}→${q.link.to}`,
        );
    }
  // Les étiquettes : hors des cartes, sans se recouvrir, posées sur leur propre flèche.
  const labels = layout.links.filter((link) => link.label);
  for (const link of labels) {
    const label = link.label as Box;
    for (const box of screens)
      if (intersects(label, box)) problems.push(`étiquette ${link.to} sur ${box.id}`);
    const center = { x: label.x + label.width / 2, y: label.y + label.height / 2 };
    const [a, b] = segments(link).at(-1) as [Point, Point];
    const onLast =
      Math.abs(a.x - b.x) < 0.01
        ? Math.abs(center.x - a.x) < 0.5 && center.y >= Math.min(a.y, b.y) && center.y <= Math.max(a.y, b.y)
        : Math.abs(center.y - a.y) < 0.5 && center.x >= Math.min(a.x, b.x) && center.x <= Math.max(a.x, b.x);
    if (!onLast) problems.push(`étiquette ${link.to} hors de sa flèche`);
  }
  for (let i = 0; i < labels.length; i += 1)
    for (let j = i + 1; j < labels.length; j += 1)
      if (intersects(labels[i]?.label as Box, labels[j]?.label as Box))
        problems.push(`étiquettes superposées : ${labels[i]?.to} / ${labels[j]?.to}`);
  return problems;
}

const expectReadable = (layout: MapLayout): void => {
  expect(problemsOf(layout)).toEqual([]);
};

describe('flow map layout', () => {
  it('1. a linear journey reads top to bottom, one column, with room between the rows', () => {
    const layout = layoutOf(linear(6));
    expect(layout.orientation).toBe('TB');
    expectReadable(layout);
    const screens = layout.screens;
    const centers = new Set(screens.map((item) => item.x + item.width / 2));
    expect(centers.size).toBe(1);
    for (let index = 1; index < screens.length; index += 1) {
      const gap =
        (screens[index]?.y ?? 0) - ((screens[index - 1]?.y ?? 0) + (screens[index - 1]?.height ?? 0));
      expect(gap).toBeGreaterThanOrEqual(70);
      expect(gap).toBeLessThanOrEqual(110);
    }
    // Chaque transition : une flèche droite, son action posée dessus.
    expect(layout.links.every((link) => link.kind === 'tree' && link.points.length === 2)).toBe(true);
    expect(layout.links.map((link) => link.label?.text)).toEqual([
      'Suivant s1',
      'Suivant s2',
      'Suivant s3',
      'Suivant s4',
      'Suivant s5',
    ]);
  });

  it('2. alternative branches take distinct columns, separated, with a natural reading order', () => {
    const result = journeyOf(
      ['root', 'a', 'b', 'c', 'a2', 'b2', 'c2'].map((id) => screen(id)),
      [
        move('root', 'a', 'A', 'PASS'),
        move('root', 'b', 'B', 'PASS'),
        move('root', 'c', 'C', 'PASS'),
        move('a', 'a2', 'A2', 'PASS'),
        move('b', 'b2', 'B2', 'PASS'),
        move('c', 'c2', 'C2', 'PASS'),
      ],
    );
    const layout = layoutOf(result, 'TB');
    expectReadable(layout);
    const [a, b, c] = ['a', 'b', 'c'].map((id) => byId(layout, id));
    expect((a as Box).x).toBeLessThan((b as Box).x);
    expect((b as Box).x).toBeLessThan((c as Box).x);
    // Deux branches voisines : au moins 80 px entre elles ; chaque suite reste dans sa colonne.
    expect((b as Box).x - ((a as Box).x + (a as Box).width)).toBeGreaterThanOrEqual(100);
    for (const id of ['a', 'b', 'c']) expect(byId(layout, `${id}2`).x).toBe(byId(layout, id).x);
    // Le départ est centré au-dessus de ses branches.
    const root = byId(layout, 'root');
    expect(root.x + root.width / 2).toBeCloseTo((b as Box).x + (b as Box).width / 2, 0);
  });

  it('3. several transitions leaving one screen: one port each on its border, spread out', () => {
    const ids = ['root', 'a', 'b', 'c', 'd', 'e', 'f'];
    const layout = layoutOf(
      journeyOf(
        ids.map((id) => screen(id)),
        ids.slice(1).map((id) => move('root', id, id, 'PASS')),
      ),
    );
    expectReadable(layout);
    const starts = layout.links.map((link) => link.points[0] as Point);
    const along = starts
      .map((point) => (layout.orientation === 'TB' ? point.x : point.y))
      .sort((x, y) => x - y);
    for (let index = 1; index < along.length; index += 1)
      expect((along[index] ?? 0) - (along[index - 1] ?? 0)).toBeGreaterThanOrEqual(12);
  });

  it('4. several transitions arriving on one screen: each reaches its own point of the border', () => {
    const ids = ['root', 'hub', 'a', 'b', 'c', 'd'];
    const result = journeyOf(
      ids.map((id) => screen(id)),
      [
        move('root', 'hub', 'Hub', 'PASS'),
        ...['a', 'b', 'c', 'd'].map((id) => move('root', id, id, 'PASS')),
        ...['a', 'b', 'c', 'd'].map((id) => move(id, 'hub', `${id} → hub`, 'PASS')),
      ],
    );
    const layout = layoutOf(result);
    expectReadable(layout);
    const arrivals = layout.links
      .filter((link) => link.to === 'hub')
      .map((link) => link.points.at(-1) as Point);
    expect(arrivals).toHaveLength(5);
    expect(new Set(arrivals.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`)).size).toBe(5);
  });

  it('5. a return to a screen already visited keeps its direction and goes around the cards', () => {
    const result = journeyOf(
      ['list', 'item', 'edit'].map((id) => screen(id)),
      [
        move('list', 'item', 'Ouvrir', 'PASS'),
        move('item', 'edit', 'Modifier', 'PASS'),
        move('edit', 'list', 'Retour', 'PASS'),
      ],
    );
    for (const orientation of ['TB', 'LR'] as const) {
      const layout = layoutOf(result, orientation);
      expectReadable(layout);
      const back = layout.links.find((link) => link.from === 'edit' && link.to === 'list');
      expect(back?.kind).toBe('link');
      expect(onBorder(back?.points.at(-1) as Point, byId(layout, 'list'))).toBe(true);
      expect(onBorder(back?.points[0] as Point, byId(layout, 'edit'))).toBe(true);
    }
  });

  it('6. a cycle (a → b → c → a, b ⇄ c) is drawn without crossing any card', () => {
    const result = journeyOf(
      ['a', 'b', 'c'].map((id) => screen(id)),
      [
        move('a', 'b', 'ab', 'PASS'),
        move('b', 'c', 'bc', 'PASS'),
        move('c', 'a', 'ca', 'PASS'),
        move('c', 'b', 'cb', 'PASS'),
      ],
    );
    for (const orientation of ['TB', 'LR'] as const) {
      const layout = layoutOf(result, orientation);
      expectReadable(layout);
      expect(layout.links.map((link) => `${link.from}${link.to}`).sort()).toEqual(['ab', 'bc', 'ca', 'cb']);
    }
  });

  it('7. long titles, long addresses and long actions wrap or shorten inside their box', () => {
    const layout = layoutOf(branching());
    expectReadable(layout);
    const order = byId(layout, 'order');
    expect(order.title).toContain('vraiment très long pour la carte');
    expect(order.titleLines).toHaveLength(CARD.maxTitleLines);
    expect(order.titleLines.at(-1)).toMatch(/…$/);
    expect(order.routeLines.length).toBeGreaterThan(1);
    const inner = CARD.width - 2 * CARD.padX;
    for (const line of order.titleLines)
      expect(textWidth(line, CARD.titleSize, { bold: true })).toBeLessThanOrEqual(inner);
    for (const line of order.routeLines)
      expect(textWidth(line, CARD.routeSize, { mono: true })).toBeLessThanOrEqual(inner);
    // Une carte plus longue est plus haute, jamais plus large : les cartes comparables gardent la même taille.
    expect(order.height).toBeGreaterThan(byId(layout, 'items').height);
    expect(new Set(layout.screens.map((item) => item.width)).size).toBe(1);
    const label = layout.links.find((link) => link.to === 'order')?.label;
    expect(label?.text).toMatch(/^Voir la commande.*…$/);
    expect(textWidth(label?.text ?? '', 11)).toBeLessThanOrEqual((label?.width ?? 0) - 8);
  });

  it('8. each status comes from the run: issues and checks on arrival, never passed without evidence', () => {
    const layout = layoutOf(branching());
    expect(byId(layout, 'edit').status).toBe('FAIL'); // anomalie ERROR + vérification en échec
    expect(byId(layout, 'settings').status).toBe('WARNING');
    expect(byId(layout, 'items').status).toBe('PASS');
    expect(byId(layout, 'home').status).toBe('UNKNOWN'); // atteint par un retour sans verdict, et départ
    expect(byId(layout, 'security').status).toBe('UNKNOWN'); // arrivée réussie mais aucune vérification
    // « Élément 42 » et « Trier » (sans changer d'écran) : toute action exécutée compte ; 2 arrivées × 2 vérifications.
    expect(byId(layout, 'items')).toMatchObject({ actions: 2, assertions: 4, errors: 0, warnings: 0 });
    expect(byId(layout, 'edit')).toMatchObject({ errors: 1, assertions: 1 });
    const warn = layoutOf(
      journeyOf([screen('a'), screen('b')], [move('a', 'b', 'x', 'PASS')], [issue('w', 'b', 'WARNING', 'w')]),
    );
    expect(byId(warn, 'b').status).toBe('WARNING');
  });

  it('9. no screen, no map; a single screen is a single card', () => {
    expect(layoutFlowMap(journeyOf([], []))).toBeUndefined();
    expect(renderFlowMap(journeyOf([], []))).toBe('');
    const single = layoutOf(journeyOf([screen('only', 'Seul écran')], []));
    expect(single.screens).toHaveLength(1);
    expect(single.links).toHaveLength(0);
    expect(single.width).toBe(CARD.width + 80);
    expectReadable(single);
  });

  it('10. a large journey stays readable and fast; beyond 80 screens the rest is counted', () => {
    const started = performance.now();
    const layout = layoutOf(large(80));
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(1000);
    expect(layout.screens).toHaveLength(80);
    expect(layout.orientation).toBe('LR');
    expect(layout.links.filter((link) => link.kind === 'link').length).toBeGreaterThan(10);
    expectReadable(layout);
    const bigger = layoutOf(large(120));
    expect(bigger.screens).toHaveLength(80);
    expect(bigger.hidden).toBe(40);
  });

  it('the branching journey holds in both orientations; the wide one is laid out left to right', () => {
    expect(layoutOf(branching()).orientation).toBe('LR');
    expectReadable(layoutOf(branching(), 'TB'));
    expectReadable(layoutOf(branching(), 'LR'));
  });

  it('random journeys (branches, returns, shortcuts, cycles) keep every rule, in both orientations', () => {
    // Générateur pseudo-aléatoire à graine fixe : les mêmes parcours à chaque exécution.
    let seed = 20_261_028;
    const random = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    for (let round = 0; round < 60; round += 1) {
      const count = 2 + Math.floor(random() * 22);
      const ids = Array.from({ length: count }, (_, index) => `r${String(index)}`);
      const transitions = ids.slice(1).map((id, index) => {
        const parent = ids[Math.floor(random() * (index + 1))] ?? 'r0';
        return move(parent, id, `Aller ${id}`, random() < 0.7 ? 'PASS' : undefined);
      });
      const extra = Math.floor(random() * count * 1.2);
      for (let index = 0; index < extra; index += 1) {
        const from = ids[Math.floor(random() * count)] ?? 'r0';
        const to = ids[Math.floor(random() * count)] ?? 'r0';
        transitions.push(move(from, to, `Lien ${from}-${to}`));
      }
      const result = journeyOf(
        ids.map((id) => screen(id, random() < 0.2 ? `Un titre d’écran assez long ${id}` : `Écran ${id}`)),
        transitions,
      );
      for (const orientation of ['TB', 'LR'] as const) expectReadable(layoutOf(result, orientation));
    }
  });

  it('a link takes the verdict of the last attempt between its two screens (a later failure shows)', () => {
    const result = journeyOf(
      [screen('a'), screen('b')],
      [move('a', 'b', 'Aller', 'PASS'), move('a', 'b', 'Aller', undefined, 'FAILED')],
    );
    const link = layoutOf(result).links.find((item) => item.to === 'b');
    expect(link?.edge?.result).toBe('FAILED');
    expect(renderFlowMap(result, 'fr')).toContain('stroke="#c62828"');
  });

  it('a screen reached without a recorded transition is tied to the start, without an arrow or action', () => {
    const result = journeyOf([screen('home'), screen('a'), screen('lost')], [move('home', 'a', 'A', 'PASS')]);
    const layout = layoutOf(result);
    const tie = layout.links.find((link) => link.to === 'lost');
    expect(tie).toMatchObject({ kind: 'direct', from: 'home', actions: [] });
    expect(tie?.label).toBeUndefined();
    expect(byId(layout, 'lost').direct).toBe(true);
    expect(renderFlowMap(result, 'fr')).toMatch(/fm-direct"[^>]*><title>[^<]*Atteint sans transition/);
  });
});
