import type {
  CodeEndpoint,
  CodeIndex,
  CodeLayer,
  CodeSymbol,
  GraphEdge,
  GraphNode,
  GraphNodeKind,
  HttpExchange,
  Incident,
  InvestigationGraph,
  Layer,
  OutgoingHttpCall,
  RelationStatus,
  ReproductionRun,
  SourceLocation,
} from './model.js';

/**
 * LE CORRÉLATEUR : relie l'incident, le scénario, les actions et les requêtes OBSERVÉES pendant la
 * reproduction au code lu (frontend, BFF, backend). Une relation lue dans le code est au mieux
 * STATICALLY_RESOLVED, jamais OBSERVED ; un lien qui manque est une arête UNKNOWN avec sa raison.
 *
 * La profondeur (scope.depth) borne le nombre d'appels de méthode à méthode suivis depuis chaque
 * endpoint atteint (un appel HTTP vers l'application suivante n'est pas un saut de méthode).
 */

// ── Chemins et endpoints (copie locale, volontairement indépendante du module code) ─────────

/** Chemin comparable : sans hôte, requête ni fragment ; `${x}`, `:id`, `{id}` → `{}` ; sans « / » final. */
export function normalizePath(value: string): string {
  let text = value.trim();
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '');
  text = text.replace(/[?#].*$/, '');
  text = text.replace(/\$\{[^}]*\}/g, '{}').replace(/\{[^}]*\}/g, '{}');
  text = text
    .split('/')
    .map((segment) => (segment.startsWith(':') && segment.length > 1 ? '{}' : segment))
    .join('/');
  text = text.replace(/\/{2,}/g, '/');
  if (!text.startsWith('/') && !text.startsWith('{}')) text = `/${text}`;
  if (text.length > 1 && text.endsWith('/')) text = text.slice(0, -1);
  return text;
}

const segmentsOf = (value: string): string[] => normalizePath(value).split('/').filter(Boolean);

/** Un gabarit (`/api/books/{}`) et un chemin (`/api/books/12` ou un autre gabarit) désignent-ils la même route ? */
export function pathMatches(template: string, concrete: string): boolean {
  const left = segmentsOf(template);
  const right = segmentsOf(concrete);
  if (left.length !== right.length) return false;
  return left.every((segment, index) => {
    const other = right[index] ?? '';
    return segment === other || segment === '{}' || other === '{}';
  });
}

/**
 * Le chemin d'un appel sortant dont le début n'est pas résolu (`{}/catalog/books` : URL de base
 * dynamique) se termine-t-il par la route ? Une correspondance par suffixe n'est jamais qu'INFERRED.
 */
function suffixMatches(callPath: string, route: string): boolean {
  const call = segmentsOf(callPath);
  const target = segmentsOf(route);
  if (call[0] !== '{}' || target.length === 0 || call.length - 1 < target.length) return false;
  const tail = call.slice(call.length - target.length);
  return pathMatches(`/${target.join('/')}`, `/${tail.join('/')}`);
}

export interface EndpointMatch {
  endpoint: CodeEndpoint;
  /** STATICALLY_RESOLVED : méthode et chemin ; INFERRED : chemin seul, ou suffixe d'une URL non résolue. */
  status: 'STATICALLY_RESOLVED' | 'INFERRED';
  reason: string;
}

