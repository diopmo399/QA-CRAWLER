import { describe, expect, it } from 'vitest';
import {
  clampSplit,
  DEFAULT_SIZES,
  emptyPrefs,
  emptySplitUi,
  INCIDENT_SPLIT_CSS,
  mobilePaneOf,
  paneFractions,
  paneMode,
  parsePrefs,
  PREFS_KEY,
  readPrefs,
  reduceSplit,
  renderHiddenBar,
  renderPane,
  renderSplitLayout,
  renderSplitter,
  splitBounds,
  splitFromPrefs,
  SUB_TABS,
  splitTemplates,
  writePrefs,
  zoneTracks,
  type PaneSpec,
  type PrefsStorage,
  type SplitUi,
} from '../../src/sdk/ui/incident-split.js';

/**
 * LA DISPOSITION EN PANNEAUX : le réducteur (agrandir, réduire, masquer, rappeler, séparateurs au clavier
 * et au pointeur), le calcul des tailles (fractions bornées par les minimums en pixels), les gabarits de
 * grille, le rendu accessible (séparateurs, barres de titre, sélecteur d'écran étroit) et les préférences
 * (validées champ par champ, sur un stockage passé en argument).
 */
const opts = { lang: 'fr' as const, layout: 'trace' as const, mobileDefault: 'primary' as const };
const spec = (title: string, body = `<p>${title}</p>`): PaneSpec => ({ title, body });
const traceSpecs = {
  primary: spec('Graphe full-stack'),
  details: spec('Détail de la sélection'),
  tree: spec('Fichiers'),
  editor: spec('Code'),
  evidence: spec('Preuves'),
};

/** Un stockage en mémoire (et un stockage qui refuse tout). */
function memory(initial?: string): PrefsStorage & { data: Map<string, string> } {
  const data = new Map<string, string>(initial === undefined ? [] : [[PREFS_KEY, initial]]);
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}
const refusing: PrefsStorage = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('QuotaExceededError');
  },
};

describe('reduceSplit — panes', () => {
  it('maximize, Escape-like restore, collapse to the title bar, hide and show again', () => {
    let ui = emptySplitUi();
    ui = reduceSplit(ui, 'ws-pane', { pane: 'editor', op: 'max' }) ?? ui;
    expect(ui.maximized).toBe('editor');
    ui = reduceSplit(ui, 'ws-pane', { pane: 'editor', op: 'restore' }) ?? ui;
    expect(ui.maximized).toBeUndefined();
    expect('maximized' in ui).toBe(false);
    ui = reduceSplit(ui, 'ws-pane', { pane: 'details', op: 'min' }) ?? ui;
    expect(ui.panes.details).toBe('min');
    expect(paneMode(ui, 'trace', 'details')).toBe('min');
    ui = reduceSplit(ui, 'ws-pane', { pane: 'details', op: 'restore' }) ?? ui;
    expect(ui.panes.details).toBeUndefined();
    ui = reduceSplit(ui, 'ws-pane', { pane: 'evidence', op: 'hide' }) ?? ui;
    expect(ui.panes.evidence).toBe('hidden');
    // Un panneau masqué ne s'agrandit pas.
    expect(reduceSplit(ui, 'ws-pane', { pane: 'evidence', op: 'max' })).toBe(ui);
    ui = reduceSplit(ui, 'ws-pane', { pane: 'evidence', op: 'show' }) ?? ui;
    expect(ui.panes).toEqual({});
  });

  it('collapsing or hiding the maximized pane leaves the maximized state; a hidden mobile pane is forgotten', () => {
    let ui: SplitUi = { ...emptySplitUi(), maximized: 'primary', mobilePane: 'primary' };
    ui = reduceSplit(ui, 'ws-pane', { pane: 'primary', op: 'hide' }) ?? ui;
    expect(ui.maximized).toBeUndefined();
    expect(ui.mobilePane).toBeUndefined();
    ui = { ...ui, maximized: 'editor' };
    ui = reduceSplit(ui, 'ws-pane', { pane: 'details', op: 'min' }) ?? ui;
    expect(ui.maximized).toBe('editor');
  });

  it('Code tab: graph and details collapsed by default; restoring or showing one opens the top zone', () => {
    let ui = emptySplitUi();
    expect(paneMode(ui, 'code', 'primary')).toBe('min');
    expect(paneMode(ui, 'code', 'details')).toBe('min');
    expect(paneMode(ui, 'trace', 'primary')).toBe('normal');
    expect(paneMode(ui, 'code', 'editor')).toBe('normal');
    ui = reduceSplit(ui, 'ws-pane', { pane: 'primary', op: 'restore', layout: 'code' }) ?? ui;
    expect(ui.codeTop).toBe(true);
    expect(paneMode(ui, 'code', 'primary')).toBe('normal');
    // Masqué reste masqué, même la zone haute fermée.
    const hidden = { ...emptySplitUi(), panes: { details: 'hidden' as const } };
    expect(paneMode(hidden, 'code', 'details')).toBe('hidden');
  });

  it('mobile: the pane chosen by the switcher, the default otherwise; foreign actions are not handled', () => {
    const ui = reduceSplit(emptySplitUi(), 'ws-pane-focus', { pane: 'evidence' }) ?? emptySplitUi();
    expect(ui.mobilePane).toBe('evidence');
    expect(reduceSplit(ui, 'ws-pane-focus', { pane: 'nope' })).toBe(ui);
    expect(reduceSplit(ui, 'ws-pane', { pane: 'nope', op: 'max' })).toBe(ui);
    expect(reduceSplit(ui, 'ws-pane', { pane: 'editor', op: 'explode' })).toBe(ui);
    expect(reduceSplit(ui, 'ws-graph-zoom', {})).toBeUndefined();
    const present = ['primary', 'details', 'tree', 'editor', 'evidence'] as const;
    expect(mobilePaneOf(ui, 'trace', present, 'primary')).toBe('evidence');
    expect(mobilePaneOf({ ...ui, panes: { evidence: 'hidden' } }, 'trace', present, 'primary')).toBe(
      'primary',
    );
    expect(mobilePaneOf(emptySplitUi(), 'document', ['content', 'details'], 'editor')).toBe('content');
  });
});

