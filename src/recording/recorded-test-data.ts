import { semanticKeyOf } from '../data/test-data-provider.js';
import {
  isSensitiveKey,
  testDataSetDocument,
  type TestDataEntry,
  type TestDataSet,
  type TestDataStrategy,
} from '../data/test-data-set.js';
import type { FunctionalExchange } from '../functional/model.js';
import type {
  RawRecordedEvent,
  RecordedElement,
  RecordedValueFacts,
  RecordingEventType,
  RecordingWarning,
  SemanticRecordedAction,
} from './model.js';

/**
 * RECORDED TEST DATA : ce que l'humain a FAIT devient le flow, les données qu'il a UTILISÉES
 * deviennent un jeu de données (TestDataSet). Une valeur enregistrée est un EXEMPLE de
 * l'intention de test, pas une constante éternelle :
 *
 *   valeurs métier (codes, choix)    → gardées telles quelles (BUSINESS_LITERAL)
 *   noms, e-mails, téléphones…       → régénérés à chaque rejeu (GENERATE_AT_REPLAY)
 *   textes libres, nombres, dates    → gardés (RECORDED_LITERAL)
 *   secrets                          → jamais lus ni écrits (CREDENTIAL_REFERENCE → { env })
 *   valeur déjà là, valeur calculée  → aucune donnée (PRESERVE_EXISTING / IGNORE_DERIVED)
 *
 * Aucune étape n'est perdue ni ajoutée : seule la valeur de chaque saisie change de forme.
 */

export type TestDataClassification =
  | 'RECORDED_TEST_DATA'
  | 'GENERATED_TEST_DATA'
  | 'BUSINESS_LITERAL'
  | 'SENSITIVE_REFERENCE'
  | 'PREFILLED_VALUE'
  | 'DERIVED_VALUE'
  | 'TRANSIENT_VALUE'
  /** Une case cochée, une option choisie : le comportement du flow, pas une donnée. */
  | 'FLOW_BEHAVIOR'
  | 'UNKNOWN';

export type GeneralizationDecision =
  | TestDataStrategy
  /** Une valeur calculée par l'application : une vérification possible, jamais une saisie. */
  | 'IGNORE_DERIVED'
  /** Gardée dans le flow (option, case) : pas une entrée du jeu de données. */
  | 'FLOW_STEP';

/** Une ligne du rapport « Recorded test data » : jamais une valeur sensible. */
export interface RecordedTestDataItem {
  /** La clé du jeu (request.title), absente quand rien n'est écrit dans le jeu. */
  key?: string;
  field: string;
  semanticType?: string;
  classification: TestDataClassification;
  strategy: GeneralizationDecision;
  /** Générateur (GENERATE_AT_REPLAY), clé citée (REFERENCE), variable (CREDENTIAL_REFERENCE). */
  detail?: string;
  reasons: string[];
  actionIds: string[];
  rawEventIds: string[];
  sensitive: boolean;
  /** Plusieurs valeurs pour la même donnée : initial, updated… */
  occurrence?: string;
}

export interface RecordedTestDataSettings {
  enabled: boolean;
  extractRecordedValues: boolean;
  replaceFlowLiterals: boolean;
  generalizeValues: boolean;
  generatePerRun: boolean;
  preserveBusinessLiterals: boolean;
  preserveExistingValues: boolean;
  namespaceByEntity: boolean;
  maxValueLength: number;
  sensitiveValues: { useCredentialReferences: boolean };
  strategies: Readonly<Record<string, 'recorded' | 'generated' | 'literal' | 'template'>>;
  overrides: Readonly<
    Record<
      string,
      {
        strategy: 'recorded' | 'generated' | 'literal' | 'template' | 'preserve';
        generator?: string;
        template?: string;
      }
    >
  >;
}

