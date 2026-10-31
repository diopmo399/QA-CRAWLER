import { mkdir } from 'node:fs/promises';
import path from 'node:path';
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
  /** browser.playwrightTrace : la trace en cours, enregistrée à la fermeture du contexte de l'application. */
  private tracing = false;

  /**
   * `handleSIGINT: false` : l'appelant gère Ctrl+C (annulation contrôlée, RunOptions.signal) ; le
   * navigateur reste ouvert jusqu'à ce que le moteur s'arrête et le ferme lui-même.
   * `tracePath` : où enregistrer la trace Playwright quand browser.playwrightTrace est activé (sans lui, aucune trace).
   */
  constructor(
    private readonly options: ScenarioConfig['browser'],
    private readonly lifecycle: { handleSIGINT?: boolean; tracePath?: string } = {},
  ) {}

  /** `extra` : options fixées par l'authentificateur (identifiants HTTP). */
  async start(extra: BrowserContextOptions = {}): Promise<BrowserContext> {
    this.browser = await chromium.launch({
      headless: this.options.headless,
      args: this.options.args,
      slowMo: this.options.slowMoMs,
      handleSIGINT: this.lifecycle.handleSIGINT ?? true,
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
    if (this.options.playwrightTrace && this.lifecycle.tracePath) {
      await this.context.tracing.start({ screenshots: true, snapshots: true });
      this.tracing = true;
    }
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

  /**
   * Ferme la fenêtre de l'APPLICATION (son contexte et ses pages, popups comprises) ; le navigateur
   * et ses contextes isolés (la fenêtre du recorder) restent ouverts.
   */
  async closeApplication(): Promise<void> {
    await this.stopTracing();
    await this.context?.close().catch(() => undefined);
    this.context = undefined;
  }

  get browserVersion(): string | undefined {
    return this.browser?.version();
  }

  /** Enregistre la trace Playwright (une seule fois) ; un échec n'empêche jamais la fermeture. */
  private async stopTracing(): Promise<void> {
    if (!this.tracing || !this.context || !this.lifecycle.tracePath) return;
    this.tracing = false;
    const tracePath = this.lifecycle.tracePath;
    await mkdir(path.dirname(tracePath), { recursive: true })
      .then(() => this.context?.tracing.stop({ path: tracePath }))
      .catch(() => undefined);
  }

  async close(): Promise<void> {
    await this.stopTracing();
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.context = undefined;
    this.browser = undefined;
  }
}
