import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BusinessEvent, BusinessFlowModel } from '../../src/recording/business/model.js';
import type { RecordedFlowStep } from '../../src/recording/model.js';
import { runRecording } from '../../src/recording/record-orchestrator.js';
import { FakeIntelligenceProvider, proposeByName } from '../fixtures/fake-intelligence-provider.js';
import {
  startBusinessRecordingApp,
  type BusinessRecordingApp,
  type BusinessVariant,
} from '../fixtures/business-recording-app.js';

/**
 * LE PARCOURS MÉTIER OBSERVABLE de bout en bout : créer une demande, la rechercher par son numéro,
 * l'ouvrir — dans une SPA (aucun rechargement). Le flow Playwright reste intact ; l'interprétation
 * métier (business-flow.json) s'y ajoute, reliée aux étapes enregistrées.
 */
type BusinessFile = BusinessFlowModel & { events: BusinessEvent[]; memory: unknown[] };

interface Session {
  steps: RecordedFlowStep[];
  business: BusinessFile;
  flowJson: string;
  loads: number;
}

async function journey(page: Page): Promise<number> {
  const pause = (): Promise<void> => page.waitForTimeout(400);
  await page.getByRole('button', { name: 'Nouvelle demande' }).click();
  await pause();
  await page.getByLabel('Nom').fill('Martin');
  await pause();
  await page.getByLabel('Description').fill('Une description');
  await pause();
  // Deux champs « Commentaire » identiques, dans deux sections.
  await page.locator('section[aria-label="Demandeur"] input').fill('Pour le demandeur');
  await pause();
  await page.locator('section[aria-label="Bénéficiaire"] input').fill('Pour le bénéficiaire');
  await pause();
  await page.getByRole('button', { name: 'Créer' }).click();
  await page.waitForTimeout(900);
  await page.getByRole('button', { name: 'Rechercher une demande' }).click();
  await pause();
  await page.getByLabel('Numéro de demande').fill('12345');
  await pause();
  await page.getByRole('button', { name: 'Rechercher', exact: true }).click();
  await page.waitForTimeout(700);
  await page.getByRole('link', { name: /Demande 12345/ }).click();
  await page.waitForTimeout(900);
  return page.evaluate(() => (window as unknown as { __loads: number }).__loads);
}

