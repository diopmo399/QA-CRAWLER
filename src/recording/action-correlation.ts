import type { RawRecordedEvent } from './model.js';
import { routeOf } from './semantic-recording.js';

/** Pourquoi une navigation reste une étape `goto` (jamais « inconnu »). */
export type GotoReason =
  'INITIAL_NAVIGATION' | 'DIRECT_URL_ENTRY' | 'EXTERNAL_NAVIGATION' | 'NO_CAUSAL_ACTION' | 'BACK_FORWARD';

export type CausalConfidence = 'VERY_HIGH' | 'HIGH' | 'MEDIUM' | 'LOW';

/** Ce que la corrélation a décidé pour une navigation observée. */
export interface NavigationDecision {
  navigationId: string;
  route: string;
  /** EFFECT : causée par une action humaine ; REDIRECT : suite d'une navigation (garde, 302) ; GOTO : une étape ; RELOAD : rien. */
  kind: 'EFFECT' | 'REDIRECT' | 'GOTO' | 'RELOAD';
  /** L'événement humain qui l'a causée (EFFECT), ou la navigation dont elle est la suite (REDIRECT). */
  causedBy?: string;
  score: number;
  confidence?: CausalConfidence;
  reasons: string[];
  gotoReason?: GotoReason;
  /** Une autre action récente était presque aussi probable. */
  ambiguous?: boolean;
}

/** Un déclencheur humain et ce qu'il a produit (navigation, chaîne de redirections, réseau). */
export interface RecordedActionGroup {
  id: string;
  triggerId: string;
  relatedEventIds: string[];
  effects: {
    navigation?: { routes: string[]; navigationIds: string[] };
    network: { method: string; path: string; status?: number }[];
  };
  causalConfidence: CausalConfidence;
  causalScore: number;
  correlationReasons: string[];
}

export interface CorrelationOptions {
  /** Fenêtre (ms) dans laquelle une action humaine peut avoir causé une navigation. */
  causalWindowMs: number;
  /** Une navigation qui suit une autre de si près est une redirection (garde de route, 302). */
  redirectWindowMs: number;
  /** Score minimal (0..1) pour rattacher une navigation à une action. */
  minScore: number;
  /** Un clic classé « bruit » (élément sans rôle) peut devenir le déclencheur d'une navigation. */
  promoteNoiseClicks: boolean;
  /** Le réseau de l'action (requête acceptée) compte comme preuve. */
  networkEvidence: boolean;
}

export interface CorrelationResult {
  groups: RecordedActionGroup[];
  navigations: NavigationDecision[];
  /** Clics « bruit » devenus déclencheurs (une tuile <div> qui navigue). */
  promoted: Set<string>;
  stats: { navigations: number; correlated: number; redirects: number; gotos: number; reloads: number };
}

/** Un envoi qui suit le clic sur son bouton de si près est le même geste. */
const SAME_GESTURE_MS = 1500;
const TRIGGER_TYPES = new Set(['click', 'submit', 'keydown', 'change', 'dialog']);
/** Saisies : une navigation qu'elles provoquent est rare (une liste qui charge une route) ; jamais préférées à un clic. */
const FIELD_CHANGE_WEIGHT = 0.6;

/**
 * ACTION CORRELATION ENGINE — « l'action humaine est la cause, la navigation est d'abord un
 * effet ». Avant la résolution sémantique, chaque navigation observée est rattachée, si
 * possible, à l'action humaine récente qui l'a causée (dans une fenêtre bornée, jamais la
 * session entière) : clic, envoi, Entrée, choix, confirmation.
 *
 * Le temps n'est qu'un signal parmi d'autres : href / routerLink de la cible égal à la
 * destination, envoi de formulaire, écriture acceptée par le serveur, dernière action avant
 * la navigation, élément de menu. Une navigation sans cause fiable reste une étape `goto`,
 * avec sa raison (première page, adresse tapée, autre site, aucune action corrélable).
 */
