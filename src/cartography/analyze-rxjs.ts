import type * as TS from 'typescript';
import type { TypeScriptModule } from '../static-analysis/typescript-loader.js';
import type { ReadFile } from './files.js';
import type { Loc, UiCall, UiDiagnostic, UiLink, UiSymbol } from './facts.js';

/**
 * LES STORES ET FLUX RXJS DU FRONTAL : lus dans l'AST TypeScript, sans convention de nommage ni NgRx. Une
 * classe est un store parce qu'elle garde un état RxJS (Subject, BehaviorSubject…) et l'expose, pas à cause de
 * son nom. Sont reconstruits : les appels entre classes (composant → store → façade → service → client HTTP,
 * classes de base comprises, sans profondeur fixe), les émissions (`next()`), les flux qui en dérivent
 * (`pipe`, `combineLatest`…), leurs traitements (`switchMap(() => service.m())`), leurs consommateurs
 * (`subscribe`, pipe `async`, `toSignal`, `firstValueFrom`), les @Output d'un enfant vers son parent, et les
 * réponses qui alimentent un flux. Un Observable est paresseux : un appel dont le résultat n'est jamais
 * souscrit n'est pas présenté comme exécuté. Rien n'est exécuté ; une URL non résolue garde son expression.
 */
export const RXJS_ANALYZER = 'rxjs-2';

const SUBJECTS = new Set(['Subject', 'BehaviorSubject', 'ReplaySubject', 'AsyncSubject']);
const CREATION = new Set([
  'combineLatest',
  'merge',
  'forkJoin',
  'zip',
  'concat',
  'race',
  'of',
  'from',
  'defer',
  'interval',
  'timer',
  'iif',
  'fromEvent',
]);
/** Les opérateurs dont la fonction rend un Observable intérieur, souscrit par le flux extérieur. */
const INNER = new Set([
  'switchMap',
  'mergeMap',
  'concatMap',
  'exhaustMap',
  'flatMap',
  'expand',
  'catchError',
  'switchMapTo',
  'mergeMapTo',
  'concatMapTo',
]);
const OPERATORS = new Set([
  ...INNER,
  'map',
  'filter',
  'tap',
  'withLatestFrom',
  'distinctUntilChanged',
  'shareReplay',
  'share',
  'debounceTime',
  'throttleTime',
  'takeUntil',
  'takeUntilDestroyed',
  'startWith',
  'scan',
  'first',
  'take',
  'finalize',
  'delay',
  'retry',
  'pluck',
  'skip',
  'auditTime',
  'combineLatestWith',
  'mergeWith',
]);
const SUBSCRIBERS = new Set(['firstValueFrom', 'lastValueFrom', 'toSignal']);
const HTTP_VERBS: Record<string, string> = {
  get: 'GET',
  post: 'POST',
  put: 'PUT',
  patch: 'PATCH',
  delete: 'DELETE',
  head: 'HEAD',
  options: 'OPTIONS',
};
const LIFECYCLE = new Set([
  'constructor',
  'ngOnInit',
  'ngOnChanges',
  'ngAfterViewInit',
  'ngAfterContentInit',
  'ngDoCheck',
]);
/** Les types de bibliothèques injectés couramment : leurs appels ne sont pas des ruptures de chaîne. */
const LIBRARY =
  /^(HttpClient|Router|ActivatedRoute|FormBuilder|NonNullableFormBuilder|ChangeDetectorRef|ElementRef|Renderer2|NgZone|DestroyRef|Injector|Location|DomSanitizer|Title|Meta|MatDialog|MatSnackBar|TranslateService|Store|Actions|DOCUMENT)$/;
/** Bornes : une classe analysée au plus une fois, une exploration de chaîne bornée. */
const MAX_FILE_BYTES = 400_000;
const MAX_VISITS = 20_000;

/** Comment le résultat (Observable) d'un appel est employé là où il est fait. */
type Use = 'SUBSCRIBED' | 'RETURNED' | 'STORED' | 'LOCAL' | 'DROPPED';

interface Ref {
  /** 'this' ou la propriété injectée. */
  via: string;
  name: string;
}
/**
 * Une condition qui entoure un appel dans le corps d'une méthode : if/else, case/default, retour anticipé,
 * catch, boucle, ternaire, && / ||. `on` et `values` sont remplis quand la condition compare un chemin à une
 * valeur (égalité, switch) ; `instance` pour un instanceof.
 */
interface Guard {
  kind: 'IF' | 'ELSE' | 'CASE' | 'DEFAULT' | 'EXIT' | 'CATCH' | 'FINALLY' | 'LOOP' | 'TERNARY' | 'LOGICAL';
  text: string;
  on?: string;
  values?: TS.Expression[];
  instance?: string;
  /** Pour l'évaluation : la comparaison (après les !) doit être fausse pour suivre cette branche. */
  negated: boolean;
  /** Pour l'affichage : la branche est suivie quand la condition écrite est fausse (else, retour anticipé). */
  whenFalse?: boolean;
}
/** Ce qui doit s'être produit avant l'appel : réponse attendue (await, subscribe, then), erreur, minuterie. */
interface Continuation {
  how: 'AWAIT' | 'SUBSCRIBE' | 'THEN' | 'ERROR' | 'FINALLY' | 'OPERATOR' | 'TIMER' | 'EVENT' | 'CALLBACK';
  via: string;
  after: string;
  /** Les noms qui reçoivent le résultat (paramètres du rappel, variable de l'await). */
  binds: string[];
}
interface CallSite {
  target: string;
  method: string;
  args: readonly TS.Expression[];
  use: Use;
  operator?: string;
  guards?: Guard[];
  cont?: Continuation[];
  /** Les identifiants lus par les arguments (pour la provenance des données). */
  uses?: string[];
  loc: Loc;
}
interface HttpSite {
  verb?: string;
  verbParam?: number;
  url?: TS.Expression;
  use: Use;
  loc: Loc;
}
interface Emit {
  ref: Ref;
  guards?: Guard[];
  cont?: Continuation[];
  /** Les appels dont la réponse est poussée par cette émission (dans subscribe/tap). */
  fedBy: CallSite[];
  loc: Loc;
}
interface Pipeline {
  source: Ref;
  calls: CallSite[];
  /** Les next() faits dans le traitement (tap, subscribe) : la réponse alimente ce flux. */
  emits: Emit[];
  operators: string[];
  /** Les rappels de filter() du traitement (condition de passage). */
  filters?: string[];
  subscribed: boolean;
  loc: Loc;
}
interface Method {
  name: string;
  params: string[];
  locals: Map<string, TS.Expression>;
  /** `const { type } = action` : type → action.type. */
  aliases: Map<string, string>;
  calls: CallSite[];
  emits: Emit[];
  http: HttpSite[];
  pipelines: Pipeline[];
  outputs: { name: string; loc: Loc }[];
  /** Le corps rend un Observable (return d'un appel, d'un flux, d'un pipe). */
  returnsObservable: boolean;
  loc: Loc;
}
interface Stream {
  name: string;
  kind: 'SUBJECT' | 'DERIVED';
  type?: string;
  init?: TS.Expression;
  sources: Ref[];
  calls: CallSite[];
  /** Un appel HTTP fait dans la définition même du flux (`data$ = this.http.get(…)`). */
  http: HttpSite[];
  operators: string[];
  filters: string[];
  reads: string[];
  loc: Loc;
}
interface ClassInfo {
  name: string;
  file: string;
  role: UiSymbol['role'];
  component: boolean;
  base?: string;
  selector?: string;
  template?: string;
  deps: Map<string, string>;
  http: Set<string>;
  values: Map<string, TS.Expression>;
  module: Map<string, TS.Expression>;
  streams: Map<string, Stream>;
  methods: Map<string, Method>;
  outputs: Set<string>;
  /** Les flux souscrits par une propriété (`data = toSignal(this.store.data$)`). */
  consumes: Ref[];
  loc: Loc;
}

export interface RxjsFacts {
  symbols: UiSymbol[];
  links: UiLink[];
  diagnostics: UiDiagnostic[];
  /** Appels HTTP trouvés ici et pas par l'analyse existante (enveloppes, request(), URL non résolues). */
  calls: UiCall[];
  /** Les méthodes d'enveloppe HTTP (URL reçue en paramètre) : l'appel réel est celui de leur appelant. */
  wrappers: string[];
  /** Le flux lu par un membre d'un composant (`canActivate$`, ou `store` + `status$`). */
  streamOf: (component: string, member: string, path: readonly string[]) => string | undefined;
  /** Les méthodes de composant appelées par le gabarit ou le cycle de vie. */
  warnings: string[];
}

const typeNameOf = (ts: TypeScriptModule, type: TS.TypeNode | undefined): string | undefined => {
  if (!type) return undefined;
  if (ts.isTypeReferenceNode(type)) return type.typeName.getText().split('.').pop();
  return undefined;
};

/** Analyse les fichiers TypeScript d'une source Angular ; `knownCalls` : les appels HTTP déjà lus. */
export function analyzeRxjs(
  ts: TypeScriptModule,
  files: readonly ReadFile[],
  knownCalls: ReadonlyMap<string, UiCall>,
): RxjsFacts {
  const warnings: string[] = [];
  const byPath = new Map(files.map((f) => [f.path, f]));
  const classes = new Map<string, ClassInfo>();
  const constants = new Map<string, string | null>();
  for (const file of files) {
    if (!/\.ts$/.test(file.path) || /\.(spec|test|d)\.ts$/.test(file.path)) continue;
    if (file.text.length > MAX_FILE_BYTES) {
      warnings.push(`${file.path}: file too large for the RxJS analysis`);
      continue;
    }
    try {
      for (const info of classesOf(ts, file, byPath, constants))
        if (classes.has(info.name)) warnings.push(`class ${info.name} declared twice: the first one is kept`);
        else classes.set(info.name, info);
    } catch (error) {
      // Un fichier illisible n'arrête pas l'analyse des autres.
      warnings.push(`${file.path}: RxJS analysis failed (${(error as Error).message})`);
    }
  }
  return resolve(ts, classes, knownCalls, warnings, constants);
}

/** La forme comparable d'une valeur littérale : chaîne JSON, nombre, booléen ou null. */
function literalOf(ts: TypeScriptModule, e: TS.Expression | undefined): string | undefined {
  if (!e) return undefined;
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return JSON.stringify(e.text);
  if (ts.isNumericLiteral(e)) return String(Number(e.text));
  if (e.kind === ts.SyntaxKind.TrueKeyword) return 'true';
  if (e.kind === ts.SyntaxKind.FalseKeyword) return 'false';
  if (e.kind === ts.SyntaxKind.NullKeyword) return 'null';
  return undefined;
}

/**
 * Les valeurs nommées d'un fichier : membres d'enum (`E.M`), constantes de module et propriétés statiques en
 * lecture seule (`Cls.P`) dont la valeur est un littéral. Un même nom défini deux fois avec des valeurs
 * différentes devient ambigu (null) : il n'est jamais choisi.
 */
function collectConstants(ts: TypeScriptModule, sf: TS.SourceFile, out: Map<string, string | null>): void {
  const put = (name: string, value: string | undefined): void => {
    if (value === undefined) return;
    const known = out.get(name);
    out.set(name, known === undefined || known === value ? value : null);
  };
  for (const st of sf.statements) {
    if (ts.isEnumDeclaration(st)) {
      let next = 0;
      for (const member of st.members) {
        const key = `${st.name.text}.${member.name.getText()}`;
        const lit = literalOf(ts, member.initializer);
        if (member.initializer && lit === undefined) {
          out.set(key, null);
          continue;
        }
        put(key, lit ?? String(next));
        next = lit !== undefined && /^-?\d+$/.test(lit) ? Number(lit) + 1 : next + 1;
      }
    } else if (ts.isVariableStatement(st) && st.declarationList.flags & ts.NodeFlags.Const) {
      for (const d of st.declarationList.declarations)
        if (ts.isIdentifier(d.name)) put(d.name.text, literalOf(ts, d.initializer));
    } else if (ts.isClassDeclaration(st) && st.name)
      for (const member of st.members)
        if (
          ts.isPropertyDeclaration(member) &&
          member.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword)
        )
          put(`${st.name.text}.${member.name.getText()}`, literalOf(ts, member.initializer));
  }
}