export interface RecordedTestDataInput {
  name: string;
  recordingSessionId: string;
  createdAt: string;
  /** Toutes les actions normalisées (gardées et écartées) : les écartées nourrissent le rapport. */
  actions: readonly SemanticRecordedAction[];
  kept: readonly SemanticRecordedAction[];
  rawEvents: readonly RawRecordedEvent[];
  /** Le texte saisi par événement brut (champs non sensibles seulement). */
  typedValues: ReadonlyMap<string, string>;
  settings: RecordedTestDataSettings;
}

export interface RecordedTestDataResult {
  set: TestDataSet;
  items: RecordedTestDataItem[];
  /** Le contenu de test-data.yaml (objet prêt à écrire). */
  document: Record<string, unknown>;
  security: { sensitiveRecorded: number; credentialReferences: number; clearTextPersisted: number };
  events: { type: RecordingEventType; message: string }[];
  warnings: RecordingWarning[];
}

/** Données qui identifient (unicité probable) : réutilisées, elles provoqueraient un 409. */
const UNIQUE = /^(e?mail|courriel|username|user ?name|login|identifiant|reference|ref|matricule)$/i;
/** customerReference, accountRef, contactEmail : le suffixe en camelCase dit l'unicité. */
const UNIQUE_SUFFIX = /[a-z](Reference|Ref|Username|Email|Login)$/;
/** Données personnelles qu'un générateur sait produire : jamais archivées depuis une démonstration. */
const PERSONAL = new Set(['firstName', 'lastName', 'phone', 'address', 'city', 'postalCode', 'company']);
/** Noms techniques qui ne disent rien (input3, mat-input-17, :r1:) : jamais une clé de donnée. */
const MEANINGLESS =
  /^(:r|mat-|cdk-|ng-|mui-)|^(input|field|text|textfield|txt|champ|value|valeur|control|form)[-_]?\d*$|\d{3,}/i;
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH']);

interface Candidate {
  action: SemanticRecordedAction;
  element: RecordedElement;
  facts?: RecordedValueFacts;
  typed?: string;
  rawId?: string;
  base: string;
  keySource: string;
  semanticType?: string;
  namespace?: string;
  write?: { actionId: string; kind: 'create' | 'update' };
  key: string;
  occurrence?: string;
  referenceTo?: Candidate;
  sameAs?: Candidate;
}

