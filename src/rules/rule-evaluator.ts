import type { UiElement } from '../model/ui-snapshot.js';
import { runtimeRequired } from '../forms/state/field-dependencies.js';
import type { FieldObservation } from '../forms/state/form-state-analyzer.js';
import { valueDigest } from '../forms/state/value-digest.js';
import type {
  EffectVerdict,
  RuleCondition,
  RuleEffect,
  RuleLiteral,
  RuleSubject,
} from '../static-analysis/rules/rule-model.js';

/**
 * RULE EVALUATOR : sur l'écran tel qu'il est, une condition est-elle vraie, fausse ou
 * inconnue — et l'effet attendu est-il là ? Pur, sans navigateur : le vérificateur
 * lui donne ce qu'il a observé. « Inconnu » n'est jamais converti en vrai ou faux.
 */

export interface ScreenFacts {
  fields: readonly FieldObservation[];
  elements: readonly UiElement[];
  salt: string;
  /** Valeur saisie par le crawler lui-même dans ce champ (ses données de test, jamais une donnée lue). */
  knownValue?: (fieldId: string) => string | undefined;
  /** Requêtes vues (GET /api/provinces), pendant la fenêtre observée. */
  apisSeen: ReadonlySet<string>;
  /** Champs dont la valeur vient de changer (une condition « x changes » est alors vraie). */
  changed?: ReadonlySet<string>;
}

export type Truth = boolean | undefined;

export function fieldOf(
  facts: ScreenFacts,
  subject: Pick<RuleSubject, 'control' | 'name'>,
): FieldObservation | undefined {
  const key = subject.control ?? subject.name;
  return (
    facts.fields.find((field) => field.control === key) ?? facts.fields.find((field) => field.fieldId === key)
  );
}

function numeric(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) return Number(value);
  return undefined;
}

function compare(left: string | number | boolean | null, operator: string, right: RuleLiteral): Truth {
  const a = numeric(left);
  const b = numeric(right);
  if (operator === '==' || operator === '!=') {
    const equal =
      a !== undefined && b !== undefined
        ? a === b
        : String(left ?? '')
            .trim()
            .toLowerCase() ===
          String(right ?? '')
            .trim()
            .toLowerCase();
    return operator === '==' ? equal : !equal;
  }
  if (a === undefined || b === undefined) return undefined;
  switch (operator) {
    case '>':
      return a > b;
    case '>=':
      return a >= b;
    case '<':
      return a < b;
    case '<=':
      return a <= b;
    default:
      return undefined;
  }
}

/** La valeur d'un champ, sans la lire en clair : code/libellé d'option, case cochée, saisie connue du crawler. */
function valueOfField(
  field: FieldObservation,
  facts: ScreenFacts,
): string | number | boolean | null | undefined {
  if (!field.hasValue) return field.kind === 'checkbox' ? false : null;
  if (field.kind === 'checkbox') return field.value?.checked ?? undefined;
  if (field.value?.code !== undefined) return field.value.code;
  if (field.value?.option !== undefined) return field.value.option;
  return facts.knownValue?.(field.fieldId);
}

export function evaluateCondition(condition: RuleCondition, facts: ScreenFacts): Truth {
  switch (condition.kind) {
    case 'COMPARE': {
      if (condition.subject.kind !== 'FIELD') return undefined;
      const field = fieldOf(facts, condition.subject);
      if (!field) return undefined;
      const value = valueOfField(field, facts);
      if (value === null) {
        // Champ vide : égal à null / '' ; jamais comparable à un nombre.
        if (condition.value === null || condition.value === '') return condition.operator === '==';
        if (condition.operator === '==') return false;
        if (condition.operator === '!=') return true;
        return undefined;
      }
      if (value !== undefined) return compare(value, condition.operator, condition.value);
      // Une valeur texte inconnue du crawler : l'égalité se vérifie par empreinte.
      if (
        (condition.operator === '==' || condition.operator === '!=') &&
        field.value?.digest &&
        condition.value !== null
      ) {
        const equal = field.value.digest === valueDigest(String(condition.value), facts.salt);
        return condition.operator === '==' ? equal : !equal;
      }
      return undefined;
    }
    case 'FLAG': {
      if (condition.subject.kind !== 'FIELD') return undefined;
      const field = fieldOf(facts, condition.subject);
      if (!field) return undefined;
      return condition.negated ? !field.hasValue : field.hasValue;
    }
    case 'FORM_STATE': {
      const known = facts.fields.filter((field) => field.valid !== undefined);
      if (known.length === 0) return undefined;
      const valid = known.every((field) => field.valid === true);
      if (!valid) return condition.state === 'INVALID';
      // Tous les champs connus valides, mais d'autres sans état : on ne conclut que si tous sont connus.
      return known.length === facts.fields.length ? condition.state === 'VALID' : undefined;
    }
    case 'AND': {
      const values = condition.items.map((item) => evaluateCondition(item, facts));
      if (values.some((value) => value === false)) return false;
      return values.every((value) => value === true) ? true : undefined;
    }
    case 'OR': {
      const values = condition.items.map((item) => evaluateCondition(item, facts));
      if (values.some((value) => value === true)) return true;
      return values.every((value) => value === false) ? false : undefined;
    }
    case 'NOT': {
      const value = evaluateCondition(condition.item, facts);
      return value === undefined ? undefined : !value;
    }
    case 'CHANGE':
      return facts.changed?.has(condition.subject.control ?? condition.subject.name) ? true : undefined;
    // Un rôle, un état interne du composant, une expression opaque : inconnus à l'écran.
    default:
      return undefined;
  }
}

