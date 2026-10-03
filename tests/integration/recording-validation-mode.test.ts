import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IntelligenceGateway } from '../../src/ai/gateway.js';
import type { IntelligenceMode, IntelligenceRequest } from '../../src/ai/model.js';
import { IntelligenceContextSanitizer } from '../../src/ai/sanitizer.js';
import type { PreActionContext, RawRecordedEvent, RecordedElement } from '../../src/recording/model.js';
import { targetAuditAdvisor } from '../../src/recording/semantic-audit.js';
import {
  RecordingTargetValidator,
  type TargetValidationStatus,
} from '../../src/recording/target-validator.js';
import { valueDigest } from '../../src/forms/state/value-digest.js';
import { FakeIntelligenceProvider } from '../fixtures/fake-intelligence-provider.js';

/**
 * RECORDING VALIDATION ≠ REPLAY RECOVERY, dans un vrai navigateur. CIBLE, EFFET et OBJECTIF sont
 * trois verdicts séparés ; un nœud re-rendu après l'action ne prouve pas une erreur de l'humain ;
 * une proposition du conseiller sur une ambiguïté pré-action est revalidée contre les preuves d'avant.
 */
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Tasks</title><style>.hidden{display:none}</style></head><body><main>
<h1>Tasks</h1>
<button type="button" id="openFilter">Filter</button>
<div role="dialog" aria-label="Filter" id="panel" class="hidden">
  <label>Field <select id="field"><option>--</option><option>Company name</option><option>City</option></select></label>
  <label>Operator <select id="operator"><option>--</option><option>Like</option><option>Equals</option></select></label>
  <div><span>Value</span><input id="valueInput" list="hints"></div>
  <div><span>Note</span><input id="extraValue"></div>
  <datalist id="hints"><option>alpha</option></datalist>
  <button type="button" id="apply">Apply</button>
</div>
<section aria-labelledby="g"><h2 id="g">General</h2><label>Priority <input id="generalPriority"></label></section>
<section aria-labelledby="f"><h2 id="f">Filters</h2><label>Priority <input id="filterPriority"></label></section>
<label>Password <input type="password" id="secret"></label>
</main><script>
  document.getElementById('openFilter').addEventListener('click', (event) => {
    event.currentTarget.classList.add('hidden');
    document.getElementById('panel').classList.remove('hidden');
  });
  window.__qaCrawlerOriginal = (ref) => document.querySelector(ref);
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
const pre = (overrides: Partial<PreActionContext> = {}): PreActionContext => ({
  route: '/',
  title: 'Tasks',
  headings: ['Tasks'],
  cssCount: 1,
  sameText: 1,
  selected: [],
  peers: [],
  loading: false,
  ...overrides,
});
let sequence = 500;
const event = (
  type: RawRecordedEvent['type'],
  el: RecordedElement,
  extra: Partial<RawRecordedEvent> = {},
): RawRecordedEvent => {
  sequence += 1;
  return {
    id: `r${String(sequence)}`,
    sequence,
    type,
    at: sequence * 1000,
    url: 'http://app.test/',
    element: el,
    ...extra,
  };
};

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
  (text: string, extra: Record<string, unknown> = {}) =>
  (request: IntelligenceRequest): unknown => {
    const chosen = request.availableActions.find((action) => action.name.includes(text));
    return {
      status: chosen ? 'PROPOSAL' : 'INCONCLUSIVE',
      ...(chosen ? { selectedActionId: chosen.id } : {}),
      supportingEvidenceIds: [],
      uncertainties: [],
      confidence: 0.9,
      ...extra,
    };
  };

const SALT = 'test-salt';
const AUDIT: ReadonlySet<TargetValidationStatus> = new Set(['AMBIGUOUS', 'MISMATCH', 'CONTEXT_MISMATCH']);

