import { describe, expect, it } from 'vitest';
import type { ImpactReport, MapSource, MapSummary, ScanRecord } from '../../src/sdk/core/cartography.js';
import { mapStrings } from '../../src/sdk/ui/dashboard-cartography-i18n.js';
import {
  filterRows,
  impactRows,
  impactView,
  issueCount,
  scanView,
  sourceIssues,
  type ScanViewHelpers,
} from '../../src/sdk/ui/dashboard-cartography-scan.js';
import { emptyCartographyUi } from '../../src/sdk/ui/dashboard-cartography.js';

/**
 * Les écrans Scan & Découverte et Analyse d'impact, rendus à partir de données construites : validations
 * des sources (mêmes règles que le serveur), états (aucun scan, jeton absent, source non enregistrée),
 * comparaison (scans identiques, source non lue jamais présentée comme « aucun changement »), lignes et
 * critères du tableau des changements.
 */
const m = mapStrings('fr');
const h: ScanViewHelpers = {
  chip: (raw, text) => `<span class="pill" data-raw="${raw}">${text}</span>`,
  conf: (v) => `<span class="conf">${v}</span>`,
  layerChip: (l) => `<span class="layer">${l}</span>`,
  date: (iso) => iso ?? '—',
  paneError: (t) => (t ? `<p class="err">${t}</p>` : ''),
  evidence: (e) => (e?.file ? `<button data-action="map-evidence" data-file="${e.file}">code</button>` : ''),
  canEdit: true,
  canRun: true,
  environments: [],
};
const local = (extra: Partial<MapSource> = {}): MapSource => ({
  id: 'front',
  name: 'Front',
  layer: 'FRONTEND',
  path: '/srv/front',
  include: [],
  enabled: true,
  ...extra,
});
const git = (extra: Partial<MapSource> = {}): MapSource =>
  local({
    id: 'back',
    name: 'Back',
    layer: 'BACKEND',
    kind: 'GIT',
    path: '',
    repoUrl: 'https://github.com/acme/back',
    ...extra,
  });
const scanRecord = (
  id: string,
  sources: ScanRecord['sources'],
  state: ScanRecord['state'] = 'COMPLETED',
): ScanRecord => ({
  id,
  schema: 1,
  startedAt: '2026-11-05T10:00:00.000Z',
  finishedAt: '2026-11-05T10:02:05.000Z',
  state,
  incremental: false,
  sources,
  counts: { FEATURE: 4, METHOD: 12, FIELD: 6 },
  edges: 30,
  errors: [],
});
const summaryOf = (sources: MapSource[], scans: ScanRecord[], gitHosts?: string[]): MapSummary =>
  ({
    config: { schema: 1, sources },
    allowedRoots: ['/srv'],
    ...(gitHosts ? { gitHosts } : {}),
    scans,
    ...(scans[0] ? { scan: scans[0] } : {}),
    coverage: { numerator: 1, denominator: 4, percent: 25, formula: 'f' },
  }) as unknown as MapSummary;

describe('source validation (same rules as the server)', () => {
  it('a valid local source and a valid Git source have no issue', () => {
    expect(sourceIssues(m, [local(), git()], ['github.com'])).toEqual([{}, {}]);
  });
  it('required fields, identifier format and duplicates', () => {
    const issues = sourceIssues(
      m,
      [local({ id: '', name: ' ', path: '' }), local({ id: 'a b' }), local(), local()],
      undefined,
    );
    expect(issues[0]).toMatchObject({
      id: m.sd.errors.idRequired,
      name: m.sd.errors.nameRequired,
      path: m.sd.errors.pathRequired,
    });
    expect(issues[1]?.id).toBe(m.sd.errors.idFormat);
    expect(issues[3]?.id).toBe(m.sd.errors.idDuplicate);
    expect(issueCount(issues)).toBe(5);
  });
  it('local: absolute path, optional repository URL, sub-folders inside', () => {
    const [issue] = sourceIssues(
      m,
      [local({ path: 'relative/dir', repoUrl: 'ftp://x/y', include: ['../up'] })],
      undefined,
    );
    expect(issue).toEqual({
      path: m.sd.errors.pathAbsolute,
      repoUrl: m.sd.errors.urlHttps,
      include: m.sd.errors.includeInvalid,
    });
  });
  it('Git: disabled server, required URL, credentials, host, branch, commit, token variable', () => {
    expect(sourceIssues(m, [git()], undefined)[0]?.kind).toBe(m.sd.errors.gitDisabled);
    expect(sourceIssues(m, [git({ repoUrl: '' })], ['github.com'])[0]?.repoUrl).toBe(m.sd.errors.urlRequired);
    expect(
      sourceIssues(m, [git({ repoUrl: 'https://u:p@github.com/a/b' })], ['github.com'])[0]?.repoUrl,
    ).toBe(m.sd.errors.urlCredentials);
    expect(sourceIssues(m, [git({ repoUrl: 'https://gitlab.com/a/b' })], ['github.com'])[0]?.repoUrl).toBe(
      m.sd.hostRefused('gitlab.com'),
    );
    const [bad] = sourceIssues(
      m,
      [git({ branch: '../x', commit: 'abc', tokenEnv: 'qa-token' })],
      ['github.com'],
    );
    expect(bad).toEqual({
      branch: m.sd.errors.branchInvalid,
      commit: m.sd.errors.commitInvalid,
      tokenEnv: m.sd.errors.tokenInvalid,
    });
  });
});