/** L'endpoint servi qui répond à `method path` (couches dans l'ordre de préférence). */
export function matchEndpoint(
  code: CodeIndex,
  method: string | undefined,
  path: string,
  layers: readonly CodeLayer[] = ['BFF', 'BACKEND', 'FRONTEND'],
  exclude?: string,
): EndpointMatch | undefined {
  const verb = method?.toUpperCase();
  for (const layer of layers) {
    const candidates = code.endpoints.filter(
      (endpoint) => endpoint.layer === layer && endpoint.applicationId !== exclude,
    );
    const exact = candidates.find(
      (endpoint) =>
        verb !== undefined && endpoint.method.toUpperCase() === verb && pathMatches(endpoint.path, path),
    );
    if (exact)
      return {
        endpoint: exact,
        status: 'STATICALLY_RESOLVED',
        reason: `${exact.method.toUpperCase()} ${exact.path} (${exact.applicationId}) correspond à ${verb ?? '?'} ${path}`,
      };
    const byPath = candidates.find((endpoint) => pathMatches(endpoint.path, path));
    if (byPath)
      return {
        endpoint: byPath,
        status: 'INFERRED',
        reason: `seul le chemin correspond : ${byPath.method.toUpperCase()} ${byPath.path} (${byPath.applicationId}) pour ${verb ?? 'une méthode inconnue'} ${path}`,
      };
    const bySuffix = candidates.find(
      (endpoint) =>
        (verb === undefined || endpoint.method.toUpperCase() === verb) && suffixMatches(path, endpoint.path),
    );
    if (bySuffix)
      return {
        endpoint: bySuffix,
        status: 'INFERRED',
        reason: `la fin de ${path} (URL de base non résolue) correspond à ${bySuffix.method.toUpperCase()} ${bySuffix.path} (${bySuffix.applicationId})`,
      };
  }
  return undefined;
}

// ── Statuts ──────────────────────────────────────────────────────────────────────────────────

const STRENGTH: Record<RelationStatus, number> = {
  OBSERVED: 3,
  STATICALLY_RESOLVED: 2,
  INFERRED: 1,
  UNKNOWN: 0,
};

/** Le plus faible des statuts : une chaîne ne vaut jamais mieux que son maillon le plus faible. */
export function weakest(...statuses: RelationStatus[]): RelationStatus {
  return statuses.reduce<RelationStatus>(
    (worst, status) => (STRENGTH[status] < STRENGTH[worst] ? status : worst),
    'OBSERVED',
  );
}

/** Une relation lue dans le code n'est jamais OBSERVED. */
function staticOnly(status: RelationStatus): RelationStatus {
  return status === 'OBSERVED' ? 'STATICALLY_RESOLVED' : status;
}

// ── Lecture des corps de réponse ─────────────────────────────────────────────────────────────

/** Les exceptions nommées dans un texte (`java.lang.NullPointerException`, `HttpServerErrorException`). */
export function exceptionsIn(text: string): { name: string; qualified: string }[] {
  const found = new Map<string, string>();
  for (const match of text.matchAll(/\b(?:[a-z_$][\w$]*\.)*[A-Z][\w$]*(?:Exception|Error)\b/g)) {
    const qualified = match[0];
    const name = qualified.split('.').at(-1) ?? qualified;
    if (!found.has(name)) found.set(name, qualified);
  }
  return [...found].map(([name, qualified]) => ({ name, qualified }));
}

export interface NullDereference {
  /** La méthode dont le retour était null (`CatalogBook.getPublisher`). */
  nullFrom: { className: string; qualifiedClass: string; method: string };
  /** La méthode invoquée sur ce null (`Publisher.getName`), quand le message la donne. */
  invoked?: { className: string; qualifiedClass: string; method: string };
  /** La relation désignée par le getter (`publisher`). */
  relation: string;
}

const methodRef = (qualified: string, method: string) => ({
  className: qualified.split('.').at(-1) ?? qualified,
  qualifiedClass: qualified,
  method,
});

