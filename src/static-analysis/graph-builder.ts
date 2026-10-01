import path from 'node:path';
import {
  STATIC_ANALYZER_VERSION,
  type StaticAnalysisMode,
  type StaticApiCallNode,
  type StaticApplicationGraph,
  type StaticComponentNode,
  type StaticCoverage,
  type StaticDataFlow,
  type StaticDtoNode,
  type StaticFieldNode,
  type StaticFormNode,
  type StaticFramework,
  type StaticNavigationEdge,
  type StaticRouteNode,
  type HttpMethod,
  type StaticFunctionalFacts,
  type StaticValueSource,
} from './model.js';
import { sanitizeGraph } from './sanitize.js';
import type { SourceSet } from './source-set.js';
import { buildRules, type RuleBuildComponent, type TemplateAction } from './rules/rule-builder.js';
import type { ApplicationRule } from './rules/rule-model.js';
import { scanTemplateRules, type TemplateRuleFacts } from './rules/template-rules.js';
import { scanTemplate, type TemplateFacts } from './template-scanner.js';
import {
  AstBudgetExceeded,
  extractFacts,
  type ClassFact,
  type FileFacts,
  type MethodFact,
  type RequestObjectFact,
  type RouteArrayFact,
  type RouteLiteral,
  type ValueExpressionFact,
} from './ts-facts.js';
import type { TypeScriptModule } from './typescript-loader.js';

export interface StaticAnalysisFeatures {
  routes: boolean;
  forms: boolean;
  validators: boolean;
  dtoMapping: boolean;
  httpCalls: boolean;
  dataFlow: boolean;
  /** Règles candidates (gabarits et code) ; absent : true. */
  rules?: boolean;
}

export interface GraphBuildOptions {
  applicationId: string;
  mode: StaticAnalysisMode;
  version?: string;
  commit?: string;
  features: StaticAnalysisFeatures;
  analyzers: { angular: boolean; genericJs: boolean };
  maxAstNodes: number;
  maxDurationMs: number;
  now?: () => number;
}

/**
 * DÉTECTION DU FRAMEWORK, par signaux déterministes : dépendances du package.json,
 * puis imports des sources. Aucune classification probabiliste.
 */
