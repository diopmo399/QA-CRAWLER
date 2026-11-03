import type { LibraryBlockView } from '../core/contracts.js';
import {
  chain,
  edgePath,
  emptyJourney,
  freeId,
  linearOrder,
  NODE_SIZE,
  pathLetter,
  portOf,
  type Journey,
  type JourneyBranch,
  type JourneyCheck,
  type JourneyEdge,
  type JourneyGraph,
  type JourneyMode,
  type JourneyNode,
  type JourneyNodeKind,
  type JourneyParam,
  type JourneySummary,
} from '../core/journey.js';
import { icon } from './dashboard-parts.js';
import type { DashboardState } from './dashboard-view.js';
import { esc } from './view.js';

/**
 * LE COMPOSITEUR VISUEL DE LA BIBLIOTHÈQUE (modèle : src/sdk/core/journey.ts). Trois panneaux sous le
 * catalogue existant : la palette des blocs réels (cherchable, regroupée par origine, glissable), la scène
 * (mode linéaire : une suite de cartes réordonnées par glisser-déposer ; mode libre : un diagramme avec
 * début, blocs, conditions, jonctions et fins, des connexions, zoom et déplacement), et le panneau des
 * propriétés (paramètres de l'instance tirés du contrat réel du bloc, entrées et sorties, versions,
 * diagnostics). Les deux modes éditent le même parcours ; passer en mode linéaire n'est accepté que sans
 * perte. Des fonctions pures : rendu et opérations sur l'état (le contrôleur les appelle).
 */

export interface JourneyUi {
  /** Le projet du parcours édité (un autre projet repart d'un parcours vide). */
  projectId?: string;
  journey: Journey;
  /** Le parcours tel qu'enregistré : son nom et sa révision (absent : jamais enregistré). */
  savedName?: string;
  savedRevision?: string;
  dirty: boolean;
  selected?: { kind: 'node' | 'edge'; id: string };
  undo: string[];
  redo: string[];
  check?: JourneyCheck;
  /** Le contenu (empreinte) que la vérification décrit : une vérification d'un autre contenu est périmée. */
  checkedFor?: string;
  checking?: boolean;
  saving?: boolean;
  saveState?: 'saved' | 'failed';
  publishing?: boolean;
  confirmPerPath?: boolean;
  confirmDiscard?: string;
  list?: JourneySummary[];
  zoom: number;
  panX: number;
  panY: number;
  /** Pourquoi le mode linéaire a été refusé (dit sous le sélecteur). */
  modeMessage?: string;
  paletteQuery: string;
  paletteClosed: string[];
  error?: string;
  details?: string[];
  notice?: string;
}

export const emptyJourneyUi = (): JourneyUi => ({
  journey: emptyJourney(''),
  dirty: false,
  undo: [],
  redo: [],
  zoom: 1,
  panX: 0,
  panY: 0,
  paletteQuery: '',
  paletteClosed: [],
});

const UNDO_MAX = 50;

/**
 * L'empreinte de la LOGIQUE du parcours (nœuds sans leur position, connexions) : déplacer un nœud ou changer
 * de mode ne rend pas une vérification périmée ; changer un bloc, un paramètre ou une connexion, si.
 */
export const logicKey = (journey: Journey): string =>
  JSON.stringify([journey.graph.nodes.map(({ x: _x, y: _y, ...node }) => node), journey.graph.edges]);

// ── Opérations (pures sur l'état ; chacune garde de quoi annuler) ─────────────────────────────

/** Avant une modification : l'état actuel rejoint l'historique d'annulation. */
export function remember(ui: JourneyUi): void {
  ui.undo = [...ui.undo, JSON.stringify(ui.journey)].slice(-UNDO_MAX);
  ui.redo = [];
  ui.dirty = true;
  ui.saveState = undefined;
  ui.notice = undefined;
}

export function undo(ui: JourneyUi): boolean {
  const previous = ui.undo.at(-1);
  if (!previous) return false;
  ui.redo = [...ui.redo, JSON.stringify(ui.journey)];
  ui.undo = ui.undo.slice(0, -1);
  ui.journey = JSON.parse(previous) as Journey;
  ui.dirty = true;
  dropMissingSelection(ui);
  return true;
}

export function redo(ui: JourneyUi): boolean {
  const next = ui.redo.at(-1);
  if (!next) return false;
  ui.undo = [...ui.undo, JSON.stringify(ui.journey)];
  ui.redo = ui.redo.slice(0, -1);
  ui.journey = JSON.parse(next) as Journey;
  ui.dirty = true;
  dropMissingSelection(ui);
  return true;
}

function dropMissingSelection(ui: JourneyUi): void {
  const selected = ui.selected;
  if (!selected) return;
  const graph = ui.journey.graph;
  const exists =
    selected.kind === 'node'
      ? graph.nodes.some((node) => node.id === selected.id)
      : graph.edges.some((edge) => edge.id === selected.id);
  if (!exists) ui.selected = undefined;
}

const nodeOf = (graph: JourneyGraph, id: string): JourneyNode | undefined =>
  graph.nodes.find((node) => node.id === id);

/** L'ordre linéaire actuel (le mode linéaire n'existe que s'il tient). */
function linear(
  graph: JourneyGraph,
): { start: JourneyNode; blocks: JourneyNode[]; end: JourneyNode } | undefined {
  const order = linearOrder(graph);
  return order.ok ? order : undefined;
}

/** Ajoute un bloc : à la position donnée de la suite (mode linéaire), ou à cet endroit du diagramme. */
export function addBlock(
  ui: JourneyUi,
  block: Pick<LibraryBlockView, 'name' | 'version'>,
  at: { index?: number; x?: number; y?: number } = {},
): string {
  remember(ui);
  const graph = ui.journey.graph;
  const id = freeId(
    'n',
    graph.nodes.map((node) => node.id),
  );
  const node: JourneyNode = { id, kind: 'BLOCK', block: block.name, version: block.version, x: 0, y: 0 };
  const order = ui.journey.mode === 'LINEAR' ? linear(graph) : undefined;
  if (order) {
    const blocks = [...order.blocks];
    blocks.splice(Math.max(0, Math.min(at.index ?? blocks.length, blocks.length)), 0, node);
    ui.journey.graph = chain(order.start, blocks, order.end, graph.edges, true);
  } else {
    const last = graph.nodes.reduce((max, entry) => Math.max(max, entry.y), 0);
    node.x = Math.round(at.x ?? -NODE_SIZE.BLOCK.w / 2);
    node.y = Math.round(at.y ?? last + 124);
    graph.nodes.push(node);
    // Le nœud choisi n'a pas encore de suite : le nouveau bloc s'y rattache.
    const selected = ui.selected?.kind === 'node' ? nodeOf(graph, ui.selected.id) : undefined;
    if (
      selected &&
      (selected.kind === 'START' || selected.kind === 'BLOCK' || selected.kind === 'JOIN') &&
      !graph.edges.some((edge) => edge.from === selected.id)
    )
      graph.edges.push({
        id: freeId(
          'e',
          graph.edges.map((edge) => edge.id),
        ),
        from: selected.id,
        to: id,
      });
  }
  ui.selected = { kind: 'node', id };
  return id;
}

/** Ajoute une condition, une jonction ou une fin au diagramme. */
export function addShape(
  ui: JourneyUi,
  kind: Exclude<JourneyNodeKind, 'START' | 'BLOCK'>,
  x?: number,
  y?: number,
): string {
  remember(ui);
  const graph = ui.journey.graph;
  const id = freeId(
    'n',
    graph.nodes.map((node) => node.id),
  );
  const last = graph.nodes.reduce((max, entry) => Math.max(max, entry.y), 0);
  graph.nodes.push({
    id,
    kind,
    ...(kind === 'CONDITION' ? { label: '' } : {}),
    x: Math.round(x ?? -NODE_SIZE[kind].w / 2),
    y: Math.round(y ?? last + 124),
  });
  ui.selected = { kind: 'node', id };
  return id;
}

/** Déplace un bloc dans la suite (mode linéaire) : `to` est sa nouvelle place parmi les blocs. */
export function moveBlock(ui: JourneyUi, id: string, to: number): boolean {
  const order = linear(ui.journey.graph);
  if (!order) return false;
  const from = order.blocks.findIndex((node) => node.id === id);
  if (from < 0) return false;
  const target = Math.max(0, Math.min(to, order.blocks.length - 1));
  if (target === from) return false;
  remember(ui);
  const blocks = [...order.blocks];
  const [moved] = blocks.splice(from, 1);
  if (moved) blocks.splice(target, 0, moved);
  ui.journey.graph = chain(order.start, blocks, order.end, ui.journey.graph.edges, true);
  return true;
}

/** Retire un nœud (jamais le début) et ses connexions ; en mode linéaire, la suite se referme. */
export function removeNode(ui: JourneyUi, id: string): boolean {
  const graph = ui.journey.graph;
  const node = nodeOf(graph, id);
  if (!node || node.kind === 'START') return false;
  const order = ui.journey.mode === 'LINEAR' ? linear(graph) : undefined;
  if (order && node.kind === 'END') return false;
  remember(ui);
  if (order)
    ui.journey.graph = chain(
      order.start,
      order.blocks.filter((entry) => entry.id !== id),
      order.end,
      graph.edges,
      true,
    );
  else
    ui.journey.graph = {
      nodes: graph.nodes.filter((entry) => entry.id !== id),
      edges: graph.edges.filter((edge) => edge.from !== id && edge.to !== id),
    };
  if (ui.selected?.id === id) ui.selected = undefined;
  return true;
}

/** Duplique une instance de bloc (avec ses paramètres) : juste après elle, ou décalée dans le diagramme. */
export function duplicateNode(ui: JourneyUi, id: string): string | undefined {
  const graph = ui.journey.graph;
  const node = nodeOf(graph, id);
  if (node?.kind !== 'BLOCK') return undefined;
  remember(ui);
  const copyId = freeId(
    'n',
    graph.nodes.map((entry) => entry.id),
  );
  const copy: JourneyNode = { ...structuredClone(node), id: copyId, x: node.x + 40, y: node.y + 40 };
  const order = ui.journey.mode === 'LINEAR' ? linear(graph) : undefined;
  if (order) {
    const blocks = [...order.blocks];
    blocks.splice(blocks.findIndex((entry) => entry.id === id) + 1, 0, copy);
    ui.journey.graph = chain(order.start, blocks, order.end, graph.edges, true);
  } else graph.nodes.push(copy);
  ui.selected = { kind: 'node', id: copyId };
  return copyId;
}

