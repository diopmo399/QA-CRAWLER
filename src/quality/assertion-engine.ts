import type { AssertionCheck, AssertionConfig, RequiredEvidence } from '../config/quality-schema.js';
import type { ContractOperation } from '../oracles/api-contract.js';
import { declares } from '../oracles/api-contract.js';
import { foldValue } from '../functional/http-structure.js';
import type { FlowStatus } from '../model/flow-run.js';
import type { AssertionResult, AssertionStatus, QualityEvidence, VerificationSource } from './model.js';
import {
  WRITE_METHODS,
  digestMatch,
  exchangeMatches,
  fieldMatches,
  interpolateUrl,
  isAccepted,
  jsonLeaves,
  jsonRecords,
  recordHas,
  resolveValue,
  selectJson,
  shortDigest,
  statusMatches,
  textMatch,
  type DigestMatch,
  type ExtractedValue,
  type ObservedExchange,
  type ResolvedValue,
  type ValueSources,
} from './values.js';

/**
 * LE MOTEUR D'ASSERTIONS MÉTIER : chaque assertion déclarée est jugée sur des PREUVES, jamais sur le
 * seul fait que Playwright a cliqué. Les sources sont injectées (réseau du flow en empreintes, valeurs
 * du run, texte de l'écran, lecture d'API en GET, contrat) : le moteur ne pilote rien et n'écrit rien.
 *
 * Une source absente donne UNVERIFIABLE ; des preuves insuffisantes, INCONCLUSIVE ; une précondition
 * non remplie, BLOCKED. Un résultat asynchrone est relu jusqu'au délai de l'assertion, jamais déclaré
 * réussi avant d'être observé.
 */

export type ApiReadResult = { status: number; body: unknown } | { error: string; unauthorized?: boolean };

export interface VerificationContext {
  runId: string;
  flow: string;
  /** Le sel du run : sans lui, aucune empreinte réseau (le réseau n'est pas observé en valeurs). */
  salt?: string;
  /** Le réseau du flow a-t-il été observé (fenêtre ouverte, empreintes) ? */
  networkObserved: boolean;
  exchanges(): readonly ObservedExchange[];
  runValue(key: string): { value: string; displayable: boolean } | undefined;
  stepStatus(index: number): FlowStatus | undefined;
  /** Le texte visible de l'écran courant (lecture seule) ; absent : pas de page. */
  uiText?: () => Promise<string | undefined>;
  /** Une lecture d'API autorisée (GET, hôte permis) ; absent : aucune lecture configurable. */
  apiGet?: (url: string) => Promise<ApiReadResult>;
  /** Les opérations du contrat OpenAPI de la mission, s'il y en a un. */
  contract?: readonly ContractOperation[];
  showValues: boolean;
  now(): number;
  sleep(ms: number): Promise<void>;
}

interface Attempt {
  status: AssertionStatus;
  source?: VerificationSource;
  expected: string;
  observed: string;
  reasons: string[];
  evidence: Omit<QualityEvidence, 'id' | 'runId' | 'flow' | 'assertionId'>[];
  /** Relire plus tard peut changer la conclusion (affichage, API, traitement asynchrone). */
  retry: boolean;
  nextStep?: string;
}

const EVIDENCE_OF: Readonly<Record<VerificationSource, RequiredEvidence | undefined>> = {
  NETWORK: 'NETWORK',
  DOM: 'DOM',
  API: 'API',
  OPENAPI: 'OPENAPI',
  RUN_DATA: undefined,
};

export class BusinessAssertionEngine {
  private readonly extracted = new Map<string, ExtractedValue>();
  private readonly results = new Map<string, AssertionResult>();
  private readonly evidence: QualityEvidence[] = [];
  private sequence = 0;

  constructor(private readonly context: VerificationContext) {}

  get allResults(): AssertionResult[] {
    return [...this.results.values()];
  }

  get allEvidence(): QualityEvidence[] {
    return [...this.evidence];
  }

  /** Les identifiants extraits (pour la cohérence des données : relations, recherche). */
  extractedValue(name: string): ExtractedValue | undefined {
    return this.extracted.get(name);
  }

  private sources(): ValueSources {
    return {
      ...(this.context.salt !== undefined ? { salt: this.context.salt } : {}),
      runValue: (key) => this.context.runValue(key),
      extracted: (name) => this.extracted.get(name),
    };
  }

