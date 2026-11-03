import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Incident } from '../../src/incident/model.js';
import { DEFAULT_PERMISSIONS } from '../../src/incident/scope.js';
import {
  createQaCrawler,
  QaCrawlerError,
  type Project,
  type QaCrawlerClient,
} from '../../src/sdk/core/index.js';
import { engineDefaults } from '../../src/sdk/server/project.js';
import { startSdkServer, type RunningSdkServer } from '../../src/sdk/server/server.js';
import { startAngularSite, type AngularSite } from '../fixtures/angular-site.js';

/**
 * L'INVESTIGATION AUTONOME À PARTIR D'UN ÉCRAN CIBLE, de bout en bout sur l'application Angular exécutable
 * (Chromium, serveur SDK réel, aucune IA) : l'utilisateur ne donne que l'écran (« création d'un nouveau
 * dossier ») et le symptôme. QA-CRAWLER localise l'écran dans le code (route, lien entrant, titre), trouve le
 * parcours (liste des dossiers puis lien « Nouveau dossier »), l'atteint dans un vrai navigateur, inventorie
 * ses contrôles, puis lance le moteur des déclencheurs depuis cet écran : la séquence minimale est retrouvée
 * et répétée, et le parcours imposé est rejoué avant chaque essai.
 */
const APP_ROOT = path.resolve('tests/fixtures/angular-app');
const SYMPTOM =
  'Après une erreur JavaScript, le bouton Enregistrer ne fait plus rien : aucune validation, aucun chargement, aucune requête. Les données saisies sont perdues après un rechargement.';
const ACTIVE = new Set([
  'INITIALIZING',
  'DISCOVERING_SCOPE',
  'EXPLORING_TRIGGERS',
  'FAILURE_DETECTED',
  'CONFIRMING_REPRODUCTION',
  'MINIMIZING',
  'ANALYZING_ROOT_CAUSE',
  'VERIFYING_HYPOTHESES',
  'PAUSED',
]);

let site: AngularSite;
let server: RunningSdkServer;
let workspace: string;
let client: QaCrawlerClient;
let project: Project;
let environmentId: string;

const create = (title: string, navigate = true): Promise<Incident> =>
  client.incidents.create(project.id, {
    title,
    description: 'd',
    observed: 'o',
    expected: 'e',
    severity: 'HIGH',
    environmentId,
    scope: {
      applications: [
        {
          id: 'web',
          name: 'Dossiers (web)',
          layer: 'FRONTEND',
          repository: { root: APP_ROOT, include: ['src'] },
        },
      ],
      allowedHosts: [new URL(site.url).host],
      permissions: { ...DEFAULT_PERMISSIONS, navigate },
    },
  });

const refusal = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return 'accepted';
  } catch (error) {
    return error instanceof QaCrawlerError ? `${String(error.status)} ${error.message}` : String(error);
  }
};

beforeAll(async () => {
  site = await startAngularSite();
  workspace = await mkdtemp(path.join(tmpdir(), 'incident-target-'));
  server = await startSdkServer({ workspace, language: 'fr', env: {} });
  client = createQaCrawler({ endpoint: `${server.url}/api`, token: server.token });
  project = await client.projects.create({
    ...engineDefaults(),
    project: { name: 'Dossiers', targetUrl: site.url, framework: 'other' },
  });
  environmentId = (
    await client.environments.create(project.id, {
      name: 'Recette',
      kind: 'TEST',
      baseUrl: site.url,
      mutations: { enabled: true, maxPerRun: 50 },
    })
  ).id;
}, 120_000);

afterAll(async () => {
  client.dispose();
  await server.close();
  await site.close();
  await rm(workspace, { recursive: true, force: true });
});