/**
 * Relie deux nœuds. Une sortie simple (début, bloc, jonction) est remplacée ; une condition a une branche
 * Oui et une branche Non (la branche donnée remplace l'ancienne). Refus expliqué sinon.
 */
export function connect(ui: JourneyUi, from: string, to: string, branch?: JourneyBranch): string | undefined {
  const graph = ui.journey.graph;
  const source = nodeOf(graph, from);
  const target = nodeOf(graph, to);
  if (!source || !target) return 'nœud absent';
  if (from === to) return 'un nœud ne se relie pas à lui-même';
  if (source.kind === 'END') return 'rien ne part d’une fin';
  if (target.kind === 'START') return 'rien ne mène au début';
  const wanted: JourneyBranch | undefined =
    source.kind === 'CONDITION'
      ? (branch ?? (graph.edges.some((edge) => edge.from === from && edge.branch === 'YES') ? 'NO' : 'YES'))
      : undefined;
  remember(ui);
  const kept = graph.edges.filter((edge) =>
    edge.from !== from ? true : source.kind === 'CONDITION' ? edge.branch !== wanted : false,
  );
  const id = freeId(
    'e',
    graph.edges.map((edge) => edge.id),
  );
  ui.journey.graph = {
    nodes: graph.nodes,
    edges: [...kept, { id, from, to, ...(wanted ? { branch: wanted } : {}) }],
  };
  ui.selected = { kind: 'edge', id };
  return undefined;
}

export function removeEdge(ui: JourneyUi, id: string): boolean {
  if (!ui.journey.graph.edges.some((edge) => edge.id === id)) return false;
  remember(ui);
  ui.journey.graph.edges = ui.journey.graph.edges.filter((edge) => edge.id !== id);
  if (ui.selected?.id === id) ui.selected = undefined;
  return true;
}

/** Le paramètre d'une instance pour une entrée de son contrat (undefined : l'amont ou les données). */
export function setParam(ui: JourneyUi, id: string, key: string, param: JourneyParam | undefined): void {
  const node = nodeOf(ui.journey.graph, id);
  if (node?.kind !== 'BLOCK') return;
  remember(ui);
  const params = Object.fromEntries(Object.entries(node.params ?? {}).filter(([entry]) => entry !== key));
  if (param) params[key] = param;
  if (Object.keys(params).length > 0) node.params = params;
  else delete node.params;
}

export function setLabel(ui: JourneyUi, id: string, label: string): void {
  const node = nodeOf(ui.journey.graph, id);
  if (!node) return;
  remember(ui);
  node.label = label.slice(0, 120);
}

export function setBranch(ui: JourneyUi, id: string, branch: JourneyBranch): void {
  const edge = ui.journey.graph.edges.find((entry) => entry.id === id);
  if (!edge || edge.branch === branch) return;
  remember(ui);
  // L'autre sortie de la condition prend la branche laissée libre.
  for (const other of ui.journey.graph.edges)
    if (other.from === edge.from && other.id !== edge.id && other.branch === branch)
      other.branch = edge.branch;
  edge.branch = branch;
}

/** Accepte explicitement la version actuelle d'un bloc pour CETTE instance. */
export function acceptVersion(ui: JourneyUi, id: string, version: number): void {
  const node = nodeOf(ui.journey.graph, id);
  if (node?.kind !== 'BLOCK') return;
  remember(ui);
  node.version = version;
}

/** Déplace un nœud du diagramme (fin d'un glisser). */
export function placeNode(ui: JourneyUi, id: string, x: number, y: number): void {
  const node = nodeOf(ui.journey.graph, id);
  if (!node || (node.x === Math.round(x) && node.y === Math.round(y))) return;
  remember(ui);
  node.x = Math.round(x);
  node.y = Math.round(y);
}

/**
 * Change de mode. Le diagramme accepte tout ; le mode linéaire seulement sans perte : sinon le parcours
 * reste en diagramme et la raison est rendue.
 */
export function switchMode(ui: JourneyUi, mode: JourneyMode): string | undefined {
  if (ui.journey.mode === mode) return undefined;
  if (mode === 'LINEAR') {
    const order = linearOrder(ui.journey.graph);
    if (!order.ok) return order.reason;
  }
  remember(ui);
  ui.journey.mode = mode;
  return undefined;
}

// ── Textes ───────────────────────────────────────────────────────────────────────────────────

const FR = {
  title: 'Compositeur de parcours',
  intro:
    'Assemblez des blocs de la bibliothèque en parcours. Le même parcours se lit en suite (mode linéaire) ou en diagramme (mode libre).',
  name: 'Nom du parcours',
  description: 'Description',
  saved: 'Parcours enregistrés',
  open: 'Ouvrir',
  newJourney: 'Nouveau parcours',
  discard: (name: string) =>
    `Les modifications non enregistrées seront perdues. Ouvrir « ${name} » quand même ?`,
  discardNew: 'Les modifications non enregistrées seront perdues. Commencer un nouveau parcours quand même ?',
  confirm: 'Confirmer',
  cancel: 'Annuler',
  modesLabel: 'Mode d’édition',
  modes: { LINEAR: 'Mode linéaire', DIAGRAM: 'Mode libre (Diagramme)' } as Record<JourneyMode, string>,
  linearRefused: (reason: string) =>
    `Le mode linéaire n’est pas possible sans perte : ${reason}. Le diagramme est conservé.`,
  undo: 'Annuler la modification',
  redo: 'Rétablir',
  check: 'Vérifier',
  checking: 'Vérification…',
  save: 'Enregistrer',
  saving: 'Enregistrement…',
  publishSingle: 'Créer le scénario',
  publishPaths: (n: number) => `Créer ${String(n)} scénarios (un par chemin)`,
  publishing: 'Création…',
  perPathConfirm:
    'Le moteur n’évalue pas les conditions : chaque chemin devient un scénario distinct, à rejouer séparément. Les branches ne sont jamais fusionnées.',
  perPathYes: 'Créer un scénario par chemin',
  status: {
    modified: 'Parcours modifié',
    saved: 'Enregistré',
    neverSaved: 'Jamais enregistré',
    saveFailed: 'Échec de l’enregistrement',
    checking: 'Vérification en cours',
    valid: 'Parcours valide',
    invalid: 'Parcours invalide',
    unchecked: 'Non vérifié',
    stale: 'Vérification antérieure à la dernière modification',
  },
  paletteTitle: 'Catalogue de blocs',
  paletteSearch: 'Chercher un bloc',
  paletteEmpty: 'Aucun bloc ne correspond.',
  paletteNoBlocks: 'La bibliothèque est vide : ajoutez d’abord un bloc.',
  originNone: 'Sans origine',
  addToJourney: (name: string) => `Ajouter « ${name} » au parcours`,
  dragHint: 'Glissez un bloc dans le parcours, ou utilisez +.',
  shapesTitle: 'Éléments du diagramme',
  shapes: { CONDITION: 'Condition', JOIN: 'Jonction', END: 'Fin' } as Record<string, string>,
  shapeHint: 'Une condition a une branche Oui et une branche Non ; une jonction réunit des branches.',
  start: 'Début',
  end: 'Fin',
  join: 'Jonction',
  conditionEmpty: 'Condition sans question',
  linearEmpty: 'Aucun bloc : glissez-en un ici ou utilisez + dans le catalogue.',
  drop: 'Déposer ici',
  moveUp: 'Monter',
  moveDown: 'Descendre',
  duplicate: 'Dupliquer',
  remove: 'Retirer du parcours',
  grip: 'Glisser pour déplacer',
  steps: (n: number) => `${String(n)} étape(s)`,
  version: (n: number) => `v${String(n)}`,
  compat: { VALID: 'Compatible', CHANGED: 'À revalider', INVALID: 'Contrat invalide' } as Record<
    string,
    string
  >,
  unknownBlock: 'Bloc introuvable',
  zoomIn: 'Zoom avant',
  zoomOut: 'Zoom arrière',
  fit: 'Ajuster à l’écran',
  actual: 'Taille réelle',
  canvasLabel: 'Diagramme du parcours',
  canvasHint:
    'Glissez un nœud pour le déplacer, depuis un port pour relier, le fond pour déplacer la vue ; Ctrl + molette pour zoomer.',
  yes: 'Oui',
  no: 'Non',
  propsTitle: 'Propriétés',
  propsJourney: 'Parcours',
  propsNone: 'Sélectionnez un bloc, une condition ou une connexion pour voir ses propriétés.',
  params: 'Paramètres',
  paramsNone: 'Ce bloc n’a pas d’entrée : rien à paramétrer pour cette instance.',
  paramModes: { INHERIT: 'Amont ou données', VALUE: 'Valeur', MAP: 'Correspondance' } as Record<
    string,
    string
  >,
  paramValue: (key: string) => `Valeur de ${key} pour cette instance`,
  paramKey: (key: string) => `Clé lue à la place de ${key}`,
  required: 'obligatoire',
  optional: 'facultative',
  io: 'Entrées / Sorties',
  ioRequired: 'Requises',
  ioProduced: 'Produites',
  ioAvailable: 'Disponibles en amont (tous chemins)',
  ioMissing: 'Manquantes',
  ioMapped: 'Correspondances',
  ioFrom: (key: string, from: string) => `${key} ← ${from}`,
  fromData: 'données de test',
  fromScenario: 'scénario',
  none: 'aucune',
  versions: 'Versions',
  versionUsed: 'Version retenue',
  versionCurrent: 'Version actuelle',
  fingerprint: 'Empreinte',
  newVersion: (n: number) => `Utiliser la version ${String(n)}`,
  versionNote: 'Une nouvelle version d’un bloc n’est utilisée qu’après acceptation explicite.',
  diagnostics: 'Diagnostics',
  noDiagnostic: 'Aucun problème relevé.',
  notChecked: 'Pas encore vérifié.',
  question: 'Question de la condition',
  connections: 'Connexions',
  connectTo: 'Relier à',
  branch: 'Branche',
  connectAction: 'Relier',
  edgeTitle: 'Connexion',
  edgeRemove: 'Supprimer la connexion',
  checkTitle: 'Vérification du parcours',
  paths: (n: number) => `${String(n)} chemin(s)`,
  blocksCount: (n: number) => `${String(n)} bloc(s)`,
  pathLabel: (letter: string) => `Chemin ${letter}`,
  pathOk: 'tient',
  pathKo: 'ne tient pas',
  linearYes: 'Lisible en mode linéaire',
  publishInfoSingle: 'Créer produira un scénario ordinaire (run: par bloc).',
  publishInfoPaths:
    'Ce parcours a des conditions : il ne devient exécutable qu’en un scénario par chemin, sur demande.',
  published: (names: string) => `Scénarios déjà créés : ${names}`,
  savedNotice: (name: string) => `Parcours « ${name} » enregistré.`,
  createdNotice: (names: string) => `Créé : ${names}.`,
  nameRequired: 'Donnez un nom au parcours pour l’enregistrer.',
  saveFirst: 'Enregistrez le parcours avant de créer ses scénarios.',
  checkFirst: 'La vérification doit être à jour et sans erreur.',
};

