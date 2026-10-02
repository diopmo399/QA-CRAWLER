import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { parseConfig } from '../../src/config/config-loader.js';
import { flowSchema, type FlowStep } from '../../src/config/flow-schema.js';
import { accountHumanJourney, buildInteractionTimeline } from '../../src/recording/human-journey.js';
import type {
  RawRecordedEvent,
  RecordedElement,
  RecordedState,
  RecordedValueFacts,
  RecordingSession,
} from '../../src/recording/model.js';
import { processRecording } from '../../src/recording/process-recording.js';

const APP = 'http://app.test';
const mission = (extra = ''): ReturnType<typeof parseConfig>['config'] =>
  parseConfig(`mission: { name: journey }\ntarget: { baseUrl: "${APP}", startAt: /tasks }\n${extra}`, {}, {})
    .config;

/** Une session écrite comme l'humain l'a vécue : chaque geste, l'écran observé après lui. */
class Journey {
  events: RawRecordedEvent[] = [];
  states: RecordedState[] = [];
  typed = new Map<string, string>();
  private clock = 1000;
  private sequence = 0;

  constructor(route: string, controls: string[]) {
    this.screen(route, controls);
    this.raw('navigation', { url: `${APP}${route}` });
  }

  /** Un nouvel écran observé (son id). */
  screen(route: string, controls: string[], extra: Partial<RecordedState> = {}): string {
    const id = `o${String(this.states.length + 1)}`;
    this.states.push({
      id,
      stateId: `${route}-${id}`,
      label: route,
      route,
      url: `${APP}${route}`,
      title: route,
      headings: [],
      alerts: [],
      invalidFields: 0,
      dialogs: [],
      controls,
      ...extra,
    });
    return id;
  }

  raw(type: RawRecordedEvent['type'], extra: Partial<RawRecordedEvent> = {}): RawRecordedEvent {
    this.sequence += 1;
    this.clock += 700;
    const event: RawRecordedEvent = {
      id: `r${String(this.sequence)}`,
      sequence: this.sequence,
      type,
      at: this.clock,
      url: `${APP}${this.states.at(-1)?.route ?? '/'}`,
      ...extra,
    };
    this.events.push(event);
    return event;
  }

  click(
    name: string,
    element: Partial<RecordedElement> = {},
    after?: string,
    extra: Partial<RawRecordedEvent> = {},
  ): this {
    this.raw('click', {
      element: el(name, { tag: 'button', role: 'button', ...element }),
      ...(after ? { stateAfter: after } : {}),
      ...extra,
    });
    return this;
  }

  fill(label: string, value: string, element: Partial<RecordedElement> = {}): this {
    const event = this.raw('change', {
      element: el(label, {
        tag: 'input',
        role: 'textbox',
        label,
        inputType: 'text',
        nameAttr: camel(label),
        ...element,
      }),
      value: facts(value),
    });
    this.typed.set(event.id, value);
    return this;
  }

  check(label: string, after?: string): this {
    this.raw('change', {
      element: el(label, { tag: 'input', role: 'checkbox', label, inputType: 'checkbox' }),
      value: { empty: false, length: 0, shape: 'text', checked: true },
      ...(after ? { stateAfter: after } : {}),
    });
    return this;
  }

  select(label: string, option: string, after?: string): this {
    this.raw('change', {
      element: el(label, { tag: 'select', role: 'combobox', label }),
      value: {
        empty: false,
        length: 0,
        shape: 'text',
        option: { label: option, value: option.toUpperCase() },
      },
      ...(after ? { stateAfter: after } : {}),
    });
    return this;
  }

  session(): RecordingSession {
    return {
      id: 'rec-journey',
      name: 'Journey',
      startedAt: '2026-01-01T00:00:00.000Z',
      startUrl: `${APP}${this.states[0]?.route ?? '/'}`,
      status: 'PROCESSING',
      rawEvents: this.events,
      semanticActions: [],
      checkpoints: [],
      states: this.states,
      initialStateId: this.states[0]?.id,
      warnings: [],
      droppedEvents: 0,
    };
  }

