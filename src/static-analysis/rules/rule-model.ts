import { createHash } from 'node:crypto';
import type { SemanticEvidence, SourceLocation } from '../model.js';

/**
 * RÈGLES DE L'APPLICATION : ce que le code dit du comportement fonctionnel —
 * « si accountType vaut BUSINESS, companyNumber apparaît et devient obligatoire ».
 *
 *   STATIC_DISCOVERED  ≠  RUNTIME_CONFIRMED
 *
 * Une règle lue dans le code est une HYPOTHÈSE : seule l'observation du navigateur la
 * confirme (RUNTIME_CONFIRMED) ou la contredit (RUNTIME_CONTRADICTED) ; une
 * contradiction n'est jamais un bug en soi, les oracles existants en jugent.
 */

export const RULE_CATEGORIES = [
  'BUSINESS',
  'VISIBILITY',
  'ENABLEMENT',
  'READONLY',
  'VALIDATION',
  'CALCULATION',
  'NAVIGATION',
  'PERMISSION',
  'OPTIONS',
] as const;
export type RuleCategory = (typeof RULE_CATEGORIES)[number];

export type RuleStatus =
  | 'STATIC_DISCOVERED'
  /** Une partie des effets observée, pas encore toute la règle. */
  | 'RUNTIME_OBSERVED'
  | 'RUNTIME_CONFIRMED'
  | 'RUNTIME_CONTRADICTED'
  | 'INCONCLUSIVE';

/** Ce dont parle une condition ou un effet. */
export interface RuleSubject {
  /**
   * FIELD : un contrôle de formulaire (control) ; STATE : une propriété du composant
   * (loading, mode) ; PERMISSION : un rôle, une permission ; FORM : un formulaire.
   */
  kind: 'FIELD' | 'STATE' | 'PERMISSION' | 'FORM';
  /** accountType, loading, ADMIN, form */
  name: string;
  /** formControlName quand kind = FIELD. */
  control?: string;
  /** Le chemin tel qu'écrit (form.value.accountType), borné. */
  path?: string;
}

export type ComparisonOperator = '==' | '!=' | '>' | '>=' | '<' | '<=';
export type RuleLiteral = string | number | boolean | null;

export type RuleCondition =
  | { kind: 'COMPARE'; subject: RuleSubject; operator: ComparisonOperator; value: RuleLiteral }
  /** Une valeur « vraie » (un drapeau, un champ rempli) ; negated : fausse. */
  | { kind: 'FLAG'; subject: RuleSubject; negated?: boolean }
  | { kind: 'FORM_STATE'; subject: RuleSubject; state: 'VALID' | 'INVALID' }
  /** hasRole('ADMIN'), user.role === 'ADMIN', permissions.includes('delete'). */
  | { kind: 'PERMISSION'; permission: string; negated?: boolean }
  /** La valeur change (valueChanges.subscribe). */
  | { kind: 'CHANGE'; subject: RuleSubject }
  | { kind: 'AND' | 'OR'; items: RuleCondition[] }
  | { kind: 'NOT'; item: RuleCondition }
  /** Une expression que l'analyse ne sait pas lire sans l'exécuter : citée, jamais interprétée. */
  | { kind: 'OPAQUE'; text: string };

export const RULE_EFFECT_KINDS = [
  'SHOW',
  'HIDE',
  'ENABLE',
  'DISABLE',
  'READONLY',
  'EDITABLE',
  'REQUIRED',
  'OPTIONAL',
  'ADD_VALIDATOR',
  'SET_VALUE',
  'CALCULATE_VALUE',
  'SET_OPTIONS',
  'ALLOW_NAVIGATION',
  'DENY_NAVIGATION',
  'ALLOW_ACTION',
  'DENY_ACTION',
  'API_REQUEST_EXPECTED',
  'INCLUDE_IN_REQUEST',
] as const;
export type RuleEffectKind = (typeof RULE_EFFECT_KINDS)[number];

/** Ce sur quoi porte un effet : un champ, un bouton, un élément, une route, une API, un état. */
export interface RuleTarget {
  kind: 'FIELD' | 'ACTION' | 'ELEMENT' | 'ROUTE' | 'API' | 'STATE';
  /** companyNumber, « Enregistrer », /admin, GET /api/provinces, discount */
  name: string;
  control?: string;
}

export interface RuleEffect {
  kind: RuleEffectKind;
  target: RuleTarget;
  /** SET_VALUE : la valeur littérale ; ADD_VALIDATOR : le validateur. */
  value?: RuleLiteral;
  validator?: string;
  /** CALCULATE_VALUE : les champs d'où le calcul part. */
  inputs?: string[];
  /** L'appel d'API concerné (API_REQUEST_EXPECTED, SET_OPTIONS, INCLUDE_IN_REQUEST). */
  api?: string;
  /**
   * Liaison du gabarit ([disabled]="c", @if (c)) : l'effet suit la condition dans les deux
   * sens — condition fausse, effet inverse attendu. Un addValidators du code, lui, ne se défait pas seul.
   */
  bidirectional?: boolean;
}

