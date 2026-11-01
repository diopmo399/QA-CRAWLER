import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
import { IncidentService, type IncidentHost } from '../../src/incident/service.js';
import type { Incident } from '../../src/sdk/core/incident-contracts.js';
import { demoIncident } from '../../src/sdk/ui/incident-demo.js';
import { finalTurn, scriptedModelClient, type ScriptedStep } from '../fixtures/scripted-model-client.js';

/**
 * L'INVESTIGATION IA PAR LE SERVICE, de bout en bout avec un client de modèle scripté (aucun réseau) :
 * le run est écrit RUNNING puis fusionné (hypothèses IA PROPOSED et plafonnées, propositions, mémoire
 * d'investigation sur disque), une proposition sans effet de bord est lancée par le chemin ordinaire en
 * AI_AGENTIC, une proposition à effets de bord attend une personne, l'assistant répond en citant,
 * l'annulation conserve l'acquis, et sans configuration IA tout est « indisponible ».
 */
const REQUEST = 'rep_1:req-3-1';
const INCIDENT_ID = 'inc_aiservice001';
const OTHER_ID = 'inc_aiservice002';

/** La clé d'agent d'un appel : le schéma de sortie l'identifie (les couches par leur message utilisateur). */
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
  if (schema === LAYER_FINDINGS_JSON_SCHEMA) {
    const user = input.messages[0]?.content ?? '';
    return /Investigate the (FRONTEND|BFF|BACKEND) layer/.exec(user)?.[1];
  }
  return undefined;
}

