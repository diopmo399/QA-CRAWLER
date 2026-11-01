import { describe, expect, it } from 'vitest';
import type {
  Incident,
  InvestigationScope,
  ScopeApplication,
  ScopeTree,
  ScopeTreeNode,
} from '../../src/sdk/core/incident-contracts.js';
import {
  emptyScopeUi,
  includedItems,
  INCIDENT_SCOPE_CSS,
  limitsOf,
  limitValue,
  nodeCheck,
  normalizePath,
  reduceScope,
  removeFromSelection,
  renderScopeEditor,
  savedSelection,
  scopeDirty,
  scopeDraftOf,
  scopeEditable,
  scopeTreeRequests,
  toggleSelection,
  type ScopeContext,
  type ScopeTrees,
  type ScopeUi,
} from '../../src/sdk/ui/incident-scope.js';

/**
 * L'ÉCRAN « DÉFINITION DU PÉRIMÈTRE » : les cases à trois états de l'arborescence (cocher un dossier
 * l'ajoute à `include`, le décocher l'en retire ; la racine : toute l'application), le remplacement d'un
 * parent par ses autres sous-dossiers, la profondeur 1 à 5, les limites (durée en minutes, mémoire en Mio,
 * sans effet hors ARO et dit comme tel), le brouillon envoyé au serveur, l'accessibilité et les droits.
 */
const at = '2026-10-30T09:00:00.000Z';

const node = (path: string, children: ScopeTreeNode[] = [], truncated = false): ScopeTreeNode => ({
  path,
  name: path.split('/').at(-1) ?? path,
  included: false,
  children,
  ...(truncated ? { truncated } : {}),
});

/** Le dépôt du frontend : src/{components,pages,services}, public, tests (lu sur deux niveaux). */
const frontTree: ScopeTree = {
  applicationId: 'front',
  root: node('', [
    node('public'),
    node('src', [node('src/components'), node('src/pages', [], true), node('src/services')]),
    node('tests'),
  ]),
};

const app = (
  id: string,
  layer: ScopeApplication['layer'],
  include: string[],
  over: Partial<ScopeApplication> = {},
) => ({
  id,
  name: { front: 'Frontend (React)', bff: 'BFF (Java)', api: 'Backend (Spring Boot)' }[id] ?? id,
  layer,
  repository: { root: `/repos/${id}`, include },
  ...over,
});

const scope = (over: Partial<InvestigationScope> = {}): InvestigationScope => ({
  mode: 'GUIDED',
  applications: [
    app('front', 'FRONTEND', []),
    app('bff', 'BFF', ['src/main/java/controllers/', './src/main/java/services']),
    app('api', 'BACKEND', ['src/main']),
  ],
  scenarios: ['Créer un livre'],
  steps: [],
  endpoints: [],
  depth: 3,
  allowedHosts: [],
  logRoots: [],
  allowedCommands: [],
  permissions: {
    readSources: true,
    navigate: true,
    httpRequests: 'NONE',
    runTests: 'NONE',
    localCommands: false,
    readLogs: false,
    openshift: 'NONE',
    sideEffects: false,
  },
  limits: {
    maxFiles: 2000,
    maxFileBytes: 524288,
    maxDurationMs: 600000,
    maxRequests: 200,
    maxExperiments: 20,
  },
  extensions: [],
  ...over,
});

const incidentOf = (over: Partial<Incident> = {}): Incident => ({
  id: 'inc_abc123def456',
  projectId: 'prj_books',
  title: 'Erreur 500 à la création d’un livre',
  description: '',
  observed: 'HTTP 500',
  expected: 'livre créé',
  severity: 'HIGH',
  execution: { target: 'LOCAL' },
  scope: scope(),
  state: 'SCOPED',
  revision: 3,
  createdAt: at,
  updatedAt: at,
  createdBy: 'analyste',
  history: [],
  investigation: { reproductions: [], hypotheses: [], experiments: [] },
  ...over,
});

const ctxOf = (
  incident = incidentOf(),
  options: { runner?: boolean; demo?: boolean; lang?: 'fr' | 'en' } = {},
) =>
  ({
    incident,
    lang: options.lang ?? 'fr',
    demo: options.demo ?? false,
    can: () => options.runner ?? true,
  }) satisfies ScopeContext;

