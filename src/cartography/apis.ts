import type {
  ApiCall,
  ApiContract,
  ApiEndpoint,
  ApiField,
  ApiService,
  CartographyModel,
  Evidence,
  MapConfidence,
  MapDecision,
  MapEdge,
  MapLayer,
  MapNode,
} from '../sdk/core/cartography.js';
import type { SourceFacts } from './facts.js';

/**
 * LE CATALOGUE DES API ET SERVICES, déduit du graphe et des faits du scan, jamais d'un nom seul :
 * - API INTERNE : les endpoints servis par une source BFF ou Backend, regroupés par le contrôleur qui les
 *   sert (preuve : la même classe) ; les appels qui y arrivent sont ceux que le graphe a reliés ;
 * - API EXTERNE : les appels HTTP sortants qu'aucun endpoint analysé ne sert et dont l'hôte est lu dans le
 *   code ou la configuration, regroupés par hôte (preuve : la même origine) ;
 * - À CLASSIFIER : un appel dont la cible ne peut pas être établie (URL dynamique, propriété sans valeur,
 *   appel du frontal qu'aucun endpoint ne sert) — dit comme tel, jamais supposé.
 * Aucune requête n'est envoyée : l'état dit la DÉTECTION, pas la disponibilité.
 */

const CONF_RANK: Record<MapConfidence, number> = { UNKNOWN: 0, PROBABLE: 1, CONFIRMED: 2 };
const weakest = (values: readonly MapConfidence[]): MapConfidence =>
  values.length === 0
    ? 'UNKNOWN'
    : values.reduce<MapConfidence>((low, c) => (CONF_RANK[c] < CONF_RANK[low] ? c : low), 'CONFIRMED');
const strongest = (values: readonly MapConfidence[]): MapConfidence =>
  values.reduce<MapConfidence>((best, c) => (CONF_RANK[c] > CONF_RANK[best] ? c : best), 'UNKNOWN');

const SENSITIVE = /(key|token|secret|password|passwd|pwd|signature|sig|auth|credential)/i;

/** Une adresse sans identifiants ni valeurs sensibles (paramètres masqués). */
export function maskUrl(url: string): string {
  const withoutUser = url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, '$1');
  const [base, query] = withoutUser.split('?', 2);
  if (!query) return withoutUser;
  const masked = query
    .split('&')
    .map((pair) => {
      const [key = '', value] = pair.split('=', 2);
      return value !== undefined && SENSITIVE.test(key) ? `${key}=***` : pair;
    })
    .join('&');
  return `${base ?? ''}?${masked}`;
}

/** « RequestBffController » → « Request Bff » ; « PartnerVerificationClient » → « Partner Verification ». */
export function humanizeClass(name: string): string {
  const core =
    name.replace(/(Bff)?(Rest)?(Controller|Resource|Client|Gateway|Adapter|Service|Api)$/u, '') || name;
  return core
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim();
}

const classOf = (handler: string): string => handler.split('.')[0] ?? handler;
const ownerOfSymbol = (symbol: string): string => {
  // « backend:src/…/PartnerVerificationClient.java#PartnerVerificationClient.verifyCompany »
  const member = symbol.split('#').pop() ?? symbol;
  return member.split('.')[0] ?? member;
};
const sourceOfEvidence = (evidence: readonly Evidence[]): string | undefined =>
  evidence.find((e) => e.sourceId)?.sourceId;

function hostLabel(origin: string): string {
  const host = origin.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(':')[0] ?? origin;
  return host;
}

/** Un champ par type, nom et sens (le premier endpoint qui l'échange est gardé). */
const unique = (fields: readonly ApiField[]): ApiField[] => [
  ...new Map(fields.map((f) => [`${f.container}.${f.name}|${f.direction}`, f])).values(),
];