export function evaluateConditions(conditions: readonly RuleCondition[], facts: ScreenFacts): Truth {
  return evaluateCondition({ kind: 'AND', items: [...conditions] }, facts);
}

/** Un bouton, un lien, un élément par son texte (« Enregistrer », « Administration »). */
function elementNamed(facts: ScreenFacts, name: string): UiElement | undefined {
  const wanted = name.trim().toLowerCase();
  return facts.elements.find((element) =>
    [element.text, element.name, element.label].some((text) => text?.trim().toLowerCase() === wanted),
  );
}

export interface EffectCheck {
  verdict: EffectVerdict;
  detail: string;
}

/** Les effets qu'un écran peut montrer ; les autres demandent un envoi, un rôle, l'état interne. */
export function observableEffect(effect: RuleEffect): boolean {
  switch (effect.kind) {
    case 'SHOW':
    case 'HIDE':
    case 'ENABLE':
    case 'DISABLE':
    case 'READONLY':
    case 'EDITABLE':
    case 'REQUIRED':
    case 'OPTIONAL':
    case 'SET_OPTIONS':
    case 'API_REQUEST_EXPECTED':
      return true;
    case 'SET_VALUE':
    case 'CALCULATE_VALUE':
      return effect.target.kind === 'FIELD';
    default:
      return false;
  }
}

/**
 * L'effet est-il observé ? `held` : la condition est vraie (effet attendu) ou fausse
 * (effet inverse attendu, seulement pour une liaison du gabarit). undefined : rien à dire.
 */
export function checkEffect(effect: RuleEffect, held: boolean, facts: ScreenFacts): EffectCheck | undefined {
  if (!held && !effect.bidirectional) return undefined;
  const name = effect.target.control ?? effect.target.name;
  const field = effect.target.kind === 'FIELD' ? fieldOf(facts, effect.target) : undefined;
  const element = effect.target.kind !== 'FIELD' ? elementNamed(facts, effect.target.name) : undefined;
  const present = effect.target.kind === 'FIELD' ? field !== undefined : element !== undefined;
  const expect = (observed: boolean, wanted: boolean, what: string): EffectCheck => ({
    verdict: observed === wanted ? 'CONFIRMED' : 'CONTRADICTED',
    detail: `${name} ${observed ? what : `not ${what}`}${held ? '' : ' (condition false)'}`,
  });
  switch (effect.kind) {
    case 'SHOW':
      return expect(present, held, 'visible');
    case 'HIDE':
      return expect(present, !held, 'visible');
    case 'ENABLE':
    case 'DISABLE': {
      if (!present) return undefined;
      const disabled = field ? field.disabled : (element?.disabled ?? false);
      return expect(disabled, effect.kind === 'DISABLE' ? held : !held, 'disabled');
    }
    case 'READONLY':
    case 'EDITABLE': {
      if (!field) return undefined;
      return expect(field.readonly, effect.kind === 'READONLY' ? held : !held, 'read-only');
    }
    case 'REQUIRED':
    case 'OPTIONAL': {
      if (!field) return held ? { verdict: 'INCONCLUSIVE', detail: `${name} not on screen` } : undefined;
      const required = runtimeRequired(field);
      if (required === undefined)
        return {
          verdict: 'INCONCLUSIVE',
          detail: `${name}: required state not observable (field already filled)`,
        };
      return expect(required, effect.kind === 'REQUIRED' ? held : !held, 'required');
    }
    case 'SET_OPTIONS': {
      if (!held) return undefined;
      if (!field) return { verdict: 'INCONCLUSIVE', detail: `${name} not on screen` };
      const options = (field.options?.codes ?? []).filter((code) => code.trim() !== '');
      if (options.length === 0) return { verdict: 'CONTRADICTED', detail: `${name} has no option` };
      if (effect.api && !facts.apisSeen.has(effect.api))
        return {
          verdict: 'INCONCLUSIVE',
          detail: `${name} has ${String(options.length)} option(s), ${effect.api} not seen`,
        };
      return {
        verdict: 'CONFIRMED',
        detail: `${name}: ${String(options.length)} option(s)${effect.api ? ` after ${effect.api}` : ''}`,
      };
    }
    case 'API_REQUEST_EXPECTED': {
      if (!held || !effect.api) return undefined;
      return facts.apisSeen.has(effect.api)
        ? { verdict: 'CONFIRMED', detail: `${effect.api} requested` }
        : { verdict: 'CONTRADICTED', detail: `${effect.api} not requested` };
    }
    case 'SET_VALUE': {
      if (!held || !field || effect.value === undefined) return undefined;
      const value = valueOfField(field, facts);
      if (value === undefined) {
        if (field.value?.digest)
          return expect(
            field.value.digest === valueDigest(String(effect.value), facts.salt),
            true,
            `= ${String(effect.value)}`,
          );
        return undefined;
      }
      return expect(compare(value, '==', effect.value) === true, true, `= ${String(effect.value)}`);
    }
    default:
      return undefined;
  }
}
