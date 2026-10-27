import { cleanText, type Block } from '../document.js';
import type { ImportIssue, SourceLocation } from '../model.js';
import { childElements, parseMarkup, textOf, type MarkupElement, type MarkupNode } from './markup.js';

/**
 * LE FORMAT « STORAGE » DE CONFLUENCE (XHTML et macros `ac:` / `ri:`) vers les blocs communs.
 *
 * Lus : titres, paragraphes, listes (et listes à cocher), tableaux, contenu des macros de mise en
 * page (expand, panel, info, note, warning, tip, details, section, column), liens.
 * Signalés, non lus : macros d'inclusion (le contenu d'une autre page n'est pas importé : lecture
 * PARTIELLE), images et pièces jointes (leur contenu n'est pas lu), macros inconnues (leur corps
 * texte est lu s'il existe). Le code (macros code, noformat) n'est pas une exigence : ignoré, dit.
 */
export interface StorageResult {
  blocks: Block[];
  links: { text: string; target: string; location: SourceLocation }[];
  issues: ImportIssue[];
  partial: boolean;
}

const LAYOUT_MACROS = new Set([
  'expand',
  'panel',
  'info',
  'note',
  'warning',
  'tip',
  'details',
  'section',
  'column',
  'ui-expand',
  'excerpt',
]);
const INCLUDE_MACROS = new Set(['include', 'excerpt-include', 'children', 'pagetree', 'content-by-label']);
const CODE_MACROS = new Set(['code', 'noformat']);

export function storageToBlocks(storage: string): StorageResult {
  const { root, repaired } = parseMarkup(storage, { html: true });
  const state: StorageResult = { blocks: [], links: [], issues: [], partial: false };
  if (repaired > 0)
    state.issues.push({
      severity: 'WARNING',
      code: 'MARKUP_REPAIRED',
      message: `${String(repaired)} malformed tag(s) were closed or ignored: check the extracted text against the page`,
    });
  walk(state, root);
  return state;
}

function location(state: StorageResult): SourceLocation {
  return { block: state.blocks.length };
}

function walk(state: StorageResult, node: MarkupElement): void {
  for (const child of node.children) {
    if (child.type === 'text') {
      const text = cleanText(child.text);
      if (text) state.blocks.push({ type: 'paragraph', text, location: location(state) });
      continue;
    }
    element(state, child);
  }
}

function element(state: StorageResult, node: MarkupElement): void {
  const heading = /^h([1-6])$/.exec(node.name);
  if (heading) {
    const text = inline(state, node);
    if (text)
      state.blocks.push({ type: 'heading', level: Number(heading[1]), text, location: location(state) });
    return;
  }
  switch (node.name) {
    case 'p':
    case 'blockquote':
    case 'pre': {
      const text = inline(state, node);
      if (text) state.blocks.push({ type: 'paragraph', text, location: location(state) });
      return;
    }
    case 'ul':
    case 'ol':
      list(state, node, node.name === 'ol');
      return;
    case 'ac:task-list':
      state.blocks.push({
        type: 'list',
        ordered: false,
        items: childElements(node, 'ac:task')
          .map((task) => inline(state, childElements(task, 'ac:task-body')[0] ?? task))
          .filter(Boolean),
        location: location(state),
      });
      return;
    case 'table':
      table(state, node);
      return;
    case 'ac:structured-macro':
    case 'ac:macro':
      macro(state, node);
      return;
    case 'ac:image':
      state.issues.push({
        severity: 'WARNING',
        code: 'IMAGE_NOT_READ',
        message: 'an image is in the page: its content is not read',
        location: location(state),
      });
      return;
    case 'ac:layout':
    case 'ac:layout-section':
    case 'ac:layout-cell':
    case 'div':
    case 'section':
    case 'tbody':
    case 'thead':
    case 'ac:rich-text-body':
      walk(state, node);
      return;
    default: {
      // Élément en ligne au niveau du bloc (span, strong, a…) : un paragraphe.
      const text = inline(state, node);
      if (text) state.blocks.push({ type: 'paragraph', text, location: location(state) });
    }
  }
}

function list(state: StorageResult, node: MarkupElement, ordered: boolean, prefix = ''): void {
  const items: string[] = [];
  const nested: { node: MarkupElement; ordered: boolean; prefix: string }[] = [];
  for (const item of childElements(node, 'li')) {
    const own: MarkupNode[] = [];
    for (const child of item.children)
      if (child.type === 'element' && (child.name === 'ul' || child.name === 'ol'))
        nested.push({ node: child, ordered: child.name === 'ol', prefix: '' });
      else own.push(child);
    const text = inline(state, { type: 'element', name: 'li', attributes: {}, children: own });
    if (text) items.push(prefix + text);
    // Les sous-listes suivent leur élément, dans l'ordre de lecture.
    if (nested.length > 0) {
      if (items.length > 0)
        state.blocks.push({ type: 'list', ordered, items: items.splice(0), location: location(state) });
      for (const sub of nested.splice(0)) list(state, sub.node, sub.ordered, sub.prefix);
    }
  }
  if (items.length > 0) state.blocks.push({ type: 'list', ordered, items, location: location(state) });
}

