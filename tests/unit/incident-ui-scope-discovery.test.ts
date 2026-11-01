import { describe, expect, it } from 'vitest';
import type {
  DiscoveredApplication,
  Incident,
  InvestigationScope,
  ScopeDiscovery,
} from '../../src/sdk/core/incident-contracts.js';
import {
  advancedDetails,
  applyPlan,
  durationText,
  frameworkGlyph,
  principalApplication,
  discoveryEditable,
  emptyDiscoveryUi,
  INCIDENT_SCOPE_DISCOVERY_CSS,
  reduceDiscovery,
  renderScopeDiscovery,
  selectedApplications,
  withKnown,
  withResult,
  type DiscoveryUi,
} from '../../src/sdk/ui/incident-scope-discovery.js';
import type { ScopeContext } from '../../src/sdk/ui/incident-scope.js';

/**
 * LE BLOC « APPLICATIONS ET DÉPÔTS » : le chemin saisi et les dépôts connus, le résultat de la découverte
 * (applications cochées quand proposées, couche corrigeable, preuves, questions, relations, problèmes expliqués),
 * « Ajouter au périmètre » qui complète le périmètre (brouillon, défini) ou demande des extensions (investigation
 * commencée), les droits, la démonstration, l'échappement et le thème.
 */
const at = '2026-11-01T10:00:00.000Z';

