import type { ReadFile } from './files.js';
import type { UiChild, UiCondition, UiElement, UiHandler, UiState, UiTab } from './facts.js';

/**
 * LA STRUCTURE D'UN GABARIT ANGULAR : conteneurs (sections, blocs conditionnels), boutons et leurs
 * gestionnaires, conditions d'affichage (`@if`, `@else`, `@case`, `*ngIf`, `[hidden]`) et d'activation
 * (`[disabled]`), contrôles de formulaire contenus. Puis, dans la classe du composant, l'origine des membres
 * lus par ces conditions (réponse d'un appel, accesseur, formulaire, entrée) et les appels de service de
 * chaque méthode. Les expressions sont gardées telles qu'écrites : rien n'est évalué, une origine non
 * trouvée reste inconnue.
 */

const VOID = new Set(['input', 'br', 'img', 'hr', 'meta', 'link', 'area', 'base', 'col', 'source', 'wbr']);
const CONTAINER_TAGS = new Set([
  'section',
  'fieldset',
  'mat-card',
  'mat-expansion-panel',
  'mat-tab',
  'article',
]);
const HEADINGS = /^(h[1-6]|legend|mat-card-title|mat-panel-title)$/;
const KEYWORDS = new Set(['true', 'false', 'null', 'undefined', 'this', 'as', 'of', 'let', 'else', 'typeof']);

const lineAt = (text: string, offset: number): number => text.slice(0, offset).split('\n').length;
const strip = (html: string): string =>
  html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\{\{[^}]*\}\}/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const attr = (attrs: string, name: string): string | undefined => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs);
  return match ? (match[1] ?? match[2]) : undefined;
};
const slug = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'element';
/** La méthode appelée par un gestionnaire d'événement (`save()`, `validate(item)`). */
const methodOf = (expression: string | undefined): string | undefined =>
  expression ? /^\s*([A-Za-z_$][\w$]*)\s*\(/.exec(expression)?.[1] : undefined;

interface Frame {
  type: 'element' | 'block';
  tag: string;
  attrs: string;
  start: number;
  contentStart: number;
  condition?: Omit<UiCondition, 'loc'> & { at: number };
  /** Bloc : la condition passe au premier élément ouvert dedans, s'il n'y a rien d'autre avant. */
  handedTo?: Frame;
  container?: UiElement;
  name?: string;
  submitHandler?: string;
  submitExpression?: string;
  hasSubmitButton?: boolean;
  /** Un élément interactif autre qu'un bouton : lien, input, composant ou directive avec un événement. */
  interactive?: { event: string; expression: string };
  ifExpression?: string;
  /** Bloc @for : l'expression parcourue. */
  forExpr?: string;
  /** Contenu différé : gabarit d'onglet, @defer. */
  lazy?: 'TEMPLATE' | 'DEFER';
  /** Élément qui porte le libellé de l'onglet englobant (gabarit de libellé, lien ngbNavLink). */
  tabLabel?: boolean;
}

/** Les événements d'interaction d'un élément quelconque (lien, div, directive). */
const INTERACTIONS = ['click', 'dblclick', 'keydown.enter', 'keyup.enter', 'tap', 'press'];
/** Les sorties d'un composant qui ne sont pas des actions de la personne (état, focus, saisie). */
const NOT_ENTRY =
  /^(ngModelChange|valueChange|selectedTabChange|selectedIndexChange|activeIdChange|navChange|onChange|focus|blur|mouseenter|mouseleave|mouseover|mouseout|input|keyup|keydown|change|scroll|resize)$/;

/**
 * Ce qui fait d'un élément (autre qu'un bouton) un point d'entrée : un événement d'interaction (`(click)` sur
 * un lien, un input type=button, une directive), un input type=submit dans un formulaire, ou une sortie
 * d'un composant de l'application (`<app-confirm (confirmed)="…">`).
 */
function interactionOf(tag: string, attrs: string): { event: string; expression: string } | undefined {
  const events = [...attrs.matchAll(/\(([\w.-]+)\)\s*=\s*"([^"]*)"/g)].map((m) => ({
    event: m[1] ?? '',
    expression: (m[2] ?? '').trim(),
  }));
  const direct = events.find((e) => INTERACTIONS.includes(e.event));
  if (direct) return direct;
  if (tag === 'input' && /\btype\s*=\s*"submit"/.test(attrs)) return { event: 'submit', expression: '' };
  if (tag.includes('-') && !LIBRARY_TAG.test(tag)) return events.find((e) => !NOT_ENTRY.test(e.event));
  return undefined;
}

