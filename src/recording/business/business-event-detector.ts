import type { ExchangeIdentifier, FunctionalExchange } from '../../functional/model.js';
import type { RawRecordedEvent, RecordedFlowStep, RecordedState, SemanticRecordedAction } from '../model.js';
import { entityOf } from '../recorded-test-data.js';
import { EntityMemory, identifierTokens } from './entity-memory.js';
import {
  statusOf,
  type BusinessEvent,
  type BusinessEventType,
  type BusinessEvidence,
  type BusinessIdentifier,
  type BusinessRelation,
} from './model.js';

/**
 * BUSINESS EVENT DETECTOR (déterministe) : des actions techniques enregistrées aux événements métier,
 * seulement quand plusieurs indices concordent. Une réponse HTTP seule ne fait jamais une création :
 * méthode, route d'API, réponse, identifiant, message affiché, libellé du bouton, navigation et
 * contexte des actions précédentes sont pesés ensemble. Rien n'est inventé : une entité qu'aucun
 * indice ne départage reste AMBIGUOUS, une hypothèse faible reste UNKNOWN.
 */
export interface BusinessDetectionInput {
  /** Les actions gardées par le normaliseur, dans l'ordre. */
  actions: readonly SemanticRecordedAction[];
  states: readonly RecordedState[];
  rawEvents: readonly RawRecordedEvent[];
  /** Les étapes du flow enregistré (le lien métier → Playwright). */
  steps?: readonly RecordedFlowStep[];
  /** Les textes saisis (champs non sensibles), par événement brut : jamais écrits. */
  typedValues?: ReadonlyMap<string, string>;
  /** L'empreinte salée de la session (la même que celle des saisies et des réponses). */
  digest?: (value: string) => string;
  /**
   * Des ambiguïtés tranchées (par l'IA, facultative) : action → entité. Un choix hors des candidats
   * observés est ignoré.
   */
  decisions?: ReadonlyMap<string, string>;
}

export interface BusinessDetection {
  events: BusinessEvent[];
  relations: BusinessRelation[];
  memory: EntityMemory;
}

const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const CREATE_LABEL =
  /\b(cr[ée]er|ajouter|enregistrer|soumettre|valider|confirmer|envoyer|create|add|save|submit|confirm|send)\b/iu;
const SEARCH_LABEL = /\b(recherch\w*|chercher|trouver|search\w*|find|lookup|query)\b/iu;
const SUCCESS =
  /\b(cr[ée]{2}e?s?|enregistr[ée]e?s?|ajout[ée]e?s?|cr[ée]ation|created|saved|added|succ[eè]s|success\w*)\b/iu;
const ENTITY_VERB =
  /(?:nouvel(?:le)?|nouveau|cr[ée]er|ajouter|rechercher|chercher|modifier|supprimer|ouvrir|consulter|new|create|add|search|find|edit|update|delete|open|view)\s+(?:(?:un|une|le|la|les|l'|des|du|de|d'|a|an|the)\s+)?([\p{L}][\p{L}-]{2,})/giu;
/** Des noms de ressource qui ne disent pas QUELLE entité (items, resources…). */
const GENERIC = new Set([
  'item',
  'resource',
  'record',
  'object',
  'entity',
  'data',
  'element',
  'entry',
  'row',
]);

