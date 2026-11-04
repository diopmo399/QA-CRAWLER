import type { LibraryBlockView } from '../core/contracts.js';
import {
  chain,
  edgePoints,
  emptyJourney,
  freeId,
  linearOrder,
  NODE_SIZE,
  journeyStructure,
  pathLetter,
  pointsPath,
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
  /** Le nom du bloc à créer depuis le parcours (absent : formulaire fermé). */
  blockName?: string;
  converting?: boolean;
  /** Le bloc choisi dans le catalogue (surligné ; l'outil « bloc » du diagramme l'ajoute). */
  picked?: string;
  /** La catégorie affichée dans le catalogue (une origine réelle des blocs ; vide : toutes). */
  category: string;
  /** L'outil du diagramme : sélectionner/déplacer, ou relier deux nœuds par clics. */
  tool: 'select' | 'connect';
  connectFrom?: string;
  /** L'onglet du panneau de propriétés d'un bloc. */
  propsTab: 'params' | 'io' | 'details';
  /** La confirmation discrète d'un ajout réussi (s'efface seule). */
  toast?: string;
  /** Un bloc déposé sur une connexion : proposer de l'insérer entre ses deux nœuds. */
  pendingInsert?: { edge: string; node: string };
}

export const emptyJourneyUi = (): JourneyUi => ({
  category: '',
  tool: 'select',
  propsTab: 'params',
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
    // Ajouté par un clic (sans position) après un nœud sans suite : le nouveau bloc s'y rattache. Un bloc
    // déposé à un endroit n'est jamais relié d'office (aucune connexion ambiguë).
    const selected =
      at.x === undefined && ui.selected?.kind === 'node' ? nodeOf(graph, ui.selected.id) : undefined;
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
/**
 * Insère un bloc posé (sans connexion) au milieu d'une connexion : départ → bloc → arrivée. La branche
 * d'une condition passe au premier segment. Les autres nœuds ne bougent pas. Refus expliqué sinon.
 */
export function insertOnEdge(ui: JourneyUi, edgeId: string, nodeId: string): string | undefined {
  const graph = ui.journey.graph;
  const edge = graph.edges.find((entry) => entry.id === edgeId);
  const node = nodeOf(graph, nodeId);
  if (!edge || !node || node.kind !== 'BLOCK') return 'connexion ou bloc introuvable';
  if (graph.edges.some((entry) => entry.from === nodeId || entry.to === nodeId))
    return 'ce bloc est déjà relié : retirez ses connexions d’abord';
  remember(ui);
  const rest = graph.edges.filter((entry) => entry.id !== edgeId);
  const first = { id: edge.id, from: edge.from, to: nodeId, ...(edge.branch ? { branch: edge.branch } : {}) };
  const second = {
    id: freeId(
      'e',
      graph.edges.map((entry) => entry.id),
    ),
    from: nodeId,
    to: edge.to,
  };
  graph.edges = [...rest, first, second];
  ui.selected = { kind: 'node', id: nodeId };
  return undefined;
}

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
  displayMode: 'Mode d’affichage :',
  tabCatalog: 'Catalogue de blocs',
  tabComposer: 'Compositeur de parcours',
  tabDiagnostics: 'Diagnostics',
  allBlocks: 'Tous les blocs',
  category: 'Catégorie',
  paletteSearchShort: 'Rechercher un bloc…',
  picked: (name: string) => `« ${name} » choisi : cliquez sur + ou glissez-le dans le parcours.`,
  toolsLabel: 'Outils du diagramme',
  toolSelect: 'Sélectionner et déplacer',
  toolBlock: 'Ajouter le bloc choisi dans le catalogue',
  toolBlockNone: 'Choisissez d’abord un bloc dans le catalogue',
  toolConnect: 'Relier : cliquez le départ puis l’arrivée',
  toolDelete: 'Supprimer la sélection',
  connectPickFrom: 'Relier : cliquez le nœud de départ.',
  connectPickTo: (name: string) =>
    `Relier depuis « ${name} » : cliquez le nœud d’arrivée (Échap pour annuler).`,
  propsBlock: 'Propriétés du bloc',
  propsShape: 'Propriétés',
  propsJourneyTitle: 'Propriétés du parcours',
  propsEdge: 'Propriétés de la connexion',
  tabParams: 'Paramètres',
  tabIo: 'Entrées/Sorties',
  tabDetails: 'Détails',
  openSheet: 'Voir la fiche du bloc',
  edit: 'Modifier',
  more: 'Plus d’actions',
  deselect: 'Désélectionner',
  validationTitle: 'Validation du parcours',
  validNot: 'Pas encore vérifié',
  validItems: {
    structure: ['Structure et connexions correctes', 'Structure ou connexions à corriger'],
    deps: ['Dépendances satisfaites', 'Dépendances non satisfaites'],
    conflicts: ['Aucune donnée en conflit', 'Données en conflit'],
    versions: ['Versions compatibles', 'Versions à vérifier ou à accepter'],
  } as Record<string, [string, string]>,
  validIssues: (n: number) => `${String(n)} problème(s)`,
  toastAdded: (name: string) => `Bloc « ${name} » ajouté au parcours`,
  close: 'Fermer',
  insertOnEdge: (block: string, from: string, to: string) => `Insérer « ${block} » entre ${from} et ${to} ?`,
  insertYes: 'Insérer',
  insertNo: 'Laisser sans connexion',
  addHere: 'Ajouter un bloc ici',
  recentShow: 'Afficher les blocs récemment ouverts',
  recentHide: 'Masquer les blocs récemment ouverts',
  propsShow: 'Afficher les propriétés',
  propsHide: 'Masquer les propriétés',
  wide: 'Agrandir le compositeur',
  narrow: 'Rétablir les panneaux',
  conditionsTitle: 'Conditions',
  versionsDeps: 'Versions et dépendances',
  noCondition: 'Aucune condition.',
  outputsTitle: 'Sorties du parcours',
  outputsGuaranteed: 'Produites sur tous les chemins',
  outputsPartial: 'Seulement sur certains chemins',
  outputsOnly: (paths: string) => `chemin(s) ${paths}`,
  outputsNone: 'Ce parcours ne produit aucune donnée déclarée par ses blocs.',
  toBlockTitle: 'Réutiliser comme bloc',
  toBlockInfo:
    'Le parcours devient un bloc de la bibliothèque, utilisable dans d’autres parcours. Son contrat déclare les sorties produites sur tous les chemins.',
  toBlock: 'Transformer en bloc',
  toBlockName: 'Nom du bloc',
  toBlockConfirm: 'Créer le bloc',
  toBlockBusy: 'Création du bloc…',
  toBlockPaths:
    'Un parcours avec conditions ne devient pas un bloc : ses chemins produisent des données différentes.',
  toBlockDone: (name: string, outputs: number) =>
    `Le bloc « ${name} » est dans la bibliothèque, avec ${String(outputs)} sortie(s) déclarée(s).`,
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
  displayMode: 'Display mode:',
  tabCatalog: 'Block catalogue',
  tabComposer: 'Journey composer',
  tabDiagnostics: 'Diagnostics',
  allBlocks: 'All blocks',
  category: 'Category',
  paletteSearchShort: 'Search a block…',
  picked: (name: string) => `“${name}” picked: click + or drag it into the journey.`,
  toolsLabel: 'Diagram tools',
  toolSelect: 'Select and move',
  toolBlock: 'Add the block picked in the catalogue',
  toolBlockNone: 'Pick a block in the catalogue first',
  toolConnect: 'Connect: click the start, then the end',
  toolDelete: 'Delete the selection',
  connectPickFrom: 'Connect: click the start node.',
  connectPickTo: (name: string) => `Connect from “${name}”: click the end node (Esc to cancel).`,
  propsBlock: 'Block properties',
  propsShape: 'Properties',
  propsJourneyTitle: 'Journey properties',
  propsEdge: 'Connection properties',
  tabParams: 'Parameters',
  tabIo: 'Inputs/Outputs',
  tabDetails: 'Details',
  openSheet: 'Open the block sheet',
  edit: 'Edit',
  more: 'More actions',
  deselect: 'Deselect',
  validationTitle: 'Journey validation',
  validNot: 'Not checked yet',
  validItems: {
    structure: ['Structure and connections correct', 'Structure or connections to fix'],
    deps: ['Dependencies satisfied', 'Dependencies not satisfied'],
    conflicts: ['No conflicting data', 'Conflicting data'],
    versions: ['Compatible versions', 'Versions to check or accept'],
  },
  validIssues: (n: number) => `${String(n)} issue(s)`,
  toastAdded: (name: string) => `Block “${name}” added to the journey`,
  close: 'Close',
  insertOnEdge: (block: string, from: string, to: string) => `Insert “${block}” between ${from} and ${to}?`,
  insertYes: 'Insert',
  insertNo: 'Leave unconnected',
  addHere: 'Add a block here',
  recentShow: 'Show recently opened blocks',
  recentHide: 'Hide recently opened blocks',
  propsShow: 'Show properties',
  propsHide: 'Hide properties',
  wide: 'Enlarge the composer',
  narrow: 'Restore the panels',
  conditionsTitle: 'Conditions',
  versionsDeps: 'Versions and dependencies',
  noCondition: 'No condition.',
  outputsTitle: 'Journey outputs',
  outputsGuaranteed: 'Produced on every path',
  outputsPartial: 'Only on some paths',
  outputsOnly: (paths: string) => `path(s) ${paths}`,
  outputsNone: 'This journey produces no data declared by its blocks.',
  toBlockTitle: 'Reuse as a block',
  toBlockInfo:
    'The journey becomes a library block, usable in other journeys. Its contract declares the outputs produced on every path.',
  toBlock: 'Turn into a block',
  toBlockName: 'Block name',
  toBlockConfirm: 'Create the block',
  toBlockBusy: 'Creating the block…',
  toBlockPaths: 'A journey with conditions does not become a block: its paths produce different data.',
  toBlockDone: (name: string, outputs: number) =>
    `The block “${name}” is in the library, with ${String(outputs)} declared output(s).`,
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

/** L'en-tête du parcours dans le compositeur : son nom (titre modifiable), les parcours enregistrés, son état. */
function journeyHead(state: DashboardState, publish: boolean): string {
  const t = journeyText(state);
  const ui = state.lib.journey;
  const journey = ui.journey;
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
  const confirm = ui.confirmDiscard
    ? `<div class="jn-confirm" role="group"><p>${esc(ui.confirmDiscard === '\u0000new' ? t.discardNew : t.discard(ui.confirmDiscard))}</p><button type="button" class="btn small primary" data-action="jn-discard-yes">${esc(t.confirm)}</button><button type="button" class="btn small ghost" data-action="jn-discard-no">${esc(t.cancel)}</button></div>`
    : ui.confirmPerPath
      ? `<div class="jn-confirm warn" role="group"><p>${esc(t.perPathConfirm)}</p><button type="button" class="btn small primary" data-action="jn-publish-paths">${esc(t.perPathYes)}</button><button type="button" class="btn small ghost" data-action="jn-publish-cancel">${esc(t.cancel)}</button></div>`
      : '';
  const messages = `${ui.modeMessage ? `<p class="jn-msg warn" role="alert">${icon('alert')}<span>${esc(ui.modeMessage)}</span></p>` : ''}${confirm}${ui.error ? `<div class="err" role="alert"><p>${esc(ui.error)}</p>${(ui.details ?? []).length > 1 ? `<ul class="plain tight">${(ui.details ?? []).map((item) => `<li>${esc(item)}</li>`).join('')}</ul>` : ''}</div>` : ''}${ui.notice ? `<p class="notice ok" role="status">${icon('check')}<span>${esc(ui.notice)}</span></p>` : ''}`;
  return `<div class="jn-head"><span class="jn-head-ic" aria-hidden="true">${icon('cube')}</span><label class="jn-title"><span class="sr">${esc(t.name)}</span><input data-jn="name" value="${esc(journey.name)}" maxlength="80" autocomplete="off" placeholder="${esc(t.name)}" aria-label="${esc(t.name)}"${publish ? '' : ' disabled'}></label>${statusChips(state)}<span class="jn-head-r">${opener}${publish ? `<button type="button" class="btn small ghost" data-action="jn-new">${icon('plus')}<span>${esc(t.newJourney)}</span></button>` : ''}</span></div>${messages}`;
}

/** Les actions du parcours, en tête de page comme la maquette : Enregistrer, Vérifier, Créer. */
export function journeyActions(state: DashboardState, publish: boolean): string {
  if (!publish) return '';
  const t = journeyText(state);
  const ui = state.lib.journey;
  const check = freshCheck(ui);
  const busy = Boolean(ui.saving || ui.publishing || ui.checking);
  const publishLabel =
    check?.publishable === 'PER_PATH' ? t.publishPaths(check.paths.length) : t.publishSingle;
  const canPublish = !busy && check?.ok === true && !ui.dirty && ui.savedName !== undefined;
  return `<div class="jn-acts"><button type="button" class="btn" data-action="jn-save"${busy ? ' disabled' : ''} aria-busy="${String(Boolean(ui.saving))}">${icon('save')}<span>${esc(ui.saving ? t.saving : t.save)}</span></button><button type="button" class="btn" data-action="jn-check"${busy ? ' disabled' : ''} aria-busy="${String(Boolean(ui.checking))}">${icon('check')}<span>${esc(ui.checking ? t.checking : t.check)}</span></button><button type="button" class="btn primary" data-action="jn-publish"${canPublish ? '' : ' disabled'} aria-busy="${String(Boolean(ui.publishing))}" title="${esc(canPublish ? publishLabel : ui.dirty || !ui.savedName ? t.saveFirst : t.checkFirst)}">${icon('play')}<span>${esc(ui.publishing ? t.publishing : publishLabel)}</span></button></div>`;
}

/** La barre du compositeur : mode d'affichage, annuler/rétablir, vue du diagramme, agrandir. */
function modeBar(state: DashboardState, publish: boolean): string {
  const t = journeyText(state);
  const ui = state.lib.journey;
  const journey = ui.journey;
  const modes = `<span class="jn-modes" role="radiogroup" aria-label="${esc(t.modesLabel)}">${(
    ['LINEAR', 'DIAGRAM'] as const
  )
    .map(
      (mode) =>
        `<button type="button" role="radio" id="jn-mode-${mode}" class="btn small${journey.mode === mode ? ' primary' : ''}" data-action="jn-mode" data-mode="${mode}" aria-checked="${String(journey.mode === mode)}">${icon(mode === 'LINEAR' ? 'menu' : 'merge')}<span>${esc(t.modes[mode])}</span></button>`,
    )
    .join('')}</span>`;
  const history = publish
    ? `<span class="jn-grp"><button type="button" class="btn small ghost icon-only" data-action="jn-undo" aria-label="${esc(t.undo)}" title="${esc(t.undo)}"${ui.undo.length === 0 ? ' disabled' : ''}>${icon('undo')}</button><button type="button" class="btn small ghost icon-only jn-redo" data-action="jn-redo" aria-label="${esc(t.redo)}" title="${esc(t.redo)}"${ui.redo.length === 0 ? ' disabled' : ''}>${icon('undo')}</button></span>`
    : '';
  const view =
    journey.mode === 'DIAGRAM'
      ? `<span class="jn-grp jn-view"><button type="button" class="btn small ghost icon-only" data-action="jn-fit" aria-label="${esc(t.fit)}" title="${esc(t.fit)}">${icon('maximize')}</button><button type="button" class="btn small ghost icon-only" data-action="jn-zoom" data-step="-1" aria-label="${esc(t.zoomOut)}" title="${esc(t.zoomOut)}">−</button><button type="button" class="btn small ghost jn-zoom" data-action="jn-actual" title="${esc(t.actual)}" aria-live="polite">${String(Math.round(ui.zoom * 100))} %</button><button type="button" class="btn small ghost icon-only" data-action="jn-zoom" data-step="1" aria-label="${esc(t.zoomIn)}" title="${esc(t.zoomIn)}">+</button></span>`
      : '';
  const wide = state.lib.wide === true;
  return `<div class="jn-modebar"><span class="jn-modebar-l">${esc(t.displayMode)}</span>${modes}<span class="jn-modebar-r">${history}${view}<button type="button" class="btn small ghost icon-only" data-action="jn-wide" aria-pressed="${String(wide)}" aria-label="${esc(wide ? t.narrow : t.wide)}" title="${esc(wide ? t.narrow : t.wide)}">${icon(wide ? 'minimize' : 'maximize')}</button></span></div>`;
}

/** Les catégories du catalogue : les origines réelles des blocs (jamais une liste inventée). */
function categoryOf(t: Text, block: LibraryBlockView): string {
  return block.origin?.journey ?? block.origin?.name ?? t.originNone;
}

function palette(state: DashboardState, publish: boolean): string {
  const t = journeyText(state);
  const ui = state.lib.journey;
  const blocks = state.lib.blocks ?? [];
  const query = ui.paletteQuery.trim().toLowerCase();
  const categories = [...new Set(blocks.map((block) => categoryOf(t, block)))].sort((a, b) =>
    a.localeCompare(b),
  );
  const category = categories.includes(ui.category) ? ui.category : '';
  const shown = blocks.filter(
    (block) =>
      (!category || categoryOf(t, block) === category) &&
      (!query ||
        block.name.toLowerCase().includes(query) ||
        (block.description ?? '').toLowerCase().includes(query)),
  );
  const groups = new Map<string, LibraryBlockView[]>();
  for (const block of shown) {
    const title = categoryOf(t, block);
    groups.set(title, [...(groups.get(title) ?? []), block]);
  }
  const item = (block: LibraryBlockView): string => {
    const picked = ui.picked === block.name;
    return `<li class="jn-pal-item${picked ? ' picked' : ''}${block.state === 'VALID' ? '' : ` ${block.state === 'INVALID' ? 'ko' : 'warn'}`}" draggable="${String(publish)}" data-jn-block="${esc(block.name)}"><button type="button" class="jn-pal-pick" data-action="jn-pick" data-block="${esc(block.name)}" aria-pressed="${String(picked)}" title="${esc(`${block.name} · ${t.version(block.version)} · ${t.steps(block.steps)}`)}"><span class="jn-pal-ic" aria-hidden="true">${icon('cube')}</span><span class="jn-pal-t"><b>${esc(block.name)}</b></span><small class="mu jn-pal-v">${esc(t.version(block.version))}</small></button>${publish ? `<button type="button" class="btn small ghost icon-only" data-action="jn-add" data-block="${esc(block.name)}" aria-label="${esc(t.addToJourney(block.name))}" title="${esc(t.addToJourney(block.name))}">${icon('plus')}</button>` : ''}</li>`;
  };
  const body =
    blocks.length === 0
      ? `<p class="mu">${esc(t.paletteNoBlocks)}</p>`
      : shown.length === 0
        ? `<p class="mu">${esc(t.paletteEmpty)}</p>`
        : [...groups.entries()]
            .map(
              ([title, entries]) =>
                `<details class="jn-pal-g"${ui.paletteClosed.includes(title) ? '' : ' open'}><summary data-action="jn-group" data-group="${esc(title)}"><span>${esc(title)}</span> <small class="mu">(${String(entries.length)})</small></summary><ul class="plain jn-pal-list">${entries.map(item).join('')}</ul></details>`,
            )
            .join('');
  const filter =
    categories.length > 1
      ? `<label class="jn-pal-cat"><span class="sr">${esc(t.category)}</span><select data-jn="category" aria-label="${esc(t.category)}"><option value="">${esc(t.allBlocks)}</option>${categories.map((entry) => `<option value="${esc(entry)}"${entry === category ? ' selected' : ''}>${esc(entry)}</option>`).join('')}</select></label>`
      : '';
  const picked = ui.picked && blocks.some((block) => block.name === ui.picked) ? ui.picked : undefined;
  return `<aside class="jn-palette" aria-labelledby="jn-pal-t"><h3 id="jn-pal-t">${esc(t.paletteTitle)}</h3><label class="lib-search jn-pal-search">${icon('search')}<span class="sr">${esc(t.paletteSearch)}</span><input type="search" data-jn="palette" value="${esc(ui.paletteQuery)}" placeholder="${esc(t.paletteSearchShort)}" autocomplete="off"></label>${filter}<div class="jn-pal-body">${body}</div><small class="mu jn-pal-hint">${esc(picked && publish ? t.picked(picked) : t.dragHint)}</small></aside>`;
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
      return `${gap(index)}<li class="jn-card${selected ? ' sel' : ''}${tone}" data-jn-node="${esc(node.id)}" draggable="${String(publish)}"><span class="jn-num" aria-hidden="true">${String(index + 1)}</span><div class="jn-card-box"><span class="jn-grip" title="${esc(t.grip)}" aria-hidden="true">${icon('grip')}</span><button type="button" class="jn-card-b" data-action="jn-select" data-node="${esc(node.id)}" aria-pressed="${String(selected)}"><span class="jn-card-h"><span class="jn-ic" aria-hidden="true">${icon('cube')}</span><span class="jn-card-t"><b>${esc(node.block ?? '?')}</b><small class="mu">${block ? `${esc(t.version(node.version ?? block.version))} · ${esc(t.steps(block.steps))}` : esc(t.unknownBlock)}</small></span>${block ? `<span class="jn-compat ${versionMismatch ? 'warn' : block.state === 'VALID' ? 'ok' : block.state === 'INVALID' ? 'ko' : 'warn'}">${esc(versionMismatch ? t.newVersion(block.version) : (t.compat[block.state] ?? block.state))}</span>` : ''}</span>${io ? `<span class="jn-ios">${io}</span>` : ''}${diag.errors.length > 0 ? `<span class="jn-err">${icon('alert')}${esc(diag.errors[0] ?? '')}${diag.errors.length > 1 ? ` (+${String(diag.errors.length - 1)})` : ''}</span>` : ''}</button>${
        publish
          ? `<span class="jn-card-a"><button type="button" class="btn small ghost icon-only" data-action="jn-move" data-node="${esc(node.id)}" data-to="${String(index - 1)}" aria-label="${esc(`${t.moveUp} : ${node.block ?? ''}`)}" title="${esc(t.moveUp)}"${index === 0 ? ' disabled' : ''}>${icon('up')}</button><button type="button" class="btn small ghost icon-only" data-action="jn-move" data-node="${esc(node.id)}" data-to="${String(index + 1)}" aria-label="${esc(`${t.moveDown} : ${node.block ?? ''}`)}" title="${esc(t.moveDown)}"${last ? ' disabled' : ''}>${icon('down')}</button><button type="button" class="btn small ghost icon-only" data-action="jn-duplicate" data-node="${esc(node.id)}" aria-label="${esc(`${t.duplicate} : ${node.block ?? ''}`)}" title="${esc(t.duplicate)}">${icon('copy')}</button><button type="button" class="btn small ghost icon-only" data-action="jn-remove" data-node="${esc(node.id)}" aria-label="${esc(`${t.remove} : ${node.block ?? ''}`)}" title="${esc(t.remove)}">${icon('trash')}</button></span>`
          : ''
      }</div></li>`;
    })
    .join('');
  const addHere = publish
    ? `<li class="jn-add-here"><button type="button" class="btn jn-add-here-b" data-action="jn-focus-palette">${icon('plus')}<span>${esc(t.addHere)}</span></button></li>`
    : '';
  return `<ol class="plain jn-line" aria-label="${esc(t.modes.LINEAR)}"><li class="jn-term start">${icon('play')}<span>${esc(t.start)}</span></li>${order.blocks.length === 0 ? `${gap(0)}<li class="jn-empty mu">${esc(t.linearEmpty)}</li>` : `${cards}${gap(order.blocks.length)}`}${addHere}<li class="jn-term end">${icon('stop')}<span>${esc(t.end)}</span></li></ol>`;
}

