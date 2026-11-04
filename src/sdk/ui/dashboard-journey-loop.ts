import type { LibraryBlockView } from '../core/contracts.js';
import type { JourneyGraph, JourneyNode } from '../core/journey.js';
import {
  defaultLoop,
  JOURNEY_LOOP_LIMITS,
  JOURNEY_LOOP_TYPES,
  loopSummary,
  loopVariableKeys,
  type JourneyLoopElement,
  type JourneyLoopItem,
  type JourneyLoopParam,
  type JourneyLoopSpec,
} from '../core/journey-loop.js';
import { defaultWait, WAIT_TYPES, type WaitSpec } from '../core/wait.js';
import { icon } from './dashboard-parts.js';
import type { DashboardState } from './dashboard-view.js';
import { esc } from './view.js';
import { freshCheck, remember, type JourneyUi } from './dashboard-journey.js';

/**
 * LE NŒUD BOUCLE DU COMPOSITEUR (modèle : src/sdk/core/journey-loop.ts) : un conteneur violet qui répète une
 * suite de blocs (et d'attentes). Ses réglages sont ceux que le moteur exécute réellement : type, nombre de
 * fois ou collection ou condition, plafond d'itérations, délai global, politique d'échec. Rien n'est aplati.
 */

const FR = {
  loop: 'Boucle',
  loopSub: 'Répéter des blocs (bornée)',
  toast: 'Boucle ajoutée : choisissez les blocs à répéter dans ses propriétés.',
  types: { REPEAT: 'Répéter N fois', FOR_EACH: 'Pour chaque élément', WHILE: 'Tant que' } as Record<
    string,
    string
  >,
  type: 'Type de boucle',
  times: 'Nombre de répétitions',
  as: 'Nom de la variable d’itération',
  asHelp: (as: string) =>
    `Dans la boucle : \${testData:${as}.index} (1, 2…), \${testData:${as}} ou \${testData:${as}.<champ>}.`,
  source: 'Collection',
  sourceInline: 'Éléments écrits ici',
  sourceData: 'Une donnée du parcours (tableau JSON)',
  items: 'Éléments (un par ligne ; des champs : prenom=Ada; nom=Byron)',
  itemsFrom: 'Clé de la donnée',
  condition: 'Condition (vérifiée avant chaque itération)',
  conditionTypes: {
    VISIBLE: 'Élément visible',
    HIDDEN: 'Élément caché',
    TEXT: 'Texte visible',
    URL: 'Adresse contient',
    RESPONSE: 'Réponse HTTP vue',
  } as Record<string, string>,
  conditionSelector: 'Sélecteur CSS',
  conditionText: 'Texte',
  conditionUrl: 'Adresse',
  maxIterations: 'Plafond d’itérations',
  maxHelp: `Protection : au plus ${String(JOURNEY_LOOP_LIMITS.maxIterations)} ; une boucle « tant que » encore vraie au plafond échoue.`,
  timeout: 'Délai global (secondes)',
  onFailure: 'Si une itération échoue',
  stop: 'Arrêter la boucle (échec)',
  continue: 'Continuer les itérations, puis échouer',
  body: 'Contenu de la boucle',
  bodyEmpty: 'Ajoutez au moins un bloc à répéter.',
  addBlock: 'Ajouter un bloc',
  addWait: 'Ajouter une attente',
  pickBlock: 'Choisir un bloc…',
  remove: 'Retirer',
  up: 'Monter',
  down: 'Descendre',
  wait: 'Attente',
  params: 'Entrées',
  paramFrom: 'Reçoit',
  paramUpstream: 'l’amont ou ses données',
  paramVar: (key: string) => `variable ${key}`,
  variables: 'Variables de l’itération',
  open: 'les champs viennent de la donnée (inconnus avant l’exécution)',
  local: 'Ce que les blocs de la boucle produisent n’existe que pendant une itération.',
  diagnostics: 'Diagnostics',
  notChecked: 'Vérifiez le parcours pour voir les diagnostics.',
  ok: 'Aucun problème détecté.',
  iterations: (count: number) => `${String(count)} élément(s)`,
  more: (count: number) => `+${String(count)} autre(s)`,
  version: (version: number) => `v${String(version)}`,
  unknown: 'bloc inconnu',
};
type Text = typeof FR;
const EN: Text = {
  loop: 'Loop',
  loopSub: 'Repeat blocks (bounded)',
  toast: 'Loop added: choose the blocks to repeat in its properties.',
  types: { REPEAT: 'Repeat N times', FOR_EACH: 'For each item', WHILE: 'While' },
  type: 'Loop type',
  times: 'Repetitions',
  as: 'Iteration variable name',
  asHelp: (as: string) =>
    `Inside the loop: \${testData:${as}.index} (1, 2…), \${testData:${as}} or \${testData:${as}.<field>}.`,
  source: 'Collection',
  sourceInline: 'Items written here',
  sourceData: 'Journey data (JSON array)',
  items: 'Items (one per line; fields: first=Ada; last=Byron)',
  itemsFrom: 'Data key',
  condition: 'Condition (checked before each iteration)',
  conditionTypes: {
    VISIBLE: 'Element visible',
    HIDDEN: 'Element hidden',
    TEXT: 'Text visible',
    URL: 'Address contains',
    RESPONSE: 'HTTP response seen',
  },
  conditionSelector: 'CSS selector',
  conditionText: 'Text',
  conditionUrl: 'Address',
  maxIterations: 'Iteration cap',
  maxHelp: `Protection: ${String(JOURNEY_LOOP_LIMITS.maxIterations)} at most; a WHILE still true at the cap fails.`,
  timeout: 'Global timeout (seconds)',
  onFailure: 'When an iteration fails',
  stop: 'Stop the loop (failure)',
  continue: 'Keep iterating, then fail',
  body: 'Loop content',
  bodyEmpty: 'Add at least one block to repeat.',
  addBlock: 'Add a block',
  addWait: 'Add a wait',
  pickBlock: 'Choose a block…',
  remove: 'Remove',
  up: 'Move up',
  down: 'Move down',
  wait: 'Wait',
  params: 'Inputs',
  paramFrom: 'Receives',
  paramUpstream: 'upstream or its data',
  paramVar: (key: string) => `variable ${key}`,
  variables: 'Iteration variables',
  open: 'fields come from the data (unknown before the run)',
  local: 'What the loop blocks produce only exists during one iteration.',
  diagnostics: 'Diagnostics',
  notChecked: 'Check the journey to see diagnostics.',
  ok: 'No problem found.',
  iterations: (count: number) => `${String(count)} item(s)`,
  more: (count: number) => `+${String(count)} more`,
  version: (version: number) => `v${String(version)}`,
  unknown: 'unknown block',
};
export const loopText = (state: DashboardState): Text => (state.t.locale === 'en' ? EN : FR);

