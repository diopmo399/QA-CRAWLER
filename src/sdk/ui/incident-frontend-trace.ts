import type {
  CodeSymbol,
  CodeSymbolKind,
  Evidence,
  FrontendTrace,
  FrontendTraceStep,
  HttpExchange,
  RelationStatus,
  ReproductionRun,
  TraceLink,
} from '../core/incident-contracts.js';
import { stepId, type SelectionKind } from './incident-links.js';
import {
  demoBanner,
  evidenceChips,
  panelState,
  relationBadge,
  relationLegend,
  selectable,
  selectionClass,
  sourceLink,
  type Lang,
  type WorkspaceContext,
} from './incident-parts.js';
import { esc } from './view.js';

/**
 * L'ONGLET « FRONTEND » DE L'ESPACE D'INVESTIGATION : la traçabilité détaillée de chaque étape de la
 * reproduction, de haut en bas — étape Playwright → action utilisateur → élément DOM → composant →
 * handler → services TypeScript → client HTTP → requête → réponse → erreur affichée. Chaque maillon est
 * une carte sélectionnable (étape, symbole, requête, preuve) avec son statut, le pourquoi, son lien vers
 * l'explorateur de code et ses preuves. Ce qui est déduit du code (composant, handler, services) est
 * marqué comme tel : jamais présenté comme observé.
 */

const P = 'ws-frontend-trace';

export interface FrontendTraceUi {
  /** L'étape mise au premier plan ; absente : l'étape en échec (ou la première). */
  step?: number;
  /** Restreindre la liste aux étapes en échec. */
  failingOnly: boolean;
}

export function emptyFrontendTraceUi(): FrontendTraceUi {
  return { failingOnly: false };
}

/** Le réducteur des actions `ws-frontend-trace-…` (pur ; undefined si l'action n'est pas la sienne). */
export function reduceFrontendTrace(
  ui: FrontendTraceUi,
  action: string,
  dataset: Record<string, string | undefined>,
): FrontendTraceUi | undefined {
  switch (action) {
    case `${P}-step`: {
      const index = Number(dataset.step);
      if (!Number.isInteger(index) || index < 1) return ui;
      return { ...ui, step: index };
    }
    case `${P}-failing`:
      return { ...ui, failingOnly: !ui.failingOnly };
    case `${P}-all`:
      return { ...ui, failingOnly: false };
    default:
      return undefined;
  }
}

