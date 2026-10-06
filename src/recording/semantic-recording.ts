import type { SafetyPolicy } from '../policies/safety-policy.js';
import type {
  RawRecordedEvent,
  RecordedElement,
  RecordingWarning,
  SemanticActionType,
  SemanticRecordedAction,
} from './model.js';
import type { CorrelationResult } from './action-correlation.js';
import { resolveRecordedTarget } from './recorded-target.js';

/** Un choix dans une liste personnalisée suit l'ouverture de la liste de près. */
const OPTION_AFTER_OPEN_MS = 15_000;
/** Un envoi de formulaire qui suit le clic sur son bouton : une seule action. */
const SUBMIT_AFTER_CLICK_MS = 1500;

export interface SemanticResolution {
  actions: SemanticRecordedAction[];
  warnings: RecordingWarning[];
  /** Événements bruts de bruit (clics de focus, touches…), gardés dans la trace brute seulement. */
  noise: number;
}

/**
 * RAW → SEMANTIC : chaque événement utile devient une action (CLICK, FILL, SELECT…)
 * avec une cible stable (resolveRecordedTarget) et le classement de la SafetyPolicy pour
 * le rejeu. Rien n'est fusionné ici au-delà de ce qu'un seul geste produit (ouvrir une
 * liste puis choisir, cliquer « Enregistrer » puis l'envoi du formulaire) : le nettoyage
 * (saisies, corrections, détours) est le travail du RecordingNormalizer.
 */
