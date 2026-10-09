import type { RecordedFlowStep } from '../model.js';
import {
  collectEntityEvidence,
  type EntityEvidence,
  type EntityEvidenceType,
  type EntityIdentity,
  type EvidenceInput,
} from './entity-evidence.js';
import {
  DeterministicProvenanceResolver,
  type EntityProvenance,
  type ProvenanceDecision,
  type ProvenanceResolver,
} from './provenance-resolver.js';
import { SEARCH_LABEL, labelOf, round, sameValue } from './signals.js';

/**
 * ENTITY IDENTITY RESOLVER + PROVENANCE : des preuves aux entités suivies.
 *
 *   EntityEvidence[] → identités regroupées (même valeur ET même portée) → ProvenanceResolver
 *                    → TrackedEntity (provenance, cycle de vie, actions d'origine)
 *
 * Une même valeur (« 123 ») n'est PAS une entité globale : la clé porte la portée structurelle
 * (ressource d'URL / d'API). Deux preuves se rejoignent quand elles ont la même valeur ET la même
 * ressource, ou quand elles sont observées dans la MÊME action (la route et la requête d'un même
 * clic). Une valeur sans portée (une saisie, un texte) rejoint l'unique entité qui la porte ; si
 * plusieurs la portent, le lien n'est pas décidé.
 */
export type LifecycleKind = 'CREATE' | 'SEARCH' | 'OPEN' | 'VIEW' | 'INPUT' | 'UPDATE' | 'SAVE' | 'DELETE';

export interface LifecycleStep {
  kind: LifecycleKind;
  /** Les actions techniques d'origine (a3…) et les étapes du flow (s4…) : traçable jusqu'à Playwright. */
  actionIds: string[];
  stepIds: string[];
  evidenceIds: string[];
  /** Poids fixes (voir lifecycleConfidence) : l'interprétation du geste, pas la provenance. */
  confidence: number;
}

export interface TrackedEntity {
  /** entity:<ressource|unknown>:<identité> — la portée fait partie de la clé. */
  key: string;
  /** Le nom tiré de la STRUCTURE (ressource d'URL / d'API) ; « unknown » si rien ne le dit. */
  type: string;
  resources: string[];
  identity: EntityIdentity;
  /** Les autres identités du même objet (id + référence d'une même réponse, route + API). */
  aliases: EntityIdentity[];
  /** La première observation : JAMAIS confondue avec une création. */
  firstSeen: { actionId?: string; actionIndex: number; evidence: EntityEvidenceType };
  provenance: ProvenanceDecision;
  lifecycle: LifecycleStep[];
  evidenceIds: string[];
  actionIds: string[];
  /** Une valeur sans portée que plusieurs entités partagent : les clés possibles. */
  linkCandidates?: string[];
}

export interface EntityTracking {
  entities: TrackedEntity[];
  evidence: EntityEvidence[];
}

export interface TrackingInput extends EvidenceInput {
  steps?: readonly RecordedFlowStep[];
  /** Une provenance proposée (IA facultative) par clé d'entité : seulement pour une AMBIGUÏTÉ. */
  proposals?: ReadonlyMap<string, EntityProvenance>;
  resolver?: ProvenanceResolver;
}

