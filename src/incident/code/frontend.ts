import ts from 'typescript';
import type {
  CodeCall,
  CodeIndex,
  CodeSymbol,
  CodeSymbolKind,
  OutgoingHttpCall,
  RelationStatus,
} from '../model.js';
import { urlPath } from './paths.js';

/**
 * L'analyse FRONTEND (TypeScript, TSX, JavaScript, Vue) par l'AST du compilateur TypeScript, qui
 * sert de parseur et n'exécute jamais le code : composants (fonctions qui rendent du JSX, classes
 * React, `@Component` Angular, `defineComponent` / SFC Vue), gestionnaires d'événements (props JSX
 * `onX={…}`, méthodes `on*` / `handle*`), fonctions métier, validations (`validate*`, `isValid*`,
 * schémas zod / yup), transformations de payload (`to*Payload`, `map*`, `serialize*`,
 * `build*Request`), appels HTTP (`fetch`, axios, HttpClient Angular), gestion d'erreur (`catch`,
 * `.catch(`).
 *
 * URL littérale : STATICALLY_RESOLVED ; base résolue par une constante du fichier (ou `baseURL`
 * d'une instance axios) : INFERRED ; expression dynamique : UNKNOWN. Les appels vers un import
 * restent UNKNOWN ici : `resolveCalls` les relie quand le fichier importé est indexé.
 */

type Detail = NonNullable<CodeSymbol['detail']>;
type FrontendResult = Pick<CodeIndex, 'symbols' | 'outgoing' | 'calls'>;

const HTTP_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
const BASE_NAME = /(url|uri|base|api|host|origin|prefix|endpoint|server)/i;

interface Scope {
  symbol?: SymbolDraft;
  /** Nom qualifié du symbole englobant (« BookForm.onSave »). */
  name?: string;
  component?: SymbolDraft;
  classSymbol?: SymbolDraft;
}

interface SymbolDraft {
  symbol: CodeSymbol;
  detail: Detail;
}

interface FileState {
  app: string;
  file: string;
  sf: ts.SourceFile;
  lineOffset: number;
  result: FrontendResult;
  symbols: Map<string, SymbolDraft>;
  /** Noms locaux importés → `module#export` (`*` : espace de noms, `default`). */
  imports: Map<string, { module: string; name: string }>;
  /** Constantes chaînes du fichier (évaluées). */
  constants: Map<string, string>;
  /** Instances axios du fichier → baseURL (vide si inconnue). */
  axiosInstances: Map<string, string | undefined>;
  axiosNames: Set<string>;
  /** Noms simples des fonctions déclarées dans le fichier (toutes profondeurs). */
  declared: Set<string>;
  /** Appels vers une fonction du fichier, reliés une fois tous les symboles connus. */
  pending: {
    from: SymbolDraft;
    name: string;
    owners: string[];
    member: boolean;
    text: string;
    line: number;
    position: number;
  }[];
  catchCounters: Map<string, number>;
  /** Position de chaque appel dans la source (ordre stable du résultat). */
  order: Map<CodeCall, number>;
}

export function analyzeFrontendSource(applicationId: string, file: string, text: string): FrontendResult {
  const result: FrontendResult = { symbols: [], outgoing: [], calls: [] };
  const order = new Map<CodeCall, number>();
  const blocks = /\.vue$/i.test(file)
    ? vueScripts(text)
    : [{ code: text, lineOffset: 0, setup: false, ts: true }];
  const template = /\.vue$/i.test(file) ? vueTemplateHandlers(text) : [];
  for (const block of blocks) {
    const kind = /\.tsx$/i.test(file)
      ? ts.ScriptKind.TSX
      : /\.jsx$/i.test(file)
        ? ts.ScriptKind.JSX
        : /\.(js|mjs|cjs)$/i.test(file) || !block.ts
          ? ts.ScriptKind.JS
          : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(file, block.code, ts.ScriptTarget.Latest, true, kind);
    const state: FileState = {
      app: applicationId,
      file,
      sf,
      lineOffset: block.lineOffset,
      result,
      symbols: new Map(result.symbols.map((s) => [s.name, { symbol: s, detail: s.detail ?? {} }])),
      imports: new Map(),
      constants: new Map(),
      axiosInstances: new Map(),
      axiosNames: new Set(),
      declared: new Set(),
      pending: [],
      catchCounters: new Map(),
      order,
    };
    prepare(state);
    let root: Scope = {};
    if (block.setup) {
      // `<script setup>` : le fichier est le composant.
      const component = addSymbol(state, 'COMPONENT', componentNameFromFile(file), sf, undefined);
      component.detail.framework = 'vue';
      root = { symbol: component, name: component.symbol.name, component };
    }
    visit(state, sf, root);
    resolvePending(state);
    for (const handler of template) {
      const draft = [...state.symbols.values()].find((d) => d.symbol.name.split('.').pop() === handler.name);
      if (draft) markHandler(draft, `${handler.event} (template)`);
    }
  }
  // Ordre de la source (les appels reliés en fin de fichier reprennent leur place ; tri stable).
  result.calls.sort((a, b) => a.line - b.line || (order.get(a) ?? 0) - (order.get(b) ?? 0));
  return result;
}

// ── Préparation : imports, constantes, instances axios, fonctions déclarées ─────────────────

