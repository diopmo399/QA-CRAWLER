import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Incident } from '../../src/incident/model.js';
import type { TriggerRunReport } from '../../src/sdk/core/incident-trigger-contracts.js';
import { createQaCrawler, type Project, type QaCrawlerClient } from '../../src/sdk/core/index.js';
import { engineDefaults } from '../../src/sdk/server/project.js';
import { startSdkServer, type RunningSdkServer } from '../../src/sdk/server/server.js';
import { startAngularSite, type AngularSite } from '../fixtures/angular-site.js';

/**
 * LA DÉCOUVERTE DES DÉCLENCHEURS PAR LE SERVEUR, LE CLIENT ET LE DASHBOARD (Chromium), sans aucune IA :
 * la description interprétée (provenance), le lancement (202, run actif relu par `GET`), la fin (déclencheur
 * reproduit, hypothèses PROPOSED, vérifications en attente, test proposé, captures sous le projet), le rapport,
 * les décisions (DECIDE : approuver un rejouage, refuser ; un lecteur est refusé), la prolongation du budget,
 * puis l'onglet « Déclencheurs » de l'espace d'investigation avec ses captures.
 */
const APP_ROOT = path.resolve('tests/fixtures/angular-app');
const SHOTS = process.env.TRG_SHOTS_DIR;
const DESCRIPTION =
  'Dans la création de dossier, après une erreur JavaScript survenue dans des circonstances inconnues, le bouton Enregistrer ne fait plus rien : aucune validation, aucun chargement, aucune requête HTTP. Un rafraîchissement (F5) remet tout en état mais la saisie est perdue.';

let site: AngularSite;
let server: RunningSdkServer;
let workspace: string;
let client: QaCrawlerClient;
let project: Project;
let incidentId: string;
let readerToken: string;

async function api<T>(
  method: 'GET' | 'POST',
  route: string,
  body?: unknown,
  token = server.token,
): Promise<T> {
  const response = await fetch(`${server.url}/api/projects/${project.id}/incidents${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${route} → ${String(response.status)} ${text}`);
  return JSON.parse(text) as T;
}

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

async function until(
  done: (incident: Incident) => boolean,
  timeoutMs = 240_000,
  id: string = incidentId,
): Promise<Incident> {
  const started = Date.now();
  for (;;) {
    const incident = await api<Incident>('GET', `/${id}`);
    if (done(incident)) return incident;
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for the trigger run');
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });
}

beforeAll(async () => {
  site = await startAngularSite();
  workspace = await mkdtemp(path.join(tmpdir(), 'trigger-ws-'));
  server = await startSdkServer({ workspace, language: 'fr', access: 'named', env: {} });
  client = createQaCrawler({ endpoint: `${server.url}/api`, token: server.token });
  readerToken = (await client.access.createMember({ name: 'Noa L.', role: 'READER' })).token;
  project = await client.projects.create({
    ...engineDefaults(),
    project: { name: 'Dossiers', targetUrl: `${site.url}/dossiers/nouveau`, framework: 'other' },
  });
  const environment = await client.environments.create(project.id, {
    name: 'Recette',
    kind: 'TEST',
    baseUrl: site.url,
    mutations: { enabled: true, maxPerRun: 50 },
  });
  const created = await client.incidents.create(project.id, {
    title: 'Enregistrer ne réagit plus après une erreur JS',
    description: DESCRIPTION,
    observed: 'Les boutons ne déclenchent plus rien, la page reste affichée.',
    expected: 'Le dossier est créé.',
    severity: 'HIGH',
    application: 'Dossiers',
    environmentId: environment.id,
    scope: {
      applications: [
        {
          id: 'dossiers-web',
          name: 'Dossiers (web)',
          layer: 'FRONTEND',
          repository: { root: APP_ROOT, include: ['src'] },
        },
      ],
      allowedHosts: [new URL(site.url).host],
    },
  });
  incidentId = created.id;
}, 120_000);

afterAll(async () => {
  client.dispose();
  await server.close();
  await site.close();
  await rm(workspace, { recursive: true, force: true });
});

