import type { Page } from 'playwright';
import type { FlowStep, FlowTarget } from '../config/flow-schema.js';

/** Ce par quoi une étape de flow en échec peut être remplacée, trouvé en inspectant l'écran. */
export interface TargetSuggestions {
  /** Étapes YAML prêtes à coller, les plus robustes d'abord. */
  suggestions: string[];
  /** Libellés des champs (ou noms des boutons) visibles à l'écran. */
  onScreen: string[];
}

type ElementStep = Extract<FlowStep, { target: FlowTarget }>;
type Kind = 'field' | 'choice' | 'clickable';

/** Une cible telle qu'écrite dans le YAML (exactement une stratégie). */
type Suggested =
  | { testId: string }
  | { role: string; name: string }
  | { label: string }
  | { text: string }
  | { css: string };

/**
 * Quand une étape de flow ne trouve pas son élément, cherche à l'écran ce que le YAML
 * voulait probablement dire : le texte de la cible (label, name ou text) est cherché à
 * l'écran — dans la fenêtre au premier plan s'il y en a une — et le champ ou contrôle
 * à côté est décrit avec la cible la plus robuste qui le trouve seul (testId, role +
 * name, id, attribut du formulaire, sinon un XPath ancré sur ce texte). Les valeurs
 * des champs ne sont jamais lues.
 */
export async function suggestTargets(page: Page, step: ElementStep): Promise<TargetSuggestions> {
  const wanted = step.target.name ?? step.target.value ?? '';
  const kind: Kind =
    step.kind === 'fill' || step.kind === 'select'
      ? 'field'
      : step.kind === 'check' || step.kind === 'uncheck'
        ? 'choice'
        : 'clickable';
  const found = await page.evaluate(inspectScreen, { wanted, kind });
  const suggestions: string[] = [];
  for (const target of found.targets) {
    if ('role' in target) {
      // Plusieurs éléments portent ce nom : pas une bonne cible.
      const count = await page
        .getByRole(target.role as Parameters<Page['getByRole']>[0], { name: target.name, exact: true })
        .count()
        .catch(() => 0);
      if (count !== 1) continue;
    }
    const line = toYaml(step, target);
    if (!suggestions.includes(line)) suggestions.push(line);
    if (suggestions.length === 3) break;
  }
  return { suggestions, onScreen: found.onScreen };
}

/** `- fill: { css: "…", value: "12345" }` */
export function toYaml(step: ElementStep, target: Suggested): string {
  const parts = Object.entries(target).map(([key, value]) => `${key}: ${quote(value)}`);
  if ('role' in target) parts.push('exact: true');
  if (step.kind === 'fill') {
    parts.push(`value: ${typeof step.value === 'string' ? quote(step.value) : `{ env: ${step.value.env} }`}`);
  }
  if (step.kind === 'select') parts.push(`option: ${quote(step.option)}`);
  return `- ${step.kind}: { ${parts.join(', ')} }`;
}

/** Scalaire YAML : brut quand c'est sûr, sinon entre guillemets doubles (la syntaxe des chaînes JSON est du YAML valide). */
function quote(value: string): string {
  return /^[\p{L}\p{N}][\p{L}\p{N} _.-]*$/u.test(value) &&
    !/^(true|false|null|yes|no|on|off|\d+)$/i.test(value)
    ? value
    : JSON.stringify(value);
}

/**
 * S'exécute dans le navigateur (sérialisé par Playwright) : autonome.
 */
