import type { FunctionalExchange } from '../../functional/model.js';
import type { RawRecordedEvent, RecordedState, SemanticRecordedAction } from '../model.js';
import {
  CREATE_LABEL,
  DELETE_LABEL,
  LEAVE_LABEL,
  SAVE_LABEL,
  SEARCH_LABEL,
  SUCCESS,
  WRITE,
  collectionOf,
  identifierTokens,
  identityInPath,
  labelOf,
  sameValue,
  screenTexts,
} from './signals.js';

/**
 * EVIDENCE COLLECTOR : avant toute interprétation, ce qui a été OBSERVÉ autour des entités, en
 * preuves structurées (une saisie, une réponse réseau, une page de détail…). La provenance d'une
 * entité (créée, découverte, existante) est décidée APRÈS, par le ProvenanceResolver, à partir de
 * ces preuves — jamais directement d'une action.
 *
 *   User Action → DOM / Navigation / Network / UI state → EntityEvidence[] → identités → provenance
 *
 * Rien n'est propre à un domaine : une identité est reconnue par sa FORME (segment d'URL après une
 * collection, champ id d'une réponse, jeton affiché) et une intention par des verbes d'interface
 * génériques. Le réseau est une source parmi d'autres : sans lui, l'écran, les URL et les gestes
 * suffisent à observer une entité.
 */
export type IdentitySource =
  | 'URL'
  | 'ROUTE'
  | 'NETWORK_RESPONSE'
  | 'NETWORK_PATH'
  | 'LOCATION_HEADER'
  | 'VISIBLE_TEXT'
  | 'DOM_LINK'
  | 'USER_INPUT';

/** La fiabilité d'une identité selon d'où elle vient (règle fixe, pas un jugement). */
export const IDENTITY_CONFIDENCE: Record<IdentitySource, number> = {
  NETWORK_RESPONSE: 0.95,
  LOCATION_HEADER: 0.95,
  NETWORK_PATH: 0.9,
  URL: 0.9,
  ROUTE: 0.9,
  DOM_LINK: 0.85,
  VISIBLE_TEXT: 0.75,
  USER_INPUT: 0.6,
};

/**
 * L'identité d'une entité : jamais supposée être un champ « id ». Un nombre, un uuid, une référence
 * (CMD-2026-00125), un segment d'URL, un texte affiché… La valeur n'est gardée que si
 * l'APPLICATION l'a montrée (URL, réponse, écran) : une saisie n'est connue que par son empreinte.
 */
export interface EntityIdentity {
  value?: string;
  digest?: string;
  source: IdentitySource;
  /** Le champ qui la portait (id, data.reference, (location)…). */
  field?: string;
  confidence: number;
}

export type EntityEvidenceType =
  /** L'identité était à l'écran (URL) quand l'enregistrement a commencé : elle existait avant. */
  | 'INITIAL_STATE'
  /** L'humain a saisi une valeur qui a la forme d'un identifiant. */
  | 'USER_INPUT'
  /** L'action est une recherche (libellé, page, route). */
  | 'SEARCH_ACTION'
  /** L'action est annoncée comme une création / soumission (libellé). */
  | 'CREATE_ACTION'
  /** Une écriture sur une COLLECTION (POST sans identifiant dans le chemin) a réussi. */
  | 'WRITE_REQUEST'
  /** 201 Created, ou un message de réussite affiché après l'action. */
  | 'SUCCESS_RESPONSE'
  /** Une identité PRODUITE par l'action de création (réponse, Location, message, page de l'entité). */
  | 'NEW_ENTITY_ID'
  /** Une lecture GET …/<id> a réussi. */
  | 'READ_RESPONSE'
  /** L'élément cliqué (lien, ligne, résultat) porte l'identité : une liste ou des résultats. */
  | 'RESULT_SELECTED'
  /** Après l'action, l'URL ou le titre de l'écran porte l'identité : une page de détail. */
  | 'DETAIL_VIEW'
  /** L'humain a tapé une URL qui porte l'identité. */
  | 'DIRECT_NAVIGATION'
  | 'UPDATE_REQUEST'
  | 'DELETE_REQUEST'
  /** Un champ modifié pendant que l'entité est affichée. */
  | 'EDIT_INPUT'
  /** « Enregistrer » pendant que l'entité est affichée (sans réseau, c'est la seule preuve). */
  | 'SAVE_ACTION'
  | 'DELETE_ACTION';

