import type * as TS from 'typescript';
import { SECRET_NAME } from '../sanitize.js';
import type { TypeScriptModule } from '../typescript-loader.js';
import type { ComparisonOperator, RuleCondition, RuleLiteral, RuleSubject } from './rule-model.js';

/**
 * CONDITIONS : une expression du code ou d'un gabarit devient une condition de règle,
 * seulement quand sa forme est simple et déterministe (comparaison à un littéral, ET,
 * OU, NON, drapeau, validité d'un formulaire, rôle). Le reste devient OPAQUE : cité,
 * jamais interprété. Aucun moteur logique général : on ne réinterprète pas JavaScript.
 */

/** Ce que désigne un opérande : un contrôle, un état du composant, un rôle. undefined : inconnu. */
export type SubjectResolver = (node: TS.Expression) => RuleSubject | undefined;

/** Noms qui portent un rôle, une permission, une autorisation. */
export const PERMISSION_NAME =
  /(^|[._])(is|has|can)?(admin|administrator|superuser|role|roles|permission|permissions|authorit(y|ies)|privilege|privileges|grant|grants|manager)($|[A-Z._])/i;

export function unwrap(ts: TypeScriptModule, node: TS.Expression): TS.Expression {
  let expression = node;
  for (;;) {
    if (
      ts.isParenthesizedExpression(expression) ||
      ts.isNonNullExpression(expression) ||
      ts.isAsExpression(expression)
    )
      expression = expression.expression;
    // Number(age), parseInt(age, 10), String(code) : la même valeur, convertie.
    else if (
      ts.isCallExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      /^(Number|String|Boolean|parseInt|parseFloat)$/.test(expression.expression.text) &&
      expression.arguments[0]
    )
      expression = expression.arguments[0];
    // +age
    else if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.PlusToken)
      expression = expression.operand;
    else return expression;
  }
}

function literalOf(ts: TypeScriptModule, node: TS.Expression): RuleLiteral | undefined {
  const expression = unwrap(ts, node);
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression))
    return expression.text;
  if (ts.isNumericLiteral(expression)) return Number(expression.text);
  if (
    ts.isPrefixUnaryExpression(expression) &&
    expression.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(expression.operand)
  )
    return -Number(expression.operand.text);
  if (expression.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expression.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (expression.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isIdentifier(expression) && expression.text === 'undefined') return null;
  // Enum.BUSINESS / AccountType.Business : le nom du membre.
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    /^[A-Z]/.test(expression.expression.text) &&
    /^[A-Z][A-Z0-9_]*$|^[A-Z][a-z]/.test(expression.name.text) &&
    !/^(this|Validators|Math|Number|String|Date)$/.test(expression.expression.text)
  )
    return expression.name.text;
  return undefined;
}

const OPERATORS = new Map<number, { operator: ComparisonOperator; flipped: ComparisonOperator }>();
function operators(
  ts: TypeScriptModule,
): Map<number, { operator: ComparisonOperator; flipped: ComparisonOperator }> {
  if (OPERATORS.size === 0) {
    OPERATORS.set(ts.SyntaxKind.EqualsEqualsEqualsToken, { operator: '==', flipped: '==' });
    OPERATORS.set(ts.SyntaxKind.EqualsEqualsToken, { operator: '==', flipped: '==' });
    OPERATORS.set(ts.SyntaxKind.ExclamationEqualsEqualsToken, { operator: '!=', flipped: '!=' });
    OPERATORS.set(ts.SyntaxKind.ExclamationEqualsToken, { operator: '!=', flipped: '!=' });
    OPERATORS.set(ts.SyntaxKind.GreaterThanToken, { operator: '>', flipped: '<' });
    OPERATORS.set(ts.SyntaxKind.GreaterThanEqualsToken, { operator: '>=', flipped: '<=' });
    OPERATORS.set(ts.SyntaxKind.LessThanToken, { operator: '<', flipped: '>' });
    OPERATORS.set(ts.SyntaxKind.LessThanEqualsToken, { operator: '<=', flipped: '>=' });
  }
  return OPERATORS;
}

const INVERSE: Record<ComparisonOperator, ComparisonOperator> = {
  '==': '!=',
  '!=': '==',
  '>': '<=',
  '>=': '<',
  '<': '>=',
  '<=': '>',
};

/** La négation, simplifiée : NOT (a == b) → a != b ; NOT drapeau → drapeau nié ; De Morgan. */
export function negate(condition: RuleCondition): RuleCondition {
  switch (condition.kind) {
    case 'COMPARE':
      return { ...condition, operator: INVERSE[condition.operator] };
    case 'FLAG':
      return { ...condition, negated: !condition.negated };
    case 'PERMISSION':
      return { ...condition, negated: !condition.negated };
    case 'FORM_STATE':
      return { ...condition, state: condition.state === 'VALID' ? 'INVALID' : 'VALID' };
    case 'NOT':
      return condition.item;
    case 'AND':
      return { kind: 'OR', items: condition.items.map(negate) };
    case 'OR':
      return { kind: 'AND', items: condition.items.map(negate) };
    default:
      return { kind: 'NOT', item: condition };
  }
}

/** Le texte d'un opérande, pour un sujet par défaut (état du composant) : this. et () retirés. */
export function pathOf(ts: TypeScriptModule, node: TS.Expression): string | undefined {
  const expression = unwrap(ts, node);
  if (ts.isIdentifier(expression)) return expression.text;
  if (expression.kind === ts.SyntaxKind.ThisKeyword) return 'this';
  if (ts.isPropertyAccessExpression(expression)) {
    const owner = pathOf(ts, expression.expression);
    return owner === undefined
      ? undefined
      : owner === 'this'
        ? expression.name.text
        : `${owner}.${expression.name.text}`;
  }
  // signal() / getter appelé sans argument
  if (ts.isCallExpression(expression) && expression.arguments.length === 0)
    return pathOf(ts, expression.expression);
  return undefined;
}

