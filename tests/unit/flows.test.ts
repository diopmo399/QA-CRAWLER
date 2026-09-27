import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import { describeStep, type FlowStep } from '../../src/config/flow-schema.js';
import { evaluateFlowAction, evaluateFlowUrl } from '../../src/flows/flow-safety.js';
import type { DiscoveredAction } from '../../src/model/discovered-action.js';
import { SafetyPolicy } from '../../src/policies/safety-policy.js';
import { testConfig } from '../helpers.js';

const minimal = 'target:\n  baseUrl: http://localhost:4200\n';
const flows = (yaml: string) => parseConfig(`${minimal}flows:\n${yaml}`, {}, {});
const steps = (yaml: string): FlowStep[] =>
  flows(`  - name: f\n    steps:\n${yaml}`).config.flows[0]?.steps ?? [];

describe('flows schema', () => {
  it('normalizes every kind of step', () => {
    const parsed = steps(`
      - goto: /dossiers
      - click: { role: button, name: Suivant }
      - fill: { label: Titre, value: Dossier QA }
      - fill: { label: Mot de passe, value: { env: QA_PASSWORD } }
      - fill: { testId: montant, value: 250 }
      - select: { label: Catégorie, option: Subvention }
      - check: { text: J'accepte }
      - uncheck: { css: "#newsletter", nth: 1 }
      - expect: { text: Étape 2, url: /create, visible: { role: heading, name: Détails } }
      - screenshot: fin
      - click: { role: button, name: Enregistrer }
        allow: MUTATION
        optional: true
        timeoutMs: 2000
`);
    expect(parsed.map((step) => step.kind)).toEqual([
      'goto',
      'click',
      'fill',
      'fill',
      'fill',
      'select',
      'check',
      'uncheck',
      'expect',
      'screenshot',
      'click',
    ]);
    expect(parsed[1]).toMatchObject({
      kind: 'click',
      target: { strategy: 'role', role: 'button', name: 'Suivant' },
      allow: [],
      optional: false,
    });
    expect(parsed[3]).toMatchObject({ kind: 'fill', value: { env: 'QA_PASSWORD' } });
    expect(parsed[4]).toMatchObject({
      kind: 'fill',
      target: { strategy: 'testId', value: 'montant' },
      value: '250',
    });
    expect(parsed[7]).toMatchObject({ target: { strategy: 'css', value: '#newsletter', nth: 1 } });
    expect(parsed[8]).toMatchObject({
      kind: 'expect',
      expect: {
        text: 'Étape 2',
        url: '/create',
        visible: { strategy: 'role', role: 'heading', name: 'Détails' },
      },
    });
    expect(parsed[10]).toMatchObject({ allow: ['MUTATION'], optional: true, timeoutMs: 2000 });
  });

  it('describes steps without revealing values read from the environment', () => {
    const parsed = steps(`
      - fill: { label: Mot de passe, value: { env: QA_PASSWORD } }
      - fill: { label: Titre, value: Dossier QA }
      - click: { role: button, name: Suivant }
        name: Étape suivante
`);
    expect(describeStep(parsed[0] as FlowStep)).toBe('fill label="Mot de passe" = ${env:QA_PASSWORD}');
    expect(describeStep(parsed[1] as FlowStep)).toBe('fill label="Titre" = "Dossier QA"');
    expect(describeStep(parsed[1] as FlowStep, true)).toBe('fill label="Titre" = "***"');
    expect(describeStep(parsed[2] as FlowStep)).toBe('Étape suivante');
  });

  it('rejects ambiguous or incomplete steps with a clear message', () => {
    expect(() => steps('      - click: { role: button }\n        goto: /x\n')).toThrowError(
      /exactly one of goto, click/,
    );
    expect(() => steps('      - click: { role: button, text: OK }\n')).toThrowError(
      /exactly one of testId, role, label, text, css/,
    );
    expect(() => steps('      - click: { label: Titre, name: x }\n')).toThrowError(
      /"name" is only valid with "role"/,
    );
    expect(() => steps('      - expect: {}\n')).toThrowError(/expect needs at least one/);
    expect(() => steps('      - click: { role: button }\n        allow: DELETE\n')).toThrowError(/allow/);
    expect(() => steps('      - fill: { label: Titre }\n')).toThrowError(/value/);
    expect(() => flows('  - name: f\n    steps: []\n')).toThrowError(/steps/);
    expect(() =>
      flows('  - name: f\n    steps: [{ goto: / }]\n  - name: f\n    steps: [{ goto: / }]\n'),
    ).toThrowError(/duplicate flow name "f"/);
  });

  it('warns about steps that may modify data, and defaults to autonomous exploration', () => {
    const loaded = flows(
      '  - name: creer\n    startAt: dossiers\n    steps:\n      - click: { role: button, name: Créer }\n        allow: [MUTATION, UNKNOWN]\n',
    );
    expect(loaded.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('flow "creer": 1 step(s) allow MUTATION')]),
    );
    expect(loaded.config.flows[0]?.startAt).toBe('/dossiers');
    expect(loaded.config.flows[0]?.thenExplore).toBe(false);
    expect(loaded.config.exploration.autonomous).toBe(true);
    expect(parseConfig(minimal, {}, {}).config.flows).toEqual([]);
  });
});