export function correlateActions(
  events: readonly RawRecordedEvent[],
  options: CorrelationOptions,
): CorrelationResult {
  const navigations: NavigationDecision[] = [];
  const groups = new Map<string, RecordedActionGroup>();
  const promoted = new Set<string>();
  const stats = { navigations: 0, correlated: 0, redirects: 0, gotos: 0, reloads: 0 };
  /** Les actions humaines récentes (tampon borné par la fenêtre causale). */
  let recent: RawRecordedEvent[] = [];
  /** Les déclencheurs déjà à l'origine d'une navigation (une action, une navigation et ses redirections). */
  const used = new Set<string>();
  let previousNavigation: { event: RawRecordedEvent; decision: NavigationDecision } | undefined;
  let currentUrl: string | undefined;
  let startOrigin: string | undefined;

  // Un clic sur un bouton d'envoi et l'envoi de son formulaire : un seul geste (le clic), dont l'envoi apporte le réseau.
  const companions = new Map<string, RawRecordedEvent>();
  let lastClick: RawRecordedEvent | undefined;
  for (const event of events) {
    if (event.type === 'click' && !event.noise) lastClick = event;
    else if (event.type === 'submit' && lastClick && event.at - lastClick.at <= SAME_GESTURE_MS)
      companions.set(lastClick.id, event);
  }
  const absorbed = new Set([...companions.values()].map((event) => event.id));
  for (const event of events) {
    if (event.type !== 'navigation') {
      if (isTrigger(event, options) && !absorbed.has(event.id)) recent.push(event);
      recent = recent.filter((candidate) => event.at - candidate.at <= options.causalWindowMs);
      continue;
    }
    stats.navigations += 1;
    const route = routeOf(event.url);
    const decision: NavigationDecision = {
      navigationId: event.id,
      route,
      kind: 'GOTO',
      score: 0,
      reasons: [],
    };
    const origin = originOf(event.url);
    if (previousNavigation === undefined) {
      startOrigin = origin;
      Object.assign(decision, {
        gotoReason: 'INITIAL_NAVIGATION',
        reasons: ['first page of the session: startAt'],
      });
    } else if (currentUrl !== undefined && currentUrl === event.url) {
      Object.assign(decision, { kind: 'RELOAD', reasons: ['same page again'] });
      stats.reloads += 1;
    } else if (event.transition && /typed|address_bar|keyword|auto_bookmark/.test(event.transition)) {
      Object.assign(decision, {
        gotoReason: 'DIRECT_URL_ENTRY',
        reasons: [`address typed in the address bar (${event.transition})`],
      });
    } else if (event.transition?.includes('forward_back')) {
      Object.assign(decision, { gotoReason: 'BACK_FORWARD', reasons: ['browser back / forward button'] });
    } else {
      const since = previousNavigation.event.at;
      const triggersSince = recent.filter((candidate) => candidate.at > since);
      const redirect =
        event.at - previousNavigation.event.at <= options.redirectWindowMs &&
        previousNavigation.decision.kind !== 'RELOAD' &&
        triggersSince.length === 0;
      if (redirect) {
        const root =
          previousNavigation.decision.kind === 'REDIRECT'
            ? previousNavigation.decision.causedBy
            : previousNavigation.event.id;
        Object.assign(decision, {
          kind: 'REDIRECT',
          causedBy: root,
          score: previousNavigation.decision.score,
          reasons: [
            `follows ${routeOf(previousNavigation.event.url)} after ${String(event.at - previousNavigation.event.at)} ms with no human action in between: redirect`,
          ],
        });
        stats.redirects += 1;
        const group = [...groups.values()].find((candidate) =>
          candidate.effects.navigation?.navigationIds.includes(root ?? ''),
        );
        if (group?.effects.navigation) {
          group.effects.navigation.routes.push(route);
          group.effects.navigation.navigationIds.push(event.id);
          group.relatedEventIds.push(event.id);
        }
      } else {
        const ranked = recent
          .filter((candidate) => !used.has(candidate.id) && candidate.at <= event.at + 50)
          .map((candidate) => ({
            candidate,
            ...score(candidate, event, recent, options, companions.get(candidate.id)),
          }))
          .filter((entry) => entry.score > 0)
          .sort((a, b) => b.score - a.score);
        const best = ranked[0];
        if (best && best.score >= options.minScore) {
          const confidence = confidenceOf(best.score);
          Object.assign(decision, {
            kind: 'EFFECT',
            causedBy: best.candidate.id,
            score: round(best.score),
            confidence,
            reasons: best.reasons,
            ...(ranked[1] && best.score - ranked[1].score < 0.1 ? { ambiguous: true } : {}),
          });
          if (best.candidate.noise) promoted.add(best.candidate.id);
          used.add(best.candidate.id);
          stats.correlated += 1;
          groups.set(best.candidate.id, {
            id: `g${String(groups.size + 1)}`,
            triggerId: best.candidate.id,
            relatedEventIds: [event.id],
            effects: {
              navigation: { routes: [route], navigationIds: [event.id] },
              network: [
                ...(best.candidate.network ?? []),
                ...(companions.get(best.candidate.id)?.network ?? []),
              ].map((exchange) => ({
                method: exchange.method,
                path: exchange.path,
                ...(exchange.status !== undefined ? { status: exchange.status } : {}),
              })),
            },
            causalConfidence: confidence,
            causalScore: round(best.score),
            correlationReasons: best.reasons,
          });
        } else {
          const external = startOrigin !== undefined && origin !== startOrigin;
          Object.assign(decision, {
            gotoReason: external ? 'EXTERNAL_NAVIGATION' : 'NO_CAUSAL_ACTION',
            reasons: [
              external
                ? `another site (${origin}) with no correlated action`
                : recent.length === 0
                  ? `no human action in the last ${String(options.causalWindowMs)} ms`
                  : `recent actions too weakly related (best score ${String(round(best?.score ?? 0))} < ${String(options.minScore)})`,
            ],
          });
        }
      }
    }
    if (decision.kind === 'GOTO') stats.gotos += 1;
    navigations.push(decision);
    if (decision.kind !== 'RELOAD') previousNavigation = { event, decision };
    currentUrl = event.url;
  }
  return { groups: [...groups.values()], navigations, promoted, stats };
}

