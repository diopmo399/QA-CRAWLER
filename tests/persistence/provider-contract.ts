import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  CrawlRunRecord,
  RunStateRecord,
  RunTransitionRecord,
  TransitionObservation,
} from '../../src/persistence/model.js';
import type { PersistenceProvider } from '../../src/persistence/persistence-provider.js';

/**
 * CONTRAT COMMUN des providers de persistance : mémoire, fichier, SQLite, PostgreSQL,
 * SQL Server doivent tous se comporter exactement de la même façon ici. C'est ce qui
 * rend un provider réellement interchangeable.
 */
export interface ContractTarget {
  /** Un provider neuf, prêt à être initialisé (le même stockage à chaque appel pour `durable`). */
  create(): Promise<PersistenceProvider> | PersistenceProvider;
  /** Les données survivent-elles à un nouveau provider sur le même stockage ? */
  durable: boolean;
}

export function persistenceProviderContract(name: string, target: ContractTarget): void {
  describe(`persistence provider contract: ${name}`, () => {
    let provider: PersistenceProvider;
    // Chaque exécution a ses propres identifiants : une base partagée entre plusieurs exécutions reste valable.
    const app = `app-${randomUUID().slice(0, 8)}`;
    const other = `${app}-other`;

    beforeAll(async () => {
      provider = await target.create();
      await provider.initialize();
    });
    afterAll(async () => {
      await provider.close();
    });

    const run = (overrides: Partial<CrawlRunRecord> = {}): CrawlRunRecord => ({
      id: randomUUID(),
      applicationId: app,
      missionName: 'contract',
      environment: 'test',
      branch: 'main',
      commitSha: 'abc123',
      crawlerVersion: '0.1.0',
      mode: 'explore',
      startedAt: '2026-01-01T10:00:00.000Z',
      status: 'RUNNING',
      statesCount: 0,
      actionsCount: 0,
      transitionsCount: 0,
      anomaliesCount: 0,
      ...overrides,
    });
    const observation = (overrides: Partial<TransitionObservation> = {}): TransitionObservation => ({
      applicationId: app,
      fromStateSignature: 'users',
      actionSignature: 'click:create',
      toStateSignature: 'create-form',
      seen: 1,
      success: 1,
      failure: 0,
      blocked: 0,
      durationTotalMs: 100,
      durationCount: 1,
      firstSeenAt: '2026-01-01T10:00:00.000Z',
      lastSeenAt: '2026-01-01T10:00:00.000Z',
      ...overrides,
    });

    it('health check: connected', async () => {
      const health = await provider.healthCheck();
      expect(health.status).toBe('CONNECTED');
      expect(health.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('crawl_run: create, read, update, list the most recent first, per application', async () => {
      const first = run({ startedAt: '2026-01-01T10:00:00.000Z' });
      const second = run({
        startedAt: '2026-01-02T10:00:00.000Z',
        environment: undefined,
        branch: undefined,
      });
      await provider.runs.create(first);
      await provider.runs.create(second);
      await provider.runs.create(run({ applicationId: other }));
      expect(await provider.runs.get(first.id)).toEqual(first);
      await provider.runs.update(first.id, {
        status: 'COMPLETED',
        finishedAt: '2026-01-01T10:05:00.000Z',
        statesCount: 4,
        actionsCount: 9,
        transitionsCount: 8,
        anomaliesCount: 1,
      });
      expect(await provider.runs.get(first.id)).toEqual({
        ...first,
        status: 'COMPLETED',
        finishedAt: '2026-01-01T10:05:00.000Z',
        statesCount: 4,
        actionsCount: 9,
        transitionsCount: 8,
        anomaliesCount: 1,
      });
      const listed = await provider.runs.list(app, 10);
      expect(listed.map((entry) => entry.id)).toEqual([second.id, first.id]);
      expect(listed[0]).toEqual(second);
      expect(await provider.runs.list(app, 1)).toHaveLength(1);
      expect(await provider.runs.get(randomUUID())).toBeUndefined();
    });

    it('crawl_run: the same id twice is refused', async () => {
      const once = run();
      await provider.runs.create(once);
      await expect(provider.runs.create(once)).rejects.toThrow();
    });

    it('run_state: saved once per run and state, id and first sighting kept, context round-trips', async () => {
      const owner = run();
      await provider.runs.create(owner);
      const state: RunStateRecord = {
        id: randomUUID(),
        runId: owner.id,
        stateSignature: 'users',
        stateId: 'users-1a2b3c4d',
        routePattern: '/users',
        urlNormalized: 'http://app.test/users',
        title: 'Users',
        heading: 'Users',
        depth: 1,
        firstSeenAt: '2026-01-01T10:00:00.000Z',
        lastSeenAt: '2026-01-01T10:00:00.000Z',
        context: { headings: ['Users'], patterns: ['CRUD_LIST'], actions: 3 },
      };
      await provider.states.save([state]);
      await provider.states.save([
        {
          ...state,
          id: randomUUID(),
          firstSeenAt: '2026-01-01T11:00:00.000Z',
          lastSeenAt: '2026-01-01T11:00:00.000Z',
          depth: 1,
        },
      ]);
      const saved = await provider.states.listByRun(owner.id);
      expect(saved).toEqual([{ ...state, lastSeenAt: '2026-01-01T11:00:00.000Z' }]);
      expect(await provider.states.listByRun(randomUUID())).toEqual([]);
    });

    it('run_transition: with and without a destination (blocked), optional fields kept', async () => {
      const owner = run();
      await provider.runs.create(owner);
      const success: RunTransitionRecord = {
        id: randomUUID(),
        runId: owner.id,
        fromStateId: 'users-1',
        toStateId: 'create-form-2',
        actionId: 'a-1',
        actionSignature: 'click:create',
        actionType: 'click',
        actionLabel: 'Create',
        status: 'SUCCESS',
        safetyClass: 'MUTATION',
        safetyDecision: 'ALLOW',
        oracleStatus: 'PASS',
        durationMs: 120,
        startedAt: '2026-01-01T10:00:00.000Z',
        finishedAt: '2026-01-01T10:00:00.120Z',
      };
      const blocked: RunTransitionRecord = {
        ...success,
        id: randomUUID(),
        toStateId: null,
        actionId: 'a-2',
        actionSignature: 'click:delete',
        actionLabel: 'Delete',
        status: 'BLOCKED',
        safetyClass: 'DANGEROUS',
        safetyDecision: 'BLOCK',
        oracleStatus: undefined,
        durationMs: undefined,
      };
      await provider.transitions.add([success, blocked]);
      const saved = await provider.transitions.listByRun(owner.id);
      expect(saved.sort((a, b) => a.actionId.localeCompare(b.actionId))).toEqual([
        success,
        Object.fromEntries(Object.entries(blocked).filter(([, value]) => value !== undefined)),
      ]);
    });

    it('transition_knowledge: increments, several destinations for the same action, weighted average duration', async () => {
      await provider.knowledge.record([
        observation(),
        observation({ durationTotalMs: 300, lastSeenAt: '2026-01-02T10:00:00.000Z' }),
      ]);
      await provider.knowledge.record([
        observation({
          toStateSignature: 'login',
          success: 1,
          durationTotalMs: 50,
          firstSeenAt: '2026-01-03T10:00:00.000Z',
          lastSeenAt: '2026-01-03T10:00:00.000Z',
        }),
        observation({
          toStateSignature: '(none)',
          success: 0,
          blocked: 1,
          durationTotalMs: 0,
          durationCount: 0,
        }),
      ]);
      const rows = await provider.knowledge.find(app, 'users', 'click:create');
      const byTarget = Object.fromEntries(rows.map((row) => [row.toStateSignature, row]));
      expect(Object.keys(byTarget).sort()).toEqual(['(none)', 'create-form', 'login']);
      expect(byTarget['create-form']).toEqual({
        applicationId: app,
        fromStateSignature: 'users',
        actionSignature: 'click:create',
        toStateSignature: 'create-form',
        seenCount: 2,
        successCount: 2,
        failureCount: 0,
        blockedCount: 0,
        averageDurationMs: 200,
        firstSeenAt: '2026-01-01T10:00:00.000Z',
        lastSeenAt: '2026-01-02T10:00:00.000Z',
      });
      expect(byTarget['(none)']).toMatchObject({ seenCount: 1, successCount: 0, blockedCount: 1 });
      expect(byTarget['(none)']?.averageDurationMs).toBeUndefined();
      // Une autre observation vers la même destination : la moyenne reste pondérée par les exécutions.
      await provider.knowledge.record([
        observation({ durationTotalMs: 500, lastSeenAt: '2026-01-04T10:00:00.000Z' }),
      ]);
      const [again] = (await provider.knowledge.find(app, 'users', 'click:create')).filter(
        (row) => row.toStateSignature === 'create-form',
      );
      expect(again).toMatchObject({ seenCount: 3, successCount: 3, averageDurationMs: 300 });
    });

    it('transition_knowledge: a batch with an invalid observation is not applied at all', async () => {
      const before = await provider.knowledge.find(app, 'users', 'click:create');
      await expect(
        provider.knowledge.record([observation(), observation({ toStateSignature: 'x'.repeat(500) })]),
      ).rejects.toThrow();
      expect(await provider.knowledge.find(app, 'users', 'click:create')).toEqual(before);
    });

    it('transition_knowledge: load returns the most recent rows first, within the limit, per application', async () => {
      await provider.knowledge.record([
        observation({
          applicationId: other,
          fromStateSignature: 'a',
          lastSeenAt: '2026-02-01T00:00:00.000Z',
        }),
        observation({
          applicationId: other,
          fromStateSignature: 'b',
          lastSeenAt: '2026-03-01T00:00:00.000Z',
        }),
        observation({
          applicationId: other,
          fromStateSignature: 'c',
          lastSeenAt: '2026-01-15T00:00:00.000Z',
        }),
      ]);
      const loaded = await provider.knowledge.load(other, 2);
      expect(loaded.map((row) => row.fromStateSignature)).toEqual(['b', 'a']);
      expect((await provider.knowledge.load(app, 100)).every((row) => row.applicationId === app)).toBe(true);
    });

    it('transition_knowledge: the context of the most recent observation round-trips (migration 003)', async () => {
      const context = { environment: 'test', actor: 'admin', version: 'v1', browser: 'chromium' };
      await provider.knowledge.record([
        observation({
          fromStateSignature: 'ctx',
          lastSeenAt: '2026-05-02T00:00:00.000Z',
          lastContext: { ...context, viewportClass: 'desktop' },
        }),
      ]);
      // Une observation plus ancienne ne remplace pas le contexte le plus récent.
      await provider.knowledge.record([
        observation({
          fromStateSignature: 'ctx',
          lastSeenAt: '2026-05-01T00:00:00.000Z',
          lastContext: { ...context, actor: 'user' },
        }),
      ]);
      const [row] = await provider.knowledge.find(app, 'ctx', 'click:create');
      expect(row?.lastContext).toEqual({ ...context, viewportClass: 'desktop' });
      await provider.knowledge.record([
        observation({
          fromStateSignature: 'ctx',
          lastSeenAt: '2026-05-03T00:00:00.000Z',
          lastContext: { ...context, version: 'v2' },
        }),
      ]);
      const [newer] = await provider.knowledge.find(app, 'ctx', 'click:create');
      expect(newer).toMatchObject({ seenCount: 3, lastContext: { ...context, version: 'v2' } });
      const [none] = await provider.knowledge.find(app, 'users', 'click:create');
      expect(none?.lastContext).toBeUndefined();
    });

    if (target.durable)
      it('durable: a new provider on the same storage sees everything', async () => {
        const again = await target.create();
        await again.initialize();
        try {
          expect((await again.runs.list(app, 100)).length).toBeGreaterThanOrEqual(3);
          const rows = await again.knowledge.find(app, 'users', 'click:create');
          expect(rows.find((row) => row.toStateSignature === 'create-form')?.seenCount).toBe(3);
        } finally {
          await again.close();
        }
      });
  });
}