// ── Opérations sur l'état (chacune garde de quoi annuler) ─────────────────────────────────────

const loopNode = (graph: JourneyGraph, id: string): (JourneyNode & { loop: JourneyLoopSpec }) | undefined => {
  const node = graph.nodes.find((entry) => entry.id === id);
  return node?.kind === 'LOOP' && node.loop ? (node as JourneyNode & { loop: JourneyLoopSpec }) : undefined;
};

/** Un identifiant d'élément du corps, unique dans le parcours (`n4i1`). */
function itemId(graph: JourneyGraph, loopId: string): string {
  const taken = new Set([
    ...graph.nodes.map((node) => node.id),
    ...graph.nodes.flatMap((node) => node.loop?.body.map((item) => item.id) ?? []),
  ]);
  for (let index = 1; ; index += 1) {
    const id = `${loopId}i${String(index)}`;
    if (!taken.has(id)) return id;
  }
}

/** Remplace la boucle (réglages) en gardant son corps. */
export function setLoop(ui: JourneyUi, id: string, change: Partial<JourneyLoopSpec>): void {
  const node = loopNode(ui.journey.graph, id);
  if (!node) return;
  remember(ui);
  const next: JourneyLoopSpec = { ...node.loop, ...change, body: change.body ?? node.loop.body };
  if (change.type && change.type !== node.loop.type) {
    const fresh = defaultLoop(change.type);
    next.times = fresh.times;
    next.items = fresh.items;
    next.while = fresh.while;
    next.maxIterations = fresh.maxIterations;
    delete next.itemsFrom;
    if (next.type !== 'REPEAT') delete next.times;
    if (next.type !== 'FOR_EACH') delete next.items;
    if (next.type !== 'WHILE') delete next.while;
  }
  node.loop = next;
}

export function loopAddBlock(
  ui: JourneyUi,
  loopId: string,
  block: Pick<LibraryBlockView, 'name' | 'version'>,
): string | undefined {
  const node = loopNode(ui.journey.graph, loopId);
  if (!node || node.loop.body.length >= JOURNEY_LOOP_LIMITS.bodyItems) return undefined;
  remember(ui);
  const id = itemId(ui.journey.graph, loopId);
  node.loop = {
    ...node.loop,
    body: [...node.loop.body, { id, kind: 'BLOCK', block: block.name, version: block.version }],
  };
  return id;
}

