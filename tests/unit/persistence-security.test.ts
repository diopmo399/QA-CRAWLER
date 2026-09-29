import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SqliteAdapter } from '../../src/persistence/database/sqlite/sqlite-adapter.js';
import { DatabasePersistenceProvider } from '../../src/persistence/database/database-provider.js';
import { JsonPersistenceProvider } from '../../src/persistence/file/json-provider.js';
import { InMemoryPersistenceProvider } from '../../src/persistence/memory/in-memory-provider.js';
import type { PersistenceProvider } from '../../src/persistence/persistence-provider.js';
import { sanitizeText, sanitizeValue, sanitizingProvider } from '../../src/persistence/sanitize.js';

/** Des secrets de chaque sorte, glissés partout où un texte peut entrer dans le stockage. */
const SECRETS = {
  bearer: 'Bearer abcDEF123456789xyz',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
  authorization: 'Authorization: Basic dXNlcjpwYXNzd29yZA==',
  cookie: 'Cookie: SESSIONID=s3cr3t-cookie-value',
  password: 'password=hunter2-secret',
  apiKey: 'api_key=AKIA-never-stored-42',
  otp: 'otp=918273',
  card: '4111 1111 1111 1111',
  iban: 'FR7630006000011234567890189',
  urlToken: 'http://app.test/reset?token=tok-never-stored-7&user=ok',
};
const LEAKS = [
  'abcDEF123456789xyz',
  'eyJhbGciOiJIUzI1NiJ9',
  'dXNlcjpwYXNzd29yZA',
  's3cr3t-cookie-value',
  'hunter2-secret',
  'AKIA-never-stored-42',
  '918273',
  '4111 1111 1111 1111',
  'FR7630006000011234567890189',
  'tok-never-stored-7',
];

describe('sanitization before storage', () => {
  it('texts: tokens, JWT, Authorization, cookies, passwords, API keys, OTP, card numbers, IBAN, URL secrets', () => {
    for (const secret of Object.values(SECRETS)) {
      const cleaned = sanitizeText(`label ${secret} end`);
      for (const leak of LEAKS) expect(cleaned).not.toContain(leak);
    }
    // Ce qui n'est pas secret reste lisible : un code à 6 chiffres sans « otp= », une date, un id.
    expect(sanitizeText('Code 112310 → 455219')).toBe('Code 112310 → 455219');
    expect(sanitizeText('2026-01-01T10:00:00.000Z')).toBe('2026-01-01T10:00:00.000Z');
    expect(sanitizeText('http://app.test/users?user=ok')).toBe('http://app.test/users?user=ok');
  });

  it('context_json: sensitive keys are dropped, nested texts cleaned', () => {
    expect(
      sanitizeValue({
        label: 'Users',
        password: 'x',
        nested: { token: 'y', note: SECRETS.bearer, items: [SECRETS.card] },
        headings: ['Users'],
      }),
    ).toEqual({
      label: 'Users',
      nested: { note: 'Bearer [REDACTED]', items: ['[REDACTED]'] },
      headings: ['Users'],
    });
  });
});

/** Interroge directement ce que chaque provider a stocké : aucun secret. */
async function storeEverywhere(provider: PersistenceProvider): Promise<string> {
  const store = sanitizingProvider(provider);
  await store.initialize();
  const runId = randomUUID();
  const everything = Object.values(SECRETS).join(' | ');
  await store.runs.create({
    id: runId,
    applicationId: 'app.test',
    missionName: `mission ${SECRETS.password}`,
    branch: SECRETS.apiKey,
    mode: 'explore',
    startedAt: '2026-01-01T10:00:00.000Z',
    status: 'RUNNING',
    statesCount: 0,
    actionsCount: 0,
    transitionsCount: 0,
    anomaliesCount: 0,
  });
  await store.states.save([
    {
      id: randomUUID(),
      runId,
      stateSignature: 'users',
      stateId: 'users-1',
      routePattern: '/users',
      urlNormalized: SECRETS.urlToken,
      title: SECRETS.jwt,
      heading: SECRETS.card,
      depth: 0,
      firstSeenAt: '2026-01-01T10:00:00.000Z',
      lastSeenAt: '2026-01-01T10:00:00.000Z',
      context: {
        headings: [everything],
        password: 'hunter2-secret',
        cookie: SECRETS.cookie,
        note: SECRETS.iban,
      },
    },
  ]);
  await store.transitions.add([
    {
      id: randomUUID(),
      runId,
      fromStateId: 'users-1',
      toStateId: null,
      actionId: 'a-1',
      actionSignature: 'click:pay',
      actionType: 'click',
      actionLabel: `Pay with ${SECRETS.card} ${SECRETS.authorization}`,
      status: 'BLOCKED',
      safetyClass: 'DANGEROUS',
      safetyDecision: 'BLOCK',
      startedAt: '2026-01-01T10:00:00.000Z',
      finishedAt: '2026-01-01T10:00:00.000Z',
    },
  ]);
  await store.knowledge.record([
    {
      applicationId: 'app.test',
      fromStateSignature: 'users',
      actionSignature: `click:${SECRETS.otp}`,
      toStateSignature: '(none)',
      seen: 1,
      success: 0,
      failure: 0,
      blocked: 1,
      durationTotalMs: 0,
      durationCount: 0,
      firstSeenAt: '2026-01-01T10:00:00.000Z',
      lastSeenAt: '2026-01-01T10:00:00.000Z',
    },
  ]);
  const stored = JSON.stringify({
    runs: await provider.runs.list('app.test', 10),
    states: await provider.states.listByRun(runId),
    transitions: await provider.transitions.listByRun(runId),
    knowledge: await provider.knowledge.load('app.test', 10),
  });
  await store.close();
  return stored;
}

describe('no secret ever reaches a provider (queried directly)', () => {
  const check = (stored: string): void => {
    for (const leak of LEAKS) expect(stored, `leaked: ${leak}`).not.toContain(leak);
    expect(stored).toContain('[REDACTED]');
  };

  it('in-memory', async () => {
    check(await storeEverywhere(new InMemoryPersistenceProvider()));
  });

  it('file: the JSON files on disk', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'qa-persistence-secrets-'));
    check(await storeEverywhere(new JsonPersistenceProvider(directory)));
    const onDisk = readdirSync(directory)
      .map((file) => readFileSync(path.join(directory, file), 'utf8'))
      .join('\n');
    for (const leak of LEAKS) expect(onDisk, `leaked on disk: ${leak}`).not.toContain(leak);
  });

  it('SQLite: the database file', async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'qa-persistence-secrets-db-')), 'qa.db');
    const adapter = new SqliteAdapter({
      engine: 'sqlite',
      file,
      connectTimeoutMs: 5000,
      trustServerCertificate: false,
    });
    check(await storeEverywhere(new DatabasePersistenceProvider(adapter, { migrate: true })));
    const raw = readFileSync(file).toString('latin1');
    for (const leak of LEAKS) expect(raw, `leaked in the database file: ${leak}`).not.toContain(leak);
  });
});
