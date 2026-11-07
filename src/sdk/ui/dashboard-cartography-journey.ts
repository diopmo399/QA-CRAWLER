import type {
  ConditionRow,
  Evidence,
  FeatureCategory,
  FeatureGroup,
  FeatureLane,
  FeatureMap,
  FeatureMapBundle,
  FeatureMapItem,
  FeatureMapQuery,
  FeatureMapRelation,
  FeatureRow,
  FeatureTreeNode,
  MapConfidence,
} from '../core/cartography.js';
import { FEATURE_CATEGORIES, FEATURE_LANES } from '../core/cartography.js';
import { icon } from './dashboard-parts.js';
import { esc } from './view.js';

/**
 * PARCOURS & GRAPHE : la carte d'une fonctionnalité, telle que le scan l'établit. À gauche, l'arborescence de
 * l'interface et les catégories de liens comptées ; au centre, quatre couloirs dans un ordre fixe (Angular,
 * BFF, Backend avec sa persistance, API externes), chacun en cartes pastel par groupe, et entre deux couloirs
 * les faisceaux de relations comptés (« Tout » n'y dessine jamais chaque trait) ; en bas, le tableau filtrable
 * et paginé de toutes les relations, les conditions, les stores, les appels, les flux de données et les preuves.
 * Choisir un élément le met au premier plan avec ses voisins et atténue le reste. Aucun chiffre n'est calculé
 * ici : tout vient de la réponse du serveur, y compris les lacunes (dites, jamais comblées).
 */

export const JOURNEY_VIEWS = [
  'overview',
  'graph',
  'ui',
  'stores',
  'rules',
  'data',
  'persistence',
  'external',
  'evidence',
] as const;
export type JourneyView = (typeof JOURNEY_VIEWS)[number];
export const JOURNEY_BOTTOMS = ['links', 'rules', 'stores', 'calls', 'data', 'evidence'] as const;
export type JourneyBottom = (typeof JOURNEY_BOTTOMS)[number];

export interface JourneyState {
  jView: JourneyView;
  jBottom: JourneyBottom;
  jQuery: FeatureMapQuery;
  jMap?: FeatureMap;
  jSelect?: string;
  jZoom: number;
  jFull: boolean;
  jClosed: string[];
  jOpen: string[];
  /** Les membres de toutes les cartes affichés (sinon : cartes repliées, sauf ouvertes ou choisies). */
  jDetail: boolean;
  /** La fonctionnalité dont les couloirs ont déjà été ajustés à la zone (une fois, à l'ouverture). */
  jFitted?: string;
}

export const emptyJourney = (): JourneyState => ({
  jView: 'graph',
  jBottom: 'links',
  jQuery: { page: 1, size: 25 },
  jZoom: 1,
  jFull: false,
  jClosed: [],
  jOpen: [],
  jDetail: false,
});

/** Ce qu'une vue met au premier plan : l'onglet du bas, la catégorie du tableau, les groupes mis en avant. */
export const VIEW_PRESET: Record<
  JourneyView,
  { bottom: JourneyBottom; category?: FeatureCategory; focus?: readonly FeatureGroup[] }
> = {
  overview: { bottom: 'links' },
  graph: { bottom: 'links' },
  ui: {
    bottom: 'links',
    category: 'CONTAINS',
    focus: ['PAGE', 'COMPONENT', 'CONTAINER', 'FIELD', 'BUTTON', 'CONDITION'],
  },
  stores: { bottom: 'stores', focus: ['STORE'] },
  rules: { bottom: 'rules', category: 'CONDITION', focus: ['CONDITION', 'BUTTON', 'CONTAINER', 'RULE'] },
  data: { bottom: 'data', category: 'DATA', focus: ['FIELD', 'MODEL', 'STORE', 'DTO', 'CONTRACT', 'ENTITY'] },
  persistence: { bottom: 'links', category: 'PERSISTENCE', focus: ['REPOSITORY', 'ENTITY'] },
  external: { bottom: 'calls', category: 'EXTERNAL', focus: ['CLIENT', 'EXTERNAL_SERVICE', 'EXTERNAL_CALL'] },
  evidence: { bottom: 'evidence' },
};

export interface JourneyHelpers {
  locale: 'fr' | 'en';
  conf: (value: MapConfidence) => string;
  evidence: (e: Evidence | undefined) => string;
  spinner: () => string;
  paneError: (text: string | undefined) => string;
  features: readonly FeatureRow[];
  feature?: string;
  loading: boolean;
  error?: string;
}

// ── Textes ───────────────────────────────────────────────────────────────────────────────────────────

