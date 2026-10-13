import path from 'node:path';
import type { Page } from 'playwright';
import { dryRunConfig } from '../dry-run/dry-run-orchestrator.js';
import { loadDryRunScenario, type DryRunInput } from '../dry-run/scenario-input.js';
import { runMission } from '../orchestrator.js';

/**
 * LA SESSION DE CORRECTION (revue) — « suivre le même chemin » avant de corriger une étape.
 *
 * L'URL d'une étape ne suffit pas : l'écran de l'étape 16 dépend des étapes 1 à 15 (un dossier
 * ouvert, une fenêtre, un assistant, une donnée créée par le run). La session rejoue donc les étapes
 * PRÉCÉDENTES avec le moteur de rejeu de la mission (même connexion, même SafetyPolicy, mêmes données
 * de test), puis GARDE LA PAGE OUVERTE dans cet état réel tant que la correction dure : l'humain y
 * désigne l'élément, rien n'est reproduit ni deviné. Si le chemin s'arrête avant l'étape visée
 * (une étape précédente échoue), la session le dit : c'est cette étape-là qu'il faut corriger d'abord.
 */
export interface CorrectionSessionRequest extends DryRunInput {
  /** Le dossier de l'enregistrement (la session écrit sous <dossier>/correction/). */
  directory: string;
  /** L'étape à corriger : sa position dans le flow, à partir de 1. Les étapes 1 à N-1 sont rejouées. */
  stepIndex: number;
  headless: boolean;
  /** Une étape précédente rejouée (progression dans la fenêtre du recorder). */
  onStep?: (executed: number, total: number) => void;
  /**
   * Les étapes précédentes sont faites (ou le chemin s'est arrêté) : la page reste ouverte tant que
   * la promesse n'est pas résolue — le temps de la correction.
   */
  hold: (state: CorrectionSessionState) => Promise<void>;
}

export interface CorrectionSessionState {
  page: Page;
  /** true : l'écran de l'étape visée est atteint (les étapes précédentes ont toutes réussi). */
  reached: boolean;
  executed: number;
  total: number;
  /** Le chemin s'est arrêté là : l'étape, son libellé et la raison (jamais une valeur saisie). */
  stoppedAt?: { index: number; label: string; reason: string };
}

export async function runCorrectionSession(
  request: CorrectionSessionRequest,
): Promise<CorrectionSessionState | { error: string }> {
  let state: CorrectionSessionState | undefined;
  try {
    const input: DryRunInput = {
      scenarioFile: request.scenarioFile,
      ...(request.missionFile ? { missionFile: request.missionFile } : {}),
      overrides: { ...request.overrides, headless: request.headless },
      ...(request.env ? { env: request.env } : {}),
    };
    const loaded = loadDryRunScenario(input);
    // Une mémoire propre à la correction : elle n'apprend rien à la mission et n'en lit rien.
    const config = dryRunConfig(
      loaded.config,
      { ...input, isolatedMemory: true, useHistory: false },
      path.join(request.directory, 'correction'),
    );
    const graph = loaded.graphs[0];
    const flow = graph ? config.flows.find((candidate) => candidate.name === graph.name) : undefined;
    if (!graph || !flow) return { error: 'the generated flow could not be loaded for the correction' };
    await runMission(config, {
      mode: 'explore',
      ...(request.env ? { env: request.env } : {}),
      onWarning: () => undefined,
      dryRun: async (driverFor) => {
        const driver = driverFor(flow);
        const started = await driver.start(graph.startAt);
        const before = graph.intents.filter((intent) => intent.index < request.stepIndex);
        const total = before.length;
        let executed = 0;
        request.onStep?.(0, total);
        let stoppedAt: CorrectionSessionState['stoppedAt'];
        if (!started)
          stoppedAt = {
            index: 0,
            label: graph.startAt ?? config.target.startAt,
            reason: 'the start page could not be loaded',
          };
        else
          for (const intent of before) {
            const result = await driver.perform(intent);
            if ((result.status === 'FAILED' || result.status === 'BLOCKED') && intent.required) {
              stoppedAt = {
                index: intent.index,
                label: intent.label,
                reason: result.reason ?? result.status,
              };
              break;
            }
            executed += 1;
            request.onStep?.(executed, total);
          }
        const page = driver.page?.();
        if (!page) return;
        state = {
          page,
          reached: stoppedAt === undefined,
          executed,
          total,
          ...(stoppedAt ? { stoppedAt } : {}),
        };
        await request.hold(state);
      },
    });
  } catch (error) {
    return {
      error: `the correction session could not run: ${error instanceof Error ? (error.message.split('\n')[0] ?? error.message) : String(error)}`,
    };
  }
  return state ?? { error: 'the correction session did not reach the application' };
}