function prepare(state: FileState): void {
  for (const statement of state.sf.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const module = statement.moduleSpecifier.text;
      const clause = statement.importClause;
      if (!clause) continue;
      if (clause.name) state.imports.set(clause.name.text, { module, name: 'default' });
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings))
        state.imports.set(bindings.name.text, { module, name: '*' });
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          state.imports.set(element.name.text, { module, name: (element.propertyName ?? element.name).text });
        }
      }
      if (module === 'axios') {
        if (clause.name) state.axiosNames.add(clause.name.text);
        if (bindings && ts.isNamespaceImport(bindings)) state.axiosNames.add(bindings.name.text);
      }
    }
  }
  if (state.axiosNames.size === 0) state.axiosNames.add('axios');
  const walk = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) state.declared.add(node.name.text);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && functionLike(node.initializer))
      state.declared.add(node.name.text);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = node.initializer;
      const value = constantString(state, init);
      if (value !== undefined && isConstDeclaration(node)) state.constants.set(node.name.text, value);
      // const api = axios.create({ baseURL: '/api' })
      if (
        ts.isCallExpression(init) &&
        ts.isPropertyAccessExpression(init.expression) &&
        init.expression.name.text === 'create' &&
        ts.isIdentifier(init.expression.expression) &&
        state.axiosNames.has(init.expression.expression.text)
      ) {
        const config = init.arguments[0];
        let base: string | undefined;
        if (config && ts.isObjectLiteralExpression(config)) {
          const prop = objectProperty(config, 'baseURL');
          if (prop) base = constantString(state, prop);
        }
        state.axiosInstances.set(node.name.text, base);
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(state.sf);
}

function isConstDeclaration(node: ts.VariableDeclaration): boolean {
  return ts.isVariableDeclarationList(node.parent) && (node.parent.flags & ts.NodeFlags.Const) !== 0;
}

function constantString(state: FileState, node: ts.Expression, depth = 0): string | undefined {
  if (depth > 5) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node))
    return constantString(state, node.expression, depth + 1);
  if (ts.isIdentifier(node)) return state.constants.get(node.text);
  if (ts.isTemplateExpression(node)) {
    let out = node.head.text;
    for (const span of node.templateSpans) {
      const value = constantString(state, span.expression, depth + 1);
      if (value === undefined) return undefined;
      out += value + span.literal.text;
    }
    return out;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = constantString(state, node.left, depth + 1);
    const right = constantString(state, node.right, depth + 1);
    return left !== undefined && right !== undefined ? left + right : undefined;
  }
  return undefined;
}

function objectProperty(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const prop of object.properties) {
    if (ts.isPropertyAssignment(prop) && propertyName(prop.name) === name) return prop.initializer;
    if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === name) return prop.name;
  }
  return undefined;
}

function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isPrivateIdentifier(name)) return name.text;
  return undefined;
}

// ── Symboles ─────────────────────────────────────────────────────────────────────────────────

function lineOf(state: FileState, node: ts.Node): number {
  return state.sf.getLineAndCharacterOfPosition(node.getStart(state.sf)).line + 1 + state.lineOffset;
}

function addSymbol(
  state: FileState,
  kind: CodeSymbolKind,
  name: string,
  node: ts.Node,
  parent: SymbolDraft | undefined,
): SymbolDraft {
  let unique = name;
  for (let n = 2; state.symbols.has(unique); n++) unique = `${name}~${n}`;
  const detail: Detail = {};
  const symbol: CodeSymbol = {
    id: `${state.app}:${state.file}#${unique}`,
    applicationId: state.app,
    layer: 'FRONTEND',
    kind,
    name: unique,
    file: state.file,
    line: lineOf(state, node),
    detail,
  };
  if (parent) symbol.parent = parent.symbol.id;
  const draft = { symbol, detail };
  state.symbols.set(unique, draft);
  state.result.symbols.push(symbol);
  return draft;
}

function addList(detail: Detail, key: string, value: string, max = 30): void {
  const current = detail[key];
  const list = Array.isArray(current) ? current : [];
  if (!list.includes(value) && list.length < max) list.push(value);
  detail[key] = list;
}

function classify(name: string, fn: ts.Node | undefined, isMember: boolean): CodeSymbolKind {
  const simple = name.split('.').pop() ?? name;
  if (fn && /^[A-Z]/.test(simple) && !isMember && returnsJsx(fn)) return 'COMPONENT';
  if (/^(on|handle)[A-Z]/.test(simple)) return 'EVENT_HANDLER';
  if (/^(validate|isValid)/.test(simple)) return 'VALIDATION';
  if (/^to\w*Payload$|^map[A-Z]|^serialize|^build\w*Request$/.test(simple)) return 'PAYLOAD_TRANSFORM';
  return 'FUNCTION';
}

function returnsJsx(fn: ts.Node): boolean {
  let found = false;
  const walk = (node: ts.Node): void => {
    if (found) return;
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) {
      found = true;
      return;
    }
    // Les fonctions imbriquées (gestionnaires) ne comptent pas.
    if (node !== fn && (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node))) return;
    ts.forEachChild(node, walk);
  };
  walk(fn);
  return found;
}

function functionLike(node: ts.Expression | undefined): ts.ArrowFunction | ts.FunctionExpression | undefined {
  if (!node) return undefined;
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return node;
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) return functionLike(node.expression);
  // useCallback(fn, deps), memo(fn), forwardRef(fn)
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    const name = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : '';
    if (['useCallback', 'memo', 'forwardRef', 'useMemo'].includes(name)) {
      const first = node.arguments[0];
      return first && (ts.isArrowFunction(first) || ts.isFunctionExpression(first)) ? first : undefined;
    }
  }
  return undefined;
}

function isExported(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  if (modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return true;
  if (ts.isVariableDeclaration(node)) {
    const statement = node.parent.parent;
    return ts.isVariableStatement(statement) && isExported(statement);
  }
  return false;
}

function isDefaultExport(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return Boolean(modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword));
}

function qualified(scope: Scope, name: string): string {
  return scope.name ? `${scope.name}.${name}` : name;
}