export function resolveSemanticActions(
  events: readonly RawRecordedEvent[],
  safety: SafetyPolicy,
  initialStateId?: string,
  /** ACTION CORRELATION : les navigations causées par une action deviennent ses effets, pas des goto. */
  correlation?: CorrelationResult,
  /** HUMAN JOURNEY : clics « non interactifs » qui ont pourtant un effet (raw id → pourquoi) : des actions UNRESOLVED. */
  promoted?: ReadonlyMap<string, string>,
): SemanticResolution {
  const decisions = new Map(correlation?.navigations.map((decision) => [decision.navigationId, decision]));
  const actions: SemanticRecordedAction[] = [];
  const warnings: RecordingWarning[] = [];
  let noise = 0;
  let stateBefore = initialStateId;
  const last = (): SemanticRecordedAction | undefined => actions.at(-1);
  const push = (
    event: RawRecordedEvent,
    type: SemanticActionType,
    extra: Partial<SemanticRecordedAction> = {},
  ): SemanticRecordedAction => {
    const action: SemanticRecordedAction = {
      id: `a${String(actions.length + 1)}`,
      type,
      rawEventIds: [event.id],
      at: event.at,
      url: event.url,
      network: event.network ?? [],
      provenance: 'HUMAN_RECORDED',
      confidence: 0.9,
      evidence: [],
      ...(stateBefore ? { stateBefore } : {}),
      ...(event.stateAfter ? { stateAfter: event.stateAfter } : {}),
      ...(event.observationClosedBy ? { observationClosedBy: event.observationClosedBy } : {}),
      ...(event.observationId ? { observationId: event.observationId } : {}),
      // Une liste vide est une preuve (rien n'était à l'écran) : gardée.
      ...(event.pre?.controls ? { preActionControls: event.pre.controls } : {}),
      ...(event.pre?.route ? { preActionRoute: event.pre.route } : {}),
      ...extra,
    };
    actions.push(action);
    if (event.stateAfter) stateBefore = event.stateAfter;
    if (action.target?.ambiguous)
      warnings.push({
        code: 'AMBIGUOUS_RECORDED_TARGET',
        message: `"${action.target.label}": ${action.target.reasons.at(-1) ?? 'several elements match'}`,
        actionId: action.id,
      });
    else if (action.target?.quality === 'FRAGILE')
      warnings.push({
        code: 'FRAGILE_LOCATOR',
        message: `"${action.target.label}" has no readable name, label or stable attribute: located by its position`,
        actionId: action.id,
      });
    return action;
  };
  /** Ajoute un événement à une action existante (même geste). */
  const absorb = (action: SemanticRecordedAction, event: RawRecordedEvent, why: string): void => {
    action.rawEventIds.push(event.id);
    action.network = [...action.network, ...(event.network ?? [])];
    if (event.stateAfter) {
      action.stateAfter = event.stateAfter;
      stateBefore = event.stateAfter;
    }
    if (event.observationClosedBy) action.observationClosedBy = event.observationClosedBy;
    if (event.observationId) action.observationId = event.observationId;
    action.merged = action.merged ? `${action.merged}; ${why}` : why;
  };

  // Une saisie prend la place où l'humain l'a commencée (le navigateur ne la valide qu'en quittant le champ).
  const ordered = events
    .map((event, index) => ({ event, index, at: event.value?.startedAt ?? event.at }))
    .sort(
      (a, b) =>
        (a.event.value?.startedAt !== undefined || b.event.value?.startedAt !== undefined
          ? a.at - b.at
          : 0) || a.index - b.index,
    )
    .map((entry) => entry.event);
  /** L'action sémantique qui contient un événement brut (le déclencheur d'une navigation). */
  const actionOf = (rawId: string): SemanticRecordedAction | undefined =>
    [...actions].reverse().find((action) => action.rawEventIds.includes(rawId));
  for (const event of ordered) {
    if (event.noise && !correlation?.promoted.has(event.id) && !promoted?.has(event.id)) {
      noise += 1;
      if (event.stateAfter) stateBefore = event.stateAfter;
      continue;
    }
    switch (event.type) {
      case 'checkpoint':
      case 'control': {
        const previous = last();
        if ((event.type === 'checkpoint' || event.control === 'checkpoint') && previous)
          previous.checkpoint = event.label ?? previous.checkpoint ?? 'checkpoint';
        break;
      }
      case 'click': {
        const element = event.element;
        if (!element) break;
        const previous = last();
        if (
          (element.role === 'option' || element.role === 'menuitemradio') &&
          previous?.type === 'CLICK' &&
          previous.target &&
          isListOpener(previous) &&
          event.at - previous.at < OPTION_AFTER_OPEN_MS
        ) {
          previous.type = 'SELECT';
          previous.option = element.name;
          previous.target = resolveRecordedTarget(openerElement(events, previous) ?? element, 'field');
          previous.value = {
            class: 'LITERAL_BUSINESS_VALUE',
            literal: element.name,
            sensitive: false,
            reason: `a choice of the screen ("${element.name}")`,
          };
          absorb(previous, event, 'list opened, then an option chosen');
          break;
        }
        const target = resolveRecordedTarget(element, 'click');
        const classification = safety.classify({
          type: element.href && element.role === 'link' ? 'navigate' : 'click',
          category: 'other',
          ...(element.text ? { text: element.text } : {}),
          ...(element.label ? { label: element.label } : {}),
          ...(element.name ? { name: element.name } : {}),
          ...(element.href ? { href: element.href } : {}),
          ...(element.role ? { role: element.role } : {}),
          isSubmit: element.isSubmit,
          submitsForm: element.isSubmit,
          inSearchForm: false,
          formHasAction: false,
          ...(element.dialogName ? { dialogName: element.dialogName } : {}),
        });
        // Un contrôle cliqué par l'humain dont l'intention n'est pas comprise : gardé, UNRESOLVED.
        const why = promoted?.get(event.id);
        const unresolved = why !== undefined || !target.named;
        push(event, element.isSubmit ? 'SUBMIT' : 'CLICK', {
          target,
          classification: classification.classification,
          evidence: [
            `raw click on ${element.role || element.tag} "${target.label}"`,
            ...target.reasons,
            ...(why ? [`not recognised as a control, kept as a human action: ${why}`] : []),
            ...(unresolved && !why ? ['a control without a name: kept, intention not understood yet'] : []),
          ],
          confidence: target.ambiguous ? 0.5 : target.quality === 'FRAGILE' || unresolved ? 0.6 : 0.9,
          ...(unresolved ? { semanticStatus: 'UNRESOLVED' as const } : {}),
        });
        break;
      }
      case 'drag': {
        // DRAG_AND_DROP : une action humaine de premier ordre (jamais réduite à un clic ni perdue).
        const drag = event.drag;
        if (!drag) break;
        const zone = (facts: typeof drag.destination): string =>
          facts ? `"${facts.label ?? facts.section ?? ''}"` : 'an unknown zone';
        const classification = safety.classify({ type: 'click', category: 'other', text: drag.item });
        const resolved = drag.destination !== undefined && (drag.moved || drag.sameZone);
        push(event, 'DRAG_AND_DROP', {
          ...(event.element ? { target: resolveRecordedTarget(event.element, 'click') } : {}),
          drag,
          classification: classification.classification,
          evidence: [
            `${drag.kind === 'HTML5' ? 'HTML5' : 'pointer'} drag of "${drag.item}" from ${zone(drag.source)} to ${zone(drag.destination)}`,
            drag.moved
              ? `ITEM_MOVED observed: "${drag.item}" is in ${zone(drag.destination)}`
              : drag.sameZone
                ? 'dropped in its own zone (reorder)'
                : 'no move observed after the drop',
          ],
          confidence: drag.moved ? 0.9 : drag.sameZone ? 0.7 : 0.5,
          ...(resolved ? {} : { semanticStatus: 'UNRESOLVED' as const }),
        });
        break;
      }
      case 'submit': {
        const previous = last();
        if (
          previous &&
          (previous.type === 'SUBMIT' || previous.type === 'CLICK') &&
          event.at - previous.at < SUBMIT_AFTER_CLICK_MS
        ) {
          previous.type = 'SUBMIT';
          absorb(previous, event, 'the click submitted its form');
          break;
        }
        const element = event.element;
        if (!element) break;
        const target = resolveRecordedTarget(element, 'click');
        push(event, 'SUBMIT', {
          target,
          classification: 'MUTATION',
          evidence: ['form submitted (Enter key or script)', ...target.reasons],
          confidence: 0.8,
        });
        break;
      }
      case 'keydown':
        // Entrée, Échap : leur effet (envoi, fermeture) est enregistré par ailleurs.
        noise += 1;
        if (event.stateAfter) stateBefore = event.stateAfter;
        break;
      case 'input':
      case 'change': {
        const element = event.element;
        if (!element) break;
        const value = event.value;
        if (element.inputType === 'checkbox' || element.role === 'switch') {
          push(event, value?.checked === false ? 'UNCHECK' : 'CHECK', {
            target: resolveRecordedTarget(element, 'check'),
            evidence: [
              `checkbox "${element.label ?? element.name}" ${value?.checked === false ? 'unchecked' : 'checked'}`,
            ],
          });
        } else if (element.inputType === 'radio') {
          const option = value?.option?.label ?? element.label ?? element.name;
          push(event, 'CHECK', {
            target: resolveRecordedTarget(element, 'check'),
            option,
            value: {
              class: 'LITERAL_BUSINESS_VALUE',
              literal: option,
              sensitive: false,
              reason: `a choice of the screen ("${option}")`,
            },
            evidence: [`radio "${option}"${element.groupLabel ? ` of "${element.groupLabel}"` : ''} chosen`],
          });
        } else if (element.tag === 'select') {
          const option = value?.option?.label ?? '';
          push(event, 'SELECT', {
            target: resolveRecordedTarget(element, 'field'),
            option,
            value: {
              class: 'LITERAL_BUSINESS_VALUE',
              literal: option,
              sensitive: false,
              reason: `a choice of the screen ("${option}"${value?.option?.value ? `, code ${value.option.value}` : ''})`,
            },
            evidence: [`option "${option}" chosen in "${element.label ?? element.name}"`],
          });
        } else if (element.inputType === 'file') {
          push(event, 'UPLOAD', {
            target: resolveRecordedTarget(element, 'field'),
            evidence: [
              `file chosen (${(value?.files ?? []).map((ext) => `.${ext}`).join(', ') || 'no file'}): the path is never recorded`,
            ],
          });
        } else {
          push(event, 'FILL', {
            target: resolveRecordedTarget(element, 'field'),
            evidence: [
              `${event.type} in "${element.label ?? element.name}" (${value?.shape ?? 'text'}, ${String(value?.length ?? 0)} characters)`,
            ],
          });
          // Les faits de la valeur (forme, empreinte) restent sur l'événement brut : le normaliseur les lit.
        }
        break;
      }
      case 'navigation': {
        const decision = decisions.get(event.id);
        if (decision?.kind === 'RELOAD') {
          if (event.stateAfter) stateBefore = event.stateAfter;
          break;
        }
        // Une navigation causée par une action (ou la suite d'une telle navigation) : un EFFET de cette action.
        const rootId =
          decision?.kind === 'REDIRECT'
            ? (decisions.get(decision.causedBy ?? '')?.causedBy ?? decision.causedBy)
            : decision?.causedBy;
        const owner =
          decision?.kind === 'EFFECT' || decision?.kind === 'REDIRECT'
            ? (actionOf(decision.kind === 'EFFECT' ? (decision.causedBy ?? '') : (rootId ?? '')) ??
              actions.find((action) => action.navigation?.navigationIds.includes(decision.causedBy ?? '')))
            : undefined;
        if (owner && decision) {
          const route = routeOf(event.url);
          if (owner.navigation) {
            owner.navigation.routes.push(route);
            owner.navigation.navigationIds.push(event.id);
            owner.navigation.reasons.push(...decision.reasons);
          } else if (owner.type === 'NAVIGATE') {
            // La redirection d'un goto (garde de route) : la chaîne reste sur le goto.
            owner.evidence.push(`then redirected to ${route}`);
          } else {
            owner.navigation = {
              routes: [route],
              navigationIds: [event.id],
              confidence: decision.confidence ?? 'MEDIUM',
              score: decision.score,
              reasons: decision.reasons,
              provenance: 'RUNTIME_OBSERVED',
            };
            owner.evidence.push(`caused the navigation to ${route} (${decision.confidence ?? 'MEDIUM'})`);
          }
          owner.network = [...owner.network, ...(event.network ?? [])];
          if (event.stateAfter) {
            owner.stateAfter = event.stateAfter;
            stateBefore = event.stateAfter;
          }
          if (decision.ambiguous)
            warnings.push({
              code: 'CAUSALITY_AMBIGUOUS',
              message: `the navigation to ${route} could also come from another recent action: attributed to "${owner.target?.label ?? owner.type}"`,
              actionId: owner.id,
            });
          break;
        }
        push(event, 'NAVIGATE', {
          route: routeOf(event.url),
          evidence: [`the page went to ${routeOf(event.url)}`, ...(decision?.reasons ?? [])],
          ...(decision?.gotoReason ? { gotoReason: decision.gotoReason } : {}),
        });
        break;
      }
      case 'dialog': {
        const dialog = event.dialog;
        if (!dialog) break;
        push(event, dialog.accepted ? 'CONFIRM' : 'CANCEL', {
          dialog: { kind: dialog.kind, message: dialog.message },
          evidence: [
            `browser ${dialog.kind} "${dialog.message}" ${dialog.accepted ? 'accepted' : 'dismissed'}`,
          ],
        });
        break;
      }
      case 'popup':
      case 'download': {
        const previous = last();
        const effect =
          event.type === 'popup'
            ? `new window ${event.target ?? ''}`.trim()
            : `download ${event.target ?? ''}`.trim();
        if (previous) previous.sideEffects = [...(previous.sideEffects ?? []), effect];
        break;
      }
      case 'filechooser':
        noise += 1;
        break;
    }
  }
  return { actions, warnings, noise };
}

function isListOpener(action: SemanticRecordedAction): boolean {
  return action.evidence.some((line) => /raw click on (combobox|listbox|button)/.test(line));
}

function openerElement(
  events: readonly RawRecordedEvent[],
  action: SemanticRecordedAction,
): RecordedElement | undefined {
  const id = action.rawEventIds[0];
  return events.find((event) => event.id === id)?.element;
}

/** La route d'une URL : le chemin et la requête, sans l'hôte. */
export function routeOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}${parsed.hash.startsWith('#/') ? parsed.hash : ''}`;
  } catch {
    return url;
  }
}
