import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createQaCrawler,
  QaCrawlerError,
  type Project,
  type QaCrawlerClient,
} from '../../src/sdk/core/index.js';
import { actionOf, rightFor } from '../../src/sdk/server/access.js';
import { engineDefaults } from '../../src/sdk/server/project.js';
import { startSdkServer, type RunningSdkServer } from '../../src/sdk/server/server.js';
import { buildDocx, wp } from '../fixtures/office-builder.js';

/**
 * LES ACCÈS par le vrai serveur : jetons nominatifs (jamais conservés en clair), rôles de l'espace
 * et par projet, droits vérifiés par le serveur à chaque appel (un rejeu avec écritures demande plus
 * qu'un rejeu en lecture seule), auteur des décisions tiré du jeton, révocation, journal sans valeur
 * saisie ; la page en mode nominatif ne porte aucun jeton.
 */
let server: RunningSdkServer;
let workspace: string;
let service: QaCrawlerClient;
let project: Project;
const clients: QaCrawlerClient[] = [];

const as = (token: string): QaCrawlerClient => {
  const client = createQaCrawler({ endpoint: `${server.url}/api`, token });
  clients.push(client);
  return client;
};

const refusal = async (call: Promise<unknown>): Promise<string> => {
  const error = await call.catch((caught: unknown) => caught);
  return error instanceof QaCrawlerError ? `${String(error.status)} ${error.code}` : 'accepted';
};

const SPEC = buildDocx(
  [
    wp('Exigences', { style: 'Heading2' }),
    wp('REQ-701 Le système doit enregistrer une demande avec son titre secret-word-in-text.'),
  ].join(''),
  { title: 'Spécification fictive' },
);

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'sdk-access-'));
  server = await startSdkServer({ workspace, language: 'fr', access: 'named', env: {} });
  service = as(server.token);
  project = await service.projects.create({
    ...engineDefaults(),
    project: { name: 'Demandes', targetUrl: 'http://127.0.0.1:9/', framework: 'other' },
  });
});

afterAll(async () => {
  for (const client of clients) client.dispose();
  await server.close();
  await rm(workspace, { recursive: true, force: true });
});

