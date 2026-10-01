import type { SemanticEvidence } from '../../static-analysis/model.js';

/**
 * ÉTAT D'UN CHAMP : plus seulement « vide » ou « rempli », mais POURQUOI il contient
 * ce qu'il contient, et donc ce qu'il faut en faire. La valeur elle-même n'est jamais
 * lue en clair : une empreinte salée (value-digest.ts), le code et le libellé de
 * l'option choisie d'une liste, l'état coché d'une case.
 */
export type FieldValueState =
  | 'EMPTY'
  /** Valeur présente, venue du serveur, d'une réponse d'API, d'un profil. */
  | 'PREFILLED'
  /** La valeur initiale du formulaire (code : country: ['Canada']). */
  | 'DEFAULT_VALUE'
  /** Remplie par le navigateur (autocomplétion). */
  | 'AUTOFILLED'
  /** Calculée à partir d'autres champs (total = quantité × prix). */
  | 'DERIVED_VALUE'
  /** Saisie par le crawler à une étape précédente et reportée ici. */
  | 'PREVIOUS_STEP_VALUE'
  /** Saisie par le crawler sur cet écran. */
  | 'CRAWLER_VALUE'
  /** Présente, d'origine inconnue. */
  | 'UNKNOWN_PREFILLED';

export type ValueOrigin =
  | 'FORM_DEFAULT'
  | 'SERVER_PREFILLED'
  | 'PROFILE_PREFILLED'
  | 'API_RESPONSE'
  | 'BROWSER_AUTOFILL'
  | 'PREVIOUS_STEP'
  | 'DERIVED'
  | 'USER_ACTION'
  | 'STATIC_INITIALIZER'
  | 'HISTORICAL'
  | 'UNKNOWN';

/** Pourquoi une valeur est là, avec ses preuves (jamais la valeur). */
export interface ValueProvenance {
  origin: ValueOrigin;
  /** 0..1 */
  confidence: number;
  evidence: SemanticEvidence[];
  /** Le champ dont la valeur a été reportée (PREVIOUS_STEP) ou dont elle est calculée (DERIVED). */
  sourceField?: string;
  /** GET /api/profile */
  sourceApi?: string;
  /** La propriété de la réponse (email). */
  sourceProperty?: string;
}

/** Ce qu'on sait de la valeur courante — jamais la valeur d'un champ texte en clair. */
export interface ObservedValue {
  digest?: string;
  /** Liste : libellé et code de l'option choisie. */
  option?: string;
  code?: string;
  /** Case à cocher, radio. */
  checked?: boolean;
}

export type FieldKind = 'text' | 'select' | 'radio' | 'checkbox' | 'other';

export interface FieldState {
  /** Identité stable du champ : formControlName, name, sinon libellé. */
  fieldId: string;
  label?: string;
  /** formControlName (Angular). */
  control?: string;
  kind: FieldKind;
  /** Concept (email, country…) quand il est connu. */
  semanticType?: string;
  currentValue?: ObservedValue;
  state: FieldValueState;
  editable: boolean;
  readonly: boolean;
  disabled: boolean;
  required: boolean;
  visible: boolean;
  /** État du framework (ng-valid) ou aria-invalid ; absent : inconnu. */
  valid?: boolean;
  dirty?: boolean;
  touched?: boolean;
  /** Mot de passe, carte, secret : jamais rempli automatiquement. */
  sensitive: boolean;
  /** Options d'une liste (libellés, codes). */
  options?: { labels: string[]; codes: string[] };
  provenance?: ValueProvenance;
}

export type FieldActionDecisionKind =
  'FILL' | 'KEEP' | 'REPLACE' | 'CLEAR' | 'OBSERVE_ONLY' | 'SKIP_DISABLED' | 'SKIP_READONLY' | 'SKIP_UNSAFE';

export type FieldActionReason =
  | 'EMPTY_FIELD'
  | 'VALID_EXISTING_VALUE'
  | 'INVALID_EXISTING_VALUE'
  | 'EXPLICIT_SCENARIO_VALUE'
  | 'EXPLICIT_VALUE_ALREADY_PRESENT'
  | 'EXPLICIT_CLEAR'
  | 'DERIVED_FIELD'
  | 'READONLY_FIELD'
  | 'DISABLED_FIELD'
  | 'SENSITIVE_FIELD'
  | 'BLOCKED_BY_POLICY'
  | 'PRESERVATION_DISABLED';

export interface FieldActionDecision {
  fieldId: string;
  decision: FieldActionDecisionKind;
  reason: FieldActionReason;
  /** « Valid existing default value » : lisible, sans valeur. */
  explanation: string;
}

export interface FieldActionInput {
  /**
   * Une valeur imposée par le scénario (Gherkin, flow.yaml, testData.fields) :
   * prioritaire sur tout ce que le champ contient. `clear` : vider le champ.
   */
  explicit?: ObservedValue | 'clear' | 'any';
  /** Garder les valeurs déjà présentes et valides (forms.preserveExistingValues, défaut true). */
  preserveExisting: boolean;
  /** La SafetyPolicy refuse l'action sur ce champ. */
  blockedByPolicy?: boolean;
}

