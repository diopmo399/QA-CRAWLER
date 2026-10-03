import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IntelligenceGateway } from '../../src/ai/gateway.js';
import type { IntelligenceMode, IntelligenceRequest } from '../../src/ai/model.js';
import { IntelligenceContextSanitizer } from '../../src/ai/sanitizer.js';
import type { RawRecordedEvent, RecordedElement } from '../../src/recording/model.js';
import { targetAuditAdvisor } from '../../src/recording/semantic-audit.js';
import {
  RecordingTargetValidator,
  type TargetAuditAdvisor,
  type TargetValidationStatus,
} from '../../src/recording/target-validator.js';
import { FakeIntelligenceProvider } from '../fixtures/fake-intelligence-provider.js';

/**
 * RECORDING TARGET VALIDATOR, cas par cas, dans un vrai navigateur. L'« élément original » est
 * celui que la page désigne (ici par un sélecteur) ; la représentation à valider est construite
 * comme pendant l'enregistrement. Jamais une action : les compteurs de la page le prouvent.
 */
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Settings</title></head><body><main>
<h1>Settings</h1>
<section aria-labelledby="g"><h2 id="g">General</h2><label>Priority <input id="generalPriority"></label></section>
<section aria-labelledby="f"><h2 id="f">Filters</h2><label>Priority <input id="filterPriority"></label>
  <div><input id="v1"></div><div><input id="v2"></div><div><input id="v3"></div></section>
<section aria-labelledby="c"><h2 id="c">Columns</h2><label>Search <input id="columnsSearch"></label>
  <ul id="available"><li id="col-status">Status</li><li id="col-owner">Owner</li></ul>
  <ul id="selected" aria-label="Selected columns"><li id="col-name">Name</li></ul></section>
<button type="button" id="apply">Apply</button>
<button type="button" id="gone" hidden>Continue</button>
<div class="mat-mdc-form-field"><label id="tasks-label">My tasks</label><input id="tasksSearch" aria-labelledby="tasks-label"></div>
<div role="combobox" id="attribute" tabindex="0"><span class="placeholder">Select an attribute</span></div>
<form id="bound"><div><input class="ctl" formcontrolname="city"></div><div><input class="ctl" formcontrolname="zip"></div><div><input class="ctl" formcontrolname="street"></div></form>
<div hidden><input class="dup"></div><div role="dialog" aria-label="Filter"><input class="dup"></div>
<div hidden><input class="dup2"></div><div><input class="dup2"></div>
<span hidden>Process request</span><span hidden>Process request</span><div class="tile" onclick="void 0">Process request</div>
<p>Applied <span id="count">0</span></p>
</main><script>
  let count = 0;
  document.getElementById('apply').addEventListener('click', () => { count += 1; document.getElementById('count').textContent = String(count); });
  // L'élément ORIGINAL de l'action humaine (ici désigné par un sélecteur, :zone pour une zone de dépôt).
  window.__qaCrawlerOriginal = (ref) => document.querySelector(ref.endsWith(':zone') ? '#selected' : ref);