export interface EntityEvidence {
  id: string;
  type: EntityEvidenceType;
  /** La place de l'action dans le parcours ; -1 : l'état initial (avant toute action). */
  actionIndex: number;
  actionId?: string;
  rawEventIds: string[];
  /** Absente : une preuve de CONTEXTE de l'action (POST réussi, libellé…), rattachée à ses identités. */
  identity?: EntityIdentity;
  /** La ressource STRUCTURELLE (segment de collection d'une URL ou d'une API, au singulier). */
  resource?: string;
  /** Des preuves qui décrivent le MÊME objet (l'id et la référence d'une même réponse). */
  object?: string;
  details: {
    method?: string;
    url?: string;
    status?: number;
    label?: string;
    selector?: string;
    route?: string;
    /** USER_INPUT : la saisie se fait dans un contexte de recherche. */
    search?: boolean;
  };
  description: string;
}

export interface EvidenceInput {
  actions: readonly SemanticRecordedAction[];
  states: readonly RecordedState[];
  rawEvents: readonly RawRecordedEvent[];
  /** Les textes saisis (champs non sensibles), pour COMPARER seulement : jamais écrits. */
  typedValues?: ReadonlyMap<string, string>;
  /** L'empreinte salée de la session (la même que celle des saisies et des réponses). */
  digest?: (value: string) => string;
  /** L'écran observé au démarrage de l'enregistrement. */
  initialStateId?: string;
}

export interface EvidenceCollection {
  evidence: EntityEvidence[];
  /** Les saisies en clair par preuve USER_INPUT : en mémoire, pour comparer, jamais écrites. */
  typed: ReadonlyMap<string, string>;
}

/** Les preuves qui OBSERVENT une entité (par opposition à une saisie ou à une création). */
export const OBSERVATION: ReadonlySet<EntityEvidenceType> = new Set([
  'INITIAL_STATE',
  'READ_RESPONSE',
  'RESULT_SELECTED',
  'DETAIL_VIEW',
  'DIRECT_NAVIGATION',
  'UPDATE_REQUEST',
  'DELETE_REQUEST',
]);

const PREFERRED_ID = /^(data\.)?(id|uuid)$/i;
/** Les autres noms d'un même objet dans une réponse (jamais une clé étrangère « clientId »). */
const ALIAS_FIELD = /(^|\.)(reference|ref|code|number|numero|num[ée]ro|no|key|slug)$/i;