  /** Juge une assertion (préconditions, relectures bornées, preuves exigées). */
  async evaluate(assertion: AssertionConfig): Promise<AssertionResult> {
    const started = this.context.now();
    const blocked = this.precondition(assertion);
    let attempt: Attempt;
    let attempts = 0;
    if (blocked) attempt = blocked;
    else {
      const deadline = started + assertion.timeoutMs;
      for (;;) {
        attempts += 1;
        attempt = await this.attempt(assertion.check).catch((error: unknown): Attempt => ({
          status: 'INCONCLUSIVE',
          expected: '',
          observed: '',
          reasons: [
            `the verification could not run: ${error instanceof Error ? error.message : String(error)}`,
          ],
          evidence: [],
          retry: false,
        }));
        if (attempt.status === 'PASS' || !attempt.retry || this.context.now() + assertion.pollMs > deadline)
          break;
        await this.context.sleep(assertion.pollMs);
      }
      // Les preuves exigées : un succès sans elles ne suffit pas.
      const missing = assertion.evidence.filter(
        (kind) => !(attempt.source !== undefined && EVIDENCE_OF[attempt.source] === kind),
      );
      if (attempt.status === 'PASS' && missing.length > 0)
        attempt = {
          ...attempt,
          status: 'INCONCLUSIVE',
          reasons: [...attempt.reasons, `required evidence missing: ${missing.join(', ')}`],
        };
    }
    const ids = attempt.evidence.map((item) => {
      this.sequence += 1;
      const id = `${this.context.flow}#${assertion.id}#e${String(this.sequence)}`;
      this.evidence.push({
        ...item,
        id,
        runId: this.context.runId,
        flow: this.context.flow,
        assertionId: assertion.id,
      });
      return id;
    });
    const result: AssertionResult = {
      id: assertion.id,
      description: assertion.description,
      flow: this.context.flow,
      kind: assertion.check.kind,
      criticality: assertion.criticality,
      mandatory: assertion.mandatory,
      status: attempt.status,
      ...(attempt.source ? { source: attempt.source } : {}),
      ...(assertion.after !== undefined ? { after: assertion.after } : {}),
      entities: assertion.entities,
      expected: attempt.expected,
      observed: attempt.observed,
      reasons: attempt.reasons,
      evidence: ids,
      attempts,
      durationMs: this.context.now() - started,
      ...(attempt.nextStep ? { nextStep: attempt.nextStep } : {}),
    };
    this.results.set(assertion.id, result);
    return result;
  }

  /** Une assertion qui ne peut pas être vérifiée parce que son étape n'a pas eu lieu. */
  blocked(assertion: AssertionConfig, reason: string): AssertionResult {
    const result: AssertionResult = {
      id: assertion.id,
      description: assertion.description,
      flow: this.context.flow,
      kind: assertion.check.kind,
      criticality: assertion.criticality,
      mandatory: assertion.mandatory,
      status: 'BLOCKED',
      ...(assertion.after !== undefined ? { after: assertion.after } : {}),
      entities: assertion.entities,
      expected: '',
      observed: '',
      reasons: [reason],
      evidence: [],
      attempts: 0,
      durationMs: 0,
      nextStep: 'fix the step or precondition that blocked it, then replay the flow',
    };
    this.results.set(assertion.id, result);
    return result;
  }

  private precondition(assertion: AssertionConfig): Attempt | undefined {
    const blocked = (reason: string): Attempt => ({
      status: 'BLOCKED',
      expected: '',
      observed: '',
      reasons: [reason],
      evidence: [],
      retry: false,
      nextStep: 'fix the step or precondition that blocked it, then replay the flow',
    });
    if (assertion.after !== undefined) {
      const status = this.context.stepStatus(assertion.after);
      if (status !== 'PASSED')
        return blocked(
          `step ${String(assertion.after)} is ${status ?? 'not executed'}: nothing to verify after it`,
        );
    }
    for (const required of assertion.requires) {
      const result = this.results.get(required);
      if (result?.status !== 'PASS')
        return blocked(`precondition ${required} is ${result?.status ?? 'not evaluated'}`);
    }
    return undefined;
  }

  private show(value: ResolvedValue): string {
    return this.context.showValues && value.displayable && value.text !== undefined
      ? `"${value.text}" (${value.label})`
      : value.label;
  }

  private shownText(text: string, displayable: boolean): string {
    return this.context.showValues && displayable ? `"${text.slice(0, 120)}"` : '(value not shown)';
  }

  private noNetwork(expected: string): Attempt {
    return {
      status: 'UNVERIFIABLE',
      expected,
      observed: 'the network of this flow was not observed in values',
      reasons: [
        'no network observation for this flow (declare the assertion on the flow, or enable functionalIntelligence)',
      ],
      evidence: [],
      retry: false,
      nextStep: 'check that the application calls are XHR/fetch on an allowed host',
    };
  }

  private resolve(ref: Parameters<typeof resolveValue>[0]): { value?: ResolvedValue; attempt?: Attempt } {
    const resolution = resolveValue(ref, this.sources());
    if (resolution.ok) return { value: resolution.value };
    return {
      attempt: {
        status: 'BLOCKED',
        expected:
          'value' in ref
            ? 'declared value'
            : 'testData' in ref
              ? `testData.${ref.testData}`
              : `extracted.${ref.extracted}`,
        observed: '',
        reasons: [resolution.reason],
        evidence: [],
        retry: false,
        nextStep: 'the step that produces this value must run first',
      },
    };
  }

  private async attempt(check: AssertionCheck): Promise<Attempt> {
    switch (check.kind) {
      case 'request':
        return this.request(check);
      case 'value':
        return this.value(check);
      case 'entity':
        return this.entity(check);
      case 'state':
        return this.state(check);
      case 'cardinality':
        return this.cardinality(check);
      case 'relation':
        return this.relation(check);
      case 'transition':
        return this.transition(check);
      case 'sideEffects':
        return this.sideEffects(check);
      case 'contract':
        return this.contract(check);
    }
  }

  private matching(method: string | undefined, path: string | undefined): ObservedExchange[] {
    return this.context.exchanges().filter((exchange) => exchangeMatches(exchange, method, path));
  }

  private label(exchange: ObservedExchange): string {
    return `${exchange.method} ${exchange.path}${exchange.status !== undefined ? ` → ${String(exchange.status)}` : ''}`;
  }

  private networkEvidence(exchange: ObservedExchange, details: Record<string, string | number | boolean>) {
    return {
      type: 'NETWORK' as const,
      source: this.label(exchange),
      timestamp: new Date(this.context.now()).toISOString(),
      confidence: 0.95,
      ...(exchange.step !== undefined ? { step: exchange.step } : {}),
      ...(exchange.observationId ? { correlationId: exchange.observationId } : {}),
      details: {
        method: exchange.method,
        path: exchange.path,
        ...(exchange.status !== undefined ? { status: exchange.status } : {}),
        ...details,
      },
    };
  }

