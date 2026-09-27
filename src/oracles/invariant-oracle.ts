import type { AuthorizationReport } from '../actors/authorization-observer.js';
import type { InvariantConfig } from '../config/config.js';
import type { PageContext } from '../model/page-context.js';
import type { Severity } from '../model/issue.js';
import type { NetworkExchange } from '../model/network.js';
import type { DetectedPattern } from '../patterns/ui-pattern.js';
import { normalizeText } from '../policies/keywords.js';
import { pathPatternToRegex } from '../policies/navigation-policy.js';
import {
  result,
  type ActionObservations,
  type ExecutedAction,
  type OracleReason,
  type OracleResult,
  type TestOracle,
} from './oracle.js';

/** Une règle explicite jugée sur une action (ou sur l'accès d'un acteur), expliquée. */
export interface InvariantEvaluation {
  invariantId: string;
  description?: string;
  severity: Severity;
  status: 'PASS' | 'FAIL';
  /** Ce que la règle attend (« access denied », « status < 500 »). */
  expected: string;
  /** Ce qui a été observé (« page accessible », « POST /api/users → 500 »). */
  observed: string;
  stateId?: string;
  actionId?: string;
  actor?: string;
  url?: string;
}

type Access = 'allowed' | 'denied' | 'forbidden' | 'login';

/**
 * Juge chaque action avec les invariants de la mission et des packs de domaine :
 * « aucune réponse ≥ 500 », « Créer utilisateur ouvre un CREATE_FORM », « l'acteur user
 * n'accède pas à /admin/** »… Chaque verdict dit la règle, l'attendu et l'observé.
 *
 * La sévérité de la règle décide de l'effet : CRITICAL/ERROR → FAIL, WARNING →
 * WARNING, INFO → noté seulement (le statut reste PASS). Une règle qui ne s'applique
 * pas à l'action n'est pas comptée. Les règles avec `actor` sont jugées sur les
 * observations d'accès multi-acteurs (evaluateAccess), et sur les actions de
 * l'acteur principal.
 */
export class InvariantOracle implements TestOracle {
  readonly name = 'invariant';
  private readonly all: InvariantEvaluation[] = [];

  constructor(
    private readonly invariants: readonly InvariantConfig[],
    private readonly primaryActor = 'primary',
  ) {}

  /** Chaque évaluation faite pendant le run, pour le rapport. */
  evaluations(): InvariantEvaluation[] {
    return [...this.all];
  }

  evaluate(
    before: PageContext,
    action: ExecutedAction,
    after: PageContext | undefined,
    observations: ActionObservations,
  ): Promise<OracleResult> {
    const judged: InvariantEvaluation[] = [];
    for (const invariant of this.invariants) {
      const actor = observations.actor ?? this.primaryActor;
      if (invariant.when.actor && invariant.when.actor !== actor) continue;
      const requests = this.requestsFor(invariant, observations.network);
      if (!this.applies(invariant, before, action, after, observations, requests)) continue;
      judged.push(...this.check(invariant, before, action, after, observations, requests));
    }
    for (const entry of judged) this.all.push(entry);
    if (judged.length === 0) return Promise.resolve(result(this.name, 'UNKNOWN', 0, []));
    const failed = judged.filter((entry) => entry.status === 'FAIL');
    const worst = failed.some((entry) => entry.severity === 'ERROR' || entry.severity === 'CRITICAL')
      ? 'FAIL'
      : failed.some((entry) => entry.severity === 'WARNING')
        ? 'WARNING'
        : 'PASS';
    const reasons: OracleReason[] = judged.map((entry) => ({
      code: entry.status === 'FAIL' ? `invariant-${entry.severity.toLowerCase()}` : 'invariant-pass',
      message:
        entry.status === 'FAIL'
          ? `invariant ${entry.invariantId}: expected ${entry.expected}, observed ${entry.observed}`
          : `invariant ${entry.invariantId}: ${entry.expected}`,
    }));
    return Promise.resolve({
      ...result(this.name, worst, 0.95, reasons),
      confidenceSource: 'explicit-invariant',
    });
  }

  /**
   * Règles d'accès (`when.actor` + `expect.access`) jugées sur les écrans ouverts par
   * chaque acteur (AuthorizationObserver) : « ADMIN-ACCESS : attendu access denied,
   * observé page accessible ».
   */
  evaluateAccess(report: AuthorizationReport | undefined): InvariantEvaluation[] {
    if (!report) return [];
    const judged: InvariantEvaluation[] = [];
    for (const invariant of this.invariants) {
      const { actor, path } = invariant.when;
      const expected = invariant.expect.access;
      if (!actor || !expected || actor === report.primaryActor) continue;
      const matcher = path ? pathPatternToRegex(path) : undefined;
      for (const observation of report.observations) {
        if (observation.actor !== actor) continue;
        if (matcher && !matcher.test(pathOf(observation.url))) continue;
        const access: Access =
          observation.access === 'ALLOWED' ? 'allowed' : observation.status === 403 ? 'forbidden' : 'denied';
        judged.push({
          invariantId: invariant.id,
          ...(invariant.description ? { description: invariant.description } : {}),
          severity: invariant.severity,
          status: accessMatches(access, expected) ? 'PASS' : 'FAIL',
          expected: `access ${expected.join(' or ')}`,
          observed:
            access === 'allowed'
              ? 'page accessible'
              : `access ${access}${observation.status ? ` (HTTP ${observation.status})` : ''}`,
          actor,
          url: observation.url,
          stateId: observation.stateId,
        });
      }
    }
    for (const entry of judged) this.all.push(entry);
    return judged;
  }