// ── Lecture d'une classe ─────────────────────────────────────────────────────────────────────────

function classesOf(
  ts: TypeScriptModule,
  file: ReadFile,
  byPath: ReadonlyMap<string, ReadFile>,
  constants: Map<string, string | null>,
): ClassInfo[] {
  const sf = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  collectConstants(ts, sf, constants);
  const loc = (node: TS.Node): Loc => ({
    file: file.path,
    line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
  });
  const module = new Map<string, TS.Expression>();
  for (const statement of sf.statements)
    if (ts.isVariableStatement(statement) && statement.declarationList.flags & ts.NodeFlags.Const)
      for (const d of statement.declarationList.declarations)
        if (ts.isIdentifier(d.name) && d.initializer) module.set(d.name.text, d.initializer);
  const out: ClassInfo[] = [];
  for (const statement of sf.statements) {
    if (!ts.isClassDeclaration(statement) || !statement.name) continue;
    out.push(classOf(ts, statement, file, byPath, module, loc));
  }
  return out;
}

function classOf(
  ts: TypeScriptModule,
  node: TS.ClassDeclaration,
  file: ReadFile,
  byPath: ReadonlyMap<string, ReadFile>,
  module: Map<string, TS.Expression>,
  loc: (node: TS.Node) => Loc,
): ClassInfo {
  const info: ClassInfo = {
    name: node.name?.text ?? '',
    file: file.path,
    role: 'CLASS',
    component: false,
    deps: new Map(),
    http: new Set(),
    values: new Map(),
    module,
    streams: new Map(),
    methods: new Map(),
    outputs: new Set(),
    consumes: [],
    loc: loc(node),
  };
  let injectable = false;
  for (const decorator of ts.getDecorators(node) ?? []) {
    if (!ts.isCallExpression(decorator.expression)) continue;
    const name = decorator.expression.expression.getText();
    if (name === 'Injectable') injectable = true;
    if (name !== 'Component' && name !== 'Directive') continue;
    info.component = name === 'Component';
    const options = decorator.expression.arguments[0];
    if (!options || !ts.isObjectLiteralExpression(options)) continue;
    for (const property of options.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const key = property.name.getText();
      const value = property.initializer;
      const text =
        ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value) ? value.text : undefined;
      if (key === 'selector' && text) info.selector = text.split(',')[0]?.trim();
      if (key === 'template' && text !== undefined) info.template = text;
      if (key === 'template' && ts.isTemplateExpression(value)) info.template = value.getText();
      if (key === 'templateUrl' && text) {
        const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
        const parts: string[] = [];
        for (const part of [...(dir ? dir.split('/') : []), ...text.split('/')]) {
          if (part === '.' || part === '') continue;
          if (part === '..') parts.pop();
          else parts.push(part);
        }
        info.template = byPath.get(parts.join('/'))?.text;
      }
    }
  }
  for (const clause of node.heritageClauses ?? [])
    if (clause.token === ts.SyntaxKind.ExtendsKeyword)
      info.base = clause.types[0]?.expression.getText().split('.').pop();
  const hasDecorator = (member: TS.Node, name: string): boolean =>
    (ts.canHaveDecorators(member) ? (ts.getDecorators(member) ?? []) : []).some(
      (d) => ts.isCallExpression(d.expression) && d.expression.expression.getText() === name,
    );
  // Injections : constructeur (private x: X), inject(X), et propriétés initialisées.
  const pending: { name: string; init: TS.Expression; type?: string; at: TS.Node }[] = [];
  for (const member of node.members) {
    if (ts.isConstructorDeclaration(member)) {
      for (const parameter of member.parameters) {
        const type = typeNameOf(ts, parameter.type);
        if (ts.isIdentifier(parameter.name) && type) info.deps.set(parameter.name.text, type);
      }
      for (const statement of member.body?.statements ?? [])
        if (
          ts.isExpressionStatement(statement) &&
          ts.isBinaryExpression(statement.expression) &&
          statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isPropertyAccessExpression(statement.expression.left) &&
          statement.expression.left.expression.kind === ts.SyntaxKind.ThisKeyword
        )
          pending.push({
            name: statement.expression.left.name.text,
            init: statement.expression.right,
            at: statement,
          });
    }
    if (ts.isPropertyDeclaration(member) && ts.isIdentifier(member.name)) {
      const name = member.name.text;
      const init = member.initializer;
      if (hasDecorator(member, 'Output')) info.outputs.add(name);
      if (init && ts.isCallExpression(init) && init.expression.getText() === 'output') info.outputs.add(name);
      if (
        init &&
        ts.isCallExpression(init) &&
        init.expression.getText() === 'inject' &&
        init.arguments[0] &&
        ts.isIdentifier(init.arguments[0])
      ) {
        info.deps.set(name, init.arguments[0].text);
        continue;
      }
      const type = member.type?.getText();
      if (init && !ts.isArrowFunction(init) && !ts.isFunctionExpression(init))
        pending.push({ name, init, ...(type ? { type } : {}), at: member });
      else if (!init && type && /\b(Observable|Subject|BehaviorSubject|ReplaySubject)\b/.test(type))
        pending.push({ name, init: member.name, type, at: member });
    }
  }
  for (const [name, type] of info.deps)
    if (type === 'HttpClient' || /^(http|httpClient)$/i.test(name)) info.http.add(name);
  // Les flux : Subject créé, ou propriété observable (nom en $, type Observable, pipe/combineLatest…).
  const streamNames = new Set<string>();
  for (const p of pending) {
    const created =
      ts.isNewExpression(p.init) && SUBJECTS.has(p.init.expression.getText().split('.').pop() ?? '');
    if (
      created ||
      p.name.endsWith('$') ||
      (p.type && /\b(Observable|Subject)\b/.test(p.type)) ||
      isObservable(ts, p.init)
    )
      streamNames.add(p.name);
    else info.values.set(p.name, p.init);
    // toSignal(this.x$) / firstValueFrom(…) dans une propriété : le flux est souscrit.
    if (
      ts.isCallExpression(p.init) &&
      ts.isIdentifier(p.init.expression) &&
      SUBSCRIBERS.has(p.init.expression.text) &&
      p.init.arguments[0]
    ) {
      const ref = refOf(ts, chainBase(ts, p.init.arguments[0]));
      if (ref) info.consumes.push(ref);
    }
  }
  const ctx = { ts, info, loc, streamNames };
  for (const p of pending) {
    if (!streamNames.has(p.name)) continue;
    const created = ts.isNewExpression(p.init) ? p.init.expression.getText().split('.').pop() : undefined;
    const stream: Stream = {
      name: p.name,
      kind: created && SUBJECTS.has(created) ? 'SUBJECT' : 'DERIVED',
      ...(created && SUBJECTS.has(created) ? { type: created } : {}),
      sources: [],
      calls: [],
      http: [],
      operators: [],
      filters: [],
      reads: [],
      loc: loc(p.at),
    };
    if (stream.kind === 'DERIVED' && !ts.isIdentifier(p.init)) readStream(ctx, p.init, stream);
    // Une propriété déclarée puis assignée : la seconde lecture complète la première.
    const known = info.streams.get(p.name);
    if (known && known.kind === 'SUBJECT') continue;
    info.streams.set(p.name, stream);
  }
  for (const member of node.members) {
    if (ts.isGetAccessorDeclaration(member) && ts.isIdentifier(member.name) && member.body) {
      const ret = member.body.statements.find(ts.isReturnStatement)?.expression;
      if (ret && (member.name.text.endsWith('$') || isObservable(ts, ret))) {
        const stream: Stream = {
          name: member.name.text,
          kind: 'DERIVED',
          sources: [],
          calls: [],
          http: [],
          operators: [],
          filters: [],
          reads: [],
          loc: loc(member),
        };
        readStream(ctx, ret, stream);
        info.streams.set(stream.name, stream);
        continue;
      }
    }
    const body =
      (ts.isMethodDeclaration(member) ||
        ts.isConstructorDeclaration(member) ||
        ts.isGetAccessorDeclaration(member)) &&
      member.body
        ? member.body
        : ts.isPropertyDeclaration(member) &&
            member.initializer &&
            (ts.isArrowFunction(member.initializer) || ts.isFunctionExpression(member.initializer))
          ? member.initializer.body
          : undefined;
    if (!body) continue;
    const name = ts.isConstructorDeclaration(member) ? 'constructor' : member.name?.getText();
    if (!name) continue;
    const parameters =
      ts.isConstructorDeclaration(member) ||
      ts.isMethodDeclaration(member) ||
      ts.isGetAccessorDeclaration(member)
        ? member.parameters
        : ((member as TS.PropertyDeclaration).initializer as TS.ArrowFunction).parameters;
    info.methods.set(name, readMethod(ctx, name, parameters, body, loc(member)));
  }
  info.role = info.component
    ? 'COMPONENT'
    : [...info.streams.values()].some((s) => s.kind === 'SUBJECT')
      ? 'STORE'
      : injectable
        ? 'SERVICE'
        : 'CLASS';
  return info;
}

interface Ctx {
  ts: TypeScriptModule;
  info: ClassInfo;
  loc: (node: TS.Node) => Loc;
  streamNames: Set<string>;
}

/** Une expression qui rend un Observable : pipe, asObservable, création RxJS. */
function isObservable(ts: TypeScriptModule, expr: TS.Expression): boolean {
  if (!ts.isCallExpression(expr)) return false;
  const callee = expr.expression;
  if (ts.isPropertyAccessExpression(callee)) return ['pipe', 'asObservable'].includes(callee.name.text);
  return ts.isIdentifier(callee) && CREATION.has(callee.text);
}

/** this.x → { via: 'this', name: x } ; this.dep.y → { via: dep, name: y }. */
function refOf(ts: TypeScriptModule, expr: TS.Expression): Ref | undefined {
  if (!ts.isPropertyAccessExpression(expr)) return undefined;
  const owner = expr.expression;
  if (owner.kind === ts.SyntaxKind.ThisKeyword) return { via: 'this', name: expr.name.text };
  if (
    ts.isPropertyAccessExpression(owner) &&
    owner.expression.kind === ts.SyntaxKind.ThisKeyword &&
    ts.isIdentifier(owner.name)
  )
    return { via: owner.name.text, name: expr.name.text };
  return undefined;
}

const isStreamRef = (ctx: Ctx, ref: Ref | undefined): ref is Ref =>
  ref !== undefined &&
  (ref.via === 'this'
    ? ctx.streamNames.has(ref.name)
    : ctx.info.deps.has(ref.via) && ref.name !== 'subscribe');

/** Les sources, appels intérieurs, opérateurs, expressions de filter() et propriétés lues d’un flux calculé. */
function readStream(ctx: Ctx, init: TS.Expression, stream: Stream): void {
  const { ts } = ctx;
  const visit = (node: TS.Node, operator?: string): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && OPERATORS.has(callee.text)) {
        stream.operators.push(callee.text);
        if (callee.text === 'filter' && node.arguments[0])
          stream.filters.push(node.arguments[0].getText().slice(0, 120));
        if (['map', 'filter'].includes(callee.text)) readsOf(ts, node.arguments[0], stream.reads);
        for (const arg of node.arguments) visit(arg, callee.text);
        return;
      }
      if (ts.isIdentifier(callee) && CREATION.has(callee.text)) stream.operators.push(callee.text);
      if (ts.isPropertyAccessExpression(callee)) {
        const recv = callee.expression;
        const method = callee.name.text;
        if (recv.kind === ts.SyntaxKind.ThisKeyword && !ctx.streamNames.has(method))
          stream.calls.push(site(ctx, node, 'this', method, 'STORED', operator));
        else if (
          ts.isPropertyAccessExpression(recv) &&
          recv.expression.kind === ts.SyntaxKind.ThisKeyword &&
          ctx.info.http.has(recv.name.text) &&
          (HTTP_VERBS[method] || method === 'request')
        ) {
          const verbArg = method === 'request' ? node.arguments[0] : undefined;
          stream.http.push({
            ...(method === 'request'
              ? verbArg && (ts.isStringLiteral(verbArg) || ts.isNoSubstitutionTemplateLiteral(verbArg))
                ? { verb: verbArg.text.toUpperCase() }
                : {}
              : { verb: HTTP_VERBS[method] ?? method.toUpperCase() }),
            ...((method === 'request' ? node.arguments[1] : node.arguments[0])
              ? { url: method === 'request' ? node.arguments[1] : node.arguments[0] }
              : {}),
            use: 'STORED',
            loc: ctx.loc(node),
          });
          for (const arg of node.arguments) visit(arg, operator);
          return;
        } else {
          if (
            recv.kind !== ts.SyntaxKind.ThisKeyword &&
            ts.isPropertyAccessExpression(recv) &&
            recv.expression.kind === ts.SyntaxKind.ThisKeyword &&
            ctx.info.deps.has(recv.name.text) &&
            !ctx.info.http.has(recv.name.text)
          ) {
            stream.calls.push(site(ctx, node, recv.name.text, method, 'STORED', operator));
            for (const arg of node.arguments) visit(arg, operator);
            return;
          }
        }
      }
    }
    if (ts.isPropertyAccessExpression(node)) {
      const ref = refOf(ts, node);
      const parent = node.parent;
      const called = ts.isCallExpression(parent) && parent.expression === node;
      if (!called && ref && isStreamRef(ctx, ref)) {
        stream.sources.push(ref);
        return;
      }
    }
    ts.forEachChild(node, (child) => {
      visit(child, operator);
    });
  };
  visit(init);
  stream.operators = [...new Set(stream.operators)];
  stream.reads = [...new Set(stream.reads)].slice(0, 20);
}

