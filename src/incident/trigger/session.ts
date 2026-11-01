import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import { redactText } from '../../security/redactor.js';
import type {
  ElementState,
  RuntimeEvent,
  RuntimeEventKind,
  TriggerAction,
  UiSnapshot,
} from '../../sdk/core/incident-trigger-contracts.js';

/**
 * LA SESSION D'EXPLORATION : un navigateur Playwright piloté action par action, les capteurs installés AVANT
 * la première navigation (erreurs de page, console, requêtes, réponses, échecs, navigations, dialogues), une
 * chronologie horodatée bornée, des instantanés de l'interface (éléments interactifs : rôle, nom, activé,
 * visible, focus, valeur masquée ; overlays ; messages ; chargement). Aucune instrumentation n'est injectée
 * dans l'application : tout est observé de l'extérieur. Les données sont masquées, les volumes bornés.
 */
/** Les libellés d'un bouton qui ferme un dialogue (texte exact, insensible à la casse). */
const DIALOG_CLOSE_NAMES = /^(fermer|close|annuler|cancel|ok|retour|back|terminer|done|×|x)$/i;

export interface SessionOptions {
  baseUrl: string;
  /** Les hôtes où naviguer est permis (le Scope Policy Engine a déjà tranché) ; vide : l'hôte de baseUrl. */
  allowedHosts?: string[];
  maxEvents?: number;
  /** Délai d'une action (ms). */
  actionTimeoutMs?: number;
  /** Fenêtre d'observation après une sonde (ms) : le temps laissé à l'application pour réagir. */
  settleMs?: number;
  headless?: boolean;
  /** Les champs dont la valeur n'est jamais lue (libellés, insensible à la casse). */
  sensitiveFields?: readonly string[];
  screenshotDir?: string;
  now?: () => Date;
  /** Un navigateur déjà lancé (tests) ; sinon Chromium. */
  browser?: Browser;
}

export interface ActionOutcome {
  ok: boolean;
  /** L'action n'a pas pu être jouée (cible absente, délai) : une erreur d'infrastructure, pas un défaut applicatif. */
  error?: string;
  /** Les événements émis pendant l'action et la fenêtre d'observation. */
  events: RuntimeEvent[];
  before: UiSnapshot;
  after: UiSnapshot;
  durationMs: number;
}

const SENSITIVE_LABEL = /(mot de passe|password|passwd|secret|token|jeton|carte|card|iban|nas|ssn|cvv)/i;
const MAX_MESSAGES = 12;
const MAX_ELEMENTS = 80;
const MAX_TEXT = 300;
const LOADING_TEXT = /(chargement|loading|en cours|veuillez patienter|please wait|…)/i;

export class ExplorationSession {
  readonly events: RuntimeEvent[] = [];
  private browser: Browser | undefined;
  private ownsBrowser = false;
  private context: BrowserContext | undefined;
  private page: Page | undefined;
  private readonly startedAt: number;
  private counter = 0;
  private currentAction: number | undefined;
  private dropped = 0;
  private readonly allowedHosts: Set<string>;

  constructor(private readonly options: SessionOptions) {
    this.startedAt = (options.now?.() ?? new Date()).getTime();
    const hosts = new Set(options.allowedHosts ?? []);
    try {
      hosts.add(new URL(options.baseUrl).host);
    } catch {
      // une URL illisible n'ajoute aucun hôte
    }
    this.allowedHosts = hosts;
  }

