import type * as TS from 'typescript';
import type { SemanticEvidence, SourceLocation, StaticFormNode } from '../model.js';
import type { ClassFact } from '../ts-facts.js';
import type { TypeScriptModule } from '../typescript-loader.js';
import type { CodeRuleFact, RawRuleEffect } from './code-rules.js';
import { conditionOf, fieldsOf, parseTemplateExpression, pathOf, unwrap } from './condition-parser.js';
import {
  canonicalConditions,
  categoryOf,
  ruleName,
  ruleSignature,
  type ApplicationRule,
  type RuleCategory,
  type RuleCondition,
  type RuleEffect,
  type RuleSubject,
} from './rule-model.js';
import type { TemplateCondition, TemplateRuleFacts } from './template-rules.js';

export interface RuleBuildComponent {
  name: string;
  file: string;
  fact: ClassFact;
  template?: { rules: TemplateRuleFacts; name: string };
}

export interface RuleBuildResult {
  rules: ApplicationRule[];
  /** Conditions lues mais écartées : aucun effet fonctionnel (if (!response) return). */
  technical: { component: string; text: string; location: SourceLocation }[];
  /** Boutons du gabarit qui appellent une méthode du composant, et quand ils sont affichés. */
  actions: TemplateAction[];
}

export interface TemplateAction {
  component: string;
  label: string;
  handler: string;
  /** Conditions d'affichage (toutes vraies) : « registration.status == PENDING ». */
  conditions: RuleCondition[];
  location: SourceLocation;
}

interface Candidate {
  component: string;
  conditions: RuleCondition[];
  effects: RuleEffect[];
  evidence: SemanticEvidence[];
  origin: 'TEMPLATE' | 'CODE';
  location: SourceLocation;
}

/**
 * RULE ANALYZER : les faits des gabarits et du code deviennent des règles —
 * conditions + effets, regroupés par condition (le @if du gabarit et le
 * addValidators du code sur « accountType == BUSINESS » font UNE règle), avec
 * leurs preuves. Tout reste STATIC_DISCOVERED.
 */
export function buildRules(
  ts: TypeScriptModule,
  components: readonly RuleBuildComponent[],
  classes: Map<string, { fact: ClassFact; file: string }>,
  forms: readonly StaticFormNode[],
): RuleBuildResult {
  const candidates: Candidate[] = [];
  const technical: RuleBuildResult['technical'] = [];
  const actions: TemplateAction[] = [];
  for (const component of components) {
    const controls = new Set(
      forms.filter((form) => form.component === component.name).flatMap((form) => form.controls),
    );
    // Les collections qui remplissent les options d'une liste : provinces → province.
    const optionsOwner = new Map<string, string>();
    for (const element of component.template?.rules.elements ?? [])
      if (element.control && element.optionsFrom)
        optionsOwner.set(element.optionsFrom.split('.').pop() ?? element.optionsFrom, element.control);
    if (component.template) candidates.push(...templateCandidates(ts, component, controls, actions));
    candidates.push(...codeCandidates(component, classes, optionsOwner));
    for (const entry of component.fact.rules.technical)
      technical.push({
        component: component.name,
        text: entry.text,
        location: { file: component.file, line: entry.line },
      });
  }
  return { rules: merge(candidates), technical, actions };
}

// ------------------------------------------------------------------ gabarit