export function extractRecordedTestData(input: RecordedTestDataInput): RecordedTestDataResult {
  const { settings } = input;
  const rawById = new Map(input.rawEvents.map((event) => [event.id, event]));
  const events: RecordedTestDataResult['events'] = [];
  const warnings: RecordingWarning[] = [];
  const items: RecordedTestDataItem[] = [];
  const security = { sensitiveRecorded: 0, credentialReferences: 0, clearTextPersisted: 0 };
  const candidates: Candidate[] = [];
  const kept = input.kept;

  // 1. Les saisies qui comptent (RECORDED_TEST_DATA_DISCOVERED).
  for (const [index, action] of kept.entries()) {
    if (action.type === 'SELECT' || action.type === 'CHECK' || action.type === 'UNCHECK') {
      items.push(flowBehaviorItem(action));
      continue;
    }
    if (action.type !== 'FILL' || !action.value) continue;
    const raw = latestWithValue(action, rawById);
    const element = raw?.element;
    if (!element) continue;
    const label = action.target?.label ?? element.label ?? element.name;
    if (action.value.class === 'SENSITIVE_REFERENCE') {
      security.sensitiveRecorded += 1;
      security.credentialReferences += 1;
      events.push({
        type: 'SENSITIVE_RECORDED_VALUE_REDACTED',
        message: `"${label}": never read, replayed from ${action.value.env ?? 'an environment variable'}`,
      });
      items.push({
        field: label,
        classification: 'SENSITIVE_REFERENCE',
        strategy: 'CREDENTIAL_REFERENCE',
        ...(action.value.env ? { detail: action.value.env } : {}),
        reasons: [action.value.reason],
        actionIds: [action.id],
        rawEventIds: action.rawEventIds,
        sensitive: true,
      });
      continue;
    }
    if (action.value.class !== 'GENERATED_TEST_DATA') {
      // Un champ vidé : une valeur passagère, gardée littéralement dans le flow.
      items.push({
        field: label,
        classification: 'TRANSIENT_VALUE',
        strategy: 'FLOW_STEP',
        reasons: [action.value.reason],
        actionIds: [action.id],
        rawEventIds: action.rawEventIds,
        sensitive: false,
      });
      continue;
    }
    if (element.readOnly === true) {
      // Un champ calculé (total) : jamais une entrée ; il peut devenir une vérification.
      action.dropped = 'derived value: computed by the application, not an input';
      items.push({
        field: label,
        classification: 'DERIVED_VALUE',
        strategy: 'IGNORE_DERIVED',
        reasons: ['read-only field: the application computes it (an outcome, not an input)'],
        actionIds: [action.id],
        rawEventIds: action.rawEventIds,
        sensitive: false,
      });
      continue;
    }
    const typedRaw = [...action.rawEventIds].reverse().find((id) => input.typedValues.has(id));
    const typed = typedRaw ? input.typedValues.get(typedRaw) : undefined;
    const write = followingWrite(kept, index);
    const resolved = resolveTestDataKey(element, raw.value, write?.exchange);
    candidates.push({
      action,
      element,
      ...(raw.value ? { facts: raw.value } : {}),
      ...(typed !== undefined && typed.length <= settings.maxValueLength ? { typed } : {}),
      ...(typedRaw ? { rawId: typedRaw } : {}),
      base: resolved.key,
      keySource: resolved.source,
      ...(resolved.semanticType ? { semanticType: resolved.semanticType } : {}),
      ...(settings.namespaceByEntity && write?.entity ? { namespace: write.entity } : {}),
      ...(write ? { write: { actionId: write.actionId, kind: write.kind } } : {}),
      key: resolved.key,
    });
  }
  // Les valeurs déjà là, gardées (PREFILLED_VALUE) : aucune donnée.
  for (const action of input.actions)
    if (action.type === 'FILL' && action.value?.class === 'PREEXISTING_VALUE')
      items.push({
        field: action.target?.label ?? 'field',
        classification: 'PREFILLED_VALUE',
        strategy: settings.preserveExistingValues ? 'PRESERVE_EXISTING' : 'FLOW_STEP',
        reasons: [action.value.reason],
        actionIds: [action.id],
        rawEventIds: action.rawEventIds,
        sensitive: false,
      });
  if (candidates.length > 0)
    events.push({
      type: 'RECORDED_TEST_DATA_DISCOVERED',
      message: `${String(candidates.length)} entered value(s)`,
    });

  // 2. Espaces de noms : une entité créée deux fois (deux clients) → customer1, customer2.
  const creates = new Map<string, string[]>();
  for (const candidate of candidates)
    if (candidate.namespace && candidate.write?.kind === 'create') {
      const list = creates.get(candidate.namespace) ?? [];
      if (!list.includes(candidate.write.actionId)) list.push(candidate.write.actionId);
      creates.set(candidate.namespace, list);
    }
  const lastCreate = new Map<string, string>();
  for (const candidate of candidates) {
    const namespace = candidate.namespace;
    let prefix = namespace;
    if (namespace) {
      const list = creates.get(namespace) ?? [];
      const instance =
        candidate.write?.kind === 'create' ? candidate.write.actionId : lastCreate.get(namespace);
      if (candidate.write?.kind === 'create') lastCreate.set(namespace, candidate.write.actionId);
      const position = instance ? list.indexOf(instance) : -1;
      if (list.length > 1 && position >= 0) prefix = `${namespace}${String(position + 1)}`;
    }
    candidate.key = prefix ? `${prefix}.${candidate.base}` : candidate.base;
  }

  // 3. Occurrences : la même donnée (même empreinte) réutilise la clé ; une autre valeur pour la
  //    même clé n'écrase jamais la première (initial, updated, updated2…).
  const byKey = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const same = byKey.get(candidate.key) ?? [];
    const twin = same.find((other) => sameValue(other, candidate));
    if (twin) {
      candidate.sameAs = twin.sameAs ?? twin;
      continue;
    }
    same.push(candidate);
    byKey.set(candidate.key, same);
  }
  for (const [key, list] of byKey) {
    if (list.length < 2) continue;
    events.push({
      type: 'TEST_DATA_COLLISION_DETECTED',
      message: `${key}: ${String(list.length)} different values in the flow, kept apart (${key}.initial, ${key}.updated…)`,
    });
    warnings.push({
      code: 'TEST_DATA_COLLISION',
      message: `"${key}" was entered with ${String(list.length)} different values: each keeps its own test data (${key}.initial, ${key}.updated…)`,
    });
    list.forEach((candidate, position) => {
      candidate.occurrence =
        position === 0 ? 'initial' : position === 1 ? 'updated' : `updated${String(position)}`;
      candidate.key = `${key}.${candidate.occurrence}`;
    });
  }

  // 4. Références : la même valeur sous une autre clé (confirmEmail, recherche par l'e-mail créé).
  const distinct = candidates.filter((candidate) => !candidate.sameAs);
  for (const [index, candidate] of distinct.entries()) {
    const earlier = distinct
      .slice(0, index)
      .find((other) => other.key !== candidate.key && sameValue(other, candidate) && meaningful(candidate));
    if (earlier) candidate.referenceTo = earlier.referenceTo ?? earlier;
  }

  // 5. Politique de généralisation, entrée du jeu, valeur de l'étape.
  const values: Record<string, TestDataEntry> = {};
  for (const candidate of candidates) {
    const owner = candidate.sameAs ?? candidate;
    const label = candidate.action.target?.label ?? candidate.element.label ?? candidate.element.name;
    if (candidate.sameAs) {
      setStepKey(candidate.action, owner.key, settings, values[owner.key]);
      continue;
    }
    events.push({
      type: 'TEST_DATA_KEY_RESOLVED',
      message: `"${label}" → testData.${candidate.key} (${candidate.keySource})`,
    });
    const decision = candidate.referenceTo
      ? {
          strategy: 'REFERENCE' as const,
          classification: classificationOf(decideStrategy(candidate.referenceTo, settings).strategy),
          reasons: [`same value as testData.${candidate.referenceTo.key}: one logical data, one value`],
        }
      : decideStrategy(candidate, settings);
    if (decision.strategy === 'CREDENTIAL_REFERENCE') {
      // Une clé qui nomme un secret (token, pin) tapée dans un champ ordinaire : jamais gardée.
      const env = `QA_${candidate.base.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}`;
      candidate.action.value = {
        class: 'SENSITIVE_REFERENCE',
        env,
        sensitive: true,
        reason: `the name says a secret: read from ${env}, never recorded`,
      };
      security.sensitiveRecorded += 1;
      security.credentialReferences += 1;
      events.push({
        type: 'SENSITIVE_RECORDED_VALUE_REDACTED',
        message: `"${label}": a secret by its name, replayed from ${env}`,
      });
      items.push({
        field: label,
        classification: 'SENSITIVE_REFERENCE',
        strategy: 'CREDENTIAL_REFERENCE',
        detail: env,
        reasons: decision.reasons,
        actionIds: [candidate.action.id],
        rawEventIds: candidate.action.rawEventIds,
        sensitive: true,
      });
      continue;
    }
    const entry: TestDataEntry = {
      key: candidate.key,
      strategy: decision.strategy,
      ...(decision.value !== undefined ? { value: decision.value } : {}),
      ...(decision.generator ? { generator: decision.generator } : {}),
      ...(decision.template ? { template: decision.template } : {}),
      ...(candidate.referenceTo ? { reference: candidate.referenceTo.key } : {}),
      ...(candidate.semanticType ? { semanticType: candidate.semanticType } : {}),
      sensitive: false,
      provenance: {
        recordingSessionId: input.recordingSessionId,
        semanticField: candidate.semanticType ?? candidate.base,
        rawEventIds: candidate.action.rawEventIds,
        classification: decision.classification,
        reasons: decision.reasons,
      },
    };
    values[entry.key] = entry;
    const groupIds = candidates
      .filter((other) => (other.sameAs ?? other) === candidate)
      .map((other) => other.action.id);
    events.push({
      type: 'TEST_DATA_CLASSIFIED',
      message: `testData.${entry.key}: ${decision.classification} → ${decision.strategy}`,
    });
    if (decision.strategy === 'GENERATE_AT_REPLAY')
      events.push({
        type: 'TEST_DATA_GENERALIZED',
        message: `testData.${entry.key}: generated at replay (${decision.generator ?? 'text'}), the recorded value is only an example`,
      });
    if (decision.strategy === 'BUSINESS_LITERAL')
      events.push({
        type: 'TEST_DATA_LITERAL_PRESERVED',
        message: `testData.${entry.key}: business value kept as recorded`,
      });
    if (decision.strategy === 'REFERENCE')
      events.push({
        type: 'TEST_DATA_REFERENCE_CREATED',
        message: `testData.${entry.key} = testData.${entry.reference ?? ''}`,
      });
    items.push({
      key: entry.key,
      field: label,
      ...(candidate.semanticType ? { semanticType: candidate.semanticType } : {}),
      classification: decision.classification,
      strategy: decision.strategy,
      ...(decision.generator
        ? { detail: decision.generator }
        : entry.reference
          ? { detail: entry.reference }
          : decision.template
            ? { detail: decision.template }
            : {}),
      reasons: decision.reasons,
      actionIds: groupIds,
      rawEventIds: candidate.action.rawEventIds,
      sensitive: false,
      ...(candidate.occurrence ? { occurrence: candidate.occurrence } : {}),
    });
    setStepKey(candidate.action, entry.key, settings, entry);
  }

  const set: TestDataSet = {
    id: `${input.recordingSessionId}:test-data`,
    name: `${input.name}-recorded-data`,
    source: 'HUMAN_RECORDING',
    recordingSessionId: input.recordingSessionId,
    createdAt: input.createdAt,
    values,
  };
  const document = testDataSetDocument(set);
  // Contrôle final : aucune entrée sensible ne porte de valeur (0 attendu, vérifié, jamais supposé).
  security.clearTextPersisted = Object.values(values).filter(
    (entry) => (entry.sensitive || isSensitiveKey(entry.key)) && entry.value !== undefined,
  ).length;
  return { set, items, document, security, events, warnings };
}

