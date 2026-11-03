import type {
  NavigationStep,
  TargetCandidate,
  TargetLocation,
  TargetPreparation,
} from '../sdk/core/incident-contracts.js';
import type {
  AngularModel,
  RuntimeEvent,
  TriggerAction,
  UiSnapshot,
} from '../sdk/core/incident-trigger-contracts.js';

/**
 * L'ÉCRAN CIBLE : à partir de ce que la personne sait (l'écran, une URL, des indications, des étapes ou un
 * enregistrement), trouver l'écran dans le code et le parcours qui y mène. Tout vient de la navigation lue
 * par l'analyseur Angular (routes, redirections, gardes, liens des templates avec leur libellé, titres) :
 * des indices vérifiables, chacun cité. Un nom seul (route, composant) ne suffit jamais à une identification
 * certaine. Le parcours est ensuite joué dans le navigateur (préparation), jamais supposé atteint.
 */

const STOP = new Set(
  (
    'de du des la le les un une l d en et ou au aux sur dans pour par avec ecran page fonctionnalite fonction ' +
    'vue module partie zone section menu onglet lien bouton the of a an in on to screen view feature tab'
  ).split(' '),
);

/** Les mots porteurs, sans accents ni casse, au singulier simple (« Créations » → « creation »). */
export function wordsOf(text: string): string[] {
  return [
    ...new Set(
      text
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length >= 3 && !STOP.has(word))
        .map((word) => (word.length > 4 && /[sx]$/.test(word) ? word.slice(0, -1) : word)),
    ),
  ];
}

