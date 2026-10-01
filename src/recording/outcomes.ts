import type { FlowExpectation } from '../config/flow-schema.js';
import { apiTemplate, intentOf } from '../functional/runtime-learning.js';
import type {
  AssertionCandidate,
  RecordedIntent,
  RecordedState,
  RecordingWarning,
  SemanticRecordedAction,
} from './model.js';
import { isWrite } from './normalizer.js';
import { readable } from './recorded-target.js';
import { routeOf } from './semantic-recording.js';

export interface InferredOutcomes {
  assertions: AssertionCandidate[];
  intent: RecordedIntent;
  warnings: RecordingWarning[];
}

/**
 * OUTCOME INFERENCE + ASSERTION CANDIDATES : ce que chaque action a produit (requête
 * acceptée, nouvelle page, message, état métier, ligne en plus, téléchargement) et les
 * vérifications qu'on peut en tirer, chacune avec sa stabilité :
 *   STABLE         rejouable telle quelle (requête POST /api/users 2xx, route /users)
 *   LIKELY_STABLE  probablement (titre de page, message court sans donnée saisie)
 *   FRAGILE        dépend des données ou du moment (toast, texte avec un nom, un nombre)
 * Seules les vérifications stables (et celles qu'un point de contrôle demande) entrent
 * dans le flow ; les autres restent dans le rapport, pour revue.
 */
