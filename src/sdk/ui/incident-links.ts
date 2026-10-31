import type { CodeLayer, Incident, SourceLocation } from '../core/incident-contracts.js';
import { incidentReproduction } from '../core/incident-contracts.js';

/**
 * LA SÉLECTION SYNCHRONISÉE DE L'ESPACE D'INVESTIGATION. Tout ce qui se sélectionne (nœud ou relation du
 * graphe, requête HTTP, événement de la chronologie, preuve, symbole, fichier, hypothèse, vérification,
 * étape) a une clé `kind:id`. L'index relie ces clés d'après les données de l'investigation — jamais
 * d'après une supposition : une requête est reliée aux nœuds qui la citent comme preuve, aux événements
 * qui la portent, à son étape ; un nœud à son symbole et à son fichier ; une hypothèse à ses preuves, ses
 * fichiers et ses vérifications. Sélectionner un élément met en évidence ce qui lui est relié partout.
 */
export const SELECTION_KINDS = [
  'node',
  'edge',
  'request',
  'event',
  'evidence',
  'symbol',
  'file',
  'hypothesis',
  'experiment',
  'step',
] as const;
export type SelectionKind = (typeof SELECTION_KINDS)[number];

export interface WorkspaceSelection {
  kind: SelectionKind;
  id: string;
}

export const selectionKey = (selection: WorkspaceSelection): string => `${selection.kind}:${selection.id}`;

/** La clé d'un fichier : son application et son chemin dans le dépôt. */
export const fileId = (applicationId: string, file: string): string => `${applicationId}:${file}`;

/** La clé d'une relation du graphe. */
export const edgeId = (from: string, to: string): string => `${from}->${to}`;

/** La clé d'une étape de la reproduction de l'incident. */
export const stepId = (reproduction: string, index: number): string => `${reproduction}#${String(index)}`;

export interface WorkspaceLinks {
  /** Relations non orientées entre clés `kind:id`. */
  readonly neighbors: ReadonlyMap<string, ReadonlySet<string>>;
  /** Les applications qui déclarent un fichier (les références d'hypothèses n'ont que le chemin). */
  readonly fileApplications: ReadonlyMap<string, readonly string[]>;
  /** Ce que chaque clé désigne dans le code, quand elle y mène. */
  readonly sources: ReadonlyMap<string, SourceLocation>;
  /** Ce que désigne une référence libre (preuve d'un nœud, d'une relation, d'une hypothèse) : sa clé `kind:id`. */
  readonly refs: ReadonlyMap<string, string>;
}

/** Les clés reliées sont parcourues sur deux sauts : requête → nœud → symbole, hypothèse → fichier → symbole. */
const DEPTH = 2;