describe('Scan & Discovery view', () => {
  it('without any scan: the sources, required marks, and an explicit empty state', () => {
    const ui = emptyCartographyUi();
    const html = scanView(m, ui, summaryOf([local()], []), h);
    expect(html).toContain(m.sd.noScan);
    expect(html.match(/class="sd-req"/g)?.length).toBe(5);
    expect(html).toContain(m.sd.neverScanned);
    // Le dépôt distant ne peut pas être ajouté sur un serveur qui ne l'autorise pas : le choix est expliqué.
    expect(html).toMatch(/data-kind="GIT" disabled aria-disabled="true"/);
  });

  it('errors are shown only after a save attempt (or once a value is typed), with aria-invalid', () => {
    const ui = emptyCartographyUi();
    ui.sources = [local({ name: '' })];
    const summary = summaryOf([local()], []);
    expect(scanView(m, ui, summary, h)).not.toContain('aria-invalid="true"');
    ui.srcTried = true;
    const html = scanView(m, ui, summary, h);
    expect(html).toContain('aria-invalid="true" aria-describedby="sd-0-name-err"');
    expect(html).toContain(m.sd.fixErrors(1));
    // La source modifiée et non enregistrée est signalée comme telle.
    expect(html).toContain(m.sd.notSaved);
  });

  it('a missing Git token from the last scan is said in the card; a collapsed card hides its fields', () => {
    const ui = emptyCartographyUi();
    const source = git({ tokenEnv: 'QA_GIT_TOKEN' });
    const scan = scanRecord(
      'scan-1',
      [
        {
          sourceId: 'back',
          name: 'Back',
          layer: 'BACKEND',
          state: 'FAILED',
          technologies: [],
          files: 0,
          skipped: 0,
          secretsExcluded: 0,
          errors: ['[CREDENTIALS_MISSING] the server has no value for QA_GIT_TOKEN'],
        },
      ],
      'FAILED',
    );
    const html = scanView(m, ui, summaryOf([source], [scan], ['github.com']), h);
    expect(html).toContain(m.sd.tokenMissing('QA_GIT_TOKEN'));
    expect(html).toContain('id="sd-src-b-0"');
    expect(html).toContain('2 min 05 s');
    ui.srcClosed = [0];
    const closed = scanView(m, ui, summaryOf([source], [scan], ['github.com']), h);
    expect(closed).not.toContain('id="sd-src-b-0"');
    expect(closed).toContain('aria-expanded="false"');
  });

  it('discovered elements link to their tab; recent scans offer a comparison with the latest', () => {
    const ui = emptyCartographyUi();
    const scans = [scanRecord('scan-2', []), scanRecord('scan-1', [])];
    const html = scanView(m, ui, summaryOf([local()], scans), h);
    expect(html).toContain('data-action="map-tab" data-tab="features"');
    expect(html).toContain('data-action="map-scan-compare" data-id="scan-1"');
    expect(html).not.toContain('data-action="map-scan-compare" data-id="scan-2"');
    expect(html).toContain('25 %');
  });
});

const report = (extra: Partial<ImpactReport>): ImpactReport => ({
  from: 'scan-1',
  to: 'scan-2',
  changes: [],
  features: [],
  scenarios: [],
  sources: [],
  ...extra,
});