export function loopAddWait(ui: JourneyUi, loopId: string): string | undefined {
  const node = loopNode(ui.journey.graph, loopId);
  if (!node || node.loop.body.length >= JOURNEY_LOOP_LIMITS.bodyItems) return undefined;
  remember(ui);
  const id = itemId(ui.journey.graph, loopId);
  node.loop = { ...node.loop, body: [...node.loop.body, { id, kind: 'WAIT', wait: defaultWait('TEXT') }] };
  return id;
}

export function loopRemoveItem(ui: JourneyUi, loopId: string, item: string): void {
  const node = loopNode(ui.journey.graph, loopId);
  if (!node) return;
  remember(ui);
  node.loop = { ...node.loop, body: node.loop.body.filter((entry) => entry.id !== item) };
}

export function loopMoveItem(ui: JourneyUi, loopId: string, item: string, delta: number): void {
  const node = loopNode(ui.journey.graph, loopId);
  if (!node) return;
  const body = [...node.loop.body];
  const from = body.findIndex((entry) => entry.id === item);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= body.length) return;
  remember(ui);
  const [moved] = body.splice(from, 1);
  if (moved) body.splice(to, 0, moved);
  node.loop = { ...node.loop, body };
}

/** Change un élément du corps : le paramètre d'une entrée d'un bloc, ou la condition d'une attente. */
export function loopSetItem(
  ui: JourneyUi,
  loopId: string,
  item: string,
  change: Partial<JourneyLoopItem>,
): void {
  const node = loopNode(ui.journey.graph, loopId);
  if (!node) return;
  remember(ui);
  node.loop = {
    ...node.loop,
    body: node.loop.body.map((entry) => (entry.id === item ? { ...entry, ...change } : entry)),
  };
}

export function loopSetParam(
  ui: JourneyUi,
  loopId: string,
  item: string,
  key: string,
  param: JourneyLoopParam | undefined,
): void {
  const node = loopNode(ui.journey.graph, loopId);
  const entry = node?.loop.body.find((candidate) => candidate.id === item);
  if (!node || !entry) return;
  const params = Object.fromEntries(Object.entries(entry.params ?? {}).filter(([name]) => name !== key));
  if (param) params[key] = param;
  loopSetItem(ui, loopId, item, Object.keys(params).length > 0 ? { params } : { params: undefined });
}

/** Les éléments d'une collection écrite : une ligne par élément ; `champ=valeur; champ=valeur` pour des champs. */
export function parseItems(text: string): JourneyLoopElement[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(0, JOURNEY_LOOP_LIMITS.maxIterations)
    .map((line): JourneyLoopElement => {
      if (!line.includes('=')) return line;
      const fields: Record<string, string> = {};
      for (const part of line.split(';')) {
        const at = part.indexOf('=');
        if (at <= 0) continue;
        const name = part.slice(0, at).trim();
        if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) fields[name] = part.slice(at + 1).trim();
      }
      return Object.keys(fields).length > 0 ? fields : line;
    });
}

export function itemsText(items: readonly JourneyLoopElement[] | undefined): string {
  return (items ?? [])
    .map((item) =>
      typeof item === 'string'
        ? item
        : Object.entries(item)
            .map(([name, value]) => `${name}=${value}`)
            .join('; '),
    )
    .join('\n');
}

// ── Rendu ─────────────────────────────────────────────────────────────────────────────────────

const blockOf = (state: DashboardState, name: string | undefined): LibraryBlockView | undefined =>
  name ? (state.lib.blocks ?? []).find((block) => block.name === name) : undefined;

function waitLine(t: Text, spec: WaitSpec): string {
  const target = spec.selector ?? spec.text ?? spec.url ?? '…';
  return `${t.conditionTypes[spec.type] ?? spec.type} « ${target} »`;
}

function itemLine(state: DashboardState, item: JourneyLoopItem): string {
  const t = loopText(state);
  if (item.kind === 'WAIT') return `${t.wait} · ${waitLine(t, item.wait ?? defaultWait())}`;
  const block = blockOf(state, item.block);
  return `${item.block ?? '?'} ${block ? t.version(item.version ?? block.version) : `(${t.unknown})`}`;
}

