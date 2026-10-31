import { normalizePath } from './code/paths.js';
import type {
  ActionEvidence,
  CodeCall,
  CodeIndex,
  CodeSymbol,
  Evidence,
  FrontendTrace,
  FrontendTraceStep,
  HttpExchange,
  OutgoingHttpCall,
  RelationStatus,
  ReproductionRun,
  SourceLocation,
  TraceLink,
} from './model.js';

/**
 * LA TRAÇABILITÉ FRONTEND d'une reproduction : pour chaque étape Playwright, l'action (observée),
 * l'élément visé (tel que l'étape le décrit), puis ce que le code permet de déduire — le composant et le
 * handler dont le déclencheur porte le même libellé (« <form onSubmit> « Enregistrer » »), les fonctions
 * TypeScript atteintes par les appels lus dans le code, les clients HTTP qui correspondent aux requêtes
 * observées de l'étape (méthode et chemin), et le gestionnaire d'erreur qui produit le message affiché.
 *
 * Seul ce que le run a vu est OBSERVED (l'étape, ses requêtes, ses preuves). Composant, handler et
 * services ne s'observent pas sans instrumentation : ils sont INFERRED (ou gardent le statut de l'appel
 * lu dans le code), UNKNOWN quand rien ne correspond. Aucune durée n'est attribuée au code. Pur,
 * déterministe, sans entrée-sortie.
 */

/** Profondeur maximale des appels parcourus depuis le handler. */
const MAX_DEPTH = 4;

/** Les étapes qui agissent sur un élément de la page. */
const INTERACTIONS = new Set([
  'click',
  'check',
  'uncheck',
  'fill',
  'select',
  'dragAndDrop',
  'auto',
  'intent',
]);

/** Les props d'événement compatibles avec chaque sorte d'étape (absente : toutes). */
const COMPATIBLE_PROPS: Record<string, readonly string[]> = {
  click: [
    'onClick',
    'onSubmit',
    'onPress',
    'onMouseDown',
    'onMouseUp',
    'onPointerDown',
    'onPointerUp',
    'onChange',
  ],
  check: ['onChange', 'onClick', 'onInput'],
  uncheck: ['onChange', 'onClick', 'onInput'],
  fill: ['onChange', 'onInput', 'onBlur', 'onKeyUp', 'onKeyDown'],
  select: ['onChange', 'onInput'],
};

const FAILED = new Set(['FAILED', 'BLOCKED']);

const fold = (text: string): string =>
  text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

const quote = (text: string): string => `« ${text} »`;

// ── L'élément décrit par l'étape ───────────────────────────────────────────────────────────

/** La cible d'une étape telle que sa description l'écrit (`click role=button[name="Enregistrer"]`). */
export interface StepTarget {
  role?: string;
  /** Le nom accessible, le libellé ou le texte visé. */
  name?: string;
  strategy: 'role' | 'label' | 'text' | 'testId' | 'css' | 'quoted' | 'none';
  /** La cible telle qu'écrite. */
  raw: string;
}

/** Lit la cible dans la description d'une étape ; aucun détail DOM n'est supposé au-delà. */
export function parseStepTarget(description: string): StepTarget {
  const role = /\brole=([\w-]+)(?:\[name="([^"]*)"\])?/.exec(description);
  if (role?.[1])
    return {
      strategy: 'role',
      role: role[1],
      ...(role[2] !== undefined ? { name: role[2] } : {}),
      raw: role[0],
    };
  const labelled = /\b(label|text)="([^"]*)"/.exec(description);
  if (labelled?.[1] && labelled[2] !== undefined)
    return { strategy: labelled[1] === 'label' ? 'label' : 'text', name: labelled[2], raw: labelled[0] };
  const testId = /\btestId=(\S+)/.exec(description);
  if (testId?.[1]) return { strategy: 'testId', raw: testId[0] };
  const css = /\bcss=(.+?)(?:\s+=\s+.*)?$/.exec(description);
  if (css?.[1]) return { strategy: 'css', raw: css[0] };
  const quoted = /«\s*([^»]+?)\s*»|"([^"]+)"|“([^”]+)”/.exec(description);
  const text = quoted ? (quoted[1] ?? quoted[2] ?? quoted[3]) : undefined;
  if (quoted && text) return { strategy: 'quoted', name: text.trim(), raw: quoted[0] };
  return { strategy: 'none', raw: description };
}