export function buildApis(
  model: Omit<CartographyModel, 'apis'>,
  facts: readonly SourceFacts[],
): ApiService[] {
  const nodes = new Map<string, MapNode>(model.nodes.map((n) => [n.id, n]));
  const into = new Map<string, MapEdge[]>();
  const outOf = new Map<string, MapEdge[]>();
  for (const e of model.edges) {
    into.set(e.to, [...(into.get(e.to) ?? []), e]);
    outOf.set(e.from, [...(outOf.get(e.from) ?? []), e]);
  }
  const layerOfSource = new Map(facts.map((f) => [f.sourceId, f.layer]));
  const apis: ApiService[] = [];

  /** Les champs d'un type (DTO de requête ou de réponse) lus dans une source. */
  const fieldsOf = (
    sourceId: string | undefined,
    type: string | undefined,
    direction: 'OUT' | 'IN',
    endpoint: string,
  ): ApiField[] => {
    if (!sourceId || !type) return [];
    const prefix = `FIELD:${sourceId}:${type}.`;
    const graphFields = model.nodes.filter((n) => n.kind === 'FIELD' && n.id.startsWith(prefix));
    if (graphFields.length === 0) {
      // Un type qui n'est pas dans le graphe (réponse lue seulement) : ses champs tels que le code les déclare.
      const cls = facts.find((f) => f.sourceId === sourceId)?.java?.classes.find((c) => c.name === type);
      return (cls?.fields ?? []).map((field) => ({
        name: field.jsonName ?? field.name,
        type: field.type,
        direction,
        required: field.required,
        container: type,
        endpoint,
        evidence: [
          {
            kind: 'STATIC_CODE' as const,
            sourceId,
            file: cls?.loc.file ?? '',
            line: field.line,
            symbol: `${type}.${field.name}`,
            confidence: 'CONFIRMED' as const,
          },
        ],
      }));
    }
    return graphFields.map((n) => ({
      name: n.name,
      ...(typeof n.detail.type === 'string' ? { type: n.detail.type } : {}),
      direction,
      ...(typeof n.detail.required === 'boolean' ? { required: n.detail.required } : {}),
      container: type,
      node: n.id,
      endpoint,
      evidence: n.evidence.slice(0, 1),
    }));
  };

  // ── API internes : endpoints servis, regroupés par contrôleur ──────────────────────────────────────
  const served = model.nodes.filter((n) => n.kind === 'API' && (n.layer === 'BFF' || n.layer === 'BACKEND'));
  const byController = new Map<string, MapNode[]>();
  for (const node of served) {
    const source = sourceOfEvidence(node.evidence) ?? node.id.split(':')[1] ?? '';
    const handler = typeof node.detail.handler === 'string' ? node.detail.handler : node.name;
    const key = `${source}|${classOf(handler)}`;
    byController.set(key, [...(byController.get(key) ?? []), node]);
  }
  const documents = facts.flatMap((f) =>
    (f.openapi?.documents ?? []).map((d) => ({ ...d, sourceId: f.sourceId })),
  );
  for (const [key, members] of byController) {
    const [sourceId = '', controller = ''] = key.split('|');
    const layer = members[0]?.layer ?? 'BACKEND';
    const endpoints: ApiEndpoint[] = members
      .map((node) => {
        const contract = (outOf.get(node.id) ?? []).find(
          (e) =>
            e.kind === 'DEPENDS_ON' && nodes.get(e.to)?.layer === 'API' && nodes.get(e.to)?.kind === 'API',
        );
        return {
          id: node.id,
          ...(typeof node.detail.httpMethod === 'string' ? { method: node.detail.httpMethod } : {}),
          ...(typeof node.detail.path === 'string' ? { path: node.detail.path } : {}),
          node: node.id,
          ...(contract ? { contract: contract.to } : {}),
          ...(typeof node.detail.requestBody === 'string' ? { requestType: node.detail.requestBody } : {}),
          ...(typeof node.detail.returns === 'string' && node.detail.returns !== 'void'
            ? { responseType: node.detail.returns }
            : {}),
          confidence: 'CONFIRMED' as const,
          evidence: node.evidence.slice(0, 2),
        };
      })
      .sort(
        (a, b) =>
          (a.path ?? '').localeCompare(b.path ?? '') || (a.method ?? '').localeCompare(b.method ?? ''),
      );
    const calls: ApiCall[] = members.flatMap((node) =>
      (into.get(node.id) ?? [])
        .filter((e) => e.kind === 'CALLS')
        .map((e) => ({
          from: e.from,
          layer: nodes.get(e.from)?.layer ?? 'OTHER',
          endpoint: node.id,
          ...(typeof node.detail.httpMethod === 'string' ? { method: node.detail.httpMethod } : {}),
          ...(typeof node.detail.path === 'string' ? { path: node.detail.path } : {}),
          confidence: e.confidence,
          how: e.reason,
          evidence: e.evidence.slice(0, 2),
        })),
    );
    // Les champs : la requête (envoyée par l'appelant) et la réponse (reçue).
    const fields = unique(
      endpoints.flatMap((ep) => [
        ...fieldsOf(sourceId, ep.requestType, 'OUT', ep.id),
        ...fieldsOf(sourceId, ep.responseType, 'IN', ep.id),
      ]),
    );
    // Le contrat : l'opération qui décrit au moins un endpoint, et le document qui la porte.
    const described = endpoints.filter((ep) => ep.contract);
    const contractNode = described[0]?.contract ? nodes.get(described[0].contract) : undefined;
    const contractSource = contractNode ? sourceOfEvidence(contractNode.evidence) : undefined;
    const contractFile = contractNode?.evidence.find((e) => e.file)?.file;
    const document =
      documents.find((d) => d.sourceId === contractSource && (!contractFile || d.file === contractFile)) ??
      documents.find((d) => d.sourceId === contractSource);
    const contract: ApiContract | undefined = document
      ? {
          sourceId: document.sourceId,
          file: document.file,
          format: document.format,
          ...(document.version ? { version: document.version } : {}),
          ...(document.title ? { title: document.title } : {}),
          ...(document.documentation ? { documentation: document.documentation } : {}),
          operations: described.length,
        }
      : undefined;
    // Le nom proposé : l'étiquette du contrat quand il en donne une, sinon le contrôleur.
    const tags = described
      .map((ep) => (ep.contract ? nodes.get(ep.contract)?.detail.tags : undefined))
      .flatMap((value) => (Array.isArray(value) ? value : []));
    const tag = tags[0];
    const base = tag ? tag.charAt(0).toUpperCase() + tag.slice(1) : humanizeClass(controller);
    const proposed = `API ${base} (${layer === 'BFF' ? 'BFF' : 'Backend'})`;
    apis.push({
      id: `API:INTERNAL:${sourceId}:${controller}`,
      name: proposed,
      proposedName: proposed,
      technicalName: controller,
      scope: 'INTERNAL',
      owner: layer,
      consumers: [...new Set(calls.map((c) => c.layer))],
      provider: sourceId,
      properties: [],
      clients: [],
      endpoints,
      calls,
      fields,
      ...(contract ? { contract } : {}),
      status: 'DETECTED',
      confidence: 'CONFIRMED',
      reasons: [
        `endpoints servis par la source « ${sourceId} » (${layer === 'BFF' ? 'BFF' : 'Backend'}), dans le périmètre analysé`,
        `regroupés par le contrôleur ${controller} (${String(endpoints.length)} endpoint(s))`,
      ],
      evidence: members.flatMap((n) => n.evidence.slice(0, 1)).slice(0, 6),
    });
  }

  // ── Appels sortants non servis par le périmètre : externes (hôte connu) ou à classifier ────────────
  interface Pending {
    call: ApiCall;
    origin?: string;
    property?: string;
    owner: string;
    sourceId: string;
    bodyType?: string;
    responseType?: string;
    client?: string;
    properties: string[];
  }
  const pending: Pending[] = [];
  const servedIds = new Set(served.map((n) => n.id));
  for (const source of facts) {
    const layer = layerOfSource.get(source.sourceId) ?? source.layer;
    for (const out of source.java?.outgoing ?? []) {
      const from = `METHOD:${out.from}`;
      const matched = (outOf.get(from) ?? []).some((e) => e.kind === 'CALLS' && servedIds.has(e.to));
      if (matched) continue;
      const evidence: Evidence[] = [
        {
          kind: 'STATIC_CODE',
          sourceId: source.sourceId,
          file: out.loc.file,
          line: out.loc.line,
          symbol: out.from.split('#').pop() ?? out.from,
          confidence: out.origin
            ? out.status === 'STATICALLY_RESOLVED'
              ? 'CONFIRMED'
              : 'PROBABLE'
            : 'UNKNOWN',
          detail: `${out.method ?? '?'} ${out.path ?? '(adresse dynamique)'}${out.client ? ` · ${out.client}` : ''}`,
        },
      ];
      const confidence: MapConfidence = out.origin
        ? out.status === 'STATICALLY_RESOLVED'
          ? 'CONFIRMED'
          : 'PROBABLE'
        : 'UNKNOWN';
      pending.push({
        call: {
          from,
          layer,
          ...(out.method ? { method: out.method } : {}),
          ...(out.path ? { path: out.path } : {}),
          ...(out.client ? { client: out.client } : {}),
          confidence,
          how: out.origin
            ? out.status === 'STATICALLY_RESOLVED'
              ? `URL littérale vers ${out.origin}`
              : `URL reconstruite${out.properties?.length ? ` depuis la configuration (${out.properties.join(', ')})` : ''} vers ${out.origin}`
            : out.properties?.length
              ? `adresse lue dans la propriété ${out.properties.join(', ')}, sans valeur dans les sources analysées`
              : 'adresse calculée à l’exécution : la cible ne peut pas être établie statiquement',
          evidence,
        },
        ...(out.origin ? { origin: out.origin } : {}),
        ...(out.properties?.[0] ? { property: out.properties[0] } : {}),
        owner: ownerOfSymbol(out.from),
        sourceId: source.sourceId,
        ...(out.bodyType ? { bodyType: out.bodyType } : {}),
        ...(out.responseType ? { responseType: out.responseType } : {}),
        ...(out.client ? { client: out.client } : {}),
        properties: out.properties ?? [],
      });
    }
    // Un appel du frontal qu'aucun endpoint analysé ne sert : sa cible reste à classifier.
    for (const call of source.ui?.calls ?? []) {
      const from = `METHOD:${source.sourceId}:${call.id}`;
      const matched = (outOf.get(from) ?? []).some((e) => e.kind === 'CALLS');
      if (matched || !nodes.has(from)) continue;
      pending.push({
        call: {
          from,
          layer,
          method: call.method,
          ...(call.path ? { path: call.path } : {}),
          client: 'HttpClient',
          confidence: 'UNKNOWN',
          how: call.path
            ? `aucun endpoint analysé ne sert ${call.method} ${call.path}`
            : 'adresse calculée à l’exécution : la cible ne peut pas être établie statiquement',
          evidence: [
            {
              kind: 'STATIC_CODE',
              sourceId: source.sourceId,
              file: call.loc.file,
              line: call.loc.line,
              symbol: call.id,
              confidence: 'UNKNOWN',
            },
          ],
        },
        owner: call.owner,
        sourceId: source.sourceId,
        ...(call.bodyType ? { bodyType: call.bodyType } : {}),
        client: 'HttpClient',
        properties: [],
      });
    }
  }
  const groups = new Map<string, Pending[]>();
  for (const entry of pending) {
    const key = entry.origin
      ? `EXTERNAL|${entry.origin}`
      : entry.property
        ? `UNCLASSIFIED|property:${entry.property}`
        : `UNCLASSIFIED|${entry.sourceId}:${entry.owner}`;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  for (const [key, entries] of groups) {
    const [scope = 'UNCLASSIFIED', target = ''] = key.split('|');
    const external = scope === 'EXTERNAL';
    const owners = [...new Set(entries.map((e) => e.owner))];
    const endpointsByKey = new Map<string, ApiEndpoint>();
    const id = external ? `API:EXTERNAL:${target}` : `API:UNCLASSIFIED:${target}`;
    for (const entry of entries) {
      const epKey = `${entry.call.method ?? '?'} ${entry.call.path ?? '?'}`;
      const existing = endpointsByKey.get(epKey);
      if (existing) {
        existing.evidence = [...existing.evidence, ...entry.call.evidence].slice(0, 4);
        existing.confidence = strongest([existing.confidence, entry.call.confidence]);
        continue;
      }
      endpointsByKey.set(epKey, {
        id: `${id}|${epKey}`,
        ...(entry.call.method ? { method: entry.call.method } : {}),
        ...(entry.call.path ? { path: entry.call.path } : {}),
        ...(entry.bodyType ? { requestType: entry.bodyType } : {}),
        ...(entry.responseType ? { responseType: entry.responseType } : {}),
        confidence: entry.call.confidence,
        evidence: entry.call.evidence,
      });
    }
    const endpoints = [...endpointsByKey.values()];
    const calls = entries.map((entry) => ({
      ...entry.call,
      endpoint: `${id}|${entry.call.method ?? '?'} ${entry.call.path ?? '?'}`,
    }));
    const fields = entries.flatMap((entry) => {
      const endpoint = `${id}|${entry.call.method ?? '?'} ${entry.call.path ?? '?'}`;
      return [
        ...fieldsOf(entry.sourceId, entry.bodyType, 'OUT', endpoint),
        ...fieldsOf(entry.sourceId, entry.responseType, 'IN', endpoint),
      ];
    });
    const uniqueFields = unique(fields);
    const technical = owners.length === 1 ? (owners[0] ?? target) : external ? hostLabel(target) : target;
    const proposed = external
      ? `API ${owners.length === 1 ? humanizeClass(owners[0] ?? '') : hostLabel(target)} (externe)`
      : `Appel ${owners.length === 1 ? humanizeClass(owners[0] ?? '') : target} (à classifier)`;
    const confidence = weakest(calls.map((c) => c.confidence));
    const properties = [...new Set(entries.flatMap((e) => e.properties))];
    apis.push({
      id,
      name: proposed,
      proposedName: proposed,
      technicalName: technical,
      scope: external ? 'EXTERNAL' : 'UNCLASSIFIED',
      consumers: [...new Set(calls.map((c) => c.layer))],
      ...(external ? { provider: hostLabel(target), baseUrl: maskUrl(target) } : {}),
      properties,
      clients: [...new Set(entries.map((e) => e.client).filter((c): c is string => Boolean(c)))],
      endpoints,
      calls,
      fields: uniqueFields,
      // L'hôte est établi (code ou configuration) : l'API est détectée ; la confiance dit le reste.
      status: external ? (confidence === 'UNKNOWN' ? 'PROBABLE' : 'DETECTED') : 'TO_CLASSIFY',
      confidence,
      reasons: external
        ? [
            `hôte ${hostLabel(target)} : aucun endpoint des sources analysées ne sert ces appels`,
            properties.length
              ? `adresse lue dans la configuration (${properties.join(', ')})`
              : 'adresse écrite dans le code',
            `regroupés par l’hôte (${String(calls.length)} appel(s), ${String(endpoints.length)} endpoint(s))`,
          ]
        : [calls[0]?.how ?? 'cible non établie', 'à classifier par une personne (interne ou externe)'],
      evidence: calls.flatMap((c) => c.evidence).slice(0, 6),
    });
  }
  return apis.sort((a, b) => a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name));
}

/** Les décisions sur les API : renommer (nom métier), fixer le périmètre. Rejouées dans l'ordre. */
export function applyApiDecisions(
  apis: readonly ApiService[],
  decisions: readonly MapDecision[],
): ApiService[] {
  const byId = new Map(apis.map((api) => [api.id, { ...api }]));
  for (const decision of [...decisions].sort((a, b) => a.at.localeCompare(b.at))) {
    const api = byId.get(decision.target);
    if (!api) continue;
    if (decision.kind === 'RENAME_API' && decision.value?.trim()) api.name = decision.value.trim();
    if (
      decision.kind === 'CLASSIFY_API' &&
      (decision.value === 'INTERNAL' || decision.value === 'EXTERNAL')
    ) {
      api.scope = decision.value;
      api.status = 'DETECTED';
      api.classifiedByPerson = true;
      api.reasons = [
        ...api.reasons,
        `périmètre fixé à la main : ${decision.value === 'INTERNAL' ? 'interne' : 'externe'}`,
      ];
    }
  }
  return [...byId.values()];
}

export const API_LAYERS: readonly MapLayer[] = ['FRONTEND', 'BFF', 'BACKEND'];
