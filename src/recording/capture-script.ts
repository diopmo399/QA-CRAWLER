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
  /** CAPTURE AVANT MUTATION : la cible, son contexte et ses candidats, au premier événement du geste. */
  preActionCapture?: {
    enabled: boolean;
    maxCandidates: number;
    includeSameForm: boolean;
    includeSameDialog: boolean;
    includeSameSection: boolean;
  };
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
  let captures = 0;
  global.__qaCrawlerOriginal = (ref: unknown): Element | null =>
    typeof ref === 'string' ? (originals.get(ref) ?? null) : null;
  // GÉNÉRATION DU DOM : un compteur léger des lots de mutations de structure (re-rendus). Les
  // preuves pré-action portent la génération de leur capture : « l'état AVANT l'action ».
  let domGeneration = 0;
  let generationObserver: MutationObserver | undefined;
  try {
    generationObserver = new MutationObserver(() => {
      domGeneration += 1;
    });
    generationObserver.observe(document, { childList: true, subtree: true });
  } catch {
    // sans observateur, la génération reste 0 (jamais bloquant)
  }
  // Lue de façon SYNCHRONE : un re-rendu fait dans la même tâche que l'envoi compte déjà.
  const generationNow = (): number => {
    if (generationObserver && generationObserver.takeRecords().length > 0) domGeneration += 1;
    return domGeneration;
  };
  global.__qaCrawlerDomGeneration = generationNow;
  // Le contexte AVANT l'effet (défini plus bas, une fois les lecteurs disponibles).
  const preContext: {
    of?: (el: Element, css: string, phase?: string) => Record<string, unknown>;
    /** La preuve capturée au PREMIER événement du geste (pointerdown, focusin, beforeinput…). */
    take?: (el: Element) => { pre: Record<string, unknown>; element: Record<string, unknown> } | undefined;
  } = {};
  /** Ce que la description de l'événement ajoute (le composant du chemin) : gardé sur la description d'avant. */
  const keepOf = (element: unknown): Record<string, unknown> => {
    const component = (element as { componentTag?: unknown } | null)?.componentTag;
    return typeof component === 'string' ? { componentTag: component } : {};
  };
  const send = (payload: Record<string, unknown>, original?: Element | null, zone?: Element | null): void => {
    if (paused && payload.type !== 'control') return;
    // CAPTURE FIRST, VALIDATE LATER : la preuve prise AVANT la mutation (au premier événement du
    // geste) fait foi ; à défaut seulement, le contexte est lu maintenant (phase AT_EVENT).
    const stored = original && payload.pre === undefined ? preContext.take?.(original) : undefined;
    if (stored)
      payload = {
        ...payload,
        // La description d'AVANT l'action (un nœud re-rendu ou détaché ne se décrit plus).
        ...(payload.element !== undefined
          ? { element: { ...stored.element, ...keepOf(payload.element) } }
          : {}),
        pre: { ...stored.pre, sentGeneration: generationNow() },
      };
    const preContextOf = preContext.of;
    if (original && payload.pre === undefined && preContextOf) {
      const css = (payload.element as { css?: unknown } | undefined)?.css;
      try {
        payload = {
          ...payload,
          pre: {
            ...preContextOf(original, typeof css === 'string' ? css : '', 'AT_EVENT'),
            sentGeneration: generationNow(),
          },
        };
      } catch {
        // un contexte illisible n'empêche jamais l'enregistrement
      }
    }
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

  // L'INSTANCE DOM : un identifiant d'enregistrement par élément rencontré (e1, e2…). Jamais un
  // localisateur de rejeu : il dit seulement que deux événements viennent (ou non) du même nœud.
  const instances = new WeakMap<Element, string>();
  let instanceCount = 0;
  const instanceOf = (el: Element): string => {
    let id = instances.get(el);
    if (!id) {
      instanceCount += 1;
      id = `e${String(instanceCount)}`;
      instances.set(el, id);
    }
    return id;
  };
  /** L'élément actif, à travers les shadow roots ouverts. */
  const activeOf = (): Element | null => {
    let active: Element | null = document.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    return active;
  };
  const describe = (el: Element): Record<string, unknown> => {
    const role = roleOf(el);
    const name = nameOf(el);
    const label = labelOf(el);
    const tag = el.tagName.toLowerCase();
    const guessed = !label && !name && el.matches(FIELD) ? guessLabel(el) : '';
    const input = el as HTMLInputElement;
    const { css, stable } = cssOf(el);
    // SAME CSS ≠ SAME FIELD : combien d'éléments ce CSS désigne (dans la racine du nœud).
    let cssMatches = 0;
    let cssIndex = -1;
    try {
      // Dans un shadow DOM, le CSS est préfixé par l'hôte : querySelectorAll ne le lit pas.
      if (el.getRootNode() === document) {
        const matching = Array.from(document.querySelectorAll(css));
        cssMatches = matching.length;
        cssIndex = matching.indexOf(el);
      }
    } catch {
      cssMatches = 0;
    }
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
    // UNIQUE CSS SELECTOR ≠ STABLE TARGET : combien d'éléments portent le même id (un #valueInput dupliqué).
    let sameId = 0;
    if (id) for (const twin of Array.from(document.querySelectorAll('[id]'))) if (twin.id === id) sameId += 1;
    // Le CHAMP fonctionnel (mat-form-field, fieldset, groupe) et le voisinage sémantique proche :
    // des libellés, titres et boutons — jamais une valeur saisie.
    const fieldBox = el.closest('mat-form-field, .mat-mdc-form-field, fieldset, [role="group"], .form-group');
    const formField = fieldBox
      ? clean(
          fieldBox.querySelector('mat-label, legend, label')?.textContent ??
            fieldBox.getAttribute('aria-label'),
          60,
        )
      : '';
    const around = (fieldBox ?? el).parentElement;
    const nearbyText = around
      ? Array.from(
          around.querySelectorAll('label, legend, mat-label, h1, h2, h3, h4, [role="heading"], button'),
        )
          .filter((node) => !node.contains(el) && isVisible(node))
          .map((node) => clean(node.textContent, 40))
          .filter((text) => text && text !== label && text !== name)
          .slice(0, 4)
      : [];
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
      ...(id ? { elementId: id, generatedId: generatedId(id), ...(sameId > 1 ? { sameId } : {}) } : {}),
      ...(formField ? { formField } : {}),
      ...(nearbyText.length > 0 ? { nearbyText } : {}),
      ...(type ? { inputType: type } : {}),
      ...(el.getAttribute('autocomplete') ? { autocomplete: el.getAttribute('autocomplete') } : {}),
      ...(el.getAttribute('placeholder') ? { placeholder: clean(el.getAttribute('placeholder')) } : {}),
      ...(el.getAttribute('href') ? { href: (el as HTMLAnchorElement).href } : {}),
      css,
      cssStable: stable,
      domInstance: instanceOf(el),
      ...(cssMatches > 1 ? { cssMatches, ...(cssIndex >= 0 ? { cssIndex } : {}) } : {}),
      ...(input.maxLength > 0 ? { maxLength: input.maxLength } : {}),
      ...(el.getAttribute('inputmode') ? { inputMode: el.getAttribute('inputmode') } : {}),
      ...(el.getAttribute('pattern') ? { pattern: el.getAttribute('pattern') } : {}),
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

  // ---- CONTEXTE PRÉ-ACTION : l'écran tel que l'humain le voyait juste avant son geste. Jamais une
  // valeur saisie : les champs texte ne donnent que leur libellé ; une liste, son choix affiché.
  preContext.of = (el: Element, css: string, phase = 'AT_EVENT'): Record<string, unknown> => {
    const visible = (node: Element): boolean => {
      const rect = node.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
      const style = getComputedStyle(node);
      return style.visibility !== 'hidden' && style.display !== 'none';
    };
    const DIALOG =
      '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open], .cdk-overlay-pane';
    const ownDialog = el.closest(DIALOG);
    const openDialog = Array.from(document.querySelectorAll(DIALOG)).find(visible);
    const dialogName = (node: Element | null | undefined): string =>
      node
        ? clean(
            node.getAttribute('aria-label') ??
              textOf(node.querySelector('h1, h2, h3, [role="heading"], mat-dialog-title, legend')),
            60,
          )
        : '';
    const headings = Array.from(document.querySelectorAll('h1, h2, h3, [role="heading"]'))
      .filter(visible)
      .map((node) => clean(textOf(node), 60))
      .filter(Boolean)
      .slice(0, 5);
    let cssCount = 0;
    try {
      cssCount = css ? document.querySelectorAll(css).length : 0;
    } catch {
      cssCount = 0;
    }
    const ownText = clean(textOf(el), 80).toLowerCase();
    const sameText = ownText
      ? Array.from(document.querySelectorAll(CANDIDATES)).filter(
          (node) => visible(node) && clean(textOf(node), 80).toLowerCase() === ownText,
        ).length
      : 0;
    // Les choix déjà faits (listes, cases) : l'état du formulaire, sans aucune saisie libre.
    const selected = Array.from(
      document.querySelectorAll(
        'select, [role="combobox"], mat-select, input[type="checkbox"], input[type="radio"]',
      ),
    )
      .filter((node) => visible(node) && node !== el)
      .map((node) => {
        const label = labelOf(node) || nameOf(node);
        let value = '';
        if (node.tagName.toLowerCase() === 'select')
          value = (node as HTMLSelectElement).selectedOptions[0]?.textContent ?? '';
        else if (node instanceof HTMLInputElement) value = node.checked ? 'checked' : 'unchecked';
        else if (!(node instanceof HTMLInputElement)) value = textOf(node);
        return { label: clean(label, 60), value: clean(value, 60) };
      })
      .filter((entry) => entry.label && entry.value && entry.value !== '--')
      .slice(0, 6);
    const tab = Array.from(document.querySelectorAll('[role="tab"][aria-selected="true"]')).find(visible);
    const role = roleOf(el);
    // L'ENSEMBLE DES CANDIDATS, pris MAINTENANT (avant la mutation) : la cible originale d'abord
    // (T1, jamais retirée par le budget), puis le voisinage pertinent — même formulaire, même
    // fenêtre, même section, rôle compatible. Jamais tous les champs de la page.
    const settings = options.preActionCapture;
    const max = Math.max(1, settings?.maxCandidates ?? 12);
    const SECTION =
      'section, fieldset, [role="region"], [role="tabpanel"], [role="group"], mat-expansion-panel, mat-card, article';
    const pool: { node: Element; relationship: string }[] = [{ node: el, relationship: 'SELF' }];
    const seen = new Set<Element>([el]);
    const add = (scope: Element | null | undefined, relationship: string): void => {
      if (!scope) return;
      for (const node of Array.from(scope.querySelectorAll(CANDIDATES))) {
        if (pool.length >= max) return;
        if (seen.has(node) || node.closest(`[${OVERLAY}]`) || !visible(node)) continue;
        seen.add(node);
        pool.push({ node, relationship });
      }
    };
    if (settings?.includeSameForm !== false) add(el.closest('form'), 'SAME_FORM');
    if (settings?.includeSameDialog !== false) add(ownDialog, 'SAME_DIALOG');
    if (settings?.includeSameSection !== false) add(el.closest(SECTION), 'SAME_SECTION');
    // Un rôle compatible ailleurs à l'écran (un champ global de recherche face au champ du panneau Filter).
    if (pool.length < max)
      for (const node of Array.from(document.querySelectorAll(CANDIDATES))) {
        if (pool.length >= max) break;
        if (seen.has(node) || node.closest(`[${OVERLAY}]`) || !visible(node) || roleOf(node) !== role)
          continue;
        seen.add(node);
        pool.push({ node, relationship: 'SAME_ROLE' });
      }
    const containerOf = (node: Element): { tag: string; label?: string } | undefined => {
      const container = node.closest('mat-form-field, .mat-mdc-form-field, [role="group"], fieldset');
      if (!container || container === node) return undefined;
      const label = clean(
        textOf(container.querySelector('mat-label, label, legend')) || container.getAttribute('aria-label'),
        60,
      );
      return { tag: container.tagName.toLowerCase(), ...(label ? { label } : {}) };
    };
    const hostOf = (node: Element): string | undefined => {
      for (let cursor: Element | null = node; cursor; cursor = cursor.parentElement)
        if (cursor.tagName.includes('-')) return cursor.tagName.toLowerCase();
      const root = node.getRootNode();
      return typeof ShadowRoot !== 'undefined' && root instanceof ShadowRoot
        ? root.host.tagName.toLowerCase()
        : undefined;
    };
    // Une description sérialisable (jamais une valeur saisie, jamais une référence au nœud).
    const snapshotOf = (node: Element, id: string, relationship: string): Record<string, unknown> => {
      const tag = node.tagName.toLowerCase();
      const label = labelOf(node) || (node.matches(FIELD) ? guessLabel(node) : '');
      const text = node.matches(FIELD) ? '' : clean(textOf(node), 60);
      const path = sectionOf(node);
      const elementId = node.getAttribute('id');
      const testIdAttr = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy'].find((name) =>
        node.hasAttribute(name),
      );
      const stableAttributes: Record<string, string> = {};
      if (elementId && !generatedId(elementId)) stableAttributes.id = elementId;
      if (testIdAttr) stableAttributes[testIdAttr] = node.getAttribute(testIdAttr) ?? '';
      for (const name of ['name', 'formcontrolname', 'type', 'placeholder'])
        if (node.getAttribute(name)) stableAttributes[name] = clean(node.getAttribute(name), 60);
      const nearby = [guessLabel(node), contextOf(node)]
        .map((entry) => clean(entry, 60))
        .filter((entry, index, all) => entry && entry !== label && all.indexOf(entry) === index);
      const form = node.closest('form');
      const formName = form
        ? clean(form.getAttribute('aria-label') ?? form.getAttribute('name') ?? form.id, 60)
        : '';
      const dialog = node.closest(DIALOG);
      const container = containerOf(node);
      const host = hostOf(node);
      const field = node as HTMLInputElement;
      return {
        id,
        origin: relationship === 'SELF' ? 'ORIGINAL_HUMAN_TARGET' : 'CONTEXT',
        relationship,
        tag,
        role: roleOf(node),
        name: clean(nameOf(node), 60),
        ...(label ? { label: clean(label, 60) } : {}),
        ...(text ? { text } : {}),
        stableAttributes,
        visible: visible(node),
        enabled: !(field.disabled || node.getAttribute('aria-disabled') === 'true'),
        editable: node.matches(FIELD) && !field.readOnly && !field.disabled,
        ...(host ? { component: host } : {}),
        ...(formName ? { form: formName } : {}),
        ...(path.length > 0 ? { section: path.join(' > ') } : {}),
        ...(dialog && dialogName(dialog) ? { dialog: dialogName(dialog) } : {}),
        ...(container ? { container } : {}),
        ...(nearby.length > 0 ? { nearby } : {}),
        cssHint: cssOf(node).css,
      };
    };
    const candidates = pool.map((entry, index) =>
      snapshotOf(entry.node, `T${String(index + 1)}`, entry.relationship),
    );
    // La cible elle-même, avec ses preuves d'accessibilité (avant tout re-rendu).
    const describedBy = (el.getAttribute('aria-describedby') ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .map((key) => textOf(document.getElementById(key)))
      .join(' ');
    captures += 1;
    const target = {
      ...(candidates[0] ?? {}),
      captureId: `${documentId}:c${String(captures)}`,
      ...(el.getAttribute('aria-label') ? { ariaLabel: clean(el.getAttribute('aria-label'), 60) } : {}),
      ...(el.getAttribute('aria-labelledby') ? { ariaLabelledBy: labelOf(el) } : {}),
      ...(describedBy ? { ariaDescription: clean(describedBy, 80) } : {}),
    };
    // Compatibilité : les pairs du même rôle (les candidats hors cible originale).
    const peers = candidates
      .filter((entry) => entry.origin !== 'ORIGINAL_HUMAN_TARGET' && entry.role === role)
      .slice(0, 6)
      .map((entry) => ({
        role,
        name: String(entry.name),
        ...(typeof entry.section === 'string' ? { section: entry.section } : {}),
      }));
    const busy = Array.from(
      document.querySelectorAll('[aria-busy="true"], mat-progress-spinner, mat-spinner, .spinner, .loading'),
    ).some(visible);
    return {
      route: location.pathname,
      title: clean(document.title, 80),
      ...(dialogName(ownDialog ?? openDialog) ? { dialog: dialogName(ownDialog ?? openDialog) } : {}),
      headings,
      cssCount,
      sameText,
      selected,
      ...(tab ? { activeTab: clean(textOf(tab), 60) } : {}),
      peers,
      loading: busy,
      phase,
      generation: generationNow(),
      capturedAt: Date.now(),
      captureId: target.captureId,
      target,
      candidates,
      originalCandidateId: 'T1',
    };
  };

  // ---- CAPTURE PRÉ-ACTION ATOMIQUE : au PREMIER événement d'un geste (avant que l'application ne
  // réagisse), la cible, son contexte et ses candidats sont figés ; l'envoi (après la saisie, le
  // clic, la pause) les reprend. Une référence au nœud ne quitte jamais la page.
  const evidence = new WeakMap<
    Element,
    { at: number; pre: Record<string, unknown>; element: Record<string, unknown> }
  >();
  const capturePreActionEvidence = (el: Element, phase: string): void => {
    if (paused || options.preActionCapture?.enabled === false || !preContext.of) return;
    try {
      evidence.set(el, {
        at: Date.now(),
        pre: preContext.of(el, cssOf(el).css, phase),
        element: describe(el),
      });
    } catch {
      // une capture illisible n'empêche jamais l'enregistrement (repli : AT_EVENT)
    }
  };
  // Une preuve est celle de CE geste : récente (un clic suit son appui), ou la session de saisie en cours.
  preContext.take = (el: Element) => {
    const found = evidence.get(el);
    if (!found) return undefined;
    const field = el.matches(FIELD);
    if (Date.now() - found.at > (field ? 10 * 60_000 : 5_000)) return undefined;
    if (!field) evidence.delete(el);
    return { pre: found.pre, element: found.element };
  };
  // CLIC / LISTE / CASE / GLISSER : l'appui précède tout gestionnaire de clic de l'application.
  document.addEventListener(
    'pointerdown',
    (event) => {
      if (isOverlay(event) || !event.isTrusted || event.button !== 0) return;
      const el = inPath(event, (node) => node.matches(CANDIDATES)) ?? functionalTarget(event);
      if (el) capturePreActionEvidence(el, 'POINTERDOWN');
    },
    { capture: true, passive: true },
  );
  // SAISIE : l'entrée dans le champ, puis la première frappe si la preuve manque.
  document.addEventListener(
    'focusin',
    (event) => {
      if (isOverlay(event)) return;
      const el = originOf(event);
      if (el?.matches(FIELD)) capturePreActionEvidence(el, 'FOCUSIN');
    },
    { capture: true, passive: true },
  );
  document.addEventListener(
    'beforeinput',
    (event) => {
      if (isOverlay(event)) return;
      const el = originOf(event);
      if (el?.matches(FIELD) && !evidence.has(el)) capturePreActionEvidence(el, 'BEFOREINPUT');
    },
    { capture: true, passive: true },
  );
  document.addEventListener(
    'keydown',
    (event) => {
      if (isOverlay(event) || !event.isTrusted) return;
      const el = originOf(event);
      if (el && !evidence.has(el) && (el.matches(FIELD) || el.matches(CANDIDATES)))
        capturePreActionEvidence(el, 'KEYDOWN');
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
        pre?: Record<string, unknown>;
        sourceBefore: string[];
        /** Les zones de dépôt visibles AU DÉPART (candidates D1…), et leurs listes d'avant. */
        zones: { zone: Element; id: string; before: string[] }[];
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
    // LES ZONES DE DÉPÔT CANDIDATES, figées au départ (avant que l'application ne recrée les nœuds) :
    // la zone d'origine d'abord (D1), puis les autres zones visibles, bornées.
    const source = item.parentElement?.closest(DROP_ZONE) ?? null;
    const zones = [
      ...(source ? [source] : []),
      ...Array.from(document.querySelectorAll(DROP_ZONE)).filter(
        (zone) => zone !== source && !item.contains(zone) && !zone.contains(source) && isVisible(zone),
      ),
    ]
      .slice(0, 6)
      .map((zone, index) => ({ zone, id: `D${String(index + 1)}`, before: itemTexts(zone) }));
    dragging = {
      item,
      zones,
      text: clean((item as HTMLElement).innerText || item.textContent, 60),
      element: describe(item),
      source: item.parentElement?.closest(DROP_ZONE) ?? null,
      x,
      y,
      kind,
      // AVANT le déplacement : l'écran et la liste d'origine.
      ...(preContext.of
        ? {
            pre: {
              ...preContext.of(item, '', kind === 'HTML5' ? 'DRAGSTART' : 'POINTERDOWN'),
              dropZones: zones.map((entry) => ({
                id: entry.id,
                origin: entry.zone === source ? 'SOURCE' : 'CONTEXT',
                ...zoneFacts(entry.zone),
                itemCount: entry.before.length,
              })),
            },
          }
        : {}),
      sourceBefore: itemTexts(item.parentElement?.closest(DROP_ZONE) ?? null),
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
      // La zone d'arrivée parmi les candidates d'avant : sa liste AVANT le dépôt (preuve historique).
      const landed = current.zones.find(
        (entry) => destination !== null && (entry.zone === destination || entry.zone.contains(destination)),
      );
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
            ...(landed ? { destinationCandidateId: landed.id } : {}),
            lists: {
              sourceBefore: current.sourceBefore.slice(0, 10),
              ...(landed ? { destinationBefore: landed.before.slice(0, 10) } : {}),
              sourceAfter: itemTexts(current.source).slice(0, 10),
              destinationAfter: itemTexts(destination).slice(0, 10),
            },
          },
          ...(current.pre ? { pre: current.pre } : {}),
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
          send(
            {
              type: 'input',
              element: describe(el),
              value: valueFacts(el),
              ...(activeOf() ? { activeDomInstance: instanceOf(activeOf() as Element) } : {}),
            },
            el,
          );
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
    send(
      {
        type: 'change',
        element: describe(el),
        value: valueFacts(el),
        ...(activeOf() ? { activeDomInstance: instanceOf(activeOf() as Element) } : {}),
      },
      el,
    );
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