describe('trigger discovery — server, client and Dashboard, deterministic mode', () => {
  it('interprets the description, runs the discovery to the end, writes hypotheses, verifications, a proposed test and screenshots', async () => {
    const described = await client.incidents.trigger.describe(project.id, incidentId, DESCRIPTION);
    const brief = described.investigation.trigger?.brief;
    expect(brief?.language).toBe('fr');
    expect(brief?.symptoms.every((item) => item.source === 'USER_REPORTED')).toBe(true);
    expect(described.history.some((event) => event.kind === 'TRIGGER')).toBe(true);

    const started = await client.incidents.trigger.start(project.id, incidentId, {
      depth: 'STANDARD',
      budget: { maxTrials: 40 },
    });
    const run0 = started.investigation.trigger?.runs.at(-1);
    expect(run0 && ACTIVE.has(run0.state)).toBe(true);
    await expect(client.incidents.trigger.start(project.id, incidentId, {})).rejects.toThrow(
      /409|already running|BUSY/,
    );

    const finished = await until((incident) => {
      const run = incident.investigation.trigger?.runs.at(-1);
      return run !== undefined && !ACTIVE.has(run.state);
    });
    const run = finished.investigation.trigger?.runs.at(-1);
    if (SHOTS) {
      await mkdir(SHOTS, { recursive: true });
      await writeFile(
        path.join(SHOTS, 'run.json'),
        JSON.stringify(
          {
            run,
            experiments: finished.investigation.experiments,
            hypotheses: finished.investigation.hypotheses,
          },
          null,
          2,
        ),
      );
    }
    expect(run?.state).toBe('WAITING_FOR_APPROVAL');
    expect(run?.minimal).toBeDefined();
    const factors = new Set(
      run?.minimal?.actions
        .map((action) => action.origin)
        .filter((origin) => origin && origin !== 'probe' && origin !== 'reference'),
    );
    expect([...factors].sort()).toEqual(['data:empty:label:Code', 'state:dialog:button:Notes']);
    expect(
      run?.conditions.filter((condition) => condition.role === 'NECESSARY').map((condition) => condition.id),
      JSON.stringify(
        run?.conditions.map((condition) => [
          condition.id,
          condition.role,
          condition.withCondition,
          condition.withoutCondition,
        ]),
      ),
    ).toEqual(expect.arrayContaining(['cond:data:empty:label:Code', 'cond:state:dialog:button:Notes']));
    expect(run?.angular?.nodes.length).toBeGreaterThan(10);
    expect(
      run?.scope?.resources.some((resource) => resource.kind === 'ROUTE' && resource.status === 'AUTHORIZED'),
    ).toBe(true);
    // Les hypothèses du run : PROPOSED dans l'incident, jamais confirmées par le moteur seul.
    const hypotheses = finished.investigation.hypotheses.filter((hypothesis) =>
      run?.hypothesisIds.includes(hypothesis.id),
    );
    expect(hypotheses.length).toBeGreaterThanOrEqual(2);
    // PROPOSED, ou INCONCLUSIVE quand une vérification jouée n'a rien pu départager : jamais CONFIRMED par le moteur seul.
    expect(
      hypotheses.every(
        (hypothesis) => hypothesis.status === 'PROPOSED' || hypothesis.status === 'INCONCLUSIVE',
      ),
    ).toBe(true);
    expect(finished.investigation.diagnosis?.status ?? 'INCONCLUSIVE').not.toBe('CONFIRMED');
    const experiments = finished.investigation.experiments.filter((experiment) =>
      experiment.id.startsWith(`exp_trig_${run?.id ?? ''}_`),
    );
    expect(
      experiments.some(
        (experiment) => experiment.kind === 'CHECK_VALIDATION' && experiment.status === 'DONE',
      ),
    ).toBe(true);
    expect(
      experiments.some(
        (experiment) => experiment.kind === 'REPLAY' && experiment.status === 'APPROVAL_REQUIRED',
      ),
    ).toBe(true);
    expect(finished.investigation.regression?.basedOn).toBe(`trigger:${run?.id ?? ''}`);
    expect(finished.investigation.regression?.status).toBe('PROPOSED');
    expect(finished.investigation.regression?.execution).toBeUndefined();
    // Les captures des essais qui reproduisent, sous le projet, jamais dans la réponse.
    const shots = await readdir(
      path.join(workspace, project.id, 'incidents', incidentId, 'trigger', run?.id ?? ''),
    );
    expect(shots.some((file) => file.endsWith('.png'))).toBe(true);
    expect(JSON.stringify(finished)).not.toContain('"sk-');
    expect(finished.state).toBe('INVESTIGATING');
  }, 300_000);

  it('serves the run report, lets DECIDE approve a replay (played by the engine) and refuse another, and extends the budget', async () => {
    const report = await client.incidents.trigger.report(project.id, incidentId);
    expect(report.sections.summary?.join(' ')).toContain('Déclencheur reproduit');
    expect(
      report.sections.conditions?.some((line) => line.startsWith('NECESSARY')),
      JSON.stringify(report.sections.conditions),
    ).toBe(true);
    expect(report.sections.hypotheses?.every((line) => /^(PROPOSED|INCONCLUSIVE) /.test(line))).toBe(true);
    const viaApi = await api<TriggerRunReport>('GET', `/${incidentId}/trigger/report`);
    expect(viaApi.sections.coverage?.length).toBeGreaterThan(0);

    const before = await api<Incident>('GET', `/${incidentId}`);
    const run = before.investigation.trigger?.runs.at(-1);
    const pending = before.investigation.experiments.filter((experiment) =>
      run?.pendingExperimentIds.includes(experiment.id),
    );
    expect(pending.length).toBeGreaterThanOrEqual(2);
    const replay = pending.find((experiment) => experiment.kind === 'REPLAY');
    const other = pending.find((experiment) => experiment.id !== replay?.id);
    // Un lecteur ne décide pas.
    await expect(
      api(
        'POST',
        `/${incidentId}/trigger/experiments/${replay?.id ?? ''}/decision`,
        { approve: true },
        readerToken,
      ),
    ).rejects.toThrow(/403/);
    const refused = await client.incidents.trigger.decideExperiment(project.id, incidentId, other?.id ?? '', {
      approve: false,
      reason: 'pas maintenant',
    });
    expect(refused.investigation.experiments.find((experiment) => experiment.id === other?.id)?.status).toBe(
      'REFUSED',
    );
    await client.incidents.trigger.decideExperiment(project.id, incidentId, replay?.id ?? '', {
      approve: true,
    });
    const done = await until(
      (incident) =>
        incident.investigation.experiments.find((experiment) => experiment.id === replay?.id)?.status ===
        'DONE',
      120_000,
    );
    const played = done.investigation.experiments.find((experiment) => experiment.id === replay?.id);
    expect(played?.approvedBy).toBeDefined();
    expect(played?.evidence.length).toBeGreaterThan(0);
    expect(['SUPPORTS', 'NEUTRAL']).toContain(played?.outcome);
    // Une hypothèse n'est pas confirmée par un seul rejouage.
    expect(
      done.investigation.hypotheses
        .filter((hypothesis) => run?.hypothesisIds.includes(hypothesis.id))
        .every((hypothesis) => hypothesis.status !== 'CONFIRMED'),
    ).toBe(true);
    const extended = await client.incidents.trigger.extendBudget(project.id, incidentId, { maxTrials: 10 });
    expect(extended.investigation.trigger?.runs.at(-1)?.budget.maxTrials).toBe(50);
    await expect(
      client.incidents.trigger.extendBudget(project.id, incidentId, { maxBrowsers: -1 }),
    ).rejects.toMatchObject({ status: 400 });
  }, 180_000);

  it('shows the « Déclencheurs » tab in the Dashboard: brief, scope, matrix, minimal reproduction, causes, proposed test', async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      const failures: string[] = [];
      page.on('pageerror', (error) => failures.push(error.message));
      await page.goto(`${server.url}/dashboard`);
      const dashboard = page.locator('qa-crawler-dashboard');
      // Accès nommé : la page demande un jeton avant de montrer les projets.
      await dashboard.locator('input[data-bind="token"]').fill(server.token);
      await dashboard.locator('form[data-action="sign-in"] button[type="submit"]').click();
      await dashboard.locator('select[data-action="project-context"]').first().waitFor({ state: 'attached' });
      await dashboard.locator('select[data-action="project-context"]').selectOption(project.id);
      await dashboard.locator('.drawer [data-action="nav"][data-view="incidents"]').click();
      await dashboard.locator('tr.inc-l-row', { hasText: 'Enregistrer ne réagit plus' }).first().click();
      await dashboard.locator('#ws-ux-tab-overview[aria-selected="true"]').waitFor();
      await dashboard.locator('#ws-ux-tab-trigger').click();
      await dashboard.locator('#ws-ux-sub-brief[aria-selected="true"]').waitFor();
      const panel = dashboard.locator('#ws-ux-panel');
      await panel.locator('.ws-trg-run').waitFor();
      expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1)).toBe(
        true,
      );
      let text = (await panel.textContent()) ?? '';
      expect(text).toContain('Découverte des déclencheurs');
      expect(text).toContain('déclaré');
      expect(text).toMatch(/Terminé|En attente d’approbation/);
      expect(text).not.toContain('Cause racine confirmée');
      await shot(page, 'trg-01-brief');
      await dashboard.locator('#ws-ux-sub-discovery').click();
      await panel.locator('.ws-trg-status[data-status="AUTHORIZED"]').first().waitFor();
      await shot(page, 'trg-02-discovery');
      await dashboard.locator('#ws-ux-sub-explorer').click();
      await panel.locator('.ws-trg-role[data-role="NECESSARY"]').first().waitFor();
      await shot(page, 'trg-03-explorer');
      await dashboard.locator('#ws-ux-sub-matrix').click();
      await panel.locator('.ws-trg-verdict[data-verdict="FAILURE_REPRODUCED"]').first().waitFor();
      await shot(page, 'trg-04-matrix');
      await panel.locator('[data-action="ws-trg-trial"]').nth(1).click();
      await dashboard.locator('#ws-ux-sub-chronology').click();
      await panel.locator('.ws-trg-ev').first().waitFor();
      await shot(page, 'trg-05-chronology');
      await dashboard.locator('#ws-ux-sub-minimal').click();
      await panel.locator('.ws-trg-steps').waitFor();
      text = (await panel.textContent()) ?? '';
      expect(text).toContain('Code = «vide»');
      expect(text).toContain('aucune récupération automatique');
      await shot(page, 'trg-06-minimal');
      await dashboard.locator('#ws-ux-sub-angular').click();
      await panel.locator('.ws-trg-features').waitFor();
      await shot(page, 'trg-07-angular');
      await dashboard.locator('#ws-ux-sub-causes').click();
      await panel.locator('.ws-trg-hyp').first().waitFor();
      text = (await panel.textContent()) ?? '';
      expect(text).toContain('PROPOSED');
      expect(text).toContain('REFUSED');
      await shot(page, 'trg-08-causes');
      await dashboard.locator('#ws-ux-sub-proposal').click();
      await panel.locator('.ws-trg-yaml').waitFor();
      text = (await panel.textContent()) ?? '';
      expect(text).toContain('noError: true');
      expect(text).toContain('jamais « validé » sans exécution');
      await shot(page, 'trg-09-proposal');
      await dashboard.locator('#ws-ux-sub-live').click();
      await panel.locator('[data-action="ws-trg-report-load"]').click();
      await panel.locator('.ws-trg-rep').first().waitFor();
      await shot(page, 'trg-10-report');
      expect(failures).toEqual([]);
    } finally {
      await browser.close();
    }
  }, 120_000);

  it('cancels a run cooperatively and refuses a pause when nothing runs', async () => {
    const bare = await client.incidents.create(project.id, {
      title: 'Annulation',
      description: DESCRIPTION,
      observed: 'o',
      expected: 'e',
      severity: 'LOW',
    });
    // Sans environnement déclaré, l'URL cible du projet sert d'environnement.
    const started = await client.incidents.trigger.start(project.id, bare.id, {
      depth: 'QUICK',
      budget: { maxTrials: 6 },
    });
    expect(started.investigation.trigger?.runs).toHaveLength(1);
    await client.incidents.trigger.cancel(project.id, bare.id);
    const cancelled = await until(
      (incident) => !ACTIVE.has(incident.investigation.trigger?.runs.at(-1)?.state ?? ''),
      90_000,
      bare.id,
    );
    const run = cancelled.investigation.trigger?.runs.at(-1);
    expect(['CANCELLED', 'INCONCLUSIVE']).toContain(run?.state);
    expect(run?.finishedAt).toBeDefined();
    await expect(client.incidents.trigger.pause(project.id, bare.id)).rejects.toMatchObject({ status: 409 });
  }, 120_000);
});
