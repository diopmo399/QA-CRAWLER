import { isBusinessCandidate, technicalCategoryOf } from '../business/entity-classifier.js';
import type { EntityCorrelation } from '../business/entity-correlation.js';
import type { EntityEvidence } from '../business/entity-evidence.js';
import type { LifecycleKind, TrackedEntity } from '../business/entity-tracker.js';
import { assessRole, roleSignalsOf, type RoleAssessment } from '../business/identity-role.js';
import { collectionOf, identityInPath, round, routePattern, sameValue } from '../business/signals.js';
import type { RawRecordedEvent, RecordedFlowStep, RecordedState, SemanticRecordedAction } from '../model.js';
import { identityTypeOf, observeCollections, selectedRecord, shownValuesOf } from './collection-observer.js';
import {
  contextChange,
  pathOf,
  shellHostsOf,
  signatureOf,
  type ContextSignature,
} from './context-detector.js';
import {
  statusOf,
  type ActionView,
  type ApplicationContext,
  type ApplicationInteractionModel,
  type BusinessAction,
  type BusinessActionKind,
  type CollectionRecord,
  type IdentityCandidate,
  type InteractionEvidence,
  type ModelEntity,
  type Task,
  type TaskWorkspace,
  type TechnicalItem,
  type WorkCollection,
} from './model.js';
import { RelationshipEngine } from './relationship-engine.js';

/**
 * APPLICATION MODEL BUILDER : des observations du Recorder (actions, écrans, réseau) et de la
 * couche entité (identités, provenance) au modèle de l'application — contextes, espace de travail,
 * tasks, entités, relations, actions métier. Pure et déterministe : le rejeu, la validation et le
 * crawler peuvent l'appeler sur leurs propres observations.
 *
 * Il n'invente rien : une task est un enregistrement lu (ou affiché) que l'humain a SÉLECTIONNÉ et
 * qui a ouvert un autre contexte — ou qu'une lecture après une création relie à la nouvelle entité ;
 * une relation n'existe qu'avec ses preuves ; une valeur qui désigne plusieurs entités reste
 * incertaine.
 */
export interface ApplicationModelInput {
  actions: readonly SemanticRecordedAction[];
  states: readonly RecordedState[];
  rawEvents: readonly RawRecordedEvent[];
  steps?: readonly RecordedFlowStep[];
  /** La couche entité (business/entity-tracker.ts) : identités, provenance, cycle de vie. */
  entities?: readonly TrackedEntity[];
  entityEvidence?: readonly EntityEvidence[];
  initialStateId?: string;
  digest?: (value: string) => string;
  /** Des relations incertaines tranchées (IA facultative) : `${source}|${type}` → cible candidate. */
  relationshipDecisions?: ReadonlyMap<string, string>;
  /** Les corrélations par données métier (business/entity-correlation.ts). */
  correlations?: readonly EntityCorrelation[];
}

const LIFECYCLE_ACTION: Partial<Record<LifecycleKind, BusinessActionKind>> = {
  CREATE: 'CREATE',
  SEARCH: 'SEARCH',
  RETRIEVE: 'RETRIEVE',
  OPEN: 'OPEN',
  UPDATE: 'UPDATE',
  SAVE: 'SAVE',
  DELETE: 'DELETE',
};

/** Les gestes qui posent un critère (un champ, une liste de choix, une case). */
const CRITERIA_INPUT: ReadonlySet<SemanticRecordedAction['type']> = new Set([
  'FILL',
  'SELECT',
  'CHECK',
  'UNCHECK',
]);