/** Où en est la vérification d'une règle (RULE COVERAGE). */
export type RuleCoverageStatus =
  | 'NOT_VERIFIED'
  | 'PARTIALLY_VERIFIED'
  | 'VERIFIED'
  | 'CONTRADICTED'
  | 'BLOCKED_BY_POLICY'
  | 'BLOCKED_BY_CONTEXT'
  | 'INCONCLUSIVE';

/** Ce que le runtime a vu pour un effet d'une règle. */
export type EffectVerdict = 'CONFIRMED' | 'CONTRADICTED' | 'INCONCLUSIVE' | 'NOT_VERIFIED';

export interface RuleObservation {
  at: string;
  /** Effet (index dans effects) observé. */
  effect: number;
  verdict: EffectVerdict;
  /** La condition était-elle vraie (effet attendu) ou fausse (effet inverse attendu) ? */
  conditionHeld: boolean;
  /** PASSIVE : état déjà présent à l'écran ; ACTIVE : valeur posée par le vérificateur, puis rétablie. */
  mode: 'PASSIVE' | 'ACTIVE' | 'NETWORK';
  detail: string;
  /** Contexte d'une contradiction : route, rôle, version, état du formulaire (jamais une valeur saisie). */
  context?: Record<string, string>;
}

export interface ApplicationRule {
  /** Stable pour une même règle (signature courte). */
  id: string;
  /** Empreinte de la sémantique (catégorie, conditions, effets, cibles) — pas des lignes ni des noms minifiés. */
  signature: string;
  /** ACCOUNT_TYPE_BUSINESS_SHOWS_COMPANY_NUMBER : lisible, déterministe. */
  name: string;
  category: RuleCategory;
  component?: string;
  /** Les conditions (toutes vraies, ET implicite). */
  conditions: RuleCondition[];
  effects: RuleEffect[];
  evidence: SemanticEvidence[];
  /** 0..1 */
  confidence: number;
  status: RuleStatus;
  /** Où la règle a été lue : gabarit (@if, [disabled]) ou code (if, valueChanges). */
  origin: 'TEMPLATE' | 'CODE';
  location: SourceLocation;
  /** Arêtes du FieldDependencyGraph que la règle explique. */
  dependencyEdges?: string[];
  observations?: RuleObservation[];
  /** Verdict par effet (même ordre que effects). */
  effectVerdicts?: EffectVerdict[];
  coverage?: RuleCoverageStatus;
  /** Pourquoi la règle n'a pas pu être vérifiée (rôle absent, envoi interdit…). */
  blockedReason?: string;
}

// ------------------------------------------------------------------ rendu

export function describeSubject(subject: RuleSubject): string {
  return subject.control ?? subject.name;
}

export function describeLiteral(value: RuleLiteral): string {
  return typeof value === 'string' ? value : String(value);
}

/** « accountType == BUSINESS AND loading == false » */
export function describeCondition(condition: RuleCondition): string {
  switch (condition.kind) {
    case 'COMPARE':
      return `${describeSubject(condition.subject)} ${condition.operator} ${describeLiteral(condition.value)}`;
    case 'FLAG':
      return `${condition.negated ? 'NOT ' : ''}${describeSubject(condition.subject)}`;
    case 'FORM_STATE':
      return `${condition.subject.name}.${condition.state.toLowerCase()}`;
    case 'PERMISSION':
      return `${condition.negated ? 'NOT ' : ''}permission ${condition.permission}`;
    case 'CHANGE':
      return `${describeSubject(condition.subject)} changes`;
    case 'AND':
    case 'OR':
      return condition.items
        .map((item) =>
          item.kind === 'AND' || item.kind === 'OR'
            ? `(${describeCondition(item)})`
            : describeCondition(item),
        )
        .join(` ${condition.kind} `);
    case 'NOT':
      return `NOT (${describeCondition(condition.item)})`;
    case 'OPAQUE':
      return `« ${condition.text} »`;
  }
}

export function describeConditions(conditions: readonly RuleCondition[]): string {
  return conditions.length === 0 ? 'always' : conditions.map(describeCondition).join(' AND ');
}

