import { sectionPathOf } from './semantic-dom.js';

/**
 * Le script injecté dans chaque page pendant un enregistrement. Il s'exécute dans le
 * navigateur (sérialisé) : autonome, aucun import.
 *
 * PASSIF : des écouteurs en phase de capture, passive, jamais de preventDefault, aucune
 * requête interceptée ; l'application ne voit aucune différence. Les mouvements de souris
 * et le défilement ne sont pas écoutés (un glisser-déposer : l'appui et le relâchement seulement).
 *
 * D'une valeur tapée : sa forme (vide, longueur, email / nombre / date…) et une empreinte
 * salée ; avec recordValues (recording.testData), aussi le texte d'un champ NON sensible,
 * pour en faire une donnée de test (jamais écrit dans la trace brute). Un champ sensible
 * (mot de passe, code à usage unique, carte) n'envoie ni texte ni empreinte. Une option
 * choisie (texte de l'interface) et l'extension d'un fichier choisi sont gardées.
 *
 * Le bandeau « ● RECORDING » vit dans un shadow root fermé sous un hôte marqué
 * data-qa-crawler-overlay : exclu de la capture, de l'observation de l'écran et des captures.
 */
export interface CaptureOptions {
  /** Nom de la fonction exposée par Playwright (context.exposeBinding). */
  binding: string;
  /** Sel de la session : les empreintes ne se comparent qu'entre événements d'un même enregistrement. */
  salt: string;
  overlay: boolean;
  /** Délai (ms) avant d'envoyer une saisie en cours (les touches ne sont jamais envoyées une à une). */
  inputDebounceMs: number;
  /** Envoyer le texte saisi d'un champ non sensible (données de test) ; jamais pour un champ sensible. */
  recordValues?: boolean;
  /** Longueur maximale d'un texte envoyé (au-delà : seulement sa forme). */
  maxValueLength?: number;
}

export const OVERLAY_ATTRIBUTE = 'data-qa-crawler-overlay';