describe('access — named tokens, roles and journal', () => {
  let reader: QaCrawlerClient;
  let analyst: QaCrawlerClient;
  let pilot: QaCrawlerClient;
  let readerId = '';
  let readerToken = '';

  it('the service token is the administrator; members get a token once, stored only as a digest', async () => {
    expect(await service.access.me()).toMatchObject({ kind: 'SERVICE', role: 'ADMIN', mode: 'named' });
    const created = await service.access.createMember({ name: 'Camille R.', role: 'READER' });
    readerId = created.member.id;
    readerToken = created.token;
    expect(created.token).toMatch(/^qa_[A-Za-z0-9_-]{43}$/);
    analyst = as((await service.access.createMember({ name: 'Noa P.', role: 'ANALYST' })).token);
    pilot = as((await service.access.createMember({ name: 'Sam L.', role: 'PILOT' })).token);
    reader = as(readerToken);
    const members = await service.access.members();
    expect(members.map((member) => [member.name, member.role])).toEqual([
      ['Camille R.', 'READER'],
      ['Noa P.', 'ANALYST'],
      ['Sam L.', 'PILOT'],
    ]);
    expect(JSON.stringify(members)).not.toContain('qa_');
    const stored = await readFile(path.join(workspace, '.qa-access', 'members.json'), 'utf8');
    expect(stored).not.toContain(readerToken);
    expect(stored).toContain('"tokenHash"');
    expect(await refusal(service.access.createMember({ name: '', role: 'READER' }))).toBe(
      '400 INVALID_INPUT',
    );
    expect(await refusal(service.access.createMember({ name: 'X', role: 'OWNER' as 'ADMIN' }))).toBe(
      '400 INVALID_INPUT',
    );
  });

  it('each role gets its rights, checked by the server', async () => {
    expect(await reader.access.me()).toMatchObject({ name: 'Camille R.', kind: 'MEMBER', rights: ['VIEW'] });
    expect((await reader.projects.list()).map((entry) => entry.id)).toEqual([project.id]);
    expect(await refusal(reader.access.members())).toBe('403 FORBIDDEN');
    expect(
      await refusal(
        reader.environments.create(project.id, {
          name: 'Recette',
          kind: 'TEST',
          baseUrl: 'http://127.0.0.1:9',
        }),
      ),
    ).toBe('403 FORBIDDEN');
    expect(
      await refusal(
        analyst.environments.create(project.id, {
          name: 'Recette',
          kind: 'TEST',
          baseUrl: 'http://127.0.0.1:9',
        }),
      ),
    ).toBe('403 FORBIDDEN');
    expect(await refusal(pilot.projects.archive(project.id))).toBe('403 FORBIDDEN');
  });

  it('a run with writes needs more than a read-only run: refused to an analyst before anything starts', async () => {
    const writes = await service.environments.create(project.id, {
      name: 'Recette',
      kind: 'TEST',
      baseUrl: 'http://127.0.0.1:9',
      mutations: { enabled: true, maxPerRun: 2 },
    });
    expect(await refusal(analyst.executions.start(project.id, { environmentId: writes.id }))).toBe(
      '403 FORBIDDEN',
    );
    // Le pilote a le droit : la requête passe le contrôle des droits (le projet n'a pas de scénario).
    expect(await refusal(pilot.executions.start(project.id, { environmentId: writes.id }))).toBe(
      '409 NO_SCENARIO',
    );
    expect(await refusal(reader.executions.start(project.id))).toBe('403 FORBIDDEN');
  });

  it('decisions are signed by the token, never by what the caller declares; publishing needs PUBLISH', async () => {
    const batch = await analyst.requirements.importFile(project.id, {
      connector: 'WORD',
      name: 'spec.docx',
      data: new Uint8Array(SPEC),
    });
    const item = batch.items.find((candidate) => candidate.externalId === 'REQ-701');
    const decided = await analyst.requirements.decide(project.id, batch.id, [
      { itemId: item?.id ?? '', decision: { action: 'ACCEPT', by: 'someone else' } as never },
    ]);
    expect(decided.items.find((candidate) => candidate.id === item?.id)?.decision?.by).toBe('Noa P.');
    expect(await refusal(analyst.requirements.publish(project.id, batch.id))).toBe('403 FORBIDDEN');
    await pilot.requirements.publish(project.id, batch.id);
    const [entity] = (await reader.requirements.get(project.id)).entities;
    expect(entity?.history[0]?.by).toBe('Noa P.');
  });

  it('a role for one project replaces the role of the workspace there only', async () => {
    await service.access.setRole(readerId, 'PILOT', { projectId: project.id });
    expect(await reader.access.me({ projectId: project.id })).toMatchObject({
      role: 'READER',
      projectRole: 'PILOT',
      rights: ['VIEW', 'RUN', 'RUN_WRITES', 'DECIDE', 'PUBLISH'],
    });
    expect((await reader.access.me()).rights).toEqual(['VIEW']);
    await service.access.setRole(readerId, null, { projectId: project.id });
    expect((await reader.access.me({ projectId: project.id })).projectRole).toBeUndefined();
    expect(await refusal(service.access.setRole(readerId, 'PILOT', { projectId: 'prj_unknown1' }))).toBe(
      '404 NOT_FOUND',
    );
  });

  it('a revoked token stops working at once', async () => {
    await service.access.revoke(readerId);
    expect(await refusal(reader.projects.list())).toBe('401 UNAUTHORIZED');
    expect(
      (await service.access.members()).find((member) => member.id === readerId)?.revokedAt,
    ).toBeDefined();
  });

  it('the journal says who did what, where, and the outcome — never a body, a value or a token', async () => {
    const journal = await service.access.journal({ projectId: project.id });
    const lines = journal.map((entry) => `${entry.who.name} ${entry.action} ${entry.outcome}`);
    expect(lines).toContain('Noa P. projects.executions DENIED');
    expect(lines).toContain('Noa P. projects.requirements.imports.decisions OK');
    expect(lines).toContain('Sam L. projects.requirements.imports.publish OK');
    expect(lines).toContain('Sam L. projects.archive DENIED');
    expect(journal.every((entry) => entry.projectId === project.id)).toBe(true);
    const raw = await readFile(path.join(workspace, '.qa-access', 'journal.jsonl'), 'utf8');
    expect(raw).not.toContain('secret-word-in-text');
    expect(raw).not.toContain('someone else');
    expect(raw).not.toContain(readerToken);
    expect(raw).not.toContain(server.token);
    expect((await service.access.journal({ kind: 'ACCESS' })).every((entry) => entry.kind === 'ACCESS')).toBe(
      true,
    );
    expect(await refusal(service.access.journal({ kind: 'NOPE' as 'RUN' }))).toBe('400 INVALID_INPUT');
  });

  it('in named mode, the pages carry no token: the dashboard asks for the personal one', async () => {
    const html = await (await fetch(`${server.url}/dashboard`)).text();
    expect(html).not.toContain(server.token);
    expect(html).toContain("dashboard.setAttribute('sign-in', '')");
    expect(html).toContain("sessionStorage.getItem('qa-crawler-token')");
  });
});