  /** Lance le navigateur et installe les capteurs ; la page reste vierge (`about:blank`) jusqu'à `navigate`. */
  async open(): Promise<void> {
    if (this.options.browser) this.browser = this.options.browser;
    else {
      this.browser = await chromium.launch({ headless: this.options.headless ?? true, handleSIGINT: false });
      this.ownsBrowser = true;
    }
    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 800 },
      acceptDownloads: false,
    });
    this.page = await this.context.newPage();
    const page = this.page;
    page.setDefaultTimeout(this.options.actionTimeoutMs ?? 5000);
    page.on('pageerror', (error) => {
      this.record('PAGE_ERROR', redactText(error.message), {
        level: 'error',
        data: { name: error.name, stack: redactText(error.stack ?? '').slice(0, 2000) },
      });
    });
    page.on('console', (message) => {
      const type = message.type();
      if (type !== 'error' && type !== 'warning') return;
      this.record('CONSOLE', redactText(message.text()).slice(0, MAX_TEXT), {
        level: type === 'error' ? 'error' : 'warning',
        data: { type },
      });
    });
    page.on('request', (request) => {
      const type = request.resourceType();
      if (type !== 'xhr' && type !== 'fetch' && type !== 'document') return;
      this.record('REQUEST', `${request.method()} ${pathOf(request.url())}`, {
        data: { method: request.method(), path: pathOf(request.url()), resourceType: type },
      });
    });
    page.on('response', (response) => {
      const request = response.request();
      const type = request.resourceType();
      if (type !== 'xhr' && type !== 'fetch' && type !== 'document') return;
      this.record('RESPONSE', `${String(response.status())} ${request.method()} ${pathOf(response.url())}`, {
        level: response.status() >= 400 ? 'error' : 'info',
        data: { status: response.status(), method: request.method(), path: pathOf(response.url()) },
      });
    });
    page.on('requestfailed', (request) => {
      const type = request.resourceType();
      if (type !== 'xhr' && type !== 'fetch' && type !== 'document') return;
      this.record(
        'REQUEST_FAILED',
        `${request.method()} ${pathOf(request.url())} : ${request.failure()?.errorText ?? 'échec'}`,
        {
          level: 'error',
          data: { method: request.method(), path: pathOf(request.url()) },
        },
      );
    });
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      this.record('NAVIGATION', pathOf(frame.url()), { data: { path: pathOf(frame.url()) } });
    });
    page.on('dialog', (dialog) => {
      this.record('DIALOG', `${dialog.type()} : ${redactText(dialog.message()).slice(0, MAX_TEXT)}`);
      void dialog.dismiss().catch(() => undefined);
    });
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => undefined);
    if (this.ownsBrowser) await this.browser?.close().catch(() => undefined);
    this.context = undefined;
    this.page = undefined;
  }

  get droppedEvents(): number {
    return this.dropped;
  }

  /** Les événements depuis un repère (index dans `events`). */
  since(mark: number): RuntimeEvent[] {
    return this.events.slice(mark);
  }

  mark(): number {
    return this.events.length;
  }

  note(summary: string, data?: Record<string, unknown>): void {
    this.record('NOTE', summary, data ? { data } : {});
  }

  /** Joue une action, puis laisse l'application réagir (`settleMs`) ; rend ce qui a été observé. */
  async perform(action: TriggerAction, index: number): Promise<ActionOutcome> {
    const page = this.required();
    const started = Date.now();
    this.currentAction = index;
    const before = await this.snapshot();
    const mark = this.mark();
    this.record('ACTION', describeAction(action), { data: { kind: action.kind, target: action.target } });
    let error: string | undefined;
    try {
      await this.execute(page, action);
      await page.waitForTimeout(this.options.settleMs ?? 400);
      await page.waitForLoadState('domcontentloaded').catch(() => undefined);
    } catch (caught) {
      error = redactText(
        caught instanceof Error ? (caught.message.split('\n')[0] ?? caught.message) : String(caught),
      );
      this.record('NOTE', `action impossible : ${error}`, { level: 'warning' });
    }
    const after = await this.snapshot();
    this.currentAction = undefined;
    return {
      ok: error === undefined,
      ...(error ? { error } : {}),
      events: this.since(mark),
      before,
      after,
      durationMs: Date.now() - started,
    };
  }

  async screenshot(file: string): Promise<boolean> {
    const page = this.page;
    if (!page) return false;
    try {
      await page.screenshot({ path: file, fullPage: false });
      this.record('SCREENSHOT', file.split('/').at(-1) ?? file);
      return true;
    } catch {
      return false;
    }
  }

  /** L'instantané de l'interface : éléments interactifs, overlays, messages, chargement. Jamais une valeur sensible. */
  async snapshot(): Promise<UiSnapshot> {
    const page = this.page;
    const empty: UiSnapshot = { url: '', title: '', elements: [], overlays: 0, messages: [], loading: false };
    if (!page) return empty;
    try {
      const raw = await page.evaluate(
        ({ maxElements, maxMessages, sensitive }) => {
          const visible = (element: Element): boolean => {
            const style = window.getComputedStyle(element);
            if (style.display === 'none' || style.visibility === 'hidden') return false;
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          };
          const labelOf = (element: Element): string => {
            const aria = element.getAttribute('aria-label');
            if (aria) return aria;
            const id = element.getAttribute('id');
            if (id) {
              const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
              if (label?.textContent) return label.textContent.trim();
            }
            const wrapping = element.closest('label');
            if (wrapping) {
              // Le libellé sans le texte du contrôle lui-même (options d'une liste, contenu d'une zone de texte).
              const clone = wrapping.cloneNode(true) as HTMLElement;
              for (const inner of clone.querySelectorAll('select, textarea, input, option')) inner.remove();
              const text = clone.textContent.replace(/\s+/g, ' ').trim();
              if (text) return text;
            }
            const placeholder = element.getAttribute('placeholder');
            if (placeholder) return placeholder;
            return element.getAttribute('name') ?? '';
          };
          const elements: {
            key: string;
            role: string;
            name: string;
            enabled: boolean;
            visible: boolean;
            focused?: boolean;
            value?: string;
            invalid?: boolean;
            options?: string[];
          }[] = [];
          const seen = new Set<string>();
          const push = (role: string, name: string, element: Element, value?: string) => {
            const key = `${role}:${name}`;
            if (seen.has(key) || elements.length >= maxElements) return;
            seen.add(key);
            const disabled =
              (element as HTMLButtonElement).disabled ||
              element.getAttribute('aria-disabled') === 'true' ||
              element.hasAttribute('disabled');
            const entry: (typeof elements)[number] = {
              key,
              role,
              name,
              enabled: !disabled,
              visible: visible(element),
            };
            if (document.activeElement === element) entry.focused = true;
            if (value !== undefined) entry.value = value;
            if (element.getAttribute('aria-invalid') === 'true' || element.classList.contains('ng-invalid'))
              entry.invalid = true;
            elements.push(entry);
          };
          for (const element of document.querySelectorAll('button, [role="button"], input[type="submit"]'))
            push(
              'button',
              (element.textContent || element.getAttribute('aria-label') || '').trim().slice(0, 60),
              element,
            );
          for (const element of document.querySelectorAll('a[href], [role="link"]'))
            push('link', element.textContent.trim().slice(0, 60), element);
          for (const element of document.querySelectorAll('[role="tab"]'))
            push('tab', element.textContent.trim().slice(0, 60), element);
          for (const element of document.querySelectorAll(
            'input:not([type="submit"]):not([type="button"]):not([type="hidden"]), textarea, select',
          )) {
            const input = element as HTMLInputElement;
            const name = labelOf(element).slice(0, 60);
            const secret =
              input.type === 'password' || sensitive.some((pattern) => new RegExp(pattern, 'i').test(name));
            const role =
              element.tagName === 'SELECT' ? 'combobox' : input.type === 'checkbox' ? 'checkbox' : 'textbox';
            push(
              role,
              name,
              element,
              secret
                ? undefined
                : String(input.type === 'checkbox' ? input.checked : input.value).slice(0, 80),
            );
            if (element.tagName === 'SELECT') {
              const last = elements[elements.length - 1];
              if (last)
                last.options = Array.from((element as HTMLSelectElement).options)
                  .slice(0, 12)
                  .map((option) => option.label.slice(0, 40));
            }
          }
          const overlays = document.querySelectorAll(
            '[role="dialog"], dialog[open], .cdk-overlay-pane, .modal.show, [aria-modal="true"]',
          ).length;
          const messages: string[] = [];
          for (const element of document.querySelectorAll(
            '[role="alert"], [role="status"], .error, .alert, .mat-error, .invalid-feedback, [aria-live]',
          )) {
            const text = element.textContent.trim();
            if (text && visible(element) && messages.length < maxMessages) messages.push(text.slice(0, 160));
          }
          const loading = Boolean(
            document.querySelector(
              '[aria-busy="true"], .spinner, .loading, mat-progress-bar, mat-spinner, [role="progressbar"]',
            ) &&
            [
              ...document.querySelectorAll(
                '[aria-busy="true"], .spinner, .loading, mat-progress-bar, mat-spinner, [role="progressbar"]',
              ),
            ].some(visible),
          );
          return { url: location.href, title: document.title, elements, overlays, messages, loading };
        },
        {
          maxElements: MAX_ELEMENTS,
          maxMessages: MAX_MESSAGES,
          sensitive: [SENSITIVE_LABEL.source, ...(this.options.sensitiveFields ?? [])],
        },
      );
      const elements: ElementState[] = raw.elements.map((element) => ({
        ...element,
        ...(element.value !== undefined ? { value: redactText(element.value) } : {}),
        ...(element.options ? { options: element.options.map((option) => redactText(option)) } : {}),
      }));
      const loading = raw.loading || raw.messages.some((message) => LOADING_TEXT.test(message));
      return {
        url: pathOf(raw.url),
        title: raw.title.slice(0, 120),
        elements,
        overlays: raw.overlays,
        messages: raw.messages.map((text) => redactText(text)),
        loading,
      };
    } catch {
      return empty;
    }
  }

  private async execute(page: Page, action: TriggerAction): Promise<void> {
    switch (action.kind) {
      case 'NAVIGATE': {
        const url = new URL(action.target ?? '/', this.options.baseUrl);
        if (!this.allowedHosts.has(url.host))
          throw new Error(`navigation refusée hors des hôtes permis : ${url.host}`);
        await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
        return;
      }
      case 'BACK':
        await page.goBack({ waitUntil: 'domcontentloaded' });
        return;
      case 'RELOAD':
        await page.reload({ waitUntil: 'domcontentloaded' });
        return;
      case 'CLICK':
      case 'OPEN_DIALOG':
      case 'TAB':
        await (await this.locate(page, action.target ?? '')).click();
        return;
      case 'CLOSE_DIALOG': {
        if (action.target) {
          await (await this.locate(page, action.target)).click();
          return;
        }
        // Un bouton de fermeture dans le dialogue ouvert, sinon la touche Échap.
        const closer = page
          .locator('[role="dialog"], dialog[open], .cdk-overlay-pane, .modal.show, [aria-modal="true"]')
          .last()
          .getByRole('button', { name: DIALOG_CLOSE_NAMES });
        if ((await closer.count()) > 0) {
          const name = ((await closer.first().textContent()) ?? '').trim().slice(0, 40);
          await closer.first().click();
          this.note(`dialogue fermé par le bouton « ${name} »`, { closedWith: name });
          return;
        }
        await page.keyboard.press('Escape');
        return;
      }
      case 'FILL':
        await (await this.locate(page, action.target ?? '')).fill(action.value ?? '');
        return;
      case 'CLEAR':
        await (await this.locate(page, action.target ?? '')).fill('');
        return;
      case 'SELECT':
        await (await this.locate(page, action.target ?? '')).selectOption({ label: action.value ?? '' });
        return;
      case 'CHECK': {
        const locator = await this.locate(page, action.target ?? '');
        if (action.value === 'false') await locator.uncheck();
        else await locator.check();
        return;
      }
      case 'PRESS':
        await page.keyboard.press(action.value ?? 'Enter');
        return;
      case 'WAIT':
        await page.waitForTimeout(Math.min(action.count ?? 500, 10_000));
        return;
      case 'REPEAT':
        for (let index = 0; index < Math.min(action.count ?? 2, 10); index += 1)
          await (await this.locate(page, action.target ?? '')).click({ delay: 10 });
        return;
    }
  }

  /** Une cible « role:Nom », « label:Libellé », « text:Texte » ou « testid:id » ; rôle et nom exacts d'abord. */
  private async locate(page: Page, target: string): Promise<Locator> {
    const separator = target.indexOf(':');
    const kind = separator > 0 ? target.slice(0, separator) : 'text';
    const name = separator > 0 ? target.slice(separator + 1) : target;
    switch (kind) {
      case 'label': {
        // Le libellé exact d'abord ; sinon le libellé qui commence par ce texte (une liste dont le <label>
        // englobe aussi les options a un nom accessible plus long que son libellé visible).
        const exact = page.getByLabel(name, { exact: true });
        if ((await exact.count()) > 0) return exact.first();
        return page.getByLabel(new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`)).first();
      }
      case 'text':
        return page.getByText(name, { exact: true }).first();
      case 'testid':
        return page.getByTestId(name).first();
      case 'css':
        return page.locator(name).first();
      default:
        return page.getByRole(kind as 'button', { name, exact: true }).first();
    }
  }

  private required(): Page {
    if (!this.page) throw new Error('session not open');
    return this.page;
  }

  private record(
    kind: RuntimeEventKind,
    summary: string,
    extra: { level?: RuntimeEvent['level']; data?: Record<string, unknown> } = {},
  ): void {
    const max = this.options.maxEvents ?? 5000;
    if (this.events.length >= max) {
      this.dropped += 1;
      return;
    }
    this.counter += 1;
    const now = this.options.now?.() ?? new Date();
    this.events.push({
      id: `ev-${String(this.counter)}`,
      t: now.getTime() - this.startedAt,
      at: now.toISOString(),
      kind,
      ...(this.currentAction !== undefined ? { action: this.currentAction } : {}),
      summary: summary.slice(0, MAX_TEXT),
      ...(extra.level ? { level: extra.level } : {}),
      ...(extra.data ? { data: extra.data } : {}),
    });
  }
}

export function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search ? '?' + redactText(parsed.search) : ''}`;
  } catch {
    return url;
  }
}

export function describeAction(action: TriggerAction): string {
  // Le libellé visible plutôt que la stratégie de localisation (« Code », pas « label:Code ») ; une URL reste entière.
  const target = (action.target ?? '').replace(/^(button|tab|link|label|text|testid|css|role):/, '');
  switch (action.kind) {
    case 'NAVIGATE':
      return `naviguer vers ${target}`;
    case 'BACK':
      return 'revenir en arrière';
    case 'RELOAD':
      return 'recharger la page';
    case 'CLICK':
      return `cliquer ${target}`;
    case 'OPEN_DIALOG':
      return `ouvrir le dialogue ${target}`;
    case 'CLOSE_DIALOG':
      return `fermer le dialogue ${target}`;
    case 'TAB':
      return `changer d'onglet ${target}`;
    case 'FILL':
      return `saisir ${target} = ${action.value === undefined ? '' : redactText(action.value).slice(0, 40) || '«vide»'}`;
    case 'CLEAR':
      return `effacer ${target}`;
    case 'SELECT':
      return `choisir ${target} = ${action.value ?? ''}`;
    case 'CHECK':
      return `${action.value === 'false' ? 'décocher' : 'cocher'} ${target}`;
    case 'PRESS':
      return `touche ${action.value ?? 'Enter'}`;
    case 'WAIT':
      return `attendre ${String(action.count ?? 500)} ms`;
    case 'REPEAT':
      return `répéter ${String(action.count ?? 2)}× ${target}`;
  }
}

/** La clé stable d'une séquence (même actions, mêmes cibles, mêmes valeurs) : une séquence n'est jouée qu'une fois. */
export function sequenceKey(actions: readonly TriggerAction[]): string {
  return actions
    .map(
      (action) => `${action.kind}|${action.target ?? ''}|${action.value ?? ''}|${String(action.count ?? '')}`,
    )
    .join('→');
}
