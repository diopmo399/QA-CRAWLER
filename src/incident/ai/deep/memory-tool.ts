import { z } from 'zod';
import type { InvestigationMemory } from '../../../sdk/core/incident-ai-contracts.js';
import type { InvestigationTool, ToolResult } from '../agent.js';
import { summarizeForReport, type InvestigationMemorySummary } from './memory.js';

/**
 * L'OUTIL `get_investigation_memory` : ce qui a déjà été tenté, trouvé, contredit et décidé, sous forme
 * structurée (jamais une transcription), pour qu'un agent ne refasse pas une expérience identique. Il lit la
 * mémoire courante par une fonction injectée (la boucle adaptative la met à jour entre deux itérations) ; aucune
 * opération de politique : la mémoire appartient à l'incident et ne contient ni corps de charge ni secret.
 */
export const GetInvestigationMemoryInput = z
  .object({
    /** Les parties voulues ; absent : tout le résumé. */
    sections: z
      .array(z.enum(['strategies', 'experiments', 'contradictions', 'explorations', 'coverage', 'limits']))
      .max(6)
      .optional(),
  })
  .strict();
export type GetInvestigationMemoryArgs = z.output<typeof GetInvestigationMemoryInput>;

export type MemoryProvider = () => InvestigationMemory | undefined;

/** Éléments au plus par liste rendue au modèle. */
export const MAX_MEMORY_TOOL_ITEMS = 40;

export function memoryTool(provider: MemoryProvider): InvestigationTool<GetInvestigationMemoryArgs> {
  return {
    name: 'get_investigation_memory',
    description:
      'The structured memory of this investigation: strategies already tried (with their outcome), verifications run or awaiting approval, contradictions found, hypothesis roles, coverage and limits. Use it before proposing a verification so that an identical one is never repeated.',
    input: GetInvestigationMemoryInput,
    operations: () => [],
    read(args): Promise<ToolResult> {
      const memory = provider();
      if (!memory)
        return Promise.resolve({
          ok: true,
          data: { empty: true, note: 'no investigation memory yet for this incident' },
        });
      const summary = summarizeForReport(memory);
      return Promise.resolve({ ok: true, data: select(summary, args.sections) });
    },
  };
}

function select(
  summary: InvestigationMemorySummary,
  sections: GetInvestigationMemoryArgs['sections'],
): Record<string, unknown> {
  const want = (name: NonNullable<typeof sections>[number]): boolean =>
    sections === undefined || sections.includes(name);
  return {
    depth: summary.depth,
    mode: summary.mode,
    status: summary.status,
    ...(summary.stopReason ? { stopReason: summary.stopReason } : {}),
    usage: summary.usage,
    ...(want('strategies')
      ? {
          strategies: {
            total: summary.strategies.total,
            byStatus: summary.strategies.byStatus,
            tried: summary.strategies.tried.slice(0, MAX_MEMORY_TOOL_ITEMS),
          },
        }
      : {}),
    ...(want('experiments')
      ? {
          experiments: {
            total: summary.experiments.total,
            byStatus: summary.experiments.byStatus,
            items: summary.experiments.items.slice(0, MAX_MEMORY_TOOL_ITEMS),
          },
        }
      : {}),
    ...(want('contradictions')
      ? {
          contradictions: {
            total: summary.contradictions.total,
            open: summary.contradictions.open,
            items: summary.contradictions.items.slice(0, MAX_MEMORY_TOOL_ITEMS),
          },
        }
      : {}),
    ...(want('explorations') ? { explorations: summary.explorations.slice(0, MAX_MEMORY_TOOL_ITEMS) } : {}),
    ...(want('coverage') ? { coverage: summary.coverage } : {}),
    ...(want('limits')
      ? { limits: summary.limits, remaining: summary.remaining.slice(0, MAX_MEMORY_TOOL_ITEMS) }
      : {}),
  };
}
