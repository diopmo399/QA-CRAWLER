import type { ApiContract } from '../oracles/api-contract.js';
import type { StaticFunctionalFacts } from '../static-analysis/model.js';
import {
  describeConditions,
  type ApplicationRule,
  type RuleCondition,
} from '../static-analysis/rules/rule-model.js';
import {
  entityName,
  runtimeEvidence,
  staticEvidence,
  type ApplicationInvariant,
  type BusinessStateMachine,
  type BusinessTransition,
  type InvariantAssertion,
} from './model.js';

const NEGATION: Record<string, string> = {
  '>': '<=',
  '>=': '<',
  '<': '>=',
  '<=': '>',
  '==': '!=',
  '!=': '==',
};

/**
 * INVARIANT ANALYZER : ce qui doit TOUJOURS rester vrai, lu dans le code — une garde qui
 * refuse (`if (paid > total) throw` → `paid <= total`), une transition gardée
 * (`approve` exige PENDING), une règle du RuleGraph (`companyNumber` obligatoire quand
 * BUSINESS), un calcul, une contrainte du contrat. Plusieurs champs dans une même
 * assertion : une contrainte croisée.
 *
 * Index par champ et par API : après une action, seuls les invariants qu'elle touche sont
 * revus (jamais toute l'application). Les valeurs ne sont jamais lues : un invariant
 * numérique reste NOT_VERIFIED tant que l'écran ou l'API ne le tranche pas.
 */
export class InvariantAnalyzer {
  private readonly invariants = new Map<string, ApplicationInvariant>();
  private readonly byField = new Map<string, Set<string>>();
  private readonly byTransition = new Map<string, Set<string>>();

  build(input: {
    facts?: StaticFunctionalFacts;
    rules?: readonly ApplicationRule[];
    machines?: readonly BusinessStateMachine[];
    contract?: ApiContract;
  }): ApplicationInvariant[] {
    for (const guard of input.facts?.guards ?? []) {
      if (guard.exit === 'NONE') continue;
      const assertion = assertionOfGuard(guard.text, guard.condition);
      if (!assertion) continue;
      const transition = input.machines
        ?.flatMap((machine) => machine.transitions)
        .find(
          (entry) =>
            entry.trigger !== undefined && guard.method === entry.trigger && assertion.kind === 'STATE',
        );
      const entity =
        transition?.entityType ??
        (/(Service|Api|Store|Repository)$/.test(guard.owner) ? entityName(guard.owner) : undefined);
      this.add({
        id: `INV:${guard.owner}.${guard.method}:${assertion.text}`,
        scope: assertion.kind === 'STATE' ? 'WORKFLOW' : assertion.fields.length > 1 ? 'ENTITY' : 'FIELD',
        ...(entity ? { entityType: entity } : {}),
        assertion,
        evidence: [
          staticEvidence(
            `${guard.owner}.${guard.method}: if (${guard.text}) ${guard.exit.toLowerCase()}`,
            guard.location,
            0.8,
          ),
        ],
        confidence: guard.exit === 'THROW' || guard.exit === 'ERROR' ? 0.85 : 0.7,
        status: 'STATIC_DISCOVERED',
        ...(transition ? { transitionId: transition.id } : {}),
      });
    }
    for (const rule of input.rules ?? []) {
      for (const effect of rule.effects) {
        const control = effect.target.control ?? effect.target.name;
        if (effect.kind === 'REQUIRED' && rule.conditions.length > 0) {
          const fields = [control, ...conditionFields(rule.conditions)];
          this.add({
            id: `INV:${rule.signature}:required:${control}`,
            scope: 'FORM',
            ...(rule.component ? { entityType: entityName(rule.component) } : {}),
            conditions: rule.conditions,
            assertion: {
              kind: 'REQUIRED_WHEN',
              text: `${control} is required when ${describeConditions(rule.conditions)}`,
              fields: [...new Set(fields)],
            },
            evidence: rule.evidence.slice(0, 2),
            confidence: rule.confidence,
            status: 'STATIC_DISCOVERED',
            ruleId: rule.id,
          });
        } else if (effect.kind === 'CALCULATE_VALUE') {
          const inputs = effect.inputs ?? [];
          this.add({
            id: `INV:${rule.signature}:derived:${control}`,
            scope: inputs.length > 1 ? 'FORM' : 'FIELD',
            assertion: {
              kind: 'DERIVED',
              text: `${control} = f(${inputs.join(', ')})`,
              fields: [control, ...inputs],
            },
            evidence: rule.evidence.slice(0, 2),
            confidence: rule.confidence,
            status: 'STATIC_DISCOVERED',
            ruleId: rule.id,
          });
        }
      }
    }
    // Contrat : un champ obligatoire de la requête d'écriture (portée API).
    for (const operation of input.contract?.operations ?? []) {
      if (operation.method === 'GET') continue;
      const required = Object.entries(operation.requestFields).filter(([, schema]) => schema.required);
      for (const [name] of required.slice(0, 10))
        this.add({
          id: `INV:API:${operation.method} ${operation.path}:${name}`,
          scope: 'API',
          assertion: {
            kind: 'REQUIRED_WHEN',
            text: `${operation.method} ${operation.path} always sends ${name}`,
            fields: [name],
          },
          evidence: [
            {
              source: 'OPENAPI',
              kind: 'required',
              value: name,
              confidence: 0.85,
              provenance: { detail: `${operation.method} ${operation.path}` },
            },
          ],
          confidence: 0.85,
          status: 'NOT_VERIFIED',
        });
    }
    return this.all();
  }