describe('impact analysis view', () => {
  const scans = [scanRecord('scan-2', []), scanRecord('scan-1', [])];
  const summary = summaryOf([local()], scans);

  it('the same scan on both sides: comparison disabled and explained', () => {
    const ui = emptyCartographyUi();
    ui.impactFrom = 'scan-1';
    ui.impactTo = 'scan-1';
    const html = impactView(m, ui, summary, h, { launch: '' });
    expect(html).toMatch(/data-action="map-impact" disabled/);
    expect(html).toContain(m.sd.same);
  });

  it('a source not read is never presented as “no change”: the ring shows “?”, the message says incomplete', () => {
    const ui = emptyCartographyUi();
    ui.impact = report({
      sources: [
        {
          sourceId: 'front',
          name: 'Front',
          layer: 'FRONTEND',
          status: 'UNDETERMINED',
          changes: { added: 0, removed: 0, changed: 0 },
          reason: 'source non lue',
        },
        {
          sourceId: 'bff',
          name: 'BFF',
          layer: 'BFF',
          status: 'UNCHANGED',
          changes: { added: 0, removed: 0, changed: 0 },
          reason: 'mêmes fichiers lus',
        },
      ],
    });
    const html = impactView(m, ui, summary, h, { launch: '' });
    expect(html).toContain('class="sd-ring-n">?</text>');
    expect(html).toContain(m.sd.noChangeRead(1));
    expect(html).not.toContain(m.sd.noChange);
    ui.impact = report({ sources: [] });
    expect(impactView(m, ui, summary, h, { launch: '' })).toContain(m.sd.noChange);
  });

  it('rows: one per change, then unchanged and undetermined sources; criteria narrow them', () => {
    const r = report({
      sources: [
        {
          sourceId: 'front',
          name: 'Front',
          layer: 'FRONTEND',
          status: 'MODIFIED',
          changes: { added: 1, removed: 1, changed: 0 },
          reason: 'x',
        },
        {
          sourceId: 'bff',
          name: 'BFF',
          layer: 'BFF',
          status: 'UNDETERMINED',
          changes: { added: 0, removed: 0, changed: 0 },
          reason: 'non lue',
        },
      ],
      changes: [
        {
          node: 'n1',
          kind: 'ROUTE',
          name: '/companies/new',
          change: 'REMOVED',
          detail: ['lien retiré'],
          source: 'front',
          layer: 'FRONTEND',
          features: [{ id: 'f1', name: 'Company form' }],
          evidence: {
            kind: 'STATIC_CODE',
            sourceId: 'front',
            file: 'src/app/app.routes.ts',
            line: 3,
            confidence: 'CONFIRMED',
          },
        },
        {
          node: 'n2',
          kind: 'FIELD',
          name: 'email',
          change: 'ADDED',
          detail: [],
          source: 'front',
          layer: 'FRONTEND',
        },
      ],
    });
    const rows = impactRows(m, r);
    expect(rows.map((x) => [x.kind, x.name, x.impact])).toEqual([
      ['REMOVED', '/companies/new', 'FEATURES'],
      ['ADDED', 'email', 'NONE_SHOWN'],
      ['UNDETERMINED', 'BFF', 'CHECK'],
    ]);
    const base = { impactKind: 'ALL', impactLayer: '', impactSource: '', impactQ: '' };
    expect(filterRows(rows, { ...base, impactKind: 'REMOVED' }).map((x) => x.name)).toEqual([
      '/companies/new',
    ]);
    expect(filterRows(rows, { ...base, impactQ: 'app.routes' }).map((x) => x.name)).toEqual([
      '/companies/new',
    ]);
    expect(filterRows(rows, { ...base, impactQ: 'company form' }).map((x) => x.name)).toEqual([
      '/companies/new',
    ]);
    expect(filterRows(rows, { ...base, impactLayer: 'BFF' }).map((x) => x.name)).toEqual(['BFF']);
    expect(filterRows(rows, { ...base, impactSource: 'front' })).toHaveLength(2);
    const ui = emptyCartographyUi();
    ui.impact = r;
    const html = impactView(m, ui, summary, h, { launch: '' });
    expect(html).toContain(`${m.sd.all} (3)`);
    expect(html).toContain(`${m.sd.removed} (1)`);
    // Le menu d'une ligne ouvre la preuve et la fonctionnalité atteinte.
    expect(html).toContain('data-action="map-evidence" data-file="src/app/app.routes.ts"');
    expect(html).toContain('data-action="map-feature" data-feature="f1"');
  });
});
