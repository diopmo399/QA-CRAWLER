import type * as TS from 'typescript';
import { matchClose, parseJava, type JavaFile, type JavaTypeDecl } from '../incident/code/java-parser.js';
import type { JavaToken } from '../incident/code/java-lexer.js';
import type { TypeScriptModule } from '../static-analysis/typescript-loader.js';
import type {
  JavaRiskFacts,
  Loc,
  RiskFacts,
  RiskFlag,
  RiskHolder,
  RiskPipe,
  RiskSubscription,
  RiskWrite,
  UiFacts,
} from './facts.js';
import type { ReadFile } from './files.js';

/**
 * L'ANALYSEUR DES FAITS DE RISQUE. Il lit l'AST (TypeScript, Java) et note ce qui est démontrable : où une
 * donnée est gardée et pour combien de temps, qui l'écrit ou la remet à zéro, ce qui borne une souscription,
 * où un indicateur revient à faux, ce qui libère une ressource. Il ne conclut rien : les règles du moteur
 * décident à partir de ces faits et du graphe. Aucun nom de méthode ne sert de preuve (« reset », « clear »).
 */
export const RISK_ANALYZER = 'risk-1';

const MAX_FILE_BYTES = 400_000;
const MAX_TEXT = 120;
const SUBJECTS: Record<string, RiskHolder['kind']> = {
  BehaviorSubject: 'BEHAVIOR_SUBJECT',
  ReplaySubject: 'REPLAY_SUBJECT',
  Subject: 'SUBJECT',
};
const BOUNDING = new Set(['takeUntil', 'takeUntilDestroyed', 'take', 'first', 'takeWhile', 'single']);
const FLATTEN = new Set(['switchMap', 'mergeMap', 'concatMap', 'exhaustMap', 'flatMap']);
const MUTATORS = new Set([
  'push',
  'pop',
  'shift',
  'unshift',
  'splice',
  'sort',
  'reverse',
  'fill',
  'set',
  'delete',
  'clear',
  'add',
]);
const HTTP_CALL =
  /\b(?:http|httpClient|_http)\s*\.\s*(?:get|post|put|patch|delete|request|head|options|jsonp)\s*[<(]/;
const RESET_TEXT = /^(?:null|undefined|\[\]|\{\}|''|""|``|0|false|new Map\(\)|new Set\(\))$/;

const clip = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').replace(/ \./g, '.').trim();
  return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT - 1)}…` : flat;
};

interface ClassCtx {
  name: string;
  kind: RiskHolder['ownerKind'];
  scope: RiskHolder['scope'];
  node: TS.ClassDeclaration;
  sf: TS.SourceFile;
  file: string;
  /** Membre → classe injectée (constructeur, inject()). */
  deps: Map<string, string>;
  holders: Map<string, RiskHolder>;
  /** Membre exposé → membre gardé (`selected$` → `selected`). */
  exposed: Map<string, string>;
  /** Méthodes qui font (ou délèguent) un appel HTTP. */
  http: Set<string>;
  text: string;
}

/** Les faits de risque d'une source : TypeScript (Angular, RxJS) et Java (Spring). */
export function analyzeRisk(
  ts: TypeScriptModule | undefined,
  files: readonly ReadFile[],
  options: { typescript: boolean; java: boolean; ui?: UiFacts },
): RiskFacts {
  const facts: RiskFacts = {
    analyzer: RISK_ANALYZER,
    files: 0,
    holders: [],
    writes: [],
    subscriptions: [],
    flags: [],
    resources: [],
    pipes: [],
    aliases: [],
    tabs: options.ui ? tabsOf(options.ui) : [],
    warnings: [],
  };
  if (options.typescript) {
    if (ts) analyzeTypeScript(ts, files, facts);
    else facts.warnings.push('risk: TypeScript is not installed, the TypeScript risk facts are missing');
  }
  if (options.java) facts.java = analyzeJavaRisk(files, facts);
  return facts;
}

// ── TypeScript ─────────────────────────────────────────────────────────────────────────────────────────

function analyzeTypeScript(ts: TypeScriptModule, files: readonly ReadFile[], facts: RiskFacts): void {
  const classes = new Map<string, ClassCtx>();
  const componentProvided = new Set<string>();
  const moduleProvided = new Set<string>();
  const parsed: { file: ReadFile; sf: TS.SourceFile }[] = [];
  for (const file of files) {
    if (!/\.ts$/.test(file.path) || /\.(spec|test|d)\.ts$/.test(file.path)) continue;
    if (file.text.length > MAX_FILE_BYTES) {
      facts.warnings.push(`${file.path}: file too large for the risk analysis`);
      continue;
    }
    // Seuls les fichiers qui déclarent une classe ou un flux intéressent les règles.
    if (!/\bclass\b/.test(file.text)) continue;
    parsed.push({ file, sf: ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true) });
  }
  facts.files = parsed.length;
  // Passe 1 : les classes, leur rôle Angular, et qui les fournit.
  for (const { file, sf } of parsed) {
    const visit = (node: TS.Node): void => {
      if (ts.isClassDeclaration(node) && node.name) {
        const ctx = classOf(ts, node, sf, file.path);
        if (!classes.has(ctx.name)) classes.set(ctx.name, ctx);
        for (const deco of decorators(ts, node)) {
          const name = decoName(ts, deco);
          const providers = decoProviders(ts, deco);
          if (name === 'Component' || name === 'Directive')
            providers.forEach((p) => componentProvided.add(p));
          if (name === 'NgModule') providers.forEach((p) => moduleProvided.add(p));
        }
      }
      // `providers: [...]` d'une route : fourni par la route (portée de la route).
      if (
        ts.isPropertyAssignment(node) &&
        node.name.getText(sf) === 'providers' &&
        ts.isArrayLiteralExpression(node.initializer)
      ) {
        const inDecorator = (() => {
          for (let p: TS.Node = node.parent; ; p = p.parent) {
            if (ts.isDecorator(p)) return true;
            if (ts.isSourceFile(p)) break;
          }
          return false;
        })();
        if (!inDecorator)
          for (const el of node.initializer.elements) if (ts.isIdentifier(el)) moduleProvided.add(el.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  for (const ctx of classes.values()) {
    if (componentProvided.has(ctx.name)) ctx.scope = 'COMPONENT';
    else if (ctx.scope === 'UNKNOWN' && moduleProvided.has(ctx.name)) ctx.scope = 'PROVIDED';
  }
  // Passe 2 : les données gardées, et les méthodes qui appellent HTTP (une délégation suivie, bornée).
  for (const ctx of classes.values()) membersOf(ts, ctx);
  for (let round = 0; round < 3; round += 1)
    for (const ctx of classes.values())
      for (const member of ctx.node.members) {
        const name = memberName(ts, member, ctx.sf);
        const body = methodBody(ts, member);
        if (!name || !body || ctx.http.has(name)) continue;
        const text = body.getText(ctx.sf);
        if (HTTP_CALL.test(text) || callsHttp(ts, body, ctx, classes)) ctx.http.add(name);
      }
  for (const ctx of classes.values()) {
    for (const holder of ctx.holders.values()) {
      const persisted = persistenceOf(ctx, holder);
      if (persisted) holder.persisted = persisted;
      const exposedAs = [...ctx.exposed].filter(([, h]) => h === holder.member).map(([m]) => m);
      if (exposedAs.length) holder.exposedAs = exposedAs;
      facts.holders.push(holder);
    }
  }
  // Passe 3 : le comportement de chaque méthode.
  for (const ctx of classes.values()) behaviourOf(ts, ctx, classes, facts);
}

function decorators(ts: TypeScriptModule, node: TS.Node): readonly TS.Decorator[] {
  return ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [];
}

function decoName(ts: TypeScriptModule, deco: TS.Decorator): string {
  const expr = deco.expression;
  const callee = ts.isCallExpression(expr) ? expr.expression : expr;
  return ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : '';
}

function decoArg(ts: TypeScriptModule, deco: TS.Decorator, key: string): TS.Expression | undefined {
  const expr = deco.expression;
  if (!ts.isCallExpression(expr)) return undefined;
  const arg = expr.arguments[0];
  if (!arg || !ts.isObjectLiteralExpression(arg)) return undefined;
  for (const prop of arg.properties)
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === key)
      return prop.initializer;
  return undefined;
}

function decoProviders(ts: TypeScriptModule, deco: TS.Decorator): string[] {
  const out: string[] = [];
  for (const key of ['providers', 'viewProviders']) {
    const list = decoArg(ts, deco, key);
    if (!list || !ts.isArrayLiteralExpression(list)) continue;
    for (const el of list.elements) {
      if (ts.isIdentifier(el)) out.push(el.text);
      else if (ts.isObjectLiteralExpression(el))
        for (const prop of el.properties)
          if (
            ts.isPropertyAssignment(prop) &&
            ts.isIdentifier(prop.name) &&
            ['provide', 'useClass', 'useExisting'].includes(prop.name.text) &&
            ts.isIdentifier(prop.initializer)
          )
            out.push(prop.initializer.text);
    }
  }
  return out;
}

function classOf(ts: TypeScriptModule, node: TS.ClassDeclaration, sf: TS.SourceFile, file: string): ClassCtx {
  let kind: ClassCtx['kind'] = 'OTHER';
  let scope: ClassCtx['scope'] = 'UNKNOWN';
  for (const deco of decorators(ts, node)) {
    const name = decoName(ts, deco);
    if (name === 'Component' || name === 'Directive' || name === 'Pipe') kind = 'COMPONENT';
    if (name === 'Injectable') {
      kind = 'SERVICE';
      const provided = decoArg(ts, deco, 'providedIn');
      if (provided && ts.isStringLiteralLike(provided) && ['root', 'platform', 'any'].includes(provided.text))
        scope = 'ROOT';
    }
  }
  // Un store maison qui étend ComponentStore / Store : un service.
  if (kind === 'OTHER' && node.heritageClauses?.some((h) => /\b(ComponentStore|Store)\b/.test(h.getText(sf))))
    kind = 'SERVICE';
  if (kind === 'COMPONENT') scope = 'COMPONENT';
  return {
    name: node.name?.text ?? '',
    kind,
    scope,
    node,
    sf,
    file,
    deps: new Map(),
    holders: new Map(),
    exposed: new Map(),
    http: new Set(),
    text: node.getText(sf),
  };
}

const locOf = (sf: TS.SourceFile, file: string, node: TS.Node): Loc => ({
  file,
  line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
});

function memberName(ts: TypeScriptModule, member: TS.ClassElement, sf: TS.SourceFile): string | undefined {
  if (ts.isConstructorDeclaration(member)) return 'constructor';
  if (!member.name) return undefined;
  return member.name.getText(sf);
}

/** Le corps d'une méthode, d'un constructeur, d'un accesseur, ou d'une propriété initialisée par une fonction. */
function methodBody(ts: TypeScriptModule, member: TS.ClassElement): TS.Node | undefined {
  if (
    (ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member) || ts.isGetAccessor(member)) &&
    member.body
  )
    return member.body;
  if (ts.isPropertyDeclaration(member) && member.initializer) {
    const init = member.initializer;
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init.body;
  }
  return undefined;
}

function membersOf(ts: TypeScriptModule, ctx: ClassCtx): void {
  const { sf } = ctx;
  const ctor = ctx.node.members.find(ts.isConstructorDeclaration);
  for (const p of ctor?.parameters ?? [])
    if (p.type && ts.isTypeReferenceNode(p.type) && ts.isIdentifier(p.name))
      ctx.deps.set(p.name.text, p.type.typeName.getText(sf).split('.').pop() ?? '');
  const derived: [string, TS.Expression][] = [];
  for (const member of ctx.node.members) {
    if (!ts.isPropertyDeclaration(member)) continue;
    if (member.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword)) continue;
    const name = member.name.getText(sf);
    const init = member.initializer;
    const loc = locOf(sf, ctx.file, member);
    const hidden =
      ts.isPrivateIdentifier(member.name) ||
      Boolean(
        member.modifiers?.some(
          (m) => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword,
        ),
      );
    const base = {
      id: `${ctx.name}.${name}`,
      owner: ctx.name,
      member: name,
      ownerKind: ctx.kind,
      scope: ctx.scope,
      ...(hidden ? {} : { public: true }),
      loc,
    };
    if (
      init &&
      ts.isNewExpression(init) &&
      ts.isIdentifier(init.expression) &&
      SUBJECTS[init.expression.text]
    ) {
      const first = init.arguments?.[0];
      ctx.holders.set(name, {
        ...base,
        kind: SUBJECTS[init.expression.text] ?? 'SUBJECT',
        ...(first ? { initial: clip(first.getText(sf)) } : {}),
      });
      continue;
    }
    if (init && ts.isCallExpression(init) && ts.isIdentifier(init.expression)) {
      if (init.expression.text === 'signal') {
        const first = init.arguments[0];
        ctx.holders.set(name, {
          ...base,
          kind: 'SIGNAL',
          ...(first ? { initial: clip(first.getText(sf)) } : {}),
        });
        continue;
      }
      if (init.expression.text === 'inject') {
        const target = init.arguments[0];
        if (target && ts.isIdentifier(target)) ctx.deps.set(name, target.text);
        continue;
      }
    }
    if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) continue;
    if (init && (ts.isCallExpression(init) || ts.isPropertyAccessExpression(init))) {
      derived.push([name, init]);
      continue;
    }
    // Un champ d'un service (portée applicative ou fournie) : un état partagé possible.
    const typed = member.type?.getText(sf) ?? '';
    if (ctx.kind === 'SERVICE' && !/Observable|Subscription|EventEmitter|Signal/.test(typed))
      ctx.holders.set(name, { ...base, kind: 'FIELD', ...(init ? { initial: clip(init.getText(sf)) } : {}) });
  }
  // Un membre calculé à partir d'une donnée gardée l'expose (asObservable, pipe, toObservable, computed).
  for (const [name, init] of derived) {
    const refs = [...init.getText(sf).matchAll(/this\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1] ?? '');
    const target = refs.find((r) => ctx.holders.has(r) || ctx.exposed.has(r));
    if (target) ctx.exposed.set(name, ctx.holders.has(target) ? target : (ctx.exposed.get(target) ?? target));
  }
}

function callsHttp(
  ts: TypeScriptModule,
  body: TS.Node,
  ctx: ClassCtx,
  classes: Map<string, ClassCtx>,
): boolean {
  let found = false;
  const visit = (node: TS.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const recv = node.expression.expression;
      if (recv.kind === ts.SyntaxKind.ThisKeyword && ctx.http.has(method)) found = true;
      else if (
        ts.isPropertyAccessExpression(recv) &&
        recv.expression.kind === ts.SyntaxKind.ThisKeyword &&
        classes.get(ctx.deps.get(recv.name.text) ?? '')?.http.has(method)
      )
        found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return found;
}

function persistenceOf(ctx: ClassCtx, holder: RiskHolder): string | undefined {
  if (holder.initial && /\b(localStorage|sessionStorage)\b/.test(holder.initial))
    return holder.initial.match(/\b(localStorage|sessionStorage)\b/)?.[1];
  // Une méthode qui écrit le stockage du navigateur en lisant ce membre.
  const re = new RegExp(
    `(localStorage|sessionStorage)\\.setItem\\([^;]*this\\.${holder.member.replace(/\$/g, '\\$')}\\b`,
  );
  return re.exec(ctx.text)?.[1];
}

interface Resolved {
  holder: RiskHolder;
  /** L'expression lit la valeur courante (`.value`, `.getValue()`, `sig()`). */
  valueRead?: boolean;
}

/** La donnée gardée que désigne une expression (`this.x`, `this.store.x$`, `this.x.value`). */
function resolveHolder(
  ts: TypeScriptModule,
  expr: TS.Expression,
  ctx: ClassCtx,
  classes: Map<string, ClassCtx>,
): Resolved | undefined {
  let e = expr;
  let valueRead = false;
  while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
  if (ts.isPropertyAccessExpression(e) && e.name.text === 'value') {
    valueRead = true;
    e = e.expression;
  } else if (
    ts.isCallExpression(e) &&
    ts.isPropertyAccessExpression(e.expression) &&
    e.expression.name.text === 'getValue'
  ) {
    valueRead = true;
    e = e.expression.expression;
  } else if (
    ts.isCallExpression(e) &&
    e.arguments.length === 0 &&
    ts.isPropertyAccessExpression(e.expression)
  ) {
    // `this.sig()` : la valeur d'un signal.
    const inner = resolveHolder(ts, e.expression, ctx, classes);
    if (inner?.holder.kind === 'SIGNAL') return { holder: inner.holder, valueRead: true };
  }
  if (!ts.isPropertyAccessExpression(e)) return undefined;
  const name = e.name.text;
  const recv = e.expression;
  const pick = (owner: ClassCtx | undefined): RiskHolder | undefined => {
    if (!owner) return undefined;
    const member = owner.holders.has(name) ? name : owner.exposed.get(name);
    return member ? owner.holders.get(member) : undefined;
  };
  let holder: RiskHolder | undefined;
  if (recv.kind === ts.SyntaxKind.ThisKeyword) holder = pick(ctx);
  else if (ts.isPropertyAccessExpression(recv) && recv.expression.kind === ts.SyntaxKind.ThisKeyword)
    holder = pick(classes.get(ctx.deps.get(recv.name.text) ?? ''));
  return holder ? { holder, ...(valueRead ? { valueRead } : {}) } : undefined;
}

type Context =
  'NEXT' | 'ERROR' | 'COMPLETE' | 'FINALIZE' | 'FINALLY' | 'CATCH' | 'THEN' | 'AFTER_AWAIT' | 'SYNC';

/** Où s'exécute un nœud par rapport au corps de sa méthode : suite d'une souscription, d'un await… */
function contextOf(ts: TypeScriptModule, node: TS.Node, body: TS.Node, awaits: readonly number[]): Context {
  for (let cur: TS.Node = node; cur !== body && !ts.isSourceFile(cur); cur = cur.parent) {
    const parent = cur.parent;
    if (ts.isCatchClause(parent)) return 'CATCH';
    if (ts.isTryStatement(parent) && parent.finallyBlock === cur) return 'FINALLY';
    const fn = ts.isArrowFunction(cur) || ts.isFunctionExpression(cur) || ts.isMethodDeclaration(cur);
    if (!fn) continue;
    // Une fonction passée à subscribe / then / catch / finalize, ou une propriété next/error/complete.
    let host: TS.Node = parent;
    let key: string | undefined;
    if (ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(cur)) {
      const prop = ts.isPropertyAssignment(parent) ? parent : cur;
      key = (prop as TS.PropertyAssignment).name.getText();
      host = (ts.isPropertyAssignment(parent) ? parent.parent : cur.parent).parent;
    }
    if (ts.isCallExpression(host)) {
      const callee = host.expression;
      const name = ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : ts.isIdentifier(callee)
          ? callee.text
          : '';
      if (name === 'subscribe' || name === 'tap') {
        if (key === 'error') return 'ERROR';
        if (key === 'complete') return 'COMPLETE';
        if (key === 'next') return 'NEXT';
        const index = host.arguments.indexOf(cur as TS.Expression);
        return index === 1 ? 'ERROR' : index === 2 ? 'COMPLETE' : 'NEXT';
      }
      if (name === 'then') return host.arguments.indexOf(cur as TS.Expression) === 1 ? 'ERROR' : 'THEN';
      if (name === 'catch' || name === 'catchError') return 'ERROR';
      if (name === 'finalize') return 'FINALIZE';
    }
  }
  const pos = node.getStart();
  return awaits.some((a) => a < pos) ? 'AFTER_AWAIT' : 'SYNC';
}

const resetValue = (arg: string | undefined, initial: string | undefined): boolean => {
  if (arg === undefined) return true;
  const flat = arg.replace(/\s+/g, '');
  return RESET_TEXT.test(flat) || (initial !== undefined && flat === initial.replace(/\s+/g, ''));
};

function operatorsOf(ts: TypeScriptModule, call: TS.CallExpression): string[] {
  return call.arguments.map((arg) => {
    if (!ts.isCallExpression(arg)) return arg.getText().slice(0, 30);
    const c = arg.expression;
    return ts.isIdentifier(c) ? c.text : ts.isPropertyAccessExpression(c) ? c.name.text : 'op';
  });
}

/** La source d'un flux souscrit, sans son pipe : `this.http.get(…)`, `this.store.client$`… */
function splitPipe(
  ts: TypeScriptModule,
  recv: TS.Expression,
): { base: TS.Expression; pipe?: TS.CallExpression } {
  if (
    ts.isCallExpression(recv) &&
    ts.isPropertyAccessExpression(recv.expression) &&
    recv.expression.name.text === 'pipe'
  )
    return { base: recv.expression.expression, pipe: recv };
  return { base: recv };
}

function sourceKindOf(
  ts: TypeScriptModule,
  base: TS.Expression,
  ctx: ClassCtx,
  classes: Map<string, ClassCtx>,
): { kind: RiskSubscription['sourceKind']; holder?: string } {
  const text = base.getText(ctx.sf);
  const resolved = resolveHolder(ts, base, ctx, classes);
  if (resolved) return { kind: 'HOLDER', holder: resolved.holder.id };
  if (ts.isCallExpression(base) && ts.isPropertyAccessExpression(base.expression)) {
    const name = base.expression.name.text;
    if (name === 'asObservable') {
      const inner = resolveHolder(ts, base.expression.expression, ctx, classes);
      if (inner) return { kind: 'HOLDER', holder: inner.holder.id };
    }
    const recv = base.expression.expression;
    if (recv.kind === ts.SyntaxKind.ThisKeyword && ctx.http.has(name)) return { kind: 'HTTP' };
    if (
      ts.isPropertyAccessExpression(recv) &&
      recv.expression.kind === ts.SyntaxKind.ThisKeyword &&
      classes.get(ctx.deps.get(recv.name.text) ?? '')?.http.has(name)
    )
      return { kind: 'HTTP' };
  }
  if (HTTP_CALL.test(text)) return { kind: 'HTTP' };
  if (
    /\.(params|paramMap|queryParams|queryParamMap|data|fragment|url)\b/.test(text) ||
    /\brouter\.events\b/.test(text)
  )
    return { kind: 'ROUTE' };
  if (/\.(valueChanges|statusChanges)\b/.test(text)) return { kind: 'FORM' };
  if (/^(?:interval|timer)\(/.test(text)) return { kind: 'TIMER' };
  if (/^fromEvent\(/.test(text)) return { kind: 'EVENT' };
  return { kind: 'OTHER' };
}

function behaviourOf(
  ts: TypeScriptModule,
  ctx: ClassCtx,
  classes: Map<string, ClassCtx>,
  facts: RiskFacts,
): void {
  const { sf } = ctx;
  const loc = (node: TS.Node): Loc => locOf(sf, ctx.file, node);
  const classText = ctx.text;
  const subscriptionsByNode = new Map<TS.Node, RiskSubscription>();
  for (const member of ctx.node.members) {
    const name = memberName(ts, member, sf);
    const body = methodBody(ts, member);
    if (!name) continue;
    // Un flux longue durée déclaré en membre (effet, `x$ = this.actions$.pipe(…)`).
    if (ts.isPropertyDeclaration(member) && member.initializer && !body) {
      const pipeCall = findPipe(ts, member.initializer);
      if (pipeCall) {
        const piped = pipeOf(ts, ctx, classes, pipeCall, `${ctx.name}.${name}`);
        if (piped) facts.pipes.push(piped);
      }
      continue;
    }
    if (!body) continue;
    const by = `${ctx.name}#${name}`;
    const awaits: number[] = [];
    const collect = (node: TS.Node): void => {
      if (ts.isAwaitExpression(node)) awaits.push(node.getStart(sf));
      ts.forEachChild(node, collect);
    };
    collect(body);
    const writesHere: { write: RiskWrite; node: TS.Node }[] = [];
    const flagsSet = new Map<string, TS.Node>();
    const flagResets = new Map<string, Context[]>();
    const emitted: { holder: RiskHolder; variable: string; end: number; node: TS.Node }[] = [];
    const record = (
      holder: RiskHolder,
      value: RiskWrite['value'],
      how: RiskWrite['how'],
      node: TS.Node,
    ): void => {
      const context = contextOf(ts, node, body, awaits);
      const async =
        context === 'NEXT' || context === 'ERROR' || context === 'COMPLETE' || context === 'AFTER_AWAIT'
          ? context
          : context === 'THEN'
            ? 'THEN'
            : undefined;
      const write: RiskWrite = {
        holder: holder.id,
        by,
        value,
        how,
        ...(async ? { async } : {}),
        text: clip(node.getText(sf)),
        loc: loc(node),
      };
      writesHere.push({ write, node });
    };
    const visit = (node: TS.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        const recv = node.expression.expression;
        // Écritures : next() d'un Subject, set()/update() d'un signal.
        if (method === 'next' || method === 'set' || method === 'update') {
          const resolved = resolveHolder(ts, recv, ctx, classes);
          const h = resolved?.holder;
          if (
            h &&
            !resolved.valueRead &&
            ((method === 'next' && h.kind !== 'SIGNAL' && h.kind !== 'FIELD') ||
              (method !== 'next' && h.kind === 'SIGNAL'))
          ) {
            const arg = node.arguments[0];
            const value =
              method === 'update' ? 'VALUE' : resetValue(arg?.getText(sf), h.initial) ? 'RESET' : 'VALUE';
            record(h, value, method === 'next' ? 'NEXT' : method === 'set' ? 'SET' : 'UPDATE', node);
            if (arg && ts.isIdentifier(arg))
              emitted.push({ holder: h, variable: arg.text, end: node.getEnd(), node });
          }
        }
        // Mutation en place de la valeur courante (`this.x.value.push(…)`, `this.list.push(…)`).
        if (MUTATORS.has(method)) {
          const resolved = resolveHolder(ts, recv, ctx, classes);
          if (resolved && (resolved.valueRead || resolved.holder.kind === 'FIELD'))
            record(resolved.holder, 'MUTATION', 'METHOD', node);
        }
        if (method === 'subscribe') {
          const sub = subscriptionOf(ts, ctx, classes, node, by, loc(node));
          subscriptionsByNode.set(node, sub);
          facts.subscriptions.push(sub);
          if (sub.operators.some((o) => FLATTEN.has(o)) && sub.sourceKind !== 'HTTP') {
            const { pipe } = splitPipe(ts, recv);
            const piped = pipe ? pipeOf(ts, ctx, classes, pipe, by) : undefined;
            if (piped) facts.pipes.push(piped);
          }
        }
        // Ressources : écouteurs, minuteries, observateurs, sockets.
        if (method === 'addEventListener') {
          const event = node.arguments[0]?.getText(sf) ?? '';
          const released = classText.includes(`removeEventListener(${event}`)
            ? 'removeEventListener'
            : undefined;
          facts.resources.push({
            owner: ctx.name,
            ownerKind: ctx.kind,
            method: by,
            kind: 'LISTENER',
            target: clip(`${recv.getText(sf)} ${event}`),
            ...(released ? { released } : {}),
            loc: loc(node),
          });
        }
      }
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'setInterval'
      ) {
        const released = /clearInterval\(/.test(classText) ? 'clearInterval' : undefined;
        facts.resources.push({
          owner: ctx.name,
          ownerKind: ctx.kind,
          method: by,
          kind: 'INTERVAL',
          target: 'setInterval',
          ...(released ? { released } : {}),
          loc: loc(node),
        });
      }
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
        const ctor = node.expression.text;
        if (/^(Intersection|Mutation|Resize|Performance)Observer$/.test(ctor)) {
          const released = /\.disconnect\(\)/.test(classText) ? 'disconnect' : undefined;
          facts.resources.push({
            owner: ctx.name,
            ownerKind: ctx.kind,
            method: by,
            kind: 'OBSERVER',
            target: ctor,
            ...(released ? { released } : {}),
            loc: loc(node),
          });
        }
        if (ctor === 'WebSocket' || ctor === 'EventSource') {
          const released = /\.close\(\)/.test(classText) ? 'close' : undefined;
          facts.resources.push({
            owner: ctx.name,
            ownerKind: ctx.kind,
            method: by,
            kind: 'WEBSOCKET',
            target: ctor,
            ...(released ? { released } : {}),
            loc: loc(node),
          });
        }
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const left = node.left;
        // Affectation d'un champ gardé (`this.store.current = …`) ou d'une propriété de sa valeur.
        if (ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) {
          const direct = ts.isPropertyAccessExpression(left)
            ? resolveHolder(ts, left, ctx, classes)
            : undefined;
          if (direct && direct.holder.kind === 'FIELD' && !direct.valueRead) {
            record(
              direct.holder,
              resetValue(node.right.getText(sf), direct.holder.initial) ? 'RESET' : 'VALUE',
              'ASSIGN',
              node,
            );
          } else {
            const inner = resolveHolder(ts, left.expression, ctx, classes);
            if (inner && (inner.valueRead || inner.holder.kind === 'FIELD'))
              record(inner.holder, 'MUTATION', 'PROPERTY', node);
          }
          // Un indicateur du composant : `this.m = true` puis `this.m = false`.
          if (ts.isPropertyAccessExpression(left) && left.expression.kind === ts.SyntaxKind.ThisKeyword) {
            const member = left.name.text;
            const right = node.right.kind;
            if (
              right === ts.SyntaxKind.TrueKeyword &&
              contextOf(ts, node, body, awaits) === 'SYNC' &&
              !flagsSet.has(member)
            )
              flagsSet.set(member, node);
            if (right === ts.SyntaxKind.FalseKeyword)
              flagResets.set(member, [...(flagResets.get(member) ?? []), contextOf(ts, node, body, awaits)]);
          }
        }
        // Alias : la variable émise est modifiée après l'émission.
        const root = rootIdentifier(ts, left);
        if (root && left !== root)
          for (const e of emitted)
            if (e.variable === root.text && node.getStart(sf) > e.end)
              facts.aliases.push({
                by,
                holder: e.holder.id,
                variable: e.variable,
                mutation: clip(node.getText(sf)),
                loc: loc(node),
              });
      }
      ts.forEachChild(node, visit);
    };
    visit(body);
    // Un rappel qui délègue la remise à faux à une méthode de la classe (`next: () => this.done()`).
    for (const sub of subscriptionsByNode.keys()) {
      const call = sub as TS.CallExpression;
      call.arguments.forEach((arg, index) => {
        const entries: [Context, TS.Node][] = ts.isObjectLiteralExpression(arg)
          ? arg.properties.flatMap((p): [Context, TS.Node][] => {
              const key = p.name?.getText(sf);
              const value = ts.isPropertyAssignment(p)
                ? p.initializer
                : ts.isMethodDeclaration(p)
                  ? p
                  : undefined;
              return value && (key === 'next' || key === 'error' || key === 'complete')
                ? [[key === 'next' ? 'NEXT' : key === 'error' ? 'ERROR' : 'COMPLETE', value]]
                : [];
            })
          : [[index === 0 ? 'NEXT' : index === 1 ? 'ERROR' : 'COMPLETE', arg]];
        for (const [context, fn] of entries)
          for (const callee of fn.getText(sf).matchAll(/this\.([A-Za-z_$][\w$]*)\(/g)) {
            const target = ctx.node.members.find((m) => memberName(ts, m, sf) === callee[1]);
            const targetBody = target ? methodBody(ts, target) : undefined;
            if (!targetBody) continue;
            for (const m of targetBody.getText(sf).matchAll(/this\.([A-Za-z_$][\w$]*)\s*=\s*false\b/g))
              flagResets.set(m[1] ?? '', [...(flagResets.get(m[1] ?? '') ?? []), context]);
          }
      });
    }
    for (const [member, setNode] of flagsSet) {
      const resets: RiskFlag['resets'] = [...new Set(flagResets.get(member) ?? [])].map((c) =>
        c === 'THEN' ? 'NEXT' : c,
      );
      if (!resets.some((r) => r === 'NEXT' || r === 'AFTER_AWAIT')) continue;
      const via: RiskFlag['via'] =
        subscriptionsByNode.size > 0 ? 'SUBSCRIBE' : awaits.length > 0 ? 'AWAIT' : 'THEN';
      const errorPath =
        [...subscriptionsByNode.values()].some((s) => s.errorHandled) ||
        /\bcatch\s*\(|\.catch\(/.test(body.getText(sf));
      facts.flags.push({ owner: ctx.name, member, method: by, via, resets, errorPath, loc: loc(setNode) });
    }
    facts.writes.push(...writesHere.map((w) => w.write));
    // Ce que font les suites des souscriptions de cette méthode.
    for (const [node, sub] of subscriptionsByNode) {
      const start = node.getStart(sf);
      const end = node.getEnd();
      sub.nextWrites = [
        ...new Set(
          writesHere
            .filter((w) => w.write.async === 'NEXT' && w.node.getStart(sf) >= start && w.node.getEnd() <= end)
            .map((w) => w.write.holder),
        ),
      ];
    }
  }
}

function rootIdentifier(ts: TypeScriptModule, expr: TS.Expression): TS.Identifier | undefined {
  let e: TS.Expression = expr;
  while (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) e = e.expression;
  return ts.isIdentifier(e) ? e : undefined;
}

function findPipe(ts: TypeScriptModule, node: TS.Node): TS.CallExpression | undefined {
  let found: TS.CallExpression | undefined;
  const visit = (n: TS.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === 'pipe'
    ) {
      found = n;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/** Un pipe qui aplatit vers HTTP : l'erreur est-elle rattrapée dans le flux interne ? */
function pipeOf(
  ts: TypeScriptModule,
  ctx: ClassCtx,
  classes: Map<string, ClassCtx>,
  pipe: TS.CallExpression,
  at: string,
): RiskPipe | undefined {
  const operators = operatorsOf(ts, pipe);
  const index = operators.findIndex((o) => FLATTEN.has(o));
  if (index < 0) return undefined;
  const flattenCall = pipe.arguments[index];
  if (!flattenCall || !ts.isCallExpression(flattenCall)) return undefined;
  const inner = flattenCall.arguments[0];
  if (!inner) return undefined;
  const innerText = inner.getText(ctx.sf);
  let reachesHttp = HTTP_CALL.test(innerText);
  if (!reachesHttp)
    for (const m of innerText.matchAll(/this\.(?:([A-Za-z_$][\w$]*)\.)?([A-Za-z_$][\w$]*)\(/g)) {
      const owner = m[1] ? classes.get(ctx.deps.get(m[1]) ?? '') : ctx;
      if (owner?.http.has(m[2] ?? '')) reachesHttp = true;
    }
  if (!reachesHttp) return undefined;
  const { base } = splitPipe(ts, pipe);
  return {
    owner: ctx.name,
    at,
    source: clip(base.getText(ctx.sf)),
    operators,
    flatten: operators[index] ?? 'switchMap',
    catchInner: /\bcatchError\s*\(/.test(innerText),
    catchOuter: operators.slice(index + 1).some((o) => o === 'catchError' || o === 'retry'),
    loc: locOf(ctx.sf, ctx.file, pipe),
  };
}

function subscriptionOf(
  ts: TypeScriptModule,
  ctx: ClassCtx,
  classes: Map<string, ClassCtx>,
  call: TS.CallExpression,
  method: string,
  loc: Loc,
): RiskSubscription {
  const { sf } = ctx;
  const recv = (call.expression as TS.PropertyAccessExpression).expression;
  const { base, pipe } = splitPipe(ts, recv);
  const operators = pipe ? operatorsOf(ts, pipe) : [];
  const { kind, holder } = sourceKindOf(ts, base, ctx, classes);
  const cleanup = operators.filter((o) => BOUNDING.has(o));
  // La souscription gardée dans un membre, une variable ou un sac, et libérée dans la classe.
  const parent = call.parent;
  let keptIn: string | undefined;
  if (ts.isBinaryExpression(parent) && parent.right === call && ts.isPropertyAccessExpression(parent.left))
    keptIn = parent.left.name.text;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    const local = parent.name.text;
    const methodNode = ctx.node.members.find((m) => `${ctx.name}#${memberName(ts, m, sf) ?? ''}` === method);
    if (methodNode && new RegExp(`\\b${local}\\??\\.unsubscribe\\(`).test(methodNode.getText(sf)))
      cleanup.push('unsubscribe');
    if (new RegExp(`this\\.([A-Za-z_$][\\w$]*)\\s*(?:=|\\.push\\(|\\.add\\()\\s*${local}\\b`).test(ctx.text))
      cleanup.push('kept');
  }
  if (
    ts.isCallExpression(parent) &&
    ts.isPropertyAccessExpression(parent.expression) &&
    ['add', 'push'].includes(parent.expression.name.text)
  ) {
    const bag = parent.expression.expression.getText(sf);
    if (new RegExp(`${bag.replace(/[.$]/g, '\\$&')}\\??\\.(?:unsubscribe\\(|forEach\\()`).test(ctx.text))
      cleanup.push('subscription-bag');
  }
  if (keptIn && new RegExp(`this\\.${keptIn.replace(/\$/g, '\\$')}\\??\\.unsubscribe\\(`).test(ctx.text))
    cleanup.push('unsubscribe');
  // Une souscription précédente libérée avant d'en installer une nouvelle (garde contre les réponses obsolètes).
  const replacesPrevious =
    keptIn !== undefined &&
    new RegExp(`this\\.${keptIn.replace(/\$/g, '\\$')}\\??\\.unsubscribe\\(`).test(
      sf.text.slice(ctx.node.getStart(sf), call.getStart(sf)).split(/\n/).slice(-40).join('\n'),
    );
  const args = call.arguments;
  const observer = args[0] && ts.isObjectLiteralExpression(args[0]) ? args[0] : undefined;
  const keyOf = (p: TS.ObjectLiteralElementLike): string => p.name?.getText(sf) ?? '';
  const errorHandled =
    args.length >= 2 ||
    Boolean(observer?.properties.some((p) => keyOf(p) === 'error')) ||
    operators.some((o) => o === 'catchError' || o === 'retry' || o === 'retryWhen');
  const nextFn = observer ? observer.properties.find((p) => keyOf(p) === 'next') : args[0];
  const nextText = nextFn?.getText(sf) ?? '';
  const nextAssigns = [
    ...new Set([...nextText.matchAll(/this\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)].map((m) => m[1] ?? '')),
  ];
  const nextCalls = [
    ...new Set(
      [...nextText.matchAll(/this\.([A-Za-z_$][\w$.]*)\s*\(/g)]
        .map((m) => m[1] ?? '')
        .filter((c) => !/\.(?:next|set|update)$/.test(c)),
    ),
  ].slice(0, 8);
  // Installée dans la suite d'une autre souscription : celle-ci se répète à chaque émission de l'autre.
  let nestedIn: RiskSubscription['sourceKind'] | undefined;
  for (let cur: TS.Node = call.parent; cur !== ctx.node && !ts.isSourceFile(cur); cur = cur.parent)
    if (
      ts.isCallExpression(cur) &&
      ts.isPropertyAccessExpression(cur.expression) &&
      cur.expression.name.text === 'subscribe' &&
      cur !== call
    ) {
      const outer = splitPipe(ts, cur.expression.expression);
      nestedIn = sourceKindOf(ts, outer.base, ctx, classes).kind;
      break;
    }
  return {
    owner: ctx.name,
    ownerKind: ctx.kind,
    method,
    source: clip(base.getText(sf)),
    sourceKind: kind,
    ...(holder ? { holder } : {}),
    operators,
    cleanup: [...new Set(cleanup)],
    errorHandled,
    nextWrites: [],
    nextAssigns,
    nextCalls,
    ...(nestedIn ? { nestedIn } : {}),
    ...(replacesPrevious ? { replacesPrevious } : {}),
    loc,
  };
}

/** Les composants affichés dans un onglet (structure des gabarits déjà lue par l'analyse Angular). */
function tabsOf(ui: UiFacts): RiskFacts['tabs'] {
  const elements = new Map((ui.elements ?? []).map((e) => [e.id, e]));
  const bySelector = new Map(
    ui.components.flatMap((c) => (c.selector ? [[c.selector, c.name] as const] : [])),
  );
  const out: RiskFacts['tabs'] = [];
  for (const child of ui.children ?? []) {
    let tab = child.container ? elements.get(child.container) : undefined;
    while (tab && tab.tab?.role !== 'TAB') tab = tab.parent ? elements.get(tab.parent) : undefined;
    if (!tab) continue;
    let group = tab.parent ? elements.get(tab.parent) : undefined;
    while (group && group.tab?.role !== 'GROUP')
      group = group.parent ? elements.get(group.parent) : undefined;
    const component = child.className ?? (child.tag ? bySelector.get(child.tag) : undefined);
    if (component) out.push({ group: group?.id ?? `${child.component}#tabs`, tab: tab.id, component });
  }
  return out;
}

// ── Java ───────────────────────────────────────────────────────────────────────────────────────────────

const STEREOTYPES = new Set(['Service', 'Component', 'RestController', 'Controller']);
const INJECTED = new Set(['Autowired', 'Inject', 'Value', 'Resource', 'PersistenceContext', 'MockBean']);
const DB_WRITES = new Set([
  'save',
  'saveAll',
  'saveAndFlush',
  'delete',
  'deleteById',
  'deleteAll',
  'deleteAllById',
  'insert',
  'update',
  'persist',
  'merge',
  'remove',
  'executeUpdate',
  'batchUpdate',
]);

function analyzeJavaRisk(files: readonly ReadFile[], facts: RiskFacts): JavaRiskFacts {
  const out: JavaRiskFacts = { mutable: [], swallowed: [], writes: [] };
  for (const file of files) {
    if (!/\.java$/.test(file.path) || /\/test\//.test(file.path)) continue;
    if (file.text.length > MAX_FILE_BYTES) continue;
    let parsed: JavaFile;
    try {
      parsed = parseJava(file.text);
    } catch (error) {
      facts.warnings.push(`${file.path}: ${(error as Error).message}`);
      continue;
    }
    facts.files += 1;
    for (const type of parsed.types) javaType(parsed, type, file.path, out);
  }
  return out;
}

function javaType(parsed: JavaFile, type: JavaTypeDecl, file: string, out: JavaRiskFacts): void {
  const tokens = parsed.tokens;
  const stereotype = type.annotations.map((a) => a.name).find((n) => STEREOTYPES.has(n));
  const scope = type.annotations.find(
    (a) => a.name === 'Scope' || a.name === 'RequestScope' || a.name === 'SessionScope',
  );
  const singleton = stereotype !== undefined && (!scope || /singleton/i.test(scope.text));
  const classTransactional = type.annotations.some((a) => a.name === 'Transactional');
  const fieldTypes = new Map(type.fields.map((f) => [f.name, f.type.name]));
  const bodyOf = (m: JavaTypeDecl['methods'][number]): JavaToken[] =>
    m.body ? tokens.slice(m.body.start, m.body.end) : [];
  // 1. État modifiable d'un singleton.
  if (singleton)
    for (const field of type.fields) {
      if (field.modifiers.includes('static') || field.modifiers.includes('final')) continue;
      if (field.annotations.some((a) => INJECTED.has(a.name))) continue;
      if (/^(Logger|Log)$/.test(field.type.name)) continue;
      const writers = type.methods
        .filter((m) => !m.constructor && !m.annotations.some((a) => a.name === 'PostConstruct'))
        .filter((m) => {
          const body = bodyOf(m);
          return body.some((t, i) => {
            if (t.text !== field.name || t.kind !== 'ident') return false;
            const prev = body[i - 1]?.text;
            const prevPrev = body[i - 2]?.text;
            const next = body[i + 1]?.text;
            const qualified = prev !== '.' || prevPrev === 'this';
            return (
              qualified && (next === '=' || next === '++' || next === '--' || /^[+\-*/]=$/.test(next ?? ''))
            );
          });
        })
        .map((m) => m.name);
      if (writers.length > 0)
        out.mutable.push({
          cls: type.name,
          stereotype,
          field: field.name,
          type: field.type.text,
          writers,
          loc: { file, line: field.line },
        });
    }
  for (const m of type.methods) {
    const body = bodyOf(m);
    if (body.length === 0) continue;
    // 2. Exceptions rattrapées sans suite.
    for (let i = 0; i < body.length; i += 1) {
      if (body[i]?.text !== 'catch' || body[i + 1]?.text !== '(') continue;
      const closeParen = body.findIndex((t, j) => j > i && t.text === ')');
      const exception = body
        .slice(i + 2, Math.max(i + 2, closeParen - 1))
        .map((t) => t.text)
        .join('');
      const open = closeParen + 1;
      if (body[open]?.text !== '{') continue;
      const close = matchClose(body, open);
      const block = body.slice(open + 1, close);
      if (block.some((t) => t.text === 'throw')) continue;
      const statements = block.map((t) => t.text).join(' ');
      const how: 'EMPTY' | 'LOG_ONLY' | 'RETURN_NULL' | undefined =
        block.length === 0
          ? 'EMPTY'
          : /^(?:\s*(?:(?:log|logger|LOG|LOGGER)\s*\.\s*\w+\s*\([^;]*\)|\w+\s*\.\s*printStackTrace\s*\(\s*\))\s*;)+\s*$/.test(
                statements,
              )
            ? 'LOG_ONLY'
            : /\breturn\s+null\s*;/.test(statements) && !/\breturn\s+(?!null)/.test(statements)
              ? 'RETURN_NULL'
              : undefined;
      if (how)
        out.swallowed.push({
          cls: type.name,
          method: m.name,
          exception: exception || 'Exception',
          how,
          loc: { file, line: body[i]?.line ?? m.line },
        });
    }
    // 3. Plusieurs écritures en base dans une méthode de service.
    if (stereotype === 'Service' || stereotype === 'Component') {
      const calls: string[] = [];
      for (let i = 2; i < body.length; i += 1) {
        const name = body[i]?.text ?? '';
        if (!DB_WRITES.has(name) || body[i - 1]?.text !== '.' || body[i + 1]?.text !== '(') continue;
        const receiver = body[i - 2]?.text ?? '';
        const typeName = fieldTypes.get(receiver) ?? '';
        if (
          /(Repository|Dao|DAO|EntityManager|JdbcTemplate|Mapper)$/.test(typeName) ||
          /(repository|repo|dao|entityManager|jdbc)/i.test(receiver)
        )
          calls.push(`${receiver}.${name}`);
      }
      if (calls.length >= 2) {
        const transactional =
          classTransactional ||
          m.annotations.some((a) => a.name === 'Transactional' && !/readOnly\s*=\s*true/.test(a.text));
        out.writes.push({
          cls: type.name,
          method: m.name,
          calls,
          transactional,
          loc: { file, line: m.line },
        });
      }
    }
  }
}