function targetLabel(target: StepTarget): string {
  if (target.strategy === 'role')
    return `${target.role ?? ''}${target.name !== undefined ? ` ${quote(target.name)}` : ''}`;
  if (target.strategy === 'label') return `champ ${quote(target.name ?? '')}`;
  if (target.strategy === 'text' || target.strategy === 'quoted') return quote(target.name ?? '');
  return target.raw;
}

function targetDetail(target: StepTarget): string {
  switch (target.strategy) {
    case 'role':
      return `rôle ${target.role ?? '?'}${target.name !== undefined ? `, nom accessible ${quote(target.name)}` : ', sans nom accessible'}`;
    case 'label':
      return `libellé ${quote(target.name ?? '')}`;
    case 'text':
      return `texte ${quote(target.name ?? '')}`;
    case 'quoted':
      return `nom ${quote(target.name ?? '')}`;
    case 'testId':
    case 'css':
      return `sélecteur ${target.raw}`;
    case 'none':
      return 'aucune cible lisible dans la description';
  }
}

// ── Les déclencheurs lus dans le code ──────────────────────────────────────────────────────

interface Trigger {
  tag: string;
  prop: string;
  labels: string[];
  raw: string;
}

/** `<form onSubmit> « Enregistrer »` → tag form, prop onSubmit, libellés [Enregistrer]. */
export function parseTrigger(raw: string): Trigger | undefined {
  const match = /^<([^\s>]+)\s+([^>\s]+)>(?:\s*«\s*(.*?)\s*»)?\s*$/.exec(raw.trim());
  if (!match?.[1] || !match[2]) return undefined;
  const labels = (match[3] ?? '')
    .split(' / ')
    .map((label) => label.trim())
    .filter(Boolean);
  return { tag: match[1], prop: match[2], labels, raw: raw.trim() };
}

const list = (symbol: CodeSymbol | undefined, key: string): string[] => {
  const value = symbol?.detail?.[key];
  return Array.isArray(value) ? value : [];
};

const sourceOf = (symbol: CodeSymbol): SourceLocation => ({
  applicationId: symbol.applicationId,
  layer: symbol.layer,
  file: symbol.file,
  line: symbol.line,
  symbolId: symbol.id,
});

const at = (file: string, line: number): string => `${file}:${String(line)}`;

interface Candidate {
  handler?: CodeSymbol;
  component?: CodeSymbol;
  /** L'entrée `handlers` du composant quand le handler n'est pas un symbole (`… → save`). */
  unresolved?: string;
  trigger: Trigger;
  label: string;
  /** 3 : libellé identique ; 2 : libellé contenu ; 1 : libellé cité dans une description libre. */
  score: number;
  /** Le handler atteint un client HTTP qui correspond aux requêtes de l'étape. */
  matchesRequests: boolean;
}

function scoreLabel(target: StepTarget, description: string, label: string): number {
  const wanted = fold(label);
  if (wanted.length === 0) return 0;
  if (target.name !== undefined) {
    const name = fold(target.name);
    if (name.length === 0) return 0;
    if (name === wanted) return 3;
    const words = (text: string): string[] => text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const contains = (outer: string, inner: string): boolean => {
      const a = words(outer).join(' ');
      const b = words(inner).join(' ');
      return b.length >= 3 && ` ${a} `.includes(` ${b} `);
    };
    return contains(name, wanted) || contains(wanted, name) ? 2 : 0;
  }
  if (target.strategy !== 'none' || wanted.length < 3) return 0;
  // Une description libre (« Cliquer sur Enregistrer ») : le libellé y est cité comme un mot entier.
  return ` ${fold(description).replace(/[^\p{L}\p{N}]+/gu, ' ')} `.includes(
    ` ${wanted.replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `,
  )
    ? 1
    : 0;
}

// ── Le contexte du code ────────────────────────────────────────────────────────────────────

interface CodeContext {
  code: CodeIndex;
  byId: Map<string, CodeSymbol>;
  callsFrom: Map<string, CodeCall[]>;
  outgoingOf: Map<string, OutgoingHttpCall[]>;
  errorHandlers: Map<string, CodeSymbol[]>;
  handlers: CodeSymbol[];
  components: CodeSymbol[];
  frontendOutgoing: OutgoingHttpCall[];
}

