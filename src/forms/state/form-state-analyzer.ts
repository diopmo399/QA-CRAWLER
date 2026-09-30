import type { UiElement } from '../../model/ui-snapshot.js';
import { sensitivityOf } from '../../policies/sensitive-fields.js';
import type { SemanticEvidence, StaticValueSource } from '../../static-analysis/model.js';
import type {
  FieldKind,
  FieldState,
  FieldValueState,
  ObservedValue,
  ValueOrigin,
  ValueProvenance,
} from './field-state.js';
import { valueDigest } from './value-digest.js';
import type { CrawlerValueMemory, ResponseValueIndex } from './value-sources.js';

/** Un champ tel qu'observé à l'écran, avant toute interprétation (radios regroupées). */
export interface FieldObservation {
  fieldId: string;
  control?: string;
  label?: string;
  kind: FieldKind;
  value?: ObservedValue;
  hasValue: boolean;
  defaultDigest?: string;
  autofilled: boolean;
  readonly: boolean;
  disabled: boolean;
  required: boolean;
  visible: boolean;
  valid?: boolean;
  dirty?: boolean;
  touched?: boolean;
  sensitive: boolean;
  options?: { labels: string[]; codes: string[] };
  /** Index de l'élément dans l'instantané (le premier du groupe pour des radios). */
  elementIndex: number;
}

const NOT_A_FIELD = new Set(['submit', 'button', 'reset', 'image', 'hidden', 'file']);

function isFieldElement(element: UiElement): boolean {
  if (element.tag === 'select' || element.tag === 'textarea' || element.customSelect || element.editable)
    return true;
  if (element.tag === 'input') return !NOT_A_FIELD.has(element.inputType ?? 'text');
  return element.role === 'radio' || element.role === 'checkbox' || element.role === 'switch';
}

/** L'identité stable d'un champ : formControlName, name, puis libellé. */
export function fieldIdentity(
  element: Pick<UiElement, 'frameworkName' | 'fieldName' | 'label' | 'name' | 'css'>,
): string {
  return element.frameworkName ?? element.fieldName ?? element.label ?? (element.name || element.css);
}

/** Les champs d'un instantané, une observation par champ (un groupe de radios = un champ). */
export function observeFields(elements: readonly UiElement[]): FieldObservation[] {
  const observations: FieldObservation[] = [];
  const radioGroups = new Map<string, FieldObservation>();
  for (const element of elements) {
    if (!isFieldElement(element)) continue;
    const sensitivity = sensitivityOf({
      ...(element.inputType !== undefined ? { inputType: element.inputType } : {}),
      ...(element.autocomplete !== undefined ? { autocomplete: element.autocomplete } : {}),
      ...(element.fieldName !== undefined ? { name: element.fieldName } : {}),
      ...(element.label !== undefined ? { label: element.label } : {}),
      ...(element.placeholder !== undefined ? { placeholder: element.placeholder } : {}),
    });
    const radio = element.inputType === 'radio' || element.role === 'radio';
    if (radio && element.choiceGroup) {
      const key = element.choiceGroup;
      let group = radioGroups.get(key);
      if (!group) {
        group = {
          fieldId: element.frameworkName ?? element.fieldName ?? element.groupLabel ?? key,
          ...(element.frameworkName ? { control: element.frameworkName } : {}),
          ...(element.groupLabel ? { label: element.groupLabel } : {}),
          kind: 'radio',
          hasValue: false,
          autofilled: false,
          readonly: element.readOnly,
          disabled: element.disabled,
          required: element.required,
          visible: element.visible,
          sensitive: sensitivity.sensitive,
          options: { labels: [], codes: [] },
          elementIndex: element.index,
        };
        radioGroups.set(key, group);
        observations.push(group);
      }
      group.options?.labels.push(element.label ?? element.name);
      group.options?.codes.push(element.choiceValue ?? element.label ?? element.name);
      group.required ||= element.required;
      if (element.checked) {
        group.hasValue = true;
        group.value = {
          checked: true,
          option: element.label ?? element.name,
          ...(element.choiceValue ? { code: element.choiceValue } : {}),
        };
      }
      if (element.frameworkValid !== undefined) group.valid = element.frameworkValid;
      continue;
    }
    const kind: FieldKind =
      element.tag === 'select' || element.customSelect
        ? 'select'
        : element.inputType === 'checkbox' || element.role === 'checkbox' || element.role === 'switch'
          ? 'checkbox'
          : element.tag === 'input' || element.tag === 'textarea' || element.editable
            ? 'text'
            : 'other';
    const value: ObservedValue | undefined =
      kind === 'checkbox'
        ? { checked: element.checked === true }
        : kind === 'select'
          ? element.hasValue
            ? {
                ...(element.selectedOption ? { option: element.selectedOption } : {}),
                ...(element.selectedValue ? { code: element.selectedValue } : {}),
              }
            : undefined
          : element.valueDigest
            ? { digest: element.valueDigest }
            : undefined;
    observations.push({
      fieldId: fieldIdentity(element),
      ...(element.frameworkName ? { control: element.frameworkName } : {}),
      ...(element.label ? { label: element.label } : {}),
      kind,
      ...(value ? { value } : {}),
      hasValue: kind === 'checkbox' ? element.checked === true : element.hasValue === true,
      ...(element.defaultValueDigest ? { defaultDigest: element.defaultValueDigest } : {}),
      autofilled: element.autofilled === true,
      readonly: element.readOnly,
      disabled: element.disabled,
      required: element.required,
      visible: element.visible,
      ...(element.frameworkValid !== undefined
        ? { valid: element.frameworkValid }
        : element.ariaInvalid
          ? { valid: false }
          : {}),
      ...(element.dirty !== undefined ? { dirty: element.dirty } : {}),
      ...(element.touched !== undefined ? { touched: element.touched } : {}),
      sensitive: sensitivity.sensitive,
      ...(kind === 'select' && element.options
        ? { options: { labels: element.options, codes: element.optionValues ?? element.options } }
        : {}),
      elementIndex: element.index,
    });
  }
  return observations;
}

