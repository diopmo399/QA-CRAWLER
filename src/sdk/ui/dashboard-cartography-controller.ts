import type {
  FeatureCategory,
  FeatureDetail,
  FeatureLane,
  FeatureMap,
  FeatureTreeNode,
  FieldRow,
  FieldSheet,
  MapDecisionInput,
  MapEdgeKind,
  MapLayer,
  MapListQuery,
  MapPage,
  MapSource,
} from '../core/cartography.js';
import {
  FEATURE_CATEGORIES,
  FEATURE_LANES,
  GIT_PROVIDERS,
  INVESTIGATION_GOALS,
  MAP_EDGE_KINDS,
  MAP_LAYERS,
  TRACE_DIRECTIONS,
  type InvestigationGoal,
} from '../core/cartography.js';
import { defaultGoal, INV_TABS, type InvTab } from './dashboard-cartography-investigation.js';
import type { QaCrawlerClient } from '../core/client.js';
import { API_TABS, type ApiTab } from './dashboard-cartography-apis.js';
import { readIds } from './dashboard-cartography-graph.js';
import { explainSaveError, issueCount, sourceIssues } from './dashboard-cartography-scan.js';
import {
  BOTTOM_TABS,
  SHEET_TABS,
  STRUCT_TABS,
  type BottomTab,
  type SheetTab,
  type StructTab,
} from './dashboard-cartography-structure.js';
import { mapStrings } from './dashboard-cartography-i18n.js';
import {
  JOURNEY_BOTTOMS,
  JOURNEY_VIEWS,
  VIEW_PRESET,
  type JourneyBottom,
  type JourneyView,
} from './dashboard-cartography-journey.js';
import {
  CENTER_TABS,
  emptyCartographyUi,
  MAP_TABS,
  type CartographyUi,
  type CenterTab,
  type ListCriteria,
  type MapPane,
  type MapTab,
} from './dashboard-cartography.js';
import type { DashboardRoute, DashboardState } from './dashboard-view.js';

/**
 * Les branches de l'arbre à replier quand `id` est choisi : toutes celles qui ont des enfants, sauf le
 * chemin qui mène à `id` (et `id` lui-même). Si `id` n'est pas dans l'arbre, l'arbre reste tel quel.
 */
export function foldTree(tree: readonly FeatureTreeNode[], id: string, current: readonly string[]): string[] {
  const path: string[] = [];
  const find = (nodes: readonly FeatureTreeNode[]): boolean =>
    nodes.some((n) => {
      path.push(n.id);
      if (n.id === id || find(n.children)) return true;
      path.pop();
      return false;
    });
  if (!find(tree)) return [...current];
  const keep = new Set(path);
  const closed: string[] = [];
  const walk = (nodes: readonly FeatureTreeNode[]): void => {
    for (const n of nodes) {
      if (n.children.length > 0 && !keep.has(n.id)) closed.push(n.id);
      walk(n.children);
    }
  };
  walk(tree);
  return closed;
}

/** Les critères du tableau des relations, sans les valeurs vides (la clé de cache reste stable). */
const compactQuery = (q: CartographyUi['jQuery']): CartographyUi['jQuery'] => ({
  ...(q.category ? { category: q.category } : {}),
  ...(q.lane ? { lane: q.lane } : {}),
  ...(q.status ? { status: q.status } : {}),
  ...(q.item ? { item: q.item } : {}),
  ...(q.q ? { q: q.q } : {}),
  ...(q.page ? { page: q.page } : {}),
  ...(q.size ? { size: q.size } : {}),
});

/**
 * LE CONTRÔLEUR DE LA CARTOGRAPHIE, EN EXPLORATION PROGRESSIVE. Au premier affichage : le résumé et une
 * page de fonctionnalités. Une fonctionnalité choisie : sa fiche et une page de ses champs. Un champ choisi :
 * sa seule fiche. Chaque zone a sa requête : une nouvelle sélection ANNULE la précédente (rien d'obsolète
 * n'est affiché), et les réponses déjà lues pour ce scan sont gardées (cache vidé à chaque nouveau scan
 * ou décision). Aucune donnée n'est fabriquée ici : tout vient des réponses du serveur.
 */
export interface CartographyHost {
  readonly root: ShadowRoot;
  readonly state: DashboardState;
  api(): QaCrawlerClient | undefined;
  paint(): void;
  navigate(route: DashboardRoute): void;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const aborted = (error: unknown): boolean => (error as { code?: string } | undefined)?.code === 'ABORTED';
const CACHE_MAX = 40;

export class CartographyController {
  private pollTimer?: ReturnType<typeof setTimeout>;
  private searchTimer?: ReturnType<typeof setTimeout>;
  private readonly inflight = new Map<MapPane, AbortController>();
  /** Le projet affiché : un autre projet repart d'un état vide. */
  private projectOfState?: string;
  /**
   * Les fiches et les pages de champs déjà lues, valables pour une version des données (nouveau scan,
   * décision : nouvelle version) : revenir sur une fonctionnalité visitée ne relit rien.
   */
  private readonly cache = new Map<string, FeatureDetail | FieldSheet | MapPage<FieldRow> | FeatureMap>();
  private version = 0;

  constructor(private readonly host: CartographyHost) {}

  private get ui(): CartographyUi {
    this.host.state.map ??= emptyCartographyUi();
    return this.host.state.map;
  }

  private get projectId(): string | undefined {
    const route = this.host.state.route;
    return route.view === 'cartography' ? route.projectId : undefined;
  }

  private remember<T extends FeatureDetail | FieldSheet | MapPage<FieldRow> | FeatureMap>(
    key: string,
    value: T,
  ): T {
    this.cache.delete(key);
    if (this.cache.size >= CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, value);
    return value;
  }

  /** Les données ont changé (scan, décision) : le cache local ne sert plus. */
  private invalidate(): void {
    this.version += 1;
    this.cache.clear();
    // Le catalogue des API et la fiche choisie sont relus (la sélection est gardée).
    if (this.host.state.map) {
      this.host.state.map.apis = undefined;
      this.host.state.map.apiSheet = undefined;
      this.host.state.map.structure = undefined;
      this.host.state.map.elementSheet = undefined;
      this.host.state.map.conditionsPage = undefined;
      this.host.state.map.actionsPage = undefined;
    }
  }

  /**
   * Une requête d'une zone : la précédente de la même zone est annulée ; l'état de chargement et l'erreur
   * sont ceux de la zone. Une réponse arrivée après une autre sélection n'est jamais affichée.
   */
  private async fetch<T>(
    pane: MapPane,
    run: (api: QaCrawlerClient, projectId: string, signal: AbortSignal) => Promise<T>,
  ): Promise<T | undefined> {
    const api = this.host.api();
    const projectId = this.projectId;
    if (!api || !projectId) return undefined;
    this.inflight.get(pane)?.abort();
    const controller = new AbortController();
    this.inflight.set(pane, controller);
    this.ui.loading[pane] = true;
    this.ui.errors[pane] = undefined;
    try {
      const value = await run(api, projectId, controller.signal);
      return controller.signal.aborted || this.projectId !== projectId ? undefined : value;
    } catch (error) {
      if (!aborted(error) && !controller.signal.aborted) this.ui.errors[pane] = message(error);
      return undefined;
    } finally {
      if (this.inflight.get(pane) === controller) {
        this.inflight.delete(pane);
        this.ui.loading[pane] = false;
      }
    }
  }

  private query(criteria: ListCriteria): MapListQuery {
    return {
      ...(criteria.q.trim() ? { q: criteria.q.trim() } : {}),
      ...(criteria.module ? { module: criteria.module } : {}),
      ...(criteria.layer ? { layer: criteria.layer } : {}),
      ...(criteria.status ? { status: criteria.status } : {}),
      ...(criteria.coverage ? { coverage: criteria.coverage } : {}),
      ...(criteria.type ? { type: criteria.type } : {}),
      ...(criteria.sort ? { sort: criteria.sort } : {}),
      page: criteria.page,
      size: criteria.size,
    };
  }

  /**
   * Le premier affichage : le résumé, une page de fonctionnalités ; la sélection gardée est relue.
   * `progress` est appelé à chaque étape montrable (résumé, puis liste) pour un affichage progressif.
   */
  async load(
    api: QaCrawlerClient,
    projectId: string,
    current: () => boolean,
    progress: () => void = () => undefined,
  ): Promise<void> {
    if (this.projectOfState !== projectId) {
      const tab = this.ui.tab;
      this.host.state.map = { ...emptyCartographyUi(), tab };
      this.projectOfState = projectId;
      this.invalidate();
    }
    const [summary, scenarios] = await Promise.all([
      api.cartography.summary(projectId),
      api.scenarios.list(projectId).catch(() => []),
    ]);
    if (!current()) return;
    if (summary.scan?.id !== this.ui.summary?.scan?.id) this.invalidate();
    this.ui.summary = summary;
    this.ui.scenarios = scenarios;
    this.ui.errors.summary = undefined;
    if (this.ui.sources && summary.config.updatedAt !== this.ui.summary.config.updatedAt)
      this.ui.sources = undefined;
    if (summary.running) this.poll(projectId);
    if (!summary.scan) return;
    progress();
    await this.loadFeatures();
    if (!current()) return;
    progress();
    // Une fonctionnalité est montrée d'emblée (la première de la page) : sa fiche et une page de ses champs.
    if (!this.ui.feature && this.ui.features?.items[0]) this.ui.feature = this.ui.features.items[0].id;
    await Promise.all([this.loadDetail(), this.loadFields(), this.loadSheet(), this.loadTab()]);
  }

  private async reloadAll(): Promise<void> {
    const api = this.host.api();
    const projectId = this.projectId;
    if (!api || !projectId) return;
    try {
      await this.load(api, projectId, () => this.projectId === projectId);
    } catch (error) {
      this.ui.error = message(error);
    }
    this.host.paint();
  }

  private async loadFeatures(): Promise<void> {
    const page = await this.fetch('features', (api, id, signal) =>
      api.cartography.features(id, this.query(this.ui.featureCriteria), { signal }),
    );
    if (page) {
      this.ui.features = page;
      this.ui.featureCriteria.page = page.page;
    }
  }

  private async loadDetail(): Promise<void> {
    const feature = this.ui.feature;
    if (!feature) {
      this.ui.detail = undefined;
      return;
    }
    const key = `${String(this.version)}|feature|${feature}`;
    const cached = this.cache.get(key) as FeatureDetail | undefined;
    if (cached) {
      this.ui.detail = cached;
      return;
    }
    if (this.ui.detail?.feature.id !== feature) this.ui.detail = undefined;
    const detail = await this.fetch('detail', (api, id, signal) =>
      api.cartography.feature(id, feature, { signal }),
    );
    if (detail && this.ui.feature === feature) this.ui.detail = this.remember(key, detail);
  }