  // REQUEST : la requête attendue a été observée avec le bon statut ; l'identifiant retourné est gardé.
  private request(check: Extract<AssertionCheck, { kind: 'request' }>): Attempt {
    const expected = `${check.method ?? 'any'} ${check.path} → ${String(check.status)}`;
    if (!this.context.networkObserved) return this.noNetwork(expected);
    const candidates = this.matching(check.method, check.path);
    if (candidates.length === 0)
      return {
        status: 'FAIL',
        source: 'NETWORK',
        expected,
        observed: 'no matching request observed',
        reasons: [
          `no ${check.method ?? ''} request on ${check.path} during the flow: the submission did not reach the server`,
        ],
        evidence: [],
        retry: true,
        nextStep: 'check the submit step and its network window (did the click send the form?)',
      };
    const answered = candidates.filter((exchange) => exchange.status !== undefined);
    const last = answered.at(-1);
    if (!last)
      return {
        status: 'INCONCLUSIVE',
        source: 'NETWORK',
        expected,
        observed: 'the request has no response yet',
        reasons: ['the matching request is still pending'],
        evidence: [],
        retry: true,
      };
    const status = last.status ?? 0;
    if (!statusMatches(status, check.status))
      return {
        status: 'FAIL',
        source: 'NETWORK',
        expected,
        observed: this.label(last),
        reasons: [
          `${this.label(last)} instead of ${String(check.status)}${last.errorCode ? ` (${last.errorCode})` : ''}`,
        ],
        evidence: [this.networkEvidence(last, { expectedStatus: String(check.status) })],
        retry: false,
        nextStep: 'read the server answer of this request in the network report',
      };
    const identifiers = (last.identifiers ?? []).filter((identifier) =>
      check.extract?.field ? fieldMatches(identifier.field, check.extract.field) : true,
    );
    // Un corps illisible n'est pas un corps sans identifiant : rien n'est affirmé.
    if (check.requireIdentifier && identifiers.length === 0 && last.responseUnread)
      return {
        status: 'INCONCLUSIVE',
        source: 'NETWORK',
        expected: `${expected}, with an identifier`,
        observed: `${this.label(last)}, response body unreadable`,
        reasons: ['the response body could not be read: whether it returned an identifier is not observed'],
        evidence: [this.networkEvidence(last, { identifiers: 0, bodyRead: false })],
        retry: false,
        nextStep: 'read the identifier through an authorized read API (kind value/entity, source api)',
      };
    if (check.requireIdentifier && identifiers.length === 0)
      return {
        status: 'FAIL',
        source: 'NETWORK',
        expected: `${expected}, with an identifier`,
        observed: `${this.label(last)} without identifier`,
        reasons: ['the write was accepted but returned no identifier of the created entity'],
        evidence: [this.networkEvidence(last, { identifiers: 0 })],
        retry: false,
      };
    const chosen = identifiers[0];
    if (check.extract && chosen)
      this.extracted.set(check.extract.name, {
        ...(chosen.value !== undefined ? { value: chosen.value } : {}),
        digest: chosen.digest,
      });
    return {
      status: 'PASS',
      source: 'NETWORK',
      expected,
      observed: `${this.label(last)}${chosen ? `, identifier ${chosen.field}${chosen.value !== undefined ? ` = ${chosen.value}` : ` ${shortDigest(chosen.digest)}`}` : ''}`,
      reasons: [
        `${this.label(last)} observed${check.extract && chosen ? `; extracted.${check.extract.name} kept for the next checks` : ''}`,
      ],
      evidence: [
        this.networkEvidence(last, {
          identifiers: identifiers.length,
          ...(chosen ? { identifierField: chosen.field, identifier: shortDigest(chosen.digest) } : {}),
        }),
      ],
      retry: false,
    };
  }