type Text = typeof FR;

const EN: Text = {
  ...FR,
  title: 'Journey composer',
  intro:
    'Assemble library blocks into journeys. The same journey reads as a sequence (linear mode) or as a diagram (free mode).',
  name: 'Journey name',
  saved: 'Saved journeys',
  open: 'Open',
  newJourney: 'New journey',
  discard: (name) => `Unsaved changes will be lost. Open “${name}” anyway?`,
  discardNew: 'Unsaved changes will be lost. Start a new journey anyway?',
  confirm: 'Confirm',
  cancel: 'Cancel',
  modesLabel: 'Editing mode',
  modes: { LINEAR: 'Linear mode', DIAGRAM: 'Free mode (Diagram)' },
  linearRefused: (reason) => `Linear mode is not possible without loss: ${reason}. The diagram is kept.`,
  undo: 'Undo',
  redo: 'Redo',
  check: 'Check',
  checking: 'Checking…',
  save: 'Save',
  saving: 'Saving…',
  publishSingle: 'Create the scenario',
  publishPaths: (n) => `Create ${String(n)} scenarios (one per path)`,
  publishing: 'Creating…',
  perPathConfirm:
    'The engine does not evaluate conditions: each path becomes a separate scenario, replayed on its own. Branches are never merged.',
  perPathYes: 'Create one scenario per path',
  status: {
    modified: 'Journey modified',
    saved: 'Saved',
    neverSaved: 'Never saved',
    saveFailed: 'Save failed',
    checking: 'Checking',
    valid: 'Valid journey',
    invalid: 'Invalid journey',
    unchecked: 'Not checked',
    stale: 'Check older than the last change',
  },
  paletteTitle: 'Block catalogue',
  paletteSearch: 'Search a block',
  paletteEmpty: 'No block matches.',
  paletteNoBlocks: 'The library is empty: add a block first.',
  originNone: 'No origin',
  addToJourney: (name) => `Add “${name}” to the journey`,
  dragHint: 'Drag a block into the journey, or use +.',
  shapesTitle: 'Diagram elements',
  shapes: { CONDITION: 'Condition', JOIN: 'Join', END: 'End' },
  shapeHint: 'A condition has a Yes branch and a No branch; a join merges branches.',
  start: 'Start',
  end: 'End',
  join: 'Join',
  conditionEmpty: 'Condition without a question',
  linearEmpty: 'No block: drag one here or use + in the catalogue.',
  drop: 'Drop here',
  moveUp: 'Move up',
  moveDown: 'Move down',
  duplicate: 'Duplicate',
  remove: 'Remove from the journey',
  grip: 'Drag to move',
  steps: (n) => `${String(n)} step(s)`,
  compat: { VALID: 'Compatible', CHANGED: 'To revalidate', INVALID: 'Invalid contract' },
  unknownBlock: 'Unknown block',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  fit: 'Fit to screen',
  actual: 'Actual size',
  canvasLabel: 'Journey diagram',
  canvasHint: 'Drag a node to move it, from a port to connect, the background to pan; Ctrl + wheel to zoom.',
  yes: 'Yes',
  no: 'No',
  propsTitle: 'Properties',
  propsJourney: 'Journey',
  propsNone: 'Select a block, a condition or a connection to see its properties.',
  params: 'Parameters',
  paramsNone: 'This block has no input: nothing to set for this instance.',
  paramModes: { INHERIT: 'Upstream or data', VALUE: 'Value', MAP: 'Mapping' },
  paramValue: (key) => `Value of ${key} for this instance`,
  paramKey: (key) => `Key read instead of ${key}`,
  required: 'required',
  optional: 'optional',
  io: 'Inputs / Outputs',
  ioRequired: 'Required',
  ioProduced: 'Produced',
  ioAvailable: 'Available upstream (all paths)',
  ioMissing: 'Missing',
  ioMapped: 'Mappings',
  fromData: 'test data',
  fromScenario: 'scenario',
  none: 'none',
  versions: 'Versions',
  versionUsed: 'Version used',
  versionCurrent: 'Current version',
  fingerprint: 'Fingerprint',
  newVersion: (n) => `Use version ${String(n)}`,
  versionNote: 'A new block version is only used once explicitly accepted.',
  diagnostics: 'Diagnostics',
  noDiagnostic: 'No problem found.',
  notChecked: 'Not checked yet.',
  question: 'Condition question',
  connections: 'Connections',
  connectTo: 'Connect to',
  branch: 'Branch',
  connectAction: 'Connect',
  edgeTitle: 'Connection',
  edgeRemove: 'Delete the connection',
  checkTitle: 'Journey check',
  paths: (n) => `${String(n)} path(s)`,
  blocksCount: (n) => `${String(n)} block(s)`,
  pathLabel: (letter) => `Path ${letter}`,
  pathOk: 'holds',
  pathKo: 'does not hold',
  linearYes: 'Readable in linear mode',
  publishInfoSingle: 'Create will write one ordinary scenario (run: per block).',
  publishInfoPaths:
    'This journey has conditions: it only becomes executable as one scenario per path, on request.',
  published: (names) => `Scenarios already created: ${names}`,
  savedNotice: (name) => `Journey “${name}” saved.`,
  createdNotice: (names) => `Created: ${names}.`,
  nameRequired: 'Name the journey to save it.',
  saveFirst: 'Save the journey before creating its scenarios.',
  checkFirst: 'The check must be up to date and without error.',
};

export const journeyText = (state: DashboardState): Text => (state.t.locale === 'en' ? EN : FR);

// ── Rendu ────────────────────────────────────────────────────────────────────────────────────

const blockOf = (state: DashboardState, name: string | undefined): LibraryBlockView | undefined =>
  name ? state.lib.blocks?.find((block) => block.name === name) : undefined;

/** La vérification ne vaut que pour le contenu qu'elle décrit. */
export const freshCheck = (ui: JourneyUi): JourneyCheck | undefined =>
  ui.check && ui.checkedFor === logicKey(ui.journey) ? ui.check : undefined;

function statusChips(state: DashboardState): string {
  const t = journeyText(state);
  const ui = state.lib.journey;
  const check = freshCheck(ui);
  const chip = (text: string, tone: string): string => `<li class="jn-chip ${tone}">${esc(text)}</li>`;
  return `<ul class="plain jn-chips" role="status" aria-live="polite">${[
    ui.saving
      ? chip(t.saving, 'live')
      : ui.saveState === 'failed'
        ? chip(t.status.saveFailed, 'ko')
        : ui.dirty
          ? chip(t.status.modified, 'warn')
          : ui.savedName
            ? chip(t.status.saved, 'ok')
            : chip(t.status.neverSaved, ''),
    ui.checking
      ? chip(t.status.checking, 'live')
      : check
        ? chip(check.ok ? t.status.valid : t.status.invalid, check.ok ? 'ok' : 'ko')
        : ui.check
          ? chip(t.status.stale, 'warn')
          : chip(t.status.unchecked, ''),
  ].join('')}</ul>`;
}

