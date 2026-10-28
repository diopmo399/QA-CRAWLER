import type { Page } from 'playwright';
import type { ScenarioConfig } from '../config/config.js';
import { HumanFlowRecorder } from './human-flow-recorder.js';
import type { PickedElement } from './target-correction.js';

/**
 * LE MODE SÉLECTION sur une page tenue (une session de correction) : la page encadre l'élément
 * survolé, l'humain clique celui que l'étape doit viser (le clic n'atteint jamais l'application),
 * Échap annule. Le même script que la fenêtre du recorder ; rien n'est enregistré.
 */
export interface TargetPicker {
  /** Attend l'élément désigné ; rien quand l'humain annule, ferme la page ou laisse passer le délai. */
  pick(label: string, timeoutMs?: number): Promise<PickedElement | undefined>;
  cancel(): void;
}

export async function openTargetPicker(
  page: Page,
  config: ScenarioConfig,
  language: 'fr' | 'en',
): Promise<TargetPicker> {
  const recorder = new HumanFlowRecorder({ name: 'correction', config, language });
  await recorder.attachCorrectionPage(page);
  return {
    pick: (label, timeoutMs) => recorder.pickTarget(label, timeoutMs),
    cancel: () => {
      recorder.cancelPick();
    },
  };
}