  // VALUE : la valeur envoyée, retournée, affichée ou relue est-elle la valeur attendue DU RUN ?
  private async value(check: Extract<AssertionCheck, { kind: 'value' }>): Promise<Attempt> {
    const resolved = this.resolve(check.expected);
    if (!resolved.value) return resolved.attempt as Attempt;
    const expectedValue = resolved.value;
    const expected = `${check.field ?? 'a field'} = ${this.show(expectedValue)} (${check.source})`;
    const normalized = check.match === 'normalized';
    if (check.source === 'ui') return this.uiContains(expectedValue, expected, normalized, 'present');
    if (check.source === 'api') {
      if (!check.api) return this.unverifiable(expected, 'no API read configured (api.url)');
      const read = await this.apiRead(check.api.url, check.api.select, expected);
      if ('attempt' in read) return read.attempt;
      const leaves = jsonRecords(read.body).flatMap((record) => jsonLeaves(record));
      const fields = leaves.filter(([path]) => fieldMatches(path, check.field));
      const match = fields.map(([, text]) => textMatch(text, expectedValue, normalized)).find(Boolean);
      if (match)
        return this.pass('API', expected, `the API returns ${check.field ?? 'the value'} (${match})`, [
          this.apiEvidence(read.url, { field: check.field ?? '(any)', match }),
        ]);
      return {
        status: 'FAIL',
        source: 'API',
        expected,
        observed:
          fields.length > 0
            ? `${check.field ?? 'the field'} has another value: ${this.shownText(fields[0]?.[1] ?? '', expectedValue.displayable)}`
            : `no ${check.field ?? 'matching'} field in the response`,
        reasons: [
          fields.length > 0
            ? 'the API returns a different value than the one submitted in this run'
            : 'the field is absent from the API response',
        ],
        evidence: [this.apiEvidence(read.url, { field: check.field ?? '(any)', match: 'differs' })],
        retry: true,
        nextStep: 'compare the submitted request and the stored entity (API read) in the network report',
      };
    }
    if (!this.context.networkObserved || expectedValue.digest === undefined) return this.noNetwork(expected);
    const candidates = this.matching(check.method, check.path);
    const digests = candidates.flatMap((exchange) =>
      (check.source === 'request'
        ? (exchange.requestCriteria ?? [])
        : [
            ...(exchange.responseValues ?? []),
            ...(exchange.records ?? []).flatMap((record) => [
              ...(record.attributes ?? []),
              ...record.identifiers,
            ]),
          ]
      ).map((digest) => ({ exchange, digest })),
    );
    const inField = digests.filter(({ digest }) => fieldMatches(digest.field, check.field));
    for (const { exchange, digest } of inField) {
      const match = digestMatch(digest, expectedValue, normalized);
      if (match)
        return this.pass(
          'NETWORK',
          expected,
          `${this.label(exchange)} ${check.source === 'request' ? 'sent' : 'returned'} ${digest.field} (${match})`,
          [this.networkEvidence(exchange, { field: digest.field, match, side: check.source })],
        );
    }
    if (candidates.length === 0)
      return {
        status: 'FAIL',
        source: 'NETWORK',
        expected,
        observed: 'no matching request observed',
        reasons: [`no request${check.path ? ` on ${check.path}` : ''} observed to carry the value`],
        evidence: [],
        retry: true,
      };
    const other = inField[0];
    const unread = check.source === 'response' && candidates.some((exchange) => exchange.responseUnread);
    return {
      status: other || check.source === 'request' ? 'FAIL' : 'INCONCLUSIVE',
      source: 'NETWORK',
      expected,
      observed: other
        ? `${other.digest.field} carries another value (${shortDigest(other.digest.digest)})`
        : `the ${check.source} does not carry ${check.field ?? 'the value'}`,
      reasons: [
        other
          ? `${this.label(other.exchange)}: ${other.digest.field} differs from ${expectedValue.label}`
          : check.source === 'request'
            ? 'the value of this run was not sent'
            : unread
              ? 'the response body could not be read: the stored value is not observed'
              : 'the response does not echo the field: the stored value cannot be confirmed from it',
      ],
      evidence: other
        ? [
            this.networkEvidence(other.exchange, {
              field: other.digest.field,
              match: 'differs',
              side: check.source,
            }),
          ]
        : [],
      retry: true,
      nextStep: other
        ? 'the server stored or returned a different value: compare request and response'
        : 'verify the stored value with an API read (source: api)',
    };
  }

  // ENTITY : présente (une, si unique) ou absente, retrouvée par une clé du run.
  private async entity(check: Extract<AssertionCheck, { kind: 'entity' }>): Promise<Attempt> {
    const resolved = this.resolve(check.by);
    if (!resolved.value) return resolved.attempt as Attempt;
    const key = resolved.value;
    const expected = `entity with ${check.field ?? 'a field'} = ${this.show(key)} ${check.expect}${check.unique ? ' (exactly one)' : ''}`;
    if (check.source === 'ui') {
      const attempt = await this.uiContains(key, expected, true, check.expect);
      if (attempt.status === 'PASS' && check.unique && attempt.observed.includes('times'))
        return {
          ...attempt,
          status: 'INCONCLUSIVE',
          reasons: [...attempt.reasons, 'the screen shows it several times: not a proof of uniqueness'],
        };
      return attempt;
    }
    let count: number;
    let evidence: Attempt['evidence'];
    let source: VerificationSource;
    if (check.source === 'api') {
      if (!check.api) return this.unverifiable(expected, 'no API read configured (api.url)');
      const read = await this.apiRead(check.api.url, check.api.select, expected);
      if ('attempt' in read) {
        // Une lecture d'une entité par son identifiant qui répond 404 : elle n'existe pas.
        if (check.expect === 'absent' && read.attempt.observed.includes('404'))
          return this.pass('API', expected, 'the API answers 404: the entity does not exist', []);
        return read.attempt;
      }
      count = jsonRecords(read.body).filter((record) =>
        jsonLeaves(record).some(
          ([path, text]) => fieldMatches(path, check.field) && textMatch(text, key, true),
        ),
      ).length;
      evidence = [this.apiEvidence(read.url, { field: check.field ?? '(any)', matches: count })];
      source = 'API';
    } else {
      if (!this.context.networkObserved || key.digest === undefined) return this.noNetwork(expected);
      const reads = this.matching(undefined, check.path).filter(
        (exchange) => exchange.records !== undefined || exchange.listSize !== undefined,
      );
      if (reads.length === 0)
        return {
          ...this.unverifiable(
            expected,
            'no read response (list, detail, search) observed after the creation',
          ),
          retry: true,
        };
      const last = reads.at(-1) as ObservedExchange;
      count = (last.records ?? []).filter((record) => recordHas(record, check.field, key)).length;
      evidence = [this.networkEvidence(last, { field: check.field ?? '(any)', matches: count })];
      source = 'NETWORK';
    }
    const ok = check.expect === 'absent' ? count === 0 : check.unique ? count === 1 : count >= 1;
    if (ok) return this.pass(source, expected, `${String(count)} matching record(s)`, evidence);
    return {
      status: 'FAIL',
      source,
      expected,
      observed: `${String(count)} matching record(s)`,
      reasons: [
        check.expect === 'absent'
          ? 'the entity is still observable'
          : count === 0
            ? 'no record carries the key of this run'
            : `${String(count)} records carry the key: not unique`,
      ],
      evidence,
      retry: true,
      nextStep:
        count > 1
          ? 'look for a duplicate creation (side effects, double submit)'
          : 'search for the entity by its identifier, then by its business key',
    };
  }

