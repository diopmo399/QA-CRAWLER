import { describe, expect, it } from 'vitest';
import { DeterministicConfidenceEngine } from '../../src/intelligence/confidence-engine.js';
import { JsonKnowledgeBase } from '../../src/knowledge/json-knowledge-base.js';
import { EngineEventLog } from '../../src/logging/engine-log.js';
import { fieldDescriptors } from '../../src/semantics/resolution/field-descriptor.js';
import {
  FieldMatcher,
  fieldTargetSignature,
  targetsFor,
} from '../../src/semantics/resolution/field-matcher.js';
import { DEFAULT_THRESHOLDS } from '../../src/semantics/resolution/resolution.js';
import {
  isSemanticSignature,
  KnowledgeSemanticHistory,
  learnFrom,
  observationOf,
  type SemanticResolutionEvent,
} from '../../src/semantics/resolution/semantic-knowledge.js';
import { SemanticVocabulary } from '../../src/semantics/resolution/vocabulary.js';
import { SemanticDictionary } from '../../src/semantics/semantic-dictionary.js';
import { field, screen, testConfig } from '../helpers.js';

const NOW = '2026-06-01T12:00:00.000Z';
const now = (): string => NOW;
const engine = new DeterministicConfidenceEngine({
  sampleHalfPoint: 5,
  aging: { halfLifeDays: 30, minWeight: 0.05 },
  compareContext: true,
  now,
});
const matcher = new FieldMatcher(new SemanticVocabulary(new SemanticDictionary()), DEFAULT_THRESHOLDS);
const config = testConfig();
const STATE = 'nouvel-utilisateur';

const event = (
  target: string,
  outcome: SemanticResolutionEvent['outcome'] = 'SUCCEEDED',
): SemanticResolutionEvent => ({
  at: NOW,
  flow: 'create user',
  stateId: 's-1',
  stateSignature: STATE,
  intentKey: 'fill:courriel',
  intent: 'FILL "courriel"',
  outcome,
  targetSignature: target,
  score: 1,
  confidence: 'VERY_HIGH',
  candidates: [],
});

function screenWith(...elements: Parameters<typeof field>[]) {
  return fieldDescriptors(
    screen({ elements: elements.map(([label, overrides]) => field(label, overrides)) }, config).actions,
  );
}

const historyOf = (knowledge: JsonKnowledgeBase) =>
  new KnowledgeSemanticHistory(knowledge, STATE, engine, { applicationId: 'app' }, now);

describe('historical confidence: the ConfidenceEngine, not a second system', () => {
  it('147 successes out of 148 is a strong signal; 1 out of 1 a weak one', () => {
    const strong = JsonKnowledgeBase.inMemory({});
    for (let index = 0; index < 147; index++) learnFrom(strong, event('field|courriel|email|email|'));
    learnFrom(strong, event('field|courriel|email|email|', 'FAILED'));
    const signal = historyOf(strong).signalFor('fill:courriel', 'field|courriel|email|email|');
    expect(signal).toMatchObject({ successes: 147, failures: 1 });
    expect(signal?.confidence).toBeGreaterThan(0.95);
    expect(signal?.detail).toMatch(/^147\/148 successful, seen today, confidence 0\.9\d+ VERY_HIGH$/);

    const weak = JsonKnowledgeBase.inMemory({});
    learnFrom(weak, event('field|courriel|email|email|'));
    expect(
      historyOf(weak).signalFor('fill:courriel', 'field|courriel|email|email|')?.confidence,
    ).toBeLessThan(0.2);
    expect(historyOf(weak).signalFor('fill:courriel', 'other')).toBeUndefined();
  });

  it('ambiguous and not-found resolutions teach nothing about a target', () => {
    const knowledge = JsonKnowledgeBase.inMemory({});
    learnFrom(knowledge, { ...event('x', 'AMBIGUOUS') });
    learnFrom(knowledge, { ...event('x', 'NOT_FOUND') });
    expect(knowledge.getTransitionKnowledge(STATE, 'intent:fill:courriel')).toBeUndefined();
  });
});

