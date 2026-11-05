import { buildStaticGraph } from '../static-analysis/graph-builder.js';
import { sourceSetOf } from '../static-analysis/source-set.js';
import { loadTypeScript } from '../static-analysis/typescript-loader.js';
import { analyzeRxjs } from './analyze-rxjs.js';
import { analyzeTemplates, membersOf } from './analyze-template.js';
import type { ReadFile } from './files.js';
import type { UiCall, UiFacts, UiField, UiState } from './facts.js';

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
  const wrappers = new Set(rx.wrappers);
  const calls = [...direct.filter((call) => !wrappers.has(call.id)), ...rx.calls];
  // La structure des gabarits (conteneurs, boutons, conditions) et l'origine des états lus.
  const structure = analyzeTemplates(relevant, new Set(calls.map((call) => call.id)));
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
    diagnostics: rx.diagnostics,
    warnings: [...graph.warnings, ...structure.warnings, ...rx.warnings],
  };
}