function inspectScreen({ wanted, kind }: { wanted: string; kind: Kind }): {
  targets: Suggested[];
  onScreen: string[];
} {
  const norm = (text: string | null | undefined): string =>
    (text ?? '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/\*/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  const clean = (text: string | null | undefined): string =>
    (text ?? '').replace(/\*/g, ' ').replace(/\s+/g, ' ').trim();
  const visible = (el: Element): boolean => {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    if (rect.width > 0 || rect.height > 0) return true;
    return false;
  };
  const FIELD =
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]):not([type="radio"]):not([type="checkbox"]), textarea, select, [role="combobox"], [role="textbox"], [contenteditable="true"]';
  const CHOICE =
    'input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"], [role="switch"]';
  const CLICK =
    'button, a[href], [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], input[type="submit"], input[type="button"], [onclick]';
  const selector = kind === 'field' ? FIELD : kind === 'choice' ? CHOICE : CLICK;
  const MODAL = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open], .cdk-overlay-pane';
  const modals = Array.from(document.querySelectorAll(MODAL)).filter(
    (el) => visible(el) && el.querySelector(selector) !== null,
  );
  const root: Element = modals[modals.length - 1] ?? document.body;
  const ownText = (el: Element): string =>
    Array.from(el.childNodes)
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent ?? '')
      .join(' ');
  const follows = (a: Element, b: Element): boolean =>
    (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  const controls = (scope: Element): Element[] =>
    Array.from(scope.querySelectorAll(selector)).filter(
      (el) => visible(el) || (el.parentElement !== null && visible(el.parentElement)),
    );

  // ---- textes de l'écran qui ressemblent à celui cherché
  const w = norm(wanted);
  const anchors = w
    ? Array.from(root.querySelectorAll('*'))
        .filter((el) => !el.matches('script, style, option') && visible(el))
        .map((el) => ({ el, text: norm(ownText(el)) }))
        .filter(({ text }) => text !== '' && (text.includes(w) || (text.length >= 4 && w.includes(text))))
        .map(({ el, text }) => ({ el, score: text === w ? 0 : text.includes(w) ? 1 : 2 }))
        .sort((a, b) => a.score - b.score)
        .map(({ el }) => el)
    : [];

  // ---- le contrôle qui va avec un texte
  const controlFor = (anchor: Element): Element | undefined => {
    if (kind === 'clickable') {
      const clickable = anchor.closest(CLICK);
      return clickable && root.contains(clickable) ? clickable : undefined;
    }
    const label = anchor.closest('label');
    const control = label?.control;
    if (control?.matches(selector)) return control;
    let scope: Element | null = anchor.parentElement;
    for (let depth = 0; scope && depth < 5; depth += 1, scope = scope.parentElement) {
      const inside = controls(scope);
      if (kind === 'choice') {
        // L'input propre à l'option : juste avant ou juste après son texte.
        const near =
          inside.find((el) => follows(anchor, el)) ?? [...inside].reverse().find((el) => follows(el, anchor));
        if (near) return near;
      } else {
        const next = inside.find((el) => follows(anchor, el));
        if (next) return next;
      }
      if (scope === root) break;
    }
    return undefined;
  };

  // ---- la cible la plus robuste qui ne trouve que cet élément
  const IMPLICIT: Record<string, string> = {
    textarea: 'textbox',
    select: 'combobox',
    button: 'button',
    a: 'link',
  };
  const roleOf = (el: Element): string => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      const type = (el.getAttribute('type') ?? 'text').toLowerCase();
      if (type === 'radio' || type === 'checkbox') return type;
      if (type === 'submit' || type === 'button') return 'button';
      if (type === 'number') return 'spinbutton';
      return 'textbox';
    }
    return IMPLICIT[tag] ?? '';
  };
  const nameOf = (el: Element): string => {
    const aria = clean(el.getAttribute('aria-label'));
    if (aria) return aria;
    const ids = el.getAttribute('aria-labelledby');
    if (ids) {
      const text = clean(
        ids
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? '')
          .join(' '),
      );
      if (text) return text;
    }
    const labels = (el as HTMLInputElement).labels;
    if (labels && labels.length > 0) return clean(labels[0]?.textContent);
    if (kind === 'clickable') return clean((el as HTMLElement).innerText);
    return '';
  };
  const unique = (css: string, el: Element): boolean => {
    try {
      const all = document.querySelectorAll(css);
      return all.length === 1 && all[0] === el;
    } catch {
      return false;
    }
  };
  const xpathFinds = (xpath: string, el: Element): boolean => {
    try {
      const result = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      return result.snapshotLength >= 1 && result.snapshotItem(0) === el;
    } catch {
      return false;
    }
  };
  const describe = (el: Element, anchor: Element | undefined): Suggested[] => {
    const out: Suggested[] = [];
    const tag = el.tagName.toLowerCase();
    for (const attribute of ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy']) {
      const value = el.getAttribute(attribute);
      if (value && attribute === 'data-testid') out.push({ testId: value });
      else if (value && unique(`[${attribute}="${CSS.escape(value)}"]`, el))
        out.push({ css: `[${attribute}="${value}"]` });
    }
    const role = roleOf(el);
    const name = nameOf(el);
    if (role && name) out.push({ role, name });
    const id = el.getAttribute('id');
    if (id && !/\d{3,}|mat-|cdk-|ng-/.test(id) && unique(`#${CSS.escape(id)}`, el))
      out.push({ css: `#${id}` });
    for (const attribute of ['formcontrolname', 'name', 'placeholder']) {
      const value = el.getAttribute(attribute);
      if (value && unique(`${tag}[${attribute}="${CSS.escape(value)}"]`, el))
        out.push({ css: `${tag}[${attribute}="${value}"]` });
    }
    if (anchor) {
      // Plus long morceau du texte sans guillemet : utilisable dans un littéral XPath.
      const text = clean(ownText(anchor))
        .split(/['"]/)
        .sort((a, b) => b.length - a.length)[0]
        ?.trim();
      if (text) {
        if (kind === 'clickable') {
          out.push({ text: clean(ownText(anchor)) });
        } else {
          const what =
            kind === 'field'
              ? "*[self::input[not(@type='hidden')] or self::textarea or self::select or @role='combobox']"
              : "*[self::input[@type='radio' or @type='checkbox'] or @role='radio' or @role='checkbox']";
          // Le contrôle juste après le texte (une radio peut aussi être juste avant).
          for (const axis of kind === 'choice' ? ['following', 'preceding'] : ['following']) {
            const xpath = `//*[text()[contains(normalize-space(.),'${text}')]]/${axis}::${what}[1]`;
            if (xpathFinds(xpath, el)) {
              out.push({ css: `xpath=${xpath}` });
              break;
            }
          }
        }
      }
    }
    return out;
  };

  const targets: Suggested[] = [];
  const seen = new Set<Element>();
  for (const anchor of anchors) {
    const control = controlFor(anchor);
    if (!control || seen.has(control)) continue;
    seen.add(control);
    targets.push(...describe(control, anchor));
    if (seen.size >= 2) break;
  }
  // Aucun texte trouvé : les contrôles dont les attributs ressemblent au texte cherché.
  if (targets.length === 0 && w) {
    const byAttribute = controls(root).filter((el) =>
      ['aria-label', 'placeholder', 'title', 'name', 'formcontrolname', 'id']
        .map((name) => norm(el.getAttribute(name)))
        .some((value) => value !== '' && (value.includes(w) || w.includes(value))),
    );
    for (const el of byAttribute.slice(0, 2)) targets.push(...describe(el, undefined));
  }

  // ---- ce qui est à l'écran : texte avant chaque champ, noms des boutons
  const onScreen: string[] = [];
  for (const el of controls(root).slice(0, 25)) {
    let label = nameOf(el);
    if (!label && kind !== 'clickable') {
      let scope: Element | null = el.parentElement;
      for (let depth = 0; !label && scope && depth < 4; depth += 1, scope = scope.parentElement) {
        const before = Array.from(scope.querySelectorAll('*')).filter(
          (node) => follows(node, el) && !node.contains(el) && visible(node) && clean(ownText(node)) !== '',
        );
        label = clean(ownText(before[before.length - 1] ?? el)).slice(0, 60);
      }
    }
    if (label && !onScreen.includes(label)) onScreen.push(label);
  }
  return { targets, onScreen: onScreen.slice(0, 15) };
}