const trees: ScopeTrees = { front: { tree: frontTree, root: '/repos/front' } };

describe('selection of folders', () => {
  it('paths are compared without ./, slashes at the ends or backslashes', () => {
    expect(normalizePath(' ./src/main/ ')).toBe('src/main');
    expect(normalizePath('src\\main\\java')).toBe('src/main/java');
    expect(normalizePath('/')).toBe('');
    expect(savedSelection(app('a', 'BFF', []))).toEqual({ whole: true, paths: [] });
    expect(savedSelection(app('a', 'BFF', ['b/', './a', 'a']))).toEqual({ whole: false, paths: ['a', 'b'] });
  });

  it('tri-state: whole repository, folder, ancestor, partial, nothing', () => {
    const selection = { whole: false, paths: ['src/components'] };
    expect(nodeCheck({ whole: true, paths: [] }, 'src/pages')).toBe('true');
    expect(nodeCheck(selection, '')).toBe('mixed');
    expect(nodeCheck(selection, 'src')).toBe('mixed');
    expect(nodeCheck(selection, 'src/components')).toBe('true');
    expect(nodeCheck(selection, 'src/components/books')).toBe('true');
    expect(nodeCheck(selection, 'src/comp')).toBe('false');
    expect(nodeCheck(selection, 'public')).toBe('false');
    expect(nodeCheck({ whole: false, paths: [] }, '')).toBe('false');
  });

  it('checking adds the folder (its kept subfolders give way); unchecking removes it', () => {
    let selection = toggleSelection({ whole: false, paths: ['src/components', 'tests'] }, frontTree, 'src');
    expect(selection).toEqual({ whole: false, paths: ['src', 'tests'] });
    selection = toggleSelection(selection, frontTree, 'tests');
    expect(selection).toEqual({ whole: false, paths: ['src'] });
    // La racine : cochée → plus rien ; sinon toute l'application.
    expect(toggleSelection(selection, frontTree, '')).toEqual({ whole: true, paths: [] });
    expect(toggleSelection({ whole: true, paths: [] }, frontTree, '')).toEqual({ whole: false, paths: [] });
  });

  it('unchecking a folder covered by a parent replaces the parent with its other subfolders', () => {
    expect(toggleSelection({ whole: true, paths: [] }, frontTree, 'src/pages')).toEqual({
      whole: false,
      paths: ['public', 'src/components', 'src/services', 'tests'],
    });
    expect(toggleSelection({ whole: false, paths: ['src', 'tests'] }, frontTree, 'src/services')).toEqual({
      whole: false,
      paths: ['src/components', 'src/pages', 'tests'],
    });
    // Sans arborescence lue, rien n'est deviné : la sélection reste.
    const kept = { whole: true, paths: [] };
    expect(toggleSelection(kept, undefined, 'src/pages')).toBe(kept);
    expect(toggleSelection(kept, frontTree, 'unknown/dir')).toBe(kept);
  });

  it('removing an included item; the included list (whole application or folders)', () => {
    expect(removeFromSelection({ whole: true, paths: [] }, '')).toEqual({ whole: false, paths: [] });
    expect(removeFromSelection({ whole: false, paths: ['a', 'b'] }, 'a/')).toEqual({
      whole: false,
      paths: ['b'],
    });
    const items = includedItems(incidentOf(), emptyScopeUi());
    expect(items.map((item) => `${item.app.id}:${item.path}`)).toEqual([
      'front:',
      'bff:src/main/java/controllers',
      'bff:src/main/java/services',
      'api:src/main',
    ]);
  });
});

