import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CartographyConfig, FeatureMap } from '../../src/sdk/core/cartography.js';
import { buildIndex, type CoverageContext } from '../../src/cartography/explorer.js';
import { featureMap } from '../../src/cartography/feature-map.js';
import { runScan } from '../../src/cartography/scan.js';
import {
  emptyJourney,
  JOURNEY_VIEWS,
  journeyTab,
  VIEW_PRESET,
  type JourneyHelpers,
  type JourneyState,
} from '../../src/sdk/ui/dashboard-cartography-journey.js';
import { foldTree } from '../../src/sdk/ui/dashboard-cartography-controller.js';

/**
 * Le rendu de l'onglet « Parcours & Graphe » sur la carte réelle du mini-projet : couloirs dans l'ordre,
 * liens réunis en faisceaux (jamais une ligne par relation), focus sur l'élément choisi, vues et tableau.
 */
const cov: CoverageContext = {
  links: [],
  coverage: new Map(),
  issues: [],
  lastRuns: new Map(),
  decisions: [],
};
const ROOT = path.resolve('tests/fixtures/cartography-conditions');

let map: FeatureMap;
/** La carte avec l'élément « Refuse » choisi : son parcours et sa traçabilité. */
let traced: FeatureMap;
beforeAll(async () => {
  const config: CartographyConfig = {
    schema: 1,
    sources: (
      [
        ['front', 'FRONTEND'],
        ['bff', 'BFF'],
        ['backend', 'BACKEND'],
      ] as const
    ).map(([id, layer]) => ({ id, name: id, layer, path: path.join(ROOT, id), include: [], enabled: true })),
  };
  const { model } = await runScan({ config, allowedRoots: [ROOT], incremental: false });
  const index = buildIndex(model);
  const feature = model.features.find((f) => f.name === 'Request create');
  map = featureMap(index, cov, feature?.id ?? '') as FeatureMap;
  const refuse = map.items.find((i) => i.kind === 'BUTTON' && i.name === 'Refuse');
  traced = featureMap(index, cov, feature?.id ?? '', { item: refuse?.id ?? '' }) as FeatureMap;
}, 120_000);

const helpers = (feature: string): JourneyHelpers => ({
  locale: 'fr',
  conf: (c) => c.toLowerCase(),
  evidence: (e) => (e ? `<a class="ev">${e.file}</a>` : ''),
  spinner: () => '<p class="spin"></p>',
  paneError: (t) => (t ? `<p class="err">${t}</p>` : ''),
  features: [],
  feature,
  loading: false,
});
/** Le rendu dans les couloirs (les tests du diagramme d'architecture le demandent explicitement). */
const render = (patch: Partial<JourneyState> = {}): string =>
  journeyTab({ ...emptyJourney(), jStyle: 'lanes', jMap: map, ...patch }, helpers(map.feature.id));
const count = (html: string, needle: string): number => html.split(needle).length - 1;

