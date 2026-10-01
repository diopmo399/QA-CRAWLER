import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import type { ExplorationResult } from '../../src/model/exploration-result.js';
import { runMission } from '../../src/orchestrator.js';

const FIXTURE = path.resolve('tests/fixtures/static-apps/registrations');

/**
 * Le rendu de l'application « registrations » telle qu'Angular la produirait : une
 * inscription en attente (badge PENDING, boutons Approve / Reject), le formulaire d'un
 * utilisateur. Le serveur répond comme l'application réelle — ou, en mode `buggy`,
 * accepte le PATCH (200) sans changer l'état. Le formulaire n'envoie pas firstName
 * (FIELD_NOT_SENT) et l'API répond 409 EMAIL_ALREADY_EXISTS.
 */
const PAGE = `<!doctype html><html><head><title>Registrations</title></head><body>
<nav><a href="/registrations/7">Registration</a> <a href="/users/new">New user</a></nav>
<main id="app"></main>
<script>
  const app = document.getElementById('app');
  async function detail() {
    const registration = await (await fetch('/api/registrations/7')).json();
    const buttons = registration.status === 'PENDING'
      ? '<button id="approve">Approve</button> <button id="reject">Reject</button>'
      : registration.status === 'APPROVED' ? '<button id="cancel">Cancel registration</button>' : '';
    app.innerHTML = '<h1>Registration 7</h1><p>Status: <span class="badge">' + registration.status + '</span></p>' + buttons;
    const write = (status) => async () => {
      await fetch('/api/registrations/7', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status }) });
      await detail();
    };
    document.getElementById('approve')?.addEventListener('click', write('APPROVED'));
    document.getElementById('reject')?.addEventListener('click', write('REJECTED'));
    document.getElementById('cancel')?.addEventListener('click', write('CANCELLED'));
  }
  function userForm() {
    app.innerHTML = '<h1>New user</h1><form id="user" novalidate>' +
      '<label>Email <input type="email" formcontrolname="email" class="ng-valid"></label>' +
      '<label>First name <input type="text" formcontrolname="firstName" class="ng-valid"></label>' +
      '<button type="submit">Create</button></form><div id="error" role="alert"></div>';
    document.getElementById('user').addEventListener('submit', async (event) => {
      event.preventDefault();
      const email = document.querySelector('[formcontrolname="email"]');
      // Le formulaire oublie firstName : le contrat l'exige.
      const response = await fetch('/api/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: email.value }) });
      if (response.status === 409) {
        const body = await response.json();
        if (body.code === 'EMAIL_ALREADY_EXISTS') {
          email.classList.replace('ng-valid', 'ng-invalid');
          email.setAttribute('aria-invalid', 'true');
          document.getElementById('error').textContent = 'Email already exists';
        }
      }
    });
  }
  if (location.pathname.startsWith('/users')) userForm(); else detail();
</script>
</body></html>`;

