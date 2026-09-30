import type { DiscoveredAction } from '../model/discovered-action.js';
import type { ApiContract, ContractFieldSchema, ContractOperation } from '../oracles/api-contract.js';
import type {
  EvidenceEdge,
  EvidenceSource,
  FieldProvenance,
  SemanticConflict,
  SemanticEvidence,
  StaticApiCallNode,
  StaticApplicationGraph,
  StaticFieldNode,
  StaticRouteNode,
  StaticValidator,
} from './model.js';

/**
 * Poids des preuves statiques : CENTRALISÉS ici (jamais en dur dans le résolveur).
 * Une preuve statique vaut moins qu'un libellé visible (70 points dans le FieldMatcher) :
 * elle éclaire un champ pauvre, elle ne renverse pas ce que l'utilisateur voit.
 */
export const STATIC_EVIDENCE_WEIGHTS = {
  /** Confiance de chaque source, 0..1. */
  confidence: {
    formControlName: 0.5,
    validator: 0.75,
    dataFlow: 0.85,
    dtoProperty: 0.85,
    http: 0.8,
    openApiFormat: 0.9,
    openApiProperty: 0.85,
  },
  /** Points du FieldMatcher quand le concept prouvé est celui de l'intention. */
  points: {
    /** Au moins une preuve forte (flux de données, DTO, OpenAPI). */
    strong: 45,
    /** Chaque source forte de plus qui converge. */
    convergence: 8,
    convergenceMax: 20,
    /** Seulement formControlName (similitude de nom). */
    medium: 18,
    /** Le concept prouvé en contredit un autre (la preuve reste citée). */
    contradiction: -25,
  },
  /** Sources qui comptent comme preuve forte. */
  strongSources: ['STATIC_CODE', 'DTO', 'OPENAPI'] as readonly EvidenceSource[],
} as const;

/** Ce qu'un format OpenAPI signifie, en concepts du vocabulaire. */
const FORMAT_CONCEPTS: Record<string, string> = {
  email: 'email',
  'idn-email': 'email',
  uri: 'website',
  url: 'website',
  tel: 'phone',
  phone: 'phone',
};

export type ConceptOf = (text: string) => string | undefined;

/**
 * STATIC KNOWLEDGE : le graphe statique indexé en mémoire pour des recherches
 * immédiates — aucune requête SQL, aucun parcours d'AST au moment de résoudre.
 *
 *   formControlName → provenances      concept → champs
 *   propriété de DTO → champs          opération d'API → champs (index inverse)
 *   route → composant                  composant → routes, appels d'API
 *
 * Chaque provenance est STATIC_DISCOVERED : elle devient RUNTIME_CONFIRMED seulement
 * quand le champ a été réellement rempli sans erreur (confirm()).
 */
export class StaticKnowledge {
  private readonly byControl = new Map<string, FieldProvenance[]>();
  private readonly byConcept = new Map<string, FieldProvenance[]>();
  private readonly byDtoProperty = new Map<string, StaticFieldNode[]>();
  private readonly byApiOperation = new Map<string, StaticFieldNode[]>();
  private readonly componentsByRoute = new Map<string, string>();
  private readonly routesByComponent = new Map<string, StaticRouteNode[]>();
  private readonly apiByComponent = new Map<string, StaticApiCallNode[]>();

  constructor(
    readonly graph: StaticApplicationGraph,
    private readonly conceptOf: ConceptOf,
    private readonly contract?: ApiContract,
  ) {
    for (const route of graph.routes) {
      if (route.component) {
        this.componentsByRoute.set(route.path, route.component);
        this.routesByComponent.set(route.component, [
          ...(this.routesByComponent.get(route.component) ?? []),
          route,
        ]);
      }
    }
    for (const call of graph.apiCalls)
      this.apiByComponent.set(call.owner, [...(this.apiByComponent.get(call.owner) ?? []), call]);
    for (const field of graph.fields) {
      const provenance = this.provenanceOf(field);
      this.byControl.set(field.control, [...(this.byControl.get(field.control) ?? []), provenance]);
      if (provenance.concept)
        this.byConcept.set(provenance.concept, [
          ...(this.byConcept.get(provenance.concept) ?? []),
          provenance,
        ]);
    }
    for (const flow of graph.dataFlows) {
      if (flow.status !== 'RESOLVED' || !flow.field) continue;
      const field = graph.fields.find((entry) => entry.id === flow.field);
      if (!field) continue;
      if (flow.dtoProperty)
        this.byDtoProperty.set(flow.dtoProperty, [
          ...(this.byDtoProperty.get(flow.dtoProperty) ?? []),
          field,
        ]);
      const call = graph.apiCalls.find((entry) => entry.id === flow.apiCall);
      if (call) {
        const key = `${call.method} ${call.route}`;
        this.byApiOperation.set(key, [...(this.byApiOperation.get(key) ?? []), field]);
      }
    }
  }

