import { valueDigest } from '../forms/state/value-digest.js';
import {
  declares,
  type ApiContract,
  type ContractFieldSchema,
  type ContractOperation,
} from '../oracles/api-contract.js';
import {
  runtimeEvidence,
  type ContractObservation,
  type FieldShape,
  type FunctionalActionObservation,
  type FunctionalExchange,
} from './model.js';

/** Type OpenAPI ↔ forme JSON vue. */
function compatible(schema: ContractFieldSchema, shape: FieldShape): boolean {
  if (!schema.type || shape.type === 'null') return true;
  if (schema.type === 'integer' || schema.type === 'number') return shape.type === 'number';
  return schema.type === shape.type;
}

/**
 * RUNTIME CONTRACT CORRELATION : le contrat OpenAPI EXISTANT (ApiContract) comparé à ce
 * que l'interface envoie vraiment et à ce que l'API répond — clés et types des corps,
 * jamais les valeurs (une valeur énumérée se compare par empreinte salée).
 *
 * Un écart est un CONTRACT_MISMATCH, jamais un APPLICATION_BUG : le contrat peut être
 * obsolète, l'interface peut avoir raison.
 */
export class RuntimeContractCorrelator {
  private readonly observations = new Map<string, ContractObservation>();

  constructor(
    private readonly contract: ApiContract | undefined,
    private readonly salt: string,
  ) {}

  all(): ContractObservation[] {
    return [...this.observations.values()];
  }

  private operationOf(exchange: FunctionalExchange): ContractOperation | undefined {
    return this.contract?.operations.find(
      (operation) => operation.method === exchange.method && operation.matcher.test(exchange.path),
    );
  }

  /** Les écarts d'une action (nouveaux ou déjà vus), dédupliqués par opération, champ et genre. */
  observe(observation: FunctionalActionObservation): ContractObservation[] {
    const found: ContractObservation[] = [];
    const formFields = new Set(observation.before?.fields ?? []);
    for (const exchange of observation.exchanges) {
      const operation = this.operationOf(exchange);
      if (!operation) continue;
      const name = `${operation.method} ${operation.path}`;
      const add = (kind: ContractObservation['kind'], detail: string, field?: string): void => {
        const id = `${kind}:${name}:${field ?? ''}`;
        const known = this.observations.get(id);
        if (known) {
          found.push(known);
          return;
        }
        const entry: ContractObservation = {
          kind,
          category: 'CONTRACT_MISMATCH',
          operation: name,
          ...(field ? { field } : {}),
          detail,
          evidence: [runtimeEvidence(`${exchange.method} ${exchange.path}: ${detail}`, 0.8)],
        };
        if (this.observations.size < 200) this.observations.set(id, entry);
        found.push(entry);
      };
      const sent = exchange.requestFields;
      if (sent && Object.keys(operation.requestFields).length > 0) {
        for (const [field, schema] of Object.entries(operation.requestFields)) {
          const shape = sent[field];
          if (!shape) {
            // Le champ est à l'écran mais n'est pas parti : l'interface l'a oublié (ou ne l'envoie pas exprès).
            if (formFields.has(field))
              add('FIELD_NOT_SENT', `${field} is on the form but not in the request body`, field);
            else if (schema.required)
              add('REQUIRED_FIELD_MISSING', `${field} is required by the contract but was not sent`, field);
            continue;
          }
          if (shape.type === 'null' && !schema.nullable)
            add('NULLABILITY_MISMATCH', `${field} sent as null, the contract does not allow null`, field);
          else if (!compatible(schema, shape))
            add(
              'TYPE_MISMATCH',
              `${field} sent as ${shape.type}, the contract says ${schema.type ?? '?'}`,
              field,
            );
          else if (
            schema.enum &&
            shape.digest &&
            !schema.enum.some((member) => valueDigest(member, this.salt) === shape.digest)
          )
            add('ENUM_MISMATCH', `${field} sent with a value outside {${schema.enum.join(', ')}}`, field);
        }
        for (const field of Object.keys(sent))
          if (!(field in operation.requestFields))
            add('UNEXPECTED_FIELD', `${field} sent but not described by the contract`, field);
      }
      if (exchange.status !== undefined && !declares(operation.responses, exchange.status))
        add(
          'UNEXPECTED_STATUS_CODE',
          `answered ${String(exchange.status)}, declared ${operation.responses.join(', ')}`,
        );
      const schema =
        exchange.status !== undefined ? operation.responseSchemas?.[String(exchange.status)] : undefined;
      if (schema && exchange.responseFields) {
        const missing = schema.required.filter((field) => !(field in (exchange.responseFields ?? {})));
        const wrong = Object.entries(schema.fields).filter(([field, declared]) => {
          const shape = exchange.responseFields?.[field];
          return shape !== undefined && !compatible(declared, shape);
        });
        if (missing.length > 0 || wrong.length > 0)
          add(
            'RESPONSE_SCHEMA_MISMATCH',
            [
              missing.length > 0 ? `missing ${missing.join(', ')}` : '',
              wrong.length > 0 ? `wrong type ${wrong.map(([field]) => field).join(', ')}` : '',
            ]
              .filter(Boolean)
              .join('; '),
          );
      }
    }
    return found;
  }
}
