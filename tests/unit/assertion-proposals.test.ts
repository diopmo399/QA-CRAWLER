import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import { flowSchema } from '../../src/config/flow-schema.js';
import {
  businessAssertionsForYaml,
  decideProposal,
  inFlow,
  proposalSummary,
} from '../../src/recording/assertion-proposals.js';
import type {
  RawRecordedEvent,
  RecordedElement,
  RecordedState,
  RecordedValueFacts,
  RecordingSession,
} from '../../src/recording/model.js';
import { observationSummary, observationsOf } from '../../src/recording/observations.js';
import { processRecording } from '../../src/recording/process-recording.js';

/**
 * OBSERVATIONS ET PROPOSITIONS D'ASSERTIONS : d'un enregistrement (création puis recherche) aux faits
 * identifiés, puis aux vérifications proposées avec leur origine, leurs preuves et leurs limites ; la
 * décision humaine écrit le flow (étape expect, assertions métier du schéma de la mission) ou l'en
 * retire ; sans décision, le flow est celui d'avant. Aucune valeur sensible dans les observations.
 */
const { config } = parseConfig(
  'mission: { name: rec }\ntarget: { baseUrl: "http://app.test", startAt: /items }\n',
  {},
  {},
);

function element(overrides: Partial<RecordedElement> = {}): RecordedElement {
  return {
    tag: 'input',
    role: 'textbox',
    name: 'Title',
    label: 'Title',
    css: 'form > div:nth-of-type(2) > input',
    cssStable: false,
    inForm: true,
    isSubmit: false,
    inNavigation: false,
    inDialog: false,
    sameRoleName: 1,
    roleNameIndex: 0,
    sameLabel: 1,
    ...overrides,
  };
}

function button(name: string, overrides: Partial<RecordedElement> = {}): RecordedElement {
  return element({ tag: 'button', role: 'button', name, label: undefined, text: name, ...overrides });
}

function facts(overrides: Partial<RecordedValueFacts> = {}): RecordedValueFacts {
  return { empty: false, length: 8, shape: 'text', digest: '0123456789abcdef', ...overrides };
}

function state(id: string, route: string, overrides: Partial<RecordedState> = {}): RecordedState {
  return {
    id,
    stateId: `${route.replace(/\W+/g, '-')}-x`,
    label: route,
    route,
    url: `http://app.test${route}`,
    title: route,
    headings: [],
    alerts: [],
    invalidFields: 0,
    dialogs: [],
    controls: [],
    ...overrides,
  };
}

let sequence = 0;
function raw(
  type: RawRecordedEvent['type'],
  at: number,
  extra: Partial<RawRecordedEvent> = {},
): RawRecordedEvent {
  sequence += 1;
  return { id: `r${String(sequence)}`, sequence, type, at, url: 'http://app.test/items/new', ...extra };
}

function session(events: RawRecordedEvent[], states: RecordedState[]): RecordingSession {
  return {
    id: 'rec-proposals',
    name: 'Create item',
    startedAt: '2026-01-01T00:00:00.000Z',
    startUrl: 'http://app.test/items',
    status: 'PROCESSING',
    rawEvents: events,
    semanticActions: [],
    checkpoints: [],
    states,
    initialStateId: states[0]?.id,
    warnings: [],
    droppedEvents: 0,
  };
}

function recording(): ReturnType<typeof processRecording> {
  const states = [
    state('o1', '/items', { controls: ['button:New item'] }),
    state('o2', '/items/new', { controls: ['button:Save'] }),
    state('o3', '/items', { controls: ['button:New item'], statuses: ['Item created'], tableRows: 3 }),
    state('o4', '/items', { controls: ['button:New item'], tableRows: 1 }),
  ];
  const events = [
    raw('navigation', 100, { url: 'http://app.test/items', stateAfter: 'o1' }),
    raw('click', 1000, { url: 'http://app.test/items', element: button('New item'), stateAfter: 'o2' }),
    raw('change', 2000, { element: element(), value: facts(), stateAfter: 'o2' }),
    raw('change', 2500, {
      element: element({ name: 'Secret code', label: 'Secret code', inputType: 'password' }),
      value: facts({ shape: 'text' }),
      stateAfter: 'o2',
    }),
    raw('click', 4000, {
      element: button('Save', { isSubmit: true }),
      stateAfter: 'o3',
      network: [
        { method: 'POST', path: '/api/items', status: 201, requestFields: { title: { type: 'string' } } },
      ],
    }),
    raw('change', 5000, {
      url: 'http://app.test/items',
      element: element({ name: 'Search', label: 'Search', css: 'input.search' }),
      value: facts(),
      stateAfter: 'o4',
      network: [{ method: 'GET', path: '/api/items?q=x', status: 200, listSize: 1 }],
    }),
  ];
  return processRecording(session(events, states), config, { language: 'en' });
}

