import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IntelligenceGateway } from '../../src/ai/gateway.js';
import type { IntelligenceMode, IntelligenceRequest } from '../../src/ai/model.js';
import { IntelligenceContextSanitizer } from '../../src/ai/sanitizer.js';
import type {
  PreActionCandidate,
  PreActionContext,
  RawRecordedEvent,
  RecordedElement,
} from '../../src/recording/model.js';
import { ContextRelevanceSelector } from '../../src/recording/recording-intelligence-context.js';
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

/** Les candidats figés AVANT l'action : T1 le champ valeur du panneau Filter (original), T2 la recherche globale. */
const candidate = (overrides: Partial<PreActionCandidate> & { id: string }): PreActionCandidate => ({
  origin: 'CONTEXT',
  relationship: 'SAME_ROLE',
  tag: 'input',
  role: 'textbox',
  name: '',
  stableAttributes: {},
  visible: true,
  enabled: true,
  editable: true,
  ...overrides,
});
const FILTER_VALUE = candidate({
  id: 'T1',
  origin: 'ORIGINAL_HUMAN_TARGET',
  relationship: 'SELF',
  stableAttributes: { id: 'valueInput' },
  section: 'Filter',
  dialog: 'Filter',
  nearby: ['Company name', 'Like'],
  cssHint: '#valueInput',
});
const GLOBAL_SEARCH = candidate({
  id: 'T2',
  name: 'Search',
  label: 'Search',
  section: 'Requests',
  cssHint: '#search',
});

