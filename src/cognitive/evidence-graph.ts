import type { StaticApplicationGraph } from '../static-analysis/model.js';
import {
  combineWeights,
  evidenceWeight,
  isRuntimeEvidence,
  type Evidence,
  type EvidenceReference,
  type EvidenceType,
} from './evidence.js';

export const NODE_KINDS = [
  'CONTROL',
  'FIELD',
  'COMPONENT',
  'ROUTE',
  'ACTION',
  'FORM',
  'DTO',
  'API',
  'RULE',
  'GOAL',
  'CAPABILITY',
  'ENTITY',
  'STATE',
  'HUMAN_ACTION',
  'OBSERVATION',
  'FAILURE',
  'RECOVERY',
  'CONDITION',
] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

/** Relations d'implémentation (code, contrat) et relations fonctionnelles / causales. */
export const RELATIONS = [
  'BINDS_TO',
  'MAPS_TO',
  'SENT_TO',
  'RENDERS',
  'OWNS',
  'REQUIRED_BY',
  'VALIDATED_BY',
  'PERFORMED_BY',
  'OBSERVED_ON',
  'RECOVERED_BY',
  'FAILED_WITH',
  // Causal knowledge graph (§10)
  'REQUIRES',
  'ENABLES',
  'DISABLES',
  'REVEALS',
  'HIDES',
  'POPULATES',
  'CLEARS',
  'VALIDATES',
  'INVALIDATES',
  'NAVIGATES_TO',
  'TRIGGERS',
  'DEPENDS_ON',
  'PREVENTS',
  'TRANSITIONS_TO',
] as const;
export type Relation = (typeof RELATIONS)[number];

export interface GraphNode {
  id: string;
  kind: NodeKind;
  label: string;
}

/** PROVENANCE OBLIGATOIRE (§5) : d'où vient la relation, combien de fois, et si le runtime l'a vue. */
export interface Provenance {
  sources: EvidenceType[];
  evidence: EvidenceReference[];
  confidence: number;
  version?: string;
  firstObserved: string;
  lastObserved: string;
  observationCount: number;
  runtimeConfirmed: boolean;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  relation: Relation;
  provenance: Provenance;
}

/** Ce que le runtime peut dire au plus d'une relation sans preuve observée : elle reste une suggestion. */
const NON_RUNTIME_CEILING = 0.8;
/** Une relation seulement proposée par un LLM ne dépasse jamais ce plafond. */
const LLM_ONLY_CEILING = 0.3;

export function nodeId(kind: NodeKind, label: string): string {
  return `${kind}:${label.trim().toLowerCase()}`;
}

/**
 * EVIDENCE GRAPH : contrôles, champs, composants, routes, actions, DTO, API, règles,
 * objectifs, états, actions humaines, observations, échecs et récupérations, reliés par
 * des relations dont chacune garde sa provenance.
 *
 * La confiance d'une relation combine ses preuves (noisy-or, pondérées par type, âge et
 * version). Sans preuve runtime elle reste plafonnée (le code suggère, le runtime confirme).
 */
export class EvidenceGraph {
  private readonly nodes = new Map<string, GraphNode>();
  private readonly edges = new Map<string, GraphEdge>();
  private readonly weights = new Map<string, number[]>();

  constructor(private readonly context: { version?: string; now?: () => string } = {}) {}

  node(kind: NodeKind, label: string): GraphNode {
    const id = nodeId(kind, label);
    const existing = this.nodes.get(id);
    if (existing) return existing;
    const node: GraphNode = { id, kind, label: label.trim() };
    this.nodes.set(id, node);
    return node;
  }

  /** Une relation de plus, ou une preuve de plus pour une relation connue. */
  relate(from: GraphNode, relation: Relation, to: GraphNode, evidence: Evidence): GraphEdge {
    const id = `${from.id}|${relation}|${to.id}`;
    const at = evidence.timestamp ?? this.now();
    const weight = evidenceWeight(evidence, {
      now: this.now(),
      ...(this.context.version ? { version: this.context.version } : {}),
    });
    const existing = this.edges.get(id);
    const weights = [...(this.weights.get(id) ?? []), weight];
    this.weights.set(id, weights);
    const sources = new Set<EvidenceType>([...(existing?.provenance.sources ?? []), evidence.type]);
    const references = [...(existing?.provenance.evidence ?? [])];
    if (!references.some((reference) => reference.id === evidence.id))
      references.push({ id: evidence.id, type: evidence.type });
    const runtimeConfirmed =
      (existing?.provenance.runtimeConfirmed ?? false) || isRuntimeEvidence(evidence.type);
    const llmOnly = [...sources].every((source) => source === 'LLM_PROPOSAL');
    const ceiling = llmOnly ? LLM_ONLY_CEILING : runtimeConfirmed ? 0.99 : NON_RUNTIME_CEILING;
    const edge: GraphEdge = {
      id,
      from: from.id,
      to: to.id,
      relation,
      provenance: {
        sources: [...sources],
        evidence: references.slice(-20),
        confidence: combineWeights(weights, ceiling),
        ...((evidence.applicationVersion ?? this.context.version)
          ? { version: evidence.applicationVersion ?? this.context.version }
          : {}),
        firstObserved: existing?.provenance.firstObserved ?? at,
        lastObserved: at,
        observationCount: (existing?.provenance.observationCount ?? 0) + 1,
        runtimeConfirmed,
      },
    };
    this.edges.set(id, edge);
    return edge;
  }