/**
 * TEST DATA KEY RESOLVER : l'identité sémantique d'un champ, jamais son localisateur.
 * Propriété du DTO envoyé (même empreinte), puis nom technique stable (formControlName,
 * name, test id), puis sens reconnu (email, firstName…), puis libellé, puis forme.
 */
export function resolveTestDataKey(
  element: RecordedElement,
  facts?: RecordedValueFacts,
  write?: FunctionalExchange,
): { key: string; source: string; semanticType?: string } {
  const testIdStem = element.testId?.replace(/[-_]?(input|field|champ|select|txt)$/i, '');
  const technical = [
    element.formControlName,
    element.nameAttr,
    testIdStem,
    element.generatedId ? undefined : element.elementId,
  ];
  const words = [...technical, element.label, element.guessedLabel, element.name].filter(
    (text): text is string => text !== undefined && text.trim() !== '',
  );
  const semantic = semanticKeyOf({
    ...(element.inputType ? { type: element.inputType } : {}),
    name: words.join(' '),
    ...(element.placeholder ? { placeholder: element.placeholder } : {}),
  });
  const shape =
    facts && ['email', 'phone', 'url', 'date', 'number'].includes(facts.shape) ? facts.shape : undefined;
  const semanticType = semantic && semantic !== 'text' && semantic !== 'name' ? semantic : shape;
  // La propriété du corps envoyé qui porte EXACTEMENT cette valeur (empreintes du même sel).
  if (facts?.digest && write?.requestFields) {
    const property = Object.entries(write.requestFields).find(
      ([, shape]) => shape.digest === facts.digest,
    )?.[0];
    const name = property?.split('.').at(-1);
    if (name && !MEANINGLESS.test(name) && camel(name) !== '')
      return {
        key: camel(name),
        source: `DTO property ${property ?? name}`,
        ...(semanticType ? { semanticType } : {}),
      };
  }
  const stable = technical.map((text) => (text && !MEANINGLESS.test(text) ? camel(text) : '')).find(Boolean);
  if (stable) return { key: stable, source: 'stable field name', ...(semanticType ? { semanticType } : {}) };
  if (semanticType && semantic === semanticType)
    return { key: semanticType, source: 'semantic field', semanticType };
  const labelled = [element.label, element.guessedLabel, element.name]
    .map((text) => (text ? camel(text) : ''))
    .find((key) => key !== '' && !MEANINGLESS.test(key));
  if (labelled) return { key: labelled, source: 'field label', ...(semanticType ? { semanticType } : {}) };
  return { key: semanticType ?? 'value', source: 'fallback', ...(semanticType ? { semanticType } : {}) };
}

