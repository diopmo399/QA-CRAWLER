/**
 * Les faits d'un gabarit Angular utiles aux RÈGLES : sous quelle condition un champ,
 * un bouton ou un lien est affiché, désactivé, en lecture seule, obligatoire ; quelle
 * collection remplit les options d'une liste. Les conditions sont gardées telles
 * qu'écrites (converties plus tard avec le parseur TypeScript), jamais évaluées.
 *
 * Contrôle de flux lu : @if / @else if / @else, @switch / @case / @default, *ngIf,
 * [ngSwitch] / *ngSwitchCase, [hidden], [class.hidden], [disabled], [readonly],
 * [required], *ngFor / @for des options. Ce n'est pas un parseur HTML général.
 */

/** Une condition active : l'expression telle qu'écrite, niée dans une branche else. */
export interface TemplateCondition {
  expression: string;
  negated: boolean;
}

export interface TemplateRuleElement {
  kind: 'CONTROL' | 'BUTTON' | 'LINK' | 'ELEMENT';
  tag: string;
  /** formControlName */
  control?: string;
  /** Texte d'un bouton ou d'un lien (« Enregistrer », « Administration »). */
  label?: string;
  /** routerLink */
  route?: string;
  /** Conditions d'affichage actives (toutes vraies). */
  visibleWhen: TemplateCondition[];
  /** Liaisons conditionnelles de l'élément. */
  disabledWhen?: string;
  readonlyWhen?: string;
  requiredWhen?: string;
  hiddenWhen?: string;
  /** Liste : la collection itérée pour ses options (provinces). */
  optionsFrom?: string;
  line: number;
}

export interface TemplateRuleFacts {
  elements: TemplateRuleElement[];
}

