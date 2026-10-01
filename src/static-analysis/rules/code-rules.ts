import type * as TS from 'typescript';
import type { StaticValidator } from '../model.js';
import type { TypeScriptModule } from '../typescript-loader.js';
import { conditionOf, negate, pathOf, unwrap } from './condition-parser.js';
import type { RuleCondition, RuleEffect, RuleSubject } from './rule-model.js';

/**
 * RULE CANDIDATE EXTRACTOR (code) : une condition n'est une règle candidate que si elle
 * produit un effet OBSERVABLE ou FONCTIONNEL — validateur, activation, valeur d'un
 * contrôle, calcul, navigation, appel d'API, propriété d'une requête. « if (!response)
 * return; » ne produit rien : c'est une condition technique, jamais une règle.
 */

/** Un effet lu dans le code, avant sa résolution (appel de service → API, collection → options). */
export interface RawRuleEffect extends RuleEffect {
  /** Appel de service (this.provinceService.list) à résoudre en « GET /api/provinces ». */
  serviceCall?: { target: string; method: string; route?: string; httpMethod?: string };
  /** Objet de requête (request.taxNumber = …) : l'appel qui l'envoie est cherché dans la méthode. */
  requestVariable?: string;
}

export interface CodeRuleFact {
  conditions: RuleCondition[];
  /** valueChanges d'un champ ou du formulaire. */
  trigger?: RuleCondition;
  effect: RawRuleEffect;
  method: string;
  /** Ce qui prouve l'effet : « Validators.required », « valueChanges », « router.navigate ». */
  evidence: string;
  line: number;
}

export interface TechnicalCondition {
  text: string;
  line: number;
  method: string;
  /** La condition lue (une garde « if (x > y) throw » devient un invariant candidat). */
  condition?: RuleCondition;
  /** Ce que fait la branche : lever une erreur, sortir, poser une erreur de formulaire, rien. */
  exit?: 'THROW' | 'RETURN' | 'ERROR' | 'NONE';
}

/**
 * Un gestionnaire d'erreur d'un appel d'API (subscribe({ error }), catchError) :
 * statut et code d'erreur attendus, champ marqué en erreur, message affiché.
 */
export interface ErrorHandlerFact {
  origin: { target: string; method: string; route?: string; httpMethod?: string };
  method: string;
  status?: number;
  code?: string;
  control?: string;
  message?: string;
  line: number;
}

export interface CodeRuleFacts {
  rules: CodeRuleFact[];
  technical: TechnicalCondition[];
  errorHandlers?: ErrorHandlerFact[];
}

/** Ce que ts-facts sait déjà lire, prêté à l'extracteur (un seul parseur, un seul moteur). */
export interface CodeRuleHelpers {
  lineOf(node: TS.Node): number;
  /** form.get('x') / form.controls.x → le contrôle. */
  controlRefOf(node: TS.Expression): { form: string; control: string } | undefined;
  /** form.controls.x.value / form.value.x / v.x → le contrôle dont c'est la valeur. */
  controlValueOf(node: TS.Expression): { form: string; control: string } | undefined;
  /** this.form → le nom du formulaire. */
  formRefOf(node: TS.Expression): string | undefined;
  validatorsOf(node: TS.Expression | undefined): StaticValidator[];
  /** this.svc.load(…).pipe(…) → l'appel d'origine d'un Observable. */
  callOriginOf(
    node: TS.Expression,
  ): { target: string; method: string; route?: string; httpMethod?: string } | undefined;
  navigationTargetOf(node: TS.Expression | undefined): string | undefined;
  /** Propriétés de la classe qui portent le Router, HttpClient. */
  routerOwners: Set<string>;
  httpOwners: Set<string>;
  /** Méthodes de la classe (pour suivre this.loadProvinces(country), un niveau). */
  methods: Map<string, TS.Node>;
  /** Contrôles connus des formulaires de la classe. */
  controls: Set<string>;
}