/** Les balises de bibliothèques : ce ne sont pas des composants de l'application. */
const LIBRARY_TAG = /^(mat|p|ngb|ng|cdk|router|mdc|ion|nz|dx|kendo|ejs)-/;
const hasAttr = (attrs: string, name: string): boolean =>
  new RegExp(`(?:^|\\s)[\\[(*]*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\])]*(?=\\s|=|$)`).test(attrs);
/** Une valeur liée écrite comme un littéral (`[label]="'Profil'"`) ou une valeur d'attribut simple. */
const literalAttr = (attrs: string, name: string): string | undefined => {
  const plain = attr(attrs, name);
  if (plain !== undefined) return plain.trim() || undefined;
  const bound = attr(attrs, `[${name}]`);
  const literal = bound ? /^\s*'([^']*)'\s*$|^\s*"([^"]*)"\s*$/.exec(bound) : null;
  return literal ? (literal[1] ?? literal[2]) : undefined;
};

/**
 * Le rôle d'onglet d'un élément : par la balise ou la directive d'une bibliothèque connue (Angular Material,
 * ng-bootstrap, PrimeNG), par le rôle ARIA, ou par le nom d'un composant maison (`app-tabs`, `app-tab`).
 */
export function tabRoleOf(tag: string, attrs: string): Pick<UiTab, 'role' | 'library'> | undefined {
  if (tag === 'mat-tab-group' || tag === 'mat-tab-nav-bar' || hasAttr(attrs, 'mat-tab-nav-bar'))
    return { role: 'GROUP', library: 'material' };
  if (tag === 'mat-tab') return { role: 'TAB', library: 'material' };
  if (hasAttr(attrs, 'mat-tab-link'))
    return { role: 'TAB', library: hasAttr(attrs, 'routerLink') ? 'route' : 'material' };
  if (hasAttr(attrs, 'ngbNav')) return { role: 'GROUP', library: 'ngb' };
  if (hasAttr(attrs, 'ngbNavItem')) return { role: 'TAB', library: 'ngb' };
  if (tag === 'p-tabview' || tag === 'p-tabs') return { role: 'GROUP', library: 'primeng' };
  if (tag === 'p-tabpanel') return { role: 'TAB', library: 'primeng' };
  const role = attr(attrs, 'role');
  if (role === 'tablist') return { role: 'GROUP', library: 'custom' };
  if (role === 'tabpanel') return { role: 'TAB', library: 'custom' };
  if (tag.includes('-') && !LIBRARY_TAG.test(tag)) {
    if (/(^|-)(tabs|tab-group|tabset|tab-set|tab-view|tab-container)$/.test(tag))
      return { role: 'GROUP', library: 'custom' };
    if (/(^|-)(tab|tab-item|tab-panel|tab-pane)$/.test(tag)) return { role: 'TAB', library: 'custom' };
  }
  return undefined;
}