/** Un geste humain qui peut causer quelque chose (pas un clic de focus dans un champ, pas une saisie en cours). */
function isTrigger(event: RawRecordedEvent, options: CorrelationOptions): boolean {
  if (!TRIGGER_TYPES.has(event.type)) return false;
  if (event.type === 'keydown') return event.key === 'Enter';
  if (event.type === 'dialog') return event.dialog?.accepted === true;
  if (event.type === 'click' && event.noise)
    return options.promoteNoiseClicks && /non-interactive/.test(event.noise);
  return true;
}

function score(
  candidate: RawRecordedEvent,
  navigation: RawRecordedEvent,
  recent: readonly RawRecordedEvent[],
  options: CorrelationOptions,
  /** L'envoi de formulaire déclenché par ce clic (même geste). */
  companion?: RawRecordedEvent,
): { score: number; reasons: string[] } {
  const network = [...(candidate.network ?? []), ...(companion?.network ?? [])];
  const reasons: string[] = [];
  const delay = Math.max(0, navigation.at - candidate.at);
  // La proximité : un signal, jamais une preuve à elle seule.
  let value = 0.45 * (1 - Math.min(1, delay / options.causalWindowMs));
  reasons.push(
    `${candidate.type} "${candidate.element?.name ?? candidate.key ?? ''}" ${String(delay)} ms before`,
  );
  const destination = pathOf(navigation.url);
  const href = candidate.element?.href;
  if (href && pathOf(href) === destination) {
    value += 0.45;
    reasons.push(`the target links to ${destination}`);
  }
  const later = recent.filter(
    (other) => other.at > candidate.at && other.at <= navigation.at && isMeaningful(other),
  );
  if (later.length === 0) {
    value += 0.25;
    reasons.push('last human action before the navigation');
  } else value -= 0.15 * later.length;
  if (candidate.type === 'submit' || candidate.element?.isSubmit || companion) {
    value += 0.15;
    reasons.push('submits a form');
  }
  if (options.networkEvidence) {
    const writes = network.filter(
      (exchange) =>
        !['GET', 'HEAD', 'OPTIONS'].includes(exchange.method) &&
        (exchange.status ?? 0) >= 200 &&
        (exchange.status ?? 0) < 400,
    );
    if (writes[0]) {
      value += 0.2;
      reasons.push(
        `${writes[0].method} ${writes[0].path} → ${String(writes[0].status)} before the navigation`,
      );
    } else if (network.length > 0) {
      value += 0.05;
      reasons.push('requests sent by the action');
    }
  }
  if (
    candidate.element?.inNavigation ||
    ['link', 'tab', 'menuitem'].includes(candidate.element?.role ?? '')
  ) {
    value += 0.1;
    reasons.push('menu, tab or link');
  }
  if (candidate.noise) {
    value -= 0.1;
    reasons.push('element without a role (click handler): promoted');
  }
  if (candidate.type === 'change') value *= FIELD_CHANGE_WEIGHT;
  return { score: Math.max(0, Math.min(1, value)), reasons };
}

function isMeaningful(event: RawRecordedEvent): boolean {
  return event.type === 'click' ? !event.noise : event.type !== 'keydown' || event.key === 'Enter';
}

function confidenceOf(value: number): CausalConfidence {
  if (value >= 0.9) return 'VERY_HIGH';
  if (value >= 0.7) return 'HIGH';
  if (value >= 0.5) return 'MEDIUM';
  return 'LOW';
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function pathOf(url: string): string {
  try {
    const parsed = new URL(url, 'http://local.invalid');
    return parsed.hash.startsWith('#/')
      ? (parsed.hash.slice(1).split('?')[0] ?? '/')
      : parsed.pathname.replace(/\/+$/, '') || '/';
  } catch {
    return url;
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}