/** Le message d'une NullPointerException « utile » (Java 14+) : quelle valeur était null. */
export function nullDereferenceIn(text: string): NullDereference | undefined {
  const nullFrom = /because the return value of [\\"']*([\w.$]+)\.(\w+)\(\)[\\"']* is null/.exec(text);
  if (!nullFrom?.[1] || !nullFrom[2]) return undefined;
  const invoked = /Cannot invoke [\\"']*([\w.$]+)\.(\w+)\([^)]*\)/.exec(text);
  const method = nullFrom[2];
  const bare = method.replace(/^(get|is)(?=[A-Z])/, '');
  return {
    nullFrom: methodRef(nullFrom[1], method),
    ...(invoked?.[1] && invoked[2] ? { invoked: methodRef(invoked[1], invoked[2]) } : {}),
    relation: bare.charAt(0).toLowerCase() + bare.slice(1),
  };
}

/** Les valeurs texte du détail d'un symbole (une clé, ou toutes). */
export function detailStrings(symbol: CodeSymbol, key?: string): string[] {
  const detail = symbol.detail ?? {};
  const values = key === undefined ? Object.values(detail) : [detail[key]];
  return values.flatMap((value) =>
    typeof value === 'string'
      ? [value]
      : Array.isArray(value)
        ? value.filter((item) => typeof item === 'string')
        : [],
  );
}

/** Les symboles dont une chaîne de déréférencement passe par la valeur null observée. */
export function dereferencingSymbols(code: CodeIndex, npe: NullDereference): CodeSymbol[] {
  const getter = `${npe.nullFrom.method}()`;
  const next = npe.invoked ? `${getter}.${npe.invoked.method}(` : `${getter}.`;
  return code.symbols.filter((symbol) =>
    detailStrings(symbol, 'dereferences').some((chain) => chain.includes(next)),
  );
}

/** Le symbole (et donc la couche) d'une classe qualifiée nommée dans un message. */
export function symbolOfClass(code: CodeIndex, qualified: string): CodeSymbol | undefined {
  const simple = qualified.split('.').at(-1) ?? qualified;
  const folder = qualified.includes('.') ? qualified.split('.').slice(0, -1).join('/') : undefined;
  const named = code.symbols.filter((symbol) => symbol.name === simple);
  return (
    named.find((symbol) => folder !== undefined && symbol.file.includes(`${folder}/`)) ??
    named[0] ??
    code.symbols.find((symbol) => symbol.file.endsWith(`/${simple}.java`) || symbol.file === `${simple}.java`)
  );
}

// ── Graphe ───────────────────────────────────────────────────────────────────────────────────

/** Les requêtes qui intéressent le graphe : appels d'API (xhr/fetch) et toute requête en erreur. */
export function isRelevantRequest(request: HttpExchange): boolean {
  return (
    request.resourceType === 'xhr' ||
    request.resourceType === 'fetch' ||
    (request.status ?? 0) >= 400 ||
    request.failure !== undefined
  );
}

/** Le genre de nœud d'un symbole ; une méthode d'un dépôt (requête dérivée) est un accès aux données. */
function nodeKindOf(symbol: CodeSymbol, parent?: CodeSymbol): GraphNodeKind {
  if (symbol.kind === 'REPOSITORY' || symbol.kind === 'SQL_QUERY' || parent?.kind === 'REPOSITORY')
    return 'REPOSITORY';
  if (symbol.layer === 'FRONTEND') return 'FRONTEND_CODE';
  const endpoint = symbol.kind === 'CONTROLLER' || symbol.kind === 'ENDPOINT';
  if (symbol.layer === 'BFF') return endpoint ? 'BFF_ENDPOINT' : 'BFF_SERVICE';
  return endpoint ? 'BACKEND_ENDPOINT' : 'BACKEND_SERVICE';
}

/** La localisation dans le code d'un symbole (la ligne de fin quand l'analyseur la connaît). */
export function sourceOfSymbol(symbol: CodeSymbol): SourceLocation {
  const endLine = symbol.detail?.endLine;
  return {
    applicationId: symbol.applicationId,
    layer: symbol.layer,
    file: symbol.file,
    line: symbol.line,
    ...(typeof endLine === 'number' && endLine > symbol.line ? { endLine } : {}),
    symbolId: symbol.id,
  };
}

/** La table (SQL natif) ou l'entité (JPQL) qu'une requête `@Query` lit ou écrit, d'après son texte. */
export function queryTarget(sql: string): string | undefined {
  return /\b(?:from|into|update|join)\s+([A-Za-z_][\w.]*)/i.exec(sql)?.[1];
}

export interface DataAccess {
  /** L'entité gérée par le dépôt (`JpaRepository<Publisher, Long>`). */
  entity?: string;
  /** La table : `@Table(name)` de l'entité, ou celle d'une requête native. */
  table?: string;
  /** Les symboles qui l'établissent (dépôt, entité). */
  evidence: string[];
}

/**
 * Ce que le code dit des données touchées par un dépôt ou une de ses requêtes : l'entité (type générique
 * du dépôt, ou nom cité par une requête JPQL) et la table (`@Table` de l'entité, ou requête native). Lu
 * dans le code, jamais observé : aucune requête SQL n'est tracée pendant la reproduction.
 */
export function dataAccessOf(symbol: CodeSymbol, symbols: ReadonlyMap<string, CodeSymbol>): DataAccess {
  const parent = symbol.parent ? symbols.get(symbol.parent) : undefined;
  const repository =
    symbol.kind === 'REPOSITORY' ? symbol : parent?.kind === 'REPOSITORY' ? parent : undefined;
  const evidence: string[] = [];
  let entity = typeof repository?.detail?.entity === 'string' ? repository.detail.entity : undefined;
  let table: string | undefined;
  const sql = typeof symbol.detail?.sql === 'string' ? symbol.detail.sql : undefined;
  const target = sql ? queryTarget(sql) : undefined;
  if (target && symbol.detail?.nativeQuery === true) table = target;
  else if (target) entity = target.split('.').at(-1) ?? target;
  if (repository && repository.id !== symbol.id) evidence.push(repository.id);
  if (entity && !table) {
    const declared = [...symbols.values()].find(
      (candidate) => candidate.name === entity && candidate.detail?.entity === true,
    );
    if (declared) {
      evidence.push(declared.id);
      if (typeof declared.detail?.table === 'string') table = declared.detail.table;
    }
  }
  return { ...(entity ? { entity } : {}), ...(table ? { table } : {}), evidence };
}

/** Le libellé d'un accès aux données : le dépôt, puis l'entité et la table quand le code les donne. */
function dataLabel(name: string, access: DataAccess): string {
  const parts = [name, access.entity, access.table ? `table ${access.table}` : undefined].filter(
    (part): part is string => part !== undefined,
  );
  return parts.join(' · ');
}

class GraphBuilder {
  private readonly nodes = new Map<string, GraphNode>();
  private readonly edges = new Map<string, GraphEdge>();

  node(node: GraphNode): string {
    const existing = this.nodes.get(node.id);
    if (existing) {
      for (const ref of node.evidence) if (!existing.evidence.includes(ref)) existing.evidence.push(ref);
    } else this.nodes.set(node.id, { ...node, evidence: [...new Set(node.evidence)] });
    return node.id;
  }

  has(id: string): boolean {
    return this.nodes.has(id);
  }

  edge(edge: GraphEdge): void {
    const key = `${edge.from}->${edge.to}`;
    const existing = this.edges.get(key);
    if (!existing) {
      this.edges.set(key, { ...edge, evidence: [...new Set(edge.evidence)] });
      return;
    }
    // Deux raisons pour la même relation : la plus forte l'emporte, les preuves s'additionnent.
    if (STRENGTH[edge.status] > STRENGTH[existing.status]) {
      existing.status = edge.status;
      existing.reason = edge.reason;
    }
    for (const ref of edge.evidence) if (!existing.evidence.includes(ref)) existing.evidence.push(ref);
  }

  build(): InvestigationGraph {
    return { nodes: [...this.nodes.values()], edges: [...this.edges.values()] };
  }
}

const symbolNodeId = (symbolId: string): string => `code:${symbolId}`;

function symbolNode(
  symbol: CodeSymbol,
  symbols: ReadonlyMap<string, CodeSymbol>,
  evidence: string[] = [],
): GraphNode {
  const parent = symbol.parent ? symbols.get(symbol.parent) : undefined;
  const kind = nodeKindOf(symbol, parent);
  const access = kind === 'REPOSITORY' ? dataAccessOf(symbol, symbols) : undefined;
  return {
    id: symbolNodeId(symbol.id),
    kind,
    label: access ? dataLabel(symbol.name, access) : symbol.name,
    layer: symbol.layer,
    evidence: [symbol.id, ...(access?.evidence ?? []), ...evidence],
    symbolId: symbol.id,
    file: symbol.file,
    line: symbol.line,
    source: sourceOfSymbol(symbol),
  };
}

export function buildGraph(input: {
  incident: Pick<Incident, 'id' | 'title' | 'scenario'>;
  reproduction?: ReproductionRun;
  code?: CodeIndex;
  depth: number;
}): InvestigationGraph {
  const { incident, reproduction, code } = input;
  const depth = Math.max(1, Math.min(5, Math.trunc(input.depth) || 1));
  const graph = new GraphBuilder();
  const symbols = new Map((code?.symbols ?? []).map((symbol) => [symbol.id, symbol]));

  const incidentId = graph.node({
    id: `incident:${incident.id}`,
    kind: 'INCIDENT',
    label: incident.title,
    layer: 'UNKNOWN',
    evidence: [],
  });

  const scenarioName = reproduction?.scenario ?? incident.scenario;
  let scenarioId: string | undefined;
  if (scenarioName) {
    scenarioId = graph.node({
      id: `scenario:${scenarioName}`,
      kind: 'SCENARIO',
      label: scenarioName,
      layer: 'UNKNOWN',
      evidence: reproduction ? [reproduction.id] : [],
    });
    graph.edge({
      from: incidentId,
      to: scenarioId,
      status: reproduction?.reproduced === true ? 'OBSERVED' : 'INFERRED',
      reason:
        reproduction?.reproduced === true
          ? `la reproduction ${reproduction.id} de « ${scenarioName} » a montré le symptôme (${reproduction.symptomMatch ?? 'correspondance trouvée'})`
          : reproduction
            ? `déclaré par l'incident ; la reproduction ${reproduction.id} n'a pas montré le symptôme`
            : "déclaré par l'incident, pas encore reproduit",
      evidence: reproduction ? [reproduction.id] : [],
    });
  }

  // Actions → requêtes (OBSERVED : vues dans la fenêtre réseau de l'action).
  const actionNodes = new Map<number, string>();
  for (const action of reproduction?.actions ?? []) {
    const evidence = (reproduction?.evidence ?? [])
      .filter((item) => item.kind === 'ACTION' && item.source.step === action.index)
      .map((item) => item.id);
    const id = graph.node({
      id: `action:${reproduction?.id ?? ''}:${String(action.index)}`,
      kind: 'ACTION',
      label: `${String(action.index)}. ${action.description}`,
      layer: 'FRONTEND',
      evidence: [...evidence, ...action.requestIds],
    });
    actionNodes.set(action.index, id);
    if (scenarioId)
      graph.edge({
        from: scenarioId,
        to: id,
        status: 'OBSERVED',
        reason: `étape ${String(action.index)} exécutée pendant la reproduction (${action.status})`,
        evidence,
      });
  }

  const relevant = (reproduction?.requests ?? []).filter(isRelevantRequest);
  const visited = new Set<string>();

  for (const request of relevant) {
    const label = `${request.method.toUpperCase()} ${request.path}${request.status !== undefined ? ` → ${String(request.status)}` : request.failure ? ` → ${request.failure}` : ''}`;
    const requestId = graph.node({
      id: `request:${request.id}`,
      kind: 'REQUEST',
      label,
      layer: 'NETWORK',
      evidence: [request.id],
    });
    const actionId = request.step !== undefined ? actionNodes.get(request.step) : undefined;
    if (actionId && request.correlation !== 'UNKNOWN')
      graph.edge({
        from: actionId,
        to: requestId,
        status: request.correlation,
        reason:
          request.correlation === 'OBSERVED'
            ? `envoyée pendant la fenêtre réseau de l'étape ${String(request.step)}`
            : `rattachée à l'étape ${String(request.step)} par son seul horodatage`,
        evidence: [request.id],
      });
    else if (scenarioId)
      graph.edge({
        from: scenarioId,
        to: requestId,
        status: 'UNKNOWN',
        reason: "vue pendant l'exécution, mais ni fenêtre d'action ni horodatage ne la rattache à une étape",
        evidence: [request.id],
      });

    // Exceptions nommées par le corps de la réponse : OBSERVED (le serveur l'a écrit).
    if (request.responseBody) linkObservedExceptions(graph, request, requestId, code, symbols);

    if (!code) continue;

    // Le code frontend qui émet cette requête (lu dans le code : au mieux STATICALLY_RESOLVED).
    for (const call of code.outgoing.filter((item) => item.layer === 'FRONTEND' && item.path !== undefined)) {
      if (!pathMatches(call.path ?? '', request.path)) continue;
      const sameMethod =
        call.method !== undefined && call.method.toUpperCase() === request.method.toUpperCase();
      if (call.method !== undefined && !sameMethod) continue;
      const symbol = symbols.get(call.symbolId);
      const frontId = graph.node(
        symbol
          ? symbolNode(symbol, symbols)
          : {
              id: symbolNodeId(call.symbolId),
              kind: 'FRONTEND_CODE',
              label: call.symbolId,
              layer: 'FRONTEND',
              evidence: [call.symbolId],
              file: call.file,
              line: call.line,
              source: sourceOfCall(call),
            },
      );
      graph.edge({
        from: frontId,
        to: requestId,
        status: weakest(staticOnly(call.status), sameMethod ? 'STATICALLY_RESOLVED' : 'INFERRED'),
        reason: `${call.file}:${String(call.line)} appelle ${call.method ?? '(méthode non écrite)'} ${call.path ?? ''}`,
        evidence: [call.symbolId, request.id],
      });
    }

    // L'endpoint qui la sert (BFF d'abord).
    const match = matchEndpoint(code, request.method, request.path, ['BFF', 'BACKEND']);
    if (!match) {
      const missing = graph.node({
        id: `unknown:${request.id}:endpoint`,
        kind: 'BFF_ENDPOINT',
        label: `? ${request.method.toUpperCase()} ${request.path}`,
        layer: 'UNKNOWN',
        evidence: [request.id],
      });
      graph.edge({
        from: requestId,
        to: missing,
        status: 'UNKNOWN',
        reason: `aucun endpoint du code BFF/backend inspecté ne sert ${request.method.toUpperCase()} ${request.path}`,
        evidence: [request.id],
      });
      continue;
    }
    const endpointNode = endpointNodeOf(graph, match.endpoint, symbols, request.id);
    graph.edge({
      from: requestId,
      to: endpointNode,
      status: match.status,
      reason: match.reason,
      evidence: [request.id, match.endpoint.symbolId],
    });
    walk(graph, code, symbols, match.endpoint, depth, visited, request);
  }

  // Une reproduction sans requête d'API, ou pas de reproduction : le lien manque, et il est dit.
  if (relevant.length === 0 && scenarioId) {
    const missing = graph.node({
      id: `unknown:${incident.id}:request`,
      kind: 'REQUEST',
      label: '? requête',
      layer: 'UNKNOWN',
      evidence: reproduction ? [reproduction.id] : [],
    });
    graph.edge({
      from: scenarioId,
      to: missing,
      status: 'UNKNOWN',
      reason: reproduction
        ? "la reproduction n'a enregistré aucune requête d'API (xhr/fetch) ni requête en échec"
        : 'pas encore de reproduction : aucune requête observée',
      evidence: reproduction ? [reproduction.id] : [],
    });
  }

  return graph.build();
}

function endpointNodeOf(
  graph: GraphBuilder,
  endpoint: CodeEndpoint,
  symbols: Map<string, CodeSymbol>,
  evidence?: string,
): string {
  const symbol = symbols.get(endpoint.symbolId);
  const kind: GraphNodeKind = endpoint.layer === 'BFF' ? 'BFF_ENDPOINT' : 'BACKEND_ENDPOINT';
  return graph.node({
    id: symbolNodeId(endpoint.symbolId),
    kind,
    label: `${endpoint.method.toUpperCase()} ${endpoint.path}${symbol ? ` (${symbol.name})` : ''}`,
    layer: endpoint.layer,
    evidence: [endpoint.symbolId, ...(evidence ? [evidence] : [])],
    symbolId: endpoint.symbolId,
    ...(symbol ? { file: symbol.file, line: symbol.line, source: sourceOfSymbol(symbol) } : {}),
  });
}

/** La localisation d'un appel HTTP sortant : la ligne de l'appel, dans le symbole qui l'émet. */
function sourceOfCall(call: OutgoingHttpCall): SourceLocation {
  return {
    applicationId: call.applicationId,
    layer: call.layer,
    file: call.file,
    line: call.line,
    symbolId: call.symbolId,
  };
}

/**
 * Depuis un endpoint : appels de méthode (au plus `depth` sauts dans l'application), appels HTTP
 * sortants vers l'application suivante (et son endpoint), exceptions levées dans le code.
 */
function walk(
  graph: GraphBuilder,
  code: CodeIndex,
  symbols: Map<string, CodeSymbol>,
  endpoint: CodeEndpoint,
  depth: number,
  visited: Set<string>,
  request: HttpExchange,
): void {
  const queue: { symbolId: string; hops: number }[] = [{ symbolId: endpoint.symbolId, hops: 0 }];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current.symbolId)) continue;
    visited.add(current.symbolId);
    const from = symbolNodeId(current.symbolId);

    // Exceptions levées par ce symbole (lues dans le code).
    for (const thrown of code.symbols.filter(
      (symbol) => symbol.kind === 'EXCEPTION' && symbol.parent === current.symbolId,
    )) {
      const id = graph.node({
        id: `exception:code:${thrown.id}`,
        kind: 'EXCEPTION',
        label: thrown.name,
        layer: thrown.layer,
        evidence: [thrown.id],
        symbolId: thrown.id,
        file: thrown.file,
        line: thrown.line,
        source: sourceOfSymbol(thrown),
      });
      graph.edge({
        from,
        to: id,
        status: 'STATICALLY_RESOLVED',
        reason: `${thrown.file}:${String(thrown.line)} lève ${thrown.name}`,
        evidence: [thrown.id],
      });
    }

    // Appels HTTP sortants de ce symbole → endpoint de l'application appelée.
    for (const call of code.outgoing.filter((item) => item.symbolId === current.symbolId))
      linkOutgoing(graph, code, symbols, call, from, depth, visited, request);

    if (current.hops >= depth) continue;
    for (const call of code.calls.filter((item) => item.from === current.symbolId && item.to !== undefined)) {
      const target = call.to ? symbols.get(call.to) : undefined;
      if (!target) continue;
      graph.node(symbolNode(target, symbols));
      graph.edge({
        from,
        to: symbolNodeId(target.id),
        status: staticOnly(call.status),
        reason: `${call.file}:${String(call.line)} ${call.text}`,
        evidence: [call.from, target.id],
      });
      queue.push({ symbolId: target.id, hops: current.hops + 1 });
    }
  }
}