/** Le gabarit d'un composant : en ligne (`template:`) ou dans son fichier (`templateUrl:`). */
function templateOf(
  file: ReadFile,
  decorator: string,
  decoratorAt: number,
  byPath: ReadonlyMap<string, ReadFile>,
): { html: string; file: string; offsetLine: number } | undefined {
  // En ligne : entre accents graves, ou entre guillemets (`template: ''` d'un composant de route vide).
  const inline =
    /\btemplate\s*:\s*(`)([\s\S]*?)`/.exec(decorator) ??
    /\btemplate\s*:\s*(['"])((?:\\.|(?!\1)[^\\\n])*)\1/.exec(decorator);
  if (inline?.[2] !== undefined) {
    const at = decoratorAt + inline.index + inline[0].indexOf(inline[1] ?? '`') + 1;
    return { html: inline[2], file: file.path, offsetLine: lineAt(file.text, at) - 1 };
  }
  const url = /\btemplateUrl\s*:\s*['"]([^'"]+)['"]/.exec(decorator)?.[1];
  if (!url) return undefined;
  const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
  const parts = [...(dir ? dir.split('/') : []), ...url.split('/')];
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === '.' || part === '') continue;
    if (part === '..') resolved.pop();
    else resolved.push(part);
  }
  const target = byPath.get(resolved.join('/'));
  return target ? { html: target.text, file: target.path, offsetLine: 0 } : undefined;
}

/** Les conteneurs et boutons d'un gabarit, avec leurs conditions, contrôles et gestionnaires. */
export function parseTemplate(
  component: string,
  html: string,
  file: string,
  offsetLine: number,
  /** Reçoit les composants affichés dans ce gabarit (balises, ngComponentOutlet). */
  children?: (UiChild & { holder?: UiElement })[],
): UiElement[] {
  // Les interpolations sont masquées (même longueur) : leurs accolades ne ferment aucun bloc.
  const text = html.replace(/\{\{[\s\S]*?\}\}/g, (m) => ' '.repeat(m.length));
  const elements: UiElement[] = [];
  const used = new Map<string, number>();
  const stack: Frame[] = [];
  let lastIf: string | undefined;
  const loc = (at: number) => ({ file, line: offsetLine + lineAt(html, at) });
  const nearestContainer = (): UiElement | undefined => {
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      const c = stack[i]?.container;
      if (c) return c;
    }
    return undefined;
  };
  const nearestTab = (role: UiTab['role']): UiElement | undefined => {
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      const c = stack[i]?.container;
      if (c?.tab?.role === role) return c;
    }
    return undefined;
  };
  /** Le contenu courant n'est instancié que plus tard (gabarit d'onglet, @defer). */
  const lazyHere = (): 'TEMPLATE' | 'DEFER' | undefined => {
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      const frame = stack[i];
      if (frame?.lazy) return frame.lazy;
      if (frame?.container?.tab) return undefined;
    }
    return undefined;
  };
  const nearestForm = (): Frame | undefined => {
    for (let i = stack.length - 1; i >= 0; i -= 1) if (stack[i]?.tag === 'form') return stack[i];
    return undefined;
  };
  /** Un bouton ou un élément interactif, complet à sa fermeture (son texte donne son nom). */
  const closeInteractive = (frame: Frame, inner = ''): void => {
    const custom =
      frame.interactive && frame.tag.includes('-') ? `${frame.tag} (${frame.interactive.event})` : undefined;
    const name =
      strip(inner) ||
      attr(frame.attrs, 'aria-label') ||
      attr(frame.attrs, 'title') ||
      (frame.interactive
        ? (literalAttr(frame.attrs, 'value') ?? literalAttr(frame.attrs, 'label') ?? custom)
        : undefined) ||
      (frame.tag === 'button' ? 'button' : frame.tag);
    const parent = nearestContainer();
    const disabled = attr(frame.attrs, '[disabled]') ?? attr(frame.attrs, '[attr.disabled]');
    const typeAttr = attr(frame.attrs, 'type');
    const expression = frame.interactive?.expression || attr(frame.attrs, '(click)')?.trim() || undefined;
    const click = methodOf(expression);
    const form = nearestForm();
    const submit =
      !expression &&
      (frame.tag === 'input'
        ? typeAttr === 'submit'
        : frame.tag === 'button' &&
          (typeAttr === 'submit' || (typeAttr === undefined && form !== undefined)));
    if (submit && form) form.hasSubmitButton = true;
    const handler = click ?? (submit ? form?.submitHandler : undefined);
    const event = submit ? 'ngSubmit' : (frame.interactive?.event ?? 'click');
    const full = expression ?? (submit ? form?.submitExpression : undefined);
    elements.push({
      ...(full ? { expression: full } : {}),
      event,
      id: makeId('BUTTON', name),
      component,
      kind: 'BUTTON',
      name,
      tag: frame.tag,
      ...(parent ? { parent: parent.id || `pending:${String(stackStartOf(stack, parent))}` } : {}),
      fields: [],
      ...(frame.condition
        ? {
            visibleWhen: {
              expression: frame.condition.expression,
              how: frame.condition.how,
              loc: loc(frame.condition.at),
            },
          }
        : {}),
      ...(disabled
        ? { disabledWhen: { expression: disabled.trim(), how: 'disabled', loc: loc(frame.start) } }
        : {}),
      ...(handler ? { handler } : {}),
      ...(submit ? { submit: true } : {}),
      loc: loc(frame.start),
    });
  };
  const makeId = (kind: UiElement['kind'], name: string): string => {
    const base = `${component}#${kind.toLowerCase()}:${slug(name)}`;
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    return n === 1 ? base : `${base}~${String(n)}`;
  };
  const openContainer = (frame: Frame, condition: Frame['condition'] | undefined): void => {
    const parent = nearestContainer();
    const element: UiElement = {
      id: '',
      component,
      kind: 'CONTAINER',
      name: '',
      tag: frame.tag,
      ...(parent ? { parent: parent.id || `pending:${String(stackStartOf(stack, parent))}` } : {}),
      fields: [],
      ...(condition
        ? { visibleWhen: { expression: condition.expression, how: condition.how, loc: loc(condition.at) } }
        : {}),
      loc: loc(frame.start),
    };
    frame.container = element;
    elements.push(element);
  };
  const finishContainer = (frame: Frame): void => {
    const element = frame.container;
    if (!element) return;
    const id = attr(frame.attrs, 'id');
    // Un groupe d'onglets sans nom prend celui de ses onglets (stable tant que leurs libellés le sont).
    if (frame.name === undefined && element.tab?.role === 'GROUP') {
      const labels = elements
        .filter((child) => child.parent === `pending:${String(frame.start)}` && child.tab?.role === 'TAB')
        .map((child) => child.name || child.tab?.label || child.tab?.repeat || '')
        .filter(Boolean);
      if (labels.length)
        frame.name = `Onglets : ${labels.slice(0, 3).join(', ')}${labels.length > 3 ? '…' : ''}`;
    }
    element.name = frame.name ?? (id ? id : element.visibleWhen ? element.visibleWhen.expression : frame.tag);
    element.id = makeId('CONTAINER', element.name);
    // Les enfants déjà enregistrés pointaient vers l'identifiant provisoire : ils sont rattachés.
    for (const child of elements)
      if (child.parent === `pending:${String(frame.start)}`) child.parent = element.id;
  };
  const re =
    /<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|@(if|else\s+if|else|switch|case|default|for|defer|empty)\b\s*(?:\(((?:[^()]|\((?:[^()]|\([^()]*\))*\))*)\))?[^{}<]*\{|\}/g;
  for (const m of text.matchAll(re)) {
    const at = m.index;
    const [token, closing, opening, attrs = '', selfClose, block, blockExpr] = m;
    if (closing) {
      const tag = closing.toLowerCase();
      // Fermer jusqu'à l'élément de même nom (un gabarit mal fermé ne casse pas tout).
      let index = -1;
      for (let i = stack.length - 1; i >= 0; i -= 1)
        if (stack[i]?.type === 'element' && stack[i]?.tag === tag) {
          index = i;
          break;
        }
      if (index < 0) continue;
      while (stack.length > index) {
        const frame = stack.pop();
        if (!frame) break;
        if (frame.type !== 'element') continue;
        const inner = html.slice(frame.contentStart, at);
        if (HEADINGS.test(frame.tag)) {
          const title = strip(inner);
          for (let i = stack.length - 1; i >= 0; i -= 1) {
            const owner = stack[i];
            if (owner?.container && owner.name === undefined) {
              if (title) owner.name = title;
              break;
            }
          }
        }
        // Le libellé d'un onglet écrit dans un gabarit de libellé ou un lien d'onglet.
        if (
          frame.tabLabel ||
          (frame.container?.tab && frame.container.tab.label === undefined && frame.tag === 'a')
        ) {
          const text = strip(inner);
          const tab = frame.tabLabel ? nearestTab('TAB') : frame.container;
          if (text && tab?.tab && tab.tab.label === undefined) {
            tab.tab.label = text;
            const owner = frame.tabLabel ? stack.find((f) => f.container === tab) : frame;
            if (owner) owner.name = text;
          }
        }
        if (frame.tag === 'form' && frame.submitExpression && !frame.hasSubmitButton) {
          // Un formulaire envoyé sans bouton submit lu (touche Entrée, bouton d'un composant) : son envoi est
          // le point d'entrée.
          const parent = nearestContainer();
          const name = `Envoi du formulaire${attr(frame.attrs, '[formGroup]') ? ` ${String(attr(frame.attrs, '[formGroup]')).trim()}` : ''}`;
          const handler = frame.submitHandler;
          elements.push({
            id: makeId('BUTTON', name),
            component,
            kind: 'BUTTON',
            name,
            tag: 'form',
            ...(parent ? { parent: parent.id || `pending:${String(stackStartOf(stack, parent))}` } : {}),
            fields: [],
            ...(handler ? { handler } : {}),
            submit: true,
            event: 'ngSubmit',
            expression: frame.submitExpression,
            loc: loc(frame.start),
          });
        }
        if (frame.tag === 'button' || frame.interactive) closeInteractive(frame, inner);
        if (frame.container) finishContainer(frame);
      }
      continue;
    }
    if (opening) {
      const tag = opening.toLowerCase();
      const frame: Frame = { type: 'element', tag, attrs, start: at, contentStart: at + token.length };
      // La condition d'un bloc @if passe à son premier élément.
      const top = stack[stack.length - 1];
      let condition: Frame['condition'] | undefined;
      if (top?.type === 'block' && top.condition && !top.handedTo && !top.container) {
        const before = text.slice(top.contentStart, at).trim();
        if (!before) {
          condition = top.condition;
          top.handedTo = frame;
        } else openContainer(top, top.condition);
      }
      const ngIf = attr(attrs, '*ngIf');
      const hidden = attr(attrs, '[hidden]');
      // Contenu différé d'un onglet, et libellé écrit dans un gabarit dédié.
      if (tag === 'ng-template' || hasAttr(attrs, 'ngbNavContent')) {
        if (
          hasAttr(attrs, 'matTabContent') ||
          hasAttr(attrs, 'ngbNavContent') ||
          attr(attrs, 'pTemplate') === 'content'
        ) {
          frame.lazy = 'TEMPLATE';
          const tab = nearestTab('TAB');
          if (tab?.tab) tab.tab.lazy = 'TEMPLATE';
        } else if (tag === 'ng-template') frame.lazy = 'TEMPLATE';
      }
      if (
        hasAttr(attrs, 'mat-tab-label') ||
        hasAttr(attrs, 'ngbNavLink') ||
        attr(attrs, 'pTemplate') === 'header'
      )
        frame.tabLabel = true;
      if (hasAttr(attrs, 'ngTemplateOutlet') || hasAttr(attrs, 'ngComponentOutlet')) {
        const tab = nearestTab('TAB');
        if (tab?.tab && !tab.tab.lazy) tab.tab.lazy = 'OUTLET';
        const outlet = attr(attrs, '*ngComponentOutlet') ?? attr(attrs, '[ngComponentOutlet]');
        const name = outlet ? /^\s*([A-Za-z_$][\w$]*)/.exec(outlet)?.[1] : undefined;
        const holder = nearestContainer();
        if (name && children)
          children.push({
            component,
            className: name,
            lazy: 'OUTLET',
            loc: loc(at),
            ...(holder ? { holder } : {}),
          });
      }
      // Un composant de l'application affiché ici (balise personnalisée, hors bibliothèques et onglets).
      const tabRole = tabRoleOf(tag, attrs);
      if (children && tag.includes('-') && !LIBRARY_TAG.test(tag) && !tabRole) {
        const holder = nearestContainer();
        const lazy = lazyHere();
        children.push({
          component,
          tag,
          loc: loc(at),
          ...(lazy ? { lazy } : {}),
          ...(holder ? { holder } : {}),
        });
      }
      if (!condition && ngIf)
        condition = { expression: (ngIf.split(';')[0] ?? ngIf).trim(), how: 'ngIf', at };
      else if (!condition && hidden) condition = { expression: hidden.trim(), how: 'hidden', at };
      if (tag === 'form') {
        frame.submitHandler = methodOf(attr(attrs, '(ngSubmit)'));
        const expression = attr(attrs, '(ngSubmit)')?.trim();
        if (expression) frame.submitExpression = expression;
      }
      const control = attr(attrs, 'formControlName');
      if (control) nearestContainer()?.fields.push(control);
      if (tag === 'button') {
        if (condition) frame.condition = condition;
        stack.push(frame);
        continue;
      }
      const interaction = tabRole ? undefined : interactionOf(tag, attrs);
      if (interaction) {
        if (condition) frame.condition = condition;
        frame.interactive = interaction;
        if (selfClose || VOID.has(tag)) {
          // input, ou balise auto-fermante : l'élément est complet dès son ouverture.
          stack.push(frame);
          closeInteractive(frame);
          stack.pop();
          continue;
        }
        stack.push(frame);
        continue;
      }
      if (selfClose || VOID.has(tag)) continue;
      if (tabRole) {
        stack.push(frame);
        openContainer(frame, condition);
        const tab: UiTab = { ...tabRole };
        const label =
          literalAttr(attrs, 'label') ?? literalAttr(attrs, 'header') ?? literalAttr(attrs, 'title');
        if (label) {
          tab.label = label;
          frame.name = label;
        }
        const repeat = attr(attrs, '*ngFor');
        const forBlock = [...stack].reverse().find((f) => f.type === 'block' && f.forExpr);
        const iterable = repeat ? / of ([^;]+)/.exec(repeat)?.[1] : forBlock?.forExpr;
        if (iterable) {
          tab.repeat = iterable.trim();
          frame.name ??= tab.repeat;
        }
        const route = attr(attrs, 'routerLink') ?? literalAttr(attrs, 'routerLink');
        if (route) {
          tab.route = route.trim();
          tab.lazy = 'ROUTE';
        }
        const selected = ['selectedIndex', 'activeId', 'activeIndex', 'value']
          .map((name) => attr(attrs, `[${name}]`) ?? attr(attrs, `[(${name})]`))
          .find((value) => value !== undefined);
        if (tabRole.role === 'GROUP' && selected)
          tab.selectedBy = { expression: selected.trim(), how: 'selected', loc: loc(at) };
        const element = frame.container;
        if (element) {
          element.tab = tab;
          const disabled = attr(attrs, '[disabled]');
          if (disabled) element.disabledWhen = { expression: disabled.trim(), how: 'disabled', loc: loc(at) };
          const handler = methodOf(
            [
              '(selectedTabChange)',
              '(selectedIndexChange)',
              '(navChange)',
              '(activeIdChange)',
              '(onChange)',
              '(click)',
            ]
              .map((name) => attr(attrs, name))
              .find((value) => value !== undefined),
          );
          if (handler) element.handler = handler;
        }
        continue;
      }
      if (condition || CONTAINER_TAGS.has(tag)) {
        stack.push(frame);
        openContainer(frame, condition);
        continue;
      }
      stack.push(frame);
      continue;
    }
    if (block) {
      const kind = block.replace(/\s+/g, ' ');
      const frame: Frame = {
        type: 'block',
        tag: `@${kind}`,
        attrs: '',
        start: at,
        contentStart: at + token.length,
      };
      if (kind === 'if' && blockExpr) {
        const expression = (blockExpr.split(';')[0] ?? blockExpr).trim();
        frame.condition = { expression, how: 'if', at };
        lastIf = expression;
      } else if (kind === 'else if' && blockExpr) {
        frame.condition = { expression: blockExpr.trim(), how: 'if', at };
      } else if (kind === 'else' && lastIf) {
        frame.condition = { expression: lastIf, how: 'else', at };
      } else if (kind === 'case' && blockExpr) {
        frame.condition = { expression: blockExpr.trim(), how: 'case', at };
      } else if (kind === 'for' && blockExpr) {
        frame.forExpr = / of ([^;]+)/.exec(blockExpr)?.[1]?.trim();
      } else if (kind === 'defer') {
        frame.lazy = 'DEFER';
        const tab = nearestTab('TAB');
        if (tab?.tab && !tab.tab.lazy) tab.tab.lazy = 'DEFER';
      }
      stack.push(frame);
      continue;
    }
    // « } » : ferme le dernier bloc (les éléments restés ouverts dedans se ferment avec lui).
    let index = -1;
    for (let i = stack.length - 1; i >= 0; i -= 1)
      if (stack[i]?.type === 'block') {
        index = i;
        break;
      }
    if (index < 0) continue;
    // Le bloc se ferme avec ce qu'il contenait encore d'ouvert ; un bloc devenu conteneur prend son nom.
    for (let i = stack.length - 1; i >= index; i -= 1) {
      const open = stack[i];
      if (open?.container) finishContainer(open);
    }
    stack.length = index;
  }
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const open = stack[i];
    if (open?.container) finishContainer(open);
  }
  // Les identifiants provisoires restants (conteneur jamais fermé) sont retirés.
  for (const element of elements) if (element.parent?.startsWith('pending:')) delete element.parent;
  return elements;
}

