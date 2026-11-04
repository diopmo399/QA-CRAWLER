import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  allSteps,
  describeStep,
  flowSchema,
  loopDepth,
  type FlowStep,
} from '../../src/config/flow-schema.js';
import { TestDataRunContext } from '../../src/data/test-data-run-context.js';
import { loopVariables, parseLoopItems } from '../../src/explorer/flow-explorer.js';
import { resolveFlowRuns, renameTestData } from '../../src/flows/flow-includes.js';
import { rawStepOf } from '../../src/dry-run/suggested-flow.js';
import { stepYaml } from '../../src/platform/flow-steps.js';
import {
  compileLoop,
  defaultLoop,
  loopProblems,
  loopVariableKeys,
  sanitizeLoop,
} from '../../src/sdk/core/journey-loop.js';
import { compileJourneyPath, journeyStructure, type JourneyGraph } from '../../src/sdk/core/journey.js';
import { dataUse } from '../../src/sdk/server/library-contract.js';

const flowOf = (yaml: string) => flowSchema.parse(parse(yaml));
const errorOf = (yaml: string): string => {
  const result = flowSchema.safeParse(parse(yaml));
  return result.success ? '' : result.error.issues.map((issue) => issue.message).join(' | ');
};

describe('loop step — schema', () => {
  it('parses REPEAT, FOR_EACH (inline and from data) and WHILE with their defaults', () => {
    const flow = flowOf(`name: Loops
steps:
  - loop:
      id: clicks
      type: REPEAT
      times: 3
      steps:
        - click: { role: button, name: Increment }
  - loop:
      id: persons
      type: FOR_EACH
      as: person
      items: [{ firstName: Ada }, { firstName: Alan }]
      steps:
        - fill: { label: First name, value: "\${testData:person.firstName}" }
  - loop:
      id: rows
      type: FOR_EACH
      itemsFrom: request.rows
      steps:
        - expect: { text: "\${testData:rows}" }
  - loop:
      id: queue
      type: WHILE
      while: { visible: { css: li.pending } }
      steps:
        - click: { role: button, name: Process one }
`);
    const loops = flow.steps.map((step) => (step.kind === 'loop' ? step.loop : undefined));
    expect(loops[0]).toMatchObject({
      type: 'REPEAT',
      times: 3,
      maxIterations: 3,
      as: 'clicks',
      onFailure: 'STOP',
    });
    expect(loops[1]).toMatchObject({ type: 'FOR_EACH', as: 'person', maxIterations: 2 });
    expect(loops[2]).toMatchObject({ type: 'FOR_EACH', itemsFrom: 'request.rows', maxIterations: 100 });
    expect(loops[3]).toMatchObject({ type: 'WHILE', maxIterations: 20, timeoutMs: 120_000 });
    expect(loops[3]?.type === 'WHILE' ? loops[3].while.visible : undefined).toMatchObject({
      strategy: 'css',
    });
    expect(describeStep(flow.steps[1] as FlowStep)).toBe(
      'loop persons: FOR_EACH person in 2 items (1 steps)',
    );
    expect(allSteps(flow.steps)).toHaveLength(8);
  });

  it('refuses an incomplete or unbounded loop, and deep nesting', () => {
    expect(errorOf(`name: X\nsteps:\n  - loop: { id: a, type: REPEAT, steps: [{ goto: / }] }`)).toMatch(
      /REPEAT needs times/,
    );
    expect(errorOf(`name: X\nsteps:\n  - loop: { id: a, type: WHILE, steps: [{ goto: / }] }`)).toMatch(
      /WHILE needs a while condition/,
    );
    expect(
      errorOf(
        `name: X\nsteps:\n  - loop: { id: a, type: FOR_EACH, items: [x], itemsFrom: k, steps: [{ goto: / }] }`,
      ),
    ).toMatch(/exactly one of items, itemsFrom/);
    expect(
      errorOf(`name: X\nsteps:\n  - loop: { id: a, type: REPEAT, times: 101, steps: [{ goto: / }] }`),
    ).not.toBe('');
    expect(
      errorOf(
        `name: X\nsteps:\n  - loop: { id: a, type: REPEAT, times: 5, maxIterations: 2, steps: [{ goto: / }] }`,
      ),
    ).toMatch(/above maxIterations/);
    expect(errorOf(`name: X\nsteps:\n  - loop: { id: a, type: REPEAT, times: 2, steps: [] }`)).not.toBe('');
    expect(
      errorOf(`name: X
steps:
  - loop:
      id: a
      type: REPEAT
      times: 2
      steps:
        - loop:
            id: b
            type: REPEAT
            times: 2
            steps:
              - loop: { id: c, type: REPEAT, times: 2, steps: [{ goto: / }] }
`),
    ).toMatch(/nest at most 2 levels/);
  });

  it('serializes a loop back to YAML without flattening it (round trip)', () => {
    const flow = flowOf(`name: Round
steps:
  - name: Each person
    loop:
      id: persons
      type: FOR_EACH
      as: person
      items: [{ firstName: Ada }]
      onFailure: CONTINUE
      timeoutMs: 5000
      steps:
        - fill: { label: First name, value: "\${testData:person.firstName}" }
        - capture: { as: person.code, text: { css: "#code" }, transform: uppercase }
`);
    const [step] = flow.steps;
    if (!step) throw new Error('one step');
    const again = flowSchema.parse({ name: 'Round', steps: [rawStepOf(step)] });
    expect(again.steps).toEqual(flow.steps);
    const mission = flowSchema.parse({ name: 'Round', steps: [stepYaml(step)] });
    expect(mission.steps[0]).toMatchObject({ kind: 'loop', loop: { id: 'persons', onFailure: 'CONTINUE' } });
    expect(loopDepth(flow.steps)).toBe(1);
  });
});

