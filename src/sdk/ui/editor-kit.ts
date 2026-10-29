import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { java } from '@codemirror/lang-java';
import { javascript } from '@codemirror/lang-javascript';
import { yaml } from '@codemirror/lang-yaml';
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  HighlightStyle,
  indentOnInput,
  StreamLanguage,
  syntaxHighlighting,
} from '@codemirror/language';
import { gherkin } from '@codemirror/legacy-modes/mode/gherkin';
import { xml } from '@codemirror/legacy-modes/mode/xml';
import { lintGutter, lintKeymap, setDiagnostics, type Diagnostic } from '@codemirror/lint';
import { diff, MergeView } from '@codemirror/merge';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { tags } from '@lezer/highlight';
import type { GeneratedFileDiagnostic } from '../core/contracts.js';

/**
 * LE KIT DE L'ÉDITEUR, chargé à la demande par le Dashboard (un seul fichier regroupé) : l'éditeur de
 * code CodeMirror 6 (coloration par langage, numéros de ligne, indentation, recherche, diagnostics dans
 * la marge, historique, raccourcis), la comparaison de deux versions, et les modèles par format (flow
 * YAML, Gherkin, plan d'un test en code) qui alimentent la vue visuelle et l'inspecteur. Les couleurs
 * viennent des jetons du Dashboard (`--qa-color-*`) : thème clair et sombre sans palette à part.
 */

export { editFlow, parseFlow, describeTarget } from '../editor/flow-document.js';
export { editFeature, parseFeature } from '../editor/gherkin-document.js';
export { codeOutline } from '../editor/code-outline.js';

export type CodeLanguage = 'yaml' | 'gherkin' | 'typescript' | 'java' | 'xml' | 'text';

const PHRASES_FR: Record<string, string> = {
  Find: 'Rechercher',
  Replace: 'Remplacer',
  next: 'suivant',
  previous: 'précédent',
  all: 'tout',
  'match case': 'respecter la casse',
  regexp: 'expression régulière',
  'by word': 'mot entier',
  replace: 'remplacer',
  'replace all': 'tout remplacer',
  close: 'fermer',
  'current match': 'occurrence courante',
  'on line': 'à la ligne',
  'replaced match on line $': 'occurrence remplacée à la ligne $',
  'replaced $ matches': '$ occurrences remplacées',
  'Go to line': 'Aller à la ligne',
  go: 'aller',
  'Folded lines': 'Lignes repliées',
  'Unfolded lines': 'Lignes dépliées',
  'Fold line': 'Replier',
  'Unfold line': 'Déplier',
  Diagnostics: 'Diagnostics',
  'No diagnostics': 'Aucun diagnostic',
};

/** La coloration, avec les jetons du Dashboard : le même sens des couleurs que le reste de l'outil. */
const highlight = HighlightStyle.define([
  {
    tag: [tags.keyword, tags.heading, tags.controlKeyword, tags.moduleKeyword],
    color: 'var(--qa-color-primary)',
    fontWeight: '600',
  },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--qa-color-success)' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--qa-color-warning)' },
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment, tags.meta],
    color: 'var(--qa-color-muted)',
    fontStyle: 'italic',
  },
  {
    tag: [tags.propertyName, tags.definition(tags.propertyName), tags.attributeName],
    color: 'var(--qa-color-text)',
    fontWeight: '600',
  },
  { tag: [tags.typeName, tags.className, tags.annotation], color: 'var(--qa-color-primary)' },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    color: 'var(--qa-color-text)',
  },
  { tag: tags.invalid, color: 'var(--qa-color-danger)' },
]);

