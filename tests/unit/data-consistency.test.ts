import { describe, expect, it } from 'vitest';
import { consistencySchema, type ConsistencyConfig } from '../../src/config/quality-schema.js';
import type { BusinessProofReport } from '../../src/flows/business-proof.js';
import { identifiersOf, recordsOf, valueDigestsOf } from '../../src/forms/state/form-knowledge-observer.js';
import type { FlowTestDataEntry } from '../../src/model/flow-run.js';
import { checkConsistency, type ConsistencyInput } from '../../src/quality/consistency-engine.js';
import type { ConsistencyResult } from '../../src/quality/model.js';
import type { ObservedExchange } from '../../src/quality/values.js';

/**
 * LA COHÉRENCE DES DONNÉES : une valeur du run suivie de la saisie jusqu'à la recherche, comparée sur
 * des empreintes salées. Une observation partielle le dit, une corrélation incertaine reste incertaine.
 */
const SALT = 'unit-salt';
const TITLE = 'QA-run42 Printer request';

function write(path: string, sent: unknown, returned?: unknown, step = 3, status = 201): ObservedExchange {
  return {
    method: 'POST',
    path,
    status,
    step,
    requestCriteria: valueDigestsOf(sent, SALT, 30),
    ...(returned !== undefined
      ? { identifiers: identifiersOf(returned, SALT), responseValues: valueDigestsOf(returned, SALT, 40) }
      : {}),
  };
}

function read(path: string, body: unknown, step: number): ObservedExchange {
  return {
    method: 'GET',
    path,
    status: 200,
    step,
    records: recordsOf(body, SALT),
    ...(Array.isArray(body) ? { listSize: body.length } : {}),
  };
}

const entry = (key: string, producedAt = 2, sensitive = false): FlowTestDataEntry => ({
  key,
  strategy: 'GENERATED',
  sensitive,
  producedAt,
  usedBy: [{ step: producedAt, how: 'INPUT' }],
});

const proof = (extra: Partial<BusinessProofReport> = {}): BusinessProofReport => ({
  status: 'PROVEN',
  key: 'title',
  creation: { step: 3, description: 'Submit', status: 'PASSED' },
  search: { step: 5, description: 'Search', status: 'PASSED' },
  open: { step: 7, description: 'Open', status: 'PASSED' },
  evidence: [],
  missing: [],
  ...extra,
});

function input(overrides: Partial<ConsistencyInput> & { values?: Record<string, string> }): ConsistencyInput {
  const values = overrides.values ?? { title: TITLE };
  return {
    runId: 'run-1',
    flow: 'Create request',
    salt: SALT,
    networkObserved: true,
    exchanges: [],
    testData: [entry('title')],
    runValue: (key) => (values[key] === undefined ? undefined : { value: values[key], displayable: true }),
    extracted: () => undefined,
    showValues: false,
    ...overrides,
  };
}

const config = (raw: unknown): ConsistencyConfig => consistencySchema.parse(raw);
const only = (results: ConsistencyResult[], rule: ConsistencyResult['rule']): ConsistencyResult[] =>
  results.filter((result) => result.rule === rule);

