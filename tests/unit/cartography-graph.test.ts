import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CartographyConfig, FieldSheet, MapSummary } from '../../src/sdk/core/cartography.js';
import { buildIndex, fieldSheet } from '../../src/cartography/explorer.js';
import { runScan } from '../../src/cartography/scan.js';
import {
  fullGraphSvg,
  mainPath,
  technologyOf,
  traceView,
  type TraceContext,
} from '../../src/sdk/ui/dashboard-cartography-graph.js';
import { mapStrings } from '../../src/sdk/ui/dashboard-cartography-i18n.js';

/**
 * Le graphe lisible d'un champ, sur le scan réel du mini-projet : le parcours principal ne contient que
 * des liens du scan, regroupés par couche ; les compteurs, la légende et le tableau des relations
 * comptent ces liens-là ; le graphe complet regroupe ou sépare les liens parallèles sans en inventer.
 */
const FIXTURE = path.resolve('tests/fixtures/cartography');
const config: CartographyConfig = {
  schema: 1,
  sources: (
    [
      ['front', 'FRONTEND'],
      ['bff', 'BFF'],
      ['backend', 'BACKEND'],
      ['contracts', 'API'],
    ] as const
  ).map(([id, layer]) => ({ id, name: id, layer, path: path.join(FIXTURE, id), include: [], enabled: true })),
};
const COMPANY = 'FIELD:front:RequestCreateComponent#form.companyName';
const m = mapStrings('fr');
let sheet: FieldSheet;
let summary: MapSummary;

beforeAll(async () => {
  const { model } = await runScan({ config, allowedRoots: [FIXTURE], incremental: false });
  const index = buildIndex(model);
  const found = fieldSheet(
    index,
    { links: [], coverage: new Map(), issues: [], lastRuns: new Map(), decisions: [] },
    COMPANY,
  );
  if (!found) throw new Error('the field sheet is missing');
  sheet = found;
  summary = { scan: model.scan } as unknown as MapSummary;
});

const context = (overrides: Partial<TraceContext> = {}): TraceContext => ({
  m,
  summary,
  sheet,
  mode: 'path',
  grouped: true,
  zoom: 1,
  panX: 0,
  panY: 0,
  fullscreen: false,
  relationsOpen: true,
  conf: (value) => `<span class="pill">${value}</span>`,
  evidence: () => '',
  where: (e) => e?.file ?? '',
  scanVersion: 'scan',
  ...overrides,
});

describe('main path of a field', () => {
  it('follows the flow links from the field, layer by layer, and only the links of the scan', () => {
    const path = mainPath(sheet);
    expect(path.groups.map((g) => g.layer)).toEqual(['FRONTEND', 'BFF', 'BACKEND', 'DATABASE']);
    expect(path.groups.map((g) => g.primary.id)).toEqual([
      COMPANY,
      'FIELD:bff:CreateRequestDto.companyName',
      'FIELD:backend:CreateRequestCommand.organizationName',
      'COLUMN:backend:Request.organizationName',
    ]);
    // Le champ de l'écran d'édition n'est pas sur ce parcours (il n'en part aucun lien vers lui).
    expect(path.groups.flatMap((g) => g.nodes.map((n) => n.id))).not.toContain(
      'FIELD:front:RequestEditComponent#form.companyName',
    );
    // Rien d'inventé : chaque lien affiché est un lien de la séquence du scan.
    const known = new Set(sheet.sequence.map((e) => e.id));
    expect(path.edges.every((e) => known.has(e.id))).toBe(true);
    // L'adresse du backend est lue dans la configuration : le passage BFF → Backend est probable.
    expect(path.links.map((l) => l.confidence)).toEqual(['CONFIRMED', 'PROBABLE', 'CONFIRMED']);
    expect(path.groups[2]?.confidence).toBe('PROBABLE');
    // Le contrat d'API est rattaché à l'étape Backend (dépendance), sans carte inventée.
    expect(path.groups[2]?.contracts.map((c) => c.node?.layer)).toEqual(['API']);
    // Le compteur d'une étape compte les liens qui en partent (la dernière : ceux qui y arrivent).
    expect(path.groups.map((g) => g.relations.length)).toEqual([2, 3, 3, 2]);
  });

  it('names the technology really detected in the source of each step', () => {
    const path = mainPath(sheet);
    expect(path.groups.map((g) => technologyOf(summary, g.primary))).toEqual([
      'Angular',
      'Spring',
      'Spring',
      'JPA',
    ]);
    expect(technologyOf(undefined, sheet.node)).toBeUndefined();
  });

  it('renders the cards, the link counters, the legend and the relations of the step asked', () => {
    const html = traceView(context({ step: 'BFF' }));
    expect(html.match(/class="map-pcard /g)).toHaveLength(4);
    expect(html).toContain('Frontend');
    expect(html).toContain('(Angular)');
    expect(html).toContain('data-step="BFF" aria-pressed="true"');
    expect(html).toContain('Relations détectées (3)');
    expect(html).toContain('Étape : BFF');
    const legend = traceView(context());
    const total = mainPath(sheet).edges;
    expect(legend).toContain(
      `Confirmé (${String(total.filter((e) => e.confidence === 'CONFIRMED').length)})`,
    );
    expect(legend).toContain(`Probable (${String(total.filter((e) => e.confidence === 'PROBABLE').length)})`);
    expect(legend).toContain(`Relations détectées (${String(total.length)})`);
    // La vue et ses réglages : zoom et position repris, plein écran signalé.
    const zoomed = traceView(context({ zoom: 1.44, panX: -20, panY: 8, fullscreen: true }));
    expect(zoomed).toContain('transform:translate(-20px,8px) scale(1.44)');
    expect(zoomed).toContain('class="map-trace full"');
    expect(zoomed).toContain('144 %');
  });

  it('groups the parallel links of the full graph, or draws each of them', () => {
    const first = sheet.graph.edges[0];
    if (!first) throw new Error('the subgraph has no link');
    // Un second lien entre les deux mêmes nœuds (autre mécanisme) : deux liens parallèles.
    const graph = {
      ...sheet.graph,
      edges: [...sheet.graph.edges, { ...first, id: 'PARALLEL', kind: 'READS' as const }],
    };
    const grouped = fullGraphSvg(m, graph, COMPANY, { grouped: true });
    const separate = fullGraphSvg(m, graph, COMPANY, { grouped: false });
    const count = (svg: string): number => (svg.match(/class="map-g-hit"/g) ?? []).length;
    expect(count(separate)).toBe(count(grouped) + 1);
    expect(grouped).toContain('2 liens');
    // Une sélection surligne le nœud et ses voisins, et atténue le reste.
    const selected = fullGraphSvg(m, sheet.graph, COMPANY, { selection: { kind: 'node', id: COMPANY } });
    expect(selected).toContain(' sel ');
    expect(selected).toContain(' dim"');
  });
});