function toolbar(state: DashboardState, publish: boolean): string {
  const t = journeyText(state);
  const ui = state.lib.journey;
  const journey = ui.journey;
  const check = freshCheck(ui);
  const busy = Boolean(ui.saving || ui.publishing || ui.checking);
  const list = ui.list ?? [];
  const opener =
    list.length > 0
      ? `<label class="jn-open"><span class="sr">${esc(t.saved)}</span><select data-jn="open" aria-label="${esc(t.saved)}"><option value="">${esc(t.saved)}…</option>${list
          .map(
            (entry) =>
              `<option value="${esc(entry.name)}"${entry.name === ui.savedName ? ' selected' : ''}>${esc(entry.name)} · ${esc(t.blocksCount(entry.blocks))}</option>`,
          )
          .join('')}</select></label>`
      : '';
  const modes = `<span class="ed-seg jn-modes" role="radiogroup" aria-label="${esc(t.modesLabel)}">${(
    ['LINEAR', 'DIAGRAM'] as const
  )
    .map(
      (mode) =>
        `<button type="button" role="radio" id="jn-mode-${mode}" data-action="jn-mode" data-mode="${mode}" aria-checked="${String(journey.mode === mode)}">${icon(mode === 'LINEAR' ? 'menu' : 'explorations')}<span>${esc(t.modes[mode])}</span></button>`,
    )
    .join('')}</span>`;
  const publishLabel =
    check?.publishable === 'PER_PATH' ? t.publishPaths(check.paths.length) : t.publishSingle;
  const canPublish = publish && !busy && check?.ok === true && !ui.dirty && ui.savedName !== undefined;
  const actions = publish
    ? `<div class="jn-acts"><button type="button" class="btn small ghost icon-only" data-action="jn-undo" aria-label="${esc(t.undo)}" title="${esc(t.undo)}"${ui.undo.length === 0 ? ' disabled' : ''}>${icon('undo')}</button><button type="button" class="btn small ghost icon-only jn-redo" data-action="jn-redo" aria-label="${esc(t.redo)}" title="${esc(t.redo)}"${ui.redo.length === 0 ? ' disabled' : ''}>${icon('undo')}</button><button type="button" class="btn" data-action="jn-check"${busy ? ' disabled' : ''} aria-busy="${String(Boolean(ui.checking))}">${icon('check')}<span>${esc(ui.checking ? t.checking : t.check)}</span></button><button type="button" class="btn" data-action="jn-save"${busy ? ' disabled' : ''} aria-busy="${String(Boolean(ui.saving))}">${icon('save')}<span>${esc(ui.saving ? t.saving : t.save)}</span></button><button type="button" class="btn primary" data-action="jn-publish"${canPublish ? '' : ' disabled'} aria-busy="${String(Boolean(ui.publishing))}" title="${esc(canPublish ? publishLabel : ui.dirty || !ui.savedName ? t.saveFirst : t.checkFirst)}">${icon('play')}<span>${esc(ui.publishing ? t.publishing : publishLabel)}</span></button></div>`
    : '';
  const confirm = ui.confirmDiscard
    ? `<div class="jn-confirm" role="group"><p>${esc(ui.confirmDiscard === '\u0000new' ? t.discardNew : t.discard(ui.confirmDiscard))}</p><button type="button" class="btn small primary" data-action="jn-discard-yes">${esc(t.confirm)}</button><button type="button" class="btn small ghost" data-action="jn-discard-no">${esc(t.cancel)}</button></div>`
    : ui.confirmPerPath
      ? `<div class="jn-confirm warn" role="group"><p>${esc(t.perPathConfirm)}</p><button type="button" class="btn small primary" data-action="jn-publish-paths">${esc(t.perPathYes)}</button><button type="button" class="btn small ghost" data-action="jn-publish-cancel">${esc(t.cancel)}</button></div>`
      : '';
  return `<div class="jn-top"><div class="jn-head"><h2 id="lib-composer-t">${esc(t.title)}</h2>${statusChips(state)}</div>
<div class="jn-bar"><label class="field jn-name"><span>${esc(t.name)}</span><input data-jn="name" value="${esc(journey.name)}" maxlength="80" autocomplete="off"${publish ? '' : ' disabled'}></label>${opener}${publish ? `<button type="button" class="btn small ghost" data-action="jn-new">${icon('plus')}<span>${esc(t.newJourney)}</span></button>` : ''}${modes}${actions}</div>
${ui.modeMessage ? `<p class="jn-msg warn" role="alert">${icon('alert')}<span>${esc(ui.modeMessage)}</span></p>` : ''}${confirm}${ui.error ? `<div class="err" role="alert"><p>${esc(ui.error)}</p>${(ui.details ?? []).length > 1 ? `<ul class="plain tight">${(ui.details ?? []).map((item) => `<li>${esc(item)}</li>`).join('')}</ul>` : ''}</div>` : ''}${ui.notice ? `<p class="notice ok" role="status">${icon('check')}<span>${esc(ui.notice)}</span></p>` : ''}</div>`;
}

function palette(state: DashboardState, publish: boolean): string {
  const t = journeyText(state);
  const ui = state.lib.journey;
  const blocks = state.lib.blocks ?? [];
  const query = ui.paletteQuery.trim().toLowerCase();
  const shown = blocks.filter(
    (block) =>
      !query ||
      block.name.toLowerCase().includes(query) ||
      (block.description ?? '').toLowerCase().includes(query),
  );
  const groups = new Map<string, LibraryBlockView[]>();
  for (const block of shown) {
    const title = block.origin?.name ?? t.originNone;
    groups.set(title, [...(groups.get(title) ?? []), block]);
  }
  const item = (block: LibraryBlockView): string =>
    `<li class="jn-pal-item${block.state === 'VALID' ? '' : ` ${block.state === 'INVALID' ? 'ko' : 'warn'}`}" draggable="${String(publish)}" data-jn-block="${esc(block.name)}"><span class="jn-pal-ic" aria-hidden="true">${icon('library')}</span><span class="jn-pal-t"><b>${esc(block.name)}</b><small class="mu">${esc(t.version(block.version))} · ${esc(t.steps(block.steps))}</small></span>${publish ? `<button type="button" class="btn small ghost icon-only" data-action="jn-add" data-block="${esc(block.name)}" aria-label="${esc(t.addToJourney(block.name))}" title="${esc(t.addToJourney(block.name))}">${icon('plus')}</button>` : ''}</li>`;
  const body =
    blocks.length === 0
      ? `<p class="mu">${esc(t.paletteNoBlocks)}</p>`
      : shown.length === 0
        ? `<p class="mu">${esc(t.paletteEmpty)}</p>`
        : [...groups.entries()]
            .map(
              ([title, entries]) =>
                `<details class="jn-pal-g"${ui.paletteClosed.includes(title) ? '' : ' open'}><summary data-action="jn-group" data-group="${esc(title)}">${esc(title)} <small class="mu">${String(entries.length)}</small></summary><ul class="plain jn-pal-list">${entries.map(item).join('')}</ul></details>`,
            )
            .join('');
  const shapes =
    ui.journey.mode === 'DIAGRAM' && publish
      ? `<section class="jn-pal-shapes" aria-labelledby="jn-shapes-t"><h3 id="jn-shapes-t">${esc(t.shapesTitle)}</h3><div class="jn-shape-row">${(
          ['CONDITION', 'JOIN', 'END'] as const
        )
          .map(
            (kind) =>
              `<button type="button" class="jn-shape ${kind.toLowerCase()}" draggable="true" data-jn-shape="${kind}" data-action="jn-shape" data-kind="${kind}">${esc(t.shapes[kind] ?? kind)}</button>`,
          )
          .join('')}</div><small class="mu">${esc(t.shapeHint)}</small></section>`
      : '';
  return `<aside class="jn-palette" aria-labelledby="jn-pal-t"><h3 id="jn-pal-t">${esc(t.paletteTitle)}</h3><label class="lib-search jn-pal-search">${icon('search')}<span class="sr">${esc(t.paletteSearch)}</span><input type="search" data-jn="palette" value="${esc(ui.paletteQuery)}" placeholder="${esc(t.paletteSearch)}" autocomplete="off"></label><small class="mu">${esc(t.dragHint)}</small>${body}${shapes}</aside>`;
}

function diagOf(ui: JourneyUi, id: string): { errors: string[]; warnings: string[] } {
  const check = freshCheck(ui);
  const diag = check?.nodes[id];
  return { errors: diag?.errors ?? [], warnings: diag?.warnings ?? [] };
}

function linearView(state: DashboardState, publish: boolean): string {
  const t = journeyText(state);
  const ui = state.lib.journey;
  const order = linearOrder(ui.journey.graph);
  if (!order.ok) return `<p class="jn-msg warn">${esc(t.linearRefused(order.reason))}</p>`;
  const gap = (index: number): string =>
    publish
      ? `<li class="jn-gap" data-jn-gap="${String(index)}" aria-hidden="true"><span>${esc(t.drop)}</span></li>`
      : '';
  const cards = order.blocks
    .map((node, index) => {
      const block = blockOf(state, node.block);
      const diag = diagOf(ui, node.id);
      const selected = ui.selected?.kind === 'node' && ui.selected.id === node.id;
      const tone = diag.errors.length > 0 ? ' ko' : diag.warnings.length > 0 ? ' warn' : '';
      const io = block
        ? `${block.contract.inputs.length > 0 ? `<span class="jn-io"><span>${esc(t.ioRequired)}</span>${block.contract.inputs.map((input) => `<code class="lib-key${input.required ? '' : ' opt'}${node.params?.[input.key] ? ' set' : ''}">${esc(input.key)}</code>`).join('')}</span>` : ''}${block.contract.outputs.length > 0 ? `<span class="jn-io"><span>${esc(t.ioProduced)}</span>${block.contract.outputs.map((output) => `<code class="lib-key">${esc(output.key)}</code>`).join('')}</span>` : ''}`
        : '';
      const last = index === order.blocks.length - 1;
      const versionMismatch = block && node.version !== undefined && node.version !== block.version;
      return `${gap(index)}<li class="jn-card${selected ? ' sel' : ''}${tone}" data-jn-node="${esc(node.id)}" draggable="${String(publish)}"><span class="jn-grip" title="${esc(t.grip)}" aria-hidden="true">${icon('grip')}</span><span class="jn-num" aria-hidden="true">${String(index + 1)}</span><button type="button" class="jn-card-b" data-action="jn-select" data-node="${esc(node.id)}" aria-pressed="${String(selected)}"><span class="jn-card-h"><span class="jn-ic" aria-hidden="true">${icon('library')}</span><b>${esc(node.block ?? '?')}</b><small class="mu">${block ? `${esc(t.version(node.version ?? block.version))} · ${esc(t.steps(block.steps))}` : esc(t.unknownBlock)}</small>${block ? `<span class="jn-compat ${versionMismatch ? 'warn' : block.state === 'VALID' ? 'ok' : block.state === 'INVALID' ? 'ko' : 'warn'}">${esc(versionMismatch ? t.newVersion(block.version) : (t.compat[block.state] ?? block.state))}</span>` : ''}</span>${io ? `<span class="jn-ios">${io}</span>` : ''}${diag.errors.length > 0 ? `<span class="jn-err">${icon('alert')}${esc(diag.errors[0] ?? '')}${diag.errors.length > 1 ? ` (+${String(diag.errors.length - 1)})` : ''}</span>` : ''}</button>${
        publish
          ? `<span class="jn-card-a"><button type="button" class="btn small ghost icon-only" data-action="jn-move" data-node="${esc(node.id)}" data-to="${String(index - 1)}" aria-label="${esc(`${t.moveUp} : ${node.block ?? ''}`)}" title="${esc(t.moveUp)}"${index === 0 ? ' disabled' : ''}>${icon('up')}</button><button type="button" class="btn small ghost icon-only" data-action="jn-move" data-node="${esc(node.id)}" data-to="${String(index + 1)}" aria-label="${esc(`${t.moveDown} : ${node.block ?? ''}`)}" title="${esc(t.moveDown)}"${last ? ' disabled' : ''}>${icon('down')}</button><button type="button" class="btn small ghost icon-only" data-action="jn-duplicate" data-node="${esc(node.id)}" aria-label="${esc(`${t.duplicate} : ${node.block ?? ''}`)}" title="${esc(t.duplicate)}">${icon('copy')}</button><button type="button" class="btn small ghost icon-only" data-action="jn-remove" data-node="${esc(node.id)}" aria-label="${esc(`${t.remove} : ${node.block ?? ''}`)}" title="${esc(t.remove)}">${icon('trash')}</button></span>`
          : ''
      }</li>`;
    })
    .join('');
  return `<ol class="plain jn-line" aria-label="${esc(t.modes.LINEAR)}"><li class="jn-term start">${icon('play')}<span>${esc(t.start)}</span></li>${order.blocks.length === 0 ? `${gap(0)}<li class="jn-empty mu">${esc(t.linearEmpty)}</li>` : `${cards}${gap(order.blocks.length)}`}<li class="jn-term end">${icon('stop')}<span>${esc(t.end)}</span></li></ol>`;
}