export function detectBusinessEvents(input: BusinessDetectionInput): BusinessDetection {
  const memory = new EntityMemory();
  const events: BusinessEvent[] = [];
  const relations: BusinessRelation[] = [];
  const stateById = new Map(input.states.map((state) => [state.id, state]));
  const rawById = new Map(input.rawEvents.map((event) => [event.id, event]));
  const stepOf = (actionId: string): string[] =>
    (input.steps ?? []).filter((step) => step.actionIds.includes(actionId)).map((step) => step.id);
  const actions = input.actions;
  /** La dernière recherche d'une entité (une ouverture qui la suit en est la suite naturelle). */
  let lastSearch: BusinessEvent | undefined;
  const consumed = new Set<string>();
  /** La dernière action rattachée à un événement métier : une création regroupe ce qui suit. */
  let boundary = -1;

  const push = (
    event: Omit<BusinessEvent, 'id' | 'stepIds' | 'analyzer'> & { analyzer?: BusinessEvent['analyzer'] },
  ): BusinessEvent => {
    const full: BusinessEvent = {
      ...event,
      id: `b${String(events.length + 1)}`,
      stepIds: [...new Set(event.actionIds.flatMap(stepOf))],
      analyzer: event.analyzer ?? 'DETERMINISTIC',
    };
    events.push(full);
    return full;
  };

  for (const [index, action] of actions.entries()) {
    const after = action.stateAfter ? stateById.get(action.stateAfter) : undefined;
    const before = action.stateBefore ? stateById.get(action.stateBefore) : undefined;
    const writes = action.network.filter(
      (exchange) => WRITE.has(exchange.method) && exchange.status !== undefined && exchange.status < 400,
    );

    // ---------------------------------------------------------------- écritures (création, mise à jour, suppression)
    const write = writes[0];
    const label = labelOf(action);
    const domTexts = after
      ? [...after.alerts, ...(after.statuses ?? []), ...after.headings, after.title]
      : [];
    const created = write && write.method === 'POST' && !hasPathId(write.path);
    const domCreation =
      !write &&
      action.type !== 'FILL' &&
      CREATE_LABEL.test(label) &&
      domTexts.some((text) => SUCCESS.test(text));
    if (created || domCreation) {
      const context = contextOf(actions, index, before);
      const decision = resolveEntity(
        write ? entityOf(write.path) : undefined,
        context.hints,
        input.decisions?.get(action.id),
      );
      const evidence = emptyEvidence();
      let confidence = 0;
      if (write) {
        confidence += 0.45;
        evidence.network.push(`${write.method} ${write.path} → ${String(write.status)}`);
        if (write.status === 201) confidence += 0.05;
      }
      const identifier = identifierOf(write, domTexts, action, input.digest);
      if (identifier) {
        confidence += identifier.source === 'dom' ? (write ? 0.2 : 0.25) : 0.25;
        (identifier.source === 'dom'
          ? evidence.dom
          : identifier.source === 'url'
            ? evidence.navigation
            : evidence.network
        ).push(
          `identifier ${identifier.value ?? '(digest)'} from ${identifier.source}${identifier.field ? ` (${identifier.field})` : ''}`,
        );
      }
      if (CREATE_LABEL.test(label)) {
        confidence += write ? 0.1 : 0.3;
        evidence.context.push(`the action "${label}" creates or submits`);
      }
      const success = domTexts.find((text) => SUCCESS.test(text));
      if (success) {
        confidence += write ? 0.1 : 0.3;
        evidence.dom.push(`message "${success.slice(0, 80)}"`);
      }
      if (action.navigation?.routes.length) {
        evidence.navigation.push(`→ ${action.navigation.routes.join(' → ')}`);
        // La page de l'entité créée (/demandes/12345) : l'identifiant y figure.
        if (
          identifier?.value !== undefined &&
          action.navigation.routes.some((route) => route.split('/').includes(identifier.value ?? ''))
        )
          confidence += 0.05;
      }
      evidence.context.push(...decision.evidence);
      confidence = Math.min(0.99, round(confidence));
      const status = decision.entity
        ? statusOf(confidence)
        : decision.candidates.length > 1
          ? 'AMBIGUOUS'
          : 'UNKNOWN';
      // L'ACTION MÉTIER regroupe le formulaire : depuis le dernier événement métier jusqu'au clic.
      const group = actions
        .slice(Math.max(boundary + 1, index - 14), index + 1)
        .filter((entry) => !consumed.has(entry.id));
      for (const entry of group) consumed.add(entry.id);
      boundary = index;
      const event = push({
        type: 'ENTITY_CREATED',
        ...(decision.entity ? { entity: decision.entity } : {}),
        ...(decision.candidates.length > 1 ? { candidates: decision.candidates } : {}),
        ...(identifier ? { identifier } : {}),
        status: decision.ai && status === 'CONFIRMED' ? 'PROBABLE' : status,
        confidence: decision.ai ? Math.min(confidence, 0.84) : confidence,
        actionIds: group.map((entry) => entry.id),
        rawEventIds: group.flatMap((entry) => entry.rawEventIds),
        evidence,
        ...(decision.ai ? { analyzer: 'AI_PROPOSAL' as const } : {}),
      });
      // UNE VÉRITÉ MÉTIER seulement si confirmée ou probable, avec une entité et un identifiant.
      if (decision.entity && identifier && (event.status === 'CONFIRMED' || event.status === 'PROBABLE')) {
        const record = memory.remember({
          entity: decision.entity,
          identifier,
          status: event.status,
          confidence: event.confidence,
          eventId: event.id,
        });
        event.output = record.reference;
      }
      continue;
    }
    if (
      write &&
      (write.method === 'PUT' ||
        write.method === 'PATCH' ||
        write.method === 'DELETE' ||
        hasPathId(write.path))
    ) {
      const pathId = write.identifiers?.find((id) => id.source === 'path');
      const matches = pathId ? memory.match({ digest: pathId.digest, value: pathId.value }) : [];
      const type: BusinessEventType = write.method === 'DELETE' ? 'ENTITY_DELETED' : 'ENTITY_UPDATED';
      if (matches.length === 1 && matches[0]) {
        const { record, match } = matches[0];
        const evidence = emptyEvidence();
        evidence.network.push(
          `${write.method} ${write.path} → ${String(write.status)}`,
          `path identifier: ${match}`,
        );
        const event = push({
          type,
          entity: record.entity,
          reference: record.reference,
          status: 'CONFIRMED',
          confidence: 0.9,
          actionIds: [action.id],
          rawEventIds: action.rawEventIds,
          evidence,
        });
        relations.push({
          type: type === 'ENTITY_DELETED' ? 'DELETE_REFERENCE' : 'UPDATE_REFERENCE',
          from: event.id,
          to: record.eventId,
          reference: record.reference,
          match,
        });
      }
    }

    // ---------------------------------------------------------------- recherche : une saisie qui vaut un identifiant connu
    if (action.type === 'FILL' && memory.all.length > 0) {
      const raw = [...action.rawEventIds]
        .reverse()
        .map((id) => rawById.get(id))
        .find((event) => event?.value);
      const typed = [...action.rawEventIds]
        .reverse()
        .map((id) => input.typedValues?.get(id))
        .find((text) => text !== undefined);
      const matches = memory.match({
        ...(raw?.value?.digest ? { digest: raw.value.digest } : {}),
        ...(typed !== undefined ? { value: typed } : {}),
      });
      if (matches.length === 1 && matches[0]) {
        const { record, match } = matches[0];
        const evidence = emptyEvidence();
        let confidence = 0.6;
        evidence.context.push(
          `the value typed in "${label}" is the identifier of the created ${record.entity} (${match})`,
        );
        const actionIds = [action.id];
        // Le clic qui a mené à la recherche (« Rechercher une demande ») fait partie de la recherche.
        const previous = actions[index - 1];
        if (
          previous &&
          previous.type !== 'FILL' &&
          !consumed.has(previous.id) &&
          SEARCH_LABEL.test(labelOf(previous))
        ) {
          actionIds.unshift(previous.id);
          confidence += 0.1;
          evidence.context.push(`"${labelOf(previous)}" opens a search`);
        }
        if (
          SEARCH_LABEL.test(label) ||
          SEARCH_LABEL.test(after?.title ?? '') ||
          (after?.headings ?? []).some((text) => SEARCH_LABEL.test(text))
        ) {
          confidence += 0.15;
          evidence.dom.push('a search field / page');
        }
        if (SEARCH_LABEL.test(action.url) || SEARCH_LABEL.test(after?.route ?? '')) {
          confidence += 0.05;
          evidence.navigation.push(`route ${after?.route ?? action.url}`);
        }
        // Le bouton « Rechercher » juste après fait partie de la recherche.
        const next = actions[index + 1];
        if (next && next.type === 'CLICK' && SEARCH_LABEL.test(labelOf(next))) {
          actionIds.push(next.id);
          consumed.add(next.id);
          confidence += 0.1;
          evidence.context.push(`"${labelOf(next)}" runs the search`);
        }
        const query = [...(next?.network ?? []), ...action.network].find(
          (exchange) => exchange.method === 'GET',
        );
        if (query)
          evidence.network.push(
            `GET ${query.path}${query.status !== undefined ? ` → ${String(query.status)}` : ''}`,
          );
        for (const id of actionIds) consumed.add(id);
        boundary = Math.max(
          boundary,
          ...actionIds.map((id) => actions.findIndex((entry) => entry.id === id)),
        );
        confidence = Math.min(0.99, round(confidence));
        const event = push({
          type: 'ENTITY_SEARCHED',
          entity: record.entity,
          reference: record.reference,
          status: statusOf(confidence),
          confidence,
          actionIds,
          rawEventIds: actionIds.flatMap((id) => actions.find((entry) => entry.id === id)?.rawEventIds ?? []),
          evidence,
        });
        if (event.status !== 'UNKNOWN') {
          lastSearch = event;
          relations.push({
            type: 'SEARCH_REFERENCE',
            from: event.id,
            to: record.eventId,
            reference: record.reference,
            match,
          });
        }
      } else if (matches.length > 1) {
        push({
          type: 'ENTITY_SEARCHED',
          candidates: [...new Set(matches.map((entry) => entry.record.reference))],
          status: 'AMBIGUOUS',
          confidence: 0.5,
          actionIds: [action.id],
          rawEventIds: action.rawEventIds,
          evidence: { ...emptyEvidence(), context: ['the typed value matches several known entities'] },
        });
      }
      continue;
    }

    // ---------------------------------------------------------------- ouverture : le résultat qui porte l'identifiant connu
    if (
      (action.type === 'CLICK' || action.type === 'NAVIGATE') &&
      !consumed.has(action.id) &&
      memory.all.length > 0
    ) {
      const evidence = emptyEvidence();
      const found = new Map<string, { score: number; match: string }>();
      const add = (reference: string, score: number, match: string, where: keyof BusinessEvidence): void => {
        const current = found.get(reference);
        found.set(reference, { score: (current?.score ?? 0) + score, match: current?.match ?? match });
        evidence[where].push(match);
      };
      const raw = rawById.get(action.rawEventIds.at(-1) ?? '');
      for (const { record, match } of memory.foundIn(`${label} ${raw?.element?.text ?? ''}`, input.digest))
        add(record.reference, 0.4, `clicked element: ${match}`, 'dom');
      if (raw?.element?.href)
        for (const { record, match } of memory.foundIn(raw.element.href, input.digest))
          add(record.reference, 0.25, `link: ${match}`, 'dom');
      for (const route of [...(action.navigation?.routes ?? []), ...(action.route ? [action.route] : [])])
        for (const { record, match } of memory.foundIn(route, input.digest))
          add(record.reference, 0.35, `route: ${match}`, 'navigation');
      for (const exchange of action.network.filter((entry) => entry.method === 'GET'))
        for (const id of exchange.identifiers ?? [])
          for (const { record, match } of memory.match({
            digest: id.digest,
            ...(id.value ? { value: id.value } : {}),
          }))
            add(record.reference, 0.25, `GET ${exchange.path}: ${match}`, 'network');
      if (found.size === 1) {
        const [reference, hit] = [...found.entries()][0] ?? [];
        const record = memory.all.find((entry) => entry.reference === reference);
        if (record && hit && reference) {
          let confidence = hit.score;
          if (lastSearch?.reference === reference) {
            confidence += 0.15;
            evidence.context.push(`follows the search of ${reference}`);
          }
          confidence = Math.min(0.99, round(confidence));
          boundary = index;
          const event = push({
            type: 'ENTITY_OPENED',
            entity: record.entity,
            reference,
            status: statusOf(confidence),
            confidence,
            actionIds: [action.id],
            rawEventIds: action.rawEventIds,
            evidence,
          });
          if (event.status !== 'UNKNOWN')
            relations.push({
              type: 'OPEN_REFERENCE',
              from: event.id,
              to: record.eventId,
              reference,
              match: hit.match,
            });
        }
      } else if (found.size > 1)
        push({
          type: 'ENTITY_OPENED',
          candidates: [...found.keys()],
          status: 'AMBIGUOUS',
          confidence: 0.5,
          actionIds: [action.id],
          rawEventIds: action.rawEventIds,
          evidence,
        });
    }
  }
  return { events, relations, memory };
}