  /**
   * Les provenances d'un élément par son formControlName. Plusieurs composants peuvent
   * utiliser le même nom : celui de la route courante passe devant ; sinon toutes sont
   * rendues, et le résolveur voit s'ils divergent.
   */
  provenanceFor(control: string | undefined, pathname?: string): FieldProvenance[] {
    if (!control) return [];
    const all = this.byControl.get(control) ?? [];
    if (all.length <= 1 || !pathname) return all;
    const component = this.componentAt(pathname);
    const local = component ? all.filter((entry) => entry.component === component) : [];
    return local.length > 0 ? local : all;
  }

  /** Le composant d'une adresse (/users/12 correspond à /users/:id). */
  componentAt(pathname: string): string | undefined {
    const clean = pathname.replace(/\/$/, '') || '/';
    const exact = this.componentsByRoute.get(clean);
    if (exact) return exact;
    for (const [route, component] of this.componentsByRoute) {
      const pattern = new RegExp(
        `^${route
          .split('/')
          .map((segment) => (segment.startsWith(':') ? '[^/]+' : escape(segment)))
          .join('/')}$`,
      );
      if (pattern.test(clean)) return component;
    }
    return undefined;
  }

  fieldsForConcept(concept: string): FieldProvenance[] {
    return this.byConcept.get(concept) ?? [];
  }

  /** Index inverse : les champs qui alimentent une opération (POST /api/users). */
  fieldsForApi(method: string, route: string): StaticFieldNode[] {
    return this.byApiOperation.get(`${method} ${route}`) ?? [];
  }

  fieldsForDtoProperty(property: string): StaticFieldNode[] {
    return this.byDtoProperty.get(property) ?? [];
  }

  routesOf(component: string): StaticRouteNode[] {
    return this.routesByComponent.get(component) ?? [];
  }

  apiCallsOf(component: string): StaticApiCallNode[] {
    return this.apiByComponent.get(component) ?? [];
  }

  /** Les validateurs d'un contrôle (pour le modèle de contraintes). */
  validatorsFor(control: string | undefined, pathname?: string): StaticValidator[] {
    const [first] = this.provenanceFor(control, pathname);
    if (!first) return [];
    return (
      this.graph.fields.find((field) => field.control === control && field.component === first.component)
        ?.validators ?? []
    );
  }

  /** Les champs (composant#contrôle) confirmés par l'exécution. */
  confirmedFields(): string[] {
    return [...this.byControl.values()]
      .flat()
      .filter((provenance) => provenance.truth === 'RUNTIME_CONFIRMED')
      .map((provenance) => `${provenance.component}#${provenance.control}`);
  }

  /** L'exécution a parcouru cette route par l'interface : RUNTIME_CONFIRMED. */
  confirmRoute(route: string): void {
    for (const node of this.graph.routes) if (node.path === route) node.truth = 'RUNTIME_CONFIRMED';
  }

  /** L'exécution a confirmé le champ (rempli sans erreur) : la connaissance devient RUNTIME_CONFIRMED. */
  confirm(control: string, component?: string): void {
    for (const provenance of this.byControl.get(control) ?? [])
      if (!component || provenance.component === component) provenance.truth = 'RUNTIME_CONFIRMED';
  }

  // ------------------------------------------------------------------ provenance