export function inferOutcomes(
  kept: readonly SemanticRecordedAction[],
  states: readonly RecordedState[],
  negative: boolean,
): InferredOutcomes {
  const stateById = new Map(states.map((state) => [state.id, state]));
  const assertions: AssertionCandidate[] = [];
  const warnings: RecordingWarning[] = [];
  const intent: RecordedIntent = { transitions: [], confidence: 0, evidence: [] };
  const lastState = new Map<string, string>();
  const rowsByRoute = new Map<string, number>();
  for (const state of states.slice(0, 1))
    if (state.tableRows !== undefined) rowsByRoute.set(state.route, state.tableRows);

  const add = (candidate: Omit<AssertionCandidate, 'id'>): void => {
    const key = JSON.stringify(candidate.expect ?? candidate.description);
    if (
      assertions.some(
        (existing) =>
          existing.afterActionId === candidate.afterActionId &&
          JSON.stringify(existing.expect ?? existing.description) === key,
      )
    )
      return;
    assertions.push({ ...candidate, id: `c${String(assertions.length + 1)}` });
  };

  for (const [index, action] of kept.entries()) {
    const before = action.stateBefore ? stateById.get(action.stateBefore) : undefined;
    const after = action.stateAfter ? stateById.get(action.stateAfter) : undefined;
    const isLast = index === kept.length - 1;
    let wrote = false;
    for (const exchange of action.network) {
      const template = apiTemplate(exchange.path);
      const status = exchange.status;
      if (!isWrite(exchange.method) || status === undefined) continue;
      const accepted = status >= 200 && status < 300;
      const url = template.replace(/\{param\}/g, '*');
      if (accepted) {
        wrote = true;
        add({
          kind: 'API_OUTCOME',
          description: `${exchange.method} ${template} is accepted (${String(status)})`,
          expect: { response: { method: exchange.method, url, status: '2xx' } },
          stability: 'STABLE',
          confidence: 0.95,
          afterActionId: action.id,
          provenance: 'INFERRED_OUTCOME',
          evidence: [
            `observed ${exchange.method} ${template} → ${String(status)} after "${action.target?.label ?? action.type}"`,
          ],
          selected: true,
          reason: 'the write the human triggered, accepted by the server',
        });
        const found = intentOf(exchange.method, template, action.target?.label ?? '');
        if (found && !intent.workflow) {
          intent.workflow = `${found.verb}:${found.entity}`;
          intent.entity = found.entity;
          intent.api = `${exchange.method} ${template}`;
          intent.confidence = 0.8;
          intent.evidence.push(
            `${exchange.method} ${template} → ${String(status)} after "${action.target?.label ?? action.type}"`,
          );
        }
        const entity = found?.entity;
        const code = exchange.responseState ?? exchange.requestState;
        if (entity && code) {
          const previous = lastState.get(entity);
          if (previous && previous !== code.code)
            intent.transitions.push({ entity, from: previous, to: code.code });
          lastState.set(entity, code.code);
          add({
            kind: 'BUSINESS_STATE',
            description: `${entity} is ${code.code} (${code.field})`,
            stability: 'LIKELY_STABLE',
            confidence: 0.7,
            afterActionId: action.id,
            provenance: 'INFERRED_OUTCOME',
            evidence: [`${code.field}: ${code.code} in ${exchange.method} ${template}`],
            selected: false,
            reason: 'a business state read in the response: not visible as such on the screen',
          });
        }
      } else if (status >= 400 && status < 500) {
        add({
          kind: 'API_OUTCOME',
          description: `${exchange.method} ${template} is refused (${String(status)}${exchange.errorCode ? `, ${exchange.errorCode}` : ''})`,
          expect: { response: { method: exchange.method, url, status: '4xx' } },
          stability: 'STABLE',
          confidence: 0.85,
          afterActionId: action.id,
          provenance: 'INFERRED_OUTCOME',
          evidence: [`observed ${exchange.method} ${template} → ${String(status)}`],
          selected: negative,
          reason: negative
            ? 'the refusal the human showed on purpose'
            : 'a refused attempt (not kept: no checkpoint on it)',
        });
      }
    }
    // Lectures : l'état métier lu (GET) devient l'état de départ des transitions.
    for (const exchange of action.network)
      if (!isWrite(exchange.method) && exchange.responseState) {
        const found = intentOf('GET', apiTemplate(exchange.path), '');
        if (found) lastState.set(found.entity, exchange.responseState.code);
      }

    // Nouvelle page.
    // La page avant : l'adresse au moment du geste (dans la page), et l'écran observé sur cette page.
    const beforeRoute = action.url ? routeOf(action.url) : before?.route;
    const origin = beforeRoute !== undefined ? (screenOn(states, beforeRoute) ?? before) : before;
    const wanted = wrote || isLast || action.checkpoint !== undefined;
    if (after && beforeRoute !== undefined && stableRoute(after.route) !== stableRoute(beforeRoute)) {
      const route = stableRoute(after.route);
      // « l'URL contient /users » est vrai aussi sur /users/new : il ne prouve rien.
      const discriminating = !beforeRoute.includes(route);
      add({
        kind: 'ROUTE',
        description: `the page ${route} is displayed`,
        expect: { url: route },
        stability: 'STABLE',
        confidence: discriminating ? 0.85 : 0.4,
        afterActionId: action.id,
        provenance: 'INFERRED_OUTCOME',
        evidence: [`${beforeRoute} → ${after.route}`],
        selected: wanted && discriminating,
        reason: !discriminating
          ? `not discriminating: ${beforeRoute} also contains ${route}`
          : wanted
            ? 'where the application leads'
            : 'an intermediate page (the next steps already prove it)',
      });
      const control = newControl(after, origin);
      if (control && (!discriminating || action.checkpoint !== undefined))
        add({
          kind: 'ROUTE',
          description: `the ${control.role} "${control.name}" of ${route} is displayed`,
          expect: { visible: { strategy: 'role', role: control.role, name: control.name } },
          stability: 'LIKELY_STABLE',
          confidence: 0.75,
          afterActionId: action.id,
          provenance: action.checkpoint !== undefined ? 'MANUAL_CHECKPOINT' : 'INFERRED_OUTCOME',
          evidence: [`visible on ${after.route}, not on ${beforeRoute}`],
          selected: wanted,
          reason: 'a control that only the new page shows',
        });
      else if (!discriminating || action.checkpoint !== undefined) {
        // Ni l'URL ni un bouton ne distinguent la nouvelle page : son titre, s'il n'apparaissait pas avant.
        const known = new Set((origin?.headings ?? []).map((text) => text.toLowerCase()));
        const heading = after.headings.find(
          (text) => readable(text) && !/\d/.test(text) && !known.has(text.toLowerCase()),
        );
        if (heading)
          add({
            kind: 'ROUTE',
            description: `the page "${heading}" (${route}) is displayed`,
            expect: { text: heading },
            stability: 'LIKELY_STABLE',
            confidence: 0.7,
            afterActionId: action.id,
            provenance: 'INFERRED_OUTCOME',
            evidence: [`heading of ${after.route}, not on ${beforeRoute}`],
            selected: wanted,
            reason: 'the title of the page the action leads to',
          });
      }
    }
    // Messages apparus.
    if (after) {
      const fresh = after.alerts.filter((alert) => !(before?.alerts ?? []).includes(alert));
      for (const alert of fresh.slice(0, 2)) {
        const fragile = /\d|@/.test(alert) || alert.length > 60 || !readable(alert);
        const refused = action.network.some(
          (exchange) => isWrite(exchange.method) && (exchange.status ?? 0) >= 400,
        );
        const error = refused || after.invalidFields > 0;
        add({
          kind: 'MESSAGE',
          description: `message "${alert}"`,
          expect: { text: alert },
          stability: fragile ? 'FRAGILE' : 'LIKELY_STABLE',
          confidence: fragile ? 0.4 : 0.65,
          afterActionId: action.id,
          provenance: 'INFERRED_OUTCOME',
          evidence: [`appeared after "${action.target?.label ?? action.type}"`],
          selected: negative && error && !fragile,
          reason: fragile
            ? 'contains data (number, address, long text): depends on the values'
            : negative && error
              ? 'the validation message the human showed on purpose'
              : 'a message that may be transient (toast): kept for review',
        });
      }
      if (negative && after.invalidFields > 0 && isSubmitLike(action))
        add({
          kind: 'FIELD_STATE',
          description: `${String(after.invalidFields)} field(s) marked invalid`,
          stability: 'LIKELY_STABLE',
          confidence: 0.7,
          afterActionId: action.id,
          provenance: 'INFERRED_OUTCOME',
          evidence: ['aria-invalid / framework invalid state after submitting'],
          selected: false,
          reason: 'invalid fields are reported by the run (form report), not as a flow step',
        });
      // Une ligne de plus dans la liste : l'entité créée est là.
      if (after.tableRows !== undefined) {
        const earlier = rowsByRoute.get(after.route);
        if (wrote || (earlier !== undefined && after.tableRows > earlier)) {
          if (earlier !== undefined && after.tableRows > earlier)
            add({
              kind: 'ENTITY_EXISTS',
              description: `the list ${after.route} shows ${String(after.tableRows - earlier)} more row(s)`,
              stability: 'LIKELY_STABLE',
              confidence: 0.6,
              afterActionId: action.id,
              provenance: 'INFERRED_OUTCOME',
              evidence: [`${String(earlier)} → ${String(after.tableRows)} rows`],
              selected: false,
              reason: 'row counts depend on the data already there',
            });
        }
        rowsByRoute.set(after.route, after.tableRows);
      }
    }
    for (const effect of action.sideEffects ?? [])
      add({
        kind: 'SIDE_EFFECT',
        description: effect,
        stability: 'LIKELY_STABLE',
        confidence: 0.6,
        afterActionId: action.id,
        provenance: 'INFERRED_OUTCOME',
        evidence: [`after "${action.target?.label ?? action.type}"`],
        selected: false,
        reason: 'outside the page: shown in the report',
      });

    // Point de contrôle : ce que l'humain a demandé de vérifier ici.
    if (action.checkpoint !== undefined && after) {
      add({
        kind: 'ROUTE',
        description: `checkpoint "${action.checkpoint}": page ${stableRoute(after.route)}`,
        expect: { url: stableRoute(after.route) },
        stability: 'STABLE',
        confidence: 0.9,
        afterActionId: action.id,
        provenance: 'MANUAL_CHECKPOINT',
        evidence: [`checkpoint "${action.checkpoint}" on ${after.route}`],
        selected: true,
        reason: 'asked by the human (checkpoint)',
      });
      // Un titre qui se lit aussi ailleurs (lien du menu, page d'avant) ne prouve rien.
      const elsewhere = new Set([
        ...after.controls.map((control) => control.split(':').slice(1).join(':').toLowerCase()),
        ...(origin?.headings ?? []).map((text) => text.toLowerCase()),
      ]);
      const heading = after.headings.find(
        (text) => readable(text) && !/\d/.test(text) && !elsewhere.has(text.toLowerCase()),
      );
      if (heading)
        add({
          kind: 'MESSAGE',
          description: `checkpoint "${action.checkpoint}": heading "${heading}"`,
          expect: { text: heading },
          stability: 'LIKELY_STABLE',
          confidence: 0.75,
          afterActionId: action.id,
          provenance: 'MANUAL_CHECKPOINT',
          evidence: [`heading of ${after.route}`],
          selected: true,
          reason: 'asked by the human (checkpoint): the page title',
        });
      for (const alert of after.alerts.slice(0, 2)) {
        const fragile = /\d|@/.test(alert) || alert.length > 60 || !readable(alert);
        add({
          kind: 'MESSAGE',
          description: `checkpoint "${action.checkpoint}": message "${alert}"`,
          expect: { text: alert },
          stability: fragile ? 'FRAGILE' : 'LIKELY_STABLE',
          confidence: fragile ? 0.45 : 0.75,
          afterActionId: action.id,
          provenance: 'MANUAL_CHECKPOINT',
          evidence: [`visible at the checkpoint on ${after.route}`],
          selected: !fragile,
          reason: fragile ? 'contains data: kept for review' : 'asked by the human (checkpoint)',
        });
      }
    }
  }
  if (!assertions.some((candidate) => candidate.selected))
    warnings.push({
      code: 'NO_OUTCOME_OBSERVED',
      message:
        'no stable outcome was observed (no accepted write, no new page): add a checkpoint where the result shows',
    });
  return { assertions, intent, warnings };
}