/** La barre d'actions d'un nœud choisi dans le diagramme : Modifier, Dupliquer, Supprimer, plus. */
function floatingBar(state: DashboardState, node: JourneyNode): string {
  const t = journeyText(state);
  const block = node.kind === 'BLOCK' ? blockOf(state, node.block) : undefined;
  const name = node.kind === 'BLOCK' ? (node.block ?? '') : nodeLabel(t, node);
  const newer =
    block && node.version !== undefined && node.version !== block.version ? block.version : undefined;
  const more = `<details class="jn-more"><summary class="btn small ghost icon-only" aria-label="${esc(t.more)}" title="${esc(t.more)}">${icon('more')}</summary><div class="jn-more-m" role="menu">${node.kind === 'BLOCK' && node.block ? `<button type="button" role="menuitem" data-action="lib-open" data-block="${esc(node.block)}">${icon('library')}<span>${esc(t.openSheet)}</span></button>` : ''}${newer !== undefined ? `<button type="button" role="menuitem" data-action="jn-accept-version" data-node="${esc(node.id)}" data-version="${String(newer)}">${icon('refresh')}<span>${esc(t.newVersion(newer))}</span></button>` : ''}<button type="button" role="menuitem" data-action="jn-deselect">${icon('close')}<span>${esc(t.deselect)}</span></button></div></details>`;
  return `<div class="jn-float" role="toolbar" aria-label="${esc(name)}"><button type="button" class="btn small ghost icon-only" data-action="jn-edit" data-node="${esc(node.id)}" aria-label="${esc(`${t.edit} : ${name}`)}" title="${esc(t.edit)}">${icon('edit')}</button>${node.kind === 'BLOCK' ? `<button type="button" class="btn small ghost icon-only" data-action="jn-duplicate" data-node="${esc(node.id)}" aria-label="${esc(`${t.duplicate} : ${name}`)}" title="${esc(t.duplicate)}">${icon('copy')}</button>` : ''}${node.kind === 'START' ? '' : `<button type="button" class="btn small ghost icon-only danger" data-action="jn-remove" data-node="${esc(node.id)}" aria-label="${esc(`${t.remove} : ${name}`)}" title="${esc(t.remove)}">${icon('trash')}</button>`}${more}</div>`;
}

