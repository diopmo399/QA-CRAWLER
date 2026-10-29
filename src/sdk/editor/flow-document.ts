import type { YAMLMap, YAMLSeq } from 'yaml';
import {
  isMap,
  isScalar,
  isSeq,
  LineCounter,
  parseDocument,
  type Document,
  type Node as YamlNode,
} from 'yaml';
import type { GeneratedFileDiagnostic } from '../core/contracts.js';

/**
 * LE FLOW YAML, VU COMME UNE LISTE D'ÉTAPES ÉDITABLE : la vue visuelle et l'inspecteur de l'éditeur
 * lisent ce plan (étapes, groupes métier, assertions, lignes du fichier) et modifient le fichier par
 * des opérations sur le document YAML — jamais en réécrivant le texte à partir d'un modèle. Le reste du
 * fichier (commentaires de provenance, effets, empreintes, intentions, ordre des clés, style) est
 * gardé tel quel. Les positions citées par les groupes (`groups[].steps`) et les assertions
 * (`after:`) suivent les étapes déplacées, ajoutées ou retirées. Utilisé dans le navigateur (éditeur)
 * et dans Node (tests).
 */

export const FLOW_ACTIONS = [
  'goto',
  'click',
  'fill',
  'select',
  'check',
  'uncheck',
  'expect',
  'screenshot',
  'manual',
  'auto',
  'intent',
  'dragAndDrop',
] as const;
export type FlowAction = (typeof FLOW_ACTIONS)[number];

/** Les actions qui visent un élément de la page. */
export const TARGET_ACTIONS: readonly FlowAction[] = ['click', 'fill', 'select', 'check', 'uncheck'];
/** Une seule de ces clés désigne l'élément (règle du schéma du flow). */
export const TARGET_STRATEGIES = ['role', 'label', 'text', 'testId', 'css'] as const;
export type TargetStrategy = (typeof TARGET_STRATEGIES)[number];
export const ALLOWANCES = ['MUTATION', 'UNKNOWN', 'DANGEROUS'] as const;

export interface FlowTargetView {
  strategy?: TargetStrategy;
  /** La valeur de la stratégie (le rôle, le libellé, le texte…). */
  value?: string;
  /** Le nom accessible (avec `role`). */
  name?: string;
  exact?: boolean;
  nth?: number;
  section?: string;
  /** D'autres précisions gardées telles quelles (ligne de tableau, identifiant sémantique). */
  extra: string[];
}

export interface FlowStepNode {
  /** Rang dans `steps` (0…) et position citée par les groupes et les assertions (1…). */
  index: number;
  position: number;
  action: FlowAction | 'unknown';
  label: string;
  name?: string;
  target?: FlowTargetView;
  /** Saisie : littérale, donnée de test (`testData`) ou variable d'environnement (`env`). */
  value?: { kind: 'literal' | 'testData' | 'env'; text: string };
  option?: string;
  url?: string;
  /** manual, screenshot, auto : la phrase ou le libellé. */
  text?: string;
  expect?: {
    text?: string;
    url?: string;
    visible?: string;
    hidden?: string;
    noError?: boolean;
    response?: string;
  };
  allow: string[];
  optional: boolean;
  timeoutMs?: number;
  intent?: { name: string; status?: string; confidence?: number };
  /** Le commentaire au-dessus de l'étape (provenance de l'enregistrement). */
  provenance?: string;
  hasEffects: boolean;
  hasFingerprint: boolean;
  /** Les clés de données citées (`testData`, `${testData:clé}`). */
  testData: string[];
  /** Le groupe métier qui contient l'étape. */
  group?: string;
  /** Les assertions vérifiées après cette étape (`after:`). */
  assertions: string[];
  /** Lignes du fichier (1…). */
  line: number;
  endLine: number;
}

export interface FlowGroupNode {
  id: string;
  name: string;
  description?: string;
  steps: number[];
  line: number;
}

export interface FlowOutline {
  name?: string;
  startAt?: string;
  steps: FlowStepNode[];
  groups: FlowGroupNode[];
  assertions: { id: string; description?: string; after?: number; line: number }[];
  testDataFile?: string;
}

export type FlowParse =
  { ok: true; outline: FlowOutline } | { ok: false; diagnostics: GeneratedFileDiagnostic[] };

