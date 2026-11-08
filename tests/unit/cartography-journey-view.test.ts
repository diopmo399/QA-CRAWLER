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
const render = (patch: Partial<JourneyState> = {}): string =>
  journeyTab({ ...emptyJourney(), jMap: map, ...patch }, helpers(map.feature.id));
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
      expect(html).toContain(`data-view="${view}" aria-selected="true"`);
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
    expect(html).toContain('Request<wbr>Service.<wbr>refuse');
    expect(html).not.toContain('text-overflow:ellipsis;white-space:nowrap}.jr-crb');
    expect(html).toMatch(
      /<li class="jr-gs l-frontend on"><button class="jr-crb" data-action="map-j-step" data-step="3"[^>]*aria-current="step"/,
    );
    expect(html).toMatch(/<li class="jr-gs l-frontend next"><button[^>]*data-step="4"/);
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
    expect(html).toMatch(/data-mode="main" aria-pressed="true">Parcours principal/);
    expect(html).toMatch(/Branches alternatives \(\d+\)/);
    expect(count(html, 'data-action="map-j-lane"')).toBe(4);
    // Sans parcours (carte d'une autre sélection) : ni onglet de l'étape ni bandeau d'étapes.
    const plain = render({ jBottom: 'step' });
    expect(plain).not.toContain('data-step-detail');
    expect(plain).not.toContain('Détails de l’étape');
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