function nodeLabel(t: Text, node: JourneyNode): string {
  return node.kind === 'BLOCK'
    ? (node.block ?? '?')
    : node.kind === 'CONDITION'
      ? node.label?.trim()
        ? node.label
        : t.conditionEmpty
      : node.kind === 'START'
        ? t.start
        : node.kind === 'END'
          ? t.end
          : t.join;
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
  const entry = node.kind === 'START' ? '' : '<span class="jn-in" aria-hidden="true"></span>';
  const block = blockOf(state, node.block);
  const inner =
    node.kind === 'BLOCK'
      ? `<span class="jn-ic" aria-hidden="true">${icon('cube')}</span><span class="jn-n-t"><b>${esc(node.block ?? '?')}</b><small class="mu">${block ? esc(t.version(node.version ?? block.version)) : esc(t.unknownBlock)}</small></span>`
      : node.kind === 'CONDITION'
        ? `<svg class="jn-dia" viewBox="0 0 ${String(size.w)} ${String(size.h)}" preserveAspectRatio="none" aria-hidden="true"><polygon points="${String(size.w / 2)},2 ${String(size.w - 2)},${String(size.h / 2)} ${String(size.w / 2)},${String(size.h - 2)} 2,${String(size.h / 2)}"></polygon></svg><span class="jn-n-q" aria-hidden="true">?</span><b class="jn-n-l">${esc(nodeLabel(t, node))}</b>`
        : `${icon(node.kind === 'START' ? 'play' : node.kind === 'END' ? 'stop' : 'merge')}<b>${esc(nodeLabel(t, node))}</b>`;
  const badge =
    diag.errors.length > 0
      ? `<span class="jn-badge ko" title="${esc(diag.errors.join(' · '))}">${String(diag.errors.length)}<span class="sr">${esc(diag.errors.join(' · '))}</span></span>`
      : diag.warnings.length > 0
        ? `<span class="jn-badge warn" title="${esc(diag.warnings.join(' · '))}">!<span class="sr">${esc(diag.warnings.join(' · '))}</span></span>`
        : '';
  const linking = ui.tool === 'connect' && ui.connectFrom === node.id ? ' link-from' : '';
  return `<div class="jn-node ${node.kind.toLowerCase()}${selected ? ' sel' : ''}${tone}${linking}" data-jn-node="${esc(node.id)}" style="${style}" role="button" tabindex="0" data-action="jn-select" data-node="${esc(node.id)}" aria-pressed="${String(selected)}" title="${esc(node.kind === 'BLOCK' && block ? `${node.block ?? ''} · ${t.steps(block.steps)}` : nodeLabel(t, node))}" aria-label="${esc(nodeLabel(t, node))}">${inner}${badge}${entry}${ports}${selected && publish ? floatingBar(state, node) : ''}</div>`;
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
  const points = edgePoints(from, to, edge.branch);
  const d = pointsPath(points);
  const selected = ui.selected?.kind === 'edge' && ui.selected.id === edge.id;
  const errors = freshCheck(ui)?.edges[edge.id] ?? [];
  const tone = errors.length > 0 ? ' ko' : edge.branch === 'YES' ? ' yes' : edge.branch === 'NO' ? ' no' : '';
  // L'étiquette Oui / Non : sur le premier coude, là où la branche quitte la condition.
  const at = points[1] ?? points[0] ?? { x: 0, y: 0 };
  const label = edge.branch
    ? `<g class="jn-pill ${edge.branch === 'YES' ? 'yes' : 'no'}"><rect x="${String(at.x - 17)}" y="${String(at.y + 8)}" width="34" height="18" rx="4"></rect><text x="${String(at.x)}" y="${String(at.y + 21)}" text-anchor="middle">${esc(edge.branch === 'YES' ? t.yes : t.no)}</text></g>`
    : '';
  const pending = ui.pendingInsert?.edge === edge.id ? ' drop' : '';
  return `<g class="jn-edge${selected ? ' sel' : ''}${tone}${pending}" data-jn-edge="${esc(edge.id)}"><path class="jn-e" d="${d}" marker-end="url(#jn-arrow)"></path><path class="jn-hit" d="${d}" data-action="jn-select-edge" data-edge="${esc(edge.id)}"><title>${esc(errors.join(' · ') || t.edgeTitle)}</title></path>${label}</g>`;
}