function templateCandidates(
  ts: TypeScriptModule,
  component: RuleBuildComponent,
  controls: Set<string>,
  actions: TemplateAction[],
): Candidate[] {
  const template = component.template;
  if (!template) return [];
  const resolve = templateResolver(ts, controls);
  const convert = (condition: TemplateCondition): RuleCondition => {
    const expression = parseTemplateExpression(ts, condition.expression);
    const parsed: RuleCondition = expression
      ? conditionOf(ts, expression, resolve)
      : { kind: 'OPAQUE', text: condition.expression.slice(0, 80) };
    return condition.negated ? negateTemplate(parsed) : parsed;
  };
  const bound = (text: string | undefined): RuleCondition | undefined => {
    if (text === undefined || /^(true|false|null|'.*'|".*")$/.test(text.trim())) return undefined;
    return convert({ expression: text, negated: false });
  };
  const candidates: Candidate[] = [];
  for (const element of template.rules.elements) {
    const location = { file: template.name, line: element.line };
    const visible = element.visibleWhen.map(convert);
    if (element.kind === 'BUTTON' && element.clickHandler && element.label)
      actions.push({
        component: component.name,
        label: element.label,
        handler: element.clickHandler,
        conditions: visible,
        location,
      });
    const target: RuleEffect['target'] = element.control
      ? { kind: 'FIELD', name: element.control, control: element.control }
      : element.kind === 'BUTTON'
        ? { kind: 'ACTION', name: element.label ?? element.tag }
        : element.kind === 'LINK'
          ? { kind: 'ELEMENT', name: element.label ?? element.route ?? element.tag }
          : { kind: 'ELEMENT', name: element.label ?? element.tag };
    const add = (conditions: RuleCondition[], effects: RuleEffect[], evidence: string): void => {
      if (conditions.length === 0 || effects.length === 0) return;
      candidates.push({
        component: component.name,
        conditions,
        effects,
        evidence: [evidenceOf('FRAMEWORK', evidence, location)],
        origin: 'TEMPLATE',
        location,
      });
    };
    if (visible.length > 0) {
      const effects: RuleEffect[] = [{ kind: 'SHOW', target, bidirectional: true }];
      if (element.kind === 'LINK' && element.route)
        effects.push({ kind: 'ALLOW_NAVIGATION', target: { kind: 'ROUTE', name: element.route } });
      add(visible, effects, '@if / *ngIf');
    }
    const binding = (text: string | undefined, kind: RuleEffect['kind'], label: string): void => {
      const condition = bound(text);
      if (condition) add([...visible, condition], [{ kind, target, bidirectional: true }], label);
    };
    binding(element.disabledWhen, 'DISABLE', '[disabled]');
    binding(element.readonlyWhen, 'READONLY', '[readonly]');
    binding(element.requiredWhen, 'REQUIRED', '[required]');
    binding(element.hiddenWhen, 'HIDE', '[hidden]');
  }
  return candidates;
}

/** Une négation de condition de gabarit (branche @else). */
function negateTemplate(condition: RuleCondition): RuleCondition {
  switch (condition.kind) {
    case 'COMPARE': {
      const inverse = { '==': '!=', '!=': '==', '>': '<=', '>=': '<', '<': '>=', '<=': '>' } as const;
      return { ...condition, operator: inverse[condition.operator] };
    }
    case 'FLAG':
    case 'PERMISSION':
      return { ...condition, negated: !condition.negated };
    case 'FORM_STATE':
      return { ...condition, state: condition.state === 'VALID' ? 'INVALID' : 'VALID' };
    default:
      return { kind: 'NOT', item: condition };
  }
}

/**
 * Dans un gabarit : form.controls.x.value, form.get('x')?.value, form.value.x, x.value,
 * et un nom (getter, signal) identique à un contrôle → le champ x.
 */
function templateResolver(
  ts: TypeScriptModule,
  controls: Set<string>,
): (node: TS.Expression) => RuleSubject | undefined {
  return (node) => {
    const expression = unwrap(ts, node);
    const field = (control: string, path?: string): RuleSubject => ({
      kind: 'FIELD',
      name: control,
      control,
      ...(path ? { path: path.slice(0, 80) } : {}),
    });
    if (ts.isPropertyAccessExpression(expression) && expression.name.text === 'value') {
      const owner = unwrap(ts, expression.expression);
      // form.get('x').value
      if (
        ts.isCallExpression(owner) &&
        ts.isPropertyAccessExpression(owner.expression) &&
        owner.expression.name.text === 'get' &&
        owner.arguments[0] &&
        ts.isStringLiteral(owner.arguments[0])
      )
        return field(owner.arguments[0].text, expression.getText());
      const path = pathOf(ts, owner);
      const controlsMatch = path ? /(?:^|\.)controls\.(\w+)$/.exec(path)?.[1] : undefined;
      if (controlsMatch) return field(controlsMatch, path);
      const name = path?.split('.').pop();
      if (name && controls.has(name)) return field(name, path);
    }
    const path = pathOf(ts, expression);
    if (path) {
      const valueMatch = /(?:^|\.)(?:value|getRawValue)\.(\w+)$/.exec(path)?.[1];
      if (valueMatch) return field(valueMatch, path);
      const name = path.split('.').pop();
      if (name && controls.has(name) && !path.includes('.')) return field(name, path);
    }
    return undefined;
  };
}