export function detectFramework(sources: SourceSet): StaticFramework {
  const manifest = sources.files.find(
    (file) => file.path === 'package.json' || file.path.endsWith('/package.json'),
  );
  if (manifest) {
    try {
      const json = JSON.parse(manifest.text) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const deps = { ...json.dependencies, ...json.devDependencies };
      if (deps['@angular/core']) return 'ANGULAR';
      if (deps.react) return 'REACT';
      if (deps.vue) return 'VUE';
    } catch {
      // package.json illisible : les imports décident
    }
  }
  const code = sources.files.filter((file) => /\.(ts|tsx|js|jsx|mjs)$/.test(file.path));
  if (code.some((file) => file.text.includes('@angular/core'))) return 'ANGULAR';
  if (code.some((file) => /from ['"]react['"]/.test(file.text))) return 'REACT';
  if (code.some((file) => /from ['"]vue['"]/.test(file.text))) return 'VUE';
  return code.length > 0 ? 'GENERIC' : 'UNKNOWN';
}

/**
 * STATIC APPLICATION GRAPH : relie les faits de chaque fichier — routes (et leurs
 * enfants chargés à la demande), composants et gabarits, formulaires, services,
 * appels HTTP, DTO, flux de données — en un graphe. Toute connaissance y est
 * STATIC_DISCOVERED : seule l'exploration la confirme.
 */
export function buildStaticGraph(
  ts: TypeScriptModule,
  sources: SourceSet,
  options: GraphBuildOptions,
): StaticApplicationGraph {
  const now = options.now ?? Date.now;
  const started = now();
  const framework = detectFramework(sources);
  const angular = framework === 'ANGULAR' && options.analyzers.angular;
  const warnings: string[] = [];
  if (sources.budgetExhausted)
    warnings.push(`STATIC_ANALYSIS_BUDGET_EXHAUSTED: ${String(sources.skipped.length)} file(s) not read`);
  warnings.push(...(sources.notes ?? []));
  if (!angular && !options.analyzers.genericJs)
    return emptyGraph(
      options,
      sources,
      framework,
      'UNAVAILABLE',
      ['no analyzer enabled for this framework'],
      started,
      now,
    );

  // ---- faits de chaque fichier
  const budget = { remaining: options.maxAstNodes };
  const facts: FileFacts[] = [];
  const templates = new Map<string, TemplateFacts>();
  const templateRules = new Map<string, TemplateRuleFacts>();
  let exhausted = false;
  for (const file of sources.files) {
    if (now() - started > options.maxDurationMs) {
      warnings.push('STATIC_ANALYSIS_BUDGET_EXHAUSTED: time budget');
      exhausted = true;
      break;
    }
    if (file.path.endsWith('.html')) {
      if (angular) {
        templates.set(file.path, scanTemplate(file.text));
        if (options.features.rules !== false) templateRules.set(file.path, scanTemplateRules(file.text));
      }
      continue;
    }
    if (!/\.(ts|tsx|js|jsx|mjs)$/.test(file.path)) continue;
    try {
      facts.push(extractFacts(ts, file.path, file.text, budget));
    } catch (error) {
      if (error instanceof AstBudgetExceeded) {
        warnings.push(error.message);
        exhausted = true;
        break;
      }
      warnings.push(`${file.path}: not parsed`);
    }
  }

  const classes = new Map<string, { fact: ClassFact; file: string }>();
  for (const fileFacts of facts)
    for (const fact of fileFacts.classes)
      if (!classes.has(fact.name)) classes.set(fact.name, { fact, file: fileFacts.file });

  // ---- routes
  const routes = options.features.routes && angular ? flattenRoutes(facts) : [];

  // ---- composants et gabarits
  const components: StaticComponentNode[] = [];
  const componentTemplates = new Map<string, { facts: TemplateFacts; name: string }>();
  const ruleComponents: RuleBuildComponent[] = [];
  if (angular)
    for (const [name, { fact, file }] of classes) {
      if (fact.decorator !== 'Component') continue;
      let template: string | undefined;
      if (fact.templateUrl) {
        template = path.posix.normalize(path.posix.join(path.posix.dirname(file), fact.templateUrl));
        const scanned = templates.get(template);
        if (scanned) componentTemplates.set(name, { facts: scanned, name: template });
      } else if (fact.inlineTemplate) {
        template = 'inline';
        componentTemplates.set(name, {
          facts: scanTemplate(fact.inlineTemplate.text),
          name: `${file} (inline)`,
        });
      }
      if (options.features.rules !== false) {
        const rulesOfTemplate = template
          ? template === 'inline'
            ? fact.inlineTemplate
              ? scanTemplateRules(fact.inlineTemplate.text)
              : undefined
            : templateRules.get(template)
          : undefined;
        ruleComponents.push({
          name,
          file,
          fact,
          ...(rulesOfTemplate
            ? {
                template: {
                  rules: rulesOfTemplate,
                  name: template === 'inline' ? `${file} (inline)` : (template ?? ''),
                },
              }
            : {}),
        });
      }
      components.push({
        name,
        ...(fact.selector ? { selector: fact.selector } : {}),
        ...(template ? { template } : {}),
        injected: fact.injected,
        location: { file, line: fact.line },
      });
    }

  // ---- formulaires et champs
  const forms: StaticFormNode[] = [];
  const fields: StaticFieldNode[] = [];
  if (angular && options.features.forms)
    for (const [name, { fact, file }] of classes)
      for (const form of fact.forms) {
        const formId = `${name}#${form.property}`;
        forms.push({
          id: formId,
          component: name,
          property: form.property,
          controls: form.controls.map((control) => control.name),
          location: { file, line: form.line },
        });
        const template = componentTemplates.get(name);
        for (const control of form.controls) {
          const binding = template?.facts.controls.find((entry) => entry.control === control.name);
          fields.push({
            id: `${formId}.${control.name}`,
            form: formId,
            component: name,
            control: control.name,
            validators: options.features.validators ? control.validators : [],
            ...(binding
              ? {
                  templateBinding: {
                    tag: binding.tag,
                    ...(binding.inputType ? { inputType: binding.inputType } : {}),
                    template: template?.name ?? '',
                  },
                }
              : {}),
            location: { file, line: control.line },
          });
        }
      }

  // ---- valeurs initiales et affectations des contrôles (provenance des valeurs)
  const valueSources: StaticValueSource[] =
    angular && options.features.forms ? valueSourcesOf(classes, forms) : [];

  // ---- règles candidates (gabarits + code), toujours STATIC_DISCOVERED
  const ruleResult =
    angular && options.features.rules !== false ? buildRules(ts, ruleComponents, classes, forms) : undefined;
  const rules: ApplicationRule[] = ruleResult?.rules ?? [];

  // ---- faits pour l'intelligence fonctionnelle (même passage, mêmes faits)
  const functionalFacts: StaticFunctionalFacts | undefined =
    options.features.rules !== false
      ? functionalFactsOf(facts, classes, ruleResult?.actions ?? [])
      : undefined;

  // ---- DTO
  const dtos: StaticDtoNode[] = options.features.dtoMapping
    ? facts.flatMap((fileFacts) =>
        fileFacts.dtos.map((dto) => ({
          name: dto.name,
          properties: dto.properties,
          location: { file: fileFacts.file, line: dto.line },
        })),
      )
    : [];
  const dtoByName = new Map(dtos.map((dto) => [dto.name, dto]));

  // ---- appels HTTP (service#méthode)
  const apiCalls: StaticApiCallNode[] = [];
  if (options.features.httpCalls)
    for (const [name, { fact, file }] of classes)
      for (const method of fact.methods)
        for (const call of method.httpCalls) {
          const parameter = call.body ? method.params.find((param) => param.name === call.body) : undefined;
          const request = call.body
            ? method.requests.find((entry) => entry.variable === call.body)
            : undefined;
          const bodyType = parameter?.type ?? request?.type;
          apiCalls.push({
            id: `${name}#${method.name}`,
            owner: name,
            method: call.method,
            route: call.route,
            ...(call.body ? { bodyParameter: call.body } : {}),
            ...(bodyType ? { bodyType } : {}),
            ...(call.responseType ? { responseType: call.responseType } : {}),
            location: { file, line: call.line },
          });
        }

  // ---- navigations (code et gabarits)
  const navigation: StaticNavigationEdge[] = [];
  if (angular && options.features.routes) {
    for (const [name, { fact, file }] of classes)
      for (const method of fact.methods)
        for (const target of method.navigations)
          navigation.push({
            fromComponent: name,
            target: target.target,
            evidence: 'ROUTER_NAVIGATION',
            location: { file, line: target.line },
          });
    for (const [name, template] of componentTemplates)
      for (const link of template.facts.links)
        navigation.push({
          fromComponent: name,
          target: link.target,
          evidence: 'ROUTER_LINK',
          location: { file: template.name, line: link.line },
        });
  }

  // ---- flux de données : contrôle → objet de requête → DTO → appel HTTP
  const dataFlows: StaticDataFlow[] = [];
  if (options.features.dataFlow && options.features.httpCalls)
    for (const [name, { fact, file }] of classes)
      for (const method of fact.methods)
        dataFlows.push(
          ...flowsOf(name, fact, method, file, classes, dtoByName, forms, options.features.dtoMapping),
        );
  for (const flow of dataFlows)
    if (flow.status === 'UNRESOLVED_DATA_FLOW') warnings.push(`UNRESOLVED_DATA_FLOW: ${flow.reason ?? ''}`);

  const coverage: StaticCoverage =
    options.mode === 'BUNDLE'
      ? 'LIMITED'
      : exhausted || sources.budgetExhausted || warnings.length > 0
        ? 'PARTIAL'
        : 'FULL';
  return sanitizeGraph({
    applicationId: options.applicationId,
    ...(options.version ? { version: options.version } : {}),
    ...(options.commit ? { commit: options.commit } : {}),
    sourceHash: sources.hash,
    analyzerVersion: STATIC_ANALYZER_VERSION,
    framework,
    mode: options.mode,
    coverage,
    routes,
    components,
    forms,
    fields,
    apiCalls,
    dtos,
    navigation,
    dataFlows,
    ...(valueSources.length > 0 ? { valueSources } : {}),
    ...(rules.length > 0 ? { rules } : {}),
    ...(functionalFacts &&
    (functionalFacts.enums.length > 0 ||
      functionalFacts.writes.length > 0 ||
      functionalFacts.guards.length > 0)
      ? { functionalFacts }
      : {}),
    ...(ruleResult && ruleResult.technical.length > 0
      ? {
          technicalConditions: ruleResult.technical
            .slice(0, 20)
            .map((entry) => ({ component: entry.component, text: entry.text, location: entry.location })),
        }
      : {}),
    warnings: [...new Set(warnings)].slice(0, 50),
    stats: { files: sources.files.length, bytes: sources.bytes, durationMs: now() - started },
    ...(sources.provenance ? { sources: sources.provenance } : {}),
    generatedAt: new Date().toISOString(),
  });
}

function emptyGraph(
  options: GraphBuildOptions,
  sources: SourceSet,
  framework: StaticFramework,
  coverage: StaticCoverage,
  warnings: string[],
  started: number,
  now: () => number,
): StaticApplicationGraph {
  return {
    applicationId: options.applicationId,
    sourceHash: sources.hash,
    analyzerVersion: STATIC_ANALYZER_VERSION,
    framework,
    mode: options.mode,
    coverage,
    routes: [],
    components: [],
    forms: [],
    fields: [],
    apiCalls: [],
    dtos: [],
    navigation: [],
    dataFlows: [],
    warnings,
    stats: { files: sources.files.length, bytes: sources.bytes, durationMs: now() - started },
    generatedAt: new Date().toISOString(),
  };
}

/** Les routes à plat, chemins complets ; un tableau chargé à la demande prend le chemin de sa route parente. */
function flattenRoutes(facts: readonly FileFacts[]): StaticRouteNode[] {
  const arraysByFile = new Map<string, { file: string; array: RouteArrayFact }[]>();
  for (const fileFacts of facts)
    for (const array of fileFacts.routeArrays) {
      const key = fileFacts.file.replace(/\.(ts|tsx|js|jsx|mjs)$/, '');
      arraysByFile.set(key, [...(arraysByFile.get(key) ?? []), { file: fileFacts.file, array }]);
    }
  const lazyTargets = new Set<RouteArrayFact>();
  const resolveLazy = (file: string, specifier: string, exportName?: string): RouteArrayFact | undefined => {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
    const candidates = arraysByFile.get(target) ?? arraysByFile.get(`${target}/index`) ?? [];
    const found =
      candidates.find((candidate) => exportName && candidate.array.variable === exportName) ?? candidates[0];
    return found?.array;
  };
  // Premier passage : les tableaux chargés à la demande ne sont pas des racines.
  const visitLazy = (file: string, routes: readonly RouteLiteral[]): void => {
    for (const route of routes) {
      if (route.lazy) {
        const array = resolveLazy(file, route.lazy.specifier, route.lazy.exportName);
        if (array) lazyTargets.add(array);
      }
      visitLazy(file, route.children);
    }
  };
  for (const fileFacts of facts)
    for (const array of fileFacts.routeArrays) visitLazy(fileFacts.file, array.routes);

  const nodes: StaticRouteNode[] = [];
  const seen = new Set<RouteArrayFact>();
  const add = (file: string, routes: readonly RouteLiteral[], parent: string, depth: number): void => {
    if (depth > 10) return;
    for (const route of routes) {
      const full = joinPath(parent, route.path);
      nodes.push({
        path: full,
        segment: route.path,
        ...(route.component ? { component: route.component } : {}),
        ...(route.redirectTo !== undefined ? { redirectTo: route.redirectTo } : {}),
        ...(route.lazy ? { lazy: route.lazy.specifier } : {}),
        guards: route.guards,
        parameters: route.path
          .split('/')
          .filter((segment) => segment.startsWith(':'))
          .map((segment) => segment.slice(1)),
        ...(parent !== '/' || route.path !== '' ? { parent } : {}),
        truth: 'STATIC_DISCOVERED',
        location: { file, line: route.line },
      });
      add(file, route.children, full, depth + 1);
      if (route.lazy) {
        const array = resolveLazy(file, route.lazy.specifier, route.lazy.exportName);
        const target = [...arraysByFile.values()].flat().find((entry) => entry.array === array);
        if (array && target && !seen.has(array)) {
          seen.add(array);
          add(target.file, array.routes, full, depth + 1);
        }
      }
    }
  };
  for (const fileFacts of facts)
    for (const array of fileFacts.routeArrays)
      if (!lazyTargets.has(array)) add(fileFacts.file, array.routes, '/', 0);
  // Une même route vue deux fois (redirections vides) : la première suffit.
  const unique = new Map<string, StaticRouteNode>();
  for (const node of nodes)
    if (!unique.has(`${node.path}|${node.component ?? ''}`))
      unique.set(`${node.path}|${node.component ?? ''}`, node);
  return [...unique.values()];
}

/** Service#méthode et « GET /api/profile » d'un appel dont la réponse est lue (un niveau de service). */
export function apiOfSource(
  fact: ClassFact,
  owner: string,
  source: NonNullable<ValueExpressionFact['source']>,
  classes: Map<string, { fact: ClassFact; file: string }>,
  method?: string,
): { apiCall?: string; apiRoute?: string } {
  if (source.httpMethod)
    return {
      apiCall: `${owner}#${method ?? source.method}`,
      ...(source.route !== undefined ? { apiRoute: `${source.httpMethod} ${source.route}` } : {}),
    };
  const type = fact.injected[source.target];
  const service = type ? classes.get(type) : undefined;
  const serviceMethod = service?.fact.methods.find((entry) => entry.name === source.method);
  const http = serviceMethod?.httpCalls[0];
  if (!type || !serviceMethod) return {};
  return {
    apiCall: `${type}#${serviceMethod.name}`,
    ...(http ? { apiRoute: `${http.method} ${http.route}` } : {}),
  };
}

/**
 * Les sources de valeur de chaque contrôle : son initialiseur (country: ['Canada'] →
 * FORM_DEFAULT), et ses affectations — patchValue({ email: profile.email }) dans le
 * subscribe d'un GET → API_RESPONSE, avec l'appel et la propriété de la réponse.
 */
function valueSourcesOf(
  classes: Map<string, { fact: ClassFact; file: string }>,
  forms: readonly StaticFormNode[],
): StaticValueSource[] {
  const sources: StaticValueSource[] = [];
  for (const [name, { fact, file }] of classes) {
    for (const form of fact.forms)
      for (const control of form.controls) {
        const initial = control.initial;
        if (!initial) continue;
        sources.push({
          field: `${name}#${form.property}.${control.name}`,
          component: name,
          control: control.name,
          kind: 'INITIALIZER',
          origin:
            initial.kind === 'EMPTY'
              ? 'EMPTY'
              : initial.kind === 'LITERAL'
                ? 'FORM_DEFAULT'
                : 'STATIC_INITIALIZER',
          ...(initial.value !== undefined ? { literal: initial.value } : {}),
          ...(initial.expression ? { expression: initial.expression } : {}),
          location: { file, line: control.line },
        });
      }
    const state = new Map<string, ValueExpressionFact>();
    for (const method of fact.methods)
      for (const assignment of method.stateAssignments) state.set(assignment.property, assignment.value);
    const controlsOf = (form: string | undefined): string[] =>
      forms.find((entry) => entry.component === name && entry.property === form)?.controls ?? [];
    for (const method of fact.methods)
      for (const assignment of method.valueAssignments) {
        let value = assignment.value;
        // this.profile.country, profile venant d'une réponse : la réponse, propriété country.
        if (value.kind === 'STATE' && value.stateProperty && state.get(value.stateProperty)?.source) {
          const origin = state.get(value.stateProperty);
          value = {
            kind: 'RESPONSE',
            ...(origin?.source ? { source: origin.source } : {}),
            ...(value.property ? { property: value.property } : {}),
            expression: value.expression,
          };
        }
        const targets = assignment.control === '*' ? controlsOf(assignment.form) : [assignment.control];
        for (const control of targets) {
          const api =
            value.kind === 'RESPONSE' && value.source
              ? apiOfSource(fact, name, value.source, classes, method.name)
              : {};
          const property =
            assignment.control === '*' ? [value.property, control].filter(Boolean).join('.') : value.property;
          sources.push({
            ...(assignment.form ? { field: `${name}#${assignment.form}.${control}` } : {}),
            component: name,
            control,
            kind: assignment.kind,
            origin:
              value.kind === 'LITERAL'
                ? 'STATIC_INITIALIZER'
                : value.kind === 'RESPONSE'
                  ? 'API_RESPONSE'
                  : value.kind === 'CALCULATION'
                    ? 'DERIVED'
                    : 'COMPONENT_STATE',
            ...(value.literal !== undefined ? { literal: value.literal } : {}),
            expression: value.expression,
            ...api,
            ...(value.kind === 'RESPONSE' && property
              ? { responseProperty: property.split('.').pop() ?? property }
              : {}),
            ...(value.inputs ? { inputs: value.inputs } : {}),
            location: { file, line: assignment.line },
          });
        }
      }
  }
  return sources;
}

/** Enums, écritures et leurs appelants, gardes, gestionnaires d'erreur, boutons → méthodes. */
function functionalFactsOf(
  facts: readonly FileFacts[],
  classes: Map<string, { fact: ClassFact; file: string }>,
  actions: TemplateAction[],
): StaticFunctionalFacts {
  const enums = facts.flatMap((fileFacts) =>
    (fileFacts.enums ?? []).map((entry) => ({
      name: entry.name,
      members: entry.members,
      location: { file: fileFacts.file, line: entry.line },
    })),
  );
  const writes: StaticFunctionalFacts['writes'] = [];
  for (const [name, { fact, file }] of classes)
    for (const method of fact.methods)
      for (const call of method.httpCalls) {
        if (call.method === 'GET') continue;
        const callers: { component: string; method: string }[] = [];
        for (const [callerName, caller] of classes)
          for (const callerMethod of caller.fact.methods)
            if (
              callerMethod.serviceCalls.some(
                (serviceCall) =>
                  caller.fact.injected[serviceCall.target] === name && serviceCall.method === method.name,
              )
            )
              callers.push({ component: callerName, method: callerMethod.name });
        if (fact.decorator === 'Component') callers.push({ component: name, method: method.name });
        writes.push({
          apiCall: `${name}#${method.name}`,
          owner: name,
          method: method.name,
          httpMethod: call.method,
          route: call.route,
          literals: call.bodyLiterals ?? {},
          callers,
          location: { file, line: call.line },
        });
      }
  const guards: StaticFunctionalFacts['guards'] = [];
  const errorHandlers: StaticFunctionalFacts['errorHandlers'] = [];
  for (const [name, { fact, file }] of classes) {
    for (const entry of fact.rules.technical)
      if (entry.exit && entry.exit !== 'NONE')
        guards.push({
          owner: name,
          method: entry.method,
          text: entry.text,
          ...(entry.condition ? { condition: entry.condition } : {}),
          exit: entry.exit,
          location: { file, line: entry.line },
        });
    for (const handler of fact.rules.errorHandlers ?? []) {
      const api = apiOfSource(
        fact,
        name,
        {
          target: handler.origin.target,
          method: handler.origin.method,
          ...(handler.origin.route !== undefined ? { route: handler.origin.route } : {}),
          ...(handler.origin.httpMethod ? { httpMethod: handler.origin.httpMethod as HttpMethod } : {}),
        },
        classes,
      );
      errorHandlers.push({
        owner: name,
        method: handler.method,
        ...(api.apiRoute ? { apiRoute: api.apiRoute } : {}),
        ...(handler.status !== undefined ? { status: handler.status } : {}),
        ...(handler.code ? { code: handler.code } : {}),
        ...(handler.control ? { control: handler.control } : {}),
        ...(handler.message ? { message: handler.message } : {}),
        location: { file, line: handler.line },
      });
    }
  }
  return { enums, writes, guards, errorHandlers, actions };
}

export function joinPath(parent: string, segment: string): string {
  const joined = `${parent.replace(/\/$/, '')}/${segment}`.replace(/\/{2,}/g, '/');
  return joined.length > 1 ? joined.replace(/\/$/, '') : '/';
}

/**
 * Les flux d'une méthode : chaque objet de requête construit depuis un formulaire,
 * passé à un service (un niveau) ou directement à HttpClient.
 */
function flowsOf(
  component: string,
  fact: ClassFact,
  method: MethodFact,
  file: string,
  classes: Map<string, { fact: ClassFact; file: string }>,
  dtos: Map<string, StaticDtoNode>,
  forms: readonly StaticFormNode[],
  dtoMapping: boolean,
): StaticDataFlow[] {
  const flows: StaticDataFlow[] = [];
  const formControls = (form: string): string[] =>
    forms.find((entry) => entry.component === component && entry.property === form)?.controls ?? [];
  const fieldId = (form: string, control: string): string => `${component}#${form}.${control}`;

  const emit = (
    request: RequestObjectFact,
    apiCall: string,
    bodyType: string | undefined,
    variable: string,
  ): void => {
    const dto = bodyType ? dtos.get(bodyType.replace(/\[\]$/, '')) : undefined;
    const pairs = [
      ...request.mappings.map((mapping) => ({
        property: mapping.property,
        form: mapping.form,
        control: mapping.control,
      })),
      ...request.spreadForms.flatMap((form) =>
        formControls(form).map((control) => ({ property: control, form, control })),
      ),
    ];
    for (const pair of pairs) {
      const dtoProperty =
        dtoMapping && dto?.properties.some((property) => property.name === pair.property)
          ? `${dto.name}.${pair.property}`
          : undefined;
      flows.push({
        status: 'RESOLVED',
        field: fieldId(pair.form, pair.control),
        requestProperty: `${variable}.${pair.property}`,
        ...(dtoProperty ? { dtoProperty } : {}),
        apiCall,
        location: { file, line: request.line },
      });
    }
    for (const reason of request.unresolved)
      flows.push({ status: 'UNRESOLVED_DATA_FLOW', apiCall, reason, location: { file, line: request.line } });
  };

  // Appel direct à HttpClient dans le composant.
  for (const call of method.httpCalls) {
    const request =
      call.bodyRequest ??
      (call.body ? method.requests.find((entry) => entry.variable === call.body) : undefined);
    if (request) emit(request, `${component}#${method.name}`, request.type, request.variable ?? 'body');
  }
  // Composant → service.méthode(requête) → HttpClient.
  for (const serviceCall of method.serviceCalls) {
    const serviceType = fact.injected[serviceCall.target];
    const service = serviceType ? classes.get(serviceType) : undefined;
    const serviceMethod = service?.fact.methods.find((entry) => entry.name === serviceCall.method);
    if (!service || !serviceMethod) continue;
    serviceCall.args.forEach((argument, index) => {
      const parameter = serviceMethod.params[index];
      if (!parameter) return;
      const request =
        argument.kind === 'object'
          ? argument.request
          : argument.kind === 'variable'
            ? method.requests.find((entry) => entry.variable === argument.name)
            : undefined;
      if (!request) return;
      const http = serviceMethod.httpCalls.find((call) => call.body === parameter.name);
      if (!http) {
        flows.push({
          status: 'UNRESOLVED_DATA_FLOW',
          reason: `${serviceType ?? ''}.${serviceMethod.name}: parameter "${parameter.name}" does not reach an HTTP call directly`,
          location: { file, line: request.line },
        });
        return;
      }
      emit(
        request,
        `${serviceType ?? ''}#${serviceMethod.name}`,
        parameter.type ?? request.type,
        request.variable ?? parameter.name,
      );
    });
  }
  return flows;
}