  private async loadFields(): Promise<void> {
    const feature = this.ui.feature;
    if (!feature) {
      this.ui.fields = undefined;
      return;
    }
    // La clé couvre la version des données, la fonctionnalité et toute la requête (recherche, tri, page).
    const key = `${String(this.version)}|fields|${feature}|${JSON.stringify(this.query(this.ui.fieldCriteria))}`;
    const cached = this.cache.get(key) as MapPage<FieldRow> | undefined;
    const page =
      cached ??
      (await this.fetch('fields', (api, id, signal) =>
        api.cartography.featureFields(id, feature, this.query(this.ui.fieldCriteria), { signal }),
      ));
    if (page && !cached && this.ui.feature === feature) this.remember(key, page);
    if (page && this.ui.feature === feature) {
      this.ui.fields = page;
      this.ui.fieldCriteria.page = page.page;
      // Le premier champ est montré d'emblée, sauf si un autre est déjà choisi dans cette fonctionnalité.
      if (!this.ui.field && page.items[0]) {
        this.ui.field = page.items[0].id;
        await this.loadSheet();
      }
    }
  }

  private async loadSheet(): Promise<void> {
    const field = this.ui.field;
    if (!field) {
      this.ui.sheet = undefined;
      return;
    }
    const feature = this.ui.feature;
    const key = `${String(this.version)}|field|${feature ?? ''}|${field}`;
    const cached = this.cache.get(key) as FieldSheet | undefined;
    const sheet =
      cached ??
      (await this.fetch('sheet', (api, id, signal) =>
        api.cartography.field(
          id,
          field,
          { ...(feature ? { feature } : {}), depth: 1, limit: 60 },
          { signal },
        ),
      ));
    if (sheet && this.ui.field === field) {
      if (this.ui.sheet?.node.id !== sheet.node.id) this.resetGraph();
      this.ui.sheet = cached ? sheet : this.remember(key, sheet);
      this.ui.expansion = undefined;
      // Une proposition : les scénarios dont l'impact est démontré sont cochés ; rien n'est lancé.
      this.ui.fieldPicked = [...sheet.impact.demonstrated.scenarios];
    }
  }

  private async loadConcepts(): Promise<void> {
    const page = await this.fetch('concepts', (api, id, signal) =>
      api.cartography.concepts(id, this.query(this.ui.conceptCriteria), { signal }),
    );
    if (page) {
      this.ui.concepts = page;
      this.ui.conceptCriteria.page = page.page;
    }
  }

  private async loadIssues(): Promise<void> {
    const page = await this.fetch('issues', (api, id, signal) =>
      api.cartography.issues(id, { page: this.ui.issuesPage, size: 20 }, { signal }),
    );
    if (page) {
      this.ui.issues = page;
      this.ui.issuesPage = page.page;
    }
  }

  private async loadConceptSheet(): Promise<void> {
    const concept = this.ui.concept;
    if (!concept) return;
    // L'identifiant d'un concept est celui de son champ de départ, préfixé.
    const node = concept.replace(/^CONCEPT:/, '');
    const sheet = await this.fetch('conceptSheet', (api, id, signal) =>
      api.cartography.field(id, node, { depth: 1, limit: 60 }, { signal }),
    );
    if (sheet && this.ui.concept === concept) this.ui.conceptSheet = sheet;
  }

  /** Ce que l'onglet affiché demande de plus (et seulement lui). */
  private async loadApis(): Promise<void> {
    const ui = this.ui;
    const catalog = await this.fetch('apis', (api, id, signal) =>
      api.cartography.apis(
        id,
        { ...this.query(ui.apiCriteria), ...(ui.apiScope ? { scope: ui.apiScope } : {}) },
        { signal },
      ),
    );
    if (!catalog) return;
    ui.apis = catalog;
    ui.apiCriteria.page = catalog.page;
    // La première API de la page est montrée d'emblée, sauf si une autre est déjà choisie.
    if (!ui.api && catalog.items[0]) ui.api = catalog.items[0].id;
  }

  private async loadApiSheet(): Promise<void> {
    const id = this.ui.api;
    if (!id) {
      this.ui.apiSheet = undefined;
      return;
    }
    const sheet = await this.fetch('apiSheet', (api, projectId, signal) =>
      api.cartography.api(projectId, id, { signal }),
    );
    if (sheet && this.ui.api === id) {
      this.ui.apiSheet = sheet;
      // Une proposition : les scénarios dont l'impact est prouvé sont cochés ; rien n'est lancé.
      this.ui.apiPicked = [...sheet.impact.demonstrated.scenarios];
    }
  }

  /** Structure & Conditions : l'arbre (fonctionnalité choisie ou projet entier). */
  private async loadStructure(): Promise<void> {
    const feature = this.ui.structFeature;
    const structure = await this.fetch('structure', (api, id, signal) =>
      api.cartography.structure(id, feature || undefined, { signal }),
    );
    if (structure && this.ui.structFeature === feature) this.ui.structure = structure;
  }

  private async loadElement(): Promise<void> {
    const id = this.ui.element;
    if (!id) {
      this.ui.elementSheet = undefined;
      return;
    }
    const sheet = await this.fetch('element', (api, projectId, signal) =>
      api.cartography.element(projectId, id, { signal }),
    );
    if (sheet && this.ui.element === id) this.ui.elementSheet = sheet;
  }

  /** Le parcours de l'élément (ou du point recentré) dans le sens et selon les critères choisis. */
  private async loadTrace(): Promise<void> {
    const ui = this.ui;
    const id = ui.traceFrom ?? ui.element;
    const direction = ui.traceDir;
    if (!id || direction === 'SHEET') return;
    const layers = [...ui.traceLayers];
    const kinds = [...ui.traceKinds];
    const trace = await this.fetch('trace', (api, projectId, signal) =>
      api.cartography.trace(projectId, id, { direction, layers, kinds }, { signal }),
    );
    if (trace && (ui.traceFrom ?? ui.element) === id && ui.traceDir === direction) ui.trace = trace;
  }

  /** Les investigations enregistrées du projet (pour les reprendre). */
  private async loadInvestigations(): Promise<void> {
    const list = await this.fetch('investigation', (api, projectId, signal) =>
      api.cartography.investigations(projectId, { signal }),
    );
    if (list) this.ui.invList = list;
  }

  /** Une étape d'investigation (lancer, reprendre une branche, relancer, relire) : son résultat remplace le précédent. */
  private investigationStep(
    run: (
      api: NonNullable<ReturnType<CartographyHost['api']>>,
      projectId: string,
      signal: AbortSignal,
    ) => Promise<NonNullable<CartographyUi['inv']>>,
  ): void {
    const ui = this.ui;
    void this.run(async () => {
      const inv = await this.fetch('investigation', run);
      if (inv) {
        ui.inv = inv;
        ui.invPath = undefined;
        ui.invTab = inv.breaks.length ? 'breaks' : inv.frontier.length ? 'frontier' : 'hypotheses';
        await this.loadInvestigations();
      }
    }).then(() => {
      this.host.root.querySelector<HTMLElement>('[data-inv-modal]')?.focus();
    });
  }

  /** Recharger le parcours puis ajuster le graphe à la zone (sens, critères ou point de départ changés). */
  private reloadTrace(): void {
    this.ui.trace = undefined;
    this.ui.graphSel = undefined;
    this.ui.lnCards = [];
    this.ui.lnBundles = [];
    this.ui.autoFit = true;
    this.host.paint();
    void this.run(() => this.loadTrace()).then(() => {
      this.fitSoon();
    });
  }

  private async loadConditions(): Promise<void> {
    const page = await this.fetch('conditions', (api, id, signal) =>
      api.cartography.conditions(id, this.query(this.ui.condCriteria), { signal }),
    );
    if (!page) return;
    this.ui.conditionsPage = page;
    this.ui.condCriteria.page = page.page;
  }

  private async loadActions(): Promise<void> {
    const page = await this.fetch('actions', (api, id, signal) =>
      api.cartography.actions(id, this.query(this.ui.actCriteria), { signal }),
    );
    if (!page) return;
    this.ui.actionsPage = page;
    this.ui.actCriteria.page = page.page;
  }

  /** L'élément choisi dans l'arbre ou une liste : sa fiche, son graphe ajusté à la zone. */
  private selectElement(id: string): void {
    const ui = this.ui;
    if (!id) return;
    if (ui.element !== id) {
      ui.element = id;
      ui.elementSheet = undefined;
      ui.traceFrom = undefined;
      ui.trace = undefined;
      ui.detailNode = undefined;
      ui.lnCards = [];
      ui.lnBundles = [];
      this.resetGraph();
    }
    ui.structTab = 'graph';
    ui.autoFit = true;
    void this.run(async () => {
      await this.loadElement();
      await this.loadTrace();
    }).then(() => {
      this.fitSoon();
    });
  }

  private async loadTab(): Promise<void> {
    if (this.ui.tab === 'structure') {
      const ui = this.ui;
      if (!ui.structure) await this.loadStructure();
      if (!ui.element) {
        // Le premier conteneur conditionnel de l'arbre est montré d'emblée (sinon le premier élément).
        const flat: { id: string; kind: string; conditional: boolean }[] = [];
        const walk = (items: NonNullable<typeof ui.structure>['roots']): void => {
          for (const item of items) {
            flat.push({ id: item.id, kind: item.kind, conditional: item.conditions.length > 0 });
            walk(item.children);
          }
        };
        walk(ui.structure?.roots ?? []);
        const pick =
          flat.find((x) => x.kind === 'CONTAINER' && x.conditional) ??
          flat.find((x) => x.kind === 'CONTAINER' || x.kind === 'BUTTON');
        if (pick) {
          ui.element = pick.id;
          ui.autoFit = true;
        }
      }
      if (ui.structTab === 'conditions' && !ui.conditionsPage) await this.loadConditions();
      if (ui.structTab === 'actions' && !ui.actionsPage) await this.loadActions();
      if (ui.element && ui.elementSheet?.element.id !== ui.element) await this.loadElement();
      if (ui.traceDir !== 'SHEET' && ui.trace?.start !== (ui.traceFrom ?? ui.element)) await this.loadTrace();
      this.fitSoon();
      return;
    }
    if (this.ui.tab === 'apis') {
      if (!this.ui.apis) await this.loadApis();
      if (this.ui.api && this.ui.apiSheet?.api.id !== this.ui.api) await this.loadApiSheet();
      return;
    }
    if (this.ui.tab === 'features' && this.ui.feature && this.ui.detail?.feature.id !== this.ui.feature) {
      // La fonctionnalité a pu changer depuis Parcours & Graphe : sa fiche et ses champs sont relus ici.
      await Promise.all([this.loadDetail(), this.loadFields()]);
      return;
    }
    if (this.ui.tab === 'journey') {
      if (!this.ui.features) await this.loadFeatures();
      if (!this.ui.feature && this.ui.features?.items[0]) this.ui.feature = this.ui.features.items[0].id;
      await this.loadJourney();
      return;
    }
    if (this.ui.tab === 'fields') {
      await Promise.all([
        this.ui.concepts ? undefined : this.loadConcepts(),
        this.ui.issues ? undefined : this.loadIssues(),
        this.ui.concept && !this.ui.conceptSheet ? this.loadConceptSheet() : undefined,
      ]);
    }
  }