function declareFunction(
  state: FileState,
  scope: Scope,
  name: string,
  declaration: ts.Node,
  fn: ts.FunctionLikeDeclaration,
  isMember: boolean,
): Scope {
  const kind = classify(name, fn, isMember);
  const draft = addSymbol(state, kind, qualified(scope, name), declaration, scope.symbol);
  if (isExported(declaration)) draft.detail.exported = true;
  if (isDefaultExport(declaration)) draft.detail.exportDefault = true;
  if (fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) draft.detail.async = true;
  const params = fn.parameters.map((p) => p.name.getText(state.sf));
  if (params.length > 0) draft.detail.params = params;
  if (kind === 'COMPONENT') draft.detail.framework = 'react';
  if (kind === 'VALIDATION') describeValidation(state, draft, fn);
  if (kind === 'PAYLOAD_TRANSFORM') describePayload(draft, fn);
  const next: Scope = { symbol: draft, name: draft.symbol.name };
  const component = kind === 'COMPONENT' ? draft : scope.component;
  if (component) next.component = component;
  if (scope.classSymbol) next.classSymbol = scope.classSymbol;
  return next;
}

// ── Parcours ─────────────────────────────────────────────────────────────────────────────────

function visit(state: FileState, node: ts.Node, scope: Scope): void {
  if (ts.isFunctionDeclaration(node) && node.name && node.body) {
    const inner = declareFunction(state, scope, node.name.text, node, node, false);
    visitChildren(state, node, inner);
    return;
  }
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    const fn = functionLike(node.initializer);
    if (fn) {
      const inner = declareFunction(state, scope, node.name.text, node, fn, false);
      visitChildren(state, fn, inner);
      return;
    }
    if (node.initializer && isSchema(state, node.initializer)) {
      const draft = addSymbol(state, 'VALIDATION', qualified(scope, node.name.text), node, scope.symbol);
      describeSchema(state, draft, node.initializer);
      if (isExported(node)) draft.detail.exported = true;
      return;
    }
  }
  if (ts.isClassDeclaration(node) && node.name) {
    visitClass(state, node, scope);
    return;
  }
  if (ts.isCallExpression(node) && isDefineComponent(node)) {
    visitVueComponent(state, node, scope);
    return;
  }
  if (ts.isExportAssignment(node) && ts.isObjectLiteralExpression(node.expression)) {
    // export default { name, methods } (Vue options API sans defineComponent)
    if (/\.vue$/i.test(state.file)) {
      visitVueOptions(state, node.expression, node, scope);
      return;
    }
  }
  if (ts.isTryStatement(node) && node.catchClause && scope.symbol) {
    visit(state, node.tryBlock, scope);
    const handler = errorHandler(state, scope, node.catchClause);
    visitChildren(state, node.catchClause.block, handler);
    if (node.finallyBlock) visit(state, node.finallyBlock, scope);
    return;
  }
  if (ts.isJsxAttribute(node)) {
    if (visitJsxHandler(state, node, scope)) return;
  }
  if (ts.isCallExpression(node)) {
    onCall(state, node, scope);
    const callee = node.expression;
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'catch' && scope.symbol) {
      // promise.catch(handler)
      visit(state, callee.expression, scope);
      const handler = errorHandler(state, scope, node);
      for (const arg of node.arguments) visitChildren(state, arg, handler);
      return;
    }
  }
  if (ts.isThrowStatement(node) && scope.symbol) {
    const expr = node.expression;
    const name =
      ts.isNewExpression(expr) && ts.isIdentifier(expr.expression)
        ? expr.expression.text
        : expr.getText(state.sf);
    addList(scope.symbol.detail, 'throws', name.slice(0, 80));
  }
  visitChildren(state, node, scope);
}

function visitChildren(state: FileState, node: ts.Node, scope: Scope): void {
  ts.forEachChild(node, (child) => {
    visit(state, child, scope);
  });
}

