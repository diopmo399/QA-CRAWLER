import path from 'node:path';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CartographyConfig, FeatureMap } from '../../src/sdk/core/cartography.js';
import { buildIndex, type CoverageContext, type MapIndex } from '../../src/cartography/explorer.js';
import { featureMap } from '../../src/cartography/feature-map.js';
import { runScan } from '../../src/cartography/scan.js';
import {
  emptyJourney,
  journeyTab,
  type JourneyHelpers,
} from '../../src/sdk/ui/dashboard-cartography-journey.js';

/**
 * La nature NgRx et signal des éléments dans « Parcours & Graphe » : établie par l'analyseur (le store qu'il
 * ajoute sous `@ngrx/store`, le type des flux `createEffect`, `createReducer`, `signal`, `computed`), jamais
 * par le nom d'une classe du projet ; montrée dans le bandeau d'étapes, les cartes et la fiche.
 * La fixture du moteur de flux n'a pas de routes : une copie temporaire en reçoit deux, pour que ses pages
 * soient des fonctionnalités.
 */
const cov: CoverageContext = {
  links: [],
  coverage: new Map(),
  issues: [],
  lastRuns: new Map(),
  decisions: [],
};
const FIXTURE = path.resolve('tests/fixtures/flow-engine/front');
const ROUTES = `import { Routes } from '@angular/router';
import { OrderPageComponent } from './c16/order.component';
import { CartComponent } from './c18/cart.component';

export const routes: Routes = [
  { path: 'orders', component: OrderPageComponent },
  { path: 'cart', component: CartComponent },
];
`;

let root: string;
let index: MapIndex;
let orders: FeatureMap;
let cart: FeatureMap;
let traced: FeatureMap;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'journey-natures-'));
  const front = path.join(root, 'front');
  await cp(FIXTURE, front, { recursive: true });
  await writeFile(path.join(front, 'src/app/app.routes.ts'), ROUTES);
  const config: CartographyConfig = {
    schema: 1,
    sources: [{ id: 'front', name: 'front', layer: 'FRONTEND', path: front, include: [], enabled: true }],
  };
  const { model } = await runScan({ config, allowedRoots: [root], incremental: false });
  index = buildIndex(model);
  const id = (name: string): string => model.features.find((f) => f.name === name)?.id ?? '';
  orders = featureMap(index, cov, id('Order page')) as FeatureMap;
  cart = featureMap(index, cov, id('Cart')) as FeatureMap;
  const save = orders.items.find((i) => i.kind === 'BUTTON' && i.name === 'Save');
  traced = featureMap(index, cov, id('Order page'), { item: save?.id ?? '' }) as FeatureMap;
}, 120_000);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const helpers = (feature: string): JourneyHelpers => ({
  locale: 'fr',
  conf: (c) => c.toLowerCase(),
  evidence: () => '',
  spinner: () => '',
  paneError: () => '',
  features: [],
  feature,
  loading: false,
});

describe('Parcours & Graphe : natures NgRx et signaux', () => {
  it('les natures viennent de l’analyseur', () => {
    const nature = (name: string): string | undefined =>
      orders.items.find((i) => (i.label ?? i.name) === name)?.nature;
    expect(nature("Store.actions⟨type='[Orders] Save'⟩")).toBe('ACTION');
    expect(nature("Store.dispatch(type='[Orders] Save')")).toBe('DISPATCH');
    expect(nature('OrderEffects.save$')).toBe('EFFECT');
    expect(nature('ordersReducer.state')).toBe('REDUCER');
    // Un flux du composant qui lit le store n'est ni une action ni un effet ; une méthode d'API non plus.
    expect(nature('OrderPageComponent.items$')).toBeUndefined();
    expect(orders.items.filter((i) => i.cardTitle === 'OrderApi').every((i) => !i.nature)).toBe(true);
    // Les signaux : sources et calculés ; un pont vers RxJS reste un flux.
    const inCart = (name: string): string | undefined =>
      cart.items.find((i) => (i.label ?? i.name) === name)?.nature;
    expect(inCart('CartStore.quantity')).toBe('SIGNAL');
    expect(inCart('CartStore.total')).toBe('COMPUTED');
    expect(inCart('CartStore.saved$')).toBeUndefined();
    // Une classe du projet nommée « …Store » n'est pas le store NgRx.
    expect(cart.items.some((i) => i.cardTitle === 'CartStore' && i.nature === 'ACTION')).toBe(false);
  });

  it('le parcours d’un bouton porte la nature de ses étapes', () => {
    const main = traced.trace?.down ?? [];
    expect(main.some((x) => x.nature === 'DISPATCH')).toBe(true);
    expect(main.some((x) => x.nature === 'ACTION')).toBe(true);
    expect(main.some((x) => x.nature === 'EFFECT')).toBe(true);
  });

  it('le bandeau, les cartes et la fiche nomment l’action par son type', () => {
    const html = journeyTab(
      { ...emptyJourney(), jMap: traced, jSelect: traced.trace?.item ?? '' },
      helpers(traced.feature.id),
    ).replaceAll('<wbr>', '');
    const ribbon = html.slice(html.indexOf('data-path'), html.indexOf('data-jr-canvas'));
    // La nature de l'étape : une icône (libellé en infobulle et pour les lecteurs d'écran), puis le nom.
    expect(ribbon).toMatch(
      /title="Envoi d’action">[^]*?Envoi d’action : <\/span><\/span><span>\[Orders\] Save<\/span>/,
    );
    expect(ribbon).toMatch(
      /title="Action NgRx">[^]*?Action NgRx : <\/span><\/span><span>\[Orders\] Save<\/span>/,
    );
    expect(ribbon).toMatch(
      /title="Effet NgRx">[^]*?Effet NgRx : <\/span><\/span><span>OrderEffects\.save\$<\/span>/,
    );
    // Le nom du canal du store reste dans la preuve (infobulle de la relation), pas dans le libellé de l'étape.
    expect(ribbon).not.toMatch(/<span>Store\.(dispatch|actions)/);
    const graph = html.slice(html.indexOf('data-jr-canvas'), html.indexOf('jr-bottom'));
    expect(graph).toContain('<small class="jr-cn">Store NgRx</small>');
    expect(graph).toContain('<small class="jr-cn">Effets NgRx</small>');
    expect(graph).toMatch(/<span>\[Orders\] Save<\/span><i class="jr-nat">envoi<\/i>/);
    expect(graph).toMatch(/<span>save\$<\/span><i class="jr-nat">effet<\/i>/);
    // Les couches que la page n'atteint pas sont des rails titrés ; la largeur minimale suit (1 couloir).
    expect(graph).toMatch(
      /<section class="jr-lane l-bff empty" data-lane="BFF" title="BFF — Aucun élément démontré/,
    );
    expect(graph).toContain('jr-lane l-backend empty');
    expect(graph).toContain('min-width:552px');
    // La fiche d'une action choisie : sa nature et son type.
    const action = traced.items.find((i) => i.nature === 'ACTION' && i.name.includes("'[Orders] Save'"));
    const sheet = journeyTab(
      { ...emptyJourney(), jMap: traced, jSelect: action?.id ?? '' },
      helpers(traced.feature.id),
    );
    expect(sheet).toMatch(/data-info>[^]*<b>\[Orders\] Save<\/b>[^]*Action NgRx/);
  });
});