const TEXT = {
  fr: {
    title: 'Traçabilité frontend',
    intro:
      'Pour chaque étape de la reproduction : ce que Playwright a fait et vu, puis ce que le code permet d’en déduire.',
    empty: 'La traçabilité frontend n’est pas encore construite.',
    emptyHint:
      'Lancez l’analyse du code depuis l’en-tête de l’incident : elle relie chaque étape au composant, au handler et aux requêtes.',
    noSteps: 'La reproduction ne compte aucune étape.',
    noFailing: 'Aucune étape en échec dans cette reproduction.',
    steps: 'Étapes de la reproduction',
    stepsCount: (shown: number, total: number) =>
      shown === total ? `${String(total)} étape(s)` : `${String(shown)} étape(s) sur ${String(total)}`,
    failingOnly: 'Restreindre aux étapes en échec',
    showAll: 'Afficher toutes les étapes',
    failing: 'en échec',
    step: (index: number) => `Étape ${String(index)}`,
    chain: (index: number) => `Traçabilité de l’étape ${String(index)}`,
    stages: {
      step: 'Étape Playwright',
      action: 'Action utilisateur',
      element: 'Élément DOM',
      component: 'Composant',
      handler: 'Handler',
      services: 'Services TypeScript',
      httpClients: 'Client HTTP',
      requests: 'Requête',
      responses: 'Réponse',
      displayedError: 'Erreur affichée',
    },
    why: 'Pourquoi',
    executed: (status: string) => `exécutée pendant la reproduction (${status})`,
    actionReason: 'l’action telle que Playwright l’a jouée et décrite',
    notApplicable: (kind: string) => `Sans objet pour une étape « ${kind} ».`,
    noElement: 'La description de l’étape ne nomme aucun élément.',
    noComponent: 'Aucun composant relié.',
    noHandler: 'Aucun handler relié.',
    noServices: 'Aucune fonction atteinte depuis le handler.',
    noClients: 'Aucun client HTTP relié aux requêtes de cette étape.',
    noRequests: 'Aucune requête observée pendant cette étape.',
    noError: 'Aucun échec à cette étape ni dans les attentes qui la suivent.',
    noResponse: 'Aucune réponse enregistrée.',
    requestBody: 'Corps de la requête (masqué)',
    responseBody: 'Extrait du corps de la réponse (masqué)',
    fullBody: 'Corps complet (masqué)',
    duration: (ms: number) => `${String(ms)} ms`,
    correlation: {
      OBSERVED: 'vue pendant la fenêtre de l’action de cette étape',
      STATICALLY_RESOLVED: 'reliée à cette étape',
      INFERRED: 'reliée à cette étape par l’horodatage seulement',
      UNKNOWN: 'aucun lien établi avec une étape',
    } as Record<RelationStatus, string>,
    deduced: 'déduit, non observable sans instrumentation',
    unknown: 'lien non établi',
    screenshot: 'Voir la capture d’écran',
    url: 'Page',
    console: 'Console',
    jsErrors: 'Erreurs JavaScript',
    limitations: 'Ce que la traçabilité ne peut pas établir',
    legendNote:
      'Observé : vu pendant la reproduction (étape, requêtes, réponses, preuves). Composant, handler et services sont lus ou déduits du code : ce n’est pas une trace d’exécution.',
    kinds: {
      VALIDATION: 'Validation',
      PAYLOAD_TRANSFORM: 'Transformation du payload',
      HTTP_CLIENT_CALL: 'Appel HTTP',
      FUNCTION: 'Fonction',
      EVENT_HANDLER: 'Handler',
      ERROR_HANDLER: 'Gestion d’erreur',
      COMPONENT: 'Composant',
    } as Partial<Record<CodeSymbolKind, string>>,
    statuses: {
      PASSED: 'réussie',
      FAILED: 'échouée',
      BLOCKED: 'bloquée',
      SKIPPED: 'ignorée',
      MANUAL: 'manuelle',
    } as Record<string, string>,
    noDetail: 'Cette étape n’existe pas dans la traçabilité.',
  },
  en: {
    title: 'Frontend traceability',
    intro:
      'For each step of the reproduction: what Playwright did and saw, then what the code lets us infer.',
    empty: 'The frontend traceability has not been built yet.',
    emptyHint:
      'Run the code analysis from the incident header: it links each step to the component, the handler and the requests.',
    noSteps: 'The reproduction has no step.',
    noFailing: 'No failing step in this reproduction.',
    steps: 'Reproduction steps',
    stepsCount: (shown: number, total: number) =>
      shown === total ? `${String(total)} step(s)` : `${String(shown)} of ${String(total)} step(s)`,
    failingOnly: 'Only failing steps',
    showAll: 'Show all steps',
    failing: 'failing',
    step: (index: number) => `Step ${String(index)}`,
    chain: (index: number) => `Traceability of step ${String(index)}`,
    stages: {
      step: 'Playwright step',
      action: 'User action',
      element: 'DOM element',
      component: 'Component',
      handler: 'Handler',
      services: 'TypeScript services',
      httpClients: 'HTTP client',
      requests: 'Request',
      responses: 'Response',
      displayedError: 'Displayed error',
    },
    why: 'Why',
    executed: (status: string) => `executed during the reproduction (${status})`,
    actionReason: 'the action as Playwright played and described it',
    notApplicable: (kind: string) => `Not applicable to a “${kind}” step.`,
    noElement: 'The step description names no element.',
    noComponent: 'No linked component.',
    noHandler: 'No linked handler.',
    noServices: 'No function reached from the handler.',
    noClients: 'No HTTP client linked to the requests of this step.',
    noRequests: 'No request observed during this step.',
    noError: 'No failure at this step nor in the expectations that follow it.',
    noResponse: 'No response recorded.',
    requestBody: 'Request body (masked)',
    responseBody: 'Response body excerpt (masked)',
    fullBody: 'Full body (masked)',
    duration: (ms: number) => `${String(ms)} ms`,
    correlation: {
      OBSERVED: 'seen during the action window of this step',
      STATICALLY_RESOLVED: 'linked to this step',
      INFERRED: 'linked to this step by its timestamp only',
      UNKNOWN: 'no link established with a step',
    } as Record<RelationStatus, string>,
    deduced: 'inferred, not observable without instrumentation',
    unknown: 'link not established',
    screenshot: 'View the screenshot',
    url: 'Page',
    console: 'Console',
    jsErrors: 'JavaScript errors',
    limitations: 'What the traceability cannot establish',
    legendNote:
      'Observed: seen during the reproduction (step, requests, responses, evidence). Component, handler and services are read or inferred from the code: this is not an execution trace.',
    kinds: {
      VALIDATION: 'Validation',
      PAYLOAD_TRANSFORM: 'Payload transform',
      HTTP_CLIENT_CALL: 'HTTP call',
      FUNCTION: 'Function',
      EVENT_HANDLER: 'Handler',
      ERROR_HANDLER: 'Error handling',
      COMPONENT: 'Component',
    } as Partial<Record<CodeSymbolKind, string>>,
    statuses: {
      PASSED: 'passed',
      FAILED: 'failed',
      BLOCKED: 'blocked',
      SKIPPED: 'skipped',
      MANUAL: 'manual',
    } as Record<string, string>,
    noDetail: 'This step is not in the traceability.',
  },
};