/** Ce que l'analyse de provenance peut consulter. Tout est facultatif. */
export interface ProvenanceContext {
  salt: string;
  stateId: string;
  /** Les sources de valeur que le code donne pour ce contrôle (sur ce composant d'abord). */
  staticSources?: (control: string) => readonly StaticValueSource[];
  /** Champs calculés (règle CALCULATION, dépendance DERIVATION). */
  derived?: (fieldId: string, control?: string) => { from: string[] } | undefined;
  responses?: ResponseValueIndex;
  crawlerValues?: CrawlerValueMemory;
  /** Le champ était déjà prérempli lors d'un run précédent (KnowledgeBase). */
  historicallyPrefilled?: (fieldId: string) => boolean;
  /** Concept d'un champ (email, country…) quand le vocabulaire ou le code le donne. */
  conceptOf?: (observation: FieldObservation) => string | undefined;
}

const PROFILE_API = /\/(profile|profil|me|current-?user|account|userinfo|utilisateur-courant)(\/|$)/i;

/**
 * VALUE PROVENANCE ANALYZER : pourquoi une valeur est là. Les preuves sont comparées
 * par empreinte, jamais en clair, dans cet ordre (la plus sûre d'abord) :
 *
 *   saisie du crawler sur cet écran  → USER_ACTION
 *   :autofill                         → BROWSER_AUTOFILL
 *   champ calculé (règle, dépendance) → DERIVED
 *   saisie du crawler ailleurs        → PREVIOUS_STEP
 *   réponse d'API (même empreinte)    → API_RESPONSE / PROFILE_PREFILLED
 *   littéral du formulaire (code)     → FORM_DEFAULT
 *   patchValue d'une réponse (code)   → API_RESPONSE (preuve statique seule)
 *   attribut value du HTML            → SERVER_PREFILLED
 *   première option d'une liste       → FORM_DEFAULT (faible)
 *   déjà prérempli au run précédent   → HISTORICAL
 *   sinon                             → UNKNOWN
 */