interface Decision {
  strategy: TestDataStrategy;
  classification: TestDataClassification;
  value?: string;
  generator?: string;
  template?: string;
  reasons: string[];
}

/**
 * RECORDED DATA GENERALIZATION POLICY. Priorité : configuration explicite → sécurité →
 * sens métier → inférence sur la valeur enregistrée → type sémantique générique → repli.
 * La sécurité reste absolue : aucune configuration ne fait garder un secret.
 */
function decideStrategy(candidate: Candidate, settings: RecordedTestDataSettings): Decision {
  const typed = candidate.typed;
  const base = candidate.base;
  const generator = candidate.semanticType ?? generatorOf(candidate);
  // Sécurité d'abord (même avant une configuration explicite).
  if (isSensitiveKey(base) || isSensitiveKey(candidate.key))
    return {
      strategy: 'CREDENTIAL_REFERENCE',
      classification: 'SENSITIVE_REFERENCE',
      reasons: ['the field name says a secret: never kept, never written'],
    };
  const override = settings.overrides[candidate.key] ?? settings.overrides[base];
  if (override) {
    const reason = `explicit configuration (recording.testData.overrides: ${override.strategy})`;
    switch (override.strategy) {
      case 'preserve':
        return { strategy: 'PRESERVE_EXISTING', classification: 'PREFILLED_VALUE', reasons: [reason] };
      case 'generated':
        return {
          strategy: 'GENERATE_AT_REPLAY',
          classification: 'GENERATED_TEST_DATA',
          generator: override.generator ?? generator,
          reasons: [reason],
        };
      case 'template':
        return {
          strategy: 'TEMPLATE',
          classification: 'GENERATED_TEST_DATA',
          template: override.template ?? `QA-CRAWLER \${runId}`,
          reasons: [reason],
        };
      default:
        if (typed !== undefined)
          return {
            strategy: override.strategy === 'literal' ? 'BUSINESS_LITERAL' : 'RECORDED_LITERAL',
            classification: override.strategy === 'literal' ? 'BUSINESS_LITERAL' : 'RECORDED_TEST_DATA',
            value: typed,
            reasons: [reason],
          };
        return {
          strategy: 'GENERATE_AT_REPLAY',
          classification: 'GENERATED_TEST_DATA',
          generator,
          reasons: [reason, 'but the value was not recorded: generated at replay'],
        };
    }
  }
  if (typed === undefined)
    return {
      strategy: 'GENERATE_AT_REPLAY',
      classification: 'GENERATED_TEST_DATA',
      generator,
      reasons: [
        candidate.facts && candidate.facts.length > settings.maxValueLength
          ? `value longer than ${String(settings.maxValueLength)} characters: generated at replay`
          : 'the value was not recorded (recording.testData.extractRecordedValues: false): generated at replay',
      ],
    };
  // Sens métier : un code (INCIDENT, BUSINESS, PENDING) tapé tel quel décide du scénario.
  if (settings.preserveBusinessLiterals && candidate.facts?.shape === 'code')
    return {
      strategy: 'BUSINESS_LITERAL',
      classification: 'BUSINESS_LITERAL',
      value: typed,
      reasons: ['a business code (capitals): it carries the meaning of the scenario, kept as recorded'],
    };
  // Une stratégie configurée par sens ou par nom de champ.
  const configured =
    settings.strategies[base] ??
    (candidate.semanticType ? settings.strategies[candidate.semanticType] : undefined);
  if (configured) {
    const reason = `recording.testData.strategies: ${configured}`;
    if (configured === 'generated')
      return {
        strategy: 'GENERATE_AT_REPLAY',
        classification: 'GENERATED_TEST_DATA',
        generator,
        reasons: [reason],
      };
    if (configured === 'template')
      return {
        strategy: 'TEMPLATE',
        classification: 'GENERATED_TEST_DATA',
        template: `${typed.slice(0, 40)} \${runId}`,
        reasons: [reason],
      };
    return {
      strategy: configured === 'literal' ? 'BUSINESS_LITERAL' : 'RECORDED_LITERAL',
      classification: configured === 'literal' ? 'BUSINESS_LITERAL' : 'RECORDED_TEST_DATA',
      value: typed,
      reasons: [reason],
    };
  }
  if (settings.generalizeValues) {
    if (candidate.semanticType === 'email' || UNIQUE.test(base) || UNIQUE_SUFFIX.test(base))
      return {
        strategy: 'GENERATE_AT_REPLAY',
        classification: 'GENERATED_TEST_DATA',
        generator: candidate.semanticType === 'email' ? 'email' : 'unique',
        reasons: [
          `semantic type ${(candidate.semanticType ?? base).toUpperCase()}`,
          'a reused value may conflict between runs (409): generated once per run',
        ],
      };
    if (candidate.semanticType && PERSONAL.has(candidate.semanticType))
      return {
        strategy: 'GENERATE_AT_REPLAY',
        classification: 'GENERATED_TEST_DATA',
        generator: candidate.semanticType,
        reasons: [
          `semantic type ${candidate.semanticType}: personal data is generated, not archived from a demonstration`,
        ],
      };
  }
  return {
    strategy: 'RECORDED_LITERAL',
    classification: 'RECORDED_TEST_DATA',
    value: typed,
    reasons: [
      `${candidate.facts?.shape ?? 'text'} entered by the human: kept as the example of the scenario`,
    ],
  };
}