export function collectEntityEvidence(input: EvidenceInput): EvidenceCollection {
  const evidence: EntityEvidence[] = [];
  const typed = new Map<string, string>();
  const stateById = new Map(input.states.map((state) => [state.id, state]));
  const rawById = new Map(input.rawEvents.map((event) => [event.id, event]));
  const actions = input.actions;

  const identity = (
    value: string,
    source: IdentitySource,
    extra: { field?: string; digest?: string } = {},
  ): EntityIdentity => {
    const digest = extra.digest ?? input.digest?.(value);
    return {
      value,
      ...(digest ? { digest } : {}),
      source,
      ...(extra.field ? { field: extra.field } : {}),
      confidence: IDENTITY_CONFIDENCE[source],
    };
  };
  const push = (entry: Omit<EntityEvidence, 'id'>): EntityEvidence => {
    const full: EntityEvidence = { id: `e${String(evidence.length + 1)}`, ...entry };
    evidence.push(full);
    return full;
  };
  /** Les identités déjà MONTRÉES par l'application (une saisie n'en fait pas partie). */
  const shown: EntityIdentity[] = [];
  const wasShown = (candidate: EntityIdentity): boolean =>
    shown.some((other) => sameIdentity(other, candidate));
  /** L'entité à l'écran : les champs modifiés et « Enregistrer » la concernent. */
  let focus: { identity: EntityIdentity; resource?: string } | undefined;

  // ------------------------------------------------------------ l'état initial (avant toute action)
  const initial = input.initialStateId ? stateById.get(input.initialStateId) : undefined;
  if (initial) {
    const found = identityInPath(initial.url) ?? identityInPath(initial.route);
    if (found) {
      const id = identity(found.value, 'URL');
      push({
        type: 'INITIAL_STATE',
        actionIndex: -1,
        rawEventIds: [],
        identity: id,
        ...(found.resource ? { resource: found.resource } : {}),
        details: { route: pathOf(initial.url) },
        description: `${pathOf(initial.url)} was displayed when the recording started`,
      });
      shown.push(id);
      focus = { identity: id, ...(found.resource ? { resource: found.resource } : {}) };
    }
  }

  for (const [index, action] of actions.entries()) {
    const after = action.stateAfter ? stateById.get(action.stateAfter) : undefined;
    const before = action.stateBefore ? stateById.get(action.stateBefore) : undefined;
    const raw = rawById.get(action.rawEventIds.at(-1) ?? '');
    const label = labelOf(action);
    const base = { actionIndex: index, actionId: action.id, rawEventIds: action.rawEventIds };
    const selector = action.target?.target.value;
    const writes = action.network.filter(
      (exchange) => WRITE.has(exchange.method) && exchange.status !== undefined && exchange.status < 400,
    );
    const routes = [
      ...(action.navigation?.routes ?? []),
      ...(action.type === 'NAVIGATE' && action.route ? [action.route] : []),
    ];
    const texts = screenTexts(after);
    const success = texts.find((text) => SUCCESS.test(text));
    const added: EntityEvidence[] = [];
    const add = (entry: Omit<EntityEvidence, 'id' | 'actionIndex' | 'actionId' | 'rawEventIds'>): void => {
      added.push(push({ ...base, ...entry }));
    };

    // Un geste qui quitte l'entité affichée (nouvelle création, recherche, retour) : plus de focus.
    if (
      action.type === 'CLICK' &&
      (SEARCH_LABEL.test(label) || LEAVE_LABEL.test(label)) &&
      !SAVE_LABEL.test(label)
    )
      focus = undefined;

    // ---------------------------------------------------------- création : une identité PRODUITE par l'action
    const collectionPost = writes.find(
      (exchange) => exchange.method === 'POST' && !identityInPath(exchange.path),
    );
    const messageToken = success ? identifierTokens(success)[0] : undefined;
    const focusInMessage =
      focus?.identity.value !== undefined &&
      success !== undefined &&
      identifierTokens(success).some((token) => sameValue(token, focus?.identity.value ?? ''));
    const domCreation =
      !collectionPost &&
      writes.length === 0 &&
      action.type !== 'FILL' &&
      CREATE_LABEL.test(label) &&
      success !== undefined &&
      messageToken !== undefined &&
      !focusInMessage &&
      !wasShown(identity(messageToken, 'VISIBLE_TEXT'));
    if (collectionPost || domCreation) {
      const object = `created:${action.id}`;
      const resource = collectionPost ? collectionOf(collectionPost.path) : undefined;
      const produced = collectionPost ? createdIdentities(collectionPost, identity) : [];
      if (produced.length === 0 && messageToken)
        produced.push({
          identity: identity(messageToken, 'VISIBLE_TEXT'),
          where: `message "${clip(success)}"`,
        });
      if (produced.length === 0)
        for (const route of action.navigation?.routes ?? []) {
          const found = identityInPath(route);
          if (found) {
            produced.push({ identity: identity(found.value, 'ROUTE'), where: `route ${route}` });
            break;
          }
        }
      for (const { identity: id, where } of produced)
        add({
          type: 'NEW_ENTITY_ID',
          identity: id,
          ...(resource ? { resource } : {}),
          object,
          details: {
            ...(collectionPost
              ? { method: 'POST', url: collectionPost.path, ...statusOf(collectionPost) }
              : {}),
            label,
          },
          description: `identity ${id.value ?? '(digest)'} produced by the action "${label}" (${where})`,
        });
      if (collectionPost)
        add({
          type: 'WRITE_REQUEST',
          details: { method: 'POST', url: collectionPost.path, ...statusOf(collectionPost) },
          description: `POST ${collectionPost.path} → ${String(collectionPost.status)} (a write to a collection)`,
        });
      if (CREATE_LABEL.test(label))
        add({
          type: 'CREATE_ACTION',
          details: { label, ...(selector ? { selector } : {}) },
          description: `the action "${label}" creates or submits`,
        });
      if (collectionPost?.status === 201 || success)
        add({
          type: 'SUCCESS_RESPONSE',
          details: collectionPost?.status === 201 ? { status: 201 } : {},
          description: collectionPost?.status === 201 ? '201 Created' : `success message "${clip(success)}"`,
        });
    } else {
      // ---------------------------------------------------------- écritures sur une entité (…/<id>)
      for (const exchange of writes) {
        const found = identityInPath(exchange.path);
        if (!found) continue;
        const id = identity(found.value, 'NETWORK_PATH', pathDigest(exchange));
        add({
          type: exchange.method === 'DELETE' ? 'DELETE_REQUEST' : 'UPDATE_REQUEST',
          identity: id,
          ...(found.resource ? { resource: found.resource } : {}),
          details: { method: exchange.method, url: exchange.path, ...statusOf(exchange) },
          description: `${exchange.method} ${exchange.path} → ${String(exchange.status)}`,
        });
      }
    }

    // ---------------------------------------------------------- lectures (GET …/<id>)
    for (const exchange of action.network) {
      if (exchange.method !== 'GET' || exchange.status === undefined || exchange.status >= 400) continue;
      const found = identityInPath(exchange.path);
      if (!found) continue;
      add({
        type: 'READ_RESPONSE',
        identity: identity(found.value, 'NETWORK_PATH', pathDigest(exchange)),
        ...(found.resource ? { resource: found.resource } : {}),
        details: { method: 'GET', url: exchange.path, ...statusOf(exchange) },
        description: `GET ${exchange.path} → ${String(exchange.status)}`,
      });
    }

    // ---------------------------------------------------------- l'élément cliqué porte l'identité (liste, résultats)
    if (action.type === 'CLICK' && !collectionPost && !domCreation) {
      const href = raw?.element?.href;
      const linked = href ? identityInPath(href) : undefined;
      if (linked)
        add({
          type: 'RESULT_SELECTED',
          identity: identity(linked.value, 'DOM_LINK'),
          ...(linked.resource ? { resource: linked.resource } : {}),
          details: { label, url: pathOf(href ?? ''), ...(selector ? { selector } : {}) },
          description: `the clicked link "${clip(label)}" points to ${pathOf(href ?? '')}`,
        });
      const shownText = `${label} ${raw?.element?.text ?? ''}`;
      for (const token of identifierTokens(shownText).slice(0, 3))
        add({
          type: 'RESULT_SELECTED',
          identity: identity(token, 'VISIBLE_TEXT'),
          details: { label, ...(selector ? { selector } : {}) },
          description: `the clicked element "${clip(label)}" shows ${token}`,
        });
    }

    // ---------------------------------------------------------- navigation : page de détail, URL tapée
    for (const route of routes) {
      const found = identityInPath(route);
      if (!found) continue;
      const direct = action.type === 'NAVIGATE';
      const initialNavigation = direct && action.gotoReason === 'INITIAL_NAVIGATION';
      const typedUrl = direct && action.gotoReason === 'DIRECT_URL_ENTRY';
      add({
        type: initialNavigation ? 'INITIAL_STATE' : typedUrl ? 'DIRECT_NAVIGATION' : 'DETAIL_VIEW',
        identity: identity(found.value, 'ROUTE'),
        ...(found.resource ? { resource: found.resource } : {}),
        ...(collectionPost || domCreation ? { object: `created:${action.id}` } : {}),
        details: { route },
        description: initialNavigation
          ? `${route} was the starting page`
          : typedUrl
            ? `the user opened ${route} directly`
            : `the screen moved to ${route}`,
      });
    }

    // Un titre d'écran qui CONFIRME une identité déjà vue dans cette action (une SPA sans route).
    const confirmed = added.filter((entry) => entry.identity?.value !== undefined);
    for (const heading of after?.headings ?? [])
      for (const token of identifierTokens(heading)) {
        const same = confirmed.find((entry) => sameValue(entry.identity?.value ?? '', token));
        if (!same || added.some((entry) => entry.type === 'DETAIL_VIEW' && entry.identity?.value === token))
          continue;
        add({
          type: 'DETAIL_VIEW',
          identity: identity(token, 'VISIBLE_TEXT'),
          ...(same.object ? { object: same.object } : {}),
          details: { label: heading },
          description: `the screen title "${clip(heading)}" shows ${token}`,
        });
      }

    // ---------------------------------------------------------- saisie d'une valeur en forme d'identifiant
    if (action.type === 'FILL') {
      const facts = [...action.rawEventIds]
        .reverse()
        .map((id) => rawById.get(id)?.value)
        .find((value) => value !== undefined);
      const text = [...action.rawEventIds]
        .reverse()
        .map((id) => input.typedValues?.get(id))
        .find((value) => value !== undefined);
      const identifierShaped =
        facts?.sensitive !== true &&
        ((text !== undefined &&
          identifierTokens(text).length === 1 &&
          identifierTokens(text)[0] === text.trim()) ||
          (text === undefined &&
            (facts?.shape === 'number' || facts?.shape === 'code') &&
            facts.length >= 3));
      const digest = facts?.digest ?? (text !== undefined ? input.digest?.(text) : undefined);
      if (identifierShaped && (digest || text !== undefined)) {
        const next = actions[index + 1];
        const search =
          SEARCH_LABEL.test(label) ||
          [before?.title, ...(before?.headings ?? []), after?.title, ...(after?.headings ?? [])].some(
            (entry) => entry !== undefined && SEARCH_LABEL.test(entry),
          ) ||
          SEARCH_LABEL.test(pathOf(action.url)) ||
          (next?.type === 'CLICK' && SEARCH_LABEL.test(labelOf(next)));
        const entry = push({
          ...base,
          type: 'USER_INPUT',
          identity: {
            ...(digest ? { digest } : {}),
            source: 'USER_INPUT',
            confidence: IDENTITY_CONFIDENCE.USER_INPUT,
          },
          details: { label, ...(selector ? { selector } : {}), search },
          description: `the user typed an identifier-shaped value in "${clip(label)}"${search ? ' (search context)' : ''}`,
        });
        if (text !== undefined) typed.set(entry.id, text);
        if (search)
          push({
            ...base,
            type: 'SEARCH_ACTION',
            details: { label },
            description: `"${clip(label)}" is a search`,
          });
        continue;
      }
    }

    // ---------------------------------------------------------- l'entité affichée : modification, enregistrement, suppression
    if (
      focus &&
      !collectionPost &&
      !domCreation &&
      !added.some(
        (entry) =>
          OBSERVATION.has(entry.type) && entry.type !== 'UPDATE_REQUEST' && entry.type !== 'DELETE_REQUEST',
      )
    ) {
      const target = {
        identity: { ...focus.identity },
        ...(focus.resource ? { resource: focus.resource } : {}),
      };
      if (['FILL', 'SELECT', 'CHECK', 'UNCHECK'].includes(action.type))
        add({
          type: 'EDIT_INPUT',
          ...target,
          details: { label, ...(selector ? { selector } : {}) },
          description: `"${clip(label)}" changed while ${focus.identity.value ?? 'the entity'} is displayed`,
        });
      else if (action.type === 'CLICK' && DELETE_LABEL.test(label))
        add({
          type: 'DELETE_ACTION',
          ...target,
          details: { label, ...(selector ? { selector } : {}) },
          description: `"${clip(label)}" while ${focus.identity.value ?? 'the entity'} is displayed`,
        });
      else if (action.type === 'CLICK' && SAVE_LABEL.test(label))
        add({
          type: 'SAVE_ACTION',
          ...target,
          details: { label, ...(selector ? { selector } : {}) },
          description: `"${clip(label)}" while ${focus.identity.value ?? 'the entity'} is displayed`,
        });
    }

    // ---------------------------------------------------------- ce qui est à l'écran après l'action
    for (const entry of added)
      if (entry.identity?.value !== undefined && entry.type !== 'USER_INPUT') shown.push(entry.identity);
    const opened =
      added.find((entry) => entry.type === 'DETAIL_VIEW' && entry.identity?.source === 'ROUTE') ??
      added.find((entry) => entry.type === 'DIRECT_NAVIGATION' || entry.type === 'INITIAL_STATE') ??
      added.find((entry) => entry.type === 'DETAIL_VIEW' || entry.type === 'RESULT_SELECTED');
    if (opened?.identity)
      focus = { identity: opened.identity, ...(opened.resource ? { resource: opened.resource } : {}) };
    else if (routes.length > 0 && !routes.some((route) => focusIn(focus, route))) focus = undefined;
  }
  return { evidence, typed };
}