  /** Parcours & Graphe : la carte de la fonctionnalité ouverte (une page de relations selon les critères). */
  private async loadJourney(): Promise<void> {
    const ui = this.ui;
    const feature = ui.feature;
    if (!feature) return;
    const query = { ...ui.jQuery };
    const key = `${String(this.version)}|journey|${feature}|${JSON.stringify(query)}`;
    const cached = this.cache.get(key) as FeatureMap | undefined;
    const map =
      cached ??
      (await this.fetch('journey', (api, id, signal) =>
        api.cartography.featureMap(id, feature, query, { signal }),
      ));
    if (!map || ui.feature !== feature || JSON.stringify(ui.jQuery) !== JSON.stringify(query)) return;
    if (!cached) this.remember(key, map);
    ui.jMap = map;
    ui.jQuery.page = map.relations.page;
    // À la première ouverture d'une fonctionnalité, les quatre couloirs sont ajustés à la zone, sans
    // descendre sous une taille lisible ni agrandir ; ensuite l'échelle ne change que sur demande.
    if (ui.jFitted !== feature) {
      ui.jFitted = feature;
      setTimeout(() => {
        this.fitJourney(true);
      }, 0);
    }
  }

  /** Relire la carte après un changement de critère (la sélection et la vue sont gardées). */
  private reloadJourney(): void {
    void this.run(() => this.loadJourney());
  }

  /**
   * Ajuster les couloirs à la zone visible, en largeur ET en hauteur. `auto` (ouverture) : le graphe est
   * d'abord amené en haut de l'écran, puis l'échelle reste entre 75 % (les cartes restent lisibles, la zone
   * défile au-delà) et 100 % ; à la demande : entre 50 et 150 %.
   */
  private fitJourney(auto = false): void {
    const canvas = this.host.root.querySelector<HTMLElement>('[data-jr-canvas]');
    const lanes = canvas?.querySelector<HTMLElement>('.jr-lanes');
    if (!canvas || !lanes) return;
    // La taille à 100 % : l'échelle (CSS zoom) réduit la mise en page, on la retire de la mesure.
    const zoom = this.ui.jZoom || 1;
    const width = lanes.scrollWidth / zoom;
    const height = lanes.scrollHeight / zoom;
    if (width <= 0 || height <= 0) return;
    // La hauteur visible sous le haut de la zone ; à l'ouverture, le titre du graphe sera en haut de l'écran.
    const head = this.host.root.querySelector<HTMLElement>('.jr-gh');
    const top = canvas.getBoundingClientRect().top - (auto && head ? head.getBoundingClientRect().top : 0);
    const room = Math.max(320, window.innerHeight - Math.max(0, top) - 16);
    const ratio = Math.floor(Math.min((canvas.clientWidth - 24) / width, (room - 24) / height) * 100) / 100;
    this.ui.jZoom = auto ? Math.max(0.75, Math.min(1, ratio)) : Math.max(0.5, Math.min(1.5, ratio));
    this.host.paint();
    // Après le rendu (qui remplace les éléments) : amener le graphe en haut de l'écran.
    if (auto) this.host.root.querySelector<HTMLElement>('.jr-gh')?.scrollIntoView({ block: 'start' });
  }

  /** Centrer la vue sur l'élément choisi (ou le début des couloirs), sans changer l'échelle. */
  private centerJourney(): void {
    const canvas = this.host.root.querySelector<HTMLElement>('[data-jr-canvas]');
    if (!canvas) return;
    const id = this.ui.jSelect;
    const target = id
      ? [...canvas.querySelectorAll<HTMLElement>('[data-action="map-j-item"]')].find(
          (el) => el.dataset.item === id,
        )
      : undefined;
    if (!target) {
      canvas.scrollTo({ left: 0, top: 0 });
      return;
    }
    const box = canvas.getBoundingClientRect();
    const at = target.getBoundingClientRect();
    canvas.scrollTo({
      left: canvas.scrollLeft + at.left - box.left - (box.width - at.width) / 2,
      top: canvas.scrollTop + at.top - box.top - (box.height - at.height) / 2,
    });
  }

  /** Une action de Parcours & Graphe (vue, onglet du bas, catégorie, faisceau, élément, page, zoom…). */
  private journeyAction(action: string, target: HTMLElement): boolean {
    const ui = this.ui;
    const query = (patch: Partial<typeof ui.jQuery>): void => {
      ui.jQuery = compactQuery({ ...ui.jQuery, ...patch, page: patch.page ?? 1 });
    };
    switch (action) {
      case 'map-j-view': {
        const view = target.dataset.view as JourneyView;
        if (!JOURNEY_VIEWS.includes(view)) return true;
        ui.jView = view;
        const preset = VIEW_PRESET[view];
        ui.jBottom = preset.bottom;
        query({ category: preset.category, lane: undefined });
        this.reloadJourney();
        return true;
      }
      case 'map-j-bottom': {
        const tab = target.dataset.tab as JourneyBottom;
        if (JOURNEY_BOTTOMS.includes(tab)) ui.jBottom = tab;
        this.host.paint();
        return true;
      }
      case 'map-j-cat': {
        const cat = target.dataset.cat as FeatureCategory | '';
        query({ category: cat && FEATURE_CATEGORIES.includes(cat) ? cat : undefined, lane: undefined });
        ui.jBottom = 'links';
        this.reloadJourney();
        return true;
      }
      case 'map-j-bundle': {
        const cat = target.dataset.cat as FeatureCategory;
        const lane = target.dataset.lane as FeatureLane;
        if (!FEATURE_CATEGORIES.includes(cat)) return true;
        query({ category: cat, lane: FEATURE_LANES.includes(lane) ? lane : undefined });
        ui.jBottom = 'links';
        this.reloadJourney();
        return true;
      }
      case 'map-j-item': {
        const id = target.dataset.item ?? '';
        const same = ui.jSelect === id;
        ui.jSelect = same ? undefined : id;
        // Voir un élément replie les autres : cartes ouvertes, cartes dépliées, branches de l'arbre hors
        // de son chemin. Le désélectionner rouvre tout.
        ui.jOpen = [];
        ui.jDetail = false;
        ui.jClosed = same ? [] : foldTree(ui.jMap?.tree ?? [], id, ui.jClosed);
        query({ item: same ? undefined : id });
        ui.jBottom = 'links';
        this.reloadJourney();
        return true;
      }
      case 'map-j-clear':
        ui.jSelect = undefined;
        ui.jOpen = [];
        ui.jClosed = [];
        query({ item: undefined, category: undefined, lane: undefined });
        this.reloadJourney();
        return true;
      case 'map-j-page':
        ui.jQuery = { ...ui.jQuery, page: Math.max(1, Number(target.dataset.page) || 1) };
        this.reloadJourney();
        return true;
      case 'map-j-zoom': {
        const dir = Number(target.dataset.dir) || 0;
        ui.jZoom = Math.max(0.5, Math.min(1.5, Math.round((ui.jZoom + dir * 0.1) * 10) / 10));
        this.host.paint();
        return true;
      }
      case 'map-j-fit':
        this.fitJourney();
        return true;
      case 'map-j-center':
        this.centerJourney();
        return true;
      case 'map-j-full':
        ui.jFull = !ui.jFull;
        this.host.paint();
        return true;
      case 'map-j-tree': {
        const node = target.dataset.node ?? '';
        ui.jClosed = ui.jClosed.includes(node) ? ui.jClosed.filter((n) => n !== node) : [...ui.jClosed, node];
        this.host.paint();
        return true;
      }
      case 'map-j-card': {
        const card = target.dataset.card ?? '';
        // Une seule carte ouverte à la fois (les groupes repliés « sec: » / « rest: » sont à part).
        const fold = (k: string): boolean => k.startsWith('sec:') || k.startsWith('rest:');
        ui.jOpen = ui.jOpen.includes(card)
          ? ui.jOpen.filter((c) => c !== card)
          : [...ui.jOpen.filter((c) => fold(card) || fold(c)), card];
        this.host.paint();
        return true;
      }
      case 'map-j-detail':
        // Déplier (ou replier) les membres de toutes les cartes ; l'échelle ne change pas.
        ui.jDetail = !ui.jDetail;
        ui.jOpen = [];
        this.host.paint();
        return true;
      default:
        return false;
    }
  }

  private async run(...steps: (() => Promise<void>)[]): Promise<void> {
    this.host.paint();
    for (const step of steps) await step();
    this.host.paint();
  }

  /** Un scan en cours : son état est relu jusqu'à la fin, puis tout l'affichage. */
  private poll(projectId: string): void {
    if (this.pollTimer) return;
    const api = this.host.api();
    if (!api) return;
    const tick = async (): Promise<void> => {
      this.pollTimer = undefined;
      if (this.projectId !== projectId) return;
      try {
        const state = await api.cartography.currentScan(projectId);
        if (this.ui.summary) this.ui.summary.running = state.state === 'RUNNING' ? state : undefined;
        if (state.state === 'RUNNING') {
          this.host.paint();
          this.pollTimer = setTimeout(() => void tick(), 400);
          return;
        }
        const m = mapStrings(this.host.state.t.locale);
        this.host.state.notice = m.scanDone(m.scanState[state.state] ?? state.state);
      } catch (error) {
        this.ui.error = message(error);
      }
      this.invalidate();
      await this.reloadAll();
    };
    this.pollTimer = setTimeout(() => void tick(), 300);
  }

  dispose(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    for (const controller of this.inflight.values()) controller.abort();
    this.inflight.clear();
    this.pollTimer = undefined;
  }