function classificationOf(strategy: TestDataStrategy): TestDataClassification {
  switch (strategy) {
    case 'GENERATE_AT_REPLAY':
    case 'TEMPLATE':
      return 'GENERATED_TEST_DATA';
    case 'BUSINESS_LITERAL':
      return 'BUSINESS_LITERAL';
    case 'CREDENTIAL_REFERENCE':
      return 'SENSITIVE_REFERENCE';
    case 'PRESERVE_EXISTING':
      return 'PREFILLED_VALUE';
    default:
      return 'RECORDED_TEST_DATA';
  }
}

/** La valeur de l'étape devient la clé du jeu (ou la valeur elle-même si replaceFlowLiterals est faux). */
function setStepKey(
  action: SemanticRecordedAction,
  key: string,
  settings: RecordedTestDataSettings,
  entry: TestDataEntry | undefined,
): void {
  if (!action.value) return;
  if (!settings.replaceFlowLiterals && entry?.value !== undefined && !entry.sensitive) {
    action.value = {
      class: 'LITERAL_BUSINESS_VALUE',
      literal: entry.value,
      sensitive: false,
      reason: `${entry.strategy}: kept in the flow (recording.testData.replaceFlowLiterals: false)`,
    };
    return;
  }
  action.value = {
    ...action.value,
    testData: key,
    reason: entry
      ? `testData.${key}: ${entry.strategy}${entry.reference ? ` → testData.${entry.reference}` : ''}`
      : `testData.${key}`,
  };
}

