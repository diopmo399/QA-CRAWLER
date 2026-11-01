import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { analyzeAngular, routesOf } from '../../src/incident/code/angular.js';
import { guardedFiles } from '../../src/incident/guarded-fs.js';
import type { Incident, PolicyOperation } from '../../src/incident/model.js';
import { ScopePolicy } from '../../src/incident/scope-policy.js';
import { defaultScope } from '../../src/incident/scope.js';
import { interpretBrief } from '../../src/incident/trigger/brief.js';
import { discoverScope } from '../../src/incident/trigger/discovery.js';
import type { AngularModel } from '../../src/sdk/core/incident-trigger-contracts.js';

/**
 * L'ANALYSE STATIQUE ANGULAR ET LA DÉCOUVERTE DU PÉRIMÈTRE sur l'application fictive tests/fixtures/angular-app :
 * composants standalone, routes déclarées hors des composants, formulaire réactif (contrôle requis), liaisons
 * d'événements → gestionnaires → services → HttpClient → API, intercepteur, ErrorHandler, Subject. Le périmètre
 * découvert porte des statuts venant du Scope Policy Engine : découvrir n'accorde rien.
 */
const APP_ROOT = path.resolve('tests/fixtures/angular-app');
const scope = defaultScope({
  applications: [
    {
      id: 'web',
      name: 'Dossiers (web)',
      layer: 'FRONTEND',
      repository: { root: APP_ROOT, include: ['src'] },
    },
  ],
  allowedHosts: ['dossiers.test'],
});
let model: AngularModel;

beforeAll(async () => {
  model = await analyzeAngular(scope.applications[0] as never, guardedFiles(new ScopePolicy(scope)));
});

const named = (kind: AngularModel['nodes'][number]['kind'], name: string) =>
  model.nodes.find((node) => node.kind === kind && node.name === name);

describe('Angular static analysis', () => {
  it('detects the application features without presuming anything about the defect', () => {
    expect(model.features).toMatchObject({
      standalone: true,
      reactiveForms: true,
      interceptors: true,
      customErrorHandler: true,
      zoneJs: true,
    });
    expect(model.features.zoneless).not.toBe(true);
    expect(model.denied).toEqual([]);
    expect(model.files).toBeGreaterThanOrEqual(10);
  });

  it('links routes (declared in app.routes.ts) to their components', () => {
    const routes = routesOf(model);
    expect(routes.map((route) => route.path).sort()).toEqual(['dossiers', 'dossiers/nouveau']);
    expect(routes.find((route) => route.path === 'dossiers/nouveau')?.componentId).toBe(
      named('COMPONENT', 'DossierComponent')?.id,
    );
  });

  it('reads the reactive form: controls with the required flag, validators', () => {
    expect(named('CONTROL', 'code')?.detail).toMatchObject({ required: true });
    expect(named('CONTROL', 'titre')?.detail).toMatchObject({ required: false });
    expect(model.nodes.some((node) => node.kind === 'VALIDATOR' && /required/.test(node.name))).toBe(true);
  });

  it('follows Template → Component → Handler → Service → HttpClient → API with provenance', () => {
    const submit = model.nodes.find((node) => node.kind === 'BINDING' && node.detail?.event === 'ngSubmit');
    const handler = named('HANDLER', 'DossierComponent.enregistrer');
    expect(submit && handler).toBeTruthy();
    expect(
      model.links.some(
        (link) =>
          link.kind === 'HANDLES' &&
          link.from === submit?.id &&
          link.to === handler?.id &&
          link.status === 'STATICALLY_RESOLVED',
      ),
    ).toBe(true);
    const calls = model.links
      .filter((link) => link.kind === 'CALLS' && link.from === handler?.id)
      .map((link) => model.nodes.find((node) => node.id === link.to)?.name);
    expect(calls).toEqual(
      expect.arrayContaining([
        'BusyService.lock',
        'NotesService.dernierBrouillon',
        'DossierApiService.creer',
      ]),
    );
    const creer = named('HANDLER', 'DossierApiService.creer');
    const http = model.links.find((link) => link.kind === 'CALLS' && link.from === creer?.id);
    expect(model.nodes.find((node) => node.id === http?.to)?.name).toBe('POST /api/dossiers');
    expect(model.nodes.some((node) => node.kind === 'API' && node.name === 'POST /api/dossiers')).toBe(true);
    expect(model.nodes.some((node) => node.kind === 'INTERCEPTOR')).toBe(true);
    expect(model.nodes.some((node) => node.kind === 'ERROR_HANDLER')).toBe(true);
    expect(model.nodes.some((node) => node.kind === 'STREAM' && node.name === 'NotesService.ouvert$')).toBe(
      true,
    );
    // Le texte des boutons liés : ce que la page montre, pour relier le code aux sondes.
    expect(model.nodes.filter((node) => node.kind === 'BINDING').map((node) => node.detail?.text)).toEqual(
      expect.arrayContaining(['Actualiser', 'Notes', 'Aide', 'Fermer']),
    );
  });
});