export function workspaceLinks(incident: Incident): WorkspaceLinks {
  const neighbors = new Map<string, Set<string>>();
  const sources = new Map<string, SourceLocation>();
  const link = (a: string, b: string): void => {
    if (a === b) return;
    const left = neighbors.get(a) ?? new Set<string>();
    left.add(b);
    neighbors.set(a, left);
    const right = neighbors.get(b) ?? new Set<string>();
    right.add(a);
    neighbors.set(b, right);
  };
  const investigation = incident.investigation;
  const reproduction = incidentReproduction(incident);
  const requestIds = new Set(
    investigation.reproductions.flatMap((run) => run.requests.map((request) => request.id)),
  );
  // Les preuves des reproductions ET celles des vérifications (journaux lus, comparaisons, code vérifié).
  const evidenceIds = new Set([
    ...investigation.reproductions.flatMap((run) => run.evidence.map((item) => item.id)),
    ...investigation.experiments.flatMap((experiment) => experiment.evidence.map((item) => item.id)),
  ]);
  const symbols = new Map((investigation.code?.symbols ?? []).map((symbol) => [symbol.id, symbol]));
  const layers = new Map<string, CodeLayer>(
    (investigation.code?.applications ?? []).map((application) => [application.id, application.layer]),
  );

  // Une référence libre (preuve d'un nœud, d'une hypothèse) : une requête, une preuve, un symbole, une vérification.
  const refKey = (ref: string): string | undefined => {
    if (requestIds.has(ref)) return `request:${ref}`;
    if (evidenceIds.has(ref)) return `evidence:${ref}`;
    if (symbols.has(ref)) return `symbol:${ref}`;
    const experiment = /^experiment:[A-Z_]+:(.+)$/.exec(ref);
    if (experiment?.[1]) return `experiment:${experiment[1]}`;
    if (investigation.experiments.some((entry) => entry.id === ref)) return `experiment:${ref}`;
    return undefined;
  };

  // Les références rencontrées et ce qu'elles désignent (les puces de preuves n'ouvrent que ce qui existe).
  const refs = new Map<string, string>();
  const resolve = (ref: string): string | undefined => {
    const target = refKey(ref);
    if (target) refs.set(ref, target);
    return target;
  };

  const fileApplications = new Map<string, string[]>();
  const noteFile = (applicationId: string, file: string): void => {
    const known = fileApplications.get(file) ?? [];
    if (!known.includes(applicationId)) known.push(applicationId);
    fileApplications.set(file, known);
  };

  // Le code : un symbole est dans un fichier ; son parent (la classe) aussi.
  for (const symbol of symbols.values()) {
    const key = `symbol:${symbol.id}`;
    const file = `file:${fileId(symbol.applicationId, symbol.file)}`;
    noteFile(symbol.applicationId, symbol.file);
    link(key, file);
    if (symbol.parent) link(key, `symbol:${symbol.parent}`);
    sources.set(key, {
      applicationId: symbol.applicationId,
      layer: symbol.layer,
      file: symbol.file,
      line: symbol.line,
      symbolId: symbol.id,
    });
  }

  // Les reproductions : étape ↔ requêtes, étape ↔ preuves.
  for (const run of investigation.reproductions) {
    for (const action of run.actions) {
      const step = `step:${stepId(run.id, action.index)}`;
      for (const requestId of action.requestIds) link(step, `request:${requestId}`);
    }
    for (const request of run.requests)
      if (request.step !== undefined) link(`request:${request.id}`, `step:${stepId(run.id, request.step)}`);
    for (const item of run.evidence)
      if (item.source.step !== undefined)
        link(`evidence:${item.id}`, `step:${stepId(run.id, item.source.step)}`);
  }

  // Le graphe : un nœud ↔ ses preuves, son symbole, son fichier ; une relation ↔ ses deux nœuds et ses preuves.
  for (const node of investigation.graph?.nodes ?? []) {
    const key = `node:${node.id}`;
    for (const ref of node.evidence) {
      const target = resolve(ref);
      if (target) link(key, target);
    }
    if (node.symbolId) link(key, `symbol:${node.symbolId}`);
    const symbol = node.symbolId ? symbols.get(node.symbolId) : undefined;
    const source =
      node.source ??
      (symbol
        ? {
            applicationId: symbol.applicationId,
            layer: symbol.layer,
            file: symbol.file,
            line: symbol.line,
            symbolId: symbol.id,
          }
        : undefined);
    if (source) {
      sources.set(key, source);
      link(key, `file:${fileId(source.applicationId, source.file)}`);
    }
    if (node.kind === 'ACTION' && reproduction) {
      const index = /:(\d+)$/.exec(node.id)?.[1];
      if (index) link(key, `step:${stepId(reproduction.id, Number(index))}`);
    }
  }
  for (const edge of investigation.graph?.edges ?? []) {
    const key = `edge:${edgeId(edge.from, edge.to)}`;
    link(key, `node:${edge.from}`);
    link(key, `node:${edge.to}`);
    for (const ref of edge.evidence) {
      const target = resolve(ref);
      if (target) link(key, target);
    }
  }

  // La chronologie : un événement ↔ ses preuves, sa requête, son étape, son code.
  for (const event of investigation.timeline ?? []) {
    const key = `event:${event.id}`;
    for (const ref of event.evidence) {
      const target = resolve(ref);
      if (target) link(key, target);
    }
    if (event.requestId) link(key, `request:${event.requestId}`);
    if (event.step !== undefined && event.reproduction)
      link(key, `step:${stepId(event.reproduction, event.step)}`);
    if (event.source) {
      sources.set(key, event.source);
      link(key, `file:${fileId(event.source.applicationId, event.source.file)}`);
      if (event.source.symbolId) link(key, `symbol:${event.source.symbolId}`);
    }
  }

  // La traçabilité frontend : chaque maillon ↔ ses preuves, son symbole ; l'étape ↔ ses requêtes.
  const trace = investigation.frontendTrace;
  for (const step of trace?.steps ?? []) {
    const key = `step:${stepId(trace?.reproduction ?? '', step.index)}`;
    const links = [
      step.element,
      step.component,
      step.handler,
      ...step.services,
      ...step.httpClients,
      step.displayedError,
    ];
    for (const entry of links) {
      if (!entry) continue;
      for (const ref of entry.evidence) {
        const target = resolve(ref);
        if (target) link(key, target);
      }
      if (entry.symbolId) link(key, `symbol:${entry.symbolId}`);
    }
    for (const request of step.requests) link(key, `request:${request.requestId}`);
    for (const ref of [...step.console, ...step.jsErrors, ...step.action.evidence]) {
      const target = resolve(ref);
      if (target) link(key, target);
    }
  }

  // Les hypothèses : ↔ leurs preuves, leurs fichiers (toutes les applications qui les déclarent), leurs vérifications.
  for (const hypothesis of investigation.hypotheses) {
    const key = `hypothesis:${hypothesis.id}`;
    for (const { ref } of [...hypothesis.supporting, ...hypothesis.contradicting]) {
      const target = resolve(ref);
      if (target) link(key, target);
    }
    for (const file of hypothesis.files)
      for (const applicationId of fileApplications.get(file) ?? [])
        link(key, `file:${fileId(applicationId, file)}`);
  }
  for (const experiment of investigation.experiments) {
    const key = `experiment:${experiment.id}`;
    if (experiment.hypothesisId) link(key, `hypothesis:${experiment.hypothesisId}`);
    for (const item of experiment.evidence) link(key, `evidence:${item.id}`);
  }

  for (const [file, applications] of fileApplications)
    for (const applicationId of applications) {
      const key = `file:${fileId(applicationId, file)}`;
      if (!sources.has(key))
        sources.set(key, { applicationId, layer: layers.get(applicationId) ?? 'FRONTEND', file, line: 1 });
    }

  // Une référence qui n'apparaît dans aucun lien mais désigne une requête, une preuve, un symbole ou une
  // vérification connue reste résolvable.
  for (const id of requestIds) refs.set(id, `request:${id}`);
  for (const id of evidenceIds) refs.set(id, `evidence:${id}`);
  for (const id of symbols.keys()) refs.set(id, `symbol:${id}`);
  for (const experiment of investigation.experiments) refs.set(experiment.id, `experiment:${experiment.id}`);

  return { neighbors, fileApplications, sources, refs };
}