/** Les propriétés lues sur les paramètres d'un rappel (`(s) => s.status === 'READY'` → status). */
function readsOf(ts: TypeScriptModule, fn: TS.Expression | undefined, out: string[]): void {
  if (!fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return;
  const params = new Set<string>();
  for (const p of fn.parameters) {
    if (ts.isIdentifier(p.name)) params.add(p.name.text);
    else if (ts.isArrayBindingPattern(p.name))
      for (const e of p.name.elements)
        if (ts.isBindingElement(e) && ts.isIdentifier(e.name)) params.add(e.name.text);
  }
  const visit = (node: TS.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      params.has(node.expression.text)
    )
      out.push(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(fn.body);
}

function site(
  ctx: Ctx,
  node: TS.CallExpression,
  target: string,
  method: string,
  use: Use,
  operator?: string,
): CallSite {
  return { target, method, args: node.arguments, use, ...(operator ? { operator } : {}), loc: ctx.loc(node) };
}

/** Comment le résultat d'un appel est employé : souscrit, rendu, rangé dans un flux, local ou perdu. */
function useOf(ctx: Ctx, call: TS.Node): Use {
  const { ts } = ctx;
  let cur: TS.Node = call;
  for (let i = 0; i < 64; i += 1) {
    const parent = cur.parent as TS.Node | undefined;
    if (!parent) return 'LOCAL';
    if (
      ts.isPropertyAccessExpression(parent) &&
      parent.expression === cur &&
      ts.isCallExpression(parent.parent) &&
      parent.parent.expression === parent
    ) {
      if (['subscribe', 'toPromise'].includes(parent.name.text)) return 'SUBSCRIBED';
      cur = parent.parent;
      continue;
    }
    if (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isNonNullExpression(parent)) {
      cur = parent;
      continue;
    }
    // forkJoin([a(), b()]) / combineLatest({ a: a() }) : la création reçoit le tableau ou l'objet.
    if (
      (ts.isArrayLiteralExpression(parent) ||
        (ts.isPropertyAssignment(parent) && ts.isObjectLiteralExpression(parent.parent))) &&
      ts.isCallExpression(ts.isPropertyAssignment(parent) ? parent.parent.parent : parent.parent)
    ) {
      cur = ts.isPropertyAssignment(parent) ? parent.parent : parent;
      continue;
    }
    if (ts.isCallExpression(parent) && parent.arguments.some((a) => a === cur)) {
      const name = parent.expression.getText().split('.').pop() ?? '';
      if (SUBSCRIBERS.has(name)) return 'SUBSCRIBED';
      if (CREATION.has(name)) {
        cur = parent;
        continue;
      }
      return 'LOCAL';
    }
    // Rendu par le rappel d'un opérateur (switchMap(() => this.s.m())) : l'Observable intérieur est souscrit
    // par le flux extérieur ; on poursuit avec la chaîne qui contient l'opérateur.
    const fn =
      ts.isArrowFunction(parent) && parent.body === cur
        ? parent
        : ts.isReturnStatement(parent)
          ? enclosingFunction(ts, parent)
          : undefined;
    if (fn) {
      if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) {
        const op = fn.parent;
        // Une méthode fléchée (`activate = (id) => this.http.post(…)`) rend son expression.
        if (!ts.isCallExpression(op)) return 'RETURNED';
        if (ts.isIdentifier(op.expression) && INNER.has(op.expression.text)) {
          cur = op;
          // L'opérateur est un argument de pipe(…) : la chaîne continue après pipe.
          const pipe = op.parent;
          if (ts.isCallExpression(pipe)) {
            cur = pipe;
            continue;
          }
          return 'LOCAL';
        }
        return 'LOCAL';
      }
      return 'RETURNED';
    }
    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      parent.right === cur
    )
      return ts.isPropertyAccessExpression(parent.left) &&
        parent.left.expression.kind === ts.SyntaxKind.ThisKeyword
        ? 'STORED'
        : 'LOCAL';
    if (ts.isExpressionStatement(parent)) return 'DROPPED';
    return 'LOCAL';
  }
  return 'LOCAL';
}

function enclosingFunction(ts: TypeScriptModule, node: TS.Node): TS.Node | undefined {
  let cur = node.parent as TS.Node | undefined;
  while (cur) {
    if (ts.isFunctionLike(cur)) return cur;
    cur = cur.parent;
  }
  return undefined;
}

/** Un texte de code raccourci pour une raison lisible. */
const short = (text: string, max = 80): string => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

const strip = (ts: TypeScriptModule, e: TS.Expression): TS.Expression => {
  let cur = e;
  while (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isNonNullExpression(cur))
    cur = cur.expression;
  return cur;
};

/** Une valeur écrite (littéral, membre d'enum, constante en majuscules), comparée à un chemin. */
const valueLike = (ts: TypeScriptModule, e: TS.Expression): boolean => {
  const x = strip(ts, e);
  if (
    ts.isStringLiteral(x) ||
    ts.isNoSubstitutionTemplateLiteral(x) ||
    ts.isNumericLiteral(x) ||
    x.kind === ts.SyntaxKind.TrueKeyword ||
    x.kind === ts.SyntaxKind.FalseKeyword ||
    x.kind === ts.SyntaxKind.NullKeyword
  )
    return true;
  if (ts.isPropertyAccessExpression(x)) {
    let root: TS.Expression = x;
    while (ts.isPropertyAccessExpression(root)) root = root.expression;
    return ts.isIdentifier(root) && /^[A-Z]/.test(root.text);
  }
  return ts.isIdentifier(x) && /^[A-Z][A-Z0-9_]*$/.test(x.text);
};

/** Le chemin comparé, à travers les alias (`const { type } = action`) et les constantes locales. */
const pathOf = (ts: TypeScriptModule, e: TS.Expression, method: Method): string => {
  const x = strip(ts, e);
  if (ts.isIdentifier(x)) {
    const alias = method.aliases.get(x.text);
    if (alias) return alias;
    const local = method.locals.get(x.text);
    if (local && (ts.isIdentifier(strip(ts, local)) || ts.isPropertyAccessExpression(strip(ts, local))))
      return strip(ts, local).getText();
  }
  if (ts.isPropertyAccessExpression(x)) {
    const head = pathOf(ts, x.expression, method);
    return `${head}.${x.name.text}`;
  }
  return x.getText();
};

/** Ce que teste une condition : égalité à une valeur, instanceof, ou une condition quelconque. */
function testOf(
  ts: TypeScriptModule,
  expr: TS.Expression,
  method: Method,
): Pick<Guard, 'text' | 'on' | 'values' | 'instance' | 'negated'> {
  let e = strip(ts, expr);
  let negated = false;
  while (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) {
    negated = !negated;
    e = strip(ts, e.operand);
  }
  const text = short(expr.getText());
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    const eq = op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken;
    const ne =
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken;
    if (eq || ne) {
      const subject = valueLike(ts, e.right) ? e.left : valueLike(ts, e.left) ? e.right : undefined;
      const value = subject === e.left ? e.right : e.left;
      if (subject && !valueLike(ts, subject))
        return { text, on: pathOf(ts, subject, method), values: [value], negated: ne ? !negated : negated };
    }
    if (op === ts.SyntaxKind.InstanceOfKeyword)
      return {
        text,
        on: pathOf(ts, e.left, method),
        instance: e.right.getText().split('.').pop() ?? '',
        negated,
      };
  }
  return { text, negated };
}

/** Une instruction qui sort toujours de la méthode (return, throw, ou un bloc / if dont toutes les branches sortent). */
function alwaysExits(ts: TypeScriptModule, st: TS.Statement | undefined): boolean {
  if (!st) return false;
  if (ts.isReturnStatement(st) || ts.isThrowStatement(st)) return true;
  if (ts.isBlock(st)) return alwaysExits(ts, st.statements[st.statements.length - 1]);
  if (ts.isIfStatement(st)) return alwaysExits(ts, st.thenStatement) && alwaysExits(ts, st.elseStatement);
  return false;
}

const CONT_OF: Record<string, Continuation['how']> = {
  subscribe: 'SUBSCRIBE',
  then: 'THEN',
  catch: 'ERROR',
  catchError: 'ERROR',
  error: 'ERROR',
  finally: 'FINALLY',
  finalize: 'FINALLY',
  complete: 'FINALLY',
  next: 'SUBSCRIBE',
  setTimeout: 'TIMER',
  setInterval: 'TIMER',
  queueMicrotask: 'TIMER',
  requestAnimationFrame: 'TIMER',
  addEventListener: 'EVENT',
};
const ARRAY_CALLBACKS = new Set(['forEach', 'map', 'filter', 'some', 'every', 'find', 'reduce', 'flatMap']);

/** Les noms qu'introduit un rappel (paramètres, déstructurations). */
function boundNames(ts: TypeScriptModule, fn: TS.SignatureDeclarationBase): string[] {
  const names: string[] = [];
  const add = (n: TS.BindingName): void => {
    if (ts.isIdentifier(n)) names.push(n.text);
    else for (const el of n.elements) if (!ts.isOmittedExpression(el)) add(el.name);
  };
  for (const p of fn.parameters) add(p.name);
  return names;
}