function codeContext(code: CodeIndex): CodeContext {
  const frontend = code.symbols.filter((symbol) => symbol.layer === 'FRONTEND');
  const byId = new Map(code.symbols.map((symbol) => [symbol.id, symbol]));
  const callsFrom = new Map<string, CodeCall[]>();
  for (const call of code.calls) callsFrom.set(call.from, [...(callsFrom.get(call.from) ?? []), call]);
  const outgoingOf = new Map<string, OutgoingHttpCall[]>();
  const frontendOutgoing = code.outgoing.filter((call) => call.layer === 'FRONTEND');
  for (const call of frontendOutgoing)
    outgoingOf.set(call.symbolId, [...(outgoingOf.get(call.symbolId) ?? []), call]);
  const errorHandlers = new Map<string, CodeSymbol[]>();
  for (const symbol of frontend)
    if (symbol.kind === 'ERROR_HANDLER' && symbol.parent)
      errorHandlers.set(symbol.parent, [...(errorHandlers.get(symbol.parent) ?? []), symbol]);
  const byPosition = (a: CodeSymbol, b: CodeSymbol): number =>
    a.applicationId.localeCompare(b.applicationId) || a.file.localeCompare(b.file) || a.line - b.line;
  return {
    code,
    byId,
    callsFrom,
    outgoingOf,
    errorHandlers,
    handlers: frontend.filter((symbol) => symbol.kind === 'EVENT_HANDLER').sort(byPosition),
    components: frontend.filter((symbol) => symbol.kind === 'COMPONENT').sort(byPosition),
    frontendOutgoing,
  };
}

function componentOf(ctx: CodeContext, symbol: CodeSymbol): CodeSymbol | undefined {
  let current = symbol.parent ? ctx.byId.get(symbol.parent) : undefined;
  for (let depth = 0; current && depth < 10; depth += 1) {
    if (current.kind === 'COMPONENT') return current;
    current = current.parent ? ctx.byId.get(current.parent) : undefined;
  }
  return undefined;
}

interface Reached {
  symbol: CodeSymbol;
  call: CodeCall;
  depth: number;
}

/** Les fonctions atteintes depuis le handler par les appels lus dans le code (préordre, ordre des appels). */
function reachedFrom(ctx: CodeContext, start: CodeSymbol): { reached: Reached[]; unresolved: CodeCall[] } {
  const reached: Reached[] = [];
  const unresolved: CodeCall[] = [];
  const seen = new Set<string>([start.id]);
  const walk = (from: string, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    for (const call of ctx.callsFrom.get(from) ?? []) {
      if (!call.to) {
        unresolved.push(call);
        continue;
      }
      if (seen.has(call.to)) continue;
      const symbol = ctx.byId.get(call.to);
      if (!symbol) continue;
      seen.add(call.to);
      reached.push({ symbol, call, depth });
      walk(symbol.id, depth + 1);
    }
  };
  walk(start.id, 1);
  return { reached, unresolved };
}

// ── Les requêtes ───────────────────────────────────────────────────────────────────────────

function pathMatches(template: string, observed: string): boolean {
  const pattern = normalizePath(template).split('/');
  const value = normalizePath(observed).split('/');
  if (pattern.length !== value.length) return false;
  return pattern.every((segment, index) => {
    const actual = value[index] ?? '';
    if (segment === actual) return true;
    if (segment === '{}') return actual !== '';
    if (!segment.includes('{}')) return false;
    const regex = new RegExp(
      `^${segment
        .split('{}')
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('[^/]+')}$`,
    );
    return regex.test(actual);
  });
}

function outgoingMatches(call: OutgoingHttpCall, request: HttpExchange): boolean {
  if (call.path === undefined) return false;
  if (call.method && call.method.toUpperCase() !== request.method.toUpperCase()) return false;
  return pathMatches(call.path, request.path);
}

const requestText = (request: HttpExchange): string =>
  `${request.method.toUpperCase()} ${request.path}${request.status !== undefined ? ` → ${String(request.status)}` : request.failure ? ' → échec' : ''}`;

function requestsOf(run: ReproductionRun, action: ActionEvidence): HttpExchange[] {
  const byId = new Map(run.requests.map((request) => [request.id, request]));
  const ordered: HttpExchange[] = [];
  const seen = new Set<string>();
  for (const id of action.requestIds) {
    const request = byId.get(id);
    if (request && !seen.has(id)) {
      ordered.push(request);
      seen.add(id);
    }
  }
  for (const request of run.requests)
    if (request.step === action.index && !seen.has(request.id)) {
      ordered.push(request);
      seen.add(request.id);
    }
  return ordered;
}