describe('limits and the draft sent to the server', () => {
  it('limits are shown in minutes and KiB, validated (duration ≤ 120 min, memory 64 to 16384 MiB)', () => {
    const saved = scope().limits;
    expect(limitValue(saved, emptyScopeUi(), 'duration')).toBe('10');
    expect(limitValue(saved, emptyScopeUi(), 'maxFileKib')).toBe('512');
    expect(limitValue(saved, emptyScopeUi(), 'memory')).toBe('');
    expect(limitValue({ ...saved, maxMemoryMb: 1024 }, emptyScopeUi(), 'memory')).toBe('1024');
    const ui: ScopeUi = {
      ...emptyScopeUi(),
      limits: { duration: '60', memory: '1024', maxFiles: '50', maxFileKib: '64' },
    };
    expect(limitsOf(saved, ui)).toEqual({
      limits: { ...saved, maxDurationMs: 3_600_000, maxMemoryMb: 1024, maxFiles: 50, maxFileBytes: 65536 },
      invalid: [],
    });
    const bad: ScopeUi = {
      ...emptyScopeUi(),
      limits: { duration: '121', memory: '32', maxRequests: '0', maxExperiments: '2.5' },
    };
    expect(limitsOf(saved, bad).invalid).toEqual(['duration', 'memory', 'maxRequests', 'maxExperiments']);
    // Une mémoire vidée : la limite est retirée.
    expect(
      limitsOf({ ...saved, maxMemoryMb: 512 }, { ...emptyScopeUi(), limits: { memory: ' ' } }).limits,
    ).not.toHaveProperty('maxMemoryMb');
  });

  it('the draft keeps permissions and extensions, applies mode, depth, includes and limits', () => {
    const incident = incidentOf();
    const ui: ScopeUi = {
      ...emptyScopeUi(incident.id),
      mode: 'MANUAL',
      depth: 5,
      selection: { front: { whole: false, paths: ['src'] } },
      limits: { duration: '30' },
    };
    const draft = scopeDraftOf(incident, ui);
    expect(draft.invalid).toEqual([]);
    expect(draft.scope.mode).toBe('MANUAL');
    expect(draft.scope.depth).toBe(5);
    expect(draft.scope.applications[0]?.repository.include).toEqual(['src']);
    // Une application non modifiée part telle quelle (ses chemins d'origine).
    expect(draft.scope.applications[1]).toBe(incident.scope.applications[1]);
    expect(draft.scope.limits.maxDurationMs).toBe(1_800_000);
    expect(draft.scope.permissions).toBe(incident.scope.permissions);
    expect(draft.scope.extensions).toBe(incident.scope.extensions);
    expect(scopeDirty(incident, ui)).toBe(true);
    expect(scopeDirty(incident, emptyScopeUi())).toBe(false);
    // Les mêmes valeurs que l'enregistré : rien n'a changé.
    expect(
      scopeDirty(incident, { ...emptyScopeUi(), mode: 'GUIDED', depth: 3, limits: { duration: '10' } }),
    ).toBe(false);
    expect(
      scopeDirty(incident, {
        ...emptyScopeUi(),
        selection: { bff: { whole: false, paths: ['src/main/java/controllers', 'src/main/java/services'] } },
      }),
    ).toBe(false);
    // Une application sans aucun dossier, une limite hors bornes : refusées avant l'envoi.
    expect(
      scopeDraftOf(incident, {
        ...emptyScopeUi(),
        selection: { api: { whole: false, paths: [] } },
        limits: { memory: '1' },
      }).invalid,
    ).toEqual(['app:api', 'limit:memory']);
  });

  it('the trees to read: missing ones, and those whose repository root changed', () => {
    const incident = incidentOf();
    expect(scopeTreeRequests(incident, {}).map((entry) => entry.id)).toEqual(['front', 'bff', 'api']);
    expect(
      scopeTreeRequests(incident, {
        ...trees,
        bff: { state: 'loading', root: '/repos/bff' },
        api: { root: '/old' },
      }).map((entry) => entry.id),
    ).toEqual(['api']);
  });
});