  private selectFeature(feature: string, concept?: string): void {
    const ui = this.ui;
    if (ui.feature !== feature) {
      ui.feature = feature;
      ui.detail = undefined;
      ui.fields = undefined;
      ui.field = undefined;
      ui.sheet = undefined;
      ui.fieldCriteria = { ...ui.fieldCriteria, q: '', type: '', layer: '', page: 1 };
    }
    ui.decision = undefined;
    ui.decisionError = undefined;
    if (ui.tab === 'fields' || ui.tab === 'impact' || ui.tab === 'apis') ui.tab = 'features';
    void this.run(async () => {
      if (concept) {
        // « Réutilisé dans » : le même concept, retrouvé dans l'autre fonctionnalité par le serveur.
        const row = await this.fetch('fields', (api, id, signal) =>
          api.cartography.featureFields(id, feature, { concept, size: 1 }, { signal }),
        );
        if (row?.items[0]) ui.field = row.items[0].id;
      }
      await Promise.all([this.loadDetail(), this.loadFields(), this.loadSheet()]);
    });
  }

  /** Un autre champ : la vue du graphe repart de son cadrage et sans sélection. */
  private resetGraph(): void {
    const ui = this.ui;
    ui.graphSel = undefined;
    ui.relStep = undefined;
    ui.zoom = 1;
    ui.panX = 0;
    ui.panY = 0;
    ui.allEvidence = false;
  }

  private canvas(): { canvas: HTMLElement; inner: HTMLElement } | undefined {
    const canvas = this.host.root.querySelector<HTMLElement>('[data-map-canvas]');
    const inner = canvas?.firstElementChild as HTMLElement | null | undefined;
    return canvas && inner ? { canvas, inner } : undefined;
  }

  /** Le zoom autour du centre de la zone affichée (la vue garde ce qu'elle montrait au milieu). */
  private zoomBy(factor: number, at?: { x: number; y: number }): void {
    const ui = this.ui;
    const next = Math.min(2.5, Math.max(0.3, Math.round(ui.zoom * factor * 100) / 100));
    const box = this.canvas();
    const cx = at?.x ?? (box?.canvas.clientWidth ?? 0) / 2;
    const cy = at?.y ?? (box?.canvas.clientHeight ?? 0) / 2;
    ui.panX = Math.round(cx - ((cx - ui.panX) * next) / ui.zoom);
    ui.panY = Math.round(cy - ((cy - ui.panY) * next) / ui.zoom);
    ui.zoom = next;
    this.host.paint();
  }

  /** Ajuster à la vue : le contenu entier, à l'échelle de la zone, centré (mesuré dans la page). */
  private fit(): void {
    const ui = this.ui;
    const box = this.canvas();
    const content = box?.inner.firstElementChild as HTMLElement | null | undefined;
    if (!box || !content) return;
    if (content.hasAttribute('data-lanes')) {
      this.fitLanes(box.canvas, content, 0.5);
      return;
    }
    const width = content.getBoundingClientRect().width / ui.zoom + 32;
    const height = content.getBoundingClientRect().height / ui.zoom + 44;
    const cw = box.canvas.clientWidth;
    const ch = box.canvas.clientHeight;
    if (width <= 0 || cw <= 0) return;
    const scale = ui.graphMode === 'full' ? Math.min(cw / width, ch / height) : cw / width;
    ui.zoom = Math.min(1.5, Math.max(0.3, Math.round(scale * 100) / 100));
    ui.panX = Math.max(0, Math.round((cw - width * ui.zoom) / 2));
    ui.panY = ui.graphMode === 'full' ? Math.max(0, Math.round((ch - height * ui.zoom) / 2)) : 0;
    this.host.paint();
  }

  /**
   * Le graphe en couloirs ajusté à la largeur de la zone, sans descendre sous un zoom lisible (le reste se
   * parcourt en déplaçant la vue) ; la hauteur de la zone suit le contenu.
   */
  private fitLanes(canvas: HTMLElement, content: HTMLElement, least: number): void {
    const ui = this.ui;
    const width = content.offsetWidth + 32;
    const height = content.offsetHeight + 44;
    const cw = canvas.clientWidth;
    if (width <= 0 || cw <= 0) return;
    // En plein écran la zone a sa hauteur propre : le graphe y tient aussi en hauteur, si c'est lisible.
    const scale = ui.fullscreen ? Math.min(cw / width, canvas.clientHeight / height) : cw / width;
    ui.zoom = Math.min(1, Math.max(least, Math.floor(scale * 100) / 100));
    ui.panX = Math.max(0, Math.round((cw - width * ui.zoom) / 2));
    ui.panY = 0;
    this.host.paint();
  }