type Text = (typeof TEXT)['fr'];
const text = (lang: Lang): Text => TEXT[lang];

/** Le nombre de caractères du corps de réponse montré d'emblée. */
const EXCERPT = 400;

// ── Données ────────────────────────────────────────────────────────────────────────────────

function runOf(ctx: WorkspaceContext, trace: FrontendTrace): ReproductionRun | undefined {
  return ctx.incident.investigation.reproductions.find((run) => run.id === trace.reproduction);
}

function exchangeOf(ctx: WorkspaceContext, trace: FrontendTrace, id: string): HttpExchange | undefined {
  const own = runOf(ctx, trace)?.requests.find((request) => request.id === id);
  return (
    own ??
    ctx.incident.investigation.reproductions
      .flatMap((run) => run.requests)
      .find((request) => request.id === id)
  );
}

function evidenceOf(ctx: WorkspaceContext, trace: FrontendTrace, id: string): Evidence | undefined {
  return runOf(ctx, trace)?.evidence.find((item) => item.id === id);
}

function symbolOf(ctx: WorkspaceContext, id: string | undefined): CodeSymbol | undefined {
  if (!id) return undefined;
  return ctx.incident.investigation.code?.symbols.find((symbol) => symbol.id === id);
}

const FAILED_STATUSES = new Set(['FAILED', 'BLOCKED']);

/** Une étape en échec : échouée ou bloquée, requête en erreur, erreur affichée ou erreur JavaScript. */
export function isFailingStep(
  step: FrontendTraceStep,
  exchange?: (id: string) => HttpExchange | undefined,
): boolean {
  if (FAILED_STATUSES.has(step.action.status)) return true;
  if (step.displayedError) return true;
  if (step.jsErrors.length > 0) return true;
  return step.requests.some(
    (request) =>
      (request.status !== undefined && request.status >= 400) ||
      Boolean(exchange?.(request.requestId)?.failure),
  );
}

/** L'étape au premier plan par défaut : celle qui porte l'erreur affichée, sinon la première en échec. */
export function defaultFrontendStep(
  trace: FrontendTrace,
  exchange?: (id: string) => HttpExchange | undefined,
): number | undefined {
  return (
    trace.steps.find((step) => step.displayedError)?.index ??
    trace.steps.find((step) => FAILED_STATUSES.has(step.action.status))?.index ??
    trace.steps.find((step) => isFailingStep(step, exchange))?.index ??
    trace.steps[0]?.index
  );
}

// ── Pièces ─────────────────────────────────────────────────────────────────────────────────

function statusPill(lang: Lang, status: string): string {
  const tone = status === 'PASSED' ? 'ok' : FAILED_STATUSES.has(status) ? 'ko' : 'mu';
  return `<span class="pill ${tone}">${esc(text(lang).statuses[status] ?? status.toLowerCase())}</span>`;
}