export interface NewFlowStep {
  action: FlowAction;
  target?: { strategy: TargetStrategy; value: string; name?: string };
  value?: string;
  option?: string;
  url?: string;
  text?: string;
}

export interface StepPatch {
  name?: string | null;
  target?: {
    strategy?: TargetStrategy;
    value?: string;
    name?: string | null;
    exact?: boolean | null;
    nth?: number | null;
  };
  value?: { kind: 'literal' | 'testData' | 'env'; text: string };
  option?: string;
  url?: string;
  text?: string;
  expect?: { text?: string | null; url?: string | null };
  allow?: string[];
  optional?: boolean;
  timeoutMs?: number | null;
}

export type FlowEdit =
  | { op: 'update'; index: number; patch: StepPatch }
  | { op: 'add'; after: number; step: NewFlowStep; group?: string }
  | { op: 'duplicate'; index: number }
  | { op: 'remove'; index: number }
  | { op: 'move'; from: number; to: number }
  | { op: 'group'; index: number; group: string | null };

/** Le texte modifié, et ce que l'édition a changé ailleurs (groupe vidé, assertion déplacée). */
export type FlowEditResult = { text: string; notes: string[] } | { error: string };

/**
 * Les options d'écriture qui reproduisent le fichier : pas de repli des longues lignes, et les
 * collections en ligne (`[1, 2]` ou `[ 1, 2 ]`) écrites comme le fichier les écrit le plus souvent.
 */
function textOptions(doc: Document, text: string): { lineWidth: 0; flowCollectionPadding: boolean } {
  let padded = 0;
  let tight = 0;
  visit(doc.contents, (node) => {
    if (!(isMap(node) || isSeq(node)) || !node.flow || node.items.length === 0 || !node.range) return;
    if (text[node.range[0] + 1] === ' ') padded += 1;
    else tight += 1;
  });
  return { lineWidth: 0, flowCollectionPadding: tight === 0 || padded >= tight };
}

function visit(node: unknown, see: (node: unknown) => void): void {
  see(node);
  if (isMap(node))
    for (const pair of node.items) {
      visit(pair.key, see);
      visit(pair.value, see);
    }
  else if (isSeq(node)) for (const item of node.items) visit(item, see);
}

function lineOf(counter: LineCounter, offset: number): number {
  return counter.linePos(offset).line;
}

const str = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined;

function plain(node: unknown): unknown {
  if (isMap(node) || isSeq(node)) return node.toJSON() as unknown;
  if (isScalar(node)) return node.value;
  return node;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function targetOf(raw: Record<string, unknown>): FlowTargetView {
  const strategy = TARGET_STRATEGIES.find((key) => raw[key] !== undefined);
  const known = new Set<string>([...TARGET_STRATEGIES, 'name', 'exact', 'nth', 'section', 'value', 'option']);
  return {
    ...(strategy ? { strategy, value: str(raw[strategy]) ?? '' } : {}),
    ...(str(raw.name) !== undefined ? { name: str(raw.name) } : {}),
    ...(typeof raw.exact === 'boolean' ? { exact: raw.exact } : {}),
    ...(typeof raw.nth === 'number' ? { nth: raw.nth } : {}),
    ...(str(raw.section) !== undefined ? { section: str(raw.section) } : {}),
    extra: Object.keys(raw).filter((key) => !known.has(key)),
  };
}

/** Les rôles ARIA les plus courants, dits en mots (le rôle d'origine reste dans le fichier). */
const ROLE_WORDS: Record<string, string> = {
  link: 'le lien',
  button: 'le bouton',
  textbox: 'le champ',
  checkbox: 'la case',
  radio: 'le bouton radio',
  combobox: 'la liste',
  option: 'l’option',
  tab: 'l’onglet',
  menuitem: 'l’élément de menu',
  heading: 'le titre',
  row: 'la ligne',
  cell: 'la cellule',
};

export function describeTarget(target: FlowTargetView | undefined): string {
  if (!target?.strategy) return '?';
  if (target.strategy === 'role')
    return `${ROLE_WORDS[target.value ?? ''] ?? target.value ?? ''}${target.name !== undefined ? ` « ${target.name} »` : ''}`;
  return `${target.strategy} « ${target.value ?? ''} »`;
}

function valueOf(raw: unknown): FlowStepNode['value'] {
  if (typeof raw === 'string' || typeof raw === 'number') {
    const text = String(raw);
    const data = /^\$\{testData:([^}]+)\}$/.exec(text);
    if (data?.[1]) return { kind: 'testData', text: data[1] };
    const env = /^\$\{env:([^}]+)\}$/.exec(text);
    if (env?.[1]) return { kind: 'env', text: env[1] };
    return { kind: 'literal', text };
  }
  const object = record(raw);
  if (object && typeof object.testData === 'string') return { kind: 'testData', text: object.testData };
  if (object && typeof object.env === 'string') return { kind: 'env', text: object.env };
  return undefined;
}