function nodeHtml(state: DashboardState, node: JourneyNode, publish: boolean): string {
  const t = journeyText(state);
  const ui = state.lib.journey;
  const size = NODE_SIZE[node.kind];
  const diag = diagOf(ui, node.id);
  const selected = ui.selected?.kind === 'node' && ui.selected.id === node.id;
  const tone = diag.errors.length > 0 ? ' ko' : diag.warnings.length > 0 ? ' warn' : '';
  const style = `left:${String(node.x)}px;top:${String(node.y)}px;width:${String(size.w)}px;height:${String(size.h)}px`;
  const ports =
    !publish || node.kind === 'END'
      ? ''
      : node.kind === 'CONDITION'
        ? `<span class="jn-port yes" data-jn-port="${esc(node.id)}" data-branch="YES" title="${esc(t.yes)}"></span><span class="jn-port no" data-jn-port="${esc(node.id)}" data-branch="NO" title="${esc(t.no)}"></span>`
        : `<span class="jn-port" data-jn-port="${esc(node.id)}" title="${esc(t.connectTo)}"></span>`;
  const block = blockOf(state, node.block);
  const inner =
    node.kind === 'BLOCK'
      ? `<span class="jn-n-h"><span class="jn-ic" aria-hidden="true">${icon('library')}</span><b>${esc(node.block ?? '?')}</b></span><small class="mu">${block ? `${esc(t.version(node.version ?? block.version))} · ${esc(t.steps(block.steps))}` : esc(t.unknownBlock)}</small>`
      : node.kind === 'CONDITION'
        ? `<span class="jn-n-h"><b>${esc(node.label?.trim() ? node.label : t.conditionEmpty)}</b></span><small class="jn-yn"><span>${esc(t.yes)}</span><span>${esc(t.no)}</span></small>`
        : `<b>${esc(node.kind === 'START' ? t.start : node.kind === 'END' ? t.end : t.join)}</b>`;
  const badge =
    diag.errors.length > 0
      ? `<span class="jn-badge ko" title="${esc(diag.errors.join(' · '))}">${String(diag.errors.length)}</span>`
      : '';
  return `<div class="jn-node ${node.kind.toLowerCase()}${selected ? ' sel' : ''}${tone}" data-jn-node="${esc(node.id)}" style="${style}" role="button" tabindex="0" data-action="jn-select" data-node="${esc(node.id)}" aria-pressed="${String(selected)}" aria-label="${esc(node.kind === 'BLOCK' ? (node.block ?? '') : node.kind === 'CONDITION' ? (node.label ?? t.shapes.CONDITION ?? '') : node.kind === 'START' ? t.start : node.kind === 'END' ? t.end : t.join)}">${inner}${badge}${ports}</div>`;
}

