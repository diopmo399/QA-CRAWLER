import { runTag } from '../forms/form-model.js';

/**
 * Données que le run a probablement créées : une action qui modifie des données
 * (formulaire envoyé, « Enregistrer »…) suivie d'un POST/PUT/PATCH réussi. Seulement
 * ce qui les identifie — jamais les valeurs envoyées, qui portent le marqueur du run (QA-CRAWLER-<runId>).
 */
export interface CreatedDataRecord {
  runId: string;
  /** Ce qu'il faut chercher dans l'application pour retrouver les données. */
  tag: string;
  stateId: string;
  actionId: string;
  /** Libellé visible de l'action (« Enregistrer »). */
  action: string;
  form?: string;
  /** Appels qui ont créé ou modifié quelque chose (URL masquée, sans corps). */
  requests: { method: string; url: string; status: number }[];
  at: string;
}

const WRITES = new Set(['POST', 'PUT', 'PATCH']);

export class CreatedDataRegistry {
  private readonly records: CreatedDataRecord[] = [];

  constructor(private readonly runId: string) {}

  /** Garde l'action quand l'un de ses appels a écrit quelque chose avec succès. */
  record(entry: {
    stateId: string;
    actionId: string;
    action: string;
    form?: string;
    requests: readonly { method: string; url: string; status?: number }[];
  }): CreatedDataRecord | undefined {
    const writes = entry.requests
      .filter(
        (request): request is { method: string; url: string; status: number } =>
          WRITES.has(request.method) &&
          request.status !== undefined &&
          request.status >= 200 &&
          request.status < 400,
      )
      .map(({ method, url, status }) => ({ method, url, status }));
    if (writes.length === 0) return undefined;
    const record: CreatedDataRecord = {
      runId: this.runId,
      tag: runTag(this.runId),
      stateId: entry.stateId,
      actionId: entry.actionId,
      action: entry.action,
      ...(entry.form ? { form: entry.form } : {}),
      requests: writes,
      at: new Date().toISOString(),
    };
    this.records.push(record);
    return record;
  }

  all(): CreatedDataRecord[] {
    return [...this.records];
  }
}

export interface CleanupReport {
  cleaner: string;
  /** Enregistrements pris en charge par le nettoyage. */
  cleaned: number;
  /** Encore à supprimer (à la main, ou par un nettoyage qui en est capable). */
  pending: CreatedDataRecord[];
  notes: string[];
}

/**
 * Supprime ce qu'un run a créé. L'explorateur ne supprime jamais rien de lui-même
 * (supprimer est DANGEROUS) ; une implémentation propre à une application (appel
 * d'API, script SQL sur une base de test…) peut être branchée ici.
 */
export interface TestDataCleanup {
  readonly name: string;
  cleanup(records: readonly CreatedDataRecord[]): Promise<CleanupReport>;
}

/** Par défaut : ne supprime rien, liste ce qu'il faut retirer et comment le retrouver. */
export class ManualCleanup implements TestDataCleanup {
  readonly name = 'manual';

  cleanup(records: readonly CreatedDataRecord[]): Promise<CleanupReport> {
    const tags = [...new Set(records.map((record) => record.tag))];
    return Promise.resolve({
      cleaner: this.name,
      cleaned: 0,
      pending: [...records],
      notes:
        records.length === 0
          ? []
          : [`Nothing was deleted automatically. Look for data containing ${tags.join(', ')}.`],
    });
  }
}