// ── La construction ────────────────────────────────────────────────────────────────────────

interface StepFacts {
  action: ActionEvidence;
  evidence: Evidence[];
  requests: HttpExchange[];
}

function evidenceOfStep(run: ReproductionRun, index: number): Evidence[] {
  return run.evidence.filter((item) => item.source.step === index);
}

/** Les preuves de l'action : l'étape elle-même d'abord, puis assertion, page, capture (ordre du run). */
function actionEvidence(items: readonly Evidence[]): string[] {
  const own = items.filter((item) => item.kind !== 'CONSOLE' && item.kind !== 'JS_ERROR');
  return [
    ...own.filter((item) => item.kind === 'ACTION'),
    ...own.filter((item) => item.kind !== 'ACTION'),
  ].map((item) => item.id);
}

export function buildFrontendTrace(input: {
  reproduction: ReproductionRun;
  code?: CodeIndex;
}): FrontendTrace {
  const run = input.reproduction;
  const code = input.code;
  const frontendApps = (code?.applications ?? []).filter((application) => application.layer === 'FRONTEND');
  const hasFrontendCode =
    code !== undefined &&
    (frontendApps.length > 0 || code.symbols.some((symbol) => symbol.layer === 'FRONTEND'));
  const ctx = code && hasFrontendCode ? codeContext(code) : undefined;
  const limitations: string[] = [];

  if (!code)
    limitations.push(
      "le code n'a pas été analysé : composants, handlers, services et clients HTTP du frontend restent inconnus (seules l'étape, sa cible et ses requêtes sont établies)",
    );
  else if (!hasFrontendCode)
    limitations.push(
      'aucune application FRONTEND dans le périmètre analysé : composants, handlers, services et clients HTTP du frontend restent inconnus',
    );
  else {
    limitations.push(
      'composants, handlers et services sont déduits du code (libellés des déclencheurs, appels lus) : ils ne sont pas observables sans instrumentation et ne constituent pas une trace d’exécution',
    );
    if (code.truncated.length > 0)
      limitations.push(
        `analyse du code partielle (${code.truncated.join(' ; ')}) : des liens peuvent manquer`,
      );
  }

  const facts: StepFacts[] = [...run.actions]
    .sort((a, b) => a.index - b.index)
    .map((action) => ({
      action,
      evidence: evidenceOfStep(run, action.index),
      requests: requestsOf(run, action),
    }));

  const withoutRequests: number[] = [];
  const steps: FrontendTraceStep[] = facts.map((fact, position) => {
    const { action, evidence, requests } = fact;
    const target = parseStepTarget(action.description);
    const actionIds = evidence.filter((item) => item.kind === 'ACTION').map((item) => item.id);
    const step: FrontendTraceStep = {
      index: action.index,
      action: {
        kind: action.kind,
        description: action.description,
        status: action.status,
        ...(action.url ? { url: action.url } : {}),
        ...(action.screenshot ? { screenshot: action.screenshot } : {}),
        evidence: actionEvidence(evidence),
      },
      services: [],
      httpClients: [],
      requests: requests.map((request) => ({
        requestId: request.id,
        method: request.method.toUpperCase(),
        path: request.path,
        ...(request.status !== undefined ? { status: request.status } : {}),
        correlation: request.correlation,
      })),
      console: evidence.filter((item) => item.kind === 'CONSOLE').map((item) => item.id),
      jsErrors: evidence.filter((item) => item.kind === 'JS_ERROR').map((item) => item.id),
    };

    const interactive = INTERACTIONS.has(action.kind);
    if (interactive && requests.length === 0) withoutRequests.push(action.index);

    // L'élément : la cible décrite par l'étape.
    if (interactive && target.strategy !== 'none') {
      const reached = action.status === 'PASSED';
      step.element = {
        label: targetLabel(target),
        status: reached ? 'OBSERVED' : 'UNKNOWN',
        reason: reached
          ? `cible de l'étape ${String(action.index)} telle que Playwright la décrit (${targetDetail(target)}) ; Playwright a agi sur cet élément. Aucun détail DOM (balise, attributs) n'est enregistré au-delà de cette description`
          : `cible décrite par l'étape ${String(action.index)} (${targetDetail(target)}) ; l'étape n'a pas abouti (${action.status}) : l'élément n'a peut-être pas été atteint`,
        evidence: actionIds,
      };
    }

    // Composant, handler, services, clients HTTP.
    let handler: CodeSymbol | undefined;
    let reached: Reached[] = [];
    if (interactive) {
      if (!ctx) {
        step.component = {
          label: '?',
          status: 'UNKNOWN',
          reason: code
            ? "le code frontend n'est pas dans le périmètre analysé : le composant ne peut pas être relié"
            : "le code n'a pas été analysé : le composant ne peut pas être relié",
          evidence: [],
        };
      } else {
        const chosen = chooseCandidate(ctx, target, action, requests, limitations);
        if (!chosen) {
          step.component = {
            label: '?',
            status: 'UNKNOWN',
            reason:
              target.name !== undefined
                ? `aucun déclencheur lu dans le code frontend ne porte le libellé ${quote(target.name)} (compatible avec « ${action.kind} »)`
                : target.strategy === 'none'
                  ? 'la description de l’étape ne nomme aucune cible et ne cite aucun libellé de déclencheur lu dans le code'
                  : `la cible (${targetDetail(target)}) n'a pas de nom accessible à rapprocher des libellés des déclencheurs`,
            evidence: [],
          };
          limitations.push(
            `étape ${String(action.index)} : aucun composant ni handler relié à la cible ${targetLabel(target)}`,
          );
        } else {
          handler = chosen.handler;
          const how =
            chosen.score === 3
              ? `le nom ${quote(target.name ?? '')} de la cible est identique au libellé du déclencheur ${chosen.trigger.raw}`
              : chosen.score === 2
                ? `le nom ${quote(target.name ?? '')} de la cible et le libellé du déclencheur ${chosen.trigger.raw} se recouvrent (correspondance partielle)`
                : `la description de l'étape cite ${quote(chosen.label)}, libellé du déclencheur ${chosen.trigger.raw} (pas de nom accessible écrit)`;
          const submit =
            chosen.trigger.tag === 'form' && chosen.trigger.prop === 'onSubmit'
              ? ' : bouton d’envoi du formulaire'
              : '';
          const component = chosen.component;
          step.component = component
            ? {
                label: component.name,
                status: 'INFERRED',
                reason: `${how}${submit} ; ${chosen.handler ? `le handler ${chosen.handler.name} est déclaré dans le composant ${component.name}` : `le composant ${component.name} déclare ce déclencheur`} (${at(component.file, component.line)}). Rapprochement lu dans le code, non observé`,
                evidence: [],
                symbolId: component.id,
                source: sourceOf(component),
              }
            : {
                label: '?',
                status: 'UNKNOWN',
                reason: `${how}, mais le handler ${chosen.handler?.name ?? ''} n'est déclaré dans aucun composant indexé`,
                evidence: [],
              };
          if (chosen.handler) {
            step.handler = {
              label: chosen.handler.name,
              status: 'INFERRED',
              reason: `${how}${submit} (${at(chosen.handler.file, chosen.handler.line)}). Déduit, non observable sans instrumentation`,
              evidence: [],
              symbolId: chosen.handler.id,
              source: sourceOf(chosen.handler),
            };
          } else {
            step.handler = {
              label: chosen.unresolved ?? '?',
              status: 'UNKNOWN',
              reason: `le composant ${component?.name ?? '?'} associe ${chosen.trigger.raw} à « ${chosen.unresolved ?? '?'} », qui n'est pas un symbole indexé : les fonctions appelées ne peuvent pas être lues`,
              evidence: [],
            };
          }
        }
      }
    }

    if (ctx && handler) {
      const walk = reachedFrom(ctx, handler);
      reached = walk.reached;
      step.services = reached.map(({ symbol, call, depth }) => ({
        label: symbol.name,
        status: call.status,
        reason: `${kindText(symbol.kind)} atteinte depuis ${ctx.byId.get(call.from)?.name ?? call.from} par l'appel « ${call.text} » (${at(call.file, call.line)}, ${depth === 1 ? 'appel direct' : `${String(depth)} appels depuis le handler`}) ; lu dans le code, pas une trace d'exécution`,
        evidence: [],
        symbolId: symbol.id,
        source: sourceOf(symbol),
      }));
      for (const call of walk.unresolved) {
        const from = ctx.byId.get(call.from);
        if (!from) continue;
        step.services.push({
          label: call.text,
          status: 'UNKNOWN',
          reason: `l'appel « ${call.text} » (${at(call.file, call.line)}) depuis ${from.name} ne mène à aucun symbole indexé`,
          evidence: [],
          symbolId: from.id,
          source: {
            applicationId: from.applicationId,
            layer: from.layer,
            file: call.file,
            line: call.line,
            symbolId: from.id,
          },
        });
      }
    }

    // Les clients HTTP qui correspondent aux requêtes de l'étape.
    if (ctx && requests.length > 0) {
      // Depuis le handler : les appels HTTP des fonctions atteintes ; sans handler : tout le frontend (INFERRED).
      const pool = handler
        ? [handler, ...reached.map((entry) => entry.symbol)].flatMap(
            (symbol) => ctx.outgoingOf.get(symbol.id) ?? [],
          )
        : ctx.frontendOutgoing;
      const matched = new Set<string>();
      for (const call of pool) {
        const hits = requests.filter((request) => outgoingMatches(call, request));
        if (hits.length === 0) continue;
        for (const hit of hits) matched.add(hit.id);
        const symbol = ctx.byId.get(call.symbolId);
        const literal = call.status === 'STATICALLY_RESOLVED' && call.method !== undefined;
        const status: RelationStatus = handler && literal ? 'STATICALLY_RESOLVED' : 'INFERRED';
        const written = `${call.method?.toUpperCase() ?? '(méthode non écrite)'} ${call.path ?? ''}`;
        const why = handler
          ? literal
            ? 'méthode et chemin littéraux'
            : call.status === 'STATICALLY_RESOLVED'
              ? 'méthode non écrite : seul le chemin correspond'
              : 'chemin reconstruit (base lue dans une constante)'
          : "aucun handler relié à l'étape : rapproché par méthode et chemin seulement, sans chemin d'appel lu";
        step.httpClients.push({
          label: `${written}${symbol ? ` (${symbol.name})` : ''}`,
          status,
          reason: `${at(call.file, call.line)}${symbol ? ` (${symbol.name})` : ''} envoie ${written} — ${why} ; correspond à ${hits.map((hit) => `la requête observée ${requestText(hit)}`).join(', ')} de l'étape ${String(action.index)}`,
          evidence: hits.map((hit) => hit.id),
          symbolId: call.symbolId,
          source: {
            applicationId: call.applicationId,
            layer: call.layer,
            file: call.file,
            line: call.line,
            symbolId: call.symbolId,
          },
        });
      }
      if (handler) {
        const unmatched = requests.filter(
          (request) => !matched.has(request.id) && ['xhr', 'fetch'].includes(request.resourceType),
        );
        if (unmatched.length > 0)
          limitations.push(
            `étape ${String(action.index)} : ${unmatched.map(requestText).join(', ')} n'est reliée à aucun client HTTP atteint depuis ${handler.name}`,
          );
      }
    }
    if (ctx && handler && requests.length === 0) {
      const emitted = [handler, ...reached.map((entry) => entry.symbol)].flatMap(
        (symbol) => ctx.outgoingOf.get(symbol.id) ?? [],
      );
      if (emitted.length > 0)
        limitations.push(
          `étape ${String(action.index)} : ${handler.name} peut envoyer ${emitted.map((call) => `${call.method ?? '?'} ${call.path ?? '?'}`).join(', ')} d'après le code, mais aucune requête n'a été observée à cette étape`,
        );
    }

    // L'erreur affichée : l'étape, ou les attentes qui la suivent, ont échoué.
    if (action.kind !== 'expect' || ownerless(facts, position)) {
      const failures = failuresAfter(facts, position);
      if (failures.length > 0) step.displayedError = displayedError(ctx, handler, reached, failures);
    }
    // Les maillons dans l'ordre de la chaîne (lecture du JSON stocké).
    const { element, component, handler: handlerLink, displayedError: shown, ...rest } = step;
    return {
      index: rest.index,
      action: rest.action,
      ...(element ? { element } : {}),
      ...(component ? { component } : {}),
      ...(handlerLink ? { handler: handlerLink } : {}),
      services: rest.services,
      httpClients: rest.httpClients,
      requests: rest.requests,
      ...(shown ? { displayedError: shown } : {}),
      console: rest.console,
      jsErrors: rest.jsErrors,
    };
  });

  if (withoutRequests.length > 0)
    limitations.push(
      `étape(s) ${withoutRequests.join(', ')} : aucune requête observée — aucun client HTTP ne peut leur être relié`,
    );

  return { reproduction: run.id, steps, limitations: [...new Set(limitations)] };
}

