import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CartographyConfig, FeatureMap } from '../../src/sdk/core/cartography.js';
import { buildIndex, type CoverageContext } from '../../src/cartography/explorer.js';
import { featureMap } from '../../src/cartography/feature-map.js';
import { runScan } from '../../src/cartography/scan.js';
import { orthPath } from '../../src/sdk/ui/dashboard-cartography-arrows.js';
import {
  emptyJourney,
  journeyTab,
  type JourneyHelpers,
  type JourneyState,
} from '../../src/sdk/ui/dashboard-cartography-journey.js';
import { esc } from '../../src/sdk/ui/view.js';

/**
 * Le parcours du bouton « Valider » (fixture cartography-trace : store RxJS, garde `etat.value.valide`
 * après `await`, deux dispatch, persistance JPA) en workflow et en flux de données, mis en page au rendu.
 */
const cov: CoverageContext = {
  links: [],
  coverage: new Map(),
  issues: [],
  lastRuns: new Map(),
  decisions: [],
};
const ROOT = path.resolve('tests/fixtures/cartography-trace');

let traced: FeatureMap;
beforeAll(async () => {
  const config: CartographyConfig = {
    schema: 1,
    sources: (
      [
        ['front', 'FRONTEND'],
        ['backend', 'BACKEND'],
      ] as const
    ).map(([id, layer]) => ({ id, name: id, layer, path: path.join(ROOT, id), include: [], enabled: true })),
  };
  const { model } = await runScan({ config, allowedRoots: [ROOT], incremental: false });
  const index = buildIndex(model);
  const feature = model.features[0];
  const map = featureMap(index, cov, feature?.id ?? '') as FeatureMap;
  const button = map.items.find((i) => i.kind === 'BUTTON' && i.name === 'Valider');
  traced = featureMap(index, cov, feature?.id ?? '', { item: button?.id ?? '', size: 100 }) as FeatureMap;
}, 120_000);

const helpers: JourneyHelpers = {
  locale: 'fr',
  conf: (c) => c.toLowerCase(),
  evidence: (e) => (e ? `<a class="ev">${e.file}</a>` : ''),
  spinner: () => '<p class="spin"></p>',
  paneError: (t) => (t ? `<p class="err">${t}</p>` : ''),
  features: [],
  feature: '',
  loading: false,
};
const render = (patch: Partial<JourneyState>): string =>
  journeyTab(
    { ...emptyJourney(), jMap: traced, jSelect: traced.trace?.item ?? '', ...patch },
    { ...helpers, feature: traced.feature.id },
  ).replaceAll('<wbr>', '');
/** Les nœuds du diagramme : identifiant, place et classes. */
const nodesOf = (html: string) =>
  [
    ...html.matchAll(
      /class="dg-n ([^"]*)"[^>]*?data-dg="([^"]+)"[^>]*?style="left:(\d+(?:\.\d+)?)px;top:(\d+(?:\.\d+)?)px;width:(\d+)px;height:(\d+)px"/g,
    ),
  ].map((m) => ({
    cls: m[1] ?? '',
    id: m[2] ?? '',
    x: Number(m[3]),
    y: Number(m[4]),
    w: Number(m[5]),
    h: Number(m[6]),
  }));
const edgesOf = (html: string) =>
  [
    ...html.matchAll(
      /<path class="dg-e r-(\w+)( on| off)?" d="[^"]+" marker-end="[^"]+" data-from="([^"]+)" data-to="([^"]+)"/g,
    ),
  ].map((m) => ({ role: m[1] ?? '', state: (m[2] ?? '').trim(), from: m[3] ?? '', to: m[4] ?? '' }));
/** L'identifiant d'une étape tel qu'il est écrit dans le HTML (échappé). */
const named = (name: string) => esc(traced.trace?.down.find((x) => x.name === name)?.id ?? `?${name}`);