const EFFECT_TEXT: Record<RuleEffectKind, string> = {
  SHOW: 'visible',
  HIDE: 'hidden',
  ENABLE: 'enabled',
  DISABLE: 'disabled',
  READONLY: 'read-only',
  EDITABLE: 'editable',
  REQUIRED: 'required',
  OPTIONAL: 'optional',
  ADD_VALIDATOR: 'validated',
  SET_VALUE: 'set',
  CALCULATE_VALUE: 'calculated',
  SET_OPTIONS: 'options loaded',
  ALLOW_NAVIGATION: 'navigation allowed',
  DENY_NAVIGATION: 'navigation denied',
  ALLOW_ACTION: 'action allowed',
  DENY_ACTION: 'action denied',
  API_REQUEST_EXPECTED: 'request expected',
  INCLUDE_IN_REQUEST: 'included in the request',
};

/** « companyNumber required », « total calculated from quantity, price, discount » */
export function describeEffect(effect: RuleEffect): string {
  const target = effect.target.control ?? effect.target.name;
  switch (effect.kind) {
    case 'SET_VALUE':
      return `${target} = ${effect.value === undefined ? '…' : describeLiteral(effect.value)}`;
    case 'CALCULATE_VALUE':
      return `${target} calculated from ${(effect.inputs ?? []).join(', ') || '…'}`;
    case 'ADD_VALIDATOR':
      return `${target} validated by ${effect.validator ?? 'a validator'}`;
    case 'ALLOW_NAVIGATION':
    case 'DENY_NAVIGATION':
      return `${EFFECT_TEXT[effect.kind]} to ${target}`;
    case 'API_REQUEST_EXPECTED':
      return `${effect.api ?? target} requested`;
    case 'INCLUDE_IN_REQUEST':
      return `${target} included in ${effect.api ?? 'the request'}`;
    case 'SET_OPTIONS':
      return `${target} options loaded${effect.api ? ` from ${effect.api}` : ''}`;
    default:
      return `${target} ${EFFECT_TEXT[effect.kind]}`;
  }
}

// ------------------------------------------------------------------ identité

/** Forme canonique d'une condition (ordre des ET/OU sans importance, casse des noms ignorée). */
export function canonicalCondition(condition: RuleCondition): string {
  const subject = (value: RuleSubject): string =>
    `${value.kind}:${(value.control ?? value.name).toLowerCase()}`;
  switch (condition.kind) {
    case 'COMPARE':
      return `${subject(condition.subject)}${condition.operator}${JSON.stringify(condition.value)}`;
    case 'FLAG':
      return `${condition.negated ? '!' : ''}${subject(condition.subject)}`;
    case 'FORM_STATE':
      return `form:${condition.state}`;
    case 'PERMISSION':
      return `${condition.negated ? '!' : ''}perm:${condition.permission.toLowerCase()}`;
    case 'CHANGE':
      return `change:${subject(condition.subject)}`;
    case 'AND':
    case 'OR':
      return `${condition.kind}(${condition.items.map(canonicalCondition).sort().join(',')})`;
    case 'NOT':
      return `NOT(${canonicalCondition(condition.item)})`;
    case 'OPAQUE':
      return `opaque:${condition.text.replace(/\s+/g, '')}`;
  }
}

export function canonicalConditions(conditions: readonly RuleCondition[]): string {
  return conditions.map(canonicalCondition).sort().join('&');
}

function canonicalEffect(effect: RuleEffect): string {
  return [
    effect.kind,
    effect.target.kind,
    (effect.target.control ?? effect.target.name).toLowerCase(),
    effect.value === undefined ? '' : JSON.stringify(effect.value),
    effect.validator ?? '',
    (effect.inputs ?? [])
      .map((input) => input.toLowerCase())
      .sort()
      .join('+'),
  ].join('|');
}

/**
 * SIGNATURE : catégorie + sémantique des conditions + sémantique des effets + identité
 * des cibles (et le composant). Ni numéro de ligne, ni nom de variable minifié, ni id
 * généré du DOM : la même règle garde sa signature d'une version à l'autre.
 */
export function ruleSignature(
  rule: Pick<ApplicationRule, 'category' | 'component' | 'conditions' | 'effects'>,
): string {
  return createHash('sha256')
    .update(
      [
        rule.category,
        (rule.component ?? '').toLowerCase(),
        canonicalConditions(rule.conditions),
        rule.effects.map(canonicalEffect).sort().join(';'),
      ].join('\n'),
    )
    .digest('hex')
    .slice(0, 16);
}