export function buildApplicationModel(input: ApplicationModelInput): ApplicationInteractionModel {
  const { actions, states } = input;
  const evidence: InteractionEvidence[] = [];
  const rawById = new Map(input.rawEvents.map((event) => [event.id, event]));
  const stateById = new Map(states.map((state) => [state.id, state]));
  const addEvidence = (entry: Omit<InteractionEvidence, 'id'>): string => {
    const id = `x${String(evidence.length + 1)}`;
    evidence.push({ id, ...entry });
    return id;
  };
  const stepOf = (actionIds: readonly string[]): string[] => [
    ...new Set(
      (input.steps ?? [])
        .filter((step) => step.actionIds.some((id) => actionIds.includes(id)))
        .map((step) => step.id),
    ),
  ];
  const actionEvidence = (
    description: string,
    action: SemanticRecordedAction,
    source: InteractionEvidence['source'],
  ): string =>
    addEvidence({
      source,
      description,
      actionIds: [action.id],
      rawEventIds: action.rawEventIds,
      stateIds: [action.stateBefore, action.stateAfter].filter((id): id is string => id !== undefined),
    });

  // ---------------------------------------------------------------- 1. contextes applicatifs
  const shell = shellHostsOf(states);
  const signatures = new Map(states.map((state) => [state.id, signatureOf(state, shell)]));
  const contexts = new Map<string, ApplicationContext>();
  const touch = (signature: ContextSignature, stateId: string, actionId?: string): ApplicationContext => {
    const context = contexts.get(signature.key) ?? {
      key: signature.key,
      classification: 'APPLICATION_CONTEXT' as ApplicationContext['classification'],
      kind: signature.kind,
      name: signature.name,
      routes: [],
      ...(signature.origin ? { origin: signature.origin } : {}),
      ...(signature.frame ? { frame: signature.frame } : {}),
      hosts: signature.hosts,
      stateIds: [],
      actionIds: [],
      evidenceIds: [],
    };
    if (!context.routes.includes(signature.route)) context.routes.push(signature.route);
    if (!context.stateIds.includes(stateId)) context.stateIds.push(stateId);
    if (actionId && !context.actionIds.includes(actionId)) context.actionIds.push(actionId);
    contexts.set(signature.key, context);
    return context;
  };
  const initial = input.initialStateId ? signatures.get(input.initialStateId) : undefined;
  if (initial && input.initialStateId) touch(initial, input.initialStateId);
  /** Le contexte avant / après chaque action (l'écran d'avant, sinon celui d'après l'action précédente). */
  const before: (ContextSignature | undefined)[] = [];
  const after: (ContextSignature | undefined)[] = [];
  let current = initial;
  for (const [index, action] of actions.entries()) {
    // Le contexte AVANT : celui où l'action précédente a laissé l'écran (l'écran d'avant observé ne
    // sert qu'au début). Le contexte APRÈS : l'écran observé — sauf s'il l'a été après le début du
    // geste suivant (il montre alors l'effet du suivant).
    const was = current ?? (action.stateBefore ? signatures.get(action.stateBefore) : undefined);
    const next = actions[index + 1];
    const observation = rawById.get(action.rawEventIds.at(-1) ?? '')?.observationId;
    const observedAt = action.stateAfter ? stateById.get(action.stateAfter)?.observedAt : undefined;
    // Un écran observé APRÈS le début du geste suivant (même observation, ou observation tardive)
    // montre aussi l'effet du suivant : il n'est pas l'effet de celui-ci.
    const closed =
      next !== undefined &&
      ((observation !== undefined &&
        rawById.get(next.rawEventIds.at(-1) ?? '')?.observationId === observation) ||
        (observedAt !== undefined && observedAt > next.at));
    const now = (!closed && action.stateAfter ? signatures.get(action.stateAfter) : undefined) ?? was;
    before[index] = was;
    after[index] = now;
    if (was) {
      const context = contexts.get(was.key);
      if (context && !context.actionIds.includes(action.id)) context.actionIds.push(action.id);
      else if (!context && action.stateBefore) touch(was, action.stateBefore, action.id);
    }
    if (now && action.stateAfter && !closed) touch(now, action.stateAfter);
    current = now;
  }
  const businessActions: Omit<BusinessAction, 'id'>[] = [];
  const switchAt = new Map<number, { from: ContextSignature; to: ContextSignature; evidenceId: string }>();
  for (const [index, action] of actions.entries()) {
    const from = before[index];
    const to = after[index];
    if (!from || !to || from.key === to.key) continue;
    const evidenceId = actionEvidence(
      `context switch: ${contextChange(from, to)}`,
      action,
      to.kind === 'FRAME' ? 'FRAME' : 'NAVIGATION',
    );
    contexts.get(to.key)?.evidenceIds.push(evidenceId);
    // Un écran d'authentification, de configuration… est un contexte TECHNIQUE : observé, jamais une
    // étape du parcours applicatif (il reste dans le Technical Context).
    const technicalRoute = technicalCategoryOf(to.frame ?? to.route);
    if (technicalRoute) {
      const context = contexts.get(to.key);
      if (context) context.classification = 'TECHNICAL_CONTEXT';
      continue;
    }
    switchAt.set(index, { from, to, evidenceId });
    businessActions.push({
      kind: 'SWITCH_CONTEXT',
      subject: to.key,
      contextKey: from.key,
      actionIds: [action.id],
      stepIds: stepOf([action.id]),
      confidence: 0.9,
      status: 'OBSERVED',
      reason: `${from.name} → ${to.name} (${contextChange(from, to)})`,
      evidenceIds: [evidenceId],
    });
  }
  for (const [index, action] of actions.entries())
    if (action.type === 'NAVIGATE' && action.gotoReason && action.gotoReason !== 'INITIAL_NAVIGATION')
      businessActions.push({
        kind: 'NAVIGATE',
        ...(after[index] ? { subject: after[index].key } : {}),
        ...(before[index] ? { contextKey: before[index].key } : {}),
        actionIds: [action.id],
        stepIds: stepOf([action.id]),
        confidence: 0.9,
        status: 'OBSERVED',
        reason: `navigation ${action.route ?? action.url} (${action.gotoReason})`,
        evidenceIds: [
          actionEvidence(
            `navigation to ${action.route ?? action.url} (${action.gotoReason})`,
            action,
            'NAVIGATION',
          ),
        ],
      });

  // ---------------------------------------------------------------- 2. entités (couche entité) et leurs valeurs
  const entityEvidence = new Map((input.entityEvidence ?? []).map((entry) => [entry.id, entry]));
  const entities = [...(input.entities ?? [])];
  const valuesOf = new Map(
    entities.map((entity) => [
      entity.key,
      [
        entity.identity,
        ...entity.aliases,
        ...entity.evidenceIds.flatMap((id) => {
          const identity = entityEvidence.get(id)?.identity;
          return identity ? [identity] : [];
        }),
      ],
    ]),
  );
  const entitiesMatching = (candidate: { value?: string; digest?: string }): TrackedEntity[] =>
    entities.filter((entity) =>
      (valuesOf.get(entity.key) ?? []).some(
        (identity) =>
          (candidate.digest !== undefined && identity.digest === candidate.digest) ||
          (candidate.value !== undefined &&
            identity.value !== undefined &&
            sameValue(identity.value, candidate.value)),
      ),
    );
  /** L'action qui a PRODUIT l'identité (preuve NEW_ENTITY_ID), pas la dernière du geste. */
  const creationIndex = (entity: TrackedEntity): number | undefined => {
    const produced = entity.evidenceIds
      .map((id) => entityEvidence.get(id))
      .find((entry) => entry?.type === 'NEW_ENTITY_ID');
    return produced?.actionId ? actions.findIndex((action) => action.id === produced.actionId) : undefined;
  };
  /**
   * Une entité qui a une existence propre (une ressource d'URL / d'API, une création prouvée) — par
   * opposition à une valeur vue seulement dans le texte de l'élément cliqué.
   */
  const substantial = (entity: TrackedEntity): boolean =>
    entity.resources.length > 0 || entity.provenance.classification === 'CREATED_DURING_RECORDING';
  const resourceOfPath = (path: string): string | undefined =>
    identityInPath(path)?.resource ?? collectionOf(path);
  /** Un enregistrement qui EST l'entité (sa propre liste, des résultats de recherche), pas un élément de travail. */
  const represents = (
    collection: WorkCollection,
    record: CollectionRecord,
    entity: TrackedEntity,
  ): boolean => {
    if (collection.searchResults) return true;
    const resource =
      collection.source.type === 'NETWORK' ? resourceOfPath(collection.source.path) : undefined;
    if (resource && entity.resources.includes(resource)) return true;
    const primary = record.identityCandidates[0];
    return (
      record.identityCandidates.length === 1 &&
      primary !== undefined &&
      substantial(entity) &&
      entitiesMatching(primary).includes(entity)
    );
  };

  // ---------------------------------------------------------------- 3. collections lues, sélections, tasks
  const collections = observeCollections(actions, (description, action) =>
    actionEvidence(description, action, 'NETWORK'),
  );
  for (const collection of collections) {
    const first = collection.observations[0];
    const where = first ? after[first.actionIndex] : undefined;
    if (where) collection.contextKey = where.key;
  }
  const relations = new RelationshipEngine(input.relationshipDecisions);
  const workspaces = new Map<string, TaskWorkspace>();
  const tasks = new Map<string, Task>();
  /** Les identités des tasks : une entité qui n'est que la task vue à l'écran n'est pas une entité. */
  const taskValues: IdentityCandidate[] = [];

  const workspaceFor = (
    collection: WorkCollection,
    reason: string,
    evidenceIds: string[],
    confidence: number,
  ): TaskWorkspace => {
    const key = `workspace:${collection.key.replace(/^collection:/, '')}`;
    const existing = workspaces.get(key);
    if (existing) {
      existing.evidenceIds = [...new Set([...existing.evidenceIds, ...evidenceIds])];
      existing.confidence = Math.max(existing.confidence, confidence);
      existing.status = statusOf(existing.confidence, existing.evidenceIds.length);
      return existing;
    }
    const workspace: TaskWorkspace = {
      key,
      type: 'TASK_WORKSPACE',
      classification: 'APPLICATION_ENTITY',
      ...(collection.contextKey ? { contextKey: collection.contextKey } : {}),
      collectionKey: collection.key,
      source:
        collection.source.type === 'NETWORK'
          ? { type: 'NETWORK', path: collection.source.path }
          : { type: 'DOM' },
      taskKeys: [],
      confidence,
      status: statusOf(confidence, evidenceIds.length),
      reason,
      evidenceIds: [...evidenceIds],
    };
    workspaces.set(key, workspace);
    return workspace;
  };
  const taskFor = (
    workspace: TaskWorkspace,
    record: CollectionRecord,
    confidence: number,
    reason: string,
    evidenceIds: string[],
    shown: readonly string[] = [],
    actionId?: string,
  ): Task => {
    const candidates = withRoles(record.identityCandidates, shown, actionId).map((candidate, index) =>
      index === 0 ? { ...candidate, type: 'TASK_ID' as const } : candidate,
    );
    const primary = candidates[0] ?? { type: 'TASK_ID' as const, source: 'DOM' as const, confidence: 0 };
    const key = `task:${workspace.key.replace(/^workspace:/, '')}:${primary.value ?? `#${(primary.digest ?? '').slice(0, 8)}`}`;
    const existing = tasks.get(key);
    if (existing) {
      existing.evidenceIds = [...new Set([...existing.evidenceIds, ...evidenceIds])];
      existing.confidence = Math.max(existing.confidence, confidence);
      existing.status = statusOf(existing.confidence, existing.evidenceIds.length);
      // Une relecture peut apporter une identité de plus (la clé métier, après une création).
      for (const candidate of candidates.slice(1))
        if (
          !existing.identityCandidates.some(
            (known) => known.digest === candidate.digest && known.field === candidate.field,
          )
        )
          existing.identityCandidates.push(candidate);
      return existing;
    }
    const task: Task = {
      key,
      classification: 'APPLICATION_ENTITY',
      workspaceKey: workspace.key,
      identityCandidates: candidates,
      primary,
      selectedBy: [],
      confidence,
      status: statusOf(confidence, evidenceIds.length),
      reason,
      evidenceIds: [...evidenceIds],
    };
    tasks.set(key, task);
    taskValues.push(primary);
    if (!workspace.taskKeys.includes(key)) workspace.taskKeys.push(key);
    relations.add({
      type: 'CONTAINS',
      source: workspace.key,
      target: key,
      confidence: 0.9,
      reason: `the record is part of ${workspace.collectionKey.replace(/^collection:/, '')}`,
      evidenceIds,
      observed: true,
    });
    if (workspace.source.type === 'NETWORK')
      relations.add({
        type: 'RETRIEVED_BY',
        source: key,
        target: `api:${workspace.collectionKey.replace(/^collection:/, '')}`,
        confidence: 0.95,
        reason: `served by ${workspace.collectionKey.replace(/^collection:/, '')}`,
        evidenceIds,
        observed: true,
      });
    return task;
  };
  /**
   * LE RÔLE des identités d'un enregistrement, par preuves (jamais par le nom du champ) : la valeur
   * est l'identité d'une autre entité observée → REFERENCE ; montrée dans l'élément cliqué → une clé
   * que l'humain connaît ; sinon réseau seul. Le principal est la valeur montrée qui n'est pas une
   * référence (sinon la première qui n'en est pas une).
   */
  const withRoles = (
    candidates: readonly IdentityCandidate[],
    shown: readonly string[],
    actionId?: string,
  ): IdentityCandidate[] => {
    const assessed = candidates.map((candidate) => {
      const references = entitiesMatching(candidate).filter(substantial);
      const visible = shown.some(
        (value) =>
          (candidate.value !== undefined && sameValue(candidate.value, value)) ||
          (input.digest !== undefined &&
            candidate.digest !== undefined &&
            input.digest(value) === candidate.digest),
      );
      const at = actionId ? { actionId } : {};
      const role = assessRole({
        network: [{ ...at, where: `field "${candidate.field ?? '?'}" of a record read on the network` }],
        ...(visible ? { shown: [{ ...at, where: 'shown by the clicked element' }] } : {}),
        ...(references.length
          ? {
              references: [
                { ...at, where: `the identity of ${references.map((entity) => entity.key).join(', ')}` },
              ],
            }
          : {}),
      });
      return {
        candidate: {
          ...candidate,
          ...(references.length ? { type: 'REFERENCE' as const } : {}),
          ...roleFields(role),
        },
        visible,
        reference: references.length > 0,
      };
    });
    const primary =
      assessed.findIndex((entry) => entry.visible && !entry.reference) >= 0
        ? assessed.findIndex((entry) => entry.visible && !entry.reference)
        : Math.max(
            0,
            assessed.findIndex((entry) => !entry.reference),
          );
    const [head] = assessed.splice(primary, 1);
    return [...(head ? [head] : []), ...assessed].map((entry, index) =>
      index === 0 && entry.candidate.type === 'REFERENCE'
        ? { ...entry.candidate, type: identityTypeOf(entry.candidate.value, true) }
        : entry.candidate,
    );
  };
  /** La task RÉFÉRENCE une entité par la valeur d'un de ses champs (le nom du champ n'importe pas). */
  const referencesOf = (task: Task, evidenceIds: string[]): void => {
    for (const candidate of task.identityCandidates.slice(1)) {
      const matches = entitiesMatching(candidate).filter((entity) => !isTaskShadow(entity));
      if (matches.length === 0) continue;
      const numeric = candidate.value !== undefined && /^\d+$/.test(candidate.value);
      relations.add({
        type: 'REFERENCES',
        source: task.key,
        target:
          matches.length === 1 && matches[0]
            ? matches[0].key
            : matches.map((entity) => entity.key).join(' | '),
        confidence: numeric ? 0.75 : 0.9,
        reason: `field ${candidate.field ?? '?'} = ${candidate.value ?? '(same salted digest)'} is the identity of ${
          matches.length === 1 ? (matches[0]?.key ?? '') : `${String(matches.length)} entities`
        }`,
        evidenceIds: [
          ...evidenceIds,
          ...matches.flatMap((entity) => entity.evidenceIds.slice(0, 2)).map(entityRef),
        ],
        ...(matches.length > 1 ? { candidates: matches.map((entity) => entity.key) } : {}),
      });
    }
  };
  const entityRef = (id: string): string => {
    const known = evidence.find((entry) => entry.ref === id);
    if (known) return known.id;
    const source = entityEvidence.get(id);
    return addEvidence({
      source: 'ENTITY_EVIDENCE',
      description: source?.description ?? id,
      actionIds: source?.actionId ? [source.actionId] : [],
      rawEventIds: source?.rawEventIds ?? [],
      stateIds: [],
      ref: id,
    });
  };
  /** Une « entité » qui n'est que la task sélectionnée, vue à l'écran (son propre identifiant). */
  const isTaskShadow = (entity: TrackedEntity): boolean =>
    !substantial(entity) &&
    taskValues.some((value) =>
      (valuesOf.get(entity.key) ?? []).some(
        (identity) =>
          (value.digest !== undefined && identity.digest === value.digest) ||
          (value.value !== undefined &&
            identity.value !== undefined &&
            sameValue(identity.value, value.value)),
      ),
    );

  /** Les sélections : un clic qui montre la valeur d'un enregistrement lu juste avant (ou une ligne du DOM). */
  const selections: { index: number; task: Task; to?: ContextSignature }[] = [];
  for (const [index, action] of actions.entries()) {
    if (action.type !== 'CLICK') continue;
    const raw = rawById.get(action.rawEventIds.at(-1) ?? '');
    const shown = shownValuesOf(action, raw);
    if (shown.length === 0) continue;
    const switched = switchAt.get(index) ?? switchAt.get(index + 1);
    let picked: { collection: WorkCollection; record: CollectionRecord } | undefined;
    // La lecture la plus récente AVANT ce clic (jamais celle que le clic déclenche), dans le contexte affiché.
    const readable = collections
      .filter((collection) => collection.observations.some((entry) => entry.actionIndex < index))
      .sort(
        (a, b) =>
          Math.max(
            ...b.observations.filter((entry) => entry.actionIndex < index).map((entry) => entry.actionIndex),
          ) -
          Math.max(
            ...a.observations.filter((entry) => entry.actionIndex < index).map((entry) => entry.actionIndex),
          ),
      );
    for (const collection of readable) {
      const found = selectedRecord(shown, collection, input.digest);
      if (found) {
        picked = { collection, record: found.record };
        break;
      }
    }
    // Sans réseau : la ligne cliquée elle-même (ses valeurs affichées) — seulement si elle ouvre un contexte.
    if (!picked && switched && (raw?.element?.row || raw?.element?.rowKey?.length)) {
      const domKey = `collection:DOM ${before[index]?.key ?? 'screen'}`;
      let collection = collections.find((entry) => entry.key === domKey);
      if (!collection) {
        collection = {
          key: domKey,
          source: { type: 'DOM' },
          records: [],
          ...(before[index] ? { contextKey: before[index].key } : {}),
          observations: [],
          searchResults: false,
        };
        collections.push(collection);
      }
      const record: CollectionRecord = {
        index: collection.records.length,
        identityCandidates: shown.map((value, position) => ({
          type: position === 0 ? 'ID' : identityTypeOf(value, false),
          value,
          ...(input.digest ? { digest: input.digest(value) } : {}),
          source: 'DOM' as const,
          confidence: 0.6,
          // Montrée à l'utilisateur dans la ligne cliquée : une clé qu'il connaît.
          ...roleFields(assessRole({ shown: [{ actionId: action.id, where: 'the clicked row shows it' }] })),
        })),
      };
      collection.records.push(record);
      collection.observations.push({
        actionId: action.id,
        actionIndex: index,
        recordCount: 1,
        evidenceId: actionEvidence(`the clicked row shows ${shown.join(', ')}`, action, 'DOM'),
      });
      picked = { collection, record };
    }
    if (!picked || !switched) continue;
    const { collection, record } = picked;
    const matched = record.identityCandidates.flatMap((candidate) => entitiesMatching(candidate));
    if (matched.some((entity) => represents(collection, record, entity))) continue;
    const observed = collection.observations.filter((entry) => entry.actionIndex <= index).at(-1);
    const selectEvidence = actionEvidence(
      `"${clip(action.target?.label ?? '')}" shows ${shown.join(', ')}: a record of ${collection.key.replace(/^collection:/, '')}; it opened ${switched.to.name}`,
      action,
      'USER_ACTION',
    );
    const evidenceIds = [...(observed ? [observed.evidenceId] : []), selectEvidence, switched.evidenceId];
    const network = collection.source.type === 'NETWORK';
    const confidence = network ? 0.85 : 0.6;
    const workspace = workspaceFor(
      collection,
      `a list of selectable work items: selecting one opens another application context${network ? ' (records served by the network)' : ' (rows of the screen only: no list read on the network matched it — read before the recording, host not allowed, or unreadable response)'}`,
      evidenceIds,
      confidence,
    );
    const task = taskFor(
      workspace,
      record,
      confidence,
      `selected by the user in ${workspace.key.replace(/^workspace:/, '')}; it opened ${switched.to.name}`,
      evidenceIds,
      shown,
      action.id,
    );
    task.selectedBy.push(action.id);
    selections.push({ index, task, to: switched.to });
    relations.add({
      type: 'DISPLAYS',
      source: workspace.contextKey ?? workspace.key,
      target: task.key,
      confidence: 0.9,
      reason: `the clicked element shows ${shown.join(', ')}`,
      evidenceIds: [selectEvidence],
      actionIds: [action.id],
      observed: true,
    });
    relations.add({
      type: 'NAVIGATES_TO',
      source: task.key,
      target: switched.to.key,
      confidence: 0.9,
      reason: `selecting the task opened ${switched.to.name} (${contextChange(switched.from, switched.to)})`,
      evidenceIds: [selectEvidence, switched.evidenceId],
      actionIds: [action.id],
      observed: true,
    });
    businessActions.push({
      kind: 'SELECT_TASK',
      subject: task.key,
      contextKey: switched.from.key,
      actionIds: [action.id],
      stepIds: stepOf([action.id]),
      confidence,
      status: statusOf(confidence, evidenceIds.length, true),
      reason: task.reason,
      evidenceIds,
    });
    referencesOf(task, evidenceIds);
  }

  // FILTER : des critères saisis DANS l'espace de travail, puis la même liste relue (quelle que soit
  // la méthode) ou ses lignes changent, sans quitter le contexte. Les valeurs saisies ne sont jamais
  // des entités ni écrites : seuls les libellés des champs sont gardés.
  const rowsOf = (stateId: string | undefined): number | undefined =>
    stateId ? stateById.get(stateId)?.tableRows : undefined;
  for (const workspace of workspaces.values()) {
    if (!workspace.contextKey) continue;
    const collection = collections.find((entry) => entry.key === workspace.collectionKey);
    let criteria: number[] = [];
    for (const [index, action] of actions.entries()) {
      if (before[index]?.key !== workspace.contextKey || switchAt.has(index)) {
        criteria = [];
        continue;
      }
      if (CRITERIA_INPUT.has(action.type)) criteria.push(index);
      if (criteria.length === 0) continue;
      const reread = collection?.observations.find((entry) => entry.actionIndex === index);
      const rowsBefore = rowsOf(action.stateBefore);
      const rowsAfter = rowsOf(action.stateAfter);
      // Les lignes qui changent ne comptent que pour un geste qui déclenche (un clic) : pendant une
      // saisie, la liste peut encore finir de se charger (l'écran d'avant est alors périmé).
      const rowsChanged =
        !CRITERIA_INPUT.has(action.type) &&
        rowsBefore !== undefined &&
        rowsAfter !== undefined &&
        rowsBefore !== rowsAfter;
      if (!reread && !rowsChanged) continue;
      const labels = [
        ...new Set(
          criteria
            .map((position) => actions[position]?.target?.label)
            .filter((label): label is string => !!label),
        ),
      ].map((label) => `"${clip(label)}"`);
      const named = labels.join(', ') || 'criteria';
      const ids = criteria
        .map((position) => actions[position]?.id)
        .filter((id): id is string => id !== undefined);
      if (!ids.includes(action.id)) ids.push(action.id);
      const evidenceIds = [
        ...(reread ? [reread.evidenceId] : []),
        actionEvidence(
          reread
            ? `${named} then ${collection?.key.replace(/^collection:/, '') ?? 'the list'} read again (${String(reread.recordCount)} records), same context`
            : `${named} then the rows changed (${String(rowsBefore)} → ${String(rowsAfter)}), same context`,
          action,
          reread ? 'NETWORK' : 'DOM',
        ),
      ];
      const confidence = reread ? 0.8 : 0.6;
      businessActions.push({
        kind: 'FILTER',
        subject: workspace.key,
        contextKey: workspace.contextKey,
        actionIds: ids,
        stepIds: stepOf(ids),
        confidence,
        status: statusOf(confidence, evidenceIds.length, true),
        reason: `the work list is narrowed by ${named}: the typed values are criteria, not entities`,
        evidenceIds,
      });
      criteria = [];
    }
  }

  // ---------------------------------------------------------------- 4. entités : contextes, création, retour à la liste
  // OBSERVE, CLASSIFY, puis CORRELATE : seules les entités métier (ou encore inconnues) entrent dans
  // le Business Context ; le technique et l'infrastructure vont dans le Technical Context.
  const keptEntities = entities.filter(
    (entity) => !isTaskShadow(entity) && isBusinessCandidate(entity.classification.classification),
  );
  // OBSERVED ≠ BUSINESS : seules les entités MÉTIER démontrées portent des actions métier ; une
  // entité UNKNOWN reste une observation (gardée, avec ses preuves), jamais une étape du flow métier.
  const businessEntities = keptEntities.filter(
    (entity) => entity.classification.classification === 'BUSINESS_ENTITY',
  );
  for (const entity of businessEntities) {
    const created = creationIndex(entity);
    for (const step of entity.lifecycle) {
      const kind = LIFECYCLE_ACTION[step.kind];
      if (!kind) continue;
      // CREATE seulement pour une création PROUVÉE (provenance CREATED_DURING_RECORDING) :
      // une première observation n'est jamais une création.
      if (kind === 'CREATE' && entity.provenance.classification !== 'CREATED_DURING_RECORDING') continue;
      const indexes = step.actionIds
        .map((id) => actions.findIndex((action) => action.id === id))
        .filter((value) => value >= 0);
      const created = kind === 'CREATE' ? creationIndex(entity) : undefined;
      const last = created !== undefined && created >= 0 ? created : Math.max(...indexes);
      const context = kind === 'OPEN' ? after[last] : before[last];
      const evidenceIds = step.evidenceIds.slice(0, 4).map(entityRef);
      businessActions.push({
        kind,
        subject: entity.key,
        ...(context ? { contextKey: context.key } : {}),
        actionIds: step.actionIds,
        stepIds: step.stepIds.length ? step.stepIds : stepOf(step.actionIds),
        confidence: step.confidence,
        status: statusOf(step.confidence, evidenceIds.length),
        reason:
          kind === 'CREATE'
            ? `provenance ${entity.provenance.classification}: ${entity.provenance.reason}`
            : `${kind.toLowerCase()} of ${entity.key} (${step.kind})`,
        evidenceIds,
      });
      if (!context) continue;
      const relationType =
        kind === 'CREATE'
          ? 'CREATED_BY'
          : kind === 'OPEN'
            ? 'OPENED_BY'
            : kind === 'SEARCH'
              ? 'SEARCHED_BY'
              : kind === 'RETRIEVE'
                ? 'RETRIEVED_BY'
                : 'UPDATED_BY';
      const byAction = kind === 'SEARCH' || kind === 'RETRIEVE';
      relations.add({
        type: relationType,
        source: entity.key,
        target: byAction ? `action:${step.actionIds.at(-1) ?? ''}` : context.key,
        confidence: 0.85,
        reason: `${kind.toLowerCase()} happened in ${context.name}`,
        evidenceIds,
        actionIds: step.actionIds,
      });
    }
    // RESULTS_IN : l'entité créée dans le contexte ouvert par la sélection d'une task.
    if (created !== undefined && created >= 0) {
      const selection = [...selections].reverse().find((entry) => entry.index < created);
      if (selection) {
        const returned = [...switchAt.entries()].some(
          ([index, change]) =>
            index > selection.index &&
            index < created &&
            change.to.key === (workspaces.get(selection.task.workspaceKey)?.contextKey ?? ''),
        );
        if (!returned) {
          const createAction = actions[created];
          relations.add({
            type: 'RESULTS_IN',
            source: selection.task.key,
            target: entity.key,
            confidence: 0.65,
            reason: `${entity.key} was created in ${selection.to?.name ?? 'the context'} opened by selecting the task (temporal + context chain)`,
            evidenceIds: [
              ...selection.task.evidenceIds.slice(-1),
              ...entity.lifecycle
                .filter((step) => step.kind === 'CREATE')
                .flatMap((step) => step.evidenceIds.slice(0, 2))
                .map(entityRef),
            ],
            actionIds: [...selection.task.selectedBy, ...(createAction ? [createAction.id] : [])],
          });
        }
      }
    }
  }
  // CREATE_RESULT / RETRIEVE : une lecture APRÈS la création sert un enregistrement qui porte la nouvelle identité.
  for (const entity of businessEntities) {
    const created = creationIndex(entity);
    if (
      created === undefined ||
      created < 0 ||
      entity.provenance.classification !== 'CREATED_DURING_RECORDING'
    )
      continue;
    for (const collection of collections) {
      const later = collection.observations.filter((entry) => entry.actionIndex > created);
      if (later.length === 0) continue;
      for (const record of collection.records) {
        const carrier = record.identityCandidates.find((candidate) =>
          entitiesMatching(candidate).includes(entity),
        );
        if (!carrier || represents(collection, record, entity)) continue;
        const observation = later.at(-1);
        if (!observation) continue;
        const known = [...workspaces.values()].find((entry) => entry.collectionKey === collection.key);
        const workspace =
          known ??
          workspaceFor(
            collection,
            'records read after a creation carry the new identity under another resource: a list of work items (not selected yet)',
            [observation.evidenceId],
            0.7,
          );
        const task = taskFor(
          workspace,
          record,
          known ? 0.85 : 0.7,
          `listed by ${collection.key.replace(/^collection:/, '')} after the creation of ${entity.key}`,
          [observation.evidenceId],
        );
        const evidenceIds = [
          observation.evidenceId,
          ...entity.lifecycle
            .filter((step) => step.kind === 'CREATE')
            .flatMap((step) => step.evidenceIds.slice(0, 2))
            .map(entityRef),
        ];
        relations.add({
          type: 'CREATE_RESULT',
          source: entity.key,
          target: task.key,
          confidence: 0.85,
          reason: `after the creation, ${collection.key.replace(/^collection:/, '')} lists a record whose ${carrier.field ?? 'value'} = ${carrier.value ?? '(same salted digest)'} is the new identity (the task id need not be the same)`,
          evidenceIds,
          actionIds: [observation.actionId],
        });
        referencesOf(task, [observation.evidenceId]);
        const action = actions[observation.actionIndex];
        businessActions.push({
          kind: 'RETRIEVE',
          subject: entity.key,
          ...(after[observation.actionIndex] ? { contextKey: after[observation.actionIndex]?.key } : {}),
          actionIds: action ? [action.id] : [],
          stepIds: action ? stepOf([action.id]) : [],
          confidence: 0.85,
          status: statusOf(0.85, evidenceIds.length),
          reason: `the created entity is listed again by ${collection.key.replace(/^collection:/, '')}`,
          evidenceIds,
        });
      }
    }
  }
  // SEARCH_MATCH : le résultat d'une recherche faite avec les données d'une création est la même
  // entité (EntityCorrelation) — ou des homonymes, laissés incertains avec leurs candidats.
  for (const correlation of input.correlations ?? []) {
    const evidenceId = addEvidence({
      source: 'NETWORK',
      description: `${correlation.id} ${correlation.status} ${String(correlation.confidence)}: ${correlation.evidence.join(' · ')}`,
      actionIds: [
        correlation.creation.actionId,
        ...correlation.query.actionIds,
        ...(correlation.open ? [correlation.open.actionId] : []),
      ],
      rawEventIds: [],
      stateIds: [],
    });
    const entity = keptEntities.find((candidate) =>
      (input.entityEvidence ?? []).some(
        (entry) => entry.details.correlation === correlation.id && candidate.evidenceIds.includes(entry.id),
      ),
    );
    relations.add({
      type: 'SEARCH_MATCH',
      source: entity?.key ?? `creation:${correlation.creation.actionId}`,
      target: `action:${correlation.query.actionId}`,
      confidence: correlation.confidence,
      reason: `the search ${correlation.query.api} was made with the creation data (${correlation.matched.map((entry) => `"${entry.label}"`).join(', ') || 'a single result'}): ${correlation.status === 'AMBIGUOUS' ? 'several results (homonyms) or a result seen before the creation — none chosen' : `result #${String(correlation.result?.index ?? '?')}${correlation.result?.identifiers[0]?.value ? ` (identity ${correlation.result.identifiers[0].value}, discovered here)` : ''}`}`,
      evidenceIds: [evidenceId],
      actionIds: [correlation.query.actionId],
      ...(correlation.candidates
        ? { candidates: correlation.candidates.map((index) => `result #${String(index)}`) }
        : {}),
    });
  }

  // Une même valeur dans deux entités distinctes (deux portées) : une corrélation, jamais une fusion.
  for (const [position, a] of keptEntities.entries())
    for (const b of keptEntities.slice(position + 1)) {
      const shared = (valuesOf.get(a.key) ?? []).find((x) =>
        (valuesOf.get(b.key) ?? []).some(
          (y) =>
            (x.digest !== undefined && x.digest === y.digest) ||
            (x.value !== undefined && y.value !== undefined && sameValue(x.value, y.value)),
        ),
      );
      if (!shared) continue;
      relations.add({
        type: 'CORRELATES_WITH',
        source: a.key,
        target: b.key,
        confidence: 0.5,
        reason: `the same value ${shared.value ?? '(same salted digest)'} identifies both, in different scopes (${a.resources.join('+') || 'unknown'} / ${b.resources.join('+') || 'unknown'}): not merged`,
        evidenceIds: [a.evidenceIds[0], b.evidenceIds[0]].filter((id): id is string => !!id).map(entityRef),
      });
    }

  // ---------------------------------------------------------------- 5. rôles des contextes, entités du modèle
  for (const workspace of workspaces.values()) {
    const context = workspace.contextKey ? contexts.get(workspace.contextKey) : undefined;
    if (context) context.role = 'WORKSPACE';
  }
  for (const change of switchAt.values()) {
    const context = contexts.get(change.to.key);
    if (context && !context.role) context.role = 'MICROFRONTEND';
  }
  const allRelations = relations.all;
  const modelEntities: ModelEntity[] = keptEntities.map((entity) => {
    const indexes = entity.actionIds
      .map((id) => actions.findIndex((action) => action.id === id))
      .filter((value) => value >= 0);
    const firstIndex = indexes.length ? Math.min(...indexes) : -1;
    const lastIndex = indexes.length ? Math.max(...indexes) : -1;
    const own = allRelations.filter(
      (relation) => relation.source === entity.key || relation.target === entity.key,
    );
    const identityOf = (identity: TrackedEntity['identity'], main: boolean): IdentityCandidate => ({
      type:
        identity.value !== undefined && /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(identity.value)
          ? 'UUID'
          : main
            ? 'ENTITY_ID'
            : identityTypeOf(identity.value, false),
      // Le RÔLE vient des preuves (montrée, saisie, réseau seul), jamais du nom du champ.
      ...roleFields(assessRole(roleSignalsOf(identity, [...entityEvidence.values()]))),
      evidenceIds: entity.evidenceIds
        .filter((id) => {
          const carried = entityEvidence.get(id)?.identity;
          return (
            carried !== undefined &&
            ((carried.digest !== undefined && carried.digest === identity.digest) ||
              (carried.value !== undefined && carried.value === identity.value))
          );
        })
        .slice(0, 6)
        .map(entityRef),
      ...(identity.field ? { field: identity.field } : {}),
      ...(identity.value !== undefined ? { value: identity.value } : {}),
      ...(identity.digest ? { digest: identity.digest } : {}),
      source:
        identity.source === 'NETWORK_RESPONSE' || identity.source === 'LOCATION_HEADER'
          ? 'NETWORK_RESPONSE'
          : identity.source === 'NETWORK_PATH'
            ? 'NETWORK_PATH'
            : identity.source === 'ROUTE' || identity.source === 'URL'
              ? 'ROUTE'
              : identity.source === 'USER_INPUT'
                ? 'USER_INPUT'
                : 'DOM',
      confidence: identity.confidence,
    });
    const contextKeys = new Set<string>();
    for (const index of indexes) {
      const where = before[index];
      const next = after[index];
      if (where) contextKeys.add(where.key);
      if (next) contextKeys.add(next.key);
    }
    return {
      key: entity.key,
      type: entity.type,
      identity: identityOf(entity.identity, true),
      identityCandidates: [entity.identity, ...entity.aliases].map((identity, index) =>
        identityOf(identity, index === 0),
      ),
      classification: {
        classification: entity.classification.classification,
        confidence: entity.classification.confidence,
        reason: entity.classification.reason,
        signals: entity.classification.signals,
        analyzer: entity.classification.analyzer,
      },
      provenance: {
        classification: entity.provenance.classification,
        confidence: entity.provenance.confidence,
        reason: entity.provenance.reason,
      },
      lifecycle: entity.lifecycle.map((step) => step.kind),
      firstSeen: {
        ...(actions[firstIndex] ? { actionId: actions[firstIndex].id } : {}),
        actionIndex: firstIndex,
      },
      lastSeen: {
        ...(actions[lastIndex] ? { actionId: actions[lastIndex].id } : {}),
        actionIndex: lastIndex,
      },
      tasks: [
        ...new Set(
          own
            .flatMap((relation) => [relation.source, relation.target])
            .filter((key) => key.startsWith('task:')),
        ),
      ],
      contexts: [...contextKeys],
      relationships: own.map((relation) => relation.id),
    };
  });

  // ---------------------------------------------------------------- 6. le flow métier, dans l'ordre du parcours
  const position = new Map(actions.map((action, index) => [action.id, index]));
  const ORDER: Record<BusinessActionKind, number> = {
    NAVIGATE: 0,
    SELECT_TASK: 1,
    SWITCH_CONTEXT: 2,
    SEARCH: 3,
    FILTER: 3,
    OPEN: 4,
    CREATE: 4,
    RETRIEVE: 5,
    UPDATE: 5,
    SAVE: 6,
    SUBMIT: 6,
    DELETE: 7,
  };
  const firstOf = (entry: Omit<BusinessAction, 'id'>): number =>
    Math.min(...entry.actionIds.map((id) => position.get(id) ?? Number.MAX_SAFE_INTEGER));
  const ordered = businessActions
    .sort((a, b) => firstOf(a) - firstOf(b) || ORDER[a.kind] - ORDER[b.kind])
    .map((entry, index) => ({ id: `ba${String(index + 1)}`, ...entry, confidence: round(entry.confidence) }));

  // ---------------------------------------------------------------- 7. le Technical Context
  const technical = new Map<string, TechnicalItem>();
  const addTechnical = (
    item: Omit<TechnicalItem, 'evidenceIds' | 'actionIds'>,
    evidenceId: string,
    actionId?: string,
  ): void => {
    const known = technical.get(item.key);
    if (known) {
      if (!known.evidenceIds.includes(evidenceId) && known.evidenceIds.length < 8)
        known.evidenceIds.push(evidenceId);
      if (actionId && !known.actionIds.includes(actionId)) known.actionIds.push(actionId);
      return;
    }
    technical.set(item.key, { ...item, evidenceIds: [evidenceId], actionIds: actionId ? [actionId] : [] });
  };
  for (const entity of entities)
    if (!isBusinessCandidate(entity.classification.classification)) {
      const kind =
        entity.classification.classification === 'INFRASTRUCTURE_ENTITY'
          ? 'INFRASTRUCTURE_ENTITY'
          : 'TECHNICAL_ENTITY';
      const location = entity.evidenceIds
        .map((id) => entityEvidence.get(id))
        .flatMap((entry) => [entry?.details.url, entry?.details.route])
        .find((value): value is string => !!value);
      const role = location ? technicalCategoryOf(location) : undefined;
      addTechnical(
        {
          key: `tech:${entity.key}`,
          classification: kind,
          category: role?.category ?? (kind === 'TECHNICAL_ENTITY' ? 'COMPONENT' : 'OTHER'),
          ...(role ? { operation: role.operation, intent: role.intent } : {}),
          label: entity.identity.value ?? entity.key,
          source: 'ENTITY',
          confidence: entity.classification.confidence,
          reason: `classified ${entity.classification.classification}: ${entity.classification.reason}`,
        },
        entityRef(entity.evidenceIds[0] ?? ''),
        entity.actionIds[0],
      );
    }
  for (const action of actions) {
    const places = [
      ...action.network.map((exchange) => ({
        path: exchange.path,
        source: 'NETWORK' as const,
        what: `${exchange.method} ${exchange.path}`,
        method: exchange.method,
      })),
      ...(action.navigation?.routes ?? []).map((route) => ({
        path: route,
        source: 'NAVIGATION' as const,
        what: `navigation ${route}`,
      })),
      ...(action.type === 'NAVIGATE' && action.route
        ? [{ path: action.route, source: 'NAVIGATION' as const, what: `navigation ${action.route}` }]
        : []),
    ];
    for (const place of places) {
      const role = technicalCategoryOf(place.path);
      if (!role) continue;
      const method = 'method' in place ? `${place.method} ` : '';
      addTechnical(
        {
          key: `tech:${role.operation}:${method}${routePattern(place.path, 6)}`,
          classification: role.classification,
          category: role.category,
          operation: role.operation,
          intent: role.intent,
          label: `${method}${routePattern(place.path, 6)}`,
          source: place.source,
          confidence: role.confidence,
          reason: role.reason,
        },
        actionEvidence(
          `${place.what}: ${role.reason}`,
          action,
          place.source === 'NETWORK' ? 'NETWORK' : 'NAVIGATION',
        ),
        action.id,
      );
    }
  }

  // ---------------------------------------------------------------- 8. les trois niveaux de chaque action
  const actionViews: ActionView[] = actions.map((action) => {
    const raw = rawById.get(action.rawEventIds.at(-1) ?? '');
    const status = raw?.targetValidation?.status;
    const explaining = ordered.filter((entry) => entry.actionIds.includes(action.id));
    const kinds = [...new Set(explaining.map((entry) => entry.kind))];
    return {
      actionId: action.id,
      type: action.type,
      ...(action.target?.label ? { label: action.target.label } : {}),
      stepIds: stepOf([action.id]),
      recorded: true,
      validation:
        status === undefined
          ? 'UNVERIFIED'
          : status.startsWith('VALIDATED')
            ? 'VALIDATED'
            : status === 'AMBIGUOUS'
              ? 'AMBIGUOUS'
              : 'FAILED',
      ...(status ? { validationStatus: status } : {}),
      interpretation: kinds.length ? kinds : ['UNKNOWN'],
      ...(explaining.length ? { confidence: Math.max(...explaining.map((entry) => entry.confidence)) } : {}),
    };
  });

  const startState = input.initialStateId
    ? states.find((state) => state.id === input.initialStateId)
    : states[0];
  const model: ApplicationInteractionModel = {
    version: 1,
    application: {
      ...(startState ? { startRoute: pathOf(startState.url) } : {}),
      ...(startState && originOf(startState.url) ? { origin: originOf(startState.url) } : {}),
      shell,
    },
    contexts: [...contexts.values()],
    collections,
    workspaces: [...workspaces.values()].map((workspace) =>
      withBff(workspace, collections, actions, keptEntities),
    ),
    tasks: [...tasks.values()],
    entities: modelEntities,
    businessContext: {
      entityKeys: modelEntities
        .filter((entity) => entity.classification.classification === 'BUSINESS_ENTITY')
        .map((entity) => entity.key),
      unknownKeys: modelEntities
        .filter((entity) => entity.classification.classification !== 'BUSINESS_ENTITY')
        .map((entity) => entity.key),
    },
    technicalContext: { items: [...technical.values()] },
    relationships: [...allRelations],
    correlations: [...(input.correlations ?? [])],
    businessActions: ordered,
    actions: actionViews,
    evidence,
    summary: {
      contexts: contexts.size,
      contextSwitches: switchAt.size,
      workspaces: workspaces.size,
      tasks: tasks.size,
      entities: modelEntities.length,
      relationships: allRelations.length,
      uncertain: allRelations.filter((relation) => relation.status === 'UNCERTAIN').length,
      technical: technical.size,
      actions: {
        recorded: actionViews.length,
        validated: actionViews.filter((view) => view.validation === 'VALIDATED').length,
        interpreted: actionViews.filter((view) => !view.interpretation.includes('UNKNOWN')).length,
        uninterpreted: actionViews.filter((view) => view.interpretation.includes('UNKNOWN')).length,
      },
    },
  };
  return model;
}

