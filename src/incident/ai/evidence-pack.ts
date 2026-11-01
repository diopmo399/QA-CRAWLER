import type { AiDataPolicy, AiRef } from '../../sdk/core/incident-ai-contracts.js';
import type { CodeLayer, Experiment, Hypothesis, ReproductionRun } from '../model.js';
import {
  DATA_DELIMITER_END,
  DATA_DELIMITER_START,
  type AgentRunContext,
  type EvidencePack,
  type ToolContext,
} from './agent.js';
import { edgeId } from './refs.js';
import { clipText, createMasker, type Masker } from './tools.js';

/**
 * LES PAQUETS DE PREUVES : ce qu'un agent reçoit en entrée, déjà masqué (`redactText` + sanitizer IA),
 * délimité comme DONNÉE (« ===DATA … ===END DATA=== »), borné (éléments, caractères, extraits), avec la
 * liste des identifiants qu'il a le droit de citer (`refs`) et ce qui n'a pas été transmis (`omitted`),
 * à reporter dans les limites du run. La politique de données décide des corps HTTP, du code (les
 * détails des symboles), des journaux ; les captures ne partent jamais (vague 1).
 */
export interface PackOptions {
  secretValues?: readonly string[];
  sensitiveFields?: readonly string[];
  /** Caractères au plus pour la section JSON d'un paquet (défaut 12 000). */
  maxPackChars?: number;
  /** Éléments au plus par liste (défaut 40). */
  maxItems?: number;
}

export type PackContext = ToolContext & { hypotheses: Hypothesis[]; experiments: Experiment[] };

export const DEFAULT_PACK_CHARS = 12_000;
export const DEFAULT_PACK_ITEMS = 40;
const SHORT_TEXT = 600;

/** Un bloc délimité : étiquette, puis le contenu — jamais une instruction. */
export function dataBlock(label: string, body: string): string {
  return `${DATA_DELIMITER_START}\n[${label}]\n${body}\n${DATA_DELIMITER_END}`;
}

export const emptyPack = (label: string, reason: string): EvidencePack => ({
  text: dataBlock(label, `(empty) ${reason}`),
  refs: [],
  omitted: [reason],
});

/** Une liste JSON, un élément par ligne, réduite par la fin jusqu'à tenir dans `maxChars`. */
function serializeList(items: unknown[], maxChars: number): { text: string; kept: number } {
  let kept = items.length;
  let lines = items.map((item) => JSON.stringify(item ?? null));
  let text = lines.join('\n');
  while (text.length > maxChars && kept > 1) {
    kept = Math.max(1, Math.floor(kept / 2));
    lines = lines.slice(0, kept);
    text = lines.join('\n');
  }
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}…`;
  return { text, kept };
}

const unique = (refs: AiRef[]): AiRef[] => {
  const seen = new Set<string>();
  const result: AiRef[] = [];
  for (const ref of refs) {
    const key = `${ref.kind}:${ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(ref);
  }
  return result;
};