  process(config = mission()) {
    const result = processRecording(this.session(), config, { language: 'en', typedValues: this.typed });
    const raw = parseYaml(result.files.yaml) as Record<string, unknown>;
    delete raw.testData;
    return { result, flow: flowSchema.parse(raw) };
  }
}

function el(name: string, extra: Partial<RecordedElement> = {}): RecordedElement {
  return {
    tag: 'button',
    role: 'button',
    name,
    text: name,
    css: `#${camel(name) || 'x'}`,
    cssStable: true,
    inForm: false,
    isSubmit: false,
    inNavigation: false,
    inDialog: false,
    sameRoleName: 1,
    roleNameIndex: 0,
    sameLabel: 1,
    ...extra,
  };
}
function facts(value: string): RecordedValueFacts {
  return {
    empty: false,
    length: value.length,
    shape: 'text',
    digest: `${value.length.toString(16).padStart(4, '0')}${'ab'.repeat(6)}`,
  };
}
function camel(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word, index) =>
      index === 0 ? word.toLowerCase() : `${word[0]?.toUpperCase() ?? ''}${word.slice(1).toLowerCase()}`,
    )
    .join('');
}
/** Ce que dit chaque étape : « click X », « fill Y », « check Z »… */
function described(steps: FlowStep[]): string[] {
  return steps.flatMap((step) => {
    switch (step.kind) {
      case 'click':
      case 'check':
      case 'uncheck':
        return [`${step.kind} ${step.target.name ?? step.target.value ?? ''}`];
      case 'fill':
        return [`fill ${step.target.value ?? step.target.name ?? ''}`];
      case 'select':
        return [`select ${step.target.value ?? ''}=${step.option}`];
      case 'intent':
        return [
          `intent ${step.intent.kind} ${'target' in step.intent ? step.intent.target : 'field' in step.intent ? step.intent.field : ''}`,
        ];
      default:
        return [];
    }
  });
}