  private requestsFor(invariant: InvariantConfig, network: readonly NetworkExchange[]): NetworkExchange[] {
    const api = network.filter(
      (exchange) => exchange.resourceType !== 'document' || exchange.status !== undefined,
    );
    if (!invariant.when.request) return api;
    const [method, pattern] = splitRequest(invariant.when.request);
    const matcher = pathPatternToRegex(pattern);
    return api.filter(
      (exchange) =>
        (method === '*' || exchange.method.toUpperCase() === method) && matcher.test(pathOf(exchange.url)),
    );
  }

  private applies(
    invariant: InvariantConfig,
    before: PageContext,
    action: ExecutedAction,
    after: PageContext | undefined,
    observations: ActionObservations,
    requests: readonly NetworkExchange[],
  ): boolean {
    const { when } = invariant;
    if ((when.anyRequest || when.request) && requests.length === 0) return false;
    if (when.actionMatches) {
      const label = normalizeText(action.text ?? '');
      if (!when.actionMatches.some((text) => label.includes(normalizeText(text)))) return false;
    }
    if (when.pattern && !has(observations.beforePatterns, when.pattern)) return false;
    if (when.path) {
      const matcher = pathPatternToRegex(when.path);
      if (!matcher.test(pathOf(before.url)) && !(after && matcher.test(pathOf(after.url)))) return false;
    }
    return true;
  }

  private check(
    invariant: InvariantConfig,
    before: PageContext,
    action: ExecutedAction,
    after: PageContext | undefined,
    observations: ActionObservations,
    requests: readonly NetworkExchange[],
  ): InvariantEvaluation[] {
    const { expect } = invariant;
    const base = {
      invariantId: invariant.id,
      ...(invariant.description ? { description: invariant.description } : {}),
      severity: invariant.severity,
      stateId: before.stateId,
      actionId: action.id,
    };
    const out: InvariantEvaluation[] = [];
    const judge = (ok: boolean, expected: string, observed: string): void => {
      out.push({ ...base, status: ok ? 'PASS' : 'FAIL', expected, observed });
    };
    if (expect.statusBelow !== undefined) {
      const bad = requests.filter((exchange) => (exchange.status ?? 0) >= (expect.statusBelow ?? 0));
      judge(
        bad.length === 0,
        `status < ${expect.statusBelow}`,
        bad.length === 0
          ? `${requests.length} request(s) below ${expect.statusBelow}`
          : bad
              .map((exchange) => `${exchange.method} ${pathOf(exchange.url)} → ${exchange.status ?? '?'}`)
              .join(', '),
      );
    }
    if (expect.resultingPattern) {
      const shown = (observations.afterPatterns ?? []).map((pattern) => pattern.type);
      judge(
        expect.resultingPattern.some((pattern) => shown.includes(pattern)),
        `resulting screen ${expect.resultingPattern.join(' or ')}`,
        shown.length > 0 ? shown.join(', ') : after ? 'no recognised pattern' : 'no resulting screen',
      );
    }
    const text = after ? normalizeText([after.title, ...after.headings, after.text ?? ''].join(' ')) : '';
    for (const wanted of expect.textPresent ?? [])
      judge(
        text.includes(normalizeText(wanted)),
        `text "${wanted}" shown`,
        text ? 'text not shown' : 'no resulting screen',
      );
    for (const unwanted of expect.textAbsent ?? [])
      judge(!text.includes(normalizeText(unwanted)), `text "${unwanted}" absent`, `"${unwanted}" shown`);
    if (expect.maxDurationMs !== undefined && action.durationMs !== undefined)
      judge(
        action.durationMs <= expect.maxDurationMs,
        `≤ ${expect.maxDurationMs} ms`,
        `${Math.round(action.durationMs)} ms`,
      );
    if (expect.access && after) {
      const access = accessOf(after, observations);
      judge(
        accessMatches(access, expect.access),
        `access ${expect.access.join(' or ')}`,
        access === 'allowed' ? 'page accessible' : `access ${access}`,
      );
    }
    return out;
  }
}

function accessMatches(access: Access, expected: readonly string[]): boolean {
  if (expected.includes(access)) return true;
  // « denied » couvre forbidden et la page de connexion.
  return access !== 'allowed' && expected.includes('denied');
}

function accessOf(after: PageContext, observations: ActionObservations): Access {
  const document = observations.network.find((exchange) => exchange.resourceType === 'document');
  if (document?.status === 403) return 'forbidden';
  if (document?.status === 401 || has(observations.afterPatterns, 'LOGIN')) return 'login';
  if (
    has(observations.afterPatterns, 'ERROR_PAGE') &&
    /\b(401|403|forbidden|interdit|denied|refus)/i.test(after.headings.join(' '))
  )
    return 'denied';
  return 'allowed';
}

function has(patterns: readonly DetectedPattern[] | undefined, type: string): boolean {
  return (patterns ?? []).some((pattern) => pattern.type === type);
}

/** « POST /api/users » → [POST, /api/users] ; « /api/** » → [*, /api/**]. */
function splitRequest(text: string): [string, string] {
  const [first, ...rest] = text.trim().split(/\s+/);
  if (rest.length === 0) return ['*', first ?? '/'];
  return [(first ?? '*').toUpperCase(), rest.join(' ')];
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}