function flowBehaviorItem(action: SemanticRecordedAction): RecordedTestDataItem {
  const choice = action.type === 'SELECT' || action.option !== undefined;
  return {
    field: action.target?.label ?? action.type,
    classification: choice ? 'BUSINESS_LITERAL' : 'FLOW_BEHAVIOR',
    strategy: 'FLOW_STEP',
    ...(action.option ? { detail: action.option } : {}),
    reasons: [
      choice
        ? 'a choice of the screen: kept as is in the flow (never a random option)'
        : `${action.type === 'CHECK' ? 'checked' : 'unchecked'}: the behavior of the flow, not data`,
    ],
    actionIds: [action.id],
    rawEventIds: action.rawEventIds,
    sensitive: false,
  };
}

function latestWithValue(
  action: SemanticRecordedAction,
  rawById: ReadonlyMap<string, RawRecordedEvent>,
): RawRecordedEvent | undefined {
  return [...action.rawEventIds]
    .reverse()
    .map((id) => rawById.get(id))
    .find((event) => event?.value);
}

/** La première écriture (POST/PUT/PATCH) après la saisie : l'entité que la donnée décrit. */
function followingWrite(
  kept: readonly SemanticRecordedAction[],
  index: number,
):
  { actionId: string; kind: 'create' | 'update'; entity?: string; exchange: FunctionalExchange } | undefined {
  for (const action of kept.slice(index + 1)) {
    const exchange = action.network.find((candidate) => WRITE_METHODS.has(candidate.method.toUpperCase()));
    if (!exchange) continue;
    const entity = entityOf(exchange.path);
    return {
      actionId: action.id,
      kind: exchange.method.toUpperCase() === 'POST' ? 'create' : 'update',
      ...(entity ? { entity } : {}),
      exchange,
    };
  }
  return undefined;
}