</script></body></html>`;

const element = (overrides: Partial<RecordedElement>): RecordedElement => ({
  tag: 'input',
  role: 'textbox',
  name: '',
  css: 'main input',
  cssStable: false,
  inForm: false,
  isSubmit: false,
  inNavigation: false,
  inDialog: false,
  sameRoleName: 1,
  roleNameIndex: 0,
  sameLabel: 1,
  ...overrides,
});
const change = (el: RecordedElement): RawRecordedEvent => ({
  id: 'r9',
  sequence: 9,
  type: 'change',
  at: 0,
  url: 'http://app.test/',
  element: el,
  value: { empty: false, length: 3, shape: 'text' },
});

function gateway(mode: IntelligenceMode, provider: FakeIntelligenceProvider): IntelligenceGateway {
  const on = true;
  return new IntelligenceGateway({
    mode,
    providerId: provider.id,
    createProvider: () => provider,
    triggers: {
      ambiguousTarget: on,
      unknownScreen: on,
      flowDivergence: on,
      recoveryFailed: on,
      multiplePlans: on,
      unresolvedHypothesis: on,
      unknownBusinessError: on,
      lowConfidence: on,
      knowledgeContradiction: on,
      unknownBlockingPrecondition: on,
      hypothesisAnalysis: on,
      recordingEnrichment: on,
    },
    thresholds: { deterministicConfidence: 0.85, minProposalConfidence: 0.6, overrideMargin: 0.15 },
    budgets: {
      maxCallsPerRun: 20,
      maxCallsPerAction: 1,
      maxCallsPerDivergence: 1,
      maxToolCallsPerRequest: 4,
      maxReasoningDurationMs: 60_000,
    },
    timeoutMs: 5_000,
    maxRetries: 0,
    failOnUnavailable: false,
    sanitizer: new IntelligenceContextSanitizer(),
  });
}
/** Le conseiller choisit la candidate dont la description contient ce texte. */
const pick =
  (text: string) =>
  (request: IntelligenceRequest): unknown => {
    const chosen = request.availableActions.find((action) => action.name.includes(text));
    return {
      status: chosen ? 'PROPOSAL' : 'INCONCLUSIVE',
      ...(chosen ? { selectedActionId: chosen.id } : {}),
      supportingEvidenceIds: request.relevantEvidence.slice(0, 1).map((evidence) => evidence.id),
      uncertainties: [],
      confidence: 0.9,
    };
  };

const AMBIGUOUS_ON: ReadonlySet<TargetValidationStatus> = new Set(['AMBIGUOUS']);
/** Trois champs de valeur identiques, sans libellé : seul un CSS générique les désigne. */
const unnamedValue = element({ css: 'section input:not([id$="Priority"]):not([id="columnsSearch"])' });

describe('RecordingTargetValidator (real browser, dry lookup)', () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
    await page.setContent(PAGE);
  });
  afterAll(async () => {
    await browser.close();
  });
  const validator = (advisor?: TargetAuditAdvisor): RecordingTargetValidator =>
    new RecordingTargetValidator({
      maxDeterministicRepairAttempts: 2,
      auditOn: advisor ? AMBIGUOUS_ON : new Set(),
      ...(advisor ? { advisor } : {}),
    });

  it('§51 exact target (label + section): VALIDATED, no repair, no advisor call', async () => {
    const provider = new FakeIntelligenceProvider(pick('x'));
    const result = await validator(targetAuditAdvisor(gateway('ASSIST', provider), { maxCalls: 5 })).validate(
      page,
      change(
        element({
          label: 'Search',
          name: 'Search',
          sectionPath: ['Settings', 'Columns'],
          css: '#columnsSearch',
          cssStable: true,
        }),
      ),
      '#columnsSearch',
    );
    expect(result?.status).toBe('VALIDATED');
    expect(result?.repairApplied).toBe(false);
    expect(provider.requests).toHaveLength(0);
  });

  it('§49 wrong section: CONTEXT_MISMATCH (never validated because both are inputs), repaired to the human section', async () => {
    const result = await validator().validate(
      page,
      // L'humain a rempli Priority dans General ; la représentation désigne celui de Filters.
      change(
        element({
          label: 'Priority',
          name: 'Priority',
          sectionPath: ['Settings', 'Filters'],
          sameLabel: 2,
          sameLabelInSection: 1,
        }),
      ),
      '#generalPriority',
    );
    expect(result?.validationBefore.status).toBe('CONTEXT_MISMATCH');
    expect(result?.validationBefore.reason).toMatch(/RESOLVED_IN_OTHER_SECTION/);
    expect(result?.status).toBe('VALIDATED');
    expect(result?.targetAfter).toMatchObject({
      strategy: 'label',
      value: 'Priority',
      section: 'Settings > General',
    });
  });

  it('§50 three identical inputs, a generic selector: AMBIGUOUS with candidates — never the first one', async () => {
    const result = await validator().validate(page, change(unnamedValue), '#v2');
    expect(result?.status).toBe('AMBIGUOUS');
    expect(result?.validationBefore.candidates?.map((candidate) => candidate.original)).toEqual([
      false,
      true,
      false,
    ]);
    expect(result?.requiresReplayValidation).toBe(true);
    expect(result?.targetAfter).toBeUndefined();
  });

  it('§53 the advisor picks the right candidate: re-resolved, matches the human target → VALIDATED_AFTER_AI_AUDIT (not universal knowledge)', async () => {
    const provider = new FakeIntelligenceProvider(pick('[1]'));
    const result = await validator(targetAuditAdvisor(gateway('ASSIST', provider), { maxCalls: 5 })).validate(
      page,
      change(unnamedValue),
      '#v2',
    );
    expect(provider.requests).toHaveLength(1);
    expect(result?.status).toBe('VALIDATED_AFTER_AI_AUDIT');
    // Le conseiller reçoit de quoi DÉPARTAGER : chaque candidate dit ce qu'elle trouve et ses traits.
    const request = provider.requests[0];
    const names = request?.availableActions.map((action) => action.name) ?? [];
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((name) => name.includes('←'))).toBe(true);
    expect(JSON.stringify(request)).toMatch(/visible/);
    expect(request?.workflowContext?.next[0]).not.toMatch(/^change\s*$/);
    expect(result?.aiAudit?.outcome).toBe('AI_PROPOSAL_RUNTIME_CONFIRMED');
    expect(result?.repair?.type).toBe('AI');
    expect(result?.targetAfter?.nth).toBe(1);
    expect(result?.knowledge).toEqual({ recordingValidated: true, replayValidated: false });
  });

  it('§54 the advisor picks a wrong candidate: AI_PROPOSAL_RUNTIME_REJECTED, the human action is kept as is', async () => {
    const provider = new FakeIntelligenceProvider(pick('[2]'));
    const result = await validator(targetAuditAdvisor(gateway('ASSIST', provider), { maxCalls: 5 })).validate(
      page,
      change(unnamedValue),
      '#v2',
    );
    expect(result?.aiAudit?.outcome).toBe('AI_PROPOSAL_RUNTIME_REJECTED');
    expect(result?.status).toBe('AMBIGUOUS');
    expect(result?.targetAfter).toBeUndefined();
    expect(result?.requiresReplayValidation).toBe(true);
  });

  it('§59 the advisor is unavailable: deterministic result kept, nothing lost', async () => {
    const provider = new FakeIntelligenceProvider(pick('[1]'), { available: false });
    const result = await validator(targetAuditAdvisor(gateway('ASSIST', provider), { maxCalls: 5 })).validate(
      page,
      change(unnamedValue),
      '#v2',
    );
    expect(result?.status).toBe('AMBIGUOUS');
    expect(['UNAVAILABLE', 'INCONCLUSIVE']).toContain(result?.aiAudit?.outcome);
    expect(result?.requiresReplayValidation).toBe(true);
  });

  it('§52 only a structural selector identifies the target: VALIDATED_FRAGILE', async () => {
    const result = await validator().validate(
      page,
      change(element({ css: 'main > section:nth-of-type(2) > div:nth-of-type(2) > input' })),
      '#v2',
    );
    expect(result?.status).toBe('VALIDATED_FRAGILE');
  });

  it('§55 a button is resolved, never clicked again', async () => {
    const result = await validator().validate(
      page,
      {
        id: 'r1',
        sequence: 1,
        type: 'click',
        at: 0,
        url: 'http://app.test/',
        element: element({
          tag: 'button',
          role: 'button',
          name: 'Apply',
          text: 'Apply',
          css: '#apply',
          cssStable: true,
        }),
      },
      '#apply',
    );
    expect(result?.status).toBe('VALIDATED');
    expect(await page.locator('#count').textContent()).toBe('0');
  });

  it('§56 a drag: item and drop zone resolved, the drag is never performed again', async () => {
    // L'humain a glissé Status vers les colonnes sélectionnées (simulé : le DOM après le dépôt).
    await page.evaluate(() => {
      const status = document.getElementById('col-status');
      if (status) document.getElementById('selected')?.appendChild(status);
    });
    const result = await validator().validate(
      page,
      {
        id: 'r2',
        sequence: 2,
        type: 'drag',
        at: 0,
        url: 'http://app.test/',
        drag: {
          kind: 'POINTER',
          item: 'Status',
          source: { section: 'Settings > Columns' },
          destination: { section: 'Settings > Columns', label: 'Selected columns' },
          sameZone: false,
          moved: true,
        },
      },
      '#col-status',
    );
    expect(result?.status).toBe('VALIDATED');
    expect(result?.drag).toEqual({ item: 'VALIDATED', destination: 'VALIDATED', movedObserved: true });
    // Déplacé UNE fois : toujours dans la destination, une seule fois, jamais revenu.
    expect(await page.locator('#selected li', { hasText: 'Status' }).count()).toBe(1);
    expect(await page.locator('#available li', { hasText: 'Status' }).count()).toBe(0);
  });

  it('an element the action itself hid (a step button replaced by the next one): NOT_VALIDATABLE, never "repaired" into a selector', async () => {
    const result = await validator().validate(
      page,
      {
        id: 'r3',
        sequence: 3,
        type: 'click',
        at: 0,
        url: 'http://app.test/',
        element: element({
          tag: 'button',
          role: 'button',
          name: 'Continue',
          text: 'Continue',
          css: '#gone',
          cssStable: true,
        }),
      },
      '#gone',
    );
    expect(result?.status).toBe('NOT_VALIDATABLE');
    expect(result?.validationBefore.reason).toMatch(/TARGET_HIDDEN_BY_ACTION/);
    expect(result?.targetAfter).toBeUndefined();
  });

  it('a Material field labelled through aria-labelledby: the replay reader reads the same label — VALIDATED, no false REPLAY_FINGERPRINT_CHECK_WOULD_FAIL', async () => {
    const result = await validator().validate(
      page,
      change(element({ label: 'My tasks', name: 'My tasks', css: '#tasksSearch', cssStable: true })),
      '#tasksSearch',
    );
    expect(result?.validationBefore.reason).not.toMatch(/REPLAY_FINGERPRINT_CHECK_WOULD_FAIL/);
    expect(result?.status).toBe('VALIDATED');
  });

  it('a custom list (mat-select) clicked by its placeholder text: the text inside the control is the same control — VALIDATED', async () => {
    const result = await validator().validate(
      page,
      {
        id: 'r4',
        sequence: 4,
        type: 'click',
        at: 0,
        url: 'http://app.test/',
        element: element({
          tag: 'div',
          role: 'combobox',
          name: 'Select an attribute',
          text: 'Select an attribute',
          css: '#attribute',
          cssStable: true,
        }),
      },
      '#attribute',
    );
    expect(result?.validationBefore.reason).not.toMatch(/RESOLVED_OTHER_ELEMENT/);
    expect(result?.status).toBe('VALIDATED');
  });

  it('a field typed in several input events is validated once (same result reused)', async () => {
    const v = validator();
    const event = change(
      element({ label: 'My tasks', name: 'My tasks', css: '#tasksSearch', cssStable: true }),
    );
    const [first, second] = await Promise.all([
      v.validate(page, { ...event, id: 'r10', type: 'input' }, '#tasksSearch'),
      v.validate(page, { ...event, id: 'r11', type: 'input' }, '#tasksSearch'),
    ]);
    expect(first?.status).toBe('VALIDATED');
    expect(second?.rawEventId).toBe('r11');
    expect(second?.log).toEqual([]);
  });

  it('the same id twice (a hidden template + the open panel): the replay picks the visible one in the dialog — VALIDATED, not AMBIGUOUS', async () => {
    const result = await validator().validate(
      page,
      change(element({ css: '.dup', cssStable: true })),
      '[role="dialog"] .dup',
    );
    expect(result?.validationBefore.status).not.toBe('AMBIGUOUS');
    expect(result?.status).toBe('VALIDATED');
  });

  it('a hidden copy first: the replay would pick it — repaired to the visible element (never a position), then revalidated', async () => {
    const result = await validator().validate(
      page,
      change(element({ css: '.dup2', cssStable: true })),
      'div:not([hidden]) > .dup2',
    );
    expect(result?.validationBefore.status).toBe('AMBIGUOUS');
    expect(result?.status).toBe('VALIDATED');
    expect(result?.targetAfter).toEqual({ strategy: 'css', value: '.dup2 >> visible=true' });
  });

  it('a text also present in hidden copies: repaired to the visible text, revalidated', async () => {
    const result = await validator().validate(
      page,
      {
        id: 'r5',
        sequence: 5,
        type: 'click',
        at: 0,
        url: 'http://app.test/',
        element: element({
          tag: 'div',
          role: '',
          name: 'Process request',
          text: 'Process request',
          css: '.tile',
          cssStable: true,
        }),
      },
      '.tile',
    );
    expect(result?.validationBefore.status).toBe('AMBIGUOUS');
    expect(result?.status).toBe('VALIDATED');
    expect(result?.targetAfter).toEqual({ strategy: 'css', value: 'text="Process request" >> visible=true' });
  });

  it('identical inputs told apart by a stable attribute (formControlName): repaired deterministically, no advisor call', async () => {
    const provider = new FakeIntelligenceProvider(pick('[1]'));
    const result = await validator(targetAuditAdvisor(gateway('ASSIST', provider), { maxCalls: 5 })).validate(
      page,
      change(element({ css: '#bound .ctl' })),
      '[formcontrolname="zip"]',
    );
    expect(result?.validationBefore.status).toBe('AMBIGUOUS');
    expect(result?.status).toBe('VALIDATED');
    expect(result?.targetAfter).toEqual({ strategy: 'css', value: 'input[formcontrolname="zip"]' });
    expect(provider.requests).toHaveLength(0);
  });

  it('the advisor sees which candidate the human was just using (FOCUSED), never the typed value', async () => {
    await page.locator('#v3').fill('typed-by-the-human');
    await page.locator('#v3').focus();
    const provider = new FakeIntelligenceProvider(pick('[2]'));
    const result = await validator(targetAuditAdvisor(gateway('ASSIST', provider), { maxCalls: 5 })).validate(
      page,
      change(unnamedValue),
      '#v3',
    );
    const sent = JSON.stringify(provider.requests);
    expect(sent).toContain('FOCUSED');
    expect(sent).not.toContain('typed-by-the-human');
    expect(result?.status).toBe('VALIDATED_AFTER_AI_AUDIT');
    await page.locator('#v3').fill('');
  });
});