const scope = (over: Partial<InvestigationScope> = {}): InvestigationScope => ({
  mode: 'GUIDED',
  applications: [
    { id: 'bff', name: 'BFF livres', layer: 'BFF', repository: { root: '/repos/bff', include: [] } },
  ],
  scenarios: [],
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
  id: 'inc_1',
  projectId: 'prj_books',
  title: 'Erreur à l’enregistrement d’un dossier',
  description: '',
  observed: 'HTTP 500',
  expected: 'dossier créé',
  severity: 'HIGH',
  execution: { target: 'LOCAL' },
  scope: scope(),
  state: 'DRAFT',
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

const app = (id: string, over: Partial<DiscoveredApplication> = {}): DiscoveredApplication => ({
  application: {
    id,
    name: id,
    layer: 'FRONTEND',
    repository: { root: `/repos/mono/apps/${id}`, include: [] },
    origin: {
      kind: 'DISCOVERED',
      at,
      analyzedRoot: '/repos/mono',
      evidence: [`apps/${id}/package.json : paquet Node`],
    },
  },
  path: `apps/${id}`,
  frameworks: ['Angular'],
  languages: ['TypeScript'],
  modules: [
    { path: 'src/app/dossiers', name: 'dossiers', matched: ['dossier'] },
    { path: 'src/app/profil', name: 'profil' },
  ],
  entryPoints: ['src/main.ts'],
  configs: ['apps/web/proxy.conf.json'],
  services: ['RxJS'],
  confidence: 'HIGH',
  evidence: [
    `apps/${id}/package.json : paquet Node`,
    'apps/web/package.json : dépendance Angular → frontend',
  ],
  questions: [],
  relevance: 0.5,
  reasons: ['mots de l’incident dans les modules : dossiers'],
  suggested: true,
  ...over,
});

const resultOf = (over: Partial<ScopeDiscovery> = {}): ScopeDiscovery => ({
  root: '/repos/mono',
  status: 'OK',
  structure: 'MONOREPO',
  tools: ['Nx', 'npm/yarn workspaces'],
  applications: [
    app('web'),
    app('api', {
      application: {
        id: 'api',
        name: 'api <Spring>',
        layer: 'BFF',
        repository: { root: '/repos/mono/apps/api', include: [] },
      },
      frameworks: ['NestJS'],
      confidence: 'MEDIUM',
      questions: ['Serveur Node : couche BFF proposée, Backend si ce serveur porte les données.'],
      reasons: ['dépendance de « web » (appelée, déduit)'],
      modules: [],
    }),
    app('tools', {
      suggested: false,
      relevance: 0,
      reasons: ['bibliothèque partagée : proposée seulement si une application proposée en dépend'],
      confidence: 'LOW',
    }),
    app('bff', { alreadyInScope: 'bff', suggested: false, reasons: ['déjà dans le périmètre (« bff »)'] }),
  ],
  relations: [
    {
      from: 'web',
      to: 'api',
      kind: 'CALLS',
      status: 'INFERRED',
      evidence: 'apps/web/proxy.conf.json : proxy de développement vers localhost:3000',
    },
  ],
  problems: [],
  denied: [],
  truncated: [],
  keywords: ['erreur', 'enregistrement', 'dossier'],
  read: ['package.json', 'nx.json', 'apps/web/package.json'],
  discoveredAt: at,
  durationMs: 1840,
  ...over,
});

describe('helpers', () => {
  it('duration, framework glyph (never a brand logo), main application', () => {
    expect(durationText(420, 'fr')).toBe('420 ms');
    expect(durationText(1840, 'fr')).toBe('1,8 s');
    expect(durationText(1840, 'en')).toBe('1.8 s');
    expect(frameworkGlyph(['Angular'], ['TypeScript'])).toEqual({ glyph: 'Ng', family: 'front' });
    expect(frameworkGlyph(['Spring Boot'], ['Java'])).toEqual({ glyph: 'Sp', family: 'java' });
    expect(frameworkGlyph([], ['Java'])).toEqual({ glyph: 'Jv', family: 'java' });
    expect(frameworkGlyph([], [])).toEqual({ glyph: '?', family: 'other' });
    expect(
      principalApplication(resultOf({ applications: [app('web', { relevance: 0, reasons: [] })] })),
    ).toBeUndefined();
  });
});

describe('state', () => {
  it('keeps the typed path, picks a known repository, checks the suggested applications, corrects a layer, clears', () => {
    let ui: DiscoveryUi = emptyDiscoveryUi('inc_1');
    ui = reduceDiscovery(ui, 'inc-disc-root', { value: ' /repos/mono ' }) ?? ui;
    expect(ui.root).toBe(' /repos/mono ');
    ui = reduceDiscovery(ui, 'inc-disc-known', { root: '/repos/front' }) ?? ui;
    expect(ui.root).toBe('/repos/front');
    ui = withKnown({ ...ui, knownState: 'loading' }, [
      { root: '/repos/front', label: 'Front', source: 'PROJECT' },
    ]);
    expect(ui.known).toHaveLength(1);
    expect(ui.knownState).toBeUndefined();
    ui = withResult(ui, resultOf());
    expect(ui.selected).toEqual({ web: true, api: true, tools: false, bff: false });
    // Décocher, cocher ; une application déjà dans le périmètre ne se coche pas ; une couche corrigée.
    ui = reduceDiscovery(ui, 'inc-disc-toggle', { block: 'web' }) ?? ui;
    expect(ui.selected.web).toBe(false);
    ui = reduceDiscovery(ui, 'inc-disc-toggle', { block: 'tools' }) ?? ui;
    expect(ui.selected.tools).toBe(true);
    ui = reduceDiscovery(ui, 'inc-disc-toggle', { block: 'bff' }) ?? ui;
    expect(ui.selected.bff).toBe(false);
    ui = reduceDiscovery(ui, 'inc-disc-layer', { block: 'api', value: 'BACKEND' }) ?? ui;
    ui = reduceDiscovery(ui, 'inc-disc-layer', { block: 'api', value: 'NOPE' }) ?? ui;
    expect(ui.layers).toEqual({ api: 'BACKEND' });
    expect(selectedApplications(ui).map((entry) => `${entry.id}:${entry.layer}`)).toEqual([
      'api:BACKEND',
      'tools:FRONTEND',
    ]);
    ui = reduceDiscovery(ui, 'inc-disc-advanced', { open: 'false' }) ?? ui;
    expect(ui.advanced).toBe(true);
    ui = reduceDiscovery(ui, 'inc-disc-clear', {}) ?? ui;
    expect(ui.result).toBeUndefined();
    expect(ui.selected).toEqual({});
    expect(ui.root).toBe('/repos/front');
    expect(reduceDiscovery(ui, 'inc-scope-mode', {})).toBeUndefined();
  });

  it('plans a direct scope update in DRAFT and SCOPED (unique ids, permissions kept), extensions once the investigation started', () => {
    const ui = withResult(
      emptyDiscoveryUi('inc_1'),
      resultOf({
        applications: [
          app('web'),
          app('bff', { alreadyInScope: 'bff', suggested: false }),
          app('api', {
            application: {
              id: 'bff',
              name: 'autre bff',
              layer: 'BFF',
              repository: { root: '/repos/mono/apps/api', include: [] },
            },
          }),
        ],
      }),
    );
    const draft = applyPlan(incidentOf(), ui);
    expect(draft.kind).toBe('UPDATE');
    if (draft.kind !== 'UPDATE') throw new Error('plan');
    expect(draft.scope.applications.map((entry) => entry.id)).toEqual(['bff', 'web', 'bff-2']);
    expect(draft.scope.permissions).toEqual(scope().permissions);
    expect(draft.added[0]?.origin?.kind).toBe('DISCOVERED');
    expect(applyPlan(incidentOf({ state: 'SCOPED' }), ui).kind).toBe('UPDATE');
    const started = applyPlan(incidentOf({ state: 'INVESTIGATING' }), ui);
    expect(started.kind).toBe('EXTENSIONS');
    if (started.kind !== 'EXTENSIONS') throw new Error('plan');
    expect(started.requests).toEqual([
      {
        kind: 'ADD_APPLICATION',
        target: 'FRONTEND:/repos/mono/apps/web',
        applicationId: 'web',
        reason: 'Découverte automatique de « /repos/mono » : apps/web/package.json : paquet Node',
      },
      {
        kind: 'ADD_APPLICATION',
        target: 'BFF:/repos/mono/apps/api',
        applicationId: 'bff-2',
        reason: 'Découverte automatique de « /repos/mono » : autre bff',
      },
    ]);
    expect(applyPlan(incidentOf(), emptyDiscoveryUi('inc_1')).kind).toBe('NONE');
  });
});

describe('renderScopeDiscovery', () => {
  it('the path field, the analyze button, the known repositories and the hint', () => {
    const ui = withKnown(emptyDiscoveryUi('inc_1'), [
      { root: '/srv/front', label: 'Catalogue (sources du projet)', source: 'PROJECT' },
      { root: '/repos/bff', label: 'BFF livres', source: 'SCOPE' },
    ]);
    const html = renderScopeDiscovery(ctxOf(), { ...ui, root: '/srv/front' });
    expect(html).toContain('<h2 id="inc-sd-t" class="fl">');
    // Sans résultat : les trois indicateurs attendent ; pendant l'analyse : en cours ; en échec : non réalisée.
    expect(html).toContain('<li class="inc-sd-ind inc-sd-ind-idle">');
    expect(html).toContain('<small>En attente d’un chemin</small>');
    expect(html).not.toContain('inc-sd-done');
    expect(renderScopeDiscovery(ctxOf(), ui, { busy: 'inc-disc-run' })).toContain(
      '<li class="inc-sd-ind inc-sd-ind-running">',
    );
    expect(html).toContain('<span class="inc-sd-root-w">');
    expect(html).toContain('Applications et dépôts');
    expect(html).toContain('<form class="inc-sd-form" data-action="inc-disc-run" novalidate>');
    expect(html).toContain('<input id="inc-sd-root" data-inc="disc.root" class="mono" value="/srv/front"');
    expect(html).toContain('placeholder="/srv/repos/catalogue"');
    expect(html).toContain(
      '<button type="submit" class="btn primary" data-action="inc-disc-run" aria-busy="false">',
    );
    expect(html).toContain('Analyser automatiquement');
    expect(html).toContain('Chemin absolu sur la machine qui investigue');
    expect(html).toContain('data-action="inc-disc-known" data-root="/srv/front"');
    expect(html).toContain('aria-label="Analyser Catalogue (sources du projet) (/srv/front)"');
    expect(html).toContain('<small class="mu">projet</small>');
    expect(html).toContain('<small class="mu">périmètre</small>');
    // Pendant l'analyse : bouton occupé, champ désactivé.
    const running = renderScopeDiscovery(ctxOf(), ui, { busy: 'inc-disc-run' });
    expect(running).toContain('aria-busy="true"');
    expect(running).toContain('Analyse en cours…');
    expect(running).toMatch(/data-inc="disc\.root"[^>]* disabled>/);
    // Lecture des dépôts connus, refus, aucun.
    expect(renderScopeDiscovery(ctxOf(), { ...emptyDiscoveryUi('inc_1'), knownState: 'loading' })).toContain(
      'Lecture des dépôts connus…',
    );
    expect(renderScopeDiscovery(ctxOf(), { ...emptyDiscoveryUi('inc_1'), knownState: 'denied' })).toContain(
      'Votre rôle ne permet pas de parcourir les dépôts.',
    );
    expect(renderScopeDiscovery(ctxOf(), withKnown(emptyDiscoveryUi('inc_1'), []))).toContain(
      'Aucun dépôt connu pour l’instant',
    );
  });

  it('the result: summary, cards checked when suggested, layer select, pills, reasons, questions, details, relations, apply', () => {
    const ui = withResult(emptyDiscoveryUi('inc_1'), resultOf());
    const html = renderScopeDiscovery(ctxOf(), ui);
    expect(html).toContain('Monorepo');
    // Le bandeau de présentation reflète le résultat réel ; le résumé donne les comptes et la durée mesurée.
    expect(html).toContain('<h2 id="inc-sd-hero-t">Périmètre d’investigation</h2>');
    expect(html).toContain('<li class="inc-sd-ind inc-sd-ind-done">');
    expect(html).toContain('<b>Détection des applications</b><small>4 détectée(s)</small>');
    expect(html).toContain('<b>Analyse des modules</b><small>6 module(s)</small>');
    expect(html).toContain('<b>Cartographie des dépendances</b><small>1 relation(s)</small>');
    expect(html).toContain('<p class="inc-sd-done" role="status">');
    expect(html).toContain(
      '<b>Analyse terminée</b><span>4 application(s)</span><span>6 module(s)</span><span>3 fichier(s) lu(s)</span><span>en 1,8 s</span>',
    );
    // L'application principale : la proposée la plus pertinente, désignée par un mot de l'incident.
    expect(principalApplication(resultOf())).toBe('web');
    expect(html).toContain('<span class="inc-sd-pill main">Application principale</span>');
    expect(html.split('Application principale')).toHaveLength(2);
    expect(html).toContain(
      '<span class="inc-sd-fw inc-sd-fw-front" role="img" aria-label="Cadre : Angular" title="Angular">Ng</span>',
    );
    expect(html).toContain(
      '<span class="inc-sd-fw inc-sd-fw-node" role="img" aria-label="Cadre : NestJS" title="NestJS">Ns</span>',
    );
    expect(html).toContain('4 application(s) détectée(s), 2 proposée(s) pour cet incident');
    expect(html).toContain('Outils : Nx, npm/yarn workspaces');
    expect(html).toContain('Mots de l’incident retenus : erreur, enregistrement, dossier');
    expect(html).toContain('<li class="inc-sd-app on" data-app="web">');
    expect(html).toMatch(/data-inc="disc\.app\.web" data-block="web" checked>/);
    expect(html).toMatch(/data-inc="disc\.app\.tools" data-block="tools">/);
    expect(html).toContain('<li class="inc-sd-app on known" data-app="bff">');
    expect(html).toMatch(/data-inc="disc\.app\.bff" data-block="bff" checked disabled>/);
    expect(html).toContain('déjà dans le périmètre (bff)');
    expect(html).toContain('<select data-inc="disc.layer.api" class="inc-sd-l-bff">');
    expect(html).toContain('<option value="BFF" selected>BFF</option>');
    expect(html).toContain('<span class="sr">Couche de api &lt;Spring&gt;</span>');
    expect(html).toContain('<b>api &lt;Spring&gt;</b>');
    expect(html).toContain('<span class="inc-sd-pill fw">Angular</span>');
    expect(html).toContain('<span class="inc-sd-pill conf-high">détection sûre</span>');
    expect(html).toContain('<span class="inc-sd-pill conf-medium">détection probable</span>');
    expect(html).toContain('<span class="inc-sd-pill conf-low">détection incertaine</span>');
    expect(html).toContain('mots de l’incident dans les modules : dossiers');
    expect(html).toContain('Serveur Node : couche BFF proposée');
    expect(html).toContain(
      '<li class="hit"><code title="src/app/dossiers">dossiers/</code><small>touche : dossier</small></li>',
    );
    expect(html).toContain('<dt>Points d’entrée</dt><dd><code>src/main.ts</code></dd>');
    expect(html).toContain('<dt>Services et dépendances</dt>');
    expect(html).toContain('apps/web/package.json : dépendance Angular → frontend');
    expect(html).toContain('Relations entre applications (1)');
    expect(html).toContain('<b>web</b> <span class="mu">appelle</span> <b>api &lt;Spring&gt;</b>');
    expect(html).toContain('Fichiers lus (3)');
    expect(html).toContain('data-action="inc-disc-apply"');
    expect(html).toContain('Ajouter 2 application(s) au périmètre');
    expect(html).toContain('Le périmètre initial n’est pas une limite');
    expect(html).toContain('data-action="inc-disc-clear"');
    // Investigation commencée : des extensions à décider.
    const started = renderScopeDiscovery(ctxOf(incidentOf({ state: 'INVESTIGATING' })), ui);
    expect(started).toContain('Demander l’extension du périmètre (2)');
    expect(started).toContain('L’investigation a commencé');
    // Rien de coché : bouton désactivé et expliqué.
    const none = renderScopeDiscovery(ctxOf(), { ...ui, selected: {} });
    expect(none).toMatch(/data-action="inc-disc-apply"[^>]* disabled/);
    expect(none).toContain('Cochez au moins une application.');
  });

  it('problems are explained with their correction; a failed analysis is an alert without applications', () => {
    const failed = resultOf({
      status: 'FAILED',
      structure: 'UNKNOWN',
      applications: [],
      relations: [],
      problems: [
        { code: 'ROOT_MISSING', message: 'Chemin introuvable : « /nowhere ».', hint: 'Vérifiez le chemin.' },
      ],
    });
    const html = renderScopeDiscovery(ctxOf(), withResult(emptyDiscoveryUi('inc_1'), failed));
    expect(html).toContain('<div class="inc-sd-problems" role="alert">');
    expect(html).toContain('<b>Analyse impossible</b>');
    expect(html).toContain('<li class="inc-sd-ind inc-sd-ind-failed">');
    expect(html).toContain('<small>Non réalisée</small>');
    expect(html).not.toContain('inc-sd-done');
    expect(html).toContain('<b>Chemin introuvable : « /nowhere ».</b> Vérifiez le chemin.');
    expect(html).not.toContain('data-action="inc-disc-apply"');
    const partial = resultOf({
      status: 'PARTIAL',
      problems: [{ code: 'PARTIAL', message: 'Lecture partielle.', hint: 'Analysez un sous-dossier.' }],
      denied: [{ path: '/repos/mono/.env', reason: 'path.sensitive : Fichier sensible refusé' }],
      truncated: ['limite atteinte'],
    });
    const partialHtml = renderScopeDiscovery(ctxOf(), withResult(emptyDiscoveryUi('inc_1'), partial));
    expect(partialHtml).toContain('<div class="inc-sd-problems" role="status">');
    expect(partialHtml).toContain('<b>Analyse partielle</b>');
    expect(partialHtml).toContain('<p class="inc-sd-done partial" role="status">');
    expect(partialHtml).toContain('Refus de lecture (1)');
    expect(partialHtml).toContain('<code>/repos/mono/.env</code>');
    expect(partialHtml).toContain('Lecture partielle</summary>');
  });

  it('rights, demonstration, locked states, English, escaping, advanced section, theme tokens only', () => {
    const ui = withResult(
      withKnown(emptyDiscoveryUi('inc_1'), [{ root: '/x', label: 'X', source: 'SCOPE' }]),
      resultOf(),
    );
    const reader = renderScopeDiscovery(ctxOf(incidentOf(), { runner: false }), ui);
    expect(reader).toContain('Lecture seule : votre rôle ne permet pas d’analyser un dépôt.');
    expect(reader).not.toContain('data-action="inc-disc-run"');
    expect(reader).not.toContain('data-action="inc-disc-apply"');
    expect(reader).toMatch(/data-inc="disc\.app\.web" data-block="web" checked disabled>/);
    expect(discoveryEditable(ctxOf(incidentOf(), { runner: false }))).toBe(false);
    const demo = renderScopeDiscovery(ctxOf(incidentOf(), { demo: true }), ui);
    expect(demo).toContain('Découverte indisponible en démonstration.');
    expect(demo).not.toContain('data-action="inc-disc-run"');
    const locked = renderScopeDiscovery(ctxOf(incidentOf({ state: 'REPRODUCING' })), ui);
    expect(locked).toContain('Le périmètre ne change pas pendant une reproduction');
    expect(discoveryEditable(ctxOf(incidentOf({ state: 'CANCELLED' })))).toBe(false);
    const english = renderScopeDiscovery(ctxOf(incidentOf(), { lang: 'en' }), ui);
    expect(english).toContain('Applications and repositories');
    expect(english).toContain('Analyze automatically');
    expect(english).toContain('4 application(s) detected, 2 suggested for this incident');
    expect(english).toContain('Add 2 application(s) to the scope');
    // Échappement : noms, chemins et racines viennent du serveur.
    const hostile = withResult(
      emptyDiscoveryUi('inc_1'),
      resultOf({
        applications: [
          app('web', {
            application: {
              id: 'web',
              name: '<b>x</b>',
              layer: 'FRONTEND',
              repository: { root: '/repos/"q"', include: [] },
            },
            path: '<p>',
          }),
        ],
      }),
    );
    const escaped = renderScopeDiscovery(ctxOf(), { ...hostile, root: '"><script>' });
    expect(escaped).not.toContain('<b>x</b>');
    expect(escaped).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(escaped).toContain('value="&quot;&gt;&lt;script&gt;"');
    expect(escaped).toContain('title="/repos/&quot;q&quot;"');
    expect(escaped).toContain('&lt;p&gt;/');
    // La section avancée : repliée, dépliée.
    expect(advancedDetails('fr', false, '<p>x</p>')).toBe(
      '<details class="inc-sd-adv"><summary data-action="inc-disc-advanced" data-open="false">Paramètres avancés (saisie manuelle)</summary><p>x</p></details>',
    );
    expect(advancedDetails('en', true, '')).toContain(
      '<details class="inc-sd-adv" open><summary data-action="inc-disc-advanced" data-open="true">Advanced settings (manual entry)</summary>',
    );
    // Thème : aucune couleur en dur.
    expect(INCIDENT_SCOPE_DISCOVERY_CSS).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(INCIDENT_SCOPE_DISCOVERY_CSS).not.toMatch(/\brgb\(/);
    expect(INCIDENT_SCOPE_DISCOVERY_CSS).toContain('var(--qa-color-primary)');
  });
});
