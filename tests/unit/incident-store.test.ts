import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  canTransition,
  IncidentConflictError,
  IncidentNotFoundError,
  IncidentStateError,
  IncidentStore,
  IncidentValidationError,
} from '../../src/incident/incident-store.js';
import type { IncidentInput, ReproductionRun } from '../../src/incident/model.js';

/**
 * LE STOCKAGE DES INCIDENTS : création et relecture par une autre instance, écriture atomique,
 * validation de la saisie, révisions (409), historique, table des transitions, annulation et
 * reprise, et modifications concurrentes sérialisées.
 */
let workspace: string;
let projectDir: string;
let clock = Date.parse('2026-10-01T08:00:00.000Z');
const now = (): Date => {
  clock += 1000;
  return new Date(clock);
};

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'qa-incident-store-'));
  projectDir = path.join(workspace, 'project-books');
});

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

const input = (extra: Partial<IncidentInput> = {}): IncidentInput => ({
  title: 'Erreur 500 à la création d’un livre',
  description:
    'Lors de la création d’un livre, après avoir cliqué sur Enregistrer, une erreur HTTP 500 apparaît.',
  observed: 'Erreur HTTP 500 après Enregistrer',
  expected: 'Le livre est créé',
  severity: 'HIGH',
  ...extra,
});

const scopedInput = (): IncidentInput =>
  input({
    scenario: 'Créer un livre',
    scope: {
      applications: [
        {
          id: 'bff',
          name: 'Books BFF',
          layer: 'BFF',
          repository: { root: path.join(workspace, 'bff'), include: [] },
        },
      ],
    },
  });

const run = (reproduced: boolean | null): ReproductionRun => ({
  id: `rep_${String(reproduced)}`,
  startedAt: new Date(clock).toISOString(),
  status: 'COMPLETED',
  target: 'LOCAL',
  scenario: 'Créer un livre',
  reproduced,
  actions: [],
  requests: [],
  evidence: [],
  screenshots: [],
});

describe('IncidentStore — création et relecture', () => {
  it('creates a DRAFT incident with safe defaults, persisted atomically and reloaded by another instance', async () => {
    const store = new IncidentStore(projectDir, { now });
    const incident = await store.create('books', input(), 'analyst');
    expect(incident.id).toMatch(/^inc_[A-Za-z0-9_-]{12}$/);
    expect(incident).toMatchObject({
      projectId: 'books',
      state: 'DRAFT',
      revision: 1,
      execution: { target: 'LOCAL' },
      createdBy: 'analyst',
      investigation: { reproductions: [], hypotheses: [], experiments: [] },
    });
    expect(incident.scope.mode).toBe('GUIDED');
    expect(incident.scope.permissions.sideEffects).toBe(false);
    expect(incident.history).toEqual([
      { at: incident.createdAt, actor: 'analyst', kind: 'CREATED', message: expect.any(String) as string },
    ]);

    const files = await readdir(path.join(projectDir, 'incidents'));
    expect(files).toEqual([`${incident.id}.json`]);
    const onDisk = JSON.parse(
      await readFile(path.join(projectDir, 'incidents', `${incident.id}.json`), 'utf8'),
    ) as unknown;
    expect(onDisk).toEqual(incident);
    expect(await new IncidentStore(projectDir).get(incident.id)).toEqual(incident);
  });

  it('is SCOPED when the scope has an application and a scenario', async () => {
    const store = new IncidentStore(projectDir, { now });
    const incident = await store.create('books', scopedInput(), 'analyst');
    expect(incident.state).toBe('SCOPED');
    expect(incident.scope.scenarios).toEqual(['Créer un livre']);
  });

  it('validates the input and never takes extensions from it', async () => {
    const store = new IncidentStore(projectDir, { now });
    await expect(store.create('books', input({ title: '  ' }), 'qa')).rejects.toBeInstanceOf(
      IncidentValidationError,
    );
    await expect(
      store.create('books', { ...input(), severity: 'URGENT' } as unknown as IncidentInput, 'qa'),
    ).rejects.toThrow(/severity/);
    await expect(store.create('books', input({ execution: { target: 'ARO' } }), 'qa')).rejects.toThrow(/aro/);
    await expect(store.create('books', input({ scope: { depth: 9 } }), 'qa')).rejects.toBeInstanceOf(
      IncidentValidationError,
    );
    await expect(
      store.create('books', input({ scope: { limits: { maxFiles: 10_000_000 } as never } }), 'qa'),
    ).rejects.toBeInstanceOf(IncidentValidationError);
    const created = await store.create(
      'books',
      input({
        scope: {
          extensions: [
            {
              id: 'ext_forged',
              kind: 'ALLOW_SIDE_EFFECTS',
              target: 'x',
              reason: 'x',
              status: 'APPROVED',
              requestedAt: '',
              requestedBy: 'x',
            },
          ],
        },
      }),
      'qa',
    );
    expect(created.scope.extensions).toEqual([]);
  });

  it('lists the most recently updated first and ignores unreadable files', async () => {
    const dir = path.join(workspace, 'project-list');
    const store = new IncidentStore(dir, { now });
    expect(await store.list()).toEqual([]);
    const first = await store.create('books', input({ title: 'Premier' }), 'qa');
    const second = await store.create('books', input({ title: 'Second' }), 'qa');
    expect((await store.list()).map((summary) => summary.id)).toEqual([second.id, first.id]);
    await store.update(first.id, 1, { severity: 'CRITICAL' }, 'qa');
    await writeFile(path.join(dir, 'incidents', 'inc_broken00000.json'), '{ not json', 'utf8');
    const summaries = await store.list();
    expect(summaries.map((summary) => summary.id)).toEqual([first.id, second.id]);
    expect(summaries[0]).toMatchObject({
      title: 'Premier',
      severity: 'CRITICAL',
      state: 'DRAFT',
      target: 'LOCAL',
    });
    expect(await store.get('../../etc/passwd')).toBeUndefined();
    expect(await store.get('inc_000000000000')).toBeUndefined();
  });
});