describe('evaluateFlowAction', () => {
  const policy = new SafetyPolicy(testConfig().safety);
  const action = (overrides: Partial<DiscoveredAction>): DiscoveredAction => ({
    id: 'a-1',
    stateId: 's-1',
    type: 'click',
    category: 'other',
    elementType: 'button',
    disabled: false,
    visible: true,
    classification: 'SAFE',
    reason: 'test',
    risks: [],
    locator: { strategy: 'role', role: 'button', name: 'x' },
    ...overrides,
  });
  const verdict = (
    overrides: Partial<DiscoveredAction>,
    allow: ('MUTATION' | 'UNKNOWN' | 'DANGEROUS')[] = [],
    valueFromEnv = false,
  ) => evaluateFlowAction(policy, action(overrides), { allow, valueFromEnv }).verdict;

  it('runs SAFE steps, and MUTATION / UNKNOWN ones only when the step allows them', () => {
    expect(verdict({})).toBe('ALLOW');
    expect(verdict({ classification: 'MUTATION', risks: ['mutation'] })).toBe('BLOCK');
    expect(verdict({ classification: 'MUTATION', risks: ['form-submit'] }, ['MUTATION'])).toBe('ALLOW');
    expect(verdict({ classification: 'UNKNOWN' })).toBe('BLOCK');
    expect(verdict({ classification: 'UNKNOWN' }, ['UNKNOWN'])).toBe('ALLOW');
    expect(verdict({ classification: 'UNKNOWN' }, ['MUTATION'])).toBe('BLOCK');
  });

  it('runs DANGEROUS steps only with allow: DANGEROUS and DANGEROUS allowed by the mission', () => {
    expect(verdict({ classification: 'DANGEROUS', risks: ['delete'] }, ['MUTATION', 'UNKNOWN'])).toBe(
      'BLOCK',
    );
    // L'étape le permet, la mission non.
    expect(verdict({ classification: 'DANGEROUS', risks: ['delete'] }, ['DANGEROUS'])).toBe('BLOCK');
    const permissive = new SafetyPolicy(
      testConfig('safety:\n  allowedActionClasses: [SAFE, DANGEROUS]\n').safety,
    );
    const dangerous = action({ classification: 'DANGEROUS', risks: ['delete'] });
    expect(evaluateFlowAction(permissive, dangerous, { allow: [] }).verdict).toBe('BLOCK');
    expect(evaluateFlowAction(permissive, dangerous, { allow: ['DANGEROUS'] }).verdict).toBe('ALLOW');
  });

  it('fills sensitive fields only from the environment, and payment fields never', () => {
    const password = {
      type: 'fill' as const,
      classification: 'DANGEROUS' as const,
      risks: ['sensitive-data' as const],
      label: 'Mot de passe',
      field: { inputType: 'password', required: true, label: 'Mot de passe' },
    };
    expect(verdict(password)).toBe('BLOCK');
    expect(verdict(password, [], true)).toBe('ALLOW');
    const card = {
      ...password,
      label: 'Numéro de carte',
      field: { inputType: 'text', required: true, autocomplete: 'cc-number' },
    };
    expect(verdict(card, ['MUTATION'], true)).toBe('BLOCK');
    expect(
      verdict(
        { ...password, label: 'IBAN', field: { inputType: 'text', required: false, label: 'IBAN' } },
        [],
        true,
      ),
    ).toBe('BLOCK');
    expect(verdict({ type: 'fill', label: 'Titre', field: { inputType: 'text', required: true } })).toBe(
      'ALLOW',
    );
  });

  it('applies the navigation rules to links and goto steps', () => {
    expect(verdict({ type: 'navigate', href: 'http://localhost:4200/users' })).toBe('ALLOW');
    expect(verdict({ type: 'navigate', href: 'https://evil.example.com/', external: true })).toBe('BLOCK');
    expect(evaluateFlowUrl(policy, 'http://localhost:4200/dossiers').verdict).toBe('ALLOW');
    expect(evaluateFlowUrl(policy, 'http://localhost:4200/logout').verdict).toBe('BLOCK');
    expect(evaluateFlowUrl(policy, 'http://localhost:4200/users/3/delete').verdict).toBe('BLOCK');
    expect(evaluateFlowUrl(policy, 'https://other.example.com/').verdict).toBe('BLOCK');
  });
});
