import path from 'node:path';
import { buildStaticGraph } from '../static-analysis/graph-builder.js';
import { sourceSetOf } from '../static-analysis/source-set.js';
import { loadTypeScript, type TypeScriptModule } from '../static-analysis/typescript-loader.js';
import { analyzeRxjs } from './analyze-rxjs.js';
import { analyzeTemplates, membersOf } from './analyze-template.js';
import { DEFAULT_VARIANT } from './config.js';
import type { ReadFile } from './files.js';
import { isDynamic, isRewrite, staticExport, type JsValue } from './static-js.js';
import type { UiCall, UiDiagnostic, UiFacts, UiField, UiState } from './facts.js';

/**
 * LE FRONTAL ANGULAR : l'analyse statique existante (AST TypeScript, gabarits) donne les routes, les
 * composants, les formulaires et leurs contrôles (validations, liaison au gabarit), les appels HTTP, les
 * DTO et les flux de données contrôle → propriété de requête → appel. Le libellé d'un champ est lu dans
 * son gabarit : `<label for>` relié à l'id de l'élément (sûr), sinon un libellé voisin ou `<mat-label>`
 * (probable), sinon le placeholder (probable). Rien n'est exécuté.
 */
const strip = (html: string): string =>
  html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\{\{[^}]*\}\}/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*[*:]\s*$/, '')
    .trim();

const attribute = (tag: string, name: string): string | undefined =>
  new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"|\\s${name}\\s*=\\s*'([^']*)'`, 'i')
    .exec(tag)
    ?.slice(1)
    // Un groupe facultatif absent vaut undefined à l'exécution.
    .find((value: string | undefined) => value !== undefined);

/** Le libellé d'un contrôle dans le texte d'un gabarit. */
export function labelOf(
  html: string,
  control: string,
): { label: string; how: NonNullable<UiField['labelHow']> } | undefined {
  const escaped = control.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const element = new RegExp(
    `<[a-zA-Z][\\w-]*[^>]*(?:formControlName\\s*=\\s*["']${escaped}["']|\\[formControl\\]\\s*=\\s*["'][^"']*\\.${escaped}["'])[^>]*>`,
  ).exec(html);
  if (!element) return undefined;
  const tag = element[0];
  const id = attribute(tag, 'id');
  if (id) {
    const forLabel = new RegExp(
      `<label[^>]*\\sfor\\s*=\\s*["']${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>([\\s\\S]*?)</label>`,
      'i',
    ).exec(html);
    const text = forLabel?.[1] ? strip(forLabel[1]) : '';
    if (text) return { label: text, how: 'for' };
  }
  // Le libellé voisin : le dernier <label> ou <mat-label> avant l'élément, sans autre contrôle entre eux.
  const before = html.slice(Math.max(0, element.index - 400), element.index);
  const labels = [...before.matchAll(/<(label|mat-label)\b[^>]*>([\s\S]*?)<\/\1>/gi)];
  const last = labels[labels.length - 1];
  if (last?.index !== undefined) {
    const between = before.slice(last.index + last[0].length);
    const text = strip(last[2] ?? '');
    if (text && !/formControlName|\[formControl\]/.test(between))
      return { label: text, how: last[1]?.toLowerCase() === 'mat-label' ? 'mat-label' : 'near' };
  }
  const placeholder = attribute(tag, 'placeholder');
  return placeholder ? { label: placeholder, how: 'placeholder' } : undefined;
}