describe('recording observations', () => {
  it('lists the captured facts by source, linked to their action and step, without sensitive values', () => {
    const result = recording();
    const set = result.observations;
    expect(set).toBeDefined();
    if (!set) return;
    const kinds = set.observations.map((observation) => `${observation.source}:${observation.kind}`);
    expect(kinds).toContain('ACCESSIBILITY:TARGET');
    expect(kinds).toContain('USER_INPUT:INPUT_VALUE');
    expect(kinds).toContain('NAVIGATION:NAVIGATION');
    expect(kinds).toContain('NETWORK_REQUEST:REQUEST');
    expect(kinds).toContain('NETWORK_RESPONSE:RESPONSE');
    expect(kinds).toContain('DOM:MESSAGE');
    expect(kinds).toContain('NETWORK_RESPONSE:RECORDS');
    // Identifiants stables, ordre, action et étape.
    expect(set.observations.map((observation) => observation.id)).toEqual(
      set.observations.map((_, index) => `ob${String(index + 1)}`),
    );
    for (const observation of set.observations) {
      expect(observation.actionId).toMatch(/^a\d+/);
      expect(observation.reliability).toBeGreaterThan(0);
      expect(observation.reliability).toBeLessThanOrEqual(1);
    }
    expect(set.observations.some((observation) => observation.stepId !== undefined)).toBe(true);
    // La saisie sensible est masquée : aucune valeur, un drapeau ; la saisie ordinaire ne montre pas sa valeur non plus (donnée de test).
    const inputs = set.observations.filter((observation) => observation.kind === 'INPUT_VALUE');
    expect(inputs.some((observation) => observation.redacted === true)).toBe(true);
    expect(inputs.every((observation) => observation.value === undefined)).toBe(true);
    expect(JSON.stringify(set)).not.toContain('0123456789abcdef');
    // Ce que l'enregistreur ne capture pas est dit, jamais inventé.
    expect(set.notCaptured).toContain('CONSOLE');
    expect(observationSummary(set).total).toBe(set.observations.length);
  });

  it('marks what was not observed instead of reconstructing it', () => {
    const states = [state('o1', '/items'), state('o2', '/items/new')];
    const events = [
      raw('navigation', 100, { url: 'http://app.test/items', stateAfter: 'o1' }),
      raw('click', 1000, { url: 'http://app.test/items', element: button('New item'), stateAfter: 'o2' }),
      // Une soumission sans écran observé après, ni requête.
      raw('click', 2000, { element: button('Save', { isSubmit: true }) }),
    ];
    const result = processRecording(session(events, states), config, { language: 'en' });
    const set = observationsOf({ session: result.session, kept: result.normalized.kept, flow: result.flow });
    expect(set.missing.map((entry) => entry.what)).toEqual(
      expect.arrayContaining([
        'screen after the action not observed',
        'no network exchange observed for this write action',
      ]),
    );
  });
});

