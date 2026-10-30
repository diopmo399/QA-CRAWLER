import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FlowConfig } from '../../src/config/flow-schema.js';
import type { FlowStepReport } from '../../src/model/flow-run.js';
import type { RunLogInput } from '../../src/sdk/server/run-events.js';
import {
  driverText,
  engineCategory,
  engineSource,
  mavenOutput,
  playwrightOutput,
  REPORTER_PREFIX,
  REPORTER_SOURCE,
  referencedEnvNames,
  secretValues,
  stepErrorKind,
  stepOfLine,
  stepStatus,
} from '../../src/sdk/server/run-log-sources.js';

/**
 * LES SOURCES DU JOURNAL : ce que chaque outil dit vraiment, traduit dans le contrat commun. Les sorties
 * ci-dessous sont celles relevées sur un vrai run (reporter de Playwright Test, `mvn test` avec
 * `DEBUG=pw:api`) ; le bout en bout avec les vrais outils : sdk-run-logs (intégration).
 */
const fixture = (name: string): string =>
  readFileSync(path.resolve('tests/fixtures/generated-tests', name), 'utf8');
const SPEC = fixture('ouvrir-une-fiche.spec.ts.txt');
const JAVA = fixture('OuvrirUneFicheTest.java.txt');

const collect = (): { events: RunLogInput[]; emit: (event: RunLogInput) => void } => {
  const events: RunLogInput[] = [];
  return { events, emit: (event) => events.push(event) };
};
const reporter = (event: Record<string, unknown>): string =>
  `${REPORTER_PREFIX}${JSON.stringify({ at: '2026-10-29T11:29:05.891Z', ...event })}\n`;

describe('step marks of the generated code', () => {
  it('a line belongs to the step of the « step N » mark above it, until the end of its method', () => {
    const ts = stepOfLine(SPEC);
    expect([14, 17, 20, 23, 26, 28].map(ts)).toEqual([undefined, 1, 2, 2, 3, undefined]);
    const java = stepOfLine(JAVA);
    expect([26, 29, 32, 35, 38, 40].map(java)).toEqual([undefined, 1, 2, 2, 3, undefined]);
  });

  it('the environment variables cited by the played files: their values are masked', () => {
    const names = referencedEnvNames([
      'value: ${env:APP_PASSWORD}',
      'fill:\n  value:\n    env: LOGIN_USER',
      'process.env.QA_REPRO_LOGIN_STEP_2',
      'System.getenv("API_TOKEN")',
    ]);
    expect(names).toEqual(
      expect.arrayContaining(['APP_PASSWORD', 'LOGIN_USER', 'QA_REPRO_LOGIN_STEP_2', 'API_TOKEN']),
    );
    expect(secretValues({ APP_PASSWORD: 'hunter2-long', LOGIN_USER: 'ab' }, names)).toEqual(['hunter2-long']);
  });
});