  edgesFrom(id: string, relation?: Relation): GraphEdge[] {
    return [...this.edges.values()].filter(
      (edge) => edge.from === id && (!relation || edge.relation === relation),
    );
  }

  edgesTo(id: string, relation?: Relation): GraphEdge[] {
    return [...this.edges.values()].filter(
      (edge) => edge.to === id && (!relation || edge.relation === relation),
    );
  }

  getNode(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  allNodes(): GraphNode[] {
    return [...this.nodes.values()];
  }

  allEdges(): GraphEdge[] {
    return [...this.edges.values()];
  }

  /** « Pourquoi crois-tu que A est lié à B ? » : les relations, leurs sources et leur confiance. */
  explain(id: string): string[] {
    return [...this.edgesFrom(id), ...this.edgesTo(id)].map(
      (edge) =>
        `${this.label(edge.from)} ${edge.relation} ${this.label(edge.to)} — ${edge.provenance.sources.join('+')}, confidence ${String(edge.provenance.confidence)}, ${String(edge.provenance.observationCount)} observation(s)${edge.provenance.runtimeConfirmed ? ', runtime confirmed' : ''}`,
    );
  }

  toJSON(): { nodes: GraphNode[]; edges: GraphEdge[] } {
    return { nodes: this.allNodes(), edges: this.allEdges() };
  }

  private label(id: string): string {
    return this.nodes.get(id)?.label ?? id;
  }

  private now(): string {
    return this.context.now?.() ?? new Date().toISOString();
  }
}

/**
 * Le graphe statique (déjà analysé, en cache) entre dans le graphe de preuves comme
 * preuve STATIC_SOURCE : champ → contrôle → composant, champ → propriété du DTO → API,
 * route → composant. Rien de tout cela n'est « runtime confirmed ».
 */
export function importStaticGraph(
  graph: EvidenceGraph,
  statics: StaticApplicationGraph,
  addEvidence: (input: Omit<Evidence, 'id'>) => Evidence,
): number {
  let relations = 0;
  const version = statics.version ?? statics.commit;
  const proof = (source: string, details: Record<string, string>, confidence = 0.8): Evidence =>
    addEvidence({
      type: 'STATIC_SOURCE',
      source,
      confidence,
      ...(version ? { applicationVersion: version } : {}),
      details,
    });
  for (const route of statics.routes) {
    if (!route.component) continue;
    graph.relate(
      graph.node('ROUTE', route.path),
      'RENDERS',
      graph.node('COMPONENT', route.component),
      proof(`${route.location.file}:${String(route.location.line)}`, {
        route: route.path,
        component: route.component,
      }),
    );
    relations += 1;
  }
  for (const field of statics.fields) {
    const control = graph.node('FIELD', field.control);
    graph.relate(
      graph.node('COMPONENT', field.component),
      'OWNS',
      control,
      proof(`${field.location.file}:${String(field.location.line)}`, {
        component: field.component,
        control: field.control,
      }),
    );
    relations += 1;
  }
  for (const flow of statics.dataFlows) {
    if (flow.status !== 'RESOLVED' || !flow.field) continue;
    const field = statics.fields.find((candidate) => candidate.id === flow.field);
    if (!field) continue;
    const at = `${flow.location.file}:${String(flow.location.line)}`;
    if (flow.dtoProperty) {
      graph.relate(
        graph.node('FIELD', field.control),
        'MAPS_TO',
        graph.node('DTO', flow.dtoProperty),
        proof(at, { control: field.control, dto: flow.dtoProperty }),
      );
      relations += 1;
    }
    const call = statics.apiCalls.find((candidate) => candidate.id === flow.apiCall);
    if (call) {
      graph.relate(
        graph.node('FIELD', field.control),
        'SENT_TO',
        graph.node('API', `${call.method} ${call.route}`),
        proof(at, { control: field.control, api: `${call.method} ${call.route}` }),
      );
      relations += 1;
    }
  }
  return relations;
}