/** L'intérieur du nœud dans le diagramme : type, résumé, et les premiers éléments du corps. */
export function loopNodeInner(state: DashboardState, node: JourneyNode): string {
  const t = loopText(state);
  const spec = node.loop ?? defaultLoop();
  const shown = spec.body.slice(0, 3);
  const rest = spec.body.length - shown.length;
  return `<span class="jn-loop-h"><span class="jn-ic loop" aria-hidden="true">${icon('refresh')}</span><span class="jn-n-t"><b>${esc(node.label?.trim() || t.loop)}</b><small class="mu">${esc(loopSummary(spec))}</small></span></span><ul class="plain jn-loop-body">${shown.map((item) => `<li class="${item.kind === 'WAIT' ? 'wait' : ''}">${icon(item.kind === 'WAIT' ? 'history' : 'cube')}<span>${esc(itemLine(state, item))}</span></li>`).join('')}${rest > 0 ? `<li class="mu">${esc(t.more(rest))}</li>` : ''}${spec.body.length === 0 ? `<li class="mu">${esc(t.bodyEmpty)}</li>` : ''}</ul>`;
}

/** La boucle dans la suite (mode linéaire) : violette, son résumé, son contenu indenté. */
export function loopCard(
  state: DashboardState,
  node: JourneyNode,
  index: number,
  last: boolean,
  publish: boolean,
  labels: { moveUp: string; moveDown: string; remove: string; grip: string },
): string {
  const t = loopText(state);
  const ui = state.lib.journey;
  const spec = node.loop ?? defaultLoop();
  const diag = freshCheck(ui)?.nodes[node.id];
  const itemErrors = spec.body.flatMap((item) => freshCheck(ui)?.nodes[item.id]?.errors ?? []);
  const errors = [...(diag?.errors ?? []), ...itemErrors];
  const selected = ui.selected?.kind === 'node' && ui.selected.id === node.id;
  const tone = errors.length > 0 ? ' ko' : (diag?.warnings.length ?? 0) > 0 ? ' warn' : '';
  const name = node.label?.trim() || t.loop;
  const actions = publish
    ? `<span class="jn-card-a"><button type="button" class="btn small ghost icon-only" data-action="jn-move" data-node="${esc(node.id)}" data-to="${String(index - 1)}" aria-label="${esc(`${labels.moveUp} : ${name}`)}" title="${esc(labels.moveUp)}"${index === 0 ? ' disabled' : ''}>${icon('up')}</button><button type="button" class="btn small ghost icon-only" data-action="jn-move" data-node="${esc(node.id)}" data-to="${String(index + 1)}" aria-label="${esc(`${labels.moveDown} : ${name}`)}" title="${esc(labels.moveDown)}"${last ? ' disabled' : ''}>${icon('down')}</button><button type="button" class="btn small ghost icon-only" data-action="jn-remove" data-node="${esc(node.id)}" aria-label="${esc(`${labels.remove} : ${name}`)}" title="${esc(labels.remove)}">${icon('trash')}</button></span>`
    : '';
  const body =
    spec.body.length === 0
      ? `<li class="mu">${esc(t.bodyEmpty)}</li>`
      : spec.body
          .map((item, at) => {
            const itemDiag = freshCheck(ui)?.nodes[item.id];
            return `<li class="jn-loop-i${item.kind === 'WAIT' ? ' wait' : ''}${(itemDiag?.errors.length ?? 0) > 0 ? ' ko' : ''}"><span class="jn-loop-n">${String(at + 1)}</span>${icon(item.kind === 'WAIT' ? 'history' : 'cube')}<span>${esc(itemLine(state, item))}</span></li>`;
          })
          .join('');
  return `<li class="jn-card loop${selected ? ' sel' : ''}${tone}" data-jn-node="${esc(node.id)}" draggable="${String(publish)}"><span class="jn-num" aria-hidden="true">${String(index + 1)}</span><div class="jn-card-box"><span class="jn-grip" title="${esc(labels.grip)}" aria-hidden="true">${icon('grip')}</span><button type="button" class="jn-card-b" data-action="jn-select" data-node="${esc(node.id)}" aria-pressed="${String(selected)}"><span class="jn-card-h"><span class="jn-ic loop" aria-hidden="true">${icon('refresh')}</span><span class="jn-card-t"><b>${esc(name)}</b><small class="mu">${esc(loopSummary(spec))} · max ${String(spec.maxIterations)} · ${String(spec.timeoutS)} s</small></span></span><ol class="plain jn-loop-list">${body}</ol>${errors.length > 0 ? `<span class="jn-err">${icon('alert')}${esc(errors[0] ?? '')}${errors.length > 1 ? ` (+${String(errors.length - 1)})` : ''}</span>` : ''}</button>${actions}</div></li>`;
}

function diagBlock(
  t: Text,
  diag: { errors: string[]; warnings: string[] } | undefined,
  checked: boolean,
): string {
  if (!checked) return `<p class="mu">${esc(t.notChecked)}</p>`;
  if (!diag || diag.errors.length + diag.warnings.length === 0)
    return `<p class="ok-t">${icon('check')} ${esc(t.ok)}</p>`;
  return `<ul class="plain jn-diag">${diag.errors.map((item) => `<li class="ko">${icon('alert')}<span>${esc(item)}</span></li>`).join('')}${diag.warnings.map((item) => `<li class="warn">${icon('info')}<span>${esc(item)}</span></li>`).join('')}</ul>`;
}