  /** Après l'affichage : l'ajustement demandé (ouverture, changement de mode ou de vue), une seule fois. */
  private fitSoon(): void {
    const run = (): void => {
      const ui = this.ui;
      if (!ui.autoFit) return;
      const box = this.canvas();
      const content = box?.inner.firstElementChild as HTMLElement | null | undefined;
      if (!box || !content?.hasAttribute('data-lanes')) return;
      ui.autoFit = false;
      this.fitLanes(box.canvas, content, ui.tab === 'structure' ? 0.55 : 0.7);
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else run();
  }

  private toggleBundle(key: string): void {
    if (!key) return;
    const ui = this.ui;
    ui.lnBundles = ui.lnBundles.includes(key)
      ? ui.lnBundles.filter((k) => k !== key)
      : [...ui.lnBundles, key];
  }

  /** Au survol d'une carte : elle, ses voisines et leurs faisceaux ressortent ; le reste s'atténue. */
  pointerOver(event: PointerEvent): void {
    const target = event.target as Element | null;
    const graph =
      target?.closest<HTMLElement>('[data-lanes]') ??
      this.host.root.querySelector<HTMLElement>('[data-lanes].hov');
    if (!graph) return;
    const card = graph.contains(target) ? target?.closest<HTMLElement>('[data-lcard]') : null;
    const id = card?.dataset.lcard;
    if (graph.dataset.hover === (id ?? '')) return;
    graph.dataset.hover = id ?? '';
    for (const el of graph.querySelectorAll('.on')) el.classList.remove('on');
    if (!card || !id) {
      graph.classList.remove('hov');
      return;
    }
    graph.classList.add('hov');
    const ids = [id, ...(card.dataset.near ?? '').split(' ').filter(Boolean)];
    for (const one of ids)
      for (const el of graph.querySelectorAll(`[data-lcard="${one}"]`)) el.classList.add('on');
    for (const el of graph.querySelectorAll<HTMLElement>('.ln-e[data-touch], .ln-badge[data-touch]'))
      if ((el.dataset.touch ?? '').split(' ').includes(id)) el.classList.add('on');
  }

  /**
   * La molette sur un graphe : zoom autour du pointeur avec Ctrl (ou ⌘, ou le pincement d'un pavé
   * tactile), et sans touche en plein écran ; ailleurs la page défile normalement.
   */
  wheel(event: WheelEvent): void {
    // Écoutée sur l'élément hôte : la cible réelle est la première du chemin (dans la racine fantôme).
    const target = event.composedPath()[0];
    const canvas = target instanceof Element ? target.closest<HTMLElement>('[data-map-canvas]') : null;
    if (!canvas || !(event.ctrlKey || event.metaKey || this.ui.fullscreen) || event.deltaY === 0) return;
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    this.zoomBy(event.deltaY < 0 ? 1.1 : 1 / 1.1, {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    });
  }

  /** Déplacer la vue en glissant dans la zone du graphe (hors des boutons, nœuds et liens). */
  pointerDown(event: PointerEvent): boolean {
    const target = event.target as Element | null;
    const canvas = target?.closest<HTMLElement>('[data-map-canvas]');
    if (!canvas || event.button !== 0 || target?.closest('[data-action]')) return false;
    const inner = canvas.firstElementChild as HTMLElement | null;
    if (!inner) return false;
    const ui = this.ui;
    const start = { x: event.clientX, y: event.clientY, panX: ui.panX, panY: ui.panY };
    const id = event.pointerId;
    canvas.classList.add('dragging');
    try {
      canvas.setPointerCapture(id);
    } catch {
      // Le pointeur n'est plus actif : le glisser continue sans capture.
    }
    const move = (e: PointerEvent): void => {
      if (e.pointerId !== id) return;
      ui.panX = Math.round(start.panX + e.clientX - start.x);
      ui.panY = Math.round(start.panY + e.clientY - start.y);
      inner.style.transform = `translate(${String(ui.panX)}px,${String(ui.panY)}px) scale(${String(ui.zoom)})`;
    };
    const end = (e: PointerEvent): void => {
      if (e.pointerId !== id) return;
      canvas.classList.remove('dragging');
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', end);
      canvas.removeEventListener('pointercancel', end);
    };
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    return true;
  }

  click(action: string, target: HTMLElement): boolean {
    const ui = this.ui;
    switch (action) {
      case 'map-api': {
        const id = target.dataset.api ?? '';
        if (ui.api !== id) {
          ui.api = id;
          ui.apiSheet = undefined;
          ui.apiRename = undefined;
          ui.lnCards = [];
          ui.lnBundles = [];
          ui.autoFit = true;
          this.resetGraph();
        }
        void this.run(() => this.loadApiSheet()).then(() => {
          this.fitSoon();
        });
        return true;
      }
      case 'map-api-scope':
        ui.apiScope = target.dataset.scope ?? '';
        ui.apiCriteria.page = 1;
        void this.run(() => this.loadApis());
        return true;
      case 'map-api-sort':
        ui.showApiSort = !ui.showApiSort;
        this.host.paint();
        return true;
      case 'map-api-tab': {
        const tab = target.dataset.tab as ApiTab;
        if (API_TABS.includes(tab)) ui.apiTab = tab;
        if (tab === 'trace') {
          ui.autoFit = true;
          ui.zoom = 1;
          ui.panX = 0;
          ui.panY = 0;
        }
        this.host.paint();
        this.fitSoon();
        return true;
      }
      case 'map-api-rename-open':
        ui.apiRename = ui.apiSheet?.api.name ?? '';
        this.host.paint();
        this.host.root.querySelector<HTMLInputElement>('input[data-map="api-name"]')?.focus();
        return true;
      case 'map-api-rename-cancel':
        ui.apiRename = undefined;
        this.host.paint();
        return true;
      case 'map-api-classify':
        if (ui.api)
          void this.decide({ kind: 'CLASSIFY_API', target: ui.api, value: target.dataset.value ?? '' });
        return true;
      case 'map-api-copy': {
        const textToCopy = target.dataset.text ?? '';
        void navigator.clipboard.writeText(textToCopy).catch(() => undefined);
        return true;
      }
      case 'map-api-launch':
        void this.launch(ui.apiPicked);
        return true;
      case 'map-ln-mode':
        ui.apiGraphMode = target.dataset.mode === 'path' ? 'path' : 'full';
        // La sélection utile est gardée d'un mode à l'autre ; le cadrage repart de la zone.
        ui.zoom = 1;
        ui.panX = 0;
        ui.panY = 0;
        ui.autoFit = ui.apiGraphMode === 'full';
        this.host.paint();
        this.fitSoon();
        return true;
      case 'map-ln-view':
        ui.apiView = target.dataset.view === 'data' ? 'data' : 'architecture';
        ui.autoFit = true;
        this.host.paint();
        this.fitSoon();
        return true;
      case 'map-ln-filters':
        ui.showApiFilters = !ui.showApiFilters;
        this.host.paint();
        return true;
      case 'map-ln-reset':
        ui.apiFilters = { lanes: [], natures: [], statuses: [], depth: 0 };
        this.host.paint();
        return true;
      case 'map-ln-bundle': {
        // Premier clic : les relations du faisceau et leurs preuves ; second clic : dépliées dans le graphe.
        const ids = readIds(target.dataset.ids);
        const key = target.dataset.bundle ?? '';
        if (ids.length === 0) return true;
        const same = ui.graphSel?.kind === 'edge' && ui.graphSel.ids.join(' ') === ids.join(' ');
        if (same && key) this.toggleBundle(key);
        else ui.graphSel = { kind: 'edge', ids };
        ui.relOpen = true;
        this.host.paint();
        return true;
      }
      case 'map-st-toggle': {
        const id = target.dataset.id ?? '';
        ui.structClosed = ui.structClosed.includes(id)
          ? ui.structClosed.filter((x) => x !== id)
          : [...ui.structClosed, id];
        this.host.paint();
        return true;
      }
      case 'map-st-el':
        this.selectElement(target.dataset.id ?? '');
        return true;
      case 'map-st-dir': {
        const dir = target.dataset.dir ?? '';
        if (dir !== 'SHEET' && !(TRACE_DIRECTIONS as readonly string[]).includes(dir)) return true;
        ui.traceDir = dir as typeof ui.traceDir;
        if (dir === 'SHEET') {
          ui.traceFrom = undefined;
          ui.graphSel = undefined;
          ui.autoFit = true;
          this.host.paint();
          this.fitSoon();
        } else this.reloadTrace();
        return true;
      }
      case 'map-st-tl': {
        const layer = target.dataset.layer as MapLayer;
        if (!MAP_LAYERS.includes(layer)) return true;
        ui.traceLayers = ui.traceLayers.includes(layer)
          ? ui.traceLayers.filter((l) => l !== layer)
          : [...ui.traceLayers, layer];
        this.reloadTrace();
        return true;
      }
      case 'map-st-tk': {
        const kind = target.dataset.kind as MapEdgeKind;
        if (!MAP_EDGE_KINDS.includes(kind)) return true;
        ui.traceKinds = ui.traceKinds.includes(kind)
          ? ui.traceKinds.filter((k) => k !== kind)
          : [...ui.traceKinds, kind];
        this.reloadTrace();
        return true;
      }
      case 'map-st-tclear':
        ui.traceLayers = [];
        ui.traceKinds = [];
        this.reloadTrace();
        return true;
      case 'map-st-recenter': {
        // Le parcours repart de cet élément : la chaîne coupée par la frontière se déplie à partir de lui.
        const id = target.dataset.id ?? '';
        if (!id) return true;
        ui.traceFrom = id === ui.element ? undefined : id;
        ui.detailNode = undefined;
        if (ui.traceDir === 'SHEET') ui.traceDir = 'BOTH';
        this.reloadTrace();
        return true;
      }
      case 'map-inv-open': {
        // L'investigation part de l'élément choisi (ou du point recentré), avec l'objectif que sa sorte suggère.
        const start = ui.traceFrom ?? ui.element;
        if (!start) return true;
        const node =
          ui.trace?.nodes.find((n) => n.id === start) ??
          (ui.elementSheet?.element.id === start ? ui.elementSheet.element : undefined);
        if (ui.invStart !== start) {
          const d = defaultGoal(node?.kind);
          ui.invGoal = d.goal;
          ui.invDir = ui.traceDir === 'UP' || ui.traceDir === 'BOTH' ? ui.traceDir : d.direction;
          ui.inv = undefined;
          ui.invPath = undefined;
        }
        ui.invStart = start;
        ui.invStartName = node?.label ?? node?.name ?? start;
        ui.invOpen = true;
        this.host.paint();
        this.host.root.querySelector<HTMLElement>('[data-inv-modal]')?.focus();
        void this.run(() => this.loadInvestigations());
        return true;
      }
      case 'map-inv-close':
        ui.invOpen = false;
        this.host.paint();
        this.host.root.querySelector<HTMLElement>('[data-action="map-inv-open"]')?.focus();
        return true;
      case 'map-inv-full':
        ui.invFull = !ui.invFull;
        this.host.paint();
        return true;
      case 'map-inv-dir': {
        const dir = target.dataset.dir ?? '';
        if ((TRACE_DIRECTIONS as readonly string[]).includes(dir)) ui.invDir = dir as typeof ui.invDir;
        this.host.paint();
        return true;
      }
      case 'map-inv-run': {
        const start = ui.invStart;
        if (!start) return true;
        const request = { start, goal: ui.invGoal, direction: ui.invDir, mode: ui.invMode };
        this.investigationStep((api, projectId, signal) =>
          api.cartography.investigate(projectId, request, { signal }),
        );
        return true;
      }
      case 'map-inv-expand': {
        const id = ui.inv?.id;
        const node = target.dataset.id ?? '';
        if (!id || !node) return true;
        this.investigationStep((api, projectId, signal) =>
          api.cartography.expandInvestigation(projectId, id, node, undefined, { signal }),
        );
        return true;
      }
      case 'map-inv-rerun': {
        const id = ui.inv?.id;
        if (!id) return true;
        this.investigationStep((api, projectId, signal) =>
          api.cartography.rerunInvestigation(projectId, id, { signal }),
        );
        return true;
      }
      case 'map-inv-path':
        ui.invPath = target.dataset.id ?? undefined;
        this.host.paint();
        return true;
      case 'map-inv-home':
        // Retour au départ : le premier chemin, au zoom normal.
        ui.invPath = undefined;
        ui.invZoom = 1;
        this.host.paint();
        return true;
      case 'map-inv-zoom': {
        const dir = Number(target.dataset.dir ?? '0');
        ui.invZoom = Math.min(2, Math.max(0.4, Math.round((ui.invZoom + dir * 0.2) * 10) / 10));
        this.host.paint();
        return true;
      }
      case 'map-inv-tab': {
        const tab = target.dataset.tab as InvTab;
        if (INV_TABS.includes(tab)) ui.invTab = tab;
        this.host.paint();
        return true;
      }
      case 'map-inv-conf':
        ui.invConf = target.dataset.conf === 'CONFIRMED' ? 'CONFIRMED' : 'ALL';
        this.host.paint();
        return true;
      case 'map-inv-layer': {
        const layer = target.dataset.layer as MapLayer;
        if (!MAP_LAYERS.includes(layer)) return true;
        ui.invLayers = ui.invLayers.includes(layer)
          ? ui.invLayers.filter((l) => l !== layer)
          : [...ui.invLayers, layer];
        this.host.paint();
        return true;
      }
      case 'map-st-detail':
        // Le zoom et la position du graphe restent tels quels : la fenêtre se superpose.
        ui.detailNode = target.dataset.id ?? undefined;
        this.host.paint();
        this.host.root.querySelector<HTMLElement>('[data-st-detail]')?.focus();
        return true;
      case 'map-st-detail-close': {
        const id = ui.detailNode;
        ui.detailNode = undefined;
        this.host.paint();
        if (id)
          this.host.root
            .querySelector<HTMLElement>(`[data-action="map-st-detail"][data-id="${CSS.escape(id)}"]`)
            ?.focus();
        return true;
      }
      case 'map-st-open': {
        // Depuis l'impact : l'onglet touché s'ouvre dans Structure & Conditions.
        const id = target.dataset.id ?? '';
        ui.tab = 'structure';
        ui.element = id;
        void this.run(() => this.loadTab()).then(() => {
          this.selectElement(id);
        });
        return true;
      }
      case 'map-st-tab': {
        const tab = target.dataset.tab as StructTab;
        if (!STRUCT_TABS.includes(tab)) return true;
        ui.structTab = tab;
        if (tab === 'graph') ui.autoFit = true;
        void this.run(() => this.loadTab());
        return true;
      }
      case 'map-st-sheet': {
        const tab = target.dataset.tab as SheetTab;
        if (SHEET_TABS.includes(tab)) ui.sheetTab = tab;
        this.host.paint();
        return true;
      }
      case 'map-st-bottom': {
        const tab = target.dataset.tab as BottomTab;
        if (BOTTOM_TABS.includes(tab)) ui.bottomTab = tab;
        this.host.paint();
        return true;
      }
      case 'map-ln-expand':
        this.toggleBundle(target.dataset.bundle ?? '');
        this.host.paint();
        return true;
      case 'map-ln-card': {
        const key = target.dataset.card ?? '';
        ui.lnCards = ui.lnCards.includes(key) ? ui.lnCards.filter((k) => k !== key) : [...ui.lnCards, key];
        this.host.paint();
        return true;
      }
      case 'map-g-mode':
        ui.graphMode = target.dataset.mode === 'full' ? 'full' : 'path';
        ui.graphSel = undefined;
        ui.relStep = undefined;
        ui.zoom = 1;
        ui.panX = 0;
        ui.panY = 0;
        this.host.paint();
        return true;
      case 'map-g-zoom':
        this.zoomBy(target.dataset.dir === '-1' ? 1 / 1.2 : 1.2);
        return true;
      case 'map-g-fit':
        this.fit();
        return true;
      case 'map-g-full':
        ui.fullscreen = !ui.fullscreen;
        // Le graphe en couloirs se recadre sur la nouvelle zone (plus grande ou rendue).
        ui.autoFit = ui.tab === 'apis' || ui.tab === 'structure';
        this.host.paint();
        this.fitSoon();
        this.host.root.querySelector<HTMLElement>('[data-action="map-g-full"]')?.focus();
        return true;
      case 'map-g-collapse':
        ui.expansion = undefined;
        ui.graphSel = undefined;
        this.host.paint();
        return true;
      case 'map-g-select': {
        if (target.dataset.kind === 'node') {
          const id = target.dataset.id ?? '';
          ui.graphSel =
            ui.graphSel?.kind === 'node' && ui.graphSel.id === id ? undefined : { kind: 'node', id };
        } else {
          const ids = readIds(target.dataset.ids);
          if (ids.length === 0) return true;
          const same = ui.graphSel?.kind === 'edge' && ui.graphSel.ids.join(' ') === ids.join(' ');
          ui.graphSel = same ? undefined : { kind: 'edge', ids };
        }
        ui.relStep = undefined;
        this.host.paint();
        return true;
      }
      case 'map-rel-toggle':
        // Le tableau se replie de lui-même (élément natif) : l'état suit, sans redessin.
        ui.relOpen = !(target.closest('details')?.open ?? true);
        return true;
      case 'map-g-clear':
        ui.graphSel = undefined;
        this.host.paint();
        return true;
      case 'map-rel-step': {
        const step = target.dataset.step ?? '';
        ui.relStep = ui.relStep === step ? undefined : step;
        ui.graphSel = undefined;
        ui.relOpen = true;
        this.host.paint();
        return true;
      }
      case 'map-rel-all':
        ui.relStep = undefined;
        ui.graphSel = undefined;
        this.host.paint();
        return true;
      case 'map-details-toggle':
        ui.detailsCollapsed = !ui.detailsCollapsed;
        this.host.paint();
        return true;
      case 'map-evidence-all':
        ui.allEvidence = !ui.allEvidence;
        this.host.paint();
        return true;
      case 'map-impact-open':
        ui.impactOpen = !ui.impactOpen;
        this.host.paint();
        return true;
      case 'map-j-view':
      case 'map-j-bottom':
      case 'map-j-cat':
      case 'map-j-bundle':
      case 'map-j-item':
      case 'map-j-clear':
      case 'map-j-page':
      case 'map-j-zoom':
      case 'map-j-fit':
      case 'map-j-center':
      case 'map-j-full':
      case 'map-j-tree':
      case 'map-j-card':
      case 'map-j-detail':
        return this.journeyAction(action, target);
      case 'map-tab': {
        const tab = target.dataset.tab as MapTab;
        if (!MAP_TABS.includes(tab)) return true;
        ui.tab = tab;
        void this.run(() => this.loadTab());
        return true;
      }
      case 'map-center-tab': {
        const tab = target.dataset.tab as CenterTab;
        if (CENTER_TABS.includes(tab)) ui.centerTab = tab;
        if (ui.tab !== 'features') ui.tab = 'features';
        this.host.paint();
        return true;
      }
      case 'map-feature':
        this.selectFeature(target.dataset.feature ?? '');
        return true;
      case 'map-reuse-open':
        this.selectFeature(target.dataset.feature ?? '', target.dataset.concept);
        return true;
      case 'map-field':
        ui.field = target.dataset.field;
        ui.expansion = undefined;
        void this.run(() => this.loadSheet());
        return true;
      case 'map-field-close':
        ui.field = undefined;
        ui.sheet = undefined;
        this.host.paint();
        return true;
      case 'map-criteria':
        ui.showCriteria = !ui.showCriteria;
        this.host.paint();
        return true;
      case 'map-graph-view':
        ui.graphView = target.dataset.view === 'sequence' ? 'sequence' : 'graph';
        this.host.paint();
        return true;
      case 'map-expand':
        void this.expand(target.dataset.node ?? '');
        return true;
      case 'map-page': {
        const page = Math.max(1, Number(target.dataset.page) || 1);
        const list = target.dataset.list;
        if (list === 'features') {
          ui.featureCriteria.page = page;
          void this.run(() => this.loadFeatures());
        } else if (list === 'fields') {
          ui.fieldCriteria.page = page;
          void this.run(() => this.loadFields());
        } else if (list === 'concepts') {
          ui.conceptCriteria.page = page;
          void this.run(() => this.loadConcepts());
        } else if (list === 'apis') {
          ui.apiCriteria.page = page;
          void this.run(() => this.loadApis());
        } else if (list === 'issues') {
          ui.issuesPage = page;
          void this.run(() => this.loadIssues());
        } else if (list === 'conditions') {
          ui.condCriteria.page = page;
          void this.run(() => this.loadConditions());
        } else if (list === 'actions') {
          ui.actCriteria.page = page;
          void this.run(() => this.loadActions());
        }
        return true;
      }
      case 'map-concept':
        ui.concept = target.dataset.concept;
        ui.conceptSheet = undefined;
        ui.tab = 'fields';
        void this.run(() => this.loadTab());
        return true;
      case 'map-open-scenario': {
        const projectId = this.projectId;
        if (projectId)
          this.host.navigate({ view: 'scenarios', projectId, scenario: target.dataset.scenario ?? '' });
        return true;
      }
      case 'map-refresh':
        this.invalidate();
        void this.reloadAll();
        return true;
      case 'map-scan':
        void this.scan();
        return true;
      case 'map-scan-cancel':
        void this.act(
          async (api, projectId) => {
            await api.cartography.cancelScan(projectId);
          },
          (text) => {
            ui.error = text;
          },
        );
        return true;
      case 'map-export':
        void this.export();
        return true;
      case 'map-src-add': {
        const sources = this.draft();
        sources.push({
          id: `source-${String(sources.length + 1)}`,
          name: '',
          layer: 'FRONTEND',
          ...(target.dataset.kind === 'GIT' ? { kind: 'GIT' as const } : {}),
          path: '',
          include: [],
          enabled: true,
        });
        ui.srcClosed = ui.srcClosed.filter((i) => i !== sources.length - 1);
        this.host.paint();
        this.focus(`#sd-${String(sources.length - 1)}-name`);
        return true;
      }
      case 'map-src-remove': {
        const index = Number(target.dataset.index);
        this.draft().splice(index, 1);
        ui.srcClosed = ui.srcClosed.filter((i) => i !== index).map((i) => (i > index ? i - 1 : i));
        this.host.paint();
        return true;
      }
      case 'map-src-toggle': {
        const index = Number(target.dataset.index);
        ui.srcClosed = ui.srcClosed.includes(index)
          ? ui.srcClosed.filter((i) => i !== index)
          : [...ui.srcClosed, index];
        this.host.paint();
        this.focus(`#sd-src-${String(index)} .sd-tg`);
        return true;
      }
      case 'map-src-focus': {
        const index = (ui.sources ?? ui.summary?.config.sources ?? []).findIndex(
          (s) => s.id === target.dataset.id,
        );
        if (index < 0) return true;
        ui.srcClosed = ui.srcClosed.filter((i) => i !== index);
        ui.tab = 'scan';
        this.host.paint();
        this.focus(`#sd-src-${String(index)} .sd-tg`);
        return true;
      }
      case 'map-scans-all':
        ui.scansAll = !ui.scansAll;
        this.host.paint();
        return true;
      case 'map-scan-details':
        ui.tab = 'scan';
        this.host.paint();
        this.focus('#map-scan-summary');
        return true;
      case 'map-scan-compare': {
        const latest = ui.summary?.scans[0]?.id;
        if (!latest || !target.dataset.id) return true;
        ui.impactFrom = target.dataset.id;
        ui.impactTo = latest;
        ui.tab = 'impact';
        void this.impact();
        return true;
      }
      case 'map-impact-swap': {
        const scans = ui.summary?.scans ?? [];
        const from = ui.impactFrom || scans[1]?.id || '';
        const to = ui.impactTo || scans[0]?.id || '';
        ui.impactFrom = to;
        ui.impactTo = from;
        this.host.paint();
        this.focus('[data-action="map-impact-swap"]');
        return true;
      }
      case 'map-impact-kind':
        ui.impactKind = target.dataset.kind ?? 'ALL';
        ui.impactLimit = 50;
        this.host.paint();
        this.focus(`[data-action="map-impact-kind"][data-kind="${ui.impactKind}"]`);
        return true;
      case 'map-impact-filters':
        ui.showImpactFilters = !ui.showImpactFilters;
        this.host.paint();
        this.focus('[data-action="map-impact-filters"]');
        return true;
      case 'map-impact-more':
        ui.impactLimit += 50;
        this.host.paint();
        return true;
      case 'map-impact-detail':
        ui.impactKind = 'ALL';
        this.host.paint();
        this.focus('#sd-imp-detail');
        return true;
      case 'map-focus':
        this.focus(`#${target.dataset.target ?? ''}`);
        return true;
      case 'map-src-save':
        void this.saveSources();
        return true;
      case 'map-decide':
        void this.decide({
          kind: target.dataset.kind as MapDecisionInput['kind'],
          target: target.dataset.target ?? '',
          ...(target.dataset.value ? { value: target.dataset.value } : {}),
        });
        return true;
      case 'map-decision-open':
        ui.decision = {
          kind: target.dataset.kind === 'MERGE' ? 'MERGE' : 'RENAME',
          value: target.dataset.kind === 'MERGE' ? '' : (ui.detail?.feature.name ?? ''),
        };
        ui.decisionError = undefined;
        this.host.paint();
        return true;
      case 'map-decision-cancel':
        ui.decision = undefined;
        ui.decisionError = undefined;
        this.host.paint();
        return true;
      case 'map-decision-save':
        if (ui.feature && ui.decision)
          void this.decide({ kind: ui.decision.kind, target: ui.feature, value: ui.decision.value });
        return true;
      case 'map-evidence':
        void this.evidence(
          target.dataset.source ?? '',
          target.dataset.file ?? '',
          Number(target.dataset.line) || 1,
          target.dataset.rev,
        );
        return true;
      case 'map-evidence-close':
        ui.evidence = undefined;
        ui.evidenceError = undefined;
        this.host.paint();
        return true;
      case 'map-impact':
        void this.impact();
        return true;
      case 'map-impact-launch':
        void this.launch([...ui.impactPicked]);
        return true;
      case 'map-field-launch':
        void this.launch([...ui.fieldPicked]);
        return true;
      default:
        return false;
    }
  }

  /** Étendre le graphe affiché autour d'un nœud (ses voisins, bornés), sans recharger le reste. */
  private async expand(node: string): Promise<void> {
    if (!node || !this.ui.sheet) return;
    const around = await this.fetch('sheet', (api, id, signal) =>
      api.cartography.neighbors(id, node, { depth: 1, limit: 30 }, { signal }),
    );
    if (!around) {
      this.host.paint();
      return;
    }
    const previous = this.ui.expansion;
    const nodes = new Map([...(previous?.nodes ?? []), ...around.nodes].map((n) => [n.id, n]));
    const edges = new Map([...(previous?.edges ?? []), ...around.edges].map((e) => [e.id, e]));
    this.ui.expansion = {
      ...around,
      nodes: [...nodes.values()],
      edges: [...edges.values()],
      truncated: Boolean(previous?.truncated) || around.truncated,
    };
    this.host.paint();
  }

  /** Un formulaire de l'écran : association d'un scénario à la fonctionnalité, ou au champ. */
  submit(form: HTMLFormElement): boolean {
    const ui = this.ui;
    if (form.dataset.action === 'map-link-add') {
      if (ui.feature && ui.linkDraft.scenario)
        void this.decide({
          kind: 'LINK_SCENARIO',
          target: ui.feature,
          value: ui.linkDraft.scenario,
          path: ui.linkDraft.path,
        });
      return true;
    }
    if (form.dataset.action === 'map-api-rename') {
      const name = ui.apiRename?.trim();
      if (ui.api && name) void this.decide({ kind: 'RENAME_API', target: ui.api, value: name });
      return true;
    }
    if (form.dataset.action === 'map-field-link') {
      if (ui.field && ui.fieldLinkDraft)
        void this.decide({ kind: 'LINK_FIELD', target: ui.field, value: ui.fieldLinkDraft });
      return true;
    }
    return false;
  }

  /** Les flèches haut et bas passent d'un élément à l'autre d'une liste (fonctionnalités, champs). */
  keydown(event: KeyboardEvent): boolean {
    const target = event.target as HTMLElement | null;
    const ui = this.ui;
    if (event.key === 'Escape' && ui.invOpen) {
      ui.invOpen = false;
      this.host.paint();
      this.host.root.querySelector<HTMLElement>('[data-action="map-inv-open"]')?.focus();
      return true;
    }
    if (event.key === 'Escape' && ui.detailNode) {
      ui.detailNode = undefined;
      this.host.paint();
      return true;
    }
    if (event.key === 'Escape' && ui.jFull && ui.tab === 'journey') {
      ui.jFull = false;
      this.host.paint();
      this.host.root.querySelector<HTMLElement>('[data-action="map-j-full"]')?.focus();
      return true;
    }
    if (event.key === 'Escape' && ui.fullscreen) {
      ui.fullscreen = false;
      this.host.paint();
      this.host.root.querySelector<HTMLElement>('[data-action="map-g-full"]')?.focus();
      return true;
    }
    // Le graphe au clavier : + et - zooment, les flèches déplacent la vue, 0 l'ajuste.
    if (target?.hasAttribute('data-map-canvas')) {
      const step = 40;
      const moves: Record<string, [number, number]> = {
        ArrowLeft: [step, 0],
        ArrowRight: [-step, 0],
        ArrowUp: [0, step],
        ArrowDown: [0, -step],
      };
      const move = moves[event.key];
      if (event.key === '+' || event.key === '=') this.zoomBy(1.2);
      else if (event.key === '-') this.zoomBy(1 / 1.2);
      else if (event.key === '0') this.fit();
      else if (move) {
        ui.panX += move[0];
        ui.panY += move[1];
        this.host.paint();
      } else return false;
      event.preventDefault();
      this.host.root.querySelector<HTMLElement>('[data-map-canvas]')?.focus();
      return true;
    }
    const list = target?.dataset.nav;
    if (!target || !list || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return false;
    const items = [...this.host.root.querySelectorAll<HTMLElement>(`[data-nav="${list}"]`)];
    const index = items.indexOf(target);
    const next = items[index + (event.key === 'ArrowDown' ? 1 : -1)];
    if (!next) return false;
    event.preventDefault();
    next.focus();
    return true;
  }

  private draft(): MapSource[] {
    this.ui.sources ??= structuredClone(this.ui.summary?.config.sources ?? []);
    return this.ui.sources;
  }

  /** Une recherche tapée : la requête part quand la saisie se pose (les précédentes sont annulées). */
  private searchLater(run: () => Promise<void>): void {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.searchTimer = undefined;
      void this.run(run);
    }, 250);
  }