/** L'await de premier niveau d'une instruction (hors fonctions imbriquées), et le nom qui reçoit son résultat. */
function awaitOf(ts: TypeScriptModule, st: TS.Statement): { after: string; binds: string[] } | undefined {
  let found: TS.AwaitExpression | undefined;
  const visit = (n: TS.Node): void => {
    if (found || ts.isFunctionLike(n)) return;
    if (ts.isAwaitExpression(n)) {
      found = n;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(st);
  if (!found) return undefined;
  let target = strip(ts, found.expression);
  // await firstValueFrom(x) : c'est x qui est attendu.
  if (
    ts.isCallExpression(target) &&
    ts.isIdentifier(target.expression) &&
    SUBSCRIBERS.has(target.expression.text) &&
    target.arguments[0]
  )
    target = target.arguments[0];
  const binds: string[] = [];
  if (ts.isVariableStatement(st))
    for (const d of st.declarationList.declarations)
      if (ts.isIdentifier(d.name)) binds.push(d.name.text);
      else
        for (const el of d.name.elements)
          if (!ts.isOmittedExpression(el) && ts.isIdentifier(el.name)) binds.push(el.name.text);
  return { after: short(target.getText()), binds };
}

/**
 * Le contexte de contrôle d'un appel dans le corps de sa méthode : les conditions qui l'entourent (de la plus
 * extérieure à la plus proche) et ce qui doit s'être produit avant lui (await, rappel de subscribe/then,
 * erreur, minuterie). Lu dans l'AST, sans rien exécuter ; une boucle ou un rappel inconnu est dit tel quel.
 */
function controlOf(
  ctx: Ctx,
  node: TS.Node,
  stop: TS.Node,
  method: Method,
): { guards?: Guard[]; cont?: Continuation[]; uses?: string[] } {
  const { ts } = ctx;
  const guards: Guard[] = [];
  const cont: Continuation[] = [];
  let cur: TS.Node = node;
  for (let i = 0; i < 200 && cur !== stop; i += 1) {
    const p = cur.parent as TS.Node | undefined;
    if (!p) break;
    if (ts.isIfStatement(p) && cur !== p.expression) {
      const t = testOf(ts, p.expression, method);
      guards.push(
        cur === p.thenStatement
          ? { kind: 'IF', ...t }
          : { kind: 'ELSE', ...t, negated: !t.negated, whenFalse: true },
      );
    } else if (ts.isCaseClause(p) && cur !== p.expression) {
      // Les case vides qui précèdent tombent dans celui-ci.
      const clauses = p.parent.clauses;
      const values: TS.Expression[] = [];
      for (let k = clauses.indexOf(p); k >= 0; k -= 1) {
        const c = clauses[k];
        if (!c || !ts.isCaseClause(c) || (c !== p && c.statements.length > 0)) break;
        values.unshift(c.expression);
      }
      const on = pathOf(ts, p.parent.parent.expression, method);
      guards.push({
        kind: 'CASE',
        text: `${on} = ${values.map((v) => v.getText()).join(' | ')}`,
        on,
        values,
        negated: false,
      });
    } else if (ts.isDefaultClause(p)) {
      const on = pathOf(ts, p.parent.parent.expression, method);
      const values = p.parent.clauses.flatMap((c) => (ts.isCaseClause(c) ? [c.expression] : []));
      guards.push({
        kind: 'DEFAULT',
        text: `${on} ≠ ${values.map((v) => v.getText()).join(', ')}`,
        on,
        values,
        negated: true,
      });
    } else if (ts.isConditionalExpression(p) && cur !== p.condition) {
      const t = testOf(ts, p.condition, method);
      guards.push({
        kind: 'TERNARY',
        ...t,
        negated: cur === p.whenFalse ? !t.negated : t.negated,
        whenFalse: cur === p.whenFalse,
      });
    } else if (
      ts.isBinaryExpression(p) &&
      cur === p.right &&
      (p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        p.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    ) {
      const t = testOf(ts, p.left, method);
      const or = p.operatorToken.kind === ts.SyntaxKind.BarBarToken;
      guards.push({ kind: 'LOGICAL', ...t, negated: or ? !t.negated : t.negated, whenFalse: or });
    } else if (ts.isCatchClause(p)) guards.push({ kind: 'CATCH', text: 'exception levée', negated: false });
    else if (ts.isTryStatement(p) && cur === p.finallyBlock)
      guards.push({ kind: 'FINALLY', text: 'fin du try', negated: false });
    else if (
      (ts.isForStatement(p) ||
        ts.isForOfStatement(p) ||
        ts.isForInStatement(p) ||
        ts.isWhileStatement(p) ||
        ts.isDoStatement(p)) &&
      cur === p.statement
    )
      guards.push({
        kind: 'LOOP',
        text: short(
          ts.isForOfStatement(p) || ts.isForInStatement(p)
            ? p.expression.getText()
            : ts.isForStatement(p)
              ? (p.condition?.getText() ?? 'for')
              : p.expression.getText(),
        ),
        negated: false,
      });
    // Les instructions qui précèdent dans le même bloc : retour anticipé (la suite n'est atteinte que si sa
    // condition est fausse), await (la suite attend sa réponse).
    if (ts.isBlock(p) || ts.isCaseClause(p) || ts.isDefaultClause(p)) {
      const list = p.statements;
      const at = list.indexOf(cur as TS.Statement);
      for (let k = 0; k < at; k += 1) {
        const st = list[k];
        if (!st) continue;
        if (ts.isIfStatement(st) && !st.elseStatement && alwaysExits(ts, st.thenStatement)) {
          const t = testOf(ts, st.expression, method);
          guards.push({ kind: 'EXIT', ...t, negated: !t.negated, whenFalse: true });
        }
        const awaited = awaitOf(ts, st);
        if (awaited) cont.push({ how: 'AWAIT', via: 'await', ...awaited });
      }
    }
    // Un rappel : la suite d'une réponse (subscribe, then), d'une erreur, d'une minuterie ou d'un opérateur.
    if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && cur === p.body) {
      let holder: TS.Node = p.parent;
      let key: string | undefined;
      if (ts.isPropertyAssignment(holder)) {
        key = holder.name.getText();
        holder = holder.parent.parent; // { next: …, error: … } → l'appel
      }
      if (ts.isCallExpression(holder)) {
        const callee = holder.expression;
        const name = key ?? callee.getText().split('.').pop() ?? '';
        const receiver = ts.isPropertyAccessExpression(callee) ? callee.expression : undefined;
        const base = receiver ? chainBase(ts, receiver) : undefined;
        const how: Continuation['how'] | undefined =
          CONT_OF[name] ?? (INNER.has(name) || OPERATORS.has(name) ? 'OPERATOR' : undefined);
        if (receiver && ARRAY_CALLBACKS.has(name) && !INNER.has(name))
          guards.push({ kind: 'LOOP', text: `${short(receiver.getText(), 40)}.${name}(…)`, negated: false });
        else if (how)
          cont.push({
            how,
            via: name,
            after: short(
              how === 'OPERATOR' &&
                ts.isCallExpression(holder.parent) &&
                ts.isPropertyAccessExpression(holder.parent.expression)
                ? chainBase(ts, holder.parent.expression.expression).getText()
                : (base ?? holder).getText(),
            ),
            binds: boundNames(ts, p),
          });
        else
          cont.push({ how: 'CALLBACK', via: name, after: short(callee.getText()), binds: boundNames(ts, p) });
      }
    }
    cur = p;
  }
  const uses: string[] = [];
  if (ts.isCallExpression(node)) {
    const collect = (n: TS.Node): void => {
      if (ts.isIdentifier(n) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n))
        uses.push(n.text);
      ts.forEachChild(n, collect);
    };
    for (const a of node.arguments) collect(a);
  }
  return {
    ...(guards.length ? { guards: guards.reverse() } : {}),
    ...(cont.length ? { cont: cont.reverse() } : {}),
    ...(uses.length ? { uses: [...new Set(uses)] } : {}),
  };
}

/** Le début d'une chaîne a.b().c() : l'expression de base et les noms des appels enchaînés. */
function chainBase(ts: TypeScriptModule, expr: TS.Expression): TS.Expression {
  let cur = expr;
  while (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
    const name = cur.expression.name.text;
    if (!['pipe', 'subscribe', 'asObservable'].includes(name)) break;
    cur = cur.expression.expression;
  }
  return cur;
}

function readMethod(
  ctx: Ctx,
  name: string,
  parameters: TS.NodeArray<TS.ParameterDeclaration>,
  body: TS.Node,
  at: Loc,
): Method {
  const { ts, info } = ctx;
  const method: Method = {
    name,
    params: parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : '')),
    locals: new Map(),
    aliases: new Map(),
    calls: [],
    emits: [],
    http: [],
    pipelines: [],
    outputs: [],
    returnsObservable: false,
    loc: at,
  };
  const handled = new Set<TS.Node>();
  const visit = (node: TS.Node, pipeline?: Pipeline): void => {
    if (handled.has(node)) return;
    if (ts.isVariableDeclarationList(node) && node.flags & ts.NodeFlags.Const)
      for (const d of node.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer) method.locals.set(d.name.text, d.initializer);
        if (ts.isObjectBindingPattern(d.name) && d.initializer)
          for (const element of d.name.elements)
            if (ts.isIdentifier(element.name))
              method.aliases.set(
                element.name.text,
                `${d.initializer.getText()}.${element.propertyName?.getText() ?? element.name.text}`,
              );
      }
    if (ts.isReturnStatement(node) && node.expression && enclosingFunction(ts, node) === body.parent) {
      const base = chainBase(ts, node.expression);
      if (isObservable(ts, node.expression) || isStreamRef(ctx, refOf(ts, base)) || ts.isCallExpression(base))
        method.returnsObservable = true;
    }
    if (ts.isArrowFunction(body.parent) && body === node && !ts.isBlock(node)) {
      const base = chainBase(ts, node as TS.Expression);
      if (isObservable(ts, node as TS.Expression) || ts.isCallExpression(base))
        method.returnsObservable = true;
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      // Les créations qui souscrivent (toSignal, firstValueFrom) : un flux passé là est consommé.
      if (ts.isPropertyAccessExpression(callee)) {
        const recv = callee.expression;
        const fname = callee.name.text;
        const ref = refOf(ts, recv);
        // this.s.pipe(…)/subscribe(…) : un traitement de flux, exécuté à chaque émission de s.
        if (['pipe', 'subscribe'].includes(fname) && isStreamRef(ctx, refOf(ts, chainBase(ts, node)))) {
          let top: TS.Node = node;
          const names: string[] = [];
          while (
            ts.isPropertyAccessExpression(top.parent) &&
            top.parent.expression === top &&
            ts.isCallExpression(top.parent.parent)
          ) {
            names.push(top.parent.name.text);
            top = top.parent.parent;
          }
          const base = refOf(ts, chainBase(ts, top as TS.Expression)) as Ref;
          const p: Pipeline = {
            source: base,
            calls: [],
            emits: [],
            operators: [],
            subscribed:
              fname === 'subscribe' || names.includes('subscribe') || useOf(ctx, top) === 'SUBSCRIBED',
            loc: ctx.loc(node),
          };
          // Tous les arguments de la chaîne, jusqu'à la base.
          let cur: TS.Node = top;
          while (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
            handled.add(cur);
            for (const arg of cur.arguments) visit(arg, p);
            cur = cur.expression.expression;
          }
          method.pipelines.push(p);
          if (useOf(ctx, top) === 'RETURNED') method.returnsObservable = true;
          return;
        }
        if (fname === 'next' && isStreamRef(ctx, ref)) {
          const emit: Emit = {
            ref,
            fedBy: fedBy(ctx, node),
            ...controlOf(ctx, node, body, method),
            loc: ctx.loc(node),
          };
          (pipeline ? pipeline.emits : method.emits).push(emit);
        } else if (fname === 'emit' && ref?.via === 'this' && info.outputs.has(ref.name)) {
          method.outputs.push({ name: ref.name, loc: ctx.loc(node) });
        } else if (
          ts.isPropertyAccessExpression(recv) &&
          recv.expression.kind === ts.SyntaxKind.ThisKeyword &&
          info.http.has(recv.name.text) &&
          (HTTP_VERBS[fname] || fname === 'request')
        ) {
          const h: HttpSite = {
            use: pipeline ? (pipeline.subscribed ? 'SUBSCRIBED' : 'LOCAL') : useOf(ctx, node),
            loc: ctx.loc(node),
          };
          if (fname === 'request') {
            const verb = node.arguments[0];
            if (verb && (ts.isStringLiteral(verb) || ts.isNoSubstitutionTemplateLiteral(verb)))
              h.verb = verb.text.toUpperCase();
            else if (verb && ts.isIdentifier(verb) && method.params.includes(verb.text))
              h.verbParam = method.params.indexOf(verb.text);
            if (node.arguments[1]) h.url = node.arguments[1];
          } else {
            h.verb = HTTP_VERBS[fname] ?? fname.toUpperCase();
            if (node.arguments[0]) h.url = node.arguments[0];
          }
          method.http.push(h);
        } else if (
          ts.isPropertyAccessExpression(recv) &&
          recv.expression.kind === ts.SyntaxKind.ThisKeyword &&
          info.deps.has(recv.name.text) &&
          !info.http.has(recv.name.text)
        ) {
          const s = site(
            ctx,
            node,
            recv.name.text,
            fname,
            pipeline ? (pipeline.subscribed ? 'SUBSCRIBED' : 'LOCAL') : useOf(ctx, node),
          );
          Object.assign(s, controlOf(ctx, node, body, method));
          (pipeline ? pipeline.calls : method.calls).push(s);
        } else if (recv.kind === ts.SyntaxKind.ThisKeyword && !ctx.streamNames.has(fname)) {
          const s = site(
            ctx,
            node,
            'this',
            fname,
            pipeline ? (pipeline.subscribed ? 'SUBSCRIBED' : 'LOCAL') : useOf(ctx, node),
          );
          Object.assign(s, controlOf(ctx, node, body, method));
          (pipeline ? pipeline.calls : method.calls).push(s);
        }
      } else if (ts.isIdentifier(callee)) {
        if (pipeline && OPERATORS.has(callee.text)) pipeline.operators.push(callee.text);
        if (pipeline && callee.text === 'filter' && node.arguments[0])
          (pipeline.filters ??= []).push(short(node.arguments[0].getText()));
        if (SUBSCRIBERS.has(callee.text) && node.arguments[0]) {
          const ref = refOf(ts, chainBase(ts, node.arguments[0]));
          if (isStreamRef(ctx, ref))
            method.pipelines.push({
              source: ref,
              calls: [],
              emits: [],
              operators: [callee.text],
              subscribed: true,
              loc: ctx.loc(node),
            });
        }
      }
    }
    ts.forEachChild(node, (child) => {
      visit(child, pipeline);
    });
  };
  visit(body);
  return method;
}