export function createPacks(
  ctx: PackContext,
  policy: AiDataPolicy,
  options: PackOptions = {},
): AgentRunContext['packs'] {
  const masker: Masker = createMasker(options);
  const maxChars = options.maxPackChars ?? DEFAULT_PACK_CHARS;
  const maxItems = options.maxItems ?? DEFAULT_PACK_ITEMS;
  const snippet = (text: string): string => clipText(text, policy.maxSnippetChars);

  /** Construit un paquet depuis des éléments : masque, borne, consigne les omissions. */
  const pack = (
    label: string,
    items: unknown[],
    refs: AiRef[],
    omitted: string[],
    header?: Record<string, unknown>,
  ): EvidencePack => {
    const masked = masker.value(items.slice(0, maxItems)) as unknown[];
    const notes = [...omitted];
    if (items.length > maxItems)
      notes.push(
        `${label} : ${items.length - maxItems} élément(s) non transmis (borne de ${maxItems} éléments).`,
      );
    const headerText = header ? `${JSON.stringify(masker.value(header))}\n` : '';
    const { text, kept } = serializeList(masked, Math.max(200, maxChars - headerText.length));
    if (kept < masked.length)
      notes.push(
        `${label} : ${masked.length - kept} élément(s) non transmis (borne de ${maxChars} caractères).`,
      );
    return { text: dataBlock(label, `${headerText}${text}`), refs: unique(refs), omitted: notes };
  };

  const latestReproduction = (): ReproductionRun | undefined =>
    ctx.reproduction ?? ctx.incident.investigation.reproductions.at(-1);

  const incident = (): EvidencePack => {
    const { incident: current } = ctx;
    const header = {
      id: current.id,
      title: current.title,
      description: clipText(current.description, SHORT_TEXT * 2),
      observed: clipText(current.observed, SHORT_TEXT),
      expected: clipText(current.expected, SHORT_TEXT),
      severity: current.severity,
      ...(current.kind !== undefined ? { kind: current.kind } : {}),
      ...(current.scenario !== undefined ? { scenario: current.scenario } : {}),
      state: current.state,
      scope: {
        mode: current.scope.mode,
        endpoints: current.scope.endpoints,
        depth: current.scope.depth,
        permissions: current.scope.permissions,
        limits: current.scope.limits,
      },
    };
    const items = current.scope.applications.map((application) => ({
      applicationId: application.id,
      name: application.name,
      layer: application.layer,
      include: application.repository.include,
      ...(application.baseUrl !== undefined ? { baseUrl: application.baseUrl } : {}),
    }));
    const omitted: string[] = [];
    const attachments = current.attachments ?? [];
    if (attachments.length > 0)
      omitted.push(
        `incident : ${attachments.length} pièce(s) jointe(s) non transmise(s) (lecture par les outils seulement).`,
      );
    return pack('incident', items, [], omitted, header);
  };

  const reproduction = (): EvidencePack => {
    const run = latestReproduction();
    if (!run) return emptyPack('reproduction', 'reproduction : aucune reproduction enregistrée.');
    const refs: AiRef[] = [];
    const omitted: string[] = [];
    const items: unknown[] = [];
    for (const action of run.actions) {
      refs.push({ kind: 'step', id: `${run.id}:step-${action.index}` });
      items.push({
        type: 'action',
        step: action.index,
        ref: `${run.id}:step-${action.index}`,
        kind: action.kind,
        description: clipText(action.description, SHORT_TEXT),
        status: action.status,
        ...(action.reason !== undefined ? { reason: clipText(action.reason, SHORT_TEXT) } : {}),
        ...(action.url !== undefined ? { url: action.url } : {}),
        durationMs: action.durationMs,
        requestIds: action.requestIds,
      });
      for (const requestId of action.requestIds) refs.push({ kind: 'request', id: requestId });
    }
    let logs = 0;
    let screenshots = 0;
    for (const evidence of run.evidence) {
      if (evidence.kind === 'LOG_LINE' && !policy.sendLogs) {
        logs += 1;
        continue;
      }
      if (evidence.kind === 'SCREENSHOT') screenshots += 1;
      refs.push({ kind: 'evidence', id: evidence.id });
      items.push({
        type: 'evidence',
        id: evidence.id,
        kind: evidence.kind,
        ...(evidence.at !== undefined ? { at: evidence.at } : {}),
        summary: snippet(evidence.summary),
        source: evidence.source,
      });
    }
    if (logs > 0)
      omitted.push(`reproduction : ${logs} ligne(s) de journal non transmise(s) (politique sendLogs=false).`);
    if (screenshots > 0 || run.screenshots.length > 0)
      omitted.push('reproduction : les captures d’écran ne sont jamais transmises (identifiants seulement).');
    const header = {
      id: run.id,
      status: run.status,
      target: run.target,
      scenario: run.scenario,
      reproduced: run.reproduced,
      ...(run.symptomMatch !== undefined ? { symptomMatch: clipText(run.symptomMatch, SHORT_TEXT) } : {}),
      ...(run.error !== undefined ? { error: clipText(run.error, SHORT_TEXT) } : {}),
      requests: run.requests.length,
    };
    return pack('reproduction', items, refs, omitted, header);
  };

  const requests = (requestOptions: { errorsOnly?: boolean } = {}): EvidencePack => {
    const run = latestReproduction();
    if (!run) return emptyPack('requests', 'requests : aucune reproduction enregistrée.');
    const refs: AiRef[] = [];
    const items: unknown[] = [];
    const omitted: string[] = [];
    let bodies = 0;
    for (const request of run.requests) {
      const failed = request.failure !== undefined || (request.status ?? 0) >= 400;
      if (requestOptions.errorsOnly && !failed) continue;
      refs.push({ kind: 'request', id: request.id });
      const item: Record<string, unknown> = {
        id: request.id,
        method: request.method,
        path: request.path,
        url: request.url,
        ...(request.status !== undefined ? { status: request.status } : {}),
        ...(request.failure !== undefined ? { failure: clipText(request.failure, SHORT_TEXT) } : {}),
        ...(request.step !== undefined ? { step: request.step } : {}),
        correlation: request.correlation,
        resourceType: request.resourceType,
        ...(request.durationMs !== undefined ? { durationMs: request.durationMs } : {}),
        ...(request.startedAt !== undefined ? { startedAt: request.startedAt } : {}),
        ...(request.requestHeaders ? { requestHeaders: request.requestHeaders } : {}),
        ...(request.responseHeaders ? { responseHeaders: request.responseHeaders } : {}),
      };
      if (request.requestBody !== undefined || request.responseBody !== undefined) {
        if (policy.sendHttpBodies) {
          if (request.requestBody !== undefined) item.requestBody = snippet(request.requestBody);
          if (request.responseBody !== undefined) item.responseBody = snippet(request.responseBody);
        } else bodies += 1;
      }
      items.push(item);
    }
    if (bodies > 0)
      omitted.push(`requests : corps de ${bodies} échange(s) non transmis (politique sendHttpBodies=false).`);
    return pack('requests', items, refs, omitted, {
      reproduction: run.id,
      errorsOnly: requestOptions.errorsOnly === true,
    });
  };

  const graph = (graphOptions: { layer?: CodeLayer } = {}): EvidencePack => {
    const current = ctx.graph ?? ctx.incident.investigation.graph;
    if (!current) return emptyPack('graph', 'graph : aucun graphe (corrélation non calculée).');
    const refs: AiRef[] = [];
    const items: unknown[] = [];
    const kept = new Set<string>();
    for (const node of current.nodes) {
      if (graphOptions.layer !== undefined && node.layer !== graphOptions.layer) continue;
      kept.add(node.id);
      refs.push({ kind: 'node', id: node.id });
      if (node.symbolId !== undefined) refs.push({ kind: 'symbol', id: node.symbolId });
      items.push({
        type: 'node',
        id: node.id,
        kind: node.kind,
        label: clipText(node.label, SHORT_TEXT),
        layer: node.layer,
        evidence: node.evidence,
        ...(node.symbolId !== undefined ? { symbolId: node.symbolId } : {}),
        ...(node.file !== undefined ? { file: node.file } : {}),
        ...(node.line !== undefined ? { line: node.line } : {}),
      });
    }
    for (const edge of current.edges) {
      if (!kept.has(edge.from) && !kept.has(edge.to)) continue;
      const id = edgeId(edge.from, edge.to);
      refs.push({ kind: 'edge', id });
      items.push({
        type: 'edge',
        id,
        from: edge.from,
        to: edge.to,
        status: edge.status,
        reason: clipText(edge.reason, SHORT_TEXT),
        evidence: edge.evidence,
      });
    }
    return pack('graph', items, refs, [], {
      nodes: current.nodes.length,
      edges: current.edges.length,
      ...(graphOptions.layer ? { layer: graphOptions.layer } : {}),
    });
  };

  const code = (layer: CodeLayer): EvidencePack => {
    const index = ctx.code ?? ctx.incident.investigation.code;
    if (!index) return emptyPack(`code:${layer}`, `code ${layer} : aucun index de code (analyse non faite).`);
    const refs: AiRef[] = [];
    const items: unknown[] = [];
    const omitted: string[] = [];
    let details = 0;
    for (const symbol of index.symbols) {
      if (symbol.layer !== layer) continue;
      refs.push(
        { kind: 'symbol', id: symbol.id },
        { kind: 'file', id: `${symbol.applicationId}:${symbol.file}` },
      );
      const item: Record<string, unknown> = {
        type: 'symbol',
        id: symbol.id,
        applicationId: symbol.applicationId,
        kind: symbol.kind,
        name: symbol.name,
        file: symbol.file,
        line: symbol.line,
        ...(symbol.parent !== undefined ? { parent: symbol.parent } : {}),
      };
      if (symbol.detail) {
        if (policy.sendSourceCode) item.detail = symbol.detail;
        else details += 1;
      }
      items.push(item);
    }
    for (const endpoint of index.endpoints)
      if (endpoint.layer === layer) items.push({ type: 'endpoint', ...endpoint });
    for (const outgoing of index.outgoing)
      if (outgoing.layer === layer) {
        refs.push({ kind: 'file', id: `${outgoing.applicationId}:${outgoing.file}` });
        items.push({ type: 'outgoing', ...outgoing });
      }
    const owned = new Set<string>();
    for (const application of index.applications) if (application.layer === layer) owned.add(application.id);
    for (const call of index.calls) {
      const owner = call.from.split(':')[0] ?? '';
      if (!owned.has(owner)) continue;
      items.push({
        type: 'call',
        from: call.from,
        ...(call.to !== undefined ? { to: call.to } : {}),
        text: clipText(call.text, SHORT_TEXT),
        status: call.status,
        file: call.file,
        line: call.line,
      });
    }
    if (details > 0)
      omitted.push(
        `code ${layer} : détails de ${details} symbole(s) non transmis (politique sendSourceCode=false).`,
      );
    for (const denied of index.denied) omitted.push(`code : refusé « ${denied.path} » (${denied.reason}).`);
    for (const truncated of index.truncated) omitted.push(`code : ${truncated}`);
    const applications = index.applications.flatMap((application) =>
      application.layer === layer ? [application] : [],
    );
    return pack(`code:${layer}`, items, refs, omitted, { layer, applications });
  };

  const hypotheses = (): EvidencePack => {
    const refs: AiRef[] = [];
    const items = ctx.hypotheses.map((hypothesis) => {
      refs.push({ kind: 'hypothesis', id: hypothesis.id });
      return {
        id: hypothesis.id,
        title: clipText(hypothesis.title, SHORT_TEXT),
        description: clipText(hypothesis.description, SHORT_TEXT * 2),
        suspectedCause: clipText(hypothesis.suspectedCause, SHORT_TEXT),
        layer: hypothesis.layer,
        files: hypothesis.files,
        confidence: hypothesis.confidence,
        status: hypothesis.status,
        origin: hypothesis.origin ?? 'RULE',
        supporting: hypothesis.supporting.map((item) => ({
          ref: item.ref,
          fact: clipText(item.fact, SHORT_TEXT),
        })),
        contradicting: hypothesis.contradicting.map((item) => ({
          ref: item.ref,
          fact: clipText(item.fact, SHORT_TEXT),
        })),
        verifications: hypothesis.verifications.map((verification) => ({
          kind: verification.kind,
          description: clipText(verification.description, SHORT_TEXT),
        })),
      };
    });
    if (items.length === 0) return emptyPack('hypotheses', 'hypotheses : aucune hypothèse pour l’instant.');
    return pack('hypotheses', items, refs, []);
  };

  const experiments = (): EvidencePack => {
    const refs: AiRef[] = [];
    const omitted: string[] = [];
    let logs = 0;
    const items = ctx.experiments.map((experiment) => {
      refs.push({ kind: 'experiment', id: experiment.id });
      const evidence: unknown[] = [];
      for (const item of experiment.evidence) {
        if (item.kind === 'LOG_LINE' && !policy.sendLogs) {
          logs += 1;
          continue;
        }
        refs.push({ kind: 'evidence', id: item.id });
        evidence.push({ id: item.id, kind: item.kind, summary: snippet(item.summary) });
      }
      return {
        id: experiment.id,
        kind: experiment.kind,
        ...(experiment.hypothesisId !== undefined ? { hypothesisId: experiment.hypothesisId } : {}),
        description: clipText(experiment.description, SHORT_TEXT),
        params: experiment.params,
        status: experiment.status,
        sideEffects: experiment.sideEffects,
        ...(experiment.outcome !== undefined ? { outcome: experiment.outcome } : {}),
        ...(experiment.summary !== undefined ? { summary: clipText(experiment.summary, SHORT_TEXT) } : {}),
        refusals: experiment.decisions.flatMap((decision) =>
          decision.allowed ? [] : [`${decision.rule} : ${clipText(decision.reason, SHORT_TEXT)}`],
        ),
        evidence,
      };
    });
    if (logs > 0)
      omitted.push(`experiments : ${logs} ligne(s) de journal non transmise(s) (politique sendLogs=false).`);
    if (items.length === 0)
      return emptyPack('experiments', 'experiments : aucune vérification pour l’instant.');
    return pack('experiments', items, refs, omitted);
  };

  return { incident, reproduction, requests, graph, code, hypotheses, experiments };
}