describe('loop step — run: inside a loop body is expanded, never the loop', () => {
  it('expands blocks inside the body and renames itemsFrom with `with:`', () => {
    const [flow] = resolveFlowRuns([
      {
        name: 'Add person',
        reusable: true,
        steps: [{ fill: { label: 'First name', value: '${testData:person.firstName}' } }],
      },
      {
        name: 'Journey',
        steps: [{ loop: { id: 'p', type: 'REPEAT', times: 2, steps: [{ run: 'Add person' }] } }],
      },
    ]) as { steps: { loop: { steps: { name: string }[] } }[] }[];
    expect(flow?.steps[0]?.loop.steps).toEqual([
      {
        fill: { label: 'First name', value: '${testData:person.firstName}' },
        name: 'run Add person › fill "First name"',
      },
    ]);
    expect(
      renameTestData({ loop: { itemsFrom: 'rows', steps: [] } }, new Map([['rows', 'request.rows']])),
    ).toEqual({
      loop: { itemsFrom: 'request.rows', steps: [] },
    });
  });
});

describe('loop iterations — variables and data scope', () => {
  it('builds the iteration variables and reads collections from JSON', () => {
    expect(loopVariables('person', 2, { firstName: 'Alan' })).toEqual({
      'person.index': '2',
      'person.firstName': 'Alan',
    });
    expect(loopVariables('item', 1, 'one')).toEqual({ 'item.index': '1', item: 'one' });
    expect(parseLoopItems('[{"a":"x","n":2},"y"]', 'k')).toEqual({ items: [{ a: 'x', n: '2' }, 'y'] });
    expect(parseLoopItems('{"a":1}', 'k')).toEqual({ error: 'testData.k is not a JSON array' });
    const nested = parseLoopItems('[[1]]', 'k');
    expect('error' in nested ? nested.error : '').toMatch(/neither a value nor an object/);
  });

  it('keeps run values, scopes iteration values, generates one value per iteration and traces everything', () => {
    let now = 0;
    const run = new TestDataRunContext({ runId: 'r', env: {}, now: () => new Date(now++ * 1000) });
    const sources = { fallback: () => undefined, generate: () => 'Same Name' };
    const sets = [
      {
        id: 's',
        name: 's',
        source: 'MANUAL' as const,
        values: {
          'company.name': {
            key: 'company.name',
            strategy: 'GENERATE_AT_REPLAY' as const,
            generator: 'company',
            sensitive: false,
          },
          'person.email': {
            key: 'person.email',
            strategy: 'GENERATE_AT_REPLAY' as const,
            generator: 'email',
            sensitive: false,
          },
        },
      },
    ];
    run.locate({ step: 1, stepName: 'Create company › fill' });
    expect(run.resolve('company.name', sets, sources)).toMatchObject({ value: 'Same Name' });
    const emails: string[] = [];
    for (const iteration of [1, 2]) {
      run.enterIteration('persons', iteration, {
        'person.index': String(iteration),
        'person.firstName': `P${String(iteration)}`,
      });
      const email = run.resolve('person.email', sets, sources);
      if (email.kind === 'value') emails.push(email.value);
      // La valeur du run reste la même pendant la boucle.
      expect(run.resolve('company.name', sets, sources)).toMatchObject({ value: 'Same Name' });
      expect(run.resolve('person.firstName', sets, sources)).toMatchObject({
        value: `P${String(iteration)}`,
        strategy: 'ITERATION',
      });
      expect(run.capture('person.id', `id-${String(iteration)}`)).toBeUndefined();
      expect(run.capture('person.id', 'other')).toMatch(/another value in this iteration/);
      run.leaveIteration();
    }
    // Une valeur générée par itération, jamais la même (et jamais celle d'une autre clé).
    expect(new Set(emails).size).toBe(2);
    expect(emails).not.toContain('Same Name');
    // Les valeurs d'itération ne survivent pas à la boucle.
    expect(run.has('person.id')).toBe(false);
    expect(run.has('person.firstName')).toBe(false);
    expect(run.has('company.name')).toBe(true);
    const trace = run.trace();
    expect(trace.find((entry) => entry.key === 'company.name')).toMatchObject({
      origin: 'GENERATED',
      value: 'Same Name',
      step: 1,
      stepName: 'Create company › fill',
    });
    expect(
      trace
        .filter((entry) => entry.key === 'person.id')
        .map((entry) => [entry.origin, entry.value, entry.valueId, entry.loops?.[0]?.iteration]),
    ).toEqual([
      ['CAPTURED', 'id-1', 'person.id@1', 1],
      ['OVERWRITE_REFUSED', 'other', undefined, 1],
      ['CAPTURED', 'id-2', 'person.id@2', 2],
      ['OVERWRITE_REFUSED', 'other', undefined, 2],
    ]);
  });

  it('links each use to the event that produced the value, by kind of use; transformations and retention', () => {
    const run = new TestDataRunContext({ runId: 'r', env: {} });
    const sources = { fallback: () => undefined, generate: () => 'Acme Name' };
    const sets = [
      {
        id: 's',
        name: 's',
        source: 'MANUAL' as const,
        values: {
          'company.name': {
            key: 'company.name',
            strategy: 'GENERATE_AT_REPLAY' as const,
            generator: 'company',
            sensitive: false,
          },
        },
      },
    ];
    run.locate({ step: 2, stepName: 'Create company › fill "Company name"' });
    run.resolve('company.name', sets, sources);
    run.used('company.name', 'ASSIGN', 'Acme Name');
    run.capture('company.code', 'ab-12');
    run.transformed('company.code', 'uppercase');
    run.locate({ step: 7, stepName: 'Create request › expect' });
    run.used('company.name', 'VALIDATE', 'Acme Name');
    run.used('request.title', 'READ', 'Fixed title');
    const [generated, assigned, captured, transformed, validated, fixed] = run.trace();
    expect(generated).toMatchObject({ id: 'd1', origin: 'GENERATED', valueId: 'company.name@1' });
    expect(assigned).toMatchObject({
      origin: 'USED',
      use: 'ASSIGN',
      valueId: 'company.name@1',
      source: 'd1',
    });
    expect(captured).toMatchObject({ origin: 'CAPTURED', valueId: 'company.code@1' });
    expect(transformed).toMatchObject({ origin: 'TRANSFORMED', detail: 'uppercase', source: captured?.id });
    expect(validated).toMatchObject({
      use: 'VALIDATE',
      value: 'Acme Name',
      source: 'd1',
      stepName: 'Create request › expect',
    });
    expect(fixed).toMatchObject({ use: 'READ', fixed: true, value: 'Fixed title' });
    expect(fixed?.source).toBeUndefined();

    const quiet = new TestDataRunContext({ runId: 'r', env: {}, traceValues: false });
    quiet.capture('company.code', 'ab-12');
    quiet.used('company.code', 'READ', 'ab-12');
    expect(quiet.trace()).toEqual([
      expect.objectContaining({ origin: 'CAPTURED', withheld: true, valueId: 'company.code@1' }),
      expect.objectContaining({ origin: 'USED', withheld: true, source: 'd1' }),
    ]);
    expect(JSON.stringify(quiet.trace())).not.toContain('ab-12');
  });

  it('never keeps the value of a sensitive key in the trace', () => {
    const run = new TestDataRunContext({ runId: 'r', env: {} });
    run.capture('user.password', 'secret-value');
    expect(run.trace()).toEqual([expect.objectContaining({ key: 'user.password', masked: true })]);
    expect(JSON.stringify(run.trace())).not.toContain('secret-value');
  });
});