function httpPill(status: number | undefined, failure: string | undefined): string {
  if (status === undefined) return `<span class="pill ko">${esc(failure ? 'ERR' : '—')}</span>`;
  const tone = status >= 500 ? 'ko' : status >= 400 ? 'warn' : 'ok';
  return `<span class="pill ${tone}">${esc(status)}</span>`;
}

/** La mention des maillons déduits ou inconnus, en plus du badge (le statut n'est pas porté que par la couleur). */
function caveat(lang: Lang, status: RelationStatus): string {
  const t = text(lang);
  if (status === 'INFERRED') return `<p class="${P}-caveat">${esc(t.deduced)}</p>`;
  if (status === 'UNKNOWN') return `<p class="${P}-caveat">${esc(t.unknown)}</p>`;
  return '';
}

function reasonOf(lang: Lang, reason: string): string {
  return reason
    ? `<p class="${P}-why"><span class="sr">${esc(text(lang).why)} : </span>${esc(reason)}</p>`
    : '';
}

interface Choice {
  kind: SelectionKind;
  id: string;
}

/** Ce que sélectionne un maillon : son symbole, sinon sa première preuve (requête ou preuve). */
function pickOf(ctx: WorkspaceContext, link: TraceLink): Choice | undefined {
  if (link.symbolId) return { kind: 'symbol', id: link.symbolId };
  const first = link.evidence[0];
  if (!first) return undefined;
  const isRequest = ctx.incident.investigation.reproductions.some((run) =>
    run.requests.some((request) => request.id === first),
  );
  return { kind: isRequest ? 'request' : 'evidence', id: first };
}

/** Le bouton principal d'une carte : sélectionnable quand il désigne quelque chose. */
function pickButton(ctx: WorkspaceContext, pick: Choice | undefined, label: string, extra = ''): string {
  if (!pick) return `<span class="${P}-label">${label}${extra}</span>`;
  return `<button type="button" class="${P}-pick" ${selectable(ctx, pick.kind, pick.id)}>${label}${extra}</button>`;
}

function card(
  ctx: WorkspaceContext,
  options: {
    status?: RelationStatus;
    pick?: Choice;
    label: string;
    body?: string;
    reason?: string;
    source?: TraceLink['source'];
    evidence?: readonly string[];
    tag?: string;
    muted?: boolean;
  },
): string {
  const state = options.pick ? selectionClass(ctx, options.pick.kind, options.pick.id) : '';
  const statusClass = options.status ? ` ${P}-s-${options.status.toLowerCase()}` : '';
  return `<div class="${P}-card${statusClass}${options.muted ? ` ${P}-muted` : ''}${state ? ` ${state}` : ''}">
<div class="${P}-card-h">${pickButton(ctx, options.pick, options.label, options.tag ? ` <small class="${P}-tag">${esc(options.tag)}</small>` : '')}${options.status ? relationBadge(ctx.lang, options.status) : ''}</div>
${options.body ?? ''}${options.status ? caveat(ctx.lang, options.status) : ''}${reasonOf(ctx.lang, options.reason ?? '')}${options.source || (options.evidence?.length ?? 0) > 0 ? `<div class="${P}-refs">${options.source ? sourceLink(ctx.lang, options.source) : ''}${evidenceChips(ctx, options.evidence ?? [])}</div>` : ''}
</div>`;
}

function emptyCard(message: string): string {
  return `<div class="${P}-card ${P}-muted"><p class="mu">${esc(message)}</p></div>`;
}

function linkCard(ctx: WorkspaceContext, link: TraceLink, tag?: string): string {
  const pick = pickOf(ctx, link);
  return card(ctx, {
    status: link.status,
    ...(pick ? { pick } : {}),
    label: `<span>${esc(link.label)}</span>`,
    reason: link.reason,
    ...(link.source ? { source: link.source } : {}),
    evidence: link.evidence,
    ...(tag ? { tag } : {}),
  });
}

function stage(name: string, content: string, index: number): string {
  return `<li class="${P}-stage"><span class="${P}-num" aria-hidden="true">${String(index)}</span><div class="${P}-stage-b"><h4 class="${P}-stage-t">${esc(name)}</h4>${content}</div></li>`;
}

