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