describe('scope discovery', () => {
  const incident = (): Incident => ({
    id: 'inc_1',
    projectId: 'p',
    title: 'Enregistrer ne réagit plus',
    description: 'd',
    observed: 'o',
    expected: 'e',
    severity: 'HIGH',
    execution: { target: 'LOCAL' },
    scope,
    state: 'INVESTIGATING',
    revision: 1,
    createdAt: '2026-10-31T10:00:00.000Z',
    updatedAt: '2026-10-31T10:00:00.000Z',
    createdBy: 'a',
    history: [],
    investigation: { reproductions: [], hypotheses: [], experiments: [] },
  });
  const brief = interpretBrief(
    'Dans la création de dossier, le bouton Enregistrer ne fait plus rien après une erreur JS.',
  );

  it('discovers routes, components, services, APIs and the repository, each with a status from the policy', async () => {
    const policy = new ScopePolicy(scope);
    const graph = await discoverScope({
      incident: incident(),
      brief,
      angular: [model],
      scenarios: [
        {
          name: 'Créer un dossier',
          file: 'dossiers/creer.flow.yaml',
          text: 'flows:\n  - name: Créer un dossier\n    steps:\n      - click: { role: button, name: Enregistrer }\n',
        },
      ],
      check: (operation) => policy.check(operation),
      baseUrl: 'http://dossiers.test',
    });
    const kinds = new Set(graph.resources.map((resource) => resource.kind));
    expect([...kinds]).toEqual(
      expect.arrayContaining(['REPOSITORY', 'ROUTE', 'COMPONENT', 'SERVICE', 'API', 'SCENARIO']),
    );
    const route = graph.resources.find(
      (resource) => resource.kind === 'ROUTE' && resource.ref === '/dossiers/nouveau',
    );
    expect(route?.status).toBe('AUTHORIZED');
    expect(route?.foundBy).toContain('STATIC');
    expect(
      graph.resources.find((resource) => resource.kind === 'API' && resource.ref === 'POST /api/dossiers'),
    ).toBeDefined();
    expect(graph.resources.find((resource) => resource.kind === 'SCENARIO')?.status).toBe('AUTHORIZED');
    expect(graph.edges.some((edge) => edge.kind === 'ROUTES_TO')).toBe(true);
    expect(graph.resources.every((resource) => resource.relevance >= 0 && resource.relevance <= 1)).toBe(
      true,
    );
  });

  it('marks what the policy denies as DENIED, with the reason, and never upgrades it', async () => {
    const deny = (operation: PolicyOperation) =>
      Promise.resolve({ allowed: false, reason: 'hors périmètre (test)', rule: 'test', operation });
    const graph = await discoverScope({
      incident: incident(),
      brief,
      angular: [model],
      check: deny,
      baseUrl: 'http://dossiers.test',
    });
    const routes = graph.resources.filter((resource) => resource.kind === 'ROUTE');
    expect(routes.length).toBeGreaterThan(0);
    expect(
      routes.every((resource) => resource.status === 'DENIED' && resource.detail === 'hors périmètre (test)'),
    ).toBe(true);
    expect(graph.resources.find((resource) => resource.kind === 'REPOSITORY')?.status).toBe('DENIED');
  });
});
