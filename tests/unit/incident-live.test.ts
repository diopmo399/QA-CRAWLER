import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LiveProgress, safeRunFile, type ReplayProgressEvent } from '../../src/incident/live.js';
import { IncidentService, type HostReplay, type IncidentHost } from '../../src/incident/service.js';

/**
 * LA PROGRESSION EN DIRECT D'UNE REPRODUCTION : seulement ce que le moteur annonce (début de flow, début
 * et fin d'étape), servie depuis la mémoire pendant le rejeu (la révision ne bouge pas, rien n'est écrit),
 * remplacée par les actions enregistrées à la fin ; les captures annoncées se lisent pendant le rejeu.
 */

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('LiveProgress', () => {
  it('adds a step when the engine starts it, completes it with the reported status and duration', () => {
    const live = new LiveProgress();
    expect(live.snapshot()).toBeUndefined();
    live.apply({ type: 'flow-start', at: 't0', flow: 'Créer un livre', total: 3 });
    live.apply({ type: 'step-start', at: 't1', index: 1, kind: 'goto', description: 'goto /books/new' });
    expect(live.snapshot()).toEqual({
      flow: 'Créer un livre',
      total: 3,
      current: 1,
      updatedAt: 't1',
      steps: [{ index: 1, kind: 'goto', description: 'goto /books/new', status: 'RUNNING', startedAt: 't1' }],
    });
    live.apply({
      type: 'step-end',
      at: 't2',
      index: 1,
      kind: 'goto',
      description: 'goto /books/new',
      status: 'FAILED',
      durationMs: 812.4,
      reason: 'timeout',
      screenshot: 'screenshots/step-1.png',
    });
    const after = live.snapshot();
    expect(after?.current).toBeUndefined();
    expect(after?.latestScreenshot).toBe('screenshots/step-1.png');
    expect(after?.steps[0]).toMatchObject({
      status: 'FAILED',
      durationMs: 812,
      reason: 'timeout',
      startedAt: 't1',
    });
    // Une étape non jouée (SKIPPED) n'a ni début ni durée inventés.
    live.apply({
      type: 'step-end',
      at: 't3',
      index: 3,
      kind: 'click',
      description: 'click "Enregistrer"',
      status: 'SKIPPED',
      durationMs: 0,
    });
    expect(live.snapshot()?.steps[1]?.durationMs).toBeUndefined();
    expect(live.snapshot()?.steps.map((step) => [step.index, step.status, step.startedAt])).toEqual([
      [1, 'FAILED', 't1'],
      [3, 'SKIPPED', undefined],
    ]);
  });

  it('ignores what it cannot trust: unknown status, bad index, a screenshot outside the run', () => {
    const live = new LiveProgress();
    live.apply({ type: 'step-start', at: 't1', index: 2, kind: 'click', description: 'click' });
    const end = (
      extra: Partial<Extract<ReplayProgressEvent, { type: 'step-end' }>>,
    ): ReplayProgressEvent => ({
      type: 'step-end',
      at: 't2',
      index: 2,
      kind: 'click',
      description: 'click',
      status: 'PASSED',
      durationMs: 5,
      ...extra,
    });
    live.apply(end({ status: 'DONE?' }));
    expect(live.snapshot()?.steps[0]?.status).toBe('RUNNING');
    live.apply(end({ index: 0 }));
    live.apply(end({ index: 1.5 }));
    expect(live.snapshot()?.steps).toHaveLength(1);
    live.apply(end({ screenshot: '../../etc/passwd' }));
    expect(live.snapshot()?.latestScreenshot).toBeUndefined();
    expect(live.snapshot()?.steps[0]).toMatchObject({ status: 'PASSED', durationMs: 5 });
    expect(safeRunFile('/abs/x.png')).toBeUndefined();
    expect(safeRunFile('screenshots\\a.png')).toBe('screenshots/a.png');
    expect(safeRunFile('a/../../b.png')).toBeUndefined();
  });

  it('starts over when a new flow begins', () => {
    const live = new LiveProgress();
    live.apply({ type: 'flow-start', at: 't0', flow: 'Connexion', total: 1 });
    live.apply({ type: 'step-start', at: 't1', index: 1, kind: 'fill', description: 'fill Identifiant' });
    live.apply({ type: 'flow-start', at: 't2', flow: 'Créer un livre', total: 4 });
    expect(live.snapshot()).toEqual({ flow: 'Créer un livre', total: 4, steps: [], updatedAt: 't2' });
  });
});

// ── Le service, avec un hôte qui relaie des événements contrôlés par le test ─────────────────