function citedKeys(value: unknown, into: Set<string>): void {
  if (typeof value === 'string') {
    for (const match of value.matchAll(/\$\{testData:([^}]+)\}/g)) if (match[1]) into.add(match[1]);
  } else if (Array.isArray(value)) {
    for (const item of value) citedKeys(item, into);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === 'testData' && typeof item === 'string') into.add(item);
      else citedKeys(item, into);
    }
  }
}

function labelOf(node: Omit<FlowStepNode, 'label'>): string {
  if (node.name) return node.name;
  switch (node.action) {
    case 'goto':
      return `Ouvrir ${node.url ?? ''}`;
    case 'click':
      return `Cliquer sur ${describeTarget(node.target)}`;
    case 'check':
      return `Cocher ${describeTarget(node.target)}`;
    case 'uncheck':
      return `Décocher ${describeTarget(node.target)}`;
    case 'fill':
      return `Saisir dans ${describeTarget(node.target)}`;
    case 'select':
      return `Choisir « ${node.option ?? ''} » dans ${describeTarget(node.target)}`;
    case 'expect': {
      const parts = Object.entries(node.expect ?? {}).map(([key, value]) =>
        key === 'noError' ? 'aucune erreur' : `${key} « ${String(value)} »`,
      );
      return `Vérifier ${parts.join(', ')}`;
    }
    case 'screenshot':
      return `Capture « ${node.text ?? ''} »`;
    case 'manual':
      return `Vérification manuelle : ${node.text ?? ''}`;
    case 'auto':
      return node.text ?? 'auto';
    case 'intent':
      return 'Intention';
    case 'dragAndDrop':
      return 'Glisser-déposer';
    default:
      return 'Étape inconnue';
  }
}

function stepsSeq(doc: Document): YAMLSeq | undefined {
  const steps = doc.get('steps', true);
  return isSeq(steps) ? steps : undefined;
}

/**
 * Le commentaire au-dessus de la première étape est rattaché par la bibliothèque à la liste, pas à
 * l'étape : il est replacé sur l'étape pour la suivre (le texte rendu est identique).
 */
function normalize(doc: Document): void {
  const steps = stepsSeq(doc);
  const first = steps?.items[0];
  if (steps?.commentBefore && first && (isMap(first) || isScalar(first)) && !first.commentBefore) {
    first.commentBefore = steps.commentBefore;
    steps.commentBefore = undefined;
  }
}

function load(
  text: string,
): { doc: Document; counter: LineCounter } | { diagnostics: GeneratedFileDiagnostic[] } {
  const counter = new LineCounter();
  const doc = parseDocument(text, { lineCounter: counter, keepSourceTokens: false });
  const problems = [...doc.errors, ...doc.warnings];
  if (doc.errors.length > 0)
    return {
      diagnostics: problems.map((problem) => ({
        severity: doc.errors.includes(problem as never) ? ('error' as const) : ('warning' as const),
        category: 'syntax' as const,
        message: problem.message.split('\n')[0] ?? problem.message,
        ...(problem.linePos?.[0] ? { line: problem.linePos[0].line, column: problem.linePos[0].col } : {}),
        source: 'yaml',
      })),
    };
  normalize(doc);
  return { doc, counter };
}

