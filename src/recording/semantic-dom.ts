/**
 * SEMANTIC DOM — les fonctions qui s'exécutent DANS LA PAGE, partagées par l'enregistrement
 * (capture-script) et le rejeu (ContextualTargetResolver) : la même identité des deux côtés.
 *
 * Chaque fonction est AUTONOME (aucune référence extérieure) : elle est sérialisée par son
 * texte et évaluée dans la page. Jamais une valeur saisie n'est lue.
 */

/**
 * Le CHEMIN DE SECTIONS d'un élément, de la plus large à la plus proche (3 au plus) :
 * « Colonnes > Colonnes disponibles », « Général ». Sources : aria-labelledby, aria-label des
 * conteneurs, l'en-tête qui contrôle le conteneur (aria-controls d'un accordéon), le titre
 * (legend, h1–h6, role=heading, mat-panel-title…) posé AVANT l'élément dans son conteneur.
 */
export function sectionPathOf(el: Element): string[] {
  const clean = (text: string | null | undefined): string =>
    (text ?? '')
      .replace(/\s+/g, ' ')
      .replace(/\s*\*$/, '')
      .trim()
      .slice(0, 60);
  const HEADING =
    'legend, h1, h2, h3, h4, h5, h6, [role="heading"], mat-panel-title, mat-card-title, .mat-expansion-panel-header-title, summary';
  const FIELD = 'input:not([type="hidden"]), select, textarea, button, [role="textbox"], [role="combobox"]';
  const SECTIONING =
    'section, fieldset, article, aside, nav, details, form, dialog, [role="region"], [role="group"], [role="tabpanel"], [aria-labelledby], [aria-label]';
  const titleOf = (node: Element, inside: Node): string => {
    const labelledBy = node.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ');
      if (clean(text)) return clean(text);
    }
    const tag = node.tagName.toLowerCase();
    const landmark =
      ['section', 'fieldset', 'form', 'details', 'article', 'aside', 'nav', 'ul', 'ol', 'dialog'].includes(
        tag,
      ) ||
      tag.includes('-') ||
      /^(region|tabpanel|dialog|group|list|listbox|tree|grid|table)$/.test(node.getAttribute('role') ?? '');
    const aria = node.getAttribute('aria-label');
    if (aria && (landmark || tag === 'div')) return clean(aria);
    // Un accordéon / onglet : le bouton qui contrôle ce conteneur le nomme.
    if (node.id) {
      const controller = document.querySelector(`[aria-controls~="${node.id}"]`);
      if (controller && !node.contains(controller)) return clean(controller.textContent);
    }
    // Le titre le plus proche posé AVANT l'élément dans ce conteneur.
    let title = '';
    for (const child of Array.from(node.children)) {
      if (child.contains(inside)) break;
      if (child.matches(HEADING)) title = clean(child.textContent);
      // Une section SŒUR (même vide) a son propre titre : il ne nomme pas l'élément qui la suit.
      else if (!child.matches(SECTIONING) && !child.matches(FIELD) && !child.querySelector(FIELD)) {
        const heading = child.querySelector(HEADING);
        if (heading) title = clean(heading.textContent);
      }
    }
    return title;
  };
  const path: string[] = [];
  let inside: Node = el;
  let node: Element | null = el.parentElement;
  for (let depth = 0; node && node !== document.body && depth < 25 && path.length < 3; depth += 1) {
    const title = titleOf(node, inside);
    if (title && title !== path[0] && title.length >= 2) path.unshift(title);
    inside = node;
    const parent: Element | null = node.parentElement;
    if (parent) node = parent;
    else {
      const root = node.getRootNode();
      node = typeof ShadowRoot !== 'undefined' && root instanceof ShadowRoot ? root.host : null;
    }
  }
  return path;
}

/** Ce que le rejeu cherche : une cible et son contexte (jamais une position). */
export interface SemanticTargetSpec {
  /** field : un champ ; control : un contrôle cliquable ; item : un élément de liste ; container : une zone de dépôt. */
  kind: 'field' | 'control' | 'item' | 'container';
  /** Libellé, nom accessible ou texte visible attendu. */
  label?: string;
  role?: string;
  /** « Général », « Colonnes > Colonnes disponibles » : la section attendue. */
  section?: string;
  /** Un jeton unique : l'élément retenu est marqué data-qa-crawler-target="<jeton>". */
  token: string;
}

