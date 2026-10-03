import { sanitizeText } from '../../persistence/sanitize.js';
import { ModelCapabilityResolver, type SdkModelInfo } from './capability-resolver.js';
import type { AvailableModel } from './model-types.js';

export type ModelDiscoveryEvent =
  'AI_MODEL_DISCOVERY_STARTED' | 'AI_MODEL_DISCOVERY_COMPLETED' | 'AI_MODEL_DISCOVERY_FAILED';

export interface ModelDiscoverySnapshot {
  status: 'OK' | 'FAILED' | 'DISABLED';
  models: AvailableModel[];
  at?: string;
  error?: string;
}

export interface AvailableModelRegistryOptions {
  /** La découverte officielle (client.listModels() du SDK). */
  discover: () => Promise<SdkModelInfo[]>;
  /** false : chaque besoin redécouvre (le SDK met déjà en cache jusqu'à la déconnexion). */
  cache: boolean;
  ttlMs: number;
  now?: () => number;
  emit?: (event: ModelDiscoveryEvent, message: string) => void;
}

/**
 * AVAILABLE MODEL REGISTRY : les modèles RÉELLEMENT accessibles au compte courant, découverts
 * par le SDK (jamais une liste écrite à la main), mis en cache (TTL ou durée de la session),
 * rafraîchis à la demande (refreshModels) — par exemple quand un modèle choisi est refusé.
 * Une découverte en échec ne fait jamais planter le crawler : elle est rapportée.
 */
export class AvailableModelRegistry {
  private snapshot: ModelDiscoverySnapshot | undefined;
  private loadedAt = 0;
  private pending: Promise<ModelDiscoverySnapshot> | undefined;
  /** Nombre de découvertes réelles (0 tant qu'aucune requête n'a eu besoin d'un modèle). */
  discoveries = 0;

  constructor(private readonly options: AvailableModelRegistryOptions) {}

  async models(): Promise<ModelDiscoverySnapshot> {
    const now = this.now();
    if (this.options.cache && this.snapshot?.status === 'OK' && now - this.loadedAt < this.options.ttlMs)
      return this.snapshot;
    return this.refreshModels();
  }

  refreshModels(): Promise<ModelDiscoverySnapshot> {
    this.pending ??= this.discover().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  /** Le dernier état connu, sans redécouvrir (rapport). */
  last(): ModelDiscoverySnapshot | undefined {
    return this.snapshot;
  }

  find(id: string): AvailableModel | undefined {
    return this.snapshot?.models.find((model) => model.id === id);
  }

  private async discover(): Promise<ModelDiscoverySnapshot> {
    this.discoveries += 1;
    this.options.emit?.('AI_MODEL_DISCOVERY_STARTED', 'listing the models available to this account');
    try {
      const raw = await this.options.discover();
      const models = raw
        .filter((info) => typeof info.id === 'string')
        .map((info) => ModelCapabilityResolver.fromSdk(info));
      this.snapshot = { status: 'OK', models, at: new Date(this.now()).toISOString() };
      this.loadedAt = this.now();
      this.options.emit?.(
        'AI_MODEL_DISCOVERY_COMPLETED',
        `${String(models.filter((model) => model.available).length)} available / ${String(models.length)} listed`,
      );
      return this.snapshot;
    } catch (error) {
      const message = sanitizeText(error instanceof Error ? error.message : String(error)).slice(0, 200);
      this.snapshot = { status: 'FAILED', models: this.snapshot?.models ?? [], error: message };
      this.options.emit?.('AI_MODEL_DISCOVERY_FAILED', message);
      return this.snapshot;
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
