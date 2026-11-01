import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scenarioSchema, type AiConfig } from '../../src/config/config.js';
import { createIncidentAiRuntime } from '../../src/incident/ai/index.js';
import type { ModelCompletionInput } from '../../src/incident/ai/model-client.js';
import {
  CROSS_LAYER_FINDINGS_JSON_SCHEMA,
  EVIDENCE_ANALYSIS_JSON_SCHEMA,
  HYPOTHESIS_PROPOSALS_JSON_SCHEMA,
  VERIFICATION_PLAN_JSON_SCHEMA,
} from '../../src/incident/ai/schemas/analysis.js';
import { CONTRADICTION_FINDINGS_JSON_SCHEMA } from '../../src/incident/ai/schemas/contradiction.js';
import { LAYER_FINDINGS_JSON_SCHEMA } from '../../src/incident/ai/schemas/layer.js';
import {
  ASSISTANT_ANSWER_JSON_SCHEMA,
  PLANNER_OUTPUT_JSON_SCHEMA,
  SYNTHESIS_JSON_SCHEMA,
} from '../../src/incident/ai/schemas/plan.js';
import type { Incident, InvestigationMemory } from '../../src/incident/model.js';
import type { AiCapabilities } from '../../src/sdk/core/incident-ai-contracts.js';
import { createQaCrawler, type Project, type QaCrawlerClient } from '../../src/sdk/core/index.js';
import { engineDefaults } from '../../src/sdk/server/project.js';
import { startSdkServer, type RunningSdkServer } from '../../src/sdk/server/server.js';
import { demoIncident } from '../../src/sdk/ui/incident-demo.js';
import { finalTurn, scriptedModelClient, type ScriptedStep } from '../fixtures/scripted-model-client.js';

/**
 * L'INVESTIGATION IA PAR LE SERVEUR ET LE DASHBOARD (Chromium), avec un client de modèle scripté : les
 * capacités annoncées, le lancement (202, run RUNNING puis DONE relu par le client), l'hypothèse IA PROPOSED et
 * plafonnée, la proposition sans effet de bord lancée par le chemin ordinaire, celle à effets de bord tranchée
 * par une personne (DECIDE), la mémoire d'investigation, le rapport (section « Investigation IA »), l'assistant
 * qui cite, et le sous-onglet « Investigation IA » de l'espace d'investigation : mode, profondeur, progression,
 * constats, vérifications proposées, hypothèses avec leur origine. Captures dans le bac à sable.
 */
const REQUEST = 'rep_1:req-3-1';
const SHOTS = process.env.AI_SHOTS_DIR;

function keyOf(input: ModelCompletionInput): string | undefined {
  const schema = input.outputSchema;
  if (schema === PLANNER_OUTPUT_JSON_SCHEMA) return 'PLANNER';
  if (schema === EVIDENCE_ANALYSIS_JSON_SCHEMA) return 'EVIDENCE_ANALYSIS';
  if (schema === CROSS_LAYER_FINDINGS_JSON_SCHEMA) return 'CROSS_LAYER';
  if (schema === HYPOTHESIS_PROPOSALS_JSON_SCHEMA) return 'HYPOTHESIS';
  if (schema === VERIFICATION_PLAN_JSON_SCHEMA) return 'VERIFICATION_PLANNING';
  if (schema === CONTRADICTION_FINDINGS_JSON_SCHEMA) return 'CONTRADICTION_HUNTER';
  if (schema === SYNTHESIS_JSON_SCHEMA) return 'SYNTHESIS';
  if (schema === ASSISTANT_ANSWER_JSON_SCHEMA) return 'ASSISTANT';
  if (schema === LAYER_FINDINGS_JSON_SCHEMA)
    return /Investigate the (FRONTEND|BFF|BACKEND) layer/.exec(input.messages[0]?.content ?? '')?.[1];
  return undefined;
}

