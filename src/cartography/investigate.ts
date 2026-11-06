import type {
  Investigation,
  InvestigationAttempt,
  InvestigationBreak,
  InvestigationBudget,
  InvestigationCycle,
  InvestigationFrontierItem,
  InvestigationGoal,
  InvestigationHypothesis,
  InvestigationMode,
  InvestigationPath,
  InvestigationRequest,
  MapConfidence,
  MapEdge,
  MapNode,
  RelationNature,
  TraceDirection,
} from '../sdk/core/cartography.js';
import type { MapIndex } from './explorer.js';

/**
 * LE MOTEUR D'INVESTIGATION, au-dessus du graphe du scan (il ne relit aucune source et n'exécute rien).
 *
 * Une investigation part d'un élément, avec un objectif et un sens, et suit une boucle déterministe :
 * PLANIFIER (pondérer les relations selon l'objectif) → RECHERCHER (meilleur d'abord, sous budget) →
 * RÉSOUDRE (aux ruptures, des stratégies : corrélation, diagnostic de l'analyseur, lien non démontré,
 * implémentations, consommateurs, appelants, état des sources) → VÉRIFIER (une hypothèse ne devient un fait
 * que par une relation démontrée du graphe) → ÉVALUER (chemins, cycles, frontière) → POURSUIVRE à la demande
 * (« Explorer cette branche ») ou S'ARRÊTER en disant pourquoi.
 *
 * Règles : une relation structurelle n'est jamais une cause ; un lien non démontré n'est pas suivi en mode
 * ciblé (il devient une hypothèse) ; une branche n'est jamais fusionnée avec une autre ; un cycle ne coupe
 * que lui-même ; un budget atteint laisse une frontière reprenable ; un chemin est démontrable, jamais
 * « observé ».
 */

export const DEFAULT_BUDGET: InvestigationBudget = {
  nodes: 400,
  perBranch: 160,
  perNature: 400,
  depth: 30,
  fanOut: 12,
  timeMs: 2_000,
};
const MAX_BUDGET: InvestigationBudget = {
  nodes: 5_000,
  perBranch: 5_000,
  perNature: 20_000,
  depth: 80,
  fanOut: 1_000,
  timeMs: 15_000,
};
const MAX_PATHS = 60;
/** La mémoire utilisée, quand le moteur tourne dans Node (jamais exigée). */
const heapUsed = (): number | undefined =>
  typeof process === 'undefined' ? undefined : process.memoryUsage().heapUsed;
const MAX_PATH_STEPS = 20_000;
const MAX_CANDIDATES = 8;

const WEIGHTS: Record<InvestigationGoal, Record<RelationNature, number>> = {
  JOURNEY: { CAUSAL: 10, CONTRACT: 8, CONTROL: 5, DATA: 4, STRUCTURE: 2, COVERAGE: 0 },
  PERSISTENCE: { CAUSAL: 10, CONTRACT: 8, DATA: 6, CONTROL: 1, STRUCTURE: 1, COVERAGE: 0 },
  ENDPOINTS: { CAUSAL: 10, CONTRACT: 9, CONTROL: 1, DATA: 1, STRUCTURE: 1, COVERAGE: 0 },
  ENTRY_POINTS: { CAUSAL: 10, CONTRACT: 8, STRUCTURE: 6, CONTROL: 4, DATA: 2, COVERAGE: 0 },
  CONDITIONS: { CONTROL: 10, DATA: 6, CAUSAL: 5, CONTRACT: 4, STRUCTURE: 3, COVERAGE: 0 },
  DATA: { DATA: 10, CONTRACT: 6, CAUSAL: 5, CONTROL: 3, STRUCTURE: 1, COVERAGE: 0 },
};
const GOAL_KINDS: Record<InvestigationGoal, readonly string[]> = {
  JOURNEY: ['API', 'ENTITY', 'COLUMN', 'BUTTON'],
  PERSISTENCE: ['ENTITY', 'COLUMN'],
  ENDPOINTS: ['API'],
  ENTRY_POINTS: ['BUTTON', 'ROUTE'],
  CONDITIONS: ['CONDITION'],
  DATA: ['FIELD', 'COLUMN', 'ENTITY', 'DTO'],
};
const CONFIDENCE: Record<MapConfidence, number> = { CONFIRMED: 1, PROBABLE: 0.6, UNKNOWN: 0.2 };
const RANK: Record<MapConfidence, number> = { CONFIRMED: 2, PROBABLE: 1, UNKNOWN: 0 };
const ENTRY_KINDS = new Set(['BUTTON', 'ROUTE', 'FEATURE', 'SCREEN']);
const PERSISTENCE_KINDS = new Set(['ENTITY', 'COLUMN']);

/** La nature d'une relation : la même sorte de lien n'a pas le même sens selon ce qu'elle relie. */
export function natureOf(edge: MapEdge, nodes: ReadonlyMap<string, MapNode>): RelationNature {
  const from = nodes.get(edge.from)?.kind;
  const to = nodes.get(edge.to)?.kind;
  switch (edge.kind) {
    case 'VERIFIES':
    case 'COVERS':
      return 'COVERAGE';
    case 'TRIGGERS':
      return 'CAUSAL';
    // Un composant « appelle » les méthodes que son gabarit lie : composition, pas déclenchement.
    case 'CALLS':
      return from === 'COMPONENT' ? 'STRUCTURE' : 'CAUSAL';
    case 'VISIBLE_WHEN':
    case 'ENABLED_WHEN':
    case 'CONTROLLED_BY':
      return 'CONTROL';
    case 'READS':
    case 'WRITES':
    case 'SENDS':
    case 'TRANSFORMS':
    case 'INPUTS':
      return 'DATA';
    case 'CONTAINS':
    case 'REUSES':
    case 'DISPLAYS':
      return 'STRUCTURE';
    case 'DEPENDS_ON':
      if (from === 'CONDITION') return 'CONTROL';
      if (from === 'SERVICE' || from === 'COMPONENT') return 'STRUCTURE';
      if (from === 'API' && to === 'API') return 'CONTRACT';
      if (from === 'API' && to === 'METHOD') return 'CAUSAL';
      return 'DATA';
  }
}