describe('flèches à angle droit', () => {
  it('horizontal-vertical-horizontal, coudé au milieu, étiquette sur le segment central', () => {
    expect(orthPath({ x: 0, y: 10 }, { x: 100, y: 50 }, 'h')).toEqual({
      d: 'M0 10L50 10L50 50L100 50',
      mid: { x: 50, y: 30 },
    });
    expect(orthPath({ x: 0, y: 10 }, { x: 100, y: 10 }, 'h').d).toBe('M0 10L100 10');
    expect(orthPath({ x: 10, y: 0 }, { x: 40, y: 80 }, 'v', 30).d).toBe('M10 0L10 30L40 30L40 80');
  });
});

describe('gardes et moments asynchrones dans la trace', () => {
  it('la relation et l’étape portent la garde et le moment lus par le scan', () => {
    const step = traced.trace?.down.find((x) => x.name === "CommandeStore.dispatch('ENREGISTRER')");
    expect(step?.via?.condition).toBe('this.etat.value.valide');
    expect(step?.via?.async).toBe('après await this.api.valider(commande)');
    const rel = traced.relations.items.find((r) => r.toName === "CommandeStore.dispatch('ENREGISTRER')");
    expect(rel?.condition).toBe('this.etat.value.valide');
    // Sans garde lue : rien n'est inventé.
    expect(
      traced.trace?.down.find((x) => x.name === 'CommandeApiService.valider')?.via?.condition,
    ).toBeUndefined();
  });
});

describe('workflow du parcours', () => {
  it('du clic à la table, le chemin principal sur une rangée ; la garde du code devient une décision', () => {
    const html = render({ jStyle: 'flow' });
    expect(html).toContain('<section class="ar dg"');
    expect(html).toMatch(/data-style="flow" aria-pressed="true">Workflow</);
    const nodes = nodesOf(html);
    const main = traced.trace
      ? nodes.filter((n) => n.cls.includes('ar-box') && !n.cls.includes('dg-pill'))
      : [];
    // Le départ (clic de l'utilisateur), puis chaque étape aval de la trace, sans doublon ni chevauchement.
    expect(nodes[0]?.id).toBe('start');
    expect(new Set(nodes.map((n) => n.id)).size).toBe(nodes.length);
    expect(main.length).toBe(traced.trace?.down.length);
    const overlap = nodes.some((a, i) =>
      nodes.some((b, j) => j > i && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h),
    );
    expect(overlap).toBe(false);
    // Le chemin principal (du bouton à la table) est sur la première rangée, de gauche à droite.
    const path = [
      'Valider',
      'CommandeStore.validerEtEnregistrer',
      'CommandeApiService.valider',
      'commandes',
    ].map((n) => nodes.find((x) => x.id === named(n)));
    expect(path.every((n) => n?.y === path[0]?.y)).toBe(true);
    expect(path.map((n) => n?.x ?? 0)).toEqual([...path.map((n) => n?.x ?? 0)].sort((a, b) => a - b));
    // Une décision : la garde lue dans le code, atteinte après l'appel asynchrone (tirets violets), et ses
    // deux branches démontrées marquées « vrai ».
    const dec = nodes.filter((n) => n.cls.startsWith('dg-dec'));
    expect(dec.length).toBe(1);
    expect(html).toContain('title="Décision · this.etat.value.valide"');
    expect(html).toContain('<span class="ar-t">valide ?</span>');
    const edges = edgesOf(html);
    const into = edges.filter((e) => e.to === dec[0]?.id);
    expect(into).toEqual([
      { role: 'dashed', state: '', from: named('CommandeStore.validerEtEnregistrer'), to: dec[0]?.id ?? '' },
    ]);
    const out = edges.filter((e) => e.from === dec[0]?.id).map((e) => e.to);
    expect(out.sort()).toEqual(
      [named("CommandeStore.dispatch('ENREGISTRER')"), named("CommandeStore.dispatch('RAFRAICHIR')")].sort(),
    );
    expect([...html.matchAll(/class="dg-lb r-default" style="[^"]*">vrai</g)].length).toBe(2);
    // Chemin principal en vert avec sa comète ; probable en tirets.
    expect(edges.find((e) => e.to === named('CommandeApiService.valider'))?.role).toBe('emphasis');
    expect(html).toContain('class="dg-c head"');
    expect(edges.find((e) => e.to === named('CommandeStore.etat$'))?.role).toBe('dashed');
    expect(html).toContain('Décision (garde du code)');
  });

  it('cliquer la décision allume son étape d’origine et ses branches ; le reste s’estompe', () => {
    const dec = /data-spot="(dec:[^"]+)"/.exec(render({ jStyle: 'flow' }))?.[1] ?? '';
    const html = render({ jStyle: 'flow', jSpot: true, jSpotId: dec });
    const nodes = nodesOf(html);
    const state = (id: string) => nodes.find((n) => n.id === id)?.cls ?? '';
    expect(state(dec)).toMatch(/ sel$/);
    expect(state(named('CommandeStore.validerEtEnregistrer'))).toMatch(/ near$/);
    expect(state(named("CommandeStore.dispatch('ENREGISTRER')"))).toMatch(/ near$/);
    expect(state(named('commandes'))).toMatch(/ dim$/);
    const edges = edgesOf(html);
    expect(edges.filter((e) => e.state === 'on').length).toBe(3);
    expect(edges.filter((e) => e.state === 'off').length).toBe(edges.length - 3);
    // Une étape hors du chemin principal se met en avant par son identifiant, sans changer l'étape active.
    expect(html).toMatch(
      new RegExp(`data-spot="${named('CommandeStore.etat').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`),
    );
  });
});