/** L'entité : celle de l'API, confirmée par l'écran ; deux indices qui se contredisent → AMBIGUOUS. */
export function resolveEntity(
  api: string | undefined,
  hints: readonly string[],
  decision?: string,
): { entity?: string; candidates: string[]; evidence: string[]; ai: boolean } {
  const apiWord = api ? singular(api) : undefined;
  // Une ressource d'API générique (items, resources) ne dit pas QUELLE entité : jamais seule.
  const generic = apiWord !== undefined && GENERIC.has(fold(apiWord));
  const strong = unique([...(apiWord && !generic ? [apiWord] : []), ...hints.map(singular)]);
  const candidates = unique([...strong, ...(generic && apiWord ? [apiWord] : [])]);
  const evidence: string[] = [];
  if (api) evidence.push(`API resource "${api}"${generic ? ' (generic name)' : ''}`);
  if (hints.length > 0) evidence.push(`screen mentions ${hints.map((hint) => `"${hint}"`).join(', ')}`);
  // Une ambiguïté tranchée par l'IA : seulement parmi les candidats observés.
  if (decision !== undefined && candidates.length > 1) {
    const chosen = candidates.find((candidate) => sameWord(candidate, decision));
    if (chosen)
      return {
        entity: chosen,
        candidates,
        evidence: [...evidence, `AI chose "${chosen}" among the observed candidates`],
        ai: true,
      };
  }
  if (strong.length === 1 && strong[0]) return { entity: strong[0], candidates: strong, evidence, ai: false };
  if (strong.length === 0) return { candidates, evidence, ai: false };
  return {
    candidates,
    evidence: [...evidence, 'several entities are possible: none is retained'],
    ai: false,
  };
}

