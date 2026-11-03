import path from 'node:path';
import ts from 'typescript';
import type { ScopeApplication } from '../../sdk/core/incident-contracts.js';
import type { AngularLink, AngularModel, AngularNode } from '../../sdk/core/incident-trigger-contracts.js';
import type { GuardedFiles } from './files.js';

/**
 * L'ANALYSEUR ANGULAR : ce que l'application utilise réellement (standalone ou NgModules, Zone.js ou zoneless,
 * signals, formulaires réactifs ou pilotés par le template, OnPush, ErrorHandler, interceptors, gestion d'état)
 * et les liens Template → Component → Handler → Service → flux → HttpClient → Interceptor → API. Chaque lien
 * porte sa provenance (fichier, ligne) et sa certitude : STATICALLY_RESOLVED quand le code le dit sans
 * ambiguïté, INFERRED quand un nom ou une convention le suggère. Rien ici ne prouve qu'un handler a tourné.
 * Lecture par le Scope Policy Engine seulement ; bornes de fichiers et de taille.
 */
export interface AngularAnalysisOptions {
  maxFiles?: number;
  maxFileBytes?: number;
}

const DEFAULT_MAX_FILES = 400;
const DEFAULT_MAX_BYTES = 400_000;
const EXTENSIONS = ['.ts', '.html'];
const SKIP = /(\.spec\.ts$|\.test\.ts$|\/node_modules\/|\/dist\/|\.stories\.ts$|\/e2e\/)/;
const LIFECYCLE = new Set([
  'ngOnInit',
  'ngOnChanges',
  'ngOnDestroy',
  'ngAfterViewInit',
  'ngAfterContentInit',
  'ngDoCheck',
  'ngAfterViewChecked',
  'ngAfterContentChecked',
]);
const EVENT_BINDING =
  /\((click|submit|ngSubmit|change|input|blur|focus|keyup(?:\.\w+)?|keydown(?:\.\w+)?|selectionChange|valueChange|closed|opened)\)\s*=\s*"([^"]*)"/g;