/** Le plan du flow : ses étapes avec leurs lignes, ses groupes, ses assertions. */
export function parseFlow(text: string): FlowParse {
  const loaded = load(text);
  if ('diagnostics' in loaded) return { ok: false, diagnostics: loaded.diagnostics };
  const { doc, counter } = loaded;
  const root = doc.contents;
  if (!isMap(root))
    return {
      ok: false,
      diagnostics: [
        {
          severity: 'error',
          category: 'schema',
          message: 'a flow is a mapping (name, steps…)',
          line: 1,
          source: 'yaml',
        },
      ],
    };
  const groupsNode = doc.get('groups', true);
  const groups: FlowGroupNode[] = isSeq(groupsNode)
    ? groupsNode.items.flatMap((item) => {
        if (!isMap(item)) return [];
        const raw = record(item.toJSON()) ?? {};
        return [
          {
            id: str(raw.id) ?? '',
            name: str(raw.name) ?? '',
            ...(str(raw.description) ? { description: str(raw.description) } : {}),
            steps: Array.isArray(raw.steps)
              ? raw.steps.filter((value): value is number => typeof value === 'number')
              : [],
            line: lineOf(counter, item.range?.[0] ?? 0),
          },
        ];
      })
    : [];
  const assertionsNode = doc.get('assertions', true);
  const assertions = isSeq(assertionsNode)
    ? assertionsNode.items.flatMap((item) => {
        if (!isMap(item)) return [];
        const raw = record(item.toJSON()) ?? {};
        return [
          {
            id: str(raw.id) ?? '',
            ...(str(raw.description) ? { description: str(raw.description) } : {}),
            ...(typeof raw.after === 'number' ? { after: raw.after } : {}),
            line: lineOf(counter, item.range?.[0] ?? 0),
          },
        ];
      })
    : [];
  const seq = stepsSeq(doc);
  const steps: FlowStepNode[] = (seq?.items ?? []).map((item, index) => {
    const position = index + 1;
    const raw = record(plain(item)) ?? {};
    const action = FLOW_ACTIONS.find((key) => raw[key] !== undefined) ?? 'unknown';
    const body = action === 'unknown' ? undefined : raw[action];
    const object = record(body);
    const keys = new Set<string>();
    citedKeys(raw, keys);
    const intent = record(raw.functionalIntent);
    const expectRaw = action === 'expect' ? object : undefined;
    const node: Omit<FlowStepNode, 'label'> = {
      index,
      position,
      action,
      ...(str(raw.name) ? { name: str(raw.name) } : {}),
      ...(object && (TARGET_ACTIONS as readonly string[]).includes(action)
        ? { target: targetOf(object) }
        : {}),
      ...(action === 'fill' && object ? { value: valueOf(object.value) } : {}),
      ...(action === 'select' && object ? { option: str(object.option) } : {}),
      ...(action === 'goto' ? { url: str(body) } : {}),
      ...(action === 'manual' || action === 'screenshot' ? { text: str(body) } : {}),
      ...(action === 'auto' && object ? { text: str(object.sentence) } : {}),
      ...(expectRaw
        ? {
            expect: {
              ...(str(expectRaw.text) ? { text: str(expectRaw.text) } : {}),
              ...(str(expectRaw.url) ? { url: str(expectRaw.url) } : {}),
              ...(record(expectRaw.visible)
                ? { visible: describeTarget(targetOf(record(expectRaw.visible) ?? {})) }
                : {}),
              ...(record(expectRaw.hidden)
                ? { hidden: describeTarget(targetOf(record(expectRaw.hidden) ?? {})) }
                : {}),
              ...(expectRaw.noError === true ? { noError: true } : {}),
              ...(record(expectRaw.response) ? { response: str(record(expectRaw.response)?.url) ?? '' } : {}),
            },
          }
        : {}),
      allow: (Array.isArray(raw.allow) ? raw.allow : raw.allow !== undefined ? [raw.allow] : []).map(String),
      optional: raw.optional === true,
      ...(typeof raw.timeoutMs === 'number' ? { timeoutMs: raw.timeoutMs } : {}),
      ...(intent && typeof intent.name === 'string'
        ? {
            intent: {
              name: intent.name,
              ...(typeof intent.status === 'string' ? { status: intent.status } : {}),
              ...(typeof intent.confidence === 'number' ? { confidence: intent.confidence } : {}),
            },
          }
        : {}),
      ...((isMap(item) || isScalar(item)) && item.commentBefore
        ? { provenance: item.commentBefore.trim() }
        : {}),
      hasEffects: raw.effects !== undefined,
      hasFingerprint: raw.fingerprint !== undefined,
      testData: [...keys],
      ...(groups.find((group) => group.steps.includes(position))
        ? { group: groups.find((group) => group.steps.includes(position))?.id }
        : {}),
      assertions: assertions
        .filter((assertion) => assertion.after === position)
        .map((assertion) => assertion.id),
      line: lineOf(counter, (item as YamlNode).range?.[0] ?? 0),
      endLine: lineOf(counter, Math.max(((item as YamlNode).range?.[1] ?? 1) - 1, 0)),
    };
    return { ...node, label: labelOf(node) };
  });
  return {
    ok: true,
    outline: {
      ...(str(root.get('name')) ? { name: str(root.get('name')) } : {}),
      ...(str(root.get('startAt')) ? { startAt: str(root.get('startAt')) } : {}),
      steps,
      groups,
      assertions,
      ...(str(root.get('testData')) ? { testDataFile: str(root.get('testData')) } : {}),
    },
  };
}