/** La barre d'outils verticale du diagramme : chaque outil agit réellement sur le parcours. */
function canvasTools(state: DashboardState, publish: boolean): string {
  if (!publish) return '';
  const t = journeyText(state);
  const ui = state.lib.journey;
  const picked =
    ui.picked && (state.lib.blocks ?? []).some((block) => block.name === ui.picked) ? ui.picked : undefined;
  const selected = ui.selected;
  const deletable =
    selected?.kind === 'edge' ||
    (selected?.kind === 'node' &&
      ui.journey.graph.nodes.some((node) => node.id === selected.id && node.kind !== 'START'));
  const tool = (attrs: string, label: string, ico: string, pressed?: boolean, disabled = false): string =>
    `<button type="button" class="jn-tool" ${attrs} aria-label="${esc(label)}" title="${esc(label)}"${pressed === undefined ? '' : ` aria-pressed="${String(pressed)}"`}${disabled ? ' disabled' : ''}>${icon(ico)}</button>`;
  return `<div class="jn-tools-v" role="toolbar" aria-label="${esc(t.toolsLabel)}" aria-orientation="vertical">${tool('data-action="jn-tool" data-tool="select"', t.toolSelect, 'pointer', ui.tool === 'select')}${tool('data-action="jn-tool-block"', picked ? `${t.toolBlock} : ${picked}` : t.toolBlockNone, 'cube', undefined, !picked)}${(
    ['CONDITION', 'JOIN', 'END'] as const
  )
    .map((kind) =>
      tool(
        `data-action="jn-shape" data-kind="${kind}" data-jn-shape="${kind}" draggable="true"`,
        t.shapes[kind] ?? kind,
        kind === 'CONDITION' ? 'diamond' : kind === 'JOIN' ? 'merge' : 'stop',
      ),
    )
    .join(
      '',
    )}${tool('data-action="jn-tool" data-tool="connect"', t.toolConnect, 'link', ui.tool === 'connect')}${tool('data-action="jn-delete-selection" class="danger"', t.toolDelete, 'trash', undefined, !deletable)}</div>`;
}

function diagramView(state: DashboardState, publish: boolean): string {
  const t = journeyText(state);
  const ui = state.lib.journey;
  const graph = ui.journey.graph;
  const box = bounds(graph);
  const pad = 400;
  const svg = `<svg class="jn-edges" style="left:${String(box.minX - pad)}px;top:${String(box.minY - pad)}px" width="${String(box.maxX - box.minX + pad * 2)}" height="${String(box.maxY - box.minY + pad * 2)}" viewBox="${String(box.minX - pad)} ${String(box.minY - pad)} ${String(box.maxX - box.minX + pad * 2)} ${String(box.maxY - box.minY + pad * 2)}" aria-hidden="false"><defs><marker id="jn-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z"></path></marker></defs>${graph.edges.map((edge) => edgeHtml(state, edge)).join('')}<path class="jn-temp" d=""></path></svg>`;
  const from = ui.connectFrom ? graph.nodes.find((node) => node.id === ui.connectFrom) : undefined;
  const hint =
    ui.tool === 'connect' ? (from ? t.connectPickTo(nodeLabel(t, from)) : t.connectPickFrom) : t.canvasHint;
  const pending = ui.pendingInsert;
  const edge = pending ? graph.edges.find((entry) => entry.id === pending.edge) : undefined;
  const ends = edge
    ? [graph.nodes.find((node) => node.id === edge.from), graph.nodes.find((node) => node.id === edge.to)]
    : [];
  const placed = pending ? graph.nodes.find((node) => node.id === pending.node) : undefined;
  const insert =
    pending && edge && placed && ends[0] && ends[1]
      ? `<div class="jn-insert" role="group"><p>${esc(t.insertOnEdge(placed.block ?? '', nodeLabel(t, ends[0]), nodeLabel(t, ends[1])))}</p><button type="button" class="btn small primary" data-action="jn-insert-yes">${esc(t.insertYes)}</button><button type="button" class="btn small ghost" data-action="jn-insert-no">${esc(t.insertNo)}</button></div>`
      : '';
  return `<div class="jn-canvas${ui.tool === 'connect' ? ' connecting' : ''}" data-jn-canvas tabindex="0" role="application" aria-label="${esc(t.canvasLabel)}" aria-describedby="jn-canvas-h">${canvasTools(state, publish)}<div class="jn-world" style="transform:translate(${String(ui.panX)}px,${String(ui.panY)}px) scale(${String(ui.zoom)})">${svg}${graph.nodes.map((node) => nodeHtml(state, node, publish)).join('')}</div>${insert}<small id="jn-canvas-h" class="jn-hint mu" aria-live="polite">${esc(hint)}</small></div>`;
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
  const newer =
    block && node.version !== undefined && node.version !== block.version ? block.version : undefined;
  const io = `<dl class="jn-dl"><dt>${esc(t.ioRequired)}</dt><dd>${chips(
    inputs.filter((input) => input.required).map((input) => input.key),
    t.none,
  )}</dd><dt>${esc(t.ioProduced)}</dt><dd>${chips(block?.contract.outputs.map((output) => output.key) ?? [], t.none)}</dd><dt>${esc(t.ioAvailable)}</dt><dd>${check ? chips(available, t.none) : `<small class="mu">${esc(t.notChecked)}</small>`}</dd><dt>${esc(t.ioMissing)}</dt><dd>${check ? chips([...new Set((diag?.missing ?? []).map((item) => `${item.key}${check.paths.length > 1 ? ` (${pathLetter(item.path - 1)})` : ''}`))], t.none, 'ko') : `<small class="mu">${esc(t.notChecked)}</small>`}</dd><dt>${esc(t.ioMapped)}</dt><dd>${[...mapped, ...satisfied].length > 0 ? `<ul class="plain tight">${[...mapped, ...satisfied].map((item) => `<li>${esc(item)}</li>`).join('')}</ul>` : `<small class="mu">${esc(t.none)}</small>`}</dd></dl>`;
  const versions = `<section class="jn-sec" aria-labelledby="jn-ver-t"><h4 id="jn-ver-t">${esc(t.versions)}</h4><dl class="jn-dl"><dt>${esc(t.versionUsed)}</dt><dd>${esc(node.version !== undefined ? t.version(node.version) : '—')}</dd><dt>${esc(t.versionCurrent)}</dt><dd>${block ? `${esc(t.version(block.version))} <span class="jn-compat ${block.state === 'VALID' ? 'ok' : block.state === 'INVALID' ? 'ko' : 'warn'}">${esc(t.compat[block.state] ?? block.state)}</span>` : esc(t.unknownBlock)}</dd><dt>${esc(t.fingerprint)}</dt><dd><code>${esc(block?.hash.slice(0, 12) ?? '—')}</code></dd></dl><small class="mu">${esc(t.versionNote)}</small></section>`;
  const actions = publish
    ? `<div class="form-acts start"><button type="button" class="btn small" data-action="jn-duplicate" data-node="${esc(node.id)}">${icon('copy')}<span>${esc(t.duplicate)}</span></button><button type="button" class="btn small ghost" data-action="jn-remove" data-node="${esc(node.id)}">${icon('trash')}<span>${esc(t.remove)}</span></button></div>`
    : '';
  const tabs = (['params', 'io', 'details'] as const)
    .map(
      (tab) =>
        `<button type="button" role="tab" id="jn-pt-${tab}" class="jn-ptab" data-action="jn-props-tab" data-tab="${tab}" aria-selected="${String(ui.propsTab === tab)}" aria-controls="jn-pp-${tab}"${ui.propsTab === tab ? '' : ' tabindex="-1"'}>${esc(tab === 'params' ? t.tabParams : tab === 'io' ? t.tabIo : t.tabDetails)}</button>`,
    )
    .join('');
  const panel = (tab: 'params' | 'io' | 'details', body: string): string =>
    `<div class="jn-ppanel" role="tabpanel" id="jn-pp-${tab}" aria-labelledby="jn-pt-${tab}"${ui.propsTab === tab ? '' : ' hidden'}>${body}</div>`;
  return `<div class="jn-props-h"><span class="jn-ic" aria-hidden="true">${icon('cube')}</span><div class="jn-props-n"><h3 id="jn-props-t">${esc(node.block ?? '?')}</h3>${block?.description ? `<p class="mu">${esc(block.description)}</p>` : ''}</div><span class="jn-ver">${esc(node.version !== undefined ? t.version(node.version) : '—')}</span>${node.block && blockOf(state, node.block) ? `<button type="button" class="btn small ghost icon-only" data-action="lib-open" data-block="${esc(node.block)}" aria-label="${esc(t.openSheet)}" title="${esc(t.openSheet)}">${icon('edit')}</button>` : ''}</div>${newer !== undefined && publish ? `<button type="button" class="btn small primary jn-accept" data-action="jn-accept-version" data-node="${esc(node.id)}" data-version="${String(newer)}">${esc(t.newVersion(newer))}</button>` : ''}<div class="jn-ptabs" role="tablist" aria-label="${esc(t.propsBlock)}">${tabs}</div>${panel('params', paramRows)}${panel('io', io)}${panel('details', `${versions}<section class="jn-sec" aria-labelledby="jn-dg-t"><h4 id="jn-dg-t">${esc(t.diagnostics)}</h4>${diagList(t, diag, check !== undefined)}</section>${ui.journey.mode === 'DIAGRAM' ? connectForm(state, node, publish) : ''}${actions}`)}`;
}

/** Le parcours lui-même (rien n'est choisi) : description, sorties, conditions, versions, réutilisation. */
function journeyProps(state: DashboardState, publish: boolean): string {
  const t = journeyText(state);
  const ui = state.lib.journey;
  const journey = ui.journey;
  const check = freshCheck(ui);
  const conditions = journey.graph.nodes.filter((node) => node.kind === 'CONDITION');
  const blocks = journey.graph.nodes.filter((node) => node.kind === 'BLOCK');
  const outputsCount = check ? check.outputs.guaranteed.length + check.outputs.partial.length : undefined;
  const acc = (title: string, count: number | undefined, body: string, open = false): string =>
    `<details class="jn-acc"${open ? ' open' : ''}><summary>${esc(title)}${count === undefined ? '' : ` <small class="mu">(${String(count)})</small>`}</summary><div class="jn-acc-b">${body}</div></details>`;
  const versions =
    blocks.length === 0
      ? `<p class="mu">${esc(t.none)}</p>`
      : `<ul class="plain tight jn-vers">${blocks
          .map((node) => {
            const block = blockOf(state, node.block);
            const ok = block !== undefined && node.version === block.version && block.state === 'VALID';
            return `<li class="${ok ? 'ok' : 'warn'}">${icon(ok ? 'check' : 'alert')}<span>${esc(node.block ?? '?')} · ${esc(node.version !== undefined ? t.version(node.version) : '—')}${block && node.version !== block.version ? ` → ${esc(t.version(block.version))}` : ''}</span></li>`;
          })
          .join('')}</ul>`;
  return `<div class="jn-props-h"><span class="jn-ic" aria-hidden="true">${icon('merge')}</span><div class="jn-props-n"><h3 id="jn-props-t">${esc(t.propsJourney)}</h3><p class="mu">${esc(t.propsNone)}</p></div></div><label class="field"><span>${esc(t.description)}</span><textarea data-jn="description" rows="2" maxlength="500"${publish ? '' : ' disabled'}>${esc(journey.description ?? '')}</textarea></label>${journey.published && journey.published.length > 0 ? `<p class="mu">${esc(t.published(journey.published.join(', ')))}</p>` : ''}${acc(t.outputsTitle, outputsCount, outputsSection(state, check), true)}${acc(
    t.conditionsTitle,
    conditions.length,
    conditions.length === 0
      ? `<p class="mu">${esc(t.noCondition)}</p>`
      : `<ul class="plain tight">${conditions.map((node) => `<li><button type="button" class="link" data-action="jn-select" data-node="${esc(node.id)}">${esc(nodeLabel(t, node))}</button></li>`).join('')}</ul>`,
  )}${acc(t.versionsDeps, blocks.length, versions)}${publish ? toBlockSection(state, check) : ''}`;
}

