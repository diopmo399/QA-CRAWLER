import type { Page } from 'playwright';
import type { IssueCollector } from '../anomaly/issue-collector.js';
import type { ScenarioConfig } from '../config/config.js';

/** D'où vient une anomalie dans l'exploration : reproductible grâce à `flow` + `actionId`. */
export interface IssueAttribution {
  stateId?: string;
  actionId?: string;
  flow?: string[];
}

/** Ce que les observateurs doivent savoir de l'exploration en cours. */
export interface ObservationContext {
  /** URL de la page explorée ; les anomalies lui sont attribuées. */
  currentPageUrl(): string;
  /** État et action en cours. */
  currentAttribution(): IssueAttribution;
  collector: IssueCollector;
  config: ScenarioConfig;
}

/** Écoute les événements de page Playwright et signale les anomalies. */
export interface PageObserver {
  attach(page: Page): void;
  detach(page: Page): void;
}

/** Champs de rattachement prêts à être ajoutés à un IssueInput. */
export function attributionOf(context: ObservationContext): IssueAttribution {
  const { stateId, actionId, flow } = context.currentAttribution();
  return {
    ...(stateId !== undefined ? { stateId } : {}),
    ...(actionId !== undefined ? { actionId } : {}),
    ...(flow !== undefined ? { flow: [...flow] } : {}),
  };
}