export class ValueProvenanceAnalyzer {
  analyze(
    observation: FieldObservation,
    context: ProvenanceContext,
  ): { state: FieldValueState; provenance?: ValueProvenance } {
    if (!observation.hasValue) return { state: 'EMPTY' };
    const make = (
      state: FieldValueState,
      origin: ValueOrigin,
      confidence: number,
      evidence: SemanticEvidence[],
      extra: Partial<ValueProvenance> = {},
    ): { state: FieldValueState; provenance: ValueProvenance } => ({
      state,
      provenance: { origin, confidence, evidence, ...extra },
    });
    const digest = observation.value?.digest;
    const statics = observation.control ? (context.staticSources?.(observation.control) ?? []) : [];

    const typedHere = context.crawlerValues?.filledHere(context.stateId, observation.fieldId);
    if (typedHere && (!digest || valueDigest(typedHere.value, context.salt) === digest))
      return make('CRAWLER_VALUE', 'USER_ACTION', 1, [
        runtime('crawler-input', 'entered by the crawler on this screen'),
      ]);
    if (observation.autofilled)
      return make('AUTOFILLED', 'BROWSER_AUTOFILL', 0.95, [
        runtime('autofill', 'the browser marks it :autofill'),
      ]);

    const derived = context.derived?.(observation.fieldId, observation.control);
    const calculated = statics.find((source) => source.origin === 'DERIVED');
    if (derived || calculated)
      return make(
        'DERIVED_VALUE',
        'DERIVED',
        derived ? 0.9 : 0.75,
        [
          derived
            ? runtime('derivation', `value follows ${derived.from.join(', ')}`)
            : codeEvidence(
                calculated,
                'calculation',
                `calculated from ${(calculated?.inputs ?? []).join(', ')}`,
              ),
        ],
        { sourceField: (derived?.from ?? calculated?.inputs ?? []).join(', ') },
      );

    const earlier = context.crawlerValues
      ?.lookup(digest)
      .find((entry) => entry.stateId !== context.stateId || entry.fieldId !== observation.fieldId);
    if (earlier)
      return make(
        'PREVIOUS_STEP_VALUE',
        'PREVIOUS_STEP',
        0.85,
        [runtime('previous-step', `same value as "${earlier.fieldId}" entered earlier`)],
        { sourceField: earlier.fieldId },
      );

    const fromCode = statics.find((source) => source.origin === 'API_RESPONSE');
    const responses = context.responses?.lookup(digest) ?? [];
    const response =
      responses.find(
        (match) =>
          fromCode?.responseProperty !== undefined &&
          match.property.split('.').pop() === fromCode.responseProperty,
      ) ??
      responses.find(
        (match) => match.property.split('.').pop() === (observation.control ?? observation.fieldId),
      ) ??
      responses[0];
    if (response) {
      const profile = PROFILE_API.test(response.api) || PROFILE_API.test(fromCode?.apiRoute ?? '');
      return make(
        'PREFILLED',
        profile ? 'PROFILE_PREFILLED' : 'API_RESPONSE',
        fromCode ? 0.95 : 0.85,
        [
          runtime('api-response', `same value as ${response.api} → ${response.property}`),
          ...(fromCode
            ? [
                codeEvidence(
                  fromCode,
                  'patch-value',
                  `${fromCode.kind} from ${fromCode.expression ?? 'a response'}`,
                ),
              ]
            : []),
        ],
        { sourceApi: response.api, sourceProperty: response.property },
      );
    }

    const literal = statics.find(
      (source) => source.origin === 'FORM_DEFAULT' && source.literal !== undefined,
    );
    if (literal && matchesLiteral(observation, literal.literal, context.salt))
      return make('DEFAULT_VALUE', 'FORM_DEFAULT', 0.9, [
        codeEvidence(literal, 'form-default', `initial value of the form control ${literal.control}`),
      ]);

    if (fromCode) {
      const profile = PROFILE_API.test(fromCode.apiRoute ?? '');
      return make(
        'PREFILLED',
        profile ? 'PROFILE_PREFILLED' : 'API_RESPONSE',
        0.6,
        [
          codeEvidence(
            fromCode,
            'patch-value',
            `${fromCode.kind} from ${fromCode.expression ?? 'a response'}`,
          ),
        ],
        {
          ...(fromCode.apiRoute ? { sourceApi: fromCode.apiRoute } : {}),
          ...(fromCode.responseProperty ? { sourceProperty: fromCode.responseProperty } : {}),
        },
      );
    }
    const initializer = statics.find((source) => source.origin === 'STATIC_INITIALIZER');
    if (initializer)
      return make('PREFILLED', 'STATIC_INITIALIZER', 0.5, [
        codeEvidence(
          initializer,
          'initializer',
          `initialised from ${initializer.expression ?? 'the component'}`,
        ),
      ]);

    if (digest && observation.defaultDigest === digest)
      return make('PREFILLED', 'SERVER_PREFILLED', 0.8, [
        runtime('html-value', 'value attribute of the page sent by the server'),
      ]);
    if (
      observation.kind === 'select' &&
      observation.value?.code !== undefined &&
      observation.options?.codes[0] === observation.value.code
    )
      return make('DEFAULT_VALUE', 'FORM_DEFAULT', 0.5, [
        runtime('first-option', 'the first option is selected'),
      ]);
    if (context.historicallyPrefilled?.(observation.fieldId))
      return make('PREFILLED', 'HISTORICAL', 0.4, [
        { source: 'HISTORICAL', kind: 'prefilled-before', value: observation.fieldId, confidence: 0.4 },
      ]);
    return make('UNKNOWN_PREFILLED', 'UNKNOWN', 0.2, []);
  }
}