const theme = EditorView.theme({
  '&': {
    color: 'var(--qa-color-text)',
    backgroundColor: 'var(--qa-color-surface)',
    fontSize: '13px',
    height: '100%',
  },
  '.cm-scroller': {
    fontFamily: 'var(--qa-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
    lineHeight: '1.55',
  },
  '.cm-content': { caretColor: 'var(--qa-color-primary)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-gutters': {
    backgroundColor: 'var(--qa-color-surface)',
    color: 'var(--qa-color-muted)',
    borderRight: '1px solid var(--qa-color-border)',
  },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--qa-color-primary) 6%, transparent)' },
  '.cm-activeLineGutter': {
    backgroundColor: 'color-mix(in srgb, var(--qa-color-primary) 10%, transparent)',
    color: 'var(--qa-color-text)',
  },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--qa-color-primary) 22%, transparent) !important',
  },
  '.cm-cursor': { borderLeftColor: 'var(--qa-color-primary)' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--qa-color-warning) 30%, transparent)' },
  '.cm-searchMatch-selected': {
    backgroundColor: 'color-mix(in srgb, var(--qa-color-warning) 55%, transparent)',
  },
  '.cm-panels': {
    backgroundColor: 'var(--qa-color-surface)',
    color: 'var(--qa-color-text)',
    borderColor: 'var(--qa-color-border)',
  },
  '.cm-panels input, .cm-panels button': { font: 'inherit', fontSize: '13px' },
  '.cm-textfield': {
    border: '1px solid var(--qa-color-border)',
    borderRadius: '6px',
    padding: '3px 6px',
    background: 'var(--qa-color-surface)',
    color: 'var(--qa-color-text)',
  },
  '.cm-button': {
    border: '1px solid var(--qa-color-border)',
    borderRadius: '6px',
    backgroundImage: 'none',
    background: 'var(--qa-color-surface)',
    color: 'var(--qa-color-text)',
  },
  '.cm-diagnostic-error': { borderLeftColor: 'var(--qa-color-danger)' },
  '.cm-diagnostic-warning': { borderLeftColor: 'var(--qa-color-warning)' },
  '.cm-lintRange-error': {
    backgroundImage: 'none',
    textDecoration: 'underline wavy var(--qa-color-danger)',
    textUnderlineOffset: '3px',
  },
  '.cm-lintRange-warning': {
    backgroundImage: 'none',
    textDecoration: 'underline wavy var(--qa-color-warning)',
    textUnderlineOffset: '3px',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--qa-color-surface)',
    color: 'var(--qa-color-text)',
    border: '1px solid var(--qa-color-border)',
    borderRadius: '8px',
  },
  '.cm-foldPlaceholder': {
    backgroundColor: 'transparent',
    border: '1px solid var(--qa-color-border)',
    color: 'var(--qa-color-muted)',
  },
  // La comparaison : ajouts et suppressions lisibles dans les deux thèmes.
  '&.cm-merge-a .cm-changedLine, .cm-deletedChunk': {
    backgroundColor: 'color-mix(in srgb, var(--qa-color-danger) 10%, transparent)',
  },
  '&.cm-merge-b .cm-changedLine': {
    backgroundColor: 'color-mix(in srgb, var(--qa-color-success) 12%, transparent)',
  },
  '&.cm-merge-a .cm-changedText, .cm-deletedChunk .cm-deletedText': {
    backgroundColor: 'color-mix(in srgb, var(--qa-color-danger) 28%, transparent)',
  },
  '&.cm-merge-b .cm-changedText': {
    backgroundColor: 'color-mix(in srgb, var(--qa-color-success) 30%, transparent)',
  },
});

function languageOf(language: CodeLanguage): Extension {
  switch (language) {
    case 'yaml':
      return yaml();
    case 'gherkin':
      return StreamLanguage.define(gherkin);
    case 'typescript':
      return javascript({ typescript: true });
    case 'java':
      return java();
    case 'xml':
      return StreamLanguage.define(xml);
    default:
      return [];
  }
}

const base = (language: CodeLanguage, locale: 'fr' | 'en'): Extension[] => [
  lineNumbers(),
  highlightActiveLineGutter(),
  foldGutter(),
  drawSelection(),
  indentOnInput(),
  bracketMatching(),
  highlightActiveLine(),
  // Lisible sans défilement horizontal : les longues lignes (commentaires de provenance) se replient à l'écran.
  EditorView.lineWrapping,
  highlightSelectionMatches(),
  syntaxHighlighting(highlight),
  languageOf(language),
  theme,
  EditorState.tabSize.of(2),
  ...(locale === 'fr' ? [EditorState.phrases.of(PHRASES_FR)] : []),
];

/** Une position (ligne, colonne 1…) dans le document, bornée. */
function offsetOf(state: EditorState, line: number, column = 1): number {
  const target = state.doc.line(Math.min(Math.max(line, 1), state.doc.lines));
  return Math.min(target.from + Math.max(column - 1, 0), target.to);
}

export interface CodeEditorHandle {
  readonly view: EditorView;
  getText(): string;
  /** Remplace le contenu (une édition structurée, une restauration) : annulable par Ctrl+Z. */
  setText(text: string): void;
  setDiagnostics(diagnostics: readonly GeneratedFileDiagnostic[]): void;
  goTo(line: number, column?: number): void;
  setReadOnly(readOnly: boolean): void;
  /** Replace l'éditeur dans un nouvel hôte (le Dashboard redessine sa page). */
  attach(host: Element): void;
  hasFocus(): boolean;
  destroy(): void;
}