/** L'ouverture d'un conteneur dans la pile (pour l'identifiant provisoire de ses enfants). */
function stackStartOf(stack: readonly Frame[], container: UiElement): number {
  for (const frame of stack) if (frame.container === container) return frame.start;
  return -1;
}

/** Les racines des membres lus par une expression (`state.canValidate && !form.invalid` → state, form). */
export function membersOf(expression: string): { root: string; path: string[] }[] {
  // Les chaînes et les pipes (`x$ | async`, `d | date:'short'`) ne sont pas des membres.
  const cleaned = expression
    .replace(/'[^']*'|"[^"]*"|`[^`]*`/g, ' ')
    .replace(/(?<!\|)\|(?!\|)\s*[A-Za-z_$][\w$]*/g, ' ');
  const out = new Map<string, string[]>();
  for (const m of cleaned.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)((?:\??\.[A-Za-z_$][\w$]*|\(\))*)/g)) {
    const root = m[1] ?? '';
    if (KEYWORDS.has(root) || /^[A-Z]/.test(root)) continue;
    const path = (m[2] ?? '')
      .split(/\??\./)
      .map((p) => p.replace('()', ''))
      .filter(Boolean);
    if (!out.has(root)) out.set(root, path);
  }
  return [...out].map(([root, path]) => ({ root, path }));
}