/** L'onglet Diagnostics : la vérification complète, chemin par chemin, et les problèmes de chaque nœud. */
export function journeyDiagnostics(state: DashboardState): string {
  const t = journeyText(state);
  const ui = state.lib.journey;
  const check = freshCheck(ui);
  const graph = ui.journey.graph;
  if (!check)
    return `<section class="jn-diagtab" aria-labelledby="jn-chk-t"><h3 id="jn-chk-t">${esc(t.checkTitle)}</h3><p class="mu">${esc(ui.checking ? t.checking : t.notChecked)}</p></section>`;
  const paths = `<p class="mu">${esc(t.paths(check.paths.length))}${check.linear ? ` · ${esc(t.linearYes)}` : ''}</p><ul class="plain jn-paths">${check.paths
    .map(
      (entry) =>
        `<li class="${entry.check.ok ? 'ok' : 'ko'}"><b>${esc(t.pathLabel(pathLetter(entry.index)))}</b> <span class="jn-chip ${entry.check.ok ? 'ok' : 'ko'}">${esc(entry.check.ok ? t.pathOk : t.pathKo)}</span>${entry.choices.length > 0 ? `<small class="mu block">${esc(entry.choices.map((choice) => `${choice.label} = ${choice.branch === 'YES' ? t.yes : t.no}`).join(' · '))}</small>` : ''}<small class="mu block">${esc(entry.check.order.map((item) => item.block).join(' → ') || '—')}</small></li>`,
    )
    .join(
      '',
    )}</ul><p class="mu">${esc(check.publishable === 'PER_PATH' ? t.publishInfoPaths : t.publishInfoSingle)}</p>`;
  const global = `${check.errors.length > 0 ? `<ul class="plain jn-diag">${check.errors.map((item) => `<li class="ko">${icon('alert')}<span>${esc(item)}</span></li>`).join('')}</ul>` : ''}${check.warnings.length > 0 ? `<ul class="plain jn-diag">${check.warnings.map((item) => `<li class="warn">${icon('info')}<span>${esc(item)}</span></li>`).join('')}</ul>` : ''}`;
  const perNode = graph.nodes
    .map((node) => ({ node, diag: check.nodes[node.id] }))
    .filter(({ diag }) => diag && (diag.errors.length > 0 || diag.warnings.length > 0))
    .map(
      ({ node, diag }) =>
        `<li><button type="button" class="link" data-action="jn-select" data-node="${esc(node.id)}">${esc(nodeLabel(t, node))}</button>${diagList(t, diag, true)}</li>`,
    )
    .join('');
  return `<section class="jn-diagtab" aria-labelledby="jn-chk-t"><h3 id="jn-chk-t">${esc(t.checkTitle)}</h3>${paths}${global}${perNode ? `<ul class="plain jn-pernode">${perNode}</ul>` : ''}</section>`;
}

/** Les sorties du parcours : garanties (tous les chemins) et partielles (certains chemins, nommés). */
function outputsSection(state: DashboardState, check: JourneyCheck | undefined): string {
  const t = journeyText(state);
  const ui = state.lib.journey;
  const body = !check
    ? `<p class="mu">${esc(ui.checking ? t.checking : t.notChecked)}</p>`
    : check.outputs.guaranteed.length === 0 && check.outputs.partial.length === 0
      ? `<p class="mu">${esc(t.outputsNone)}</p>`
      : `<dl class="jn-dl jn-out"><dt>${esc(t.outputsGuaranteed)}</dt><dd>${check.outputs.guaranteed.length > 0 ? check.outputs.guaranteed.map((key) => `<code class="lib-key">${esc(key)}</code>`).join('') : `<small class="mu">${esc(t.none)}</small>`}</dd>${
          check.outputs.partial.length > 0
            ? `<dt>${esc(t.outputsPartial)}</dt><dd><ul class="plain tight jn-out-partial">${check.outputs.partial
                .map(
                  (item) =>
                    `<li><code class="lib-key warn">${esc(item.key)}</code> <small class="mu">${esc(t.outputsOnly(item.paths.map((path) => pathLetter(path - 1)).join(', ')))}</small></li>`,
                )
                .join('')}</ul></dd>`
            : ''
        }</dl>`;
  return `<section class="jn-sec jn-outputs" aria-labelledby="jn-out-t"><h4 id="jn-out-t">${esc(t.outputsTitle)}</h4>${body}</section>`;
}