const planner = finalTurn({
  goals: ['Établir pourquoi POST /api/books répond 500 sans éditeur'],
  steps: [
    { id: 'step-1', order: 1, title: 'Preuves', agent: 'EVIDENCE_ANALYSIS', targets: [REQUEST] },
    { id: 'step-2', order: 2, title: 'Backend', agent: 'BACKEND', targets: ['catalog'] },
    { id: 'step-3', order: 3, title: 'Hypothèses', agent: 'HYPOTHESIS', targets: [] },
    { id: 'step-4', order: 4, title: 'Vérifications', agent: 'VERIFICATION_PLANNING', targets: [] },
    { id: 'step-5', order: 5, title: 'Contradictions', agent: 'CONTRADICTION_HUNTER', targets: [] },
    { id: 'step-6', order: 6, title: 'Synthèse', agent: 'SYNTHESIS', targets: [] },
  ],
  focus: { layers: ['BACKEND'], endpoints: ['POST /api/books'], refs: [{ kind: 'request', id: REQUEST }] },
  questions: [],
});
const evidence = finalTurn({
  firstSymptom: { summary: 'La réponse 500 à POST /api/books.', refs: [{ kind: 'request', id: REQUEST }] },
  precedingEvents: [],
  inconsistencies: [],
  missingEvidence: [],
  temporalRelations: [],
  leads: [],
  gaps: [],
});
const backend = finalTurn({
  findings: [
    {
      title: 'Le service lit l’éditeur sans garde',
      summary: 'register() déréférence getPublisher() alors que le corps envoyé n’a pas d’éditeur.',
      layer: 'BACKEND',
      basis: 'INFERRED',
      refs: [{ kind: 'request', id: REQUEST }],
      locations: [],
    },
  ],
  gaps: [],
});
const hypotheses = finalTurn({
  hypotheses: [
    {
      title: 'Éditeur absent du corps transmis au backend',
      description: 'Le BFF transmet le livre sans identifiant d’éditeur ; le backend le déréférence.',
      suspectedCause: 'publisherId perdu entre le formulaire et le backend',
      layer: 'BFF',
      locations: [],
      supporting: [{ ref: { kind: 'request', id: REQUEST }, fact: 'le corps ne porte pas publisherId' }],
      contradicting: [],
      confidence: 0.95,
      verificationHints: [],
    },
  ],
  existing: [],
  gaps: [],
});
const verifications = finalTurn({
  proposals: [
    {
      hypothesisId: 'hyp-ai-1',
      kind: 'COMPARE_REQUESTS',
      objective: 'Comparer les corps envoyés avec et sans éditeur',
      description: 'Comparer rep_1 (échec) et rep_2 (succès) sur POST /api/books',
      params: { left: 'rep_1', right: 'rep_2', endpoint: 'POST /api/books', field: 'publisherId' },
      resources: [],
      permissions: [],
      risks: [],
      sideEffects: false,
      expected: 'publisherId manque côté échec',
      confirmIf: 'le champ manque dans rep_1 et pas dans rep_2',
      refuteIf: 'les deux corps portent le champ',
      priority: 1,
    },
    {
      hypothesisId: 'hyp-ai-1',
      kind: 'INTEGRATION_TEST',
      objective: 'Rejouer le test d’intégration du catalogue',
      description: 'mvn verify sur le module catalogue',
      params: { applicationId: 'catalog', test: 'CatalogBookIT', environmentKind: 'TEST' },
      resources: ['maven'],
      permissions: ['RUN_WRITES'],
      risks: ['écrit en base'],
      sideEffects: true,
      expected: 'le test échoue sans éditeur',
      confirmIf: 'échec reproduit',
      refuteIf: 'le test passe',
      priority: 2,
    },
  ],
  gaps: [],
});
const noMore = finalTurn({ proposals: [], gaps: [] });
const contradictions = finalTurn({
  contradictions: [
    {
      hypothesisId: 'hyp-ai-1',
      kind: 'MISSING_EVIDENCE',
      summary: 'Aucun journal du BFF ne montre la transformation du corps : question ouverte.',
      refs: [],
      openQuestion: true,
    },
  ],
});
const synthesis = finalTurn({
  summary: 'Le corps transmis au backend ne porte pas d’éditeur ; la comparaison des requêtes le soutient.',
  ranking: ['hyp-ai-1'],
  missing: ['journaux du BFF'],
  decisive: [],
});
const assistant = finalTurn({
  answer: 'La requête en échec est POST /api/books, répondue 500 ; son corps ne porte pas publisherId.',
  refs: [{ kind: 'request', id: REQUEST }],
  locations: [],
  insufficient: false,
});
const SCRIPT: Record<string, ScriptedStep[]> = {
  PLANNER: [planner, planner, planner],
  EVIDENCE_ANALYSIS: [evidence],
  BACKEND: [backend],
  CROSS_LAYER: [finalTurn({ findings: [], relations: [], gaps: [] })],
  HYPOTHESIS: [hypotheses, hypotheses, hypotheses],
  VERIFICATION_PLANNING: [verifications, noMore, noMore],
  CONTRADICTION_HUNTER: [contradictions],
  SYNTHESIS: [synthesis],
  ASSISTANT: [assistant],
};