function visitClass(state: FileState, node: ts.ClassDeclaration, scope: Scope): void {
  const name = node.name?.text ?? 'default';
  const decorators = (ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : []).map((d) =>
    ts.isCallExpression(d.expression)
      ? d.expression.expression.getText(state.sf)
      : d.expression.getText(state.sf),
  );
  const heritage = (node.heritageClauses ?? [])
    .filter((h) => h.token === ts.SyntaxKind.ExtendsKeyword)
    .flatMap((h) => h.types.map((t) => t.expression.getText(state.sf)));
  const react = heritage.some((h) => /^(React\.)?(Pure)?Component$/.test(h));
  const angular = decorators.includes('Component');
  const error = heritage.some((h) => /(Error|Exception)$/.test(h));
  const kind: CodeSymbolKind = react || angular ? 'COMPONENT' : error ? 'EXCEPTION' : 'FUNCTION';
  const draft = addSymbol(state, kind, qualified(scope, name), node, scope.symbol);
  draft.detail.declaration = 'class';
  if (decorators.length > 0) draft.detail.decorators = decorators;
  if (heritage.length > 0) draft.detail.extends = heritage;
  if (react) draft.detail.framework = 'react';
  if (angular) {
    draft.detail.framework = 'angular';
    const decorator = (ts.getDecorators(node) ?? []).find(
      (d) => ts.isCallExpression(d.expression) && d.expression.expression.getText(state.sf) === 'Component',
    );
    const config =
      decorator && ts.isCallExpression(decorator.expression) ? decorator.expression.arguments[0] : undefined;
    const selector =
      config && ts.isObjectLiteralExpression(config) ? objectProperty(config, 'selector') : undefined;
    if (selector && ts.isStringLiteral(selector)) draft.detail.selector = selector.text;
  }
  if (isExported(node)) draft.detail.exported = true;
  if (isDefaultExport(node)) draft.detail.exportDefault = true;
  // Champs typés : paramètres de constructeur avec modificateur et propriétés déclarées.
  const imports: string[] = [];
  for (const member of node.members) {
    if (ts.isConstructorDeclaration(member)) {
      for (const param of member.parameters) {
        const hasModifier = (ts.getModifiers(param) ?? []).length > 0;
        if (hasModifier && ts.isIdentifier(param.name) && param.type)
          addList(draft.detail, 'fields', `${param.name.text}:${typeName(param.type, state.sf)}`);
      }
    } else if (ts.isPropertyDeclaration(member) && ts.isIdentifier(member.name) && member.type) {
      addList(draft.detail, 'fields', `${member.name.text}:${typeName(member.type, state.sf)}`);
    }
  }
  for (const field of (draft.detail.fields as string[] | undefined) ?? []) {
    const type = field.split(':')[1] ?? '';
    const imported = state.imports.get(type);
    if (imported) imports.push(`${type}=${imported.module}#${imported.name}`);
  }
  if (imports.length > 0) draft.detail.imports = imports;
  const classScope: Scope = { symbol: draft, name: draft.symbol.name, classSymbol: draft };
  if (kind === 'COMPONENT') classScope.component = draft;
  for (const member of node.members) {
    if ((ts.isMethodDeclaration(member) || ts.isGetAccessor(member)) && member.body) {
      const memberName = propertyName(member.name) ?? member.name.getText(state.sf);
      const inner = declareFunction(state, classScope, memberName, member, member, true);
      visitChildren(state, member.body, inner);
    } else if (ts.isPropertyDeclaration(member) && functionLike(member.initializer)) {
      const fn = functionLike(member.initializer);
      const memberName = propertyName(member.name) ?? member.name.getText(state.sf);
      if (fn) {
        const inner = declareFunction(state, classScope, memberName, member, fn, true);
        visitChildren(state, fn, inner);
      }
    } else if (ts.isConstructorDeclaration(member) && member.body) {
      visitChildren(state, member.body, classScope);
    }
  }
  // Une classe (service) qui fait des appels HTTP : un client HTTP.
  if (kind === 'FUNCTION' && state.result.outgoing.some((o) => isChildOf(state, o.symbolId, draft.symbol.id)))
    draft.symbol.kind = 'HTTP_CLIENT';
}

function isChildOf(state: FileState, symbolId: string, parentId: string): boolean {
  const symbol = [...state.symbols.values()].find((d) => d.symbol.id === symbolId);
  return symbol?.symbol.parent === parentId;
}

function typeName(node: ts.TypeNode, sf: ts.SourceFile): string {
  if (ts.isTypeReferenceNode(node)) return node.typeName.getText(sf).split('.').pop() ?? '';
  return node.getText(sf);
}

function isDefineComponent(node: ts.CallExpression): boolean {
  const callee = node.expression;
  const name = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : '';
  return (name === 'defineComponent' || name === 'extend') && node.arguments.length > 0;
}

function visitVueComponent(state: FileState, node: ts.CallExpression, scope: Scope): void {
  const options = node.arguments[0];
  if (options && ts.isObjectLiteralExpression(options)) visitVueOptions(state, options, node, scope);
}

function visitVueOptions(
  state: FileState,
  options: ts.ObjectLiteralExpression,
  node: ts.Node,
  scope: Scope,
): void {
  const nameProp = objectProperty(options, 'name');
  const name = nameProp && ts.isStringLiteral(nameProp) ? nameProp.text : componentNameFromFile(state.file);
  const draft = addSymbol(state, 'COMPONENT', qualified(scope, name), node, scope.symbol);
  draft.detail.framework = 'vue';
  const componentScope: Scope = { symbol: draft, name: draft.symbol.name, component: draft };
  for (const prop of options.properties) {
    const key = prop.name ? propertyName(prop.name) : undefined;
    if (
      key === 'methods' &&
      ts.isPropertyAssignment(prop) &&
      ts.isObjectLiteralExpression(prop.initializer)
    ) {
      for (const method of prop.initializer.properties) {
        const methodName = method.name ? propertyName(method.name) : undefined;
        if (!methodName) continue;
        const fn = ts.isMethodDeclaration(method)
          ? method
          : ts.isPropertyAssignment(method)
            ? functionLike(method.initializer)
            : undefined;
        if (!fn) continue;
        const inner = declareFunction(state, componentScope, methodName, method, fn, true);
        if (fn.body) visitChildren(state, fn.body, inner);
      }
    } else {
      visitChildren(state, prop, componentScope);
    }
  }
}

function componentNameFromFile(file: string): string {
  const base = file.split('/').pop() ?? file;
  return base.replace(/\.[^.]+$/, '');
}

function errorHandler(state: FileState, scope: Scope, node: ts.CatchClause | ts.CallExpression): Scope {
  const owner = scope.name ?? 'module';
  const count = (state.catchCounters.get(owner) ?? 0) + 1;
  state.catchCounters.set(owner, count);
  const name = `${owner}.catch${count > 1 ? String(count) : ''}`;
  const draft = addSymbol(state, 'ERROR_HANDLER', name, node, scope.symbol);
  const body = ts.isCatchClause(node) ? node.block : node.arguments[0];
  let rethrows = false;
  const walk = (child: ts.Node): void => {
    if (ts.isThrowStatement(child)) rethrows = true;
    if (ts.isCallExpression(child)) {
      const callee = child.expression.getText(state.sf);
      if (callee.length <= 60) addList(draft.detail, 'calls', callee, 10);
    }
    if (ts.isStringLiteral(child) || ts.isNoSubstitutionTemplateLiteral(child))
      addList(draft.detail, 'messages', child.text.slice(0, 120), 5);
    ts.forEachChild(child, walk);
  };
  if (body) walk(body);
  draft.detail.rethrows = rethrows;
  draft.detail.style = ts.isCatchClause(node) ? 'try/catch' : '.catch()';
  const next: Scope = { symbol: draft, name: draft.symbol.name };
  if (scope.component) next.component = scope.component;
  if (scope.classSymbol) next.classSymbol = scope.classSymbol;
  return next;
}