function kindText(kind: CodeSymbol['kind']): string {
  switch (kind) {
    case 'VALIDATION':
      return 'validation';
    case 'PAYLOAD_TRANSFORM':
      return 'transformation du payload';
    case 'HTTP_CLIENT_CALL':
      return 'fonction cliente HTTP';
    case 'EVENT_HANDLER':
      return 'handler';
    default:
      return 'fonction';
  }
}

function chooseCandidate(
  ctx: CodeContext,
  target: StepTarget,
  action: ActionEvidence,
  requests: readonly HttpExchange[],
  limitations: string[],
): Candidate | undefined {
  const compatible = COMPATIBLE_PROPS[action.kind];
  const accepts = (trigger: Trigger): boolean => !compatible || compatible.includes(trigger.prop);
  const candidates: Candidate[] = [];
  const emitsRequests = (handler: CodeSymbol): boolean => {
    if (requests.length === 0) return false;
    const emitters = [handler, ...reachedFrom(ctx, handler).reached.map((entry) => entry.symbol)];
    return emitters.some((symbol) =>
      (ctx.outgoingOf.get(symbol.id) ?? []).some((call) =>
        requests.some((request) => outgoingMatches(call, request)),
      ),
    );
  };
  for (const handler of ctx.handlers)
    for (const raw of list(handler, 'triggers')) {
      const trigger = parseTrigger(raw);
      if (!trigger || !accepts(trigger)) continue;
      for (const label of trigger.labels) {
        const score = scoreLabel(target, action.description, label);
        if (score === 0) continue;
        const component = componentOf(ctx, handler);
        candidates.push({
          handler,
          ...(component ? { component } : {}),
          trigger,
          label,
          score,
          matchesRequests: emitsRequests(handler),
        });
      }
    }
  // Un déclencheur dont le handler n'est pas un symbole (`<button onClick> « Enregistrer » → save`).
  for (const component of ctx.components)
    for (const entry of list(component, 'handlers')) {
      const [raw, expression] = entry.split(' → ');
      const trigger = raw ? parseTrigger(raw) : undefined;
      if (!trigger || !accepts(trigger)) continue;
      for (const label of trigger.labels) {
        const score = scoreLabel(target, action.description, label);
        if (score === 0) continue;
        candidates.push({
          component,
          unresolved: expression?.trim() ?? '?',
          trigger,
          label,
          score,
          matchesRequests: false,
        });
      }
    }
  if (candidates.length === 0) return undefined;
  const rank = (candidate: Candidate): number =>
    candidate.score * 4 + (candidate.matchesRequests ? 2 : 0) + (candidate.handler ? 1 : 0);
  const best = Math.max(...candidates.map(rank));
  const top = candidates
    .filter((candidate) => rank(candidate) === best)
    .sort((a, b) =>
      (a.handler?.id ?? a.component?.id ?? '').localeCompare(b.handler?.id ?? b.component?.id ?? ''),
    );
  const names = [...new Set(top.map((candidate) => candidate.handler?.name ?? candidate.unresolved ?? '?'))];
  if (names.length > 1)
    limitations.push(
      `étape ${String(action.index)} : plusieurs handlers correspondent à ${targetLabel(target)} (${names.join(', ')}) ; ${names[0] ?? ''} est retenu par ordre de déclaration, à vérifier`,
    );
  return top[0];
}

