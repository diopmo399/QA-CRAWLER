import type { ReadFile } from './files.js';
import type { UiCondition, UiElement, UiHandler, UiState } from './facts.js';

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
  ifExpression?: string;
}

/** Le gabarit d'un composant : en ligne (`template:`) ou dans son fichier (`templateUrl:`). */
function templateOf(
  file: ReadFile,
  decorator: string,
  decoratorAt: number,
  byPath: ReadonlyMap<string, ReadFile>,
): { html: string; file: string; offsetLine: number } | undefined {
  const inline = /\btemplate\s*:\s*`([\s\S]*?)`/.exec(decorator);
  if (inline?.[1] !== undefined) {
    const at = decoratorAt + inline.index + inline[0].indexOf('`') + 1;
    return { html: inline[1], file: file.path, offsetLine: lineAt(file.text, at) - 1 };
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
  const nearestForm = (): Frame | undefined => {
    for (let i = stack.length - 1; i >= 0; i -= 1) if (stack[i]?.tag === 'form') return stack[i];
    return undefined;
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
        if (frame.tag === 'button') {
          const name =
            strip(inner) || attr(frame.attrs, 'aria-label') || attr(frame.attrs, 'title') || 'button';
          const parent = nearestContainer();
          const disabled = attr(frame.attrs, '[disabled]') ?? attr(frame.attrs, '[attr.disabled]');
          const typeAttr = attr(frame.attrs, 'type');
          const click = methodOf(attr(frame.attrs, '(click)'));
          const form = nearestForm();
          const submit = !click && (typeAttr === 'submit' || (typeAttr === undefined && form !== undefined));
          const handler = click ?? (submit ? form?.submitHandler : undefined);
          elements.push({
            id: makeId('BUTTON', name),
            component,
            kind: 'BUTTON',
            name,
            tag: 'button',
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
        }
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
      if (!condition && ngIf)
        condition = { expression: (ngIf.split(';')[0] ?? ngIf).trim(), how: 'ngIf', at };
      else if (!condition && hidden) condition = { expression: hidden.trim(), how: 'hidden', at };
      if (tag === 'form') frame.submitHandler = methodOf(attr(attrs, '(ngSubmit)'));
      const control = attr(attrs, 'formControlName');
      if (control) nearestContainer()?.fields.push(control);
      if (tag === 'button') {
        if (condition) frame.condition = condition;
        stack.push(frame);
        continue;
      }
      if (selfClose || VOID.has(tag)) continue;
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
  const cleaned = expression.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, ' ');
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
      const found = template
        ? parseTemplate(component, template.html, template.file, template.offsetLine)
        : [];
      elements.push(...found);
      const bodyAt = m.index + m[0].length;
      const body = file.text.slice(bodyAt);
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
        warnings.push(`template of ${component} not found: structure not analysed`);
    }
  }
  return { elements, states, handlers, warnings };
}