// ── Éditions ──────────────────────────────────────────────────────────────────────────────────

function stepMap(seq: YAMLSeq, index: number): YAMLMap | undefined {
  const item = seq.items[index];
  return isMap(item) ? item : undefined;
}

/** Les positions citées ailleurs, réécrites : `map(ancienne) → nouvelle | undefined` (retirée). */
function remap(doc: Document, map: (position: number) => number | undefined, notes: string[]): void {
  const groups = doc.get('groups', true);
  if (isSeq(groups)) {
    for (let index = groups.items.length - 1; index >= 0; index -= 1) {
      const group = groups.items[index];
      if (!isMap(group)) continue;
      const list = group.get('steps', true);
      if (!isSeq(list)) continue;
      const next = list.items
        .map((item) => (isScalar(item) && typeof item.value === 'number' ? map(item.value) : undefined))
        .filter((value): value is number => value !== undefined)
        .sort((a, b) => a - b);
      if (next.length === 0) {
        notes.push(`group “${String(group.get('name'))}” has no step left: it was removed`);
        groups.items.splice(index, 1);
        continue;
      }
      const flow = list.flow;
      const replacement = doc.createNode(next) as YAMLSeq;
      replacement.flow = flow;
      group.set('steps', replacement);
    }
  }
  const assertions = doc.get('assertions', true);
  if (isSeq(assertions))
    for (const assertion of assertions.items) {
      if (!isMap(assertion)) continue;
      const after = assertion.get('after');
      if (typeof after !== 'number') continue;
      let mapped = map(after);
      // L'étape retirée : l'assertion est vérifiée après l'étape qui la précédait.
      for (let previous = after - 1; mapped === undefined && previous >= 1; previous -= 1)
        mapped = map(previous);
      if (mapped === undefined) {
        assertion.delete('after');
        notes.push(`assertion ${String(assertion.get('id'))} is now checked at the end of the flow`);
      } else if (mapped !== after) assertion.set('after', mapped);
    }
}

function newStepNode(doc: Document, step: NewFlowStep): YAMLMap {
  const target = step.target
    ? {
        [step.target.strategy]: step.target.value,
        ...(step.target.strategy === 'role' && step.target.name !== undefined
          ? { name: step.target.name }
          : {}),
      }
    : undefined;
  let body: unknown;
  switch (step.action) {
    case 'goto':
      body = step.url ?? '/';
      break;
    case 'fill':
      body = { ...target, value: step.value ?? '' };
      break;
    case 'select':
      body = { ...target, option: step.option ?? '' };
      break;
    case 'expect':
      body = step.url !== undefined ? { url: step.url } : { text: step.text ?? '' };
      break;
    case 'manual':
    case 'screenshot':
      body = step.text ?? '';
      break;
    case 'click':
    case 'check':
    case 'uncheck':
      body = target ?? {};
      break;
    default:
      throw new EditError(`a ${step.action} step is added in the source view`);
  }
  return doc.createNode({ [step.action]: body });
}

class EditError extends Error {}

