import { createQaCrawler, type QaCrawlerClient } from '../core/client.js';
import { startSdkServer, type SdkServerOptions } from './server.js';

/**
 * LE SDK DANS UN PROGRAMME NODE (scripts, CI, outils internes). Le même service et le même client
 * que le Dashboard et l'assistant : le serveur démarre sur 127.0.0.1 (port libre), avec un jeton
 * aléatoire jamais affiché, et le client lui parle. Aucun second moteur : tout passe par le contrat
 * HTTP versionné (`SDK_API_VERSION`).
 */
export type OpenQaCrawlerOptions = Omit<
  SdkServerOptions,
  'host' | 'port' | 'token' | 'allowedOrigins' | 'publicUrl'
>;

export interface QaCrawlerNode {
  client: QaCrawlerClient;
  /** L'adresse locale du service (pour un composant d'interface ouvert dans un navigateur). */
  url: string;
  /**
   * Arrête le service : les exécutions en cours sont annulées (le moteur s'arrête avant l'action
   * suivante et écrit son rapport), puis le serveur se ferme.
   */
  close(): Promise<void>;
}

export async function openQaCrawler(options: OpenQaCrawlerOptions): Promise<QaCrawlerNode> {
  const server = await startSdkServer({ ...options, host: '127.0.0.1', port: 0 });
  const client = createQaCrawler({ endpoint: `${server.url}/api`, token: server.token });
  let closed: Promise<void> | undefined;
  return {
    client,
    url: server.url,
    close: () => {
      closed ??= (async () => {
        client.dispose();
        await server.close();
      })();
      return closed;
    },
  };
}