  private add(invariant: ApplicationInvariant): void {
    if (this.invariants.has(invariant.id) || this.invariants.size >= 300) return;
    this.invariants.set(invariant.id, invariant);
    for (const field of invariant.assertion.fields) {
      const set = this.byField.get(field) ?? new Set<string>();
      set.add(invariant.id);
      this.byField.set(field, set);
    }
    if (invariant.transitionId) {
      const set = this.byTransition.get(invariant.transitionId) ?? new Set<string>();
      set.add(invariant.id);
      this.byTransition.set(invariant.transitionId, set);
    }
  }

  all(): ApplicationInvariant[] {
    return [...this.invariants.values()];
  }

  /** INDEX : les invariants qu'une action touche (ses champs, ses transitions) — et seulement eux. */
  impacted(fields: readonly string[], transitionIds: readonly string[] = []): ApplicationInvariant[] {
    const ids = new Set<string>();
    for (const field of fields) for (const id of this.byField.get(field) ?? []) ids.add(id);
    for (const transition of transitionIds)
      for (const id of this.byTransition.get(transition) ?? []) ids.add(id);
    return [...ids].flatMap((id) => {
      const invariant = this.invariants.get(id);
      return invariant ? [invariant] : [];
    });
  }

  /**
   * Une transition métier a été jugée : l'invariant d'état qui la garde est confirmé
   * (la transition a eu lieu depuis l'état exigé) ou violé (elle a eu lieu depuis un autre état).
   */
  onTransition(
    transition: BusinessTransition,
    from: string | undefined,
    happened: boolean,
  ): ApplicationInvariant[] {
    const touched: ApplicationInvariant[] = [];
    for (const invariant of this.impacted([], [transition.id])) {
      if (invariant.assertion.kind !== 'STATE' || !from || !happened) continue;
      const required = invariant.assertion.right;
      if (required === undefined) continue;
      const respected = invariant.assertion.operator === '==' ? from === required : from !== required;
      invariant.status = respected ? 'RUNTIME_CONFIRMED' : 'RUNTIME_VIOLATED';
      const detail = `${transition.trigger ?? transition.id} from ${from}: ${respected ? 'respected' : 'violated'} (${invariant.assertion.text})`;
      invariant.evidence.push(runtimeEvidence(detail));
      invariant.observations = [...(invariant.observations ?? []), detail].slice(-5);
      touched.push(invariant);
    }
    return touched;
  }

  /** Une transition interdite a été confirmée à l'écran : l'invariant d'état tient (le déclencheur n'est pas offert). */
  onForbiddenConfirmed(trigger: string, state: string): void {
    for (const invariant of this.all()) {
      if (invariant.assertion.kind !== 'STATE' || !invariant.transitionId?.endsWith(`:${trigger}`)) continue;
      if (invariant.status !== 'STATIC_DISCOVERED') continue;
      invariant.status = 'RUNTIME_CONFIRMED';
      invariant.observations = [
        ...(invariant.observations ?? []),
        `${trigger} not offered when ${state}`,
      ].slice(-5);
    }
  }
}

/** `if (a + b > c) throw` → `a + b <= c` ; `if (status !== 'PENDING') return` → `status == PENDING`. */
export function assertionOfGuard(
  text: string,
  condition: RuleCondition | undefined,
): InvariantAssertion | undefined {
  if (condition?.kind === 'COMPARE') {
    const operator = NEGATION[condition.operator];
    if (!operator) return undefined;
    const field = condition.subject.name;
    const value = String(condition.value);
    const state = typeof condition.value === 'string' && /^(status|state|statut|etat|stage)$/i.test(field);
    return {
      kind: state ? 'STATE' : 'COMPARISON',
      text: `${field} ${operator} ${value}`,
      left: field,
      operator,
      right: value,
      fields: [field],
    };
  }
  const source = condition?.kind === 'OPAQUE' ? condition.text : text;
  const match = /^(.+?)\s*(>=|<=|===|!==|==|!=|>|<)\s*(.+)$/.exec(source.trim());
  if (!match) return undefined;
  const [, left = '', rawOperator = '', right = ''] = match;
  const operator = NEGATION[rawOperator.replace('===', '==').replace('!==', '!=')];
  if (!operator || /[&|?]/.test(source)) return undefined;
  const clean = (side: string): string =>
    side
      .replace(/\bthis\./g, '')
      .replace(/\b\w+\.(\w+)/g, '$1')
      .trim();
  const fields = [
    ...new Set(
      [...`${left} ${right}`.matchAll(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g)].map(
        (entry) => entry[0].split('.').pop() ?? entry[0],
      ),
    ),
  ].filter((name) => !/^(this|Math|Number|null|undefined|true|false)$/.test(name));
  if (fields.length === 0) return undefined;
  return {
    kind: 'COMPARISON',
    text: `${clean(left)} ${operator} ${clean(right)}`,
    left: clean(left),
    operator,
    right: clean(right),
    fields,
  };
}

function conditionFields(conditions: readonly RuleCondition[]): string[] {
  return conditions.flatMap((condition): string[] => {
    switch (condition.kind) {
      case 'COMPARE':
      case 'FLAG':
      case 'FORM_STATE':
      case 'CHANGE':
        return [condition.subject.control ?? condition.subject.name];
      case 'AND':
      case 'OR':
        return conditionFields(condition.items);
      case 'NOT':
        return conditionFields([condition.item]);
      default:
        return [];
    }
  });
}
