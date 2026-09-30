import type { FormSummary } from '../model/discovered-action.js';
import type { UiElement, UiSnapshot } from '../model/ui-snapshot.js';

export type DomSnapshot = Omit<UiSnapshot, 'url' | 'title'>;

/**
 * S'exécute dans le navigateur (sérialisé par Playwright) : il doit rester
 * autonome — aucun import, aucune référence au code du module.
 *
 * Lit le DOM et calcule, pour chaque élément interactif, son rôle ARIA et une
 * approximation de son nom accessible (les mêmes notions que getByRole de
 * Playwright). Les valeurs des champs ne sont jamais lues.
 */
export function collectDomSnapshot(options: { maxElements: number }): DomSnapshot {
  // Un document sans <body> (en cours de chargement juste après une connexion, réponse XML,
  // page intermédiaire d'authentification) : son texte est lu sur la racine, jamais une erreur.
  const pageText = (): string => {
    // Les types du DOM disent <body> toujours présent ; ce n'est pas vrai pendant un chargement.
    const body = document.querySelector('body');
    return body ? body.innerText : (document.querySelector(':root')?.textContent ?? '');
  };
  // Posé par l'exécuteur de flows sur l'élément visé par une étape imposée (voir FlowStepExecutor).
  const FLOW_TARGET_ATTRIBUTE = 'data-qa-flow-target';
  const CANDIDATES = [
    'a[href]',
    'button',
    'summary',
    'input:not([type="hidden"])',
    'select',
    'textarea',
    '[role="button"]',
    '[role="link"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="menuitemcheckbox"]',
    '[role="menuitemradio"]',
    '[role="switch"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="option"]',
    '[role="combobox"]',
    '[routerlink]',
    '[ng-reflect-router-link]',
    '[onclick]',
    // Un lien sans adresse (Angular « <a (click)> ») : gardé seulement s'il a l'air cliquable (curseur pointeur).
    'a:not([href])',
    '[tabindex="0"]',
    // Texte riche et champs modifiables personnalisés.
    '[contenteditable]:not([contenteditable="false"])',
  ].join(', ');
  /** Toasts, zones live, minuteurs : ils vont et viennent. */
  const TRANSIENT =
    '[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"], [role="log"], [role="timer"], [role="marquee"], mat-snack-bar-container, .toast, .snackbar';
  /** Candidats qui sont des actions à eux seuls (tout sauf un simple tabindex="0"). */
  const ACTIONABLE = CANDIDATES.replace(/,\s*\[tabindex="0"\]/, '').replace(/,\s*a:not\(\[href\]\)/, '');
  const STRUCTURE_ROLES = new Set([
    'heading',
    'dialog',
    'alertdialog',
    'document',
    'region',
    'group',
    'presentation',
    'none',
    'img',
    'article',
    'main',
    'navigation',
    'banner',
    'contentinfo',
    'complementary',
    'list',
    'table',
    'grid',
    'tabpanel',
    'status',
    'alert',
    'tooltip',
  ]);
  const FIELD_SELECTOR =
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]), select, textarea';

  const clean = (value: string | null | undefined, max = 120): string =>
    (value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

  // ---- les shadow roots ouverts (composants web : Ionic, Shoelace, Lit, Stencil…) sont lus comme la page.
  // Le contenu placé dans un slot reste dans le light DOM ; ce qu'un composant dessine lui-même vit dans son shadow root.
  const hasShadow = Array.from(document.querySelectorAll('*')).some((el) => el.shadowRoot !== null);
  /** Chaque élément correspondant, dans l'ordre du document, shadow roots compris (juste après leur hôte). */
  const deepAll = (selector: string): Element[] => {
    if (!hasShadow) return Array.from(document.querySelectorAll(selector));
    const out: Element[] = [];
    const visit = (root: Document | ShadowRoot): void => {
      for (const el of Array.from(root.querySelectorAll('*'))) {
        if (el.matches(selector)) out.push(el);
        if (el.shadowRoot) visit(el.shadowRoot);
      }
    };
    visit(document);
    return out;
  };
  const hostOf = (node: Node): Element | null => {
    const root = node.getRootNode();
    return root instanceof ShadowRoot ? root.host : null;
  };
  /** closest(), en continuant à travers les hôtes des shadow roots. */
  const closestDeep = (el: Element | null, selector: string): Element | null => {
    for (let current = el; current; current = hostOf(current)) {
      const found = current.closest(selector);
      if (found) return found;
    }
    return null;
  };
  const parentDeep = (el: Element): Element | null => el.parentElement ?? hostOf(el);
  /** contains(), pour un élément qui peut se trouver dans le shadow root d'un descendant. */
  const containsDeep = (container: Element, el: Element): boolean => {
    for (let current: Element | null = el; current; current = hostOf(current))
      if (container.contains(current)) return true;
    return false;
  };
  const rootOf = (el: Element): Document | ShadowRoot => el.getRootNode() as Document | ShadowRoot;
  const byId = (el: Element, id: string): Element | null =>
    rootOf(el).getElementById(id) ?? document.getElementById(id);

  const isVisible = (el: Element): boolean => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    if (style.opacity !== '0') return true;
    // Les cases et radios stylées (Angular Material…) cachent l'input natif sous leur propre dessin.
    return el.matches('input[type="checkbox"], input[type="radio"]') && el.parentElement !== null
      ? isVisible(el.parentElement)
      : false;
  };

  /** Texte utilisé pour les noms accessibles : nœuds texte, en sautant les sous-arbres aria-hidden/cachés (sans text-transform CSS). */
  const nameText = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const el = node as Element;
    if (el.getAttribute('aria-hidden') === 'true') return '';
    const tag = el.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'template') return '';
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return '';
    if (tag === 'img') return ` ${el.getAttribute('alt') ?? ''} `;
    // Un <slot> montre les nœuds que la page y a placés (ses propres enfants ne sont qu'un repli).
    if (tag === 'slot') {
      const assigned = (el as HTMLSlotElement).assignedNodes({ flatten: true });
      if (assigned.length > 0) return assigned.map((child) => nameText(child)).join('');
    }
    const block = style.display !== 'inline' && style.display !== 'inline-block' ? ' ' : '';
    return (
      block +
      Array.from(el.childNodes)
        .map((child) => nameText(child))
        .join('') +
      block
    );
  };

  const labelOf = (el: Element): string => {
    const id = el.getAttribute('id');
    const byFor = id ? rootOf(el).querySelector(`label[for="${CSS.escape(id)}"]`) : null;
    const wrapping = closestDeep(el, 'label');
    return clean(byFor ? nameText(byFor) : wrapping ? nameText(wrapping) : '') || hostLabel(el);
  };
  /**
   * Un champ dessiné dans un composant : le libellé que la page a donné au composant
   * (attribut label="…", aria-label, contenu de slot="label", ou son propre <label>).
   */
  const hostLabel = (el: Element): string => {
    const host = hostOf(el);
    if (!host) return '';
    const slotted = host.querySelector('[slot="label"]');
    return (
      clean(
        host.getAttribute('label') ?? host.getAttribute('aria-label') ?? (slotted ? nameText(slotted) : ''),
      ) || labelOf(host)
    );
  };

  const implicitRole = (el: Element): string => {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') ?? '').toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : '';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return el.hasAttribute('multiple') ? 'listbox' : 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      if (type === 'number') return 'spinbutton';
      if (type === 'search') return 'searchbox';
      if (['', 'text', 'email', 'tel', 'url', 'password'].includes(type)) return 'textbox';
      return '';
    }
    return '';
  };

  const accessibleName = (el: Element, role: string): string => {
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.trim()) return clean(ariaLabel);
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((ref) => {
          const target = byId(el, ref);
          return target ? nameText(target) : '';
        })
        .join(' ');
      if (text.trim()) return clean(text);
    }
    const tag = el.tagName.toLowerCase();
    if (
      [
        'textbox',
        'searchbox',
        'combobox',
        'listbox',
        'spinbutton',
        'checkbox',
        'radio',
        'slider',
        'switch',
      ].includes(role) &&
      tag !== 'button'
    ) {
      const label = labelOf(el);
      if (label) return label;
      return clean(el.getAttribute('title') ?? el.getAttribute('placeholder'));
    }
    if (tag === 'input')
      return clean((el as HTMLInputElement).value || el.getAttribute('alt') || el.getAttribute('title'));
    const text = clean(nameText(el));
    if (text) return text;
    const img = el.querySelector('img[alt], svg[aria-label]');
    return clean(img?.getAttribute('alt') ?? img?.getAttribute('aria-label') ?? el.getAttribute('title'));
  };

  const cssPath = (el: Element): string => {
    const id = el.getAttribute('id');
    // Dans un shadow root : le chemin de l'hôte, puis le chemin à l'intérieur (le CSS de Playwright traverse les shadow roots ouverts).
    const host = hostOf(el);
    const prefix = host ? `${cssPath(host)} ` : '';
    if (id && deepAll(`#${CSS.escape(id)}`).length === 1) return `${prefix}#${CSS.escape(id)}`;
    const parts: string[] = [];
    let current: Element | null = el;
    while (current && current !== document.body && parts.length < 6) {
      const tag = current.tagName.toLowerCase();
      const parent: Element | null = current.parentElement;
      const siblings = parent
        ? Array.from(parent.children).filter((child) => child.tagName === current?.tagName)
        : [];
      parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(current) + 1})` : tag);
      const parentId = parent?.getAttribute('id');
      if (parentId && deepAll(`#${CSS.escape(parentId)}`).length === 1) {
        parts.unshift(`#${CSS.escape(parentId)}`);
        break;
      }
      current = parent;
    }
    return prefix + parts.join(' > ');
  };

  const dialogNameOf = (el: Element): string | undefined => {
    const dialog = closestDeep(el, '[role="dialog"], [role="alertdialog"], dialog');
    if (!dialog) return undefined;
    const heading = dialog.querySelector<HTMLElement>('h1, h2, h3, [role="heading"]');
    return clean(dialog.getAttribute('aria-label') ?? heading?.innerText ?? '') || 'dialog';
  };

  const forms = deepAll('form') as HTMLFormElement[];
  const searchForm = (form: HTMLFormElement | null): boolean =>
    form !== null &&
    (form.getAttribute('role') === 'search' ||
      ((form.getAttribute('method') ?? 'get').toLowerCase() === 'get' &&
        form.querySelector('input[type="search"], input[name="q"], input[name="search"]') !== null));

  /** Contient un élément interactif, shadow roots de ses composants compris. */
  let deepCandidates: Element[] | undefined;
  const holdsCandidate = (el: Element): boolean => {
    if (el.querySelector(CANDIDATES) !== null) return true;
    if (!hasShadow) return false;
    deepCandidates ??= deepAll(CANDIDATES);
    return deepCandidates.some((candidate) => candidate !== el && containsDeep(el, candidate));
  };

  // ---- premier plan : ce qui est devant l'écran (modale, tiroir, menu ouvert, bannière de cookies…)
  const LAYERS =
    '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open], .cdk-overlay-pane, [role="menu"], [role="listbox"]';
  // Un menu ou une liste n'est devant que s'il flotte (menu déroulant), pas s'il fait partie de la page (barre latérale).
  const floating = (el: Element): boolean => {
    let current: Element | null = el;
    for (let depth = 0; current && depth < 4; depth += 1, current = current.parentElement) {
      const position = window.getComputedStyle(current).position;
      if (position === 'fixed' || position === 'absolute') return true;
    }
    return false;
  };
  const layers = deepAll(LAYERS).filter(
    (el) =>
      isVisible(el) &&
      holdsCandidate(el) &&
      !closestDeep(parentDeep(el), LAYERS) &&
      (!el.matches('[role="menu"], [role="listbox"]') || floating(el)),
  );
  // Un calque qui prend le pointeur à la page derrière : une modale aria-modal/<dialog>, ou un
  // calque fixed/absolute qui couvre la plus grande partie de la fenêtre, quel que soit son balisage (fond + boîte).
  const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
  const coveringLayer = (): Element | undefined => {
    const points: [number, number][] = [
      [0.5, 0.5],
      [0.5, 0.3],
      [0.5, 0.7],
    ];
    for (const [x, y] of points) {
      let hit = document.elementFromPoint(window.innerWidth * x, window.innerHeight * y);
      let covering: Element | undefined;
      while (hit && hit !== document.body && hit !== document.documentElement) {
        const position = window.getComputedStyle(hit).position;
        const rect = hit.getBoundingClientRect();
        if (
          (position === 'fixed' || position === 'absolute') &&
          (rect.width * rect.height) / viewportArea >= 0.6
        )
          covering = hit; // garder le plus extérieur : le conteneur du fond contient la boîte
        hit = hit.parentElement;
      }
      if (covering && holdsCandidate(covering)) return covering;
    }
    return undefined;
  };
  const modal =
    layers.find((el) => el.matches('[aria-modal="true"], dialog[open]:modal, [role="alertdialog"]')) ??
    coveringLayer();
  if (modal && !layers.includes(modal)) layers.push(modal);
  const foregroundOf = (el: Element): boolean => layers.some((layer) => containsDeep(layer, el));
  // Les calques s'empilent : un calendrier ouvert depuis une fenêtre pose son propre fond sur la fenêtre. Un élément
  // est recouvert quand le point que viserait un clic appartient à un autre calque (panneau, fond, grand
  // calque fixed/absolute). Les petits en-têtes collants ne sont pas des calques : Playwright défile autour.
  const BACKDROP = '.cdk-overlay-backdrop, [class*="backdrop"], [class*="Backdrop"]';
  const layerOf = (hit: Element): Element | undefined => {
    for (let current: Element | null = hit; current; current = current.parentElement) {
      if (current === document.body || current === document.documentElement) return undefined;
      if (current.matches(LAYERS) || current.matches(BACKDROP)) return current;
      const position = window.getComputedStyle(current).position;
      if (position === 'fixed' || position === 'absolute') {
        const rect = current.getBoundingClientRect();
        if ((rect.width * rect.height) / viewportArea >= 0.5) return current;
      }
    }
    return undefined;
  };
  const coveredByLayer = (el: Element): boolean => {
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return false; // hors de l'écran
    const hit = document.elementFromPoint(x, y);
    // Un élément d'un shadow root est touché à travers son hôte (reciblage des événements).
    if (!hit || el.contains(hit) || containsDeep(hit, el)) return false;
    const layer = layerOf(hit);
    return layer !== undefined && !containsDeep(layer, el);
  };
  const overlayName = (el: Element): string => {
    const heading = el.querySelector<HTMLElement>('h1, h2, h3, [role="heading"]');
    return clean(el.getAttribute('aria-label') ?? heading?.innerText ?? '', 80) || 'overlay';
  };

  // ---- ce dont un champ a besoin en plus de ses contraintes (la valeur elle-même n'est jamais lue)
  const FIELD_CONTAINER =
    'mat-form-field, .mat-mdc-form-field, .mat-form-field, .form-group, .form-field, .field, .input-group';
  const ERROR_SELECTOR =
    'mat-error, .mat-mdc-form-field-error, .mat-error, .invalid-feedback, .error-message, .field-error, [role="alert"]';
  const textOfIds = (el: Element, ids: string | null): string =>
    clean(
      (ids ?? '')
        .split(/\s+/)
        .map((ref) => (ref ? byId(el, ref) : null))
        .filter((target): target is HTMLElement => target !== null && !target.matches(ERROR_SELECTOR))
        .map((target) => nameText(target))
        .join(' '),
      60,
    );
  // ---- libellé et aide « visuels » : le texte posé juste avant / juste après un champ, sans lien HTML
  // (pas de <label for>, pas d'aria) — courant dans les fenêtres faites de <div>.
  const FIELD_LIKE = `${FIELD_SELECTOR}, [role="combobox"], [role="radio"], [role="checkbox"], [contenteditable]:not([contenteditable="false"])`;
  const holdsField = (el: Element): boolean =>
    el.matches(FIELD_LIKE) ||
    el.querySelector(FIELD_LIKE) !== null ||
    (el.shadowRoot !== null && el.shadowRoot.querySelector(FIELD_LIKE) !== null);
  /**
   * Le texte court le plus proche avant (ou après) un champ, dans son propre bloc : on
   * remonte tant que le parent ne contient que ce champ, et on s'arrête dès qu'un
   * frère contient un autre champ (son texte est alors à ce champ-là). Assez haut pour
   * sortir d'un mat-form-field (input › infix › flex › wrapper › mat-form-field › bloc).
   * Un message d'erreur (« Ce champ est obligatoire ») n'est ni un libellé ni une aide.
   */
  const NEAR_TEXT_DEPTH = 8;
  const nearText = (el: Element, direction: 'before' | 'after', max: number): string => {
    let node: Element = el;
    for (let depth = 0; depth < NEAR_TEXT_DEPTH; depth += 1) {
      for (
        let sibling = direction === 'before' ? node.previousElementSibling : node.nextElementSibling;
        sibling;
        sibling = direction === 'before' ? sibling.previousElementSibling : sibling.nextElementSibling
      ) {
        if (holdsField(sibling)) return '';
        if (sibling.matches(ERROR_SELECTOR) || sibling.querySelector(ERROR_SELECTOR) || !isVisible(sibling))
          continue;
        const text = clean(nameText(sibling), max + 1)
          .replace(/^\*\s*/, '')
          .replace(/\s*\*$/, '');
        if (text) return text.length <= max ? text : '';
      }
      const parent = parentDeep(node);
      if (!parent || parent === document.body || parent.querySelectorAll(FIELD_LIKE).length > 1) break;
      node = parent;
    }
    return '';
  };
  const describeField = (
    el: Element,
    tag: string,
    inputType: string | undefined,
    customSelect: boolean,
  ): Partial<UiElement> => {
    const info: Partial<UiElement> = {};
    const input = el as HTMLInputElement;
    if (customSelect) {
      // Une liste personnalisée affiche son texte d'invite tant qu'aucune option n'est choisie.
      info.hasValue = el.querySelector('[class*="placeholder"]') === null && clean(nameText(el)) !== '';
    } else if (tag === 'input' || tag === 'textarea') {
      if (inputType !== 'checkbox' && inputType !== 'radio') info.hasValue = input.value !== '';
    }
    const container = closestDeep(el, FIELD_CONTAINER);
    const hint =
      textOfIds(el, el.getAttribute('aria-describedby')) ||
      clean(
        Array.from(
          container?.querySelectorAll(
            'mat-hint, .mat-mdc-form-field-hint, .mat-hint, .form-text, .help-block',
          ) ?? [],
        )
          .map((node) => nameText(node))
          .join(' '),
        60,
      );
    if (hint) info.hint = hint;
    else {
      // Aide affichée sous le champ sans lien HTML ("99999", "HH:MM").
      const below = nearText(el, 'after', 40);
      if (below) info.hint = below;
    }
    if (
      /datepicker/i.test(el.className && typeof el.className === 'string' ? el.className : '') ||
      container?.querySelector('mat-datepicker-toggle, [class*="datepicker-toggle"]') ||
      (tag === 'input' && el.getAttribute('aria-haspopup') === 'dialog')
    )
      info.dateLike = true;
    if (
      inputType === 'radio' ||
      inputType === 'checkbox' ||
      el.matches('[role="radio"], [role="checkbox"]')
    ) {
      const group = closestDeep(el, '[role="radiogroup"], mat-radio-group, fieldset, [role="group"]');
      const groupName =
        clean(group?.getAttribute('aria-label')) ||
        textOfIds(el, group?.getAttribute('aria-labelledby') ?? null) ||
        clean(group?.querySelector('legend')?.textContent) ||
        clean(group?.previousElementSibling?.textContent, 80);
      if (groupName) info.groupLabel = groupName.replace(/^\*\s*/, '');
      const name = el.getAttribute('name');
      // Radios d'un même choix (une option par groupe) ; les cases à cocher restent indépendantes.
      if (inputType === 'radio' || el.matches('[role="radio"]'))
        info.choiceGroup = name ? `name:${name}` : groupName ? `label:${groupName}` : undefined;
      const groupHtml =
        group?.hasAttribute('required') ||
        (name !== null && rootOf(el).querySelector(`input[name="${CSS.escape(name)}"][required]`) !== null);
      const groupAria = group?.getAttribute('aria-required') === 'true';
      if (groupHtml || groupAria) {
        info.required = true;
        info.requiredBy = [
          ...(groupHtml ? (['HTML'] as const) : []),
          ...(groupAria ? (['ARIA'] as const) : []),
        ];
      }
    }
    return info;
  };

  // ---- éléments interactifs
  const elements: UiElement[] = [];
  const all = deepAll(CANDIDATES);
  for (const [index, el] of all.entries()) {
    const inLayer = layers.length > 0 && foregroundOf(el);
    // Ce qui est devant l'écran est toujours gardé, même au-delà de maxElements (les calques sont souvent en fin de DOM).
    if (elements.length >= options.maxElements && !el.hasAttribute(FLOW_TARGET_ATTRIBUTE) && !inLayer)
      continue;
    if (!isVisible(el)) continue;
    const covered = coveredByLayer(el);
    const foreground = inLayer && !covered;
    const tag = el.tagName.toLowerCase();
    const isField = ['input', 'select', 'textarea'].includes(tag);
    // contenteditable (texte riche, champs personnalisés) : rempli comme un champ texte.
    const editable = !isField && (el as HTMLElement).isContentEditable;
    // Dans une zone modifiable : une partie du texte, pas une action.
    if (editable && parentDeep(el) && (parentDeep(el) as HTMLElement).isContentEditable) continue;
    // Un conteneur cliquable autour d'un autre candidat (par exemple <li onclick><a href>) : garder l'élément le plus intérieur.
    if (!isField && el.matches('[onclick], [tabindex="0"]') && el.querySelector(CANDIDATES) !== null)
      continue;
    // Les éléments imbriqués dans un autre élément interactif sont atteints à travers lui.
    const parent = parentDeep(el);
    if (
      !isField &&
      !editable &&
      parent &&
      closestDeep(parent, 'a[href], button, [role="button"], [role="link"], [role="tab"], [role="menuitem"]')
    )
      continue;

    const role =
      clean(el.getAttribute('role')) ||
      implicitRole(el) ||
      (editable ? 'textbox' : '') ||
      (el.matches('[routerlink], [ng-reflect-router-link], [onclick], [tabindex="0"]') ? 'button' : '');
    // Seulement focalisable (tabindex="0") : un titre, une fenêtre ou un bloc de texte qui prend le focus n'est pas une
    // action, sauf s'il a l'air cliquable (curseur pointeur) ou déclare un rôle interactif.
    if (
      !editable &&
      !el.matches(ACTIONABLE) &&
      (/^h[1-6]$/.test(tag) ||
        STRUCTURE_ROLES.has(clean(el.getAttribute('role'))) ||
        (!clean(el.getAttribute('role')) &&
          window.getComputedStyle(el).cursor !== 'pointer' &&
          // Un lien sans adresse stylé comme un lien ou un bouton (class="link", "btn"…).
          !(tag === 'a' && /link|btn|button|action/i.test(el.getAttribute('class') ?? ''))))
    )
      continue;
    const inputType =
      tag === 'input'
        ? (el.getAttribute('type') ?? 'text').toLowerCase()
        : tag === 'button'
          ? (el.getAttribute('type') ?? 'submit').toLowerCase()
          : undefined;
    const form = closestDeep(el, 'form') as HTMLFormElement | null;
    const formIndex = form ? forms.indexOf(form) : -1;
    const html = el as HTMLElement & Partial<HTMLInputElement>;
    const isSubmit =
      form !== null &&
      ((tag === 'button' && inputType === 'submit') ||
        (tag === 'input' && (inputType === 'submit' || inputType === 'image')));
    const ariaExpanded = el.getAttribute('aria-expanded');
    const ariaSelected = el.getAttribute('aria-selected');
    const href = tag === 'a' ? (el as HTMLAnchorElement).href : undefined;
    const routerLink =
      el.getAttribute('routerlink') ?? el.getAttribute('ng-reflect-router-link') ?? undefined;
    const dialogName = dialogNameOf(el);
    const linkedLabel = isField || editable ? labelOf(el) : '';
    const fieldName = accessibleName(el, role);
    // Aucun libellé relié : le texte posé juste avant le champ (« * Code agence » au-dessus).
    const visual =
      !linkedLabel && !fieldName && (isField || editable || role === 'combobox')
        ? nearText(el, 'before', 60)
        : '';
    const label = linkedLabel || visual;
    // Libellé deviné (texte voisin, composant autour) : Playwright ne le connaît pas, le localisateur sera CSS.
    const labelGuessed = visual !== '' || (label !== '' && hostOf(el) !== null && label === hostLabel(el));
    // Le formulaire auquel appartient un élément : son <form>, sinon la fenêtre / le calque qui le contient (les
    // formulaires des fenêtres Angular Material n'ont souvent pas de <form>).
    const layer = layers.find((candidate) => containsDeep(candidate, el));
    // Champs hors de tout <form>, fenêtre ou calque : la page elle-même peut être le formulaire (SPA sans <form>).
    const formGroup = form
      ? `form:${formIndex}`
      : layer
        ? `layer:${overlayName(layer)}`
        : isField ||
            editable ||
            role === 'combobox' ||
            el.matches('button, [role="button"], input[type="submit"]')
          ? 'page'
          : undefined;
    const customSelect = !isField && (role === 'combobox' || role === 'listbox');
    const fieldInfo = isField || customSelect ? describeField(el, tag, inputType, customSelect) : {};
    const requiredBy: ('HTML' | 'ARIA')[] = [
      ...(el.hasAttribute('required') ? (['HTML'] as const) : []),
      ...(el.getAttribute('aria-required') === 'true' ? (['ARIA'] as const) : []),
    ];
    const numberAttr = (name: string): number | undefined => {
      const value = el.getAttribute(name);
      return value !== null && value !== '' && !Number.isNaN(Number(value)) ? Number(value) : undefined;
    };
    const attr = (name: string): string | undefined => {
      const value = el.getAttribute(name);
      return value !== null && value !== '' ? value : undefined;
    };

    const element: UiElement = {
      index,
      tag,
      role,
      name: fieldName || (editable ? label : ''),
      text: isField || editable ? '' : clean(nameText(el)),
      visible: true,
      disabled:
        ('disabled' in el && (el as HTMLButtonElement).disabled) ||
        el.getAttribute('aria-disabled') === 'true',
      readOnly: el.hasAttribute('readonly'),
      hasPopup: (el.getAttribute('aria-haspopup') ?? 'false') !== 'false',
      required: el.hasAttribute('required') || el.getAttribute('aria-required') === 'true',
      isSubmit,
      inSearchForm: searchForm(form),
      formHasAction: form !== null && (form.getAttribute('action') ?? '').trim() !== '',
      inNavigation:
        closestDeep(el, 'nav, [role="navigation"], [role="menu"], [role="menubar"], [role="tablist"]') !==
        null,
      inDialog: dialogName !== undefined,
      css: cssPath(el),
    };
    const optional: Partial<UiElement> = {
      label: label || undefined,
      testId:
        attr('data-testid') ??
        attr('data-test-id') ??
        attr('data-test') ??
        attr('data-qa') ??
        attr('data-cy'),
      inputType,
      fieldName: attr('name'),
      frameworkName: attr('formcontrolname'),
      elementId: attr('id'),
      href,
      target: attr('target'),
      routerLink,
      autocomplete: attr('autocomplete'),
      placeholder: attr('placeholder'),
      checked:
        inputType === 'checkbox' || inputType === 'radio'
          ? Boolean(html.checked)
          : el.getAttribute('aria-checked') !== null
            ? el.getAttribute('aria-checked') === 'true'
            : undefined,
      selected: ariaSelected !== null ? ariaSelected === 'true' : undefined,
      expanded: ariaExpanded !== null ? ariaExpanded === 'true' : undefined,
      formIndex: formIndex >= 0 ? formIndex : undefined,
      dialogName,
      formGroup,
      customSelect: customSelect ? true : undefined,
      transient: closestDeep(el, TRANSIENT) ? true : undefined,
      // D'où vient « obligatoire » (attribut HTML, aria-required) : le modèle de contraintes garde l'origine.
      requiredBy: requiredBy.length > 0 ? requiredBy : undefined,
      multiple: el.hasAttribute('multiple') ? true : undefined,
      ariaInvalid: el.getAttribute('aria-invalid') === 'true' ? true : undefined,
      ...fieldInfo,
      editable: editable ? true : undefined,
      ...(editable ? { hasValue: clean((el as HTMLElement).innerText) !== '' } : {}),
      inShadow: hostOf(el) !== null ? true : undefined,
      labelGuessed: labelGuessed ? true : undefined,
      flowTarget: el.hasAttribute(FLOW_TARGET_ATTRIBUTE) ? true : undefined,
      foreground: foreground ? true : undefined,
      // Derrière un calque modal : la page derrière ne peut pas recevoir le clic.
      obscured: covered || (modal !== undefined && !inLayer) ? true : undefined,
      min: attr('min'),
      max: attr('max'),
      step: attr('step'),
      minLength: numberAttr('minlength'),
      maxLength: numberAttr('maxlength'),
      pattern: attr('pattern'),
      inputMode: attr('inputmode'),
      disabledOptions:
        tag === 'select'
          ? Array.from((el as HTMLSelectElement).options)
              .slice(0, 30)
              .filter((option) => option.disabled)
              .map((option) => clean(option.text))
          : undefined,
      options:
        tag === 'select'
          ? Array.from((el as HTMLSelectElement).options)
              .slice(0, 30)
              .map((option) => clean(option.text))
          : undefined,
    };
    for (const [key, value] of Object.entries(optional) as [string, unknown][]) {
      if (value !== undefined) (element as unknown as Record<string, unknown>)[key] = value;
    }
    elements.push(element);
  }

  // ---- formulaires (structure seulement)
  const describeFields = (fields: Element[]): FormSummary['fields'] =>
    fields.map((element) => {
      const el = element as HTMLInputElement;
      const tag = el.tagName.toLowerCase() as 'input' | 'select' | 'textarea';
      const field: FormSummary['fields'][number] = {
        tag,
        type: tag === 'input' ? (el.getAttribute('type') ?? 'text').toLowerCase() : tag,
        required: el.required || el.getAttribute('aria-required') === 'true',
        disabled: el.disabled,
        readOnly: el.hasAttribute('readonly'),
      };
      const values: Record<string, unknown> = {
        name: el.getAttribute('name') ?? undefined,
        elementId: el.id || undefined,
        label: labelOf(el) || el.getAttribute('aria-label') || undefined,
        placeholder: el.getAttribute('placeholder') ?? undefined,
        min: el.getAttribute('min') ?? undefined,
        max: el.getAttribute('max') ?? undefined,
        step: el.getAttribute('step') ?? undefined,
        minLength: el.getAttribute('minlength') ? Number(el.getAttribute('minlength')) : undefined,
        maxLength: el.getAttribute('maxlength') ? Number(el.getAttribute('maxlength')) : undefined,
        pattern: el.getAttribute('pattern') ?? undefined,
        options:
          tag === 'select'
            ? Array.from((el as unknown as HTMLSelectElement).options)
                .slice(0, 20)
                .map((option) => clean(option.text))
            : undefined,
      };
      for (const [key, value] of Object.entries(values)) {
        if (value !== undefined) (field as unknown as Record<string, unknown>)[key] = value;
      }
      return field;
    });

  const formResults: FormSummary[] = forms.map((form, index) => {
    const method = (form.getAttribute('method') ?? 'get').toLowerCase();
    const submit = form.querySelector<HTMLElement>(
      'button[type="submit"], button:not([type]), input[type="submit"]',
    );
    const result: FormSummary = {
      index,
      method,
      isSearchForm: searchForm(form),
      fields: describeFields(
        Array.from(form.querySelectorAll(FIELD_SELECTOR)).filter((field) => isVisible(field)),
      ),
    };
    if (form.getAttribute('name')) result.name = form.getAttribute('name') ?? '';
    if (form.id) result.elementId = form.id;
    if (form.getAttribute('action')) result.action = form.action;
    if (submit) result.submitLabel = clean(submit.innerText || (submit as HTMLInputElement).value);
    return result;
  });
  const orphans = deepAll(FIELD_SELECTOR).filter(
    (field) => closestDeep(field, 'form') === null && isVisible(field),
  );
  if (orphans.length > 0) {
    formResults.push({ index: -1, method: 'none', isSearchForm: false, fields: describeFields(orphans) });
  }

  // ---- signaux structurels
  const visibleTexts = (selector: string, max: number): string[] =>
    deepAll(selector)
      .filter((el) => isVisible(el))
      .map((el) => clean((el as HTMLElement).innerText || el.getAttribute('aria-label'), 80))
      .filter(Boolean)
      .slice(0, max);

  /** Forme de l'écran, sans jamais lire les données affichées (seulement les en-têtes de colonnes). */
  const structureOf = () => {
    const shown = (selector: string): Element[] => deepAll(selector).filter((el) => isVisible(el));
    const tables = shown('table, [role="table"], [role="grid"], [role="treegrid"], mat-table');
    let tableRows = 0;
    let columnHeaders: string[] = [];
    for (const table of tables) {
      const rows = Array.from(
        table.querySelectorAll('tbody tr, [role="row"], mat-row, tr.mat-mdc-row'),
      ).filter((row) => row.querySelector('th, [role="columnheader"]') === null);
      if (rows.length >= tableRows) {
        tableRows = rows.length;
        columnHeaders = Array.from(table.querySelectorAll('th, [role="columnheader"], mat-header-cell'))
          .map((cell) => clean((cell as HTMLElement).innerText, 40))
          .filter(Boolean)
          .slice(0, 8);
      }
    }
    const lists = shown('[role="list"], [role="listbox"], ul, ol').filter(
      (list) =>
        closestDeep(list, 'nav, [role="navigation"], [role="menu"], [role="tablist"]') === null &&
        list.children.length >= 3,
    ).length;
    const breadcrumb = shown(
      'nav[aria-label*="breadcrumb" i], nav[aria-label*="fil" i], .breadcrumb, .breadcrumbs, [class*="breadcrumb"]',
    )[0];
    const breadcrumbs = breadcrumb
      ? Array.from(breadcrumb.querySelectorAll('a, li, span'))
          .map((item) => clean((item as HTMLElement).innerText, 40))
          .filter((text, index, all) => text && text !== '/' && text !== '>' && all.indexOf(text) === index)
          .slice(0, 6)
      : [];
    const regions = shown(
      '[role="region"][aria-label], section[aria-label], main[aria-label], [role="main"][aria-label]',
    )
      .map((el) => clean(el.getAttribute('aria-label'), 60))
      .filter(Boolean)
      .slice(0, 8);
    const stepHeaders = shown(
      'mat-step-header, .mat-step-header, [class*="stepper"] [role="tab"], .step, .wizard-step',
    );
    const stepText = /\b(etape|étape|step)\s*\d+\s*(sur|of|\/)\s*\d+/i.exec(pageText());
    const empty = shown(
      '.empty-state, .no-data, .no-results, [class*="empty-state"], [class*="no-data"], [class*="no-results"], mat-empty',
    )[0];
    const emptyText =
      /\b(aucun(e)? (resultat|résultat|donnee|donnée|element|élément|enregistrement)|no (results?|data|items?|records?)|nothing (here|found)|liste vide|empty)\b/i.exec(
        clean(pageText(), 2000),
      );
    const structure: {
      tables: number;
      tableRows: number;
      columnHeaders: string[];
      lists: number;
      cards: number;
      breadcrumbs: string[];
      regions: string[];
      wizardSteps: number;
      fileInputs: number;
      emptyMessage?: string;
      pagination: boolean;
    } = {
      tables: tables.length,
      tableRows,
      columnHeaders,
      lists,
      cards: shown('mat-card, .mat-mdc-card, .card, .tile, [role="article"]').length,
      breadcrumbs,
      regions,
      wizardSteps:
        stepHeaders.length ||
        (stepText ? Number(stepText[0].replace(/\D+/g, ' ').trim().split(' ').pop()) : 0),
      fileInputs: deepAll('input[type="file"], [class*="dropzone"], [class*="drop-zone"], [class*="upload"]')
        .length,
      pagination:
        shown(
          'mat-paginator, .mat-mdc-paginator, nav[aria-label*="pagination" i], .pagination, [class*="paginat"]',
        ).length > 0,
    };
    const emptyShown = empty ? clean((empty as HTMLElement).innerText, 80) : emptyText?.[0];
    if (emptyShown) structure.emptyMessage = emptyShown;
    return structure;
  };

  return {
    headings: visibleTexts('h1, h2, h3, [role="heading"]', 12),
    dialogs: deepAll('[role="dialog"], [role="alertdialog"], dialog[open]')
      .filter((el) => isVisible(el))
      .map((el) => {
        const heading = el.querySelector<HTMLElement>('h1, h2, h3, [role="heading"]');
        return clean(el.getAttribute('aria-label') ?? heading?.innerText ?? 'dialog', 80);
      }),
    overlay: modal ? overlayName(modal) : undefined,
    selectedTabs: visibleTexts('[role="tab"][aria-selected="true"]', 10),
    currentItems: visibleTexts('[aria-current]:not([aria-current="false"])', 10),
    textExcerpt: clean(pageText(), 600),
    structure: structureOf(),
    elements,
    forms: formResults,
    signals: {
      // Messages montrés à l'utilisateur : alertes, bannières d'erreur, snackbars/toasts.
      alerts: deepAll(
        '[role="alert"], [role="alertdialog"], mat-snack-bar-container, .mat-mdc-snack-bar-container, .snackbar, .toast, .alert-danger, .alert-error, .error-banner, .notification-error',
      )
        .filter((el) => isVisible(el))
        .map((el) => clean((el as HTMLElement).innerText, 160))
        .filter(Boolean)
        .slice(0, 5),
      // Chargement en cours : aria-busy, barres de progression et roues de chargement.
      busy: deepAll(
        '[aria-busy="true"], [role="progressbar"], mat-spinner, mat-progress-spinner, mat-progress-bar, ngx-spinner, .spinner, .loading, .loader, [class*="spinner"], [class*="skeleton"]',
      ).some((el) => isVisible(el)),
      // Rien à voir ni à faire.
      empty: clean(pageText(), 40).length < 3 && elements.length === 0,
      invalidFields: deepAll('[aria-invalid="true"]').filter((el) => isVisible(el)).length,
    },
  };
}