describe('ValidationMode.RECORDING: target, effect and goal are separate (real browser)', () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
  });
  beforeEach(async () => {
    await page.setContent(PAGE);
  });
  afterAll(async () => {
    await browser.close();
  });
  const validator = (provider?: FakeIntelligenceProvider): RecordingTargetValidator => {
    const v = new RecordingTargetValidator({
      maxDeterministicRepairAttempts: 2,
      auditOn: AUDIT,
      flowName: 'filter-requests',
      ...(provider ? { advisor: targetAuditAdvisor(gateway('ASSIST', provider), { maxCalls: 5 }) } : {}),
    });
    v.useValueSalt(SALT);
    return v;
  };
  /** L'humain a saisi « alpha » ; le framework remplace ensuite le nœud A par un nœud B (re-rendu). */
  const fillThenRerender = async (): Promise<void> => {
    await page.locator('#openFilter').click();
    await page.locator('#valueInput').fill('alpha');
    await page.evaluate(() => {
      const a = document.getElementById('valueInput');
      const b = document.createElement('input');
      b.id = 'valueInput';
      b.value = 'alpha';
      a?.replaceWith(b);
    });
  };
  const valueField = (): RecordedElement =>
    element({
      role: 'combobox',
      css: '#valueInput',
      cssStable: true,
      elementId: 'valueInput',
      inDialog: true,
      dialogName: 'Filter',
    });

  it('node A re-rendered after the FILL, #valueInput now designates node B: target VALIDATED_PRE_ACTION, no fingerprint mismatch, no recovery; effect CONFIRMED; goal REACHED', async () => {
    await fillThenRerender();
    const result = await validator().validate(
      page,
      event('input', valueField(), {
        value: { empty: false, length: 5, shape: 'text', digest: valueDigest('alpha', SALT) },
        pre: pre({
          route: 'blank',
          dialog: 'Filter',
          cssCount: 1,
          headings: ['Tasks', 'General', 'Filters'],
        }),
      }),
      undefined,
    );
    expect(result?.mode).toBe('RECORDING');
    expect(result?.status).toBe('VALIDATED_PRE_ACTION');
    expect(result?.verdict.target).toMatchObject({
      status: 'VALIDATED_PRE_ACTION',
      source: 'PRE_ACTION_CONTEXT',
    });
    // L'après (nœud B) n'est qu'une preuve : jamais un écart d'identité, jamais GOAL_ALREADY_REACHED.
    expect(result?.validationBefore.differences).toEqual([]);
    expect(result?.validationBefore.postState).toBeDefined();
    expect(result?.log.join('\n')).not.toMatch(/GOAL_ALREADY_REACHED|RECOVERED|TARGET_MISMATCH/);
    expect(result?.verdict.effect.status).toBe('CONFIRMED');
    expect(result?.verdict.effect.evidence.join(' ')).toContain('holds the typed value');
    expect(result?.verdict.goal.status).toBe('REACHED');
    // Jamais la valeur en clair : une empreinte salée.
    expect(JSON.stringify(result)).not.toContain('alpha');
    // Jamais rejouée : la valeur est restée celle de l'humain.
    expect(await page.locator('#valueInput').inputValue()).toBe('alpha');
  });

  it('the effect is a separate verdict: a value that is not in the field leaves the target VALIDATED_PRE_ACTION and the effect NOT_OBSERVED', async () => {
    await fillThenRerender();
    const result = await validator().validate(
      page,
      event('input', valueField(), {
        value: { empty: false, length: 4, shape: 'text', digest: valueDigest('beta', SALT) },
        pre: pre({ dialog: 'Filter', cssCount: 1 }),
      }),
      undefined,
    );
    expect(result?.verdict.target.status).toBe('VALIDATED_PRE_ACTION');
    expect(result?.verdict.effect.status).toBe('NOT_OBSERVED');
    expect(result?.verdict.goal.status).toBe('NOT_OBSERVED');
  });

  it('an effect never validates a target: the original is gone, the selector matched 2 elements before the action → AMBIGUOUS even though the post-action match is unique and the value is there', async () => {
    await fillThenRerender();
    const result = await validator().validate(
      page,
      event('input', valueField(), {
        value: { empty: false, length: 5, shape: 'text', digest: valueDigest('alpha', SALT) },
        pre: pre({ dialog: 'Filter', cssCount: 2 }),
      }),
      undefined,
    );
    expect(result?.status).toBe('AMBIGUOUS');
    expect(result?.validationBefore.reason).toMatch(/PRE_ACTION_AMBIGUOUS/);
    expect(result?.verdict.target).toMatchObject({ status: 'AMBIGUOUS', source: 'NONE' });
    expect(result?.verdict.effect.status).toBe('CONFIRMED');
    expect(result?.requiresReplayValidation).toBe(true);
  });

  /** Deux champs « Priority » visibles avant l'action ; l'original (section Filters) a disparu. */
  const priority = (peers: PreActionContext['peers']): RawRecordedEvent =>
    event(
      'input',
      element({
        name: 'Priority',
        css: 'main input.priority',
        sameRoleName: 2,
        sameLabel: 2,
        sectionPath: ['Filters'],
      }),
      { value: { empty: false, length: 4, shape: 'text' }, pre: pre({ cssCount: 2, peers }) },
    );
  const BOTH: PreActionContext['peers'] = [
    { role: 'textbox', name: 'Priority', section: 'General' },
    { role: 'textbox', name: 'Priority', section: 'Filters' },
  ];

  it('a pre-action AMBIGUITY is submitted to the advisor; a proposal with the pre-action identity, unique before the action, is accepted (ADVISOR_REVALIDATED)', async () => {
    const provider = new FakeIntelligenceProvider(pick('in "Filters"'));
    const result = await validator(provider).validate(page, priority(BOTH), undefined);
    expect(provider.requests).toHaveLength(1);
    expect(result?.aiAudit?.outcome).toBe('AI_PROPOSAL_RUNTIME_CONFIRMED');
    expect(result?.status).toBe('VALIDATED_AFTER_AI_AUDIT');
    expect(result?.verdict.target.source).toBe('ADVISOR_REVALIDATED');
    expect(result?.targetAfter).toMatchObject({ strategy: 'role', name: 'Priority', section: 'Filters' });
    expect(result?.repair?.evidence).toContain('pre-action-peers');
  });

  it('a proposal that contradicts the pre-action identity is rejected: the human action is preserved, still AMBIGUOUS', async () => {
    const provider = new FakeIntelligenceProvider(pick('in "General"'));
    const result = await validator(provider).validate(page, priority(BOTH), undefined);
    expect(result?.aiAudit?.outcome).toBe('AI_PROPOSAL_RUNTIME_REJECTED');
    expect(result?.status).toBe('AMBIGUOUS');
    expect(result?.verdict.target.source).toBe('NONE');
    expect(result?.repairApplied).toBe(false);
  });

  it('when the pre-action evidence cannot single the proposal out (two identical elements before the action): INCONCLUSIVE', async () => {
    const provider = new FakeIntelligenceProvider(pick('in "Filters"'));
    const result = await validator(provider).validate(
      page,
      priority([
        { role: 'textbox', name: 'Priority', section: 'Filters' },
        { role: 'textbox', name: 'Priority', section: 'Filters' },
      ]),
      undefined,
    );
    expect(result?.aiAudit?.outcome).toBe('INCONCLUSIVE');
    expect(result?.status).toBe('AMBIGUOUS');
  });

  it('the advisor context says RECORDING: the action is never replayed, and target, effect and goal are separate', async () => {
    const provider = new FakeIntelligenceProvider(pick('in "Filters"'));
    await validator(provider).validate(page, priority(BOTH), undefined);
    const context = provider.requests[0]?.recordingContext as {
      mission?: { validationMode?: string; constraints?: string[] };
    };
    expect(context.mission?.validationMode).toBe('RECORDING');
    expect(context.mission?.constraints?.join(' ')).toMatch(/never validates a target/);
  });
});