  // STATE : l'état métier attendu (avec les états « en attente » d'un traitement asynchrone).
  private async state(check: Extract<AssertionCheck, { kind: 'state' }>): Promise<Attempt> {
    const expected = `state ${check.expected} (${check.source})`;
    const judge = (
      observed: string | undefined,
      source: VerificationSource,
      evidence: Attempt['evidence'],
    ): Attempt => {
      if (observed === undefined)
        return {
          status: 'UNVERIFIABLE',
          source,
          expected,
          observed: 'no state observed',
          reasons: ['no business state in the observed data'],
          evidence,
          retry: true,
        };
      if (observed.toUpperCase() === check.expected.toUpperCase())
        return this.pass(source, expected, `state ${observed}`, evidence);
      const pending = check.pending.some((code) => code.toUpperCase() === observed.toUpperCase());
      return {
        status: pending ? 'INCONCLUSIVE' : 'FAIL',
        source,
        expected,
        observed: `state ${observed}`,
        reasons: [
          pending
            ? `still ${observed} (asynchronous processing not finished within the delay)`
            : `state ${observed} instead of ${check.expected}`,
        ],
        evidence,
        retry: true,
        nextStep: pending
          ? 'raise timeoutMs if the processing is slow, or check the background job'
          : 'check the transition that led to this state',
      };
    };
    let key: ResolvedValue | undefined;
    if (check.by) {
      const resolved = this.resolve(check.by);
      if (!resolved.value) return resolved.attempt as Attempt;
      key = resolved.value;
    }
    if (check.source === 'ui') {
      const text = await this.context.uiText?.();
      if (text === undefined) return this.unverifiable(expected, 'no page to read');
      const shown = foldValue(text).includes(foldValue(check.expected));
      return shown
        ? this.pass('DOM', expected, `"${check.expected}" is displayed`, [
            this.domEvidence({ state: check.expected }),
          ])
        : {
            status: 'FAIL',
            source: 'DOM',
            expected,
            observed: `"${check.expected}" is not displayed`,
            reasons: ['the screen does not show the expected state'],
            evidence: [this.domEvidence({ state: check.expected, shown: false })],
            retry: true,
          };
    }
    if (check.source === 'api') {
      if (!check.api) return this.unverifiable(expected, 'no API read configured (api.url)');
      const read = await this.apiRead(check.api.url, check.api.select, expected);
      if ('attempt' in read) return read.attempt;
      const records = jsonRecords(read.body).filter(
        (record) => !key || jsonLeaves(record).some(([, text]) => textMatch(text, key, true)),
      );
      if (key && records.length > 1)
        return {
          status: 'INCONCLUSIVE',
          source: 'API',
          expected,
          observed: `${String(records.length)} records match the key`,
          reasons: ['ambiguous entity: several records match'],
          evidence: [],
          retry: false,
        };
      const leaf = jsonLeaves(records[0]).find(([path]) =>
        check.field ? fieldMatches(path, check.field) : /(^|\.)(status|state|statut|etat)$/i.test(path),
      );
      return judge(leaf?.[1], 'API', [
        this.apiEvidence(read.url, { field: leaf?.[0] ?? check.field ?? 'status' }),
      ]);
    }
    if (!this.context.networkObserved) return this.noNetwork(expected);
    const candidates = this.matching(check.method, check.path);
    for (const exchange of [...candidates].reverse()) {
      if (exchange.responseState && (!check.field || fieldMatches(exchange.responseState.field, check.field)))
        return judge(exchange.responseState.code, 'NETWORK', [
          this.networkEvidence(exchange, { stateField: exchange.responseState.field }),
        ]);
      const record = (exchange.records ?? []).find(
        (entry) => entry.state && (!key || recordHas(entry, undefined, key)),
      );
      if (record?.state)
        return judge(record.state.code, 'NETWORK', [
          this.networkEvidence(exchange, { stateField: record.state.field }),
        ]);
    }
    return judge(undefined, 'NETWORK', []);
  }

  private async records(
    source: 'network' | 'api',
    path: string | undefined,
    api: { url: string; select?: string } | undefined,
    expected: string,
  ): Promise<
    | {
        records: {
          has(field: string | undefined, value: ResolvedValue): boolean;
          values(field: string): string[];
          digests(field: string): string[];
        }[];
        evidence: Attempt['evidence'];
        source: VerificationSource;
      }
    | { attempt: Attempt }
  > {
    if (source === 'api') {
      if (!api) return { attempt: this.unverifiable(expected, 'no API read configured (api.url)') };
      const read = await this.apiRead(api.url, api.select, expected);
      if ('attempt' in read) return read;
      return {
        records: jsonRecords(read.body).map((record) => {
          const leaves = jsonLeaves(record);
          return {
            has: (field, value) =>
              leaves.some(
                ([leaf, text]) => fieldMatches(leaf, field) && textMatch(text, value, true) !== undefined,
              ),
            values: (field) => leaves.filter(([leaf]) => fieldMatches(leaf, field)).map(([, text]) => text),
            digests: () => [],
          };
        }),
        evidence: [this.apiEvidence(read.url, {})],
        source: 'API',
      };
    }
    if (!this.context.networkObserved) return { attempt: this.noNetwork(expected) };
    const reads = this.matching(undefined, path).filter((exchange) => exchange.records !== undefined);
    const last = reads.at(-1);
    if (!last)
      return {
        attempt: { ...this.unverifiable(expected, 'no read response (list, detail) observed'), retry: true },
      };
    return {
      records: (last.records ?? []).map((record) => ({
        has: (field, value) => recordHas(record, field, value) !== undefined,
        values: () => [],
        digests: (field) =>
          [...(record.attributes ?? []), ...record.identifiers]
            .filter((digest) => fieldMatches(digest.field, field))
            .map((digest) => digest.digest),
      })),
      evidence: [this.networkEvidence(last, { records: last.records?.length ?? 0 })],
      source: 'NETWORK',
    };
  }