export interface SemanticScanCandidate {
  label: string;
  role: string;
  section: string;
  score: number;
  reasons: string[];
}

export interface SemanticScanResult {
  status: 'RESOLVED' | 'NOT_FOUND' | 'AMBIGUOUS';
  chosen?: SemanticScanCandidate;
  candidates: SemanticScanCandidate[];
}

/**
 * CONTEXTUAL TARGET RESOLVER (dans la page) : chaque candidat est noté par son libellé (associé,
 * aria, placeholder, ou deviné : le texte posé avant le champ), son rôle et SA SECTION. Une
 * section différente de celle attendue exclut le candidat : un champ de « Filtres » ne remplace
 * jamais un champ de « Général », même s'il a la même balise. Deux candidats aussi proches :
 * AMBIGUOUS (jamais le premier du DOM au hasard).
 */
export function semanticScan(
  spec: SemanticTargetSpec,
  sectionOf: (el: Element) => string[],
): SemanticScanResult {
  const clean = (text: string | null | undefined): string =>
    (text ?? '')
      .replace(/\s+/g, ' ')
      .replace(/\s*\*$/, '')
      .trim()
      .slice(0, 80);
  const norm = (text: string): string =>
    text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const visible = (el: Element): boolean => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  };
  const FIELD =
    'input:not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]), select, textarea, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="searchbox"], [role="spinbutton"]';
  const CONTROL =
    'button, a[href], [role="button"], [role="link"], [role="tab"], [role="menuitem"], summary, input[type="checkbox"], input[type="radio"], [role="checkbox"], [role="radio"], [role="switch"]';
  const ITEM =
    '[draggable="true"], [cdkdrag], .cdk-drag, [role="option"], [role="listitem"], [role="row"], li, [role="treeitem"]';
  const CONTAINER =
    '[cdkdroplist], .cdk-drop-list, [role="list"], [role="listbox"], [role="tree"], ul, ol, [aria-dropeffect], [data-drop-zone], tbody';
  const labelOf = (el: Element): string => {
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ');
      if (clean(text)) return clean(text);
    }
    const labels = (el as HTMLInputElement).labels;
    if (labels && labels.length > 0) return clean(labels[0]?.textContent);
    const wrapping = el.closest('label');
    if (wrapping) return clean(wrapping.textContent);
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    const field = el.closest('mat-form-field, .mat-mdc-form-field');
    const matLabel = field?.querySelector('mat-label, label');
    if (matLabel) return clean(matLabel.textContent);
    if (el.matches(FIELD)) {
      // Le texte posé juste avant le champ (libellé non relié), comme à l'enregistrement.
      let node: Element = el;
      for (let depth = 0; depth < 4; depth += 1) {
        for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
          if (sibling.matches(FIELD) || sibling.querySelector(FIELD))
            return clean(el.getAttribute('placeholder'));
          if (!visible(sibling)) continue;
          const text = clean(sibling.textContent);
          if (text) return text.length <= 60 ? text : clean(el.getAttribute('placeholder'));
        }
        const parent: Element | null = node.parentElement;
        if (!parent || parent === document.body || parent.querySelectorAll(FIELD).length > 1) break;
        node = parent;
      }
      return clean(el.getAttribute('placeholder'));
    }
    if (el.matches(CONTAINER)) return clean(el.getAttribute('aria-label'));
    return clean((el as HTMLElement).innerText || el.textContent || el.getAttribute('title'));
  };
  const roleOf = (el: Element): string => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'li') return 'listitem';
    if (tag === 'ul' || tag === 'ol') return 'list';
    if (tag === 'input') {
      const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'number') return 'spinbutton';
      return 'textbox';
    }
    return '';
  };
  const selector =
    spec.kind === 'field'
      ? FIELD
      : spec.kind === 'item'
        ? ITEM
        : spec.kind === 'container'
          ? CONTAINER
          : CONTROL;
  const wantedLabel = norm(spec.label ?? '');
  const wantedSection = (spec.section ?? '')
    .split('>')
    .map((part) => norm(part))
    .filter(Boolean);
  const scored: (SemanticScanCandidate & { el: Element })[] = [];
  for (const el of Array.from(document.querySelectorAll(selector))) {
    if (el.closest('[data-qa-crawler-overlay]') || !visible(el)) continue;
    const label = labelOf(el);
    const role = roleOf(el);
    const path = sectionOf(el);
    const section = path.join(' > ');
    const reasons: string[] = [];
    let score = 0;
    const found = norm(label);
    if (wantedLabel) {
      if (found === wantedLabel) {
        score += 0.6;
        reasons.push(`label "${label}"`);
      } else if (
        found &&
        (found.includes(wantedLabel) || (found.length >= 3 && wantedLabel.includes(found)))
      ) {
        score += 0.35;
        reasons.push(`label "${label}" close to "${spec.label ?? ''}"`);
      } else if (spec.kind !== 'container') continue;
    }
    if (spec.role && role === spec.role) {
      score += 0.1;
      reasons.push(`role ${role}`);
    }
    if (wantedSection.length > 0) {
      const found = path.map((part) => norm(part));
      const last = wantedSection[wantedSection.length - 1] ?? '';
      if (found.join('>') === wantedSection.join('>')) {
        score += 0.4;
        reasons.push(`section "${section}"`);
      } else if (found.includes(last)) {
        score += 0.3;
        reasons.push(`inside section "${spec.section ?? ''}"`);
      } else if (found.length > 0) {
        // Une AUTRE section connue : ce n'est pas la cible (Filtres ≠ Général).
        continue;
      } else score += 0.05;
    }
    if (spec.kind === 'container' && !wantedLabel && wantedSection.length === 0) continue;
    scored.push({ el, label, role, section, score: Math.round(score * 100) / 100, reasons });
  }
  // Un conteneur : le plus INTÉRIEUR des conteneurs de même score (la liste, pas la page).
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      (spec.kind === 'container' ? (a.el.contains(b.el) ? 1 : b.el.contains(a.el) ? -1 : 0) : 0),
  );
  const candidates = scored.slice(0, 5).map(({ el: _el, ...rest }) => rest);
  const [first, second] = scored;
  if (!first) return { status: 'NOT_FOUND', candidates };
  const nested =
    second !== undefined &&
    spec.kind === 'container' &&
    (first.el.contains(second.el) || second.el.contains(first.el));
  if (second && !nested && first.score - second.score < 0.1) return { status: 'AMBIGUOUS', candidates };
  first.el.setAttribute('data-qa-crawler-target', spec.token);
  const { el: _chosen, ...chosen } = first;
  return { status: 'RESOLVED', chosen, candidates };
}

/** Le texte à évaluer dans la page (CDP) : les deux fonctions, sans dépendre d'un eval de la page. */
export function semanticScanExpression(spec: SemanticTargetSpec): string {
  return [
    '(() => { if (typeof globalThis.__name !== "function") { globalThis.__name = function (fn) { return fn; }; }',
    'for (const old of Array.from(document.querySelectorAll("[data-qa-crawler-target]"))) old.removeAttribute("data-qa-crawler-target");',
    `return (${semanticScan.toString()})(${JSON.stringify(spec)}, ${sectionPathOf.toString()}); })()`,
  ].join('\n');
}

/** Le chemin de sections de l'élément marqué data-qa-crawler-probe="<jeton>" (vérification d'empreinte). */
export function sectionPathExpression(token: string): string {
  return [
    '(() => { if (typeof globalThis.__name !== "function") { globalThis.__name = function (fn) { return fn; }; }',
    `const el = document.querySelector('[data-qa-crawler-probe="${token.replace(/[^\w-]/g, '')}"]');`,
    `if (!el) return null; el.removeAttribute('data-qa-crawler-probe');`,
    `return (${sectionPathOf.toString()})(el); })()`,
  ].join('\n');
}
