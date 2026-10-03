import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IntelligenceGateway } from '../../src/ai/gateway.js';
import type { IntelligenceMode, IntelligenceRequest } from '../../src/ai/model.js';
import { IntelligenceContextSanitizer } from '../../src/ai/sanitizer.js';
import type { PreActionContext, RawRecordedEvent, RecordedElement } from '../../src/recording/model.js';
import type {
  EvidenceSources,
  RecordingAuditContext,
} from '../../src/recording/recording-intelligence-context.js';
import { targetAuditAdvisor } from '../../src/recording/semantic-audit.js';
import {
  RecordingTargetValidator,
  type TargetValidationStatus,
} from '../../src/recording/target-validator.js';
import { FakeIntelligenceProvider } from '../fixtures/fake-intelligence-provider.js';

/**
 * PRE-ACTION VALIDATION + CONTEXT BEFORE DECISION, dans un vrai navigateur. L'élément original est
 * désigné par un sélecteur ; le contexte pré-action est celui que la capture enverrait.
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
let sequence = 100;
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
const contextOf = (provider: FakeIntelligenceProvider): RecordingAuditContext =>
  provider.requests[0]?.recordingContext as unknown as RecordingAuditContext;

const AUDIT: ReadonlySet<TargetValidationStatus> = new Set(['AMBIGUOUS', 'MISMATCH', 'CONTEXT_MISMATCH']);

describe('Pre-action validation and recording AI context (real browser)', () => {
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
  const validator = (
    provider?: FakeIntelligenceProvider,
    sources?: EvidenceSources,
  ): RecordingTargetValidator =>
    new RecordingTargetValidator({
      maxDeterministicRepairAttempts: 0,
      auditOn: AUDIT,
      flowName: 'filter-requests',
      ...(provider ? { advisor: targetAuditAdvisor(gateway('ASSIST', provider), { maxCalls: 5 }) } : {}),
      ...(sources ? { sources } : {}),
    });

  /** L'humain filtre : Field = Company name, Operator = Like, puis la valeur ; « Apply » a déjà été reçu. */
  const filterScenario = async (v: RecordingTargetValidator): Promise<RawRecordedEvent> => {
    await page.locator('#openFilter').click();
    await page.locator('#field').selectOption('Company name');
    await page.locator('#operator').selectOption('Like');
    const field = event(
      'change',
      element({
        tag: 'select',
        role: 'combobox',
        name: 'Field',
        label: 'Field',
        css: '#field',
        cssStable: true,
      }),
      {
        value: { empty: false, length: 12, shape: 'text', option: { label: 'Company name' } },
        pre: pre({ dialog: 'Filter' }),
      },
    );
    const operator = event(
      'change',
      element({
        tag: 'select',
        role: 'combobox',
        name: 'Operator',
        label: 'Operator',
        css: '#operator',
        cssStable: true,
      }),
      {
        value: { empty: false, length: 4, shape: 'text', option: { label: 'Like' } },
        pre: pre({ dialog: 'Filter', selected: [{ label: 'Field', value: 'Company name' }] }),
      },
    );
    // Un sélecteur générique : deux champs de valeur visibles dans la fenêtre (ambigu).
    const value = event(
      'change',
      element({
        role: 'combobox',
        css: '#panel input',
        cssStable: false,
        inDialog: true,
        dialogName: 'Filter',
      }),
      {
        value: { empty: false, length: 5, shape: 'text' },
        pre: pre({
          dialog: 'Filter',
          cssCount: 2,
          selected: [
            { label: 'Field', value: 'Company name' },
            { label: 'Operator', value: 'Like' },
          ],
        }),
      },
    );
    const apply = event(
      'click',
      element({
        tag: 'button',
        role: 'button',
        name: 'Apply',
        text: 'Apply',
        css: '#apply',
        cssStable: true,
      }),
    );
    for (const entry of [field, operator, value, apply]) v.observe(entry);
    await page.locator('#valueInput').fill('alpha');
    await page.locator('#valueInput').focus();
    return value;
  };

  it('§48.1 the button disappears with its click: validated from the pre-action context, with the observed effect', async () => {
    await page.locator('#openFilter').click();
    const result = await validator().validate(
      page,
      event(
        'click',
        element({
          tag: 'button',
          role: 'button',
          name: 'Filter',
          text: 'Filter',
          css: '#openFilter',
          cssStable: true,
        }),
        {
          pre: pre(),
        },
      ),
      '#openFilter',
    );
    expect(result?.status).toBe('VALIDATED_WITH_EFFECT');
    expect(result?.validationBefore.reason).toMatch(/TARGET_VALIDATED_PRE_ACTION/);
    expect(result?.effects).toContain('dialog "Filter" appeared');
    expect(result?.semanticallyConfirmed).toBe(true);
    expect(result?.originalTargetMatch).toBe(false);
  });

  it('§48.4 / §48.3 / §48.11 the filter workflow: the advisor understands field → operator → value → Apply, the semantic neighbours, the contradiction — and the runtime confirms its choice', async () => {
    const provider = new FakeIntelligenceProvider(
      pick('id=valueInput', { semanticTarget: { semanticId: 'filter.value', role: 'textbox' } }),
    );
    const v = validator(provider);
    const value = await filterScenario(v);
    const result = await v.validate(page, value, '#valueInput');
    expect(provider.requests).toHaveLength(1);
    const context = contextOf(provider);
    expect(context.mission.type).toBe('RECORDING_TARGET_AUDIT');
    expect(context.workflow.flowName).toBe('filter-requests');
    expect(context.screen.dialog).toBe('Filter');
    expect(
      context.previousActions.map((action) => `${action.type} ${action.target}=${action.value ?? ''}`),
    ).toEqual(['SELECT Field=Company name', 'SELECT Operator=Like']);
    expect(context.nextActions.actions.map((action) => `${action.type} ${action.target}`)).toEqual([
      'CLICK Apply',
    ]);
    expect(context.nextActions.authority).toBe('EVIDENCE_NOT_TRUTH');
    expect(context.businessContext?.configuration).toEqual({ Field: 'Company name', Operator: 'Like' });
    expect(context.businessContext?.observedPattern).toBe(
      'SELECT Field → SELECT Operator → CHANGE Value → CLICK Apply',
    );
    expect(context.formState).toMatchObject({
      Field: { value: 'Company name' },
      Operator: { value: 'Like' },
    });
    expect(context.dependencies.map((dependency) => dependency.source)).toEqual(['Field', 'Operator']);
    // Les voisins sémantiques : chaque candidat a son identité fonctionnelle, pas seulement un localisateur.
    const nearby = context.candidates.map((candidate) => candidate.nearbyText).filter(Boolean);
    expect(nearby).toEqual(expect.arrayContaining(['Value', 'Note']));
    expect(
      context.candidates.every((candidate) => candidate.runtimeMatch.originalTargetSimilarity >= 0),
    ).toBe(true);
    // L'identité stable de l'original (son id) est transmise — jamais sa valeur.
    expect(context.originalTarget.stableAttributes).toEqual({ id: 'valueInput' });
    expect(result?.status).toBe('VALIDATED_AFTER_AI_AUDIT');
    expect(result?.aiAudit?.outcome).toBe('AI_PROPOSAL_RUNTIME_CONFIRMED');
    expect(result?.fingerprintAfter?.semanticId).toBe('filter.value');
    expect(result?.aiAudit?.context).toBeDefined();
  });

  it('§48.2 / §48.5 Priority vs Filter: the advisor sees both sections, and the candidate of the human section scores higher', async () => {
    const provider = new FakeIntelligenceProvider(pick('General'));
    const result = await validator(provider).validate(
      page,
      event('change', element({ label: 'Priority', name: 'Priority', css: 'section input', sameLabel: 2 }), {
        value: { empty: false, length: 1, shape: 'number' },
        pre: pre({ cssCount: 2 }),
      }),
      '#generalPriority',
    );
    const context = contextOf(provider);
    const sections = context.candidates.map((candidate) => candidate.section).filter(Boolean);
    expect(sections.join(' | ')).toMatch(/General/);
    expect(sections.join(' | ')).toMatch(/Filters/);
    const general = context.candidates.find((candidate) => candidate.section?.endsWith('General'));
    const filters = context.candidates.find((candidate) => candidate.section?.endsWith('Filters'));
    expect(general?.runtimeMatch.originalTargetSimilarity ?? 0).toBeGreaterThan(
      filters?.runtimeMatch.originalTargetSimilarity ?? 0,
    );
    expect(result?.aiAudit?.outcome).toBe('AI_PROPOSAL_RUNTIME_CONFIRMED');
  });

  it('§48.8 secrets are never in the AI request (typed values, password field)', async () => {
    await page.locator('#secret').fill('S3cret-Value-9z');
    const provider = new FakeIntelligenceProvider(pick('id=valueInput'));
    const v = validator(provider);
    const value = await filterScenario(v);
    await v.validate(page, value, '#valueInput');
    const sent = JSON.stringify(provider.requests);
    expect(sent).not.toContain('S3cret-Value-9z');
    expect(sent).not.toContain('alpha');
  });

  it('§48.9 AI OFF: no advisor, zero request — the deterministic result stands', async () => {
    const provider = new FakeIntelligenceProvider(pick('id=valueInput'));
    const v = new RecordingTargetValidator({ maxDeterministicRepairAttempts: 0, auditOn: AUDIT });
    const value = await filterScenario(v);
    const result = await v.validate(page, value, '#valueInput');
    expect(provider.requests).toHaveLength(0);
    expect(result?.status).toBe('AMBIGUOUS');
  });

  it('§48.10 an invented candidate is rejected (never applied)', async () => {
    const provider = new FakeIntelligenceProvider(() => ({
      status: 'PROPOSAL',
      selectedActionId: 'A99',
      supportingEvidenceIds: [],
      uncertainties: [],
      confidence: 1,
    }));
    const v = validator(provider);
    const value = await filterScenario(v);
    const result = await v.validate(page, value, '#valueInput');
    expect(result?.status).toBe('AMBIGUOUS');
    expect(result?.targetAfter).toBeUndefined();
    expect(result?.aiAudit?.outcome).not.toBe('AI_PROPOSAL_RUNTIME_CONFIRMED');
  });

  it('§48.12 an incorrect candidate (confidence 1.0) is rejected by the runtime', async () => {
    const provider = new FakeIntelligenceProvider(pick('id=extraValue', { confidence: 1 }));
    const v = validator(provider);
    const value = await filterScenario(v);
    const result = await v.validate(page, value, '#valueInput');
    expect(result?.aiAudit?.outcome).toBe('AI_PROPOSAL_RUNTIME_REJECTED');
    expect(result?.status).toBe('AMBIGUOUS');
  });

  it('§48.13 insufficient evidence: INCONCLUSIVE, the deterministic result stands', async () => {
    const provider = new FakeIntelligenceProvider(() => ({
      status: 'INCONCLUSIVE',
      supportingEvidenceIds: [],
      uncertainties: ['two value fields, no distinguishing evidence'],
      confidence: 0.2,
    }));
    const v = validator(provider);
    const value = await filterScenario(v);
    const result = await v.validate(page, value, '#valueInput');
    expect(result?.aiAudit?.outcome).toBe('INCONCLUSIVE');
    expect(result?.status).toBe('AMBIGUOUS');
  });

  it('§48.14 / §48.15 static and historical evidence are labelled as hints; when they contradict the runtime, the runtime wins', async () => {
    const sources: EvidenceSources = {
      staticEvidence: () => [
        {
          id: 'SE-1',
          type: 'FORM_CONTROL_MAPPING',
          component: 'filter-panel',
          formControl: 'note',
          possibleConcept: 'filter.value',
          confidence: 0.82,
        },
      ],
      historicalEvidence: () => [
        {
          id: 'H-1',
          type: 'PREVIOUS_MAPPING',
          statement: 'the value was the Note field last time',
          confidence: 0.7,
        },
      ],
    };
    // Le conseiller suit les indices (le champ « Note ») ; le runtime dit que l'humain a utilisé la valeur.
    const provider = new FakeIntelligenceProvider(pick('id=extraValue'));
    const v = validator(provider, sources);
    const value = await filterScenario(v);
    const result = await v.validate(page, value, '#valueInput');
    const context = contextOf(provider);
    expect(context.staticEvidence[0]?.authority).toBe('SUPPORTING_EVIDENCE');
    expect(context.historicalEvidence[0]?.authority).toBe('EXPERIENCE');
    expect(result?.aiAudit?.outcome).toBe('AI_PROPOSAL_RUNTIME_REJECTED');
  });

  it('§48.6 drag and drop: source / destination lists before and after are kept as evidence, never a second drag', async () => {
    await page.setContent(`<main><h1>Columns</h1>
      <div aria-labelledby="a"><h3 id="a">Available</h3><ul id="available"><li id="owner">Owner</li></ul></div>
      <div aria-labelledby="d"><h3 id="d">Displayed</h3><ul id="displayed" aria-label="Displayed columns"><li>Name</li><li id="status">Status</li></ul></div>
      <script>window.__qaCrawlerOriginal = (ref) => document.querySelector(ref.endsWith(':zone') ? '#displayed' : ref);</script></main>`);
    const result = await validator().validate(
      page,
      {
        id: 'r900',
        sequence: 900,
        type: 'drag',
        at: 0,
        url: 'http://app.test/',
        drag: {
          kind: 'POINTER',
          item: 'Status',
          source: { section: 'Columns > Available' },
          destination: { section: 'Columns > Displayed', label: 'Displayed columns' },
          sameZone: false,
          moved: true,
          lists: {
            sourceBefore: ['Status', 'Owner'],
            sourceAfter: ['Owner'],
            destinationAfter: ['Name', 'Status'],
          },
        },
      },
      '#status',
    );
    expect(result?.status).toBe('VALIDATED');
    expect(result?.drag?.lists).toEqual({
      sourceBefore: ['Status', 'Owner'],
      sourceAfter: ['Owner'],
      destinationAfter: ['Name', 'Status'],
    });
    expect(await page.locator('#displayed li', { hasText: 'Status' }).count()).toBe(1);
  });
});