/** Un élément du corps dans le panneau : ses entrées (variables d'itération proposées), ou sa condition. */
function itemProps(
  state: DashboardState,
  node: JourneyNode,
  spec: JourneyLoopSpec,
  item: JourneyLoopItem,
  at: number,
  publish: boolean,
): string {
  const t = loopText(state);
  const ui = state.lib.journey;
  const off = publish ? '' : ' disabled';
  const check = freshCheck(ui);
  const diag = check?.nodes[item.id];
  const attrs = `data-loop="${esc(node.id)}" data-item="${esc(item.id)}"`;
  const head = `<div class="jn-loop-ih"><span class="jn-loop-n">${String(at + 1)}</span>${icon(item.kind === 'WAIT' ? 'history' : 'cube')}<b>${esc(itemLine(state, item))}</b>${
    publish
      ? `<span class="jn-loop-ia"><button type="button" class="btn small ghost icon-only" data-action="jn-loop-move" ${attrs} data-delta="-1" aria-label="${esc(t.up)}" title="${esc(t.up)}"${at === 0 ? ' disabled' : ''}>${icon('up')}</button><button type="button" class="btn small ghost icon-only" data-action="jn-loop-move" ${attrs} data-delta="1" aria-label="${esc(t.down)}" title="${esc(t.down)}"${at === spec.body.length - 1 ? ' disabled' : ''}>${icon('down')}</button><button type="button" class="btn small ghost icon-only" data-action="jn-loop-remove" ${attrs} aria-label="${esc(`${t.remove} : ${itemLine(state, item)}`)}" title="${esc(t.remove)}">${icon('trash')}</button></span>`
      : ''
  }</div>`;
  if (item.kind === 'WAIT') {
    const wait = item.wait ?? defaultWait('TEXT');
    const value = wait.selector ?? wait.text ?? wait.url ?? '';
    return `<li class="jn-loop-item wait">${head}<div class="jn-row2"><label class="field"><span>${esc(t.wait)}</span><select data-jn="loop.item.wait.type" ${attrs}${off}>${WAIT_TYPES.map((type) => `<option value="${type}"${type === wait.type ? ' selected' : ''}>${esc(t.conditionTypes[type] ?? type)}</option>`).join('')}</select></label><label class="field"><span>${esc(wait.type === 'URL' || wait.type === 'RESPONSE' ? t.conditionUrl : t.conditionText)}</span><input data-jn="loop.item.wait.value" ${attrs} value="${esc(value)}" maxlength="300" autocomplete="off" spellcheck="false"${off}></label></div>${diag && diag.errors.length > 0 ? diagBlock(t, diag, true) : ''}</li>`;
  }
  const block = blockOf(state, item.block);
  const variables = loopVariableKeys(spec).keys;
  const available = [...new Set([...variables, ...(diag?.available ?? [])])];
  const listId = `jn-loop-av-${item.id}`;
  const inputs = block?.contract.inputs ?? [];
  const params =
    inputs.length === 0
      ? ''
      : `<datalist id="${esc(listId)}">${available.map((key) => `<option value="${esc(key)}"></option>`).join('')}</datalist><ul class="plain jn-loop-params">${inputs
          .map((input) => {
            const param = item.params?.[input.key];
            const mapped = param?.mode === 'MAP' ? param.key : '';
            return `<li><code class="lib-key${input.required ? '' : ' opt'}">${esc(input.key)}</code><label class="field"><span>${esc(t.paramFrom)}</span><input list="${esc(listId)}" data-jn="loop.item.param" ${attrs} data-key="${esc(input.key)}" value="${esc(mapped)}" placeholder="${esc(t.paramUpstream)}" maxlength="120" autocomplete="off" spellcheck="false"${off}></label></li>`;
          })
          .join('')}</ul>`;
  return `<li class="jn-loop-item">${head}${params ? `<p class="jn-loop-k">${esc(t.params)}</p>${params}` : ''}${diag && (diag.errors.length > 0 || diag.warnings.length > 0) ? diagBlock(t, diag, true) : ''}</li>`;
}

