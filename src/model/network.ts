/**
 * Un échange HTTP vu pendant une action. Seul ce qui explique la transition est
 * gardé — jamais les en-têtes (Authorization, cookies), les corps, les mots de
 * passe ni les secrets ; l'URL passe par le masquage.
 */
export interface NetworkExchange {
  method: string;
  url: string;
  /** Absent quand la requête a échoué ou n'avait pas répondu à la fermeture de la fenêtre. */
  status?: number;
  durationMs?: number;
  /** document, xhr, fetch… */
  resourceType: string;
  /** Erreur réseau (ERR_CONNECTION_REFUSED…), quand la requête a échoué. */
  failure?: string;
}

/** La fenêtre réseau d'une action : de juste avant son exécution jusqu'à l'observation de l'état suivant. */
export interface ActionNetworkTrace {
  actionId: string;
  startedAt: string;
  finishedAt: string;
  requests: NetworkExchange[];
}