describe('flux de données du parcours', () => {
  it('les étapes rangées par rôle ; la lecture va de la table à qui la lit', () => {
    const html = render({ jStyle: 'data' });
    expect(html).toMatch(/data-style="data" aria-pressed="true">Data flow</);
    expect([...html.matchAll(/class="dg-sh"[^>]*>([^<]+)</g)].map((m) => m[1])).toEqual([
      'Source',
      'État',
      'Transport',
      'Traitement',
      'Stockage',
      'Affichage',
    ]);
    const nodes = nodesOf(html);
    expect(nodes.length).toBe(traced.trace?.down.length);
    const overlap = nodes.some((a, i) =>
      nodes.some((b, j) => j > i && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h),
    );
    expect(overlap).toBe(false);
    const col = (name: string) => nodes.find((n) => n.id === named(name))?.x ?? -1;
    expect(col('Valider')).toBeLessThan(col('CommandeStore.validerEtEnregistrer'));
    expect(col('CommandeStore.validerEtEnregistrer')).toBeLessThan(col('CommandeApiService.valider'));
    expect(col('CommandeApiService.valider')).toBe(col('POST /api/v1/commandes/validation'));
    expect(col('CommandeController.valider')).toBeLessThan(col('commandes'));
    // L'interface atteinte après le store affiche : dernière colonne.
    expect(col('CommandesPageComponent.etat$')).toBe(Math.max(...nodes.map((n) => n.x)));
    // La table lue par le service : la flèche part de la table, avec le verbe « lit ».
    const edges = edgesOf(html);
    const read = edges.find((e) => e.from === named('commandes'));
    expect(read).toEqual({
      role: 'default',
      state: '',
      from: named('commandes'),
      to: named('CommandeService.valider'),
    });
    expect(html).toContain('class="dg-lb r-default"');
    expect(html).toMatch(/class="dg-lb r-default"[^>]*>lit</);
    // Une branche garde sa rangée en traversant les colonnes : l'appel HTTP est à la hauteur de son store.
    const y = (name: string) => nodes.find((n) => n.id === named(name))?.y;
    expect(y('CommandeApiService.valider')).toBe(y('CommandeStore.validerEtEnregistrer'));
    expect(y('CommandeController.valider')).toBe(y('POST /api/v1/commandes/validation'));
  });
});