describe('Pre-action candidate set in the validator (real browser)', () => {
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
  const validator = (provider?: FakeIntelligenceProvider, log?: string[]): RecordingTargetValidator =>
    new RecordingTargetValidator({
      maxDeterministicRepairAttempts: 2,
      auditOn: AUDIT,
      flowName: 'filter-requests',
      ...(provider ? { advisor: targetAuditAdvisor(gateway('ASSIST', provider), { maxCalls: 5 }) } : {}),
      ...(log ? { log: (line: string) => log.push(line) } : {}),
    });
  /** Le champ valeur, disparu après l'action ; la représentation (#valueInput) trouvait 2 éléments avant. */
  const valueEvent = (candidates: PreActionCandidate[], originalCandidateId?: string): RawRecordedEvent =>
    event(
      'input',
      element({
        role: 'textbox',
        css: '#valueInput',
        cssStable: true,
        elementId: 'valueInput',
        sectionPath: ['Filter'],
      }),
      {
        value: { empty: false, length: 5, shape: 'text' },
        pre: pre({
          phase: 'FOCUSIN',
          generation: 3,
          cssCount: 2,
          candidates,
          ...(originalCandidateId ? { originalCandidateId } : {}),
        }),
      },
    );
  /** Le parcours : champ et opérateur choisis avant, « Apply » après (des preuves, pas une vérité). */
  const observeJourney = (v: RecordingTargetValidator, value: RawRecordedEvent): void => {
    const select = (name: string, option: string): RawRecordedEvent =>
      event('change', element({ tag: 'select', role: 'combobox', name, label: name, css: `#${name}` }), {
        value: { empty: false, length: option.length, shape: 'text', option: { label: option } },
      });
    const apply = event('click', element({ tag: 'button', role: 'button', name: 'Apply', css: '#apply' }));
    for (const entry of [select('Field', 'Company name'), select('Operator', 'Like'), value, apply])
      v.observe(entry);
  };

  it('candidates=0 despite a successful capture: PRE_ACTION_CAPTURE_INCOMPLETE, diagnosed — and the advisor is never asked to invent a target', async () => {
    const provider = new FakeIntelligenceProvider(pick('Search'));
    const log: string[] = [];
    const result = await validator(provider, log).validate(page, valueEvent([]), undefined);
    expect(result?.preActionCapture).toMatchObject({ captured: true, complete: false, candidateCount: 0 });
    expect(result?.preActionCapture?.diagnostic).toMatch(/PRE_ACTION_CAPTURE_INCOMPLETE: candidates=0/);
    expect(log.join('\n')).toMatch(/\[PRE_ACTION_CAPTURE_INCOMPLETE\]/);
    expect(provider.requests).toHaveLength(0);
    expect(result?.aiAudit?.outcome).toBe('NOT_CALLED');
    expect(result?.status).toBe('AMBIGUOUS');
  });

  it('the advisor receives the PRE-ACTION candidates (T1 = original, with its nearby context) and the future actions; choosing T1 is confirmed against the pre-action evidence', async () => {
    const provider = new FakeIntelligenceProvider(pick('near "Company name'));
    const log: string[] = [];
    const v = validator(provider, log);
    const value = valueEvent([FILTER_VALUE, GLOBAL_SEARCH], 'T1');
    observeJourney(v, value);
    const result = await v.validate(page, value, undefined);
    expect(log.join('\n')).toMatch(
      /\[PRE_ACTION_CAPTURE\] action=\S+ type=INPUT target=input#valueInput phase=FOCUSIN generation=3 candidates=2 originalCandidate=T1/,
    );
    expect(log.join('\n')).toMatch(/\[AI_PRE_ACTION_AUDIT_REQUESTED\]/);
    expect(log.join('\n')).toMatch(/\[AI_PRE_ACTION_PROPOSAL_CONFIRMED\] action=\S+ candidate=T1/);
    expect(result?.aiAudit).toMatchObject({ outcome: 'AI_PROPOSAL_RUNTIME_CONFIRMED', candidate: 'T1' });
    expect(result?.status).toBe('VALIDATED_AFTER_AI_AUDIT');
    expect(result?.validatedCandidate).toBe('T1');
    // La représentation enregistrée est gardée : l'identité est prouvée, rien n'est « corrigé ».
    expect(result?.targetAfter).toBeUndefined();
    const context = provider.requests[0]?.recordingContext as {
      candidates: {
        origin?: string;
        nearby?: string[];
        capturedBeforeAction?: boolean;
        locatorEvidence: { locator: string };
      }[];
      nextActions: { actions: { type: string; target: string }[] };
    };
    const original = context.candidates.find((entry) => entry.origin === 'ORIGINAL_HUMAN_TARGET');
    expect(original).toMatchObject({ capturedBeforeAction: true, nearby: ['Company name', 'Like'] });
    expect(original?.locatorEvidence.locator).toBe('#valueInput');
    expect(context.nextActions.actions.map((entry) => entry.target)).toContain('Apply');
  });

  it('choosing T2 (the global search box) is rejected: it is not the original human target captured before the action — the human action is preserved', async () => {
    const provider = new FakeIntelligenceProvider(pick('Search'));
    const log: string[] = [];
    const v = validator(provider, log);
    const value = valueEvent([FILTER_VALUE, GLOBAL_SEARCH], 'T1');
    observeJourney(v, value);
    const result = await v.validate(page, value, undefined);
    expect(log.join('\n')).toMatch(/\[AI_PRE_ACTION_PROPOSAL_REJECTED\] action=\S+ candidate=T2/);
    expect(result?.aiAudit).toMatchObject({ outcome: 'AI_PROPOSAL_RUNTIME_REJECTED', candidate: 'T2' });
    expect(result?.status).toBe('AMBIGUOUS');
    expect(result?.repairApplied).toBe(false);
  });

  it('the representation matched 2 elements before the action, but the original candidate was the only "Priority" in its section: deterministic reconstruction, VALIDATED_PRE_ACTION — no advisor', async () => {
    const provider = new FakeIntelligenceProvider(pick('Priority'));
    const result = await validator(provider).validate(
      page,
      valueEvent(
        [
          candidate({
            id: 'T1',
            origin: 'ORIGINAL_HUMAN_TARGET',
            relationship: 'SELF',
            name: 'Priority',
            label: 'Priority',
            section: 'Filters',
          }),
          candidate({ id: 'T2', name: 'Priority', label: 'Priority', section: 'General' }),
        ],
        'T1',
      ),
      undefined,
    );
    // (L'écran de test change aussi de route : l'effet est un verdict à part, l'identité est pré-action.)
    expect(result?.status).toMatch(/^VALIDATED_(PRE_ACTION|WITH_EFFECT)$/);
    expect(result?.verdict.target).toMatchObject({
      status: 'VALIDATED_PRE_ACTION',
      source: 'PRE_ACTION_CONTEXT',
    });
    expect(result?.repair?.reason).toBe('PRE_ACTION_CANDIDATE_RECONSTRUCTION');
    expect(result?.targetAfter).toEqual({ strategy: 'label', value: 'Priority', section: 'Filters' });
    expect(provider.requests).toHaveLength(0);
  });

  it('STOP: the validations still queued stay deterministic — the advisor is never called after the stop (the deferred audit is counted)', async () => {
    const provider = new FakeIntelligenceProvider(pick('near "Company name'));
    const log: string[] = [];
    const v = validator(provider, log);
    v.drain();
    const value = valueEvent([FILTER_VALUE, GLOBAL_SEARCH], 'T1');
    observeJourney(v, value);
    const result = await v.validate(page, value, undefined);
    expect(provider.requests).toHaveLength(0);
    expect(result?.aiAudit?.outcome).toBe('NOT_CALLED');
    expect(result?.aiAudit?.reason).toMatch(/recording stopped/);
    expect(v.deferredAudits).toBe(1);
    expect(v.pending).toBe(0);
    expect(result?.status).toBe('AMBIGUOUS');
  });

  it('the relevance selector never drops the original human target, whatever its similarity', () => {
    const selector = new ContextRelevanceSelector({ previous: 5, next: 2, candidates: 2 });
    const kept = selector.candidates([
      { id: 'a', similarity: 0.9 },
      { id: 'b', similarity: 0.8 },
      { id: 'original', similarity: 0.1, pinned: true },
    ]);
    expect(kept.map((entry) => entry.id)).toEqual(['a', 'original']);
  });
});