  // CARDINALITY : combien d'enregistrements portent la valeur.
  private async cardinality(check: Extract<AssertionCheck, { kind: 'cardinality' }>): Promise<Attempt> {
    const resolved = this.resolve(check.matching.value);
    if (!resolved.value) return resolved.attempt as Attempt;
    const value = resolved.value;
    const bounds = [
      check.equals !== undefined ? `= ${String(check.equals)}` : '',
      check.min !== undefined ? `≥ ${String(check.min)}` : '',
      check.max !== undefined ? `≤ ${String(check.max)}` : '',
    ]
      .filter(Boolean)
      .join(', ');
    const expected = `records with ${check.matching.field ?? 'a field'} = ${this.show(value)}: ${bounds}`;
    const found = await this.records(check.source, check.path, check.api, expected);
    if ('attempt' in found) return found.attempt;
    const count = found.records.filter((record) => record.has(check.matching.field, value)).length;
    const ok =
      (check.equals === undefined || count === check.equals) &&
      (check.min === undefined || count >= check.min) &&
      (check.max === undefined || count <= check.max);
    return ok
      ? this.pass(found.source, expected, `${String(count)} record(s)`, found.evidence)
      : {
          status: 'FAIL',
          source: found.source,
          expected,
          observed: `${String(count)} record(s)`,
          reasons: [`${String(count)} record(s), expected ${bounds}`],
          evidence: found.evidence,
          retry: true,
          nextStep: 'look for a duplicate or a missing creation',
        };
  }

  // RELATION : l'entité retrouvée porte la bonne référence (un client, un dossier parent…).
  private async relation(check: Extract<AssertionCheck, { kind: 'relation' }>): Promise<Attempt> {
    const entity = this.resolve(check.entity.value);
    if (!entity.value) return entity.attempt as Attempt;
    const target = this.resolve(check.expected);
    if (!target.value) return target.attempt as Attempt;
    const expected = `entity ${this.show(entity.value)} → ${check.field} = ${this.show(target.value)}`;
    const found = await this.records(check.source, check.path, check.api, expected);
    if ('attempt' in found) return found.attempt;
    const matching = found.records.filter((record) =>
      record.has(check.entity.field, entity.value as ResolvedValue),
    );
    if (matching.length === 0)
      return {
        status: 'INCONCLUSIVE',
        source: found.source,
        expected,
        observed: 'entity not observed',
        reasons: ['the entity is not in the observed data: the relation cannot be judged'],
        evidence: found.evidence,
        retry: true,
      };
    if (matching.length > 1)
      return {
        status: 'INCONCLUSIVE',
        source: found.source,
        expected,
        observed: `${String(matching.length)} entities match`,
        reasons: ['ambiguous entity: several records match its key'],
        evidence: found.evidence,
        retry: false,
      };
    const record = matching[0] as (typeof matching)[number];
    if (record.has(check.field, target.value))
      return this.pass(
        found.source,
        expected,
        `${check.field} points to the expected entity`,
        found.evidence,
      );
    const present =
      found.source === 'API' ? record.values(check.field).length > 0 : record.digests(check.field).length > 0;
    return present
      ? {
          status: 'FAIL',
          source: found.source,
          expected,
          observed: `${check.field} points to another entity`,
          reasons: [`wrong relation: ${check.field} does not reference ${target.value.label}`],
          evidence: found.evidence,
          retry: true,
          nextStep: 'check which entity was selected when the relation was set',
        }
      : {
          status: 'UNVERIFIABLE',
          source: found.source,
          expected,
          observed: `${check.field} is not in the observed data`,
          reasons: [`the observed record does not carry ${check.field}`],
          evidence: found.evidence,
          retry: true,
        };
  }

  // TRANSITION : de → vers observée sur le réseau ; permise (acceptée) ou interdite (refusée).
  private transition(check: Extract<AssertionCheck, { kind: 'transition' }>): Attempt {
    const expected = `${check.from} → ${check.to} ${check.expect}`;
    if (!this.context.networkObserved) return this.noNetwork(expected);
    let current: string | undefined;
    for (const exchange of this.matching(check.method, check.path)) {
      const requested = exchange.requestState?.code;
      if (
        requested &&
        current?.toUpperCase() === check.from.toUpperCase() &&
        requested.toUpperCase() === check.to.toUpperCase()
      ) {
        const accepted = isAccepted(exchange);
        const allowed = check.expect === 'allowed';
        const evidence = [this.networkEvidence(exchange, { from: check.from, to: check.to, accepted })];
        if (accepted === allowed)
          return this.pass(
            'NETWORK',
            expected,
            `${this.label(exchange)}: ${accepted ? 'accepted' : 'refused'}`,
            evidence,
          );
        return {
          status: 'FAIL',
          source: 'NETWORK',
          expected,
          observed: `${this.label(exchange)}: ${accepted ? 'accepted' : 'refused'}`,
          reasons: [allowed ? 'an allowed transition was refused' : 'a forbidden transition was accepted'],
          evidence,
          retry: false,
          nextStep: 'check the workflow rule on the server',
        };
      }
      const observed =
        exchange.responseState?.code ?? exchange.records?.find((record) => record.state)?.state?.code;
      if (observed && isAccepted(exchange)) current = observed;
    }
    return {
      status: 'INCONCLUSIVE',
      source: 'NETWORK',
      expected,
      observed: 'transition not exercised',
      reasons: [`no request moving ${check.from} to ${check.to} was observed`],
      evidence: [],
      retry: false,
      nextStep: 'add the step that requests this transition to the flow',
    };
  }