/** Les bornes du diagramme (pour dimensionner le calque des connexions et ajuster la vue). */
export function bounds(graph: JourneyGraph): { minX: number; minY: number; maxX: number; maxY: number } {
  if (graph.nodes.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return {
    minX: Math.min(...graph.nodes.map((node) => node.x)),
    minY: Math.min(...graph.nodes.map((node) => node.y)),
    maxX: Math.max(...graph.nodes.map((node) => node.x + NODE_SIZE[node.kind].w)),
    maxY: Math.max(...graph.nodes.map((node) => node.y + NODE_SIZE[node.kind].h)),
  };
}

function edgeHtml(state: DashboardState, edge: JourneyEdge): string {
  const t = journeyText(state);
  const ui = state.lib.journey;
  const graph = ui.journey.graph;
  const from = graph.nodes.find((node) => node.id === edge.from);
  const to = graph.nodes.find((node) => node.id === edge.to);
  if (!from || !to) return '';
  const d = edgePath(from, to, edge.branch);
  const selected = ui.selected?.kind === 'edge' && ui.selected.id === edge.id;
  const errors = freshCheck(ui)?.edges[edge.id] ?? [];
  const tone = errors.length > 0 ? ' ko' : edge.branch === 'YES' ? ' yes' : edge.branch === 'NO' ? ' no' : '';
  const port = portOf(from, edge.branch);
  const label = edge.branch
    ? `<text class="jn-e-l${tone}" x="${String(port.x + (edge.branch === 'NO' ? 8 : -8))}" y="${String(port.y + 16)}" text-anchor="${edge.branch === 'NO' ? 'start' : 'end'}">${esc(edge.branch === 'YES' ? t.yes : t.no)}</text>`
    : '';
  return `<g class="jn-edge${selected ? ' sel' : ''}${tone}" data-jn-edge="${esc(edge.id)}"><path class="jn-e" d="${d}" marker-end="url(#jn-arrow)"></path><path class="jn-hit" d="${d}" data-action="jn-select-edge" data-edge="${esc(edge.id)}"><title>${esc(errors.join(' · ') || t.edgeTitle)}</title></path>${label}</g>`;
}

function diagramView(state: DashboardState, publish: boolean): string {
  const t = journeyText(state);
  const ui = state.lib.journey;
  const graph = ui.journey.graph;
  const box = bounds(graph);
  const pad = 400;
  const svg = `<svg class="jn-edges" style="left:${String(box.minX - pad)}px;top:${String(box.minY - pad)}px" width="${String(box.maxX - box.minX + pad * 2)}" height="${String(box.maxY - box.minY + pad * 2)}" viewBox="${String(box.minX - pad)} ${String(box.minY - pad)} ${String(box.maxX - box.minX + pad * 2)} ${String(box.maxY - box.minY + pad * 2)}" aria-hidden="false"><defs><marker id="jn-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z"></path></marker></defs>${graph.edges.map((edge) => edgeHtml(state, edge)).join('')}<path class="jn-temp" d=""></path></svg>`;
  return `<div class="jn-canvas" data-jn-canvas tabindex="0" role="application" aria-label="${esc(t.canvasLabel)}" aria-describedby="jn-canvas-h"><div class="jn-tools"><button type="button" class="btn small ghost icon-only" data-action="jn-zoom" data-step="-1" aria-label="${esc(t.zoomOut)}" title="${esc(t.zoomOut)}">−</button><span class="jn-zoom" aria-live="polite">${String(Math.round(ui.zoom * 100))} %</span><button type="button" class="btn small ghost icon-only" data-action="jn-zoom" data-step="1" aria-label="${esc(t.zoomIn)}" title="${esc(t.zoomIn)}">+</button><button type="button" class="btn small ghost" data-action="jn-fit">${icon('maximize')}<span>${esc(t.fit)}</span></button><button type="button" class="btn small ghost" data-action="jn-actual">${esc(t.actual)}</button></div><div class="jn-world" style="transform:translate(${String(ui.panX)}px,${String(ui.panY)}px) scale(${String(ui.zoom)})">${svg}${graph.nodes.map((node) => nodeHtml(state, node, publish)).join('')}</div><small id="jn-canvas-h" class="jn-hint mu">${esc(t.canvasHint)}</small></div>`;
}

function chips(items: readonly string[], none: string, tone = ''): string {
  return items.length > 0
    ? items.map((key) => `<code class="lib-key${tone ? ` ${tone}` : ''}">${esc(key)}</code>`).join('')
    : `<small class="mu">${esc(none)}</small>`;
}

function diagList(
  t: Text,
  diag: { errors: string[]; warnings: string[] } | undefined,
  checked: boolean,
): string {
  if (!checked) return `<p class="mu">${esc(t.notChecked)}</p>`;
  if (!diag || diag.errors.length + diag.warnings.length === 0)
    return `<p class="ok-t">${icon('check')} ${esc(t.noDiagnostic)}</p>`;
  return `<ul class="plain jn-diag">${diag.errors.map((item) => `<li class="ko">${icon('alert')}<span>${esc(item)}</span></li>`).join('')}${diag.warnings.map((item) => `<li class="warn">${icon('info')}<span>${esc(item)}</span></li>`).join('')}</ul>`;
}

function connectForm(state: DashboardState, node: JourneyNode, publish: boolean): string {
  const t = journeyText(state);
  const graph = state.lib.journey.journey.graph;
  if (!publish || node.kind === 'END') return '';
  const targets = graph.nodes.filter((entry) => entry.id !== node.id && entry.kind !== 'START');
  const label = (entry: JourneyNode): string =>
    entry.kind === 'BLOCK'
      ? (entry.block ?? '?')
      : entry.kind === 'CONDITION'
        ? `${t.shapes.CONDITION ?? ''} : ${entry.label ?? ''}`
        : entry.kind === 'END'
          ? `${t.end} (${entry.id})`
          : `${t.join} (${entry.id})`;
  const outs = graph.edges.filter((edge) => edge.from === node.id);
  return `<section class="jn-sec" aria-labelledby="jn-con-t"><h4 id="jn-con-t">${esc(t.connections)}</h4>${
    outs.length > 0
      ? `<ul class="plain jn-outs">${outs
          .map((edge) => {
            const to = graph.nodes.find((entry) => entry.id === edge.to);
            return `<li>${edge.branch ? `<span class="jn-chip ${edge.branch === 'YES' ? 'ok' : 'warn'}">${esc(edge.branch === 'YES' ? t.yes : t.no)}</span>` : ''}→ ${esc(to ? label(to) : edge.to)} <button type="button" class="btn small ghost icon-only" data-action="jn-edge-remove" data-edge="${esc(edge.id)}" aria-label="${esc(t.edgeRemove)}" title="${esc(t.edgeRemove)}">${icon('trash')}</button></li>`;
          })
          .join('')}</ul>`
      : ''
  }<div class="jn-connect"><label class="field"><span>${esc(t.connectTo)}</span><select data-jn="connect.to"><option value=""></option>${targets.map((entry) => `<option value="${esc(entry.id)}">${esc(label(entry))}</option>`).join('')}</select></label>${node.kind === 'CONDITION' ? `<label class="field"><span>${esc(t.branch)}</span><select data-jn="connect.branch"><option value="YES">${esc(t.yes)}</option><option value="NO">${esc(t.no)}</option></select></label>` : ''}<button type="button" class="btn small" data-action="jn-connect" data-node="${esc(node.id)}">${esc(t.connectAction)}</button></div></section>`;
}

function blockProps(state: DashboardState, node: JourneyNode, publish: boolean): string {
  const t = journeyText(state);
  const ui = state.lib.journey;
  const block = blockOf(state, node.block);
  const check = freshCheck(ui);
  const diag = check?.nodes[node.id];
  const params = node.params ?? {};
  const inputs = block?.contract.inputs ?? [];
  const available = diag?.available ?? [];
  const listId = `jn-avail-${node.id}`;
  const paramRows =
    inputs.length === 0
      ? `<p class="mu">${esc(t.paramsNone)}</p>`
      : `<datalist id="${esc(listId)}">${available.map((key) => `<option value="${esc(key)}"></option>`).join('')}</datalist><ul class="plain jn-params">${inputs
          .map((input) => {
            const param = params[input.key];
            const mode = param?.mode ?? 'INHERIT';
            const field =
              param?.mode === 'VALUE'
                ? `<input data-jn="param.value" data-key="${esc(input.key)}" value="${esc(param.value)}" aria-label="${esc(t.paramValue(input.key))}" autocomplete="off"${publish ? '' : ' disabled'}>`
                : param?.mode === 'MAP'
                  ? `<input data-jn="param.key" data-key="${esc(input.key)}" value="${esc(param.key)}" list="${esc(listId)}" aria-label="${esc(t.paramKey(input.key))}" autocomplete="off" spellcheck="false" class="mono"${publish ? '' : ' disabled'}>`
                  : '';
            return `<li class="jn-param"><span class="jn-param-k"><code class="lib-key${input.required ? '' : ' opt'}">${esc(input.key)}</code><small class="mu">${esc(input.required ? t.required : t.optional)}</small></span><select data-jn="param.mode" data-key="${esc(input.key)}" aria-label="${esc(input.key)}"${publish ? '' : ' disabled'}>${(['INHERIT', 'VALUE', 'MAP'] as const).map((value) => `<option value="${value}"${value === mode ? ' selected' : ''}>${esc(t.paramModes[value] ?? value)}</option>`).join('')}</select>${field}</li>`;
          })
          .join('')}</ul>`;
  const mapped = Object.entries(params).map(([key, param]) =>
    param.mode === 'MAP' ? t.ioFrom(key, param.key) : t.ioFrom(key, `« ${param.value} »`),
  );
  const satisfied = (diag?.satisfied ?? []).map((item) => {
    const from =
      item.from === 'data'
        ? t.fromData
        : item.from === 'scenario'
          ? t.fromScenario
          : (ui.journey.graph.nodes.find((entry) => entry.id === item.from)?.block ?? item.from);
    return t.ioFrom(item.key, from);
  });
  const versionMismatch = block && node.version !== undefined && node.version !== block.version;
  const io = `<section class="jn-sec" aria-labelledby="jn-io-t"><h4 id="jn-io-t">${esc(t.io)}</h4><dl class="jn-dl"><dt>${esc(t.ioRequired)}</dt><dd>${chips(
    inputs.filter((input) => input.required).map((input) => input.key),
    t.none,
  )}</dd><dt>${esc(t.ioProduced)}</dt><dd>${chips(block?.contract.outputs.map((output) => output.key) ?? [], t.none)}</dd><dt>${esc(t.ioAvailable)}</dt><dd>${check ? chips(available, t.none) : `<small class="mu">${esc(t.notChecked)}</small>`}</dd><dt>${esc(t.ioMissing)}</dt><dd>${check ? chips([...new Set((diag?.missing ?? []).map((item) => `${item.key}${check.paths.length > 1 ? ` (${pathLetter(item.path - 1)})` : ''}`))], t.none, 'ko') : `<small class="mu">${esc(t.notChecked)}</small>`}</dd><dt>${esc(t.ioMapped)}</dt><dd>${[...mapped, ...satisfied].length > 0 ? `<ul class="plain tight">${[...mapped, ...satisfied].map((item) => `<li>${esc(item)}</li>`).join('')}</ul>` : `<small class="mu">${esc(t.none)}</small>`}</dd></dl></section>`;
  const versions = `<section class="jn-sec" aria-labelledby="jn-ver-t"><h4 id="jn-ver-t">${esc(t.versions)}</h4><dl class="jn-dl"><dt>${esc(t.versionUsed)}</dt><dd>${esc(node.version !== undefined ? t.version(node.version) : '—')}</dd><dt>${esc(t.versionCurrent)}</dt><dd>${block ? `${esc(t.version(block.version))} <span class="jn-compat ${block.state === 'VALID' ? 'ok' : block.state === 'INVALID' ? 'ko' : 'warn'}">${esc(t.compat[block.state] ?? block.state)}</span>` : esc(t.unknownBlock)}</dd><dt>${esc(t.fingerprint)}</dt><dd><code>${esc(block?.hash.slice(0, 12) ?? '—')}</code></dd></dl>${versionMismatch && publish ? `<button type="button" class="btn small primary" data-action="jn-accept-version" data-node="${esc(node.id)}" data-version="${String(block.version)}">${esc(t.newVersion(block.version))}</button>` : ''}<small class="mu">${esc(t.versionNote)}</small></section>`;
  const actions = publish
    ? `<div class="form-acts start"><button type="button" class="btn small" data-action="jn-duplicate" data-node="${esc(node.id)}">${icon('copy')}<span>${esc(t.duplicate)}</span></button><button type="button" class="btn small ghost" data-action="jn-remove" data-node="${esc(node.id)}">${icon('trash')}<span>${esc(t.remove)}</span></button></div>`
    : '';
  return `<div class="jn-props-h"><span class="jn-ic" aria-hidden="true">${icon('library')}</span><div><h3 id="jn-props-t">${esc(node.block ?? '?')}</h3>${block?.description ? `<p class="mu">${esc(block.description)}</p>` : ''}</div></div><section class="jn-sec" aria-labelledby="jn-par-t"><h4 id="jn-par-t">${esc(t.params)}</h4>${paramRows}</section>${io}${versions}<section class="jn-sec" aria-labelledby="jn-dg-t"><h4 id="jn-dg-t">${esc(t.diagnostics)}</h4>${diagList(t, diag, check !== undefined)}</section>${ui.journey.mode === 'DIAGRAM' ? connectForm(state, node, publish) : ''}${actions}`;
}

function journeyProps(state: DashboardState, publish: boolean): string {
  const t = journeyText(state);
  const ui = state.lib.journey;
  const journey = ui.journey;
  const check = freshCheck(ui);
  const summary = check
    ? `<p class="mu">${esc(t.paths(check.paths.length))}${check.linear ? ` · ${esc(t.linearYes)}` : ''}</p><ul class="plain jn-paths">${check.paths
        .map(
          (entry) =>
            `<li class="${entry.check.ok ? 'ok' : 'ko'}"><b>${esc(t.pathLabel(pathLetter(entry.index)))}</b> <span class="jn-chip ${entry.check.ok ? 'ok' : 'ko'}">${esc(entry.check.ok ? t.pathOk : t.pathKo)}</span>${entry.choices.length > 0 ? `<small class="mu block">${esc(entry.choices.map((choice) => `${choice.label} = ${choice.branch === 'YES' ? t.yes : t.no}`).join(' · '))}</small>` : ''}<small class="mu block">${esc(entry.check.order.map((item) => item.block).join(' → ') || '—')}</small></li>`,
        )
        .join(
          '',
        )}</ul><p class="mu">${esc(check.publishable === 'PER_PATH' ? t.publishInfoPaths : t.publishInfoSingle)}</p>`
    : `<p class="mu">${esc(ui.checking ? t.checking : t.notChecked)}</p>`;
  const global = check
    ? `${check.errors.length > 0 ? `<ul class="plain jn-diag">${check.errors.map((item) => `<li class="ko">${icon('alert')}<span>${esc(item)}</span></li>`).join('')}</ul>` : ''}${check.warnings.length > 0 ? `<ul class="plain jn-diag">${check.warnings.map((item) => `<li class="warn">${icon('info')}<span>${esc(item)}</span></li>`).join('')}</ul>` : ''}`
    : '';
  return `<div class="jn-props-h"><span class="jn-ic" aria-hidden="true">${icon('explorations')}</span><div><h3 id="jn-props-t">${esc(t.propsJourney)}</h3><p class="mu">${esc(t.propsNone)}</p></div></div><label class="field"><span>${esc(t.description)}</span><textarea data-jn="description" rows="2" maxlength="500"${publish ? '' : ' disabled'}>${esc(journey.description ?? '')}</textarea></label>${journey.published && journey.published.length > 0 ? `<p class="mu">${esc(t.published(journey.published.join(', ')))}</p>` : ''}<section class="jn-sec" aria-labelledby="jn-chk-t"><h4 id="jn-chk-t">${esc(t.checkTitle)}</h4>${summary}${global}</section>`;
}

function otherProps(state: DashboardState, node: JourneyNode, publish: boolean): string {
  const t = journeyText(state);
  const ui = state.lib.journey;
  const check = freshCheck(ui);
  const title =
    node.kind === 'CONDITION'
      ? (t.shapes.CONDITION ?? '')
      : node.kind === 'START'
        ? t.start
        : node.kind === 'END'
          ? t.end
          : t.join;
  const question =
    node.kind === 'CONDITION'
      ? `<label class="field"><span>${esc(t.question)}</span><input data-jn="label" value="${esc(node.label ?? '')}" maxlength="120" autocomplete="off"${publish ? '' : ' disabled'}></label>`
      : '';
  const remove =
    publish && node.kind !== 'START'
      ? `<div class="form-acts start"><button type="button" class="btn small ghost" data-action="jn-remove" data-node="${esc(node.id)}">${icon('trash')}<span>${esc(t.remove)}</span></button></div>`
      : '';
  return `<div class="jn-props-h"><span class="jn-ic ${node.kind.toLowerCase()}" aria-hidden="true">${icon(node.kind === 'CONDITION' ? 'alert' : 'explorations')}</span><div><h3 id="jn-props-t">${esc(title)}</h3></div></div>${question}<section class="jn-sec" aria-labelledby="jn-dg-t"><h4 id="jn-dg-t">${esc(t.diagnostics)}</h4>${diagList(t, check?.nodes[node.id], check !== undefined)}</section>${connectForm(state, node, publish)}${remove}`;
}

function edgeProps(state: DashboardState, edge: JourneyEdge, publish: boolean): string {
  const t = journeyText(state);
  const ui = state.lib.journey;
  const graph = ui.journey.graph;
  const from = graph.nodes.find((node) => node.id === edge.from);
  const to = graph.nodes.find((node) => node.id === edge.to);
  const name = (node: JourneyNode | undefined): string =>
    !node
      ? '?'
      : node.kind === 'BLOCK'
        ? (node.block ?? '?')
        : node.kind === 'CONDITION'
          ? (node.label ?? '?')
          : node.kind === 'START'
            ? t.start
            : node.kind === 'END'
              ? t.end
              : t.join;
  const errors = freshCheck(ui)?.edges[edge.id] ?? [];
  return `<div class="jn-props-h"><span class="jn-ic" aria-hidden="true">${icon('right')}</span><div><h3 id="jn-props-t">${esc(t.edgeTitle)}</h3><p class="mu">${esc(name(from))} → ${esc(name(to))}</p></div></div>${from?.kind === 'CONDITION' ? `<label class="field"><span>${esc(t.branch)}</span><select data-jn="edge.branch"${publish ? '' : ' disabled'}><option value="YES"${edge.branch === 'YES' ? ' selected' : ''}>${esc(t.yes)}</option><option value="NO"${edge.branch === 'NO' ? ' selected' : ''}>${esc(t.no)}</option></select></label>` : ''}<section class="jn-sec" aria-labelledby="jn-dg-t"><h4 id="jn-dg-t">${esc(t.diagnostics)}</h4>${diagList(t, { errors, warnings: [] }, freshCheck(ui) !== undefined)}</section>${publish ? `<div class="form-acts start"><button type="button" class="btn small ghost" data-action="jn-edge-remove" data-edge="${esc(edge.id)}">${icon('trash')}<span>${esc(t.edgeRemove)}</span></button></div>` : ''}`;
}

function properties(state: DashboardState, publish: boolean): string {
  const t = journeyText(state);
  const ui = state.lib.journey;
  const selected = ui.selected;
  const graph = ui.journey.graph;
  const node = selected?.kind === 'node' ? graph.nodes.find((entry) => entry.id === selected.id) : undefined;
  const edge = selected?.kind === 'edge' ? graph.edges.find((entry) => entry.id === selected.id) : undefined;
  const body = node
    ? node.kind === 'BLOCK'
      ? blockProps(state, node, publish)
      : otherProps(state, node, publish)
    : edge
      ? edgeProps(state, edge, publish)
      : journeyProps(state, publish);
  return `<aside class="jn-props" aria-labelledby="jn-props-t" aria-live="polite"><p class="jn-props-k">${esc(t.propsTitle)}</p>${body}${selected ? `<button type="button" class="btn small ghost jn-back" data-action="jn-deselect">${icon('back')}<span>${esc(t.propsJourney)}</span></button>` : ''}</aside>`;
}

/** Le compositeur : barre, palette, scène (linéaire ou diagramme), propriétés et diagnostics. */
export function journeyWorkspace(state: DashboardState, publish: boolean): string {
  const t = journeyText(state);
  const ui = state.lib.journey;
  const stage = ui.journey.mode === 'LINEAR' ? linearView(state, publish) : diagramView(state, publish);
  return `<section class="card jn" id="lib-composer" aria-labelledby="lib-composer-t" data-mode="${ui.journey.mode}">${toolbar(state, publish)}<p class="mu jn-intro">${esc(t.intro)}</p><div class="jn-body">${palette(state, publish)}<div class="jn-stage" data-jn-stage>${stage}</div>${properties(state, publish)}</div></section>`;
}

// ── Styles ───────────────────────────────────────────────────────────────────────────────────

export const JOURNEY_CSS = `
.jn{display:flex;flex-direction:column;gap:12px;min-width:0}
.jn-top{display:flex;flex-direction:column;gap:10px}
.jn-head{display:flex;flex-wrap:wrap;align-items:center;gap:10px;justify-content:space-between}
.jn-head h2{margin:0}
.jn-chips{display:flex;flex-wrap:wrap;gap:6px}
.jn-chip{display:inline-flex;align-items:center;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600;border:1px solid var(--qa-color-border);background:var(--qa-color-surface-2);color:var(--qa-color-muted)}
.jn-chip.ok{color:var(--qa-color-primary-2);background:var(--qa-color-primary-soft);border-color:color-mix(in srgb,var(--qa-color-primary) 25%,var(--qa-color-border))}
.jn-chip.warn{color:color-mix(in srgb,var(--qa-color-warning) 75%,var(--qa-color-text));background:var(--qa-color-warning-soft);border-color:color-mix(in srgb,var(--qa-color-warning) 30%,var(--qa-color-border))}
.jn-chip.ko{color:var(--qa-color-danger);background:var(--qa-color-danger-soft);border-color:color-mix(in srgb,var(--qa-color-danger) 30%,var(--qa-color-border))}
.jn-chip.live{color:var(--qa-color-primary);background:var(--qa-color-surface)}
.jn-bar{display:flex;flex-wrap:wrap;align-items:flex-end;gap:10px}
.jn-name{flex:1 1 220px;min-width:0}
.jn-open select{min-height:var(--qa-control,36px);max-width:260px}
.jn-modes button{display:inline-flex;align-items:center;gap:6px}
.jn-modes .ico{width:15px;height:15px}
.jn-acts{display:flex;flex-wrap:wrap;gap:6px;margin-left:auto}
.jn-redo .ico{transform:scaleX(-1)}
.jn-msg{display:flex;gap:6px;align-items:flex-start;margin:0;padding:8px 10px;border-radius:8px;font-size:13px}
.jn-msg.warn{background:var(--qa-color-warning-soft);color:color-mix(in srgb,var(--qa-color-warning) 70%,var(--qa-color-text))}
.jn-msg .ico{width:16px;height:16px;flex:none;margin-top:1px}
.jn-confirm{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--qa-color-border);border-radius:8px;background:var(--qa-color-surface-2)}
.jn-confirm.warn{border-color:color-mix(in srgb,var(--qa-color-warning) 35%,var(--qa-color-border));background:var(--qa-color-warning-soft)}
.jn-confirm p{margin:0;flex:1 1 260px}
.jn-intro{margin:0}
.jn-body{display:grid;grid-template-columns:230px minmax(0,1fr) 320px;gap:12px;align-items:start;min-width:0}
.jn-palette,.jn-props{border:1px solid var(--qa-color-border);border-radius:10px;background:var(--qa-color-surface);padding:12px;display:flex;flex-direction:column;gap:8px;min-width:0;max-height:640px;overflow:auto}
.jn-palette h3,.jn-props h3{margin:0;font-size:14px}
.jn-pal-search{display:flex}
.jn-pal-g summary{cursor:pointer;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--qa-color-muted);padding:4px 0}
.jn-pal-list{display:flex;flex-direction:column;gap:6px;margin:4px 0}
.jn-pal-item{display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--qa-color-border);border-radius:8px;background:var(--qa-color-surface);cursor:grab;min-width:0}
.jn-pal-item:hover{border-color:var(--qa-color-primary)}
.jn-pal-item.warn{border-left:3px solid var(--qa-color-warning)}
.jn-pal-item.ko{border-left:3px solid var(--qa-color-danger)}
.jn-pal-t{display:flex;flex-direction:column;min-width:0;flex:1}
.jn-pal-t b{font-size:13px;overflow-wrap:anywhere}
.jn-pal-ic,.jn-ic{width:26px;height:26px;border-radius:7px;display:grid;place-items:center;background:var(--qa-color-primary-soft);color:var(--qa-color-primary);flex:none}
.jn-pal-ic .ico,.jn-ic .ico{width:15px;height:15px}
.jn-ic.condition{background:var(--qa-color-warning-soft);color:var(--qa-color-warning)}
.jn-pal-shapes h3{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--qa-color-muted)}
.jn-shape-row{display:flex;flex-wrap:wrap;gap:6px}
.jn-shape{border:1px dashed var(--qa-color-border-strong);border-radius:8px;background:var(--qa-color-surface);padding:5px 10px;font:inherit;font-size:12.5px;cursor:grab;color:var(--qa-color-text)}
.jn-shape.condition{border-color:var(--qa-color-warning);color:color-mix(in srgb,var(--qa-color-warning) 75%,var(--qa-color-text));background:var(--qa-color-warning-soft)}
.jn-stage{min-width:0;border:1px solid var(--qa-color-border);border-radius:10px;background:var(--qa-color-surface-2);padding:14px;min-height:420px}
.jn-line{display:flex;flex-direction:column;align-items:stretch;gap:0;max-width:640px;margin:0 auto}
.jn-term{align-self:center;display:inline-flex;align-items:center;gap:6px;padding:6px 16px;border-radius:999px;font-weight:700;font-size:13px;background:var(--qa-color-primary);color:var(--qa-color-surface)}
.jn-term.end{background:var(--qa-color-text)}
.jn-term .ico{width:14px;height:14px}
.jn-gap{height:22px;display:flex;align-items:center;justify-content:center;position:relative}
.jn-gap::before{content:"";position:absolute;top:0;bottom:0;left:50%;border-left:2px solid var(--qa-color-border-strong)}
.jn-gap span{position:relative;opacity:0;font-size:11.5px;font-weight:600;color:var(--qa-color-primary-2);background:var(--qa-color-primary-soft);border:1px dashed var(--qa-color-primary);border-radius:6px;padding:0 8px}
.jn-dragging .jn-gap{height:34px}
.jn-dragging .jn-gap span{opacity:.6}
.jn-gap.over span{opacity:1}
.jn-card{display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--qa-color-border);border-radius:10px;background:var(--qa-color-surface);min-width:0;box-shadow:0 1px 2px color-mix(in srgb,var(--qa-color-text) 6%,transparent)}
.jn-card:hover{border-color:color-mix(in srgb,var(--qa-color-primary) 45%,var(--qa-color-border))}
.jn-card.sel{border-color:var(--qa-color-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--qa-color-primary) 25%,transparent)}
.jn-card.ko{border-color:var(--qa-color-danger);background:color-mix(in srgb,var(--qa-color-danger) 4%,var(--qa-color-surface))}
.jn-card.warn{border-color:var(--qa-color-warning)}
.jn-card.moving{opacity:.45}
.jn-grip{cursor:grab;color:var(--qa-color-faint);display:grid;place-items:center}
.jn-grip .ico{width:16px;height:16px}
.jn-num{width:22px;height:22px;border-radius:50%;display:grid;place-items:center;font-size:12px;font-weight:700;background:var(--qa-color-primary-soft);color:var(--qa-color-primary-2);flex:none}
.jn-card-b{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;text-align:left;background:none;border:0;padding:0;font:inherit;color:inherit;cursor:pointer}
.jn-card-h{display:flex;flex-wrap:wrap;align-items:center;gap:6px;min-width:0}
.jn-card-h b{overflow-wrap:anywhere}
.jn-compat{font-size:11.5px;font-weight:600;padding:1px 8px;border-radius:999px;border:1px solid var(--qa-color-border)}
.jn-compat.ok{color:var(--qa-color-primary-2);background:var(--qa-color-primary-soft)}
.jn-compat.warn{color:color-mix(in srgb,var(--qa-color-warning) 75%,var(--qa-color-text));background:var(--qa-color-warning-soft)}
.jn-compat.ko{color:var(--qa-color-danger);background:var(--qa-color-danger-soft)}
.jn-ios{display:flex;flex-wrap:wrap;gap:8px}
.jn-io{display:inline-flex;flex-wrap:wrap;align-items:center;gap:4px;font-size:11.5px;color:var(--qa-color-muted)}
.jn-io .lib-key.set{border-color:var(--qa-color-primary)}
.jn-err{display:flex;gap:4px;align-items:center;font-size:12px;color:var(--qa-color-danger)}
.jn-err .ico{width:13px;height:13px}
.jn-card-a{display:flex;gap:2px;flex:none}
.jn-empty{text-align:center;padding:24px 12px;border:2px dashed var(--qa-color-border-strong);border-radius:10px}
.jn-canvas{position:relative;height:560px;overflow:hidden;border-radius:8px;background-color:var(--qa-color-surface);background-image:radial-gradient(color-mix(in srgb,var(--qa-color-text) 14%,transparent) 1px,transparent 1px);background-size:20px 20px;cursor:grab;touch-action:none;margin:-14px}
.jn-canvas.panning{cursor:grabbing}
.jn-canvas.drop{outline:2px dashed var(--qa-color-primary);outline-offset:-4px}
.jn-tools{position:absolute;z-index:3;top:8px;right:8px;display:flex;align-items:center;gap:4px;padding:4px;border:1px solid var(--qa-color-border);border-radius:8px;background:var(--qa-color-surface)}
.jn-zoom{font-size:12px;min-width:44px;text-align:center;font-variant-numeric:tabular-nums}
.jn-hint{position:absolute;z-index:3;left:10px;bottom:8px;right:10px;font-size:11.5px;pointer-events:none}
.jn-world{position:absolute;left:0;top:0;transform-origin:0 0}
.jn-edges{position:absolute;overflow:visible;pointer-events:none}
.jn-e{fill:none;stroke:var(--qa-color-border-strong);stroke-width:2}
.jn-edge.yes .jn-e{stroke:var(--qa-color-primary)}
.jn-edge.no .jn-e{stroke:var(--qa-color-warning)}
.jn-edge.ko .jn-e{stroke:var(--qa-color-danger);stroke-dasharray:6 4}
.jn-edge.sel .jn-e{stroke-width:3.5}
.jn-hit{fill:none;stroke:transparent;stroke-width:14;pointer-events:stroke;cursor:pointer}
.jn-e-l{font-size:11px;font-weight:700;fill:var(--qa-color-muted)}
.jn-e-l.yes{fill:var(--qa-color-primary-2)}
.jn-e-l.no{fill:color-mix(in srgb,var(--qa-color-warning) 80%,var(--qa-color-text))}
#jn-arrow path{fill:var(--qa-color-border-strong)}
.jn-temp{fill:none;stroke:var(--qa-color-primary);stroke-width:2;stroke-dasharray:5 4}
.jn-node{position:absolute;box-sizing:border-box;display:flex;flex-direction:column;justify-content:center;gap:3px;padding:8px 12px;border:1px solid var(--qa-color-border);border-radius:10px;background:var(--qa-color-surface);cursor:move;user-select:none;box-shadow:0 1px 3px color-mix(in srgb,var(--qa-color-text) 8%,transparent)}
.jn-node.block{border-left:4px solid var(--qa-color-primary);background:color-mix(in srgb,var(--qa-color-primary) 5%,var(--qa-color-surface))}
.jn-node.start,.jn-node.end{align-items:center;border-radius:999px;background:var(--qa-color-primary);color:var(--qa-color-surface);border-color:var(--qa-color-primary)}
.jn-node.end{background:var(--qa-color-text);border-color:var(--qa-color-text)}
.jn-node.condition{border:2px solid var(--qa-color-warning);background:var(--qa-color-warning-soft);border-radius:14px;align-items:center;text-align:center}
.jn-node.join{align-items:center;border-radius:999px;border-style:dashed;background:var(--qa-color-surface-2)}
.jn-node.sel{box-shadow:0 0 0 3px color-mix(in srgb,var(--qa-color-primary) 35%,transparent)}
.jn-node.ko{border-color:var(--qa-color-danger)}
.jn-node.dragging{opacity:.85;box-shadow:0 8px 20px color-mix(in srgb,var(--qa-color-text) 18%,transparent)}
.jn-node:focus-visible{outline:2px solid var(--qa-color-primary);outline-offset:2px}
.jn-n-h{display:flex;align-items:center;gap:6px;min-width:0}
.jn-n-h b{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.jn-yn{display:flex;justify-content:space-between;width:100%;font-weight:700;font-size:11px}
.jn-yn span:first-child{color:var(--qa-color-primary-2)}
.jn-badge{position:absolute;top:-8px;right:-8px;min-width:18px;height:18px;border-radius:9px;background:var(--qa-color-danger);color:var(--qa-color-surface);font-size:11px;font-weight:700;display:grid;place-items:center;padding:0 4px}
.jn-port{position:absolute;bottom:-7px;left:50%;width:14px;height:14px;margin-left:-7px;border-radius:50%;background:var(--qa-color-surface);border:2px solid var(--qa-color-primary);cursor:crosshair}
.jn-port.yes{left:22%}
.jn-port.no{left:78%;border-color:var(--qa-color-warning)}
.jn-port:hover{background:var(--qa-color-primary)}
.jn-node.target{box-shadow:0 0 0 3px var(--qa-color-primary)}
.jn-props-k{margin:0;font-size:11.5px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--qa-color-muted)}
.jn-props-h{display:flex;gap:10px;align-items:flex-start}
.jn-props-h p{margin:2px 0 0}
.jn-sec{display:flex;flex-direction:column;gap:6px;padding-top:8px;border-top:1px solid var(--qa-color-border)}
.jn-sec h4{margin:0;font-size:13px}
.jn-params{display:flex;flex-direction:column;gap:8px}
.jn-param{display:grid;grid-template-columns:minmax(0,1fr);gap:4px}
.jn-param-k{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.jn-param select,.jn-param input,.jn-connect select{min-height:32px;border-radius:7px;border:1px solid var(--qa-color-border-strong);background:var(--qa-color-surface);color:var(--qa-color-text);font:inherit;padding:2px 8px}
.jn-dl{display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px 10px;margin:0;font-size:12.5px}
.jn-dl dt{color:var(--qa-color-muted)}
.jn-dl dd{margin:0;display:flex;flex-wrap:wrap;gap:4px;min-width:0}
.jn-diag{display:flex;flex-direction:column;gap:4px;font-size:12.5px}
.jn-diag li{display:flex;gap:6px;align-items:flex-start;overflow-wrap:anywhere}
.jn-diag li.ko{color:var(--qa-color-danger)}
.jn-diag li.warn{color:color-mix(in srgb,var(--qa-color-warning) 75%,var(--qa-color-text))}
.jn-diag .ico{width:14px;height:14px;flex:none;margin-top:2px}
.jn-paths{display:flex;flex-direction:column;gap:6px;font-size:12.5px}
.jn-paths li{padding:6px 8px;border:1px solid var(--qa-color-border);border-radius:8px}
.jn-paths li.ko{border-color:color-mix(in srgb,var(--qa-color-danger) 40%,var(--qa-color-border))}
.jn-outs{display:flex;flex-direction:column;gap:4px;font-size:12.5px}
.jn-outs li{display:flex;align-items:center;gap:6px}
.jn-connect{display:flex;flex-wrap:wrap;align-items:flex-end;gap:6px}
.jn-back{align-self:flex-start}
.ok-t{color:var(--qa-color-primary-2);display:flex;gap:6px;align-items:center;margin:0}
.ok-t .ico{width:14px;height:14px}
/* Écran intermédiaire : les propriétés passent sous la scène (le diagramme garde sa largeur). */
@media (max-width:1599px){
  .jn-body{grid-template-columns:220px minmax(0,1fr)}
  .jn-props{grid-column:1 / -1;max-height:none}
}
@media (max-width:760px){
  .jn-body{grid-template-columns:minmax(0,1fr)}
  .jn-palette{max-height:280px}
  .jn-canvas{height:440px}
  .jn-acts{margin-left:0}
}
`;