// ── La chaîne d'une étape ──────────────────────────────────────────────────────────────────

function chain(
  ctx: WorkspaceContext,
  trace: FrontendTrace,
  step: FrontendTraceStep,
  compact: boolean,
): string {
  const t = text(ctx.lang);
  const s = t.stages;
  const id = stepId(trace.reproduction, step.index);
  const interactive = step.element !== undefined || step.component !== undefined;
  const screenshotEvidence = step.action.evidence
    .map((ref) => evidenceOf(ctx, trace, ref))
    .find((item) => item?.kind === 'SCREENSHOT');
  const actionEvidence = step.action.evidence.find((ref) => evidenceOf(ctx, trace, ref)?.kind === 'ACTION');

  const stages: string[] = [];
  // 1. Étape Playwright.
  stages.push(
    card(ctx, {
      status: 'OBSERVED',
      pick: { kind: 'step', id },
      label: `<span>${esc(t.step(step.index))}</span> <code>${esc(step.action.kind)}</code>`,
      body: `<p class="${P}-meta">${statusPill(ctx.lang, step.action.status)}${step.action.url ? ` <span class="mu">${esc(t.url)} :</span> <code>${esc(step.action.url)}</code>` : ''}</p>`,
      reason: t.executed(step.action.status),
      evidence: step.action.evidence,
    }),
  );
  // 2. Action utilisateur.
  stages.push(
    card(ctx, {
      status: 'OBSERVED',
      ...(actionEvidence ? { pick: { kind: 'evidence', id: actionEvidence } } : {}),
      label: `<span>${esc(step.action.description)}</span>`,
      body:
        step.action.screenshot && screenshotEvidence
          ? `<p class="${P}-meta"><button type="button" class="lnk ${selectionClass(ctx, 'evidence', screenshotEvidence.id)}" ${selectable(ctx, 'evidence', screenshotEvidence.id)}>${esc(t.screenshot)}</button> <code class="mu">${esc(step.action.screenshot)}</code></p>`
          : step.action.screenshot
            ? `<p class="${P}-meta"><code class="mu">${esc(step.action.screenshot)}</code></p>`
            : '',
      reason: t.actionReason,
    }),
  );
  // 3. Élément DOM.
  stages.push(
    step.element
      ? linkCard(ctx, step.element)
      : emptyCard(interactive ? t.noElement : t.notApplicable(step.action.kind)),
  );
  // 4. Composant, 5. Handler.
  stages.push(
    step.component
      ? linkCard(ctx, step.component, t.kinds.COMPONENT)
      : emptyCard(interactive ? t.noComponent : t.notApplicable(step.action.kind)),
  );
  stages.push(
    step.handler
      ? linkCard(ctx, step.handler)
      : emptyCard(interactive ? t.noHandler : t.notApplicable(step.action.kind)),
  );
  // 6. Services TypeScript.
  stages.push(
    step.services.length > 0
      ? `<ul class="${P}-list">${step.services
          .map((link) => {
            const kind = symbolOf(ctx, link.symbolId)?.kind;
            const tag = kind ? t.kinds[kind] : undefined;
            return `<li>${linkCard(ctx, link, tag)}</li>`;
          })
          .join('')}</ul>`
      : emptyCard(step.handler ? t.noServices : t.notApplicable(step.action.kind)),
  );
  // 7. Client HTTP.
  stages.push(
    step.httpClients.length > 0
      ? `<ul class="${P}-list">${step.httpClients.map((link) => `<li>${linkCard(ctx, link)}</li>`).join('')}</ul>`
      : emptyCard(t.noClients),
  );
  // 8. Requête, 9. Réponse.
  const exchanges = step.requests.map((request) => ({
    request,
    exchange: exchangeOf(ctx, trace, request.requestId),
  }));
  stages.push(
    exchanges.length > 0
      ? `<ul class="${P}-list">${exchanges
          .map(
            ({ request, exchange }) =>
              `<li>${card(ctx, {
                status: request.correlation,
                pick: { kind: 'request', id: request.requestId },
                label: `<code>${esc(request.method)}</code> <code>${esc(request.path)}</code>`,
                body: exchange?.requestBody
                  ? `<details class="${P}-body"><summary>${esc(t.requestBody)}</summary><pre>${esc(exchange.requestBody)}</pre></details>`
                  : '',
                reason: t.correlation[request.correlation],
              })}</li>`,
          )
          .join('')}</ul>`
      : emptyCard(t.noRequests),
  );
  stages.push(
    exchanges.length > 0
      ? `<ul class="${P}-list">${exchanges
          .map(({ request, exchange }) => {
            const observed = request.status !== undefined || Boolean(exchange?.failure);
            const body = exchange?.responseBody ?? '';
            const excerpt = body.length > EXCERPT ? `${body.slice(0, EXCERPT)}…` : body;
            return `<li>${card(ctx, {
              status: observed ? 'OBSERVED' : 'UNKNOWN',
              pick: { kind: 'request', id: request.requestId },
              label: `${httpPill(request.status, exchange?.failure)} <code>${esc(request.method)} ${esc(request.path)}</code>`,
              body: `${exchange?.durationMs !== undefined ? `<p class="${P}-meta mu">${esc(t.duration(exchange.durationMs))}</p>` : ''}${exchange?.failure ? `<p class="err">${esc(exchange.failure)}</p>` : ''}${
                body
                  ? `<p class="${P}-meta mu">${esc(t.responseBody)}</p><pre class="${P}-pre">${esc(excerpt)}</pre>${
                      body.length > EXCERPT && !compact
                        ? `<details class="${P}-body"><summary>${esc(t.fullBody)}</summary><pre>${esc(body)}</pre></details>`
                        : ''
                    }`
                  : observed
                    ? ''
                    : `<p class="mu">${esc(t.noResponse)}</p>`
              }`,
            })}</li>`;
          })
          .join('')}</ul>`
      : emptyCard(t.noRequests),
  );
  // 10. Erreur affichée.
  stages.push(step.displayedError ? linkCard(ctx, step.displayedError) : emptyCard(t.noError));

  const names = [
    s.step,
    s.action,
    s.element,
    s.component,
    s.handler,
    s.services,
    s.httpClients,
    s.requests,
    s.responses,
    s.displayedError,
  ];
  const extras = [
    step.console.length > 0
      ? `<p class="${P}-extra"><b>${esc(t.console)}</b> ${evidenceChips(ctx, step.console, 6)}</p>`
      : '',
    step.jsErrors.length > 0
      ? `<p class="${P}-extra"><b>${esc(t.jsErrors)}</b> ${evidenceChips(ctx, step.jsErrors, 6)}</p>`
      : '',
  ].join('');
  return `<ol class="${P}-chain${compact ? ` ${P}-compact` : ''}" aria-label="${esc(t.chain(step.index))}">${stages
    .map((content, index) => stage(names[index] ?? '', content, index + 1))
    .join('')}</ol>${extras}`;
}