describe('IncidentStore — révisions et historique', () => {
  it('updates on the read revision, refuses a stale one (409) and records the history', async () => {
    const store = new IncidentStore(projectDir, { now });
    const created = await store.create('books', input(), 'analyst');
    const updated = await store.update(
      created.id,
      1,
      { expected: 'Le livre apparaît dans le catalogue' },
      'lead',
    );
    expect(updated.revision).toBe(2);
    expect(updated.expected).toBe('Le livre apparaît dans le catalogue');
    expect(updated.updatedAt > created.updatedAt).toBe(true);
    expect(updated.history.at(-1)).toMatchObject({
      kind: 'UPDATED',
      actor: 'lead',
      message: 'Modifié : expected.',
    });

    await expect(store.update(created.id, 1, { severity: 'LOW' }, 'other')).rejects.toBeInstanceOf(
      IncidentConflictError,
    );
    await expect(store.update('inc_000000000000', 1, { severity: 'LOW' }, 'qa')).rejects.toBeInstanceOf(
      IncidentNotFoundError,
    );
    await expect(store.update(created.id, 2, { title: '' }, 'qa')).rejects.toBeInstanceOf(
      IncidentValidationError,
    );

    // Le périmètre complété fait passer l'incident à SCOPED (événements SCOPE puis STATE).
    const scoped = await store.update(
      created.id,
      2,
      {
        scenario: 'Créer un livre',
        scope: {
          applications: scopedInput().scope?.applications ?? [],
          permissions: { readLogs: true } as never,
          extensions: [],
        },
      },
      'lead',
    );
    expect(scoped.revision).toBe(3);
    expect(scoped.state).toBe('SCOPED');
    expect(scoped.scope.permissions).toMatchObject({ readLogs: true, readSources: true, sideEffects: false });
    expect(scoped.history.map((event) => event.kind)).toEqual([
      'CREATED',
      'UPDATED',
      'UPDATED',
      'SCOPE',
      'STATE',
    ]);
    expect((await new IncidentStore(projectDir).get(created.id))?.revision).toBe(3);
  });
});