const aiConfig = (): AiConfig =>
  scenarioSchema.parse({
    target: { baseUrl: 'http://catalogue.test' },
    ai: {
      enabled: true,
      provider: 'anthropic',
      anthropic: { model: 'scripted-model' },
      incidents: {
        mode: 'AI_AGENTIC',
        dataPolicy: { allowExternal: true },
        budget: { maxIterations: 4, maxModelCalls: 40, maxExperiments: 2 },
      },
    },
  }).ai;

let server: RunningSdkServer;
let workspace: string;
let client: QaCrawlerClient;
let project: Project;
let incidentId: string;

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

async function until(done: (incident: Incident) => boolean, timeoutMs = 60_000): Promise<Incident> {
  const started = Date.now();
  for (;;) {
    const incident = await api<Incident>('GET', `/${incidentId}`);
    if (done(incident)) return incident;
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for the AI run');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });
}

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'incident-ai-ws-'));
  const client0 = scriptedModelClient({ turns: SCRIPT, keyOf, model: 'scripted-model' });
  const aiRuntime = createIncidentAiRuntime(aiConfig(), {}, { client: client0 });
  server = await startSdkServer({ workspace, language: 'fr', aiRuntime });
  client = createQaCrawler({ endpoint: `${server.url}/api`, token: server.token });
  project = await client.projects.create({
    ...engineDefaults(),
    project: { name: 'Catalogue', targetUrl: 'http://catalogue.test/books', framework: 'other' },
  });
  // L'incident connu (les données réelles de l'investigation de la fixture), écrit dans le projet du serveur.
  const created = await client.incidents.create(project.id, {
    title: 'Erreur 500 à la création d’un livre',
    description: 'Après Enregistrer, l’application affiche une erreur HTTP 500.',
    observed: 'Erreur HTTP 500 après Enregistrer',
    expected: 'Livre créé',
    severity: 'HIGH',
    scenario: 'Créer un livre sans éditeur',
  });
  incidentId = created.id;
  const file = path.join(workspace, project.id, 'incidents', `${incidentId}.json`);
  // L'environnement de la démonstration n'existe pas dans ce projet : l'incident vise l'URL du projet.
  const { environmentId: _environment, ...demo } = demoIncident();
  const seeded: Incident = {
    ...demo,
    id: created.id,
    projectId: project.id,
    title: created.title,
    createdAt: created.createdAt,
    createdBy: created.createdBy,
    revision: created.revision + 1,
    history: [...created.history, ...demo.history.slice(1)],
  };
  await writeFile(file, JSON.stringify(seeded, null, 2));
}, 60_000);

afterAll(async () => {
  client.dispose();
  await server.close();
  await rm(workspace, { recursive: true, force: true });
});