// ── Rendus exportés ────────────────────────────────────────────────────────────────────────

/** L'onglet « Frontend » : sélecteur d'étapes, chaîne détaillée de l'étape au premier plan, légende, limites. */
export function renderFrontendTrace(ctx: WorkspaceContext, ui: FrontendTraceUi): string {
  const t = text(ctx.lang);
  const trace = ctx.incident.investigation.frontendTrace;
  const head = `<div class="${P}-head"><h3>${esc(t.title)}</h3><p class="mu">${esc(t.intro)}</p></div>`;
  if (!trace)
    return `<section class="${P}" aria-label="${esc(t.title)}">${demoBanner(ctx)}${head}${panelState(ctx.lang, 'empty', `${t.empty} ${t.emptyHint}`)}</section>`;
  if (trace.steps.length === 0)
    return `<section class="${P}" aria-label="${esc(t.title)}">${demoBanner(ctx)}${head}${panelState(ctx.lang, 'empty', t.noSteps)}${limitations(ctx, trace)}</section>`;

  const exchange = (id: string): HttpExchange | undefined => exchangeOf(ctx, trace, id);
  const failing = new Set(
    trace.steps.filter((step) => isFailingStep(step, exchange)).map((step) => step.index),
  );
  const visible = ui.failingOnly ? trace.steps.filter((step) => failing.has(step.index)) : trace.steps;
  const fallback = defaultFrontendStep(trace, exchange);
  const focus =
    visible.find((step) => step.index === ui.step) ??
    visible.find((step) => step.index === fallback) ??
    visible[0];

  const toggle = `<button type="button" class="btn small${ui.failingOnly ? ' primary' : ''}" data-action="${P}-failing" aria-pressed="${String(ui.failingOnly)}">${esc(t.failingOnly)}</button>`;
  const selector = `<nav class="${P}-steps" aria-label="${esc(t.steps)}">
<div class="${P}-steps-h"><span class="mu">${esc(t.stepsCount(visible.length, trace.steps.length))}</span>${toggle}</div>
${
  visible.length === 0
    ? `<p class="mu">${esc(t.noFailing)}</p><button type="button" class="lnk" data-action="${P}-all">${esc(t.showAll)}</button>`
    : `<ol>${visible
        .map((step) => {
          const key = stepId(trace.reproduction, step.index);
          const current = step.index === focus?.index;
          const isFailing = failing.has(step.index);
          return `<li><button type="button" class="${P}-step${current ? ' current' : ''}${isFailing ? ' failing' : ''} ${selectionClass(ctx, 'step', key)}" data-action="${P}-step" data-step="${String(step.index)}" aria-current="${current ? 'step' : 'false'}"><span class="${P}-step-n">${String(step.index)}</span><span class="${P}-step-d"><code>${esc(step.action.kind)}</code> ${esc(step.action.description)}</span>${isFailing ? `<span class="pill ko">${esc(t.failing)}</span>` : ''}</button></li>`;
        })
        .join('')}</ol>`
}
</nav>`;
  const detail = focus
    ? `<div class="${P}-detail"><h4 class="${P}-detail-t">${esc(t.chain(focus.index))}</h4>${chain(ctx, trace, focus, false)}</div>`
    : `<div class="${P}-detail">${panelState(ctx.lang, 'empty', t.noFailing)}</div>`;
  const legend = `<div class="${P}-legend">${relationLegend(ctx.lang)}<p class="mu">${esc(t.legendNote)}</p></div>`;
  return `<section class="${P}" aria-label="${esc(t.title)}">${demoBanner(ctx)}${head}${legend}<div class="${P}-body-grid">${selector}${detail}</div>${limitations(ctx, trace)}</section>`;
}