  private provenanceOf(field: StaticFieldNode): FieldProvenance {
    const { confidence } = STATIC_EVIDENCE_WEIGHTS;
    const evidence: SemanticEvidence[] = [];
    const edges: EvidenceEdge[] = [];
    const chain: string[] = [];
    const add = (entry: Omit<SemanticEvidence, 'concept'> & { conceptText?: string }): void => {
      const { conceptText, ...rest } = entry;
      const concept = conceptText ? this.conceptOf(conceptText) : undefined;
      evidence.push({ ...rest, ...(concept ? { concept } : {}) });
    };

    if (field.templateBinding)
      chain.push(
        `${field.templateBinding.tag}${field.templateBinding.inputType ? `[type=${field.templateBinding.inputType}]` : ''}`,
      );
    chain.push(`formControlName=${field.control}`, `FormControl ${field.control}`);
    edges.push({
      source: field.templateBinding
        ? `${field.templateBinding.template}#${field.control}`
        : `template#${field.control}`,
      target: field.id,
      relation: 'formControlName',
      evidence: 'FRAMEWORK',
      confidence: confidence.formControlName,
    });
    add({
      source: 'FRAMEWORK',
      kind: 'formControlName',
      value: field.control,
      conceptText: field.control,
      confidence: confidence.formControlName,
      provenance: {
        location: field.location,
        detail: `FormControl "${field.control}" in ${field.component}`,
      },
    });
    for (const validator of field.validators) {
      chain.push(
        `Validators.${validator.kind}${validator.value !== undefined ? `(${String(validator.value)})` : ''}`,
      );
      edges.push({
        source: field.id,
        target: `validator:${validator.kind}`,
        relation: 'validator',
        evidence: 'FRAMEWORK',
        confidence: confidence.validator,
      });
      if (validator.kind === 'email')
        evidence.push({
          source: 'FRAMEWORK',
          kind: 'validator',
          value: 'Validators.email',
          concept: 'email',
          confidence: confidence.validator,
          provenance: { location: field.location, detail: 'Angular Validators.email' },
        });
    }

    for (const flow of this.graph.dataFlows) {
      if (flow.status !== 'RESOLVED' || flow.field !== field.id || !flow.requestProperty) continue;
      const property = flow.requestProperty.split('.').pop() ?? flow.requestProperty;
      chain.push(`${field.control} → ${flow.requestProperty}`);
      edges.push({
        source: field.id,
        target: flow.requestProperty,
        relation: 'assigned-to',
        evidence: 'STATIC_CODE',
        confidence: confidence.dataFlow,
      });
      add({
        source: 'STATIC_CODE',
        kind: 'data-flow',
        value: `${field.control} → ${flow.requestProperty}`,
        conceptText: property,
        confidence: confidence.dataFlow,
        provenance: {
          location: flow.location,
          detail: `form value "${field.control}" assigned to ${flow.requestProperty}`,
        },
      });
      if (flow.dtoProperty) {
        chain.push(flow.dtoProperty);
        edges.push({
          source: flow.requestProperty,
          target: flow.dtoProperty,
          relation: 'dto-property',
          evidence: 'DTO',
          confidence: confidence.dtoProperty,
        });
        add({
          source: 'DTO',
          kind: 'dto-property',
          value: flow.dtoProperty,
          conceptText: property,
          confidence: confidence.dtoProperty,
          provenance: { detail: `request type ${flow.dtoProperty.split('.')[0] ?? ''}` },
        });
      }
      const call = this.graph.apiCalls.find((entry) => entry.id === flow.apiCall);
      if (!call) continue;
      const operation = `${call.method} ${call.route}`;
      chain.push(operation);
      edges.push({
        source: flow.dtoProperty ?? flow.requestProperty,
        target: operation,
        relation: 'request-body',
        evidence: 'HTTP',
        confidence: confidence.http,
      });
      evidence.push({
        source: 'HTTP',
        kind: 'request-body',
        value: operation,
        confidence: confidence.http,
        provenance: { location: call.location, detail: `${call.id} sends the request` },
      });
      const schema = this.contractField(call, property);
      if (!schema) continue;
      const formatConcept = schema.format ? FORMAT_CONCEPTS[schema.format.toLowerCase()] : undefined;
      chain.push(
        `OpenAPI ${property}${schema.type ? ` type=${schema.type}` : ''}${schema.format ? ` format=${schema.format}` : ''}`,
      );
      edges.push({
        source: operation,
        target: `openapi:${property}`,
        relation: 'openapi-property',
        evidence: 'OPENAPI',
        confidence: formatConcept ? confidence.openApiFormat : confidence.openApiProperty,
      });
      if (formatConcept)
        evidence.push({
          source: 'OPENAPI',
          kind: 'openapi-format',
          value: `format=${schema.format ?? ''}`,
          concept: formatConcept,
          confidence: confidence.openApiFormat,
          provenance: { detail: `OpenAPI ${operation} body.${property}` },
        });
      else
        add({
          source: 'OPENAPI',
          kind: 'openapi-property',
          value: property,
          conceptText: property,
          confidence: confidence.openApiProperty,
          provenance: { detail: `OpenAPI ${operation} body.${property}` },
        });
    }

    const { concept, conflicts } = decideConcept(evidence);
    return {
      control: field.control,
      component: field.component,
      chain,
      edges,
      evidence,
      ...(concept ? { concept } : {}),
      conflicts,
      truth: 'STATIC_DISCOVERED',
    };
  }

