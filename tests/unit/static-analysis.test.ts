import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseOpenApi } from '../../src/oracles/api-contract.js';
import { SemanticVocabulary } from '../../src/semantics/resolution/vocabulary.js';
import { SemanticDictionary } from '../../src/semantics/semantic-dictionary.js';
import { cacheKeyOf } from '../../src/static-analysis/cache.js';
import type { StaticApplicationGraph } from '../../src/static-analysis/model.js';
import { sanitizeText } from '../../src/static-analysis/sanitize.js';
import { StaticApplicationAnalyzer } from '../../src/static-analysis/static-analyzer.js';
import {
  StaticKnowledge,
  decideConcept,
  matchOperation,
} from '../../src/static-analysis/static-knowledge.js';
import { scanTemplate } from '../../src/static-analysis/template-scanner.js';
import { staticAnalyzerOptions as analyzerOptions } from '../helpers.js';

const FIXTURE = path.resolve('tests/fixtures/static-apps/angular');
const vocabulary = new SemanticVocabulary(new SemanticDictionary());
const conceptOf = (text: string): string | undefined => vocabulary.conceptOf(text)?.concept;

describe('static analysis: the Angular application graph (lots A–E)', () => {
  let graph: StaticApplicationGraph;
  let knowledge: StaticKnowledge;

  beforeAll(async () => {
    graph = (await new StaticApplicationAnalyzer(analyzerOptions()).analyzeSource(FIXTURE)).graph;
    const contract = parseOpenApi(await readFile(path.join(FIXTURE, 'openapi.yaml'), 'utf8'));
    knowledge = new StaticKnowledge(graph, conceptOf, contract);
  });

  it('detects Angular from package.json; never reads tests', () => {
    expect(graph.framework).toBe('ANGULAR');
    expect(graph.mode).toBe('SOURCE');
    expect(JSON.stringify(graph)).not.toContain('.spec.ts');
  });

  it('routes: children, lazy children, guards, parameters — all STATIC_DISCOVERED', () => {
    const paths = graph.routes.map((route) => route.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        '/dashboard',
        '/administration',
        '/administration/users',
        '/administration/users/new',
        '/administration/users/:id/contacts',
        '/reports',
        '/reports/monthly',
      ]),
    );
    const administration = graph.routes.find((route) => route.path === '/administration');
    expect(administration?.guards).toEqual(['authGuard']);
    expect(graph.routes.find((route) => route.path.endsWith('contacts'))?.parameters).toEqual(['id']);
    expect(graph.routes.find((route) => route.path === '/')?.redirectTo).toBe('dashboard');
    expect(graph.routes.every((route) => route.truth === 'STATIC_DISCOVERED')).toBe(true);
    expect(knowledge.componentAt('/administration/users/42/contacts')).toBe('ContactsComponent');
  });

  it('navigation: router.navigate and routerLink (static and bound)', () => {
    const edges = graph.navigation.map((edge) => `${edge.fromComponent} ${edge.evidence} ${edge.target}`);
    expect(edges).toEqual(
      expect.arrayContaining([
        'DashboardComponent ROUTER_NAVIGATION /administration/users',
        'DashboardComponent ROUTER_LINK /reports/monthly',
        'UsersComponent ROUTER_LINK /administration/users/new',
      ]),
    );
  });

  it('forms: FormBuilder.group, validators, template ↔ FormControl (templateUrl and inline template)', () => {
    const contact = graph.fields.find((field) => field.control === 'contact');
    expect(contact?.validators).toEqual([{ kind: 'required' }, { kind: 'email' }]);
    expect(contact?.templateBinding).toMatchObject({ tag: 'input', inputType: 'text' });
    expect(graph.fields.find((field) => field.control === 'firstName')?.validators).toContainEqual({
      kind: 'maxLength',
      value: 100,
    });
    expect(
      graph.fields.find((field) => field.control === 'primaryContact')?.templateBinding?.template,
    ).toContain('(inline)');
  });

  it('DTO, HTTP calls, service chain and data flows; a computed key is UNRESOLVED_DATA_FLOW, never guessed', () => {
    expect(graph.dtos.map((dto) => dto.name)).toEqual(
      expect.arrayContaining(['CreateUserRequest', 'ContactsRequest']),
    );
    expect(graph.apiCalls.find((call) => call.id === 'UserService#create')).toMatchObject({
      method: 'POST',
      route: '/api/users',
      bodyParameter: 'request',
      bodyType: 'CreateUserRequest',
      responseType: 'User',
    });
    const flow = graph.dataFlows.find((entry) => entry.field === 'CreateUserComponent#form.contact');
    expect(flow).toMatchObject({
      status: 'RESOLVED',
      requestProperty: 'request.email',
      dtoProperty: 'CreateUserRequest.email',
      apiCall: 'UserService#create',
    });
    // Destructuration + objet passé en argument
    expect(
      graph.dataFlows.find((entry) => entry.field === 'ContactsComponent#form.primaryContact'),
    ).toMatchObject({
      requestProperty: 'body.primaryEmail',
      dtoProperty: 'ContactsRequest.primaryEmail',
    });
    expect(graph.dataFlows.some((entry) => entry.status === 'UNRESOLVED_DATA_FLOW')).toBe(true);
    expect(graph.coverage).toBe('PARTIAL');
  });

  it('the main chain: input → contact → request.email → CreateUserRequest.email → POST /api/users → OpenAPI format=email → EMAIL', () => {
    const [provenance] = knowledge.provenanceFor('contact');
    expect(provenance?.chain).toEqual([
      'input[type=text]',
      'formControlName=contact',
      'FormControl contact',
      'Validators.required',
      'Validators.email',
      'contact → request.email',
      'CreateUserRequest.email',
      'POST /api/users',
      'OpenAPI email type=string format=email',
    ]);
    expect(provenance?.concept).toBe('email');
    expect(provenance?.conflicts).toEqual([]);
    expect(provenance?.truth).toBe('STATIC_DISCOVERED');
    const sources = new Set(provenance?.evidence.map((entry) => entry.source));
    expect([...sources]).toEqual(
      expect.arrayContaining(['FRAMEWORK', 'STATIC_CODE', 'DTO', 'HTTP', 'OPENAPI']),
    );
    // Chaque arête garde source, cible, relation, preuve et confiance.
    expect(provenance?.edges.map((edge) => edge.relation)).toEqual(
      expect.arrayContaining([
        'formControlName',
        'assigned-to',
        'dto-property',
        'request-body',
        'openapi-property',
      ]),
    );
  });

  it('contradiction: formControlName "phone" (phone) sent as backupEmail (email): SEMANTIC_EVIDENCE_CONFLICT, the stronger evidence wins', () => {
    const [provenance] = knowledge.provenanceFor('phone');
    expect(provenance?.conflicts[0]?.kind).toBe('SEMANTIC_EVIDENCE_CONFLICT');
    expect(provenance?.conflicts[0]?.detail).toMatch(/email .* vs phone/);
    expect(provenance?.concept).toBe('email');
  });

  it('indexes: concept → fields, API → fields (reverse), DTO property → fields', () => {
    expect(knowledge.fieldsForConcept('email').map((entry) => entry.control)).toEqual(
      expect.arrayContaining(['contact', 'primaryContact', 'secondaryContact']),
    );
    expect(knowledge.fieldsForApi('POST', '/api/users').map((field) => field.control)).toEqual(
      expect.arrayContaining(['contact', 'firstName']),
    );
    expect(knowledge.fieldsForDtoProperty('CreateUserRequest.email').map((field) => field.control)).toEqual([
      'contact',
    ]);
    expect(knowledge.validatorsFor('firstName')).toContainEqual({ kind: 'maxLength', value: 100 });
  });

  it('runtime confirmation changes STATIC_DISCOVERED into RUNTIME_CONFIRMED, only for that field', () => {
    knowledge.confirm('firstName', 'CreateUserComponent');
    expect(knowledge.provenanceFor('firstName')[0]?.truth).toBe('RUNTIME_CONFIRMED');
    expect(knowledge.provenanceFor('contact')[0]?.truth).toBe('STATIC_DISCOVERED');
  });

  it('secrets never reach the static knowledge', () => {
    const json = JSON.stringify(graph);
    expect(json).not.toContain('fixture-constant-not-a-real-key');
    expect(json).not.toContain('token=');
    expect(sanitizeText('Authorization: Bearer abcdefghijklmnop')).not.toContain('abcdefghijklmnop');
    expect(sanitizeText('/api/x/ghp_1a2B3c4D5e6F7g8H9i0J1k2L3m4N')).toContain('[REDACTED]');
    expect(sanitizeText('https://h/api?api_key=secret123')).toContain('api_key=[REDACTED]');
  });
});