/** Le panneau des propriétés d'une boucle : réglages exécutés par le moteur, contenu, diagnostics. */
export function loopProps(state: DashboardState, node: JourneyNode, publish: boolean): string {
  const t = loopText(state);
  const ui = state.lib.journey;
  const spec = node.loop ?? defaultLoop();
  const off = publish ? '' : ' disabled';
  const check = freshCheck(ui);
  const attrs = `data-loop="${esc(node.id)}"`;
  const select = (key: string, label: string, options: [string, string][], value: string): string =>
    `<label class="field"><span>${esc(label)}</span><select data-jn="loop.${key}" ${attrs}${off}>${options.map(([option, text]) => `<option value="${esc(option)}"${option === value ? ' selected' : ''}>${esc(text)}</option>`).join('')}</select></label>`;
  const number = (key: string, label: string, value: number, min: number, max: number): string =>
    `<label class="field"><span>${esc(label)}</span><input type="number" data-jn="loop.${key}" ${attrs} min="${String(min)}" max="${String(max)}" step="1" value="${String(value)}"${off}></label>`;
  const type = select(
    'type',
    t.type,
    JOURNEY_LOOP_TYPES.map((value) => [value, t.types[value] ?? value]),
    spec.type,
  );
  let source = '';
  if (spec.type === 'REPEAT')
    source = number('times', t.times, spec.times ?? 1, 1, JOURNEY_LOOP_LIMITS.maxIterations);
  if (spec.type === 'FOR_EACH') {
    const fromData = spec.itemsFrom !== undefined;
    source = `${select(
      'source',
      t.source,
      [
        ['INLINE', t.sourceInline],
        ['DATA', t.sourceData],
      ],
      fromData ? 'DATA' : 'INLINE',
    )}${
      fromData
        ? `<label class="field"><span>${esc(t.itemsFrom)}</span><input data-jn="loop.itemsFrom" ${attrs} value="${esc(spec.itemsFrom ?? '')}" maxlength="120" autocomplete="off" spellcheck="false" class="mono"${off}></label>`
        : `<label class="field"><span>${esc(t.items)}</span><textarea data-jn="loop.items" ${attrs} rows="4" spellcheck="false"${off}>${esc(itemsText(spec.items))}</textarea><small class="mu">${esc(t.iterations(spec.items?.length ?? 0))}</small></label>`
    }`;
  }
  if (spec.type === 'WHILE') {
    const condition = spec.while ?? defaultWait();
    const value = condition.selector ?? condition.text ?? condition.url ?? '';
    source = `<fieldset class="jn-loop-cond"><legend>${esc(t.condition)}</legend>${select(
      'while.type',
      t.type,
      WAIT_TYPES.map((value) => [value, t.conditionTypes[value] ?? value]),
      condition.type,
    )}<label class="field"><span>${esc(condition.type === 'URL' || condition.type === 'RESPONSE' ? t.conditionUrl : condition.selector !== undefined ? t.conditionSelector : t.conditionText)}</span><input data-jn="loop.while.value" ${attrs} value="${esc(value)}" maxlength="300" autocomplete="off" spellcheck="false"${off}></label></fieldset>`;
  }
  const variables = loopVariableKeys(spec);
  const vars = `<div class="jn-loop-vars"><p class="jn-loop-k">${esc(t.variables)}</p><p>${variables.keys.map((key) => `<code class="lib-key">${esc(key)}</code>`).join(' ')}${variables.open ? ` <small class="mu">${esc(t.open)}</small>` : ''}</p><small class="mu">${esc(t.asHelp(spec.as))}</small></div>`;
  const limits = `<div class="jn-row2">${number('maxIterations', t.maxIterations, spec.maxIterations, 1, JOURNEY_LOOP_LIMITS.maxIterations)}${number('timeoutS', t.timeout, spec.timeoutS, JOURNEY_LOOP_LIMITS.timeoutS.min, JOURNEY_LOOP_LIMITS.timeoutS.max)}</div><small class="mu block">${esc(t.maxHelp)}</small>${select(
    'onFailure',
    t.onFailure,
    [
      ['STOP', t.stop],
      ['CONTINUE', t.continue],
    ],
    spec.onFailure,
  )}`;
  const blocks = state.lib.blocks ?? [];
  const add = publish
    ? `<div class="jn-loop-add"><label class="field"><span class="sr">${esc(t.addBlock)}</span><select data-jn="loop.pick" ${attrs}><option value="">${esc(t.pickBlock)}</option>${blocks.map((block) => `<option value="${esc(block.name)}">${esc(block.name)}</option>`).join('')}</select></label><button type="button" class="btn small" data-action="jn-loop-add-block" ${attrs}>${icon('plus')}<span>${esc(t.addBlock)}</span></button><button type="button" class="btn small ghost" data-action="jn-loop-add-wait" ${attrs}>${icon('history')}<span>${esc(t.addWait)}</span></button></div>`
    : '';
  const body = `<section class="jn-sec jn-loop-sec" aria-labelledby="jn-loop-b"><h4 id="jn-loop-b">${esc(t.body)}</h4><p class="mu small">${esc(t.local)}</p>${
    spec.body.length === 0
      ? `<p class="mu">${esc(t.bodyEmpty)}</p>`
      : `<ol class="plain jn-loop-items">${spec.body.map((item, at) => itemProps(state, node, spec, item, at, publish)).join('')}</ol>`
  }${add}</section>`;
  return `<div class="jn-props-h"><span class="jn-ic loop" aria-hidden="true">${icon('refresh')}</span><div class="jn-props-n"><h3 id="jn-props-t">${esc(t.loop)}</h3><p class="mu">${esc(loopSummary(spec))}</p></div></div><section class="jn-sec jn-loopf" aria-label="${esc(t.loop)}">${type}${source}<label class="field"><span>${esc(t.as)}</span><input data-jn="loop.as" ${attrs} value="${esc(spec.as)}" maxlength="40" autocomplete="off" spellcheck="false" class="mono"${off}></label>${vars}${limits}</section>${body}<section class="jn-sec" aria-labelledby="jn-loop-dg"><h4 id="jn-loop-dg">${esc(t.diagnostics)}</h4>${diagBlock(t, check?.nodes[node.id], check !== undefined)}</section>`;
}