/** Un sujet d'état par défaut : rôle si le nom le dit, sinon propriété du composant. */
export function defaultSubject(ts: TypeScriptModule, node: TS.Expression): RuleSubject | undefined {
  const path = pathOf(ts, node);
  if (!path || path === 'this') return undefined;
  const name = path.split('.').pop() ?? path;
  return {
    kind: PERMISSION_NAME.test(path) ? 'PERMISSION' : 'STATE',
    name,
    path: path.slice(0, 80),
  };
}

/**
 * Convertit une expression en condition. `resolve` reconnaît les contrôles et les
 * alias (paramètre d'un valueChanges) ; sinon le sujet par défaut s'applique.
 */
export function conditionOf(
  ts: TypeScriptModule,
  node: TS.Expression,
  resolve: SubjectResolver,
): RuleCondition {
  const expression = unwrap(ts, node);
  const subjectOf = (operand: TS.Expression): RuleSubject | undefined =>
    resolve(unwrap(ts, operand)) ?? defaultSubject(ts, operand);
  const opaque = (): RuleCondition => ({
    kind: 'OPAQUE',
    text: expression.getText().replace(/\s+/g, ' ').slice(0, 80),
  });

  if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.ExclamationToken)
    return negate(conditionOf(ts, expression.operand, resolve));

  if (ts.isBinaryExpression(expression)) {
    const kind = expression.operatorToken.kind;
    if (kind === ts.SyntaxKind.AmpersandAmpersandToken || kind === ts.SyntaxKind.BarBarToken) {
      const type = kind === ts.SyntaxKind.AmpersandAmpersandToken ? 'AND' : 'OR';
      const items: RuleCondition[] = [];
      for (const side of [expression.left, expression.right]) {
        const item = conditionOf(ts, side, resolve);
        if (item.kind === type) items.push(...item.items);
        else items.push(item);
      }
      return { kind: type, items };
    }
    const comparison = operators(ts).get(kind);
    if (comparison) {
      const right = literalOf(ts, expression.right);
      const left = literalOf(ts, expression.left);
      const [operand, value, operator] =
        right !== undefined
          ? [expression.left, right, comparison.operator]
          : left !== undefined
            ? [expression.right, left, comparison.flipped]
            : [undefined, undefined, comparison.operator];
      if (operand === undefined) return opaque();
      const subject = subjectOf(operand);
      if (!subject) return opaque();
      // Jamais le littéral comparé à un secret (token === '…') : la condition reste opaque, sans valeur.
      if (SECRET_NAME.test(subject.path ?? subject.name))
        return { kind: 'OPAQUE', text: 'secret comparison' };
      // role === 'ADMIN' : une permission.
      if (
        subject.kind === 'PERMISSION' &&
        typeof value === 'string' &&
        (operator === '==' || operator === '!=')
      )
        return { kind: 'PERMISSION', permission: value, ...(operator === '!=' ? { negated: true } : {}) };
      return { kind: 'COMPARE', subject, operator, value };
    }
    return opaque();
  }

  // hasRole('ADMIN'), auth.hasPermission('users.delete'), roles.includes('ADMIN')
  if (ts.isCallExpression(expression) && ts.isStringLiteral(expression.arguments[0] ?? expression)) {
    const callee = pathOf(ts, expression.expression) ?? '';
    const argument = expression.arguments[0];
    const text = argument && ts.isStringLiteral(argument) ? argument.text : undefined;
    if (
      text &&
      (/(^|\.)(has|is)?(role|permission|authority|access|privilege)s?$/i.test(callee) ||
        /(^|\.)(hasAnyRole|hasRole|hasPermission|hasAuthority|can|isGranted)$/.test(callee))
    )
      return { kind: 'PERMISSION', permission: text };
    if (text && /(roles|permissions|authorities|grants)\.includes$/i.test(callee))
      return { kind: 'PERMISSION', permission: text };
  }

  // form.valid / form.invalid / this.form.valid
  if (ts.isPropertyAccessExpression(expression) && /^(valid|invalid)$/.test(expression.name.text)) {
    const owner = pathOf(ts, expression.expression) ?? 'form';
    return {
      kind: 'FORM_STATE',
      subject: { kind: 'FORM', name: owner.split('.').pop() ?? owner },
      state: expression.name.text === 'valid' ? 'VALID' : 'INVALID',
    };
  }

  const subject = subjectOf(expression);
  if (subject) return { kind: 'FLAG', subject };
  return opaque();
}

/** Une expression de gabarit, lue avec le parseur TypeScript (jamais évaluée). */
export function parseTemplateExpression(ts: TypeScriptModule, text: string): TS.Expression | undefined {
  const source = ts.createSourceFile('template-expression.ts', `(${text});`, ts.ScriptTarget.Latest, true);
  const statement = source.statements[0];
  if (!statement || !ts.isExpressionStatement(statement)) return undefined;
  if ((source as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics?.length) return undefined;
  return unwrap(ts, statement.expression);
}

/** Les sujets FIELD d'une condition (les champs dont elle dépend). */
export function fieldsOf(condition: RuleCondition): string[] {
  switch (condition.kind) {
    case 'COMPARE':
    case 'FLAG':
    case 'CHANGE':
      return condition.subject.kind === 'FIELD' ? [condition.subject.control ?? condition.subject.name] : [];
    case 'AND':
    case 'OR':
      return [...new Set(condition.items.flatMap(fieldsOf))];
    case 'NOT':
      return fieldsOf(condition.item);
    default:
      return [];
  }
}