/**
 * Un BFF n'est jamais supposé : une liste devient un CANDIDAT quand ses enregistrements portent les
 * identités d'entités servies ailleurs, quand le même préfixe d'API sert plusieurs ressources, ou
 * (simple indice de nom) quand un segment du chemin s'appelle « bff ».
 */
function withBff(
  workspace: TaskWorkspace,
  collections: readonly WorkCollection[],
  actions: readonly SemanticRecordedAction[],
  entities: readonly TrackedEntity[],
): TaskWorkspace {
  if (workspace.source.type !== 'NETWORK') return workspace;
  const path = workspace.source.path;
  const reasons: string[] = [];
  const prefix = path.split('/').filter(Boolean).slice(0, 1).join('/');
  const resources = new Set(
    actions.flatMap((action) =>
      action.network
        .filter((exchange) => exchange.path.split('/').filter(Boolean)[0] === prefix)
        .flatMap((exchange) => {
          const resource = identityInPath(exchange.path)?.resource ?? collectionOf(exchange.path);
          return resource ? [resource] : [];
        }),
    ),
  );
  if (resources.size >= 2)
    reasons.push(`the prefix /${prefix} serves several resources (${[...resources].join(', ')})`);
  const own = collectionOf(path) ?? identityInPath(path)?.resource;
  const referenced = entities.filter(
    (entity) => entity.resources.length > 0 && own !== undefined && !entity.resources.includes(own),
  );
  const collection = collections.find((entry) => entry.key === workspace.collectionKey);
  if (collection && referenced.length > 0 && workspace.taskKeys.length > 0)
    reasons.push(
      `its records relate to entities served under other resources (${[...new Set(referenced.flatMap((entity) => entity.resources))].join(', ')})`,
    );
  if (path.split('/').some((segment) => /^bff$/i.test(segment)))
    reasons.push('a path segment is named "bff" (a naming hint only)');
  if (reasons.length === 0) return workspace;
  return {
    ...workspace,
    source: {
      ...workspace.source,
      bffCandidate: { confidence: round(Math.min(0.9, 0.3 + 0.2 * reasons.length)), reasons },
    },
  };
}

/** Le type d'une identité d'entité : un id technique (ENTITY_ID), une clé métier, une référence… */
/** Les champs de rôle d'une identité (voir identity-role.ts). */
function roleFields(
  role: RoleAssessment,
): Pick<IdentityCandidate, 'semanticRole' | 'roleConfidence' | 'roleEvidence'> {
  return {
    semanticRole: role.semanticRole,
    roleConfidence: role.confidence,
    roleEvidence: role.evidence.slice(0, 8),
  };
}

function originOf(url: string): string | undefined {
  try {
    const origin = new URL(url).origin;
    return origin === 'null' ? undefined : origin;
  } catch {
    return undefined;
  }
}

function clip(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 60);
}