let projectDir: string;
let service: IncidentService;
let emit: ((event: ReplayProgressEvent) => void) | undefined;
let finish: ((outcome: Awaited<HostReplay['done']>) => void) | undefined;

beforeAll(async () => {
  projectDir = await mkdtemp(path.join(tmpdir(), 'incident-live-'));
  const runDir = (run: string): string => path.join(projectDir, 'reports', run);
  const host: IncidentHost = {
    projectId: 'catalogue',
    projectDir,
    runDir,
    replay: (input) => {
      emit = input.onProgress;
      const done = new Promise<Awaited<HostReplay['done']>>((resolve) => {
        finish = resolve;
      });
      return Promise.resolve({
        run: 'run-1',
        runDir: runDir('run-1'),
        baseUrl: 'http://catalogue.test/',
        startedAt: '2026-10-31T10:00:00.000Z',
        done,
        cancel: () => {
          finish?.({ status: 'CANCELLED' });
        },
      });
    },
    scenarioYaml: () => Promise.resolve(undefined),
    addScenario: () => Promise.reject(new Error('no library here')),
    environment: () => Promise.resolve({ baseUrl: 'http://catalogue.test/' }),
  };
  service = new IncidentService(host);
});

afterAll(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

describe('IncidentService — live reproduction', () => {
  it('serves the engine progress from memory while RUNNING, then the recorded result replaces it', async () => {
    const incident = await service.create(
      {
        title: 'Erreur 500',
        description: 'd',
        observed: 'erreur HTTP 500',
        expected: 'le livre est créé',
        severity: 'HIGH',
        scenario: 'Créer un livre',
      },
      'alice',
    );
    const started = await service.reproduce(incident.id, 'alice');
    const running = () =>
      service.incident(incident.id).then((current) => current.investigation.reproductions[0]);
    expect((await running())?.status).toBe('RUNNING');
    // Rien annoncé par le moteur : pas de progression inventée.
    expect((await running())?.live).toBeUndefined();

    emit?.({ type: 'flow-start', at: '2026-10-31T10:00:01.000Z', flow: 'Créer un livre', total: 2 });
    emit?.({
      type: 'step-start',
      at: '2026-10-31T10:00:01.100Z',
      index: 1,
      kind: 'goto',
      description: 'goto /books/new',
    });
    expect((await running())?.live).toMatchObject({
      flow: 'Créer un livre',
      total: 2,
      current: 1,
      steps: [{ index: 1, status: 'RUNNING', startedAt: '2026-10-31T10:00:01.100Z' }],
    });

    // Le moteur a écrit une capture pour l'étape : elle se lit pendant le rejeu.
    await mkdir(path.join(projectDir, 'reports', 'run-1', 'screenshots'), { recursive: true });
    await writeFile(
      path.join(projectDir, 'reports', 'run-1', 'screenshots', 'step-1.png'),
      Buffer.from(PNG_1X1, 'base64'),
    );
    emit?.({
      type: 'step-end',
      at: '2026-10-31T10:00:02.000Z',
      index: 1,
      kind: 'goto',
      description: 'goto /books/new',
      status: 'PASSED',
      durationMs: 900,
      screenshot: 'screenshots/step-1.png',
    });
    const live = (await running())?.live;
    expect(live?.steps[0]).toMatchObject({ status: 'PASSED', durationMs: 900 });
    expect(live?.current).toBeUndefined();
    expect(live?.latestScreenshot).toBe('screenshots/step-1.png');
    const shot = await service.screenshot(incident.id, 'rep_1', 'screenshots/step-1.png');
    expect(shot.dataUrl).toBe(`data:image/png;base64,${PNG_1X1}`);
    await expect(service.screenshot(incident.id, 'rep_1', 'screenshots/other.png')).rejects.toThrow(
      /not found/,
    );

    // Rien n'est écrit pendant le rejeu : même révision, aucune progression dans le fichier.
    const stored = await readFile(path.join(projectDir, 'incidents', `${incident.id}.json`), 'utf8');
    expect(stored).not.toContain('"live"');
    expect((await service.incident(incident.id)).revision).toBe(started.revision);

    finish?.({ status: 'FAILED', error: 'engine stopped' });
    await service.settle();
    const done = (await service.incident(incident.id)).investigation.reproductions[0];
    expect(done?.status).toBe('FAILED');
    expect(done?.live).toBeUndefined();
    // Après la fin, la capture n'est lisible que si le résultat enregistré la cite.
    await expect(service.screenshot(incident.id, 'rep_1', 'screenshots/step-1.png')).rejects.toThrow(
      /not found/,
    );
  });
});