const HTTP_CALL =
  /\bthis\.(\w+)\.(get|post|put|patch|delete|request)\s*(?:<[^>]*>)?\s*\(\s*(['"`])([^'"`]*)\3/g;
const SERVICE_CALL = /\bthis\.(\w+)\.(\w+)\s*\(/g;
const STREAM_DECL =
  /\b([\w$]+)\s*(?::\s*[\w<>[\], |]+)?\s*=\s*new\s+(Subject|BehaviorSubject|ReplaySubject|AsyncSubject)\b/g;
const SIGNAL_DECL =
  /\b(\w+)\s*=\s*(signal|computed|effect|input|model|output|toSignal|linkedSignal)\s*(?:<[^>]*>)?\s*\(/g;
const FORM_DECL =
  /\b(\w+)\s*(?::\s*(FormGroup|FormControl|FormArray|UntypedFormGroup)[\w<>, |]*)?\s*=\s*(?:new\s+(FormGroup|FormControl|FormArray)|this\.(?:fb|formBuilder|builder)\.(group|control|array)|inject\(FormBuilder\)\.(group|control|array))\b/g;
const CONTROL_KEYS = /^\s*(\w+)\s*:\s*(?:\[|new\s+FormControl|this\.fb\.control|\{)/gm;
const VALIDATOR = /\bValidators\.(\w+)/g;
const ASYNC_VALIDATOR = /asyncValidators?\s*:|AsyncValidatorFn|\basyncValidator/;
const ROUTE_ENTRY = /\{\s*path\s*:\s*['"`]([^'"`]*)['"`]\s*,\s*(?:[^}]*?)component\s*:\s*(\w+)/g;
/** Un objet de route sans accolade imbriquée : `{ path: 'x', component: X, canActivate: [g] }`. */
const ROUTE_OBJECT = /\{[^{}]*?\bpath\s*:\s*['"`]([^'"`]*)['"`][^{}]*\}/g;
/** Un lien ou un bouton de navigation d'un template, et son contenu. */
const NAV_ELEMENT = /<(a|button)\b([^>]*)>([\s\S]{0,240}?)<\/\1>/gi;
const HEADING = /<(h[1-3])\b[^>]*>([\s\S]{1,160}?)<\/\1>/gi;
/** Le texte visible d'un fragment de template : balises et interpolations retirées. */
const visibleText = (html: string): string =>
  html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\{\{[^}]*\}\}/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
/** La cible d'un lien : `routerLink="x"`, `[routerLink]="'x'"`, `[routerLink]="['/x']"`, `href="/x"`. */
function linkTarget(attributes: string): string | undefined {
  const plain = /\brouterLink\s*=\s*"([^"]+)"/.exec(attributes)?.[1];
  if (plain) return plain;
  const bound = /\[routerLink\]\s*=\s*"\s*\[?\s*'([^']+)'/.exec(attributes)?.[1];
  if (bound) return bound;
  const href = /\bhref\s*=\s*"(\/[^"#?]*)/.exec(attributes)?.[1];
  return href;
}

interface FileText {
  absolute: string;
  relative: string;
  text: string;
}

function lineOf(sf: ts.SourceFile, position: number): number {
  return sf.getLineAndCharacterOfPosition(position).line + 1;
}

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

function decoratorsOf(node: ts.ClassDeclaration): { name: string; arg?: ts.ObjectLiteralExpression }[] {
  const out: { name: string; arg?: ts.ObjectLiteralExpression }[] = [];
  for (const modifier of ts.getDecorators(node) ?? []) {
    const expression = modifier.expression;
    if (!ts.isCallExpression(expression)) continue;
    const name = expression.expression.getText();
    const first = expression.arguments[0];
    out.push({ name, ...(first && ts.isObjectLiteralExpression(first) ? { arg: first } : {}) });
  }
  return out;
}

function property(arg: ts.ObjectLiteralExpression | undefined, name: string): ts.Expression | undefined {
  if (!arg) return undefined;
  for (const item of arg.properties)
    if (ts.isPropertyAssignment(item) && item.name.getText() === name) return item.initializer;
  return undefined;
}

const stringOf = (expression: ts.Expression | undefined): string | undefined =>
  expression && (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression))
    ? expression.text
    : undefined;

function heritage(node: ts.ClassDeclaration): string[] {
  const names: string[] = [];
  for (const clause of node.heritageClauses ?? [])
    for (const type of clause.types) names.push(type.expression.getText());
  return names;
}

export class AngularAnalyzer {
  private readonly nodes = new Map<string, AngularNode>();
  private readonly links: AngularLink[] = [];
  private readonly features: AngularModel['features'] = {};
  private readonly denied: string[] = [];
  private readonly truncated: string[] = [];
  private readonly handlersByComponent = new Map<string, Set<string>>();
  private readonly serviceFields = new Map<string, Map<string, string>>();
  private readonly injectables = new Set<string>();
  private readonly templates = new Map<string, { file: string; text: string; inline: boolean }>();
  private files = 0;

  private readonly routeEntries: { path: string; component: string }[] = [];
  private readonly navigation: NonNullable<AngularModel['navigation']> = {
    routes: [],
    links: [],
    headings: [],
  };

  constructor(private readonly app: ScopeApplication) {}

  async analyze(files: GuardedFiles, options: AngularAnalysisOptions = {}): Promise<AngularModel> {
    const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    const maxBytes = options.maxFileBytes ?? DEFAULT_MAX_BYTES;
    const roots = this.app.repository.include.length > 0 ? this.app.repository.include : [''];
    const listed: string[] = [];
    for (const include of roots) {
      try {
        listed.push(
          ...(await files.list(path.join(this.app.repository.root, include), { extensions: EXTENSIONS })),
        );
      } catch (error) {
        this.denied.push(`${include || '(racine)'} : ${describe(error)}`);
      }
    }
    const sources: FileText[] = [];
    for (const absolute of [...new Set(listed)].filter((file) => !SKIP.test(file)).sort()) {
      if (sources.length >= maxFiles) {
        this.truncated.push(`${String(maxFiles)} fichiers lus au plus : l’analyse Angular est partielle.`);
        break;
      }
      let text: string;
      try {
        text = await files.readText(absolute);
      } catch (error) {
        this.denied.push(`${this.relative(absolute)} : ${describe(error)}`);
        continue;
      }
      if (text.length > maxBytes) {
        this.truncated.push(`${this.relative(absolute)} dépasse ${String(maxBytes)} caractères : ignoré.`);
        continue;
      }
      sources.push({ absolute, relative: this.relative(absolute), text });
    }
    this.files = sources.length;
    for (const source of sources.filter((file) => file.relative.endsWith('.html')))
      this.templates.set(source.relative, { file: source.relative, text: source.text, inline: false });
    // Les routes sont déclarées hors des composants (app.routes.ts) : elles sont relevées avant l'analyse.
    for (const source of sources.filter((file) => file.relative.endsWith('.ts')))
      for (const match of source.text.matchAll(ROUTE_ENTRY))
        this.routeEntries.push({ path: match[1] ?? '', component: match[2] ?? '' });
    // La navigation : chaque objet de route (composant, redirection, gardes), pour le parcours d'accès.
    for (const source of sources.filter(
      (file) => file.relative.endsWith('.ts') && /\bpath\s*:/.test(file.text),
    ))
      for (const match of source.text.matchAll(ROUTE_OBJECT)) {
        const body = match[0];
        const guards = [...body.matchAll(/\b(?:canActivate|canMatch|canActivateChild)\s*:\s*\[([^\]]*)\]/g)]
          .flatMap((entry) => (entry[1] ?? '').split(','))
          .map((name) => name.trim().replace(/\(.*$/, ''))
          .filter((name) => /^\w+$/.test(name));
        const component = /\bcomponent\s*:\s*(\w+)/.exec(body)?.[1];
        const redirectTo = /\bredirectTo\s*:\s*['"`]([^'"`]*)['"`]/.exec(body)?.[1];
        if (!component && redirectTo === undefined) continue;
        this.navigation.routes.push({
          path: match[1] ?? '',
          ...(component ? { component } : {}),
          ...(redirectTo !== undefined ? { redirectTo } : {}),
          guards,
          file: source.relative,
          line: lineAt(source.text, match.index),
        });
      }
    for (const source of sources.filter((file) => file.relative.endsWith('.ts'))) this.analyzeTs(source);
    for (const [componentId, template] of this.componentTemplates)
      this.analyzeTemplate(componentId, template);
    this.linkServices();
    return {
      applicationId: this.app.id,
      features: this.features,
      nodes: [...this.nodes.values()],
      links: this.links,
      navigation: this.navigation,
      files: this.files,
      denied: this.denied,
      truncated: this.truncated,
    };
  }

  private readonly componentTemplates = new Map<string, { file: string; text: string; inline: boolean }>();

  private relative(absolute: string): string {
    return path.relative(this.app.repository.root, absolute).split(path.sep).join('/');
  }

  private id(kind: AngularNode['kind'], file: string, name: string): string {
    return `${this.app.id}:${kind.toLowerCase()}:${file}#${name}`;
  }

  private add(node: AngularNode): AngularNode {
    const existing = this.nodes.get(node.id);
    if (existing) return existing;
    this.nodes.set(node.id, node);
    return node;
  }

  private link(link: AngularLink): void {
    if (this.links.some((item) => item.from === link.from && item.to === link.to && item.kind === link.kind))
      return;
    this.links.push(link);
  }

  private analyzeTs(source: FileText): void {
    const { text, relative } = source;
    const sf = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    if (/provide(Experimental)?ZonelessChangeDetection\s*\(/.test(text)) this.features.zoneless = true;
    if (/['"]zone\.js(\/[\w.-]+)?['"]/.test(text)) this.features.zoneJs = true;
    if (/@ngrx\/store|@ngrx\/signals/.test(text)) this.features.stateManagement = 'NgRx';
    else if (/@ngxs\/store/.test(text)) this.features.stateManagement = 'NGXS';
    else if (/@datorama\/akita|@ngneat\/elf/.test(text)) this.features.stateManagement ??= 'Akita/Elf';
    if (/ReactiveFormsModule|FormBuilder|new FormGroup|new FormControl/.test(text))
      this.features.reactiveForms = true;
    if (/FormsModule|\[\(ngModel\)\]|ngModel/.test(text)) this.features.templateForms = true;
    if (/\b(signal|computed|effect)\s*(<[^>]*>)?\s*\(/.test(text) && /@angular\/core/.test(text))
      this.features.signals = true;
    if (/\{\s*provide\s*:\s*ErrorHandler/.test(text)) this.features.customErrorHandler = true;
    if (/HTTP_INTERCEPTORS|withInterceptors\s*\(|HttpInterceptorFn|implements\s+HttpInterceptor\b/.test(text))
      this.features.interceptors = true;
    if (/provideHttpClient\s*\(|HttpClientModule/.test(text)) this.features.interceptors ??= false;

    const routes = this.routeEntries;

    for (const statement of sf.statements) {
      // Les fonctions d'interception, de garde et de résolution (API fonctionnelle).
      if (ts.isVariableStatement(statement))
        for (const declaration of statement.declarationList.declarations) {
          const name = declaration.name.getText();
          const type = declaration.type?.getText() ?? '';
          const line = lineOf(sf, declaration.getStart());
          if (/HttpInterceptorFn/.test(type)) {
            this.features.interceptors = true;
            this.add({
              id: this.id('INTERCEPTOR', relative, name),
              kind: 'INTERCEPTOR',
              name,
              applicationId: this.app.id,
              file: relative,
              line,
              detail: { style: 'functional' },
            });
          } else if (/CanActivateFn|CanMatchFn|CanDeactivateFn/.test(type))
            this.add({
              id: this.id('GUARD', relative, name),
              kind: 'GUARD',
              name,
              applicationId: this.app.id,
              file: relative,
              line,
            });
          else if (/ResolveFn/.test(type))
            this.add({
              id: this.id('RESOLVER', relative, name),
              kind: 'RESOLVER',
              name,
              applicationId: this.app.id,
              file: relative,
              line,
            });
        }
      if (!ts.isClassDeclaration(statement) || !statement.name) continue;
      const className = statement.name.text;
      const decorators = decoratorsOf(statement);
      const implemented = heritage(statement);
      const line = lineOf(sf, statement.getStart());
      const component = decorators.find((item) => item.name === 'Component');
      const directive = decorators.find((item) => item.name === 'Directive');
      const injectable = decorators.find((item) => item.name === 'Injectable');
      if (decorators.some((item) => item.name === 'NgModule')) this.features.ngModules = true;

      if (component) {
        const arg = component.arg;
        const standalone = property(arg, 'standalone');
        if (standalone?.kind === ts.SyntaxKind.TrueKeyword) this.features.standalone = true;
        else if (standalone?.kind === ts.SyntaxKind.FalseKeyword) this.features.ngModules = true;
        const onPush = /OnPush/.test(property(arg, 'changeDetection')?.getText() ?? '');
        if (onPush) this.features.onPush = true;
        const selector = stringOf(property(arg, 'selector')) ?? '';
        const templateUrl = stringOf(property(arg, 'templateUrl'));
        const inline = stringOf(property(arg, 'template'));
        const node = this.add({
          id: this.id('COMPONENT', relative, className),
          kind: 'COMPONENT',
          name: className,
          applicationId: this.app.id,
          file: relative,
          line,
          detail: {
            selector,
            ...(standalone?.kind === ts.SyntaxKind.TrueKeyword ? { standalone: true } : {}),
            ...(onPush ? { onPush: true } : {}),
            routes: routes.filter((route) => route.component === className).map((route) => route.path),
          },
        });
        const templateFile = templateUrl
          ? path.posix.normalize(path.posix.join(path.posix.dirname(relative), templateUrl))
          : undefined;
        const template = templateFile ? this.templates.get(templateFile) : undefined;
        if (template) this.componentTemplates.set(node.id, template);
        else if (inline !== undefined)
          this.componentTemplates.set(node.id, { file: relative, text: inline, inline: true });
        else if (templateUrl) this.truncated.push(`${relative} : template ${templateUrl} non lu.`);
        this.analyzeClassBody(sf, statement, node, relative, text);
      } else if (
        injectable ||
        implemented.some((name) => /HttpInterceptor|ErrorHandler|CanActivate|Resolve/.test(name))
      ) {
        const isInterceptor = implemented.some((name) => /HttpInterceptor/.test(name));
        const isErrorHandler = implemented.some((name) => /ErrorHandler/.test(name));
        const isGuard = implemented.some((name) => /CanActivate|CanMatch|CanDeactivate/.test(name));
        const isResolver = implemented.some((name) => /^Resolve\b/.test(name));
        const kind: AngularNode['kind'] = isInterceptor
          ? 'INTERCEPTOR'
          : isErrorHandler
            ? 'ERROR_HANDLER'
            : isGuard
              ? 'GUARD'
              : isResolver
                ? 'RESOLVER'
                : 'SERVICE';
        if (isInterceptor) this.features.interceptors = true;
        if (isErrorHandler) this.features.customErrorHandler = true;
        const providedIn = stringOf(property(injectable?.arg, 'providedIn'));
        const node = this.add({
          id: this.id(kind, relative, className),
          kind,
          name: className,
          applicationId: this.app.id,
          file: relative,
          line,
          detail: { ...(providedIn ? { providedIn } : {}), style: 'class' },
        });
        this.injectables.add(className);
        this.analyzeClassBody(sf, statement, node, relative, text);
      } else if (directive) {
        const selector = stringOf(property(directive.arg, 'selector')) ?? '';
        const node = this.add({
          id: this.id('DIRECTIVE', relative, className),
          kind: 'DIRECTIVE',
          name: className,
          applicationId: this.app.id,
          file: relative,
          line,
          detail: { selector },
        });
        this.analyzeClassBody(sf, statement, node, relative, text);
      }
    }
  }

  /** Les membres d'une classe : handlers et cycle de vie, formulaires, flux, signals, appels HTTP et services injectés. */
  private analyzeClassBody(
    sf: ts.SourceFile,
    cls: ts.ClassDeclaration,
    owner: AngularNode,
    relative: string,
    text: string,
  ): void {
    const fields = new Map<string, string>();
    for (const member of cls.members) {
      if (ts.isConstructorDeclaration(member))
        for (const parameter of member.parameters) {
          const type = parameter.type?.getText();
          if (type && ts.getModifiers(parameter)?.length)
            fields.set(parameter.name.getText(), type.replace(/<.*$/, ''));
        }
      if (ts.isPropertyDeclaration(member)) {
        const name = member.name.getText();
        const type = member.type?.getText();
        const init = member.initializer?.getText() ?? '';
        const injected = /\binject\(\s*(\w+)/.exec(init)?.[1];
        if (injected) fields.set(name, injected);
        else if (type) fields.set(name, type.replace(/<.*$/, ''));
      }
    }
    this.serviceFields.set(owner.id, fields);
    const classText = cls.getText();
    const classStart = cls.getStart();
    const handlers = new Set<string>();
    for (const member of cls.members) {
      if (!ts.isMethodDeclaration(member) || !member.body) continue;
      const name = member.name.getText();
      const line = lineOf(sf, member.getStart());
      const body = member.body.getText();
      const lifecycle = LIFECYCLE.has(name);
      const kind: AngularNode['kind'] = lifecycle
        ? 'LIFECYCLE'
        : owner.kind === 'COMPONENT' || owner.kind === 'DIRECTIVE'
          ? 'HANDLER'
          : 'HANDLER';
      const node = this.add({
        id: this.id(kind, relative, `${owner.name}.${name}`),
        kind,
        name: `${owner.name}.${name}`,
        applicationId: this.app.id,
        file: relative,
        line,
        detail: {
          owner: owner.name,
          ...(/\bawait\b|\.then\s*\(|new Promise/.test(body) ? { promise: true } : {}),
          ...(/\btry\s*\{/.test(body) ? { tryCatch: true } : {}),
          ...(/catchError\s*\(/.test(body) ? { catchError: true } : {}),
          ...(/\.subscribe\s*\(/.test(body) ? { subscribes: true } : {}),
        },
      });
      handlers.add(name);
      this.link({
        from: owner.id,
        to: node.id,
        kind: 'HANDLES',
        status: 'STATICALLY_RESOLVED',
        file: relative,
        line,
      });
      // Appels HTTP directs.
      for (const match of body.matchAll(HTTP_CALL)) {
        const [, field, verb, , url] = match;
        const type = fields.get(field ?? '') ?? '';
        if (!/HttpClient/.test(type) && field !== 'http') continue;
        const callLine = lineAt(text, classStart + classText.indexOf(body) + match.index);
        const http = this.add({
          id: this.id('HTTP_CALL', relative, `${owner.name}.${name}#${verb}:${url}`),
          kind: 'HTTP_CALL',
          name: `${(verb ?? '').toUpperCase()} ${url ?? ''}`,
          applicationId: this.app.id,
          file: relative,
          line: callLine,
          detail: { method: (verb ?? '').toUpperCase(), url: url ?? '' },
        });
        this.link({
          from: node.id,
          to: http.id,
          kind: 'CALLS',
          status: /HttpClient/.test(type) ? 'STATICALLY_RESOLVED' : 'INFERRED',
          file: relative,
          line: callLine,
          text: match[0],
        });
        const api = this.add({
          id: `${this.app.id}:api:${(verb ?? '').toUpperCase()} ${url ?? ''}`,
          kind: 'API',
          name: `${(verb ?? '').toUpperCase()} ${url ?? ''}`,
          applicationId: this.app.id,
          file: relative,
          line: callLine,
        });
        this.link({
          from: http.id,
          to: api.id,
          kind: 'TARGETS',
          status: 'STATICALLY_RESOLVED',
          file: relative,
          line: callLine,
        });
      }
      // Flux : émissions et souscriptions.
      for (const match of body.matchAll(/\bthis\.(\w+)\.(next|error|complete|subscribe)\s*\(/g)) {
        const [, field, verb] = match;
        const streamId = this.id('STREAM', relative, `${owner.name}.${field ?? ''}`);
        if (!this.nodes.has(streamId)) continue;
        this.link({
          from: node.id,
          to: streamId,
          kind: verb === 'subscribe' ? 'SUBSCRIBES' : 'EMITS',
          status: 'STATICALLY_RESOLVED',
          file: relative,
          line,
          text: match[0],
        });
      }
      // Appels de services injectés (reliés une fois toutes les classes connues).
      this.pendingCalls.push({ from: node.id, ownerId: owner.id, body, file: relative, line });
    }
    this.handlersByComponent.set(owner.id, handlers);
    // Flux déclarés.
    for (const match of classText.matchAll(STREAM_DECL)) {
      const [, name, kind] = match;
      this.add({
        id: this.id('STREAM', relative, `${owner.name}.${name ?? ''}`),
        kind: 'STREAM',
        name: `${owner.name}.${name ?? ''}`,
        applicationId: this.app.id,
        file: relative,
        line: lineAt(text, classStart + match.index),
        detail: { type: kind ?? '', shared: owner.kind === 'SERVICE' },
      });
    }
    // Signals.
    for (const match of classText.matchAll(SIGNAL_DECL)) {
      const [, name, kind] = match;
      this.features.signals = true;
      this.add({
        id: this.id('SIGNAL', relative, `${owner.name}.${name ?? ''}`),
        kind: 'SIGNAL',
        name: `${owner.name}.${name ?? ''}`,
        applicationId: this.app.id,
        file: relative,
        line: lineAt(text, classStart + match.index),
        detail: { type: kind ?? '' },
      });
    }
    // Formulaires et contrôles.
    for (const match of classText.matchAll(FORM_DECL)) {
      const [, name] = match;
      const at = classStart + match.index;
      const form = this.add({
        id: this.id('FORM', relative, `${owner.name}.${name ?? ''}`),
        kind: 'FORM',
        name: `${owner.name}.${name ?? ''}`,
        applicationId: this.app.id,
        file: relative,
        line: lineAt(text, at),
        detail: { reactive: true },
      });
      this.features.reactiveForms = true;
      const declaration = classText.slice(match.index, match.index + 2000);
      const block = declaration.slice(0, blockEnd(declaration));
      for (const control of block.matchAll(CONTROL_KEYS)) {
        const key = control[1] ?? '';
        if (!key || key === name) continue;
        const node = this.add({
          id: this.id('CONTROL', relative, `${owner.name}.${name ?? ''}.${key}`),
          kind: 'CONTROL',
          name: key,
          applicationId: this.app.id,
          file: relative,
          line: lineAt(text, at + control.index),
          detail: {
            form: name ?? '',
            required: /Validators\.required/.test(
              block.slice(control.index, block.indexOf('\n', control.index) + 1 || undefined),
            ),
          },
        });
        this.link({
          from: form.id,
          to: node.id,
          kind: 'VALIDATES',
          status: 'STATICALLY_RESOLVED',
          file: relative,
          line: node.line,
        });
      }
      const validators = [...new Set([...block.matchAll(VALIDATOR)].map((item) => item[1] ?? ''))];
      if (validators.length > 0 || ASYNC_VALIDATOR.test(block)) {
        const validator = this.add({
          id: this.id('VALIDATOR', relative, `${owner.name}.${name ?? ''}`),
          kind: 'VALIDATOR',
          name: validators.join(', ') || 'validateur',
          applicationId: this.app.id,
          file: relative,
          line: lineAt(text, at),
          detail: { validators, async: ASYNC_VALIDATOR.test(block) },
        });
        this.link({
          from: form.id,
          to: validator.id,
          kind: 'VALIDATES',
          status: 'STATICALLY_RESOLVED',
          file: relative,
          line: validator.line,
        });
      }
    }
  }

  private readonly pendingCalls: {
    from: string;
    ownerId: string;
    body: string;
    file: string;
    line: number;
  }[] = [];

  /** Les appels `this.<champ>.<méthode>()` vers une classe injectable connue, résolus quand la méthode existe. */
  private linkServices(): void {
    const byName = new Map<string, AngularNode>();
    for (const node of this.nodes.values())
      if (node.kind !== 'HANDLER' && node.kind !== 'LIFECYCLE') byName.set(node.name, node);
    for (const pending of this.pendingCalls) {
      const fields = this.serviceFields.get(pending.ownerId) ?? new Map<string, string>();
      for (const match of pending.body.matchAll(SERVICE_CALL)) {
        const [, field, method] = match;
        const type = fields.get(field ?? '');
        if (!type || !this.injectables.has(type)) continue;
        const target = byName.get(type);
        if (!target) continue;
        const handlerId = this.id('HANDLER', target.file, `${type}.${method ?? ''}`);
        const resolved = this.nodes.has(handlerId);
        this.link({
          from: pending.from,
          to: resolved ? handlerId : target.id,
          kind: 'CALLS',
          status: resolved ? 'STATICALLY_RESOLVED' : 'INFERRED',
          file: pending.file,
          line: pending.line,
          text: match[0],
        });
      }
    }
  }

  private analyzeTemplate(
    componentId: string,
    template: { file: string; text: string; inline: boolean },
  ): void {
    const component = this.nodes.get(componentId);
    if (!component) return;
    const node = this.add({
      id: this.id('TEMPLATE', template.file, component.name),
      kind: 'TEMPLATE',
      name: template.inline ? `${component.name} (inline)` : template.file,
      applicationId: this.app.id,
      file: template.file,
      line: 1,
      detail: {
        inline: template.inline,
        controlFlow: /@if\s*\(|@for\s*\(/.test(template.text),
        ngModel: /\[\(ngModel\)\]/.test(template.text),
        formGroup: /\[formGroup\]|formControlName/.test(template.text),
      },
    });
    this.link({
      from: component.id,
      to: node.id,
      kind: 'BINDS',
      status: 'STATICALLY_RESOLVED',
      file: component.file,
      line: component.line,
    });
    if (/\[\(ngModel\)\]/.test(template.text)) this.features.templateForms = true;
    // Les liens de navigation (libellé visible) et les titres de l'écran : indices pour localiser un écran cible.
    for (const match of template.text.matchAll(NAV_ELEMENT)) {
      const target = linkTarget(match[2] ?? '');
      const label =
        visibleText(match[3] ?? '') || /aria-label\s*=\s*"([^"]*)"/.exec(match[2] ?? '')?.[1] || '';
      if (target && label)
        this.navigation.links.push({
          componentId,
          file: template.file,
          line: lineAt(template.text, match.index),
          target,
          label,
        });
    }
    for (const match of template.text.matchAll(HEADING)) {
      const text = visibleText(match[2] ?? '');
      if (text)
        this.navigation.headings.push({
          componentId,
          file: template.file,
          line: lineAt(template.text, match.index),
          text,
        });
    }
    const handlers = this.handlersByComponent.get(componentId) ?? new Set<string>();
    for (const match of template.text.matchAll(EVENT_BINDING)) {
      const [, event, expression] = match;
      const index = match.index;
      const context = template.text.slice(Math.max(0, index - 400), index);
      const tag = /<([\w-]+)[^<]*$/.exec(context)?.[1] ?? 'element';
      const after = template.text.slice(index, index + 400);
      const label =
        (/aria-label\s*=\s*"([^"]*)"/.exec(context + after)?.[1] ??
        /type\s*=\s*"submit"/.test(context + after))
          ? 'submit'
          : undefined;
      const textAfter = />([^<{]{1,60})</.exec(after)?.[1]?.trim();
      const name = `${tag}${label ? `[${label}]` : textAfter ? `:${textAfter}` : ''} (${event ?? ''})`;
      const line = lineAt(template.text, index);
      const binding = this.add({
        id: this.id('BINDING', template.file, `${component.name}#${String(line)}:${event ?? ''}`),
        kind: 'BINDING',
        name,
        applicationId: this.app.id,
        file: template.file,
        line,
        detail: {
          event: event ?? '',
          expression: expression ?? '',
          element: tag,
          ...(textAfter ? { text: textAfter } : {}),
        },
      });
      this.link({
        from: node.id,
        to: binding.id,
        kind: 'BINDS',
        status: 'STATICALLY_RESOLVED',
        file: template.file,
        line,
      });
      const method = /^\s*(\w+)\s*\(/.exec(expression ?? '')?.[1];
      if (method) {
        const handlerId = this.id('HANDLER', component.file, `${component.name}.${method}`);
        this.link({
          from: binding.id,
          to: handlers.has(method) ? handlerId : component.id,
          kind: 'HANDLES',
          status: handlers.has(method) ? 'STATICALLY_RESOLVED' : 'INFERRED',
          file: template.file,
          line,
          text: expression ?? '',
        });
      }
    }
    const disabled = [...template.text.matchAll(/\[disabled\]\s*=\s*"([^"]*)"/g)].map(
      (item) => item[1] ?? '',
    );
    if (disabled.length > 0) node.detail = { ...node.detail, disabledBindings: disabled.slice(0, 20) };
  }
}

function blockEnd(text: string): number {
  let depth = 0;
  let started = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '(' || ch === '{' || ch === '[') {
      depth += 1;
      started = true;
    } else if (ch === ')' || ch === '}' || ch === ']') {
      depth -= 1;
      if (started && depth <= 0) return i + 1;
    }
  }
  return text.length;
}

function describe(error: unknown): string {
  const decision = (error as { decision?: { reason?: string } } | undefined)?.decision;
  if (decision?.reason) return decision.reason;
  return error instanceof Error ? error.message : String(error);
}

export async function analyzeAngular(
  app: ScopeApplication,
  files: GuardedFiles,
  options: AngularAnalysisOptions = {},
): Promise<AngularModel> {
  return new AngularAnalyzer(app).analyze(files, options);
}

/** Les chemins de route lus dans le code d'une application (depuis les composants). */
export function routesOf(model: AngularModel): { path: string; componentId: string }[] {
  const out: { path: string; componentId: string }[] = [];
  for (const node of model.nodes) {
    if (node.kind !== 'COMPONENT') continue;
    const routes = node.detail?.routes;
    if (Array.isArray(routes)) for (const route of routes) out.push({ path: route, componentId: node.id });
  }
  return out;
}