/** Les champs typés d'une classe : `x = inject(Type)`, `private x: Type` (constructeur ou champ). */
function fieldTypes(body: string): Map<string, string> {
  const types = new Map<string, string>();
  for (const m of body.matchAll(/\b([a-z_$][\w$]*)\s*=\s*inject\s*\(\s*([A-Z][\w$]*)/g))
    types.set(m[1] ?? '', m[2] ?? '');
  for (const m of body.matchAll(
    /(?:private|public|protected|readonly)\s+(?:readonly\s+)?([a-z_$][\w$]*)\s*:\s*([A-Z][\w$]*)/g,
  ))
    types.set(m[1] ?? '', m[2] ?? '');
  return types;
}

/** La fin d'un appel ouvert à `open` (parenthèse appariée), bornée. */
function closeParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < Math.min(text.length, open + 4000); i += 1) {
    const c = text[i];
    if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return Math.min(text.length, open + 4000);
}

/** Les méthodes d'une classe et leur corps (accolades appariées), bornées. */
function methodsOf(body: string): { name: string; at: number; text: string }[] {
  const out: { name: string; at: number; text: string }[] = [];
  for (const m of body.matchAll(
    /^\s*(?:(?:public|private|protected|async)\s+)*([a-zA-Z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{;]+)?\{/gm,
  )) {
    const name = m[1] ?? '';
    if (['if', 'for', 'while', 'switch', 'catch', 'constructor', 'function'].includes(name)) continue;
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let end = open;
    for (let i = open; i < Math.min(body.length, open + 20000); i += 1) {
      if (body[i] === '{') depth += 1;
      else if (body[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    out.push({ name, at: m.index, text: body.slice(open, end + 1) });
  }
  return out;
}

export interface TemplateFacts {
  elements: UiElement[];
  children: UiChild[];
  states: UiState[];
  handlers: UiHandler[];
  warnings: string[];
}

/** Les gabarits et classes des composants d'une source Angular. */
export function analyzeTemplates(files: readonly ReadFile[], knownCalls: ReadonlySet<string>): TemplateFacts {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const elements: UiElement[] = [];
  const states: UiState[] = [];
  const handlers: UiHandler[] = [];
  const children: UiChild[] = [];
  const warnings: string[] = [];
  for (const file of files) {
    if (!file.path.endsWith('.ts') || !file.text.includes('@Component')) continue;
    for (const m of file.text.matchAll(
      /@Component\s*\(\s*\{([\s\S]*?)\}\s*\)\s*export\s+class\s+([A-Z][\w$]*)/g,
    )) {
      const decorator = m[1] ?? '';
      const component = m[2] ?? '';
      const decoratorAt = m.index + m[0].indexOf(decorator);
      const template = templateOf(file, decorator, decoratorAt, byPath);
      const shown: (UiChild & { holder?: UiElement })[] = [];
      const found = template
        ? parseTemplate(component, template.html, template.file, template.offsetLine, shown)
        : [];
      elements.push(...found);
      const bodyAt = m.index + m[0].length;
      const body = file.text.slice(bodyAt);
      // Les composants affichés : rattachés à leur conteneur ; ngComponentOutlet résolu par la propriété.
      for (const { holder, ...child } of shown) {
        let className = child.className;
        if (className) {
          const assigned = new RegExp(
            `\\b${className.replace(/[$]/g, '\\$')}\\s*(?::[^=;]+)?=\\s*([A-Z][\\w$]*)\\s*[;\\n]`,
          ).exec(body)?.[1];
          className = /^[A-Z]/.test(className) ? className : assigned;
          if (!className) continue;
        }
        children.push({
          ...child,
          ...(className ? { className } : {}),
          ...(holder?.id ? { container: holder.id } : {}),
        });
      }
      // Les onglets générés par une boucle : les libellés écrits dans le tableau de la classe.
      for (const el of found) {
        const repeat = el.tab?.repeat;
        if (!el.tab || !repeat || !/^[A-Za-z_$][\w$.]*$/.test(repeat)) continue;
        const name = repeat.replace(/^this\./, '');
        const array = new RegExp(`\\b${name.replace(/[$]/g, '\\$')}\\s*(?::[^=;]+)?=\\s*\\[`).exec(body);
        if (!array) continue;
        const open = array.index + array[0].length - 1;
        let depth = 0;
        let end = open;
        for (let i = open; i < Math.min(body.length, open + 8000); i += 1) {
          if (body[i] === '[') depth += 1;
          else if (body[i] === ']') {
            depth -= 1;
            if (depth === 0) {
              end = i;
              break;
            }
          }
        }
        const items = [
          ...body.slice(open, end).matchAll(/\b(?:label|title|header)\s*:\s*['"`]([^'"`]+)['"`]/g),
        ].map((x) => x[1] ?? '');
        if (items.length) el.tab.items = items.slice(0, 30);
      }
      const types = fieldTypes(body);
      const methods = methodsOf(body);
      const lineOf = (at: number) => lineAt(file.text, bodyAt + at);
      // Les appels de service de chaque méthode : this.x.m(…) où x est un service injecté.
      for (const method of methods) {
        const calls = [
          ...new Set(
            [...method.text.matchAll(/this\.([a-z_$][\w$]*)\.([a-zA-Z_$][\w$]*)\s*\(/g)]
              .map((c) => (types.get(c[1] ?? '') ? `${types.get(c[1] ?? '') ?? ''}#${c[2] ?? ''}` : ''))
              .filter((id) => id && knownCalls.has(id)),
          ),
        ];
        handlers.push({
          component,
          method: method.name,
          calls,
          loc: { file: file.path, line: lineOf(method.at) },
        });
      }
      // L'origine des membres lus par les conditions.
      const members = new Set(
        found
          .flatMap((e) => [e.visibleWhen, e.disabledWhen])
          .flatMap((c) => (c ? membersOf(c.expression).map((x) => x.root) : [])),
      );
      for (const member of members) {
        const escaped = member.replace(/[$]/g, '\\$');
        const formGroup = new RegExp(
          `\\b${escaped}\\s*=\\s*(?:this\\.(?:fb|formBuilder|builder)\\.group|new\\s+FormGroup|inject\\(FormBuilder\\)\\.group)`,
        ).exec(body);
        if (formGroup) {
          states.push({
            component,
            member,
            kind: 'FORM',
            loc: { file: file.path, line: lineOf(formGroup.index) },
          });
          continue;
        }
        const input = new RegExp(
          `@Input\\([^)]*\\)\\s*(?:set\\s+)?${escaped}\\b|\\b${escaped}\\s*=\\s*input(?:\\.required)?\\s*[<(]`,
        ).exec(body);
        if (input) {
          states.push({
            component,
            member,
            kind: 'INPUT',
            loc: { file: file.path, line: lineOf(input.index) },
          });
          continue;
        }
        const getter = new RegExp(`\\bget\\s+${escaped}\\s*\\(\\s*\\)[^{]*\\{([\\s\\S]*?)\\}`).exec(body);
        if (getter) {
          const expression = /return\s+([^;]+);/.exec(getter[1] ?? '')?.[1]?.trim();
          states.push({
            component,
            member,
            kind: 'GETTER',
            ...(expression ? { expression: expression.slice(0, 160) } : {}),
            loc: { file: file.path, line: lineOf(getter.index) },
          });
          continue;
        }
        // Affecté dans le rappel d'un appel : this.svc.m(…).subscribe((r) => { this.member = r.prop; }).
        let response: UiState | undefined;
        for (const sub of body.matchAll(/this\.([a-z_$][\w$]*)\.([a-zA-Z_$][\w$]*)\s*\(/g)) {
          const type = types.get(sub[1] ?? '');
          if (!type) continue;
          const open = sub.index + sub[0].length - 1;
          const after = body.slice(closeParen(body, open) + 1, closeParen(body, open) + 1 + 200);
          const subscribe = /^\s*(?:\.pipe\([^)]*\)\s*)?\.subscribe\s*\(\s*(?:\(\s*)?([a-zA-Z_$][\w$]*)/.exec(
            after,
          );
          if (!subscribe) continue;
          const param = subscribe[1] ?? '';
          const subAt = closeParen(body, open) + 1 + after.indexOf('.subscribe');
          const callback = body.slice(subAt, closeParen(body, body.indexOf('(', subAt)));
          const assign = new RegExp(
            `this\\.${escaped}\\s*(?:=\\s*${param}\\b((?:\\??\\.[A-Za-z_$][\\w$]*)*)|\\.set\\(\\s*${param}\\b((?:\\??\\.[A-Za-z_$][\\w$]*)*)\\s*\\))`,
          ).exec(callback);
          if (!assign) continue;
          const property = (assign[1] ?? assign[2] ?? '').split(/\??\./).filter(Boolean).join('.');
          response = {
            component,
            member,
            kind: 'RESPONSE',
            call: `${type}#${sub[2] ?? ''}`,
            ...(property ? { property } : {}),
            loc: { file: file.path, line: lineOf(subAt + (assign.index > 0 ? assign.index : 0)) },
          };
          break;
        }
        if (response) {
          states.push(response);
          continue;
        }
        const local = new RegExp(
          `(?:^|\\n)\\s*(?:(?:public|private|protected|readonly)\\s+)*${escaped}\\s*(?::[^=;]+)?=\\s*([^;\\n]+)`,
        ).exec(body);
        if (local)
          states.push({
            component,
            member,
            kind: 'LOCAL',
            expression: (local[1] ?? '').trim().slice(0, 120),
            loc: { file: file.path, line: lineOf(local.index) },
          });
      }
      if (!template && /\btemplate(Url)?\s*:/.test(decorator))
        warnings.push(`gabarit de ${component} introuvable : structure non analysée`);
    }
  }
  return { elements, children, states, handlers, warnings };
}
