import type { CDPSession, Page } from 'playwright';

/**
 * LES CORPS DE RÉPONSE APRÈS UNE NAVIGATION : une application qui crée puis navigue aussitôt
 * (`location.href = '/requests/' + id`) rend le corps de la réponse illisible par Playwright (« No
 * resource with given identifier found »). Une session CDP de LECTURE, avec les messages durables du
 * réseau (enableDurableMessages), garde ces corps lisibles : le secours de l'observateur réseau quand
 * `response.text()` échoue. Rien n'est intercepté ni modifié ; Chromium seulement, sinon absent.
 */
interface BodyEntry {
  id: string;
  method: string;
  url: string;
  used: boolean;
  settled: boolean;
  wake?: () => void;
}

interface BodySession {
  cdp: CDPSession;
  entries: BodyEntry[];
}

const MAX_ENTRIES = 300;

export class DurableResponseBodies {
  private readonly sessions = new WeakMap<Page, Promise<BodySession | undefined>>();

  attach(page: Page): void {
    if (this.sessions.has(page)) return;
    this.sessions.set(page, this.open(page));
  }

  detach(page: Page): void {
    const session = this.sessions.get(page);
    this.sessions.delete(page);
    void session?.then((opened) => opened?.cdp.detach()).catch(() => undefined);
  }

  private async open(page: Page): Promise<BodySession | undefined> {
    try {
      const cdp = await page.context().newCDPSession(page);
      const entries: BodyEntry[] = [];
      const settle = (requestId: string): void => {
        const entry = entries.find((candidate) => candidate.id === requestId);
        if (!entry) return;
        entry.settled = true;
        entry.wake?.();
      };
      cdp.on(
        'Network.requestWillBeSent',
        (event: { requestId: string; type?: string; request: { method: string; url: string } }) => {
          if (event.type !== 'XHR' && event.type !== 'Fetch') return;
          entries.push({
            id: event.requestId,
            method: event.request.method,
            url: event.request.url,
            used: false,
            settled: false,
          });
          if (entries.length > MAX_ENTRIES) entries.shift();
        },
      );
      cdp.on('Network.loadingFinished', (event: { requestId: string }) => {
        settle(event.requestId);
      });
      cdp.on('Network.loadingFailed', (event: { requestId: string }) => {
        settle(event.requestId);
      });
      await cdp.send('Network.enable', {
        maxTotalBufferSize: 20_000_000,
        maxResourceBufferSize: 2_000_000,
        enableDurableMessages: true,
      });
      return { cdp, entries };
    } catch {
      return undefined;
    }
  }

  /** Le corps de la réponse de cette requête (la première non lue de même méthode et URL), ou rien. */
  async text(page: Page, method: string, url: string, timeoutMs = 2000): Promise<string | undefined> {
    const session = await this.sessions.get(page);
    if (!session) return undefined;
    const entry = session.entries.find(
      (candidate) => !candidate.used && candidate.method === method && candidate.url === url,
    );
    if (!entry) return undefined;
    entry.used = true;
    if (!entry.settled)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        entry.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    try {
      const body = await session.cdp.send('Network.getResponseBody', { requestId: entry.id });
      return body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
    } catch {
      return undefined;
    }
  }
}