  // SIDE EFFECTS : aucune écriture acceptée hors de la liste ; pas plus de créations que prévu.
  private sideEffects(check: Extract<AssertionCheck, { kind: 'sideEffects' }>): Attempt {
    const expected = `writes limited to ${check.allowedWrites.map((write) => `${write.method ?? 'any'} ${write.path}`).join(', ') || '(none declared)'}${check.maxCreated !== undefined ? `, at most ${String(check.maxCreated)} creation(s)` : ''}`;
    if (!this.context.networkObserved) return this.noNetwork(expected);
    const writes = this.context
      .exchanges()
      .filter((exchange) => WRITE_METHODS.has(exchange.method.toUpperCase()) && isAccepted(exchange));
    const unexpected = writes.filter(
      (exchange) =>
        check.allowedWrites.length > 0 &&
        !check.allowedWrites.some((allowed) => exchangeMatches(exchange, allowed.method, allowed.path)),
    );
    const created = writes.filter(
      (exchange) =>
        exchange.method.toUpperCase() === 'POST' &&
        (exchange.status === 201 || (exchange.identifiers?.length ?? 0) > 0),
    );
    const reasons: string[] = [];
    if (unexpected.length > 0)
      reasons.push(`unexpected write(s): ${unexpected.map((exchange) => this.label(exchange)).join(', ')}`);
    if (check.maxCreated !== undefined && created.length > check.maxCreated)
      reasons.push(`${String(created.length)} creation(s) for at most ${String(check.maxCreated)}`);
    const evidence = [...unexpected, ...created]
      .slice(0, 6)
      .map((exchange) => this.networkEvidence(exchange, { write: true }));
    if (reasons.length > 0)
      return {
        status: 'FAIL',
        source: 'NETWORK',
        expected,
        observed: `${String(writes.length)} accepted write(s)`,
        reasons,
        evidence,
        retry: false,
        nextStep: 'find the step that sent the extra write (double click, retry, hidden call)',
      };
    return {
      ...this.pass(
        'NETWORK',
        expected,
        `${String(writes.length)} accepted write(s), ${String(created.length)} creation(s)`,
        evidence,
      ),
      reasons: ['only the browser traffic of this flow is observed: server-side effects stay unknown'],
    };
  }

  // CONTRACT : la réponse observée est déclarée par le contrat OpenAPI, avec ses champs obligatoires.
  private contract(check: Extract<AssertionCheck, { kind: 'contract' }>): Attempt {
    const expected = `${check.method ?? 'any'} ${check.path} follows the OpenAPI contract`;
    if (!this.context.contract)
      return this.unverifiable(expected, 'no OpenAPI contract in the mission (openapi.source)');
    if (!this.context.networkObserved) return this.noNetwork(expected);
    const answered = this.matching(check.method, check.path).filter(
      (exchange) => exchange.status !== undefined,
    );
    if (answered.length === 0)
      return {
        status: 'INCONCLUSIVE',
        source: 'OPENAPI',
        expected,
        observed: 'no matching response observed',
        reasons: ['the operation was not called during the flow'],
        evidence: [],
        retry: false,
      };
    for (const exchange of answered) {
      const operation = this.context.contract.find(
        (candidate) =>
          candidate.method.toUpperCase() === exchange.method.toUpperCase() &&
          candidate.matcher.test(exchange.path),
      );
      const evidence = [
        {
          ...this.networkEvidence(exchange, { operation: operation?.path ?? '(undocumented)' }),
          type: 'OPENAPI' as const,
          confidence: 0.6,
        },
      ];
      if (!operation)
        return {
          status: 'FAIL',
          source: 'OPENAPI',
          expected,
          observed: `${this.label(exchange)}: undocumented endpoint`,
          reasons: ['the contract does not declare this operation'],
          evidence,
          retry: false,
        };
      if (!declares(operation.responses, exchange.status ?? 0))
        return {
          status: 'FAIL',
          source: 'OPENAPI',
          expected,
          observed: `${this.label(exchange)}: status not declared`,
          reasons: [`the contract declares ${operation.responses.join(', ')}`],
          evidence,
          retry: false,
        };
      const schema = operation.responseSchemas?.[String(exchange.status)];
      const missing =
        schema && exchange.responseFields
          ? schema.required.filter((field) => !(field in (exchange.responseFields ?? {})))
          : [];
      if (missing.length > 0)
        return {
          status: 'FAIL',
          source: 'OPENAPI',
          expected,
          observed: `required field(s) missing: ${missing.join(', ')}`,
          reasons: ['the response lacks fields the contract requires'],
          evidence,
          retry: false,
        };
    }
    const last = answered.at(-1) as ObservedExchange;
    return this.pass('OPENAPI', expected, `${String(answered.length)} response(s) declared by the contract`, [
      { ...this.networkEvidence(last, {}), type: 'OPENAPI' as const, confidence: 0.6 },
    ]);
  }