// ------------------------------------------------------------------ code

function codeCandidates(
  component: RuleBuildComponent,
  classes: Map<string, { fact: ClassFact; file: string }>,
  optionsOwner: Map<string, string>,
): Candidate[] {
  const candidates: Candidate[] = [];
  for (const rule of component.fact.rules.rules) {
    const effect = resolveEffect(rule, component, classes, optionsOwner);
    if (!effect) continue;
    const location = { file: component.file, line: rule.line };
    // Le déclencheur (valueChanges d'un champ) est redondant quand une condition porte déjà sur ce champ.
    const covered = new Set(rule.conditions.flatMap(fieldsOf));
    const trigger =
      rule.trigger &&
      !(
        rule.trigger.kind === 'CHANGE' &&
        covered.has(rule.trigger.subject.control ?? rule.trigger.subject.name)
      )
        ? rule.trigger
        : undefined;
    const conditions = [...(trigger ? [trigger] : []), ...rule.conditions];
    // Un calcul sur un formulaire entier (form.valueChanges) : la règle est le calcul lui-même.
    const effective =
      effect.kind === 'CALCULATE_VALUE'
        ? conditions.filter(
            (condition) => !(condition.kind === 'CHANGE' && condition.subject.kind === 'FORM'),
          )
        : conditions;
    if (effective.length === 0 && effect.kind !== 'CALCULATE_VALUE') continue;
    candidates.push({
      component: component.name,
      conditions: effective,
      effects: [effect],
      evidence: [evidenceOf('STATIC_CODE', `${rule.evidence} in ${component.name}.${rule.method}`, location)],
      origin: 'CODE',
      location,
    });
  }
  return candidates;
}

function resolveEffect(
  rule: CodeRuleFact,
  component: RuleBuildComponent,
  classes: Map<string, { fact: ClassFact; file: string }>,
  optionsOwner: Map<string, string>,
): RuleEffect | undefined {
  const { serviceCall, requestVariable, ...effect } = rule.effect;
  const api = serviceCall ? apiOf(component.fact, serviceCall, classes) : undefined;
  if (effect.kind === 'SET_OPTIONS') {
    // La réponse gardée dans une propriété n'est une règle d'options que si une liste l'affiche.
    const control = optionsOwner.get(effect.target.name);
    if (!control) return undefined;
    return {
      kind: 'SET_OPTIONS',
      target: { kind: 'FIELD', name: control, control },
      ...(api ? { api } : {}),
    };
  }
  if (effect.kind === 'API_REQUEST_EXPECTED') {
    if (!api) return undefined;
    return { kind: 'API_REQUEST_EXPECTED', target: { kind: 'API', name: api }, api };
  }
  if (effect.kind === 'INCLUDE_IN_REQUEST' && requestVariable) {
    const method = component.fact.methods.find((entry) => entry.name === rule.method);
    const call = method?.serviceCalls.find((entry) =>
      entry.args.some((argument) => argument.kind === 'variable' && argument.name === requestVariable),
    );
    const requestApi = call
      ? apiOf(component.fact, { target: call.target, method: call.method }, classes)
      : undefined;
    const direct = method?.httpCalls.find((entry) => entry.body === requestVariable);
    const resolved = requestApi ?? (direct ? `${direct.method} ${direct.route}` : undefined);
    return { ...effect, ...(resolved ? { api: resolved } : {}) };
  }
  return effect;
}

/** « GET /api/provinces » d'un appel de service (un niveau) ou direct. */
function apiOf(
  fact: ClassFact,
  call: NonNullable<RawRuleEffect['serviceCall']>,
  classes: Map<string, { fact: ClassFact; file: string }>,
): string | undefined {
  if (call.httpMethod) return call.route !== undefined ? `${call.httpMethod} ${call.route}` : undefined;
  const type = fact.injected[call.target];
  const service = type ? classes.get(type) : undefined;
  const method = service?.fact.methods.find((entry) => entry.name === call.method);
  const http = method?.httpCalls[0];
  return http ? `${http.method} ${http.route}` : undefined;
}