const FR = {
  tab: 'Parcours & Graphe',
  views: {
    overview: 'Vue d’ensemble',
    graph: 'Parcours & Graphe',
    ui: 'Structure UI',
    stores: 'Stores & Dépendances',
    rules: 'Conditions & Règles',
    data: 'Flux de données',
    persistence: 'Persistance (JPA)',
    external: 'API externes',
    evidence: 'Preuves (Code)',
  } satisfies Record<JourneyView, string>,
  bottoms: {
    links: (n: number) => `Détails des liens (${String(n)})`,
    rules: (n: number) => `Conditions & Règles (${String(n)})`,
    stores: (n: number) => `Stores (${String(n)})`,
    calls: (n: number) => `Appels & Services (${String(n)})`,
    data: (n: number) => `Données (${String(n)})`,
    evidence: (n: number) => `Code & Preuves (${String(n)})`,
  } satisfies Record<JourneyBottom, (n: number) => string>,
  feature: 'Fonctionnalité',
  pickFeature: 'Choisir une fonctionnalité',
  allFeatures: 'Toutes les fonctionnalités',
  noFeature: 'Aucune fonctionnalité dans ce scan.',
  status: { CANDIDATE: 'Candidate', CONFIRMED: 'Confirmée', REJECTED: 'Rejetée' } as Record<string, string>,
  kpi: {
    links: 'Liens',
    stores: 'Stores (SPA)',
    services: 'Services (SPA)',
    entities: 'Entités JPA',
    external: 'API externes',
    scenarios: 'Scénarios associés',
    coverage: 'Couverture',
  },
  lanes: {
    FRONTEND: ['Angular (SPA)', 'Interface utilisateur'],
    BFF: ['BFF', 'Orchestration'],
    BACKEND: ['Backend (Java)', 'Traitement métier'],
    EXTERNAL: ['API externe', 'Services partenaires'],
  } satisfies Record<FeatureLane, [string, string]>,
  laneAbsent: 'Aucun élément démontré dans cette couche.',
  groups: {
    PAGE: 'Pages',
    COMPONENT: 'Composants',
    CONTAINER: 'Conteneurs',
    FIELD: 'Champs',
    BUTTON: 'Boutons',
    CONDITION: 'Conditions',
    STORE: 'Stores personnalisés',
    SPA_SERVICE: 'Services SPA',
    MODEL: 'Modèles',
    CONTROLLER: 'Contrôleurs',
    ENDPOINT: 'Endpoints',
    CONTRACT: 'Contrats',
    DTO: 'Contrats (DTO)',
    SERVICE: 'Services',
    RULE: 'Règles métier',
    CLIENT: 'Clients sortants',
    METHOD: 'Autres méthodes',
    REPOSITORY: 'Repositories',
    ENTITY: 'Entités et tables',
    EXTERNAL_SERVICE: 'Services externes',
    EXTERNAL_CALL: 'Appels',
  } satisfies Record<FeatureGroup, string>,
  persistence: 'Persistance (Hibernate/JPA)',
  categories: {
    CONTAINS: 'Contient',
    CONDITION: 'Visible / actif si',
    DEPENDS: 'Dépend de',
    CALLS: 'Appelle',
    DATA: 'Flux de données',
    PERSISTENCE: 'Persistance',
    EXTERNAL: 'API externe',
  } satisfies Record<FeatureCategory, string>,
  linksTitle: (n: number) => `Liens (${String(n)})`,
  all: 'Toutes',
  journeyTitle: 'Parcours complet (Angular → BFF → Backend → API externe)',
  inner: 'Liens internes',
  links: (n: number) => (n === 1 ? '1 lien' : `${String(n)} liens`),
  isolated: 'non relié',
  more: (n: number) => `+${String(n)} autre(s)`,
  hiddenCards: (n: number) =>
    `+${String(n)} carte(s) moins reliée(s) non affichée(s) : toutes leurs relations sont dans le tableau`,
  less: 'Réduire',
  members: (n: number) => (n === 1 ? '1 membre' : `${String(n)} membres`),
  isolatedCount: (n: number) => (n === 1 ? '1 non relié' : `${String(n)} non reliés`),
  showMembers: 'Déplier toutes les cartes',
  hideMembers: 'Replier les cartes',
  zoomIn: 'Zoom avant',
  zoomOut: 'Zoom arrière',
  center: 'Centrer (garde l’échelle)',
  fit: 'Ajuster à l’écran',
  full: 'Plein écran',
  exitFull: 'Quitter le plein écran',
  selected: 'Élément choisi',
  clear: 'Tout montrer',
  focusNote: (name: string) =>
    `Focus sur ${name} : ses relations sont au premier plan, les autres atténuées.`,
  col: {
    n: '#',
    type: 'Type de lien',
    source: 'Source',
    target: 'Cible',
    status: 'Statut',
    proof: 'Preuve',
    element: 'Élément',
    aspect: 'Aspect',
    expression: 'Expression',
    decision: 'Décision',
    layer: 'Couche',
    group: 'Groupe',
    detail: 'Détail',
    count: 'Liens',
    file: 'Fichier',
  },
  visible: 'Visible si',
  enabled: 'Actif si',
  hiddenWhen: 'Masqué si',
  disabledWhen: 'Désactivé si',
  noDecision: 'décision non établie',
  search: 'Rechercher une relation',
  anyStatus: 'Tous les statuts',
  anyCategory: 'Toutes les catégories',
  anyLane: 'Toutes les couches',
  conf: { CONFIRMED: 'confirmé', PROBABLE: 'probable', UNKNOWN: 'non démontré' } as Record<string, string>,
  page: (p: number, n: number) => `Page ${String(p)} / ${String(n)}`,
  prev: 'Précédente',
  next: 'Suivante',
  noRelations: 'Aucune relation ne correspond à ces critères.',
  noConditions: 'Aucune condition d’affichage ou d’activation démontrée dans cette fonctionnalité.',
  noStores: 'Aucun store atteint par cette fonctionnalité.',
  noCalls: 'Aucun appel ni service atteint.',
  rulesTitle: 'Règles principales (extraits)',
  flowTitle: 'Flux de données',
  noFlow: 'Aucun flux de données démontré.',
  gapsTitle: 'Ce que le scan ne démontre pas',
  noGaps: 'Aucune lacune relevée pour cette fonctionnalité.',
  gaps: {
    LANE_NO_SOURCE: 'Couche sans source',
    LANE_NOT_REACHED: 'Couche non atteinte',
    NO_STORE: 'Aucun store',
    ISOLATED: 'Éléments non reliés',
    BROKEN_CORRELATION: 'Corrélations non démontrées',
    UNCLASSIFIED_CALL: 'Appels sortants à classifier',
    DEPENDENCY_UNAVAILABLE: 'Dépendances indisponibles',
    SOURCE_PARTIAL: 'Source lue partiellement',
    CHAIN_BREAK: 'Ruptures de chaîne',
    TRUNCATED: 'Relations coupées',
  } as Record<string, string>,
  overviewTitle: 'Synthèse par couche',
  overviewItems: (n: number) => `${String(n)} élément(s)`,
  statusTitle: 'Niveaux de preuve',
  openCode: 'Voir le code',
  noEvidence: 'sans fichier',
  truncated: 'Relations coupées : la fonctionnalité dépasse la limite ; le tableau en garde le compte exact.',
  loading: 'Chargement de la carte…',
};
type JourneyStrings = typeof FR;

const EN: JourneyStrings = {
  tab: 'Journey & Graph',
  views: {
    overview: 'Overview',
    graph: 'Journey & Graph',
    ui: 'UI structure',
    stores: 'Stores & dependencies',
    rules: 'Conditions & rules',
    data: 'Data flow',
    persistence: 'Persistence (JPA)',
    external: 'External APIs',
    evidence: 'Evidence (code)',
  },
  bottoms: {
    links: (n) => `Link details (${String(n)})`,
    rules: (n) => `Conditions & rules (${String(n)})`,
    stores: (n) => `Stores (${String(n)})`,
    calls: (n) => `Calls & services (${String(n)})`,
    data: (n) => `Data (${String(n)})`,
    evidence: (n) => `Code & evidence (${String(n)})`,
  },
  feature: 'Feature',
  pickFeature: 'Pick a feature',
  allFeatures: 'All features',
  noFeature: 'No feature in this scan.',
  status: { CANDIDATE: 'Candidate', CONFIRMED: 'Confirmed', REJECTED: 'Rejected' },
  kpi: {
    links: 'Links',
    stores: 'Stores (SPA)',
    services: 'Services (SPA)',
    entities: 'JPA entities',
    external: 'External APIs',
    scenarios: 'Linked scenarios',
    coverage: 'Coverage',
  },
  lanes: {
    FRONTEND: ['Angular (SPA)', 'User interface'],
    BFF: ['BFF', 'Orchestration'],
    BACKEND: ['Backend (Java)', 'Business processing'],
    EXTERNAL: ['External API', 'Partner services'],
  },
  laneAbsent: 'No element demonstrated in this layer.',
  groups: {
    PAGE: 'Pages',
    COMPONENT: 'Components',
    CONTAINER: 'Containers',
    FIELD: 'Fields',
    BUTTON: 'Buttons',
    CONDITION: 'Conditions',
    STORE: 'Custom stores',
    SPA_SERVICE: 'SPA services',
    MODEL: 'Models',
    CONTROLLER: 'Controllers',
    ENDPOINT: 'Endpoints',
    CONTRACT: 'Contracts',
    DTO: 'Contracts (DTO)',
    SERVICE: 'Services',
    RULE: 'Business rules',
    CLIENT: 'Outgoing clients',
    METHOD: 'Other methods',
    REPOSITORY: 'Repositories',
    ENTITY: 'Entities and tables',
    EXTERNAL_SERVICE: 'External services',
    EXTERNAL_CALL: 'Calls',
  },
  persistence: 'Persistence (Hibernate/JPA)',
  categories: {
    CONTAINS: 'Contains',
    CONDITION: 'Visible / enabled when',
    DEPENDS: 'Depends on',
    CALLS: 'Calls',
    DATA: 'Data flow',
    PERSISTENCE: 'Persistence',
    EXTERNAL: 'External API',
  },
  linksTitle: (n) => `Links (${String(n)})`,
  all: 'All',
  journeyTitle: 'Complete journey (Angular → BFF → Backend → external API)',
  inner: 'Inner links',
  links: (n) => (n === 1 ? '1 link' : `${String(n)} links`),
  isolated: 'not linked',
  more: (n) => `+${String(n)} more`,
  hiddenCards: (n) => `+${String(n)} less-linked card(s) not shown: all their links are in the table`,
  less: 'Collapse',
  members: (n) => (n === 1 ? '1 member' : `${String(n)} members`),
  isolatedCount: (n) => `${String(n)} not linked`,
  showMembers: 'Expand all cards',
  hideMembers: 'Collapse the cards',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  center: 'Center (keeps the scale)',
  fit: 'Fit to screen',
  full: 'Full screen',
  exitFull: 'Exit full screen',
  selected: 'Selected element',
  clear: 'Show everything',
  focusNote: (name) => `Focus on ${name}: its relations are in front, the others dimmed.`,
  col: {
    n: '#',
    type: 'Link type',
    source: 'Source',
    target: 'Target',
    status: 'Status',
    proof: 'Evidence',
    element: 'Element',
    aspect: 'Aspect',
    expression: 'Expression',
    decision: 'Decision',
    layer: 'Layer',
    group: 'Group',
    detail: 'Detail',
    count: 'Links',
    file: 'File',
  },
  visible: 'Visible when',
  enabled: 'Enabled when',
  hiddenWhen: 'Hidden when',
  disabledWhen: 'Disabled when',
  noDecision: 'decision not established',
  search: 'Search a relation',
  anyStatus: 'All statuses',
  anyCategory: 'All categories',
  anyLane: 'All layers',
  conf: { CONFIRMED: 'confirmed', PROBABLE: 'probable', UNKNOWN: 'not demonstrated' },
  page: (p, n) => `Page ${String(p)} / ${String(n)}`,
  prev: 'Previous',
  next: 'Next',
  noRelations: 'No relation matches these criteria.',
  noConditions: 'No display or enabling condition demonstrated in this feature.',
  noStores: 'No store reached by this feature.',
  noCalls: 'No call or service reached.',
  rulesTitle: 'Main rules (excerpts)',
  flowTitle: 'Data flow',
  noFlow: 'No data flow demonstrated.',
  gapsTitle: 'What the scan does not demonstrate',
  noGaps: 'No gap found for this feature.',
  gaps: {
    LANE_NO_SOURCE: 'Layer without source',
    LANE_NOT_REACHED: 'Layer not reached',
    NO_STORE: 'No store',
    ISOLATED: 'Unlinked elements',
    BROKEN_CORRELATION: 'Undemonstrated correlations',
    UNCLASSIFIED_CALL: 'Outgoing calls to classify',
    DEPENDENCY_UNAVAILABLE: 'Unavailable dependencies',
    SOURCE_PARTIAL: 'Source partly read',
    CHAIN_BREAK: 'Chain breaks',
    TRUNCATED: 'Relations cut',
  },
  overviewTitle: 'Summary per layer',
  overviewItems: (n) => `${String(n)} element(s)`,
  statusTitle: 'Evidence levels',
  openCode: 'View code',
  noEvidence: 'no file',
  truncated: 'Relations cut: the feature exceeds the limit; the table keeps the exact count.',
  loading: 'Loading the map…',
};