describe('Business flow layer (CREATE → SEARCH → OPEN)', () => {
  let app: BusinessRecordingApp;
  let dir: string;
  const sessions: Partial<Record<BusinessVariant | 'ambiguous-ai', Session>> = {};

  const record = async (
    key: BusinessVariant | 'ambiguous-ai',
    provider?: FakeIntelligenceProvider,
  ): Promise<Session> => {
    app.variant = key === 'ambiguous-ai' ? 'ambiguous' : key;
    const missionFile = path.join(dir, `${key}.mission.yaml`);
    await writeFile(
      missionFile,
      `mission: { name: business-${key} }
target: { baseUrl: ${app.url}, startAt: / }
safety:
  mutations: { enabled: true, maxPerRun: 20 }
${provider ? 'ai: { enabled: true, mode: ASSIST }' : ''}
`,
    );
    let loads = 0;
    const outcome = await runRecording({
      name: `business-${key}`,
      missionFile,
      overrides: { headless: true, reportsDir: path.join(dir, 'reports') },
      env: {},
      language: 'fr',
      ...(provider ? { intelligenceProvider: provider } : {}),
      drive: async ({ page }) => {
        loads = await journey(page);
      },
    });
    const flowJson = await readFile(path.join(outcome.directory, 'recorded-flow.json'), 'utf8');
    const business = JSON.parse(
      await readFile(path.join(outcome.directory, 'business-flow.json'), 'utf8'),
    ) as BusinessFile;
    return {
      steps: (JSON.parse(flowJson) as { steps: RecordedFlowStep[] }).steps,
      business,
      flowJson,
      loads,
    };
  };

  beforeAll(async () => {
    app = await startBusinessRecordingApp();
    dir = await mkdtemp(path.join(tmpdir(), 'qa-record-business-'));
    for (const variant of ['full', 'network-only', 'dom-only', 'ambiguous'] as const)
      sessions[variant] = await record(variant);
    sessions['ambiguous-ai'] = await record(
      'ambiguous-ai',
      new FakeIntelligenceProvider(proposeByName('demande', 0.9)),
    );
  }, 400_000);

  afterAll(async () => {
    await app.close();
  });

  const chain = (session: Session | undefined): string[] =>
    (session?.business.steps ?? []).map((step) => `${step.action} ${step.entity ?? '?'}`);
  const stepLabelled = (session: Session | undefined, text: string): RecordedFlowStep[] =>
    (session?.steps ?? []).filter((step) => JSON.stringify(step.step).includes(text));

  it('TEST 1 — ENTITY_CREATED: demande, id 12345 from the network response, $created.demande.id', () => {
    const created = sessions.full?.business.events.find((event) => event.type === 'ENTITY_CREATED');
    expect(created).toMatchObject({
      entity: 'demande',
      status: 'CONFIRMED',
      output: '$created.demande.id',
      identifier: { value: '12345', source: 'network', field: 'id' },
    });
    expect(created?.evidence.network.join(' ')).toMatch(/POST \/api\/demandes → 201/);
  });

  it('TEST 2 — the search for 12345 is SEARCH_REFERENCE = $created.demande.id', () => {
    const relation = sessions.full?.business.relations.find((entry) => entry.type === 'SEARCH_REFERENCE');
    expect(relation).toMatchObject({ reference: '$created.demande.id' });
    const search = sessions.full?.business.steps.find((step) => step.action === 'search');
    expect(search).toMatchObject({ entity: 'demande', reference: '$created.demande.id' });
  });

  it('TEST 3 — CREATE → SEARCH → OPEN, each step linked to its recorded actions', () => {
    expect(chain(sessions.full)).toEqual(['create demande', 'search demande', 'open demande']);
    const ids = new Set(sessions.full?.steps.map((step) => step.id));
    for (const step of sessions.full?.business.steps ?? []) {
      expect(step.recordedActions.length).toBeGreaterThan(0);
      for (const id of step.recordedActions) expect(ids.has(id)).toBe(true);
    }
    const open = sessions.full?.business.steps.find((step) => step.action === 'open');
    expect(open?.reference).toBe('$created.demande.id');
  });

  it('TEST 4 — two identical « Commentaire » inputs keep their own context, both inside the CREATE step', () => {
    const comments = (sessions.full?.steps ?? []).filter(
      (step) =>
        step.step.kind === 'fill' &&
        (step.step as { target: { value?: string } }).target.value === 'Commentaire',
    );
    expect(comments).toHaveLength(2);
    const targets = comments.map(
      (step) => (step.step as { target: { section?: string } }).target.section ?? '',
    );
    expect(targets.some((section) => section.includes('Demandeur'))).toBe(true);
    expect(targets.some((section) => section.includes('Bénéficiaire'))).toBe(true);
    const create = sessions.full?.business.steps.find((step) => step.action === 'create');
    for (const step of comments) expect(create?.recordedActions).toContain(step.id);
  });

  it('TEST 5 — a SPA (URL changes, no reload): the opening is found through the route', () => {
    expect(sessions.full?.loads).toBe(1);
    const open = sessions.full?.business.steps.find((step) => step.action === 'open');
    expect([...(open?.evidence.dom ?? []), ...(open?.evidence.navigation ?? [])].join(' ')).toMatch(/12345/);
  });

  it('TEST 6 — the id only in the network response: still CREATE → SEARCH → OPEN', () => {
    const created = sessions['network-only']?.business.events.find(
      (event) => event.type === 'ENTITY_CREATED',
    );
    expect(created?.identifier).toMatchObject({ value: '12345', source: 'network' });
    expect(chain(sessions['network-only'])).toEqual(['create demande', 'search demande', 'open demande']);
  });

  it('TEST 7 — the id only on the screen (« Demande 12345 créée »): found in the DOM', () => {
    const created = sessions['dom-only']?.business.events.find((event) => event.type === 'ENTITY_CREATED');
    expect(created?.identifier).toMatchObject({ value: '12345', source: 'dom' });
    expect(created?.evidence.dom.join(' ')).toMatch(/créée/);
    expect(chain(sessions['dom-only'])).toEqual(['create demande', 'search demande', 'open demande']);
  });

  it('TEST 8 — two entities possible (API « dossiers », screen « demande »): AMBIGUOUS, nothing invented', () => {
    const ambiguous = sessions.ambiguous?.business;
    expect(ambiguous?.unresolved[0]).toMatchObject({
      type: 'ENTITY_CREATED',
      status: 'AMBIGUOUS',
      candidates: ['dossier', 'demande'],
    });
    // Aucun nom inventé pour la création, aucune référence $created.
    expect(ambiguous?.steps.some((step) => step.action === 'create' || step.reference !== undefined)).toBe(
      false,
    );
    // L'écriture (/api/dossiers) et la lecture (/api/demandes/12345) sont deux portées d'API : jamais
    // fusionnées d'office. La création est prouvée ; l'ouverture est une OBSERVATION (jamais « créée ») ;
    // la saisie 12345 vise l'une ou l'autre : lien non décidé.
    const provenance = (key: string): string | undefined =>
      ambiguous?.entities.find((entity) => entity.key === key)?.provenance?.classification;
    expect(provenance('entity:dossier:12345')).toBe('CREATED_DURING_RECORDING');
    expect(provenance('entity:demande:12345')).toBe('DISCOVERED_DURING_RECORDING');
    const typed = ambiguous?.entities.find((entity) => entity.linkCandidates);
    expect(typed?.provenance?.classification).toBe('UNKNOWN');
    expect(typed?.identity?.value).toBeUndefined();
    expect(ambiguous?.memory).toHaveLength(0);
  });

  it('the optional AI chooses among the observed candidates only: PROBABLE, marked AI_PROPOSAL', () => {
    const steps = sessions['ambiguous-ai']?.business.steps ?? [];
    expect(steps[0]).toMatchObject({
      action: 'create',
      entity: 'demande',
      status: 'PROBABLE',
      analyzer: 'AI_PROPOSAL',
    });
    expect(steps[0]?.confidence).toBeLessThan(0.85);
  });

  it('the Playwright flow is untouched: same recorded steps, selectors kept, no business data inside', () => {
    for (const variant of ['full', 'ambiguous'] as const) {
      const flow = sessions[variant]?.flowJson ?? '';
      expect(flow).not.toMatch(/\$created|ENTITY_CREATED|businessAction/);
      expect(stepLabelled(sessions[variant], 'Créer')).toHaveLength(1);
    }
    expect(sessions.full?.steps.length).toBe(sessions.ambiguous?.steps.length);
  });
});
