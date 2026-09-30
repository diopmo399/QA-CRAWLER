import type * as TS from 'typescript';
import type { HttpMethod, StaticValidator, StaticValidatorKind } from './model.js';
import { SECRET_NAME } from './sanitize.js';
import type { TypeScriptModule } from './typescript-loader.js';

/**
 * Les FAITS d'un fichier TypeScript / JavaScript, lus dans l'AST du compilateur (un
 * seul parcours par fichier) : routes, composants, formulaires et validateurs, appels
 * HTTP, DTO, objets de requête construits depuis un formulaire, appels de service,
 * navigations. Aucune évaluation : seuls les littéraux et les noms sont lus. Ce qui
 * n'est pas une forme simple et déterministe devient UNRESOLVED_DATA_FLOW, jamais
 * une supposition.
 */

export interface RouteLiteral {
  path: string;
  component?: string;
  redirectTo?: string;
  lazy?: { specifier: string; exportName?: string };
  guards: string[];
  children: RouteLiteral[];
  line: number;
}

export interface RouteArrayFact {
  /** Nom de la variable (export const ADMIN_ROUTES = [...]) ; absent pour un tableau en argument. */
  variable?: string;
  routes: RouteLiteral[];
  line: number;
}

export interface FormControlFact {
  name: string;
  validators: StaticValidator[];
  line: number;
}

export interface FormFact {
  property: string;
  controls: FormControlFact[];
  line: number;
}

/** Une propriété d'objet de requête alimentée par un contrôle de formulaire. */
export interface RequestMapping {
  property: string;
  control: string;
  form: string;
}

export interface RequestObjectFact {
  variable?: string;
  type?: string;
  mappings: RequestMapping[];
  /** ...this.form.value : chaque contrôle devient la propriété de même nom. */
  spreadForms: string[];
  unresolved: string[];
  line: number;
}

export type ArgumentFact =
  { kind: 'variable'; name: string } | { kind: 'object'; request: RequestObjectFact } | { kind: 'other' };

export interface ServiceCallFact {
  /** Propriété de la classe qui porte le service (this.userService). */
  target: string;
  method: string;
  args: ArgumentFact[];
  line: number;
}

export interface HttpCallFact {
  method: HttpMethod;
  route: string;
  /** Paramètre ou variable passé comme corps. */
  body?: string;
  bodyRequest?: RequestObjectFact;
  responseType?: string;
  line: number;
}

export interface MethodFact {
  name: string;
  params: { name: string; type?: string }[];
  httpCalls: HttpCallFact[];
  requests: RequestObjectFact[];
  serviceCalls: ServiceCallFact[];
  navigations: { target: string; line: number }[];
  line: number;
}

export interface ClassFact {
  name: string;
  decorator?: string;
  selector?: string;
  templateUrl?: string;
  inlineTemplate?: { text: string; line: number };
  injected: Record<string, string>;
  forms: FormFact[];
  methods: MethodFact[];
  line: number;
}

export interface DtoFact {
  name: string;
  properties: { name: string; type?: string; optional: boolean }[];
  line: number;
}

export interface FileFacts {
  file: string;
  imports: string[];
  classes: ClassFact[];
  routeArrays: RouteArrayFact[];
  dtos: DtoFact[];
  nodes: number;
}

export class AstBudgetExceeded extends Error {
  constructor() {
    super('STATIC_ANALYSIS_BUDGET_EXHAUSTED: too many AST nodes');
    this.name = 'AstBudgetExceeded';
  }
}

const HTTP_METHODS: Record<string, HttpMethod> = {
  get: 'GET',
  post: 'POST',
  put: 'PUT',
  patch: 'PATCH',
  delete: 'DELETE',
};
const BODY_METHODS = new Set(['post', 'put', 'patch']);
const VALIDATOR_KINDS = new Set<StaticValidatorKind>([
  'required',
  'email',
  'min',
  'max',
  'minLength',
  'maxLength',
  'pattern',
  'requiredTrue',
]);
const DTO_NAME = /(Request|Dto|DTO|Command|Payload|Body|Input|Model)$/;

