import {
  citedPaths,
  dereferencingSymbols,
  detailStrings,
  exceptionsIn,
  matchEndpoint,
  nullDereferenceIn,
  pathMatches,
  symbolOfClass,
  type NullDereference,
} from './correlator.js';
import type {
  CodeIndex,
  CodeSymbol,
  Experiment,
  ExperimentKind,
  HttpExchange,
  Hypothesis,
  Incident,
  InvestigationGraph,
  Layer,
  ProposedVerification,
  ReproductionRun,
} from './model.js';

/**
 * LES HYPOTHÈSES : chacune naît d'une règle posée sur les PREUVES (réponses observées, charges utiles,
 * code lu), porte ses preuves favorables et contraires, les fichiers à examiner et les vérifications
 * qui la confirmeraient ou la réfuteraient. Sans expérience, la confiance ne dépasse jamais 0,7.
 */

export const HYPOTHESIS_RULES = [
  'null-relation',
  'missing-validation',
  'backend-propagated',
  'server-error',
  'client-error',
  'network-failure',
  'frontend-error',
  'test-data',
  'environment',
] as const;
export type HypothesisRule = (typeof HYPOTHESIS_RULES)[number];

/** La règle qui a produit l'hypothèse (lue dans son id `hyp-<règle>`). */
export function ruleOf(hypothesis: Pick<Hypothesis, 'id'>): HypothesisRule | undefined {
  return HYPOTHESIS_RULES.find(
    (rule) => hypothesis.id === `hyp-${rule}` || hypothesis.id.startsWith(`hyp-${rule}-`),
  );
}

/** Confiance plafonnée tant qu'aucune expérience ne l'a soutenue. */
export const MAX_CONFIDENCE_WITHOUT_EXPERIMENT = 0.7;

/** Les vérifications qui exécutent quelque chose (par opposition à une lecture statique du code). */
export const DYNAMIC_EXPERIMENTS: readonly ExperimentKind[] = [
  'REPLAY',
  'COMPARE_WITH_PASSING',
  'COMPARE_REQUESTS',
  'COMPARE_RESPONSES',
  'UNIT_TEST',
  'INTEGRATION_TEST',
  'INSPECT_LOGS',
];

const clamp = (value: number, max = MAX_CONFIDENCE_WITHOUT_EXPERIMENT): number =>
  Math.round(Math.max(0.05, Math.min(max, value)) * 100) / 100;

const endpointOf = (request: HttpExchange): string => `${request.method.toUpperCase()} ${request.path}`;
const describe = (request: HttpExchange): string =>
  `${endpointOf(request)}${request.status !== undefined ? ` (${String(request.status)})` : request.failure ? ` (${request.failure})` : ''}`;
const isWrite = (request: HttpExchange): boolean =>
  ['POST', 'PUT', 'PATCH'].includes(request.method.toUpperCase());
const isApi = (request: HttpExchange): boolean =>
  request.resourceType === 'xhr' || request.resourceType === 'fetch';