// ── JSX : gestionnaires d'événements ─────────────────────────────────────────────────────────

function visitJsxHandler(state: FileState, attr: ts.JsxAttribute, scope: Scope): boolean {
  const prop = attr.name.getText(state.sf);
  if (!/^on[A-Z]/.test(prop)) return false;
  const init = attr.initializer;
  if (!init || !ts.isJsxExpression(init) || !init.expression) return false;
  const element = attr.parent.parent;
  const tag =
    ts.isJsxOpeningElement(element) || ts.isJsxSelfClosingElement(element)
      ? element.tagName.getText(state.sf)
      : '?';
  const trigger = triggerLabel(state, element, tag, prop);
  const expr = init.expression;
  if (ts.isIdentifier(expr) || ts.isPropertyAccessExpression(expr)) {
    const name = ts.isIdentifier(expr) ? expr.text : expr.name.text;
    const candidates = [
      scope.component ? `${scope.component.symbol.name}.${name}` : '',
      scope.name ? `${scope.name}.${name}` : '',
      name,
    ];
    const draft = candidates.map((c) => state.symbols.get(c)).find(Boolean);
    if (draft) markHandler(draft, trigger);
    else if (scope.symbol) addList(scope.symbol.detail, 'handlers', `${trigger} → ${expr.getText(state.sf)}`);
    return true;
  }
  const fn = functionLike(expr);
  if (fn) {
    // Inline : un symbole seulement s'il appelle une fonction du fichier ou un import.
    if (callsKnown(state, fn)) {
      const owner = scope.component ?? scope.symbol;
      const base = `${owner ? owner.symbol.name + '.' : ''}${tag}.${prop}`;
      const draft = addSymbol(state, 'EVENT_HANDLER', base, attr, owner);
      draft.detail.inline = true;
      markHandler(draft, trigger);
      const inner: Scope = { symbol: draft, name: draft.symbol.name };
      if (scope.component) inner.component = scope.component;
      visitChildren(state, fn, inner);
      return true;
    }
  }
  return false;
}

function markHandler(draft: SymbolDraft, trigger: string): void {
  if (draft.symbol.kind === 'FUNCTION') draft.symbol.kind = 'EVENT_HANDLER';
  addList(draft.detail, 'triggers', trigger, 10);
}

function triggerLabel(state: FileState, element: ts.Node, tag: string, prop: string): string {
  const full = ts.isJsxOpeningElement(element) ? element.parent : element;
  const texts: string[] = [];
  if (tag === 'form') {
    // Les boutons d'envoi du formulaire.
    const walk = (node: ts.Node): void => {
      if (ts.isJsxElement(node) && node.openingElement.tagName.getText(state.sf) === 'button') {
        const type = node.openingElement.attributes.properties.find(
          (p) => ts.isJsxAttribute(p) && p.name.getText(state.sf) === 'type',
        );
        const value =
          type && ts.isJsxAttribute(type) && type.initializer && ts.isStringLiteral(type.initializer)
            ? type.initializer.text
            : 'submit';
        if (value === 'submit') texts.push(jsxText(node));
      }
      ts.forEachChild(node, walk);
    };
    walk(full);
  } else texts.push(jsxText(full));
  const label = texts.filter(Boolean).join(' / ');
  return `<${tag} ${prop}>${label ? ` « ${label} »` : ''}`;
}

function jsxText(node: ts.Node): string {
  const parts: string[] = [];
  const walk = (child: ts.Node): void => {
    if (ts.isJsxText(child)) parts.push(child.text);
    ts.forEachChild(child, walk);
  };
  walk(node);
  return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 60);
}

function callsKnown(state: FileState, fn: ts.Node): boolean {
  let found = false;
  const walk = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && (state.imports.has(callee.text) || state.declared.has(callee.text)))
        found = true;
      if (ts.isPropertyAccessExpression(callee) && callee.expression.kind === ts.SyntaxKind.ThisKeyword)
        found = true;
    }
    ts.forEachChild(node, walk);
  };
  walk(fn);
  return found;
}

// ── Appels : HTTP et appels de fonctions ─────────────────────────────────────────────────────