  /** Une saisie : gardée dans l'état ; une liste est relue côté serveur (le focus est rendu par le Dashboard). */
  input(target: HTMLInputElement | HTMLSelectElement, committed: boolean): boolean {
    const name = target.dataset.map;
    if (!name) return false;
    const ui = this.ui;
    const value = target.value;
    const checked = (target as HTMLInputElement).checked;
    if (name.startsWith('src-')) {
      const source = this.draft()[Number(target.dataset.index)];
      if (!source) return true;
      const field = name.slice(4);
      if (field === 'enabled') {
        source.enabled = checked;
        // Sur la vue d'ensemble, cocher une source l'enregistre aussitôt.
        if (ui.tab !== 'scan') void this.saveSources();
        return true;
      }
      if (field === 'include')
        source.include = value
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean);
      else if (field === 'layer') source.layer = value as MapLayer;
      else if (field === 'id' || field === 'name' || field === 'path') source[field] = value;
      else if (field === 'kind') {
        if (value === 'GIT') {
          source.kind = 'GIT';
          source.path = '';
        } else delete source.kind;
        this.host.paint();
      } else if (field === 'provider') {
        const provider = GIT_PROVIDERS.find((p) => p === value);
        if (provider) source.provider = provider;
        else delete source.provider;
      } else if (field === 'repoUrl' || field === 'branch' || field === 'commit' || field === 'tokenEnv') {
        // Un champ vidé est retiré (le serveur ne reçoit que ce qui est saisi).
        const typed = value.trim();
        if (field === 'repoUrl') source.repoUrl = typed || undefined;
        else if (field === 'branch') source.branch = typed || undefined;
        else if (field === 'commit') source.commit = typed || undefined;
        else source.tokenEnv = typed || undefined;
      }
      // Une saisie validée (sortie du champ) redessine la carte : ses erreurs et l'état d'enregistrement
      // suivent. Le dessin attend que le focus soit posé sur le champ suivant, qui le garde alors.
      if (committed && field !== 'kind')
        setTimeout(() => {
          this.host.paint();
        }, 0);
      return true;
    }
    const criteria = (
      list: ListCriteria,
      key: keyof ListCriteria,
      reload: () => Promise<void>,
      typed: boolean,
    ): void => {
      if (list[key] === value) return;
      (list as unknown as Record<string, string | number>)[key] = value;
      list.page = 1;
      if (typed) this.searchLater(reload);
      else void this.run(reload);
    };
    switch (name) {
      case 'f-q':
        criteria(ui.featureCriteria, 'q', () => this.loadFeatures(), !committed);
        return true;
      case 'f-module':
      case 'f-layer':
      case 'f-status':
      case 'f-coverage':
      case 'f-sort':
        criteria(ui.featureCriteria, name.slice(2) as keyof ListCriteria, () => this.loadFeatures(), false);
        return true;
      case 'features-size':
        ui.featureCriteria.size = Number(value) || 5;
        ui.featureCriteria.page = 1;
        void this.run(() => this.loadFeatures());
        return true;
      case 'c-q':
        criteria(ui.fieldCriteria, 'q', () => this.loadFields(), !committed);
        return true;
      case 'c-type':
      case 'c-layer':
        criteria(ui.fieldCriteria, name.slice(2) as keyof ListCriteria, () => this.loadFields(), false);
        return true;
      case 'fields-size':
        ui.fieldCriteria.size = Number(value) || 5;
        ui.fieldCriteria.page = 1;
        void this.run(() => this.loadFields());
        return true;
      case 'a-q':
        criteria(ui.apiCriteria, 'q', () => this.loadApis(), !committed);
        return true;
      case 'struct-feature':
        if (ui.structFeature === value) return true;
        ui.structFeature = value;
        ui.structure = undefined;
        void this.run(() => this.loadStructure());
        return true;
      case 'inv-goal':
        if ((INVESTIGATION_GOALS as readonly string[]).includes(value))
          ui.invGoal = value as InvestigationGoal;
        return true;
      case 'inv-mode':
        ui.invMode = value === 'EXHAUSTIVE' ? 'EXHAUSTIVE' : 'FOCUSED';
        return true;
      case 'inv-q':
        if (ui.invQ === value) return true;
        ui.invQ = value;
        if (committed) this.host.paint();
        else this.searchLater(() => Promise.resolve());
        return true;
      case 'inv-load': {
        if (!value) return true;
        this.investigationStep((api, projectId, signal) =>
          api.cartography.investigation(projectId, value, { signal }),
        );
        return true;
      }
      case 'struct-q':
        // La recherche dans l'arbre est locale (l'arbre chargé) : seul l'affichage change.
        if (ui.structQ === value) return true;
        ui.structQ = value;
        if (committed) this.host.paint();
        else this.searchLater(() => Promise.resolve());
        return true;
      case 'cond-q':
        criteria(ui.condCriteria, 'q', () => this.loadConditions(), !committed);
        return true;
      case 'act-q':
        criteria(ui.actCriteria, 'q', () => this.loadActions(), !committed);
        return true;
      case 'conditions-size':
        ui.condCriteria.size = Number(value) || 10;
        ui.condCriteria.page = 1;
        void this.run(() => this.loadConditions());
        return true;
      case 'actions-size':
        ui.actCriteria.size = Number(value) || 10;
        ui.actCriteria.page = 1;
        void this.run(() => this.loadActions());
        return true;
      case 'a-sort':
        criteria(ui.apiCriteria, 'sort', () => this.loadApis(), false);
        return true;
      case 'apis-size':
        ui.apiCriteria.size = Number(value) || 5;
        ui.apiCriteria.page = 1;
        void this.run(() => this.loadApis());
        return true;
      case 'api-name':
        ui.apiRename = value;
        return true;
      case 'api-pick': {
        const scenario = target.dataset.scenario ?? '';
        ui.apiPicked = checked
          ? [...new Set([...ui.apiPicked, scenario])]
          : ui.apiPicked.filter((x) => x !== scenario);
        this.host.paint();
        return true;
      }
      case 'k-q':
        criteria(ui.conceptCriteria, 'q', () => this.loadConcepts(), !committed);
        return true;
      case 'k-layer':
      case 'k-status':
        criteria(ui.conceptCriteria, name.slice(2) as keyof ListCriteria, () => this.loadConcepts(), false);
        return true;
      case 'concepts-size':
        ui.conceptCriteria.size = Number(value) || 20;
        ui.conceptCriteria.page = 1;
        void this.run(() => this.loadConcepts());
        return true;
      case 'trace-feature':
        if (committed) this.selectFeature(value);
        return true;
      case 'incremental':
        ui.incremental = checked;
        return true;
      case 'decision-value':
        if (ui.decision) ui.decision.value = value;
        if (committed) this.host.paint();
        return true;
      case 'link-scenario':
        ui.linkDraft.scenario = value;
        this.host.paint();
        return true;
      case 'link-path':
        ui.linkDraft.path = value === 'NEGATIVE' ? 'NEGATIVE' : 'POSITIVE';
        return true;
      case 'field-link':
        ui.fieldLinkDraft = value;
        this.host.paint();
        return true;
      case 'impact-from':
        ui.impactFrom = value;
        this.host.paint();
        return true;
      case 'impact-to':
        ui.impactTo = value;
        this.host.paint();
        return true;
      case 'imp-q':
        // La recherche porte sur le rapport déjà chargé : seul l'affichage change.
        if (ui.impactQ === value) return true;
        ui.impactQ = value;
        ui.impactLimit = 50;
        if (committed) this.host.paint();
        else this.searchLater(() => Promise.resolve());
        return true;
      case 'imp-layer':
        ui.impactLayer = value;
        this.host.paint();
        return true;
      case 'imp-source':
        ui.impactSource = value;
        this.host.paint();
        return true;
      case 'impact-env':
        ui.impactEnv = value;
        return true;
      case 'j-feature':
        if (!value || value === ui.feature) return true;
        // Une autre fonctionnalité : sa carte seule (sa fiche et ses champs se chargeront dans leur onglet),
        // sans la sélection ni les critères de la précédente ; la vue reste.
        ui.feature = value;
        ui.detail = undefined;
        ui.fields = undefined;
        ui.field = undefined;
        ui.sheet = undefined;
        ui.fieldCriteria = { ...ui.fieldCriteria, q: '', type: '', layer: '', page: 1 };
        ui.jSelect = undefined;
        ui.jOpen = [];
        ui.jClosed = [];
        ui.jQuery = {
          page: 1,
          size: ui.jQuery.size ?? 25,
          ...(VIEW_PRESET[ui.jView].category ? { category: VIEW_PRESET[ui.jView].category } : {}),
        };
        this.reloadJourney();
        return true;
      case 'j-cat':
      case 'j-lane':
      case 'j-status': {
        const key = name === 'j-cat' ? 'category' : name === 'j-lane' ? 'lane' : 'status';
        const allowed: readonly string[] =
          key === 'category'
            ? FEATURE_CATEGORIES
            : key === 'lane'
              ? FEATURE_LANES
              : ['CONFIRMED', 'PROBABLE', 'UNKNOWN'];
        // Une valeur hors liste efface le critère (jamais transmise au serveur).
        ui.jQuery = compactQuery({
          ...ui.jQuery,
          page: 1,
          [key]: allowed.includes(value) ? value : undefined,
        });
        this.reloadJourney();
        return true;
      }
      case 'j-q': {
        const next = { ...ui.jQuery, page: 1 };
        if (value.trim()) next.q = value.trim();
        else delete next.q;
        ui.jQuery = next;
        this.searchLater(() => this.loadJourney());
        return true;
      }
      case 'group-parallel':
        ui.grouped = checked;
        this.host.paint();
        return true;
      case 'ln-filter': {
        // Coché : montré ; décoché : masqué (l'affichage seulement, aucune relation n'est retirée).
        const group = target.dataset.group as 'lanes' | 'natures' | 'statuses' | undefined;
        if (!group || !['lanes', 'natures', 'statuses'].includes(group)) return true;
        const list = ui.apiFilters[group];
        ui.apiFilters = {
          ...ui.apiFilters,
          [group]: checked ? list.filter((v) => v !== value) : [...new Set([...list, value])],
        };
        this.host.paint();
        return true;
      }
      case 'ln-depth':
        ui.apiFilters = { ...ui.apiFilters, depth: Math.max(0, Math.min(10, Number(value) || 0)) };
        this.host.paint();
        return true;
      case 'impact-pick':
      case 'field-pick': {
        const scenario = target.dataset.scenario ?? '';
        const list = name === 'impact-pick' ? ui.impactPicked : ui.fieldPicked;
        const next = checked ? [...new Set([...list, scenario])] : list.filter((s) => s !== scenario);
        if (name === 'impact-pick') ui.impactPicked = next;
        else ui.fieldPicked = next;
        this.host.paint();
        return true;
      }
      default:
        return true;
    }
  }

