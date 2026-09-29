import { DomFormAnalyzer } from '../../forms/form-analyzer.js';
import type { DiscoveredForm } from '../../forms/form-model.js';
import type { DiscoveredAction } from '../../model/discovered-action.js';
import type { PageContext } from '../../model/page-context.js';
import type { SemanticDictionary } from '../semantic-dictionary.js';
import { ActionResolver } from './action-resolver.js';
import { fieldDescriptors, type FieldDescriptor } from './field-descriptor.js';
import { FieldMatcher } from './field-matcher.js';
import { FormIntentResolver, type FormIntentPlan } from './form-intent-resolver.js';
import { describeIntent, type GherkinIntent } from './intent.js';
import { NavigationResolver } from './navigation-resolver.js';
import { matchKey, normalizeForMatch } from './normalize.js';
import {
  explainResolution,
  levelOf,
  type ResolutionCandidate,
  type ResolutionStatus,
  type ResolutionThresholds,
} from './resolution.js';
import type { SemanticHistory } from './semantic-history.js';
import { SemanticVocabulary, type VocabularyInput } from './vocabulary.js';

/** Ce que l'exécution doit faire de la cible résolue (elle repasse par la SafetyPolicy). */
export type ResolvedTarget =
  | {
      kind: 'field';
      field: FieldDescriptor;
      operation: 'fill' | 'select' | 'check' | 'uncheck';
      option?: string;
    }
  | { kind: 'action'; action: DiscoveredAction }
  | { kind: 'here'; page: string }
  | { kind: 'form'; plan: FormIntentPlan }
  | { kind: 'synthetic-form'; form: DiscoveredForm };

export interface SemanticResolution {
  intent: GherkinIntent;
  description: string;
  /** La clé de l'intention dans l'historique (« fill:courriel »). */
  intentKey: string;
  status: ResolutionStatus;
  target?: ResolvedTarget;
  score: number;
  confidence: string;
  valueType?: string;
  reasons: string[];
  candidates: Pick<ResolutionCandidate, 'label' | 'score'>[];
  /** Signature sémantique de la cible (mémoire), quand elle est résolue. */
  targetSignature?: string;
  /** GHERKIN RESOLUTION en clair (jamais une valeur). */
  explanation: string[];
}

export interface SemanticResolverOptions extends ResolutionThresholds {
  vocabulary?: VocabularyInput;
}

export interface ResolveOptions {
  stateSignature: string;
  previousFormGroup?: string;
  history?: SemanticHistory;
  /** La phrase du scénario, pour l'explication. */
  sentence?: string;
  /** La valeur vient d'une variable d'environnement, ou le champ est sensible : jamais affichée. */
  sensitiveValue?: boolean;
}

const TITLES: Record<GherkinIntent['kind'], string> = {
  NAVIGATE: 'NAVIGATION',
  CLICK: 'ACTION',
  FILL: 'FIELD MATCH',
  SELECT: 'FIELD MATCH',
  CHECK: 'FIELD MATCH',
  UPLOAD: 'FIELD MATCH',
  SUBMIT: 'ACTION',
  FILL_FORM: 'FORM',
  ASSERT: 'ASSERTION',
};

/**
 * SEMANTIC RESOLVER : la façade.
 *
 *   FieldMatcher · OptionResolver · ActionResolver · NavigationResolver · FormIntentResolver
 *
 * Il ne clique pas, ne remplit pas, ne navigue pas : INTENTION → CIBLE. L'exécution
 * reste celle des flows, avec la SafetyPolicy avant Playwright. Tout est en mémoire :
 * l'écran observé (PageContext) et l'historique déjà préchargé (SemanticHistory).
 */
export class SemanticResolver {
  readonly vocabulary: SemanticVocabulary;
  private readonly fields: FieldMatcher;
  private readonly actions: ActionResolver;
  private readonly navigation: NavigationResolver;
  private readonly forms: FormIntentResolver;
  private readonly analyzer = new DomFormAnalyzer();

  constructor(
    dictionary: SemanticDictionary,
    private readonly options: SemanticResolverOptions,
  ) {
    this.vocabulary = new SemanticVocabulary(dictionary, options.vocabulary);
    this.fields = new FieldMatcher(this.vocabulary, options);
    this.actions = new ActionResolver(this.vocabulary, dictionary, options);
    this.navigation = new NavigationResolver(dictionary, options);
    this.forms = new FormIntentResolver(this.fields, options);
  }