function isSubmitLike(action: SemanticRecordedAction): boolean {
  return action.type === 'SUBMIT' || (action.type === 'CLICK' && action.classification === 'MUTATION');
}

/** Le dernier écran observé sur cette route. */
function screenOn(states: readonly RecordedState[], route: string): RecordedState | undefined {
  const wanted = stableRoute(route);
  return [...states].reverse().find((state) => stableRoute(state.route) === wanted);
}

const VISIBLE_ROLES = ['button', 'link', 'tab', 'menuitem'];

/** Un bouton / lien que la nouvelle page montre et que la précédente ne montrait pas. */
function newControl(
  after: RecordedState,
  before: RecordedState | undefined,
): { role: string; name: string } | undefined {
  const known = new Set(before?.controls ?? []);
  for (const control of after.controls) {
    if (known.has(control)) continue;
    const [role = '', ...rest] = control.split(':');
    const name = rest.join(':');
    if (VISIBLE_ROLES.includes(role) && readable(name) && !/\d/.test(name)) return { role, name };
  }
  return undefined;
}

/** /users/12/edit → /users/ : la partie de la route qui ne dépend pas des données. */
export function stableRoute(route: string): string {
  // Une application à routes dans le fragment (#/users) : la route est dans le fragment.
  const hash = route.indexOf('#/');
  const path =
    hash >= 0 ? (route.slice(hash + 1).split('?')[0] ?? '/') : (route.split(/[?#]/)[0] ?? route) || '/';
  // Une route déjà normalisée par le StateDetector (/demandes/:id) a ses paramètres en « :nom ».
  const template = apiTemplate(path).replace(/\/:[^/]+/g, '/{param}');
  const cut = template.indexOf('{param}');
  return cut >= 0 ? template.slice(0, cut) || '/' : template;
}

/** Les vérifications retenues pour une action, dans l'ordre. */
export function selectedExpectations(
  assertions: readonly AssertionCandidate[],
  actionId: string,
): { candidate: AssertionCandidate; expect: FlowExpectation }[] {
  return assertions.flatMap((candidate) =>
    candidate.afterActionId === actionId && candidate.selected && candidate.expect
      ? [{ candidate, expect: candidate.expect }]
      : [],
  );
}