function table(state: StorageResult, node: MarkupElement): void {
  const rows: MarkupElement[] = [];
  const collect = (parent: MarkupElement): void => {
    for (const child of childElements(parent))
      if (child.name === 'tr') rows.push(child);
      else if (child.name === 'thead' || child.name === 'tbody' || child.name === 'tfoot') collect(child);
  };
  collect(node);
  const cells = rows.map((row) =>
    childElements(row).filter((cell) => cell.name === 'th' || cell.name === 'td'),
  );
  const first = cells[0] ?? [];
  const headerRow = first.length > 0 && first.every((cell) => cell.name === 'th');
  const values = cells.map((row) => row.map((cell) => inline(state, cell)));
  if (cells.some((row) => row.some((cell) => cell.attributes.rowspan || cell.attributes.colspan)))
    state.issues.push({
      severity: 'WARNING',
      code: 'TABLE_MERGED_CELLS',
      message: 'a table has merged cells: its columns may be shifted, check the rows',
      location: location(state),
    });
  state.blocks.push({
    type: 'table',
    header: headerRow ? (values[0] ?? []) : [],
    rows: headerRow ? values.slice(1) : values,
    location: location(state),
  });
}

function macro(state: StorageResult, node: MarkupElement): void {
  const name = node.attributes['ac:name'] ?? '';
  const body = childElements(node, 'ac:rich-text-body')[0];
  if (LAYOUT_MACROS.has(name)) {
    const title = childElements(node, 'ac:parameter').find(
      (parameter) => parameter.attributes['ac:name'] === 'title',
    );
    if (title && cleanText(textOf(title)))
      state.blocks.push({ type: 'paragraph', text: cleanText(textOf(title)), location: location(state) });
    if (body) walk(state, body);
    return;
  }
  if (INCLUDE_MACROS.has(name)) {
    state.partial = true;
    state.issues.push({
      severity: 'WARNING',
      code: 'MACRO_NOT_EXPANDED',
      message: `macro "${name}" shows content from elsewhere: that content is not imported (partial read)`,
      location: location(state),
    });
    return;
  }
  if (CODE_MACROS.has(name)) {
    state.issues.push({
      severity: 'INFO',
      code: 'CODE_SKIPPED',
      message: `macro "${name}" (code) is not read as a requirement`,
      location: location(state),
    });
    return;
  }
  if (name === 'jira') {
    const key = childElements(node, 'ac:parameter').find(
      (parameter) => parameter.attributes['ac:name'] === 'key',
    );
    if (key)
      state.links.push({
        text: cleanText(textOf(key)),
        target: `jira:${cleanText(textOf(key))}`,
        location: location(state),
      });
    return;
  }
  state.issues.push({
    severity: 'WARNING',
    code: 'MACRO_UNKNOWN',
    message: `macro "${name || 'unnamed'}" is not interpreted${body ? ': its text body is read' : ': its content is not read'}`,
    location: location(state),
  });
  if (body) walk(state, body);
}

/** Le texte en ligne d'un élément ; les liens sont relevés au passage (jamais suivis). */
function inline(state: StorageResult, node: MarkupElement): string {
  const parts: string[] = [];
  const visit = (current: MarkupNode): void => {
    if (current.type === 'text') {
      parts.push(current.text);
      return;
    }
    if (current.name === 'br') {
      parts.push(' ');
      return;
    }
    if (current.name === 'ac:image') {
      state.issues.push({
        severity: 'WARNING',
        code: 'IMAGE_NOT_READ',
        message: 'an image is in the text: its content is not read',
        location: location(state),
      });
      return;
    }
    if (current.name === 'ac:structured-macro' && CODE_MACROS.has(current.attributes['ac:name'] ?? ''))
      return;
    // Une macro « status » en ligne : son libellé seul ; les autres paramètres de macro ne sont pas du texte.
    if (current.name === 'ac:structured-macro' && current.attributes['ac:name'] === 'status') {
      const title = childElements(current, 'ac:parameter').find(
        (parameter) => parameter.attributes['ac:name'] === 'title',
      );
      if (title) parts.push(` ${textOf(title)} `);
      return;
    }
    if (current.name === 'ac:parameter') return;
    if (current.name === 'time') {
      parts.push(current.attributes.datetime ?? textOf(current));
      return;
    }
    if (current.name === 'a') {
      const text = cleanText(textOf(current));
      if (current.attributes.href)
        state.links.push({ text, target: current.attributes.href, location: location(state) });
    }
    if (current.name === 'ac:link') {
      const page = childElements(current).find(
        (child) => child.name === 'ri:page' || child.name === 'ri:attachment' || child.name === 'ri:user',
      );
      const label = childElements(current).find(
        (child) => child.name === 'ac:plain-text-link-body' || child.name === 'ac:link-body',
      );
      if (page?.name === 'ri:page')
        state.links.push({
          text: cleanText(label ? textOf(label) : (page.attributes['ri:content-title'] ?? '')),
          target: `page:${page.attributes['ri:content-title'] ?? ''}`,
          location: location(state),
        });
      if (page?.name === 'ri:attachment')
        state.links.push({
          text: page.attributes['ri:filename'] ?? '',
          target: `attachment:${page.attributes['ri:filename'] ?? ''}`,
          location: location(state),
        });
      if (label) parts.push(textOf(label));
      else if (page?.name === 'ri:page') parts.push(page.attributes['ri:content-title'] ?? '');
      return;
    }
    for (const child of current.children) visit(child);
  };
  for (const child of node.children) visit(child);
  return cleanText(parts.join(''));
}