describe('Human journey: a button, tab, section or menu clicked by the human is never lost', () => {
  it('§35 / §43: a button that reveals a section on the same URL is kept, and the fill depends on it', () => {
    const journey = new Journey('/simulator', ['button:Company information']);
    const revealed = journey.screen('/simulator', [
      'button:Company information',
      'textbox:Legal name',
      'textbox:Business number',
    ]);
    journey
      .click('Company information', {}, revealed)
      .fill('Legal name', 'Alpha inc')
      .fill('Business number', '1234');
    const { result, flow } = journey.process();
    expect(described(flow.steps)).toEqual([
      'click Company information',
      'fill Legal name',
      'fill Business number',
    ]);
    const click = result.normalized.kept.find((action) => action.target?.label === 'Company information');
    expect(click?.domEffects).toEqual(expect.arrayContaining(['FIELD_ADDED']));
    expect(result.journey.dependencies).toEqual(
      expect.arrayContaining([expect.objectContaining({ from: click?.id, evidence: 'FORWARD' })]),
    );
    expect(result.journey.summary.unaccounted).toBe(0);
  });

  it('§36: a real button with no detected effect stays in the flow, UNRESOLVED_BUT_PRESERVED', () => {
    const journey = new Journey('/simulator', ['button:Advanced mode', 'textbox:Amount']);
    journey.click('Advanced mode', {}, 'o1').fill('Amount', '120');
    const { result, flow } = journey.process();
    expect(described(flow.steps)).toEqual(['click Advanced mode', 'fill Amount']);
    expect(result.journey.accounts[0]).toMatchObject({ status: 'UNRESOLVED_BUT_PRESERVED', flowStep: 1 });
    expect(result.files.yaml).toContain('UNRESOLVED_HUMAN_ACTION');
  });

  it('§37 / §20: a tab clicked before filling is kept before the fill, even when the field looked reachable', () => {
    const journey = new Journey('/request', ['tab:Applicant', 'tab:Company', 'textbox:Legal name']);
    const company = journey.screen('/request', ['tab:Applicant', 'tab:Company', 'textbox:Legal name']);
    journey.click('Company', { role: 'tab' }, company).fill('Legal name', 'Alpha inc');
    const { result, flow } = journey.process();
    // Avant : la règle « détour » retirait l'onglet (le champ était visible). Le parcours enseigné l'emporte.
    expect(described(flow.steps)).toEqual(['click Company', 'fill Legal name']);
    expect(result.journey.summary).toMatchObject({ unaccounted: 0 });
  });

  it('§38 / §42: a custom component the capture did not recognise, but that opened fields, is kept UNRESOLVED', () => {
    const journey = new Journey('/request', ['button:Save']);
    const opened = journey.screen('/request', ['button:Save', 'textbox:Additional details']);
    journey.click('More information', { tag: 'div', role: '', css: 'x-panel > div.header' }, opened, {
      noise: 'click on a non-interactive element',
    });
    journey.fill('Additional details', 'Some text');
    const { result, flow } = journey.process();
    expect(described(flow.steps)[0]).toMatch(/More information/);
    expect(described(flow.steps)).toHaveLength(2);
    expect(result.journey.accounts[0]).toMatchObject({ status: 'UNRESOLVED_BUT_PRESERVED', flowStep: 1 });
    expect(result.files.yaml).toContain('UNRESOLVED_HUMAN_ACTION');
  });

  it('§10 / §42: backward causality — no observation after the click, but the next field did not exist before it', () => {
    const journey = new Journey('/request', ['button:Save']);
    journey.click('Employee section', { tag: 'mat-card', role: '' }, undefined, {
      noise: 'click on a non-interactive element',
    });
    journey.fill('Employee name', 'Jane');
    const { result } = journey.process();
    expect(result.journey.accounts.map((account) => account.status)).toEqual([
      'UNRESOLVED_BUT_PRESERVED',
      'PRESERVED',
    ]);
  });

  it('a click on plain content with no effect and nothing depending on it is confirmed noise (with its rule)', () => {
    const journey = new Journey('/request', ['textbox:Name']);
    journey.click('Some text', { tag: 'p', role: '' }, 'o1', { noise: 'click on a non-interactive element' });
    journey.fill('Name', 'Jane');
    const { result } = journey.process();
    expect(result.journey.accounts[0]).toMatchObject({
      status: 'HUMAN_NOISE',
      rule: 'NON_INTERACTIVE_NO_EFFECT',
    });
    expect(result.journey.summary.unaccounted).toBe(0);
  });

  it('§39: both "Continue" of a stepper are kept, the URL never changes', () => {
    const journey = new Journey('/wizard', ['button:Continue', 'textbox:Name']);
    const step2 = journey.screen('/wizard', ['button:Continue', 'textbox:Address']);
    const step3 = journey.screen('/wizard', ['button:Submit', 'textbox:Comment']);
    journey
      .fill('Name', 'Jane')
      .click('Continue', {}, step2)
      .fill('Address', '1 main st')
      .click('Continue', {}, step3)
      .fill('Comment', 'ok');
    const { flow } = journey.process();
    expect(described(flow.steps)).toEqual([
      'fill Name',
      'click Continue',
      'fill Address',
      'click Continue',
      'fill Comment',
    ]);
  });

  it('§40: menu → submenu → action are three steps', () => {
    const journey = new Journey('/home', ['button:Menu']);
    const menu = journey.screen('/home', ['button:Menu', 'menuitem:Requests']);
    const sub = journey.screen('/home', ['button:Menu', 'menuitem:Requests', 'menuitem:New request']);
    const form = journey.screen('/home', ['textbox:Title']);
    journey
      .click('Menu', {}, menu)
      .click('Requests', { role: 'menuitem' }, sub)
      .click('New request', { role: 'menuitem' }, form)
      .fill('Title', 'x');
    const { flow } = journey.process();
    expect(described(flow.steps)).toEqual([
      'click Menu',
      'click Requests',
      'click New request',
      'fill Title',
    ]);
  });

  it('§41: a focus click before typing is MERGED into the FILL (REDUNDANT_FOCUS_CLICK), never silently dropped', () => {
    const journey = new Journey('/form', ['textbox:Email']);
    journey.click('Email', { tag: 'input', role: 'textbox', label: 'Email' }, undefined, {
      noise: 'focus click in a field',
    });
    journey.fill('Email', 'a@b.c', { inputType: 'email' });
    const { result } = journey.process();
    const [focus, fill] = result.journey.accounts;
    expect(focus).toMatchObject({
      status: 'MERGED',
      rule: 'REDUNDANT_FOCUS_CLICK',
      mergedInto: fill?.interactionId,
    });
    expect(fill).toMatchObject({ status: 'PRESERVED', flowStep: 1 });
  });

  it('a box checked then unchecked is a correction, unless something depended on it in between', () => {
    const plain = new Journey('/form', ['checkbox:Urgent', 'textbox:Note']);
    plain.check('Urgent').check('Urgent');
    const unchecked = plain.events.at(-1);
    if (unchecked) unchecked.value = { empty: false, length: 0, shape: 'text', checked: false };
    plain.fill('Note', 'x');
    expect(
      plain
        .process()
        .result.journey.accounts.slice(0, 2)
        .map((account) => account.status),
    ).toEqual(['COLLAPSED_CORRECTION', 'COLLAPSED_CORRECTION']);
    const used = new Journey('/form', ['checkbox:Has employees']);
    const shown = used.screen('/form', ['checkbox:Has employees', 'textbox:Employee count']);
    used.check('Has employees', shown).fill('Employee count', '3');
    const hidden = used.screen('/form', ['checkbox:Has employees']);
    used.raw('change', {
      element: el('Has employees', {
        tag: 'input',
        role: 'checkbox',
        label: 'Has employees',
        inputType: 'checkbox',
      }),
      value: { empty: false, length: 0, shape: 'text', checked: false },
      stateAfter: hidden,
    });
    const { flow } = used.process();
    expect(described(flow.steps)).toEqual([
      'check Has employees',
      'fill Employee count',
      'uncheck Has employees',
    ]);
  });

  it('§44 / §45 / §46: the full journey keeps every functional interaction, accounted for, in the human order', () => {
    const journey = new Journey('/home', ['link:Task list']);
    const tasks = journey.screen('/tasks', ['button:Company interview']);
    const interview = journey.screen('/tasks/1', ['button:Company interview', 'checkbox:EUR']);
    const employee = journey.screen('/tasks/1', ['checkbox:EUR', 'button:Employee section']);
    const employeeOpen = journey.screen('/tasks/1', [
      'button:Employee section',
      'textbox:Employee name',
      'button:Company information',
    ]);
    const company = journey.screen('/tasks/1', [
      'button:Company information',
      'textbox:Legal name',
      'textbox:Business number',
      'button:Request section',
    ]);
    const request = journey.screen('/tasks/1', [
      'combobox:Request type',
      'textbox:Description',
      'button:Continue',
    ]);
    const confirm = journey.screen('/tasks/1', ['button:Confirm']);
    const submit = journey.screen('/tasks/1', ['button:Submit']);
    journey
      .click('Task list', { role: 'link', tag: 'a' }, tasks)
      .click('Company interview', {}, interview)
      .check('EUR', employee)
      .click('Employee section', {}, employeeOpen)
      .fill('Employee name', 'Jane')
      .click('Company information', {}, company)
      .fill('Legal name', 'Alpha inc')
      .fill('Business number', '1234567')
      .click('Request section', {}, request)
      .select('Request type', 'Incident')
      .fill('Description', 'Printer down')
      .click('Continue', {}, confirm)
      .click('Confirm', {}, submit)
      .click('Submit', { isSubmit: true }, submit, {
        network: [{ method: 'POST', path: '/api/requests', status: 201 }],
      });
    const { result, flow } = journey.process();
    expect(described(flow.steps)).toEqual([
      'click Task list',
      'click Company interview',
      'check EUR',
      'click Employee section',
      'fill Employee name',
      'click Company information',
      'fill Legal name',
      'fill Business number',
      'click Request section',
      'select Request type=Incident',
      'fill Description',
      'click Continue',
      'click Confirm',
      'click Submit',
    ]);
    const summary = result.journey.summary;
    expect(summary.unaccounted).toBe(0);
    expect(summary.meaningful).toBe(
      summary.preserved + summary.unresolvedPreserved + summary.merged + summary.excluded + summary.noise,
    );
    expect(result.journey.ordered).toBe(true);
    const steps = result.journey.accounts.flatMap((account) => (account.flowStep ? [account.flowStep] : []));
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
    expect(result.journey.phases.length).toBeGreaterThan(2);
    expect(result.warnings.map((warning) => warning.code)).not.toContain(
      'FLOW_GENERATION_LOST_HUMAN_ACTIONS',
    );
  });

  it('§47: TestData extraction keeps the section click before the fill that uses testData', () => {
    const journey = new Journey('/simulator', ['button:Company section']);
    const opened = journey.screen('/simulator', ['button:Company section', 'textbox:Legal name']);
    journey.click('Company section', {}, opened).fill('Legal name', 'Alpha inc');
    journey.click('Save', { isSubmit: true }, opened, {
      network: [{ method: 'POST', path: '/api/companies', status: 201 }],
    });
    const { flow } = journey.process();
    expect(flow.steps[0]).toMatchObject({ kind: 'click' });
    expect(flow.steps[1]).toMatchObject({ kind: 'fill', value: { testData: 'company.legalName' } });
  });

  it('§12: EXACT keeps every entered value; OPTIMIZED writes a separate shorter flow, never in place', () => {
    const exact = new Journey('/form', ['textbox:Name']);
    exact.fill('Name', 'Jan').click('Help', {}, 'o1').fill('Name', 'Jane');
    expect(described(exact.process(mission('recording: { fidelity: EXACT }\n')).flow.steps)).toEqual([
      'fill Name',
      'click Help',
      'fill Name',
    ]);
    const states = new Journey('/users', ['tab:Users', 'tab:Reports', 'button:Add user']);
    const reports = states.screen('/reports', ['tab:Users', 'tab:Reports']);
    const added = states.screen('/users/new', ['button:Save']);
    states.click('Reports', { role: 'tab', inNavigation: true }, reports).click('Add user', {}, added);
    const { result, flow } = states.process(mission('recording: { fidelity: OPTIMIZED }\n'));
    expect(described(flow.steps)).toEqual(['click Reports', 'click Add user']);
    expect(result.optimized?.removed.map((item) => item.label)).toEqual(['Reports']);
    expect(result.optimized?.files.yaml).not.toContain('Reports');
  });

  it('§15: the validator refuses an interaction removed without a reason (FLOW_GENERATION_LOST_HUMAN_ACTIONS)', () => {
    const journey = new Journey('/form', ['button:Calculate']);
    journey.click('Calculate', {}, 'o1');
    const { result } = journey.process();
    const action = result.normalized.actions.find((candidate) => candidate.target?.label === 'Calculate');
    if (!action) throw new Error('no action');
    action.dropped = 'shorter path exists';
    const lost = accountHumanJourney({
      events: journey.events,
      actions: result.normalized.actions,
      kept: [],
      flow: { ...result.flow, steps: [] },
      states: journey.states,
      dependencies: [],
    });
    expect(lost.summary.unaccounted).toBe(1);
    expect(lost.warnings.map((warning) => warning.code)).toContain('FLOW_GENERATION_LOST_HUMAN_ACTIONS');
  });

  it('the timeline groups the keystrokes of one field into one interaction, in the order the human started them', () => {
    const journey = new Journey('/form', ['textbox:Name']);
    journey.raw('input', {
      element: el('Name', { tag: 'input', role: 'textbox', label: 'Name' }),
      value: facts('Ja'),
    });
    journey.raw('change', {
      element: el('Name', { tag: 'input', role: 'textbox', label: 'Name' }),
      value: facts('Jane'),
    });
    journey.click('Next');
    const { interactions } = buildInteractionTimeline(journey.events);
    expect(
      interactions.map((interaction) => [interaction.id, interaction.type, interaction.rawEventIds.length]),
    ).toEqual([
      ['h001', 'FILL', 2],
      ['h002', 'CLICK', 1],
    ]);
  });
});