/** Sans doublon, au singulier et sans accents près (demandes / demande). */
function unique(words: readonly string[]): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const word of words) {
    const key = fold(word);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(word);
  }
  return kept;
}

/** Les noms d'entité que l'écran dit autour de l'action (« Nouvelle demande », « Créer le dossier »). */
export function entityHintsOf(text: string): string[] {
  const hints: string[] = [];
  for (const match of text.matchAll(ENTITY_VERB)) {
    const word = match[1]?.toLowerCase();
    if (word && !/^(recherche|search|nouvelle|nouveau|new)$/i.test(word)) hints.push(singular(word));
  }
  return [...new Set(hints)];
}

function contextOf(
  actions: readonly SemanticRecordedAction[],
  index: number,
  before: RecordedState | undefined,
): { hints: string[] } {
  const texts: string[] = [];
  // Les actions depuis la dernière écriture (le formulaire de cette création), au plus 8.
  for (let cursor = index; cursor >= 0 && cursor > index - 8; cursor -= 1) {
    const action = actions[cursor];
    if (!action) break;
    if (cursor !== index && action.network.some((exchange) => WRITE.has(exchange.method))) break;
    texts.push(labelOf(action));
  }
  if (before) texts.push(before.title, ...before.headings);
  return { hints: [...new Set(texts.flatMap(entityHintsOf))] };
}