describe('IncidentStore — états', () => {
  it('follows the transition table', async () => {
    const store = new IncidentStore(projectDir, { now });
    const draft = await store.create('books', input(), 'qa');
    await expect(store.transition(draft.id, 'REPRODUCING', 'qa', 'go')).rejects.toBeInstanceOf(
      IncidentStateError,
    );
    const incident = await store.create('books', scopedInput(), 'qa');
    for (const state of [
      'REPRODUCING',
      'REPRODUCED',
      'INVESTIGATING',
      'DIAGNOSED',
      'INVESTIGATING',
      'INCONCLUSIVE',
    ] as const) {
      const next = await store.transition(incident.id, state, 'qa', `vers ${state}`);
      expect(next.state).toBe(state);
    }
    const after = await store.get(incident.id);
    expect(after?.revision).toBe(7);
    expect(after?.history.filter((event) => event.kind === 'STATE').map((event) => event.message)).toEqual([
      'SCOPED → REPRODUCING : vers REPRODUCING',
      'REPRODUCING → REPRODUCED : vers REPRODUCED',
      'REPRODUCED → INVESTIGATING : vers INVESTIGATING',
      'INVESTIGATING → DIAGNOSED : vers DIAGNOSED',
      'DIAGNOSED → INVESTIGATING : vers INVESTIGATING',
      'INVESTIGATING → INCONCLUSIVE : vers INCONCLUSIVE',
    ]);
    await expect(store.transition(incident.id, 'DRAFT', 'qa', 'x')).rejects.toThrow(/INCONCLUSIVE → DRAFT/);
    expect(canTransition('FAILED', 'SCOPED')).toBe(true);
    expect(canTransition('DIAGNOSED', 'DRAFT')).toBe(false);
    expect(canTransition('CANCELLED', 'SCOPED')).toBe(false);
  });

  it('cancels from any non-final state and resumes to the stable state', async () => {
    const store = new IncidentStore(projectDir, { now });
    const incident = await store.create('books', scopedInput(), 'qa');
    const cancelled = await store.cancel(incident.id, 'lead');
    expect(cancelled).toMatchObject({ state: 'CANCELLED', cancelledFrom: 'SCOPED' });
    await expect(store.cancel(incident.id, 'lead')).rejects.toBeInstanceOf(IncidentStateError);
    await expect(store.transition(incident.id, 'REPRODUCING', 'qa', 'x')).rejects.toBeInstanceOf(
      IncidentStateError,
    );
    await expect(
      store.update(incident.id, cancelled.revision, { severity: 'LOW' }, 'qa'),
    ).rejects.toBeInstanceOf(IncidentStateError);
    const resumed = await store.resume(incident.id, 'lead');
    expect(resumed.state).toBe('SCOPED');
    expect(resumed.cancelledFrom).toBeUndefined();
    expect(resumed.history.slice(-2).map((event) => event.kind)).toEqual(['CANCELLED', 'RESUMED']);
    await expect(store.resume(incident.id, 'lead')).rejects.toBeInstanceOf(IncidentStateError);

    // Une reproduction en cours reprend à SCOPED.
    await store.transition(incident.id, 'REPRODUCING', 'qa', 'go');
    await store.cancel(incident.id, 'lead');
    expect((await store.resume(incident.id, 'lead')).state).toBe('SCOPED');

    // Une investigation en cours reprend à l'état stable de la dernière reproduction.
    await store.transition(incident.id, 'REPRODUCING', 'qa', 'go');
    await store.mutate(
      incident.id,
      'engine',
      (current) => {
        current.investigation.reproductions.push(run(true));
        current.state = 'REPRODUCED';
      },
      { kind: 'REPRODUCTION', message: 'Symptôme reproduit.' },
    );
    await store.transition(incident.id, 'INVESTIGATING', 'qa', 'analyse');
    const viaTransition = await store.transition(incident.id, 'CANCELLED', 'lead', 'stop');
    expect(viaTransition.cancelledFrom).toBe('INVESTIGATING');
    expect((await store.resume(incident.id, 'lead')).state).toBe('REPRODUCED');

    // Un état stable est retrouvé tel quel.
    await store.transition(incident.id, 'INVESTIGATING', 'qa', 'analyse');
    await store.transition(incident.id, 'DIAGNOSED', 'qa', 'cause trouvée');
    await store.cancel(incident.id, 'lead');
    expect((await store.resume(incident.id, 'lead')).state).toBe('DIAGNOSED');
  });
});