/** La charge utile JSON d'une requête (undefined si absente, tronquée ou pas du JSON). */
export function payloadOf(request: HttpExchange): Record<string, unknown> | undefined {
  if (!request.requestBody) return undefined;
  try {
    const parsed: unknown = JSON.parse(request.requestBody);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

type FieldState = 'absent' | 'empty' | 'present' | 'unknown';

function fieldState(payload: Record<string, unknown> | undefined, field: string): FieldState {
  if (!payload) return 'unknown';
  if (!(field in payload)) return 'absent';
  const value = payload[field];
  return value === null || value === '' ? 'empty' : 'present';
}

/** Les clés de la charge utile qui désignent une relation (`publisher` → `publisherId`, `publisher_id`). */
function relationKeys(payload: Record<string, unknown>, relation: string): string[] {
  const prefix = relation.toLowerCase();
  return Object.keys(payload).filter((key) => key.toLowerCase().startsWith(prefix));
}

// ── DTO et validations (lecture défensive du détail des symboles) ───────────────────────────

const REQUIRED = /NotNull|NotBlank|NotEmpty|Required/;

interface DtoField {
  name: string;
  annotations: string[];
  symbolId?: string;
}

/** Le DTO reçu par un endpoint : un symbole DTO de la même application nommé dans le détail de la méthode. */
function dtoOf(code: CodeIndex, endpointSymbolId: string): CodeSymbol | undefined {
  const method = code.symbols.find((symbol) => symbol.id === endpointSymbolId);
  if (!method) return undefined;
  // Le corps de la requête (@RequestBody) quand l'analyse l'a lu : jamais le type de la réponse.
  const body = method.detail?.requestBody;
  if (typeof body === 'string') {
    const name = body.replace(/<.*$/, '').split('.').at(-1) ?? body;
    return code.symbols.find(
      (symbol) =>
        symbol.kind === 'DTO' && symbol.applicationId === method.applicationId && symbol.name === name,
    );
  }
  const mentioned = new Set(detailStrings(method).flatMap((value) => value.split(/[^\w$.]+/)));
  return code.symbols.find(
    (symbol) =>
      symbol.kind === 'DTO' &&
      symbol.applicationId === method.applicationId &&
      (mentioned.has(symbol.name) || [...mentioned].some((item) => item.endsWith(`.${symbol.name}`))),
  );
}

/** Les champs d'un DTO et leurs annotations de validation. */
function dtoFields(code: CodeIndex, dto: CodeSymbol): DtoField[] {
  const fields = new Map<string, DtoField>();
  const add = (name: string, annotations: string[] = [], symbolId?: string): void => {
    const field = name.split('.').at(-1) ?? name;
    const existing = fields.get(field) ?? { name: field, annotations: [] };
    existing.annotations.push(...annotations);
    if (symbolId) existing.symbolId ??= symbolId;
    fields.set(field, existing);
  };
  for (const name of [...detailStrings(dto, 'fields'), ...detailStrings(dto, 'components')])
    for (const part of name.split(/[,\s]+/).filter(Boolean)) add(part.split(':')[0] ?? part);
  for (const symbol of code.symbols) {
    if (symbol.kind !== 'VALIDATION') continue;
    if (symbol.parent !== dto.id && symbol.file !== dto.file) continue;
    const field = detailStrings(symbol, 'field')[0] ?? symbol.name;
    const annotations = [
      ...detailStrings(symbol, 'annotation'),
      ...detailStrings(symbol, 'annotations'),
      ...detailStrings(symbol, 'rule'),
      ...detailStrings(symbol, 'constraints'),
    ];
    add(field, annotations.length > 0 ? annotations : [symbol.name], symbol.id);
  }
  return [...fields.values()];
}

/** Le code frontend autour de l'appel qui émet la requête : validations et transformations de la charge utile. */
function frontendNeighbours(code: CodeIndex, request: HttpExchange): CodeSymbol[] {
  const callers = code.outgoing
    .filter(
      (call) =>
        call.layer === 'FRONTEND' &&
        call.path !== undefined &&
        pathMatches(call.path, request.path) &&
        (call.method === undefined || call.method.toUpperCase() === request.method.toUpperCase()),
    )
    .map((call) => call.symbolId);
  const parents = code.calls
    .filter((call) => call.to !== undefined && callers.includes(call.to))
    .map((call) => call.from);
  const siblings = new Set(
    code.calls
      .filter((call) => parents.includes(call.from) && call.to !== undefined)
      .map((call) => call.to ?? ''),
  );
  return code.symbols.filter(
    (symbol) =>
      symbol.layer === 'FRONTEND' &&
      siblings.has(symbol.id) &&
      (symbol.kind === 'VALIDATION' || symbol.kind === 'PAYLOAD_TRANSFORM'),
  );
}

/** Les DTO du chemin : celui de l'endpoint qui sert la requête, puis ceux des endpoints atteints par le graphe. */
function dtosOnPath(code: CodeIndex, request: HttpExchange, graph?: InvestigationGraph): CodeSymbol[] {
  const endpoints: string[] = [];
  const match = matchEndpoint(code, request.method, request.path, ['BFF', 'BACKEND']);
  if (match) endpoints.push(match.endpoint.symbolId);
  for (const node of graph?.nodes ?? [])
    if ((node.kind === 'BFF_ENDPOINT' || node.kind === 'BACKEND_ENDPOINT') && node.symbolId)
      endpoints.push(node.symbolId);
  const dtos: CodeSymbol[] = [];
  for (const endpoint of new Set(endpoints)) {
    const dto = dtoOf(code, endpoint);
    if (dto && !dtos.some((item) => item.id === dto.id)) dtos.push(dto);
  }
  return dtos;
}

// ── Construction ─────────────────────────────────────────────────────────────────────────────

interface Draft {
  rule: HypothesisRule;
  title: string;
  description: string;
  suspectedCause: string;
  layer: Layer;
  files: string[];
  supporting: Hypothesis['supporting'];
  contradicting: Hypothesis['contradicting'];
  confidence: number;
  verifications: ProposedVerification[];
}

function toHypothesis(draft: Draft): Hypothesis {
  return {
    id: `hyp-${draft.rule}`,
    title: draft.title,
    description: draft.description,
    suspectedCause: draft.suspectedCause,
    layer: draft.layer,
    files: [...new Set(draft.files)].sort(),
    supporting: draft.supporting,
    contradicting: draft.contradicting,
    confidence: clamp(draft.confidence - 0.15 * draft.contradicting.length),
    verifications: draft.verifications,
    status: 'PROPOSED',
  };
}

const scenarioParams = (incident: Incident): Record<string, string> =>
  incident.scenario ? { scenario: incident.scenario } : {};

/** La requête qui porte le symptôme : une écriture d'API en erreur d'abord. */
function failingRequests(
  reproduction: ReproductionRun | undefined,
  min: number,
  max: number,
): HttpExchange[] {
  return (reproduction?.requests ?? [])
    .filter((request) => request.status !== undefined && request.status >= min && request.status <= max)
    .sort((left, right) => Number(isWrite(right) && isApi(right)) - Number(isWrite(left) && isApi(left)));
}

/** Une requête du même endpoint qui a réussi sans ce champ contredit l'explication par ce champ. */
function passingWithout(
  reproduction: ReproductionRun | undefined,
  failing: HttpExchange,
  keyOf: (payload: Record<string, unknown>) => boolean,
): HttpExchange[] {
  return (reproduction?.requests ?? []).filter((request) => {
    if (request.id === failing.id || request.status === undefined || request.status >= 400) return false;
    if (
      request.method.toUpperCase() !== failing.method.toUpperCase() ||
      !pathMatches(request.path, failing.path)
    )
      return false;
    const payload = payloadOf(request);
    return payload !== undefined && !keyOf(payload);
  });
}

function nullRelation(input: Context, request: HttpExchange, npe: NullDereference): Draft {
  const { code, reproduction, incident } = input;
  const derefs = code ? dereferencingSymbols(code, npe) : [];
  const owner = code ? symbolOfClass(code, npe.nullFrom.qualifiedClass) : undefined;
  const payload = payloadOf(request);
  const keys = payload ? relationKeys(payload, npe.relation) : [];
  const states = keys.map((key) => fieldState(payload, key));
  const absent = payload !== undefined && (keys.length === 0 || states.every((state) => state !== 'present'));
  const chain = `${npe.nullFrom.className}.${npe.nullFrom.method}()${npe.invoked ? `.${npe.invoked.method}()` : ''}`;
  // La chaîne telle qu'écrite dans le code (« book.getPublisher().getName() »), sinon celle du message.
  const codeChain = (symbol: CodeSymbol): string =>
    detailStrings(symbol, 'dereferences').find((item) => item.includes(`${npe.nullFrom.method}()`)) ?? chain;
  const supporting: Hypothesis['supporting'] = [
    {
      ref: request.id,
      fact: `le corps de la réponse de ${describe(request)} nomme java.lang.NullPointerException : la valeur de retour de ${npe.nullFrom.className}.${npe.nullFrom.method}() est null`,
    },
    ...derefs.map((symbol) => ({
      ref: symbol.id,
      fact: `${symbol.name} (${symbol.file}:${String(symbol.line)}) déréférence ${codeChain(symbol)}`,
    })),
  ];
  if (absent)
    supporting.push({
      ref: request.id,
      fact:
        keys.length === 0
          ? `la charge utile de ${endpointOf(request)} ne porte aucun champ « ${npe.relation}… » (clés : ${Object.keys(payload).join(', ') || 'aucune'})`
          : `la charge utile de ${endpointOf(request)} porte ${keys.join(', ')} sans valeur`,
    });
  const contradicting = passingWithout(reproduction, request, (body) =>
    relationKeys(body, npe.relation).some((key) => fieldState(body, key) === 'present'),
  ).map((other) => ({
    ref: other.id,
    fact: `${describe(other)} a abouti alors que sa charge utile ne porte aucune valeur « ${npe.relation} »`,
  }));
  const target = derefs[0];
  const verifications: ProposedVerification[] = [
    {
      kind: 'COMPARE_WITH_PASSING',
      description: `rejouer avec une valeur pour « ${npe.relation} » et comparer les charges utiles et les réponses de ${endpointOf(request)}`,
      params: { endpoint: endpointOf(request), field: keys[0] ?? npe.relation },
    },
    {
      kind: 'INSPECT_LOGS',
      description: `chercher la NullPointerException sur ${npe.nullFrom.method}() dans les journaux`,
      params: {
        patterns: ['NullPointerException', `${npe.nullFrom.method}()`],
        ...(target
          ? { applicationId: target.applicationId }
          : owner
            ? { applicationId: owner.applicationId }
            : {}),
      },
    },
    {
      kind: 'REPLAY',
      description: 'rejouer le scénario : la même erreur 500 doit revenir',
      params: scenarioParams(incident),
    },
  ];
  if (target)
    verifications.splice(1, 0, {
      kind: 'UNIT_TEST',
      description: `exécuter un test unitaire de ${target.name} sans « ${npe.relation} » (échec attendu avec la NullPointerException)`,
      params: { applicationId: target.applicationId, symbol: target.name, file: target.file, expect: 'fail' },
    });
  const layer: Layer = target?.layer ?? owner?.layer ?? 'UNKNOWN';
  return {
    rule: 'null-relation',
    title: `Relation « ${npe.relation} » nulle : ${npe.nullFrom.className}.${npe.nullFrom.method}() renvoie null`,
    description: `La réponse de ${describe(request)} contient une NullPointerException : la valeur de retour de ${npe.nullFrom.qualifiedClass}.${npe.nullFrom.method}() est null${npe.invoked ? ` et ${npe.invoked.className}.${npe.invoked.method}() est invoquée dessus` : ''}.`,
    suspectedCause: target
      ? `${target.name} (${target.file}:${String(target.line)}) déréférence ${codeChain(target)} sans vérifier que la relation « ${npe.relation} » existe${absent ? ` ; la requête ne transmet aucun « ${npe.relation} »` : ''}.`
      : `Le code qui appelle ${npe.nullFrom.className}.${npe.nullFrom.method}() ne gère pas une relation « ${npe.relation} » nulle (non localisé dans le code inspecté).`,
    layer,
    files: [...derefs.map((symbol) => symbol.file), ...(owner ? [owner.file] : [])],
    supporting,
    contradicting,
    confidence: 0.4 + (target ? 0.15 : 0) + (absent ? 0.1 : 0),
    verifications,
  };
}

function missingValidation(
  input: Context,
  request: HttpExchange,
  npe: NullDereference | undefined,
): Draft | undefined {
  const { code, reproduction, graph } = input;
  const payload = payloadOf(request);
  if (!payload) return undefined;
  const dtos = code ? dtosOnPath(code, request, graph) : [];
  // Les champs déclarés par les DTO, absents ou vides dans la charge utile, et qu'aucune annotation n'exige.
  const unchecked: { dto: CodeSymbol; field: DtoField }[] = [];
  const checked: { dto: CodeSymbol; field: DtoField }[] = [];
  for (const dto of code ? dtos : []) {
    for (const field of dtoFields(code as CodeIndex, dto)) {
      const required = field.annotations.some((annotation) => REQUIRED.test(annotation));
      if (required) checked.push({ dto, field });
      else if (fieldState(payload, field.name) === 'absent' || fieldState(payload, field.name) === 'empty')
        unchecked.push({ dto, field });
    }
  }
  // Avec une NullPointerException, le champ qui compte est celui de la relation nulle.
  const relevant = npe
    ? unchecked.filter((item) => item.field.name.toLowerCase().startsWith(npe.relation.toLowerCase()))
    : unchecked;
  const npeOnly =
    npe !== undefined &&
    relevant.length === 0 &&
    dtos.length === 0 &&
    relationKeys(payload, npe.relation).length === 0;
  if (relevant.length === 0 && !npeOnly) return undefined;
  const field = relevant[0]?.field.name ?? npe?.relation ?? '';
  const fieldLabel = relevant[0] ? field : `${field}…`;

  const neighbours = code ? frontendNeighbours(code, request) : [];
  const supporting: Hypothesis['supporting'] = [
    {
      ref: request.id,
      fact: `le frontend a envoyé ${endpointOf(request)} sans « ${fieldLabel} » (clés : ${Object.keys(payload).join(', ') || 'aucune'}) : sa validation l'a laissée passer`,
    },
    ...relevant.map(({ dto, field: item }) => ({
      ref: item.symbolId ?? dto.id,
      fact: `${dto.name} (${dto.file}) déclare ${item.name} sans @NotNull/@NotBlank${
        checked.some((other) => other.dto.id === dto.id)
          ? ` (alors que ${checked
              .filter((other) => other.dto.id === dto.id)
              .map((other) => other.field.name)
              .join(
                ', ',
              )} ${checked.filter((other) => other.dto.id === dto.id).length > 1 ? 'sont obligatoires' : 'est obligatoire'})`
          : ''
      }`,
    })),
  ];
  if (npe)
    supporting.push({
      ref: request.id,
      fact: `le serveur a ensuite échoué sur la relation « ${npe.relation} » nulle (${npe.nullFrom.className}.${npe.nullFrom.method}() est null)`,
    });
  const contradicting = passingWithout(
    reproduction,
    request,
    (body) => fieldState(body, field) === 'present',
  ).map((other) => ({ ref: other.id, fact: `${describe(other)} a abouti lui aussi sans « ${field} »` }));
  const bff = relevant.find((item) => item.dto.layer === 'BFF');
  const layer: Layer = bff ? 'BFF' : (relevant[0]?.dto.layer ?? 'FRONTEND');
  const dtoNames = [...new Set(relevant.map((item) => item.dto.name))];
  const verifications: ProposedVerification[] = relevant.slice(0, 2).map(({ dto, field: item }) => ({
    kind: 'CHECK_VALIDATION' as const,
    description: `vérifier que ${dto.name}.${item.name} ne porte ni @NotNull ni @NotBlank`,
    params: { applicationId: dto.applicationId, file: dto.file, field: item.name, expect: 'missing' },
  }));
  verifications.push(
    {
      kind: 'COMPARE_WITH_PASSING',
      description: `rejouer avec « ${field} » rempli : la requête doit aboutir et ne différer que par ce champ`,
      params: { endpoint: endpointOf(request), field },
    },
    {
      kind: 'COMPARE_REQUESTS',
      description: `comparer la charge utile de ${endpointOf(request)} en échec avec celle d'une requête qui aboutit`,
      params: { endpoint: endpointOf(request), field, expectMissingField: field },
    },
  );
  return {
    rule: 'missing-validation',
    title: `Validation manquante : « ${fieldLabel} » absent de la requête n'est refusé nulle part`,
    description: `${endpointOf(request)} est envoyée sans « ${fieldLabel} »${dtoNames.length > 0 ? ` et ${dtoNames.join(', ')} ne l'exige${dtoNames.length > 1 ? 'nt' : ''} pas` : ''} : la requête invalide va jusqu'au serveur au lieu d'être refusée par une validation.`,
    suspectedCause: `Le champ « ${fieldLabel} » n'est validé ni par le frontend (requête envoyée sans lui)${
      bff ? `, ni par le BFF (${bff.dto.name} sans @NotNull)` : ''
    }${relevant.some((item) => item.dto.layer === 'BACKEND') ? `, ni par le backend (${relevant.find((item) => item.dto.layer === 'BACKEND')?.dto.name ?? ''})` : ''} : une valeur manquante atteint ${npe ? 'le code qui déréférence la relation' : 'le serveur'}.`,
    layer,
    files: [...relevant.map((item) => item.dto.file), ...neighbours.map((symbol) => symbol.file)],
    supporting,
    contradicting,
    confidence: 0.35 + (relevant.length > 0 ? 0.15 : 0) + (npe ? 0.1 : 0),
    verifications,
  };
}

function backendPropagated(input: Context, request: HttpExchange): Draft | undefined {
  const { code, graph } = input;
  const body = request.responseBody ?? '';
  const cited = citedPaths(body).filter((path) => !pathMatches(path, request.path));
  const nested =
    /\b\w+\s+(?:error|erreur)\s*:?\s*5\d\d\b/i.test(body) ||
    (body.match(/status[\\"']*\s*:\s*5\d\d/g)?.length ?? 0) > 1;
  const calls = (graph?.nodes ?? []).filter((node) => node.kind === 'BACKEND_CALL' && node.layer === 'BFF');
  const match = code ? matchEndpoint(code, request.method, request.path, ['BFF']) : undefined;
  if (cited.length === 0 && !nested && !(match && calls.length > 0)) return undefined;
  const supporting: Hypothesis['supporting'] = [];
  if (cited.length > 0 || nested)
    supporting.push({
      ref: request.id,
      fact: `le corps de la réponse de ${describe(request)} ${cited.length > 0 ? `cite ${cited.join(', ')}` : 'enveloppe une autre erreur serveur'}${nested ? ' avec un statut 5xx imbriqué' : ''}`,
    });
  if (match)
    supporting.push({
      ref: match.endpoint.symbolId,
      fact: `${endpointOf(request)} est servi par le BFF (${match.endpoint.applicationId}, ${match.status})`,
    });
  for (const node of calls)
    supporting.push({
      ref: node.symbolId ?? node.id,
      fact: `le BFF appelle ${node.label} (${node.file ?? ''}:${String(node.line ?? '')})`,
    });
  const handlers = (code?.symbols ?? []).filter(
    (symbol) => symbol.layer === 'BFF' && symbol.kind === 'EXCEPTION_HANDLER',
  );
  const contradicting: Hypothesis['contradicting'] = [];
  if (match && cited.length === 0 && !nested)
    contradicting.push({
      ref: request.id,
      fact: "le corps de la réponse ne nomme aucun appel au backend : l'erreur vient peut-être du BFF lui-même",
    });
  const backendEndpoint = (graph?.nodes ?? []).find(
    (node) => node.kind === 'BACKEND_ENDPOINT' && node.layer === 'BACKEND',
  );
  return {
    rule: 'backend-propagated',
    title: `Erreur du backend propagée par le BFF${cited[0] ? ` (${cited[0]})` : ''}`,
    description: `${describe(request)} renvoie l'échec d'un appel du BFF vers le backend${cited.length > 0 ? ` (${cited.join(', ')})` : ''} au lieu d'une erreur fonctionnelle.`,
    suspectedCause: `Le backend échoue sur ${cited[0] ?? backendEndpoint?.label ?? 'l’appel du BFF'} et le BFF renvoie cette erreur telle quelle (${String(request.status ?? '5xx')})${handlers[0] ? ` via ${handlers[0].name}` : ''}.`,
    layer: 'BACKEND',
    files: [
      ...calls.map((node) => node.file ?? '').filter(Boolean),
      ...handlers.map((symbol) => symbol.file),
      ...(backendEndpoint?.file ? [backendEndpoint.file] : []),
    ],
    supporting,
    contradicting,
    confidence: 0.3 + (cited.length > 0 || nested ? 0.2 : 0) + (calls.length > 0 ? 0.1 : 0),
    verifications: [
      {
        kind: 'INSPECT_LOGS',
        description: `chercher l'appel en échec ${cited[0] ?? ''} dans les journaux du backend`
          .replace(/\s+/g, ' ')
          .trim(),
        params: { patterns: [...cited, ...exceptionsIn(body).map((item) => item.name)].slice(0, 6) },
      },
      {
        kind: 'COMPARE_RESPONSES',
        description: `comparer les réponses de ${endpointOf(request)} d'une exécution en échec et d'une exécution qui aboutit`,
        params: { endpoint: endpointOf(request) },
      },
    ],
  };
}

function serverError(input: Context, request: HttpExchange): Draft {
  const match = input.code
    ? matchEndpoint(input.code, request.method, request.path, ['BFF', 'BACKEND'])
    : undefined;
  const symbol = match ? input.code?.symbols.find((item) => item.id === match.endpoint.symbolId) : undefined;
  return {
    rule: 'server-error',
    title: `Erreur serveur sur ${endpointOf(request)}`,
    description: `${describe(request)} : le serveur a échoué ; la réponse ne nomme ni exception ni appel en aval.`,
    suspectedCause: `Une erreur non gérée dans ${symbol ? `${symbol.name} (${symbol.file})` : `le code qui sert ${endpointOf(request)} (non localisé)`}.`,
    layer: match?.endpoint.layer ?? 'UNKNOWN',
    files: symbol ? [symbol.file] : [],
    supporting: [
      { ref: request.id, fact: `${describe(request)} observée pendant la reproduction` },
      ...(match ? [{ ref: match.endpoint.symbolId, fact: match.reason }] : []),
    ],
    contradicting: [],
    confidence: 0.3 + (match ? 0.1 : 0),
    verifications: [
      {
        kind: 'INSPECT_LOGS',
        description: `lire les journaux du serveur autour de ${endpointOf(request)}`,
        params: {
          patterns: [request.path, 'Exception'],
          ...(match ? { applicationId: match.endpoint.applicationId } : {}),
        },
      },
      { kind: 'REPLAY', description: 'rejouer le scénario', params: scenarioParams(input.incident) },
    ],
  };
}

function clientError(input: Context, request: HttpExchange): Draft {
  const match = input.code
    ? matchEndpoint(input.code, request.method, request.path, ['BFF', 'BACKEND'])
    : undefined;
  const dto = match && input.code ? dtoOf(input.code, match.endpoint.symbolId) : undefined;
  const auth = request.status === 401 || request.status === 403;
  return {
    rule: 'client-error',
    title: auth
      ? `Accès refusé sur ${endpointOf(request)} (${String(request.status)})`
      : `Requête refusée par le serveur : validation ou contrat (${describe(request)})`,
    description: auth
      ? `${describe(request)} : la session ou les droits de l'utilisateur du scénario ne permettent pas l'appel.`
      : `${describe(request)} : la charge utile envoyée ne correspond pas à ce que le serveur attend (validation, format ou contrat).`,
    suspectedCause: auth
      ? `L'utilisateur ou la session du scénario n'a pas les droits sur ${endpointOf(request)}.`
      : `La requête construite par le frontend diffère du contrat de ${dto ? dto.name : endpointOf(request)}.`,
    layer: auth ? 'ENVIRONMENT' : (match?.endpoint.layer ?? 'UNKNOWN'),
    files: dto ? [dto.file] : [],
    supporting: [
      {
        ref: request.id,
        fact: `${describe(request)}${request.responseBody ? ` : ${request.responseBody.slice(0, 160)}` : ''}`,
      },
    ],
    contradicting: [],
    confidence: 0.35,
    verifications: [
      {
        kind: 'COMPARE_WITH_PASSING',
        description: `comparer avec une requête ${endpointOf(request)} qui aboutit`,
        params: { endpoint: endpointOf(request) },
      },
      ...(dto
        ? [
            {
              kind: 'CHECK_VALIDATION' as const,
              description: `lire les validations de ${dto.name}`,
              params: { applicationId: dto.applicationId, file: dto.file },
            },
          ]
        : []),
    ],
  };
}

interface Context {
  incident: Incident;
  reproduction?: ReproductionRun;
  code?: CodeIndex;
  graph?: InvestigationGraph;
}

export function proposeHypotheses(input: {
  incident: Incident;
  reproduction?: ReproductionRun;
  code?: CodeIndex;
  graph?: InvestigationGraph;
}): Hypothesis[] {
  const context: Context = input;
  const { reproduction, incident } = input;
  const drafts: Draft[] = [];
  if (!reproduction) return [];

  const serverErrors = failingRequests(reproduction, 500, 599);
  const npeRequest = serverErrors.find(
    (request) => request.responseBody && nullDereferenceIn(request.responseBody),
  );
  const npe = npeRequest?.responseBody ? nullDereferenceIn(npeRequest.responseBody) : undefined;
  if (npeRequest && npe) drafts.push(nullRelation(context, npeRequest, npe));

  // Validation manquante : une écriture en erreur dont la charge utile omet un champ.
  const writeErrors = failingRequests(reproduction, 400, 599).filter(isWrite);
  for (const request of writeErrors) {
    const draft = missingValidation(context, request, request === npeRequest ? npe : undefined);
    if (draft) {
      drafts.push(draft);
      break;
    }
  }

  const primary = serverErrors[0];
  if (primary) {
    const propagated = backendPropagated(context, primary);
    if (propagated) drafts.push(propagated);
    else if (!npe) drafts.push(serverError(context, primary));
  }

  const clientErrors = failingRequests(reproduction, 400, 499).filter(isApi);
  const firstClient = clientErrors[0];
  if (firstClient && serverErrors.length === 0) drafts.push(clientError(context, firstClient));

  const failures = reproduction.requests.filter((request) => request.failure !== undefined);
  if (failures.length > 0)
    drafts.push({
      rule: 'network-failure',
      title: `Échec réseau : ${failures[0]?.failure ?? ''}`.trim(),
      description: `${String(failures.length)} requête(s) n'ont reçu aucune réponse (${failures
        .slice(0, 3)
        .map((request) => `${endpointOf(request)} : ${request.failure ?? ''}`)
        .join(' ; ')}).`,
      suspectedCause: "Un service injoignable ou un problème réseau dans l'environnement de test.",
      layer: 'ENVIRONMENT',
      files: [],
      supporting: failures.slice(0, 5).map((request) => ({ ref: request.id, fact: describe(request) })),
      contradicting: reproduction.requests
        .filter(
          (request) =>
            request.failure === undefined &&
            request.status !== undefined &&
            request.status < 400 &&
            isApi(request),
        )
        .slice(0, 1)
        .map((request) => ({
          ref: request.id,
          fact: `${describe(request)} a répondu : le serveur est joignable`,
        })),
      confidence: 0.45,
      verifications: [
        {
          kind: 'REPLAY',
          description: "rejouer le scénario : l'échec revient-il ?",
          params: scenarioParams(incident),
        },
        {
          kind: 'INSPECT_LOGS',
          description: 'lire les journaux du serveur sur la période',
          params: { patterns: failures.map((r) => r.path).slice(0, 4) },
        },
      ],
    });

  // Erreur JavaScript avant toute requête d'API : le frontend s'arrête avant d'appeler le serveur.
  const firstApiStep = Math.min(
    ...reproduction.requests
      .filter((request) => isApi(request) && request.step !== undefined)
      .map((request) => request.step ?? Infinity),
  );
  const jsErrors = reproduction.evidence.filter(
    (item) =>
      item.kind === 'JS_ERROR' &&
      (item.source.step === undefined
        ? !reproduction.requests.some(isApi)
        : item.source.step <= firstApiStep),
  );
  if (jsErrors.length > 0)
    drafts.push({
      rule: 'frontend-error',
      title: 'Erreur JavaScript avant tout appel au serveur',
      description: jsErrors[0]?.summary ?? '',
      suspectedCause:
        'Le frontend lève une erreur avant d’envoyer la requête (gestionnaire d’événement ou validation).',
      layer: 'FRONTEND',
      files: [],
      supporting: jsErrors.slice(0, 5).map((item) => ({ ref: item.id, fact: item.summary })),
      contradicting: [],
      confidence: reproduction.requests.some(isApi) ? 0.3 : 0.5,
      verifications: [
        {
          kind: 'REPLAY',
          description: 'rejouer le scénario et lire la console',
          params: scenarioParams(incident),
        },
      ],
    });

  if (reproduction.reproduced === false) {
    const fact = reproduction.symptomMatch ?? "le symptôme n'a pas été observé";
    drafts.push(
      {
        rule: 'test-data',
        title: 'Le symptôme dépend des données saisies',
        description: `La reproduction n'a pas montré le symptôme (${fact}) : les données du scénario diffèrent peut-être de celles de l'incident.`,
        suspectedCause:
          "Une valeur précise (ou manquante) saisie lors de l'incident, absente du scénario rejoué.",
        layer: 'TEST_DATA',
        files: [],
        supporting: [{ ref: reproduction.id, fact }],
        contradicting: [],
        confidence: 0.3,
        verifications: [
          {
            kind: 'REPLAY',
            description: "rejouer avec les données décrites dans l'incident",
            params: scenarioParams(incident),
          },
        ],
      },
      {
        rule: 'environment',
        title: "Le symptôme dépend de l'environnement",
        description: `La reproduction n'a pas montré le symptôme (${fact}) : version déployée, configuration ou données de l'environnement différentes.`,
        suspectedCause: "L'environnement de l'incident diffère de celui de la reproduction.",
        layer: 'ENVIRONMENT',
        files: [],
        supporting: [{ ref: reproduction.id, fact }],
        contradicting: [],
        confidence: 0.25,
        verifications: [
          {
            kind: 'INSPECT_LOGS',
            description: "lire les journaux de l'environnement de l'incident",
            params: {},
          },
        ],
      },
    );
  }

  return drafts.map(toHypothesis);
}

// ── Expériences ──────────────────────────────────────────────────────────────────────────────

const EXPERIMENT_REF = /^experiment:([A-Z_]+):(.+)$/;

/** Les expériences qui ont soutenu l'hypothèse : `experiment:<KIND>:<id>` dans ses preuves favorables. */
export function supportingExperiments(hypothesis: Hypothesis): { kind: ExperimentKind; id: string }[] {
  return hypothesis.supporting.flatMap((item) => {
    const match = EXPERIMENT_REF.exec(item.ref);
    return match?.[1] && match[2] ? [{ kind: match[1] as ExperimentKind, id: match[2] }] : [];
  });
}

/**
 * CONFIRMED : au moins deux expériences indépendantes de sortes différentes l'ont soutenue, dont une
 * dynamique (exécution, rejeu, comparaison, journaux), et rien ne la contredit.
 */
export function meetsConfirmation(hypothesis: Hypothesis): boolean {
  const supports = supportingExperiments(hypothesis);
  const kinds = new Set(supports.map((item) => item.kind));
  const ids = new Set(supports.map((item) => item.id));
  return (
    kinds.size >= 2 &&
    ids.size >= 2 &&
    supports.some((item) => DYNAMIC_EXPERIMENTS.includes(item.kind)) &&
    hypothesis.contradicting.length === 0
  );
}

export function applyExperiment(hypotheses: Hypothesis[], experiment: Experiment): Hypothesis[] {
  if (experiment.status !== 'DONE' || !experiment.outcome || !experiment.hypothesisId) return hypotheses;
  const ref = `experiment:${experiment.kind}:${experiment.id}`;
  const fact = `${experiment.kind} ${experiment.outcome} : ${experiment.summary ?? experiment.description}`;
  return hypotheses.map((hypothesis) => {
    if (hypothesis.id !== experiment.hypothesisId) return hypothesis;
    // Une expérience ne compte qu'une fois.
    const known = [...hypothesis.supporting, ...hypothesis.contradicting].some((item) => item.ref === ref);
    if (known) return hypothesis;
    if (experiment.outcome === 'SUPPORTS') {
      const next: Hypothesis = {
        ...hypothesis,
        supporting: [...hypothesis.supporting, { ref, fact }],
      };
      const confirmed = meetsConfirmation(next);
      return {
        ...next,
        status: confirmed ? 'CONFIRMED' : hypothesis.status === 'REFUTED' ? 'REFUTED' : 'SUPPORTED',
        confidence: confirmed
          ? Math.max(0.9, clamp(hypothesis.confidence + 0.15, 0.95))
          : clamp(hypothesis.confidence + 0.15, 0.85),
      };
    }
    if (experiment.outcome === 'REFUTES')
      return {
        ...hypothesis,
        contradicting: [...hypothesis.contradicting, { ref, fact }],
        status: 'REFUTED',
        confidence: clamp(hypothesis.confidence - 0.4, 1),
      };
    // NEUTRAL : rien de nouveau ; sans autre résultat d'expérience, l'hypothèse reste à trancher.
    const decided =
      supportingExperiments(hypothesis).length > 0 ||
      hypothesis.contradicting.some((item) => EXPERIMENT_REF.test(item.ref));
    return decided ? hypothesis : { ...hypothesis, status: 'INCONCLUSIVE' };
  });
}

// ── Recommandations (fondées sur l'hypothèse, jamais inventées) ──────────────────────────────

export function recommendationsFor(hypothesis: Hypothesis): string[] {
  const files = hypothesis.files.length > 0 ? ` (${hypothesis.files.join(', ')})` : '';
  const field = hypothesis.verifications
    .map((item) => item.params.field)
    .find((value): value is string => typeof value === 'string');
  switch (ruleOf(hypothesis)) {
    case 'null-relation':
      return [
        `Vérifier la relation avant de la déréférencer et renvoyer une erreur fonctionnelle (400/422) quand elle manque${files}.`,
      ];
    case 'missing-validation':
      return [
        `Rendre « ${field ?? 'le champ'} » obligatoire de bout en bout : contrôle dans la validation du frontend, @NotNull sur le DTO du BFF, contrôle côté backend${files}.`,
      ];
    case 'backend-propagated':
      return [
        `Traduire l'erreur du backend en réponse fonctionnelle dans le BFF plutôt que la propager en 500${files}.`,
      ];
    case 'server-error':
      return [`Lire les journaux du serveur et ajouter la gestion de l'erreur${files}.`];
    case 'client-error':
      return [`Aligner la requête du frontend sur le contrat du serveur${files}.`];
    case 'network-failure':
      return ["Vérifier la disponibilité des services de l'environnement de test, puis rejouer."];
    case 'frontend-error':
      return [
        "Corriger l'erreur JavaScript levée avant l'appel au serveur (voir la console de la reproduction).",
      ];
    case 'test-data':
      return ["Rejouer avec les données exactes de l'incident."];
    case 'environment':
      return [
        "Comparer la version et la configuration de l'environnement de l'incident avec celles de la reproduction.",
      ];
    default:
      return [];
  }
}