/** Les appels dont la réponse est poussée par un next() placé dans un subscribe/tap. */
function fedBy(ctx: Ctx, next: TS.CallExpression): CallSite[] {
  const { ts } = ctx;
  const fn = enclosingFunction(ts, next);
  if (!fn) return [];
  let holder = fn.parent as TS.Node | undefined;
  if (holder && ts.isPropertyAssignment(holder)) holder = holder.parent.parent; // { next: (r) => … }
  if (!holder || !ts.isCallExpression(holder)) return [];
  const name = holder.expression.getText().split('.').pop() ?? '';
  let chain: TS.Expression | undefined;
  if (name === 'subscribe' && ts.isPropertyAccessExpression(holder.expression))
    chain = holder.expression.expression;
  else if (
    name === 'tap' &&
    ts.isCallExpression(holder.parent) &&
    ts.isPropertyAccessExpression(holder.parent.expression)
  )
    chain = holder.parent.expression.expression;
  if (!chain) return [];
  const base = chainBase(ts, chain);
  if (!ts.isCallExpression(base) || !ts.isPropertyAccessExpression(base.expression)) return [];
  const recv = base.expression.expression;
  const method = base.expression.name.text;
  if (recv.kind === ts.SyntaxKind.ThisKeyword) return [site(ctx, base, 'this', method, 'SUBSCRIBED')];
  if (
    ts.isPropertyAccessExpression(recv) &&
    recv.expression.kind === ts.SyntaxKind.ThisKeyword &&
    ctx.info.deps.has(recv.name.text)
  )
    return [site(ctx, base, recv.name.text, method, 'SUBSCRIBED')];
  return [];
}

// ── URL ──────────────────────────────────────────────────────────────────────────────────────────

interface Url {
  route?: string;
  /** Le paramètre de la méthode qui porte l'URL (enveloppe : ApiClient.post(url, body)). */
  param?: number;
  expression: string;
}

/** '/api/x' · `${this.base}/x` · base + '/x' · constante · propriété ; un paramètre devient {url}. */
function urlOf(
  ts: TypeScriptModule,
  expr: TS.Expression | undefined,
  info: ClassInfo,
  method: Method,
  depth = 0,
): Url {
  if (!expr) return { expression: '' };
  const text = expr.getText().slice(0, 200);
  const part = (node: TS.Expression, first: boolean): { route: string; param?: number } => {
    const inner = depth < 5 ? urlOf(ts, node, info, method, depth + 1) : { expression: '' };
    if (inner.route !== undefined)
      return { route: inner.route, ...(inner.param !== undefined ? { param: inner.param } : {}) };
    return { route: first ? '{base}' : '{param}' };
  };
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr))
    return { route: expr.text, expression: text };
  if (ts.isParenthesizedExpression(expr)) return urlOf(ts, expr.expression, info, method, depth);
  if (ts.isIdentifier(expr)) {
    const index = method.params.indexOf(expr.text);
    if (index >= 0) return { route: '{url}', param: index, expression: text };
    const value = method.locals.get(expr.text) ?? info.module.get(expr.text);
    if (value && depth < 5) return { ...urlOf(ts, value, info, method, depth + 1), expression: text };
    return { expression: text };
  }
  if (ts.isPropertyAccessExpression(expr) && expr.expression.kind === ts.SyntaxKind.ThisKeyword) {
    const value = info.values.get(expr.name.text);
    if (value && depth < 5) return { ...urlOf(ts, value, info, method, depth + 1), expression: text };
    return { expression: text };
  }
  if (ts.isTemplateExpression(expr)) {
    let route = expr.head.text;
    let param: number | undefined;
    expr.templateSpans.forEach((span, index) => {
      const p = part(span.expression, index === 0 && expr.head.text === '');
      route += p.route + span.literal.text;
      if (p.param !== undefined) param = p.param;
    });
    return { route, ...(param !== undefined ? { param } : {}), expression: text };
  }
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = part(expr.left, true);
    const right = part(expr.right, false);
    const param = left.param ?? right.param;
    return { route: left.route + right.route, ...(param !== undefined ? { param } : {}), expression: text };
  }
  return { expression: text };
}

// ── Résolution : liens, consommateurs, diagnostics ───────────────────────────────────────────────