  private async act(
    run: (api: QaCrawlerClient, projectId: string) => Promise<void>,
    onError: (text: string) => void,
  ): Promise<void> {
    const api = this.host.api();
    const projectId = this.projectId;
    if (!api || !projectId) return;
    try {
      await run(api, projectId);
    } catch (error) {
      onError(message(error));
    }
    this.host.paint();
  }

  private async scan(): Promise<void> {
    const m = mapStrings(this.host.state.t.locale);
    this.ui.scanBusy = true;
    this.host.paint();
    await this.act(
      async (api, projectId) => {
        const record = await api.cartography.scan(projectId, { incremental: this.ui.incremental });
        if (this.ui.summary) this.ui.summary.running = record;
        this.host.state.notice = m.scanStarted;
        this.poll(projectId);
      },
      (text) => {
        this.ui.error = text;
      },
    );
    this.ui.scanBusy = false;
    this.host.paint();
  }

  /** Met le focus sur un élément de l'écran après l'affichage (et le fait voir). */
  private focus(selector: string): void {
    if (selector === '#') return;
    const element = this.host.root.querySelector<HTMLElement>(selector);
    element?.scrollIntoView({ block: 'nearest' });
    element?.focus();
  }

  private async saveSources(): Promise<void> {
    const sources = this.draft();
    // Les erreurs connues avant l'envoi sont dites sur place, la première reçoit le focus.
    const locale = mapStrings(this.host.state.t.locale);
    const problems = issueCount(
      sourceIssues(locale, sources, this.ui.summary?.gitHosts, this.ui.summary?.allowedRoots),
    );
    if (problems > 0) {
      this.ui.srcTried = true;
      this.ui.sourcesError = undefined;
      this.ui.srcClosed = [];
      this.host.paint();
      this.focus('.sd-sources [aria-invalid="true"]');
      return;
    }
    this.ui.srcTried = false;
    this.ui.sourcesBusy = true;
    this.ui.sourcesError = undefined;
    this.host.paint();
    await this.act(
      async (api, projectId) => {
        const config = await api.cartography.saveConfig(projectId, { sources });
        if (this.ui.summary) this.ui.summary.config = config;
        this.ui.sources = undefined;
        this.host.state.notice = mapStrings(this.host.state.t.locale).saved;
        const summary = await api.cartography.summary(projectId);
        if (this.projectId === projectId) this.ui.summary = summary;
      },
      (raw) => {
        const text = explainSaveError(locale, raw);
        this.ui.sourcesError = text;
        if (this.ui.tab !== 'scan') this.ui.error = text;
      },
    );
    this.ui.sourcesBusy = false;
    this.host.paint();
  }