function linkOutgoing(
  graph: GraphBuilder,
  code: CodeIndex,
  symbols: Map<string, CodeSymbol>,
  call: OutgoingHttpCall,
  from: string,
  depth: number,
  visited: Set<string>,
  request: HttpExchange,
): void {
  const callId = graph.node({
    id: `outgoing:${call.symbolId}:${String(call.line)}`,
    kind: 'BACKEND_CALL',
    label: `${call.method?.toUpperCase() ?? '?'} ${call.path ?? '(URL dynamique)'}`,
    layer: call.layer,
    evidence: [call.symbolId],
    symbolId: call.symbolId,
    file: call.file,
    line: call.line,
    source: sourceOfCall(call),
  });
  graph.edge({
    from,
    to: callId,
    status: staticOnly(call.status),
    reason: `${call.file}:${String(call.line)} envoie une requête HTTP (${call.status})`,
    evidence: [call.symbolId],
  });
  // Le corps de la réponse observée cite-t-il ce chemin ? Une preuve de plus, le statut reste statique.
  const cited =
    call.path !== undefined &&
    request.responseBody !== undefined &&
    citedPaths(request.responseBody).some(
      (path) => pathMatches(path, call.path ?? '') || suffixMatches(call.path ?? '', path),
    );
  if (call.path === undefined || call.status === 'UNKNOWN') {
    const missing = graph.node({
      id: `unknown:${callId}`,
      kind: 'BACKEND_ENDPOINT',
      label: '? endpoint',
      layer: 'UNKNOWN',
      evidence: [call.symbolId],
    });
    graph.edge({
      from: callId,
      to: missing,
      status: 'UNKNOWN',
      reason: "l'URL de cet appel est construite à l'exécution : sa cible ne peut pas être lue dans le code",
      evidence: [call.symbolId],
    });
    return;
  }
  const match = matchEndpoint(code, call.method, call.path, ['BACKEND', 'BFF'], call.applicationId);
  if (!match) {
    const missing = graph.node({
      id: `unknown:${callId}`,
      kind: 'BACKEND_ENDPOINT',
      label: `? ${call.method?.toUpperCase() ?? ''} ${call.path}`.replace(/\s+/g, ' '),
      layer: 'UNKNOWN',
      evidence: [call.symbolId],
    });
    graph.edge({
      from: callId,
      to: missing,
      status: 'UNKNOWN',
      reason: `aucune application inspectée ne sert ${call.method?.toUpperCase() ?? ''} ${call.path}`.replace(
        /\s+/g,
        ' ',
      ),
      evidence: [call.symbolId],
    });
    return;
  }
  const target = endpointNodeOf(graph, match.endpoint, symbols);
  graph.edge({
    from: callId,
    to: target,
    status: weakest(staticOnly(call.status), match.status),
    reason: `${match.reason}${cited ? ` ; le corps de la réponse de ${request.method.toUpperCase()} ${request.path} cite ce chemin` : ''}`,
    evidence: [call.symbolId, match.endpoint.symbolId, ...(cited ? [request.id] : [])],
  });
  walk(graph, code, symbols, match.endpoint, depth, visited, request);
}