/** Les clés reliées à une sélection (la sélection comprise), sur deux sauts. */
export function relatedKeys(
  links: WorkspaceLinks,
  selection: WorkspaceSelection | undefined,
): ReadonlySet<string> {
  if (!selection) return new Set();
  const start = selectionKey(selection);
  const seen = new Set<string>([start]);
  let frontier = [start];
  for (let depth = 0; depth < DEPTH; depth += 1) {
    const next: string[] = [];
    for (const key of frontier)
      for (const neighbor of links.neighbors.get(key) ?? []) {
        if (seen.has(neighbor)) continue;
        seen.add(neighbor);
        next.push(neighbor);
      }
    frontier = next;
  }
  return seen;
}

/** L'endroit du code d'une sélection : le sien, sinon celui d'un élément relié (le plus proche d'abord). */
export function sourceOf(
  links: WorkspaceLinks,
  selection: WorkspaceSelection | undefined,
): SourceLocation | undefined {
  if (!selection) return undefined;
  const start = selectionKey(selection);
  const own = links.sources.get(start);
  if (own) return own;
  for (const key of relatedKeys(links, selection)) {
    if (!key.startsWith('symbol:') && !key.startsWith('node:')) continue;
    const found = links.sources.get(key);
    if (found) return found;
  }
  return undefined;
}

/** L'état d'un élément affiché, d'après la sélection : sélectionné, relié, atténué, ou neutre (rien de sélectionné). */
export type SelectionState = 'selected' | 'related' | 'dimmed' | 'none';

export function selectionState(
  related: ReadonlySet<string>,
  selection: WorkspaceSelection | undefined,
  kind: SelectionKind,
  id: string,
): SelectionState {
  if (!selection) return 'none';
  const key = `${kind}:${id}`;
  if (key === selectionKey(selection)) return 'selected';
  return related.has(key) ? 'related' : 'dimmed';
}