/** Les mots d'un nom de classe (« DossierListComponent » → dossier, list). */
const classWords = (name: string): string[] =>
  wordsOf(name.replace(/Component$/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2'));

/** « /dossiers/nouveau/ » → « dossiers/nouveau » ; « » pour la racine. */
export const routeKey = (path: string): string => path.replace(/^\/+|\/+$/g, '').replace(/[?#].*$/, '');

/** Le chemin d'une URL ou d'une route saisie. */
export function pathKey(urlOrPath: string): string {
  try {
    return routeKey(new URL(urlOrPath, 'http://local.invalid').pathname);
  } catch {
    return routeKey(urlOrPath);
  }
}

/** Une route paramétrée (« dossiers/:id ») reconnaît-elle ce chemin ? */
function routeMatches(route: string, path: string): boolean {
  const left = routeKey(route).split('/');
  const right = routeKey(path).split('/');
  return (
    left.length === right.length && left.every((part, index) => part.startsWith(':') || part === right[index])
  );
}

const overlap = (left: readonly string[], right: readonly string[]): string[] =>
  left.filter((word) => right.includes(word));

interface RouteInfo {
  path: string;
  applicationId: string;
  component?: string;
  componentId?: string;
  file: string;
  line: number;
  componentFile?: string;
  componentLine?: number;
  guards: string[];
}

interface LinkInfo {
  from?: string;
  target: string;
  label: string;
  file: string;
  line: number;
}

function routesOf(models: readonly AngularModel[]): {
  routes: RouteInfo[];
  redirects: Map<string, string>;
  links: LinkInfo[];
  headings: Map<string, { text: string; file: string; line: number }[]>;
} {
  const routes: RouteInfo[] = [];
  const redirects = new Map<string, string>();
  const links: LinkInfo[] = [];
  const headings = new Map<string, { text: string; file: string; line: number }[]>();
  for (const model of models) {
    const navigation = model.navigation;
    if (!navigation) continue;
    for (const route of navigation.routes) {
      if (route.redirectTo !== undefined && !route.component) {
        redirects.set(routeKey(route.path), routeKey(route.redirectTo));
        continue;
      }
      const node = model.nodes.find((item) => item.kind === 'COMPONENT' && item.name === route.component);
      routes.push({
        path: routeKey(route.path),
        applicationId: model.applicationId,
        ...(route.component ? { component: route.component } : {}),
        ...(node ? { componentId: node.id, componentFile: node.file, componentLine: node.line } : {}),
        file: route.file,
        line: route.line,
        guards: route.guards,
      });
    }
    for (const link of navigation.links)
      links.push({
        ...(link.componentId ? { from: link.componentId } : {}),
        target: routeKey(link.target),
        label: link.label,
        file: link.file,
        line: link.line,
      });
    for (const heading of navigation.headings) {
      const list = headings.get(heading.componentId) ?? [];
      list.push({ text: heading.text, file: heading.file, line: heading.line });
      headings.set(heading.componentId, list);
    }
  }
  return { routes, redirects, links, headings };
}

export interface LocateInput {
  query: string;
  url?: string;
  hints?: string;
  /** Les étapes connues (mode guidé), en texte libre. */
  steps?: readonly string[];
  /** Le départ d'un enregistrement associé (route observée). */
  recordingStart?: string;
  /** Une route choisie par la personne parmi les candidats. */
  route?: string;
  models: readonly AngularModel[];
  actor: string;
  at: string;
}

/** Note les routes : chaque indice ajoute sa part et se cite ; un nom seul est plafonné à 0,45. */
export function targetCandidates(input: LocateInput): TargetCandidate[] {
  const { routes, links, headings } = routesOf(input.models);
  const query = wordsOf(input.query);
  const hints = wordsOf(input.hints ?? '');
  const urlPath = input.url ? pathKey(input.url) : undefined;
  const recorded = input.recordingStart ? pathKey(input.recordingStart) : undefined;
  const out: TargetCandidate[] = [];
  for (const route of routes) {
    let score = 0;
    let strong = false;
    const evidence: string[] = [];
    if (urlPath !== undefined && routeMatches(route.path, urlPath)) {
      score += 0.6;
      strong = true;
      evidence.push(
        `l’URL indiquée correspond à la route /${route.path} (${route.file}:${String(route.line)})`,
      );
    }
    if (recorded !== undefined && routeMatches(route.path, recorded)) {
      score += 0.4;
      strong = true;
      evidence.push(`l’enregistrement associé démarre sur /${route.path}`);
    }
    const pathHits = overlap(query, wordsOf(route.path.replace(/:\w+/g, '')));
    if (pathHits.length > 0) {
      score += Math.min(0.3, 0.15 * pathHits.length);
      evidence.push(`la route /${route.path} contient « ${pathHits.join(', ')} »`);
    }
    const inbound = links.filter((link) => routeMatches(route.path, link.target));
    for (const link of inbound) {
      const hits = overlap(query, wordsOf(link.label));
      const hintHits = overlap(hints, wordsOf(link.label));
      if (hits.length > 0) {
        score += Math.min(0.35, 0.18 * hits.length);
        strong = true;
        evidence.push(`lien « ${link.label} » vers cet écran (${link.file}:${String(link.line)})`);
        break;
      }
      if (hintHits.length > 0) {
        score += 0.1;
        evidence.push(`lien « ${link.label} » cité par les indications (${link.file}:${String(link.line)})`);
        break;
      }
    }
    for (const heading of route.componentId ? (headings.get(route.componentId) ?? []) : []) {
      const hits = overlap(query, wordsOf(heading.text));
      if (hits.length > 0) {
        score += Math.min(0.3, 0.15 * hits.length);
        strong = true;
        evidence.push(`titre « ${heading.text} » de l’écran (${heading.file}:${String(heading.line)})`);
        break;
      }
    }
    const nameHits = route.component ? overlap(query, classWords(route.component)) : [];
    if (nameHits.length > 0) {
      score += 0.1;
      evidence.push(`nom du composant ${route.component ?? ''} (« ${nameHits.join(', ')} »)`);
    }
    if (score === 0) continue;
    const nameOnly = !strong;
    const confidence = Math.round(Math.min(nameOnly ? 0.45 : 0.95, score) * 100) / 100;
    out.push({
      route: `/${route.path}`,
      applicationId: route.applicationId,
      ...(route.component ? { component: route.component } : {}),
      ...(route.componentId ? { componentId: route.componentId } : {}),
      ...(route.componentFile ? { file: route.componentFile } : {}),
      ...(route.componentLine !== undefined ? { line: route.componentLine } : {}),
      confidence,
      evidence,
      nameOnly,
      guards: route.guards,
    });
  }
  return out.sort((a, b) => b.confidence - a.confidence || a.route.length - b.route.length).slice(0, 6);
}

/**
 * Le plus court parcours par liens depuis l'entrée de l'application (redirection de la racine) jusqu'à la
 * route cible : les liens d'un composant routé partent de sa route, ceux d'un composant sans route (coquille,
 * menu) partent de partout. Sans lien, l'accès direct par l'URL est proposé et dit.
 */
export function accessPath(
  models: readonly AngularModel[],
  target: string,
  known: { steps?: readonly string[]; recordingStart?: string } = {},
): { entry: string; path: NavigationStep[]; limits: string[] } {
  const { routes, redirects, links } = routesOf(models);
  const goal = routeKey(target);
  const entryKey = redirects.get('') ?? '';
  const entry = `/${entryKey}`;
  const limits: string[] = [];
  const componentRoute = new Map(
    routes.filter((route) => route.componentId).map((route) => [route.componentId ?? '', route.path]),
  );
  const edgesFrom = (from: string): LinkInfo[] =>
    links.filter(
      (link) => !link.from || !componentRoute.has(link.from) || componentRoute.get(link.from) === from,
    );
  const resolve = (key: string): string => redirects.get(key) ?? key;
  const steps: NavigationStep[] = [];
  let start = resolve(entryKey);
  // Un enregistrement associé : son départ, quand c'est une route connue, sert d'entrée (route observée).
  if (known.recordingStart !== undefined) {
    const recorded = pathKey(known.recordingStart);
    if (routes.some((route) => routeMatches(route.path, recorded))) {
      start = recorded;
      steps.push({
        kind: 'NAVIGATE',
        target: `/${recorded}`,
        label: `/${recorded}`,
        route: `/${recorded}`,
        source: 'RECORDING',
        evidence: 'départ de l’enregistrement associé',
      });
    }
  }
  if (steps.length === 0)
    steps.push({
      kind: 'NAVIGATE',
      target: entry,
      label: entry,
      route: `/${start}`,
      source: 'LINKS',
      evidence: entryKey ? `redirection de la racine vers /${entryKey}` : 'racine de l’application',
    });
  // Les étapes connues (mode guidé) : chacune est rapprochée d'un lien relevé depuis l'écran courant.
  for (const text of known.steps ?? []) {
    const words = wordsOf(text);
    const link = edgesFrom(start).find((candidate) => {
      const label = wordsOf(candidate.label);
      return label.length > 0 && label.every((word) => words.includes(word));
    });
    if (!link) {
      limits.push(
        `étape connue non rapprochée d’un lien de l’écran /${start} : « ${text} » (gardée comme indication)`,
      );
      continue;
    }
    start = resolve(link.target);
    steps.push({
      kind: 'CLICK',
      target: `link:${link.label}`,
      label: link.label,
      route: `/${start}`,
      source: 'GUIDED',
      evidence: `${link.file}:${String(link.line)}`,
    });
  }
  if (routeMatches(goal, start)) return { entry, path: steps, limits };
  // Largeur d'abord sur le graphe des liens.
  const previous = new Map<string, { from: string; link: LinkInfo }>();
  const queue = [start];
  const seen = new Set([start]);
  while (queue.length > 0) {
    const current = queue.shift() ?? '';
    if (routeMatches(goal, current)) break;
    for (const link of edgesFrom(current)) {
      const next = resolve(link.target);
      if (seen.has(next)) continue;
      seen.add(next);
      previous.set(next, { from: current, link });
      queue.push(next);
    }
  }
  const reached = [...seen].find((key) => routeMatches(goal, key));
  if (reached === undefined) {
    limits.push(
      `aucun lien relevé ne mène à /${goal} depuis /${start} : accès direct par l’URL (à vérifier dans le navigateur)`,
    );
    steps.push({
      kind: 'NAVIGATE',
      target: `/${goal}`,
      label: `/${goal}`,
      route: `/${goal}`,
      source: 'DIRECT',
    });
    return { entry, path: steps, limits };
  }
  const chain: NavigationStep[] = [];
  for (let key = reached; key !== start;) {
    const hop = previous.get(key);
    if (!hop) break;
    chain.unshift({
      kind: 'CLICK',
      target: `link:${hop.link.label}`,
      label: hop.link.label,
      route: `/${key}`,
      source: 'LINKS',
      evidence: `${hop.link.file}:${String(hop.link.line)}`,
    });
    key = hop.from;
  }
  return { entry, path: [...steps, ...chain], limits };
}

/** « Localiser l'écran » : candidats, écran retenu, parcours, gardes et limites. */
export function locateTarget(input: LocateInput): TargetLocation {
  const candidates = targetCandidates(input);
  const limits: string[] = [];
  if (!input.models.some((model) => model.navigation && model.navigation.routes.length > 0))
    limits.push(
      'aucune route Angular lue dans le périmètre : l’écran ne peut pas être localisé dans le code',
    );
  const forced = input.route ? `/${routeKey(input.route)}` : undefined;
  const chosen = forced ?? candidates[0]?.route;
  if (!chosen) {
    if (candidates.length === 0) limits.push(`aucun écran ne correspond à « ${input.query} »`);
    return {
      locatedAt: input.at,
      locatedBy: input.actor,
      query: input.query,
      candidates,
      entry: '/',
      path: [],
      guards: [],
      limits,
    };
  }
  const best = candidates.find((candidate) => candidate.route === chosen);
  if (best?.nameOnly)
    limits.push(
      `« ${chosen} » ne correspond que par son nom : identification incertaine, à confirmer dans le navigateur`,
    );
  const route = accessPath(input.models, chosen, {
    ...(input.steps ? { steps: input.steps } : {}),
    ...(input.recordingStart ? { recordingStart: input.recordingStart } : {}),
  });
  const { routes } = routesOf(input.models);
  // Les gardes de la route et de ses parents (préfixes) : l'accès est conditionné, jamais contourné.
  const guards = [
    ...new Set(
      routes
        .filter((item) => routeKey(chosen) === item.path || routeKey(chosen).startsWith(`${item.path}/`))
        .flatMap((item) => item.guards),
    ),
  ];
  if (guards.length > 0)
    limits.push(
      `accès protégé par ${guards.join(', ')} : une session autorisée est nécessaire ; QA-CRAWLER ne la crée pas et ne contourne pas la garde`,
    );
  if (/:\w+/.test(chosen))
    limits.push(`route paramétrée ${chosen} : un identifiant existant est nécessaire pour l’atteindre`);
  return {
    locatedAt: input.at,
    locatedBy: input.actor,
    query: input.query,
    candidates,
    chosen,
    entry: route.entry,
    path: route.path,
    guards,
    limits: [...limits, ...route.limits],
  };
}

/** Les actions du moteur pour un parcours (URL absolue pour une navigation). */
export function entryActions(path: readonly NavigationStep[], baseUrl: string): TriggerAction[] {
  const base = baseUrl.replace(/\/$/, '');
  return path.map((step) =>
    step.kind === 'NAVIGATE'
      ? {
          kind: 'NAVIGATE',
          target: `${base}${step.target.startsWith('/') ? step.target : `/${step.target}`}`,
          origin: 'target',
        }
      : { kind: 'CLICK', target: step.target, origin: 'target' },
  );
}

const LOGIN = /(login|connexion|signin|sign-in|auth)/i;

/** L'inventaire et les blocages d'un écran atteint (instantané du navigateur, événements du parcours). */
export function preparationOf(input: {
  route: string;
  snapshot: UiSnapshot;
  steps: TargetPreparation['steps'];
  events: readonly RuntimeEvent[];
  blockers: string[];
  actor: string;
  at: string;
  durationMs: number;
  screenshot?: string;
}): TargetPreparation {
  const { snapshot } = input;
  const names = (roles: readonly string[]): string[] =>
    snapshot.elements
      .filter((element) => roles.includes(element.role) && element.visible)
      .map((element) => element.name)
      .filter(Boolean)
      .slice(0, 30);
  const reachedPath = pathKey(snapshot.url);
  const reached = input.steps.every((step) => step.ok) && routeMatches(input.route, reachedPath);
  const blockers = [...input.blockers];
  if (!reached && snapshot.url && !routeMatches(input.route, reachedPath))
    blockers.push(`écran atteint /${reachedPath} au lieu de ${input.route}`);
  if (
    LOGIN.test(reachedPath) ||
    snapshot.elements.some((element) => /mot de passe|password/i.test(element.name))
  )
    blockers.push(
      'page de connexion : une session autorisée est nécessaire (aucun identifiant n’est saisi par QA-CRAWLER)',
    );
  const requests = input.events
    .filter((event) => event.kind === 'REQUEST')
    .map((event) => event.summary)
    .slice(0, 30);
  const errors = input.events
    .filter(
      (event) =>
        event.kind === 'PAGE_ERROR' ||
        (event.kind === 'CONSOLE' && event.level === 'error') ||
        event.kind === 'REQUEST_FAILED',
    )
    .map((event) => event.summary)
    .slice(0, 20);
  return {
    preparedAt: input.at,
    preparedBy: input.actor,
    route: input.route,
    reached: reached && blockers.length === 0,
    finalUrl: snapshot.url,
    title: snapshot.title,
    steps: input.steps,
    inventory: {
      buttons: names(['button']),
      fields: names(['textbox', 'searchbox', 'spinbutton', 'checkbox', 'radio']),
      links: names(['link']),
      selects: names(['combobox', 'listbox']),
      disabled: snapshot.elements
        .filter((element) => !element.enabled && element.visible)
        .map((element) => `${element.role}:${element.name}`)
        .slice(0, 20),
      dialogs: snapshot.elements.filter((element) => element.role === 'dialog').length,
      overlays: snapshot.overlays,
      messages: snapshot.messages.slice(0, 10),
      loading: snapshot.loading,
    },
    requests,
    errors,
    blockers,
    ...(input.screenshot ? { screenshot: input.screenshot } : {}),
    durationMs: input.durationMs,
  };
}