function applyPatch(doc: Document, item: YAMLMap, patch: StepPatch): void {
  const action = FLOW_ACTIONS.find((key) => item.has(key));
  if (!action) throw new EditError('this step has no known action');
  if (patch.name !== undefined) {
    if (patch.name === null || patch.name.trim() === '') item.delete('name');
    else item.set('name', patch.name);
  }
  const body = item.get(action, true);
  if (patch.target) {
    if (!isMap(body)) throw new EditError(`a ${action} step has no target`);
    const current = TARGET_STRATEGIES.find((key) => body.has(key));
    const strategy = patch.target.strategy ?? current;
    if (!strategy) throw new EditError('choose how the element is found');
    if (patch.target.strategy && current && current !== strategy) {
      body.delete(current);
      if (strategy !== 'role') body.delete('name');
    }
    if (patch.target.value !== undefined) body.set(strategy, patch.target.value);
    else if (patch.target.strategy && current !== strategy) body.set(strategy, '');
    if (patch.target.name !== undefined) {
      if (patch.target.name === null || strategy !== 'role') body.delete('name');
      else body.set('name', patch.target.name);
    }
    if (patch.target.exact !== undefined) {
      if (patch.target.exact === null) body.delete('exact');
      else body.set('exact', patch.target.exact);
    }
    if (patch.target.nth !== undefined) {
      if (patch.target.nth === null) body.delete('nth');
      else body.set('nth', patch.target.nth);
    }
  }
  if (patch.value) {
    if (action !== 'fill' || !isMap(body)) throw new EditError('only a fill step has a value');
    body.set(
      'value',
      patch.value.kind === 'literal'
        ? patch.value.text
        : doc.createNode(
            patch.value.kind === 'testData' ? { testData: patch.value.text } : { env: patch.value.text },
          ),
    );
  }
  if (patch.option !== undefined) {
    if (action !== 'select' || !isMap(body)) throw new EditError('only a select step has an option');
    body.set('option', patch.option);
  }
  if (patch.url !== undefined) {
    if (action !== 'goto') throw new EditError('only a goto step has a url');
    item.set('goto', patch.url);
  }
  if (patch.text !== undefined) {
    if (action === 'manual' || action === 'screenshot') item.set(action, patch.text);
    else if (action === 'auto' && isMap(body)) body.set('sentence', patch.text);
    else throw new EditError(`a ${action} step has no text`);
  }
  if (patch.expect) {
    if (action !== 'expect' || !isMap(body))
      throw new EditError('only an expect step checks a text or a url');
    for (const key of ['text', 'url'] as const) {
      const next = patch.expect[key];
      if (next === undefined) continue;
      if (next === null || next === '') body.delete(key);
      else body.set(key, next);
    }
  }
  if (patch.allow) {
    const allowed = patch.allow.filter((entry) => (ALLOWANCES as readonly string[]).includes(entry));
    if (allowed.length === 0) item.delete('allow');
    else item.set('allow', allowed.length === 1 ? allowed[0] : allowed);
  }
  if (patch.optional !== undefined) {
    if (patch.optional) item.set('optional', true);
    else item.delete('optional');
  }
  if (patch.timeoutMs !== undefined) {
    if (patch.timeoutMs === null) item.delete('timeoutMs');
    else item.set('timeoutMs', patch.timeoutMs);
  }
}

/**
 * Une édition structurée du flow. Le document est relu, modifié nœud par nœud, puis réécrit : les
 * commentaires et les clés non touchées restent ; une étape garde son commentaire de provenance quand
 * elle bouge. Refusée (sans rien changer) si le texte n'est pas un flow lisible.
 */