export function trackEntities(input: TrackingInput): EntityTracking {
  const { evidence, typed } = collectEntityEvidence(input);
  const resolver = input.resolver ?? new DeterministicProvenanceResolver();
  const carriers = evidence.filter((entry) => entry.identity !== undefined);
  const matches = (a: EntityEvidence, b: EntityEvidence): boolean => {
    const x = a.identity;
    const y = b.identity;
    if (!x || !y) return false;
    if (x.digest && y.digest && x.digest === y.digest) return true;
    const vx = x.value ?? typed.get(a.id);
    const vy = y.value ?? typed.get(b.id);
    return vx !== undefined && vy !== undefined && sameValue(vx, vy);
  };

  // ------------------------------------------------------------ regroupement (union-find)
  const parent = carriers.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root] ?? root;
    parent[index] = root;
    return root;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  for (let i = 0; i < carriers.length; i += 1)
    for (let j = i + 1; j < carriers.length; j += 1) {
      const a = carriers[i];
      const b = carriers[j];
      if (!a || !b) continue;
      const sameObject = a.object !== undefined && a.object === b.object;
      const sameAction = a.actionIndex === b.actionIndex;
      const sameScope =
        a.resource !== undefined && a.resource === b.resource && namespaceOf(a) === namespaceOf(b);
      if (sameObject || (matches(a, b) && (sameScope || sameAction))) union(i, j);
    }
  const clusters = (): Map<number, number[]> => {
    const groups = new Map<number, number[]>();
    for (const index of carriers.keys()) {
      const root = find(index);
      groups.set(root, [...(groups.get(root) ?? []), index]);
    }
    return groups;
  };
  const scoped = (members: readonly number[]): boolean =>
    members.some((index) => carriers[index]?.resource !== undefined);
  const clusterMatch = (x: readonly number[], y: readonly number[]): boolean =>
    x.some((i) => y.some((j) => carriers[i] && carriers[j] && matches(carriers[i], carriers[j])));
  // L'API et l'écran ne nomment pas forcément pareil (/api/dossiers/12 et /demandes/12) : une entité
  // vue d'un seul côté rejoint l'UNIQUE entité de l'autre côté qui porte la même valeur, sans conflit
  // de nom dans un même espace (deux ressources d'écran différentes restent deux entités).
  {
    const groups = [...clusters().values()].filter(scoped);
    const names = (members: readonly number[], namespace: 'api' | 'ui'): string[] =>
      [
        ...new Set(
          members.flatMap((index) => {
            const entry = carriers[index];
            return entry?.resource && namespaceOf(entry) === namespace ? [entry.resource] : [];
          }),
        ),
      ].sort();
    const compatible = (x: readonly number[], y: readonly number[]): boolean =>
      (['api', 'ui'] as const).every((namespace) => {
        const a = names(x, namespace);
        const b = names(y, namespace);
        return a.length === 0 || b.length === 0 || a.join('+') === b.join('+');
      });
    /** Les entités de l'AUTRE côté (API ↔ écran) qui portent la même valeur, sans conflit de nom. */
    const counterparts = (members: readonly number[]): (readonly number[])[] => {
      const api = names(members, 'api').length > 0;
      const ui = names(members, 'ui').length > 0;
      if (api === ui) return [];
      const side = api ? 'api' : 'ui';
      const other = api ? 'ui' : 'api';
      const found = groups.filter(
        (candidate) =>
          candidate !== members &&
          names(candidate, other).length > 0 &&
          compatible(members, candidate) &&
          clusterMatch(members, candidate),
      );
      // Le même nom des deux côtés (/api/items/12 et /items/12) départage : un indice, jamais seul.
      const named = found.filter((candidate) =>
        names(candidate, other).some((name) => names(members, side).includes(name)),
      );
      return named.length === 1 ? named : found;
    };
    for (const members of groups) {
      const owners = counterparts(members);
      const owner = owners[0];
      if (owners.length !== 1 || !owner || owner[0] === undefined || members[0] === undefined) continue;
      // Un lien seulement s'il est UNIQUE des deux côtés.
      const back = counterparts(owner);
      if (back.length !== 1 || back[0] !== members) continue;
      union(owner[0], members[0]);
    }
  }
  // Les valeurs sans portée se rejoignent entre elles, puis rejoignent l'UNIQUE entité qui les porte.
  {
    const bare = [...clusters().values()].filter((members) => !scoped(members));
    for (let i = 0; i < bare.length; i += 1)
      for (let j = i + 1; j < bare.length; j += 1) {
        const x = bare[i];
        const y = bare[j];
        if (x?.[0] !== undefined && y?.[0] !== undefined && clusterMatch(x, y)) union(x[0], y[0]);
      }
  }
  const ambiguousLinks = new Map<number, number[]>();
  {
    const groups = [...clusters().values()];
    const withScope = groups.filter(scoped);
    for (const members of groups.filter((entry) => !scoped(entry))) {
      const owners = withScope.filter((other) => clusterMatch(members, other));
      if (owners.length === 1 && owners[0]?.[0] !== undefined && members[0] !== undefined)
        union(owners[0][0], members[0]);
      else if (owners.length > 1 && members[0] !== undefined)
        ambiguousLinks.set(
          members[0],
          owners.map((owner) => owner[0] ?? -1),
        );
    }
  }

  // ------------------------------------------------------------ une entité par groupe
  const groups = [...clusters().entries()];
  const keyOf = new Map<number, string>();
  const usedKeys = new Set<string>();
  for (const [root, members] of groups) {
    const own = members.map((index) => carriers[index]).filter((entry): entry is EntityEvidence => !!entry);
    const resources = [...new Set(own.flatMap((entry) => (entry.resource ? [entry.resource] : [])))].sort();
    const display = displayIdentity(own);
    let key = `entity:${resources.length ? resources.join('+') : 'unknown'}:${display.value ?? `#${(display.digest ?? '').slice(0, 8)}`}`;
    for (let suffix = 2; usedKeys.has(key); suffix += 1)
      key = `${key.replace(/~\d+$/, '')}~${String(suffix)}`;
    usedKeys.add(key);
    keyOf.set(root, key);
  }
  const stepOf = (actionId: string): string[] =>
    (input.steps ?? []).filter((step) => step.actionIds.includes(actionId)).map((step) => step.id);

  const entities: TrackedEntity[] = [];
  for (const [root, members] of groups) {
    const own = members
      .map((index) => carriers[index])
      .filter((entry): entry is EntityEvidence => !!entry)
      .sort((a, b) => a.actionIndex - b.actionIndex);
    const actionIndexes = new Set(own.map((entry) => entry.actionIndex));
    // Les preuves de CONTEXTE (POST réussi, libellé, recherche) des actions où l'entité apparaît.
    const context = evidence.filter(
      (entry) => entry.identity === undefined && actionIndexes.has(entry.actionIndex),
    );
    const all = [...own, ...context].sort((a, b) => a.actionIndex - b.actionIndex);
    const key = keyOf.get(root) ?? '';
    const display = displayIdentity(own);
    const linkRoots = members.map((index) => ambiguousLinks.get(index)).find((entry) => entry !== undefined);
    const linkCandidates = linkRoots?.map((owner) => keyOf.get(find(owner)) ?? '').filter(Boolean);
    const proposal = input.proposals?.get(key);
    const provenance = resolver.resolve(
      { key, identity: display, ...(linkCandidates?.length ? { linkCandidates } : {}) },
      all,
      proposal ? { proposal } : {},
    );
    const resources = [...new Set(own.flatMap((entry) => (entry.resource ? [entry.resource] : [])))].sort();
    const first = own[0];
    entities.push({
      key,
      type: resources.length === 1 && resources[0] ? resources[0] : 'unknown',
      resources,
      identity: display,
      aliases: aliasesOf(own, display),
      firstSeen: {
        ...(first?.actionId ? { actionId: first.actionId } : {}),
        actionIndex: first?.actionIndex ?? -1,
        evidence: first?.type ?? 'USER_INPUT',
      },
      provenance,
      lifecycle: lifecycleOf(all, input, stepOf),
      evidenceIds: all.map((entry) => entry.id),
      actionIds: [...new Set(all.flatMap((entry) => (entry.actionId ? [entry.actionId] : [])))],
      ...(linkCandidates?.length ? { linkCandidates } : {}),
    });
  }
  entities.sort((a, b) => a.firstSeen.actionIndex - b.firstSeen.actionIndex);
  return { entities, evidence };
}