export async function analyzeAngular(root: string, files: readonly ReadFile[]): Promise<UiFacts> {
  const ts = await loadTypeScript();
  const empty: UiFacts = {
    routes: [],
    components: [],
    fields: [],
    calls: [],
    flows: [],
    reads: [],
    dtos: [],
    warnings: [],
  };
  if (!ts) return { ...empty, warnings: ['the TypeScript parser is not installed: Angular not analyzed'] };
  const relevant = files.filter(
    (file) => /\.(ts|tsx|js|jsx|mjs|html)$/.test(file.path) || file.path.endsWith('package.json'),
  );
  const sources = sourceSetOf(
    root,
    relevant.map((file) => ({ path: file.path, text: file.text })),
  );
  const graph = buildStaticGraph(ts, sources, {
    applicationId: 'cartography',
    mode: 'SOURCE',
    features: {
      routes: true,
      forms: true,
      validators: true,
      dtoMapping: true,
      httpCalls: true,
      dataFlow: true,
      rules: false,
    },
    analyzers: { angular: true, genericJs: false },
    maxAstNodes: 2_000_000,
    maxDurationMs: 60_000,
  });
  const texts = new Map(files.map((file) => [file.path, file.text]));
  const fields: UiField[] = graph.fields.map((field) => {
    const template = field.templateBinding?.template ? texts.get(field.templateBinding.template) : undefined;
    const label = template ? labelOf(template, field.control) : undefined;
    return {
      id: field.id,
      component: field.component,
      control: field.control,
      ...(label ? { label: label.label, labelHow: label.how } : {}),
      ...(field.templateBinding?.tag ? { tag: field.templateBinding.tag } : {}),
      ...(field.templateBinding?.inputType ? { inputType: field.templateBinding.inputType } : {}),
      validators: field.validators.map((validator) =>
        validator.value !== undefined ? `${validator.kind}:${String(validator.value)}` : validator.kind,
      ),
      bound: field.templateBinding !== undefined,
      loc: field.location,
    };
  });
  const direct: UiCall[] = graph.apiCalls.map((call) => ({
    id: call.id,
    owner: call.owner,
    method: call.method,
    ...(call.route ? { path: call.route } : {}),
    ...(call.bodyType ? { bodyType: call.bodyType } : {}),
    loc: call.location,
  }));
  // Les stores et flux RxJS : appels indirects (store → service → client HTTP), émissions, souscriptions.
  const rx = analyzeRxjs(ts, relevant, new Map(direct.map((call) => [call.id, call])));
  // Une enveloppe (`ApiClient.post(url, body)`) n'est pas un appel : chacun de ses appelants en est un.
  // Une méthode générique aux appels HTTP distingués par branche : ses appels sont ceux de ses branches.
  const wrappers = new Set([...rx.wrappers, ...rx.branched]);
  const angular = angularVariants(files);
  const proxies = proxiesOf(ts, files, angular.proxyOf);
  const corrected = new Map(rx.bases.map((entry) => [entry.id, entry]));
  const calls = [...direct.filter((call) => !wrappers.has(call.id)), ...rx.calls].map((call) => {
    const fix = corrected.get(call.id);
    return fix && !call.base
      ? {
          ...call,
          path: fix.path,
          ...(fix.base ? { base: fix.base } : {}),
          ...(fix.baseKey ? { baseKey: fix.baseKey } : {}),
        }
      : call;
  });
  // La structure des gabarits (conteneurs, boutons, conditions) et l'origine des états lus.
  const structure = analyzeTemplates(relevant, new Set(calls.map((call) => call.id)));
  // Chaque élément interactif est relié à ce que son expression déclenche (méthode, ou méthode vue dans le
  // contexte des valeurs écrites dans le gabarit) ; une expression qui ne mène à rien de résolu est dite.
  const uiDiagnostics: UiDiagnostic[] = [];
  for (const el of structure.elements) {
    if (el.kind !== 'BUTTON' || !el.expression) continue;
    const hits = rx.entryOf(el.component, el.expression);
    const first = hits[0];
    if (first) {
      el.target = first.to;
      if (first.context) el.targetContext = first.context;
      if (first.unresolved)
        uiDiagnostics.push({
          from: first.method.replace('.', '#'),
          at: first.method.replace('.', '#'),
          code: 'CONTEXT_UNRESOLVED',
          message: `élément « ${el.name} » : ${first.unresolved}`,
          loc: el.loc,
        });
    } else if (!el.handler) {
      el.unresolved = `(${el.event ?? 'click'})="${el.expression}" ne désigne aucune méthode résolue du composant ni de ses services`;
      uiDiagnostics.push({
        from: el.component,
        at: el.id,
        code: 'UI_DYNAMIC',
        message: `élément « ${el.name} » : ${el.unresolved}`,
        loc: el.loc,
      });
    }
  }
  // Un membre lu par une condition qui est un flux (`canActivate$ | async`, `store.status$ | async`).
  const states: UiState[] = [...structure.states];
  for (const el of structure.elements)
    for (const cond of [el.visibleWhen, el.disabledWhen, el.tab?.selectedBy]) {
      if (!cond) continue;
      for (const m of membersOf(cond.expression)) {
        const stream = rx.streamOf(el.component, m.root, m.path);
        if (!stream) continue;
        const at = states.findIndex((st) => st.component === el.component && st.member === m.root);
        const state: UiState = {
          component: el.component,
          member: m.root,
          kind: 'STREAM',
          stream,
          loc: cond.loc,
        };
        if (at >= 0) states[at] = state;
        else states.push(state);
      }
    }
  return {
    routes: graph.routes.map((route) => ({
      path: route.path,
      ...(route.component ? { component: route.component } : {}),
      loc: route.location,
    })),
    components: graph.components.map((component) => ({
      name: component.name,
      ...(component.selector ? { selector: component.selector } : {}),
      loc: component.location,
    })),
    fields,
    calls,
    flows: graph.dataFlows.map((flow) => ({
      ...(flow.field ? { field: flow.field } : {}),
      ...(flow.requestProperty ? { requestProperty: flow.requestProperty } : {}),
      ...(flow.dtoProperty ? { dtoProperty: flow.dtoProperty } : {}),
      ...(flow.apiCall ? { call: flow.apiCall } : {}),
      resolved: flow.status === 'RESOLVED',
      ...(flow.reason ? { reason: flow.reason } : {}),
      loc: flow.location,
    })),
    reads: (graph.valueSources ?? [])
      .filter((source) => source.origin === 'API_RESPONSE')
      .map((source) => ({
        ...(source.field ? { field: source.field } : {}),
        ...(source.apiCall ? { call: source.apiCall } : {}),
        ...(source.responseProperty ? { responseProperty: source.responseProperty } : {}),
        loc: source.location,
      })),
    dtos: graph.dtos.map((dto) => ({ name: dto.name, properties: dto.properties, loc: dto.location })),
    elements: structure.elements,
    children: structure.children,
    states,
    handlers: structure.handlers,
    symbols: rx.symbols,
    links: rx.links,
    diagnostics: [...rx.diagnostics, ...uiDiagnostics],
    ...(proxies.length ? { proxies } : {}),
    ...(angular.variants.length ? { variants: angular.variants } : {}),
    ...(rx.environment.length ? { environment: rx.environment } : {}),
    warnings: [...graph.warnings, ...structure.warnings, ...rx.warnings],
  };
}