/** Le changement d'un réglage de boucle depuis un champ du panneau. */
export function applyLoopField(
  ui: JourneyUi,
  key: string,
  target: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
): boolean {
  const loopId = target.dataset.loop ?? '';
  const node = loopNode(ui.journey.graph, loopId);
  if (!node) return false;
  const value = target.value;
  const int = (fallback: number): number => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const item = target.dataset.item ?? '';
  switch (key) {
    case 'loop.type':
      setLoop(ui, loopId, {
        type: JOURNEY_LOOP_TYPES.find((type) => type === value) ?? 'REPEAT',
      });
      return true;
    case 'loop.times':
      setLoop(ui, loopId, { times: Math.max(1, Math.min(JOURNEY_LOOP_LIMITS.maxIterations, int(1))) });
      return true;
    case 'loop.source':
      if (value === 'DATA') setLoop(ui, loopId, { itemsFrom: node.loop.itemsFrom ?? '', items: undefined });
      else setLoop(ui, loopId, { items: node.loop.items ?? [], itemsFrom: undefined });
      return true;
    case 'loop.items':
      setLoop(ui, loopId, { items: parseItems(value), itemsFrom: undefined });
      return true;
    case 'loop.itemsFrom':
      setLoop(ui, loopId, { itemsFrom: value.trim() });
      return true;
    case 'loop.as':
      setLoop(ui, loopId, { as: value.trim() });
      return true;
    case 'loop.maxIterations':
      setLoop(ui, loopId, {
        maxIterations: Math.max(1, Math.min(JOURNEY_LOOP_LIMITS.maxIterations, int(1))),
      });
      return true;
    case 'loop.timeoutS':
      setLoop(ui, loopId, {
        timeoutS: Math.max(
          JOURNEY_LOOP_LIMITS.timeoutS.min,
          Math.min(JOURNEY_LOOP_LIMITS.timeoutS.max, int(1)),
        ),
      });
      return true;
    case 'loop.onFailure':
      setLoop(ui, loopId, { onFailure: value === 'CONTINUE' ? 'CONTINUE' : 'STOP' });
      return true;
    case 'loop.while.type': {
      const type = WAIT_TYPES.find((candidate) => candidate === value) ?? 'VISIBLE';
      setLoop(ui, loopId, { while: { ...(node.loop.while ?? defaultWait()), ...conditionOf(type, '') } });
      return true;
    }
    case 'loop.while.value': {
      const current = node.loop.while ?? defaultWait();
      setLoop(ui, loopId, { while: { ...current, ...conditionOf(current.type, value) } });
      return true;
    }
    case 'loop.item.wait.type': {
      const type = WAIT_TYPES.find((candidate) => candidate === value) ?? 'TEXT';
      const wait = node.loop.body.find((entry) => entry.id === item)?.wait ?? defaultWait(type);
      loopSetItem(ui, loopId, item, { wait: { ...wait, ...conditionOf(type, '') } });
      return true;
    }
    case 'loop.item.wait.value': {
      const wait = node.loop.body.find((entry) => entry.id === item)?.wait ?? defaultWait('TEXT');
      loopSetItem(ui, loopId, item, { wait: { ...wait, ...conditionOf(wait.type, value) } });
      return true;
    }
    case 'loop.item.param': {
      const name = target.dataset.key ?? '';
      const mapped = value.trim();
      loopSetParam(ui, loopId, item, name, mapped ? { mode: 'MAP', key: mapped } : undefined);
      return true;
    }
    default:
      return false;
  }
}