describe('reduceScope', () => {
  it('mode, depth, limits, expansion, toggle, removal, reset, invalid, saved', () => {
    const incident = incidentOf();
    const env = { incident, trees };
    let ui = emptyScopeUi(incident.id);
    ui = reduceScope(ui, 'inc-scope-mode', { mode: 'AUTO_WITHIN_SCOPE' }) ?? ui;
    expect(ui.mode).toBe('AUTO_WITHIN_SCOPE');
    expect(reduceScope(ui, 'inc-scope-mode', { mode: 'WILD' })).toBe(ui);
    ui = reduceScope(ui, 'inc-scope-depth', { value: '1' }) ?? ui;
    expect(ui.depth).toBe(1);
    expect(reduceScope(ui, 'inc-scope-depth', { value: '9' })).toBe(ui);
    ui = reduceScope(ui, 'inc-scope-invalid', { fields: 'limit:duration, app:api' }) ?? ui;
    expect(ui.invalid).toEqual(['limit:duration', 'app:api']);
    ui = reduceScope(ui, 'inc-scope-limit', { field: 'duration', value: '45' }) ?? ui;
    expect(ui.limits.duration).toBe('45');
    expect(ui.invalid).toEqual(['app:api']);
    expect(reduceScope(ui, 'inc-scope-limit', { field: 'cpu', value: '1' })).toBe(ui);
    ui = reduceScope(ui, 'inc-scope-expand', { block: 'front', index: 'src', open: 'false' }) ?? ui;
    expect(ui.expanded['front|src']).toBe(true);
    ui = reduceScope(ui, 'inc-scope-toggle', { block: 'front', index: 'src/pages' }, env) ?? ui;
    expect(ui.selection.front).toEqual({
      whole: false,
      paths: ['public', 'src/components', 'src/services', 'tests'],
    });
    ui = reduceScope(ui, 'inc-scope-toggle', { block: 'api', index: '' }, env) ?? ui;
    expect(ui.selection.api).toEqual({ whole: true, paths: [] });
    expect(ui.invalid).toEqual([]);
    ui = reduceScope(ui, 'inc-scope-remove', { block: 'bff', index: 'src/main/java/services' }, env) ?? ui;
    expect(ui.selection.bff).toEqual({ whole: false, paths: ['src/main/java/controllers'] });
    // Sans incident (ou pour une application inconnue), rien ne change.
    expect(reduceScope(ui, 'inc-scope-toggle', { block: 'front', index: 'src' })).toBe(ui);
    expect(reduceScope(ui, 'inc-scope-toggle', { block: 'nope', index: '' }, env)).toBe(ui);
    const reset = reduceScope(ui, 'inc-scope-reset', {});
    expect(reset).toEqual({ ...emptyScopeUi(incident.id), expanded: ui.expanded });
    expect(reduceScope(ui, 'inc-scope-saved', {})).toEqual(reset);
    expect(reduceScope(ui, 'ws-ux-stage', {})).toBeUndefined();
    expect(reduceScope(ui, 'inc-scope-next', {})).toBeUndefined();
  });
});