export const journeyStrings = (locale: 'fr' | 'en'): JourneyStrings => (locale === 'en' ? EN : FR);

// ── Rendu ────────────────────────────────────────────────────────────────────────────────────────────

const LANE_ICON: Record<FeatureLane, string> = {
  FRONTEND: 'monitor',
  BFF: 'code',
  BACKEND: 'gear',
  EXTERNAL: 'cloud',
};
const CAT_ICON: Record<FeatureCategory, string> = {
  CONTAINS: 'grid',
  CONDITION: 'eye',
  DEPENDS: 'link',
  CALLS: 'swap',
  DATA: 'data',
  PERSISTENCE: 'layers',
  EXTERNAL: 'cloud',
};
const GROUP_ICON: Partial<Record<FeatureGroup, string>> = {
  PAGE: 'file',
  COMPONENT: 'cube',
  CONTAINER: 'grid',
  FIELD: 'text',
  BUTTON: 'pointer',
  CONDITION: 'eye',
  STORE: 'layers',
  SPA_SERVICE: 'code',
  CONTROLLER: 'file',
  ENDPOINT: 'link',
  CONTRACT: 'file',
  DTO: 'file',
  SERVICE: 'gear',
  RULE: 'check',
  CLIENT: 'external',
  REPOSITORY: 'data',
  ENTITY: 'data',
  EXTERNAL_SERVICE: 'cloud',
  EXTERNAL_CALL: 'swap',
};
const MEMBERS_SHOWN = 4;

/** Le texte d'un membre dans sa carte : sans le nom de la carte devant, une méthode avec ses parenthèses. */
function memberText(item: FeatureMapItem): string {
  const name = item.label ?? item.name;
  const short = name.startsWith(`${item.cardTitle}.`) ? name.slice(item.cardTitle.length + 1) : name;
  return item.kind === 'METHOD' && !short.includes('(') ? `${short}()` : short;
}

/** Les éléments voisins de l'élément choisi (d'après la page de relations filtrée sur lui). */
function neighbourSet(map: FeatureMap, selected: string | undefined): Set<string> | undefined {
  if (!selected) return undefined;
  const set = new Set<string>([selected]);
  const card = map.items.find((i) => i.id === selected)?.card;
  for (const item of map.items) if (item.card === selected || (card && item.id === card)) set.add(item.id);
  for (const r of map.relations.items) {
    set.add(r.from);
    set.add(r.to);
  }
  return set;
}

function kpis(s: JourneyStrings, map: FeatureMap): string {
  // Les comptes du serveur (tous les éléments), pas seulement les cartes renvoyées.
  const info = (group: FeatureGroup) => map.lanes.flatMap((l) => l.groups).filter((g) => g.group === group);
  const cards = (group: FeatureGroup): number => info(group).reduce((sum, g) => sum + g.cards, 0);
  const external = info('EXTERNAL_SERVICE').reduce((sum, g) => sum + g.count, 0);
  const cov = map.feature.coverage;
  const tiles: [string, string, string][] = [
    ['link', String(map.relationCount), s.kpi.links],
    ['layers', String(cards('STORE')), s.kpi.stores],
    ['code', String(cards('SPA_SERVICE')), s.kpi.services],
    ['data', String(cards('ENTITY')), s.kpi.entities],
    ['cloud', String(external), s.kpi.external],
    ['play', String(map.feature.scenarios), s.kpi.scenarios],
    ...(cov && cov.applicable > 0
      ? [
          ['check', `${String(Math.round((cov.met / cov.applicable) * 100))} %`, s.kpi.coverage] as [
            string,
            string,
            string,
          ],
        ]
      : []),
  ];
  return `<div class="jr-kpis">${tiles.map(([ic, value, label]) => `<div class="jr-kpi">${icon(ic)}<div><b>${esc(value)}</b><small>${esc(label)}</small></div></div>`).join('')}</div>`;
}

