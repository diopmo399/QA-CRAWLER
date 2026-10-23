import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Issue } from '../../src/model/issue.js';
import { JUnitReporter, junitSuitesOf, junitXmlOf } from '../../src/reporting/junit-reporter.js';
import { flow, result, step } from '../fixtures/qa-platform-results.js';

/**
 * JUNIT XML : un reporter de plus, qui ne lit que le résultat. Les statuts des étapes, le seuil
 * des anomalies et l'échappement XML ; jamais une valeur du run.
 */
const issue = (extra: Partial<Issue>): Issue => ({
  id: 'ISSUE-001',
  type: 'HTTP',
  severity: 'ERROR',
  message: 'GET /api/items → 500',
  pageUrl: 'http://app.test/items',
  pages: ['http://app.test/items'],
  states: ['S2'],
  timestamp: '2026-10-11T10:00:05.000Z',
  occurrences: 1,
  ...extra,
});

const run = result(
  [
    flow('create item', [
      step(1, 'Open "New item"', { durationMs: 250 }),
      step(2, 'Fill the label', { kind: 'fill', durationMs: 50, testData: ['testData.item.label'] }),
      step(3, 'Save', {
        status: 'FAILED',
        reason: 'element not found: button "Save"',
        url: 'http://app.test/items/new',
        screenshot: 'shots/003.png',
      }),
      step(4, 'Check the list', { status: 'SKIPPED', reason: 'step 3 failed' }),
    ]),
    flow('delete item', [
      step(1, 'Open the item'),
      step(2, 'Delete', { status: 'BLOCKED', reason: 'DANGEROUS action: add "allow: DANGEROUS"' }),
      step(3, 'Confirm', { status: 'SKIPPED', reason: 'step 2 blocked' }),
    ]),
    flow('optional checks', [
      step(1, 'Banner', { status: 'FAILED', optional: true, reason: 'not visible' }),
      step(2, 'Manual review', { kind: 'manual', status: 'MANUAL' }),
    ]),
  ],
  {
    issues: [
      issue({}),
      issue({ id: 'ISSUE-002', type: 'CONSOLE', severity: 'WARNING', message: 'console.error: <b>&"x"' }),
    ],
  },
);

describe('JUnit XML reporter', () => {
  it('maps flows to test suites and steps to test cases with the right outcomes', () => {
    const suites = junitSuitesOf(run, { failOnSeverity: 'ERROR' });
    expect(suites.map((suite) => suite.name)).toEqual([
      'create item',
      'delete item',
      'optional checks',
      'anomalies',
    ]);
    expect(suites[0]?.cases.map((entry) => entry.outcome)).toEqual([
      'passed',
      'passed',
      'failure',
      'skipped',
    ]);
    expect(suites[1]?.cases.map((entry) => entry.outcome)).toEqual(['passed', 'error', 'skipped']);
    // Une étape facultative échouée ou une vérification manuelle n'échoue pas la CI.
    expect(suites[2]?.cases.map((entry) => entry.outcome)).toEqual(['skipped', 'skipped']);
    expect(suites[2]?.cases[0]?.message).toBe('optional step failed: not visible');
    expect(suites[0]?.properties).toContainEqual(['qa-crawler.flow.status', 'FAILED']);
  });

  it('turns the anomalies at or above failOnSeverity into failures, none with NONE', () => {
    const { xml, summary } = junitXmlOf(run, { failOnSeverity: 'ERROR' });
    expect(summary).toEqual({ tests: 10, failures: 2, errors: 1, skipped: 4 });
    expect(xml).toContain('<testsuite name="anomalies" tests="1" failures="1"');
    expect(xml).toContain('classname="qa-crawler.anomalies.HTTP"');
    const warnings = junitXmlOf(run, { failOnSeverity: 'WARNING' });
    expect(warnings.summary.failures).toBe(3);
    const none = junitXmlOf(run, { failOnSeverity: 'NONE' });
    expect(none.summary.failures).toBe(1);
    expect(none.xml).not.toContain('name="anomalies"');
  });

  it('writes a well-formed document: header, escaped text, times in seconds, no control character', () => {
    const { xml } = junitXmlOf(run, { failOnSeverity: 'WARNING' });
    expect(
      xml.startsWith(
        '<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="qa-crawler: create-and-find"',
      ),
    ).toBe(true);
    expect(xml).toContain(
      '<testcase name="step 1 — Open &quot;New item&quot;" classname="qa-crawler.flows.create_item" time="0.250">',
    );
    expect(xml).toContain('<failure message="element not found: button &quot;Save&quot;" type="FAILED">');
    expect(xml).toContain('screenshot: shots/003.png');
    expect(xml).toContain('console.error: &lt;b&gt;&amp;&quot;x&quot;');
    expect(xml).toContain(
      '<error message="DANGEROUS action: add &quot;allow: DANGEROUS&quot;" type="BLOCKED">',
    );
    expect(xml).toContain('<skipped message="manual check: Manual review"></skipped>');
    expect(xml).toContain('timestamp="2026-10-11T10:00:00"');
    expect(xml.trimEnd().endsWith('</testsuites>')).toBe(true);
    // Les étapes citent des clés de données de test, jamais des valeurs : rien d'autre n'est écrit.
    expect(xml).not.toContain('testData.item.label');
  });

  it('keeps the file usable when nothing ran: one passed case for the mission', () => {
    const empty = result([], { issues: [issue({ severity: 'INFO' })] });
    const { xml, summary } = junitXmlOf(empty, { failOnSeverity: 'ERROR' });
    expect(summary).toEqual({ tests: 1, failures: 0, errors: 0, skipped: 0 });
    expect(xml).toContain('<testsuite name="mission" tests="1"');
    expect(xml).toContain('create-and-find: 1 anomaly(ies), none at or above ERROR');
  });

  describe('on disk', () => {
    let dir = '';
    beforeAll(async () => {
      dir = await mkdtemp(path.join(os.tmpdir(), 'junit-'));
    });
    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('writes the file under the reports directory, creating nested folders', async () => {
      const reporter = new JUnitReporter(dir, path.join('ci', 'junit.xml'), { failOnSeverity: 'ERROR' });
      expect(reporter.format).toBe('junit');
      const file = await reporter.write(run);
      expect(file).toBe(path.join(dir, 'ci', 'junit.xml'));
      expect(await readFile(file, 'utf8')).toContain('<testsuites name="qa-crawler: create-and-find"');
    });
  });
});
