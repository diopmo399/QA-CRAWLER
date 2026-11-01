import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { flowsSchema } from '../../src/config/flow-schema.js';
import type { HttpExchange, Incident, InvestigationScope } from '../../src/incident/model.js';
import { proposeRegressionTest, responsePattern } from '../../src/incident/regression.js';

/**
 * LE TEST DE NON-RÉGRESSION proposé pour l'incident fictif du catalogue : le scénario « creer-livre »
 * rejoué tel quel, plus les attentes de la bibliothèque (réponse 2xx, aucun message d'erreur, texte
 * attendu). Toujours PROPOSED, jamais exécuté ici.
 */

const LIBRARY_YAML = `flows:
  - name: lister-livres
    steps:
      - goto: /books
  - name: creer-livre
    startAt: /books/new
    steps:
      - fill:
          label: Titre
          value: Le Petit Atlas
      - fill:
          label: ISBN
          value: { testData: book.isbn }
      - click:
          role: button
          name: Enregistrer
        allow: MUTATION
      - expect:
          url: /books
`;

function scope(endpoints: string[] = []): InvestigationScope {
  return {
    mode: 'GUIDED',
    applications: [],
    scenarios: ['creer-livre'],
    steps: [],
    endpoints,
    depth: 3,
    allowedHosts: [],
    logRoots: [],
    allowedCommands: [],
    permissions: {
      readSources: true,
      navigate: true,
      httpRequests: 'NONE',
      runTests: 'NONE',
      localCommands: false,
      readLogs: false,
      openshift: 'NONE',
      sideEffects: false,
    },
    limits: {
      maxFiles: 2000,
      maxFileBytes: 524288,
      maxDurationMs: 600000,
      maxRequests: 200,
      maxExperiments: 20,
    },
    extensions: [],
  };
}

function request(
  partial: Partial<HttpExchange> & Pick<HttpExchange, 'id' | 'method' | 'path'>,
): HttpExchange {
  return { url: partial.path, resourceType: 'fetch', correlation: 'OBSERVED', ...partial };
}

function incident(requests: HttpExchange[], extra: Partial<Incident> = {}): Incident {
  return {
    id: 'inc_catalogue01',
    projectId: 'catalogue',
    title: 'Erreur 500 à la création d’un livre',
    description: "Après avoir cliqué sur Enregistrer, l'application affiche une erreur HTTP 500.",
    observed: 'erreur HTTP 500',
    expected: 'le livre est créé et le message « Livre enregistré » est affiché',
    severity: 'HIGH',
    scenario: 'creer-livre',
    execution: { target: 'LOCAL' },
    scope: scope(),
    state: 'DIAGNOSED',
    revision: 3,
    createdAt: '2026-10-30T08:00:00.000Z',
    updatedAt: '2026-10-30T11:00:00.000Z',
    createdBy: 'analyste',
    history: [],
    investigation: {
      reproductions: [
        {
          id: 'rep_1',
          startedAt: '2026-10-30T09:00:00.000Z',
          status: 'COMPLETED',
          target: 'LOCAL',
          scenario: 'creer-livre',
          reproduced: true,
          actions: [],
          requests,
          evidence: [],
          screenshots: [],
        },
      ],
      hypotheses: [],
      experiments: [],
    },
    ...extra,
  };
}

const FAILING = [
  request({ id: 'r1', method: 'GET', path: '/api/publishers', status: 200, step: 1 }),
  request({ id: 'r2', method: 'GET', path: '/assets/logo.png', status: 404, step: 1, resourceType: 'image' }),
  request({ id: 'r3', method: 'POST', path: '/api/books', status: 500, step: 3 }),
];

interface ParsedFlow {
  name: string;
  startAt?: string;
  steps: Record<string, unknown>[];
}

const parse = (yaml: string): ParsedFlow[] => (parseYaml(yaml) as { flows: ParsedFlow[] }).flows;