/** L'espace d'une ressource : l'API (réseau) ou l'écran (URL, liens). */
function namespaceOf(entry: EntityEvidence): 'api' | 'ui' {
  const source = entry.identity?.source;
  return source === 'NETWORK_RESPONSE' || source === 'NETWORK_PATH' || source === 'LOCATION_HEADER'
    ? 'api'
    : 'ui';
}

/** L'identité à montrer : la plus fiable qui a une valeur montrée par l'application. */
function displayIdentity(own: readonly EntityEvidence[]): EntityIdentity {
  const identities = own.flatMap((entry) => (entry.identity ? [entry.identity] : []));
  const valued = identities.filter((identity) => identity.value !== undefined);
  const pool = valued.length > 0 ? valued : identities;
  const best = pool.reduce<EntityIdentity | undefined>(
    (a, b) => (a === undefined || b.confidence > a.confidence ? b : a),
    undefined,
  );
  const digest = identities.find((identity) => identity.digest)?.digest;
  return {
    ...(best ?? { source: 'USER_INPUT', confidence: 0 }),
    ...(best?.digest === undefined && digest ? { digest } : {}),
  };
}

function aliasesOf(own: readonly EntityEvidence[], display: EntityIdentity): EntityIdentity[] {
  const aliases: EntityIdentity[] = [];
  for (const entry of own) {
    const identity = entry.identity;
    if (!identity?.value || (display.value !== undefined && sameValue(identity.value, display.value)))
      continue;
    if (aliases.some((alias) => alias.value !== undefined && sameValue(alias.value, identity.value ?? '')))
      continue;
    aliases.push(identity);
  }
  return aliases;
}

const OPENING: ReadonlySet<EntityEvidenceType> = new Set([
  'RESULT_SELECTED',
  'DETAIL_VIEW',
  'DIRECT_NAVIGATION',
  'READ_RESPONSE',
]);