/** La cible d'une condition : un texte cité tel quel, un sélecteur CSS (commence par . # [), ou une adresse. */
function conditionOf(type: WaitSpec['type'], value: string): Partial<WaitSpec> {
  const text = value.trim();
  const reset: Partial<WaitSpec> = { type, selector: undefined, text: undefined, url: undefined };
  if (!text) return reset;
  if (type === 'URL' || type === 'RESPONSE') return { ...reset, url: text };
  if ((type === 'VISIBLE' || type === 'HIDDEN') && /^[.#[]|^[a-z]+[.#[]/i.test(text))
    return { ...reset, selector: text };
  return { ...reset, text };
}

export const LOOP_CSS = `
.jn-ic.loop,.jn-pal-ic.loop{background:var(--jn-loop-soft);color:var(--jn-loop)}
.jn-node.loop{border-color:color-mix(in srgb,var(--jn-loop) 70%,var(--qa-color-border));background:color-mix(in srgb,var(--jn-loop) 6%,var(--qa-color-surface));flex-direction:column;align-items:stretch;justify-content:flex-start;gap:4px;padding:8px 10px}
.jn-node.loop.sel{border-color:var(--jn-sel)}
.jn-loop-h{display:flex;align-items:center;gap:8px;min-width:0}
.jn-loop-h .jn-n-t small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:170px}
.jn-loop-body{display:flex;flex-direction:column;gap:2px;border-left:2px solid color-mix(in srgb,var(--jn-loop) 45%,transparent);margin-left:12px;padding-left:8px;font-size:11px;min-width:0}
.jn-loop-body li{display:flex;align-items:center;gap:4px;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.jn-loop-body li span{overflow:hidden;text-overflow:ellipsis}
.jn-loop-body li.wait{color:var(--jn-wait)}
.jn-loop-body svg{width:12px;height:12px;flex:none}
.jn-card.loop .jn-card-box{border-color:color-mix(in srgb,var(--jn-loop) 55%,var(--qa-color-border));background:color-mix(in srgb,var(--jn-loop) 5%,var(--qa-color-surface))}
.jn-card.loop.sel .jn-card-box{border-color:var(--jn-loop);box-shadow:0 0 0 2px color-mix(in srgb,var(--jn-loop) 22%,transparent)}
.jn-loop-list{display:flex;flex-direction:column;gap:3px;margin:6px 0 0 14px;padding-left:10px;border-left:2px solid color-mix(in srgb,var(--jn-loop) 45%,transparent)}
.jn-loop-i{display:flex;align-items:center;gap:6px;font-size:12px;min-width:0}
.jn-loop-i.wait{color:var(--jn-wait)}
.jn-loop-i.ko{color:var(--qa-color-danger)}
.jn-loop-i svg,.jn-loop-ih svg{width:13px;height:13px;flex:none}
.jn-loop-n{display:inline-grid;place-items:center;min-width:18px;height:18px;border-radius:999px;background:var(--jn-loop-soft);color:var(--jn-loop);font-size:11px;font-weight:600}
.jn-loop-items{display:flex;flex-direction:column;gap:8px;margin:6px 0}
.jn-loop-item{border:1px solid var(--qa-color-border);border-left:3px solid var(--jn-loop);border-radius:8px;padding:6px 8px;display:flex;flex-direction:column;gap:6px}
.jn-loop-item.wait{border-left-color:var(--jn-wait)}
.jn-loop-ih{display:flex;align-items:center;gap:6px;min-width:0}
.jn-loop-ih b{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}
.jn-loop-ia{display:flex;gap:2px}
.jn-loop-k{margin:0;font-size:11px;font-weight:600;color:var(--qa-color-muted);text-transform:uppercase;letter-spacing:.04em}
.jn-loop-params{display:flex;flex-direction:column;gap:6px}
.jn-loop-params li{display:grid;grid-template-columns:auto 1fr;align-items:end;gap:6px}
.jn-loop-add{display:flex;flex-wrap:wrap;gap:6px;align-items:flex-end}
.jn-loop-add .field{flex:1;min-width:140px;margin:0}
.jn-loop-vars p{margin:2px 0}
.jn-loop-cond{border:1px solid var(--qa-color-border);border-radius:8px;padding:6px 8px;margin:0}
.jn-loop-cond legend{font-size:12px;color:var(--qa-color-muted)}
`;