const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
]);
const TAG = /<([a-zA-Z][\w-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>/y;
const CLOSE = /<\/([a-zA-Z][\w-]*)\s*>/y;
const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

interface Block {
  kind: 'if' | 'else' | 'switch' | 'case' | 'neutral';
  /** Les conditions que ce bloc ajoute. */
  conditions: TemplateCondition[];
  /** if / else if : les conditions précédentes de la chaîne (niées dans le else). */
  chain?: string[];
  /** switch : son sujet ; case : les valeurs déjà vues. */
  subject?: string;
  cases?: string[];
}

interface OpenElement {
  tag: string;
  conditions: TemplateCondition[];
  /** [ngSwitch]="x" posé sur cet élément. */
  switchSubject?: string;
  /** select : la collection d'un *ngFor d'option à l'intérieur. */
  controlIndex?: number;
}

export function scanTemplateRules(html: string): TemplateRuleFacts {
  const elements: TemplateRuleElement[] = [];
  const blocks: Block[] = [];
  const open: OpenElement[] = [];
  const lineAt = lineIndex(html);
  // Les interpolations {{ … }} peuvent contenir « } » : elles sont masquées (même longueur).
  const text = html.replace(/\{\{[\s\S]*?\}\}/g, (match) => ' '.repeat(match.length));
  let lastChain: string[] | undefined;
  let cursor = 0;
  const active = (): TemplateCondition[] => [
    ...blocks.flatMap((block) => block.conditions),
    ...open.flatMap((element) => element.conditions),
  ];
  const parenthesized = (from: number): { expression: string; end: number } | undefined => {
    const start = text.indexOf('(', from);
    if (start < 0) return undefined;
    let depth = 0;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (char === '(') depth += 1;
      else if (char === ')') {
        depth -= 1;
        if (depth === 0) return { expression: text.slice(start + 1, index).trim(), end: index + 1 };
      }
    }
    return undefined;
  };
  const openBrace = (from: number): number => {
    const brace = text.indexOf('{', from);
    return brace < 0 ? text.length : brace + 1;
  };

  while (cursor < text.length) {
    const char = text[cursor];
    if (text.startsWith('<!--', cursor)) {
      const end = text.indexOf('-->', cursor);
      cursor = end < 0 ? text.length : end + 3;
      continue;
    }
    if (char === '@') {
      const keyword =
        /^@(if|else\s+if|else|switch|case|default|for|defer|empty|placeholder|loading|error)\b/.exec(
          text.slice(cursor, cursor + 20),
        )?.[1];
      if (keyword) {
        const kind = keyword.replace(/\s+/, ' ');
        if (kind === 'if') {
          const condition = parenthesized(cursor);
          if (condition) {
            const expression = stripAlias(condition.expression);
            blocks.push({ kind: 'if', conditions: [{ expression, negated: false }], chain: [expression] });
            cursor = openBrace(condition.end);
            continue;
          }
        } else if (kind === 'else if' || kind === 'else') {
          const chain = lastChain ?? [];
          const negations = chain.map((expression) => ({ expression, negated: true }));
          if (kind === 'else if') {
            const condition = parenthesized(cursor);
            if (condition) {
              const expression = stripAlias(condition.expression);
              blocks.push({
                kind: 'if',
                conditions: [...negations, { expression, negated: false }],
                chain: [...chain, expression],
              });
              cursor = openBrace(condition.end);
              continue;
            }
          } else {
            blocks.push({ kind: 'else', conditions: negations });
            cursor = openBrace(cursor);
            continue;
          }
        } else if (kind === 'switch') {
          const condition = parenthesized(cursor);
          if (condition) {
            blocks.push({ kind: 'switch', conditions: [], subject: condition.expression, cases: [] });
            cursor = openBrace(condition.end);
            continue;
          }
        } else if (kind === 'case') {
          const condition = parenthesized(cursor);
          const owner = [...blocks].reverse().find((block) => block.kind === 'switch');
          if (condition && owner?.subject) {
            owner.cases?.push(condition.expression);
            blocks.push({
              kind: 'case',
              conditions: [{ expression: `${owner.subject} === ${condition.expression}`, negated: false }],
            });
            cursor = openBrace(condition.end);
            continue;
          }
        } else if (kind === 'default') {
          const owner = [...blocks].reverse().find((block) => block.kind === 'switch');
          blocks.push({
            kind: 'case',
            conditions: (owner?.cases ?? []).map((value) => ({
              expression: `${owner?.subject ?? ''} === ${value}`,
              negated: true,
            })),
          });
          cursor = openBrace(cursor);
          continue;
        } else {
          // @for, @defer… : un bloc sans condition d'affichage (@for garde sa collection).
          const after = cursor + 1 + keyword.length;
          const hasParens = /^\s*\(/.test(text.slice(after, after + 40));
          const condition = hasParens ? parenthesized(after) : undefined;
          const forOf =
            kind === 'for' && condition ? /\bof\s+([\w$.()?!]+)/.exec(condition.expression)?.[1] : undefined;
          blocks.push({ kind: 'neutral', conditions: [], ...(forOf ? { subject: forOf } : {}) });
          cursor = openBrace(condition ? condition.end : after);
          continue;
        }
      }
    }
    if (char === '}') {
      const closed = blocks.pop();
      lastChain = closed?.kind === 'if' ? closed.chain : undefined;
      cursor += 1;
      continue;
    }
    if (char === '<') {
      CLOSE.lastIndex = cursor;
      const close = CLOSE.exec(text);
      if (close) {
        const name = (close[1] ?? '').toLowerCase();
        const index = open.map((element) => element.tag).lastIndexOf(name);
        if (index >= 0) open.splice(index);
        cursor = CLOSE.lastIndex;
        lastChain = undefined;
        continue;
      }
      TAG.lastIndex = cursor;
      const tag = TAG.exec(text);
      if (tag) {
        lastChain = undefined;
        const name = (tag[1] ?? '').toLowerCase();
        const attributes = new Map<string, string>();
        for (const attribute of (tag[2] ?? '').matchAll(ATTRIBUTE))
          attributes.set(
            (attribute[1] ?? '').toLowerCase(),
            attribute[2] ?? attribute[3] ?? attribute[4] ?? '',
          );
        const own: TemplateCondition[] = [];
        const ngIf = attributes.get('*ngif');
        if (ngIf) own.push({ expression: stripAlias(ngIf.split(';')[0] ?? ngIf), negated: false });
        const caseValue = attributes.get('*ngswitchcase');
        const switchOwner = [...open].reverse().find((element) => element.switchSubject);
        if (caseValue && switchOwner?.switchSubject)
          own.push({ expression: `${switchOwner.switchSubject} === ${caseValue}`, negated: false });
        const conditions = [...active(), ...own];
        const line = lineAt(tag.index);
        const control = controlOf(attributes);
        const route = linkOf(attributes);
        const bound = (key: string): string | undefined => {
          const value = attributes.get(key);
          return value !== undefined && value.trim() !== '' ? value.trim() : undefined;
        };
        const hidden = bound('[hidden]') ?? bound('[class.hidden]') ?? bound('[class.d-none]');
        const common = {
          tag: name,
          visibleWhen: conditions,
          ...(bound('[disabled]') ? { disabledWhen: bound('[disabled]') } : {}),
          ...(bound('[readonly]') ? { readonlyWhen: bound('[readonly]') } : {}),
          ...((bound('[required]') ?? bound('[attr.required]'))
            ? { requiredWhen: bound('[required]') ?? bound('[attr.required]') }
            : {}),
          ...(hidden ? { hiddenWhen: hidden } : {}),
          line,
        };
        let elementIndex: number | undefined;
        if (control) {
          elements.push({ kind: 'CONTROL', control, ...common });
          elementIndex = elements.length - 1;
        } else if (
          name === 'button' ||
          (name === 'input' && /^(submit|button)$/i.test(attributes.get('type') ?? ''))
        ) {
          const label =
            name === 'button' ? innerText(text, TAG.lastIndex, 'button') : (attributes.get('value') ?? '');
          elements.push({
            kind: 'BUTTON',
            ...(label ? { label } : {}),
            ...(route ? { route } : {}),
            ...common,
          });
        } else if (route) {
          const label = name === 'a' ? innerText(text, TAG.lastIndex, 'a') : undefined;
          elements.push({ kind: 'LINK', route, ...(label ? { label } : {}), ...common });
        } else if (hidden && conditions.length === 0) {
          elements.push({ kind: 'ELEMENT', ...common });
        }
        // <option *ngFor="let p of provinces"> dans la liste d'un contrôle : ses options viennent de provinces.
        const ngFor = attributes.get('*ngfor');
        const collection =
          ngFor !== undefined
            ? /\bof\s+([\w$.()?!]+)/.exec(ngFor)?.[1]
            : [...blocks].reverse().find((block) => block.kind === 'neutral' && block.subject)?.subject;
        if ((name === 'option' || name === 'mat-option') && collection) {
          const owner = [...open].reverse().find((element) => element.controlIndex !== undefined);
          const target = owner?.controlIndex !== undefined ? elements[owner.controlIndex] : undefined;
          if (target && !target.optionsFrom) target.optionsFrom = collection.replace(/[()?!]/g, '');
        }
        const selfClosing = tag[3] === '/' || VOID.has(name);
        if (!selfClosing)
          open.push({
            tag: name,
            conditions: own,
            ...(attributes.get('[ngswitch]') ? { switchSubject: attributes.get('[ngswitch]') } : {}),
            ...(elementIndex !== undefined && (name === 'select' || name === 'mat-select')
              ? { controlIndex: elementIndex }
              : {}),
          });
        cursor = TAG.lastIndex;
        continue;
      }
    }
    if (!/\s/.test(char ?? '')) lastChain = undefined;
    cursor += 1;
  }
  return { elements };
}

/** « user$ | async as user » → « user$ » ; « x; as y » → « x » */
function stripAlias(expression: string): string {
  return (
    expression
      .split(';')[0]
      ?.replace(/\|\s*async\b/g, '')
      .replace(/\bas\s+\w+\s*$/, '')
      .trim() ?? expression
  );
}

function innerText(text: string, from: number, tag: string): string {
  const end = text.indexOf(`</${tag}`, from);
  if (end < 0) return '';
  return text
    .slice(from, end)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

function controlOf(attributes: Map<string, string>): string | undefined {
  const plain = attributes.get('formcontrolname');
  if (plain && /^[\w$]+$/.test(plain)) return plain;
  const bound = attributes.get('[formcontrolname]');
  const quoted = bound ? /^\s*['"]([\w$]+)['"]\s*$/.exec(bound)?.[1] : undefined;
  if (quoted) return quoted;
  const direct = attributes.get('[formcontrol]');
  if (direct) {
    const match =
      /controls\.([\w$]+)\s*$/.exec(direct) ??
      /controls\[\s*['"]([\w$]+)['"]\s*\]\s*$/.exec(direct) ??
      /\.get\(\s*['"]([\w$]+)['"]\s*\)\s*$/.exec(direct);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function linkOf(attributes: Map<string, string>): string | undefined {
  const plain = attributes.get('routerlink');
  if (plain && !plain.includes('{')) return plain.trim();
  const bound = attributes.get('[routerlink]');
  if (!bound) return undefined;
  const single = /^\s*['"]([^'"]+)['"]\s*$/.exec(bound)?.[1];
  if (single) return single;
  const array = /^\s*\[(.*)\]\s*$/.exec(bound)?.[1];
  if (!array) return undefined;
  const segments = array.split(',').map((part) => /^\s*['"]([^'"]+)['"]\s*$/.exec(part)?.[1] ?? ':param');
  if (segments.every((segment) => segment === ':param')) return undefined;
  return segments.join('/').replace(/\/{2,}/g, '/');
}

function lineIndex(text: string): (offset: number) => number {
  const starts = [0];
  for (let index = 0; index < text.length; index++) if (text[index] === '\n') starts.push(index + 1);
  return (offset) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if ((starts[middle] ?? 0) <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
}
