import type { DiscoveredAction, FormSummary } from './discovered-action.js';
import type { Issue } from './issue.js';
import type { PageStructure } from './ui-snapshot.js';

/**
 * État observable de l'écran courant, tel que donné au moteur de décision. Structuré
 * et compact — pas de HTML brut — pour qu'un futur moteur (local ou dans le cloud)
 * puisse le recevoir tel quel.
 */
export interface PageContext {
  url: string;
  title: string;
  stateId: string;
  /** Nom lisible de l'état (par exemple "users-list"). */
  stateLabel: string;
  /** Modèle de route normalisé (/users/:id). */
  route: string;
  headings: string[];
  /** Court extrait du texte visible. */
  text?: string;
  dialogs: string[];
  actions: DiscoveredAction[];
  forms: FormSummary[];
  /** Anomalies déjà observées sur cet état. */
  errors: Issue[];
  /** Forme de l'écran (tableaux, fil d'Ariane, régions…), quand elle a été observée. */
  structure?: PageStructure;
  metadata: {
    depth: number;
    timestamp: string;
    /** Id des états depuis l'état de départ jusqu'à celui-ci. */
    flow: string[];
  };
}