interface WalkContext {
  conditions: RuleCondition[];
  trigger?: RuleCondition;
  /** Paramètre d'un valueChanges → le champ dont il porte la valeur. */
  aliases: Map<string, RuleSubject>;
  /** Paramètre d'un subscribe → l'appel dont il reçoit la réponse. */
  responses: Map<string, NonNullable<RawRuleEffect['serviceCall']>>;
  method: string;
  depth: number;
  visited: Set<string>;
}

const MAX_TECHNICAL = 60;

export function extractCodeRules(
  ts: TypeScriptModule,
  members: readonly { name: string; body: TS.Node }[],
  helpers: CodeRuleHelpers,
): CodeRuleFacts {
  const facts: CodeRuleFacts = { rules: [], technical: [] };
  const assignment = (kind: TS.SyntaxKind): boolean => kind === ts.SyntaxKind.EqualsToken;

  const resolverOf =
    (context: WalkContext) =>
    (node: TS.Expression): RuleSubject | undefined => {
      const expression = unwrap(ts, node);
      if (ts.isIdentifier(expression)) {
        const alias = context.aliases.get(expression.text);
        if (alias) return alias;
      }
      const control = helpers.controlValueOf(expression);
      if (control)
        return {
          kind: 'FIELD',
          name: control.control,
          control: control.control,
          path: pathOf(ts, expression) ?? control.control,
        };
      return undefined;
    };

  const emit = (context: WalkContext, effect: RawRuleEffect, evidence: string, node: TS.Node): boolean => {
    // Sans condition ni déclencheur, seul un calcul est une règle (total = quantité × prix).
    if (context.conditions.length === 0 && !context.trigger && effect.kind !== 'CALCULATE_VALUE')
      return false;
    facts.rules.push({
      conditions: [...context.conditions],
      ...(context.trigger ? { trigger: context.trigger } : {}),
      effect,
      method: context.method,
      evidence,
      line: helpers.lineOf(node),
    });
    return true;
  };

  const fieldTarget = (control: string): RuleEffect['target'] => ({ kind: 'FIELD', name: control, control });

  /** Un calcul : les noms dont il part (contrôles d'abord). */
  const inputsOf = (node: TS.Expression, context: WalkContext): string[] => {
    const inputs = new Set<string>();
    const collect = (child: TS.Node): void => {
      if (ts.isExpression(child)) {
        const subject = resolverOf(context)(child);
        if (subject) {
          inputs.add(subject.control ?? subject.name);
          return;
        }
      }
      if (ts.isPropertyAccessExpression(child) && child.name.text !== 'value') {
        inputs.add(child.name.text);
        return;
      }
      if (
        ts.isIdentifier(child) &&
        !(ts.isPropertyAccessExpression(child.parent) && child.parent.name === child)
      ) {
        inputs.add(child.text);
        return;
      }
      ts.forEachChild(child, collect);
    };
    collect(node);
    return [...inputs].filter((name) => !/^(Math|Number|this)$/.test(name)).slice(0, 8);
  };

  const isArithmetic = (node: TS.Expression): boolean => {
    const expression = unwrap(ts, node);
    return (
      ts.isBinaryExpression(expression) &&
      [
        ts.SyntaxKind.AsteriskToken,
        ts.SyntaxKind.PlusToken,
        ts.SyntaxKind.MinusToken,
        ts.SyntaxKind.SlashToken,
        ts.SyntaxKind.PercentToken,
      ].includes(expression.operatorToken.kind) &&
      !ts.isStringLiteral(unwrap(ts, expression.left)) &&
      !ts.isStringLiteral(unwrap(ts, expression.right))
    );
  };

  const literalOf = (node: TS.Expression): string | number | boolean | null | undefined => {
    const expression = unwrap(ts, node);
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression))
      return expression.text;
    if (ts.isNumericLiteral(expression)) return Number(expression.text);
    if (expression.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (expression.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (expression.kind === ts.SyntaxKind.NullKeyword) return null;
    return undefined;
  };

  /** Effet d'une affectation de valeur à un contrôle (setValue / patchValue sur un contrôle). */
  const valueEffect = (
    control: string,
    value: TS.Expression,
    context: WalkContext,
  ): RawRuleEffect | undefined => {
    const literal = literalOf(value);
    if (literal !== undefined) return { kind: 'SET_VALUE', target: fieldTarget(control), value: literal };
    if (isArithmetic(value))
      return { kind: 'CALCULATE_VALUE', target: fieldTarget(control), inputs: inputsOf(value, context) };
    return undefined;
  };

  const callbackOf = (
    node: TS.Expression | undefined,
  ): TS.ArrowFunction | TS.FunctionExpression | undefined => {
    if (!node) return undefined;
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return node;
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties)
        if (
          ts.isPropertyAssignment(property) &&
          ts.isIdentifier(property.name) &&
          property.name.text === 'next'
        )
          return callbackOf(property.initializer);
    }
    return undefined;
  };

  /** X.valueChanges (éventuellement .pipe(…)) → le contrôle ou le formulaire observé. */
  const valueChangesOf = (node: TS.Expression): { control?: string; form?: string } | undefined => {
    let expression = unwrap(ts, node);
    while (
      ts.isCallExpression(expression) &&
      ts.isPropertyAccessExpression(expression.expression) &&
      expression.expression.name.text === 'pipe'
    )
      expression = unwrap(ts, expression.expression.expression);
    if (!ts.isPropertyAccessExpression(expression) || expression.name.text !== 'valueChanges')
      return undefined;
    const owner = expression.expression;
    const control = helpers.controlRefOf(owner);
    if (control) return { control: control.control };
    const form = helpers.formRefOf(owner);
    if (form) return { form };
    // this.country.valueChanges (getter nommé comme le contrôle)
    const name = pathOf(ts, owner)?.split('.').pop();
    if (name && helpers.controls.has(name)) return { control: name };
    return undefined;
  };

  /** subscribe(next, error) / subscribe({ error }) → le gestionnaire d'erreur. */
  const errorCallbackOf = (
    args: TS.NodeArray<TS.Expression>,
  ): TS.ArrowFunction | TS.FunctionExpression | undefined => {
    const second = args[1];
    if (second && (ts.isArrowFunction(second) || ts.isFunctionExpression(second))) return second;
    const first = args[0];
    if (first && ts.isObjectLiteralExpression(first))
      for (const property of first.properties)
        if (
          ts.isPropertyAssignment(property) &&
          ts.isIdentifier(property.name) &&
          property.name.text === 'error' &&
          (ts.isArrowFunction(property.initializer) || ts.isFunctionExpression(property.initializer))
        )
          return property.initializer;
    return undefined;
  };

  /**
   * ERROR PATH (code) : dans le gestionnaire d'erreur, « if (e.status === 409) » ou
   * « e.error.code === 'EMAIL_EXISTS' », puis le champ marqué (setErrors) ou le message posé.
   */
  const scanErrorHandler = (
    callback: TS.ArrowFunction | TS.FunctionExpression,
    origin: ErrorHandlerFact['origin'],
    method: string,
  ): void => {
    const parameter = callback.parameters[0];
    const name = parameter && ts.isIdentifier(parameter.name) ? parameter.name.text : undefined;
    if (!name) return;
    const handlers: ErrorHandlerFact[] = (facts.errorHandlers ??= []);
    const statusPattern = new RegExp(`\\b${name}\\??\\.status\\s*===?\\s*(\\d{3})`);
    const codePattern = new RegExp(
      `\\b${name}\\??\\.error\\??\\.(?:code|errorCode|error|type)\\s*===?\\s*['"]([A-Za-z0-9_.-]{2,60})['"]`,
    );
    const visit = (node: TS.Node, scope: { status?: number; code?: string }): void => {
      if (ts.isIfStatement(node)) {
        const text = node.expression.getText();
        const status = statusPattern.exec(text)?.[1];
        const code = codePattern.exec(text)?.[1];
        visit(node.thenStatement, {
          ...scope,
          ...(status ? { status: Number(status) } : {}),
          ...(code ? { code } : {}),
        });
        if (node.elseStatement) visit(node.elseStatement, scope);
        return;
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'setErrors'
      ) {
        const control =
          helpers.controlRefOf(node.expression.expression)?.control ??
          controlNamed(node.expression.expression);
        if (handlers.length < 40)
          handlers.push({
            origin,
            method,
            ...scope,
            ...(control ? { control } : {}),
            line: helpers.lineOf(node),
          });
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(node.left) &&
        node.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
        /(error|message|alert)/i.test(node.left.name.text)
      ) {
        const right = unwrap(ts, node.right);
        const message =
          ts.isStringLiteral(right) || ts.isNoSubstitutionTemplateLiteral(right)
            ? right.text.slice(0, 120)
            : undefined;
        if (handlers.length < 40)
          handlers.push({
            origin,
            method,
            ...scope,
            ...(message ? { message } : {}),
            line: helpers.lineOf(node),
          });
      }
      ts.forEachChild(node, (child) => {
        visit(child, scope);
      });
    };
    visit(callback.body, {});
  };

  const walk = (node: TS.Node, context: WalkContext): number => {
    // ---- if (condition) { effets } else { effets }
    if (ts.isIfStatement(node)) {
      const condition = conditionOf(ts, node.expression, resolverOf(context));
      const thenCount = walk(node.thenStatement, {
        ...context,
        conditions: [...context.conditions, condition],
      });
      const elseCount = node.elseStatement
        ? walk(node.elseStatement, { ...context, conditions: [...context.conditions, negate(condition)] })
        : 0;
      if (thenCount + elseCount === 0 && facts.technical.length < MAX_TECHNICAL) {
        const branch = node.thenStatement.getText();
        const exit = /\bthrow\b/.test(branch)
          ? 'THROW'
          : /\.setErrors\s*\(/.test(branch)
            ? 'ERROR'
            : /\breturn\b/.test(branch)
              ? 'RETURN'
              : 'NONE';
        facts.technical.push({
          text: node.expression.getText().replace(/\s+/g, ' ').slice(0, 80),
          line: helpers.lineOf(node),
          method: context.method,
          condition,
          exit,
        });
      }
      return thenCount + elseCount;
    }

    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const callee = node.expression;
      const name = callee.name.text;
      const owner = callee.expression;

      // ---- X.valueChanges.subscribe((v) => …) : un déclencheur.
      if (name === 'subscribe') {
        const changes = valueChangesOf(owner);
        const callback = callbackOf(node.arguments[0]);
        if (changes && callback) {
          const subject: RuleSubject = changes.control
            ? { kind: 'FIELD', name: changes.control, control: changes.control }
            : { kind: 'FORM', name: changes.form ?? 'form' };
          const aliases = new Map(context.aliases);
          const parameter = callback.parameters[0];
          if (parameter && ts.isIdentifier(parameter.name) && changes.control)
            aliases.set(parameter.name.text, subject);
          return walk(callback.body, { ...context, trigger: { kind: 'CHANGE', subject }, aliases });
        }
        // ---- this.svc.load(x).subscribe((data) => …) : un appel d'API, puis ce que fait sa réponse.
        const origin = helpers.callOriginOf(owner);
        let count = 0;
        if (origin && !helpers.routerOwners.has(origin.target)) {
          if (
            emit(
              context,
              {
                kind: 'API_REQUEST_EXPECTED',
                target: { kind: 'API', name: `${origin.target}.${origin.method}` },
                serviceCall: origin,
              },
              'API call',
              node,
            )
          )
            count += 1;
          if (callback) {
            const responses = new Map(context.responses);
            const parameter = callback.parameters[0];
            if (parameter && ts.isIdentifier(parameter.name)) responses.set(parameter.name.text, origin);
            count += walk(callback.body, { ...context, responses });
          }
          const onError = errorCallbackOf(node.arguments);
          if (onError) scanErrorHandler(onError, origin, context.method);
          return count;
        }
      }

      // ---- validateurs : addValidators / setValidators / clearValidators / removeValidators
      if (/^(addValidators|setValidators|clearValidators|removeValidators)$/.test(name)) {
        const control = helpers.controlRefOf(owner)?.control ?? controlNamed(owner);
        if (control) {
          const validators = helpers.validatorsOf(node.arguments[0]);
          let count = 0;
          if (name === 'clearValidators') {
            if (emit(context, { kind: 'OPTIONAL', target: fieldTarget(control) }, 'clearValidators()', node))
              count += 1;
          } else if (name === 'removeValidators') {
            if (validators.some((validator) => validator.kind === 'required'))
              if (
                emit(
                  context,
                  { kind: 'OPTIONAL', target: fieldTarget(control) },
                  'removeValidators(Validators.required)',
                  node,
                )
              )
                count += 1;
          } else
            for (const validator of validators) {
              const effect: RawRuleEffect =
                validator.kind === 'required' || validator.kind === 'requiredTrue'
                  ? { kind: 'REQUIRED', target: fieldTarget(control) }
                  : {
                      kind: 'ADD_VALIDATOR',
                      target: fieldTarget(control),
                      validator:
                        validator.value === undefined
                          ? validator.kind
                          : `${validator.kind}(${String(validator.value)})`,
                    };
              if (emit(context, effect, `${name}(Validators.${validator.kind})`, node)) count += 1;
            }
          return count;
        }
      }

      // ---- enable() / disable()
      if ((name === 'enable' || name === 'disable') && node.arguments.length <= 1) {
        const control = helpers.controlRefOf(owner)?.control ?? controlNamed(owner);
        if (control)
          return emit(
            context,
            { kind: name === 'enable' ? 'ENABLE' : 'DISABLE', target: fieldTarget(control) },
            `${name}()`,
            node,
          )
            ? 1
            : 0;
      }

      // ---- setValue / patchValue : un contrôle, ou le formulaire avec un objet
      if (name === 'setValue' || name === 'patchValue') {
        const argument = node.arguments[0];
        const control = helpers.controlRefOf(owner)?.control ?? controlNamed(owner);
        if (control && argument) {
          const effect = valueEffect(control, argument, context);
          return effect && emit(context, effect, `${name}()`, node) ? 1 : 0;
        }
        if (helpers.formRefOf(owner) && argument && ts.isObjectLiteralExpression(argument)) {
          let count = 0;
          for (const property of argument.properties) {
            if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue;
            const effect = valueEffect(property.name.text, property.initializer, context);
            if (effect && emit(context, effect, `${name}()`, node)) count += 1;
          }
          return count;
        }
      }

      // ---- router.navigate([...])
      if (/^navigate(ByUrl)?$/.test(name)) {
        const ownerName = pathOf(ts, owner)?.split('.').pop();
        if (ownerName && helpers.routerOwners.has(ownerName)) {
          const target = helpers.navigationTargetOf(node.arguments[0]);
          if (target)
            return emit(
              context,
              { kind: 'ALLOW_NAVIGATION', target: { kind: 'ROUTE', name: target } },
              'router.navigate',
              node,
            )
              ? 1
              : 0;
        }
      }

      // ---- this.loadProvinces(country) : la méthode de la classe, suivie (un niveau).
      if (
        owner.kind === ts.SyntaxKind.ThisKeyword &&
        helpers.methods.has(name) &&
        context.depth < 2 &&
        !context.visited.has(name)
      ) {
        const body = helpers.methods.get(name);
        if (body) {
          const visited = new Set(context.visited).add(name);
          return walk(body, { ...context, depth: context.depth + 1, visited, method: context.method });
        }
      }

      // ---- this.svc.save(request) sans subscribe, sous condition : un appel attendu.
      const ownerName = pathOf(ts, owner);
      if (
        ownerName &&
        !ownerName.includes('.') &&
        (context.conditions.length > 0 || context.trigger) &&
        !helpers.routerOwners.has(ownerName) &&
        !helpers.httpOwners.has(ownerName) &&
        !helpers.controls.has(ownerName) &&
        !helpers.formRefOf(owner) &&
        owner.kind !== ts.SyntaxKind.ThisKeyword &&
        ts.isPropertyAccessExpression(owner) &&
        owner.expression.kind === ts.SyntaxKind.ThisKeyword &&
        !(ts.isPropertyAccessExpression(node.parent) && node.parent.name.text === 'subscribe')
      ) {
        let count = 0;
        const parentCall =
          ts.isPropertyAccessExpression(node.parent) && ts.isCallExpression(node.parent.parent)
            ? node.parent.parent
            : undefined;
        if (!parentCall)
          if (
            emit(
              context,
              {
                kind: 'API_REQUEST_EXPECTED',
                target: { kind: 'API', name: `${ownerName}.${name}` },
                serviceCall: { target: ownerName, method: name },
              },
              'service call',
              node,
            )
          )
            count += 1;
        ts.forEachChild(node, (child) => {
          count += walk(child, context);
        });
        return count;
      }
    }

    // ---- affectations
    if (ts.isBinaryExpression(node) && assignment(node.operatorToken.kind)) {
      const left = node.left;
      const right = node.right;
      if (ts.isPropertyAccessExpression(left)) {
        const property = left.name.text;
        // this.x = …
        if (left.expression.kind === ts.SyntaxKind.ThisKeyword) {
          const rightExpression = unwrap(ts, right);
          // this.provinces = provinces (réponse d'un appel) : des données d'options, résolues avec le gabarit.
          if (ts.isIdentifier(rightExpression) && context.responses.has(rightExpression.text)) {
            const origin = context.responses.get(rightExpression.text);
            return emit(
              context,
              {
                kind: 'SET_OPTIONS',
                target: { kind: 'STATE', name: property },
                ...(origin ? { serviceCall: origin } : {}),
              },
              'response stored for the template',
              node,
            )
              ? 1
              : 0;
          }
          if (isArithmetic(right))
            return emit(
              context,
              {
                kind: 'CALCULATE_VALUE',
                target: { kind: 'STATE', name: property },
                inputs: inputsOf(right, context),
              },
              'calculation',
              node,
            )
              ? 1
              : 0;
          const literal = literalOf(right);
          // Un indicateur technique (loading, submitted) n'est pas un effet métier.
          if (
            literal !== undefined &&
            !/^(loading|busy|submitted|saving|pending|isLoading|isSaving|error)$/i.test(property)
          )
            return emit(
              context,
              { kind: 'SET_VALUE', target: { kind: 'STATE', name: property }, value: literal },
              'assignment',
              node,
            )
              ? 1
              : 0;
        } else if (ts.isIdentifier(left.expression)) {
          // request.taxNumber = this.form.controls.companyNumber.value (sous condition) : envoyé à l'API.
          const control = helpers.controlValueOf(unwrap(ts, right));
          if (control)
            return emit(
              context,
              {
                kind: 'INCLUDE_IN_REQUEST',
                target: fieldTarget(control.control),
                requestVariable: left.expression.text,
              },
              `${left.expression.text}.${property} = form value`,
              node,
            )
              ? 1
              : 0;
        }
      }
    }

    let count = 0;
    ts.forEachChild(node, (child) => {
      count += walk(child, context);
    });
    return count;
  };

  /** this.country (getter du contrôle country), ou une variable nommée comme un contrôle. */
  const controlNamed = (node: TS.Expression): string | undefined => {
    const name = pathOf(ts, node)?.split('.').pop();
    return name && helpers.controls.has(name) ? name : undefined;
  };

  for (const member of members)
    walk(member.body, {
      conditions: [],
      aliases: new Map(),
      responses: new Map(),
      method: member.name,
      depth: 0,
      visited: new Set([member.name]),
    });
  return facts;
}