describe('functional intelligence end to end (Chromium): state machine, goals, side effects, error path, contract', () => {
  let server: Server;
  let url: string;
  let dir: string;
  let status = 'PENDING';
  let buggy = false;
  const requests: string[] = [];

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'qa-functional-e2e-'));
    server = createServer((request, response) => {
      const route = request.url ?? '/';
      const method = request.method ?? 'GET';
      requests.push(`${method} ${route}`);
      const json = (code: number, body: unknown): void => {
        response.writeHead(code, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      };
      if (route === '/api/registrations/7' && method === 'GET') json(200, { id: '7', status });
      else if (route === '/api/registrations/7' && method === 'PATCH') {
        let body = '';
        request.on('data', (chunk: Buffer) => (body += chunk.toString()));
        request.on('end', () => {
          const next = (JSON.parse(body) as { status?: string }).status;
          if (!buggy && next) status = next;
          json(200, { id: '7', status });
        });
      } else if (route === '/api/users' && method === 'POST') {
        request.resume();
        request.on('end', () => {
          json(409, { code: 'EMAIL_ALREADY_EXISTS', message: 'conflict' });
        });
      } else {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(PAGE);
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const run = async (options: {
    enabled: boolean;
    startAt: string;
    mutations?: boolean;
    flows?: string;
  }): Promise<{ result: ExplorationResult; log: string; html: string }> => {
    const reports = await mkdtemp(path.join(dir, 'run-'));
    const { config } = parseConfig(
      `
mission: { name: functional-e2e }
target: { baseUrl: ${url}, startAt: ${options.startAt} }
safety: { allowedActionClasses: [SAFE${options.mutations === false ? '' : ', MUTATION'}] }
exploration: { maxStates: 6, maxActions: 6, actionTimeoutMs: 3000, settleTimeMs: 120 }
forms: { exercise: false }
${options.flows ?? ''}
openapi: { enabled: true, source: ${path.join(FIXTURE, 'openapi.yaml')} }
staticAnalysis:
  enabled: true
  source: { root: ${FIXTURE} }
  cache: { enabled: false }
functionalIntelligence: { enabled: ${String(options.enabled)} }
report: { failOnSeverity: NONE }
output:
  reportsDir: ${path.join(reports, 'reports')}
  screenshotsDir: ${path.join(reports, 'screenshots')}
`,
      {},
      {},
    );
    const { result } = await runMission(config);
    const entries = await readdir(reports, { recursive: true });
    const logFile = entries.find((entry) => entry.endsWith('engine-log.jsonl'));
    const log = logFile ? await readFile(path.join(reports, logFile), 'utf8') : '';
    const html = await readFile(path.join(reports, 'reports', 'index.html'), 'utf8');
    return { result, log, html };
  };

  it('plans and verifies "PENDING registration can transition to APPROVED" under the SafetyPolicy', async () => {
    status = 'PENDING';
    buggy = false;
    const { result, log, html } = await run({ enabled: true, startAt: '/registrations/7' });
    const functional = result.functional;
    expect(functional).toBeDefined();
    const machine = functional?.machines.find((entry) => entry.entityType === 'REGISTRATION');
    expect(machine?.states.map((state) => state.state)).toEqual(
      expect.arrayContaining(['DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']),
    );
    const goals = new Map((functional?.goals ?? []).map((goal) => [goal.id, goal]));
    const printable = (functional?.goals ?? [])
      .map((goal) => `${goal.id}: ${goal.status} ${goal.observations?.at(-1) ?? ''}`)
      .join('\n');
    const approve = goals.get('STATE_TRANSITION:REGISTRATION:PENDING>APPROVED:approve');
    expect(approve?.intent).toBe('Verify PENDING registration can transition to APPROVED');
    expect(approve?.status, printable).toBe('VERIFIED');
    const transition = machine?.transitions.find(
      (entry) => entry.id === 'REGISTRATION:PENDING>APPROVED:approve',
    );
    expect(transition?.status).toBe('RUNTIME_CONFIRMED');
    expect(transition?.evidence.some((entry) => entry.source === 'RUNTIME')).toBe(true);
    // Supprimer, payer : jamais exécutés, bloqués par la SafetyPolicy.
    expect(goals.get('WORKFLOW:DELETE:USER')?.status).toBe('BLOCKED');
    expect(requests.some((entry) => entry.startsWith('DELETE') || entry.includes('/payments'))).toBe(false);
    // L'action est choisie pour l'objectif (TEST_GOAL_PROGRESS), et le journal le dit.
    expect(log).toContain('TEST_GOAL_SELECTED');
    expect(log).toContain('TEST_GOAL_VERIFIED');
    expect(log).toContain('BUSINESS_TRANSITION_CONFIRMED');
    expect(html).toContain('Functional intelligence');
    expect(html).toContain('Verify PENDING registration can transition to APPROVED');
    expect(result.functional?.coverage.transitions.confirmed).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it('PATCH 200 but the badge stays PENDING: the missing transition is reported, not a confirmed failure', async () => {
    status = 'PENDING';
    buggy = true;
    const { result } = await run({ enabled: true, startAt: '/registrations/7' });
    const goal = result.functional?.goals.find(
      (entry) => entry.id === 'STATE_TRANSITION:REGISTRATION:PENDING>APPROVED:approve',
    );
    expect(goal?.status).toBe('FAILED');
    const functionalIssues = result.issues.filter((issue) => issue.type === 'FUNCTIONAL');
    expect(functionalIssues.some((issue) => /PENDING → APPROVED expected/.test(issue.message))).toBe(true);
    expect(functionalIssues.every((issue) => issue.severity === 'WARNING')).toBe(true);
    buggy = false;
  }, 120_000);

  it('409 EMAIL_ALREADY_EXISTS reaches the email field; firstName not sent is a CONTRACT_MISMATCH', async () => {
    // Le scénario déclaré remplit le courriel et envoie (une écriture permise par la mission).
    const { result } = await run({
      enabled: true,
      startAt: '/users/new',
      flows: `flows:
  - name: Create a user
    steps:
      - fill: { label: Email, value: taken@example.test }
      - { click: { role: button, name: Create }, allow: MUTATION }`,
    });
    const path409 = result.functional?.errorPaths.find(
      (entry) => entry.businessCode === 'EMAIL_ALREADY_EXISTS',
    );
    expect(path409).toMatchObject({
      operation: 'CREATE:USER',
      httpStatus: 409,
      uiTarget: 'email',
      status: 'RUNTIME_CONFIRMED',
    });
    const mismatch = result.functional?.contract.find((entry) => entry.kind === 'FIELD_NOT_SENT');
    expect(mismatch).toMatchObject({
      category: 'CONTRACT_MISMATCH',
      operation: 'POST /api/users',
      field: 'firstName',
    });
    expect(
      result.issues.some((issue) => issue.type === 'CONTRACT' && /FIELD_NOT_SENT/.test(issue.message)),
    ).toBe(true);
    // Jamais une valeur saisie dans le résultat.
    expect(JSON.stringify(result.functional)).not.toMatch(/@example/);
  }, 120_000);

  it('functionalIntelligence disabled (non-regression): no functional section, no functional issue', async () => {
    status = 'PENDING';
    const { result, html } = await run({ enabled: false, startAt: '/registrations/7' });
    expect(result.functional).toBeUndefined();
    expect(result.issues.some((issue) => issue.type === 'FUNCTIONAL')).toBe(false);
    expect(html).not.toContain('Functional intelligence');
  }, 120_000);
});