function limitations(ctx: WorkspaceContext, trace: FrontendTrace): string {
  if (trace.limitations.length === 0) return '';
  const t = text(ctx.lang);
  return `<div class="note warn ${P}-limits"><b>${esc(t.limitations)}</b><ul>${trace.limitations
    .map((entry) => `<li>${esc(entry)}</li>`)
    .join('')}</ul></div>`;
}

/** Le détail d'une étape pour le panneau latéral (chaîne compacte). */
export function renderFrontendStepDetail(ctx: WorkspaceContext, stepIndex: number): string {
  const t = text(ctx.lang);
  const trace = ctx.incident.investigation.frontendTrace;
  if (!trace) return panelState(ctx.lang, 'empty', `${t.empty} ${t.emptyHint}`);
  const step = trace.steps.find((entry) => entry.index === stepIndex);
  if (!step) return panelState(ctx.lang, 'empty', t.noDetail);
  return `<div class="${P}-side"><h4 class="${P}-detail-t">${esc(t.chain(step.index))}</h4>${chain(ctx, trace, step, true)}</div>`;
}

export const INCIDENT_FRONTEND_TRACE_CSS = `
.${P}{display:flex;flex-direction:column;gap:14px;min-width:0}
.${P}-head h3{margin:0 0 2px}
.${P}-head p{margin:0}
.${P}-legend{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:1px solid var(--qa-color-border);border-radius:10px;background:var(--qa-color-surface-2)}
.${P}-legend p{margin:0;font-size:13px}
.${P}-body-grid{display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start}
.${P}-steps{flex:1 1 220px;max-width:300px;min-width:0;display:flex;flex-direction:column;gap:8px}
.${P}-steps-h{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between}
.${P}-steps ol{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}
.${P}-step{display:flex;gap:8px;align-items:flex-start;width:100%;text-align:left;padding:6px 8px;border:1px solid var(--qa-color-border);border-radius:8px;background:var(--qa-color-surface);color:var(--qa-color-text);cursor:pointer}
.${P}-step:hover{border-color:var(--qa-color-border-strong)}
.${P}-step:focus-visible,.${P}-pick:focus-visible{outline:2px solid var(--qa-color-primary);outline-offset:2px}
.${P}-step.current{border-color:var(--qa-color-primary);background:color-mix(in srgb,var(--qa-color-primary) 8%,var(--qa-color-surface))}
.${P}-step.failing{border-left:3px solid var(--qa-color-danger)}
.${P}-step-n{flex:none;min-width:22px;height:22px;border-radius:999px;display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;background:var(--qa-color-surface-2);border:1px solid var(--qa-color-border)}
.${P}-step-d{flex:1;min-width:0;overflow-wrap:anywhere;font-size:13px}
.${P}-detail{flex:999 1 340px;min-width:0}
.${P}-detail-t{margin:0 0 8px;font-size:14px}
.${P}-chain{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.${P}-stage{position:relative;display:flex;gap:10px;padding-bottom:12px}
.${P}-stage:not(:last-child)::before{content:"";position:absolute;left:11px;top:24px;bottom:0;border-left:2px solid var(--qa-color-border)}
.${P}-num{flex:none;width:24px;height:24px;border-radius:999px;display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;color:var(--qa-color-primary);background:color-mix(in srgb,var(--qa-color-primary) 12%,var(--qa-color-surface));border:1px solid color-mix(in srgb,var(--qa-color-primary) 40%,transparent);z-index:1}
.${P}-stage-b{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px}
.${P}-stage-t{margin:2px 0 0;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--qa-color-muted)}
.${P}-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.${P}-card{display:flex;flex-direction:column;gap:4px;padding:8px 10px;border:1px solid var(--qa-color-border);border-left-width:3px;border-radius:8px;background:var(--qa-color-surface);min-width:0}
.${P}-s-observed{border-left-color:var(--qa-color-primary)}
.${P}-s-statically_resolved{border-left-color:var(--qa-color-success)}
.${P}-s-inferred{border-style:dashed;border-left-style:dashed;border-left-color:var(--qa-color-warning)}
.${P}-s-unknown{border-style:dotted;border-left-style:dotted;border-left-color:var(--qa-color-danger)}
.${P}-muted{background:var(--qa-color-surface-2);border-left-color:var(--qa-color-border)}
.${P}-muted p{margin:0;font-size:13px}
.${P}-card-h{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;justify-content:space-between}
.${P}-pick{flex:1 1 auto;min-width:0;text-align:left;padding:0;border:0;background:none;color:var(--qa-color-text);font-weight:600;cursor:pointer;overflow-wrap:anywhere}
.${P}-pick:hover{color:var(--qa-color-primary)}
.${P}-label{flex:1 1 auto;min-width:0;font-weight:600;overflow-wrap:anywhere}
.${P}-tag{font-weight:500;color:var(--qa-color-muted)}
.${P}-why{margin:0;font-size:13px;color:var(--qa-color-muted);overflow-wrap:anywhere}
.${P}-caveat{margin:0;font-size:12px;font-style:italic;color:color-mix(in srgb,var(--qa-color-warning) 70%,var(--qa-color-text))}
.${P}-s-unknown .${P}-caveat{color:color-mix(in srgb,var(--qa-color-danger) 70%,var(--qa-color-text))}
.${P}-meta{margin:0;display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:13px}
.${P}-refs{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.${P}-pre,.${P}-body pre{margin:0;padding:6px 8px;max-height:220px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font:12px var(--qa-font-family-mono);background:var(--qa-color-surface-2);border:1px solid var(--qa-color-border);border-radius:6px}
.${P}-body summary{cursor:pointer;font-size:13px}
.${P}-extra{margin:4px 0 0;display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:13px}
.${P}-limits ul{margin:4px 0 0;padding-left:18px}
.${P}-compact .${P}-stage{padding-bottom:8px}
.${P}-compact .${P}-card{padding:6px 8px}
@container (max-width:700px){.${P}-steps{max-width:none;flex-basis:100%}.${P}-detail{flex-basis:100%}}
`;