describe('proposeRegressionTest', () => {
  it('reuses the scenario steps and adds the library assertions after the triggering step', () => {
    const proposal = proposeRegressionTest({
      incident: incident(FAILING),
      scenarioName: 'creer-livre',
      scenarioYaml: LIBRARY_YAML,
    });
    expect(proposal.status).toBe('PROPOSED');
    expect(proposal.execution).toBeUndefined();
    expect(proposal.file).toBeUndefined();
    expect(proposal.basedOn).toBe('creer-livre');
    expect(proposal.name).toBe('Non-régression — Erreur 500 à la création d’un livre');

    const [flow] = parse(proposal.flowYaml);
    expect(flow?.name).toBe(proposal.name);
    expect(flow?.startAt).toBe('/books/new');
    const steps = flow?.steps ?? [];
    expect(steps).toHaveLength(7);
    expect(steps[0]).toEqual({ fill: { label: 'Titre', value: 'Le Petit Atlas' } });
    expect(steps[1]).toEqual({ fill: { label: 'ISBN', value: { testData: 'book.isbn' } } });
    expect(steps[2]).toEqual({ click: { role: 'button', name: 'Enregistrer' }, allow: 'MUTATION' });
    expect(steps[3]).toMatchObject({
      expect: { response: { method: 'POST', url: '/api/books', status: '2xx' } },
    });
    expect(steps[4]).toMatchObject({ expect: { noError: true } });
    expect(steps[5]).toEqual({ expect: { url: '/books' } });
    expect(steps[6]).toMatchObject({ expect: { text: 'Livre enregistré' } });
    expect(proposal.expected).toContain('POST /api/books répond en 2xx (plus de 500)');
    expect(proposal.expected).toContain('« Livre enregistré » affiché');
  });

  it('produces a flow the library schema accepts', () => {
    const proposal = proposeRegressionTest({
      incident: incident(FAILING),
      scenarioName: 'creer-livre',
      scenarioYaml: LIBRARY_YAML,
    });
    const flows = flowsSchema.parse(parse(proposal.flowYaml));
    expect(flows).toHaveLength(1);
    expect(flows[0]?.steps.filter((step) => step.kind === 'expect')).toHaveLength(4);
  });

  it('accepts a single-flow file, replaces identifiers in the path and falls back to the scope endpoint', () => {
    const single = `name: modifier-livre\nsteps:\n  - goto: /books/12/edit\n  - click: { text: Enregistrer }\n    allow: MUTATION\n`;
    const edit = proposeRegressionTest({
      incident: incident([request({ id: 'r4', method: 'PUT', path: '/api/books/12', status: 502, step: 2 })]),
      scenarioName: 'modifier-livre',
      scenarioYaml: single,
    });
    const [flow] = parse(edit.flowYaml);
    expect(flow?.steps[2]).toMatchObject({
      expect: { response: { method: 'PUT', url: '/api/books/*', status: '2xx' } },
    });
    expect(flowsSchema.parse(parse(edit.flowYaml))).toHaveLength(1);

    const fromScope = proposeRegressionTest({
      incident: incident([], { scope: scope(['POST /api/books']), expected: 'le livre est créé' }),
      scenarioName: 'creer-livre',
      scenarioYaml: LIBRARY_YAML,
    });
    const steps = parse(fromScope.flowYaml)[0]?.steps ?? [];
    // Sans requête observée : les attentes à la fin, et pas de texte inventé.
    expect(steps.at(-2)).toMatchObject({ expect: { response: { method: 'POST', url: '/api/books' } } });
    expect(steps.at(-1)).toMatchObject({ expect: { noError: true } });
    expect(steps.some((step) => (step.expect as { text?: string } | undefined)?.text !== undefined)).toBe(
      false,
    );
  });

  it('refuses a scenario without steps', () => {
    expect(() =>
      proposeRegressionTest({
        incident: incident(FAILING),
        scenarioName: 'vide',
        scenarioYaml: 'flows: []\n',
      }),
    ).toThrow(/no flow with steps/);
  });

  it('turns identifiers into wildcards', () => {
    expect(responsePattern('/api/books/12/cover')).toBe('/api/books/*/cover');
    expect(responsePattern('/api/books/0b8f6a52-3c1e-4d5a-9f7e-2a6b1c3d4e5f')).toBe('/api/books/*');
    expect(responsePattern('/api/books')).toBe('/api/books');
  });
});