/** Le cycle de vie : un geste métier par action, dans l'ordre, les gestes identiques consécutifs réunis. */
function lifecycleOf(
  evidence: readonly EntityEvidence[],
  input: TrackingInput,
  stepOf: (actionId: string) => string[],
): LifecycleStep[] {
  const byAction = new Map<number, EntityEvidence[]>();
  for (const entry of evidence)
    byAction.set(entry.actionIndex, [...(byAction.get(entry.actionIndex) ?? []), entry]);
  const indexes = [...byAction.keys()].sort((a, b) => a - b);
  const creationAt = evidence.find((entry) => entry.type === 'NEW_ENTITY_ID')?.actionIndex;
  const kindAt = (index: number): LifecycleKind | undefined => {
    const types = new Set((byAction.get(index) ?? []).map((entry) => entry.type));
    if (types.has('NEW_ENTITY_ID')) return 'CREATE';
    if (types.has('DELETE_REQUEST') || types.has('DELETE_ACTION')) return 'DELETE';
    if (types.has('SAVE_ACTION') || types.has('UPDATE_REQUEST')) return 'SAVE';
    if ([...types].some((type) => OPENING.has(type))) return 'OPEN';
    if (types.has('INITIAL_STATE')) return 'VIEW';
    if (types.has('USER_INPUT')) {
      // Une valeur saisie dans le formulaire qui l'a ensuite créée : une part de la création.
      if (creationAt !== undefined && creationAt > index) return 'CREATE';
      if ((byAction.get(index) ?? []).some((entry) => entry.details.search === true)) return 'SEARCH';
      const next = indexes.find((other) => other > index);
      return next !== undefined && (byAction.get(next) ?? []).some((entry) => OPENING.has(entry.type))
        ? 'SEARCH'
        : 'INPUT';
    }
    if (types.has('EDIT_INPUT')) return 'UPDATE';
    return undefined;
  };
  const steps: LifecycleStep[] = [];
  for (const index of indexes) {
    const kind = kindAt(index);
    if (!kind) continue;
    const entries = byAction.get(index) ?? [];
    const actionIds = [...new Set(entries.flatMap((entry) => (entry.actionId ? [entry.actionId] : [])))];
    // Le bouton « Rechercher » juste après la saisie fait partie de la recherche.
    if (kind === 'SEARCH') {
      const next = input.actions[index + 1];
      if (next?.type === 'CLICK' && SEARCH_LABEL.test(labelOf(next))) actionIds.push(next.id);
    }
    const last = steps.at(-1);
    if (last?.kind === kind) {
      last.actionIds = [...new Set([...last.actionIds, ...actionIds])];
      last.evidenceIds.push(...entries.map((entry) => entry.id));
      last.stepIds = [...new Set(last.actionIds.flatMap(stepOf))];
      continue;
    }
    steps.push({
      kind,
      actionIds,
      stepIds: [...new Set(actionIds.flatMap(stepOf))],
      evidenceIds: entries.map((entry) => entry.id),
      confidence: 0,
    });
  }
  const types = (step: LifecycleStep): Set<EntityEvidenceType> =>
    new Set(evidence.filter((entry) => step.evidenceIds.includes(entry.id)).map((entry) => entry.type));
  for (const [position, step] of steps.entries())
    step.confidence = lifecycleConfidence(step.kind, types(step), steps[position - 1], steps[position + 1]);
  return steps;
}

/** Les poids d'un geste : une base, puis chaque preuve concordante. */
export function lifecycleConfidence(
  kind: LifecycleKind,
  types: ReadonlySet<EntityEvidenceType>,
  previous?: LifecycleStep,
  next?: LifecycleStep,
): number {
  let score: number;
  switch (kind) {
    case 'CREATE':
      score = 0.6 + (types.has('WRITE_REQUEST') ? 0.2 : 0) + (types.has('SUCCESS_RESPONSE') ? 0.1 : 0);
      break;
    case 'SEARCH':
      score = 0.6 + (types.has('SEARCH_ACTION') ? 0.15 : 0) + (next?.kind === 'OPEN' ? 0.1 : 0);
      break;
    case 'OPEN':
      score =
        0.6 +
        0.1 * ([...types].filter((type) => OPENING.has(type)).length - 1) +
        (previous?.kind === 'SEARCH' ? 0.1 : 0);
      break;
    case 'SAVE':
    case 'DELETE':
      score =
        0.6 +
        (types.has('UPDATE_REQUEST') || types.has('DELETE_REQUEST') ? 0.2 : 0) +
        (types.has('SAVE_ACTION') || types.has('DELETE_ACTION') ? 0.1 : 0);
      break;
    case 'UPDATE':
      score = 0.6;
      break;
    case 'VIEW':
      score = 0.5;
      break;
    case 'INPUT':
      score = 0.3;
      break;
  }
  return round(Math.min(0.99, score));
}