  private pass(
    source: VerificationSource,
    expected: string,
    observed: string,
    evidence: Attempt['evidence'],
  ): Attempt {
    return { status: 'PASS', source, expected, observed, reasons: [observed], evidence, retry: false };
  }

  private unverifiable(expected: string, reason: string): Attempt {
    return {
      status: 'UNVERIFIABLE',
      expected,
      observed: reason,
      reasons: [reason],
      evidence: [],
      retry: false,
      nextStep: 'give the assertion a source that is available in this environment',
    };
  }

  private domEvidence(details: Record<string, string | number | boolean>) {
    return {
      type: 'DOM' as const,
      source: 'screen at verification',
      timestamp: new Date(this.context.now()).toISOString(),
      confidence: 0.9,
      details,
    };
  }

  private apiEvidence(url: string, details: Record<string, string | number | boolean>) {
    // Le chemin seulement : jamais la requête (?q=…), qui peut porter une valeur du run.
    let shown: string;
    try {
      shown = `GET ${new URL(url, 'http://read.invalid').pathname}`;
    } catch {
      shown = 'GET (read API)';
    }
    return {
      type: 'NETWORK' as const,
      sourceType: 'API' as const,
      source: `${shown} (read-only verification)`,
      timestamp: new Date(this.context.now()).toISOString(),
      confidence: 0.95,
      details: { readOnly: true, ...details },
    };
  }

  /** L'écran montre-t-il la valeur (présente) ou pas (absente) ? Relu jusqu'au délai. */
  private async uiContains(
    value: ResolvedValue,
    expected: string,
    normalized: boolean,
    expect: 'present' | 'absent',
  ): Promise<Attempt> {
    const text = await this.context.uiText?.();
    if (text === undefined) return this.unverifiable(expected, 'no page to read');
    if (value.text === undefined)
      return this.unverifiable(expected, `${value.label} has no displayable value to look for`);
    const haystack = normalized ? foldValue(text) : text;
    const needle = normalized ? foldValue(value.text) : value.text.trim();
    const count = needle === '' ? 0 : haystack.split(needle).length - 1;
    const present = count > 0;
    const evidence = [
      this.domEvidence({
        value: value.label,
        occurrences: count,
        match: normalized ? 'normalized' : 'exact',
      }),
    ];
    if (present === (expect === 'present'))
      return this.pass(
        'DOM',
        expected,
        present ? `displayed${count > 1 ? ` ${String(count)} times` : ''}` : 'not displayed',
        evidence,
      );
    return {
      status: 'FAIL',
      source: 'DOM',
      expected,
      observed: present ? 'still displayed' : 'not displayed',
      reasons: [present ? `${value.label} is still on the screen` : `${value.label} is not on the screen`],
      evidence,
      retry: true,
      nextStep: present
        ? 'check that the screen was refreshed after the change'
        : 'open the entity and compare the displayed values',
    };
  }

  /** Une lecture d'API (GET, hôte permis) ; les erreurs deviennent des conclusions honnêtes. */
  private async apiRead(
    template: string,
    select: string | undefined,
    expected: string,
  ): Promise<{ body: unknown; url: string } | { attempt: Attempt }> {
    if (!this.context.apiGet)
      return { attempt: this.unverifiable(expected, 'API reads are not available in this run') };
    const interpolated = interpolateUrl(template, this.sources());
    if (!interpolated.url)
      return {
        attempt: {
          status: 'BLOCKED',
          expected,
          observed: '',
          reasons: [`${interpolated.missing ?? 'a value'} has no displayable value to build the read URL`],
          evidence: [],
          retry: false,
        },
      };
    const read = await this.context.apiGet(interpolated.url);
    if ('error' in read)
      return {
        attempt: {
          status: read.unauthorized ? 'UNVERIFIABLE' : 'INCONCLUSIVE',
          source: 'API',
          expected,
          observed: read.error,
          reasons: [read.error],
          evidence: [],
          retry: !read.unauthorized,
        },
      };
    if (read.status === 401 || read.status === 403)
      return {
        attempt: {
          status: 'UNVERIFIABLE',
          source: 'API',
          expected,
          observed: `GET answered ${String(read.status)}`,
          reasons: ['the read API refuses this session: no access to verify'],
          evidence: [this.apiEvidence(interpolated.url, { status: read.status })],
          retry: false,
        },
      };
    if (read.status === 404)
      return {
        attempt: {
          status: 'FAIL',
          source: 'API',
          expected,
          observed: 'GET answered 404',
          reasons: ['the entity is not found by the read API'],
          evidence: [this.apiEvidence(interpolated.url, { status: 404 })],
          retry: true,
          nextStep: 'check the identifier used by the read URL',
        },
      };
    if (read.status >= 400)
      return {
        attempt: {
          status: 'INCONCLUSIVE',
          source: 'API',
          expected,
          observed: `GET answered ${String(read.status)}`,
          reasons: ['the read API failed: no conclusion'],
          evidence: [this.apiEvidence(interpolated.url, { status: read.status })],
          retry: true,
        },
      };
    return { body: selectJson(read.body, select), url: interpolated.url };
  }
}

/** Une correspondance pour le rapport. */
export function describeMatch(match: DigestMatch | undefined): string {
  return match === 'normalized'
    ? 'normalized (case, accents, spaces)'
    : match === 'exact'
      ? 'exact'
      : 'differs';
}