const EXISTING_LABEL: Partial<Record<FieldValueState, string>> = {
  PREFILLED: 'prefilled value',
  DEFAULT_VALUE: 'default value',
  AUTOFILLED: 'autofilled value',
  PREVIOUS_STEP_VALUE: 'value from a previous step',
  CRAWLER_VALUE: 'value already entered',
  UNKNOWN_PREFILLED: 'existing value',
};

/**
 * FIELD ACTION DECISION : que faire d'un champ, et pourquoi. Remplace « s'il a une
 * valeur, l'ignorer » :
 *
 *   EMPTY                                  → FILL
 *   PREFILLED / DEFAULT / AUTOFILLED valide → KEEP
 *   … invalide                             → REPLACE
 *   DERIVED_VALUE, READONLY                → OBSERVE_ONLY
 *   DISABLED                               → SKIP_DISABLED
 *   sensible, refusé par la SafetyPolicy   → SKIP_UNSAFE
 *
 * Une valeur explicite du scénario reste prioritaire : « je sélectionne France » sur
 * un pays déjà « Canada » donne REPLACE (EXPLICIT_SCENARIO_VALUE), jamais KEEP.
 */
export function decideFieldAction(state: FieldState, input: FieldActionInput): FieldActionDecision {
  const decide = (
    decision: FieldActionDecisionKind,
    reason: FieldActionReason,
    explanation: string,
  ): FieldActionDecision => ({ fieldId: state.fieldId, decision, reason, explanation });
  if (input.blockedByPolicy)
    return decide('SKIP_UNSAFE', 'BLOCKED_BY_POLICY', 'refused by the safety policy');
  if (state.sensitive && input.explicit === undefined)
    return decide('SKIP_UNSAFE', 'SENSITIVE_FIELD', 'sensitive field: never filled automatically');
  if (state.disabled) return decide('SKIP_DISABLED', 'DISABLED_FIELD', 'disabled field');
  if (state.readonly)
    return input.explicit === undefined
      ? decide('OBSERVE_ONLY', 'READONLY_FIELD', 'read-only field: observed, never typed into')
      : decide('SKIP_READONLY', 'READONLY_FIELD', 'read-only field: the scenario value cannot be entered');

  if (input.explicit !== undefined) {
    if (input.explicit === 'clear')
      return state.state === 'EMPTY'
        ? decide('KEEP', 'EXPLICIT_VALUE_ALREADY_PRESENT', 'already empty')
        : decide('CLEAR', 'EXPLICIT_CLEAR', 'the scenario empties the field');
    if (input.explicit !== 'any' && state.state !== 'EMPTY' && sameValue(state.currentValue, input.explicit))
      return decide('KEEP', 'EXPLICIT_VALUE_ALREADY_PRESENT', 'the scenario value is already present');
    return state.state === 'EMPTY'
      ? decide('FILL', 'EXPLICIT_SCENARIO_VALUE', 'value given by the scenario')
      : decide('REPLACE', 'EXPLICIT_SCENARIO_VALUE', 'value given by the scenario replaces the existing one');
  }

  if (state.state === 'EMPTY') return decide('FILL', 'EMPTY_FIELD', 'empty field');
  if (state.state === 'DERIVED_VALUE')
    return decide(
      'OBSERVE_ONLY',
      'DERIVED_FIELD',
      'value calculated from other fields: observed, never typed',
    );
  const existing = EXISTING_LABEL[state.state] ?? 'existing value';
  if (state.valid === false)
    return decide('REPLACE', 'INVALID_EXISTING_VALUE', `invalid ${existing}: replaced by valid test data`);
  if (!input.preserveExisting)
    return decide(
      'REPLACE',
      'PRESERVATION_DISABLED',
      `${existing} replaced (forms.preserveExistingValues: false)`,
    );
  return decide('KEEP', 'VALID_EXISTING_VALUE', `valid existing ${existing}`);
}

/** Deux valeurs observées désignent-elles la même chose (code, libellé, empreinte, coché) ? */
export function sameValue(current: ObservedValue | undefined, wanted: ObservedValue): boolean {
  if (!current) return false;
  const lower = (text: string | undefined): string | undefined => text?.trim().toLowerCase();
  if (wanted.checked !== undefined) return current.checked === wanted.checked;
  if (wanted.code !== undefined && current.code !== undefined && lower(wanted.code) === lower(current.code))
    return true;
  if (
    wanted.option !== undefined &&
    current.option !== undefined &&
    lower(wanted.option) === lower(current.option)
  )
    return true;
  // Une valeur de scénario écrite comme le code ou le libellé d'une option.
  if (
    wanted.option !== undefined &&
    current.code !== undefined &&
    lower(wanted.option) === lower(current.code)
  )
    return true;
  return wanted.digest !== undefined && current.digest !== undefined && wanted.digest === current.digest;
}