function onCall(state: FileState, node: ts.CallExpression, scope: Scope): void {
  const http = httpCall(state, node, scope);
  if (http && scope.symbol) {
    const call: OutgoingHttpCall = {
      applicationId: state.app,
      layer: 'FRONTEND',
      symbolId: scope.symbol.symbol.id,
      status: http.status,
      file: state.file,
      line: lineOf(state, node),
    };
    if (http.method) call.method = http.method;
    if (http.path !== undefined) call.path = http.path;
    state.result.outgoing.push(call);
    addList(scope.symbol.detail, 'http', `${http.method ?? '?'} ${http.path ?? '?'}`);
    if (scope.symbol.symbol.kind === 'FUNCTION') scope.symbol.symbol.kind = 'HTTP_CLIENT_CALL';
    return;
  }
  if (!scope.symbol) return;
  const callee = node.expression;
  const text = compact(node.getText(state.sf));
  const from = scope.symbol;
  const push = (call: Omit<CodeCall, 'file' | 'line' | 'from' | 'text'>): void => {
    const full: CodeCall = {
      from: from.symbol.id,
      text,
      file: state.file,
      line: lineOf(state, node),
      ...call,
    };
    state.order.set(full, node.pos);
    state.result.calls.push(full);
  };
  if (ts.isIdentifier(callee)) {
    const name = callee.text;
    if (state.declared.has(name)) {
      const owners = [scope.name, scope.component?.symbol.name].filter((o): o is string => Boolean(o));
      state.pending.push({
        from,
        name,
        owners,
        member: false,
        text,
        line: lineOf(state, node),
        position: node.pos,
      });
      return;
    }
    const imported = state.imports.get(name);
    if (imported && isLocalModule(imported.module)) {
      addList(from.detail, 'imports', `${name}=${imported.module}#${imported.name}`);
      push({ status: 'UNKNOWN' });
    }
    return;
  }
  if (ts.isPropertyAccessExpression(callee)) {
    const target = callee.expression;
    // ns.fn() d'un import `* as ns` / défaut.
    const imported = ts.isIdentifier(target) ? state.imports.get(target.text) : undefined;
    if (ts.isIdentifier(target) && imported && !state.axiosNames.has(target.text)) {
      if (!isLocalModule(imported.module)) return;
      addList(from.detail, 'imports', `${target.text}=${imported.module}#${imported.name}`);
      push({ status: 'UNKNOWN' });
      return;
    }
    // this.method() dans une classe ; this.field.method() vers un service injecté.
    if (target.kind === ts.SyntaxKind.ThisKeyword && scope.classSymbol) {
      // Méthode déclarée plus bas dans la classe : reliée en fin de fichier.
      state.pending.push({
        from,
        name: callee.name.text,
        owners: [scope.classSymbol.symbol.name],
        member: true,
        text,
        line: lineOf(state, node),
        position: node.pos,
      });
      return;
    }
    if (
      ts.isPropertyAccessExpression(target) &&
      target.expression.kind === ts.SyntaxKind.ThisKeyword &&
      scope.classSymbol &&
      ((scope.classSymbol.detail.fields as string[] | undefined) ?? []).some((f) =>
        f.startsWith(`${target.name.text}:`),
      )
    ) {
      push({ status: 'UNKNOWN' });
    }
  }
}

/** Les appels vers une fonction du fichier : imbriquée (« BookForm.helper ») d'abord, puis de premier niveau. */
function resolvePending(state: FileState): void {
  for (const call of state.pending) {
    const names: string[] = [];
    for (const owner of call.owners) {
      if (call.member) {
        names.push(`${owner}.${call.name}`);
        continue;
      }
      // Le symbole courant, puis ses englobants (« A.b.c » → « A.b », « A »).
      const parts = owner.split('.');
      for (let k = parts.length; k > 0; k--) names.push(`${parts.slice(0, k).join('.')}.${call.name}`);
    }
    if (!call.member) names.push(call.name);
    const target = names.map((n) => state.symbols.get(n)).find(Boolean);
    if (!target) continue;
    const full: CodeCall = {
      from: call.from.symbol.id,
      to: target.symbol.id,
      text: call.text,
      status: 'STATICALLY_RESOLVED',
      file: state.file,
      line: call.line,
    };
    state.order.set(full, call.position);
    state.result.calls.push(full);
  }
  state.pending = [];
}

/** Un module du dépôt (relatif ou alias `@/`, `~/`) ; un paquet (react, axios…) n'est pas une relation du code. */
function isLocalModule(module: string): boolean {
  return /^(\.|@\/|~\/)/.test(module);
}

function compact(text: string): string {
  const flat = text.replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();
  return flat.length > 200 ? flat.slice(0, 199) + '…' : flat;
}

interface HttpFact {
  method?: string;
  path?: string;
  status: RelationStatus;
}

function httpCall(state: FileState, node: ts.CallExpression, scope: Scope): HttpFact | undefined {
  const callee = node.expression;
  const args = node.arguments;
  // fetch(url, { method })
  if (
    (ts.isIdentifier(callee) && callee.text === 'fetch') ||
    (ts.isPropertyAccessExpression(callee) &&
      callee.name.text === 'fetch' &&
      ts.isIdentifier(callee.expression) &&
      ['window', 'globalThis', 'self'].includes(callee.expression.text))
  ) {
    const init = args[1];
    let method: string | undefined = 'GET';
    let methodLiteral = true;
    if (init) {
      if (ts.isObjectLiteralExpression(init)) {
        const prop = objectProperty(init, 'method');
        if (prop) {
          const value = constantString(state, prop);
          method = value?.toUpperCase();
          methodLiteral =
            value !== undefined && (ts.isStringLiteral(prop) || ts.isNoSubstitutionTemplateLiteral(prop));
        }
      } else {
        method = undefined;
        methodLiteral = false;
      }
    }
    return withMethod(evaluateUrl(state, args[0]), method, methodLiteral);
  }
  // axios(config) / axios(url, config)
  if (
    ts.isIdentifier(callee) &&
    (state.axiosNames.has(callee.text) || state.axiosInstances.has(callee.text))
  ) {
    const base = state.axiosInstances.get(callee.text);
    const first = args[0];
    if (first && ts.isObjectLiteralExpression(first)) return axiosConfig(state, first, base);
    const config = args[1];
    const method =
      config && ts.isObjectLiteralExpression(config) ? objectProperty(config, 'method') : undefined;
    const value = method ? constantString(state, method) : 'GET';
    return withMethod(prefix(evaluateUrl(state, first), base), value?.toUpperCase(), Boolean(value));
  }
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  const verb = callee.name.text;
  const target = callee.expression;
  const isAxios =
    ts.isIdentifier(target) && (state.axiosNames.has(target.text) || state.axiosInstances.has(target.text));
  const isAngular =
    ts.isPropertyAccessExpression(target) &&
    target.expression.kind === ts.SyntaxKind.ThisKeyword &&
    isHttpClientField(scope, target.name.text);
  if (!isAxios && !isAngular) return undefined;
  const base = isAxios && ts.isIdentifier(target) ? state.axiosInstances.get(target.text) : undefined;
  if (HTTP_VERBS.has(verb))
    return withMethod(prefix(evaluateUrl(state, args[0]), base), verb.toUpperCase(), true);
  if (verb === 'request') {
    const first = args[0];
    if (isAxios && first && ts.isObjectLiteralExpression(first)) return axiosConfig(state, first, base);
    // HttpClient.request('POST', url)
    if (isAngular && first) {
      const method = constantString(state, first);
      return withMethod(evaluateUrl(state, args[1]), method?.toUpperCase(), method !== undefined);
    }
  }
  return undefined;
}