describe('investigation autonome à partir d’un écran cible', () => {
  it('localise l’écran, l’atteint dans le navigateur, explore depuis lui jusqu’à la séquence minimale', async () => {
    const incident = await create('Plus rien ne répond après Enregistrer');
    // Rien n'est lancé sans écran cible ni URL.
    expect(await refusal(client.incidents.locateAccessTarget(project.id, incident.id))).toMatch(/^422/);
    expect(await refusal(client.incidents.prepareAccessTarget(project.id, incident.id))).toMatch(/^422/);

    await client.incidents.saveAccess(project.id, incident.id, {
      mode: 'AUTO',
      target: 'création d’un nouveau dossier',
      narrative: SYMPTOM,
    });
    const located = (await client.incidents.locateAccessTarget(project.id, incident.id)).access?.location;
    expect(located?.chosen).toBe('/dossiers/nouveau');
    const best = located?.candidates[0];
    expect(best?.component).toBe('DossierComponent');
    expect(best?.nameOnly).toBe(false);
    expect(best?.evidence.join(' ')).toMatch(/lien « Nouveau dossier »/);
    expect(located?.candidates.map((candidate) => candidate.route)).toContain('/dossiers');
    expect(located?.path.map((step) => `${step.kind} ${step.target}`)).toEqual([
      'NAVIGATE /dossiers',
      'CLICK link:Nouveau dossier',
    ]);
    // L'exploration exige un écran réellement atteint.
    expect(await refusal(client.incidents.exploreAccessTarget(project.id, incident.id))).toMatch(
      /^422 .*not reached|prepare/,
    );

    const prepared = (await client.incidents.prepareAccessTarget(project.id, incident.id)).access
      ?.preparation;
    expect(prepared?.blockers).toEqual([]);
    expect(prepared?.reached).toBe(true);
    expect(prepared?.finalUrl).toMatch(/\/dossiers\/nouveau$/);
    expect(prepared?.steps.every((step) => step.ok)).toBe(true);
    expect(prepared?.inventory.buttons).toEqual(expect.arrayContaining(['Enregistrer', 'Notes']));
    expect(prepared?.inventory.fields).toEqual(expect.arrayContaining(['Code']));
    expect(prepared?.screenshot).toMatch(/^prepare-\d+\.png$/);
    // La capture est gardée sous le projet, dans le dossier de l'incident.
    const files = (await readdir(workspace, { recursive: true })).map(String);
    expect(
      files.some((file) => file.endsWith(path.join(incident.id, 'target', prepared?.screenshot ?? '?'))),
    ).toBe(true);

    const started = await client.incidents.exploreAccessTarget(project.id, incident.id, 'QUICK');
    const runId = started.access?.exploration?.runId;
    expect(runId).toBeDefined();
    const begin = Date.now();
    let finished: Incident;
    for (;;) {
      finished = await client.incidents.get(project.id, incident.id);
      const current = finished.investigation.trigger?.runs.find((run) => run.id === runId);
      if (current && !ACTIVE.has(current.state)) break;
      if (Date.now() - begin > 240_000) throw new Error('délai dépassé');
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const run = finished.investigation.trigger?.runs.find((item) => item.id === runId);
    expect(run?.entry?.source).toBe('TARGET');
    expect(run?.entry?.actions.map((action) => action.kind)).toEqual(['NAVIGATE', 'CLICK']);
    expect(run?.limitations.join(' ')).toMatch(/point d['’]entrée imposé/);
    expect(run?.minimal).toBeDefined();
    const factors = new Set(
      run?.minimal?.actions
        .map((action) => action.origin)
        .filter((origin) => origin && !['probe', 'reference', 'target'].includes(origin)),
    );
    expect([...factors].sort()).toEqual(['data:empty:label:Code', 'state:dialog:button:Notes']);
    // La reproduction a été répétée (profondeur rapide : 2 fois) avant la réduction.
    expect(
      run?.trials.some(
        (trial) => trial.repeats !== undefined && trial.repeats.total >= 2 && trial.repeats.reproduced >= 2,
      ),
    ).toBe(true);
    // Jamais une cause confirmée par le moteur seul.
    expect(finished.investigation.diagnosis?.status ?? 'INCONCLUSIVE').not.toBe('CONFIRMED');
  }, 300_000);

  it('ne navigue pas quand le périmètre interdit la navigation ; un parcours guidé introuvable est dit', async () => {
    const closed = await create('Navigation interdite', false);
    await client.incidents.saveAccess(project.id, closed.id, { target: 'liste des dossiers' });
    const located = (await client.incidents.locateAccessTarget(project.id, closed.id)).access?.location;
    expect(located?.chosen).toBe('/dossiers');
    const loads = site.pageLoads;
    expect(await refusal(client.incidents.prepareAccessTarget(project.id, closed.id))).toMatch(
      /navigation is not allowed/,
    );
    expect(site.pageLoads).toBe(loads);

    const guided = await create('Parcours guidé');
    await client.incidents.saveAccess(project.id, guided.id, {
      mode: 'GUIDED',
      target: 'nouveau dossier',
      steps: [{ id: 's1', text: 'Ouvrir le menu Archives' }],
    });
    const path2 = (await client.incidents.locateAccessTarget(project.id, guided.id)).access?.location;
    // L'étape guidée ne correspond à aucun lien : la limite est dite, le parcours déduit du code est gardé.
    expect(path2?.limits.join(' ')).toMatch(/Archives/);
    expect(path2?.path.at(-1)?.target).toBe('link:Nouveau dossier');
  }, 120_000);
});