describe('IncidentStore — mutate', () => {
  it('serializes concurrent mutations, even across store instances', async () => {
    const store = new IncidentStore(projectDir, { now });
    const other = new IncidentStore(projectDir, { now });
    const incident = await store.create('books', scopedInput(), 'qa');
    const count = 20;
    const results = await Promise.all(
      Array.from({ length: count }, (_, index) =>
        (index % 2 === 0 ? store : other).mutate(
          incident.id,
          `worker-${index}`,
          async (current) => {
            const seen = current.investigation.hypotheses.length;
            await new Promise((resolve) => setTimeout(resolve, (index * 7) % 5));
            current.investigation.hypotheses.push({
              id: `hyp_${index}`,
              title: `Hypothèse ${index} (vue après ${seen})`,
              description: '',
              suspectedCause: '',
              layer: 'BACKEND',
              files: [],
              supporting: [],
              contradicting: [],
              confidence: 0.1,
              verifications: [],
              status: 'PROPOSED',
            });
          },
          { kind: 'HYPOTHESES', message: `hypothèse ${index}` },
        ),
      ),
    );
    expect(results.map((result) => result.revision).sort((a, b) => a - b)).toEqual(
      Array.from({ length: count }, (_, index) => index + 2),
    );
    const final = await store.get(incident.id);
    expect(final?.revision).toBe(count + 1);
    expect(final?.investigation.hypotheses.map((hypothesis) => hypothesis.id).sort()).toEqual(
      Array.from({ length: count }, (_, index) => `hyp_${index}`).sort(),
    );
    // Chaque modification a vu toutes les précédentes.
    expect(
      final?.investigation.hypotheses.map((hypothesis) =>
        hypothesis.title.replace(/^.*après (\d+)\)$/, '$1'),
      ),
    ).toEqual(Array.from({ length: count }, (_, index) => String(index)));
    expect(final?.history.filter((event) => event.kind === 'HYPOTHESES')).toHaveLength(count);
    const leftovers = (await readdir(path.join(projectDir, 'incidents'))).filter((name) =>
      name.endsWith('.tmp'),
    );
    expect(leftovers).toEqual([]);
  });

  it('keeps identity and history under its control, checks state changes and persists nothing on failure', async () => {
    const store = new IncidentStore(projectDir, { now });
    const incident = await store.create('books', scopedInput(), 'qa');
    const changed = await store.mutate(
      incident.id,
      'engine',
      (current) => {
        current.id = 'inc_hijacked0000';
        current.revision = 99;
        current.history = [];
        current.createdBy = 'someone';
        current.title = 'Titre revu';
      },
      { kind: 'UPDATED', message: 'titre' },
    );
    expect(changed).toMatchObject({ id: incident.id, revision: 2, createdBy: 'qa', title: 'Titre revu' });
    expect(changed.history.map((event) => event.kind)).toEqual(['CREATED', 'UPDATED']);

    await expect(
      store.mutate(
        incident.id,
        'engine',
        () => {
          throw new Error('échec du moteur');
        },
        { kind: 'REPRODUCTION', message: 'x' },
      ),
    ).rejects.toThrow('échec du moteur');
    await expect(
      store.mutate(
        incident.id,
        'engine',
        (current) => {
          current.state = 'DIAGNOSED';
        },
        { kind: 'DIAGNOSIS', message: 'x' },
      ),
    ).rejects.toBeInstanceOf(IncidentStateError);
    await expect(
      store.mutate(
        incident.id,
        'engine',
        (current) => {
          current.state = 'CANCELLED';
        },
        { kind: 'STATE', message: 'x' },
      ),
    ).rejects.toBeInstanceOf(IncidentStateError);
    expect((await store.get(incident.id))?.revision).toBe(2);

    const moved = await store.mutate(
      incident.id,
      'engine',
      (current) => {
        current.state = 'REPRODUCING';
      },
      { kind: 'REPRODUCTION', message: 'Reproduction lancée.' },
    );
    expect(moved.state).toBe('REPRODUCING');
    expect(moved.history.slice(-2).map((event) => event.kind)).toEqual(['REPRODUCTION', 'STATE']);
    await expect(
      store.mutate('inc_000000000000', 'x', () => undefined, { kind: 'UPDATED', message: 'x' }),
    ).rejects.toBeInstanceOf(IncidentNotFoundError);
  });
});
