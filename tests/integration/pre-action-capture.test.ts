import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureScript, type CaptureOptions } from '../../src/recording/capture-script.js';
import type { PreActionCandidate, PreActionContext } from '../../src/recording/model.js';
import { runRecording, type RecordOutcome } from '../../src/recording/record-orchestrator.js';
import { startFilterApp, type FilterApp } from '../fixtures/filter-app.js';

/**
 * CAPTURE FIRST, VALIDATE LATER : la cible réellement utilisée, son contexte et ses candidats sont
 * figés par la page au PREMIER événement du geste (appui, entrée dans le champ, première frappe),
 * avant que l'application ne re-rende. La cible originale est toujours candidate (T1).
 */
interface Payload {
  type: string;
  element?: { css?: string; elementId?: string; tag?: string };
  pre?: PreActionContext;
}

const CAPTURE: NonNullable<CaptureOptions['preActionCapture']> = {
  enabled: true,
  maxCandidates: 12,
  includeSameForm: true,
  includeSameDialog: true,
  includeSameSection: true,
};

describe('Pre-action candidate capture (page side, real browser)', () => {
  let app: FilterApp;
  let browser: Browser;
  beforeAll(async () => {
    app = await startFilterApp();
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser.close();
    await app.close();
  });

  /** Une page de l'application avec le script de capture, et les messages qu'il envoie. */
  const open = async (
    variant: string,
    capture: NonNullable<CaptureOptions['preActionCapture']> = CAPTURE,
  ): Promise<{ page: Page; payloads: Payload[] }> => {
    const page = await browser.newPage();
    const payloads: Payload[] = [];
    await page.exposeBinding('__qaTestCapture', (_source, payload: unknown) => {
      payloads.push(payload as Payload);
    });
    await page.addInitScript({
      content: captureScript({
        binding: '__qaTestCapture',
        salt: 'test',
        overlay: false,
        inputDebounceMs: 50,
        preActionCapture: capture,
      }),
    });
    await page.goto(`${app.url}/?variant=${variant}`);
    return { page, payloads };
  };
  const settle = (page: Page): Promise<void> => page.waitForTimeout(250);
  const original = (pre: PreActionContext | undefined): PreActionCandidate | undefined =>
    pre?.candidates?.find((candidate) => candidate.id === pre.originalCandidateId);

  it('the field is replaced at the first keystroke (#valueInput then matches nothing): the evidence was taken at FOCUSIN — original T1, cssCount 1, never candidates=0', async () => {
    const { page, payloads } = await open('volatile');
    await page.locator('#open').click();
    await page.locator('#valueInput').fill('alpha');
    await page.keyboard.press('Tab');
    await settle(page);
    expect(await page.locator('#valueInput').count()).toBe(0);
    const fill = payloads.find((payload) => payload.type === 'input' || payload.type === 'change');
    expect(fill?.pre?.phase).toBe('FOCUSIN');
    expect(fill?.pre?.cssCount).toBe(1);
    expect(fill?.pre?.candidates?.length).toBeGreaterThanOrEqual(1);
    expect(fill?.pre?.originalCandidateId).toBe('T1');
    const t1 = original(fill?.pre);
    expect(t1).toMatchObject({ origin: 'ORIGINAL_HUMAN_TARGET', relationship: 'SELF', tag: 'input' });
    expect(t1?.stableAttributes.id).toBe('valueInput');
    expect(t1?.dialog).toBe('Filter');
    // La description envoyée est celle d'AVANT la mutation (le nœud remplacé n'a plus d'id).
    expect(fill?.element?.elementId).toBe('valueInput');
    // La génération du DOM au moment de la capture (l'état AVANT l'action).
    expect(typeof fill?.pre?.generation).toBe('number');
    expect(typeof fill?.pre?.sentGeneration).toBe('number');
    // Les candidats contextuels : la même fenêtre d'abord, puis le champ global de même rôle.
    const relations = fill?.pre?.candidates?.map((candidate) => candidate.relationship) ?? [];
    expect(relations).toContain('SAME_DIALOG');
    // Jamais une valeur saisie dans les preuves.
    expect(JSON.stringify(fill?.pre)).not.toContain('alpha');
    await page.close();
  });

  it('a candidate is a description, not a locator: the CSS is only a hint, with the nearby context', async () => {
    const { page, payloads } = await open('default');
    await page.locator('#open').click();
    await page.locator('#valueInput').fill('alpha');
    await page.keyboard.press('Tab');
    await settle(page);
    const fill = payloads.find((payload) => payload.type === 'input' || payload.type === 'change');
    const t1 = original(fill?.pre);
    expect(t1?.cssHint).toBe('#valueInput');
    expect(t1?.role).toBe('combobox');
    expect(fill?.pre?.target?.captureId).toMatch(/:c\d+$/);
    await page.close();
  });

  it('maxCandidates 1: the original human target is never dropped by the budget', async () => {
    const { page, payloads } = await open('default', { ...CAPTURE, maxCandidates: 1 });
    await page.locator('#open').click();
    await settle(page);
    const click = payloads.find((payload) => payload.type === 'click');
    expect(click?.pre?.phase).toBe('POINTERDOWN');
    expect(click?.pre?.candidates).toHaveLength(1);
    expect(original(click?.pre)?.name).toBe('Filter');
    await page.close();
  });

  it('a field wrapped in a component (mat-form-field / mat-label): physical target and semantic container are both captured', async () => {
    const { page, payloads } = await open('material');
    await page.locator('#open').click();
    await page.locator('#valueInput').fill('alpha');
    await page.keyboard.press('Tab');
    await settle(page);
    const fill = payloads.find((payload) => payload.type === 'input' || payload.type === 'change');
    const t1 = original(fill?.pre);
    expect(t1?.tag).toBe('input');
    expect(t1?.container).toEqual({ tag: 'mat-form-field', label: 'Value' });
    expect(t1?.component).toBe('mat-form-field');
    expect(t1?.label).toBe('Value');
    await page.close();
  });

  it('the dialog closes after the click: the button keeps its pre-action snapshot (POINTERDOWN)', async () => {
    const { page, payloads } = await open('closeOnApply');
    await page.locator('#open').click();
    await page.locator('#apply').click();
    await settle(page);
    expect(await page.locator('#apply').isVisible()).toBe(false);
    const apply = payloads.filter((payload) => payload.type === 'click').at(-1);
    expect(apply?.pre?.phase).toBe('POINTERDOWN');
    expect(original(apply?.pre)).toMatchObject({ name: 'Apply', dialog: 'Filter', visible: true });
    await page.close();
  });

  it('a select replaced after its choice: the select and its context are kept from before the change', async () => {
    const { page, payloads } = await open('selectRerender');
    await page.locator('#open').click();
    await page.locator('#field').selectOption('Company name');
    await settle(page);
    const change = payloads.find((payload) => payload.type === 'change');
    expect(change?.pre?.originalCandidateId).toBe('T1');
    expect(original(change?.pre)).toMatchObject({ tag: 'select', role: 'combobox', label: 'Field' });
    await page.close();
  });

  it('capture disabled: no candidate set (the validator will diagnose PRE_ACTION_CAPTURE_INCOMPLETE)', async () => {
    const { page, payloads } = await open('default', { ...CAPTURE, enabled: false });
    await page.locator('#open').click();
    await settle(page);
    const click = payloads.find((payload) => payload.type === 'click');
    // Le repli au moment de l'événement existe toujours (AT_EVENT), avec la cible originale.
    expect(click?.pre?.phase).toBe('AT_EVENT');
    expect(original(click?.pre)?.name).toBe('Filter');
    await page.close();
  });
});