/** /api/v1/customers/12 → customer ; /api/demandes → demande. */
export function entityOf(apiPath: string): string | undefined {
  const segments = apiPath
    .split('?')[0]
    ?.split('/')
    .filter(
      (segment) =>
        segment !== '' &&
        !/^(api|rest|v\d+|graphql)$/i.test(segment) &&
        !/^(\d+|[0-9a-f-]{16,}|\{.*\}|:.*)$/i.test(segment),
    );
  const last = segments?.at(-1);
  if (!last) return undefined;
  const word = camel(last);
  if (word === '') return undefined;
  if (/ies$/.test(word)) return word.replace(/ies$/, 'y');
  if (/(ss|x|ch|sh)es$/.test(word)) return word.replace(/es$/, '');
  if (/[^s]s$/.test(word)) return word.slice(0, -1);
  return word;
}

function sameValue(a: Candidate, b: Candidate): boolean {
  if (a.facts?.digest && b.facts?.digest) return a.facts.digest === b.facts.digest;
  return a.typed !== undefined && a.typed === b.typed;
}

/** Une valeur trop courte (« 1 », « a ») qui se répète n'est pas la même donnée. */
function meaningful(candidate: Candidate): boolean {
  return (candidate.facts?.length ?? candidate.typed?.length ?? 0) >= 3;
}

function generatorOf(candidate: Candidate): string {
  const shape = candidate.facts?.shape;
  if (shape && ['email', 'phone', 'url', 'date', 'number'].includes(shape)) return shape;
  return candidate.element.tag === 'textarea' ? 'textarea' : 'text';
}

export function camel(text: string): string {
  const words = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .slice(0, 4);
  const key = words
    .map((word, index) =>
      index === 0 ? word.toLowerCase() : `${word[0]?.toUpperCase() ?? ''}${word.slice(1).toLowerCase()}`,
    )
    .join('');
  return /^[A-Za-z]/.test(key) ? key : '';
}
