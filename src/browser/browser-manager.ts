import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
} from 'playwright';
import type { ScenarioConfig } from '../config/config.js';

/**
 * Possède le processus Chromium. Sans interface par défaut et réglé pour les
 * conteneurs : pas de GPU, pas de serveur d'affichage, aucun privilège
 * particulier. Playwright lance Chromium sans son sandbox par défaut, ce qui
 * permet de tourner avec un utilisateur non root quelconque (OpenShift) sans capacité supplémentaire.
 */
export class BrowserManager {
  private browser: Browser | undefined;
  private context: BrowserContext | undefined;

  constructor(private readonly options: ScenarioConfig['browser']) {}

  /** `extra` : options fixées par l'authentificateur (identifiants HTTP). */
  async start(extra: BrowserContextOptions = {}): Promise<BrowserContext> {
    this.browser = await chromium.launch({
      headless: this.options.headless,
      args: this.options.args,
      slowMo: this.options.slowMoMs,
    });
    this.context = await this.browser.newContext({
      viewport: this.options.viewport,
      ignoreHTTPSErrors: this.options.ignoreHttpsErrors,
      ...(this.options.locale ? { locale: this.options.locale } : {}),
      ...(this.options.userAgent ? { userAgent: this.options.userAgent } : {}),
      // Un téléchargement n'est jamais une page à explorer.
      acceptDownloads: false,
      ...extra,
    });
    // Les scripts de page sont sérialisés avec Function#toString. Quand le crawler passe par un
    // chargeur TypeScript qui garde les noms de fonction (tsx/esbuild), ces scripts appellent un
    // helper `__name` qui n'existe pas dans la page. On fournit un remplacement qui ne fait rien.
    await this.context.addInitScript({
      content:
        'if (typeof globalThis.__name !== "function") { globalThis.__name = function (fn) { return fn; }; }',
    });
    return this.context;
  }

  async newPage(): Promise<Page> {
    if (!this.context) throw new Error('BrowserManager.start() must be called first');
    return this.context.newPage();
  }

  /**
   * Une page dans un contexte SÉPARÉ du même navigateur (une autre fenêtre) : ni cookies, ni scripts,
   * ni écouteurs partagés avec le contexte de l'application (le panneau du recorder, jamais capturé).
   */
  async newIsolatedPage(options: BrowserContextOptions = {}): Promise<Page> {
    if (!this.browser) throw new Error('BrowserManager.start() must be called first');
    const context = await this.browser.newContext({ acceptDownloads: false, ...options });
    return context.newPage();
  }

  get browserVersion(): string | undefined {
    return this.browser?.version();
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.context = undefined;
    this.browser = undefined;
  }
}