  resolve(intent: GherkinIntent, context: PageContext, options: ResolveOptions): SemanticResolution {
    const resolution = this.resolveIntent(intent, context, options);
    return {
      ...resolution,
      explanation: explainResolution({
        title: TITLES[intent.kind],
        ...(options.sentence ? { step: options.sentence } : {}),
        intent: resolution.description,
        ...(resolution.valueType ? { valueType: resolution.valueType } : {}),
        ...(options.sensitiveValue && intent.kind === 'FILL' ? { valueRedacted: true } : {}),
        status: resolution.status,
        ...(selectedLabel(resolution.target) ? { selected: selectedLabel(resolution.target) } : {}),
        score: resolution.score,
        confidence: resolution.confidence,
        reasons: resolution.reasons,
        candidates: resolution.candidates,
      }),
    };
  }

  private resolveIntent(
    intent: GherkinIntent,
    context: PageContext,
    options: ResolveOptions,
  ): Omit<SemanticResolution, 'explanation'> {
    const description = describeIntent(intent);
    const matchContext = {
      stateSignature: options.stateSignature,
      ...(options.previousFormGroup ? { previousFormGroup: options.previousFormGroup } : {}),
      ...(options.history ? { history: options.history } : {}),
      ...(options.sensitiveValue ? { sensitiveValue: true } : {}),
    };
    switch (intent.kind) {
      case 'FILL':
      case 'SELECT':
      case 'CHECK': {
        const result = this.fields.resolve(intent, fieldDescriptors(context.actions), matchContext);
        const radio = result.option?.radio;
        const field = radio ?? result.selected?.field;
        const operation =
          intent.kind === 'CHECK'
            ? intent.checked
              ? 'check'
              : 'uncheck'
            : radio
              ? 'check'
              : intent.kind === 'SELECT' || field?.type === 'select' || field?.type === 'combobox'
                ? 'select'
                : 'fill';
        const option =
          intent.kind === 'SELECT' && !radio
            ? result.option?.selected?.label
            : intent.kind === 'FILL' && operation === 'select' && typeof intent.value === 'string'
              ? intent.value
              : undefined;
        return {
          intent,
          description,
          intentKey: result.intentKey,
          status: result.status,
          ...(result.status === 'RESOLVED' && field
            ? { target: { kind: 'field', field, operation, ...(option !== undefined ? { option } : {}) } }
            : {}),
          score: result.score,
          confidence: result.confidence,
          ...(result.valueType ? { valueType: result.valueType } : {}),
          reasons: [
            ...result.reasons,
            ...(result.option && result.option.status !== 'RESOLVED'
              ? result.option.reasons.slice(0, 1)
              : []),
          ],
          candidates: result.candidates,
          ...(result.targetSignature ? { targetSignature: result.targetSignature } : {}),
        };
      }
      case 'UPLOAD':
        return {
          intent,
          description,
          intentKey: `upload:${matchKey(intent.field)}`,
          status: 'BLOCKED',
          score: 0,
          confidence: levelOf(0),
          reasons: ['file upload is never automated by the semantic resolution (safety)'],
          candidates: [],
        };
      case 'SUBMIT':
      case 'CLICK': {
        const result =
          intent.kind === 'SUBMIT'
            ? this.actions.resolveFormAction(intent, context.actions, matchContext)
            : this.actions.resolveClick(intent, context.actions, matchContext);
        return {
          intent,
          description,
          intentKey: result.intentKey,
          status: result.status,
          ...(result.selected ? { target: { kind: 'action', action: result.selected } } : {}),
          score: result.score,
          confidence: result.confidence,
          reasons: result.reasons,
          candidates: result.candidates,
          ...(result.targetSignature ? { targetSignature: result.targetSignature } : {}),
        };
      }
      case 'NAVIGATE': {
        const result = this.navigation.resolve(intent, context, matchContext);
        return {
          intent,
          description,
          intentKey: result.intentKey,
          status: result.status,
          ...(result.alreadyThere
            ? { target: { kind: 'here', page: result.alreadyThere } }
            : result.selected
              ? { target: { kind: 'action', action: result.selected } }
              : {}),
          score: result.score,
          confidence: result.confidence,
          reasons: result.reasons,
          candidates: result.candidates,
          ...(result.targetSignature ? { targetSignature: result.targetSignature } : {}),
        };
      }
      case 'FILL_FORM':
        return intent.rows
          ? this.resolveForm({ ...intent, rows: intent.rows }, context, matchContext, description)
          : this.resolveSyntheticForm(intent.form, context, description, intent);
      case 'ASSERT':
        return {
          intent,
          description,
          intentKey: `assert:${intent.assertion.toLowerCase()}`,
          status: 'NOT_FOUND',
          score: 0,
          confidence: levelOf(0),
          reasons: ['assertions are checked on the page by the explorer'],
          candidates: [],
        };
    }
  }