export function extractFacts(
  ts: TypeScriptModule,
  file: string,
  text: string,
  nodeBudget: { remaining: number },
): FileFacts {
  const kind = /\.(tsx|jsx)$/.test(file)
    ? ts.ScriptKind.TSX
    : /\.(js|mjs)$/.test(file)
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const facts: FileFacts = { file, imports: [], classes: [], routeArrays: [], dtos: [], nodes: 0 };
  const lineOf = (node: TS.Node): number =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const count = (): void => {
    facts.nodes += 1;
    if (--nodeBudget.remaining < 0) throw new AstBudgetExceeded();
  };
  const nameOf = (name: TS.PropertyName | TS.BindingName | undefined): string | undefined => {
    if (!name) return undefined;
    if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
    if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
    return undefined;
  };
  const stringOf = (node: TS.Expression | undefined): string | undefined => {
    if (!node) return undefined;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    return undefined;
  };
  const typeName = (type: TS.TypeNode | undefined): string | undefined => {
    if (!type) return undefined;
    if (ts.isTypeReferenceNode(type)) return type.typeName.getText(source);
    if (ts.isArrayTypeNode(type)) return `${typeName(type.elementType) ?? 'unknown'}[]`;
    return type.getText(source);
  };

  // ---------------------------------------------------------------- routes
  const isRouteObject = (node: TS.Node): node is TS.ObjectLiteralExpression =>
    ts.isObjectLiteralExpression(node) &&
    node.properties.some(
      (property) =>
        ts.isPropertyAssignment(property) &&
        nameOf(property.name) === 'path' &&
        stringOf(property.initializer) !== undefined,
    );
  const isRouteArray = (node: TS.Node): node is TS.ArrayLiteralExpression =>
    ts.isArrayLiteralExpression(node) && node.elements.length > 0 && node.elements.some(isRouteObject);
  const routeOf = (object: TS.ObjectLiteralExpression): RouteLiteral => {
    const route: RouteLiteral = { path: '', guards: [], children: [], line: lineOf(object) };
    for (const property of object.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const key = nameOf(property.name);
      const value = property.initializer;
      if (key === 'path') route.path = stringOf(value) ?? '';
      else if (key === 'component' && ts.isIdentifier(value)) route.component = value.text;
      else if (key === 'redirectTo') {
        const target = stringOf(value);
        if (target !== undefined) route.redirectTo = target;
      } else if (key === 'loadChildren' || key === 'loadComponent') {
        const lazy = lazyOf(value);
        if (lazy) route.lazy = lazy;
      } else if (key && /^can(Activate|Match|Load|ActivateChild|Deactivate)$/.test(key)) {
        if (ts.isArrayLiteralExpression(value))
          for (const guard of value.elements) route.guards.push(guard.getText(source).slice(0, 80));
      } else if (key === 'children' && ts.isArrayLiteralExpression(value)) {
        for (const child of value.elements) if (isRouteObject(child)) route.children.push(routeOf(child));
      }
    }
    return route;
  };
  /** () => import('./admin/admin.routes').then((m) => m.ADMIN_ROUTES) */
  const lazyOf = (node: TS.Expression): RouteLiteral['lazy'] => {
    let specifier: string | undefined;
    let exportName: string | undefined;
    const visit = (child: TS.Node): void => {
      if (
        ts.isCallExpression(child) &&
        child.expression.kind === ts.SyntaxKind.ImportKeyword &&
        child.arguments[0]
      )
        specifier = stringOf(child.arguments[0]);
      if (ts.isPropertyAccessExpression(child) && ts.isIdentifier(child.name) && specifier)
        exportName = child.name.text;
      ts.forEachChild(child, visit);
    };
    visit(node);
    return specifier ? { specifier, ...(exportName ? { exportName } : {}) } : undefined;
  };

  // ---------------------------------------------------------------- validators
  const validatorsOf = (node: TS.Expression | undefined): StaticValidator[] => {
    if (!node) return [];
    const list = ts.isArrayLiteralExpression(node) ? [...node.elements] : [node];
    const validators: StaticValidator[] = [];
    for (const element of list) {
      // Validators.required / Validators.maxLength(100) / Validators.pattern('^[0-9]+$')
      const call = ts.isCallExpression(element) ? element : undefined;
      const access = call ? call.expression : element;
      if (!ts.isPropertyAccessExpression(access)) continue;
      if (access.expression.getText(source) !== 'Validators') continue;
      const kind = access.name.text as StaticValidatorKind;
      if (!VALIDATOR_KINDS.has(kind)) continue;
      const argument = call?.arguments[0];
      let value: string | number | undefined;
      if (argument && ts.isNumericLiteral(argument)) value = Number(argument.text);
      else if (argument && ts.isRegularExpressionLiteral(argument)) value = argument.text;
      else value = stringOf(argument);
      validators.push({ kind, ...(value !== undefined ? { value } : {}) });
    }
    return validators;
  };
  /** Un contrôle : ['', [Validators…]], new FormControl('', …), fb.control('', …), { value, validators } */
  const controlOf = (name: string, initializer: TS.Expression, line: number): FormControlFact => {
    if (ts.isArrayLiteralExpression(initializer))
      return { name, validators: validatorsOf(initializer.elements[1]), line };
    if (
      (ts.isNewExpression(initializer) && /FormControl$/.test(initializer.expression.getText(source))) ||
      (ts.isCallExpression(initializer) && /\.control$/.test(initializer.expression.getText(source)))
    ) {
      const options = initializer.arguments?.[1];
      if (options && ts.isObjectLiteralExpression(options)) {
        const validators = options.properties.find(
          (property): property is TS.PropertyAssignment =>
            ts.isPropertyAssignment(property) && nameOf(property.name) === 'validators',
        );
        return { name, validators: validatorsOf(validators?.initializer), line };
      }
      return { name, validators: validatorsOf(options), line };
    }
    return { name, validators: [], line };
  };
  /** fb.group({…}) / fb.nonNullable.group({…}) / new FormGroup({…}) → ses contrôles. */
  const formOf = (node: TS.Expression): FormControlFact[] | undefined => {
    let object: TS.Expression | undefined;
    if (ts.isCallExpression(node) && /\.group$/.test(node.expression.getText(source)))
      object = node.arguments[0];
    else if (ts.isNewExpression(node) && /FormGroup$/.test(node.expression.getText(source)))
      object = node.arguments?.[0];
    if (!object || !ts.isObjectLiteralExpression(object)) return undefined;
    const controls: FormControlFact[] = [];
    for (const property of object.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const name = nameOf(property.name);
      if (name) controls.push(controlOf(name, property.initializer, lineOf(property)));
    }
    return controls;
  };

  // ---------------------------------------------------------------- data flow
  interface FlowScope {
    forms: Set<string>;
    /** Variable locale = valeur du formulaire (const v = this.form.value). */
    formValues: Map<string, string>;
    /** Variable locale = valeur d'un contrôle (const { email } = this.form.value). */
    controlValues: Map<string, { form: string; control: string }>;
  }
  const formRef = (node: TS.Expression, scope: FlowScope): string | undefined => {
    // this.form / form
    const text = node.getText(source);
    const name = text.replace(/^this\./, '');
    if (!/^[\w$]+$/.test(name)) return undefined;
    if (scope.forms.has(name) || /form/i.test(name)) return name;
    return undefined;
  };
  /** La valeur d'un contrôle, ou undefined si l'expression n'est pas une forme reconnue. */
  const controlValueOf = (
    node: TS.Expression,
    scope: FlowScope,
  ): { form: string; control: string } | undefined => {
    let expression = node;
    while (ts.isNonNullExpression(expression) || ts.isParenthesizedExpression(expression))
      expression = expression.expression;
    if (ts.isIdentifier(expression)) return scope.controlValues.get(expression.text);
    // X.value  (X = this.form.controls.c | this.form.controls['c'] | this.form.get('c'))
    if (ts.isPropertyAccessExpression(expression) && expression.name.text === 'value') {
      let owner: TS.Expression = expression.expression;
      while (ts.isNonNullExpression(owner)) owner = owner.expression;
      if (ts.isPropertyAccessExpression(owner) && ts.isPropertyAccessExpression(owner.expression)) {
        if (owner.expression.name.text === 'controls') {
          const form = formRef(owner.expression.expression, scope);
          if (form) return { form, control: owner.name.text };
        }
      }
      if (
        ts.isElementAccessExpression(owner) &&
        ts.isPropertyAccessExpression(owner.expression) &&
        owner.expression.name.text === 'controls'
      ) {
        const form = formRef(owner.expression.expression, scope);
        const control = stringOf(owner.argumentExpression);
        if (form && control) return { form, control };
      }
      if (
        ts.isCallExpression(owner) &&
        ts.isPropertyAccessExpression(owner.expression) &&
        owner.expression.name.text === 'get'
      ) {
        const form = formRef(owner.expression.expression, scope);
        const control = stringOf(owner.arguments[0]);
        if (form && control) return { form, control };
      }
    }
    // this.form.value.email / this.form.getRawValue().email / v.email
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
      const control = ts.isPropertyAccessExpression(expression)
        ? expression.name.text
        : stringOf(expression.argumentExpression);
      const holder = formValueOf(expression.expression, scope);
      if (holder && control) return { form: holder, control };
    }
    return undefined;
  };
  /** this.form.value / this.form.getRawValue() / une variable qui les contient → le formulaire. */
  const formValueOf = (node: TS.Expression, scope: FlowScope): string | undefined => {
    let expression = node;
    while (ts.isNonNullExpression(expression) || ts.isParenthesizedExpression(expression))
      expression = expression.expression;
    if (ts.isIdentifier(expression)) return scope.formValues.get(expression.text);
    if (ts.isPropertyAccessExpression(expression) && expression.name.text === 'value')
      return formRef(expression.expression, scope);
    if (
      ts.isCallExpression(expression) &&
      ts.isPropertyAccessExpression(expression.expression) &&
      expression.expression.name.text === 'getRawValue'
    )
      return formRef(expression.expression.expression, scope);
    return undefined;
  };
  const requestOf = (
    object: TS.ObjectLiteralExpression,
    scope: FlowScope,
    variable?: string,
    type?: string,
  ): RequestObjectFact | undefined => {
    const request: RequestObjectFact = {
      ...(variable ? { variable } : {}),
      ...(type ? { type } : {}),
      mappings: [],
      spreadForms: [],
      unresolved: [],
      line: lineOf(object),
    };
    for (const property of object.properties) {
      if (ts.isSpreadAssignment(property)) {
        const form = formValueOf(property.expression, scope);
        if (form) request.spreadForms.push(form);
        continue;
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        const value = scope.controlValues.get(property.name.text);
        if (value) request.mappings.push({ property: property.name.text, ...value });
        continue;
      }
      if (!ts.isPropertyAssignment(property)) continue;
      if (ts.isComputedPropertyName(property.name)) {
        request.unresolved.push('computed property name');
        continue;
      }
      const name = nameOf(property.name);
      if (!name) continue;
      const value = controlValueOf(property.initializer, scope);
      if (value) request.mappings.push({ property: name, ...value });
      else if (/form/i.test(property.initializer.getText(source)) && !SECRET_NAME.test(name))
        // Une valeur du formulaire passée par une transformation non suivie.
        request.unresolved.push(`${name}: transformed form value`);
    }
    return request.mappings.length > 0 || request.spreadForms.length > 0 || request.unresolved.length > 0
      ? request
      : undefined;
  };

  // ---------------------------------------------------------------- classes
  const classOf = (node: TS.ClassDeclaration): ClassFact | undefined => {
    const name = node.name?.text;
    if (!name) return undefined;
    const fact: ClassFact = { name, injected: {}, forms: [], methods: [], line: lineOf(node) };
    const decorators = ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [];
    for (const decorator of decorators) {
      if (!ts.isCallExpression(decorator.expression)) continue;
      const decoratorName = decorator.expression.expression.getText(source);
      fact.decorator = decoratorName;
      const options = decorator.expression.arguments[0];
      if (decoratorName === 'Component' && options && ts.isObjectLiteralExpression(options))
        for (const property of options.properties) {
          if (!ts.isPropertyAssignment(property)) continue;
          const key = nameOf(property.name);
          const value = stringOf(property.initializer);
          if (key === 'selector' && value) fact.selector = value;
          else if (key === 'templateUrl' && value) fact.templateUrl = value;
          else if (key === 'template' && value !== undefined)
            fact.inlineTemplate = { text: value, line: lineOf(property.initializer) };
        }
    }
    // Injection : constructeur (private x: X) et inject(X).
    for (const member of node.members) {
      if (ts.isConstructorDeclaration(member))
        for (const parameter of member.parameters) {
          const parameterName = nameOf(parameter.name);
          const type = typeName(parameter.type);
          if (parameterName && type) fact.injected[parameterName] = type;
        }
      if (ts.isPropertyDeclaration(member) && member.initializer) {
        const propertyName = nameOf(member.name);
        if (!propertyName) continue;
        if (
          ts.isCallExpression(member.initializer) &&
          member.initializer.expression.getText(source) === 'inject' &&
          member.initializer.arguments[0]
        )
          fact.injected[propertyName] = member.initializer.arguments[0].getText(source);
        const controls = formOf(member.initializer);
        if (controls) fact.forms.push({ property: propertyName, controls, line: lineOf(member) });
      }
    }
    // Formulaires assignés : this.form = this.fb.group({...})
    const assignForms = (body: TS.Node): void => {
      const visit = (child: TS.Node): void => {
        count();
        if (
          ts.isBinaryExpression(child) &&
          child.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isPropertyAccessExpression(child.left) &&
          child.left.expression.kind === ts.SyntaxKind.ThisKeyword
        ) {
          const controls = formOf(child.right);
          if (controls) fact.forms.push({ property: child.left.name.text, controls, line: lineOf(child) });
        }
        ts.forEachChild(child, visit);
      };
      visit(body);
    };
    for (const member of node.members)
      if ((ts.isConstructorDeclaration(member) || ts.isMethodDeclaration(member)) && member.body)
        assignForms(member.body);

    const formNames = new Set(fact.forms.map((form) => form.property));
    const httpOwners = new Set(
      Object.entries(fact.injected)
        .filter(([property, type]) => type === 'HttpClient' || /^http/i.test(property))
        .map(([property]) => property),
    );
    const routerOwners = new Set(
      Object.entries(fact.injected)
        .filter(([property, type]) => type === 'Router' || /^router$/i.test(property))
        .map(([property]) => property),
    );
    for (const member of node.members) {
      if (!(ts.isMethodDeclaration(member) || ts.isPropertyDeclaration(member))) continue;
      const methodName = nameOf(member.name);
      const body = ts.isMethodDeclaration(member)
        ? member.body
        : member.initializer &&
            (ts.isArrowFunction(member.initializer) || ts.isFunctionExpression(member.initializer))
          ? member.initializer.body
          : undefined;
      if (!methodName || !body) continue;
      const parameters = ts.isMethodDeclaration(member)
        ? member.parameters
        : (member.initializer as TS.ArrowFunction).parameters;
      fact.methods.push(
        methodOf(methodName, parameters, body, lineOf(member), formNames, httpOwners, routerOwners),
      );
    }
    return fact;
  };

  const methodOf = (
    name: string,
    parameters: TS.NodeArray<TS.ParameterDeclaration>,
    body: TS.Node,
    line: number,
    forms: Set<string>,
    httpOwners: Set<string>,
    routerOwners: Set<string>,
  ): MethodFact => {
    const method: MethodFact = {
      name,
      params: parameters.flatMap((parameter) => {
        const parameterName = nameOf(parameter.name);
        const type = typeName(parameter.type);
        return parameterName ? [{ name: parameterName, ...(type ? { type } : {}) }] : [];
      }),
      httpCalls: [],
      requests: [],
      serviceCalls: [],
      navigations: [],
      line,
    };
    const scope: FlowScope = { forms, formValues: new Map(), controlValues: new Map() };
    const argumentOf = (argument: TS.Expression): ArgumentFact => {
      if (ts.isIdentifier(argument)) return { kind: 'variable', name: argument.text };
      if (ts.isObjectLiteralExpression(argument)) {
        const request = requestOf(argument, scope);
        return request ? { kind: 'object', request } : { kind: 'other' };
      }
      // this.form.value / this.form.getRawValue() passé directement
      const form = formValueOf(argument, scope);
      if (form)
        return {
          kind: 'object',
          request: { mappings: [], spreadForms: [form], unresolved: [], line: lineOf(argument) },
        };
      return { kind: 'other' };
    };
    const visit = (node: TS.Node): void => {
      count();
      if (ts.isVariableDeclaration(node) && node.initializer) {
        // const request: CreateUserRequest = { email: this.form.controls.contact.value }
        if (ts.isIdentifier(node.name) && ts.isObjectLiteralExpression(node.initializer)) {
          const request = requestOf(node.initializer, scope, node.name.text, typeName(node.type));
          if (request) method.requests.push(request);
        }
        // const v = this.form.value
        if (ts.isIdentifier(node.name)) {
          const form = formValueOf(node.initializer, scope);
          if (form) scope.formValues.set(node.name.text, form);
          const control = controlValueOf(node.initializer, scope);
          if (control) scope.controlValues.set(node.name.text, control);
        }
        // const { email, phone: tel } = this.form.value
        if (ts.isObjectBindingPattern(node.name)) {
          const form = formValueOf(node.initializer, scope);
          if (form)
            for (const element of node.name.elements) {
              const local = nameOf(element.name);
              const control = element.propertyName ? nameOf(element.propertyName) : local;
              if (local && control) scope.controlValues.set(local, { form, control });
            }
        }
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const callee = node.expression;
        const owner = callee.expression;
        const ownerName =
          ts.isPropertyAccessExpression(owner) && owner.expression.kind === ts.SyntaxKind.ThisKeyword
            ? owner.name.text
            : ts.isIdentifier(owner)
              ? owner.text
              : undefined;
        const methodName = callee.name.text;
        // HttpClient injecté (type connu), ou une propriété nommée http / httpClient (JS sans types, bundle).
        const http =
          ownerName !== undefined && (httpOwners.has(ownerName) || /^(http|httpClient)$/i.test(ownerName));
        if (ownerName && http && HTTP_METHODS[methodName]) {
          // La requête (?x=…) n'est jamais gardée : inutile pour relier, et elle peut porter un secret.
          const route = routeTemplate(node.arguments[0])?.replace(/\?.*$/, '');
          if (route !== undefined) {
            const call: HttpCallFact = {
              method: HTTP_METHODS[methodName],
              route,
              ...(node.typeArguments?.[0] ? { responseType: typeName(node.typeArguments[0]) } : {}),
              line: lineOf(node),
            };
            const bodyArgument = BODY_METHODS.has(methodName) ? node.arguments[1] : undefined;
            if (bodyArgument) {
              const argument = argumentOf(bodyArgument);
              if (argument.kind === 'variable') call.body = argument.name;
              else if (argument.kind === 'object') call.bodyRequest = argument.request;
            }
            method.httpCalls.push(call);
          }
        } else if (ownerName && routerOwners.has(ownerName) && /^navigate(ByUrl)?$/.test(methodName)) {
          const target = navigationTarget(node.arguments[0]);
          if (target) method.navigations.push({ target, line: lineOf(node) });
        } else if (
          ownerName &&
          ts.isPropertyAccessExpression(owner) &&
          !httpOwners.has(ownerName) &&
          !routerOwners.has(ownerName) &&
          !forms.has(ownerName)
        ) {
          method.serviceCalls.push({
            target: ownerName,
            method: methodName,
            args: node.arguments.map(argumentOf),
            line: lineOf(node),
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(body);
    return method;
  };

  /** '/api/users' · `${this.base}/users/${id}` · this.base + '/users' → /api/users, {base}/users/{param} */
  const routeTemplate = (node: TS.Expression | undefined): string | undefined => {
    if (!node) return undefined;
    const literal = stringOf(node);
    if (literal !== undefined) return literal;
    if (ts.isTemplateExpression(node)) {
      let route = node.head.text;
      node.templateSpans.forEach((span, index) => {
        route += index === 0 && node.head.text === '' ? '{base}' : '{param}';
        route += span.literal.text;
      });
      return route;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = routeTemplate(node.left) ?? '{base}';
      const right = routeTemplate(node.right) ?? '{param}';
      return left + right;
    }
    return undefined;
  };
  /** ['/administration', 'users'] · '/administration/users' */
  const navigationTarget = (node: TS.Expression | undefined): string | undefined => {
    if (!node) return undefined;
    const literal = stringOf(node);
    if (literal !== undefined) return literal;
    if (!ts.isArrayLiteralExpression(node)) return undefined;
    const segments = node.elements.map((element) => stringOf(element) ?? ':param');
    if (segments.every((segment) => segment === ':param')) return undefined;
    return segments.join('/').replace(/\/{2,}/g, '/');
  };

  // ---------------------------------------------------------------- DTO
  const dtoOf = (
    name: string,
    members: readonly TS.TypeElement[] | readonly TS.ClassElement[],
    line: number,
  ): DtoFact => ({
    name,
    properties: members.flatMap((member) => {
      if (!(ts.isPropertySignature(member) || ts.isPropertyDeclaration(member))) return [];
      const property = nameOf(member.name);
      if (!property) return [];
      const type = typeName(member.type);
      return [{ name: property, ...(type ? { type } : {}), optional: member.questionToken !== undefined }];
    }),
    line,
  });

  const visitTop = (node: TS.Node): void => {
    count();
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier))
      facts.imports.push(node.moduleSpecifier.text);
    if (ts.isClassDeclaration(node)) {
      const fact = classOf(node);
      if (fact) facts.classes.push(fact);
      const name = node.name?.text;
      const plain =
        name &&
        !fact?.decorator &&
        node.members.every(
          (member) => ts.isPropertyDeclaration(member) || ts.isConstructorDeclaration(member),
        );
      if (name && (plain || DTO_NAME.test(name))) facts.dtos.push(dtoOf(name, node.members, lineOf(node)));
      return;
    }
    if (ts.isInterfaceDeclaration(node)) facts.dtos.push(dtoOf(node.name.text, node.members, lineOf(node)));
    if (ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type))
      facts.dtos.push(dtoOf(node.name.text, node.type.members, lineOf(node)));
    if (isRouteArray(node)) {
      const parent = node.parent;
      const variable =
        ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) ? parent.name.text : undefined;
      // Un tableau « children » est lu avec sa route parente, pas comme une racine.
      const isChildren = ts.isPropertyAssignment(parent) && nameOf(parent.name) === 'children';
      if (!isChildren) {
        facts.routeArrays.push({
          ...(variable ? { variable } : {}),
          routes: node.elements.filter(isRouteObject).map(routeOf),
          line: lineOf(node),
        });
        return;
      }
    }
    ts.forEachChild(node, visitTop);
  };
  visitTop(source);
  return facts;
}