function isHttpClientField(scope: Scope, name: string): boolean {
  const fields = (scope.classSymbol?.detail.fields as string[] | undefined) ?? [];
  if (fields.some((f) => f === `${name}:HttpClient`)) return true;
  return /^http(Client)?$/i.test(name);
}

function axiosConfig(
  state: FileState,
  config: ts.ObjectLiteralExpression,
  base: string | undefined,
): HttpFact {
  const methodNode = objectProperty(config, 'method');
  const method = methodNode ? constantString(state, methodNode) : 'GET';
  const baseNode = objectProperty(config, 'baseURL');
  const localBase = baseNode ? constantString(state, baseNode) : undefined;
  return withMethod(
    prefix(evaluateUrl(state, objectProperty(config, 'url')), localBase ?? base),
    method?.toUpperCase(),
    method !== undefined,
  );
}

function withMethod(url: UrlFact, method: string | undefined, literal: boolean): HttpFact {
  const fact: HttpFact = { status: url.status };
  if (method) fact.method = method;
  if (url.url !== undefined) fact.path = urlPath(url.url);
  if ((!method || !literal) && fact.status === 'STATICALLY_RESOLVED') fact.status = 'INFERRED';
  return fact;
}

function prefix(url: UrlFact, base: string | undefined): UrlFact {
  if (base === undefined || url.url === undefined || /^[a-z]+:\/\//i.test(url.url)) return url;
  return {
    url: base.replace(/\/$/, '') + (url.url.startsWith('/') ? url.url : `/${url.url}`),
    status: 'INFERRED',
  };
}

interface UrlFact {
  url?: string;
  status: RelationStatus;
}

/** L'URL d'un appel : littéral, gabarit (`${id}` → `{id}`), base constante du fichier, ou dynamique. */
function evaluateUrl(state: FileState, node: ts.Expression | undefined): UrlFact {
  if (!node) return { status: 'UNKNOWN' };
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return { url: node.text, status: 'STATICALLY_RESOLVED' };
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node))
    return evaluateUrl(state, node.expression);
  const pieces: { kind: 'literal' | 'resolved' | 'dynamic'; text: string }[] = [];
  const collect = (expr: ts.Expression): void => {
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
      pieces.push({ kind: 'literal', text: expr.text });
    } else if (ts.isTemplateExpression(expr)) {
      pieces.push({ kind: 'literal', text: expr.head.text });
      for (const span of expr.templateSpans) {
        collect(span.expression);
        pieces.push({ kind: 'literal', text: span.literal.text });
      }
    } else if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      collect(expr.left);
      collect(expr.right);
    } else if (ts.isParenthesizedExpression(expr)) {
      collect(expr.expression);
    } else {
      const constant = constantString(state, expr);
      if (constant !== undefined) pieces.push({ kind: 'resolved', text: constant });
      else pieces.push({ kind: 'dynamic', text: paramName(expr, state.sf) });
    }
  };
  collect(node);
  const meaningful = pieces.filter((p) => !(p.kind === 'literal' && p.text === ''));
  if (meaningful.length === 0) return { status: 'UNKNOWN' };
  let status: RelationStatus = 'STATICALLY_RESOLVED';
  const head = meaningful[0];
  if (head?.kind === 'dynamic') {
    // `${baseUrl}/books` : une base inconnue devant un chemin absolu.
    const next = meaningful[1];
    if (next && next.kind !== 'dynamic' && next.text.startsWith('/') && BASE_NAME.test(head.text)) {
      meaningful.shift();
      status = 'INFERRED';
    } else return { status: 'UNKNOWN' };
  }
  let url = '';
  for (const piece of meaningful) {
    if (piece.kind === 'dynamic') url += `{${piece.text}}`;
    else {
      if (piece.kind === 'resolved') status = 'INFERRED';
      url += piece.text;
    }
  }
  return { url, status };
}

function paramName(expr: ts.Expression, sf: ts.SourceFile): string {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  if (ts.isCallExpression(expr)) {
    // encodeURIComponent(id), String(id)
    const first = expr.arguments[0];
    if (first) return paramName(first, sf);
  }
  if (ts.isElementAccessExpression(expr)) return paramName(expr.expression, sf);
  return 'param';
}

// ── Détails : validations, payloads, schémas ─────────────────────────────────────────────────

function describeValidation(state: FileState, draft: SymbolDraft, fn: ts.FunctionLikeDeclaration): void {
  const first = fn.parameters[0];
  const param = first && ts.isIdentifier(first.name) ? first.name.text : undefined;
  const walk = (node: ts.Node): void => {
    if (
      param &&
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === param
    )
      addList(draft.detail, 'checks', node.name.text);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (/\s/.test(node.text)) addList(draft.detail, 'messages', node.text.slice(0, 120), 10);
    }
    ts.forEachChild(node, walk);
  };
  if (fn.body) walk(fn.body);
}