export function installRecorder(
  options: CaptureOptions,
  /** sectionPathOf (semantic-dom) : le même chemin de sections qu'au rejeu. */
  sectionOf: (el: Element) => string[] = () => [],
): void {
  const global = window as unknown as Record<string, unknown>;
  if (global.__qaCrawlerRecorderInstalled === true) return;
  global.__qaCrawlerRecorderInstalled = true;
  // Les cadres (iframes) ne sont pas enregistrés : seulement la page principale.
  if (window.top !== window) return;

  const OVERLAY = 'data-qa-crawler-overlay';
  const CANDIDATES =
    'a[href], button, summary, input:not([type="hidden"]), select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="switch"], [role="checkbox"], [role="radio"], [role="option"], [role="combobox"], [routerlink], [contenteditable]:not([contenteditable="false"]), mat-select, [onclick]';
  const FIELD =
    'input:not([type="hidden"]), select, textarea, [contenteditable]:not([contenteditable="false"])';
  const SENSITIVE_WORDS =
    /(pass(word|wd|e)?\b|pwd|mot.?de.?passe|token|\botp\b|\bpin\b|cvv|cvc|secret|api.?key|card.?number|num[ée]ro.?de.?carte|security.?code)/i;
  let paused = false;
  let sequence = 0;
  const queue: unknown[] = [];

  // L'ÉLÉMENT ORIGINAL de chaque action (validation immédiate de la cible) : une référence en
  // mémoire, bornée, jamais envoyée ni écrite dans le DOM. Le validateur la LIT seulement.
  const documentId = Math.random().toString(36).slice(2, 10);
  const originals = new Map<string, Element>();
  global.__qaCrawlerOriginal = (ref: unknown): Element | null =>
    typeof ref === 'string' ? (originals.get(ref) ?? null) : null;
  const send = (payload: Record<string, unknown>, original?: Element | null, zone?: Element | null): void => {
    if (paused && payload.type !== 'control') return;
    sequence += 1;
    let ref: string | undefined;
    if (original) {
      ref = `${documentId}:${String(sequence)}`;
      originals.set(ref, original);
      if (zone) originals.set(`${ref}:zone`, zone);
      while (originals.size > 120) {
        const oldest = originals.keys().next().value;
        if (oldest === undefined) break;
        originals.delete(oldest);
      }
    }
    const message = { ...payload, sequence, at: Date.now(), url: location.href, ...(ref ? { ref } : {}) };
    const fn = global[options.binding];
    if (typeof fn !== 'function') {
      if (queue.length < 200) queue.push(message);
      return;
    }
    while (queue.length > 0) {
      const waiting = queue.shift();
      (fn as (value: unknown) => Promise<unknown>)(waiting).catch(() => undefined);
    }
    (fn as (value: unknown) => Promise<unknown>)(message).catch(() => undefined);
  };

  const clean = (value: string | null | undefined, max = 120): string =>
    (value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const stripMark = (value: string): string => value.replace(/[*:\s]+$/, '').trim();
  const digestOf = (value: string): string | undefined => {
    if (value.trim() === '') return undefined;
    const text = `${options.salt}\u0000${value.trim()}`;
    let a = 0x811c9dc5;
    let b = 0x01000193 ^ 0x5bd1e995;
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      a = Math.imul(a ^ code, 0x01000193) >>> 0;
      b = Math.imul(b ^ code, 0x01000193) >>> 0;
    }
    return `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`;
  };
  const isOverlay = (event: Event): boolean =>
    event.composedPath().some((node) => node instanceof Element && node.hasAttribute(OVERLAY));
  /**
   * L'élément d'origine de l'événement, MÊME dans un shadow DOM : vu du document, un clic dans un
   * web component est « retargeté » sur l'hôte (sans texte, souvent un conteneur) ; le chemin
   * composé garde le vrai bouton, le vrai champ.
   */
  const originOf = (event: Event): Element | null => {
    const first = event.composedPath().find((node) => node instanceof Element);
    return first instanceof Element ? first : event.target instanceof Element ? event.target : null;
  };
  /** Le premier élément du chemin composé (du plus interne au plus externe) qui correspond. */
  const inPath = (event: Event, test: (el: Element) => boolean): Element | null => {
    for (const node of event.composedPath()) {
      if (!(node instanceof Element) || node === document.body || node === document.documentElement) break;
      if (test(node)) return node;
    }
    return null;
  };
  /** Le composant maison (balise avec tiret) le plus proche, à travers les shadow roots. */
  const componentOf = (event: Event): string | undefined =>
    inPath(event, (el) => el.tagName.includes('-'))?.tagName.toLowerCase();
  const isVisible = (el: Element): boolean => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  };
  const textOf = (el: Element | null | undefined): string =>
    el ? clean((el as HTMLElement).innerText || el.textContent || el.shadowRoot?.textContent) : '';
  /** Le titre de la section qui contient l'élément (contexte de l'empreinte, jamais une valeur). */
  const contextOf = (el: Element): string => {
    const section = el.closest(
      'section, fieldset, form, [role="region"], [role="tabpanel"], [role="dialog"], mat-expansion-panel, mat-card, article',
    );
    if (!section) return '';
    const heading =
      section.getAttribute('aria-label') ??
      textOf(
        section.querySelector('legend, h1, h2, h3, h4, [role="heading"], mat-panel-title, mat-card-title'),
      );
    return clean(heading, 60);
  };

  const roleOf = (el: Element): string => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.split(' ')[0] ?? '';
    const tag = el.tagName.toLowerCase();
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return (el as HTMLSelectElement).multiple ? 'listbox' : 'combobox';
    if (tag === 'mat-select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'option') return 'option';
    if (tag === 'input') {
      const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'number') return 'spinbutton';
      if (type === 'range') return 'slider';
      if (type === 'file') return '';
      return el.hasAttribute('list') ? 'combobox' : 'textbox';
    }
    if ((el as HTMLElement).isContentEditable) return 'textbox';
    return '';
  };

  const labelOf = (el: Element): string => {
    const labelled = el.getAttribute('aria-labelledby');
    if (labelled) {
      const text = labelled
        .split(/\s+/)
        .map((id) => textOf(document.getElementById(id)))
        .join(' ');
      if (clean(text)) return stripMark(clean(text));
    }
    // Le texte d'un <label> SANS les contrôles qu'il contient (les options d'un <select> enveloppé
    // ne font pas partie du libellé : « Field », pas « Field -- Company name City »).
    const labelText = (label: Element): string => {
      if (!label.querySelector('select, textarea, input, option')) return textOf(label);
      const copy = label.cloneNode(true) as Element;
      for (const control of Array.from(copy.querySelectorAll('select, textarea, input, option')))
        control.remove();
      return clean(copy.textContent);
    };
    const labels = (el as HTMLInputElement).labels;
    if (labels?.[0]) return stripMark(labelText(labels[0]));
    const wrapping = el.closest('label');
    if (wrapping) return stripMark(labelText(wrapping));
    const field = el.closest('mat-form-field, .mat-mdc-form-field');
    const matLabel = field?.querySelector('mat-label, label');
    if (matLabel) return stripMark(textOf(matLabel));
    const aria = el.getAttribute('aria-label');
    if (aria) return stripMark(clean(aria));
    return '';
  };

  /**
   * Un champ sans libellé relié (pas de <label>, ni aria-label) : le texte posé juste avant lui
   * (« Code agence » au-dessus), comme l'UIObserver le devine — l'intention le retrouvera au rejeu.
   */
  const guessLabel = (el: Element): string => {
    let node: Element = el;
    for (let depth = 0; depth < 4; depth += 1) {
      for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
        if (sibling.matches(FIELD) || sibling.querySelector(FIELD)) return '';
        if (!isVisible(sibling)) continue;
        const text = clean(textOf(sibling), 61)
          .replace(/^\*\s*/, '')
          .replace(/\s*\*$/, '');
        if (text) return text.length <= 60 ? stripMark(text) : '';
      }
      const parent: Element | null = node.parentElement;
      if (!parent || parent === document.body || parent.querySelectorAll(FIELD).length > 1) break;
      node = parent;
    }
    return '';
  };

  const nameOf = (el: Element): string => {
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    const role = roleOf(el);
    if (
      ['textbox', 'combobox', 'checkbox', 'radio', 'spinbutton', 'listbox', 'slider', 'switch'].includes(role)
    ) {
      const label = labelOf(el);
      if (label) return label;
    }
    if (el instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(el.type))
      return clean(el.value);
    const text = textOf(el);
    if (text) return text;
    const title = el.getAttribute('title');
    if (title) return clean(title);
    const img = el.querySelector('img[alt]');
    if (img) return clean(img.getAttribute('alt'));
    return clean(el.getAttribute('placeholder'));
  };

  const generatedId = (id: string): boolean =>
    /\d/.test(id) ||
    /^(mat|cdk|ng|ion|mui|react|ember|radix|headlessui)[-_:]/i.test(id) ||
    id.startsWith(':');
  const escape = (value: string): string =>
    typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(value)
      : value.replace(/"/g, '\\"');

  /** CSS d'un élément ; dans un shadow DOM, préfixé par l'hôte (Playwright traverse les shadow roots ouverts). */
  const cssOf = (el: Element): { css: string; stable: boolean } => {
    const root = el.getRootNode();
    const inner = localCss(el);
    if (typeof ShadowRoot !== 'undefined' && root instanceof ShadowRoot) {
      const host = cssOf(root.host);
      return { css: `${host.css} ${inner.css}`, stable: host.stable && inner.stable };
    }
    return inner;
  };
  const localCss = (el: Element): { css: string; stable: boolean } => {
    const tag = el.tagName.toLowerCase();
    const testId = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy']
      .map((name) => [name, el.getAttribute(name)] as const)
      .find(([, value]) => value);
    if (testId) return { css: `[${testId[0]}="${testId[1] ?? ''}"]`, stable: true };
    const id = el.getAttribute('id');
    if (id && !generatedId(id)) return { css: `#${escape(id)}`, stable: true };
    const name = el.getAttribute('name');
    if (name && !/\d{2,}/.test(name)) return { css: `${tag}[name="${name}"]`, stable: true };
    const control = el.getAttribute('formcontrolname');
    if (control) return { css: `[formcontrolname="${control}"]`, stable: true };
    // Dernier recours : un chemin de positions, fragile (signalé comme tel).
    const parts: string[] = [];
    let node: Element | null = el;
    for (let depth = 0; node && node !== document.body && depth < 5; depth += 1) {
      const parent: Element | null = node.parentElement;
      // Un composant maison (balise à tiret) est une ancre plus stable qu'une position.
      if (depth > 0 && node.tagName.includes('-') && !parts.some((part) => part.includes('-'))) {
        parts.unshift(node.tagName.toLowerCase());
        break;
      }
      const nodeTag = node.tagName;
      const same = parent ? Array.from(parent.children).filter((child) => child.tagName === nodeTag) : [];
      const position = same.length > 1 ? `:nth-of-type(${String(same.indexOf(node) + 1)})` : '';
      parts.unshift(`${nodeTag.toLowerCase()}${position}`);
      node = parent;
    }
    return { css: parts.join(' > '), stable: false };
  };

  const sensitiveField = (el: Element): boolean => {
    const input = el as HTMLInputElement;
    if (input.type === 'password') return true;
    const autocomplete = (el.getAttribute('autocomplete') ?? '').toLowerCase();
    if (/password|one-time-code|cc-/.test(autocomplete)) return true;
    const words = [
      el.getAttribute('name'),
      el.getAttribute('id'),
      labelOf(el),
      el.getAttribute('placeholder'),
    ]
      .filter(Boolean)
      .join(' ');
    return SENSITIVE_WORDS.test(words);
  };

  const describe = (el: Element): Record<string, unknown> => {
    const role = roleOf(el);
    const name = nameOf(el);
    const label = labelOf(el);
    const tag = el.tagName.toLowerCase();
    const guessed = !label && !name && el.matches(FIELD) ? guessLabel(el) : '';
    const input = el as HTMLInputElement;
    const { css, stable } = cssOf(el);
    const id = el.getAttribute('id') ?? undefined;
    let sameRoleName = 0;
    let roleNameIndex = 0;
    let sameLabel = 0;
    // Comme Playwright sans exact : un nom qui CONTIENT celui-ci (sans la casse) correspond aussi.
    const lowerName = name.toLowerCase();
    const lowerLabel = label.toLowerCase();
    for (const candidate of Array.from(document.querySelectorAll(CANDIDATES))) {
      if (candidate.closest(`[${OVERLAY}]`) || (!isVisible(candidate) && candidate !== el)) continue;
      if (
        role &&
        lowerName &&
        roleOf(candidate) === role &&
        nameOf(candidate).toLowerCase().includes(lowerName)
      ) {
        if (candidate === el) roleNameIndex = sameRoleName;
        sameRoleName += 1;
      }
      if (lowerLabel && candidate.matches(FIELD) && labelOf(candidate).toLowerCase().includes(lowerLabel))
        sameLabel += 1;
    }
    const dialog = el.closest(
      '[role="dialog"], [role="alertdialog"], dialog, [aria-modal="true"], mat-dialog-container',
    );
    const group = el.closest('fieldset, [role="radiogroup"], [role="group"]');
    const groupLabel = group
      ? clean(group.querySelector('legend')?.textContent ?? group.getAttribute('aria-label'))
      : '';
    const form = el.closest('form');
    const type = tag === 'input' ? (input.type || 'text').toLowerCase() : undefined;
    const isSubmit =
      (tag === 'button' &&
        form !== null &&
        (el.getAttribute('type') ?? 'submit').toLowerCase() === 'submit') ||
      (tag === 'input' && (type === 'submit' || type === 'image'));
    const testIdEntry = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy']
      .map((attribute) => [attribute, el.getAttribute(attribute)] as const)
      .find(([, value]) => value);
    const testId = testIdEntry?.[1];
    // L'IDENTITÉ CONTEXTUELLE : le chemin de sections (« Colonnes > Colonnes disponibles »), le même
    // qu'au rejeu ; deux champs identiques de sections différentes ne se confondent pas.
    const sectionPath = sectionOf(el);
    const context = sectionPath.at(-1) ?? contextOf(el);
    const humanLabel = label || guessed || clean(el.getAttribute('placeholder'));
    let sameLabelInSection = 0;
    if (humanLabel && el.matches(FIELD)) {
      const section = sectionPath.join(' > ');
      for (const candidate of Array.from(document.querySelectorAll(FIELD))) {
        if (candidate.closest(`[${OVERLAY}]`) || (!isVisible(candidate) && candidate !== el)) continue;
        const other =
          labelOf(candidate) || guessLabel(candidate) || clean(candidate.getAttribute('placeholder'));
        if (other.toLowerCase() === humanLabel.toLowerCase() && sectionOf(candidate).join(' > ') === section)
          sameLabelInSection += 1;
      }
    }
    return {
      tag,
      role,
      name,
      ...(context && context !== name ? { context } : {}),
      ...(sectionPath.length > 0 ? { sectionPath } : {}),
      ...(sameLabelInSection > 0 ? { sameLabelInSection } : {}),
      ...(typeof ShadowRoot !== 'undefined' && el.getRootNode() instanceof ShadowRoot
        ? { inShadow: true }
        : {}),
      ...(textOf(el) && tag !== 'select' ? { text: textOf(el).slice(0, 80) } : {}),
      ...(label ? { label } : {}),
      ...(guessed ? { guessedLabel: guessed } : {}),
      ...(testIdEntry ? { testId, testIdAttribute: testIdEntry[0] } : {}),
      ...(el.getAttribute('name') ? { nameAttr: el.getAttribute('name') } : {}),
      ...((el.getAttribute('formcontrolname') ?? el.getAttribute('ng-reflect-name'))
        ? { formControlName: el.getAttribute('formcontrolname') ?? el.getAttribute('ng-reflect-name') }
        : {}),
      ...(id ? { elementId: id, generatedId: generatedId(id) } : {}),
      ...(type ? { inputType: type } : {}),
      ...(el.getAttribute('autocomplete') ? { autocomplete: el.getAttribute('autocomplete') } : {}),
      ...(el.getAttribute('placeholder') ? { placeholder: clean(el.getAttribute('placeholder')) } : {}),
      ...(el.getAttribute('href') ? { href: (el as HTMLAnchorElement).href } : {}),
      css,
      cssStable: stable,
      inForm: form !== null,
      isSubmit,
      inNavigation:
        el.closest('nav, [role="navigation"], [role="menu"], [role="menubar"], [role="tablist"]') !== null,
      inDialog: dialog !== null,
      ...(dialog
        ? {
            dialogName: clean(
              dialog.getAttribute('aria-label') ??
                textOf(dialog.querySelector('h1, h2, h3, [role="heading"]')),
              80,
            ),
          }
        : {}),
      ...(groupLabel ? { groupLabel } : {}),
      sameRoleName,
      roleNameIndex,
      sameLabel,
      ...((el as HTMLElement).isContentEditable ? { contentEditable: true } : {}),
      ...(tag === 'mat-select' || (role === 'combobox' && tag !== 'select' && tag !== 'input')
        ? { customSelect: true }
        : {}),
      ...(input.required || el.getAttribute('aria-required') === 'true' ? { required: true } : {}),
      ...(input.readOnly || el.getAttribute('aria-readonly') === 'true' ? { readOnly: true } : {}),
      ...(tag === 'select' || el.hasAttribute('list') ? { hasOptions: true } : {}),
    };
  };

  const shapeOf = (value: string): string => {
    const text = value.trim();
    if (text === '') return 'empty';
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return 'email';
    if (/^-?\d+([.,]\d+)?$/.test(text)) return 'number';
    if (/^\d{4}-\d{2}-\d{2}/.test(text) || /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/.test(text)) return 'date';
    if (/^\+?[\d\s().-]{7,}$/.test(text)) return 'phone';
    if (/^https?:\/\//i.test(text)) return 'url';
    if (/^[A-Z][A-Z0-9_]{1,40}$/.test(text)) return 'code';
    return 'text';
  };

  const initial = new WeakMap<Element, string | undefined>();
  /** Début de la saisie dans un champ : l'ordre des étapes suit l'humain, pas le moment où le champ est quitté. */
  const started = new WeakMap<Element, number>();
  const currentValue = (el: Element): string => {
    if ((el as HTMLElement).isContentEditable) return (el as HTMLElement).innerText;
    const value: unknown = (el as HTMLInputElement).value;
    return typeof value === 'string' ? value : '';
  };

  const valueFacts = (el: Element): Record<string, unknown> => {
    const tag = el.tagName.toLowerCase();
    const input = el as HTMLInputElement;
    if (tag === 'select') {
      const select = el as HTMLSelectElement;
      const option = select.selectedOptions[0];
      return {
        empty: !option || select.value === '',
        length: 0,
        shape: 'text',
        ...(option ? { option: { label: clean(option.text), value: select.value } } : {}),
      };
    }
    if (tag === 'input' && (input.type === 'checkbox' || input.type === 'radio')) {
      return {
        empty: false,
        length: 0,
        shape: 'text',
        checked: input.checked,
        ...(input.type === 'radio'
          ? { option: { label: labelOf(el) || clean(input.value), value: input.value } }
          : {}),
      };
    }
    if (tag === 'input' && input.type === 'file') {
      const files = Array.from(input.files ?? []).map((file) => {
        const match = /\.([A-Za-z0-9]{1,8})$/.exec(file.name);
        return match?.[1] ? match[1].toLowerCase() : '';
      });
      return { empty: files.length === 0, length: files.length, shape: 'text', files };
    }
    const value = currentValue(el);
    const sensitive = sensitiveField(el);
    const digest = sensitive ? undefined : digestOf(value);
    const start = initial.get(el);
    const begin = started.get(el);
    return {
      ...(begin !== undefined ? { startedAt: begin } : {}),
      empty: value.trim() === '',
      length: value.length,
      shape: sensitive ? (value.trim() === '' ? 'empty' : 'text') : shapeOf(value),
      ...(digest ? { digest } : {}),
      ...(!sensitive && start ? { initialDigest: start } : {}),
      ...(sensitive ? { sensitive: true } : {}),
      ...(!sensitive &&
      options.recordValues === true &&
      value.trim() !== '' &&
      value.length <= (options.maxValueLength ?? 500)
        ? { text: value }
        : {}),
    };
  };

  const INTERACTIVE_HINT_ATTRIBUTES = [
    'aria-expanded',
    'aria-controls',
    'aria-pressed',
    'aria-selected',
    'aria-haspopup',
    'data-toggle',
    'data-bs-toggle',
    'jsaction',
  ];
  const INTERACTIVE_HINT_CLASS =
    /(^|[\s_-])(btn|button|clickable|accordion|expansion-panel-header|panel-header|step-header|stepper-header|toggle)($|[\s_-])/i;
  /**
   * La cible fonctionnelle d'un clic hors des contrôles reconnus : l'élément le plus INTERNE du
   * chemin composé qui porte une preuve d'interactivité (onclick, tabindex, attributs et classes
   * de composant) ; à défaut, celui qui DÉFINIT le curseur « main » (pas un grand conteneur qui en
   * hérite). Jamais l'hôte d'un web component quand un élément interne convient.
   */
  const functionalTarget = (event: Event): Element | null => {
    const path = event.composedPath().filter((node): node is Element => node instanceof Element);
    const viewport = window.innerWidth * window.innerHeight;
    const reasonable = (node: Element): boolean => {
      const box = node.getBoundingClientRect();
      return box.width * box.height <= viewport * 0.4 && clean(textOf(node), 400).length <= 160;
    };
    for (const node of path) {
      if (node === document.body || node === document.documentElement) break;
      const tabindex = node.getAttribute('tabindex');
      if (
        (node.hasAttribute('onclick') ||
          (tabindex !== null && Number(tabindex) >= 0) ||
          INTERACTIVE_HINT_ATTRIBUTES.some((name) => node.hasAttribute(name)) ||
          INTERACTIVE_HINT_CLASS.test(typeof node.className === 'string' ? node.className : '')) &&
        reasonable(node)
      )
        return node;
    }
    for (const node of path) {
      if (node === document.body || node === document.documentElement) break;
      const parent =
        node.parentElement ??
        (node.getRootNode() as ShadowRoot | (Document & { host?: Element })).host ??
        null;
      if (
        getComputedStyle(node).cursor === 'pointer' &&
        (!parent || getComputedStyle(parent).cursor !== 'pointer') &&
        reasonable(node)
      )
        return node;
    }
    return null;
  };

  // ---- focus : la valeur trouvée en entrant dans le champ (empreinte), pour reconnaître une valeur inchangée.
  document.addEventListener(
    'focusin',
    (event) => {
      if (isOverlay(event)) return;
      const el = originOf(event);
      if (!el || !el.matches(FIELD) || initial.has(el)) return;
      initial.set(el, sensitiveField(el) ? undefined : digestOf(currentValue(el)));
    },
    { capture: true, passive: true },
  );

  // ---- glisser-déposer : pointeur (CDK, implémentations maison) ou HTML5 (draggable), corrélés en
  // UNE action humaine. L'élément est décrit au départ (avant que l'application ne le déplace) ;
  // les éléments des deux zones sont relus après le dépôt : déplacé ou non (ITEM_MOVED).
  const DRAG_ITEM =
    '[draggable="true"], [cdkdrag], .cdk-drag, [role="option"], [role="listitem"], [role="row"], li, [role="treeitem"]';
  const DROP_ZONE =
    '[cdkdroplist], .cdk-drop-list, [role="list"], [role="listbox"], [role="tree"], ul, ol, [aria-dropeffect], [data-drop-zone], tbody';
  const itemTexts = (zone: Element | null): string[] => {
    if (!zone) return [];
    const found = Array.from(zone.querySelectorAll(DRAG_ITEM)).filter(
      (el) => !el.classList.contains('cdk-drag-placeholder') && !el.classList.contains('cdk-drag-preview'),
    );
    return found
      .filter((el) => !found.some((other) => other !== el && el.contains(other)))
      .map((el) => clean((el as HTMLElement).innerText || el.textContent, 60))
      .slice(0, 30);
  };
  const zoneFacts = (zone: Element | null): Record<string, unknown> | undefined => {
    if (!zone) return undefined;
    const path = sectionOf(zone);
    const label = clean(zone.getAttribute('aria-label'), 60);
    return { ...(path.length > 0 ? { section: path.join(' > ') } : {}), ...(label ? { label } : {}) };
  };
  let dragging:
    | {
        item: Element;
        text: string;
        element: Record<string, unknown>;
        source: Element | null;
        x: number;
        y: number;
        kind: 'HTML5' | 'POINTER';
        drop?: Element | null;
      }
    | undefined;
  let lastDragAt = 0;
  const startDrag = (event: Event, kind: 'HTML5' | 'POINTER', x: number, y: number): void => {
    if (isOverlay(event) || !event.isTrusted) return;
    const item = inPath(event, (node) => node.matches(DRAG_ITEM));
    if (!item) {
      dragging = undefined;
      return;
    }
    dragging = {
      item,
      text: clean((item as HTMLElement).innerText || item.textContent, 60),
      element: describe(item),
      source: item.parentElement?.closest(DROP_ZONE) ?? null,
      x,
      y,
      kind,
    };
  };
  const finishDrag = (x: number, y: number, zone: Element | null): void => {
    const current = dragging;
    dragging = undefined;
    if (!current) return;
    // Un appui sans déplacement est un clic, pas un glisser.
    if (current.kind === 'POINTER' && Math.hypot(x - current.x, y - current.y) < 10) return;
    lastDragAt = Date.now();
    const destination = zone ?? current.drop ?? null;
    window.setTimeout(() => {
      const norm = (text: string): string => text.toLowerCase();
      const inDestination = itemTexts(destination).map(norm).includes(norm(current.text));
      const inSource =
        current.source !== destination && itemTexts(current.source).map(norm).includes(norm(current.text));
      const from = zoneFacts(current.source);
      const to = zoneFacts(destination);
      send(
        {
          type: 'drag',
          element: current.element,
          drag: {
            kind: current.kind,
            item: current.text,
            ...(from ? { source: from } : {}),
            ...(to ? { destination: to } : {}),
            sameZone: destination !== null && destination === current.source,
            moved: destination !== null && destination !== current.source && inDestination && !inSource,
          },
        },
        current.item,
        destination,
      );
    }, 300);
  };
  document.addEventListener(
    'pointerdown',
    (event) => {
      if (event.button !== 0 || dragging?.kind === 'HTML5') return;
      startDrag(event, 'POINTER', event.clientX, event.clientY);
    },
    { capture: true, passive: true },
  );
  document.addEventListener(
    'dragstart',
    (event) => {
      startDrag(event, 'HTML5', event.clientX, event.clientY);
    },
    { capture: true, passive: true },
  );
  document.addEventListener(
    'drop',
    (event) => {
      if (dragging) dragging.drop = originOf(event)?.closest(DROP_ZONE) ?? null;
    },
    { capture: true, passive: true },
  );
  document.addEventListener(
    'dragend',
    (event) => {
      if (dragging?.kind === 'HTML5') finishDrag(event.clientX, event.clientY, dragging.drop ?? null);
    },
    { capture: true, passive: true },
  );
  document.addEventListener(
    'pointerup',
    (event) => {
      if (dragging?.kind !== 'POINTER') return;
      // Phase de capture : lu AVANT que l'application ne déplace l'élément.
      const under = document.elementFromPoint(event.clientX, event.clientY);
      finishDrag(event.clientX, event.clientY, under?.closest(DROP_ZONE) ?? null);
    },
    { capture: true, passive: true },
  );
  document.addEventListener(
    'pointercancel',
    () => {
      if (dragging?.kind === 'POINTER') dragging = undefined;
    },
    { capture: true, passive: true },
  );

  // ---- clics
  document.addEventListener(
    'click',
    (event) => {
      if (isOverlay(event) || !event.isTrusted) return;
      // Le contrôle réellement cliqué : le premier élément interactif du chemin composé (un <span>
      // dans un bouton → le bouton ; un bouton dans un web component → ce bouton, pas l'hôte).
      const origin = originOf(event);
      const el = inPath(event, (node) => node.matches(CANDIDATES)) ?? origin;
      if (!el) return;
      const component = componentOf(event);
      const tag = el.tagName.toLowerCase();
      const type = ((el as HTMLInputElement).type || '').toLowerCase();
      let noise: string | undefined;
      if (Date.now() - lastDragAt < 500) noise = 'end of a drag (recorded as a drag and drop)';
      else if (
        tag === 'textarea' ||
        (tag === 'input' &&
          !['button', 'submit', 'reset', 'image', 'checkbox', 'radio', 'file'].includes(type))
      )
        noise = 'focus click in a field';
      else if (tag === 'select') noise = 'opens a native list (the choice is recorded by change)';
      else if (tag === 'input' && (type === 'checkbox' || type === 'radio'))
        noise = 'toggle (recorded by change)';
      else if (tag === 'label' && (el as HTMLLabelElement).control)
        noise = 'label of a control (recorded by change)';
      else if ((el as HTMLElement).isContentEditable) noise = 'focus click in an editable area';
      // Un élément sans rôle mais cliquable (une tuile <div (click)>, un <span> dans une carte) : le
      // premier ancêtre au curseur « main » est la cible ; sans lui, un clic de bruit (que la
      // corrélation peut encore promouvoir s'il précède une navigation).
      let target = el;
      if (!noise && !el.matches(CANDIDATES)) {
        const clickable = functionalTarget(event);
        if (clickable) target = clickable;
        else noise = 'click on a non-interactive element';
      }
      send(
        {
          type: 'click',
          element: { ...describe(target), ...(component ? { componentTag: component } : {}) },
          ...(noise ? { noise } : {}),
        },
        noise ? null : target,
      );
    },
    { capture: true, passive: true },
  );

  // ---- saisies : jamais une touche à la fois ; la dernière valeur après une pause.
  const pending = new Map<Element, number>();
  document.addEventListener(
    'input',
    (event) => {
      if (isOverlay(event)) return;
      const el = originOf(event);
      if (!el || !el.matches(FIELD)) return;
      const tag = el.tagName.toLowerCase();
      const type = ((el as HTMLInputElement).type || '').toLowerCase();
      if (tag === 'select' || type === 'checkbox' || type === 'radio' || type === 'file') return;
      if (!started.has(el)) started.set(el, Date.now());
      const previous = pending.get(el);
      if (previous !== undefined) window.clearTimeout(previous);
      pending.set(
        el,
        window.setTimeout(() => {
          pending.delete(el);
          send({ type: 'input', element: describe(el), value: valueFacts(el) }, el);
        }, options.inputDebounceMs),
      );
    },
    { capture: true, passive: true },
  );

  const commit = (el: Element): void => {
    const timer = pending.get(el);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      pending.delete(el);
    }
    send({ type: 'change', element: describe(el), value: valueFacts(el) }, el);
    started.delete(el);
  };
  document.addEventListener(
    'change',
    (event) => {
      if (isOverlay(event)) return;
      const el = originOf(event);
      if (el?.matches(FIELD)) commit(el);
    },
    { capture: true, passive: true },
  );
  // Une zone contenteditable n'émet pas change : sa valeur est prise en la quittant.
  document.addEventListener(
    'focusout',
    (event) => {
      if (isOverlay(event)) return;
      const el = originOf(event);
      // Un champ d'un shadow DOM (change n'en sort pas) : sa valeur est prise en le quittant.
      if (el && pending.has(el) && ((el as HTMLElement).isContentEditable || el.getRootNode() !== document))
        commit(el);
    },
    { capture: true, passive: true },
  );

  // ---- envoi de formulaire (bouton, ou Entrée dans un champ)
  document.addEventListener(
    'submit',
    (event) => {
      if (isOverlay(event)) return;
      const form = event.target instanceof HTMLFormElement ? event.target : null;
      if (!form) return;
      // Les saisies en attente partent avant l'envoi : l'ordre reste celui de l'humain.
      for (const el of Array.from(pending.keys())) if (form.contains(el)) commit(el);
      const submitter =
        event.submitter ??
        form.querySelector('button:not([type]), button[type="submit"], input[type="submit"]');
      send({ type: 'submit', element: describe(submitter ?? form) }, submitter ?? form);
    },
    { capture: true, passive: true },
  );
  document.addEventListener(
    'keydown',
    (event) => {
      if (isOverlay(event) || !event.isTrusted) return;
      if (event.key !== 'Enter' && event.key !== 'Escape') return;
      const el = originOf(event);
      if (!el) return;
      if (event.key === 'Enter' && el.matches(FIELD)) {
        const timer = pending.get(el);
        if (timer !== undefined) commit(el);
      }
      send({ type: 'keydown', key: event.key, element: describe(el) });
    },
    { capture: true, passive: true },
  );

  // ---- le bandeau
  const recorder = {
    setPaused: (value: boolean): void => {
      paused = value;
      render();
    },
    setStatus: (text: string): void => {
      status = text;
      render();
    },
  };
  global.__qaCrawlerRecorder = recorder;
  let status = 'RECORDING';
  let host: HTMLElement | undefined;
  let root: ShadowRoot | undefined;
  const render = (): void => {
    if (!root) return;
    const label = root.querySelector('.state');
    if (label) label.textContent = paused ? '❚❚ PAUSED' : `● ${status}`;
    const toggle = root.querySelector('[data-act="pause"]');
    if (toggle) toggle.textContent = paused ? 'Resume' : 'Pause';
  };
  const mount = (): void => {
    // Un document sans racine (en cours de remplacement) : le bandeau viendra au prochain passage.
    const rootElement = document.querySelector(':root');
    if (!options.overlay || rootElement === null) return;
    if (host?.isConnected) return;
    host = document.createElement('qa-crawler-recorder');
    host.setAttribute(OVERLAY, 'true');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'all:initial;position:fixed;right:12px;bottom:12px;z-index:2147483647';
    root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>
      .bar{font:12px/1.4 system-ui,sans-serif;background:#1f2328;color:#fff;border-radius:8px;padding:6px 8px;display:flex;gap:6px;align-items:center;box-shadow:0 2px 8px rgba(0,0,0,.35)}
      .state{color:#ff6b6b;font-weight:600;white-space:nowrap}
      input{font:inherit;width:120px;padding:2px 4px;border-radius:4px;border:1px solid #555;background:#2d333b;color:#fff}
      button{font:inherit;cursor:pointer;border:0;border-radius:4px;padding:3px 8px;background:#444c56;color:#fff}
      button[data-act="stop"]{background:#d1242f}
    </style><div class="bar"><span class="state">● RECORDING</span><input placeholder="checkpoint label" maxlength="80"><button data-act="checkpoint">Checkpoint</button><button data-act="pause">Pause</button><button data-act="stop">Stop</button></div>`;
    root.addEventListener('click', (event) => {
      const button = event.target instanceof Element ? event.target.closest('button') : null;
      const act = button?.getAttribute('data-act');
      if (!act || !root) return;
      if (act === 'checkpoint') {
        const input = root.querySelector('input');
        const label = clean(input?.value, 80);
        if (input) input.value = '';
        send({ type: 'control', control: 'checkpoint', ...(label ? { label } : {}) });
      } else if (act === 'pause') {
        const next = !paused;
        send({ type: 'control', control: next ? 'pause' : 'resume' });
        recorder.setPaused(next);
      } else if (act === 'stop') {
        send({ type: 'control', control: 'stop' });
        recorder.setStatus('STOPPED');
      }
    });
    rootElement.appendChild(host);
    render();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
  // Une application qui réécrit le document : le bandeau revient.
  window.setInterval(mount, 1000);
}

/** Le contenu de l'init script : un remplacement de __name (chargeurs TypeScript) puis l'installation. */
export function captureScript(options: CaptureOptions): string {
  return [
    'if (typeof globalThis.__name !== "function") { globalThis.__name = function (fn) { return fn; }; }',
    `(${installRecorder.toString()})(${JSON.stringify(options)}, ${sectionPathOf.toString()});`,
  ].join('\n');
}