interface Failure {
  index: number;
  action: ActionEvidence;
  evidence: Evidence[];
}

/** L'étape elle-même si elle a échoué, puis les attentes (`expect`) qui la suivent immédiatement et ont échoué. */
function failuresAfter(facts: readonly StepFacts[], position: number): Failure[] {
  const failures: Failure[] = [];
  const own = facts[position];
  if (own && FAILED.has(own.action.status))
    failures.push({ index: own.action.index, action: own.action, evidence: own.evidence });
  if (own?.action.kind === 'expect') return failures;
  for (let next = position + 1; next < facts.length; next += 1) {
    const fact = facts[next];
    if (!fact || fact.action.kind !== 'expect') break;
    if (FAILED.has(fact.action.status))
      failures.push({ index: fact.action.index, action: fact.action, evidence: fact.evidence });
  }
  return failures;
}

/** Une attente sans étape d'action avant elle (en tête du scénario) porte elle-même l'erreur affichée. */
function ownerless(facts: readonly StepFacts[], position: number): boolean {
  for (let previous = position - 1; previous >= 0; previous -= 1)
    if (facts[previous]?.action.kind !== 'expect') return false;
  return true;
}

function displayedError(
  ctx: CodeContext | undefined,
  handler: CodeSymbol | undefined,
  reached: readonly Reached[],
  failures: readonly Failure[],
): TraceLink {
  const proofs = failures.flatMap((failure) =>
    failure.evidence.filter((item) => ['ASSERTION', 'SCREENSHOT', 'PAGE'].includes(item.kind)),
  );
  const evidence = proofs.map((item) => item.id);
  const where = failures
    .map(
      (failure) =>
        `étape ${String(failure.index)} (${failure.action.description} : ${failure.action.status})`,
    )
    .join(', ');
  const owners = handler ? [handler, ...reached.map((entry) => entry.symbol)] : [];
  const errorHandlers = ctx ? owners.flatMap((owner) => ctx.errorHandlers.get(owner.id) ?? []) : [];
  const chosen = errorHandlers[0];
  if (!ctx || !handler || !chosen)
    return {
      label: '?',
      status: 'UNKNOWN',
      reason: `échec observé à l'${where} ; ${
        !ctx
          ? "le code frontend n'est pas disponible"
          : !handler
            ? "aucun handler n'est relié à l'étape"
            : `aucun gestionnaire d'erreur (catch) n'est lu dans le code depuis ${handler.name}`
      } : le message affiché ne peut pas être rattaché au code. Le texte à l'écran n'a pas été capturé ; voir les preuves de l'échec`,
      evidence,
    };
  const messages = list(chosen, 'messages');
  const calls = list(chosen, 'calls');
  const throwers = owners.filter((owner) => list(owner, 'throws').length > 0);
  // Le texte n'est OBSERVED que si une preuve du run le contient.
  const haystack = [
    ...failures.flatMap((failure) => failure.evidence.map((item) => ({ id: item.id, text: item.summary }))),
    ...failures.map((failure) => ({ id: '', text: failure.action.reason ?? '' })),
  ];
  const seen = messages
    .filter((message) => fold(message).length >= 4)
    .flatMap((message) =>
      haystack
        .filter((entry) => fold(entry.text).includes(fold(message)))
        .map((entry) => ({ message, id: entry.id })),
    );
  const label =
    messages.length > 0
      ? messages.map(quote).join(' / ')
      : `${chosen.name}${calls.length > 0 ? ` → ${calls.join(', ')}` : ''}`;
  const code = `en cas d'échec, ${chosen.name} (${String(chosen.detail?.style ?? 'catch')}, ${at(chosen.file, chosen.line)}) ${calls.length > 0 ? `appelle ${calls.join(', ')}` : 'ne fait aucun appel lisible'}${messages.length > 0 ? ` ; texte(s) lu(s) dans le code : ${messages.map(quote).join(', ')}` : ''}${throwers.length > 0 ? ` ; ${throwers.map((owner) => `${owner.name} lève ${list(owner, 'throws').join(', ')}`).join(' ; ')} (son message peut être affiché)` : ''}${chosen.detail?.rethrows === true ? " ; l'erreur est relancée" : ''}`;
  if (seen.length > 0) {
    const first = seen[0];
    return {
      label: quote(first?.message ?? ''),
      status: 'OBSERVED',
      reason: `le texte ${quote(first?.message ?? '')} figure dans ${first?.id ? `la preuve ${first.id}` : `la raison de l'${where}`} ; son lien avec le gestionnaire d'erreur est déduit du code : ${code}`,
      evidence: [...new Set([...seen.map((entry) => entry.id).filter(Boolean), ...evidence])],
      symbolId: chosen.id,
      source: sourceOf(chosen),
    };
  }
  return {
    label,
    status: 'INFERRED',
    reason: `déduit du code : ${code}. Le texte réellement affiché n'a pas été capturé (non observable sans instrumentation) ; échec observé à l'${where}`,
    evidence,
    symbolId: chosen.id,
    source: sourceOf(chosen),
  };
}
