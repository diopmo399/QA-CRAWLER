import type { IntelligenceRequest, ProviderCallOptions, ProviderResult } from './model.js';
import type { ModelProfile, ModelSelectionMode } from './models/model-types.js';

export interface ProviderModelSummary {
  selectionMode: ModelSelectionMode;
  requestedModel?: string;
  defaultProfile: ModelProfile;
  reasoningMode: string;
  discovery?: { status: string; available: number; listed: number; at?: string; error?: string };
}

/**
 * Un FOURNISSEUR D'INTELLIGENCE : il analyse une requête structurée et rend une proposition
 * brute. Il ne clique jamais, ne voit jamais Playwright et ne décide de rien — la passerelle
 * valide, la SafetyPolicy autorise, l'exécuteur exécute, le runtime confirme.
 *
 * Le cœur de QA-Crawler ne connaît que cette interface : aucun SDK n'est importé hors de son
 * propre module de fournisseur.
 */
export interface IntelligenceProvider {
  readonly id: string;
  /** Le modèle effectivement utilisé, quand il est connu (pour le rapport). */
  readonly model?: string;
  /** Disponible (installé, authentifié, joignable) ? Ne lève jamais. */
  isAvailable(): Promise<boolean>;
  /** La raison de l'indisponibilité (jamais un secret). */
  unavailableReason?(): string | undefined;
  analyze(request: IntelligenceRequest, options: ProviderCallOptions): Promise<ProviderResult>;
  /** La gestion des modèles du fournisseur, pour le rapport (mode de sélection, découverte). */
  modelSummary?(): ProviderModelSummary | undefined;
  close?(): Promise<void>;
}