function featurePicker(s: JourneyStrings, map: FeatureMap | undefined, h: JourneyHelpers): string {
  const options = [...h.features];
  if (map && !options.some((f) => f.id === map.feature.id))
    options.unshift({ id: map.feature.id, name: map.feature.name } as FeatureRow);
  const status = map
    ? `<span class="jr-status s-${map.feature.status.toLowerCase()}">${esc(s.status[map.feature.status] ?? map.feature.status)}</span>`
    : '';
  return `<div class="jr-pick">${icon('play')}<label><span>${esc(s.feature)} :</span><select data-map="j-feature" aria-label="${esc(s.pickFeature)}">${options.map((f) => `<option value="${esc(f.id)}" ${f.id === (map?.feature.id ?? h.feature) ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select></label>${status}<button class="lnk" data-action="map-tab" data-tab="features">${esc(s.allFeatures)}</button></div>`;
}

function treeView(nodes: readonly FeatureTreeNode[], st: JourneyState, map: FeatureMap): string {
  const links = new Map(map.items.map((i) => [i.id, i.links]));
  const row = (n: FeatureTreeNode): string => {
    const closed = st.jClosed.includes(n.id);
    const kids = n.children.length
      ? `<button class="jr-tg" data-action="map-j-tree" data-node="${esc(n.id)}" aria-expanded="${String(!closed)}" aria-label="${esc(n.name)}">${icon(closed ? 'right' : 'down')}</button>`
      : '<span class="jr-tg-sp"></span>';
    const label = n.kind === 'ROUTE' || n.kind === 'SCREEN' ? `Page : ${n.name}` : n.name;
    const sel = st.jSelect === n.id;
    const zero = (links.get(n.id) ?? 0) === 0;
    return `<li>${kids}<button class="jr-tn k-${n.kind.toLowerCase()}${sel ? ' sel' : ''}${zero ? ' zero' : ''}" data-action="map-j-item" data-item="${esc(n.id)}" aria-pressed="${String(sel)}">${icon(n.kind === 'BUTTON' ? 'pointer' : n.kind === 'FIELD' ? 'text' : n.kind === 'CONTAINER' ? 'grid' : n.kind === 'COMPONENT' ? 'cube' : 'file')}<span>${esc(label)}</span></button>${!closed && n.children.length ? `<ul>${n.children.map(row).join('')}</ul>` : ''}</li>`;
  };
  return nodes.length ? `<ul class="jr-tree" role="tree">${nodes.map(row).join('')}</ul>` : '';
}

function categoryList(s: JourneyStrings, map: FeatureMap, st: JourneyState): string {
  const rows = FEATURE_CATEGORIES.map((c) => {
    const active = st.jQuery.category === c;
    return `<li><button class="jr-cat c-${c.toLowerCase()}${active ? ' on' : ''}" data-action="map-j-cat" data-cat="${c}" aria-pressed="${String(active)}">${icon(CAT_ICON[c])}<span>${esc(s.categories[c])}</span><b>${String(map.categories[c])}</b></button></li>`;
  }).join('');
  const all = `<li><button class="jr-cat${st.jQuery.category ? '' : ' on'}" data-action="map-j-cat" data-cat="" aria-pressed="${String(!st.jQuery.category)}">${icon('filter')}<span>${esc(s.all)}</span><b>${String(map.relationCount)}</b></button></li>`;
  return `<section class="jr-links"><h3>${icon('right')}${esc(s.linksTitle(map.relationCount))}</h3><ul>${all}${rows}</ul></section>`;
}

/** Les cartes d'un couloir : une section par groupe, une carte par classe/DTO/entité/store, ses membres. */
function laneCards(
  s: JourneyStrings,
  map: FeatureMap,
  lane: FeatureLane,
  st: JourneyState,
  near: Set<string> | undefined,
  focus: ReadonlySet<FeatureGroup> | undefined,
): string {
  const items = map.items.filter((i) => i.lane === lane);
  const groupOf = (list: readonly FeatureMapItem[], key: (i: FeatureMapItem) => string) => {
    const out = new Map<string, FeatureMapItem[]>();
    for (const i of list) {
      const bucket = out.get(key(i));
      if (bucket) bucket.push(i);
      else out.set(key(i), [i]);
    }
    return out;
  };
  const groups = groupOf(items, (i) => i.group) as Map<FeatureGroup, FeatureMapItem[]>;
  const info = new Map(map.lanes.find((l) => l.lane === lane)?.groups.map((g) => [g.group, g]));
  const section = (group: FeatureGroup, list: FeatureMapItem[]): string => {
    const cards = groupOf(list, (i) => i.card);
    const counts = info.get(group);
    const hidden = counts ? counts.cards - counts.shown : 0;
    const dim = (focus && !focus.has(group)) || (near && !list.some((i) => near.has(i.id)));
    const body = [...cards].map(([card, members]) => {
      const head = members.find((i) => i.id === card);
      const rest = members.filter((i) => i.id !== card);
      const open = st.jOpen.includes(card);
      const sel = members.some((i) => i.id === st.jSelect);
      // Repliée par défaut (le graphe tient dans l'écran) : dépliée si demandé, ouverte ou choisie.
      const compact = !st.jDetail && !open && !sel;
      const shown = compact ? [] : open ? rest : rest.slice(0, MEMBERS_SHOWN);
      const links = members.reduce((sum, i) => sum + i.links, 0);
      const title = head ?? members[0];
      const isolated = rest.filter((i) => i.links === 0).length;
      const toggleBtn = (text: string): string =>
        `<button class="lnk jr-more" data-action="map-j-card" data-card="${esc(card)}" aria-expanded="${String(!compact)}">${text}</button>`;
      // Repliée : le nombre de membres tient dans l'en-tête (orange s'il y a des membres non reliés) ;
      // un clic sur la carte la choisit, ce qui la déplie.
      const memberNote = `${s.members(rest.length)}${isolated ? ` · ${s.isolatedCount(isolated)}` : ''}`;
      const count = `<i class="jr-n">${esc(s.links(links))}${compact && rest.length ? `<small${isolated ? ' class="w"' : ''} title="${esc(memberNote)}" aria-label="${esc(memberNote)}">${esc(s.members(rest.length))}</small>` : ''}</i>`;
      const toggle =
        rest.length === 0 || compact
          ? ''
          : open && (rest.length > MEMBERS_SHOWN || (!st.jDetail && !sel))
            ? toggleBtn(esc(s.less))
            : !open && rest.length > MEMBERS_SHOWN
              ? toggleBtn(esc(s.more(rest.length - MEMBERS_SHOWN)))
              : '';
      const cardDim = near && !members.some((i) => near.has(i.id));
      const zero = links === 0;
      const member = (i: FeatureMapItem): string =>
        `<li><button class="jr-m${i.id === st.jSelect ? ' sel' : ''}${i.links === 0 ? ' zero' : ''}${near && !near.has(i.id) ? ' dim' : ''}" data-action="map-j-item" data-item="${esc(i.id)}" title="${esc(i.sub ? `${i.label ?? i.name} — ${i.sub}` : (i.label ?? i.name))}"><span>${esc(memberText(i))}</span>${i.sub ? `<small>${esc(i.sub)}</small>` : ''}${i.links === 0 ? `<em>${esc(s.isolated)}</em>` : ''}</button></li>`;
      return `<div class="jr-card${sel ? ' sel' : ''}${cardDim ? ' dim' : ''}${zero ? ' zero' : ''}"><button class="jr-ch" data-action="map-j-item" data-item="${esc(title?.id ?? card)}" title="${esc(title?.cardTitle ?? '')}">${icon(GROUP_ICON[group] ?? 'cube')}<span><b>${esc(head ? (head.label ?? head.name) : (title?.cardTitle ?? card))}</b>${head?.sub ? `<small>${esc(head.sub)}</small>` : ''}</span>${count}</button>${shown.length ? `<ul class="jr-ml">${shown.map(member).join('')}</ul>` : ''}${toggle}</div>`;
    });
    const more = hidden > 0 ? `<p class="jr-hidden">${esc(s.hiddenCards(hidden))}</p>` : '';
    return `<div class="jr-sec${dim ? ' dim' : ''}" data-group="${group}"><h4>${icon(GROUP_ICON[group] ?? 'cube')}<span>${esc(s.groups[group])}</span><i>${String(counts?.count ?? list.length)}</i></h4>${body.join('')}${more}</div>`;
  };
  const order = [...groups.keys()];
  const main = order.filter((g) => g !== 'REPOSITORY' && g !== 'ENTITY');
  const persistence = order.filter((g) => g === 'REPOSITORY' || g === 'ENTITY');
  return `${main.map((g) => section(g, groups.get(g) ?? [])).join('')}${persistence.length ? `<div class="jr-persist"><h4 class="jr-ph">${icon('data')}<span>${esc(s.persistence)}</span></h4>${persistence.map((g) => section(g, groups.get(g) ?? [])).join('')}</div>` : ''}`;
}

/** Les faisceaux entre deux couloirs voisins (ou sautant une couche), comptés par catégorie. */
function connector(s: JourneyStrings, map: FeatureMap, from: FeatureLane, st: JourneyState): string {
  const rank = (l: FeatureLane): number => FEATURE_LANES.indexOf(l);
  const between = map.bundles.filter(
    (b) =>
      (b.fromLane === from && rank(b.toLane) > rank(from)) ||
      (b.toLane === from && rank(b.fromLane) > rank(from)),
  );
  const byCat = new Map<FeatureCategory, { count: number; lanes: Set<FeatureLane>; weak: number }>();
  for (const b of between) {
    const entry = byCat.get(b.category) ?? { count: 0, lanes: new Set<FeatureLane>(), weak: 0 };
    entry.count += b.count;
    entry.weak += b.statuses.PROBABLE + b.statuses.UNKNOWN;
    entry.lanes.add(b.fromLane === from ? b.toLane : b.fromLane);
    byCat.set(b.category, entry);
  }
  const pills = [...byCat].map(([cat, e]) => {
    const skip = [...e.lanes].filter((l) => rank(l) > rank(from) + 1);
    const on = st.jQuery.category === cat && st.jQuery.lane === from;
    return `<button class="jr-pill c-${cat.toLowerCase()}${on ? ' on' : ''}${e.weak ? ' weak' : ''}" data-action="map-j-bundle" data-cat="${cat}" data-lane="${from}" title="${esc(`${s.categories[cat]} : ${s.links(e.count)}${skip.length ? ` → ${skip.map((l) => s.lanes[l][0]).join(', ')}` : ''}`)}">${icon(CAT_ICON[cat])}<b>${String(e.count)}</b><span>${esc(s.categories[cat])}</span>${skip.length ? `<small>→ ${esc(skip.map((l) => s.lanes[l][0]).join(', '))}</small>` : ''}</button>`;
  });
  return `<div class="jr-conn" aria-label="${esc(`${s.lanes[from][0]} →`)}">${pills.length ? `<span class="jr-arrow" aria-hidden="true"></span>${pills.join('')}` : '<span class="jr-arrow off" aria-hidden="true"></span>'}</div>`;
}

/** Les relations à l'intérieur d'un couloir, comptées par catégorie (en pied de couloir). */
function innerLinks(s: JourneyStrings, map: FeatureMap, lane: FeatureLane): string {
  const counts = new Map<FeatureCategory, number>();
  for (const b of map.bundles)
    if (b.fromLane === lane && b.toLane === lane)
      counts.set(b.category, (counts.get(b.category) ?? 0) + b.count);
  if (counts.size === 0) return '';
  return `<div class="jr-inner"><span>${esc(s.inner)} :</span>${[...counts].map(([c, n]) => `<button class="lnk" data-action="map-j-bundle" data-cat="${c}" data-lane="${lane}" data-inner="1">${esc(s.categories[c])} ${String(n)}</button>`).join(' · ')}</div>`;
}

function lanesGraph(
  s: JourneyStrings,
  map: FeatureMap,
  st: JourneyState,
  near: Set<string> | undefined,
): string {
  const focus = VIEW_PRESET[st.jView].focus ? new Set(VIEW_PRESET[st.jView].focus) : undefined;
  const lanes = FEATURE_LANES.map((lane, index) => {
    const present = map.lanes.find((l) => l.lane === lane)?.present ?? false;
    const [title, sub] = s.lanes[lane];
    const body = present
      ? laneCards(s, map, lane, st, near, focus)
      : `<p class="jr-absent">${esc(s.laneAbsent)}</p>`;
    const col = `<section class="jr-lane l-${lane.toLowerCase()}${present ? '' : ' empty'}" data-lane="${lane}"><header>${icon(LANE_ICON[lane])}<div><h3>${esc(title)}</h3><small>${esc(sub)}</small></div></header>${body}${innerLinks(s, map, lane)}</section>`;
    return index < FEATURE_LANES.length - 1 ? `${col}${connector(s, map, lane, st)}` : col;
  });
  return `<div class="jr-lanes" style="zoom:${String(st.jZoom)}">${lanes.join('')}</div>`;
}

function toolbar(s: JourneyStrings, st: JourneyState): string {
  const btn = (action: string, label: string, ic: string, extra = ''): string =>
    `<button class="btn small icon-only" data-action="${action}" aria-label="${esc(label)}" title="${esc(label)}"${extra}>${icon(ic)}</button>`;
  return `<div class="jr-tools">${btn('map-j-detail', st.jDetail ? s.hideMembers : s.showMembers, 'text', ` aria-pressed="${String(st.jDetail)}"`)}${btn('map-j-center', s.center, 'target')}${btn('map-j-fit', s.fit, 'fit')}${btn('map-j-full', st.jFull ? s.exitFull : s.full, st.jFull ? 'minimize' : 'maximize', ` aria-pressed="${String(st.jFull)}"`)}${btn('map-j-zoom', s.zoomOut, 'minus', ' data-dir="-1"')}<output class="jr-zoom" aria-live="polite">${String(Math.round(st.jZoom * 100))} %</output>${btn('map-j-zoom', s.zoomIn, 'plus', ' data-dir="1"')}</div>`;
}

function aspectLabel(s: JourneyStrings, row: ConditionRow): string {
  if (row.aspect === 'VISIBLE') return row.whenTrue ? s.visible : s.hiddenWhen;
  return row.whenTrue ? s.enabled : s.disabledWhen;
}

function relationsTable(s: JourneyStrings, map: FeatureMap, st: JourneyState, h: JourneyHelpers): string {
  const page = map.relations;
  const pages = Math.max(1, Math.ceil(page.total / page.size));
  const q = st.jQuery;
  const filters = `<div class="jr-filters"><select data-map="j-cat" aria-label="${esc(s.col.type)}"><option value="">${esc(s.anyCategory)}</option>${FEATURE_CATEGORIES.map((c) => `<option value="${c}" ${q.category === c ? 'selected' : ''}>${esc(s.categories[c])} (${String(map.categories[c])})</option>`).join('')}</select><select data-map="j-lane" aria-label="${esc(s.col.layer)}"><option value="">${esc(s.anyLane)}</option>${FEATURE_LANES.map((l) => `<option value="${l}" ${q.lane === l ? 'selected' : ''}>${esc(s.lanes[l][0])}</option>`).join('')}</select><select data-map="j-status" aria-label="${esc(s.col.status)}"><option value="">${esc(s.anyStatus)}</option>${(['CONFIRMED', 'PROBABLE', 'UNKNOWN'] as const).map((c) => `<option value="${c}" ${q.status === c ? 'selected' : ''}>${esc(s.conf[c] ?? c)} (${String(map.statuses[c])})</option>`).join('')}</select><input type="search" data-map="j-q" value="${esc(q.q ?? '')}" placeholder="${esc(s.search)}" aria-label="${esc(s.search)}"></div>`;
  const offset = (page.page - 1) * page.size;
  const rows = page.items
    .map(
      (r: FeatureMapRelation, i) =>
        `<tr${r.from === st.jSelect || r.to === st.jSelect ? ' class="sel"' : ''}><td class="mu">${String(offset + i + 1)}</td><td><span class="jr-ct c-${r.category.toLowerCase()}">${icon(CAT_ICON[r.category])}${esc(s.categories[r.category])}</span></td><td><button class="lnk" data-action="map-j-item" data-item="${esc(r.from)}">${esc(r.fromName)}</button><small class="mu">${esc(s.lanes[r.fromLane][0])} · ${esc(s.groups[r.fromGroup])}</small></td><td aria-hidden="true">→</td><td><button class="lnk" data-action="map-j-item" data-item="${esc(r.to)}">${esc(r.toName)}</button><small class="mu">${esc(s.lanes[r.toLane][0])} · ${esc(s.groups[r.toGroup])}</small></td><td>${h.conf(r.status)}</td><td>${h.evidence(r.evidence) || `<span class="mu small">${esc(s.noEvidence)}</span>`}</td></tr>`,
    )
    .join('');
  const pager =
    pages > 1
      ? `<div class="jr-pager"><button class="btn small" data-action="map-j-page" data-page="${String(page.page - 1)}" ${page.page <= 1 ? 'disabled' : ''}>${esc(s.prev)}</button><span>${esc(s.page(page.page, pages))}</span><button class="btn small" data-action="map-j-page" data-page="${String(page.page + 1)}" ${page.page >= pages ? 'disabled' : ''}>${esc(s.next)}</button></div>`
      : '';
  return `${filters}${rows ? `<div class="jr-tw"><table class="jr-t"><thead><tr><th>${esc(s.col.n)}</th><th>${esc(s.col.type)}</th><th>${esc(s.col.source)}</th><th></th><th>${esc(s.col.target)}</th><th>${esc(s.col.status)}</th><th>${esc(s.col.proof)}</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<p class="mu">${esc(s.noRelations)}</p>`}${pager}`;
}

function conditionsTable(s: JourneyStrings, map: FeatureMap, h: JourneyHelpers): string {
  if (map.conditions.length === 0) return `<p class="mu">${esc(s.noConditions)}</p>`;
  return `<div class="jr-tw"><table class="jr-t"><thead><tr><th>${esc(s.col.element)}</th><th>${esc(s.col.aspect)}</th><th>${esc(s.col.expression)}</th><th>${esc(s.col.decision)}</th><th>${esc(s.col.status)}</th></tr></thead><tbody>${map.conditions.map((c) => `<tr><td><button class="lnk" data-action="map-j-item" data-item="${esc(c.element.id)}">${esc(c.element.name)}</button></td><td>${esc(aspectLabel(s, c))}</td><td><code>${esc(c.expression)}</code></td><td>${c.decision ? `<code>${esc(c.decision)}</code>` : `<span class="mu small">${esc(c.undetermined ?? s.noDecision)}</span>`}</td><td>${h.conf(c.status)}</td></tr>`).join('')}</tbody></table></div>`;
}

function itemsTable(s: JourneyStrings, list: readonly FeatureMapItem[], empty: string): string {
  if (list.length === 0) return `<p class="mu">${esc(empty)}</p>`;
  return `<div class="jr-tw"><table class="jr-t"><thead><tr><th>${esc(s.col.layer)}</th><th>${esc(s.col.group)}</th><th>${esc(s.col.element)}</th><th>${esc(s.col.detail)}</th><th>${esc(s.col.count)}</th></tr></thead><tbody>${list.map((i) => `<tr><td>${esc(s.lanes[i.lane][0])}</td><td>${esc(s.groups[i.group])}</td><td><button class="lnk" data-action="map-j-item" data-item="${esc(i.id)}">${esc(i.label ?? i.name)}</button></td><td>${i.sub ? `<code>${esc(i.sub)}</code>` : ''}</td><td>${i.links === 0 ? `<span class="warn-t">${esc(s.isolated)}</span>` : String(i.links)}</td></tr>`).join('')}</tbody></table></div>`;
}

/** Les étapes du flux de données : les groupes reliés par des flux ou de la persistance, dans l'ordre des couches. */
function flowChain(s: JourneyStrings, map: FeatureMap): string {
  const flows = map.bundles.filter((b) => b.category === 'DATA' || b.category === 'PERSISTENCE');
  if (flows.length === 0) return `<p class="mu small">${esc(s.noFlow)}</p>`;
  const steps: { lane: FeatureLane; group: FeatureGroup }[] = [];
  const add = (lane: FeatureLane, group: FeatureGroup): void => {
    if (!steps.some((x) => x.lane === lane && x.group === group)) steps.push({ lane, group });
  };
  for (const b of flows) {
    add(b.fromLane, b.fromGroup);
    add(b.toLane, b.toGroup);
  }
  // Une ligne par couche, dans l'ordre fixe des couches ; les groupes de la couche à la suite.
  const rows = FEATURE_LANES.map((lane) => ({ lane, groups: steps.filter((x) => x.lane === lane) })).filter(
    (r) => r.groups.length > 0,
  );
  return `<ol class="jr-flow">${rows.map((r) => `<li class="l-${r.lane.toLowerCase()}"><small>${esc(s.lanes[r.lane][0])}</small><span>${r.groups.map((x) => `<i>${icon(GROUP_ICON[x.group] ?? 'cube')}${esc(s.groups[x.group])}</i>`).join('<b aria-hidden="true">→</b>')}</span></li>`).join('')}</ol>`;
}

function bundlesList(s: JourneyStrings, list: readonly FeatureMapBundle[]): string {
  return list.length
    ? `<ul class="jr-bl">${list.map((b) => `<li><button class="lnk" data-action="map-j-bundle" data-cat="${b.category}" data-lane="${b.fromLane}">${esc(`${s.groups[b.fromGroup]} (${s.lanes[b.fromLane][0]}) → ${s.groups[b.toGroup]} (${s.lanes[b.toLane][0]})`)}</button><b>${String(b.count)}</b></li>`).join('')}</ul>`
    : '';
}

function gapsPanel(s: JourneyStrings, map: FeatureMap): string {
  if (map.gaps.length === 0) return `<p class="mu small">${esc(s.noGaps)}</p>`;
  return `<ul class="jr-gaps">${map.gaps
    .map(
      (g) =>
        `<li class="g-${g.code.toLowerCase()}"><b>${esc(s.gaps[g.code] ?? g.code)}${g.lane ? ` · ${esc(s.lanes[g.lane][0])}` : ''}</b><span>${esc(g.detail)}</span>${
          g.items.length
            ? `<ul>${g.items
                .slice(0, 8)
                .map((x) => `<li>${esc(x)}</li>`)
                .join(
                  '',
                )}${g.items.length > 8 ? `<li class="mu">${esc(s.more(g.items.length - 8))}</li>` : ''}</ul>`
            : ''
        }</li>`,
    )
    .join('')}</ul>`;
}

function overview(s: JourneyStrings, map: FeatureMap, h: JourneyHelpers): string {
  const lanes = map.lanes
    .map((l) => {
      const [title] = s.lanes[l.lane];
      const total = l.groups.reduce((sum, g) => sum + g.count, 0);
      return `<section class="jr-ov l-${l.lane.toLowerCase()}"><h3>${icon(LANE_ICON[l.lane])}${esc(title)}</h3><p class="mu small">${esc(l.present ? s.overviewItems(total) : s.laneAbsent)}</p><ul>${l.groups.map((g) => `<li><span>${esc(s.groups[g.group])}</span><b>${String(g.count)}</b></li>`).join('')}</ul></section>`;
    })
    .join('');
  const levels = (['CONFIRMED', 'PROBABLE', 'UNKNOWN'] as const)
    .map((c) => `<li>${h.conf(c)}<b>${String(map.statuses[c])}</b></li>`)
    .join('');
  return `<div class="jr-overview"><h3>${esc(s.overviewTitle)}</h3><div class="jr-ovg">${lanes}</div><div class="jr-ov2"><section><h3>${esc(s.statusTitle)}</h3><ul class="jr-lv">${levels}</ul></section><section><h3>${esc(s.gapsTitle)}</h3>${gapsPanel(s, map)}</section></div></div>`;
}

function bottom(s: JourneyStrings, map: FeatureMap, st: JourneyState, h: JourneyHelpers): string {
  const stores = map.items.filter((i) => i.group === 'STORE');
  const calls = map.items.filter((i) =>
    [
      'SPA_SERVICE',
      'CONTROLLER',
      'ENDPOINT',
      'CONTRACT',
      'SERVICE',
      'RULE',
      'CLIENT',
      'EXTERNAL_CALL',
    ].includes(i.group),
  );
  const dataCount = map.categories.DATA + map.categories.PERSISTENCE;
  const counts: Record<JourneyBottom, number> = {
    links: map.relationCount,
    rules: map.conditions.length,
    stores: new Set(stores.map((i) => i.card)).size,
    calls: calls.length,
    data: dataCount,
    evidence: map.relationCount,
  };
  const tabs = `<div class="tabs jr-btabs" role="tablist">${(['links', 'rules', 'stores', 'calls', 'data', 'evidence'] as const).map((b) => `<button role="tab" data-action="map-j-bottom" data-tab="${b}" aria-selected="${String(st.jBottom === b)}">${esc(s.bottoms[b](counts[b]))}</button>`).join('')}</div>`;
  let body: string;
  if (st.jBottom === 'rules') body = conditionsTable(s, map, h);
  else if (st.jBottom === 'stores')
    body = stores.length
      ? itemsTable(s, stores, s.noStores)
      : `<p class="mu">${esc(s.noStores)}</p>${gapsPanel(s, { ...map, gaps: map.gaps.filter((g) => g.code === 'NO_STORE') })}`;
  else if (st.jBottom === 'calls') body = itemsTable(s, calls, s.noCalls);
  else if (st.jBottom === 'data')
    body = `${flowChain(s, map)}${bundlesList(
      s,
      map.bundles.filter((b) => b.category === 'DATA' || b.category === 'PERSISTENCE'),
    )}`;
  else body = relationsTable(s, map, st, h);
  const rules = map.conditions.slice(0, 4);
  const side = `<aside class="jr-side"><section><h3>${icon('check')}${esc(s.rulesTitle)}</h3>${rules.length ? `<ul class="jr-rules">${rules.map((c) => `<li><span class="jr-rk">${esc(aspectLabel(s, c))} :</span> <code>${esc(c.expression)}</code>${c.decision ? `<small>→ ${esc(c.decision)}</small>` : ''}</li>`).join('')}</ul>` : `<p class="mu small">${esc(s.noConditions)}</p>`}</section><section><h3>${icon('data')}${esc(s.flowTitle)}</h3>${flowChain(s, map)}</section></aside>`;
  return `<div class="jr-bottom"><div class="jr-bmain">${tabs}<div class="jr-bbody">${body}</div></div>${side}</div>`;
}

export function journeyTab(st: JourneyState, h: JourneyHelpers): string {
  const s = journeyStrings(h.locale);
  const map = st.jMap;
  if (!h.feature && h.features.length === 0)
    return `<section class="card msg"><p class="mu">${esc(s.noFeature)}</p></section>`;
  if (!map || map.feature.id !== h.feature)
    return `<section class="card jr">${featurePicker(s, undefined, h)}${h.paneError(h.error)}${h.error ? '' : h.spinner()}</section>`;
  const views = `<div class="tabs jr-views" role="tablist" aria-label="${esc(map.feature.name)}">${JOURNEY_VIEWS.map((v) => `<button role="tab" data-action="map-j-view" data-view="${v}" aria-selected="${String(st.jView === v)}">${esc(s.views[v])}</button>`).join('')}</div>`;
  const selected = st.jSelect ? map.items.find((i) => i.id === st.jSelect) : undefined;
  const near = selected ? neighbourSet(map, selected.id) : undefined;
  const aside = `<aside class="jr-aside"><section><h3>${esc(s.feature)} : ${esc(map.feature.name)}</h3>${treeView(map.tree, st, map)}</section>${categoryList(s, map, st)}</aside>`;
  const focusNote = selected
    ? `<p class="jr-focus" role="status">${icon('target')}<span>${esc(s.focusNote(selected.label ?? selected.name))}</span><button class="lnk" data-action="map-j-clear">${esc(s.clear)}</button></p>`
    : '';
  const center =
    st.jView === 'overview'
      ? overview(s, map, h)
      : `<div class="jr-gh"><h3>${icon('play')}${esc(s.journeyTitle)}</h3>${toolbar(s, st)}</div>${focusNote}${map.truncated ? `<p class="map-note warn-t">${esc(s.truncated)}</p>` : ''}<div class="jr-canvas" data-jr-canvas>${lanesGraph(s, map, st, near)}</div>`;
  const loading = h.loading ? `<span class="spin jr-busy" aria-label="${esc(s.loading)}"></span>` : '';
  return `<section class="card jr${st.jFull ? ' full' : ''}" data-jr><div class="jr-head">${featurePicker(s, map, h)}${loading}${kpis(s, map)}</div>${views}${h.paneError(h.error)}<div class="jr-body">${aside}<div class="jr-main">${center}</div></div>${bottom(s, map, st, h)}</section>`;
}

export const JOURNEY_CSS = `
.jr{display:flex;flex-direction:column;gap:12px;padding:14px}
.jr.full{position:fixed;inset:8px;z-index:60;overflow:auto;background:var(--qa-color-surface)}
.jr-head{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between}
.jr-pick{display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-weight:600}
.jr-pick>.ico{color:var(--qa-color-primary)}
.jr-pick label{display:flex;gap:6px;align-items:center}
.jr-pick select{max-width:340px;font-weight:600}
.jr-status{font-size:12px;padding:2px 9px;border-radius:999px;background:#e8f5ec;color:#1d6b3a}
.jr-status.s-candidate{background:#fdf3e2;color:#8a5a12}.jr-status.s-rejected{background:#fde8e8;color:#9b1c1c}
.jr-kpis{display:flex;flex-wrap:wrap;gap:6px}
.jr-kpi{display:flex;gap:7px;align-items:center;padding:6px 10px;border:1px solid var(--qa-color-border);border-radius:var(--qa-radius);min-width:96px;background:var(--qa-color-surface)}
.jr-kpi .ico{width:18px;height:18px;color:var(--qa-color-primary)}
.jr-kpi b{display:block;font-size:17px;line-height:1.1}.jr-kpi small{color:var(--qa-color-muted);font-size:11px}
.jr-views{flex-wrap:nowrap;overflow-x:auto;gap:4px;border-bottom:1px solid var(--qa-color-border)}
.jr-views button{white-space:nowrap;flex:none;font-weight:600}
.jr-views button[aria-selected="true"]{background:var(--qa-color-primary);color:#fff;border-radius:8px}
.jr-body{display:grid;grid-template-columns:minmax(210px,250px) minmax(0,1fr);gap:12px;align-items:start}
.jr-aside{display:flex;flex-direction:column;gap:12px;min-width:0}
.jr-aside h3,.jr-side h3,.jr-overview h3{display:flex;gap:6px;align-items:center;font-size:13.5px;margin:0 0 6px}
.jr-tree,.jr-tree ul{list-style:none;margin:0;padding:0}.jr-tree ul{padding-left:14px;border-left:1px dashed var(--qa-color-border);margin-left:8px}
.jr-tree li{display:flex;flex-wrap:wrap;align-items:center}.jr-tree li>ul{flex-basis:100%}
.jr-tg,.jr-tg-sp{width:18px;height:18px;border:0;background:none;padding:0;display:inline-flex;align-items:center;justify-content:center;flex:none}
.jr-tg .ico{width:12px;height:12px}
.jr-tn{display:inline-flex;gap:6px;align-items:center;border:0;background:none;padding:3px 6px;border-radius:6px;text-align:left;font-size:13px;min-width:0;max-width:100%}
.jr-tn span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.jr-tn .ico{width:14px;height:14px;flex:none;color:var(--qa-color-muted)}
.jr-tn.k-button .ico{color:#2f7d4f}.jr-tn.sel{background:#e3f4e8;font-weight:700}.jr-tn.zero span{text-decoration:underline dotted}
.jr-links ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.jr-cat{display:flex;gap:7px;align-items:center;width:100%;border:0;background:none;padding:4px 6px;border-radius:6px;font-size:13px;text-align:left}
.jr-cat span{flex:1 1 auto}.jr-cat b{font-variant-numeric:tabular-nums}.jr-cat.on{background:#e3f4e8;font-weight:700}
.jr-cat .ico{width:15px;height:15px}
.c-contains .ico{color:#7a3fd1}.c-condition .ico{color:#d97a0a}.c-depends .ico{color:#2f6fd1}.c-calls .ico{color:#2f7d4f}.c-data .ico{color:#0f8a8a}.c-persistence .ico{color:#b0661a}.c-external .ico{color:#2f6fd1}
.jr-main{min-width:0;display:flex;flex-direction:column;gap:8px}
.jr-gh{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between}
.jr-gh h3{display:flex;gap:6px;align-items:center;margin:0;font-size:15px}.jr-gh h3 .ico{color:var(--qa-color-primary)}
.jr-tools{display:flex;gap:4px;align-items:center}.jr-zoom{min-width:48px;text-align:center;font-size:12.5px}
.jr-focus{display:flex;gap:6px;align-items:center;margin:0;font-size:12.5px;color:var(--qa-color-muted)}
.jr-canvas{overflow:auto;border:1px solid var(--qa-color-border);border-radius:var(--qa-radius);padding:10px;max-height:calc(100vh - 60px);background:var(--qa-color-surface)}
.jr.full .jr-canvas{max-height:none}
.jr-lanes{display:flex;align-items:stretch;gap:0;width:100%;min-width:954px}
.jr-lane{flex:1 1 0;min-width:180px;max-width:290px;border-radius:12px;padding:8px;display:flex;flex-direction:column;gap:6px;border:1px solid}
.jr-lane header{display:flex;gap:8px;align-items:center;justify-content:center;text-align:center}
.jr-lane header .ico{width:22px;height:22px}
.jr-lane h3{margin:0;font-size:14.5px}.jr-lane header small{color:var(--qa-color-muted);font-size:11.5px}
.l-frontend{background:#f4effc;border-color:#ddd0f6}.l-frontend header .ico{color:#c0392b}
.l-bff{background:#ecf4fd;border-color:#c8dcf4}.l-bff header .ico{color:#2f6fd1}
.l-backend{background:#ecf8f0;border-color:#c6e7d2}.l-backend header .ico{color:#2f7d4f}
.l-external{background:#fdf3e7;border-color:#f2d6b0}.l-external header .ico{color:#d97a0a}
.jr-lane.empty{opacity:.75}.jr-absent{margin:auto 0;text-align:center;color:var(--qa-color-muted);font-size:12.5px}
.jr-sec{display:flex;flex-direction:column;gap:4px;transition:opacity .15s}
.jr-sec h4{display:flex;gap:6px;align-items:center;margin:0;font-size:11.5px;text-transform:uppercase;letter-spacing:.03em;color:var(--qa-color-muted)}
.jr-sec h4 .ico{width:13px;height:13px}.jr-sec h4 i{font-style:normal;margin-left:auto}
.jr-sec.dim,.jr-card.dim{opacity:.38}
.jr-card{background:#fff;border:1px solid rgba(0,0,0,.08);border-radius:9px;box-shadow:0 1px 2px rgba(0,0,0,.04);transition:opacity .15s}
.jr-card.sel{outline:2px solid var(--qa-color-primary)}.jr-card.zero{border-style:dashed}
.jr-ch{display:flex;gap:6px;align-items:flex-start;width:100%;border:0;background:none;padding:5px 7px;text-align:left}
.jr-ch .ico{width:16px;height:16px;flex:none;margin-top:1px;color:var(--qa-color-muted)}
.jr-ch>span{display:flex;flex-direction:column;min-width:0;flex:1 1 auto}
.jr-ch b{font-size:12.5px;overflow-wrap:break-word;min-width:0}.jr-ch small{font-size:11px;color:var(--qa-color-muted);overflow-wrap:anywhere}
.jr-n{font-style:normal;font-size:10.5px;color:var(--qa-color-muted);white-space:nowrap;flex:none;display:flex;flex-direction:column;align-items:flex-end;line-height:1.25}.jr-n small{font-size:10px;color:var(--qa-color-primary)}.jr-n small.w{color:#b0661a}
.jr-ml{list-style:none;margin:0;padding:0 6px 6px 31px;display:flex;flex-direction:column;gap:1px}
.jr-m{display:flex;flex-wrap:wrap;gap:0 6px;align-items:baseline;width:100%;border:0;background:none;padding:2px 4px;border-radius:5px;text-align:left;font-size:12px}
.jr-m small{color:var(--qa-color-muted);font-size:10.5px}.jr-m em{font-style:normal;font-size:10px;color:#9b5b00}
.jr-m.sel{background:#e3f4e8;font-weight:700}.jr-m.dim{opacity:.4}.jr-m:hover,.jr-ch:hover,.jr-tn:hover{background:rgba(0,0,0,.04)}
.jr-more{font-size:11.5px;padding:0 8px 6px 31px;margin-top:-3px}.jr-more em{font-style:normal;color:#9b5b00}
.jr-hidden{margin:2px 4px 0;font-size:11px;color:var(--qa-color-muted)}
.jr-persist{border:1px dashed #b0661a;border-radius:9px;padding:6px;display:flex;flex-direction:column;gap:6px;background:rgba(255,255,255,.5)}
.jr-ph{display:flex;gap:6px;align-items:center;margin:0;font-size:12px;color:#8a4d10}
.jr-inner{font-size:11.5px;color:var(--qa-color-muted);display:flex;flex-wrap:wrap;gap:4px;margin-top:auto}
.jr-inner .lnk{font-size:11.5px}
.jr-conn{flex:none;width:78px;display:flex;flex-direction:column;justify-content:center;align-items:center;gap:6px;padding:0 6px;position:relative}
.jr-arrow{width:100%;height:2px;background:#5d6b7a;position:relative;margin-bottom:4px}
.jr-arrow::after{content:"";position:absolute;right:-1px;top:-4px;border:5px solid transparent;border-left:8px solid #5d6b7a;border-right:0}
.jr-arrow.off{background:repeating-linear-gradient(90deg,#b8c0c8 0 5px,transparent 5px 9px)}.jr-arrow.off::after{border-left-color:#b8c0c8}
.jr-pill{display:flex;flex-wrap:wrap;gap:3px 5px;align-items:center;justify-content:center;width:100%;border:1px solid var(--qa-color-border);background:#fff;border-radius:999px;padding:3px 8px;font-size:11.5px}
.jr-pill .ico{width:13px;height:13px}.jr-pill b{font-variant-numeric:tabular-nums}.jr-pill small{flex-basis:100%;text-align:center;font-size:10px;color:var(--qa-color-muted)}
.jr-pill.weak{border-style:dashed}.jr-pill.on{border-color:var(--qa-color-primary);background:#e3f4e8;font-weight:700}
.jr-bottom{display:grid;grid-template-columns:minmax(0,1fr) minmax(220px,300px);gap:12px;align-items:start}
.jr-bmain{min-width:0;border:1px solid var(--qa-color-border);border-radius:var(--qa-radius);padding:8px}
.jr-btabs{flex-wrap:nowrap;overflow-x:auto;gap:4px;margin-bottom:8px}.jr-btabs button{white-space:nowrap;flex:none}
.jr-btabs button[aria-selected="true"]{background:var(--qa-color-primary);color:#fff;border-radius:8px}
.jr-filters{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}.jr-filters input{flex:1 1 180px;min-width:0}
.jr-tw{overflow-x:auto}
.jr-t{width:100%;border-collapse:collapse;font-size:12.5px}
.jr-t th{text-align:left;font-size:11px;text-transform:uppercase;color:var(--qa-color-muted);padding:5px 6px;border-bottom:1px solid var(--qa-color-border)}
.jr-t td{padding:5px 6px;border-bottom:1px solid var(--qa-color-border);vertical-align:top}
.jr-t td small{display:block;font-size:10.5px}.jr-t tr.sel td{background:#f1faf3}
.jr-ct{display:inline-flex;gap:4px;align-items:center;white-space:nowrap}.jr-ct .ico{width:14px;height:14px}
.jr-pager{display:flex;gap:8px;align-items:center;justify-content:flex-end;margin-top:8px;font-size:12.5px}
.jr-side{display:flex;flex-direction:column;gap:10px;min-width:0}
.jr-side section{border:1px solid var(--qa-color-border);border-radius:var(--qa-radius);padding:8px}
.jr-rules{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:5px;font-size:12px}
.jr-rules code{overflow-wrap:anywhere}.jr-rules small{display:block;color:var(--qa-color-muted)}.jr-rk{font-weight:600}
.jr-flow{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:5px}
.jr-flow li{display:flex;flex-direction:column;gap:3px;padding:5px 7px;border-radius:8px;font-size:11.5px;border:1px solid}
.jr-flow li>span{display:flex;flex-wrap:wrap;gap:3px 5px;align-items:center}
.jr-flow i{display:inline-flex;gap:3px;align-items:center;font-style:normal}.jr-flow i .ico{width:12px;height:12px}
.jr-flow b{color:var(--qa-color-muted);font-weight:400}
.jr-flow small{color:var(--qa-color-muted);font-size:10px;text-transform:uppercase;letter-spacing:.03em}
.jr-bl{list-style:none;margin:8px 0 0;padding:0;display:flex;flex-direction:column;gap:3px;font-size:12.5px}
.jr-bl li{display:flex;gap:8px;justify-content:space-between}
.jr-gaps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px;font-size:12.5px}
.jr-gaps>li{border-left:3px solid #d97a0a;padding-left:8px;display:flex;flex-direction:column;gap:2px}
.jr-gaps ul{margin:2px 0 0;padding-left:16px;font-size:12px;color:var(--qa-color-muted)}
.jr-overview{display:flex;flex-direction:column;gap:10px}
.jr-ovg{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px}
.jr-ov{border-radius:10px;padding:10px;border:1px solid}
.jr-ov ul,.jr-lv{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:3px;font-size:12.5px}
.jr-ov li,.jr-lv li{display:flex;justify-content:space-between;gap:8px}
.jr-ov2{display:grid;grid-template-columns:minmax(160px,240px) minmax(0,1fr);gap:12px}
.jr-busy{width:16px;height:16px}
@media (max-width:1100px){.jr-body{grid-template-columns:minmax(0,1fr)}.jr-bottom{grid-template-columns:minmax(0,1fr)}.jr-ov2{grid-template-columns:minmax(0,1fr)}}
`;