const planner = finalTurn({
  goals: ['Établir pourquoi POST /api/books répond 500 sans éditeur'],
  steps: [
    { id: 'step-1', order: 1, title: 'Preuves', agent: 'EVIDENCE_ANALYSIS', targets: [REQUEST] },
    { id: 'step-2', order: 2, title: 'Backend', agent: 'BACKEND', targets: ['catalog'] },
    { id: 'step-3', order: 3, title: 'Inter-couches', agent: 'CROSS_LAYER', targets: [] },
    { id: 'step-4', order: 4, title: 'Hypothèses', agent: 'HYPOTHESIS', targets: [] },
    { id: 'step-5', order: 5, title: 'Vérifications', agent: 'VERIFICATION_PLANNING', targets: [] },
    { id: 'step-6', order: 6, title: 'Contradictions', agent: 'CONTRADICTION_HUNTER', targets: [] },
    { id: 'step-7', order: 7, title: 'Synthèse', agent: 'SYNTHESIS', targets: [] },
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

const crossLayer = finalTurn({ findings: [], relations: [], gaps: [] });

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

const noMoreVerifications = finalTurn({ proposals: [], gaps: [] });

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
  summary:
    'Le corps transmis au backend ne porte pas d’éditeur ; une comparaison des requêtes le départagerait.',
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
  CROSS_LAYER: [crossLayer],
  HYPOTHESIS: [hypotheses, hypotheses, hypotheses],
  VERIFICATION_PLANNING: [verifications, noMoreVerifications, noMoreVerifications],
  CONTRADICTION_HUNTER: [contradictions],
  SYNTHESIS: [synthesis],
  ASSISTANT: [assistant],
};

function aiConfig(mode: 'AI_ASSISTED' | 'AI_AGENTIC'): AiConfig {
  return scenarioSchema.parse({
    target: { baseUrl: 'http://catalogue.test' },
    ai: {
      enabled: true,
      provider: 'anthropic',
      anthropic: { model: 'scripted-model' },
      incidents: {
        mode,
        dataPolicy: { allowExternal: true },
        budget: { maxIterations: 4, maxModelCalls: 40, maxExperiments: 2 },
      },
    },
  }).ai;
}

let projectDir: string;

const hostOf = (): IncidentHost => ({
  projectId: 'prj_books',
  projectDir,
  replay: () => Promise.reject(new Error('no replay in this test')),
  scenarioYaml: () => Promise.resolve(undefined),
  addScenario: () => Promise.reject(new Error('no library in this test')),
  environment: () => Promise.resolve({ baseUrl: 'http://catalogue.test/' }),
  runDir: (run) => path.join(projectDir, 'reports', run),
});

async function seed(id: string): Promise<Incident> {
  const incident: Incident = { ...demoIncident(), id, projectId: 'prj_books' };
  await mkdir(path.join(projectDir, 'incidents'), { recursive: true });
  await writeFile(path.join(projectDir, 'incidents', `${id}.json`), JSON.stringify(incident, null, 2));
  return incident;
}

beforeAll(async () => {
  projectDir = await mkdtemp(path.join(tmpdir(), 'incident-ai-service-'));
  await seed(INCIDENT_ID);
  await seed(OTHER_ID);
});

afterAll(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

describe('IncidentService — investigation IA (client scripté)', () => {
  it('sans configuration IA : DETERMINISTIC seulement, lancement refusé, assistant indisponible', async () => {
    const service = new IncidentService(hostOf());
    const capabilities = await service.aiCapabilities(INCIDENT_ID);
    expect(capabilities.availableModes).toEqual(['DETERMINISTIC']);
    expect(capabilities.unavailableReason).toMatch(/DETERMINISTIC/);
    await expect(service.investigate(INCIDENT_ID, 'alice', { mode: 'AI_ASSISTED' })).rejects.toMatchObject({
      code: 'INVALID',
    });
    const answer = await service.ask(INCIDENT_ID, 'alice', 'Pourquoi 500 ?');
    expect(answer.answer).toBe('');
    expect(answer.unavailable).toMatch(/DETERMINISTIC/);
    expect((await service.incident(INCIDENT_ID)).investigation.ai?.answers).toHaveLength(1);
    expect(await service.aiMemory(INCIDENT_ID)).toBeUndefined();
  });

  it('AI_AGENTIC : run DONE, hypothèse IA PROPOSED plafonnée, proposition sans effet lancée, mémoire écrite', async () => {
    const client = scriptedModelClient({ turns: SCRIPT, keyOf, model: 'scripted-model' });
    const runtime = createIncidentAiRuntime(aiConfig('AI_AGENTIC'), {}, { client });
    expect(runtime.capabilities().availableModes).toContain('AI_AGENTIC');
    const service = new IncidentService(hostOf(), { ai: runtime });

    // Un budget plus grand que la configuration n'est jamais accepté ici.
    await expect(
      service.investigate(INCIDENT_ID, 'alice', { mode: 'AI_AGENTIC', budget: { maxModelCalls: 10_000 } }),
    ).rejects.toMatchObject({ code: 'INVALID' });
    // DEEP exige AI_AGENTIC.
    await expect(
      service.investigate(INCIDENT_ID, 'alice', { mode: 'AI_ASSISTED', depth: 'DEEP' }),
    ).rejects.toMatchObject({ code: 'INVALID' });

    const started = await service.investigate(INCIDENT_ID, 'alice', {
      mode: 'AI_AGENTIC',
      depth: 'STANDARD',
    });
    const running = started.investigation.ai?.runs.at(-1);
    expect(running?.status).toBe('RUNNING');
    expect(running?.depth).toBe('STANDARD');
    await expect(service.investigate(INCIDENT_ID, 'alice', { mode: 'AI_AGENTIC' })).rejects.toMatchObject({
      code: 'BUSY',
    });
    await service.settle();

    const incident = await service.incident(INCIDENT_ID);
    const run = incident.investigation.ai?.runs.at(-1);
    expect(run?.id).toBe(running?.id);
    expect(
      run?.status,
      JSON.stringify({ steps: run?.steps, limitations: run?.limitations, error: run?.error }),
    ).toBe('DONE');
    expect(run?.steps.map((step) => [step.agent, step.status])).toEqual(
      expect.arrayContaining([
        ['PLANNER', 'DONE'],
        ['EVIDENCE_ANALYSIS', 'DONE'],
        ['BACKEND', 'DONE'],
        ['HYPOTHESIS', 'DONE'],
        ['VERIFICATION_PLANNING', 'DONE'],
        ['CONTRADICTION_HUNTER', 'DONE'],
        ['SYNTHESIS', 'DONE'],
      ]),
    );
    expect(run?.synthesis?.ranking).toEqual(['hyp-ai-1']);

    // L'hypothèse IA : PROPOSED, origine IA, confiance plafonnée, jamais confirmée.
    const ai = incident.investigation.hypotheses.find((hypothesis) => hypothesis.id === 'hyp-ai-1');
    expect(ai).toBeDefined();
    expect(ai?.origin).toBe('AI');
    expect(ai?.status).toBe('PROPOSED');
    expect(ai?.confidence).toBeLessThanOrEqual(0.7);
    expect(ai?.aiRunId).toBe(run?.id);
    expect(incident.investigation.diagnosis?.status).toBe(demoIncident().investigation.diagnosis?.status);

    // La proposition sans effet de bord a été planifiée et lancée par le chemin ordinaire ; celle à effets attend.
    const compare = run?.proposals.find((proposal) => proposal.kind === 'COMPARE_REQUESTS');
    const integration = run?.proposals.find((proposal) => proposal.kind === 'INTEGRATION_TEST');
    expect(compare?.status).toBe('DONE');
    expect(compare?.experimentId).toBeDefined();
    const experiment = incident.investigation.experiments.find((entry) => entry.id === compare?.experimentId);
    expect(experiment?.kind).toBe('COMPARE_REQUESTS');
    expect(experiment?.status).toBe('DONE');
    expect(experiment?.hypothesisId).toBe('hyp-ai-1');
    expect(integration?.status).toBe('PROPOSED');
    expect(run?.usage.experiments).toBe(1);
    expect(incident.history.filter((event) => event.kind === 'AI').length).toBeGreaterThanOrEqual(2);

    // La mémoire d'investigation : sur disque, structurée, sans transcription.
    const raw = await readFile(path.join(projectDir, 'incidents', INCIDENT_ID, 'ai', 'memory.json'), 'utf8');
    expect(raw).not.toContain('Investigate the');
    const memory = await service.aiMemory(INCIDENT_ID);
    expect(memory?.status).toBe('DONE');
    expect(memory?.depth).toBe('STANDARD');
    expect(memory?.strategies.length).toBeGreaterThan(0);
    expect(memory?.explorations.some((item) => item.hypothesisId === 'hyp-ai-1')).toBe(true);
    expect(memory?.contradictions).toHaveLength(1);
    expect(memory?.contradictions[0]?.openQuestion).toBe(true);
    expect(memory?.coverage.length).toBeGreaterThan(0);
    expect(memory?.coverage.every((entry) => !('percent' in entry))).toBe(true);
    expect(
      memory?.experiments.some((item) => item.kind === 'COMPARE_REQUESTS' && item.status === 'DONE'),
    ).toBe(true);

    // Une personne refuse la proposition à effets de bord : elle reste refusée, rien n'est lancé.
    const refused = await service.decideAiExperiment(INCIDENT_ID, integration?.id ?? '', false, 'bob', {
      reason: 'pas en recette aujourd’hui',
    });
    const after = refused.investigation.ai?.runs
      .at(-1)
      ?.proposals.find((item) => item.id === integration?.id);
    expect(after?.status).toBe('REFUSED');
    expect(after?.refusal).toContain('pas en recette');
    expect(
      refused.investigation.experiments.filter((entry) => entry.kind === 'INTEGRATION_TEST'),
    ).toHaveLength(0);
    await expect(
      service.decideAiExperiment(INCIDENT_ID, integration?.id ?? '', true, 'bob'),
    ).rejects.toMatchObject({ code: 'STATE' });

    // L'assistant cite une référence existante ; la réponse est conservée.
    const answer = await service.ask(INCIDENT_ID, 'alice', 'Quelle requête échoue ?');
    expect(answer.unavailable).toBeUndefined();
    expect(answer.refs).toEqual([{ kind: 'request', id: REQUEST }]);
    expect((await service.incident(INCIDENT_ID)).investigation.ai?.answers.at(-1)?.id).toBe(answer.id);

    // Une prolongation de budget (DECIDE) : jamais maxCommands, bornée, tracée.
    await expect(service.extendAiBudget(INCIDENT_ID, { maxCommands: 1 }, 'bob')).rejects.toMatchObject({
      code: 'INVALID',
    });
    const extended = await service.extendAiBudget(INCIDENT_ID, { maxExperiments: 2 }, 'bob');
    expect(extended.budget.maxExperiments).toBe((memory?.budget.maxExperiments ?? 0) + 2);
    expect(extended.budget.extensions.at(-1)?.by).toBe('bob');
    await runtime.close();
  });

  it('AI_ASSISTED : aucune vérification lancée ; l’annulation garde l’acquis', async () => {
    const slow = scriptedModelClient({ turns: SCRIPT, keyOf, delayMs: 120 });
    const runtime = createIncidentAiRuntime(aiConfig('AI_ASSISTED'), {}, { client: slow });
    const service = new IncidentService(hostOf(), { ai: runtime });
    await service.investigate(OTHER_ID, 'alice', { mode: 'AI_ASSISTED', depth: 'QUICK' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const cancelled = await service.cancelInvestigation(OTHER_ID, 'alice');
    expect(['RUNNING', 'CANCELLED']).toContain(cancelled.investigation.ai?.runs.at(-1)?.status);
    await service.settle();
    const incident = await service.incident(OTHER_ID);
    const run = incident.investigation.ai?.runs.at(-1);
    expect(run?.status).toBe('CANCELLED');
    expect(run?.stopReason).toBe('CANCELLED');
    expect(run?.steps.length).toBeGreaterThan(0);
    expect(incident.investigation.experiments).toEqual(demoIncident().investigation.experiments);
    await expect(service.cancelInvestigation(OTHER_ID, 'alice')).rejects.toMatchObject({ code: 'STATE' });
    const memory = await service.aiMemory(OTHER_ID);
    expect(memory?.status).toBe('CANCELLED');
    await runtime.close();
  });
});