export function editFlow(text: string, edit: FlowEdit): FlowEditResult {
  const loaded = load(text);
  if ('diagnostics' in loaded) return { error: 'the YAML does not parse: fix it in the source view first' };
  const { doc } = loaded;
  const seq = stepsSeq(doc);
  if (!seq) return { error: 'the flow has no steps list' };
  const count = seq.items.length;
  const notes: string[] = [];
  const inRange = (index: number): boolean => Number.isInteger(index) && index >= 0 && index < count;
  try {
    switch (edit.op) {
      case 'update': {
        const item = inRange(edit.index) ? stepMap(seq, edit.index) : undefined;
        if (!item) return { error: `no step ${String(edit.index + 1)}` };
        applyPatch(doc, item, edit.patch);
        break;
      }
      case 'add': {
        if (edit.after < -1 || edit.after >= count) return { error: 'no such place in the steps' };
        const at = edit.after + 1;
        seq.items.splice(at, 0, newStepNode(doc, edit.step));
        remap(doc, (position) => (position > at ? position + 1 : position), notes);
        const group = edit.group ?? groupOf(doc, edit.after + 1);
        if (group) addToGroup(doc, group, at + 1);
        break;
      }
      case 'duplicate': {
        const item = inRange(edit.index) ? seq.items[edit.index] : undefined;
        if (!isMap(item)) return { error: `no step ${String(edit.index + 1)}` };
        const copy = item.clone() as YAMLMap;
        copy.commentBefore = undefined;
        const at = edit.index + 1;
        seq.items.splice(at, 0, copy);
        const group = groupOf(doc, edit.index + 1);
        remap(doc, (position) => (position > at ? position + 1 : position), notes);
        if (group) addToGroup(doc, group, at + 1);
        break;
      }
      case 'remove': {
        if (!inRange(edit.index)) return { error: `no step ${String(edit.index + 1)}` };
        if (count === 1) return { error: 'a flow keeps at least one step' };
        const removed = edit.index + 1;
        // Le commentaire au-dessus de la suivante n'est pas celui de l'étape retirée : il reste.
        seq.items.splice(edit.index, 1);
        remap(
          doc,
          (position) => (position === removed ? undefined : position > removed ? position - 1 : position),
          notes,
        );
        break;
      }
      case 'move': {
        if (!inRange(edit.from) || !inRange(edit.to)) return { error: 'no such step' };
        if (edit.from === edit.to) return { text, notes };
        const order = Array.from({ length: count }, (_, index) => index);
        const [moved] = order.splice(edit.from, 1);
        order.splice(edit.to, 0, moved ?? edit.from);
        const [item] = seq.items.splice(edit.from, 1);
        seq.items.splice(edit.to, 0, item);
        // order[nouveau rang] = ancien rang → position ancienne → nouvelle.
        const next = new Map(order.map((old, index) => [old + 1, index + 1]));
        remap(doc, (position) => next.get(position), notes);
        break;
      }
      case 'group': {
        if (!inRange(edit.index)) return { error: `no step ${String(edit.index + 1)}` };
        const position = edit.index + 1;
        const groups = doc.get('groups', true);
        if (
          edit.group !== null &&
          !(isSeq(groups) && groups.items.some((group) => isMap(group) && group.get('id') === edit.group))
        )
          return { error: `no group ${edit.group}` };
        if (isSeq(groups))
          for (const group of groups.items) {
            if (!isMap(group)) continue;
            const list = group.get('steps', true);
            if (!isSeq(list)) continue;
            const kept = list.items.filter((entry) => !(isScalar(entry) && entry.value === position));
            if (kept.length === 0 && group.get('id') !== edit.group)
              return { error: `the group “${String(group.get('name'))}” would have no step left` };
            list.items = kept;
          }
        if (edit.group !== null) addToGroup(doc, edit.group, position);
        break;
      }
    }
  } catch (error) {
    if (error instanceof EditError) return { error: error.message };
    throw error;
  }
  return { text: doc.toString(textOptions(doc, text)), notes };
}

function groupOf(doc: Document, position: number): string | undefined {
  const groups = doc.get('groups', true);
  if (!isSeq(groups)) return undefined;
  for (const group of groups.items) {
    if (!isMap(group)) continue;
    const list = group.get('steps', true);
    if (isSeq(list) && list.items.some((entry) => isScalar(entry) && entry.value === position))
      return String(group.get('id'));
  }
  return undefined;
}

function addToGroup(doc: Document, id: string, position: number): void {
  const groups = doc.get('groups', true);
  if (!isSeq(groups)) return;
  for (const group of groups.items) {
    if (!isMap(group) || group.get('id') !== id) continue;
    const list = group.get('steps', true);
    if (!isSeq(list)) continue;
    const values = [
      ...list.items.flatMap((entry) =>
        isScalar(entry) && typeof entry.value === 'number' ? [entry.value] : [],
      ),
      position,
    ];
    const replacement = doc.createNode([...new Set(values)].sort((a, b) => a - b)) as YAMLSeq;
    replacement.flow = list.flow;
    group.set('steps', replacement);
  }
}