/** ACCOUNT_TYPE_BUSINESS_SHOWS_COMPANY_NUMBER */
export function ruleName(rule: Pick<ApplicationRule, 'conditions' | 'effects'>): string {
  const snake = (text: string): string =>
    text
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .replace(/[^A-Za-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toUpperCase()
      .slice(0, 40);
  const whenOf = (condition: RuleCondition | undefined): string =>
    condition === undefined
      ? ''
      : condition.kind === 'COMPARE'
        ? `${snake(describeSubject(condition.subject))}_${condition.operator === '==' ? '' : `${OPERATOR_WORD[condition.operator]}_`}${snake(describeLiteral(condition.value))}`
        : condition.kind === 'FLAG'
          ? `${condition.negated ? 'NOT_' : ''}${snake(describeSubject(condition.subject))}`
          : condition.kind === 'PERMISSION'
            ? `${condition.negated ? 'NOT_' : ''}${snake(condition.permission)}`
            : condition.kind === 'CHANGE'
              ? `${snake(describeSubject(condition.subject))}_CHANGE`
              : condition.kind === 'FORM_STATE'
                ? `FORM_${condition.state}`
                : condition.kind === 'AND' || condition.kind === 'OR'
                  ? condition.items.slice(0, 2).map(whenOf).join(`_${condition.kind}_`)
                  : condition.kind === 'NOT'
                    ? `NOT_${whenOf(condition.item)}`
                    : 'CONDITION';
  // La condition la plus parlante d'abord (un changement seul ne dit pas grand-chose).
  const ordered = [...rule.conditions].sort(
    (a, b) => Number(a.kind === 'CHANGE') - Number(b.kind === 'CHANGE'),
  );
  const when = ordered.slice(0, 2).map(whenOf).join('_AND_');
  const effect = rule.effects[0];
  const verb = effect ? VERB[effect.kind] : 'AFFECTS';
  const target = effect ? snake(effect.target.control ?? effect.target.name) : 'APPLICATION';
  return [when, verb, target].filter(Boolean).join('_').replace(/_+/g, '_');
}

const OPERATOR_WORD: Record<ComparisonOperator, string> = {
  '==': 'IS',
  '!=': 'NOT',
  '>': 'ABOVE',
  '>=': 'AT_LEAST',
  '<': 'BELOW',
  '<=': 'AT_MOST',
};

const VERB: Record<RuleEffectKind, string> = {
  SHOW: 'SHOWS',
  HIDE: 'HIDES',
  ENABLE: 'ENABLES',
  DISABLE: 'DISABLES',
  READONLY: 'LOCKS',
  EDITABLE: 'UNLOCKS',
  REQUIRED: 'REQUIRES',
  OPTIONAL: 'RELAXES',
  ADD_VALIDATOR: 'VALIDATES',
  SET_VALUE: 'SETS',
  CALCULATE_VALUE: 'CALCULATES',
  SET_OPTIONS: 'LOADS_OPTIONS_OF',
  ALLOW_NAVIGATION: 'ALLOWS',
  DENY_NAVIGATION: 'DENIES',
  ALLOW_ACTION: 'ALLOWS',
  DENY_ACTION: 'DENIES',
  API_REQUEST_EXPECTED: 'CALLS',
  INCLUDE_IN_REQUEST: 'SENDS',
};

/**
 * La catégorie d'une règle selon ses effets et sa condition : une condition de
 * rôle/permission fait une règle PERMISSION ; sinon l'effet le plus « fonctionnel » l'emporte.
 */
export function categoryOf(
  conditions: readonly RuleCondition[],
  effects: readonly RuleEffect[],
): RuleCategory {
  const permission = conditions.some(function isPermission(condition: RuleCondition): boolean {
    if (condition.kind === 'PERMISSION') return true;
    if (condition.kind === 'AND' || condition.kind === 'OR') return condition.items.some(isPermission);
    if (condition.kind === 'NOT') return isPermission(condition.item);
    return (
      (condition.kind === 'COMPARE' || condition.kind === 'FLAG') && condition.subject.kind === 'PERMISSION'
    );
  });
  const kinds = new Set(effects.map((effect) => effect.kind));
  if (permission && [...kinds].some((kind) => kind !== 'CALCULATE_VALUE')) return 'PERMISSION';
  if (kinds.has('CALCULATE_VALUE')) return 'CALCULATION';
  if (kinds.has('REQUIRED') || kinds.has('OPTIONAL') || kinds.has('ADD_VALIDATOR')) return 'VALIDATION';
  if (
    kinds.has('INCLUDE_IN_REQUEST') ||
    kinds.has('API_REQUEST_EXPECTED') ||
    kinds.has('ALLOW_ACTION') ||
    kinds.has('DENY_ACTION') ||
    [...effects].some((effect) => effect.kind === 'SET_VALUE' && effect.target.kind === 'STATE')
  )
    return kinds.has('SET_OPTIONS') ? 'OPTIONS' : 'BUSINESS';
  if (kinds.has('SET_OPTIONS')) return 'OPTIONS';
  if (kinds.has('ALLOW_NAVIGATION') || kinds.has('DENY_NAVIGATION')) return 'NAVIGATION';
  if (kinds.has('READONLY') || kinds.has('EDITABLE')) return 'READONLY';
  if (kinds.has('ENABLE') || kinds.has('DISABLE')) return 'ENABLEMENT';
  if (kinds.has('SET_VALUE')) return 'BUSINESS';
  return 'VISIBILITY';
}