/** Les chemins d'API cités par un corps de réponse (`"path":"/catalog/books"`). */
export function citedPaths(body: string): string[] {
  const paths = new Set<string>();
  for (const match of body.matchAll(/[\\"']*path[\\"']*\s*:\s*[\\"']*(\/[\w\-./{}]*)/g))
    if (match[1]) paths.add(match[1]);
  return [...paths];
}

function linkObservedExceptions(
  graph: GraphBuilder,
  request: HttpExchange,
  requestId: string,
  code: CodeIndex | undefined,
  symbolMap: ReadonlyMap<string, CodeSymbol>,
): void {
  const body = request.responseBody ?? '';
  const npe = nullDereferenceIn(body);
  for (const exception of exceptionsIn(body)) {
    // La couche : celle de la classe nommée par le message (la valeur null), sinon celle de l'exception si elle est dans le code.
    const owner =
      code && npe && exception.name === 'NullPointerException'
        ? symbolOfClass(code, npe.nullFrom.qualifiedClass)
        : code
          ? symbolOfClass(code, exception.qualified)
          : undefined;
    const layer: Layer = owner?.layer ?? 'UNKNOWN';
    const id = graph.node({
      id: `exception:observed:${request.id}:${exception.name}`,
      kind: 'EXCEPTION',
      label: exception.qualified,
      layer,
      evidence: [request.id],
    });
    graph.edge({
      from: requestId,
      to: id,
      status: 'OBSERVED',
      reason: `le corps de la réponse de ${request.method.toUpperCase()} ${request.path}${request.status !== undefined ? ` (${String(request.status)})` : ''} nomme ${exception.qualified}`,
      evidence: [request.id],
    });
    // Le code dont la chaîne de déréférencement correspond au message : une déduction, jamais une trace.
    if (code && npe && exception.name === 'NullPointerException')
      for (const symbol of dereferencingSymbols(code, npe)) {
        const from = graph.node(symbolNode(symbol, symbolMap));
        graph.edge({
          from,
          to: id,
          status: 'INFERRED',
          reason: `${symbol.file}:${String(symbol.line)} déréférence ${npe.nullFrom.className}.${npe.nullFrom.method}()${npe.invoked ? `.${npe.invoked.method}()` : ''}, la valeur nulle d'après le message`,
          evidence: [symbol.id, request.id],
        });
      }
  }
}