/** Réutiliser le parcours comme un bloc : seulement valide, enregistré, sans condition. */
function toBlockSection(state: DashboardState, check: JourneyCheck | undefined): string {
  const t = journeyText(state);
  const ui = state.lib.journey;
  const busy = Boolean(ui.saving || ui.publishing || ui.checking || ui.converting);
  const ready =
    check?.ok === true && check.publishable === 'SINGLE' && !ui.dirty && ui.savedName !== undefined;
  const reason =
    check?.publishable === 'PER_PATH'
      ? t.toBlockPaths
      : ui.dirty || !ui.savedName
        ? t.saveFirst
        : t.checkFirst;
  const form =
    ui.blockName !== undefined && ready
      ? `<div class="jn-toblock" role="group" aria-labelledby="jn-blk-t"><label class="field"><span>${esc(t.toBlockName)}</span><input data-jn="blockName" value="${esc(ui.blockName)}" maxlength="80" autocomplete="off"></label><div class="form-acts start"><button type="button" class="btn small primary" data-action="jn-to-block-confirm"${busy ? ' disabled' : ''} aria-busy="${String(Boolean(ui.converting))}">${icon('library')}<span>${esc(ui.converting ? t.toBlockBusy : t.toBlockConfirm)}</span></button><button type="button" class="btn small ghost" data-action="jn-to-block-cancel">${esc(t.cancel)}</button></div></div>`
      : `<button type="button" class="btn small" data-action="jn-to-block"${ready && !busy ? '' : ' disabled'} title="${esc(ready ? t.toBlockInfo : reason)}">${icon('library')}<span>${esc(t.toBlock)}</span></button>${ready ? '' : `<small class="mu block">${esc(reason)}</small>`}`;
  return `<section class="jn-sec" aria-labelledby="jn-blk-t"><h4 id="jn-blk-t">${esc(t.toBlockTitle)}</h4><p class="mu">${esc(t.toBlockInfo)}</p>${form}</section>`;
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

/** Le résultat de la vérification, en quatre points tirés de la vraie vérification (jamais présumés). */
function validationCard(state: DashboardState): string {
  const t = journeyText(state);
  const ui = state.lib.journey;
  const check = freshCheck(ui);
  const title = `<h3 id="jn-val-t">${esc(t.validationTitle)}</h3>`;
  if (!check)
    return `<section class="jn-valid" aria-labelledby="jn-val-t">${title}<p class="jn-val-state ${ui.checking ? 'live' : ''}" role="status">${ui.checking ? '<span class="spin" aria-hidden="true"></span>' : icon('info')}<span>${esc(ui.checking ? t.checking : ui.check ? t.status.stale : t.validNot)}</span></p></section>`;
  const graph = ui.journey.graph;
  const structure = journeyStructure(graph);
  const counts = {
    structure:
      structure.errors.length +
      Object.values(structure.nodes).reduce((sum, list) => sum + list.length, 0) +
      Object.values(structure.edges).reduce((sum, list) => sum + list.length, 0),
    deps: Object.values(check.nodes).reduce((sum, diag) => sum + diag.missing.length, 0),
    conflicts: check.paths.reduce((sum, path) => sum + path.check.conflicts.length, 0),
    versions: graph.nodes.filter((node) => {
      if (node.kind !== 'BLOCK') return false;
      const block = blockOf(state, node.block);
      return !block || node.version !== block.version || block.state !== 'VALID';
    }).length,
  };
  const items = (Object.keys(counts) as (keyof typeof counts)[])
    .map((key) => {
      const count = counts[key];
      return `<li class="${count === 0 ? 'ok' : 'ko'}">${icon(count === 0 ? 'check' : 'alert')}<span>${esc(t.validItems[key]?.[count === 0 ? 0 : 1] ?? key)}${count === 0 ? '' : ` <small>· ${esc(t.validIssues(count))}</small>`}</span></li>`;
    })
    .join('');
  return `<section class="jn-valid" aria-labelledby="jn-val-t">${title}<p class="jn-val-state ${check.ok ? 'ok' : 'ko'}" role="status">${icon(check.ok ? 'check' : 'alert')}<span>${esc(check.ok ? t.status.valid : t.status.invalid)}</span></p><ul class="plain jn-val-list">${items}</ul></section>`;
}

/** Le panneau droit : les propriétés de la sélection (ou du parcours), puis la validation du parcours. */
export function journeySide(state: DashboardState, publish: boolean): string {
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
  const kicker = node
    ? node.kind === 'BLOCK'
      ? t.propsBlock
      : t.propsShape
    : edge
      ? t.propsEdge
      : t.propsJourneyTitle;
  return `<aside class="jn-side" aria-label="${esc(kicker)}"><section class="jn-props" aria-labelledby="jn-props-t" aria-live="polite"><div class="jn-props-top"><p class="jn-props-k">${esc(kicker)}</p><button type="button" class="btn small ghost icon-only" data-action="jn-panel" data-panel="props" data-open="0" aria-label="${esc(t.propsHide)}" title="${esc(t.propsHide)}">${icon('close')}</button></div>${body}${selected ? `<button type="button" class="btn small ghost jn-back" data-action="jn-deselect">${icon('back')}<span>${esc(t.propsJourney)}</span></button>` : ''}</section>${validationCard(state)}</aside>`;
}

/** L'onglet Compositeur : en-tête du parcours, barre des modes, catalogue compact et scène. */
export function journeyComposer(state: DashboardState, publish: boolean): string {
  const t = journeyText(state);
  const ui = state.lib.journey;
  const stage = ui.journey.mode === 'LINEAR' ? linearView(state, publish) : diagramView(state, publish);
  const toast = ui.toast
    ? `<div class="jn-toast" role="status">${icon('check')}<span>${esc(ui.toast)}</span><button type="button" class="btn small ghost icon-only" data-action="jn-toast-close" aria-label="${esc(t.close)}" title="${esc(t.close)}">${icon('close')}</button></div>`
    : '';
  return `<div class="jn-composer" data-mode="${ui.journey.mode}">${journeyHead(state, publish)}${modeBar(state, publish)}<div class="jn-body">${palette(state, publish)}<div class="jn-stage${ui.toast ? ' has-toast' : ''}" data-jn-stage>${stage}${toast}</div></div></div>`;
}

// ── Styles ───────────────────────────────────────────────────────────────────────────────────

export const JOURNEY_CSS = `
.jn{--jn-sel:#2F6FED;--jn-sel-soft:color-mix(in srgb,#2F6FED 14%,transparent);--jn-node-bg:color-mix(in srgb,var(--qa-color-primary) 7%,var(--qa-color-surface));--jn-node-bd:color-mix(in srgb,var(--qa-color-primary) 55%,var(--qa-color-border));--jn-cond-bg:color-mix(in srgb,var(--qa-color-warning) 10%,var(--qa-color-surface));--jn-cond-bd:color-mix(in srgb,var(--qa-color-warning) 70%,var(--qa-color-border));--jn-no:#B4233A;--jn-no-bg:color-mix(in srgb,#B4233A 12%,var(--qa-color-surface));--jn-edge:color-mix(in srgb,var(--qa-color-text) 62%,var(--qa-color-surface));display:flex;flex-direction:column;gap:10px;min-width:0}
/* Barre de tête : critères du catalogue à gauche, actions du parcours à droite. */
.lib-top{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px}
.lib-top .lib-bar{flex:1 1 640px;min-width:0;padding:6px 8px}
.jn-acts{display:flex;flex-wrap:wrap;gap:8px;margin-left:auto}
/* Les quatre zones : récents, onglets (catalogue / compositeur / diagnostics), propriétés. */
.lib-shell{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:12px;align-items:start;min-width:0}
.lib-recent-col{width:200px;display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid var(--qa-color-border);border-radius:12px;background:var(--qa-color-surface);max-height:calc(100vh - 230px);overflow:auto;min-width:0}
.lib-col-h{display:flex;align-items:center;justify-content:space-between;gap:6px}
.lib-col-h h3{margin:0;font-size:13.5px}
.lib-recent-col .lib-recent{display:flex;flex-wrap:wrap;gap:6px}
.lib-recent-col .lib-cards.mini{display:flex;flex-direction:column;gap:8px}
.lib-recent-col .lib-cards.mini .lib-card{padding:10px;font-size:12.5px}
.lib-rail{display:none;width:34px;padding:8px 0;justify-content:center;align-items:flex-start;border:1px solid var(--qa-color-border);border-radius:12px;background:var(--qa-color-surface);align-self:stretch}
.lib-shell.recent-closed .lib-recent-col{display:none}
.lib-shell.recent-closed .lib-rail.recent{display:flex}
.lib-shell.props-closed .lib-rail.props{display:flex}
.lib-main{min-width:0;display:flex;flex-direction:column;border:1px solid var(--qa-color-border);border-radius:12px;background:var(--qa-color-surface);overflow:hidden}
.lib-tabs{display:flex;gap:2px;padding:0 10px;border-bottom:1px solid var(--qa-color-border);background:var(--qa-color-surface-2);overflow-x:auto}
.lib-tab{display:inline-flex;align-items:center;gap:7px;padding:10px 14px;border:0;border-bottom:2px solid transparent;background:none;font:inherit;font-size:13.5px;font-weight:600;color:var(--qa-color-muted);cursor:pointer;white-space:nowrap}
.lib-tab .ico{width:15px;height:15px}
.lib-tab[aria-selected="true"]{color:var(--qa-color-primary-2);border-bottom-color:var(--qa-color-primary)}
.lib-tab:hover{color:var(--qa-color-text)}
.lib-tabpanel{padding:12px;min-width:0}
.lib-tabpanel .lib-catalog .lib-cards.grid{max-height:none}
/* Le compositeur. */
.jn-composer{display:flex;flex-direction:column;gap:10px;min-width:0}
.jn-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px}
.jn-head-ic{width:30px;height:30px;border-radius:8px;display:grid;place-items:center;background:var(--qa-color-primary-soft);color:var(--qa-color-primary)}
.jn-head-ic .ico{width:17px;height:17px}
.jn-title{flex:1 1 220px;min-width:160px;max-width:420px}
.jn-title input{width:100%;font:inherit;font-size:17px;font-weight:700;color:var(--qa-color-text);border:1px solid transparent;border-radius:8px;padding:4px 8px;background:transparent}
.jn-title input:hover{border-color:var(--qa-color-border)}
.jn-title input:focus{border-color:var(--qa-color-primary);outline:none;background:var(--qa-color-surface)}
.jn-head-r{display:flex;flex-wrap:wrap;gap:6px;margin-left:auto;align-items:center}
.jn-open select{min-height:32px;max-width:240px;border-radius:8px;border:1px solid var(--qa-color-border-strong);background:var(--qa-color-surface);font:inherit;font-size:13px;padding:2px 8px}
.jn-chips{display:flex;flex-direction:row;flex-wrap:wrap;gap:6px}
.jn-chip{display:inline-flex;align-items:center;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600;border:1px solid var(--qa-color-border);background:var(--qa-color-surface-2);color:var(--qa-color-muted)}
.jn-chip.ok{color:var(--qa-color-primary-2);background:var(--qa-color-primary-soft);border-color:color-mix(in srgb,var(--qa-color-primary) 25%,var(--qa-color-border))}
.jn-chip.warn{color:color-mix(in srgb,var(--qa-color-warning) 75%,var(--qa-color-text));background:var(--qa-color-warning-soft);border-color:color-mix(in srgb,var(--qa-color-warning) 30%,var(--qa-color-border))}
.jn-chip.ko{color:var(--qa-color-danger);background:var(--qa-color-danger-soft);border-color:color-mix(in srgb,var(--qa-color-danger) 30%,var(--qa-color-border))}
.jn-chip.live{color:var(--qa-color-primary);background:var(--qa-color-surface)}
.jn-modebar{display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px}
.jn-modebar-l{font-size:13px;font-weight:600;color:var(--qa-color-text)}
.jn-modes{display:inline-flex;gap:8px}
.jn-modes .btn{display:inline-flex;align-items:center;gap:6px;min-height:34px}
.jn-modes .ico{width:15px;height:15px}
.jn-modebar-r{display:flex;flex-wrap:wrap;gap:8px;margin-left:auto;align-items:center}
.jn-grp{display:inline-flex;align-items:center;gap:2px;padding:2px;border:1px solid var(--qa-color-border);border-radius:8px;background:var(--qa-color-surface)}
.jn-zoom{min-width:58px;font-variant-numeric:tabular-nums}
.jn-redo .ico{transform:scaleX(-1)}
.jn-msg{display:flex;gap:6px;align-items:flex-start;margin:0;padding:8px 10px;border-radius:8px;font-size:13px}
.jn-msg.warn{background:var(--qa-color-warning-soft);color:color-mix(in srgb,var(--qa-color-warning) 70%,var(--qa-color-text))}
.jn-msg .ico{width:16px;height:16px;flex:none;margin-top:1px}
.jn-confirm{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--qa-color-border);border-radius:8px;background:var(--qa-color-surface-2)}
.jn-confirm.warn{border-color:color-mix(in srgb,var(--qa-color-warning) 35%,var(--qa-color-border));background:var(--qa-color-warning-soft)}
.jn-confirm p{margin:0;flex:1 1 260px}
.jn-body{display:grid;grid-template-columns:200px minmax(0,1fr);gap:12px;align-items:stretch;min-width:0}
/* Le catalogue compact. */
.jn-palette{border:1px solid var(--qa-color-border);border-radius:10px;background:var(--qa-color-surface);padding:10px;display:flex;flex-direction:column;gap:8px;min-width:0;height:var(--jn-h);overflow:hidden}
.jn-palette h3{margin:0;font-size:13.5px}
.jn-palette .jn-pal-search{display:flex;flex:none;height:32px}
.jn-pal-cat select{width:100%;min-height:32px;border-radius:8px;border:1px solid var(--qa-color-border-strong);background:var(--qa-color-surface);font:inherit;font-size:13px;padding:2px 8px}
.jn-pal-body{flex:1;overflow:auto;min-height:0;display:flex;flex-direction:column;gap:6px}
.jn-pal-g{border:1px solid var(--qa-color-border);border-radius:8px;background:var(--qa-color-surface);flex:none}
.jn-pal-g summary{cursor:pointer;font-size:13px;font-weight:700;padding:7px 9px;list-style:none;display:flex;align-items:center;gap:6px}
.jn-pal-g summary::-webkit-details-marker{display:none}
.jn-pal-g summary::before{content:"";width:6px;height:6px;border-right:2px solid var(--qa-color-muted);border-bottom:2px solid var(--qa-color-muted);transform:rotate(-45deg);transition:transform .15s}
.jn-pal-g[open] summary::before{transform:rotate(45deg)}
.jn-pal-g summary span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.jn-pal-list{display:flex;flex-direction:column;gap:2px;padding:0 4px 6px}
.jn-pal-item{display:flex;align-items:center;gap:2px;border:1px solid transparent;border-radius:7px;cursor:grab;min-width:0}
.jn-pal-item:hover{background:var(--qa-color-primary-soft)}
.jn-pal-item.picked{background:var(--qa-color-primary-soft);border-color:color-mix(in srgb,var(--qa-color-primary) 45%,var(--qa-color-border))}
.jn-pal-item.warn .jn-pal-ic{background:var(--qa-color-warning-soft);color:var(--qa-color-warning)}
.jn-pal-item.ko .jn-pal-ic{background:var(--qa-color-danger-soft);color:var(--qa-color-danger)}
.jn-pal-pick{flex:1;min-width:0;display:flex;align-items:center;gap:8px;padding:5px 6px;border:0;background:none;font:inherit;color:inherit;text-align:left;cursor:pointer}
.jn-pal-t{display:flex;flex-direction:column;min-width:0;flex:1}
.jn-pal-v{font-size:11px;flex:none}
.jn-head .jn-chips{flex:none;flex-wrap:nowrap}
.jn-stage.has-toast .jn-hint{display:none}
.jn-pal-t b{font-size:12.5px;font-weight:600;line-height:1.25;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:anywhere}
.jn-pal-t small{font-size:11px}
.jn-pal-ic,.jn-ic{width:24px;height:24px;border-radius:6px;display:grid;place-items:center;background:var(--qa-color-primary-soft);color:var(--qa-color-primary);flex:none}
.jn-pal-ic .ico,.jn-ic .ico{width:15px;height:15px}
.jn-ic.condition{background:var(--qa-color-warning-soft);color:var(--qa-color-warning)}
.jn-pal-hint{font-size:11.5px}
/* La scène. */
.jn-composer{--jn-h:clamp(460px,calc(100vh - 330px),780px)}
.jn-stage{position:relative;min-width:0;border:1px solid var(--qa-color-border);border-radius:10px;background:var(--qa-color-surface);height:var(--jn-h);overflow:auto}
.jn-composer[data-mode="LINEAR"] .jn-stage{padding:16px}
.jn-line{display:flex;flex-direction:column;align-items:stretch;max-width:560px;margin:0 auto;position:relative}
.jn-term{align-self:center;display:inline-flex;align-items:center;gap:6px;padding:6px 18px;border-radius:999px;font-weight:700;font-size:13px;background:var(--qa-color-primary-soft);color:var(--qa-color-primary-2);border:1.5px solid var(--qa-color-primary)}
.jn-term .ico{width:13px;height:13px}
.jn-gap{height:26px;display:flex;align-items:center;justify-content:center;position:relative;margin-left:36px}
.jn-gap::before{content:"";position:absolute;top:0;bottom:0;left:50%;border-left:1.5px solid var(--qa-color-border-strong)}
.jn-gap span{position:relative;opacity:0;font-size:11.5px;font-weight:600;color:var(--qa-color-primary-2);background:var(--qa-color-primary-soft);border:1px dashed var(--qa-color-primary);border-radius:6px;padding:0 8px}
.jn-dragging .jn-gap span{opacity:.6}
.jn-gap.over span{opacity:1}
.jn-card{display:flex;align-items:center;gap:10px;min-width:0}
.jn-num{width:24px;height:24px;border-radius:50%;display:grid;place-items:center;font-size:12px;font-weight:700;background:var(--qa-color-surface);color:var(--qa-color-primary-2);border:1.5px solid var(--qa-color-primary);flex:none}
.jn-card.sel .jn-num{background:var(--qa-color-primary-2);color:var(--qa-color-surface);border-color:var(--qa-color-primary-2)}
.jn-card-box{flex:1;min-width:0;display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--qa-color-border);border-radius:10px;background:var(--qa-color-surface);box-shadow:0 1px 2px color-mix(in srgb,var(--qa-color-text) 6%,transparent)}
.jn-card:hover .jn-card-box{border-color:var(--jn-node-bd)}
.jn-card.sel .jn-card-box{background:var(--jn-node-bg);border-color:var(--qa-color-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--qa-color-primary) 18%,transparent)}
.jn-card.ko .jn-card-box{border-color:var(--qa-color-danger);background:color-mix(in srgb,var(--qa-color-danger) 4%,var(--qa-color-surface))}
.jn-card.warn .jn-card-box{border-color:var(--qa-color-warning)}
.jn-card.moving{opacity:.45}
.jn-grip{cursor:grab;color:var(--qa-color-faint);display:grid;place-items:center}
.jn-grip .ico{width:15px;height:15px}
.jn-card-b{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;text-align:left;background:none;border:0;padding:0;font:inherit;color:inherit;cursor:pointer}
.jn-card-h{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0}
.jn-card-t{display:flex;flex-direction:column;min-width:0;flex:1}
.jn-card-t b{font-size:13.5px;overflow-wrap:anywhere}
.jn-card-t small{font-size:11.5px}
.jn-compat{font-size:11px;font-weight:600;padding:1px 8px;border-radius:999px;border:1px solid var(--qa-color-border)}
.jn-compat.ok{color:var(--qa-color-primary-2);background:var(--qa-color-primary-soft)}
.jn-compat.warn{color:color-mix(in srgb,var(--qa-color-warning) 75%,var(--qa-color-text));background:var(--qa-color-warning-soft)}
.jn-compat.ko{color:var(--qa-color-danger);background:var(--qa-color-danger-soft)}
.jn-ios{display:flex;flex-wrap:wrap;gap:8px}
.jn-io{display:inline-flex;flex-wrap:wrap;align-items:center;gap:4px;font-size:11.5px;color:var(--qa-color-muted)}
.jn-io .lib-key.set{border-color:var(--qa-color-primary)}
.jn-err{display:flex;gap:4px;align-items:center;font-size:12px;color:var(--qa-color-danger)}
.jn-err .ico{width:13px;height:13px}
.jn-card-a{display:flex;gap:0;flex:none;opacity:.55}
.jn-card:hover .jn-card-a,.jn-card.sel .jn-card-a,.jn-card-a:focus-within{opacity:1}
.jn-empty{text-align:center;padding:24px 12px;border:2px dashed var(--qa-color-border-strong);border-radius:10px;margin-left:34px}
.jn-add-here{display:flex;justify-content:center;margin:6px 0 12px 34px}
.jn-add-here-b{width:100%;justify-content:center;border-style:dashed;color:var(--qa-color-muted);background:var(--qa-color-surface-2)}
/* Le diagramme. */
.jn-canvas{position:relative;height:100%;overflow:hidden;background-color:var(--qa-color-surface);background-image:radial-gradient(color-mix(in srgb,var(--qa-color-text) 13%,transparent) 1px,transparent 1.2px);background-size:18px 18px;cursor:grab;touch-action:none}
.jn-canvas.panning{cursor:grabbing}
.jn-canvas.connecting,.jn-canvas.connecting .jn-node{cursor:crosshair}
.jn-canvas.drop{outline:2px dashed var(--qa-color-primary);outline-offset:-4px}
.jn-tools-v{position:absolute;z-index:4;top:10px;left:10px;display:flex;flex-direction:column;gap:2px;padding:4px;border:1px solid var(--qa-color-border);border-radius:10px;background:var(--qa-color-surface);box-shadow:0 2px 8px color-mix(in srgb,var(--qa-color-text) 8%,transparent)}
.jn-tool{width:32px;height:32px;display:grid;place-items:center;border:0;border-radius:7px;background:none;color:var(--qa-color-text);cursor:pointer}
.jn-tool .ico{width:17px;height:17px}
.jn-tool:hover:not(:disabled){background:var(--qa-color-primary-soft);color:var(--qa-color-primary-2)}
.jn-tool[aria-pressed="true"]{background:var(--qa-color-primary-soft);color:var(--qa-color-primary)}
.jn-tool:disabled{opacity:.35;cursor:not-allowed}
.jn-tool.danger:not(:disabled){color:var(--qa-color-danger)}
.jn-tool[data-kind="CONDITION"]{color:var(--qa-color-warning)}
.jn-hint{position:absolute;z-index:3;left:56px;bottom:8px;right:10px;font-size:11.5px;pointer-events:none}
.jn-world{position:absolute;left:0;top:0;transform-origin:0 0}
.jn-edges{position:absolute;overflow:visible;pointer-events:none}
.jn-e{fill:none;stroke:var(--jn-edge);stroke-width:1.6}
.jn-edge.ko .jn-e{stroke:var(--qa-color-danger);stroke-dasharray:6 4}
.jn-edge.sel .jn-e{stroke:var(--jn-sel);stroke-width:2.6}
.jn-edge.drop .jn-e{stroke:var(--qa-color-primary);stroke-width:3.2}
.jn-hit{fill:none;stroke:transparent;stroke-width:14;pointer-events:stroke;cursor:pointer}
#jn-arrow path{fill:var(--jn-edge)}
.jn-pill rect{stroke-width:1}
.jn-pill text{font-size:11px;font-weight:700}
.jn-pill.yes rect{fill:var(--qa-color-primary-soft);stroke:color-mix(in srgb,var(--qa-color-primary) 40%,transparent)}
.jn-pill.yes text{fill:var(--qa-color-primary-2)}
.jn-pill.no rect{fill:var(--jn-no-bg);stroke:color-mix(in srgb,var(--jn-no) 35%,transparent)}
.jn-pill.no text{fill:var(--jn-no)}
.jn-temp{fill:none;stroke:var(--jn-sel);stroke-width:2;stroke-dasharray:5 4}
.jn-node{position:absolute;box-sizing:border-box;display:flex;align-items:center;gap:8px;padding:8px 12px;border:1.5px solid var(--jn-node-bd);border-radius:10px;background:var(--jn-node-bg);cursor:move;user-select:none;box-shadow:0 1px 3px color-mix(in srgb,var(--qa-color-text) 7%,transparent)}
.jn-n-t{display:flex;flex-direction:column;min-width:0}
.jn-n-t b{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.jn-n-t small{font-size:11.5px}
.jn-node.start,.jn-node.end{justify-content:center;border-radius:999px;background:var(--qa-color-primary-soft);border-color:var(--qa-color-primary);color:var(--qa-color-primary-2);font-size:13.5px}
.jn-node.start .ico,.jn-node.end .ico{width:13px;height:13px}
.jn-node.join{justify-content:center;border-radius:999px;border-style:dashed;background:var(--qa-color-surface);font-size:12.5px;color:var(--qa-color-muted)}
.jn-node.join .ico{width:14px;height:14px}
.jn-node.condition{border:0;background:none;box-shadow:none;flex-direction:column;justify-content:center;gap:2px;text-align:center;padding:12px 28px}
.jn-dia{position:absolute;inset:0;width:100%;height:100%;overflow:visible;z-index:-1}
.jn-dia polygon{fill:var(--jn-cond-bg);stroke:var(--jn-cond-bd);stroke-width:1.6;vector-effect:non-scaling-stroke}
.jn-n-q{width:18px;height:18px;border-radius:50%;display:grid;place-items:center;font-size:12px;font-weight:800;background:var(--qa-color-warning);color:var(--qa-color-surface)}
.jn-n-l{font-size:12px;line-height:1.2;max-width:100%;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.jn-node.condition.sel .jn-dia polygon{stroke:var(--jn-sel);stroke-width:2.4}
.jn-node.condition.ko .jn-dia polygon{stroke:var(--qa-color-danger)}
.jn-node.condition.sel,.jn-node.condition.ko{box-shadow:none;border:0}
.jn-node.sel{border:2px solid var(--jn-sel);box-shadow:0 0 0 3px var(--jn-sel-soft),0 4px 12px color-mix(in srgb,var(--qa-color-text) 12%,transparent)}
.jn-node.ko{border-color:var(--qa-color-danger)}
.jn-node.warn{border-color:var(--qa-color-warning)}
.jn-node.link-from{box-shadow:0 0 0 3px var(--jn-sel)}
.jn-node.dragging{opacity:.85;box-shadow:0 8px 20px color-mix(in srgb,var(--qa-color-text) 18%,transparent)}
.jn-node:focus-visible{outline:2px solid var(--jn-sel);outline-offset:2px}
.jn-node.target{box-shadow:0 0 0 3px var(--jn-sel)}
.jn-badge{position:absolute;top:-8px;right:-8px;min-width:18px;height:18px;border-radius:9px;color:var(--qa-color-surface);font-size:11px;font-weight:700;display:grid;place-items:center;padding:0 4px}
.jn-badge.ko{background:var(--qa-color-danger)}
.jn-badge.warn{background:var(--qa-color-warning)}
.jn-node.condition .jn-badge{top:4px;right:calc(50% - 46px)}
.jn-port{position:absolute;bottom:-6px;left:50%;width:11px;height:11px;margin-left:-5.5px;border-radius:50%;background:var(--qa-color-surface);border:2px solid var(--jn-node-bd);cursor:crosshair}
.jn-port.yes{left:0;bottom:auto;top:50%;margin-top:-5.5px;margin-left:-5.5px;border-color:var(--qa-color-primary)}
.jn-port.no{left:100%;bottom:auto;top:50%;margin-top:-5.5px;margin-left:-5.5px;border-color:var(--jn-no)}
.jn-port:hover{background:var(--jn-sel);border-color:var(--jn-sel)}
.jn-in{position:absolute;top:-6px;left:50%;width:11px;height:11px;margin-left:-5.5px;border-radius:50%;background:var(--qa-color-surface);border:2px solid var(--jn-node-bd);opacity:0;pointer-events:none}
.jn-node.condition .jn-in{top:-4px}
.jn-node.sel .jn-in,.jn-node.sel .jn-port,.jn-canvas.connecting .jn-in{opacity:1;border-color:var(--jn-sel)}
.jn-float{position:absolute;z-index:5;bottom:calc(100% + 8px);right:0;display:flex;align-items:center;gap:1px;padding:2px;border:1px solid var(--qa-color-border);border-radius:8px;background:var(--qa-color-surface);box-shadow:0 4px 12px color-mix(in srgb,var(--qa-color-text) 14%,transparent);cursor:default}
.jn-float .btn .ico{width:15px;height:15px}
.jn-float .btn{color:var(--jn-sel)}
.jn-float .btn.danger{color:var(--qa-color-danger)}
.jn-node.condition .jn-float{right:auto;left:50%;transform:translateX(-50%)}
.jn-more{position:relative}
.jn-more summary{list-style:none}
.jn-more summary::-webkit-details-marker{display:none}
.jn-more-m{position:absolute;top:calc(100% + 4px);right:0;min-width:210px;display:flex;flex-direction:column;padding:4px;border:1px solid var(--qa-color-border);border-radius:8px;background:var(--qa-color-surface);box-shadow:0 6px 18px color-mix(in srgb,var(--qa-color-text) 16%,transparent)}
.jn-more-m button{display:flex;align-items:center;gap:8px;padding:7px 9px;border:0;border-radius:6px;background:none;font:inherit;font-size:13px;color:var(--qa-color-text);text-align:left;cursor:pointer}
.jn-more-m button:hover{background:var(--qa-color-primary-soft)}
.jn-more-m .ico{width:14px;height:14px}
.jn-insert{position:absolute;z-index:6;top:10px;left:50%;transform:translateX(-50%);display:flex;flex-wrap:wrap;align-items:center;gap:8px;max-width:calc(100% - 80px);padding:8px 10px;border:1px solid color-mix(in srgb,var(--qa-color-primary) 40%,var(--qa-color-border));border-radius:10px;background:var(--qa-color-surface);box-shadow:0 6px 18px color-mix(in srgb,var(--qa-color-text) 14%,transparent);font-size:13px}
.jn-insert p{margin:0}
.jn-toast{position:absolute;z-index:7;left:50%;bottom:14px;transform:translateX(-50%);display:flex;align-items:center;gap:10px;padding:8px 8px 8px 12px;border:1px solid color-mix(in srgb,var(--qa-color-primary) 35%,var(--qa-color-border));border-radius:10px;background:var(--qa-color-surface);box-shadow:0 6px 18px color-mix(in srgb,var(--qa-color-text) 16%,transparent);font-size:13px;font-weight:600;max-width:calc(100% - 28px)}
.jn-toast>.ico{width:20px;height:20px;padding:3px;border-radius:50%;background:var(--qa-color-primary);color:var(--qa-color-surface);flex:none}
.jn-composer[data-mode="LINEAR"] .jn-toast{position:sticky;bottom:6px;margin:8px auto 0;transform:none;left:auto;width:max-content}
/* Le panneau droit : propriétés puis validation. */
.jn-side{width:300px;display:flex;flex-direction:column;gap:12px;min-width:0;max-height:calc(100vh - 200px);overflow:auto}
.jn-props,.jn-valid{border:1px solid var(--qa-color-border);border-radius:12px;background:var(--qa-color-surface);padding:12px;display:flex;flex-direction:column;gap:8px;min-width:0}
.jn-props-top{display:flex;align-items:center;justify-content:space-between}
.jn-props-k{margin:0;font-size:14px;font-weight:700;color:var(--qa-color-text)}
.jn-props h3,.jn-valid h3{margin:0;font-size:14px}
.jn-props-h{display:flex;gap:8px;align-items:center;min-width:0}
.jn-props-n{flex:1;min-width:0}
.jn-props-n p{margin:2px 0 0;font-size:12px}
.jn-props-h h3{font-size:13.5px;overflow-wrap:anywhere}
.jn-ver{font-size:12px;font-weight:600;padding:2px 8px;border:1px solid var(--qa-color-border-strong);border-radius:6px;color:var(--qa-color-text)}
.jn-accept{align-self:flex-start}
.jn-ptabs{display:flex;border-bottom:1px solid var(--qa-color-border);gap:2px}
.jn-ptab{flex:1;padding:7px 4px;border:0;border-bottom:2px solid transparent;background:none;font:inherit;font-size:12.5px;font-weight:600;color:var(--qa-color-muted);cursor:pointer}
.jn-ptab[aria-selected="true"]{color:var(--qa-color-primary-2);border-bottom-color:var(--qa-color-primary)}
.jn-ppanel{display:flex;flex-direction:column;gap:8px;padding-top:4px}
.jn-acc{border:1px solid var(--qa-color-border);border-radius:8px}
.jn-acc summary{cursor:pointer;padding:7px 9px;font-size:13px;font-weight:600}
.jn-acc-b{padding:0 9px 9px;display:flex;flex-direction:column;gap:6px}
.jn-acc-b .jn-sec{border-top:0;padding-top:0}
.jn-acc-b .jn-sec h4{display:none}
.jn-vers{display:flex;flex-direction:column;gap:4px;font-size:12.5px}
.jn-vers li{display:flex;gap:6px;align-items:center}
.jn-vers li.ok .ico{color:var(--qa-color-primary)}
.jn-vers li.warn .ico{color:var(--qa-color-warning)}
.jn-vers .ico{width:14px;height:14px;flex:none}
.jn-valid{gap:10px}
.jn-val-state{display:flex;align-items:center;gap:8px;margin:0;padding:8px 10px;border-radius:8px;font-weight:700;font-size:13px;background:var(--qa-color-surface-2);color:var(--qa-color-muted)}
.jn-val-state .ico{width:16px;height:16px}
.jn-val-state.ok{background:var(--qa-color-primary-soft);color:var(--qa-color-primary-2)}
.jn-val-state.ko{background:var(--qa-color-danger-soft);color:var(--qa-color-danger)}
.jn-val-list{display:flex;flex-direction:column;gap:6px;font-size:12.5px}
.jn-val-list li{display:flex;gap:8px;align-items:flex-start}
.jn-val-list .ico{width:16px;height:16px;flex:none;padding:2px;border-radius:50%;color:var(--qa-color-surface)}
.jn-val-list li.ok .ico{background:var(--qa-color-primary)}
.jn-val-list li.ko .ico{background:var(--qa-color-danger)}
.jn-val-list small{color:var(--qa-color-danger)}
.jn-sec{display:flex;flex-direction:column;gap:6px;padding-top:8px;border-top:1px solid var(--qa-color-border)}
.jn-sec h4{margin:0;font-size:13px}
.jn-out dd{display:flex;flex-wrap:wrap;gap:4px}
.jn-out-partial li{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.jn-out .lib-key.warn{border-color:var(--qa-color-warning)}
.jn-toblock{display:flex;flex-direction:column;gap:8px}
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
.jn-diagtab{display:flex;flex-direction:column;gap:10px;max-width:900px}
.jn-diagtab h3{margin:0;font-size:15px}
.jn-pernode{display:flex;flex-direction:column;gap:8px}
.jn-pernode>li{padding:8px 10px;border:1px solid var(--qa-color-border);border-radius:8px}
.ok-t{color:var(--qa-color-primary-2);display:flex;gap:6px;align-items:center;margin:0}
.ok-t .ico{width:14px;height:14px}
/* Écrans de bureau plus étroits : récents en rail, panneaux plus fins ; le canvas garde la priorité. */
@media (max-width:1599px){
  .lib-shell.recent-auto .lib-recent-col{display:none}
  .lib-shell.recent-auto .lib-rail.recent{display:flex}
  .jn-side{width:280px}
  .jn-body{grid-template-columns:196px minmax(0,1fr)}
  .jn-modebar-l{display:none}
}
@media (max-width:1180px){
  .lib-shell{grid-template-columns:auto minmax(0,1fr)}
  .jn-side{grid-column:1 / -1;width:auto;max-height:none;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr)}
  .lib-rail.props{grid-column:1 / -1;width:auto}
}
@media (max-width:760px){
  .lib-shell{grid-template-columns:minmax(0,1fr)}
  .lib-shell .lib-rail{display:none!important}
  .lib-recent-col{width:auto;max-height:none}
  .jn-body{grid-template-columns:minmax(0,1fr)}
  .jn-palette{height:280px}
  .jn-side{grid-template-columns:minmax(0,1fr)}
  .jn-acts{margin-left:0}
}
`;