describe('renderScopeEditor', () => {
  it('mode radios, the application tree with tri-state checkboxes, depth, included items, limits, next step', () => {
    const incident = incidentOf();
    const ui: ScopeUi = {
      ...emptyScopeUi(incident.id),
      selection: { front: { whole: false, paths: ['src/components'] } },
    };
    const html = renderScopeEditor(ctxOf(incident), ui, trees);
    expect(html).toContain('<h2 id="inc-sc-t" class="fl">Définition du périmètre</h2>');
    // Les trois modes : un groupe de boutons radio (tabindex itinérant), la description du mode choisi.
    expect(html).toContain('<div class="inc-sc-modes" role="radiogroup" aria-label="Mode d’investigation">');
    expect(html).toMatch(
      /role="radio" class="inc-sc-mode" data-action="inc-scope-mode" data-mode="GUIDED" data-index="GUIDED" aria-checked="true" tabindex="0" aria-describedby="inc-sc-mode-h">Mode guidé</,
    );
    expect(html).toMatch(/data-mode="MANUAL"[^>]*aria-checked="false" tabindex="-1"[^>]*>Mode manuel</);
    expect(html).toMatch(/data-mode="AUTO_WITHIN_SCOPE"[^>]*>Mode automatique</);
    expect(html).toContain('Les extensions et vérifications sont proposées ; chacune attend votre clic.');
    // L'application : une case partielle (aria-checked="mixed"), son badge de couche.
    expect(html).toMatch(
      /role="checkbox" class="inc-sc-cb" aria-checked="mixed" data-action="inc-scope-toggle" data-block="front" data-index="">.*Frontend \(React\).*inc-sc-l-frontend/,
    );
    expect(html).toContain(
      'data-action="inc-scope-expand" data-block="front" data-index="" data-open="true" aria-expanded="true" aria-label="Replier Frontend (React)"',
    );
    // Les dossiers : « src » partiel et déplié, « src/components » coché, « public » non coché.
    expect(html).toMatch(
      /aria-checked="mixed" data-action="inc-scope-toggle" data-block="front" data-index="src">/,
    );
    expect(html).toMatch(
      /aria-checked="true" data-action="inc-scope-toggle" data-block="front" data-index="src\/components">/,
    );
    expect(html).toMatch(
      /aria-checked="false" data-action="inc-scope-toggle" data-block="front" data-index="public">/,
    );
    expect(html).toContain('<span class="inc-sc-name" title="src/components">components/</span>');
    // Un dossier dont la lecture s'arrête : dit.
    expect(html).toContain('sous-dossiers non affichés (profondeur de lecture)');
    // Les autres applications : leur arborescence est en cours de lecture.
    expect(html.match(/Lecture des dossiers…/g)).toHaveLength(2);
    // La profondeur : un curseur 1 à 5 avec sa valeur dite.
    expect(html).toContain(
      '<input type="range" id="inc-sc-depth" data-inc="scope.range" min="1" max="5" step="1" value="3" aria-valuetext="3 sur 5 — Standard" aria-describedby="inc-sc-depth-h">',
    );
    expect(html).toContain('<label for="inc-sc-depth" class="inc-sc-h">Profondeur d’analyse</label>');
    for (const level of ['Limitée', 'Standard', 'Complète'])
      expect(html).toContain(`<small>${level}</small>`);
    // Les éléments inclus : couche, application, chemin, bouton de retrait nommé.
    expect(html).toContain('Éléments inclus (4)');
    expect(html).toContain(
      'data-action="inc-scope-remove" data-block="front" data-index="src/components" aria-label="Retirer src/components/ de Frontend (React)"',
    );
    // Les limites : durée en minutes, mémoire en Mio, sans effet en LOCAL et dit comme tel.
    expect(html).toContain(
      '<input id="inc-sc-limit-duration" type="number" inputmode="numeric" data-inc="scope.limit.duration" min="1" max="120" step="1" value="10">',
    );
    expect(html).toContain('aria-describedby="inc-sc-limit-memory-h"');
    expect(html).toContain('Sans effet en LOCAL : seul un Job ARO borne la mémoire de son conteneur.');
    expect(html).toContain('<summary>Plus de limites</summary>');
    expect(html).toContain('data-inc="scope.limit.maxFileKib"');
    // Le brouillon diffère : il peut être abandonné ; « Étape suivante » enregistre, vérifie, continue.
    expect(html).toContain('Modifications non enregistrées.');
    expect(html).toContain('data-action="inc-scope-reset"');
    expect(html).toContain('data-action="inc-scope-next" aria-describedby="inc-sc-next-h" aria-busy="false"');
    expect(html).toContain('data-action="inc-validate"');
    expect(html).not.toContain('role="alert"');
  });

  it('errors: an application without folder and a limit out of range are flagged and described', () => {
    const incident = incidentOf({
      execution: {
        target: 'ARO',
        aro: { namespace: 'n', serviceAccount: 's', image: 'i', repositoriesMount: '/m' },
      },
    });
    const ui: ScopeUi = {
      ...emptyScopeUi(incident.id),
      selection: { api: { whole: false, paths: [] } },
      limits: { maxFiles: '0' },
      invalid: ['app:api', 'limit:maxFiles'],
    };
    const html = renderScopeEditor(ctxOf(incident), ui, trees, {
      validation: {
        ok: false,
        issues: [{ field: 'applications[2].repository.root', message: 'introuvable' }],
      },
    });
    expect(html).toMatch(
      /role="checkbox" class="inc-sc-cb" aria-checked="false" aria-invalid="true" aria-describedby="inc-sc-app-api-e" data-action="inc-scope-toggle" data-block="api" data-index=""/,
    );
    expect(html).toMatch(/<p id="inc-sc-app-api-e" class="err inc-sc-field-err">.*Aucun dossier retenu/);
    expect(html).toContain('<details class="inc-sc-more" open>');
    expect(html).toContain(
      'id="inc-sc-limit-maxFiles" type="number" inputmode="numeric" data-inc="scope.limit.maxFiles" min="1" step="1" value="0" aria-invalid="true" aria-describedby="inc-sc-limit-maxFiles-e"',
    );
    expect(html).toContain(
      '<p class="err" role="alert">Corriger les éléments signalés avant de continuer.</p>',
    );
    expect(html).toContain('<b>1 problème(s) dans le périmètre</b>');
    expect(html).toContain('<code>applications[2].repository.root</code> introuvable');
    // ARO : la mémoire est imposée au conteneur du Job.
    expect(html).toContain('Imposée au conteneur du Job ARO.');
    const valid = renderScopeEditor(ctxOf(incident), emptyScopeUi(), trees, {
      validation: { ok: true, issues: [] },
    });
    expect(valid).toContain('role="status"');
  });

  it('tree states: denied, error with retry, empty; read-only roles, demonstration, locked states', () => {
    const incident = incidentOf();
    const states: ScopeTrees = {
      front: { state: 'denied' },
      bff: { state: { error: 'dépôt <absent>' } },
      api: { tree: { applicationId: 'api', root: node('') } },
    };
    const html = renderScopeEditor(ctxOf(incident), emptyScopeUi(), states);
    expect(html).toContain('Votre rôle ne permet pas de parcourir les dépôts.');
    expect(html).toContain('Lecture des dossiers impossible : dépôt &lt;absent&gt;');
    expect(html).toContain('data-action="inc-scope-tree-retry" data-block="bff"');
    expect(html).toContain('Aucun sous-dossier lisible.');

    const reader = renderScopeEditor(ctxOf(incident, { runner: false }), emptyScopeUi(), trees);
    expect(scopeEditable(ctxOf(incident, { runner: false }))).toBe(false);
    expect(reader).toContain('Lecture seule : votre rôle ne permet pas de modifier le périmètre.');
    expect(reader).toMatch(/data-action="inc-scope-toggle"[^>]*disabled/);
    expect(reader).not.toContain('data-action="inc-scope-remove"');
    expect(reader).not.toContain('data-action="inc-scope-next"');
    expect(reader).not.toContain('data-action="inc-validate"');
    expect(reader).toContain('data-action="ws-ux-stage" data-stage="environment"');
    expect(reader).toMatch(/data-inc="scope\.range"[^>]*disabled/);

    const demo = renderScopeEditor(ctxOf(incident, { demo: true }), emptyScopeUi(), trees);
    expect(demo.match(/Arborescence indisponible en démonstration\./g)).toHaveLength(3);
    expect(demo).not.toContain('data-action="inc-scope-next"');

    const running = renderScopeEditor(ctxOf(incidentOf({ state: 'REPRODUCING' })), emptyScopeUi(), trees);
    expect(running).toContain('Le périmètre ne change pas pendant une reproduction ni après une annulation.');
    expect(running).not.toContain('data-action="inc-scope-next"');

    const busy = renderScopeEditor(ctxOf(incident), emptyScopeUi(), trees, { busy: true });
    expect(busy).toMatch(
      /data-action="inc-scope-next" aria-describedby="inc-sc-next-h" aria-busy="true" disabled/,
    );

    const none = renderScopeEditor(
      ctxOf(incidentOf({ scope: scope({ applications: [] }) })),
      emptyScopeUi(),
      {},
    );
    expect(none).toContain('Aucune application dans le périmètre');
    expect(none).toContain('Éléments inclus (0)');
  });

  it('escapes names and paths; English texts; theme tokens only', () => {
    const incident = incidentOf({
      scope: scope({ applications: [app('front', 'FRONTEND', ['<b>x</b>'], { name: '<script>' })] }),
    });
    const html = renderScopeEditor(ctxOf(incident), emptyScopeUi(), {});
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('&lt;script&gt;');
    const en = renderScopeEditor(ctxOf(incidentOf(), { lang: 'en' }), emptyScopeUi(), trees);
    expect(en).toContain('Scope definition');
    expect(en).toContain('Guided mode');
    expect(en).toContain('aria-valuetext="3 of 5 — Standard"');
    expect(en).toContain('No effect in LOCAL');
    expect(INCIDENT_SCOPE_CSS).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(INCIDENT_SCOPE_CSS).not.toMatch(/rgba?\(/);
    expect(INCIDENT_SCOPE_CSS).toContain('.inc-sc-cb[aria-checked="mixed"] .inc-sc-box');
  });
});