/**
 * Le sens du flux d'une relation : la plupart vont de leur origine à leur cible, mais « A dépend de B »
 * (donnée calculée à partir de B, condition qui lit B, conteneur affiché si B) fait circuler B vers A.
 * L'aval suit le flux ; l'amont le remonte.
 */
export function flowOf(edge: MapEdge, nature: RelationNature): readonly [string, string] {
  const reversed = nature === 'CONTROL' || (nature === 'DATA' && edge.kind === 'DEPENDS_ON');
  return reversed ? [edge.to, edge.from] : [edge.from, edge.to];
}

const clampBudget = (budget: Partial<InvestigationBudget> | undefined): InvestigationBudget => {
  const out = { ...DEFAULT_BUDGET };
  for (const key of Object.keys(DEFAULT_BUDGET) as (keyof InvestigationBudget)[]) {
    const value = budget?.[key];
    if (typeof value === 'number' && Number.isFinite(value))
      out[key] = Math.min(MAX_BUDGET[key], Math.max(1, Math.trunc(value)));
  }
  return out;
};

const shortName = (id: string): string => {
  const tail = id.split('#').pop() ?? id;
  return tail.split('.').pop() ?? tail;
};
const sourceOf = (id: string): string => id.split(':')[1] ?? '';

type Sign = 1 | -1;
interface Visit {
  cost: number;
  branch: string;
  sign: Sign;
  depth: number;
  /** Une relation non structurelle a déjà été suivie depuis le départ. */
  causal?: boolean;
}

/**
 * Une relation de composition n'est suivie que là où elle a un sens pour le parcours : vers l'aval, tant
 * qu'aucune cause n'a été suivie (l'écran contient ses boutons) — un conteneur révélé par une action ne
 * déclenche pas les boutons qu'il contient, il faut un autre événement ; vers l'amont, jamais vers la classe
 * qui déclare une méthode (appartenir n'est pas appeler).
 */
const structureAllowed = (w: Work, sign: Sign, causal: boolean | undefined, to: string): boolean =>
  sign === 1 ? !causal : w.index.nodes.get(to)?.kind !== 'SERVICE';

interface Work {
  index: MapIndex;
  goal: InvestigationGoal;
  mode: InvestigationMode;
  budget: InvestigationBudget;
  start: string;
  direction: TraceDirection;
  visits: Map<string, Visit>;
  frontier: Map<string, InvestigationFrontierItem>;
  perBranch: Map<string, number>;
  perNature: Map<RelationNature, number>;
  natures: Map<string, RelationNature>;
  /** Les liens non démontrés rencontrés en mode ciblé : hypothèses, jamais suivis. */
  undemonstrated: MapEdge[];
  /** Les nœuds dont la personne a demandé la suite : leurs liens non démontrés sont suivis, marqués comme tels. */
  opened: Set<string>;
}

const natureCached = (w: Work, edge: MapEdge): RelationNature => {
  let n = w.natures.get(edge.id);
  if (!n) {
    n = natureOf(edge, w.index.nodes);
    w.natures.set(edge.id, n);
  }
  return n;
};