describe('static analysis: cache, budget, helpers', () => {
  it('cache: MISS then HIT for the same hash; a changed source is a new hash (MISS)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'qa-static-cache-'));
    const app = path.join(dir, 'app');
    await cp(FIXTURE, app, { recursive: true });
    const events: string[] = [];
    const analyzer = new StaticApplicationAnalyzer(
      analyzerOptions({ cacheDirectory: path.join(dir, 'cache'), onEvent: (event) => events.push(event) }),
    );
    const first = await analyzer.analyzeSource(app);
    expect(first.cache).toBe('MISS');
    const second = await analyzer.analyzeSource(app);
    expect(second.cache).toBe('HIT');
    expect(second.graph.sourceHash).toBe(first.graph.sourceHash);
    await writeFile(path.join(app, 'src/app/core/auth.guard.ts'), 'export const authGuard = () => false;\n');
    const third = await analyzer.analyzeSource(app);
    expect(third.cache).toBe('MISS');
    expect(third.graph.sourceHash).not.toBe(first.graph.sourceHash);
    expect(events).toEqual(
      expect.arrayContaining([
        'STATIC_ANALYSIS_CACHE_MISS',
        'STATIC_ANALYSIS_CACHE_HIT',
        'STATIC_ANALYSIS_COMPLETED',
      ]),
    );
  });

  it('the cache key changes with the commit, the version and the analyzer version', () => {
    const base = { application: 'a', mode: 'SOURCE' as const, sourceHash: 'h' };
    const keys = new Set([
      cacheKeyOf(base),
      cacheKeyOf({ ...base, commit: 'c1' }),
      cacheKeyOf({ ...base, version: '2.0' }),
      cacheKeyOf({ ...base, analyzerVersion: '0.9' }),
      cacheKeyOf({ ...base, sourceHash: 'h2' }),
    ]);
    expect(keys.size).toBe(5);
  });

  it('budget: too many AST nodes → STATIC_ANALYSIS_BUDGET_EXHAUSTED, partial knowledge, no failure', async () => {
    const events: string[] = [];
    const { graph } = await new StaticApplicationAnalyzer(
      analyzerOptions({
        budgets: { maxFiles: 500, maxDurationMs: 30_000, maxFileSizeBytes: 2_000_000, maxAstNodes: 50 },
        onEvent: (event) => events.push(event),
      }),
    ).analyzeSource(FIXTURE);
    expect(graph.coverage).toBe('PARTIAL');
    expect(graph.warnings.join(' ')).toContain('STATIC_ANALYSIS_BUDGET_EXHAUSTED');
    expect(events).toContain('STATIC_ANALYSIS_BUDGET_EXHAUSTED');
  });

  it('a missing source folder gives an empty graph, never an exception', async () => {
    const { graph } = await new StaticApplicationAnalyzer(analyzerOptions()).analyzeSource(
      '/nonexistent/app',
    );
    expect(graph.framework).toBe('UNKNOWN');
    expect(graph.fields).toEqual([]);
  });

  it('template scanner: formControlName, [formControlName], [formControl], routerLink', () => {
    const facts = scanTemplate(
      `<input formControlName="a"><select [formControlName]="'b'"></select>
       <input [formControl]="form.controls['c']" type="email"><a [routerLink]="['/x', id, 'y']">x</a>`,
    );
    expect(facts.controls.map((control) => control.control)).toEqual(['a', 'b', 'c']);
    expect(facts.controls[2]?.inputType).toBe('email');
    expect(facts.links).toEqual([{ target: '/x/:param/y', line: 2 }]);
  });

  it('decideConcept: agreement → the concept; two strong opposite concepts → conflict without a winner', () => {
    expect(
      decideConcept([
        { source: 'STATIC_CODE', kind: 'data-flow', value: 'x', concept: 'email', confidence: 0.85 },
        { source: 'OPENAPI', kind: 'openapi-format', value: 'x', concept: 'email', confidence: 0.9 },
      ]).concept,
    ).toBe('email');
    const split = decideConcept([
      { source: 'STATIC_CODE', kind: 'data-flow', value: 'x', concept: 'email', confidence: 0.85 },
      { source: 'OPENAPI', kind: 'openapi-format', value: 'x', concept: 'phone', confidence: 0.9 },
    ]);
    expect(split.concept).toBeUndefined();
    expect(split.conflicts[0]?.kind).toBe('SEMANTIC_EVIDENCE_CONFLICT');
  });

  it('OpenAPI operation matching ignores an unknown base prefix and parameters', () => {
    const contract = parseOpenApi(`openapi: 3.0.0
paths:
  /api/users/{id}/contacts:
    put: { responses: { '200': { description: ok } } }
`);
    expect(matchOperation(contract, 'PUT', '{base}/api/users/{param}/contacts')?.path).toBe(
      '/api/users/{id}/contacts',
    );
    expect(matchOperation(contract, 'POST', '/api/users/{param}/contacts')).toBeUndefined();
  });
});
