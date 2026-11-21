import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CartographyConfig, FieldSheet } from '../../src/sdk/core/cartography.js';
import { buildIndex, fieldSheet, type CoverageContext } from '../../src/cartography/explorer.js';
import { runScan } from '../../src/cartography/scan.js';
import { conceptDiagrams } from '../../src/sdk/ui/dashboard-cartography-concept.js';
import { mapStrings } from '../../src/sdk/ui/dashboard-cartography-i18n.js';
import { esc } from '../../src/sdk/ui/view.js';

/**
 * Les diagrammes Archify d'un concept de données (fixture cartography : « Company name » saisi dans deux
 * formulaires, transmis au BFF, transformé, envoyé au backend, écrit en base) : parcours par couche,
 * réutilisation par fonctionnalité, homonymes sans flèche.
 */
const cov: CoverageContext = {
  links: [],
  coverage: new Map(),
  issues: [],
  lastRuns: new Map(),
  decisions: [],
};
const ROOT = path.resolve('tests/fixtures/cartography');
const m = mapStrings('fr');

let sheet: FieldSheet;
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
  const concept = model.concepts.find((c) => c.name === 'Company name' && c.features.length === 3);
  sheet = fieldSheet(index, cov, concept?.fields[0] ?? '') as FieldSheet;
}, 120_000);

const stageOf = (html: string, name: string): string => {
  const start = html.indexOf(`data-cf-stage="${name}"`);
  const end = html.indexOf('data-cf-stage=', start + 20);
  return html.slice(start, end < 0 ? undefined : end);
};
const nodes = (part: string) =>
  [
    ...part.matchAll(
      /class="dg-n ar-box t-(\w+)([^"]*)"[^>]*data-cf="([^"]+)" style="left:(\d+(?:\.\d+)?)px;top:(\d+(?:\.\d+)?)px;width:(\d+)px;height:(\d+)px"/g,
    ),
  ].map((r) => ({
    tone: r[1] ?? '',
    cls: r[2] ?? '',
    id: r[3] ?? '',
    x: Number(r[4]),
    y: Number(r[5]),
    w: Number(r[6]),
    h: Number(r[7]),
  }));
const edges = (part: string) =>
  [
    ...part.matchAll(
      /<path class="dg-e r-(\w+)( on| off)?" d="[^"]+" marker-end="[^"]+" data-from="([^"]+)" data-to="([^"]+)"/g,
    ),
  ].map((r) => ({ role: r[1] ?? '', state: (r[2] ?? '').trim(), from: r[3] ?? '', to: r[4] ?? '' }));

describe('diagrammes d’un concept de données', () => {
  it('le parcours : une région par couche, un nœud par champ, une flèche par lien justifié', () => {
    const html = conceptDiagrams(m, sheet);
    const flow = stageOf(html, 'cf-flow');
    expect(
      [...flow.matchAll(/class="cf-region"[^>]*><span class="ar-rl">([^<]+)</g)].map((r) => r[1]),
    ).toEqual(['Front', 'BFF', 'Backend', 'Base de données']);
    const ns = nodes(flow);
    const ids = new Set([sheet.node.id, ...sheet.sequence.flatMap((e) => [e.from, e.to])]);
    expect(ns.length).toBe(ids.size);
    expect(new Set(ns.map((n) => n.id))).toEqual(new Set([...ids].map(esc)));
    // Teinte de la couche ; la colonne de la table en violet (persistance).
    expect(ns.filter((n) => n.tone === 'db').length).toBe(1);
    // Aucun chevauchement de nœuds.
    const overlap = ns.some((a, i) =>
      ns.some((b, j) => j > i && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h),
    );
    expect(overlap).toBe(false);
    // Une flèche par lien justifié, de sa force : démontré en vert (comète), probable en tirets.
    const es = edges(flow);
    expect(es.length).toBe(sheet.sequence.length);
    for (const e of sheet.sequence) {
      const drawn = es.find((d) => d.from === esc(e.from) && d.to === esc(e.to));
      expect(drawn?.role).toBe(e.confidence === 'CONFIRMED' ? 'emphasis' : 'dashed');
    }
    expect(flow).toContain('class="dg-c head"');
    expect(flow).toContain('>transmet<');
    expect(flow).toContain('Table REQUEST');
    expect(html).toContain('Lien démontré');
  });

  it('la réutilisation : le concept relié à chaque fonctionnalité ; les homonymes sans aucune flèche', () => {
    const html = conceptDiagrams(m, sheet);
    const reuse = stageOf(html, 'cf-reuse');
    expect(html).toContain('Réutilisation (3 fonctionnalité(s))');
    const features = nodes(reuse).filter((n) => n.id !== 'concept');
    expect(features.map((n) => n.id).sort()).toEqual(sheet.reuse.map((f) => esc(f.id)).sort());
    expect(edges(reuse).map((e) => e.from)).toEqual(['concept', 'concept', 'concept']);
    expect(reuse).toContain('data-action="map-feature"');
    const hom = stageOf(html, 'cf-hom');
    expect(nodes(hom).length).toBe(sheet.concept.homonyms.length);
    expect(hom).not.toContain('<path');
    expect(hom).toContain('data-action="map-concept"');
    expect(html).toContain('Homonymes (même nom, sans lien démontré : non fusionnés)');
  });

  it('cliquer un champ l’allume avec ses voisins et ses liens ; le reste s’estompe', () => {
    const target = sheet.sequence[1]?.to ?? '';
    const flow = stageOf(conceptDiagrams(m, sheet, target), 'cf-flow');
    const ns = nodes(flow);
    const state = (id: string) => ns.find((n) => n.id === esc(id))?.cls ?? '';
    expect(state(target)).toMatch(/ sel$/);
    const linked = sheet.sequence.filter((e) => e.from === target || e.to === target);
    for (const e of linked) expect(state(e.from === target ? e.to : e.from)).toMatch(/ near$/);
    const es = edges(flow);
    expect(es.filter((e) => e.state === 'on').length).toBe(linked.length);
    expect(es.filter((e) => e.state === 'off').length).toBe(es.length - linked.length);
    // Sans mise en avant, rien n'est estompé.
    expect(stageOf(conceptDiagrams(m, sheet), 'cf-flow')).not.toMatch(/ dim"/);
  });
});