  private resolveForm(
    intent: Extract<GherkinIntent, { kind: 'FILL_FORM' }> & {
      rows: NonNullable<Extract<GherkinIntent, { kind: 'FILL_FORM' }>['rows']>;
    },
    context: PageContext,
    matchContext: Parameters<FieldMatcher['resolve']>[2],
    description: string,
  ): Omit<SemanticResolution, 'explanation'> {
    const plan = this.forms.resolve(intent, fieldDescriptors(context.actions), matchContext);
    const status: ResolutionStatus =
      plan.blocked.length > 0
        ? 'BLOCKED'
        : plan.unresolved.length > 0
          ? 'NOT_FOUND'
          : plan.ambiguous.length > 0
            ? 'AMBIGUOUS'
            : 'RESOLVED';
    const confidence =
      plan.mappings.length > 0 ? Math.min(...plan.mappings.map((mapping) => mapping.confidence)) : 0;
    return {
      intent,
      description,
      intentKey: `fill_form:${matchKey(intent.form ?? '')}`,
      status,
      target: { kind: 'form', plan },
      score: confidence,
      confidence: levelOf(confidence),
      reasons: [
        ...plan.mappings.map(
          (mapping) => `"${mapping.intent}" → "${mapping.target}" ${mapping.confidence} ${mapping.level}`,
        ),
        ...plan.ambiguous.map((issue) => `AMBIGUOUS "${issue.intent}": ${issue.reason}`),
        ...plan.unresolved.map((issue) => `NOT_FOUND "${issue.intent}": ${issue.reason}`),
        ...plan.blocked.map((issue) => `BLOCKED "${issue.intent}": ${issue.reason}`),
      ],
      candidates: [],
    };
  }

  /** « je remplis le formulaire utilisateur » : le formulaire, rempli ensuite avec les données synthétiques. */
  private resolveSyntheticForm(
    name: string | undefined,
    context: PageContext,
    description: string,
    intent: GherkinIntent,
  ): Omit<SemanticResolution, 'explanation'> {
    const forms = this.analyzer.formsOf(context);
    const wanted = normalizeForMatch(name).tokens;
    const named =
      wanted.length > 0
        ? forms.filter((form) => wanted.every((token) => normalizeForMatch(form.name).tokens.includes(token)))
        : [];
    const front = forms.filter((form) => form.foreground);
    const choice = named.length === 1 ? named : front.length === 1 ? front : forms.length === 1 ? forms : [];
    const [form] = choice;
    const common = {
      intent,
      description,
      intentKey: `fill_form:${matchKey(name ?? '')}`,
      candidates: forms.map((entry) => ({ label: entry.name, score: entry === form ? 1 : 0 })),
    };
    if (!form)
      return {
        ...common,
        status: forms.length === 0 ? 'NOT_FOUND' : 'AMBIGUOUS',
        score: 0,
        confidence: levelOf(0),
        reasons: [
          forms.length === 0
            ? 'no form on the screen'
            : `${forms.length} forms and none named "${name ?? ''}"`,
        ],
      };
    return {
      ...common,
      status: 'RESOLVED',
      target: { kind: 'synthetic-form', form },
      score: 1,
      confidence: levelOf(1),
      reasons: [
        named.length === 1
          ? `form "${form.name}" named in the scenario`
          : front.length === 1
            ? `form "${form.name}" in the foreground`
            : `the only form: "${form.name}"`,
        `${form.fields.length} field(s), filled with synthetic data (TestDataProvider)`,
      ],
    };
  }
}

function selectedLabel(target: ResolvedTarget | undefined): string | undefined {
  if (!target) return undefined;
  switch (target.kind) {
    case 'field':
      return target.field.label ?? target.field.ariaLabel ?? target.field.name;
    case 'action':
      return target.action.text ?? target.action.label ?? target.action.name;
    case 'here':
      return `already on ${target.page}`;
    case 'form':
      return target.plan.form ?? 'form';
    case 'synthetic-form':
      return target.form.name;
  }
}