function evidenceOf(
  source: 'STATIC_CODE' | 'FRAMEWORK',
  detail: string,
  location: SourceLocation,
): SemanticEvidence {
  return {
    source,
    kind: 'rule',
    value: detail,
    confidence: source === 'FRAMEWORK' ? 0.85 : 0.8,
    provenance: { location, detail },
  };
}

// ------------------------------------------------------------------ regroupement

/** Même composant + mêmes conditions → une règle ; effets dédupliqués ; preuves cumulées. */
function merge(candidates: readonly Candidate[]): ApplicationRule[] {
  const groups = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.component}|${canonicalConditions(candidate.conditions)}`;
    groups.set(key, [...(groups.get(key) ?? []), candidate]);
  }
  const rules: ApplicationRule[] = [];
  const calculations = new Set<string>();
  for (const group of groups.values()) {
    const first = group[0];
    if (!first) continue;
    const effects: RuleEffect[] = [];
    const seen = new Set<string>();
    for (const effect of group.flatMap((candidate) => candidate.effects)) {
      const key = JSON.stringify([
        effect.kind,
        effect.target.kind,
        effect.target.control ?? effect.target.name,
        effect.value,
        effect.validator,
        effect.api,
      ]);
      // Un même calcul lu deux fois (méthode suivie depuis un déclencheur, puis seule) : une fois.
      const calculation =
        effect.kind === 'CALCULATE_VALUE'
          ? `${first.component}|${effect.target.control ?? effect.target.name}`
          : undefined;
      if (seen.has(key) || (calculation && calculations.has(calculation))) continue;
      seen.add(key);
      if (calculation) calculations.add(calculation);
      effects.push(effect);
    }
    if (effects.length === 0) continue;
    const category = categoryOf(first.conditions, effects);
    // L'effet qui donne sa catégorie à la règle passe en premier (et nomme la règle).
    const primary = effects.findIndex((effect) => CATEGORY_EFFECTS[category].includes(effect.kind));
    if (primary > 0) effects.unshift(...effects.splice(primary, 1));
    const opaque = JSON.stringify(first.conditions).includes('"OPAQUE"');
    const both = new Set(group.map((candidate) => candidate.origin)).size > 1;
    const partial = {
      category,
      component: first.component,
      conditions: first.conditions,
      effects,
    };
    const signature = ruleSignature(partial);
    rules.push({
      id: `rule-${signature.slice(0, 12)}`,
      signature,
      name: ruleName({ conditions: first.conditions, effects }),
      ...partial,
      evidence: group.flatMap((candidate) => candidate.evidence).slice(0, 8),
      confidence: Math.min(0.95, (opaque ? 0.45 : 0.75) + (both ? 0.15 : 0)),
      status: 'STATIC_DISCOVERED',
      origin: group.some((candidate) => candidate.origin === 'TEMPLATE') ? 'TEMPLATE' : 'CODE',
      location: first.location,
    });
  }
  return rules;
}

const CATEGORY_EFFECTS: Record<RuleCategory, readonly RuleEffect['kind'][]> = {
  BUSINESS: ['SET_VALUE', 'INCLUDE_IN_REQUEST', 'API_REQUEST_EXPECTED', 'ALLOW_ACTION', 'DENY_ACTION'],
  VISIBILITY: ['SHOW', 'HIDE'],
  ENABLEMENT: ['ENABLE', 'DISABLE'],
  READONLY: ['READONLY', 'EDITABLE'],
  VALIDATION: ['REQUIRED', 'OPTIONAL', 'ADD_VALIDATOR'],
  CALCULATION: ['CALCULATE_VALUE'],
  NAVIGATION: ['ALLOW_NAVIGATION', 'DENY_NAVIGATION'],
  PERMISSION: [
    'SHOW',
    'HIDE',
    'ALLOW_NAVIGATION',
    'DENY_NAVIGATION',
    'ALLOW_ACTION',
    'DENY_ACTION',
    'ENABLE',
    'DISABLE',
  ],
  OPTIONS: ['SET_OPTIONS'],
};
