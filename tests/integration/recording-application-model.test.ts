import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApplicationInteractionModel } from '../../src/recording/application/model.js';
import type { RecordedFlowStep } from '../../src/recording/model.js';
import { runRecording } from '../../src/recording/record-orchestrator.js';
import {
  startWorkspaceRecordingApp,
  type WorkspaceRecordingApp,
  type WorkspaceVariant,
} from '../fixtures/workspace-recording-app.js';

/**
 * L'APPLICATION INTERACTION MODEL de bout en bout, sur une application à micro-frontends inconnue
 * du Recorder : shell, liste de tasks servie par un BFF, MFE en éléments personnalisés et en
 * iframe, SPA. Le flow Playwright reste intact ; application-model.json s'y ajoute.
 */
interface Session {
  model: ApplicationInteractionModel;
  steps: RecordedFlowStep[];
}

describe('Application Interaction Model (shell + task list + BFF + micro-frontends)', () => {
  let app: WorkspaceRecordingApp;
  let dir: string;
  const sessions: Record<string, Session> = {};

  const record = async (
    name: string,
    variant: WorkspaceVariant,
    drive: (page: Page) => Promise<void>,
  ): Promise<Session> => {
    app.reset();
    app.variant = variant;
    const missionFile = path.join(dir, `${name}.mission.yaml`);
    await writeFile(
      missionFile,
      `mission: { name: workspace-${name} }
target: { baseUrl: ${app.url}, startAt: / }
safety:
  mutations: { enabled: true, maxPerRun: 20 }
`,
    );
    const outcome = await runRecording({
      name: `workspace-${name}`,
      missionFile,
      overrides: { headless: true, reportsDir: path.join(dir, 'reports') },
      env: {},
      language: 'en',
      drive: async ({ page }) => {
        await drive(page);
      },
    });
    return {
      model: JSON.parse(
        await readFile(path.join(outcome.directory, 'application-model.json'), 'utf8'),
      ) as ApplicationInteractionModel,
      steps: (
        JSON.parse(await readFile(path.join(outcome.directory, 'recorded-flow.json'), 'utf8')) as {
          steps: RecordedFlowStep[];
        }
      ).steps,
    };
  };
  const pause = (page: Page, ms = 500): Promise<void> => page.waitForTimeout(ms);
  const openTasks = async (page: Page): Promise<void> => {
    await page.getByRole('button', { name: 'Tasks', exact: true }).click();
    await pause(page, 800);
  };

  beforeAll(async () => {
    app = await startWorkspaceRecordingApp();
    dir = await mkdtemp(path.join(tmpdir(), 'qa-record-workspace-'));
    // A + D : task → MFE de création → création → retour à la liste (une task de suivi porte la clé).
    sessions.created = await record('created', 'mfe', async (page) => {
      await openTasks(page);
      await page.getByRole('button', { name: 'Task 456' }).click();
      await pause(page);
      await page.getByLabel('Name').fill('Alex');
      await pause(page);
      await page.getByRole('button', { name: 'Create' }).click();
      await pause(page, 1000);
      await openTasks(page);
    });
    // C : task existante → MFE de détail → modification → enregistrement.
    sessions.updated = await record('updated', 'mfe', async (page) => {
      await openTasks(page);
      await page.getByRole('button', { name: 'Task 457' }).click();
      await pause(page, 900);
      await page.getByLabel('Description').fill('Updated by Martin');
      await pause(page);
      await page.getByRole('button', { name: 'Save' }).click();
      await pause(page, 700);
    });
    // B : recherche d'un item existant → ouverture.
    sessions.searched = await record('searched', 'mfe', async (page) => {
      await openTasks(page);
      await page.getByRole('button', { name: 'Search items' }).click();
      await pause(page);
      await page.getByLabel('Business key').fill('ABC777');
      await pause(page);
      await page.getByRole('button', { name: 'Search', exact: true }).click();
      await pause(page, 700);
      await page.getByRole('link', { name: 'Item ABC777' }).click();
      await pause(page, 900);
    });
    // I : un MFE chargé dans une iframe.
    sessions.framed = await record('framed', 'mfe', async (page) => {
      await openTasks(page);
      await page.getByRole('button', { name: 'Task 458' }).click();
      await pause(page, 1000);
    });
    // J : la même application sans éléments personnalisés (routes de SPA seulement).
    sessions.plain = await record('plain', 'plain', async (page) => {
      await openTasks(page);
      await page.getByRole('button', { name: 'Task 457' }).click();
      await pause(page, 900);
    });
  }, 400_000);

  afterAll(async () => {
    await app.close();
  });

  const kinds = (session: Session | undefined): string[] =>
    (session?.model.businessActions ?? []).map((action) => action.kind);
  const subsequence = (all: readonly string[], wanted: readonly string[]): boolean => {
    let cursor = 0;
    for (const kind of all) if (kind === wanted[cursor]) cursor += 1;
    return cursor === wanted.length;
  };

  it('TEST A + H — task → create MFE (custom element) → item ABC123: Task → Item, SELECT_TASK → SWITCH_CONTEXT → CREATE', () => {
    const model = sessions.created?.model;
    expect(model?.application.shell).toContain('app-shell');
    expect(model?.workspaces[0]).toMatchObject({
      type: 'TASK_WORKSPACE',
      source: { type: 'NETWORK', path: '/bff/tasks' },
    });
    const task = model?.tasks.find((entry) => entry.primary.value === '456');
    expect(task?.primary).toMatchObject({ type: 'TASK_ID', field: 'taskId' });
    expect(model?.contexts.find((context) => context.key === 'host:items-create')).toMatchObject({
      kind: 'HOST',
      role: 'MICROFRONTEND',
    });
    const item = model?.entities.find((entity) => entity.identity.value === 'ABC123');
    expect(item?.provenance.classification).toBe('CREATED_DURING_RECORDING');
    expect(model?.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'RESULTS_IN', source: task?.key, target: item?.key }),
        expect.objectContaining({ type: 'CREATED_BY', source: item?.key, target: 'host:items-create' }),
      ]),
    );
    expect(subsequence(kinds(sessions.created), ['SELECT_TASK', 'SWITCH_CONTEXT', 'CREATE'])).toBe(true);
  });

  it('TEST D — back to the task list: the BFF lists task 900 carrying ABC123 → CREATE_RESULT + RETRIEVE', () => {
    const model = sessions.created?.model;
    const result = model?.relationships.find((relation) => relation.type === 'CREATE_RESULT');
    expect(result?.source).toBe(model?.entities.find((entity) => entity.identity.value === 'ABC123')?.key);
    expect(result?.target).toMatch(/:900$/);
    expect(kinds(sessions.created)).toContain('RETRIEVE');
    expect(model?.workspaces[0]?.source).toMatchObject({
      bffCandidate: expect.objectContaining({ reasons: expect.any(Array) as unknown }) as unknown,
    });
  });

  it('TEST C — existing task → detail MFE → update → save: SELECT_TASK → OPEN → UPDATE → SAVE; Task REFERENCES Item', () => {
    const model = sessions.updated?.model;
    expect(subsequence(kinds(sessions.updated), ['SELECT_TASK', 'OPEN', 'UPDATE', 'SAVE'])).toBe(true);
    const task = model?.tasks.find((entry) => entry.primary.value === '457');
    expect(task?.identityCandidates.map((candidate) => candidate.type)).toEqual(['TASK_ID', 'BUSINESS_KEY']);
    expect(model?.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'REFERENCES', source: task?.key, target: 'entity:item:ABC777' }),
      ]),
    );
    expect(
      model?.entities.find((entity) => entity.key === 'entity:item:ABC777')?.provenance.classification,
    ).toBe('DISCOVERED_DURING_RECORDING');
  });

  it('TEST B — search ABC777 → open: SEARCH → OPEN, no CREATE, no task', () => {
    expect(subsequence(kinds(sessions.searched), ['SEARCH', 'OPEN'])).toBe(true);
    expect(kinds(sessions.searched)).not.toContain('CREATE');
    expect(sessions.searched?.model.tasks).toHaveLength(0);
  });

  it('TEST I — the review MFE in an iframe is a FRAME context opened by the task', () => {
    const model = sessions.framed?.model;
    const frame = model?.contexts.find((context) => context.kind === 'FRAME');
    expect(frame?.frame).toMatch(/\/mfe\/review$/);
    expect(model?.relationships).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'NAVIGATES_TO', target: frame?.key })]),
    );
  });

  it('TEST J — a SPA without custom elements: the routes are the contexts, the task is still found', () => {
    const model = sessions.plain?.model;
    expect(model?.contexts.every((context) => context.kind === 'ROUTE')).toBe(true);
    expect(model?.tasks.map((task) => task.primary.value)).toEqual(['457']);
    expect(subsequence(kinds(sessions.plain), ['SELECT_TASK', 'SWITCH_CONTEXT', 'OPEN'])).toBe(true);
  });

  it('the Playwright flow stays complete, and every business action points to recorded actions', () => {
    for (const session of Object.values(sessions)) {
      expect(session.steps.length).toBeGreaterThan(0);
      const actionIds = new Set(session.steps.flatMap((step) => step.actionIds));
      for (const action of session.model.businessActions)
        expect(action.actionIds.some((id) => actionIds.has(id))).toBe(true);
    }
    // Les saisies ne sont jamais écrites.
    expect(JSON.stringify(sessions.updated?.model)).not.toContain('Updated by Martin');
  });
});