describe('Data consistency engine', () => {
  it('1. the value typed in the interface is the one sent in the request', () => {
    const { results, evidence } = checkConsistency(
      input({ exchanges: [write('/api/requests', { title: TITLE, kind: 'printer' })] }),
    );
    const [ui] = only(results, 'UI_TO_REQUEST');
    expect(ui).toMatchObject({ status: 'CONSISTENT', key: 'title', field: 'title' });
    expect(ui?.evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({ type: 'NETWORK', runId: 'run-1', step: 3 });

    // Envoyée en majuscules par l'application : cohérente, avec la normalisation dite.
    const upper = checkConsistency(
      input({ exchanges: [write('/api/requests', { title: TITLE.toUpperCase() })] }),
    );
    expect(only(upper.results, 'UI_TO_REQUEST')[0]).toMatchObject({
      status: 'CONSISTENT',
      normalization: expect.stringContaining('case') as unknown,
    });

    // Perdue avant l'envoi : MISSING_DATA, jamais un succès.
    const lost = checkConsistency(
      input({ exchanges: [write('/api/requests', { title: 'something else' })] }),
    );
    expect(only(lost.results, 'UI_TO_REQUEST')[0]?.status).toBe('MISSING_DATA');

    // Une transformation documentée n'est pas une perte.
    const transformed = checkConsistency(
      input({
        exchanges: [write('/api/requests', { slug: 'qa-run42-printer-request' })],
        config: config({ transforms: { title: 'sent as a slug' } }),
      }),
    );
    expect(only(transformed.results, 'UI_TO_REQUEST')[0]).toMatchObject({
      status: 'CONSISTENT',
      normalization: 'documented transformation: sent as a slug',
    });
  });

  it('2. the response returns what was submitted, and a changed value is INCONSISTENT', () => {
    const good = checkConsistency(
      input({ exchanges: [write('/api/requests', { title: TITLE }, { id: 'REQ-1001', title: TITLE })] }),
    );
    expect(only(good.results, 'REQUEST_TO_RESPONSE')[0]).toMatchObject({
      status: 'CONSISTENT',
      field: 'title',
    });

    // 201, mais le serveur a enregistré un autre titre : la création « réussie » est fausse.
    const wrong = checkConsistency(
      input({
        exchanges: [write('/api/requests', { title: TITLE }, { id: 'REQ-1001', title: 'Other title' })],
      }),
    );
    const [mismatch] = only(wrong.results, 'REQUEST_TO_RESPONSE');
    expect(mismatch).toMatchObject({ status: 'INCONSISTENT', field: 'title' });
    expect(mismatch?.difference).toContain('different title');

    // La réponse ne renvoie pas la valeur : rien n'est affirmé sur ce qui est enregistré.
    const silent = checkConsistency(
      input({ exchanges: [write('/api/requests', { title: TITLE }, { id: 'REQ-1001' })] }),
    );
    expect(only(silent.results, 'REQUEST_TO_RESPONSE')[0]).toMatchObject({
      status: 'NOT_OBSERVABLE',
      limits: [expect.stringContaining('not observable') as unknown],
    });
  });

  it('3. the final screen shows the value of this run', () => {
    const shown = checkConsistency(
      input({ uiText: `Request REQ-1001\n${TITLE}\nStatus: open`, config: config({ displayed: ['title'] }) }),
    );
    expect(only(shown.results, 'RESPONSE_TO_UI')[0]).toMatchObject({ status: 'CONSISTENT', declared: true });

    const stale = checkConsistency(
      input({ uiText: 'Request REQ-0999\nAn older request', config: config({ displayed: ['title'] }) }),
    );
    expect(only(stale.results, 'RESPONSE_TO_UI')[0]?.status).toBe('INCONSISTENT');

    const unread = checkConsistency(input({ config: config({ displayed: ['title'] }) }));
    expect(only(unread.results, 'RESPONSE_TO_UI')[0]?.status).toBe('NOT_OBSERVABLE');
  });

  it('4. the later search finds the created entity, identified by its identifier', () => {
    const created = write('/api/requests', { title: TITLE }, { id: 'REQ-1001', title: TITLE });
    const found = checkConsistency(
      input({
        businessProof: proof(),
        exchanges: [
          created,
          read(
            '/api/requests?q=QA-run42',
            [
              { id: 'REQ-1001', title: TITLE },
              { id: 'REQ-0007', title: 'Printer request for room 4' },
            ],
            5,
          ),
        ],
      }),
    );
    expect(only(found.results, 'CREATE_TO_SEARCH')[0]).toMatchObject({ status: 'CONSISTENT', key: 'title' });

    // La recherche ne renvoie pas l'entité créée.
    const missing = checkConsistency(
      input({
        businessProof: proof(),
        exchanges: [created, read('/api/requests?q=QA-run42', [{ id: 'REQ-0007', title: 'Other' }], 5)],
      }),
    );
    expect(only(missing.results, 'CREATE_TO_SEARCH')[0]?.status).toBe('INCONSISTENT');

    // Même valeur, autre identifiant : une autre entité, pas celle créée.
    const other = checkConsistency(
      input({
        businessProof: proof(),
        exchanges: [created, read('/api/requests?q=QA-run42', [{ id: 'REQ-0555', title: TITLE }], 5)],
      }),
    );
    expect(only(other.results, 'CREATE_TO_SEARCH')[0]?.difference).toContain('not the created identifier');
  });

  it('5. a declared relation pointing to the wrong entity is INCONSISTENT', () => {
    const rule = config({
      relations: [
        {
          id: 'request-owner',
          entity: { field: 'title', value: { testData: 'title' } },
          field: 'ownerId',
          expected: { value: 'USR-2001' },
        },
      ],
    });
    const right = checkConsistency(
      input({
        config: rule,
        exchanges: [read('/api/requests/REQ-1001', { id: 'REQ-1001', title: TITLE, ownerId: 'USR-2001' }, 6)],
      }),
    );
    expect(only(right.results, 'RELATION')[0]).toMatchObject({ status: 'CONSISTENT', key: 'request-owner' });

    const wrong = checkConsistency(
      input({
        config: rule,
        exchanges: [read('/api/requests/REQ-1001', { id: 'REQ-1001', title: TITLE, ownerId: 'USR-9999' }, 6)],
      }),
    );
    expect(only(wrong.results, 'RELATION')[0]).toMatchObject({
      status: 'INCONSISTENT',
      declared: true,
      difference: 'ownerId references another entity',
    });

    const unseen = checkConsistency(input({ config: rule, exchanges: [] }));
    expect(only(unseen.results, 'RELATION')[0]?.status).toBe('NOT_OBSERVABLE');
  });

  it('6. a duplicate is flagged only on a declared unique key, never on similar names', () => {
    const list = [
      { id: 'REQ-1001', number: 'N-77001', title: TITLE },
      { id: 'REQ-1002', number: 'N-77002', title: TITLE },
      { id: 'REQ-1003', number: 'N-77003', title: 'qa-run42 printer request' },
    ];
    // Aucune clé unique déclarée : des noms identiques ne sont JAMAIS des doublons.
    const undeclared = checkConsistency(input({ exchanges: [read('/api/requests', list, 5)] }));
    expect(only(undeclared.results, 'DUPLICATE')).toHaveLength(0);

    // La clé déclarée (number) est unique : cohérent, malgré les titres proches.
    const unique = checkConsistency(
      input({
        config: config({ uniqueKeys: [{ field: 'number', value: { value: 'N-77001' } }] }),
        exchanges: [read('/api/requests', list, 5)],
      }),
    );
    expect(only(unique.results, 'DUPLICATE')[0]).toMatchObject({
      status: 'CONSISTENT',
      observed: '1 record(s)',
    });

    // Deux enregistrements partagent la clé déclarée : doublon.
    const duplicated = checkConsistency(
      input({
        config: config({ uniqueKeys: [{ field: 'number', value: { value: 'N-77001' } }] }),
        exchanges: [
          read('/api/requests', [...list, { id: 'REQ-1004', number: 'N-77001', title: 'Another title' }], 5),
        ],
      }),
    );
    expect(only(duplicated.results, 'DUPLICATE')[0]).toMatchObject({
      status: 'INCONSISTENT',
      observed: '2 record(s)',
    });
  });

  it('7. an unexpected side effect (extra write, extra creation) is detected', () => {
    const rule = config({
      sideEffects: { allowedWrites: [{ method: 'POST', path: '/api/requests' }], maxCreated: 1 },
    });
    const clean = checkConsistency(
      input({ config: rule, exchanges: [write('/api/requests', { title: TITLE }, { id: 'REQ-1001' })] }),
    );
    expect(only(clean.results, 'SIDE_EFFECT')[0]).toMatchObject({
      status: 'CONSISTENT',
      limits: [expect.stringContaining('only the browser traffic') as unknown],
    });

    const extra = checkConsistency(
      input({
        config: rule,
        exchanges: [
          write('/api/requests', { title: TITLE }, { id: 'REQ-1001' }),
          write('/api/requests', { title: TITLE }, { id: 'REQ-1002' }, 3),
          write('/api/audit/purge', { all: 'yes' }, undefined, 3, 200),
        ],
      }),
    );
    const [side] = only(extra.results, 'SIDE_EFFECT');
    expect(side?.status).toBe('INCONSISTENT');
    expect(side?.difference).toContain('unexpected write POST /api/audit/purge');
    expect(side?.difference).toContain('2 creation(s) for at most 1');

    // Une liste relue avant et après : deux lignes nouvelles pour une seule création.
    const grown = checkConsistency(
      input({
        config: config({ sideEffects: { maxCreated: 1 } }),
        exchanges: [
          read('/api/requests', [{ id: 'REQ-0001', title: 'Old' }], 1),
          write('/api/requests', { title: TITLE }, { id: 'REQ-1001' }),
          read(
            '/api/requests',
            [
              { id: 'REQ-0001', title: 'Old' },
              { id: 'REQ-1001', title: TITLE },
              { id: 'REQ-1002', title: TITLE },
            ],
            5,
          ),
        ],
      }),
    );
    expect(only(grown.results, 'SIDE_EFFECT')[0]?.difference).toContain('2 record(s) appeared in the list');
  });

  it('8. a search that does not see the entity yet is PENDING when declared eventually consistent', () => {
    const exchanges = [
      write('/api/requests', { title: TITLE }, { id: 'REQ-1001', title: TITLE }),
      read('/api/requests?q=QA-run42', [], 5),
    ];
    const eventual = checkConsistency(
      input({ businessProof: proof(), exchanges, config: config({ eventual: true }) }),
    );
    expect(only(eventual.results, 'CREATE_TO_SEARCH')[0]).toMatchObject({
      status: 'PENDING_EVENTUAL_CONSISTENCY',
      limits: [expect.stringContaining('eventually consistent') as unknown],
    });
    // Sans cette déclaration, c'est une incohérence.
    const strict = checkConsistency(input({ businessProof: proof(), exchanges }));
    expect(only(strict.results, 'CREATE_TO_SEARCH')[0]).toMatchObject({
      status: 'INCONSISTENT',
      difference: 'the search returned nothing',
    });
  });

  it('9. an ambiguous correlation stays ambiguous (no guess from similar records)', () => {
    // La création ne renvoie aucun identifiant ; deux enregistrements portent la valeur.
    const listed = read(
      '/api/requests?q=QA-run42',
      [
        { id: 'REQ-1001', title: TITLE },
        { id: 'REQ-1002', title: TITLE },
      ],
      5,
    );
    const exchanges = [write('/api/requests', { title: TITLE }, { title: TITLE }), listed];
    const { results } = checkConsistency(input({ businessProof: proof(), exchanges }));
    const [search] = only(results, 'CREATE_TO_SEARCH');
    expect(search).toMatchObject({ status: 'AMBIGUOUS_ENTITY', confidence: 0.5 });
    expect(search?.difference).toContain('2 records carry the value');

    // Avec l'identifiant créé, les homonymes ne gênent plus.
    const identified = checkConsistency(
      input({
        businessProof: proof(),
        exchanges: [write('/api/requests', { title: TITLE }, { id: 'REQ-1001', title: TITLE }), listed],
      }),
    );
    expect(only(identified.results, 'CREATE_TO_SEARCH')[0]?.status).toBe('CONSISTENT');

    // Une relation dont l'entité est portée par plusieurs enregistrements : ambiguë.
    const relation = checkConsistency(
      input({
        config: config({
          relations: [
            {
              entity: { field: 'title', value: { testData: 'title' } },
              field: 'ownerId',
              expected: { value: 'U1' },
            },
          ],
        }),
        exchanges: [listed],
      }),
    );
    expect(only(relation.results, 'RELATION')[0]?.status).toBe('AMBIGUOUS_ENTITY');
  });

  it('10. secrets and sensitive values never reach the results or evidence', () => {
    const secret = 'S3cret-Passw0rd!';
    const { results, evidence } = checkConsistency(
      input({
        values: { title: TITLE, password: secret },
        testData: [entry('title'), entry('password', 2, true)],
        uiText: `Welcome ${TITLE}`,
        config: config({ displayed: ['title'], sideEffects: { allowedWrites: [] } }),
        exchanges: [
          write(
            '/api/requests',
            { title: TITLE, password: secret, token: 'tok-abc' },
            { id: 'REQ-1001', title: TITLE, accessToken: 'tok-xyz' },
          ),
        ],
      }),
    );
    const dump = JSON.stringify({ results, evidence });
    expect(dump).not.toContain(secret);
    expect(dump).not.toContain('tok-');
    // Le titre n'apparaît pas non plus en clair tant que l'affichage des valeurs n'est pas permis.
    expect(dump).not.toContain(TITLE);
    // La donnée sensible n'est pas suivie du tout.
    expect(results.some((result) => result.key === 'password')).toBe(false);

    // Affichage permis : seule la valeur générée, affichable, apparaît.
    const shown = checkConsistency(
      input({
        values: { title: TITLE, password: secret },
        testData: [entry('title'), entry('password', 2, true)],
        showValues: true,
        exchanges: [write('/api/requests', { title: TITLE, password: secret })],
      }),
    );
    const visible = JSON.stringify(shown);
    expect(visible).toContain(TITLE);
    expect(visible).not.toContain(secret);
  });

  it('marks everything NOT_OBSERVABLE when the network was not observed in values', () => {
    const { results } = checkConsistency(
      input({
        networkObserved: false,
        businessProof: proof(),
        config: config({ sideEffects: { maxCreated: 1 } }),
      }),
    );
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) expect(result.status).toBe('NOT_OBSERVABLE');
  });
});