describe('access — rights per route', () => {
  const right = (method: string, url: string) => rightFor(url.split('/').filter(Boolean), method);

  it('reads need VIEW; each write its right; an unknown write the widest', () => {
    expect(right('GET', '/api/projects/prj_abcd/executions')).toBe('VIEW');
    expect(right('GET', '/api/access/members')).toBe('MANAGE_ACCESS');
    expect(right('GET', '/api/access/me')).toBe('VIEW');
    expect(right('POST', '/api/projects/prj_abcd/executions')).toBe('RUN');
    expect(right('POST', '/api/projects/prj_abcd/environments/check')).toBe('RUN');
    expect(right('POST', '/api/projects/prj_abcd/environments/env_1')).toBe('MANAGE_ENVIRONMENTS');
    expect(right('POST', '/api/projects/prj_abcd/archive')).toBe('MANAGE_PROJECTS');
    expect(right('POST', '/api/projects')).toBe('MANAGE_PROJECTS');
    expect(right('POST', '/api/projects/prj_abcd/requirements/imports/imp_abcdef/decisions')).toBe('DECIDE');
    expect(right('POST', '/api/projects/prj_abcd/requirements/imports/imp_abcdef/publish')).toBe('PUBLISH');
    expect(right('POST', '/api/projects/prj_abcd/requirements/links')).toBe('PUBLISH');
    expect(right('POST', '/api/projects/prj_abcd/scenarios')).toBe('PUBLISH');
    expect(right('POST', '/api/projects/prj_abcd/recordings')).toBe('RUN');
    expect(right('POST', '/api/projects/prj_abcd/recordings/demo/groups')).toBe('DECIDE');
    // La barre d'enregistrement pilote une session : le droit de lancer.
    expect(right('POST', '/api/projects/prj_abcd/recordings/demo/replay')).toBe('RUN');
    expect(right('POST', '/api/projects/prj_abcd/recordings/demo/correction')).toBe('RUN');
    expect(right('POST', '/api/projects/prj_abcd/recordings/demo/correction/resume')).toBe('RUN');
    expect(right('POST', '/api/projects/prj_abcd/recordings/demo/correction/apply')).toBe('DECIDE');
    expect(right('POST', '/api/projects/prj_abcd/recordings/demo/intents')).toBe('DECIDE');
    expect(right('POST', '/api/projects/prj_abcd/recordings/demo/steps/row')).toBe('DECIDE');
    for (const control of ['stop', 'pause', 'resume', 'undo', 'checkpoint', 'resolve', 'ignore'])
      expect(right('POST', `/api/projects/prj_abcd/recordings/demo/${control}`)).toBe('RUN');
    expect(actionOf(['api', 'projects', 'prj_abcd', 'recordings', 'demo', 'pause']).action).toBe(
      'projects.recordings.pause',
    );
    expect(right('POST', '/api/explorations/exp_1/report-links')).toBe('VIEW');
    expect(right('POST', '/api/something-new')).toBe('MANAGE_ACCESS');
    expect(right('POST', '/api/projects/prj_abcd/something-new')).toBe('MANAGE_ACCESS');
  });

  it('actions are named from the words of the route, identifiers left out', () => {
    expect(actionOf(['api', 'projects', 'prj_abcd', 'environments', 'check']).kind).toBe('RUN');
    expect(
      actionOf(['api', 'projects', 'prj_abcd', 'requirements', 'imports', 'imp_abcdef', 'publish']),
    ).toEqual({
      action: 'projects.requirements.imports.publish',
      kind: 'REQUIREMENTS',
    });
    expect(actionOf(['api', 'projects', 'prj_abcd', 'executions'])).toEqual({
      action: 'projects.executions',
      kind: 'RUN',
    });
    expect(actionOf(['api', 'projects', 'prj_abcd', 'environments', 'env_1', 'remove']).kind).toBe(
      'CONFIGURATION',
    );
    expect(actionOf(['api', 'access', 'members', 'mbr_x', 'revoke'])).toEqual({
      action: 'access.members.revoke',
      kind: 'ACCESS',
    });
  });
});
