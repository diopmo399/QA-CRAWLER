import type {
  AiRef,
  AiSourceLocation,
  AiSuggestedRelation,
} from '../../../sdk/core/incident-ai-contracts.js';
import type { AgentOutcome, AgentRunContext, InvestigationAgent, InvestigationToolName } from '../agent.js';
import { refLookupOf, validateCitations, type RefLookup } from '../merge.js';
import { CROSS_LAYER_SYSTEM, CROSS_LAYER_TASK } from '../prompts/cross-layer.js';
import { dataSection } from '../prompts/evidence.js';
import {
  CROSS_LAYER_FINDINGS_JSON_SCHEMA,
  CrossLayerFindingsSchema,
  type CrossLayerFindings,
} from '../schemas/analysis.js';
import { agentBounds } from './evidence-analysis.js';

/**
 * L'AGENT INTER-COUCHES : la comparaison Frontend → BFF → Backend → Repository (champ perdu, transformation
 * fautive, contrat divergent, conversion générique d'erreur, validation absente de plusieurs couches). Les
 * relations suggérées ne relient que des nœuds existants et sont écrites INFERRED par `toGraphRelations`.
 */

export const CROSS_LAYER_TOOLS: readonly InvestigationToolName[] = [
  'get_request',
  'get_trace_graph',
  'get_graph_neighbours',
  'find_symbol',
  'find_references',
  'search_code',
  'read_source',
];

type CodeLayer = 'FRONTEND' | 'BFF' | 'BACKEND';
const CODE_LAYERS: readonly CodeLayer[] = ['FRONTEND', 'BFF', 'BACKEND'];

/** Les couches de code présentes dans le périmètre (applications) ou dans l'index. */
export function codeLayersOf(ctx: Pick<AgentRunContext, 'incident'>): CodeLayer[] {
  const layers = new Set<CodeLayer>();
  for (const app of ctx.incident.scope.applications) layers.add(app.layer);
  for (const app of ctx.incident.investigation.code?.applications ?? []) layers.add(app.layer);
  return CODE_LAYERS.filter((layer) => layers.has(layer));
}

export function crossLayerRefs(output: CrossLayerFindings): {
  refs: AiRef[];
  locations: AiSourceLocation[];
  relations: AiSuggestedRelation[];
} {
  return {
    refs: [...output.findings.flatMap((item) => item.refs), ...output.relations.flatMap((item) => item.refs)],
    locations: output.findings.flatMap((item) => item.locations),
    relations: output.relations,
  };
}

/** Les raisons de rejet : références, fichiers, et nœuds des relations qui doivent exister. */
export function validateCrossLayer(output: CrossLayerFindings, lookup: RefLookup): string[] {
  const { refs, locations, relations } = crossLayerRefs(output);
  const reasons = validateCitations(lookup, refs, locations);
  for (const relation of relations)
    for (const id of [relation.from, relation.to])
      if (!lookup.has({ kind: 'node', id }))
        reasons.push(`unknown graph node "${id}" in a relation: relate only existing node ids`);
  return [...new Set(reasons)];
}

export function createCrossLayerAgent(): InvestigationAgent<CrossLayerFindings> {
  return {
    name: 'CROSS_LAYER',
    applies(ctx) {
      return codeLayersOf(ctx).length >= 2 || (ctx.incident.investigation.graph?.nodes.length ?? 0) > 0;
    },
    async run(ctx): Promise<AgentOutcome<CrossLayerFindings>> {
      const layers = codeLayersOf(ctx);
      const packs = [
        ctx.packs.requests({ errorsOnly: true }),
        ctx.packs.graph(),
        ...layers.map((layer) => ctx.packs.code(layer)),
      ];
      const packRefs = packs.flatMap((pack) => pack.refs);
      const user = [
        ...packs.map((pack) => pack.text),
        dataSection('Evidence analysis (previous agent output)', ctx.previous.EVIDENCE_ANALYSIS),
        dataSection('Frontend findings (previous agent output)', ctx.previous.FRONTEND),
        dataSection('BFF findings (previous agent output)', ctx.previous.BFF),
        dataSection('Backend findings (previous agent output)', ctx.previous.BACKEND),
        CROSS_LAYER_TASK,
      ]
        .filter((part) => part.length > 0)
        .join('\n\n');
      const result = await ctx.loop<CrossLayerFindings>({
        agent: 'CROSS_LAYER',
        system: CROSS_LAYER_SYSTEM,
        user,
        tools: CROSS_LAYER_TOOLS,
        schema: CrossLayerFindingsSchema,
        outputSchema: CROSS_LAYER_FINDINGS_JSON_SCHEMA,
        ...agentBounds(ctx),
        validate: (output) => validateCrossLayer(output, refLookupOf(ctx, packRefs)),
      });
      return {
        agent: 'CROSS_LAYER',
        result,
        limitations: [...new Set(packs.flatMap((pack) => pack.omitted))],
      };
    },
  };
}

export const crossLayerAgent = createCrossLayerAgent();