describe('reduceSplit — splitters and size math', () => {
  it('the keyboard starts from the RENDERED position: the first arrow moves visibly when the stored one is out of bounds', () => {
    const ui = emptySplitUi();
    // 860 px : les détails gardent 260 px, la position rendue est 0,6977 (la mémorisée 0,7).
    const left = reduceSplit(ui, 'ws-split-key', {
      splitter: 'primary-details',
      key: 'ArrowLeft',
      total: '860',
    });
    expect(left?.sizes['primary-details']).toBeCloseTo(0.6777, 3);
    const right = reduceSplit(ui, 'ws-split-key', {
      splitter: 'primary-details',
      key: 'ArrowRight',
      total: '860',
    });
    expect(right?.sizes['primary-details']).toBeCloseTo(0.6977, 3);
    // Sans taille connue, la position mémorisée sert de départ.
    expect(
      reduceSplit(ui, 'ws-split-key', { splitter: 'primary-details', key: 'ArrowLeft' })?.sizes[
        'primary-details'
      ],
    ).toBeCloseTo(0.68);
  });

  it('positions are fractions, clamped by the general bounds and by the pixel minimums of each pane', () => {
    const sizes = { ...DEFAULT_SIZES };
    expect(clampSplit('primary-details', 0.01, sizes)).toBe(0.08);
    expect(clampSplit('primary-details', 0.99, sizes)).toBe(0.92);
    // 1 000 px : le graphe garde 320 px, les détails 260 px.
    expect(splitBounds('primary-details', sizes, 1000)).toEqual({ min: 0.32, max: 0.74 });
    expect(clampSplit('primary-details', 0.2, sizes, 1000)).toBe(0.32);
    expect(clampSplit('primary-details', 0.9, sizes, 1000)).toBe(0.74);
    // Zone haute ≥ 200 px, zone basse ≥ 160 px.
    expect(splitBounds('top-bottom', sizes, 800)).toEqual({ min: 0.25, max: 0.8 });
    // Les deux séparateurs de la zone basse gardent l'éditeur entre eux (300 px sur 1 000).
    expect(splitBounds('tree-editor', { ...sizes, 'editor-evidence': 0.7 }, 1000).max).toBeCloseTo(0.4);
    expect(splitBounds('editor-evidence', { ...sizes, 'tree-editor': 0.2 }, 1000).min).toBeCloseTo(0.5);
    // Trop petit pour les deux minimums : la position reste au milieu de ce qui est possible.
    const tiny = splitBounds('primary-details', sizes, 400);
    expect(tiny.min).toBe(tiny.max);
    expect(clampSplit('primary-details', Number.NaN, sizes)).toBe(sizes['primary-details']);
  });

  it('set from the pointer, keyboard steps (2 %, Shift 10 %), Home/End, Enter collapses the first pane, reset', () => {
    let ui = emptySplitUi();
    ui = reduceSplit(ui, 'ws-split-set', { splitter: 'primary-details', value: '0.5', total: '1200' }) ?? ui;
    expect(ui.sizes['primary-details']).toBe(0.5);
    ui = reduceSplit(ui, 'ws-split-key', { splitter: 'primary-details', key: 'ArrowRight' }) ?? ui;
    expect(ui.sizes['primary-details']).toBeCloseTo(0.52);
    ui =
      reduceSplit(ui, 'ws-split-key', { splitter: 'primary-details', key: 'ArrowLeft', shift: 'true' }) ?? ui;
    expect(ui.sizes['primary-details']).toBeCloseTo(0.42);
    ui = reduceSplit(ui, 'ws-split-key', { splitter: 'top-bottom', key: 'ArrowDown' }) ?? ui;
    expect(ui.sizes['top-bottom']).toBeCloseTo(0.6);
    ui = reduceSplit(ui, 'ws-split-key', { splitter: 'primary-details', key: 'Home', total: '1000' }) ?? ui;
    expect(ui.sizes['primary-details']).toBe(0.32);
    ui = reduceSplit(ui, 'ws-split-key', { splitter: 'primary-details', key: 'End', total: '1000' }) ?? ui;
    expect(ui.sizes['primary-details']).toBe(0.74);
    ui = reduceSplit(ui, 'ws-split-key', { splitter: 'tree-editor', key: 'Enter' }) ?? ui;
    expect(ui.panes.tree).toBe('min');
    ui = reduceSplit(ui, 'ws-split-key', { splitter: 'tree-editor', key: 'Enter' }) ?? ui;
    expect(ui.panes.tree).toBeUndefined();
    expect(reduceSplit(ui, 'ws-split-key', { splitter: 'tree-editor', key: 'a' })).toBe(ui);
    expect(reduceSplit(ui, 'ws-split-set', { splitter: 'nope', value: '0.5' })).toBe(ui);
    ui = reduceSplit(ui, 'ws-split-reset', { splitter: 'primary-details' }) ?? ui;
    expect(ui.sizes['primary-details']).toBe(DEFAULT_SIZES['primary-details']);
    expect(ui.sizes['top-bottom']).toBeCloseTo(0.6);
    const all = reduceSplit(
      { ...ui, panes: { evidence: 'hidden' }, mobilePane: 'tree' },
      'ws-split-reset',
      {},
    );
    expect(all).toEqual({ ...emptySplitUi(), mobilePane: 'tree' });
  });

  it('pane fractions come from splitter positions; the grid uses minmax(min px, fr) and integer fr parts', () => {
    expect(paneFractions(DEFAULT_SIZES)).toMatchObject({ primary: 0.7, tree: 0.2, content: 0.68 });
    expect(paneFractions(DEFAULT_SIZES).editor).toBeCloseTo(0.54);
    expect(paneFractions(DEFAULT_SIZES).evidence).toBeCloseTo(0.26);
    const ui = emptySplitUi();
    const templates = splitTemplates(ui, 'trace');
    expect(templates.top).toBe('minmax(320px,70fr) 6px minmax(260px,30fr)');
    expect(templates.bottom).toBe('minmax(180px,20fr) 6px minmax(300px,54fr) 6px minmax(200px,26fr)');
    expect(templates.rows).toBe('minmax(200px,58fr) 6px minmax(160px,42fr)');
    expect(splitTemplates(ui, 'document').doc).toBe('minmax(360px,68fr) 6px minmax(260px,32fr)');
    // Un panneau réduit entre deux autres devient un rail de 40 px, sans séparateur à côté.
    const strip = zoneTracks({ ...ui, panes: { tree: 'min' } }, 'trace', ['tree', 'editor', 'evidence']);
    expect(strip.template).toBe('40px minmax(300px,54fr) 6px minmax(200px,26fr)');
    expect(strip.tracks.filter((track) => track.kind === 'splitter')).toHaveLength(1);
    // Onglet Code : la zone haute réduite à ses barres prend la hauteur de ses barres.
    const code = splitTemplates(ui, 'code');
    expect(code.top).toBe('minmax(0,1fr) minmax(0,1fr)');
    expect(code.rows).toBe('auto 6px minmax(0,1fr)');
    // Un panneau masqué disparaît de la grille ; une zone vide laisse toute la hauteur à l'autre.
    expect(splitTemplates({ ...ui, panes: { details: 'hidden' } }, 'trace').top).toBe('minmax(320px,70fr)');
    expect(splitTemplates({ ...ui, panes: { primary: 'hidden', details: 'hidden' } }, 'trace').rows).toBe(
      'minmax(0,1fr)',
    );
  });
});