function resolve(
  ts: TypeScriptModule,
  classes: ReadonlyMap<string, ClassInfo>,
  knownCalls: ReadonlyMap<string, UiCall>,
  warnings: string[],
  constants: ReadonlyMap<string, string | null>,
): RxjsFacts {
  const symbols = new Map<string, UiSymbol>();
  const links = new Map<string, UiLink>();
  const diagnostics: UiDiagnostic[] = [];
  const calls = new Map<string, UiCall>();
  const methodId = (c: ClassInfo, m: string): string => `${c.name}#${m}`;
  const streamId = (c: ClassInfo, s: string): string => `${c.name}.${s}`;
  const classOfDep = (c: ClassInfo, via: string): ClassInfo | undefined =>
    via === 'this' ? c : classes.get(c.deps.get(via) ?? '');
  /** Une méthode, cherchée dans la classe puis ses classes de base. */
  const lookup = (c: ClassInfo, name: string): { cls: ClassInfo; method: Method } | undefined => {
    const seen = new Set<string>();
    let cur: ClassInfo | undefined = c;
    while (cur && !seen.has(cur.name)) {
      seen.add(cur.name);
      const m = cur.methods.get(name);
      if (m) return { cls: cur, method: m };
      cur = cur.base ? classes.get(cur.base) : undefined;
    }
    return undefined;
  };
  const streamLookup = (c: ClassInfo, name: string): { cls: ClassInfo; stream: Stream } | undefined => {
    const seen = new Set<string>();
    let cur: ClassInfo | undefined = c;
    while (cur && !seen.has(cur.name)) {
      seen.add(cur.name);
      const s = cur.streams.get(name);
      if (s) return { cls: cur, stream: s };
      cur = cur.base ? classes.get(cur.base) : undefined;
    }
    return undefined;
  };
  const resolveRef = (c: ClassInfo, ref: Ref): { cls: ClassInfo; stream: Stream } | undefined => {
    const target = classOfDep(c, ref.via);
    return target ? streamLookup(target, ref.name) : undefined;
  };
  const symbolOf = (c: ClassInfo, m: Method): string => {
    const id = methodId(c, m.name);
    if (!symbols.has(id))
      symbols.set(id, { id, kind: 'METHOD', owner: c.name, name: m.name, role: c.role, loc: m.loc });
    return id;
  };
  const streamSymbol = (c: ClassInfo, s: Stream): string => {
    const id = streamId(c, s.name);
    if (!symbols.has(id))
      symbols.set(id, {
        id,
        kind: 'STREAM',
        owner: c.name,
        name: s.name,
        role: c.role,
        stream: {
          kind: s.kind,
          ...(s.type ? { type: s.type } : {}),
          operators: s.operators,
          consumed: 'NONE',
          ...(s.filters.length ? { filters: s.filters } : {}),
          ...(s.reads.length ? { reads: s.reads } : {}),
        },
        loc: s.loc,
      });
    return id;
  };
  const link = (l: UiLink): void => {
    const key = `${l.from}|${l.to}|${l.kind}`;
    const known = links.get(key);
    const rank = { CONFIRMED: 2, PROBABLE: 1, UNKNOWN: 0 };
    if (!known || rank[l.confidence] > rank[known.confidence]) links.set(key, l);
  };

  // 1. Consommateurs des flux : souscriptions explicites, pipe async des gabarits, puis par dérivation.
  const consumed = new Map<string, { how: 'SUBSCRIBED' | 'ASYNC' | 'DERIVED'; by: string }[]>();
  const consume = (id: string, how: 'SUBSCRIBED' | 'ASYNC' | 'DERIVED', by: string): void => {
    const list = consumed.get(id) ?? [];
    if (!list.some((x) => x.how === how && x.by === by)) list.push({ how, by });
    consumed.set(id, list);
  };
  for (const c of classes.values()) {
    for (const m of c.methods.values())
      for (const p of m.pipelines) {
        const r = resolveRef(c, p.source);
        if (r && p.subscribed) consume(streamId(r.cls, r.stream.name), 'SUBSCRIBED', methodId(c, m.name));
      }
    for (const ref of c.consumes) {
      const r = resolveRef(c, ref);
      if (r) consume(streamId(r.cls, r.stream.name), 'SUBSCRIBED', c.name);
    }
    if (c.component && c.template)
      for (const a of c.template.matchAll(/([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*\|\s*async\b/g)) {
        const [root = '', second] = (a[1] ?? '').split('.');
        const r =
          second && c.deps.has(root) ? resolveRef(c, { via: root, name: second }) : streamLookup(c, root);
        if (r) consume(streamId(r.cls, r.stream.name), 'ASYNC', c.name);
      }
  }
  // Un flux consommé consomme ses sources (point fixe borné).
  for (let round = 0; round < 50; round += 1) {
    let changed = false;
    for (const c of classes.values())
      for (const s of c.streams.values()) {
        const id = streamId(c, s.name);
        if (!consumed.has(id)) continue;
        for (const src of s.sources) {
          const r = resolveRef(c, src);
          if (!r) continue;
          const sid = streamId(r.cls, r.stream.name);
          if (!consumed.get(sid)?.some((x) => x.by === id)) {
            consume(sid, 'DERIVED', id);
            changed = true;
          }
        }
      }
    if (!changed) break;
  }
  const consumption = (
    id: string,
  ): { confidence: UiLink['confidence']; why: string; how: 'SUBSCRIBED' | 'ASYNC' | 'DERIVED' | 'NONE' } => {
    const list = consumed.get(id) ?? [];
    // Un flux n'est exécuté que s'il est souscrit : explicitement (sûr), par un gabarit affiché (probable).
    const direct = list.find((x) => x.how === 'SUBSCRIBED');
    if (direct) return { confidence: 'CONFIRMED', why: `souscrit par ${direct.by}`, how: 'SUBSCRIBED' };
    const viaAsync = list.find((x) => x.how === 'ASYNC');
    if (viaAsync)
      return {
        confidence: 'PROBABLE',
        why: `souscrit par le gabarit de ${viaAsync.by} (pipe async)`,
        how: 'ASYNC',
      };
    const derived = list.find((x) => x.how === 'DERIVED');
    if (derived) {
      const up = consumption(derived.by);
      return { confidence: up.confidence, why: `consommé via ${derived.by} (${up.why})`, how: 'DERIVED' };
    }
    return {
      confidence: 'UNKNOWN',
      why: 'aucune souscription trouvée (un Observable non souscrit n’est pas exécuté)',
      how: 'NONE',
    };
  };

  // 2. Appels HTTP : enveloppes (URL en paramètre), request(), URL non résolues.
  interface Wrapper {
    verb?: string;
    verbParam?: number;
    route: string;
    param: number;
  }
  const wrappers = new Map<string, Wrapper>();
  for (const c of classes.values())
    for (const m of c.methods.values())
      for (const h of m.http) {
        const url = urlOf(ts, h.url, c, m);
        const id = methodId(c, m.name);
        // Une enveloppe reçoit l'URL entière (éventuellement après une adresse de base) ; un paramètre qui
        // n'est qu'un segment (`/api/requests/${id}`) reste un segment variable.
        if (url.param !== undefined && url.route !== undefined && /^(\{base\})?\{url\}/.test(url.route)) {
          wrappers.set(id, {
            ...(h.verb ? { verb: h.verb } : {}),
            ...(h.verbParam !== undefined ? { verbParam: h.verbParam } : {}),
            route: url.route,
            param: url.param,
          });
          continue;
        }
        if (url.route !== undefined) url.route = url.route.replace(/\{url\}/g, '{param}');
        if (knownCalls.has(id) || calls.has(id) || !h.verb) continue;
        calls.set(id, {
          id,
          owner: c.name,
          method: h.verb,
          ...(url.route !== undefined
            ? { path: url.route.replace(/\?.*$/, '') }
            : {
                expression: url.expression,
                unresolved: 'URL construite dynamiquement : son expression ne se résout pas statiquement',
              }),
          loc: h.loc,
        });
      }
  const isLeaf = (id: string): boolean => knownCalls.has(id) || calls.has(id);

  // 3. Les liens de déclenchement et de données.
  const problems = new Map<string, UiDiagnostic[]>();
  const problem = (at: string, code: UiDiagnostic['code'], message: string, loc: Loc): void => {
    const list = problems.get(at) ?? [];
    if (!list.some((p) => p.code === code && p.message === message))
      list.push({ from: '', at, code, message, loc });
    problems.set(at, list);
  };
  const callers = new Map<string, { from: string; use: Use }[]>();
  const returns = new Map<string, boolean>();
  for (const c of classes.values())
    for (const m of c.methods.values())
      returns.set(methodId(c, m.name), m.returnsObservable || m.http.some((h) => h.use === 'RETURNED'));
  /** Résout un appel : lien, enveloppe HTTP, ou problème nommé. */
  const callTarget = (
    c: ClassInfo,
    m: Method,
    cs: CallSite,
  ): { id: string; cls: ClassInfo; method: Method } | undefined => {
    const from = methodId(c, m.name);
    const target = classOfDep(c, cs.target);
    if (!target) {
      const type = c.deps.get(cs.target) ?? cs.target;
      if (!LIBRARY.test(type))
        problem(
          from,
          'SERVICE_NOT_FOUND',
          `${type}.${cs.method}() : la classe ${type} n’est pas dans les sources analysées`,
          cs.loc,
        );
      return undefined;
    }
    const found = lookup(target, cs.method);
    if (!found) {
      if (!streamLookup(target, cs.method))
        problem(
          from,
          'METHOD_NOT_FOUND',
          `${target.name}.${cs.method}() : méthode introuvable dans ${target.name} ni ses classes de base`,
          cs.loc,
        );
      return undefined;
    }
    return { id: methodId(found.cls, found.method.name), ...found };
  };
  // ── Contexte d'appel : valeurs transmises, branches atteignables, provenance ──────────────────────
  /** Une valeur connue statiquement : littéral, symbole (membre d'enum non résolu), objet, instance. */
  interface Val {
    text: string;
    lit?: string;
    sym?: string;
    obj?: Map<string, Val>;
    inst?: string;
  }
  type Ctxt = ReadonlyMap<string, Val | undefined>;
  const keyOf = (v: Val | undefined): string | undefined => {
    if (!v) return undefined;
    if (v.lit !== undefined) return `L:${v.lit}`;
    if (v.sym) {
      const resolved = constants.get(v.sym);
      if (resolved === null) return undefined; // nom ambigu : jamais choisi
      return resolved !== undefined ? `L:${resolved}` : `S:${v.sym}`;
    }
    if (v.inst) return `I:${v.inst}`;
    return undefined;
  };
  const valOf = (
    e: TS.Expression,
    c: ClassInfo,
    m: Method,
    ctx: Ctxt | undefined,
    depth = 0,
  ): Val | undefined => {
    if (depth > 6) return undefined;
    const x = strip(ts, e);
    const text = short(x.getText(), 60);
    const lit = literalOf(ts, x);
    if (lit !== undefined) return { text, lit };
    if (ts.isIdentifier(x)) {
      if (m.params.includes(x.text)) return ctx?.get(x.text);
      const local = m.locals.get(x.text);
      if (local) return valOf(local, c, m, ctx, depth + 1);
      const mod = c.module.get(x.text);
      if (mod) return valOf(mod, c, m, ctx, depth + 1);
      const named = constants.get(x.text);
      return named ? { text, lit: named } : undefined;
    }
    if (ts.isPropertyAccessExpression(x)) {
      const named = constants.get(x.getText());
      if (named) return { text, lit: named };
      if (named === null) return undefined;
      if (x.expression.kind === ts.SyntaxKind.ThisKeyword) {
        const init = c.values.get(x.name.text);
        return init ? valOf(init, c, m, ctx, depth + 1) : undefined;
      }
      const head = valOf(x.expression, c, m, ctx, depth + 1);
      if (head?.obj) return head.obj.get(x.name.text);
      let root: TS.Expression = x;
      while (ts.isPropertyAccessExpression(root)) root = root.expression;
      return ts.isIdentifier(root) && /^[A-Z]/.test(root.text) ? { text, sym: x.getText() } : undefined;
    }
    if (ts.isObjectLiteralExpression(x)) {
      const obj = new Map<string, Val>();
      for (const prop of x.properties) {
        const name = prop.name?.getText();
        if (!name) continue;
        const v = ts.isPropertyAssignment(prop)
          ? valOf(prop.initializer, c, m, ctx, depth + 1)
          : ts.isShorthandPropertyAssignment(prop)
            ? valOf(prop.name, c, m, ctx, depth + 1)
            : undefined;
        if (v) obj.set(name, v);
      }
      return { text, obj };
    }
    if (ts.isNewExpression(x)) return { text, inst: x.expression.getText().split('.').pop() ?? '' };
    return undefined;
  };
  /** La valeur d'un chemin (`event.type`) dans un contexte. */
  const valAt = (path: string, ctx: Ctxt): Val | undefined => {
    const [root, ...rest] = path.split('.');
    let v = ctx.get(root ?? '');
    for (const seg of rest) v = v?.obj?.get(seg);
    return v;
  };
  const basesOf = (name: string): string[] => {
    const out: string[] = [];
    let cur = classes.get(name);
    while (cur?.base && !out.includes(cur.base)) {
      out.push(cur.base);
      cur = classes.get(cur.base);
    }
    return out;
  };
  /** Une condition dans un contexte : suivie (MATCH), écartée (NO), indéterminée, ou sans lien avec le contexte. */
  const verdictOf = (g: Guard, c: ClassInfo, m: Method, ctx: Ctxt): 'MATCH' | 'NO' | 'UNKNOWN' | 'FREE' => {
    if (!g.on || !m.params.includes(g.on.split('.')[0] ?? '')) return 'FREE';
    const v = valAt(g.on, ctx);
    let hit: boolean | undefined;
    if (g.instance) hit = v?.inst ? v.inst === g.instance || basesOf(v.inst).includes(g.instance) : undefined;
    else {
      const k = keyOf(v);
      if (k === undefined) return 'UNKNOWN';
      const keys = (g.values ?? []).map((e) => keyOf(valOf(e, c, m, undefined)));
      hit = keys.includes(k) ? true : keys.some((x) => x === undefined) ? undefined : false;
    }
    if (hit === undefined) return 'UNKNOWN';
    return hit !== g.negated ? 'MATCH' : 'NO';
  };
  const verdictAll = (gs: Guard[] | undefined, c: ClassInfo, m: Method, ctx: Ctxt | undefined) => {
    let out: 'MATCH' | 'NO' | 'UNKNOWN' = 'MATCH';
    if (!ctx) return out;
    for (const g of gs ?? []) {
      const v = verdictOf(g, c, m, ctx);
      if (v === 'NO') return 'NO';
      if (v === 'UNKNOWN') out = 'UNKNOWN';
    }
    return out;
  };
  /** Les chemins de paramètres qui choisissent les branches d'une méthode (directement ou en les transmettant). */
  const decisive = new Map<string, string[]>();
  const decisivePaths = (c: ClassInfo, m: Method, seen = new Set<string>()): string[] => {
    const id = methodId(c, m.name);
    const known = decisive.get(id);
    if (known) return known;
    if (seen.has(id)) return [];
    seen.add(id);
    const paths = new Set<string>();
    const sites = [...m.calls, ...m.emits.map((e) => ({ guards: e.guards }))];
    for (const site of sites)
      for (const g of site.guards ?? [])
        if (g.on && m.params.includes(g.on.split('.')[0] ?? '') && (g.values?.length || g.instance))
          paths.add(g.on);
    for (const cs of m.calls) {
      const target = classOfDep(c, cs.target);
      const found = target ? lookup(target, cs.method) : undefined;
      if (!found) continue;
      const inner = decisivePaths(found.cls, found.method, seen);
      if (!inner.length) continue;
      // Le paramètre transmis tel quel (ou un de ses champs) devient décisif ici aussi.
      cs.args.forEach((arg, i) => {
        const param = found.method.params[i];
        if (!param || !inner.some((p) => p === param || p.startsWith(`${param}.`))) return;
        const path = pathOf(ts, arg, m);
        if (m.params.includes(path.split('.')[0] ?? '')) paths.add(path);
      });
    }
    const list = [...paths];
    decisive.set(id, list);
    return list;
  };
  const conditionText = (gs: Guard[] | undefined): string | undefined => {
    const parts = (gs ?? []).map((g) => {
      if (g.kind === 'CASE') return `${g.on ?? ''} = ${(g.values ?? []).map((v) => v.getText()).join(' | ')}`;
      if (g.kind === 'DEFAULT')
        return `${g.on ?? ''} n’est aucun de ${(g.values ?? []).map((v) => v.getText()).join(', ')}`;
      if (g.kind === 'CATCH') return 'une exception est levée';
      if (g.kind === 'FINALLY') return 'fin du try';
      if (g.kind === 'LOOP') return `chaque itération de ${g.text}`;
      if (!g.whenFalse) return g.text;
      return /^!\s*[^=]/.test(g.text) ? g.text.replace(/^!\s*\(?\s*|\s*\)?$/g, '') : `non (${g.text})`;
    });
    return parts.length ? parts.join(' et ') : undefined;
  };
  const NOTE: Record<string, string> = {
    switchMap: ' ; une nouvelle émission annule le traitement en cours',
    exhaustMap: ' ; une émission est ignorée tant que le traitement en cours n’est pas fini',
    concatMap: ' ; les émissions sont traitées l’une après l’autre',
    mergeMap: ' ; les traitements peuvent se chevaucher',
    debounceTime: ' ; seule la dernière émission d’une rafale passe',
  };
  const asyncText = (cont: Continuation[] | undefined): string | undefined => {
    const parts = (cont ?? []).map((k) => {
      switch (k.how) {
        case 'AWAIT':
          return `après await ${k.after}`;
        case 'SUBSCRIBE':
          return `à chaque réponse de ${k.after} (subscribe)`;
        case 'THEN':
          return `à la résolution de ${k.after} (then)`;
        case 'ERROR':
          return `si ${k.after} échoue (${k.via})`;
        case 'FINALLY':
          return `à la fin de ${k.after} (${k.via})`;
        case 'OPERATOR':
          return `dans ${k.via} sur ${k.after}${NOTE[k.via] ?? ''}`;
        case 'TIMER':
          return `différé (${k.via})`;
        case 'EVENT':
          return `à un événement (${k.via})`;
        default:
          return `dans un rappel passé à ${k.after} (moment d’exécution non démontré)`;
      }
    });
    return parts.length ? parts.join(' ; ') : undefined;
  };
  const dataText = (cs: CallSite, m: Method): string | undefined => {
    const parts: string[] = [];
    for (const name of cs.uses ?? []) {
      const from = [...(cs.cont ?? [])].reverse().find((k) => k.binds.includes(name));
      if (from) {
        parts.push(`${name} = ${from.how === 'ERROR' ? 'erreur' : 'résultat'} de ${from.after}`);
        continue;
      }
      const local = m.locals.get(name);
      if (local && /\(/.test(local.getText())) parts.push(`${name} ← ${short(local.getText(), 60)}`);
      else if (local && ts.isObjectLiteralExpression(strip(ts, local))) {
        // L'objet construit à partir d'autres valeurs : leur provenance est suivie un niveau plus loin.
        const inner = (cs.cont ?? []).flatMap((k) =>
          k.binds.filter((b) => local.getText().includes(b)).map((b) => `${b} = résultat de ${k.after}`),
        );
        parts.push(`${name} ← ${short(local.getText(), 60)}${inner.length ? ` (${inner.join(', ')})` : ''}`);
      }
      const alias = m.aliases.get(name);
      if (alias) parts.push(`${name} = ${alias}`);
    }
    return parts.length ? [...new Set(parts)].join(' ; ') : undefined;
  };

  let clones = 0;
  const MAX_CLONES = 300;
  const MAX_CONTEXT_DEPTH = 4;
  const specialized = new Map<string, string>();
  /**
   * Une méthode générique vue avec les valeurs transmises par un appelant : ses appels et émissions ne sont
   * suivis que dans les branches compatibles ; une branche indéterminée reste, probable. Bornée (profondeur,
   * nombre de contextes) ; une limite atteinte est dite et l'appel retombe sur la méthode générique.
   */
  const specialize = (
    c: ClassInfo,
    m: Method,
    ctx: Ctxt,
    label: string,
    depth: number,
  ): string | undefined => {
    const id = methodId(c, m.name);
    const key = `${id}|${[...ctx].map(([k, v]) => `${k}=${JSON.stringify(v ? [keyOf(v), [...(v.obj ?? new Map<string, Val>())].map(([a, b]) => [a, keyOf(b)])] : null)}`).join(',')}`;
    const known = specialized.get(key);
    if (known) return known;
    if (depth > MAX_CONTEXT_DEPTH || clones >= MAX_CLONES) {
      problem(
        id,
        'LIMIT',
        `${id.replace('#', '.')}() : limite d’analyse contextuelle atteinte (profondeur ${String(MAX_CONTEXT_DEPTH)}, ${String(MAX_CLONES)} contextes) ; les branches ne sont plus distinguées`,
        m.loc,
      );
      return undefined;
    }
    clones += 1;
    const cloneId = `${id}⟨${label}⟩`;
    specialized.set(key, cloneId);
    const branches = { kept: 0, pruned: 0, unknown: 0 };
    symbols.set(cloneId, {
      id: cloneId,
      kind: 'METHOD',
      owner: c.name,
      name: `${m.name}(${label})`,
      role: c.role,
      of: id,
      context: label,
      branches,
      loc: m.loc,
    });
    for (const cs of m.calls) {
      const v = verdictAll(cs.guards, c, m, ctx);
      if (v === 'NO') {
        branches.pruned += 1;
        continue;
      }
      if (v === 'UNKNOWN') branches.unknown += 1;
      else branches.kept += 1;
      callLink(c, m, cloneId, cs, 'CALL', undefined, { ctx, verdict: v, depth });
    }
    for (const e of m.emits) {
      const v = verdictAll(e.guards, c, m, ctx);
      if (v === 'NO') continue;
      const r = resolveRef(c, e.ref);
      if (!r) continue;
      const sid = streamSymbol(r.cls, r.stream);
      const condition = conditionText(e.guards?.filter((g) => verdictOf(g, c, m, ctx) !== 'MATCH'));
      const asyncNote = asyncText(e.cont);
      link({
        from: cloneId,
        to: sid,
        kind: 'EMIT',
        confidence: v === 'UNKNOWN' ? 'PROBABLE' : 'CONFIRMED',
        reason: `${m.name}(${label}) émet sur ${sid} (next)${condition ? ` — si ${condition}` : ''}`,
        ...(condition ? { condition } : {}),
        ...(asyncNote ? { async: asyncNote } : {}),
        context: label,
        loc: e.loc,
      });
    }
    return cloneId;
  };

  const callLink = (
    c: ClassInfo,
    m: Method,
    from: string,
    cs: CallSite,
    kind: 'CALL' | 'PIPE',
    base?: { confidence: UiLink['confidence']; why: string; condition?: string; async?: string },
    scope?: { ctx: Ctxt; verdict: 'MATCH' | 'UNKNOWN'; depth: number },
  ): void => {
    const t = callTarget(c, m, cs);
    if (!t) return;
    const wrapper = wrappers.get(t.id);
    const caller = methodId(c, m.name);
    if (wrapper && kind === 'CALL' && !isLeaf(caller) && !scope) {
      // L'URL est fournie par l'appelant : l'appel HTTP est le sien.
      const arg = cs.args[wrapper.param];
      const url = urlOf(ts, arg, c, m);
      const verbArg = wrapper.verbParam !== undefined ? cs.args[wrapper.verbParam] : undefined;
      const verb =
        wrapper.verb ??
        (verbArg && (ts.isStringLiteral(verbArg) || ts.isNoSubstitutionTemplateLiteral(verbArg))
          ? verbArg.text.toUpperCase()
          : undefined);
      if (verb) {
        const route = url.route !== undefined ? wrapper.route.replace('{url}', url.route) : undefined;
        calls.set(caller, {
          id: caller,
          owner: c.name,
          method: verb,
          via: t.id,
          ...(route !== undefined
            ? { path: route.replace(/\?.*$/, '') }
            : {
                expression: url.expression,
                unresolved: `URL passée à ${t.id.replace('#', '.')}() non résolue statiquement`,
              }),
          loc: cs.loc,
        });
      }
    }
    symbolOf(t.cls, t.method);
    callers.set(t.id, [...(callers.get(t.id) ?? []), { from: caller, use: cs.use }]);
    const observable = returns.get(t.id) === true;
    let confidence: UiLink['confidence'] = 'CONFIRMED';
    const shown = from.includes('⟨') ? (symbols.get(from)?.name ?? from) : from.replace('#', '.');
    let why = `${shown}${from.includes('⟨') ? '' : '()'} appelle ${t.id.replace('#', '.')}()`;
    if (kind === 'PIPE' && base) {
      confidence = base.confidence;
      why = `${cs.operator ? `${cs.operator} → ` : ''}${t.id.replace('#', '.')}() à chaque émission (${base.why})`;
    } else if (observable && (cs.use === 'DROPPED' || cs.use === 'LOCAL')) {
      confidence = cs.use === 'DROPPED' ? 'UNKNOWN' : 'PROBABLE';
      why +=
        cs.use === 'DROPPED'
          ? ' — son Observable n’est jamais souscrit'
          : ' — souscription de son Observable non démontrée';
      if (cs.use === 'DROPPED' && !scope)
        problem(
          caller,
          'OBSERVABLE_NOT_SUBSCRIBED',
          `${t.id.replace('#', '.')}() rend un Observable que ${caller.replace('#', '.')}() ne souscrit pas : l’appel n’est pas exécuté`,
          cs.loc,
        );
    } else if (cs.use === 'SUBSCRIBED') why += ' et souscrit son résultat';
    // La méthode appelée choisit ses branches selon un paramètre : la valeur transmise, si elle est connue,
    // désigne une version contextuelle qui ne suit que les branches compatibles.
    let to = t.id;
    let context: string | undefined;
    const paths = decisivePaths(t.cls, t.method);
    if (paths.length) {
      const ctx = new Map<string, Val | undefined>();
      t.method.params.forEach((param, i) => {
        const arg = cs.args[i];
        if (arg) ctx.set(param, valOf(arg, c, m, scope?.ctx));
      });
      const shownVals = paths
        .map((path) => {
          const v = valAt(path, ctx);
          if (!keyOf(v) || !v) return undefined;
          return path.includes('.') ? `${path.split('.').slice(1).join('.')}=${v.text}` : v.text;
        })
        .filter((x): x is string => x !== undefined);
      if (shownVals.length) {
        const label = shownVals.join(', ');
        const clone = specialize(t.cls, t.method, ctx, label, (scope?.depth ?? 0) + 1);
        if (clone) {
          to = clone;
          context = label;
          const b = symbols.get(clone)?.branches;
          why += ` avec ${label} : seules les branches compatibles sont suivies${b ? ` (${String(b.kept)} retenue(s), ${String(b.pruned)} écartée(s)${b.unknown ? `, ${String(b.unknown)} indéterminée(s)` : ''})` : ''}`;
        }
      } else if (!scope && kind === 'CALL')
        problem(
          caller,
          'CONTEXT_UNRESOLVED',
          `${t.id.replace('#', '.')}() choisit son traitement selon ${paths.join(', ')} ; la valeur transmise par ${caller.replace('#', '.')}() (${cs.args.map((a) => short(a.getText(), 30)).join(', ')}) n’est pas déterminable statiquement : toutes ses branches restent possibles`,
          cs.loc,
        );
    }
    // Dans un contexte, une condition déjà tranchée par la valeur transmise n'est pas répétée.
    const guards = scope ? cs.guards?.filter((g) => verdictOf(g, c, m, scope.ctx) !== 'MATCH') : cs.guards;
    const condition = [base?.condition, conditionText(guards)].filter(Boolean).join(' et ') || undefined;
    const asyncNote = [base?.async, asyncText(cs.cont)].filter(Boolean).join(' ; ') || undefined;
    const data = dataText(cs, m);
    // Dans la méthode générique elle-même (aucun contexte), une branche choisie par un paramètre n'est
    // qu'une possibilité : elle n'est empruntée que pour certaines valeurs transmises.
    const chosenBy = !scope
      ? cs.guards?.find(
          (g) => g.on && m.params.includes(g.on.split('.')[0] ?? '') && (g.values?.length || g.instance),
        )
      : undefined;
    if (chosenBy && confidence === 'CONFIRMED') {
      confidence = 'PROBABLE';
      why += ` — branche choisie par la valeur de ${chosenBy.on ?? ''} (contexte d’appel non déterminé ici)`;
    }
    if (scope?.verdict === 'UNKNOWN' && confidence === 'CONFIRMED') {
      confidence = 'PROBABLE';
      why += ' — la valeur qui choisit cette branche n’est pas déterminable statiquement';
    }
    if (cs.cont?.some((k) => k.how === 'CALLBACK') && confidence === 'CONFIRMED') confidence = 'PROBABLE';
    if (condition) why += ` — si ${condition}`;
    if (asyncNote) why += ` — ${asyncNote}`;
    link({
      from,
      to,
      kind,
      confidence,
      reason: why,
      ...(condition ? { condition } : {}),
      ...(asyncNote ? { async: asyncNote } : {}),
      ...(data ? { data } : {}),
      ...(context ? { context } : {}),
      loc: cs.loc,
    });
  };
  for (const c of classes.values()) {
    for (const m of c.methods.values()) {
      const from = symbolOf(c, m);
      for (const cs of m.calls) callLink(c, m, from, cs, 'CALL');
      for (const e of m.emits) {
        const r = resolveRef(c, e.ref);
        if (!r) continue;
        const sid = streamSymbol(r.cls, r.stream);
        link({
          from,
          to: sid,
          kind: 'EMIT',
          confidence: 'CONFIRMED',
          reason: `${m.name}() émet sur ${sid} (next)`,
          loc: e.loc,
        });
        for (const f of e.fedBy) {
          const t = callTarget(c, m, f);
          if (t) {
            symbolOf(t.cls, t.method);
            link({
              from: t.id,
              to: sid,
              kind: 'FEEDS',
              confidence: 'CONFIRMED',
              reason: `la réponse de ${t.id.replace('#', '.')}() est poussée dans ${sid}`,
              loc: e.loc,
            });
          }
        }
      }
      for (const p of m.pipelines) {
        const r = resolveRef(c, p.source);
        // Un flux d'une bibliothèque (ActivatedRoute.params…) : le traitement part de la méthode qui s'y abonne.
        const sid = r ? streamSymbol(r.cls, r.stream) : from;
        const origin = r ? sid : `${p.source.via === 'this' ? '' : `${p.source.via}.`}${p.source.name}`;
        const base = p.subscribed
          ? {
              confidence: 'CONFIRMED' as const,
              why: `abonnement à ${origin} dans ${methodId(c, m.name).replace('#', '.')}()`,
            }
          : { confidence: 'UNKNOWN' as const, why: `traitement de ${origin} jamais souscrit` };
        const operator = p.operators.find((o) => INNER.has(o));
        const stops = p.operators.filter((o) => ['takeUntil', 'takeWhile', 'take', 'first'].includes(o));
        const pipeBase = {
          ...base,
          ...(p.filters?.length ? { condition: `filter(${p.filters.join(') et filter(')})` } : {}),
          ...(stops.length
            ? { async: `le traitement s’arrête par ${stops.join(', ')} (annulation possible)` }
            : {}),
        };
        for (const cs of p.calls)
          callLink(c, m, sid, { ...cs, ...(operator ? { operator } : {}) }, 'PIPE', pipeBase);
        for (const e of p.emits) {
          const target = resolveRef(c, e.ref);
          if (!target) continue;
          const tid = streamSymbol(target.cls, target.stream);
          link({
            from: sid,
            to: tid,
            kind: 'PROPAGATES',
            confidence: base.confidence,
            reason: `le traitement de ${origin} émet sur ${tid} (${base.why})`,
            loc: e.loc,
          });
          for (const cs of p.calls) {
            const t = callTarget(c, m, cs);
            if (t)
              link({
                from: t.id,
                to: tid,
                kind: 'FEEDS',
                confidence: 'CONFIRMED',
                reason: `la réponse de ${t.id.replace('#', '.')}() est poussée dans ${tid}`,
                loc: e.loc,
              });
          }
        }
      }
      for (const o of m.outputs) {
        // Le parent lie (sortie)="gestionnaire()" sur la balise de l'enfant.
        if (!c.selector) continue;
        const tag = c.selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        for (const parent of classes.values()) {
          if (!parent.template) continue;
          for (const t of parent.template.matchAll(
            new RegExp(`<${tag}\\b[^>]*\\(${o.name}\\)\\s*=\\s*"([^"]*)"`, 'g'),
          ))
            for (const h of (t[1] ?? '').matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
              const pm = parent.methods.get(h[1] ?? '');
              if (!pm) continue;
              link({
                from,
                to: symbolOf(parent, pm),
                kind: 'OUTPUT',
                confidence: 'CONFIRMED',
                reason: `@Output ${o.name} de <${c.selector}> → (${o.name})="${h[1] ?? ''}()" dans ${parent.name}`,
                loc: o.loc,
              });
            }
        }
      }
    }
    for (const s of c.streams.values()) {
      const sid = streamSymbol(c, s);
      const run = consumption(sid);
      for (const src of s.sources) {
        const r = resolveRef(c, src);
        if (!r) continue;
        const up = streamSymbol(r.cls, r.stream);
        link({
          from: sid,
          to: up,
          kind: 'DERIVES',
          confidence: 'CONFIRMED',
          reason: `${sid} est calculé à partir de ${up}`,
          loc: s.loc,
        });
        link({
          from: up,
          to: sid,
          kind: 'PROPAGATES',
          confidence: run.confidence,
          reason: `une émission de ${up} traverse ${sid} (${run.why})`,
          loc: s.loc,
        });
      }
      const pseudo: Method = {
        name: s.name,
        params: [],
        locals: new Map(),
        aliases: new Map(),
        calls: [],
        emits: [],
        http: [],
        pipelines: [],
        outputs: [],
        returnsObservable: true,
        loc: s.loc,
      };
      for (const h of s.http) {
        // L'appel HTTP est fait par la définition du flux : il s'exécute quand le flux est souscrit.
        const id = methodId(c, s.name);
        const url = urlOf(ts, h.url, c, pseudo);
        if (!knownCalls.has(id) && !calls.has(id) && h.verb)
          calls.set(id, {
            id,
            owner: c.name,
            method: h.verb,
            ...(url.route !== undefined
              ? { path: url.route.replace(/\?.*$/, '') }
              : {
                  expression: url.expression,
                  unresolved: 'URL construite dynamiquement : son expression ne se résout pas statiquement',
                }),
            loc: h.loc,
          });
        if (!symbols.has(id))
          symbols.set(id, { id, kind: 'METHOD', owner: c.name, name: s.name, role: c.role, loc: h.loc });
        link({
          from: sid,
          to: id,
          kind: 'PIPE',
          confidence: run.confidence,
          reason: `${sid} fait l’appel HTTP ${h.verb ?? ''} à sa souscription (${run.why})`,
          loc: h.loc,
        });
        link({
          from: id,
          to: sid,
          kind: 'FEEDS',
          confidence: 'CONFIRMED',
          reason: `${sid} rend la réponse de l’appel HTTP`,
          loc: h.loc,
        });
      }
      // Un flux défini en propriété (`results$ = query.pipe(switchMap(…), takeUntil(…))`) : ses opérateurs
      // disent quand le traitement est remplacé, ignoré ou arrêté, et ses filter() quand il passe.
      const stops = s.operators.filter((o) => ['takeUntil', 'takeWhile', 'take', 'first'].includes(o));
      for (const cs of s.calls) {
        const m = pseudo;
        const notes = [
          cs.operator && INNER.has(cs.operator) ? `dans ${cs.operator}${NOTE[cs.operator] ?? ''}` : '',
          stops.length ? `le traitement s’arrête par ${stops.join(', ')} (annulation possible)` : '',
        ].filter(Boolean);
        callLink(c, m, sid, cs, 'PIPE', {
          confidence: run.confidence,
          why: run.why,
          ...(s.filters.length ? { condition: `filter(${s.filters.join(') et filter(')})` } : {}),
          ...(notes.length ? { async: notes.join(' ; ') } : {}),
        });
        const t = callTarget(c, m, cs);
        if (t && cs.operator && INNER.has(cs.operator))
          link({
            from: t.id,
            to: sid,
            kind: 'FEEDS',
            confidence: 'CONFIRMED',
            reason: `${sid} rend les réponses de ${t.id.replace('#', '.')}() (${cs.operator})`,
            loc: cs.loc,
          });
      }
    }
  }
  for (const [id, list] of consumed) {
    const sym = symbols.get(id);
    if (sym?.stream) {
      sym.stream.consumed = consumption(id).how;
      sym.stream.consumers = [...new Set(list.map((x) => x.by))].slice(0, 10);
    }
  }

  // 4. Diagnostics : depuis chaque méthode de composant, l'étape où la chaîne s'arrête sans appel HTTP.
  const out = new Map<string, UiLink[]>();
  for (const l of links.values())
    if (!['DERIVES', 'FEEDS'].includes(l.kind)) out.set(l.from, [...(out.get(l.from) ?? []), l]);
  for (const c of classes.values()) {
    if (!c.component) continue;
    for (const m of c.methods.values()) {
      const start = methodId(c, m.name);
      if (!out.has(start) && !isLeaf(start) && !problems.has(start)) continue;
      const seen = new Set<string>([start]);
      const queue = [start];
      let reached = false;
      const ends: UiDiagnostic[] = [];
      let visits = 0;
      while (queue.length > 0) {
        if ((visits += 1) > MAX_VISITS) {
          ends.push({
            from: start,
            at: start,
            code: 'LIMIT',
            message: 'exploration bornée atteinte : chaîne incomplète',
            loc: m.loc,
          });
          break;
        }
        const cur = queue.shift() ?? '';
        if (isLeaf(cur)) {
          const call = calls.get(cur) ?? knownCalls.get(cur);
          if (call?.unresolved)
            ends.push({
              from: start,
              at: cur,
              code: 'URL_DYNAMIC',
              message: `${cur.replace('#', '.')}() : ${call.unresolved}${call.expression ? ` (${call.expression})` : ''}`,
              loc: call.loc,
            });
          else reached = true;
        }
        for (const p of problems.get(cur) ?? []) ends.push({ ...p, from: start });
        const next = (out.get(cur) ?? []).filter((l) => l.confidence !== 'UNKNOWN');
        const blocked = (out.get(cur) ?? []).filter((l) => l.confidence === 'UNKNOWN' && l.kind !== 'CALL');
        for (const b of blocked)
          ends.push({
            from: start,
            at: b.to,
            code: 'STREAM_NOT_SUBSCRIBED',
            message: `${b.to.replace('#', '.')} : ${b.reason}`,
            loc: b.loc,
          });
        const sym = symbols.get(cur);
        // Un flux qui reçoit des émissions et que l'écran consomme (async, subscribe) est un état d'interface :
        // la chaîne s'y termine normalement. Sans aucun consommateur, l'émission ne sert à rien de démontrable.
        if (sym?.kind === 'STREAM' && (out.get(cur) ?? []).length === 0 && consumption(cur).how === 'NONE')
          ends.push({
            from: start,
            at: cur,
            code: 'SUBJECT_NO_CONSUMER',
            message: `${cur} reçoit des émissions, mais n’est ni souscrit ni traité (pipe, subscribe, flux dérivé, pipe async)`,
            loc: sym.loc,
          });
        if (
          sym?.kind === 'METHOD' &&
          cur !== start &&
          !isLeaf(cur) &&
          (out.get(cur) ?? []).length === 0 &&
          !problems.has(cur)
        )
          ends.push({
            from: start,
            at: cur,
            code: 'NO_HTTP',
            message: `${cur.replace('#', '.')}() est résolu, mais aucun appel HTTP ni appel suivant n’y est identifié`,
            loc: sym.loc,
          });
        for (const l of next)
          if (!seen.has(l.to)) {
            seen.add(l.to);
            queue.push(l.to);
          }
      }
      // Un cycle d'appels sans appel HTTP : le chemin exact (profondeur d'abord, borné).
      if (!reached) {
        const onStack: string[] = [];
        const done = new Set<string>();
        const found: { cycle?: string[] } = {};
        let steps = 0;
        /** Rend vrai dès qu'un cycle est trouvé (il est alors dans found.cycle). */
        const dfs = (id: string): boolean => {
          if ((steps += 1) > MAX_VISITS) return false;
          onStack.push(id);
          for (const l of (out.get(id) ?? []).filter((x) => x.confidence !== 'UNKNOWN')) {
            const at = onStack.indexOf(l.to);
            if (at >= 0) {
              found.cycle = [...onStack.slice(at), l.to];
              return true;
            }
            if (!done.has(l.to) && dfs(l.to)) return true;
          }
          onStack.pop();
          done.add(id);
          return false;
        };
        dfs(start);
        const cycle = found.cycle;
        if (cycle)
          ends.push({
            from: start,
            at: cycle[0] ?? start,
            code: 'CYCLE',
            message: `cycle d’appels sans appel HTTP : ${cycle.map((x) => (x.includes('#') ? `${x.replace('#', '.')}()` : x)).join(' → ')}`,
            loc: symbols.get(cycle[0] ?? '')?.loc ?? m.loc,
          });
      }
      // Une imprécision (branches non distinguées, limite contextuelle) est dite même quand un appel HTTP
      // est atteint : la chaîne existe, mais elle peut contenir des branches que l'action n'emprunte pas.
      const kept = reached ? ends.filter((d) => d.code === 'CONTEXT_UNRESOLVED' || d.code === 'LIMIT') : ends;
      if (kept.length > 0) {
        const unique = new Map(kept.map((d) => [`${d.code}|${d.message}`, d]));
        diagnostics.push(...[...unique.values()].slice(0, 6));
      }
    }
  }

  // 5. Les méthodes de composant : point d'entrée (gabarit, cycle de vie) ou interne.
  for (const c of classes.values()) {
    if (!c.component) continue;
    const bound = new Set<string>();
    for (const e of (c.template ?? '').matchAll(/\(([\w.-]+)\)\s*=\s*"([^"]*)"/g))
      for (const h of (e[2] ?? '').matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) bound.add(h[1] ?? '');
    for (const m of c.methods.values()) {
      const id = methodId(c, m.name);
      if (!out.has(id) && !isLeaf(id) && !problems.has(id)) continue;
      const sym = symbols.get(id) ?? {
        id,
        kind: 'METHOD' as const,
        owner: c.name,
        name: m.name,
        role: c.role,
        loc: m.loc,
      };
      sym.entry = LIFECYCLE.has(m.name) ? 'LIFECYCLE' : bound.has(m.name) ? 'TEMPLATE' : 'INTERNAL';
      symbols.set(id, sym);
    }
  }

  const streamOf = (component: string, member: string, path: readonly string[]): string | undefined => {
    const c = classes.get(component);
    if (!c) return undefined;
    const own = streamLookup(c, member);
    if (own) return streamSymbol(own.cls, own.stream);
    const second = path[0];
    if (second && c.deps.has(member)) {
      const r = resolveRef(c, { via: member, name: second });
      if (r) return streamSymbol(r.cls, r.stream);
    }
    return undefined;
  };
  // Les symboles sont lus après streamOf (qui peut en ajouter un pour un état de gabarit).
  return {
    get symbols() {
      return [...symbols.values()];
    },
    links: [...links.values()],
    diagnostics,
    calls: [...calls.values()],
    wrappers: [...wrappers.keys()],
    streamOf,
    warnings,
  };
}
