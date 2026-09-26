import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { ScenarioConfig } from '../config/config.js';

/**
 * Owns the Chromium process. Headless by default and tuned for containers:
 * no GPU, no display server, no special privileges. Playwright launches
 * Chromium without its sandbox by default, which is what allows running as
 * an arbitrary non-root user (OpenShift) without extra capabilities.
 */
export class BrowserManager {
  private browser: Browser | undefined;
  private context: BrowserContext | undefined;

  constructor(private readonly options: ScenarioConfig['browser']) {}

  async start(): Promise<BrowserContext> {
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
      // A download is never a page to crawl.
      acceptDownloads: false,
    });
    // Page scripts are serialized with Function#toString. When the crawler runs through a
    // TypeScript loader that keeps function names (tsx/esbuild), those scripts reference a
    // `__name` helper that does not exist in the page. Provide a no-op fallback.
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