  private async decide(input: MapDecisionInput): Promise<void> {
    if (!input.target) return;
    this.ui.decisionBusy = true;
    this.host.paint();
    await this.act(
      async (api, projectId) => {
        await api.cartography.decide(projectId, input);
        this.ui.decision = undefined;
        this.ui.decisionError = undefined;
        this.ui.linkDraft = { scenario: '', path: 'POSITIVE' };
        this.ui.fieldLinkDraft = '';
        this.ui.apiRename = undefined;
        this.host.state.notice = mapStrings(this.host.state.t.locale).decide.done;
        // Une décision change les données : la sélection est relue (bornée), rien de plus.
        this.invalidate();
        if (input.kind === 'MERGE' || input.kind === 'REJECT') this.ui.conceptSheet = undefined;
        await this.load(api, projectId, () => this.projectId === projectId);
        if (this.ui.concept) await this.loadConceptSheet();
      },
      (text) => {
        this.ui.decisionError = text;
        this.ui.error = text;
      },
    );
    this.ui.decisionBusy = false;
    this.host.paint();
  }

  private async impact(): Promise<void> {
    const summary = this.ui.summary;
    const from = this.ui.impactFrom || summary?.scans[1]?.id;
    const to = this.ui.impactTo || summary?.scans[0]?.id;
    this.ui.impactBusy = true;
    this.ui.impactError = undefined;
    this.host.paint();
    await this.act(
      async (api, projectId) => {
        const report = await api.cartography.impact(projectId, {
          ...(from ? { from } : {}),
          ...(to ? { to } : {}),
        });
        this.ui.impact = report;
        this.ui.impactLimit = 50;
        // Une proposition : les scénarios dont l'impact est démontré sont cochés ; rien n'est lancé.
        this.ui.impactPicked = report.scenarios
          .filter((s) => s.confidence === 'CONFIRMED')
          .map((s) => s.scenario);
      },
      (text) => {
        this.ui.impactError = text;
      },
    );
    this.ui.impactBusy = false;
    this.host.paint();
  }

  /** Rejouer les scénarios choisis par la personne : rien n'est lancé sans ce clic. */
  private async launch(scenarios: string[]): Promise<void> {
    if (scenarios.length === 0) return;
    this.ui.launching = true;
    this.host.paint();
    await this.act(
      async (api, projectId) => {
        const started = await api.executions.start(projectId, {
          scenarios,
          ...(this.ui.impactEnv ? { environmentId: this.ui.impactEnv } : {}),
        });
        this.host.state.live = { snapshot: started, steps: [], cancelRequested: false };
        this.host.navigate({
          view: 'execution',
          projectId,
          run: started.run ?? '',
          explorationId: started.id,
        });
      },
      (text) => {
        this.ui.impactError = text;
        this.ui.error = text;
      },
    );
    this.ui.launching = false;
  }

  private async evidence(source: string, file: string, line: number, revision?: string): Promise<void> {
    await this.act(
      async (api, projectId) => {
        // La preuve est relue à la révision où elle a été relevée (si le scan l'a connue).
        this.ui.evidence = await api.cartography.evidence(projectId, {
          source,
          file,
          line,
          ...(revision ? { revision } : {}),
        });
        this.ui.evidenceError = undefined;
      },
      (text) => {
        this.ui.evidence = undefined;
        this.ui.evidenceError = text;
      },
    );
  }

  /** L'export : la vue complète est demandée à ce moment-là seulement, puis enregistrée en JSON. */
  private async export(): Promise<void> {
    await this.act(
      async (api, projectId) => {
        const view = await api.cartography.get(projectId);
        if (!view.model) return;
        const blob = new Blob([`${JSON.stringify(view, null, 2)}\n`], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `cartography-${projectId}-${view.model.scan.id}.json`;
        this.host.root.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => {
          URL.revokeObjectURL(url);
        }, 1000);
      },
      (text) => {
        this.ui.error = text;
      },
    );
  }
}