/** Deux identités désignent-elles la même valeur (même empreinte salée, ou même valeur) ? */
export function sameIdentity(a: EntityIdentity, b: EntityIdentity): boolean {
  if (a.digest && b.digest && a.digest === b.digest) return true;
  return a.value !== undefined && b.value !== undefined && sameValue(a.value, b.value);
}

function createdIdentities(
  exchange: FunctionalExchange,
  identity: (
    value: string,
    source: IdentitySource,
    extra?: { field?: string; digest?: string },
  ) => EntityIdentity,
): { identity: EntityIdentity; where: string }[] {
  const ids = exchange.identifiers ?? [];
  const preferred =
    ids.find((id) => id.source === 'response' && PREFERRED_ID.test(id.field)) ??
    ids.find((id) => id.source === 'response') ??
    ids.find((id) => id.source === 'location');
  if (!preferred) return [];
  const kept = [
    preferred,
    ...ids.filter((id) => id !== preferred && id.source === 'response' && ALIAS_FIELD.test(id.field)),
  ];
  return kept.map((id) => {
    const source: IdentitySource = id.source === 'location' ? 'LOCATION_HEADER' : 'NETWORK_RESPONSE';
    const built: EntityIdentity =
      id.value !== undefined
        ? identity(id.value, source, { field: id.field, digest: id.digest })
        : { digest: id.digest, source, field: id.field, confidence: IDENTITY_CONFIDENCE[source] };
    return {
      identity: built,
      where: `${source === 'LOCATION_HEADER' ? 'Location header' : 'response'} field ${id.field}`,
    };
  });
}

function pathDigest(exchange: FunctionalExchange): { digest?: string } {
  const digest = exchange.identifiers?.find((id) => id.source === 'path')?.digest;
  return digest ? { digest } : {};
}

function statusOf(exchange: FunctionalExchange): { status?: number } {
  return exchange.status !== undefined ? { status: exchange.status } : {};
}

function focusIn(focus: { identity: EntityIdentity } | undefined, route: string): boolean {
  const value = focus?.identity.value;
  return (
    value !== undefined &&
    identityInPath(route)?.value !== undefined &&
    sameValue(identityInPath(route)?.value ?? '', value)
  );
}

function pathOf(url: string): string {
  try {
    return new URL(url, 'http://local.invalid').pathname;
  } catch {
    return url;
  }
}

function clip(text: string | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
}