/** Les configurations d'angular.json : remplacements des fichiers environment, fichier de proxy. */
function angularVariants(files: readonly ReadFile[]): {
  variants: NonNullable<UiFacts['variants']>;
  proxyOf: Map<string, string[]>;
} {
  const variants: NonNullable<UiFacts['variants']> = [];
  const proxyOf = new Map<string, string[]>();
  const use = (file: string, variant: string): void => {
    const key = path.posix.normalize(file).replace(/^\.\//, '');
    proxyOf.set(key, [...(proxyOf.get(key) ?? []), variant]);
  };
  for (const file of files.filter((f) => /(^|\/)angular\.json$/.test(f.path))) {
    let doc: unknown;
    try {
      doc = JSON.parse(file.text);
    } catch {
      continue;
    }
    const projects = (doc as { projects?: Record<string, unknown> }).projects ?? {};
    for (const project of Object.values(projects)) {
      const architect =
        (
          project as {
            architect?: Record<
              string,
              { options?: Record<string, unknown>; configurations?: Record<string, Record<string, unknown>> }
            >;
          }
        ).architect ?? {};
      const serve = architect.serve;
      if (typeof serve?.options?.proxyConfig === 'string') use(serve.options.proxyConfig, DEFAULT_VARIANT);
      const names = new Set([
        ...Object.keys(architect.build?.configurations ?? {}),
        ...Object.keys(serve?.configurations ?? {}),
      ]);
      for (const name of names) {
        const build = architect.build?.configurations?.[name] ?? {};
        const own = serve?.configurations?.[name] ?? {};
        const replacements = (
          Array.isArray(build.fileReplacements) ? (build.fileReplacements as unknown[]) : []
        ).flatMap((r) =>
          r &&
          typeof r === 'object' &&
          typeof (r as { replace?: unknown }).replace === 'string' &&
          typeof (r as { with?: unknown }).with === 'string'
            ? [{ replace: (r as { replace: string }).replace, with: (r as { with: string }).with }]
            : [],
        );
        const proxyConfig = typeof own.proxyConfig === 'string' ? own.proxyConfig : undefined;
        if (proxyConfig) use(proxyConfig, name);
        if (replacements.length || proxyConfig)
          variants.push({ name, replacements, ...(proxyConfig ? { proxyConfig } : {}) });
      }
    }
  }
  return { variants, proxyOf };
}

/**
 * Les règles des proxys de développement : proxy.conf.json, et proxy.conf.js/.cjs/.mjs évalués par leur
 * arbre syntaxique (jamais exécutés). Objet par préfixe ou tableau de règles `context`. Une cible ou une
 * réécriture non interprétable reste notée comme dynamique, jamais devinée.
 */
function proxiesOf(
  ts: TypeScriptModule,
  files: readonly ReadFile[],
  proxyOf: ReadonlyMap<string, string[]>,
): NonNullable<UiFacts['proxies']> {
  const out: NonNullable<UiFacts['proxies']> = [];
  for (const file of files.filter((f) => /(^|\/)proxy[\w.-]*\.(json|c?js|mjs)$/.test(f.path))) {
    let doc: JsValue | undefined;
    if (/\.json$/.test(file.path))
      try {
        doc = JSON.parse(file.text) as JsValue;
      } catch {
        continue;
      }
    else doc = staticExport(ts, file.path, file.text);
    if (doc === undefined) continue;
    const variants = proxyOf.get(file.path) ?? [undefined];
    const rules: { contexts: string[]; rule: Record<string, JsValue>; dynamic?: string }[] = [];
    if (isDynamic(doc)) rules.push({ contexts: ['/'], rule: {}, dynamic: `configuration ${doc.dynamic}` });
    else if (Array.isArray(doc)) {
      for (const r of doc)
        if (r && typeof r === 'object' && !Array.isArray(r) && !isDynamic(r) && !isRewrite(r)) {
          const ctx = (r as Record<string, JsValue>).context;
          rules.push({
            contexts: (Array.isArray(ctx) ? ctx : [ctx]).filter((c): c is string => typeof c === 'string'),
            rule: r,
            ...(isDynamic(ctx) ? { dynamic: `context = ${ctx.dynamic}` } : {}),
          });
        }
    } else if (doc && typeof doc === 'object' && !isRewrite(doc)) {
      for (const [context, r] of Object.entries(doc))
        if (r && typeof r === 'object' && !Array.isArray(r) && !isDynamic(r) && !isRewrite(r))
          rules.push({ contexts: [context], rule: r });
        else if (isDynamic(r)) rules.push({ contexts: [context], rule: {}, dynamic: `règle ${r.dynamic}` });
    }
    for (const { contexts, rule, dynamic } of rules)
      for (const raw of contexts) {
        const context = raw.replace(/\/\*+$/, '') || '/';
        const notes: string[] = dynamic ? [dynamic] : [];
        const target = rule.target;
        if (isDynamic(target)) notes.push(`target = ${target.dynamic}`);
        let rewrite: { pattern: string; replacement: string } | undefined;
        const pr = rule.pathRewrite ?? rule.rewrite;
        if (isRewrite(pr)) rewrite = pr.rewrite;
        else if (isDynamic(pr)) notes.push(`réécriture = ${pr.dynamic}`);
        else if (pr && typeof pr === 'object' && !Array.isArray(pr)) {
          const first = Object.entries(pr).find(([k, v]) => typeof v === 'string' && k.length <= 200);
          if (first) rewrite = { pattern: first[0], replacement: first[1] as string };
          else if (Object.keys(pr).length) notes.push('réécriture non interprétable');
        }
        if (isDynamic(rule.bypass)) notes.push(`bypass = ${rule.bypass.dynamic}`);
        const at = file.text.indexOf(raw);
        for (const variant of variants)
          out.push({
            context,
            ...(typeof target === 'string' ? { target } : {}),
            ...(rewrite ? { rewrite } : {}),
            file: file.path,
            line: at < 0 ? 1 : file.text.slice(0, at).split('\n').length,
            ...(variant ? { variant } : {}),
            ...(notes.length ? { dynamic: notes.join(' ; ') } : {}),
            ...(typeof rule.secure === 'boolean' ? { secure: rule.secure } : {}),
            ...(typeof rule.changeOrigin === 'boolean' ? { changeOrigin: rule.changeOrigin } : {}),
          });
      }
  }
  return out;
}
