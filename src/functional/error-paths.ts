import type { ApiContract } from '../oracles/api-contract.js';
import type { StaticFunctionalFacts } from '../static-analysis/model.js';
import {
  apiMatches,
  runtimeEvidence,
  staticEvidence,
  type ErrorClass,
  type ErrorPath,
  type FunctionalActionObservation,
  type FunctionalWorkflow,
} from './model.js';

/** Classe d'erreur d'un statut HTTP — une hypothèse : le vrai contrat se lit au runtime. */
export function errorClassOf(status: number | undefined, code?: string): ErrorClass {
  if (status === undefined) return 'OTHER';
  if (status === 400) return 'VALIDATION';
  if (status === 401) return 'AUTHENTICATION';
  if (status === 403) return 'AUTHORIZATION';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 422) return code ? 'BUSINESS_VALIDATION' : 'VALIDATION';
  if (status >= 500) return 'TECHNICAL';
  return 'OTHER';
}

/**
 * ERROR PATH ANALYZER : la chaîne complète d'une erreur — ACTION → ERREUR D'API →
 * code métier → traitement du code → MESSAGE affiché → CHAMP en erreur. Le code dit ce
 * qu'il prévoit (`if (e.status === 409 && e.error?.code === 'EMAIL_ALREADY_EXISTS')
 * email.setErrors`), le contrat ce qu'il déclare (409), le runtime ce qui arrive vraiment.
 */
export class ErrorPathAnalyzer {
  private readonly paths = new Map<string, ErrorPath>();

