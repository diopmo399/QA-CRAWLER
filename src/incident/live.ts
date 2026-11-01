import path from 'node:path';
import { LIVE_STEP_STATUSES, type LiveStepStatus, type ReproductionLive } from './model.js';

/**
 * LA PROGRESSION EN DIRECT D'UNE REPRODUCTION : construite seulement à partir des événements du moteur
 * (début de flow, début et fin d'étape), gardée en mémoire par le service pendant le rejeu. Aucune
 * étape à venir, aucune durée n'est inventée : une étape apparaît quand le moteur la commence (ou la
 * rapporte, SKIPPED), sa durée quand il la termine.
 */

/** Ce que l'hôte relaie du moteur pendant un rejeu (descriptions déjà sans valeur saisie). */
export type ReplayProgressEvent =
  | { type: 'flow-start'; at: string; flow: string; total: number }
  | { type: 'step-start'; at: string; index: number; kind: string; description: string }
  | {
      type: 'step-end';
      at: string;
      index: number;
      kind: string;
      description: string;
      status: string;
      durationMs: number;
      reason?: string;
      /** Relative au dossier du run. */
      screenshot?: string;
    };

const MAX_STEPS = 1000;
const FINAL_STATUSES = new Set<string>(LIVE_STEP_STATUSES.filter((status) => status !== 'RUNNING'));

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const validIndex = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 100_000;

/** Une capture relative au dossier du run, sans remontée ; undefined sinon. */
export function safeRunFile(file: unknown): string | undefined {
  if (typeof file !== 'string' || file === '' || file.includes('\0')) return undefined;
  if (path.isAbsolute(file) || path.win32.isAbsolute(file)) return undefined;
  const normalized = path.posix.normalize(file.replace(/\\/g, '/'));
  if (normalized.startsWith('../') || normalized === '..' || normalized.split('/').includes('..'))
    return undefined;
  return normalized;
}

export class LiveProgress {
  private live: ReproductionLive | undefined;

  apply(event: ReplayProgressEvent): void {
    const at = typeof event.at === 'string' ? event.at : new Date().toISOString();
    if (event.type === 'flow-start') {
      // Un nouveau flow (par exemple après un flow de préparation) : ses étapes repartent de zéro.
      this.live = {
        flow: clip(event.flow, 300),
        ...(validIndex(event.total) ? { total: event.total } : {}),
        steps: [],
        updatedAt: at,
      };
      return;
    }
    if (!validIndex(event.index)) return;
    const live = (this.live ??= { steps: [], updatedAt: at });
    let step = live.steps.find((entry) => entry.index === event.index);
    if (!step) {
      if (live.steps.length >= MAX_STEPS) return;
      step = {
        index: event.index,
        kind: clip(event.kind, 40),
        description: clip(event.description, 200),
        status: 'RUNNING',
      };
      live.steps.push(step);
      live.steps.sort((a, b) => a.index - b.index);
    }
    if (event.type === 'step-start') {
      step.status = 'RUNNING';
      step.startedAt = at;
      delete step.durationMs;
      live.current = event.index;
    } else {
      if (!FINAL_STATUSES.has(event.status)) return;
      step.status = event.status as LiveStepStatus;
      step.description = clip(event.description, 200);
      // Une étape SKIPPED n'a pas été jouée : le 0 du moteur n'est pas une durée mesurée.
      if (
        event.status !== 'SKIPPED' &&
        typeof event.durationMs === 'number' &&
        Number.isFinite(event.durationMs) &&
        event.durationMs >= 0
      )
        step.durationMs = Math.round(event.durationMs);
      if (event.reason) step.reason = clip(event.reason, 300);
      const screenshot = safeRunFile(event.screenshot);
      if (screenshot) {
        step.screenshot = screenshot;
        live.latestScreenshot = screenshot;
      }
      if (live.current === event.index) delete live.current;
    }
    live.updatedAt = at;
  }

  /** Une copie de l'état courant ; undefined tant que le moteur n'a rien annoncé. */
  snapshot(): ReproductionLive | undefined {
    return this.live ? structuredClone(this.live) : undefined;
  }
}