describe('Playwright Test reporter', () => {
  it('the reporter written for the run never writes the value of a fill', () => {
    expect(REPORTER_SOURCE).toContain('Fill|Type|Press sequentially');
    expect(REPORTER_SOURCE).toContain(REPORTER_PREFIX.trim().slice(1, 5));
  });

  it('turns the runner steps into events tied to the test line and to its flow step; other lines stay output', () => {
    const { events, emit } = collect();
    const output: string[] = [];
    const parser = playwrightOutput({
      emit,
      file: 'playwright/ouvrir-une-fiche.spec.ts',
      source: SPEC,
      output: (text) => output.push(text),
    });
    const begin = reporter({
      type: 'step-begin',
      test: 'Ouvrir une fiche › Ouvrir une fiche',
      category: 'pw:api',
      title: "Click getByRole('link', { name: 'Utilisateurs' }).first()",
      file: 'ouvrir-une-fiche.spec.ts',
      line: 17,
    });
    // Une ligne coupée entre deux paquets de sortie est recollée.
    parser.write(`  ✓  1 ouvrir-une-fiche.spec.ts:13:7 › Ouvrir une fiche\n${begin.slice(0, 40)}`);
    parser.write(begin.slice(40));
    parser.write(
      reporter({ type: 'step-begin', category: 'fixture', title: 'Fixture "browser"' }) +
        reporter({
          type: 'step-end',
          category: 'expect',
          title: 'Expect "toBeVisible"',
          durationMs: 12,
          error: 'Timed out 5000ms waiting for expect(locator).toBeVisible()',
          file: 'ouvrir-une-fiche.spec.ts',
          line: 22,
        }) +
        reporter({
          type: 'test-end',
          test: 'Ouvrir une fiche › Ouvrir une fiche',
          status: 'failed',
          durationMs: 5400,
          errors: [
            { message: 'expect(locator).toBeVisible() failed', file: 'ouvrir-une-fiche.spec.ts', line: 22 },
          ],
        }),
    );
    parser.end();
    expect(events.map((event) => event.type)).toEqual([
      'OUTPUT',
      'ACTION_STARTED',
      'RUNNER_STEP_STARTED',
      'ASSERTION_FINISHED',
      'TEST_FINISHED',
    ]);
    expect(events[1]).toMatchObject({
      category: 'ACTION',
      status: 'RUNNING',
      line: 17,
      step: 1,
      file: 'playwright/ouvrir-une-fiche.spec.ts',
      level: 'INFO',
    });
    expect(events[2]).toMatchObject({ category: 'ENGINE', level: 'DEBUG' });
    expect(events[3]).toMatchObject({
      status: 'FAILED',
      level: 'ERROR',
      errorKind: 'ASSERTION',
      line: 22,
      step: 2,
      durationMs: 12,
    });
    expect(events[4]).toMatchObject({
      type: 'TEST_FINISHED',
      status: 'FAILED',
      errorKind: 'ASSERTION',
      line: 22,
      step: 2,
    });
    expect(output.join('')).toContain('ouvrir-une-fiche.spec.ts:13:7');
    expect(output.join('')).not.toContain('QA-EVENT');
  });
});

describe('Maven and the Playwright Java driver', () => {
  // La sortie réelle de `mvn -B -ntp test` avec DEBUG=pw:api (extrait), plus une saisie et un échec.
  const OUTPUT = [
    '[INFO] Running Ouvrir une fiche',
    '2026-10-29T11:28:45.297Z pw:api navigating to "http://localhost:36917/", waiting until "load"',
    '2026-10-29T11:28:45.340Z pw:api waiting for getByRole(AriaRole.LINK, new Page.GetByRoleOptions().setName("Utilisateurs")).first()',
    '2026-10-29T11:28:45.378Z pw:api   locator resolved to <a href="/users">Utilisateurs</a>',
    '2026-10-29T11:28:45.381Z pw:api attempting click action',
    '2026-10-29T11:28:45.416Z pw:api   click action done',
    '2026-10-29T11:40:40.391Z pw:api   fill("s3cr3t-Valeur-42")',
    '2026-10-29T11:40:40.410Z pw:api elementHandle.type("autre-secret-77")',
    '2026-10-29T11:40:40.420Z pw:api   locator resolved to <input name="name" value="s3cr3t-Valeur-42">',
    '2026-10-29T11:28:45.535Z pw:api Assert "hasURL" with timeout 5000ms',
    '[ERROR] Tests run: 1, Failures: 0, Errors: 1, Skipped: 0, Time elapsed: 32.1 s <<< FAILURE! -- in Ouvrir une fiche',
    '[ERROR] qa.generated.OuvrirUneFicheTest.ouvrirUneFiche -- Time elapsed: 31.9 s <<< ERROR!',
    'com.microsoft.playwright.TimeoutError: Error {',
    '\tat qa.generated.OuvrirUneFicheTest.ouvrirUneFiche(OuvrirUneFicheTest.java:32)',
    '[INFO] BUILD FAILURE',
  ].join('\n');

  it('a test started and finished, the driver gestures (waited, resolved, done), a failure on its line and step', () => {
    const { events, emit } = collect();
    const parser = mavenOutput({
      emit,
      file: 'java/src/test/java/qa/generated/OuvrirUneFicheTest.java',
      source: JAVA,
    });
    for (const chunk of OUTPUT.match(/[\s\S]{1,37}/g) ?? []) parser.write(chunk);
    parser.write('\n');
    parser.end();
    const types = events.map((event) => event.type);
    expect(types.slice(0, 6)).toEqual([
      'TEST_STARTED',
      'NAVIGATION_STARTED',
      'TARGET_WAIT',
      'TARGET_RESOLVED',
      'ACTION_STARTED',
      'ACTION_FINISHED',
    ]);
    expect(events[0]).toMatchObject({ scenario: 'Ouvrir une fiche', status: 'RUNNING' });
    expect(events[5]).toMatchObject({
      status: 'EXECUTED',
      source: 'playwright-java',
      at: '2026-10-29T11:28:45.416Z',
    });
    // Le pilote annonce une vérification, pas sa fin : elle est demandée, jamais confirmée par lui.
    expect(events.find((event) => event.type === 'ASSERTION_REQUESTED')).toMatchObject({
      status: 'REQUESTED',
    });
    expect(events.find((event) => event.type === 'TEST_FINISHED')).toMatchObject({
      status: 'FAILED',
      level: 'ERROR',
    });
    expect(events.find((event) => event.type === 'FAILURE_LOCATED')).toMatchObject({ line: 32, step: 2 });
    expect(events.find((event) => event.type === 'TEST_ERROR')).toMatchObject({ errorKind: 'SELECTOR' });
    const text = JSON.stringify(events);
    expect(text).not.toContain('s3cr3t-Valeur-42');
    expect(text).not.toContain('autre-secret-77');
  });

  it('the raw output kept for the run has no driver line and no typed value', () => {
    const output: string[] = [];
    const parser = mavenOutput({
      emit: () => undefined,
      file: 'X.java',
      source: '',
      output: (text) => output.push(text),
    });
    parser.write(`${OUTPUT}\n`);
    parser.end();
    expect(output.join('')).toContain('BUILD FAILURE');
    expect(output.join('')).not.toContain('pw:api');
    expect(driverText('fill("a)b\\"c") and value="x"')).toBe('fill(…) and value="…"');
  });

  it('the empty [ERROR] lines Maven puts between its blocks say nothing: no event', () => {
    const { events, emit } = collect();
    const parser = mavenOutput({ emit, file: 'X.java', source: '' });
    parser.write('[ERROR] \n[ERROR]\n[ERROR] BUILD FAILURE\n');
    parser.end();
    expect(events.map((entry) => entry.message)).toEqual(['BUILD FAILURE']);
  });
});