function describePayload(draft: SymbolDraft, fn: ts.FunctionLikeDeclaration): void {
  const walk = (node: ts.Node, conditional: boolean): void => {
    if (ts.isObjectLiteralExpression(node)) {
      for (const prop of node.properties) {
        if (ts.isSpreadAssignment(prop)) {
          const inner = prop.expression;
          const isConditional =
            ts.isConditionalExpression(unwrap(inner)) ||
            (ts.isBinaryExpression(unwrap(inner)) &&
              (unwrap(inner) as ts.BinaryExpression).operatorToken.kind ===
                ts.SyntaxKind.AmpersandAmpersandToken);
          walk(inner, conditional || isConditional);
          continue;
        }
        const key = propertyName(prop.name);
        if (!key) continue;
        addList(draft.detail, 'fields', key);
        if (conditional) addList(draft.detail, 'conditionalFields', key);
        if (ts.isPropertyAssignment(prop)) walk(prop.initializer, conditional);
      }
      return;
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left)
    ) {
      addList(draft.detail, 'fields', node.left.name.text);
      if (conditional) addList(draft.detail, 'conditionalFields', node.left.name.text);
    }
    if (ts.isDeleteExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      addList(draft.detail, 'conditionalFields', node.expression.name.text);
    }
    if (ts.isIfStatement(node)) {
      walk(node.expression, conditional);
      walk(node.thenStatement, true);
      if (node.elseStatement) walk(node.elseStatement, true);
      return;
    }
    if (ts.isConditionalExpression(node)) {
      walk(node.condition, conditional);
      walk(node.whenTrue, true);
      walk(node.whenFalse, true);
      return;
    }
    ts.forEachChild(node, (child) => {
      walk(child, conditional);
    });
  };
  if (fn.body) walk(fn.body, false);
}

function unwrap(node: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node;
}

function isSchema(state: FileState, node: ts.Expression): boolean {
  let root: ts.Expression = node;
  while (ts.isCallExpression(root) || ts.isPropertyAccessExpression(root)) root = root.expression;
  if (!ts.isIdentifier(root)) return false;
  const imported = state.imports.get(root.text);
  const fromLibrary = imported && ['zod', 'yup'].includes(imported.module);
  return (
    (fromLibrary || root.text === 'z' || root.text === 'yup') && /\bobject\s*\(/.test(node.getText(state.sf))
  );
}

function describeSchema(state: FileState, draft: SymbolDraft, node: ts.Expression): void {
  draft.detail.schema = /\byup\b|object\(\{[\s\S]*\.required\(\)/.test(node.getText(state.sf))
    ? 'yup'
    : 'zod';
  let object: ts.ObjectLiteralExpression | undefined;
  const find = (child: ts.Node): void => {
    if (object) return;
    if (
      ts.isCallExpression(child) &&
      ((ts.isPropertyAccessExpression(child.expression) && child.expression.name.text === 'object') ||
        (ts.isIdentifier(child.expression) && child.expression.text === 'object'))
    ) {
      const arg = child.arguments[0];
      if (arg && ts.isObjectLiteralExpression(arg)) object = arg;
    }
    ts.forEachChild(child, find);
  };
  find(node);
  if (!object) return;
  const yup = draft.detail.schema === 'yup';
  for (const prop of object.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const key = propertyName(prop.name);
    if (!key) continue;
    const chain: string[] = [];
    let current: ts.Expression = prop.initializer;
    while (ts.isCallExpression(current)) {
      if (ts.isPropertyAccessExpression(current.expression)) {
        chain.unshift(current.expression.name.text);
        current = current.expression.expression;
      } else if (ts.isIdentifier(current.expression)) {
        chain.unshift(current.expression.text);
        break;
      } else break;
    }
    addList(draft.detail, 'fields', key);
    addList(draft.detail, 'validations', `${key}: ${chain.join('.')}`);
    const optional = chain.some((c) => ['optional', 'nullable', 'nullish', 'notRequired'].includes(c));
    const required = yup ? chain.includes('required') : !optional;
    addList(draft.detail, required ? 'requiredFields' : 'optionalFields', key);
  }
}

// ── Vue : blocs <script> et gestionnaires du <template> ──────────────────────────────────────

function vueScripts(text: string): { code: string; lineOffset: number; setup: boolean; ts: boolean }[] {
  const blocks: { code: string; lineOffset: number; setup: boolean; ts: boolean }[] = [];
  const regex = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  for (let match = regex.exec(text); match; match = regex.exec(text)) {
    const attrs = match[1] ?? '';
    const start = match.index + match[0].indexOf('>') + 1;
    const lineOffset = text.slice(0, start).split('\n').length - 1;
    blocks.push({
      code: match[2] ?? '',
      lineOffset,
      setup: /\bsetup\b/.test(attrs),
      ts: /lang\s*=\s*["']tsx?["']/.test(attrs),
    });
  }
  return blocks;
}

function vueTemplateHandlers(text: string): { event: string; name: string }[] {
  const template = /<template\b[^>]*>([\s\S]*)<\/template>/i.exec(text)?.[1] ?? '';
  const handlers: { event: string; name: string }[] = [];
  const regex = /(?:@|v-on:)([\w.-]+)\s*=\s*"([^"]+)"/g;
  for (let match = regex.exec(template); match; match = regex.exec(template)) {
    const name = /^\s*([A-Za-z_$][\w$]*)/.exec(match[2] ?? '')?.[1];
    if (name) handlers.push({ event: `@${match[1] ?? ''}`, name });
  }
  return handlers;
}