function runtime(kind: string, detail: string): SemanticEvidence {
  return { source: 'RUNTIME', kind, value: detail, confidence: 0.9, provenance: { detail } };
}

function codeEvidence(source: StaticValueSource | undefined, kind: string, detail: string): SemanticEvidence {
  return {
    source: 'STATIC_CODE',
    kind,
    value: detail,
    confidence: 0.8,
    provenance: { ...(source ? { location: source.location } : {}), detail },
  };
}

/** La valeur observée est-elle ce littéral du code (option, code, case cochée, empreinte) ? */
function matchesLiteral(
  observation: FieldObservation,
  literal: string | number | boolean | undefined,
  salt: string,
): boolean {
  if (literal === undefined) return false;
  const value = observation.value;
  if (!value) return false;
  if (typeof literal === 'boolean') return value.checked === literal;
  const text = String(literal).trim().toLowerCase();
  if (value.code !== undefined && value.code.trim().toLowerCase() === text) return true;
  if (value.option !== undefined && value.option.trim().toLowerCase() === text) return true;
  return value.digest !== undefined && value.digest === valueDigest(String(literal), salt);
}

/**
 * FORM STATE ANALYZER : l'état de chaque champ d'un écran — valeur (en empreinte),
 * provenance, éditable / en lecture seule / désactivé / obligatoire / visible / valide.
 */
export class FormStateAnalyzer {
  private readonly provenance = new ValueProvenanceAnalyzer();

  analyze(elements: readonly UiElement[], context: ProvenanceContext): FieldState[] {
    return observeFields(elements).map((observation) => this.stateOf(observation, context));
  }

  stateOf(observation: FieldObservation, context: ProvenanceContext): FieldState {
    const { state, provenance } = this.provenance.analyze(observation, context);
    const concept = context.conceptOf?.(observation);
    return {
      fieldId: observation.fieldId,
      ...(observation.label ? { label: observation.label } : {}),
      ...(observation.control ? { control: observation.control } : {}),
      kind: observation.kind,
      ...(concept ? { semanticType: concept } : {}),
      ...(observation.value ? { currentValue: observation.value } : {}),
      state,
      editable: !observation.readonly && !observation.disabled,
      readonly: observation.readonly,
      disabled: observation.disabled,
      required: observation.required,
      visible: observation.visible,
      ...(observation.valid !== undefined ? { valid: observation.valid } : {}),
      ...(observation.dirty !== undefined ? { dirty: observation.dirty } : {}),
      ...(observation.touched !== undefined ? { touched: observation.touched } : {}),
      sensitive: observation.sensitive,
      ...(observation.options ? { options: observation.options } : {}),
      ...(provenance ? { provenance } : {}),
    };
  }
}