/** Les voisins d'un nœud dans un sens, avec le score de la relation pour l'objectif. */
function stepsOf(
  w: Work,
  id: string,
  sign: Sign,
): { edge: MapEdge; to: string; score: number; nature: RelationNature }[] {
  const out: { edge: MapEdge; to: string; score: number; nature: RelationNature }[] = [];
  for (const edge of [...(w.index.out.get(id) ?? []), ...(w.index.in.get(id) ?? [])]) {
    const nature = natureCached(w, edge);
    const weight = WEIGHTS[w.goal][nature];
    if (weight <= 0) continue;
    const [a, b] = flowOf(edge, nature);
    const from = sign === 1 ? a : b;
    if (from !== id) continue;
    const to = sign === 1 ? b : a;
    if (to === id) continue;
    const node = w.index.nodes.get(to);
    if (!node) continue;
    const degree = (w.index.out.get(to)?.length ?? 0) + (w.index.in.get(to)?.length ?? 0);
    const bonus = GOAL_KINDS[w.goal].includes(node.kind) ? 2 : 1;
    const score = (weight * CONFIDENCE[edge.confidence] * bonus) / Math.log2(2 + degree);
    out.push({ edge, to, score, nature });
  }
  // Ordre déterministe : meilleur score, puis identifiant.
  return out.sort((a, b) => b.score - a.score || (a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
}

const setFrontier = (
  w: Work,
  node: string,
  reason: InvestigationFrontierItem['reason'],
  pending: number,
  sign: Sign,
): void => {
  const current = w.frontier.get(node);
  if (current && current.reason === reason) current.pending += pending;
  else if (!current) w.frontier.set(node, { node, reason, pending, direction: sign === 1 ? 'DOWN' : 'UP' });
};

/** RECHERCHER : meilleur d'abord, sous budget ; chaque coupure laisse une frontière reprenable. */
function explore(w: Work, seeds: { id: string; sign: Sign; branch?: string }[], nodeBudget: number): void {
  const started = performance.now();
  // File de priorité simple (les volumes sont bornés par le budget) : coût croissant, puis identifiant.
  const queue: { id: string; sign: Sign; cost: number }[] = [];
  for (const s of seeds) {
    const v = w.visits.get(s.id);
    if (v) queue.push({ id: s.id, sign: s.sign, cost: v.cost });
  }
  let added = 0;
  while (queue.length > 0) {
    queue.sort((a, b) => a.cost - b.cost || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const cur = queue.shift();
    if (!cur) break;
    const visit = w.visits.get(cur.id);
    if (!visit) continue;
    const node = w.index.nodes.get(cur.id);
    const steps = stepsOf(w, cur.id, cur.sign);
    if (performance.now() - started > w.budget.timeMs) {
      setFrontier(w, cur.id, 'TIME', steps.length, cur.sign);
      for (const rest of queue)
        setFrontier(w, rest.id, 'TIME', stepsOf(w, rest.id, rest.sign).length, rest.sign);
      return;
    }
    if (visit.depth >= w.budget.depth) {
      if (steps.some((s) => !w.visits.has(s.to))) setFrontier(w, cur.id, 'DEPTH', steps.length, cur.sign);
      continue;
    }
    // Une classe n'est pas dépliée en toutes ses méthodes, sauf au départ.
    const structuralOnly = node?.kind === 'SERVICE' && cur.id !== w.start;
    let nonCausal = 0;
    for (const step of steps) {
      if (w.visits.has(step.to)) continue;
      if (step.nature === 'STRUCTURE' && !structureAllowed(w, cur.sign, visit.causal, step.to)) continue;
      if (structuralOnly && step.nature === 'STRUCTURE') {
        setFrontier(w, cur.id, 'FAN_OUT', 1, cur.sign);
        continue;
      }
      // Mode ciblé : un lien non démontré n'est pas suivi ; il reste une hypothèse à la frontière.
      if (w.mode === 'FOCUSED' && step.edge.confidence === 'UNKNOWN' && !w.opened.has(cur.id)) {
        w.undemonstrated.push(step.edge);
        setFrontier(w, cur.id, 'UNDEMONSTRATED', 1, cur.sign);
        continue;
      }
      // Les relations non causales d'un nœud très relié (store à cent propriétés) ne saturent pas l'exploration.
      const causal = step.nature === 'CAUSAL' || step.nature === 'CONTRACT';
      if (!causal && w.mode === 'FOCUSED' && (nonCausal += 1) > w.budget.fanOut) {
        setFrontier(w, cur.id, 'FAN_OUT', 1, cur.sign);
        continue;
      }
      if ((w.perNature.get(step.nature) ?? 0) >= w.budget.perNature) {
        setFrontier(w, cur.id, 'NATURE_BUDGET', 1, cur.sign);
        continue;
      }
      const branch = cur.id === w.start ? step.to : visit.branch;
      if ((w.perBranch.get(branch) ?? 0) >= w.budget.perBranch) {
        setFrontier(w, cur.id, 'BRANCH_BUDGET', 1, cur.sign);
        continue;
      }
      if (added >= nodeBudget) {
        setFrontier(w, cur.id, 'BUDGET', 1, cur.sign);
        continue;
      }
      added += 1;
      w.perNature.set(step.nature, (w.perNature.get(step.nature) ?? 0) + 1);
      w.perBranch.set(branch, (w.perBranch.get(branch) ?? 0) + 1);
      const cost = visit.cost + 1 / Math.max(0.01, step.score);
      w.visits.set(step.to, {
        cost,
        branch,
        sign: cur.sign,
        depth: visit.depth + 1,
        causal: visit.causal === true || step.nature !== 'STRUCTURE',
      });
      queue.push({ id: step.to, sign: cur.sign, cost });
    }
  }
}

interface Findings {
  breaks: Map<string, InvestigationBreak>;
  hypotheses: Map<string, InvestigationHypothesis>;
  attempts: InvestigationAttempt[];
  /** Les nœuds où une rupture est expliquée comme une fin légitime (consommateur démontré, point d'entrée). */
  explained: Set<string>;
}

const addBreak = (f: Findings, b: InvestigationBreak): void => {
  const key = `${b.code}|${b.at}`;
  if (!f.breaks.has(key)) f.breaks.set(key, b);
};
const addHypothesis = (f: Findings, h: Omit<InvestigationHypothesis, 'id'>): void => {
  const id = `${h.source}|${h.at}|${h.claim}`;
  if (!f.hypotheses.has(id)) f.hypotheses.set(id, { id, ...h });
};

/** RÉSOUDRE et VÉRIFIER : aux nœuds sans suite démontrée, chaque stratégie est tentée une fois, avec son issue. */
function resolve(w: Work, done: ReadonlySet<string>, f: Findings): void {
  const { index } = w;
  const correlations = new Map<string, NonNullable<typeof index.model.correlations>>();
  for (const c of index.model.correlations ?? [])
    correlations.set(c.from, [...(correlations.get(c.from) ?? []), c]);
  const partial = new Set(
    index.model.scan.sources
      .filter((s) => s.state === 'PARTIAL' || s.state === 'FAILED')
      .map((s) => s.sourceId),
  );
  const outbound = new Set<string>();
  // Seul un appel vers une API externe établie termine une branche ; un appel « à classifier » ne le fait pas.
  for (const api of index.model.apis ?? [])
    if (api.scope === 'EXTERNAL') for (const call of api.calls) outbound.add(call.from);
  const attempt = (a: InvestigationAttempt): void => {
    const key = `${a.strategy}|${a.at}`;
    if (done.has(key) || f.attempts.some((x) => `${x.strategy}|${x.at}` === key)) return;
    f.attempts.push(a);
  };
  const nodeName = (id: string): string => index.nodes.get(id)?.name ?? id;
  const byName = new Map<string, string[]>();
  const byNameOf = (src: string, name: string, layer: string): string[] => {
    const key = `${src}|${layer}|${name}`;
    let list = byName.get(key);
    if (!list) {
      list = [];
      for (const n of index.nodes.values())
        if (n.kind === 'METHOD' && n.layer === layer && sourceOf(n.id) === src && shortName(n.id) === name)
          list.push(n.id);
      byName.set(key, list);
    }
    return list;
  };

  for (const [id, visit] of w.visits) {
    const node = index.nodes.get(id);
    if (!node) continue;
    const sign = visit.sign;
    // 1. Corrélation inter-couches : une liaison non confirmée est une rupture ou une hypothèse, jamais un fait.
    for (const c of correlations.get(id) ?? []) {
      // Une issue qui change selon la variante (profil, configuration) : contradictoire, même confirmée par défaut.
      const statuses = new Set([c.status, ...(c.variants ?? []).map((v) => v.status)]);
      if (statuses.size > 1)
        addHypothesis(f, {
          at: id,
          claim: `${c.method} ${c.path} : l'issue diffère selon la variante de configuration`,
          status: 'CONTRADICTORY',
          candidates: [...new Set((c.variants ?? []).flatMap((v) => (v.target ? [v.target] : [])))],
          evidence: [`défaut : ${c.status}`, ...(c.variants ?? []).map((v) => `${v.variant} : ${v.status}`)],
          source: 'ANALYZER',
        });
      if (c.status === 'CONFIRMED') continue;
      const candidates = [
        ...new Set([
          ...(c.target ? [c.target] : []),
          ...c.candidates.filter((x) => !x.rejected).map((x) => x.node),
        ]),
      ].slice(0, MAX_CANDIDATES);
      const message = c.causes[0]?.message ?? `${c.method} ${c.path} : liaison ${c.status.toLowerCase()}`;
      if (c.status === 'PROBABLE')
        addHypothesis(f, {
          at: id,
          claim: `${c.method} ${c.path} est servi par ${c.target ?? '?'}`,
          status: 'CANDIDATE',
          candidates,
          evidence: c.causes.map((x) => `${x.code} : ${x.message}`),
          source: 'ANALYZER',
        });
      else
        addBreak(f, {
          at: id,
          code: c.causes[0]?.code ?? 'NO_ENDPOINT',
          message: `${c.method} ${c.path} — ${message}`,
          hints: [...(c.diagnostic?.examined ?? []), ...(c.diagnostic?.limits ?? [])].slice(0, 8),
          resolutions: c.diagnostic?.suggestions ?? [],
        });
      if (c.status !== 'PROBABLE' && candidates.length)
        addHypothesis(f, {
          at: id,
          claim: `${c.method} ${c.path} correspond peut-être à l'un des candidats`,
          status: 'CANDIDATE',
          candidates,
          evidence: c.candidates
            .map((x) => `${x.node} : ${x.reasons.join(', ')}${x.rejected ? ` (écarté : ${x.rejected})` : ''}`)
            .slice(0, MAX_CANDIDATES),
          source: 'ANALYZER',
        });
      // Une lecture partielle de la source cherchée est dite à part : l'absence de cible n'y est pas une preuve.
      if (c.causes.some((x) => x.code === 'SOURCE_PARTIAL') && c.causes[0]?.code !== 'SOURCE_PARTIAL')
        addBreak(f, {
          at: id,
          code: 'SOURCE_PARTIAL',
          message: c.causes.find((x) => x.code === 'SOURCE_PARTIAL')?.message ?? '',
          hints: c.diagnostic?.limits ?? [],
          resolutions: ['relancer le scan avec des limites de lecture plus larges'],
        });
      attempt({
        at: id,
        strategy: 'CORRELATION',
        outcome: candidates.length ? 'CANDIDATES' : 'NOTHING',
        detail: `${c.method} ${c.path} : ${c.status}${c.causes.length ? ` (${c.causes.map((x) => x.code).join(', ')})` : ''}`,
        ...(candidates.length ? { found: candidates } : {}),
      });
    }
    // 2. Les ruptures typées de l'analyseur du frontal (cycle, limite, flux non souscrit, URL dynamique…).
    const breaks = Array.isArray(node.detail.breaks) ? node.detail.breaks : [];
    for (const raw of breaks) {
      const [code = 'UNKNOWN', at = '', ...rest] = raw.split('|');
      const target =
        [`METHOD:${sourceOf(id)}:${at}`, `STREAM:${sourceOf(id)}:${at}`].find((x) => index.nodes.has(x)) ??
        id;
      addBreak(f, {
        at: target,
        code,
        message: rest.join('|'),
        hints: [`relevé par l'analyseur depuis ${nodeName(id)}`],
        resolutions:
          code === 'LIMIT'
            ? ['reprendre depuis ce point (« Explorer cette branche ») ; l’analyse du frontal est bornée']
            : code === 'CYCLE'
              ? ['examiner les sorties du cycle : elles restent explorées']
              : [],
      });
      attempt({
        at: id,
        strategy: 'ANALYZER_DIAGNOSTIC',
        outcome: 'NOTHING',
        detail: `${code} : ${rest.join('|')}`,
      });
    }

    // Les fins de branche : aucun voisin suivi dans le sens de la visite.
    const next = stepsOf(w, id, sign);
    // 3. Un lien non démontré (Observable jamais souscrit, chaîne perdue) : une hypothèse, pas une suite.
    const unknown = next.filter((s) => s.edge.confidence === 'UNKNOWN' && !w.visits.has(s.to));
    if (unknown.length && w.mode === 'FOCUSED' && !w.opened.has(id)) {
      addHypothesis(f, {
        at: id,
        claim: `${nodeName(id)} mène peut-être à ${unknown.map((u) => nodeName(u.to)).join(', ')}`,
        status: 'CANDIDATE',
        candidates: unknown.map((u) => u.to).slice(0, MAX_CANDIDATES),
        evidence: unknown.map((u) => u.edge.reason).slice(0, MAX_CANDIDATES),
        source: 'ANALYZER',
      });
      attempt({
        at: id,
        strategy: 'UNDEMONSTRATED_LINK',
        outcome: 'CANDIDATES',
        detail: unknown[0]?.edge.reason ?? '',
        found: unknown.map((u) => u.to).slice(0, MAX_CANDIDATES),
      });
    }
    const continues = next.some((s) => w.visits.has(s.to) && w.visits.get(s.to)?.sign === sign);
    if (continues || w.frontier.has(id)) continue;
    // 7. Une source lue en partie : l'absence de suite n'est pas une preuve.
    if (partial.has(sourceOf(id))) {
      attempt({
        at: id,
        strategy: 'SOURCE_STATE',
        outcome: 'NOTHING',
        detail: `source ${sourceOf(id)} lue en partie`,
      });
      addBreak(f, {
        at: id,
        code: 'SOURCE_PARTIAL',
        message: `la source ${sourceOf(id)} n'a été lue qu'en partie : la suite peut se trouver dans la partie non lue`,
        hints: [],
        resolutions: ['relancer le scan avec des limites de lecture plus larges'],
      });
    }
    if (sign === 1) {
      if (PERSISTENCE_KINDS.has(node.kind) || outbound.has(id)) continue;
      if (node.kind === 'STREAM') {
        // 5. Un flux sans suite : consommé par l'écran (fin locale) ou sans consommateur démontré.
        const consumers = Array.isArray(node.detail.consumers) ? node.detail.consumers : [];
        attempt({
          at: id,
          strategy: 'CONSUMERS',
          outcome: consumers.length ? 'RESOLVED' : 'NOTHING',
          detail: consumers.length ? `consommé par ${consumers.join(', ')}` : 'aucun consommateur démontré',
          ...(consumers.length ? { found: consumers } : {}),
        });
        if (consumers.length) f.explained.add(id);
        else
          addBreak(f, {
            at: id,
            code: 'SUBJECT_NO_CONSUMER',
            message: `${node.name} reçoit des émissions, mais aucun consommateur n'est démontré`,
            hints: [],
            resolutions: ['chercher un subscribe, un pipe async ou un flux dérivé hors des sources lues'],
          });
        continue;
      }
      if (node.kind === 'API') {
        const notImplemented = node.detail.implemented === false;
        addBreak(f, {
          at: id,
          code: notImplemented ? 'CONTRACT_NOT_IMPLEMENTED' : 'NO_HANDLER',
          message: notImplemented
            ? `${node.name} : aucune implémentation du contrat n'est lue`
            : `${node.name} : aucune méthode servante n'est démontrée`,
          hints: typeof node.detail.implementation === 'string' ? [node.detail.implementation] : [],
          resolutions: ['ajouter la source qui sert cet endpoint, ou vérifier l’interface générée'],
        });
        continue;
      }
      if (node.kind === 'METHOD' && !unknown.length && !shortName(id).includes('⟨')) {
        // 4. Une méthode sans suite : une implémentation ailleurs (interface, classe abstraite) ?
        const candidates = byNameOf(sourceOf(id), shortName(id), node.layer).filter(
          (c) => c !== id && (index.out.get(c)?.length ?? 0) > 0,
        );
        attempt({
          at: id,
          strategy: 'IMPLEMENTATIONS',
          outcome: candidates.length ? 'CANDIDATES' : 'NOTHING',
          detail: candidates.length
            ? `${String(candidates.length)} méthode(s) de même nom ont une suite`
            : 'aucune autre méthode de même nom n’a de suite : fin locale',
          ...(candidates.length ? { found: candidates.slice(0, MAX_CANDIDATES) } : {}),
        });
        if (candidates.length) {
          addHypothesis(f, {
            at: id,
            claim: `${nodeName(id)} est peut-être implémentée par ${candidates.slice(0, 3).map(nodeName).join(', ')}`,
            status: 'CANDIDATE',
            candidates: candidates.slice(0, MAX_CANDIDATES),
            evidence: ['même nom de méthode dans la même source (indice, jamais une preuve)'],
            source: 'ANALYZER',
          });
          addBreak(f, {
            at: id,
            code: 'SYMBOL_UNRESOLVED',
            message: `${nodeName(id)} : aucune suite démontrée ; implémentations candidates par le nom`,
            hints: candidates.slice(0, MAX_CANDIDATES).map(nodeName),
            resolutions: ['vérifier l’injection (interface, profil, qualifier) qui choisit l’implémentation'],
          });
        }
      }
    } else {
      if (ENTRY_KINDS.has(node.kind) || node.kind === 'COMPONENT') {
        f.explained.add(id);
        continue;
      }
      if (node.kind === 'METHOD' && id !== w.start) {
        // 6. Une méthode qu'aucun appelant démontré n'atteint ; une méthode générique est appelée par ses
        // versions contextualisées (`dispatch⟨'X'⟩`), qui portent chacune leurs appelants.
        const clones = [...index.nodes.keys()].filter(
          (x) => x.startsWith(`${id}⟨`) && (index.in.get(x)?.length ?? 0) > 0,
        );
        if (clones.length) {
          attempt({
            at: id,
            strategy: 'CALLERS',
            outcome: 'RESOLVED',
            detail: `appelée dans ${String(clones.length)} contexte(s) distingué(s) : ${clones.map(nodeName).join(', ')}`,
            found: clones.slice(0, MAX_CANDIDATES),
          });
          f.explained.add(id);
          continue;
        }
        attempt({ at: id, strategy: 'CALLERS', outcome: 'NOTHING', detail: 'aucun appelant démontré' });
        addBreak(f, {
          at: id,
          code: 'NO_CALLER',
          message: `${nodeName(id)} : aucun appelant ni déclencheur démontré`,
          hints: [],
          resolutions: ['chercher un appel indirect (événement, planification, réflexion) hors du graphe lu'],
        });
      }
    }
  }
}

/** Les composantes fortement connexes (Tarjan, itératif) du sous-graphe parcouru : les cycles réels. */
function cyclesOf(w: Work, edges: readonly MapEdge[]): InvestigationCycle[] {
  const adj = new Map<string, string[]>();
  const flowEdges: { from: string; to: string; nature: RelationNature }[] = [];
  for (const e of edges) {
    const nature = natureCached(w, e);
    if (nature === 'STRUCTURE' || nature === 'COVERAGE') continue;
    const [from, to] = flowOf(e, nature);
    flowEdges.push({ from, to, nature });
    adj.set(from, [...(adj.get(from) ?? []), to]);
  }
  const indexOf = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: InvestigationCycle[] = [];
  let counter = 0;
  for (const root of [...adj.keys()].sort()) {
    if (indexOf.has(root)) continue;
    const work: { id: string; i: number }[] = [{ id: root, i: 0 }];
    indexOf.set(root, counter);
    low.set(root, counter);
    counter += 1;
    stack.push(root);
    onStack.add(root);
    while (work.length) {
      const top = work[work.length - 1];
      if (!top) break;
      const list = adj.get(top.id) ?? [];
      if (top.i < list.length) {
        const next = list[top.i] ?? '';
        top.i += 1;
        if (!indexOf.has(next)) {
          indexOf.set(next, counter);
          low.set(next, counter);
          counter += 1;
          stack.push(next);
          onStack.add(next);
          work.push({ id: next, i: 0 });
        } else if (onStack.has(next)) low.set(top.id, Math.min(low.get(top.id) ?? 0, indexOf.get(next) ?? 0));
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.id, Math.min(low.get(parent.id) ?? 0, low.get(top.id) ?? 0));
      if (low.get(top.id) === indexOf.get(top.id)) {
        const component: string[] = [];
        for (let x = stack.pop(); x !== undefined; x = stack.pop()) {
          onStack.delete(x);
          component.push(x);
          if (x === top.id) break;
        }
        const selfLoop = component.length === 1 && (adj.get(top.id) ?? []).includes(top.id);
        if (component.length > 1 || selfLoop) {
          const members = new Set(component);
          const inner = flowEdges.filter((e) => members.has(e.from) && members.has(e.to));
          const natures = new Set(inner.map((e) => e.nature));
          const kinds = component.map((id) => w.index.nodes.get(id)?.kind);
          const nature: InvestigationCycle['nature'] = kinds.includes('STREAM')
            ? 'STATE'
            : natures.size === 1 && natures.has('CAUSAL')
              ? 'CALL'
              : natures.has('DATA')
                ? 'DATA'
                : 'CALL';
          const exits = [
            ...new Set(flowEdges.filter((e) => members.has(e.from) && !members.has(e.to)).map((e) => e.to)),
          ].sort();
          out.push({ nodes: component.sort(), nature, exits });
        }
      }
    }
  }
  return out;
}

/** ÉVALUER : les chemins démontrables, branche par branche (jamais fusionnées), du départ à leur fin. */
function pathsOf(
  w: Work,
  edges: readonly MapEdge[],
  breakAt: ReadonlySet<string>,
  explained: ReadonlySet<string>,
): { paths: InvestigationPath[]; truncated: boolean } {
  const outbound = new Set<string>();
  for (const api of w.index.model.apis ?? [])
    if (api.scope === 'EXTERNAL') for (const call of api.calls) outbound.add(call.from);
  const paths: InvestigationPath[] = [];
  let truncated = false;
  let steps = 0;
  for (const sign of [1, -1] as const) {
    const adj = new Map<string, { e: MapEdge; to: string }[]>();
    for (const e of edges) {
      const nature = natureCached(w, e);
      if (nature === 'COVERAGE' || WEIGHTS[w.goal][nature] <= 0) continue;
      const [f, t] = flowOf(e, nature);
      if (w.mode === 'FOCUSED' && e.confidence === 'UNKNOWN' && !w.opened.has(sign === 1 ? f : t)) continue;
      const [a, b] = sign === 1 ? [f, t] : [t, f];
      if (w.visits.get(a)?.sign !== sign && a !== w.start) continue;
      if (w.visits.get(b)?.sign !== sign) continue;
      // Deux relations parallèles entre les mêmes nœuds font un seul pas : la plus sûre.
      const list = adj.get(a) ?? [];
      const same = list.findIndex((x) => x.to === b);
      if (same < 0) list.push({ e, to: b });
      else if (RANK[e.confidence] > RANK[list[same]?.e.confidence ?? 'UNKNOWN']) list[same] = { e, to: b };
      adj.set(a, list);
    }
    if (!adj.has(w.start)) continue;
    for (const list of adj.values())
      list.sort((x, y) => (w.visits.get(x.to)?.cost ?? 0) - (w.visits.get(y.to)?.cost ?? 0));
    const stackNodes: string[] = [w.start];
    const stackEdges: MapEdge[] = [];
    const onStack = new Set([w.start]);
    const emit = (end: InvestigationPath['end'], status: InvestigationPath['status']): void => {
      if (paths.length >= MAX_PATHS) {
        truncated = true;
        return;
      }
      const confidence = stackEdges.reduce<MapConfidence>(
        (acc, e) => (RANK[e.confidence] < RANK[acc] ? e.confidence : acc),
        'CONFIRMED',
      );
      const conditions = [
        ...new Set([
          ...stackEdges.flatMap((e) => (e.detail?.condition ? [e.detail.condition] : [])),
          ...stackNodes.flatMap((id) => {
            const n = w.index.nodes.get(id);
            return n?.kind === 'CONDITION' ? [n.label ?? n.name] : [];
          }),
        ]),
      ];
      paths.push({
        id: `${sign === 1 ? 'D' : 'U'}${String(paths.length + 1)}`,
        direction: sign === 1 ? 'DOWN' : 'UP',
        nodes: [...stackNodes],
        edges: stackEdges.map((e) => e.id),
        status,
        end,
        confidence,
        conditions,
      });
    };
    const endOf = (
      id: string,
      blockedByCycle: boolean,
    ): [InvestigationPath['end'], InvestigationPath['status']] => {
      const node = w.index.nodes.get(id);
      if (w.frontier.has(id)) return ['FRONTIER', 'PARTIAL'];
      if (breakAt.has(id) && !explained.has(id)) return ['BREAK', 'BROKEN'];
      if (blockedByCycle) return ['CYCLE', 'PARTIAL'];
      if (sign === -1) return ['ENTRY', 'COMPLETE'];
      if (node && PERSISTENCE_KINDS.has(node.kind)) return ['PERSISTENCE', 'COMPLETE'];
      if (outbound.has(id)) return ['EXTERNAL', 'COMPLETE'];
      if (node?.kind === 'API') return ['ENDPOINT', 'PARTIAL'];
      return ['LOCAL', 'COMPLETE'];
    };
    const classify = (id: string, blockedByCycle: boolean): void => {
      emit(...endOf(id, blockedByCycle));
    };
    const dfs = (id: string): void => {
      if ((steps += 1) > MAX_PATH_STEPS || paths.length >= MAX_PATHS) {
        truncated = true;
        return;
      }
      const causal = stackEdges.some((e) => natureCached(w, e) !== 'STRUCTURE');
      const next = (adj.get(id) ?? []).filter(
        (x) => natureCached(w, x.e) !== 'STRUCTURE' || structureAllowed(w, sign, causal, x.to),
      );
      const open = next.filter((x) => !onStack.has(x.to));
      if (open.length === 0 && id !== w.start) {
        classify(id, next.length > 0);
        return;
      }
      for (const { e, to } of open) {
        onStack.add(to);
        stackNodes.push(to);
        stackEdges.push(e);
        dfs(to);
        stackNodes.pop();
        stackEdges.pop();
        onStack.delete(to);
        if (truncated) return;
      }
    };
    dfs(w.start);
  }
  const order: Record<InvestigationPath['status'], number> = { COMPLETE: 0, PARTIAL: 1, BROKEN: 2 };
  paths.sort(
    (a, b) =>
      order[a.status] - order[b.status] ||
      RANK[b.confidence] - RANK[a.confidence] ||
      b.nodes.length - a.nodes.length ||
      (a.id < b.id ? -1 : 1),
  );
  return { paths, truncated };
}

/** Assembler le résultat (sous-graphe, chemins, cycles, constats) depuis l'état de l'exploration. */
function assemble(
  w: Work,
  base: Pick<Investigation, 'id' | 'createdAt' | 'expansions'> & { previous?: string },
  findings: Findings,
  started: number,
  heapBefore: number | undefined,
): Investigation {
  const { index } = w;
  const nodes = [...w.visits.keys()]
    .map((id) => index.nodes.get(id))
    .filter((n): n is MapNode => n !== undefined);
  const edges: MapEdge[] = [];
  for (const id of w.visits.keys())
    for (const e of index.out.get(id) ?? [])
      if (w.visits.has(e.to) && natureCached(w, e) !== 'COVERAGE') edges.push(e);
  const breakAt = new Set([...findings.breaks.values()].map((b) => b.at));
  const { paths, truncated } = pathsOf(w, edges, breakAt, findings.explained);
  const useful = new Set(paths.flatMap((p) => p.edges));
  const cycles = cyclesOf(w, edges);
  const frontier = [...w.frontier.values()].sort((a, b) => (a.node < b.node ? -1 : 1));
  const partialSources = index.model.scan.sources.filter(
    (s) => s.state === 'PARTIAL' || s.state === 'FAILED',
  );
  const limitations = [
    'analyse statique : un chemin est démontrable, jamais observé ; la valeur réelle d’une condition n’est pas connue',
    ...(w.mode === 'FOCUSED'
      ? ['mode ciblé : les liens non démontrés sont des hypothèses, pas des suites']
      : []),
    ...(frontier.length
      ? [
          `${String(frontier.length)} branche(s) non explorée(s) (budget, profondeur, nature ou lien non démontré)`,
        ]
      : []),
    ...(truncated ? [`chemins listés limités à ${String(MAX_PATHS)}`] : []),
    ...partialSources.map(
      (s) => `source ${s.name} : ${s.state === 'PARTIAL' ? 'lue en partie' : 'en échec'}`,
    ),
  ];
  const heap = heapUsed();
  const breaks = [...findings.breaks.values()].filter((b) => !findings.explained.has(b.at));
  const hypotheses = [...findings.hypotheses.values()];
  return {
    id: base.id,
    scanId: index.scanId,
    revisions: Object.fromEntries(index.model.scan.sources.map((s) => [s.sourceId, s.revision ?? 'NONE'])),
    createdAt: base.createdAt,
    updatedAt: new Date().toISOString(),
    request: { start: w.start, goal: w.goal, direction: w.direction, mode: w.mode, budget: w.budget },
    state:
      frontier.length === 0 && breaks.length === 0 && partialSources.length === 0 && !truncated
        ? 'COMPLETE'
        : 'PARTIAL',
    nodes,
    edges,
    natures: Object.fromEntries(edges.map((e) => [e.id, natureCached(w, e)])),
    levels: Object.fromEntries([...w.visits].map(([id, v]) => [id, v.sign * v.depth])),
    paths,
    pathsTruncated: truncated,
    breaks,
    hypotheses,
    attempts: findings.attempts,
    frontier,
    cycles,
    expansions: base.expansions,
    trail: Object.fromEntries(
      [...w.visits].map(([id, v]) => [
        id,
        { cost: v.cost, branch: v.branch, ...(v.causal ? { causal: true } : {}) },
      ]),
    ),
    ...(base.previous ? { previous: base.previous } : {}),
    metrics: {
      visited: w.visits.size,
      useful: useful.size,
      searches: findings.attempts.length,
      resolved: findings.attempts.filter((a) => a.outcome === 'RESOLVED').length,
      remaining: frontier.length,
      ms: Math.round(performance.now() - started),
      ...(heap !== undefined && heapBefore !== undefined
        ? { heapKb: Math.max(0, Math.round((heap - heapBefore) / 1024)) }
        : {}),
    },
    limitations,
  };
}

/** Lancer une investigation depuis un élément ; undefined : élément inconnu de ce scan. */
export function investigate(
  index: MapIndex,
  request: InvestigationRequest,
  base: { id: string; now?: Date; previous?: string } = { id: 'inv' },
): Investigation | undefined {
  if (!index.nodes.has(request.start)) return undefined;
  const started = performance.now();
  const heapBefore = heapUsed();
  const direction = request.direction ?? 'DOWN';
  const w: Work = {
    index,
    goal: request.goal ?? 'JOURNEY',
    mode: request.mode ?? 'FOCUSED',
    budget: clampBudget(request.budget),
    start: request.start,
    direction,
    visits: new Map(),
    frontier: new Map(),
    perBranch: new Map(),
    perNature: new Map(),
    natures: new Map(),
    undemonstrated: [],
    opened: new Set(),
  };
  const signs: Sign[] = direction === 'UP' ? [-1] : direction === 'DOWN' ? [1] : [1, -1];
  w.visits.set(request.start, { cost: 0, branch: request.start, sign: signs[0] ?? 1, depth: 0 });
  // Le départ part dans chaque sens demandé ; un nœud atteint dans un sens ne poursuit que dans ce sens.
  for (const sign of signs) {
    const v = w.visits.get(request.start);
    if (v) v.sign = sign;
    explore(w, [{ id: request.start, sign }], w.budget.nodes);
  }
  const findings: Findings = { breaks: new Map(), hypotheses: new Map(), attempts: [], explained: new Set() };
  resolve(w, new Set(), findings);
  const now = (base.now ?? new Date()).toISOString();
  return assemble(
    w,
    { id: base.id, createdAt: now, expansions: [], ...(base.previous ? { previous: base.previous } : {}) },
    findings,
    started,
    heapBefore,
  );
}

export class InvestigationStaleError extends Error {
  constructor() {
    super('the scan changed since this investigation: run it again');
    this.name = 'InvestigationStaleError';
  }
}

/**
 * POURSUIVRE une branche : la reprise part d'un nœud de la frontière avec un budget neuf, sans refaire ce qui
 * est déjà validé (visites, tentatives). Refusée si le scan a changé : la preuve d'avant ne vaut plus.
 */
export function expandInvestigation(
  index: MapIndex,
  previous: Investigation,
  node: string,
  budget?: Partial<InvestigationBudget>,
): Investigation | undefined {
  if (previous.scanId !== index.scanId) throw new InvestigationStaleError();
  const item = previous.frontier.find((f) => f.node === node);
  if (!item || !index.nodes.has(node)) return undefined;
  const started = performance.now();
  const heapBefore = heapUsed();
  const merged = clampBudget({ ...previous.request.budget, ...budget });
  const w: Work = {
    index,
    goal: previous.request.goal,
    mode: previous.request.mode,
    budget: { ...merged, fanOut: item.reason === 'FAN_OUT' ? MAX_BUDGET.fanOut : merged.fanOut },
    start: previous.request.start,
    direction: previous.request.direction,
    visits: new Map(),
    frontier: new Map(previous.frontier.filter((f) => f.node !== node).map((f) => [f.node, { ...f }])),
    perBranch: new Map(),
    perNature: new Map(),
    natures: new Map(Object.entries(previous.natures)),
    undemonstrated: [],
    // « Explorer cette branche » sur un lien non démontré : il est suivi, marqué comme tel (jamais confirmé).
    opened: new Set([...previous.expansions, node]),
  };
  for (const [id, t] of Object.entries(previous.trail)) {
    const level = previous.levels[id] ?? 0;
    w.visits.set(id, {
      cost: t.cost,
      branch: t.branch,
      sign: level < 0 ? -1 : 1,
      depth: Math.abs(level),
      ...(t.causal ? { causal: true } : {}),
    });
  }
  const sign: Sign = item.direction === 'UP' ? -1 : 1;
  const visit = w.visits.get(node);
  if (visit) {
    visit.sign = sign;
    // La reprise d'une branche coupée par la profondeur repart avec une profondeur neuve.
    if (item.reason === 'DEPTH') visit.depth = 0;
  }
  explore(w, [{ id: node, sign }], w.budget.nodes);
  const findings: Findings = {
    breaks: new Map(),
    hypotheses: new Map(),
    attempts: [...previous.attempts],
    explained: new Set(),
  };
  resolve(w, new Set(previous.attempts.map((a) => `${a.strategy}|${a.at}`)), findings);
  const result = assemble(
    w,
    {
      id: previous.id,
      createdAt: previous.createdAt,
      expansions: [...previous.expansions, node],
      ...(previous.previous ? { previous: previous.previous } : {}),
    },
    findings,
    started,
    heapBefore,
  );
  result.request = previous.request;
  return result;
}

/**
 * L'EXTENSION FACULTATIVE (désactivée par défaut, aucun fournisseur intégré) : une extension peut proposer des
 * pistes à partir des seuls identifiants et noms (jamais de code ni de secret). Chaque piste est vérifiée ici :
 * elle n'est SUPPORTED que si une relation démontrée du graphe relie déjà les deux éléments ; elle ne crée
 * jamais de relation et ne confirme jamais rien seule.
 */
export interface AdvisorSuggestion {
  at: string;
  claim: string;
  candidates: string[];
}

export function applyAdvice(
  index: MapIndex,
  investigation: Investigation,
  suggestions: readonly AdvisorSuggestion[],
  limit = 20,
): Investigation {
  const hypotheses = [...investigation.hypotheses];
  const attempts = [...investigation.attempts];
  for (const s of suggestions.slice(0, limit)) {
    if (!index.nodes.has(s.at)) continue;
    const linked = s.candidates.filter((c) =>
      [...(index.out.get(s.at) ?? []), ...(index.in.get(s.at) ?? [])].some(
        (e) =>
          e.confidence === 'CONFIRMED' &&
          (e.to === c || e.from === c) &&
          natureOf(e, index.nodes) !== 'STRUCTURE' &&
          natureOf(e, index.nodes) !== 'COVERAGE',
      ),
    );
    hypotheses.push({
      id: `ADVISOR|${s.at}|${s.claim}`,
      at: s.at,
      claim: s.claim,
      status: linked.length ? 'SUPPORTED' : 'CANDIDATE',
      candidates: s.candidates.filter((c) => index.nodes.has(c)).slice(0, MAX_CANDIDATES),
      evidence: linked.length
        ? linked.map((c) => `relation démontrée avec ${c}`)
        : ['aucune relation démontrée : piste à vérifier'],
      source: 'ADVISOR',
    });
    attempts.push({
      at: s.at,
      strategy: 'ADVISOR',
      outcome: linked.length ? 'RESOLVED' : 'CANDIDATES',
      detail: s.claim,
      found: s.candidates.slice(0, MAX_CANDIDATES),
    });
  }
  return { ...investigation, hypotheses, attempts };
}