describe('rendering', () => {
  it('a collapsed rail writes the short title; the full title stays in the tooltip and the button labels', () => {
    const tree = { ...spec('Fichiers du périmètre'), short: 'Fichiers' };
    const rail = renderPane(
      'tree',
      tree,
      { ...emptySplitUi(), panes: { tree: 'min' } },
      { ...opts, strip: true },
    );
    expect(rail).toContain('title="Fichiers du périmètre"><span>Fichiers</span></h2>');
    expect(rail).toContain('aria-label="Déplier « Fichiers du périmètre »"');
    const open = renderPane('tree', tree, emptySplitUi(), opts);
    expect(open).toContain('<span>Fichiers du périmètre</span></h2>');
  });

  it('splitter handles and pane edges use contrasted tokens, and the pointer area is wider than the track', () => {
    expect(INCIDENT_SPLIT_CSS).toContain(
      '.ws-splitter::after{content:"";position:absolute;border-radius:2px;background:var(--qa-color-muted)}',
    );
    expect(INCIDENT_SPLIT_CSS).not.toContain('opacity:.7');
    expect(INCIDENT_SPLIT_CSS).toContain(
      '--ws-edge:color-mix(in srgb,var(--qa-color-muted) 60%,var(--qa-color-border-strong))',
    );
    expect(INCIDENT_SPLIT_CSS).toContain('border:1px solid var(--ws-edge)');
    expect(INCIDENT_SPLIT_CSS).toContain('.ws-splitter-x::before{top:0;bottom:0;left:-3px;right:-3px}');
  });

  it('a pane: labelled section, title with tooltip, max / collapse / hide buttons with their state', () => {
    const ui = emptySplitUi();
    const html = renderPane('editor', spec('Code (lecture seule)', '<p>x</p>'), ui, opts);
    expect(html).toContain(
      '<section class="ws-pane ws-pane-editor" id="ws-pane-editor" data-ws-pane="editor" data-ws-zone="editor" data-mode="normal" aria-labelledby="ws-pane-editor-t">',
    );
    expect(html).toContain('<h2 class="ws-pane-t" id="ws-pane-editor-t" title="Code (lecture seule)">');
    expect(html).toContain(
      'data-action="ws-pane" data-pane="editor" data-op="max" data-layout="trace" aria-label="Agrandir « Code (lecture seule) » à tout l’espace (Échap rétablit)"',
    );
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('data-op="min"');
    expect(html).toContain('aria-expanded="true" aria-controls="ws-pane-editor-b"');
    expect(html).toContain('data-op="hide"');
    expect(html).toContain(
      '<div class="ws-pane-b" id="ws-pane-editor-b" data-ws-scroll="editor"><p>x</p></div>',
    );
    const min = renderPane('editor', spec('Code'), { ...ui, panes: { editor: 'min' } }, opts);
    expect(min).toContain('data-mode="min"');
    expect(min).toContain('data-op="restore"');
    expect(min).toContain('aria-expanded="false"');
    expect(min).toContain('data-ws-scroll="editor" hidden>');
    expect(min).not.toContain('data-op="max"');
    const max = renderPane('editor', spec('Code'), { ...ui, maximized: 'editor' }, opts);
    expect(max).toContain('data-mode="max"');
    expect(max).toContain(
      'data-op="restore" data-layout="trace" aria-label="Rétablir « Code » dans la disposition"',
    );
    expect(max).toContain('aria-pressed="true"');
    expect(max).not.toContain('data-op="hide"');
  });

  it('a splitter: role separator, focusable, orientation, value and bounds in percent, controls its first pane', () => {
    const html = renderSplitter('primary-details', emptySplitUi(), opts);
    expect(html).toContain(
      'class="ws-splitter ws-splitter-x" role="separator" tabindex="0" aria-orientation="vertical" aria-valuenow="70" aria-valuemin="8" aria-valuemax="92" aria-label="Redimensionner : Graphe et Détails" aria-controls="ws-pane-primary"',
    );
    expect(html).toContain('data-action="ws-split" data-ws-splitter="primary-details"');
    expect(renderSplitter('top-bottom', emptySplitUi(), opts)).toContain(
      'ws-splitter-y" role="separator" tabindex="0" aria-orientation="horizontal"',
    );
  });

  it('the split layout: two zones, splitters between normal panes, a switcher for narrow screens', () => {
    const html = renderSplitLayout(traceSpecs, emptySplitUi(), { ...opts, detailsHint: 'Voir le détail' });
    expect(html).toContain('<div class="ws-split-host">');
    expect(html).toContain('style="grid-template-rows:minmax(200px,58fr) 6px minmax(160px,42fr)"');
    for (const splitter of ['top-bottom', 'primary-details', 'tree-editor', 'editor-evidence'])
      expect(html).toContain(`data-ws-splitter="${splitter}"`);
    expect(html).toContain('<div class="ws-mswitch" role="group" aria-label="Panneau affiché">');
    expect(html).toContain('data-action="ws-pane-focus" data-pane="primary" aria-pressed="true"');
    expect(html).toContain('data-pane="evidence" aria-pressed="false"');
    expect(html).toContain('class="ws-mhint lnk" data-action="ws-pane-focus" data-pane="details"');
    expect(html).toMatch(/class="ws-pane ws-pane-primary ws-m-on"/);
    // Agrandi : un seul panneau ; masqué : listé pour être rappelé.
    const maxed = renderSplitLayout(traceSpecs, { ...emptySplitUi(), maximized: 'details' }, opts);
    expect(maxed.match(/<section class="ws-pane/g)).toHaveLength(1);
    expect(maxed).toContain('ws-split-maxed');
    const ui = { ...emptySplitUi(), panes: { tree: 'hidden' as const } };
    const hidden = renderSplitLayout(traceSpecs, ui, opts);
    expect(hidden).not.toContain('id="ws-pane-tree"');
    expect(hidden).not.toContain('data-ws-splitter="tree-editor"');
    expect(renderHiddenBar(ui, traceSpecs, opts)).toContain(
      'data-action="ws-pane" data-pane="tree" data-op="show" data-layout="trace" aria-label="Afficher « Fichiers »"',
    );
    expect(renderHiddenBar(emptySplitUi(), traceSpecs, opts)).toBe('');
    // Le document : contenu | détails.
    const doc = renderSplitLayout({ content: spec('Résumé'), details: spec('Détail') }, emptySplitUi(), {
      ...opts,
      layout: 'document',
      mobileDefault: 'content',
    });
    expect(doc).toContain('data-ws-layout="document"');
    expect(doc).toContain('data-ws-splitter="content-details"');
    // Onglet Code : barres de la zone haute, sans séparateur entre les zones.
    const code = renderSplitLayout(traceSpecs, emptySplitUi(), {
      ...opts,
      layout: 'code',
      mobileDefault: 'editor',
    });
    expect(code).toContain('ws-split-top ws-zone-collapsed');
    expect(code).not.toContain('data-ws-splitter="top-bottom"');
    expect(code).toContain('class="ws-splitter-gap"');
  });

  it('every pane scrolls by itself; one pane at a time under 720 px; theme tokens only', () => {
    expect(INCIDENT_SPLIT_CSS).toMatch(/\.ws-pane-b\{[^}]*min-height:0;[^}]*overflow:auto/);
    expect(INCIDENT_SPLIT_CSS).toMatch(/\.ws-pane\{[^}]*min-height:0;min-width:0/);
    expect(INCIDENT_SPLIT_CSS).toContain('container:ws-split / inline-size');
    expect(INCIDENT_SPLIT_CSS).toMatch(
      /@container ws-split \(max-width:719px\)\{[^@]*\.ws-pane:not\(\.ws-m-on\)\{display:none\}/,
    );
    expect(INCIDENT_SPLIT_CSS).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(INCIDENT_SPLIT_CSS).not.toMatch(/rgba?\(/);
  });

  it('English texts', () => {
    const html = renderPane('details', spec('Selection detail'), emptySplitUi(), { ...opts, lang: 'en' });
    expect(html).toContain('Maximize “Selection detail” to the whole space (Escape restores)');
    expect(renderSplitter('tree-editor', emptySplitUi(), { ...opts, lang: 'en' })).toContain(
      'aria-label="Resize: Files and Code"',
    );
  });
});

describe('preferences', () => {
  it('read back what was written; every field is validated, garbage ignored', () => {
    const storage = memory();
    const prefs = {
      ...emptyPrefs(),
      sizes: { 'primary-details': 0.6, 'top-bottom': 0.5 },
      panes: { evidence: 'hidden' as const, tree: 'min' as const },
      maximized: 'editor' as const,
      tab: 'code' as const,
      subs: { traceability: 'http' as const },
      graphZoom: 1.5,
      graphLayout: 'lanes' as const,
      compact: true,
      stepper: true,
      treeCollapsed: true,
      codeTop: true,
    };
    expect(writePrefs(storage, prefs)).toBe(true);
    expect(JSON.parse(storage.data.get(PREFS_KEY) ?? '{}')).toMatchObject({ tab: 'code', compact: true });
    expect(readPrefs(storage)).toEqual(prefs);
    const garbage = parsePrefs({
      sizes: { 'primary-details': 7, 'top-bottom': 'x', nope: 0.5, 'content-details': 0.4 },
      panes: { evidence: 'gone', tree: 'min', alien: 'hidden', editor: 'normal' },
      maximized: 'window',
      tab: 'settings',
      subs: { traceability: 'logs', timeline: 'logs', report: 42 },
      graphZoom: Number.POSITIVE_INFINITY,
      graphLayout: 'spiral',
      compact: 'yes',
      stepper: 1,
      treeCollapsed: false,
    });
    expect(garbage).toEqual({
      ...emptyPrefs(),
      sizes: { 'content-details': 0.4 },
      panes: { tree: 'min' },
      subs: { timeline: 'logs' },
    });
    // L'éditeur garde sa largeur : deux séparateurs trop proches sont ignorés ensemble.
    expect(parsePrefs({ sizes: { 'tree-editor': 0.5, 'editor-evidence': 0.55 } }).sizes).toEqual({});
    expect(parsePrefs('nope')).toEqual(emptyPrefs());
    expect(parsePrefs([1, 2])).toEqual(emptyPrefs());
  });

  it('Reproduction › Exécution and Preuves are sub-tabs of the timeline tab, remembered like the others', () => {
    expect(SUB_TABS.timeline).toEqual(['run', 'evidence', 'events', 'logs']);
    expect(parsePrefs({ subs: { timeline: 'run' } }).subs).toEqual({ timeline: 'run' });
    expect(parsePrefs({ subs: { timeline: 'evidence' } }).subs).toEqual({ timeline: 'evidence' });
    expect(parsePrefs({ graphLayout: 'columns' }).graphLayout).toBe('columns');
    expect(parsePrefs({ graphLayout: 'grid' }).graphLayout).toBeUndefined();
  });

  it('no storage, a refusing storage or unreadable JSON: the defaults, and the page keeps working', () => {
    expect(readPrefs(undefined)).toEqual(emptyPrefs());
    expect(readPrefs(refusing)).toEqual(emptyPrefs());
    expect(writePrefs(refusing, emptyPrefs())).toBe(false);
    expect(writePrefs(undefined, emptyPrefs())).toBe(false);
    expect(readPrefs(memory('{not json'))).toEqual(emptyPrefs());
    expect(readPrefs(memory(''))).toEqual(emptyPrefs());
  });

  it('a layout built from the preferences', () => {
    const ui = splitFromPrefs({
      ...emptyPrefs(),
      sizes: { 'top-bottom': 0.4 },
      panes: { details: 'min' },
      maximized: 'primary',
      codeTop: true,
    });
    expect(ui.sizes).toEqual({ ...DEFAULT_SIZES, 'top-bottom': 0.4 });
    expect(ui.panes).toEqual({ details: 'min' });
    expect(ui.maximized).toBe('primary');
    expect(ui.codeTop).toBe(true);
  });
});