  build(
    facts: StaticFunctionalFacts | undefined,
    workflows: readonly FunctionalWorkflow[],
    contract?: ApiContract,
  ): ErrorPath[] {
    const operationOf = (api: string | undefined): string => {
      if (!api) return 'unknown';
      return workflows.find((workflow) => workflow.api === api)?.id ?? api;
    };
    for (const handler of facts?.errorHandlers ?? []) {
      const operation = operationOf(handler.apiRoute);
      const uiResult =
        handler.control && handler.message
          ? 'FIELD_ERROR_AND_MESSAGE'
          : handler.control
            ? 'FIELD_ERROR'
            : handler.message
              ? 'MESSAGE'
              : 'UNKNOWN';
      this.add({
        id: `${operation}:${handler.status !== undefined ? String(handler.status) : 'ANY'}:${handler.code ?? '-'}`,
        operation,
        ...(handler.status !== undefined ? { httpStatus: handler.status } : {}),
        errorClass: errorClassOf(handler.status, handler.code),
        ...(handler.code ? { businessCode: handler.code } : {}),
        ...(handler.control ? { uiTarget: handler.control } : {}),
        ...(handler.message ? { uiMessage: handler.message } : {}),
        uiResult,
        evidence: [
          staticEvidence(
            `${handler.owner}.${handler.method} handles ${handler.status !== undefined ? String(handler.status) : 'errors'}${handler.code ? ` ${handler.code}` : ''}`,
            handler.location,
            0.8,
          ),
        ],
        status: 'STATIC_DISCOVERED',
      });
    }
    // Contrat : les réponses d'erreur déclarées des opérations d'écriture (sans chaîne d'interface connue).
    for (const operation of contract?.operations ?? []) {
      if (operation.method === 'GET') continue;
      const api = `${operation.method} ${operation.path}`;
      const realized = workflows.filter(
        (entry) =>
          entry.api !== undefined &&
          apiMatches(entry.api, operation.method, operation.path.replace(/\{[^}]+\}/g, 'x')),
      );
      // Plusieurs workflows sur la même opération (submit, approve…) : l'erreur appartient à l'opération.
      const workflow = realized.length === 1 ? realized[0] : undefined;
      for (const declared of operation.responses) {
        const status = Number(declared);
        if (!Number.isInteger(status) || status < 400) continue;
        const name = workflow?.id ?? api;
        if ([...this.paths.values()].some((path) => path.operation === name && path.httpStatus === status))
          continue;
        this.add({
          id: `${name}:${String(status)}:-`,
          operation: name,
          httpStatus: status,
          errorClass: errorClassOf(status),
          uiResult: 'UNKNOWN',
          evidence: [
            {
              source: 'OPENAPI',
              kind: 'error-response',
              value: `${api} → ${String(status)}`,
              confidence: 0.8,
              provenance: { detail: api },
            },
          ],
          status: 'STATIC_DISCOVERED',
        });
      }
    }
    return this.all();
  }

  private add(path: ErrorPath): void {
    const known = this.paths.get(path.id);
    if (known) {
      // Le même traitement lu en plusieurs faits (setErrors puis message) : une seule chaîne.
      known.uiTarget ??= path.uiTarget;
      known.uiMessage ??= path.uiMessage;
      known.uiResult = uiResultOf(known.uiTarget, known.uiMessage, known.uiResult);
      return;
    }
    if (this.paths.size < 200) this.paths.set(path.id, path);
  }

  all(): ErrorPath[] {
    return [...this.paths.values()];
  }

  /**
   * Une écriture refusée (4xx / 5xx) : le chemin d'erreur observé — statut, code métier
   * de la réponse, champ marqué en erreur, message affiché — rapproché du chemin prévu.
   */
  observe(observation: FunctionalActionObservation, workflows: readonly FunctionalWorkflow[]): ErrorPath[] {
    const seen: ErrorPath[] = [];
    for (const exchange of observation.exchanges) {
      if (exchange.status === undefined || exchange.status < 400 || exchange.method === 'GET') continue;
      const realized = workflows.filter(
        (entry) => entry.api !== undefined && apiMatches(entry.api, exchange.method, exchange.path),
      );
      const workflow =
        realized.length === 1
          ? realized[0]
          : realized.find(
              (entry) => entry.triggerLabel !== undefined && entry.triggerLabel === observation.label,
            );
      const operation = workflow?.id ?? `${exchange.method} ${exchange.path}`;
      const before = new Set(observation.before?.invalidFields ?? []);
      const invalid = (observation.after?.invalidFields ?? []).filter((field) => !before.has(field));
      const message = observation.after?.alerts[0]?.slice(0, 120);
      const expected = this.all().find(
        (path) =>
          path.operation === operation &&
          path.httpStatus === exchange.status &&
          (path.businessCode === undefined || path.businessCode === exchange.errorCode),
      );
      const fieldMatches = expected?.uiTarget ? invalid.includes(expected.uiTarget) : undefined;
      const messageMatches =
        expected?.uiMessage && message ? message.includes(expected.uiMessage) : undefined;
      const detail = `${exchange.method} ${exchange.path} → ${String(exchange.status)}${exchange.errorCode ? ` ${exchange.errorCode}` : ''}${invalid.length > 0 ? `; field(s) in error: ${invalid.join(', ')}` : ''}${message ? `; message shown` : ''}`;
      if (expected) {
        expected.status =
          fieldMatches !== false && messageMatches !== false && (fieldMatches || messageMatches)
            ? 'RUNTIME_CONFIRMED'
            : 'RUNTIME_OBSERVED';
        expected.evidence.push(runtimeEvidence(detail));
        seen.push(expected);
        continue;
      }
      const path: ErrorPath = {
        id: `${operation}:${String(exchange.status)}:${exchange.errorCode ?? '-'}`,
        operation,
        httpStatus: exchange.status,
        errorClass: errorClassOf(exchange.status, exchange.errorCode),
        ...(exchange.errorCode ? { businessCode: exchange.errorCode } : {}),
        ...(invalid[0] ? { uiTarget: invalid[0] } : {}),
        ...(message ? { uiMessage: message } : {}),
        uiResult:
          invalid.length > 0 && message
            ? 'FIELD_ERROR_AND_MESSAGE'
            : invalid.length > 0
              ? 'FIELD_ERROR'
              : message
                ? 'MESSAGE'
                : 'NONE',
        evidence: [runtimeEvidence(detail)],
        status: 'RUNTIME_OBSERVED',
      };
      const known = this.paths.get(path.id);
      if (known) {
        known.evidence.push(runtimeEvidence(detail));
        seen.push(known);
      } else {
        this.add(path);
        seen.push(path);
      }
    }
    return seen;
  }
}

function uiResultOf(
  target: string | undefined,
  message: string | undefined,
  fallback: ErrorPath['uiResult'],
): ErrorPath['uiResult'] {
  if (target && message) return 'FIELD_ERROR_AND_MESSAGE';
  if (target) return 'FIELD_ERROR';
  if (message) return 'MESSAGE';
  return fallback;
}