describe('engine listener and log', () => {
  const flow = {
    name: 'Ouvrir une fiche',
    steps: [{ kind: 'click' }, { kind: 'fill' }, { kind: 'expect' }],
  } as unknown as FlowConfig;
  const report = (extra: Partial<FlowStepReport>): FlowStepReport => ({
    index: 1,
    kind: 'click',
    description: 'click link "Utilisateurs"',
    status: 'PASSED',
    optional: false,
    durationMs: 120,
    ...extra,
  });

  it('a step started then finished: its position, its line, and what the engine said about its effect', () => {
    const { events, emit } = collect();
    const source = engineSource({
      emit,
      format: 'yaml',
      file: 'ouvrir.flow.yaml',
      stepLines: new Map([
        [1, 8],
        [2, 25],
      ]),
      reportsDir: '/r',
    });
    source.listener.onFlowStart?.(flow);
    source.listener.onFlowStepStart?.(flow, {
      index: 1,
      kind: 'click',
      description: 'click link "Utilisateurs"',
      optional: false,
    });
    // Ce que le moteur journalise pendant l'étape lui est rattaché.
    source.onLog({
      at: '2026-10-29T10:00:00.000Z',
      level: 'INFO',
      event: 'TARGET_RESOLUTION',
      message: 'resolved',
    });
    source.onLog({
      at: '2026-10-29T10:00:00.000Z',
      level: 'INFO',
      event: 'FLOW_STEP',
      message: 'handled by the listener',
    });
    source.listener.onFlowStep?.(
      flow,
      report({
        effect: {
          execution: 'EXECUTED',
          status: 'CONFIRMED',
          expected: [],
          observed: [],
          reasons: [],
          recovery: [],
        },
        network: {
          requests: [
            { method: 'GET', path: '/users', status: 200, durationMs: 12, resourceType: 'document' },
          ],
          writes: 0,
          errors: 0,
        },
        screenshot: '/r/screenshots/step-1.png',
      }),
    );
    source.onLog({
      at: '2026-10-29T10:00:01.000Z',
      level: 'TRACE',
      event: 'NAVIGATION_DETECTED',
      message: 'after',
    });
    expect(events.map((event) => event.type)).toEqual([
      'SCENARIO_STARTED',
      'STEP_STARTED',
      'TARGET_RESOLUTION',
      'HTTP_REQUEST',
      'STEP_FINISHED',
      'NAVIGATION_DETECTED',
    ]);
    expect(events[1]).toMatchObject({ step: 1, line: 8, status: 'RUNNING', category: 'ACTION' });
    expect(events[2]).toMatchObject({ step: 1, line: 8, category: 'ACTION' });
    expect(events[3]).toMatchObject({ category: 'NETWORK', step: 1, message: 'GET /users → 200' });
    expect(events[4]).toMatchObject({
      status: 'CONFIRMED',
      step: 1,
      evidence: { screenshot: 'screenshots/step-1.png' },
    });
    expect(events[5]).toMatchObject({ level: 'DEBUG', category: 'BROWSER' });
    expect(events[5]?.step).toBeUndefined();
  });

  it('a fill never shows its value; a failure is classified; a step skipped after a stop is « not run »', () => {
    const { events, emit } = collect();
    const source = engineSource({ emit, format: 'gherkin', file: 'f.feature', reportsDir: '/r' });
    source.listener.onFlowStepStart?.(flow, {
      index: 2,
      kind: 'fill',
      description: 'fill "Mot de passe" = "hunter2-secret"',
      optional: false,
      sourceLine: 11,
    });
    source.listener.onFlowStep?.(
      flow,
      report({
        index: 2,
        kind: 'fill',
        description: 'fill "Mot de passe" = "hunter2-secret"',
        status: 'FAILED',
        reason: 'value hunter2-secret rejected',
        suggestions: ['- fill: { label: Code }'],
      }),
    );
    source.listener.onFlowStep?.(
      flow,
      report({ index: 3, kind: 'expect', status: 'SKIPPED', reason: 'flow stopped' }),
    );
    expect(JSON.stringify(events)).not.toContain('hunter2-secret');
    expect(events[0]).toMatchObject({ line: 11, step: 2 });
    expect(events[1]).toMatchObject({ status: 'FAILED', errorKind: 'SELECTOR', level: 'ERROR' });
    expect(events[2]).toMatchObject({ status: 'NOT_RUN' });
  });

  it('statuses and error families as the engine reports them; a healed locator is a suggestion, not a change', () => {
    expect(stepStatus({ status: 'PASSED', kind: 'click' })).toBe('EXECUTED');
    expect(stepStatus({ status: 'BLOCKED', kind: 'click' })).toBe('BLOCKED');
    expect(stepStatus({ status: 'MANUAL', kind: 'manual' })).toBe('SKIPPED');
    expect(stepErrorKind({ status: 'BLOCKED', kind: 'click' })).toBe('POLICY');
    expect(stepErrorKind({ status: 'FAILED', kind: 'click', reason: 'net::ERR_CONNECTION_REFUSED' })).toBe(
      'BROWSER',
    );
    expect(stepErrorKind({ status: 'FAILED', kind: 'expect', reason: 'url is /a' })).toBe('ASSERTION');
    expect(engineCategory('SEMANTIC_RESOLUTION_FAILED')).toBe('ACTION');
    expect(engineCategory('BUSINESS_ASSERTION_FAILED')).toBe('ASSERTION');
    const { events, emit } = collect();
    engineSource({ emit, format: 'yaml', file: 'x', reportsDir: '/r' }).listener.onFlowStep?.(
      flow,
      report({
        effect: {
          execution: 'EXECUTED',
          status: 'NO_EFFECT',
          expected: [],
          observed: [],
          reasons: [],
          recovery: [],
          healed: { from: 'css=.a', to: 'role=link' },
        },
      }),
    );
    expect(events[0]).toMatchObject({ type: 'REPAIR_SUGGESTED', status: 'REQUESTED' });
    expect(events[0]?.message).toContain('the scenario file is not changed');
    expect(events[1]).toMatchObject({ type: 'STEP_FINISHED', status: 'EXECUTED', level: 'WARN' });
  });
});
