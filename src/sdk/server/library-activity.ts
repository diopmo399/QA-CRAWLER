import type { ExecutionDataTraceView, ExecutionDetail, LibraryBlockActivity } from '../core/contracts.js';
import { executionDetail, listExecutions } from './platform.js';

/**
 * L'ACTIVITÉ RÉELLE D'UN BLOC : la dernière exécution qui l'a rejoué, et ce que la trace des données de cette
 * exécution a observé pour lui. Rien n'est supposé ni inventé :
 *   - une exécution « rejoue le bloc » si l'un de ses scénarios le rejoue (registre), ou si l'une de ses étapes
 *     est une étape de ce bloc (« run Bloc › … ») — une exécution de simulation d'un parcours, par exemple ;
 *   - les événements sont ceux que le moteur a rapportés pour ce bloc (même politique de rétention : sans
 *     `testData.traceValues`, aucune valeur ; une clé sensible n'a jamais de valeur).
 * Seules les exécutions les plus récentes sont lues (borne `scan`) : un historique long ne coûte pas plus.
 */
const SCAN = 30;

const ownStep = (block: string, label: string): boolean =>
  label === `run ${block}` || label.startsWith(`run ${block} ›`);

function touches(detail: ExecutionDetail, block: string): boolean {
  return detail.flowsDetail.some(
    (flow) =>
      flow.steps.some((step) => ownStep(block, step.label)) ||
      (flow.dataTrace ?? []).some((entry) => entry.block === block),
  );
}

export async function blockActivity(
  projectId: string,
  reportsDir: string,
  block: { name: string; usedBy: readonly string[] },
  scan = SCAN,
): Promise<LibraryBlockActivity> {
  const records = (await listExecutions(projectId, reportsDir)).slice(0, scan);
  for (const record of records) {
    const byScenario = (record.scenarios ?? []).some((scenario) => block.usedBy.includes(scenario));
    const detail = await executionDetail(projectId, reportsDir, record.run);
    if (!detail || (!byScenario && !touches(detail, block.name))) continue;
    const events: (ExecutionDataTraceView & { flow: string })[] = detail.flowsDetail.flatMap((flow) =>
      (flow.dataTrace ?? [])
        .filter((entry) => entry.block === block.name)
        .map((entry) => ({ ...entry, flow: flow.name })),
    );
    return {
      scanned: records.length,
      last: {
        run: record.run,
        createdAt: record.createdAt,
        verdict: record.verdict,
        ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
        ...(record.scenarios ? { scenarios: [...record.scenarios] } : {}),
        ...(record.simulation ? { simulation: { ...record.simulation } } : {}),
        ...(record.environment ? { environment: { ...record.environment } } : {}),
        ...(detail.reports.html ? { report: detail.reports.html } : {}),
      },
      events,
    };
  }
  return { scanned: records.length, events: [] };
}