describe('assertion proposals', () => {
  it('proposes observed, deduced and explicit assertions with their origin, evidence and limits', () => {
    const result = recording();
    const proposals = result.flow.proposals ?? [];
    expect(proposals.length).toBeGreaterThan(0);
    const byOrigin = proposalSummary(proposals).byOrigin;
    expect(byOrigin.OBSERVED).toBeGreaterThan(0);
    expect(byOrigin.DEDUCED).toBeGreaterThan(0);
    // L'écriture acceptée, observée : une vérification d'écran (réponse 2xx), recommandée (candidat stable).
    const accepted = proposals.find(
      (proposal) => proposal.category === 'API_RESPONSE' && proposal.expect?.response?.status === '2xx',
    );
    expect(accepted).toMatchObject({
      origin: 'OBSERVED',
      verificationMethod: 'UI_EXPECT',
      recommended: true,
      status: 'PROPOSED',
    });
    expect(accepted?.sourceObservationIds.length).toBeGreaterThan(0);
    expect(accepted?.evidence.length).toBeGreaterThan(0);
    // La saisie se retrouve dans la requête : DÉDUITE (le champ n'est pas identifié), à confirmer, avec ses limites.
    const carried = proposals.find((proposal) => proposal.category === 'DATA_CONSISTENCY');
    expect(carried).toMatchObject({
      origin: 'DEDUCED',
      verificationMethod: 'BUSINESS_ASSERTION',
      needsConfirmation: true,
      recommended: false,
    });
    expect(carried?.assertion?.check).toMatchObject({ kind: 'value', source: 'request', path: '/api/items' });
    expect(JSON.stringify(carried?.assertion?.check)).toContain('"expected":{"testData":"');
    expect(carried?.limits.join(' ')).toContain('not identified');
    // La saisie sensible ne donne aucune proposition de donnée.
    expect(proposals.filter((proposal) => proposal.category === 'DATA_CONSISTENCY')).toHaveLength(1);
    // La lecture qui suit sert l'enregistrement créé : DÉDUITE, dépend de la précédente.
    const found = proposals.find((proposal) => proposal.category === 'RELATIONSHIP');
    expect(found).toMatchObject({ origin: 'DEDUCED', needsConfirmation: true });
    expect(found?.assertion?.requires).toEqual([carried?.assertion?.id]);
    // L'absence d'erreur après l'écriture : observée sur l'écran suivant.
    expect(proposals.find((proposal) => proposal.category === 'ERROR_ABSENCE')).toMatchObject({
      origin: 'OBSERVED',
      expect: { noError: true },
    });
    // Chaque proposition est reliée à une étape du flow et n'est jamais en double.
    const keys = proposals.map(
      (proposal) =>
        `${proposal.afterActionId}|${JSON.stringify(proposal.expect ?? proposal.assertion?.check)}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
    expect(proposals.every((proposal) => proposal.afterStepId !== undefined)).toBe(true);
  });

  it('without a decision the flow is the one of before: only the recommended checks are in it, no business assertion', () => {
    const result = recording();
    const proposals = result.flow.proposals ?? [];
    const kept = proposals.filter(inFlow);
    expect(kept.every((proposal) => proposal.recommended && proposal.status === 'PROPOSED')).toBe(true);
    expect(result.flow.businessAssertions).toBeUndefined();
    expect(result.files.yaml).not.toContain('assertions:');
    const expects = result.flow.steps.filter((item) => item.step.kind === 'expect').length;
    expect(expects).toBe(
      result.flow.assertions.filter((candidate) => candidate.selected && candidate.expect).length,
    );
  });

  it('a human decision writes or removes the check; a deduced business assertion only enters the YAML once accepted', () => {
    const result = recording();
    const flow = result.flow;
    const proposals = flow.proposals ?? [];
    const carried = proposals.find((proposal) => proposal.category === 'DATA_CONSISTENCY');
    const errorFree = proposals.find((proposal) => proposal.category === 'ERROR_ABSENCE');
    const accepted = proposals.find(
      (proposal) => proposal.category === 'API_RESPONSE' && proposal.recommended,
    );
    if (!carried || !errorFree || !accepted) throw new Error('fixture proposals missing');
    const stepsBefore = flow.steps.length;

    // Accepter la déduction : elle devient une assertion métier du YAML, avec son ancrage (after) et sa précondition filtrée.
    expect(decideProposal(flow, { id: carried.id, decision: 'ACCEPT' }, '2026-01-02T00:00:00.000Z')).toEqual({
      ok: true,
    });
    expect(carried.status).toBe('APPROVED');
    expect(flow.businessAssertions?.map((entry) => entry.id)).toEqual([carried.assertion?.id]);
    const yamlAssertions = businessAssertionsForYaml(flow);
    expect(yamlAssertions).toHaveLength(1);
    expect(yamlAssertions[0]).toMatchObject({ id: carried.assertion?.id, evidence: ['NETWORK'] });
    expect(typeof yamlAssertions[0]?.after).toBe('number');
    expect(yamlAssertions[0]?.requires).toBeUndefined();

    // Accepter une vérification d'écran : une étape expect de plus, marquée HUMAN_DECISION, juste après l'action.
    expect(decideProposal(flow, { id: errorFree.id, decision: 'ACCEPT' })).toEqual({ ok: true });
    expect(flow.steps.length).toBe(stepsBefore + 1);
    const inserted = flow.steps.find((item) => item.provenance === 'HUMAN_DECISION');
    expect(inserted?.step).toMatchObject({ kind: 'expect', expect: { noError: true } });
    const anchor = flow.steps.findIndex((item) => item.id === errorFree.afterStepId);
    expect(inserted).toBeDefined();
    expect(inserted ? flow.steps.indexOf(inserted) : -1).toBeGreaterThan(anchor);

    // Refuser une vérification recommandée : son étape quitte le flow ; réinitialiser la ramène.
    expect(decideProposal(flow, { id: accepted.id, decision: 'REJECT', note: 'not needed' })).toEqual({
      ok: true,
    });
    expect(
      flow.steps.some(
        (item) =>
          item.step.kind === 'expect' && JSON.stringify(item.step.expect) === JSON.stringify(accepted.expect),
      ),
    ).toBe(false);
    expect(accepted.note).toBe('not needed');
    expect(decideProposal(flow, { id: accepted.id, decision: 'RESET' })).toEqual({ ok: true });
    expect(accepted.status).toBe('PROPOSED');
    expect(
      flow.steps.some(
        (item) =>
          item.step.kind === 'expect' && JSON.stringify(item.step.expect) === JSON.stringify(accepted.expect),
      ),
    ).toBe(true);

    // Modifier : description, obligation, criticité ; désactiver retire l'assertion métier.
    expect(
      decideProposal(flow, {
        id: carried.id,
        decision: 'MODIFY',
        description: 'the title reaches the API',
        mandatory: false,
        criticality: 'HIGH',
      }),
    ).toEqual({ ok: true });
    expect(carried.status).toBe('MODIFIED');
    expect(flow.businessAssertions?.[0]).toMatchObject({
      description: 'the title reaches the API',
      mandatory: false,
      criticality: 'HIGH',
    });
    expect(businessAssertionsForYaml(flow)[0]).toMatchObject({ mandatory: false, criticality: 'HIGH' });
    expect(decideProposal(flow, { id: carried.id, decision: 'DISABLE' })).toEqual({ ok: true });
    expect(flow.businessAssertions).toBeUndefined();
    // Une proposition inconnue, ou non exécutable, est refusée.
    expect(decideProposal(flow, { id: 'p999', decision: 'ACCEPT' })).toEqual({
      error: 'unknown proposal p999',
    });
  });

  it('the YAML with accepted assertions is valid for the flow schema and replays the same steps', async () => {
    const result = recording();
    const carried = (result.flow.proposals ?? []).find(
      (proposal) => proposal.category === 'DATA_CONSISTENCY',
    );
    if (!carried) throw new Error('fixture proposal missing');
    decideProposal(result.flow, { id: carried.id, decision: 'ACCEPT' });
    const { generateFlowFiles } = await import('../../src/recording/recorded-flow.js');
    const files = generateFlowFiles(result.flow, { language: 'en', recordedAt: '2026-01-01T00:00:00.000Z' });
    expect(files.yaml).toContain('assertions:');
    const parsed = flowSchema.parse((await import('yaml')).parse(files.yaml));
    expect(parsed.assertions).toHaveLength(1);
    expect(parsed.assertions[0]).toMatchObject({
      id: carried.assertion?.id,
      check: { kind: 'value', source: 'request' },
    });
    expect(parsed.assertions[0]?.after).toBeLessThanOrEqual(parsed.steps.length);
    expect(parsed.steps.length).toBe(result.flow.steps.length);
  });
});