describe('the history is a signal, never the truth', () => {
  const email = screenWith(
    ['Courriel', { fieldName: 'email', inputType: 'email' }],
    ['Nom', { fieldName: 'familyName' }],
  );
  const emailTarget = targetsFor({ kind: 'FILL', field: 'courriel', value: '' }, email).find(
    (target) => target.field.name === 'email',
  );
  if (!emailTarget) throw new Error('no email field');
  const signature = fieldTargetSignature(emailTarget);

  it('first run: a strong DOM resolution; later runs: the history adds a bounded bonus', () => {
    const knowledge = JsonKnowledgeBase.inMemory({});
    const first = matcher.resolve({ kind: 'FILL', field: 'courriel', value: 'a@b.co' }, email, {
      stateSignature: STATE,
      history: historyOf(knowledge),
    });
    expect(first.status).toBe('RESOLVED');
    expect(first.reasons.some((reason) => reason.includes('historical'))).toBe(false);
    for (let run = 0; run < 20; run++) learnFrom(knowledge, event(signature));
    const later = matcher.resolve({ kind: 'FILL', field: 'courriel', value: 'a@b.co' }, email, {
      stateSignature: STATE,
      history: historyOf(knowledge),
    });
    const history = later.candidates[0]?.components.find((component) => component.factor === 'history');
    expect(history?.points).toBeGreaterThan(8);
    expect(history?.points).toBeLessThanOrEqual(15);
    expect(later.candidates[0]?.points).toBeGreaterThan(first.candidates[0]?.points ?? 0);
  });

  it('the interface changed (email → contactEmail, clear label): the new field is chosen', () => {
    const knowledge = JsonKnowledgeBase.inMemory({});
    for (let run = 0; run < 147; run++) learnFrom(knowledge, event(signature));
    const changed = screenWith(
      ['Courriel de contact', { fieldName: 'contactEmail', inputType: 'email' }],
      ['Nom', { fieldName: 'familyName' }],
    );
    const result = matcher.resolve({ kind: 'FILL', field: 'courriel', value: 'a@b.co' }, changed, {
      stateSignature: STATE,
      history: historyOf(knowledge),
    });
    expect(result.status).toBe('RESOLVED');
    expect(result.selected?.field.name).toBe('contactEmail');
  });

  it('a strong history on a weak candidate never beats a strong DOM proof', () => {
    const two = screenWith(
      ['Courriel', { fieldName: 'email', inputType: 'email' }],
      ['Contact', { fieldName: 'contact' }],
    );
    const contact = targetsFor({ kind: 'FILL', field: 'courriel', value: '' }, two).find(
      (target) => target.field.name === 'contact',
    );
    if (!contact) throw new Error('no contact field');
    const knowledge = JsonKnowledgeBase.inMemory({});
    for (let run = 0; run < 500; run++) learnFrom(knowledge, event(fieldTargetSignature(contact)));
    const result = matcher.resolve({ kind: 'FILL', field: 'courriel', value: 'a@b.co' }, two, {
      stateSignature: STATE,
      history: historyOf(knowledge),
    });
    expect(result.selected?.field.name).toBe('email');
    // Sans aucune preuve du DOM, l'historique seul n'ajoute rien.
    expect(result.candidates.find((candidate) => candidate.label === 'Contact')?.components).toEqual([]);
  });
});

describe('events and storage', () => {
  it('the semantic entries never mix with the transitions of the exploration', () => {
    const knowledge = JsonKnowledgeBase.inMemory({});
    learnFrom(knowledge, event('field|courriel|email|email|'));
    expect(knowledge.actionsLeadingTo(() => true)).toEqual([]);
    expect(isSemanticSignature('intent:fill:courriel')).toBe(true);
    expect(isSemanticSignature('click:creer')).toBe(false);
  });

  it('persistence: a success and a failure are observations towards the target and !target', () => {
    expect(observationOf(event('t'))).toMatchObject({
      toStateSignature: 't',
      actionSignature: 'intent:fill:courriel',
    });
    expect(observationOf(event('t', 'FAILED'))).toMatchObject({ toStateSignature: '!t' });
    expect(observationOf(event('t', 'AMBIGUOUS'))).toBeUndefined();
  });

  it('engine log: SEMANTIC_RESOLUTION_SUCCEEDED / FAILED / AMBIGUOUS, secrets redacted', () => {
    const log = new EngineEventLog('DEBUG');
    const listener = log.listener();
    listener.onSemanticResolution?.({ ...event('t'), selected: 'Courriel' });
    listener.onSemanticResolution?.({ ...event('t', 'FAILED'), reason: 'Authorization: Bearer abc.def.ghi' });
    listener.onSemanticResolution?.({
      ...event('t', 'AMBIGUOUS'),
      candidates: [
        { label: 'Adresse principale', score: 0.69 },
        { label: 'Adresse de facturation', score: 0.69 },
      ],
    });
    const entries = log.entries();
    expect(entries.map((entry) => entry.event)).toEqual([
      'SEMANTIC_RESOLUTION_SUCCEEDED',
      'SEMANTIC_RESOLUTION_FAILED',
      'SEMANTIC_RESOLUTION_AMBIGUOUS',
    ]);
    expect(entries[0]?.message).toBe('FILL "courriel" → "Courriel" SUCCEEDED (1 VERY_HIGH)');
    expect(JSON.stringify(entries)).not.toContain('abc.def.ghi');
    expect(entries[2]?.data?.candidates).toBe('Adresse principale 0.69 | Adresse de facturation 0.69');
  });
});