export function createCodeEditor(options: {
  root: ShadowRoot | Document;
  text: string;
  language: CodeLanguage;
  locale: 'fr' | 'en';
  label: string;
  readOnly?: boolean;
  onChange(text: string): void;
  onSave(): void;
}): CodeEditorHandle {
  const editable = new Compartment();
  let silent = false;
  const view = new EditorView({
    root: options.root,
    state: EditorState.create({
      doc: options.text,
      extensions: [
        ...base(options.language, options.locale),
        history(),
        search({ top: true }),
        lintGutter(),
        editable.of([
          EditorState.readOnly.of(options.readOnly === true),
          EditorView.editable.of(options.readOnly !== true),
        ]),
        keymap.of([
          {
            key: 'Mod-s',
            preventDefault: true,
            run: () => {
              options.onSave();
              return true;
            },
          },
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          ...foldKeymap,
          ...lintKeymap,
          indentWithTab,
        ]),
        EditorView.contentAttributes.of({ 'aria-label': options.label }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !silent) options.onChange(update.state.doc.toString());
        }),
      ],
    }),
  });
  return {
    view,
    getText: () => view.state.doc.toString(),
    setText: (text) => {
      if (text === view.state.doc.toString()) return;
      silent = true;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
      silent = false;
    },
    setDiagnostics: (diagnostics) => {
      const state = view.state;
      const list: Diagnostic[] = diagnostics
        .filter((diagnostic) => diagnostic.line !== undefined && diagnostic.file === undefined)
        .map((diagnostic) => {
          const from = offsetOf(state, diagnostic.line ?? 1, diagnostic.column);
          const line = state.doc.lineAt(from);
          return {
            from,
            to: diagnostic.column ? Math.max(from, line.to) : line.to,
            severity: diagnostic.severity,
            message: diagnostic.message,
            source: diagnostic.source,
          };
        });
      view.dispatch(setDiagnostics(state, list));
    },
    goTo: (line, column) => {
      const at = offsetOf(view.state, line, column);
      view.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: 'center' }) });
      view.focus();
    },
    setReadOnly: (readOnly) => {
      view.dispatch({
        effects: editable.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
      });
    },
    attach: (host) => {
      if (view.dom.parentElement === host) return;
      const scroll = view.scrollDOM.scrollTop;
      host.appendChild(view.dom);
      view.scrollDOM.scrollTop = scroll;
      view.requestMeasure();
    },
    hasFocus: () => view.hasFocus,
    destroy: () => {
      view.destroy();
    },
  };
}

export interface DiffHandle {
  attach(host: Element): void;
  destroy(): void;
}

/** Deux versions côte à côte (lecture seule), différences surlignées, longues parties identiques repliées. */
export function createDiff(options: {
  root: ShadowRoot | Document;
  left: string;
  right: string;
  language: CodeLanguage;
  locale: 'fr' | 'en';
}): DiffHandle {
  const readOnly = [EditorState.readOnly.of(true), EditorView.editable.of(false)];
  const merge = new MergeView({
    a: { doc: options.left, extensions: [...base(options.language, options.locale), ...readOnly] },
    b: { doc: options.right, extensions: [...base(options.language, options.locale), ...readOnly] },
    root: options.root,
    gutter: true,
    highlightChanges: true,
    collapseUnchanged: { margin: 3, minSize: 6 },
  });
  return {
    attach: (host) => {
      if (merge.dom.parentElement !== host) host.appendChild(merge.dom);
    },
    destroy: () => {
      merge.destroy();
    },
  };
}

/** Le texte complet d'un éditeur monté (CodeMirror ne dessine que les lignes visibles). */
export function editorText(dom: HTMLElement): string | undefined {
  return EditorView.findFromDOM(dom)?.state.doc.toString();
}

/**
 * Le nombre de lignes ajoutées et retirées entre deux versions, et le nombre de blocs de différences
 * (le résumé de la comparaison) : une comparaison LIGNE PAR LIGNE (plus longue sous-suite commune), le
 * surlignage fin restant celui de la vue côte à côte.
 */
export function diffSummary(
  left: string,
  right: string,
): { added: number; removed: number; changes: number } {
  const a = left.split('\n');
  const b = right.split('\n');
  // Les lignes communes au début et à la fin ne comptent pas (et allègent le calcul).
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const x = a.slice(start, endA);
  const y = b.slice(start, endB);
  if (x.length * y.length > 4_000_000)
    return { added: y.length, removed: x.length, changes: diff(left, right).length };
  const table = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i -= 1)
    for (let j = y.length - 1; j >= 0; j -= 1)
      (table[i] as Uint32Array)[j] =
        x[i] === y[j]
          ? ((table[i + 1] as Uint32Array)[j + 1] ?? 0) + 1
          : Math.max((table[i + 1] as Uint32Array)[j] ?? 0, (table[i] as Uint32Array)[j + 1] ?? 0);
  let added = 0;
  let removed = 0;
  let changes = 0;
  let inChange = false;
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      i += 1;
      j += 1;
      inChange = false;
      continue;
    }
    if (!inChange) changes += 1;
    inChange = true;
    if (
      j < y.length &&
      (i >= x.length || ((table[i] as Uint32Array)[j + 1] ?? 0) >= ((table[i + 1] as Uint32Array)[j] ?? 0))
    ) {
      added += 1;
      j += 1;
    } else {
      removed += 1;
      i += 1;
    }
  }
  return { added, removed, changes };
}