describe('journey loop node — model, compilation, structure', () => {
  const graph = (loop = defaultLoop('FOR_EACH')): JourneyGraph => ({
    nodes: [
      { id: 'n1', kind: 'START', x: 0, y: 0 },
      {
        id: 'n3',
        kind: 'LOOP',
        loop: {
          ...loop,
          as: 'person',
          items: [{ firstName: 'Ada' }, { firstName: 'Alan' }],
          maxIterations: 2,
          body: [
            {
              id: 'n3i1',
              kind: 'BLOCK',
              block: 'Add person',
              version: 1,
              params: { name: { mode: 'MAP', key: 'person.firstName' } },
            },
            {
              id: 'n3i2',
              kind: 'WAIT',
              wait: { type: 'TEXT', text: '${testData:person.firstName}', timeoutS: 5, onTimeout: 'FAIL' },
            },
          ],
        },
        x: 0,
        y: 100,
      },
      { id: 'n2', kind: 'END', x: 0, y: 200 },
    ],
    edges: [
      { id: 'e1', from: 'n1', to: 'n3' },
      { id: 'e2', from: 'n3', to: 'n2' },
    ],
  });

  it('compiles the loop node into ONE loop step with its body (run: + with:, wait)', () => {
    const { steps } = compileJourneyPath(graph(), ['n1', 'n3', 'n2']);
    expect(steps).toEqual([
      {
        name: 'Pour chaque person (2 éléments)',
        loop: {
          id: 'n3',
          type: 'FOR_EACH',
          items: [{ firstName: 'Ada' }, { firstName: 'Alan' }],
          as: 'person',
          maxIterations: 2,
          timeoutMs: 120_000,
          onFailure: 'STOP',
          steps: [
            { run: 'Add person', with: { name: 'person.firstName' } },
            {
              name: 'Attente : texte « ${testData:person.firstName} »',
              expect: { text: '${testData:person.firstName}' },
              timeoutMs: 5000,
            },
          ],
        },
      },
    ]);
    // Le flow compilé est accepté par le schéma du moteur (après dépliage des blocs).
    const [flow] = resolveFlowRuns([
      {
        name: 'Add person',
        reusable: true,
        steps: [{ fill: { label: 'Name', value: { testData: 'name' } } }],
      },
      { name: 'Journey', steps },
    ]);
    expect(flowSchema.safeParse(flow).success).toBe(true);
  });

  it('reports structural problems of a loop and refuses uncontrolled back edges', () => {
    const empty = graph({ ...defaultLoop('FOR_EACH') });
    const node = empty.nodes[1];
    if (node?.loop) node.loop.body = [];
    expect(journeyStructure(empty).nodes.n3).toEqual(
      expect.arrayContaining(['la boucle ne contient aucun bloc', 'ajoutez au moins un bloc dans la boucle']),
    );
    expect(
      loopProblems({ ...defaultLoop('FOR_EACH'), body: [{ id: 'x', kind: 'BLOCK', block: 'B' }] }),
    ).toEqual(['la collection est vide : ajoutez des éléments ou choisissez une donnée']);
    const cyclic = graph();
    cyclic.nodes.push({ id: 'n4', kind: 'BLOCK', block: 'Other', x: 0, y: 300 });
    cyclic.edges.push({ id: 'e3', from: 'n3', to: 'n4' }, { id: 'e4', from: 'n4', to: 'n3' });
    expect(Object.values(journeyStructure(cyclic).edges).flat().join(' ')).toMatch(/boucle non contrôlée/);
  });

  it('sanitizes a loop received as JSON and lists its iteration variables', () => {
    const spec = sanitizeLoop({
      type: 'FOR_EACH',
      as: 'person',
      items: [{ firstName: 'Ada', 'bad key': 'x' }, 'two', 3],
      maxIterations: 500,
      timeoutS: -4,
      body: [{ id: 'i1', kind: 'BLOCK', block: 'B', extra: true }, { kind: 'NOPE' }],
    });
    expect(spec).toEqual({
      type: 'FOR_EACH',
      as: 'person',
      items: [{ firstName: 'Ada' }, 'two', '3'],
      maxIterations: 100,
      timeoutS: 1,
      onFailure: 'STOP',
      body: [{ id: 'i1', kind: 'BLOCK', block: 'B' }],
    });
    expect(loopVariableKeys(spec)).toEqual({
      keys: ['person.index', 'person.firstName', 'person'],
      open: false,
    });
    expect(loopVariableKeys({ ...spec, items: undefined, itemsFrom: 'rows' })).toEqual({
      keys: ['person.index'],
      open: true,
    });
    expect(
      compileLoop('n9', { ...defaultLoop('WHILE'), body: [] }, undefined, () => undefined),
    ).toMatchObject({
      loop: { type: 'WHILE', while: { visible: {} } },
    });
  });
});

describe('block contract with a loop', () => {
  it('iteration variables and values produced in the body are neither inputs nor outputs', () => {
    const use = dataUse([
      { fill: { label: 'Company', value: '${testData:company.name}' } },
      {
        loop: {
          id: 'persons',
          as: 'person',
          type: 'FOR_EACH',
          itemsFrom: 'request.persons',
          steps: [
            { fill: { label: 'First', value: '${testData:person.firstName}' } },
            { capture: { as: 'person.id', text: { css: '#id' } } },
            { expect: { text: '${testData:person.id} ${testData:request.code}' } },
          ],
        },
      },
    ]);
    expect(use.cites.sort()).toEqual(['company.name', 'request.code', 'request.persons']);
    expect(use.captures).toEqual([]);
    expect(use.local.sort()).toEqual(['person.firstName', 'person.id']);
  });
});