  /** Le schéma OpenAPI de la propriété du corps envoyé par cet appel. */
  private contractField(call: StaticApiCallNode, property: string): ContractFieldSchema | undefined {
    const operation = this.contract ? matchOperation(this.contract, call.method, call.route) : undefined;
    return operation?.requestFields[property];
  }
}

/** L'opération OpenAPI d'un appel vu dans le code (un préfixe de base inconnu est ignoré). */
export function matchOperation(
  contract: ApiContract,
  method: string,
  route: string,
): ContractOperation | undefined {
  const concrete = route
    .replace(/\{base\}/g, '')
    .replace(/\{param\}/g, '1')
    .replace(/\?.*$/, '');
  const absolute = concrete.startsWith('/') ? concrete : `/${concrete}`;
  const segments = absolute.split('/').filter(Boolean);
  const candidates = contract.operations.filter((operation) => operation.method === method);
  // Le chemin tel quel, puis sans ses premiers segments (/v1/api/users → /api/users).
  for (let start = 0; start < segments.length; start++) {
    const tail = `/${segments.slice(start).join('/')}`;
    const found = candidates.find((operation) => operation.matcher.test(tail));
    if (found) return found;
  }
  return undefined;
}

/**
 * Le concept d'un champ selon ses preuves. Les preuves fortes (code, DTO, OpenAPI)
 * décident ; formControlName seul ne suffit pas à contredire. Deux concepts forts
 * différents : SEMANTIC_EVIDENCE_CONFLICT, et le concept le mieux soutenu reste
 * seulement s'il l'est nettement.
 */
export function decideConcept(evidence: readonly SemanticEvidence[]): {
  concept?: string;
  conflicts: SemanticConflict[];
} {
  const support = new Map<string, { score: number; sources: Set<EvidenceSource> }>();
  for (const entry of evidence) {
    if (!entry.concept) continue;
    const current = support.get(entry.concept) ?? { score: 0, sources: new Set<EvidenceSource>() };
    current.score += entry.confidence;
    current.sources.add(entry.source);
    support.set(entry.concept, current);
  }
  const ranked = [...support.entries()].sort((a, b) => b[1].score - a[1].score);
  const [best, second] = ranked;
  if (!best) return { conflicts: [] };
  const conflicts: SemanticConflict[] = [];
  if (second)
    conflicts.push({
      kind: 'SEMANTIC_EVIDENCE_CONFLICT',
      concepts: ranked.map(([concept, entry]) => ({ concept, sources: [...entry.sources] })),
      detail: ranked.map(([concept, entry]) => `${concept} (${[...entry.sources].join(', ')})`).join(' vs '),
    });
  // Un concept retenu doit l'emporter nettement sur le suivant.
  if (second && best[1].score < second[1].score * 1.5) return { conflicts };
  return { concept: best[0], conflicts };
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Chaque champ observé qui porte un formControlName reçoit ce que le code en dit :
 * concept (données de test), propriété d'API (contrat) et validateurs (contraintes).
 * Des preuves, pas des vérités : l'exécution reste juge. Deux composants qui divergent
 * sur le sens d'un même nom : aucun concept n'est posé.
 */
export function annotateStaticFields(
  knowledge: StaticKnowledge,
  actions: readonly DiscoveredAction[],
  pathname: string,
): void {
  for (const action of actions) {
    const field = action.field;
    if (!field?.frameworkName) continue;
    const provenances = knowledge.provenanceFor(field.frameworkName, pathname);
    const [first] = provenances;
    if (!first) continue;
    const concepts = new Set(provenances.map((provenance) => provenance.concept));
    if (concepts.size === 1 && first.concept) field.staticConcept = first.concept;
    const flow = first.edges.find((edge) => edge.relation === 'assigned-to');
    const property = flow?.target.split('.').pop();
    if (property) field.staticProperty = property;
    const validators = knowledge.validatorsFor(field.frameworkName, pathname);
    if (validators.length > 0) field.staticValidators = validators.map((validator) => ({ ...validator }));
  }
}