function identifierOf(
  write: FunctionalExchange | undefined,
  domTexts: readonly string[],
  action: SemanticRecordedAction,
  digest: ((value: string) => string) | undefined,
): BusinessIdentifier | undefined {
  const ids = write?.identifiers ?? [];
  const preferred =
    ids.find((id) => id.source === 'response' && /^(data\.)?(id|uuid)$/i.test(id.field)) ??
    ids.find((id) => id.source === 'response') ??
    ids.find((id) => id.source === 'location');
  if (preferred) return fromExchange(preferred);
  // Un identifiant affiché après l'action (« Demande 12345 créée »), à côté d'un mot de réussite.
  for (const text of domTexts.filter((entry) => SUCCESS.test(entry) || /#\s?\d/.test(entry))) {
    const token = identifierTokens(text)[0];
    if (token) return { value: token, ...(digest ? { digest: digest(token) } : {}), source: 'dom' };
  }
  // La page de l'entité créée (/demandes/12345).
  for (const route of action.navigation?.routes ?? []) {
    const last = route.split('?')[0]?.split('/').filter(Boolean).at(-1);
    if (last && /^\d{3,}$/.test(last))
      return { value: last, ...(digest ? { digest: digest(last) } : {}), source: 'url' };
  }
  return undefined;
}

function fromExchange(id: ExchangeIdentifier): BusinessIdentifier {
  return {
    digest: id.digest,
    ...(id.value !== undefined ? { value: id.value } : {}),
    source: id.source === 'response' ? 'network' : id.source,
    field: id.field,
  };
}

function labelOf(action: SemanticRecordedAction): string {
  return action.target?.label ?? action.route ?? '';
}

function hasPathId(path: string): boolean {
  const last = path.split('/').filter(Boolean).at(-1) ?? '';
  return /^\d+$/.test(last) || /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(last);
}

function emptyEvidence(): BusinessEvidence {
  return { network: [], dom: [], navigation: [], context: [] };
}

function singular(word: string): string {
  const lower = word.toLowerCase();
  if (/(ss|us)$/.test(lower)) return lower;
  if (/[^s]s$/.test(lower) || (/x$/.test(lower) && lower.length > 4)) return lower.slice(0, -1);
  return lower;
}

function fold(word: string): string {
  return word.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function sameWord(a: string, b: string): boolean {
  return fold(singular(a)) === fold(singular(b));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