describe('AI investigation — server, client and Dashboard with a scripted model', () => {
  it('announces the capabilities, runs AI_AGENTIC/STANDARD to DONE, merges proposals and writes the memory', async () => {
    const capabilities = await client.incidents.ai.capabilities(project.id, incidentId);
    expect(capabilities.availableModes).toEqual(['DETERMINISTIC', 'AI_ASSISTED', 'AI_AGENTIC']);
    expect(capabilities.defaultMode).toBe('AI_AGENTIC');
    expect(capabilities.model).toBe('scripted-model');
    expect(capabilities.budget.maxCommands).toBe(0);
    expect(await client.incidents.ai.memory(project.id, incidentId)).toBeNull();

    // Un budget plus grand que la configuration : refusé (422), même avec le jeton du service.
    await expect(
      api('POST', `/${incidentId}/ai/investigate`, { mode: 'AI_AGENTIC', budget: { maxModelCalls: 9999 } }),
    ).rejects.toThrow(/422/);
    await expect(
      api('POST', `/${incidentId}/ai/investigate`, { mode: 'AI_ASSISTED', depth: 'DEEP' }),
    ).rejects.toThrow(/422/);

    const started = await client.incidents.ai.investigate(project.id, incidentId, {
      mode: 'AI_AGENTIC',
      depth: 'STANDARD',
    });
    const running = started.investigation.ai?.runs.at(-1);
    expect(running?.status).toBe('RUNNING');
    const done = await until((incident) => incident.investigation.ai?.runs.at(-1)?.status !== 'RUNNING');
    const run = done.investigation.ai?.runs.at(-1);
    expect(
      run?.status,
      JSON.stringify({
        error: run?.error,
        steps: run?.steps.map((step) => [step.agent, step.status, step.error]),
      }),
    ).toBe('DONE');
    expect(run?.depth).toBe('STANDARD');
    const ai = done.investigation.hypotheses.find((hypothesis) => hypothesis.id === 'hyp-ai-1');
    expect(ai?.origin).toBe('AI');
    expect(ai?.status).toBe('PROPOSED');
    expect(ai?.confidence).toBeLessThanOrEqual(0.7);
    const compare = run?.proposals.find((proposal) => proposal.kind === 'COMPARE_REQUESTS');
    expect(compare?.status).toBe('DONE');
    expect(done.investigation.experiments.some((entry) => entry.id === compare?.experimentId)).toBe(true);
    const integration = run?.proposals.find((proposal) => proposal.kind === 'INTEGRATION_TEST');
    expect(integration?.status).toBe('PROPOSED');

    const memory = await client.incidents.ai.memory(project.id, incidentId);
    expect(memory?.status).toBe('DONE');
    expect(memory?.contradictions).toHaveLength(1);
    expect(memory?.coverage.length).toBeGreaterThan(0);
    const raw = await readFile(
      path.join(workspace, project.id, 'incidents', incidentId, 'ai', 'memory.json'),
      'utf8',
    );
    expect(JSON.parse(raw) as InvestigationMemory).toMatchObject({ incidentId, depth: 'STANDARD' });

    // Le rapport porte la section « Investigation IA » et la limite sur les hypothèses IA non éprouvées.
    const markdown = await client.incidents.reportMarkdown(project.id, incidentId);
    expect(markdown).toContain('## Investigation IA');
    expect(markdown).toContain('hyp-ai-1');
    expect(markdown).toContain('Investigation approfondie');
    expect(markdown).toMatch(/hypothèse\(s\) d'origine IA non éprouvée\(s\)/);
    const html = await api<{ html: string }>('GET', `/${incidentId}/report?format=html&sections=ai`);
    expect(html.html).toContain('id="ai"');
    expect(html.html).toContain('Investigation IA');

    // L'assistant cite sa référence ; la réponse est conservée.
    const answer = await client.incidents.ai.ask(project.id, incidentId, 'Quelle requête échoue ?');
    expect(answer.refs).toEqual([{ kind: 'request', id: REQUEST }]);
    expect((await client.incidents.get(project.id, incidentId)).investigation.ai?.answers).toHaveLength(1);

    // Trancher une proposition est une décision : refusée ici, rien n'est lancé.
    const decided = await client.incidents.ai.decideExperiment(
      project.id,
      incidentId,
      integration?.id ?? '',
      {
        approve: false,
        reason: 'pas en recette',
      },
    );
    expect(
      decided.investigation.ai?.runs.at(-1)?.proposals.find((item) => item.id === integration?.id)?.status,
    ).toBe('REFUSED');
    const extended = await client.incidents.ai.extendBudget(project.id, incidentId, { maxExperiments: 1 });
    expect(extended.budget.extensions).toHaveLength(1);
  }, 90_000);

  it('shows the AI investigation in the Dashboard: mode, depth, progress, findings, proposals, origin pills', async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      const failures: string[] = [];
      page.on('pageerror', (error) => failures.push(error.message));
      await page.goto(`${server.url}/dashboard`);
      const dashboard = page.locator('qa-crawler-dashboard');
      await dashboard.locator('select[data-action="project-context"]').selectOption(project.id);
      await dashboard.locator('.drawer [data-action="nav"][data-view="incidents"]').click();
      await dashboard.locator('tr.inc-l-row', { hasText: 'Erreur 500' }).first().click();
      await dashboard.locator('#ws-ux-tab-overview[aria-selected="true"]').waitFor();
      await dashboard.locator('#ws-ux-tab-diagnosis').click();
      await dashboard.locator('#ws-ux-sub-ai').click();
      await dashboard.locator('#ws-ux-sub-ai[aria-selected="true"]').waitFor();
      const panel = dashboard.locator('#ws-ux-panel');
      await panel.locator('.ws-ai-run').waitFor();
      // Aucun défilement global : le corps de l'espace reste dans la fenêtre.
      expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1)).toBe(
        true,
      );
      const text = (await panel.textContent()) ?? '';
      expect(text).toContain('Investigation IA');
      expect(text).toContain('Terminé');
      expect(text).toContain('scripted-model');
      expect(text).not.toContain('Cause racine confirmée');
      // Le mode et la profondeur : IA agentique disponible, DEEP permise avec elle.
      expect(await panel.locator('[data-action="ws-ai-mode"][data-mode="AI_AGENTIC"]').isDisabled()).toBe(
        false,
      );
      expect(await panel.locator('[data-action="ws-ai-depth"][data-depth="DEEP"]').isDisabled()).toBe(false);
      await shot(page, 'ai-01-run');
      await panel.locator('[data-action="ws-ai-section"][data-section="findings"]').click();
      await panel.locator('.ws-ai-finding').first().waitFor();
      expect(await panel.locator('.ws-ai-finding').count()).toBeGreaterThan(0);
      await shot(page, 'ai-02-findings');
      await panel.locator('[data-action="ws-ai-section"][data-section="proposals"]').click();
      await panel.locator('.ws-ai-prop').first().waitFor();
      const proposals = (await panel.locator('.ws-ai-props').textContent()) ?? '';
      expect(proposals).toContain('COMPARE_REQUESTS');
      expect(proposals).toContain('Refusée');
      await shot(page, 'ai-03-proposals');
      await panel.locator('[data-action="ws-ai-section"][data-section="hypotheses"]').click();
      await panel.locator('.ws-ai-hyp').first().waitFor();
      expect(await panel.locator('.ws-ai-origin', { hasText: 'IA' }).count()).toBeGreaterThan(0);
      await shot(page, 'ai-04-hypotheses');
      await panel.locator('[data-action="ws-ai-section"][data-section="contradictions"]').click();
      await panel.locator('.ws-ai-ctr').first().waitFor();
      expect((await panel.textContent()) ?? '').toContain('Question ouverte');
      await panel.locator('[data-action="ws-ai-section"][data-section="coverage"]').click();
      await panel.locator('.ws-ai-table').first().waitFor();
      await shot(page, 'ai-05-coverage');
      await panel.locator('[data-action="ws-ai-section"][data-section="assistant"]').click();
      await panel.locator('.ws-ai-answer').first().waitFor();
      expect((await panel.textContent()) ?? '').toContain('POST /api/books');
      await shot(page, 'ai-06-assistant');
      // Les hypothèses du diagnostic portent leur origine.
      await dashboard.locator('#ws-ux-sub-hypotheses').click();
      await panel.locator('.ws-dx-hyp').first().waitFor();
      expect(await panel.locator('.ws-dx-hyp .ws-ai-origin', { hasText: 'IA' }).count()).toBeGreaterThan(0);
      await shot(page, 'ai-07-hypotheses-origin');
      expect(failures).toEqual([]);
    } finally {
      await browser.close();
    }
  }, 90_000);
});

export type { AiCapabilities };