describe('onglet Parcours & Graphe', () => {
  it('dessine les quatre couloirs dans l’ordre Angular → BFF → Backend → API externe', () => {
    const html = render();
    const at = ['l-frontend', 'l-bff', 'l-backend', 'l-external'].map((c) => html.indexOf(`jr-lane ${c}`));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(html).toContain('Persistance (Hibernate/JPA)');
  });

  it('« Tout » réunit les liens en faisceaux comptés, jamais une ligne par relation', () => {
    const html = render();
    const pills = count(html, 'class="jr-pill');
    expect(pills).toBeGreaterThan(0);
    expect(pills).toBeLessThan(map.relationCount / 3);
    // Les compteurs de la colonne gauche sont ceux du scan.
    expect(html).toContain(`Liens (${String(map.relationCount)})`);
    for (const [cat, n] of Object.entries(map.categories))
      expect(html).toMatch(new RegExp(`data-cat="${cat}"[^>]*>.*?<b>${String(n)}</b>`));
  });

  it('met l’élément choisi au premier plan et atténue les autres', () => {
    const refuse = map.items.find((i) => i.kind === 'BUTTON' && i.name === 'Refuse');
    const html = render({ jSelect: refuse?.id ?? '' });
    expect(html).toContain('jr-focus');
    expect(html).toContain(' dim');
    expect(html).toMatch(/jr-m sel|jr-card sel|jr-tn[^"]* sel/);
  });

  it('cartes repliées par défaut (nombre de membres dans l’en-tête), dépliées sur demande ou choisies', () => {
    const compact = render();
    expect(compact).not.toContain('class="jr-ml"');
    expect(compact).toMatch(/<i class="jr-n">\d+ liens<small[^>]*>\d+ membres<\/small><\/i>/);
    expect(compact).toContain('data-action="map-j-detail" aria-label="Déplier toutes les cartes"');
    const detailed = render({ jDetail: true });
    expect(count(detailed, 'class="jr-ml"')).toBeGreaterThan(3);
    // La carte de l'élément choisi se déplie ; les autres cartes de son parcours ne montrent que leurs
    // membres sur ce parcours, celles hors parcours restent repliées.
    const method = map.items.find((i) => i.kind === 'METHOD' && i.card !== i.id);
    const chosen = render({ jSelect: method?.id ?? '', jMap: { ...map, neighbours: [method?.id ?? ''] } });
    expect(count(chosen, 'class="jr-ml"')).toBe(1);
    expect(chosen).toContain('jr-m sel');
    const onPath = map.items.find((i) => i.kind === 'METHOD' && i.card !== i.id && i.card !== method?.card);
    const both = render({
      jSelect: method?.id ?? '',
      jMap: { ...map, neighbours: [method?.id ?? '', onPath?.id ?? ''] },
    });
    expect(count(both, 'class="jr-ml"')).toBe(2);
  });

  it('un élément choisi replie le reste : groupes sans lien à leur titre, cartes sans lien en une ligne', () => {
    const refuse = map.items.find((i) => i.kind === 'BUTTON' && i.name === 'Refuse');
    // Les voisins tels que le serveur les donne pour cet élément (toutes ses relations).
    const neighbours = [
      refuse?.id ?? '',
      ...map.relations.items
        .filter((r) => r.from === refuse?.id || r.to === refuse?.id)
        .flatMap((r) => [r.from, r.to]),
    ];
    const focused = { ...map, neighbours };
    const html = journeyTab(
      { ...emptyJourney(), jMap: focused, jSelect: refuse?.id ?? '' },
      helpers(map.feature.id),
    );
    expect(count(html, 'jr-sec dim folded')).toBeGreaterThan(5);
    expect(html).toContain('+2 cartes sans lien avec l’élément choisi');
    // Les groupes qui touchent l'élément restent ouverts ; un groupe replié se déplie sur demande.
    expect(html).toMatch(/data-group="BUTTON"[^]*?Refuse/);
    const opened = journeyTab(
      { ...emptyJourney(), jMap: focused, jSelect: refuse?.id ?? '', jOpen: ['sec:BFF|ENDPOINT'] },
      helpers(map.feature.id),
    );
    expect(count(opened, 'jr-sec dim folded')).toBe(count(html, 'jr-sec dim folded') - 1);
    // Sans élément choisi, rien n'est replié.
    expect(render()).not.toContain('folded');
  });

  it('foldTree replie les branches hors du chemin de l’élément choisi', () => {
    const tree = [
      {
        id: 'P',
        kind: 'ROUTE' as const,
        name: 'p',
        children: [
          {
            id: 'A',
            kind: 'CONTAINER' as const,
            name: 'a',
            children: [{ id: 'A1', kind: 'BUTTON' as const, name: 'a1', children: [] }],
          },
          {
            id: 'B',
            kind: 'CONTAINER' as const,
            name: 'b',
            children: [{ id: 'B1', kind: 'BUTTON' as const, name: 'b1', children: [] }],
          },
        ],
      },
    ];
    expect(foldTree(tree, 'A1', [])).toEqual(['B']);
    expect(foldTree(tree, 'P', [])).toEqual(['A', 'B']);
    // Un élément hors de l'arbre (backend, BFF) ne touche pas à l'arbre.
    expect(foldTree(tree, 'X', ['A'])).toEqual(['A']);
  });

  it('chaque vue ouvre son onglet du bas, sans erreur de rendu', () => {
    for (const view of JOURNEY_VIEWS) {
      const html = render({ jView: view, jBottom: VIEW_PRESET[view].bottom });
      // La vue se choisit dans une liste (« Afficher »), dans l'en-tête du graphe.
      expect(html).toContain(`<option value="${view}" selected>`);
    }
    const rules = render({ jView: 'rules', jBottom: 'rules' });
    expect(rules).toContain('!state.canValidate');
    expect(rules).toContain('ValidationEligibilityService.canValidate');
    const overview = render({ jView: 'overview' });
    expect(overview).toContain('jr-gaps');
  });

  it('le fil du parcours numérote les étapes, les mêmes dans le graphe et le tableau', () => {
    const t = traced.trace;
    const html = render({ jMap: traced, jSelect: t?.item ?? '' });
    expect(html).toContain('data-path');
    expect(html).toContain('<b class="jr-pt">Parcours d’exécution de Refuse</b>');
    // Les éléments distincts de la trace, numérotés de 1 à n.
    const steps = new Set([...(t?.up ?? []), ...(t?.down ?? [])].map((x) => x.id)).size;
    expect(html).toContain(`${String(steps)} étapes`);
    // Le chemin principal, dans l'ordre : de la page au bouton, puis jusqu'à la table.
    // Les noms portent des points de coupure (<wbr>) ; on les lit sans.
    const ribbon = html
      .slice(html.indexOf('data-path'), html.indexOf('data-jr-canvas'))
      .replaceAll('<wbr>', '');
    const order = [
      '/requests/create',
      'RequestCreateComponent',
      'Validation',
      'Refuse',
      'RequestService.refuse',
      'POST /api/requests/refuse',
      'RequestBffController.refuse',
      'RequestBffService.refuse',
      'POST /requests/refuse',
      'RequestController.refuse',
      'RequestValidationService.refuse',
      'REQUEST',
    ].map((n) => ribbon.indexOf(`<span>${n}</span></button>`));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(ribbon).toMatch(/<i class="jr-sn"[^>]*>1<\/i>.*?<span>\/requests\/create<\/span>/);
    expect(ribbon).toMatch(/<i class="jr-sn goal"[^>]*>\d+<\/i>.*?<span>REQUEST<\/span>/);
    // Le verbe des relations, les passages de couche, le bout atteint, les autres étapes.
    expect(ribbon).toContain('<span>affiche</span>');
    expect(ribbon).toContain('<span>contient</span>');
    expect(ribbon).toContain('<span>déclenche</span>');
    expect(count(ribbon, 'class="jr-cx')).toBe(2);
    expect(ribbon).toContain('>Table atteinte</li>');
    expect(ribbon).toContain('1 table atteinte');
    expect(ribbon).toMatch(/\+\d+ autres étapes, numérotées dans le graphe/);
    expect(ribbon).not.toContain('Ruptures');
    // Le graphe porte les mêmes numéros : par défaut le chemin principal seul (les 12 étapes de la page à
    // la table), avec toutes les branches ou tout le graphe sur demande.
    const graphOf = (h: string) => h.slice(h.indexOf('data-jr-canvas'), h.indexOf('jr-bottom'));
    expect(count(graphOf(html), 'class="jr-sn')).toBe(order.length);
    const alt = render({ jMap: traced, jSelect: t?.item ?? '', jMode: 'alt' });
    expect(count(graphOf(alt), 'class="jr-sn')).toBe(steps);
    const full = render({ jMap: traced, jSelect: t?.item ?? '', jMode: 'full' });
    expect(full).not.toContain('jr-sec dim folded');
    // Rien de replié, mais chaque carte repliée montre ses membres numérotés du parcours.
    expect(count(graphOf(full), 'class="jr-sn')).toBe(steps);
    expect(html).toContain('jr-sec dim folded');
    // Le tableau se lit dans l'ordre des étapes, chaque ligne avec ses deux numéros.
    const table = html.slice(html.indexOf('class="jr-t"'));
    expect(table).toMatch(/<td class="mu"><span class="jr-sn2"[^>]*><i class="jr-sn"[^>]*>1<\/i>/);
    expect(count(table, 'class="jr-sn2"')).toBe(traced.relations.items.length);
    // Sans élément choisi : aucun numéro.
    expect(render()).not.toContain('jr-sn');
  });

  it('le parcours guidé : étape active, précédente et suivante, détails de l’étape, fiche, modes', () => {
    const t = traced.trace;
    const at = (patch: Partial<JourneyState>) =>
      render({ jMap: traced, jSelect: t?.item ?? '', jBottom: 'step', ...patch });
    // Par défaut, l'étape active est l'élément choisi (4e du chemin : page, composant, conteneur, bouton).
    const html = at({});
    // Les noms longs se coupent entre les mots (camelCase, points), jamais en plein mot ni tronqués.
    expect(html).toContain('Request<wbr>Create<wbr>Component');
    // Le bandeau tient sur une ligne qui défile : chaque nom y est entier (ni coupé ni tronqué).
    expect(html).toContain('<span>RequestService.refuse</span></button>');
    expect(html).not.toContain('text-overflow:ellipsis;white-space:nowrap}.jr-crb');
    // Le verbe de la relation qui mène à une étape est dans la même entrée que l'étape (un retour à la ligne
    // ne le laisse jamais seul en bout de ligne).
    expect(html).toMatch(
      /<li class="jr-gs l-frontend on"><span class="jr-cl[^]*?<\/span><button class="jr-crb" data-action="map-j-step" data-step="3"[^>]*aria-current="step"/,
    );
    expect(html).toMatch(
      /<li class="jr-gs l-frontend next"><span class="jr-cl[^>]*>[^]*?<button[^>]*data-step="4"/,
    );
    expect(html).not.toContain('<li class="jr-cl');
    // Les commandes : début, précédent, suivant (l'étape visée), suivre le parcours (actif par défaut).
    expect(html).toMatch(/data-step="0"[^>]*aria-label="Revenir au début"/);
    expect(html).toMatch(/data-step="2"[^>]*aria-label="Étape précédente"/);
    expect(html).toMatch(/data-step="4"[^>]*aria-label="Étape suivante"/);
    expect(html).toContain('data-action="map-j-follow" aria-pressed="true"');
    expect(html).toContain('Ordre déduit des relations prouvées par le code');
    // Le graphe met en évidence l'élément de l'étape active et celui de l'étape suivante.
    expect(html).toMatch(/class="jr-m sel on"|class="jr-ch on"/);
    expect(html).toContain(' next"');
    // Détails de l'étape : rang, rôle, couche, relation qui y mène et qui en part, confiance.
    const detail = html.slice(html.indexOf('data-step-detail'));
    expect(detail).toContain('Étape 4/12');
    expect(detail).toContain('Boutons : Refuse');
    expect(detail).toContain('Action de l’utilisateur dans l’interface.');
    expect(detail).toMatch(/arrive de[^]*Validation[^]*mène à[^]*RequestService\.refuse/);
    expect(detail).toContain('Relation prouvée par le code.');
    // Une étape plus loin : la première étape probable du chemin le dit, la table est le bout.
    const probable = at({ jStep: 8 });
    expect(probable.slice(probable.indexOf('data-step-detail'))).toContain(
      'Relation probable : déduite, pas démontrée.',
    );
    const last = at({ jStep: 99 });
    expect(last.slice(last.indexOf('data-step-detail'))).toMatch(/Étape 12\/12[^]*REQUEST[^]*Table atteinte/);
    // La fiche de l'élément choisi sous l'arbre ; les modes et la mini-carte des couches.
    expect(html).toMatch(/data-info>[^]*Refuse[^]*Boutons[^]*Angular \(SPA\)/);
    expect(html).toMatch(/data-mode="main" aria-pressed="true">Principal/);
    expect(html).toMatch(/Branches \(\d+\)/);
    // Simplifié : ni mini-carte des couches (les rails la remplacent), ni tuiles de chiffres, ni seconde barre
    // d'onglets, ni colonne de droite sous le graphe ; les modes et la vue sont dans l'en-tête du graphe.
    expect(html).not.toContain('data-action="map-j-lane"');
    expect(html).not.toContain('class="jr-kpi"');
    expect(html).not.toContain('data-action="map-j-view"');
    expect(html).not.toContain('class="jr-side"');
    expect(html).toMatch(
      /<div class="jr-gh">[^]*?data-map="j-view"[^]*?class="jr-modes"[^]*?class="jr-tools"/,
    );
    expect(html).toMatch(/<p class="jr-sum"><span><b>\d+<\/b> Liens<\/span>/);
    // Sans parcours (carte d'une autre sélection) : ni onglet de l'étape ni bandeau d'étapes.
    const plain = render({ jBottom: 'step' });
    expect(plain).not.toContain('data-step-detail');
    expect(plain).not.toContain('Détails de l’étape');
  });

  it('le chemin principal est tracé dans les couloirs, dans l’ordre du bandeau', () => {
    const t = traced.trace;
    const html = render({ jMap: traced, jSelect: t?.item ?? '' });
    // Le calque du tracé porte les étapes du chemin principal dans l'ordre, avec le statut de chaque relation.
    const raw = /data-jr-route="([^"]*)"/.exec(html)?.[1] ?? '';
    const route = JSON.parse(raw.replaceAll('&quot;', '"').replaceAll('&amp;', '&')) as {
      id: string;
      s?: string;
    }[];
    const ribbon = html.slice(html.indexOf('data-path'), html.indexOf('data-jr-canvas'));
    const order = [
      ...ribbon.matchAll(/class="jr-crb" data-action="map-j-step" data-step="\d+" data-item="([^"]*)"/g),
    ].map((m) => m[1]);
    expect(route.map((r) => r.id)).toEqual(order.map((id) => id?.replaceAll('&amp;', '&')));
    expect(route[0]?.s).toBeUndefined();
    expect(route.slice(1).every((r) => ['CONFIRMED', 'PROBABLE', 'UNKNOWN'].includes(r.s ?? ''))).toBe(true);
    // Sans élément choisi : ni parcours ni tracé.
    expect(render()).not.toContain('data-jr-route');
    // Les quatre couloirs sont atteints ici : aucun rail, et la largeur minimale est celle de quatre couloirs.
    expect(html).not.toContain('jr-lane l-external empty');
    expect(html).toContain('min-width:954px');
  });

  it('le parcours choisi s’affiche par défaut en diagramme d’architecture, les couloirs sur demande', () => {
    const t = traced.trace;
    const html = journeyTab(
      { ...emptyJourney(), jMap: traced, jSelect: t?.item ?? '' },
      helpers(map.feature.id),
    );
    expect(html).toContain('<section class="ar"');
    expect(html).toContain('data-ar-route=');
    expect(html).not.toContain('class="jr-lanes"');
    // Le choix de présentation ; les modes (principal, branches, tout) ne valent que pour les couloirs.
    expect(html).toMatch(/data-action="map-j-style" data-style="archi" aria-pressed="true">Architecture</);
    expect(html).toMatch(/data-action="map-j-style" data-style="lanes" aria-pressed="false">Couloirs</);
    expect(html).not.toContain('data-action="map-j-mode"');
    expect(html).not.toContain('data-action="map-j-detail"');
    const lanes = render({ jMap: traced, jSelect: t?.item ?? '' });
    expect(lanes).toContain('class="jr-lanes"');
    expect(lanes).toContain('data-action="map-j-mode"');
    expect(lanes).not.toContain('<section class="ar"');
    // Sans élément choisi (pas de parcours) : les couloirs de la fonctionnalité, sans choix de présentation.
    const none = journeyTab({ ...emptyJourney(), jMap: map }, helpers(map.feature.id));
    expect(none).toContain('class="jr-lanes"');
    expect(none).not.toContain('map-j-style');
  });

  it('le diagramme d’architecture : une boîte par étape du chemin, dans l’ordre et les couches du bandeau', () => {
    const t = traced.trace;
    const html = journeyTab(
      { ...emptyJourney(), jMap: traced, jSelect: t?.item ?? '' },
      helpers(map.feature.id),
    ).replaceAll('<wbr>', '');
    const ribbon = html.slice(html.indexOf('data-path'), html.indexOf('data-jr-canvas'));
    const order = [
      ...ribbon.matchAll(/class="jr-crb" data-action="map-j-step" data-step="\d+" data-item="([^"]*)"/g),
    ].map((m) => m[1]);
    const diagram = html.slice(html.indexOf('<section class="ar"'), html.indexOf('class="ar-legend"'));
    const boxes = [
      ...diagram.matchAll(
        /data-action="map-j-spot" data-step="(\d+)" data-item="([^"]*)" data-ar-step="\d+"/g,
      ),
    ];
    // Les mêmes étapes que le bandeau ; dans chaque couche, dans l'ordre du chemin.
    expect(boxes.map((m) => m[2]).sort()).toEqual([...order].sort());
    expect(boxes.length).toBe(12);
    const regions = [...diagram.matchAll(/<section class="ar-region" data-lane="(\w+)">/g)].map((m) => m[1]);
    expect(regions).toEqual(['FRONTEND', 'BFF', 'BACKEND']);
    expect(diagram).toContain(
      '<div class="ar-rail" data-lane="EXTERNAL"><span>API externe · non atteint</span>',
    );
    for (const lane of regions) {
      const part = diagram.slice(diagram.indexOf(`data-lane="${lane ?? ''}">`)).split('</section>')[0] ?? '';
      const steps = [...part.matchAll(/data-ar-step="(\d+)"/g)].map((m) => Number(m[1]));
      expect([...steps].sort((a, b) => a - b)).toEqual(steps);
    }
    // Numéros du bandeau, teinte par couche, la table en violet (persistance).
    expect(diagram).toMatch(/<i class="jr-sn"[^>]*>1<\/i><span class="ar-t">\/requests\/create<\/span>/);
    expect(diagram).toMatch(/class="ar-box t-be[^"]*"[^>]*>[^]*?RequestController\.refuse/);
    expect(diagram).toMatch(
      /class="ar-box t-db[^"]*"[^>]*><i class="jr-sn goal"[^>]*>\d+<\/i><span class="ar-t">REQUEST</,
    );
    // Les flèches : une par relation du chemin, avec son statut et son verbe.
    const raw = /data-ar-route="([^"]*)"/.exec(html)?.[1] ?? '';
    const links = JSON.parse(raw.replaceAll('&quot;', '"').replaceAll('&amp;', '&')) as {
      s?: string;
      v?: string;
      c?: string;
    }[];
    expect(links.length).toBe(12);
    expect(links[0]).toEqual({});
    expect(links.slice(1).every((l) => ['CONFIRMED', 'PROBABLE', 'UNKNOWN'].includes(l.s ?? ''))).toBe(true);
    // Le verbe n'est écrit qu'aux deux passages de couche (Angular → BFF → Backend).
    expect(links.filter((l) => l.v).length).toBe(2);
    expect(links.every((l) => !l.v || /appelle|dépend de/.test(l.v))).toBe(true);
    // Cinq étapes au plus par couche ici : une colonne par région, une rangée par étape.
    expect(diagram.split('class="ar-col c1"').length - 1).toBe(3);
    expect(diagram).toMatch(/data-ar-step="4" style="grid-row:5;grid-column:1"/);
    expect(links.some((l) => l.c)).toBe(false);
    // La légende et les trois cartes, tirées de la trace.
    const after = html.slice(html.indexOf('class="ar-legend"'), html.indexOf('jr-bottom'));
    expect(after).toContain('Chemin confirmé');
    expect(after).toContain('<li>12 étapes</li>');
    expect(after).toContain('<li>Couches : Angular (SPA) → BFF → Backend (Java)</li>');
    expect(after).toContain('<li>Table atteinte</li>');
    const weak = links.filter((l) => l.s !== 'CONFIRMED').length;
    expect(after).toContain(`relation(s) confirmée(s) sur 11`);
    if (weak === 0) expect(after).toContain('Toutes les relations du chemin sont confirmées.');
    expect(after).toContain('Lacunes du scan');
  });

  it('cliquer une boîte met son étape en avant avec ses voisines ; le reste s’estompe', () => {
    const t = traced.trace;
    const at = (patch: Partial<JourneyState>) =>
      journeyTab(
        { ...emptyJourney(), jMap: traced, jSelect: t?.item ?? '', ...patch },
        helpers(map.feature.id),
      );
    const cls = (html: string, i: number) =>
      new RegExp(`class="ar-box ([^"]*)" data-action="map-j-spot" data-step="${String(i)}"`).exec(
        html,
      )?.[1] ?? '';
    const links = (html: string) =>
      JSON.parse(
        (/data-ar-route="([^"]*)"/.exec(html)?.[1] ?? '').replaceAll('&quot;', '"').replaceAll('&amp;', '&'),
      ) as { c?: string }[];
    // Sans mise en avant : l'étape active est cerclée, rien n'est estompé, « Tout afficher » est inactif.
    const calm = at({ jStep: 5 });
    expect(cls(calm, 5)).toMatch(/ cur$/);
    expect(calm).not.toMatch(/class="ar-box [^"]* dim"/);
    expect(calm).toMatch(/data-action="map-j-unspot" disabled>Tout afficher/);
    // Mise en avant de l'étape 6 (rang 5) : elle, ses deux voisines, le reste estompé ; ses deux flèches.
    const spot = at({ jStep: 5, jSpot: true });
    expect(cls(spot, 5)).toMatch(/ sel$/);
    expect(spot).toMatch(
      /data-step="5" data-item="[^"]*" data-ar-step="5" style="[^"]*" aria-pressed="true"/,
    );
    expect(cls(spot, 4)).toMatch(/ near$/);
    expect(cls(spot, 6)).toMatch(/ near$/);
    expect(cls(spot, 0)).toMatch(/ dim$/);
    expect(cls(spot, 11)).toMatch(/ dim$/);
    expect(links(spot).map((l) => l.c ?? '')).toEqual([
      '',
      'off',
      'off',
      'off',
      'off',
      'on',
      'on',
      'off',
      'off',
      'off',
      'off',
      'off',
    ]);
    expect(spot).toMatch(/data-action="map-j-unspot">Tout afficher/);
    // La zone du diagramme elle-même rend tout visible (clic dans le vide).
    expect(spot).toContain('class="ar-stage" data-ar data-action="map-j-unspot"');
  });

  it('le tableau des liens montre la page demandée avec la preuve de chaque relation', () => {
    const html = render();
    expect(count(html, '<tr')).toBeGreaterThanOrEqual(map.relations.items.length);
    expect(html).toContain('class="ev"');
    expect(html).toContain('data-action="map-j-page"');
  });

  it('attend sa carte (indicateur) puis affiche l’erreur sans rien inventer', () => {
    const waiting = journeyTab(emptyJourney(), helpers('FEATURE:x'));
    expect(waiting).toContain('class="spin"');
    const failed = journeyTab(emptyJourney(), { ...helpers('FEATURE:x'), error: 'introuvable' });
    expect(failed).toContain('introuvable');
    expect(failed).not.toContain('jr-lane');
  });
});