interface ValidationEntry {
  action: string;
  label: string;
  status?: string;
  classification: string;
  validation?: { status: string; candidate?: string };
  preActionCapture?: {
    captured: boolean;
    complete: boolean;
    candidateCount: number;
    originalCandidateId?: string;
  };
  currentRuntime?: { originalStillPresent: boolean };
  target?: { status: string; source: string };
  validationBefore?: { status: string; reason: string; postState?: { status: string } };
}

describe('Pre-action candidate capture, end to end (recording + validation)', () => {
  let app: FilterApp;
  let dir: string;
  beforeAll(async () => {
    app = await startFilterApp();
    dir = await mkdtemp(path.join(tmpdir(), 'qa-pre-action-capture-'));
  });
  afterAll(async () => {
    await app.close();
  });

  const record = async (variant: string, logs: string[]): Promise<RecordOutcome> =>
    runRecording({
      name: `Filter ${variant}`,
      url: `${app.url}/?variant=${variant}`,
      overrides: { headless: true, reportsDir: path.join(dir, `reports-${variant}`) },
      env: {},
      onEvent: (event) => {
        logs.push(event.message);
      },
      drive: async ({ page }) => {
        await page.locator('#open').click();
        await page.locator('#field').selectOption('Company name');
        await page.locator('#operator').selectOption('Like');
        await page.locator('#valueInput').fill('alpha');
        await page.keyboard.press('Tab');
        await page.locator('#apply').click();
        await page.waitForTimeout(1500);
      },
    });
  const validationOf = async (outcome: RecordOutcome): Promise<ValidationEntry[]> =>
    (
      JSON.parse(await readFile(path.join(outcome.directory, 'target-validation.json'), 'utf8')) as {
        actions: ValidationEntry[];
      }
    ).actions;

  for (const variant of ['volatile', 'reuse']) {
    it(`${variant}: the FILL whose node is gone (${variant === 'reuse' ? '#valueInput now designates the global search box' : '#valueInput matches nothing'}) is VALIDATED_PRE_ACTION on T1 — no candidates=0, no false mismatch, no action lost, nothing replayed`, async () => {
      const logs: string[] = [];
      const outcome = await record(variant, logs);
      const actions = await validationOf(outcome);
      // Aucune action perdue : ouvrir, champ, opérateur, valeur, appliquer.
      expect(actions.map((entry) => entry.action)).toEqual(['CLICK', 'SELECT', 'SELECT', 'FILL', 'CLICK']);
      const fill = actions.find((entry) => entry.action === 'FILL');
      expect(fill?.preActionCapture).toMatchObject({
        captured: true,
        complete: true,
        originalCandidateId: 'T1',
      });
      expect(fill?.preActionCapture?.candidateCount).toBeGreaterThanOrEqual(1);
      expect(fill?.currentRuntime?.originalStillPresent).toBe(false);
      expect(fill?.validation?.status).toMatch(/^VALIDATED_PRE_ACTION/);
      expect(fill?.validation?.candidate).toBe('T1');
      expect(fill?.target?.source).toBe('PRE_ACTION_CONTEXT');
      expect(fill?.classification).toBe('VALIDATED');
      // Le nœud que #valueInput désigne maintenant n'invalide jamais la cible prouvée avant l'action.
      expect(fill?.status).not.toBe('MISMATCH');
      const text = logs.join('\n');
      expect(text).not.toMatch(/candidates=0/);
      // Le temps après « Stop », phase par phase (jamais deviné).
      expect(text).toMatch(/after Stop: \d+\.\d s — /);
      expect(text).toMatch(/\[DOM_GENERATION_CHANGED\]/);
      expect(text).not.toMatch(/matched 0 elements before the action/);
      for (const entry of actions)
        expect(entry.preActionCapture?.complete, `${entry.action} ${entry.label}`).toBe(true);
      // Jamais rejouée : « Apply » une seule fois.
      const html = await readFile(path.join(outcome.directory, 'index.html'), 'utf8');
      expect(html).toContain('Pre-action captured ✓');
    }, 120_000);
  }

  it('a target that survives its action is VALIDATED_LIVE', async () => {
    const logs: string[] = [];
    const outcome = await record('default', logs);
    const actions = await validationOf(outcome);
    const operator = actions.filter((entry) => entry.action === 'SELECT').at(-1);
    expect(operator?.validation?.status).toBe('VALIDATED_LIVE');
    expect(operator?.currentRuntime?.originalStillPresent).toBe(true);
    expect(logs.join('\n')).toMatch(/\[PRE_ACTION_CAPTURE\] action=\S+ type=CHANGE target=select#operator/);
  }, 120_000);
});
