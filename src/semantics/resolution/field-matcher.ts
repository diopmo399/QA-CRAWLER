import type { CheckIntent, FillIntent, SelectIntent } from './intent.js';
import { describeIntent } from './intent.js';
import type { FieldDescriptor } from './field-descriptor.js';
import { containsPhrase, matchKey, normalizeForMatch, tokenOverlap } from './normalize.js';
import { OptionResolver, type OptionChoice, type OptionResolution } from './option-resolver.js';
import {
  decide,
  levelOf,
  rank,
  renderComponent,
  candidateOf,
  targetSignature,
  type ResolutionCandidate,
  type ResolutionStatus,
  type ResolutionThresholds,
  type ScoreComponent,
} from './resolution.js';
import { MAX_HISTORY_POINTS, type SemanticHistory } from './semantic-history.js';
import {
  classifyValue,
  valueFieldCompatibility,
  type SemanticValueType,
  type ValueClassification,
} from './value-classifier.js';
import type { SemanticVocabulary } from './vocabulary.js';
import type { FieldProvenance } from '../../static-analysis/model.js';
import { STATIC_EVIDENCE_WEIGHTS } from '../../static-analysis/static-knowledge.js';

export type FieldIntent = FillIntent | SelectIntent | CheckIntent;

export interface SemanticResolutionContext {
  /** Signature de l'écran (la clé de l'historique). */
  stateSignature: string;
  /** Le formulaire du champ précédent du scénario : un formulaire se remplit d'un tenant. */
  previousFormGroup?: string;
  history?: SemanticHistory;
  /** La valeur est-elle sensible (mot de passe, OTP…) ? Son type n'est alors pas affiché. */
  sensitiveValue?: boolean;
  /**
   * Les preuves de l'ANALYSE STATIQUE d'un champ (formControlName → code → DTO → API →
   * OpenAPI), lues dans un index en mémoire. Absent : l'analyse statique est coupée et
   * rien ne change.
   */
  staticEvidence?: (field: FieldDescriptor) => readonly FieldProvenance[];
}

/** Une cible de champ : un champ, ou un groupe de radios (SELECT « Mensuel » comme fréquence). */
export interface FieldTarget {
  id: string;
  label: string;
  field: FieldDescriptor;
  /** Groupe de radios : ses choix, chacun avec son champ. */
  radios?: FieldDescriptor[];
}

/** Une cible évaluée : le candidat, la cible, et l'option choisie (SELECT). */
export interface ScoredTarget {
  candidate: ResolutionCandidate;
  target: FieldTarget;
  option?: OptionResolution & { radio?: FieldDescriptor };
}

export interface FieldResolution {
  status: ResolutionStatus;
  intent: string;
  /** La clé de l'intention dans l'historique : « fill:courriel ». */
  intentKey: string;
  selected?: FieldTarget;
  /** SELECT : l'option choisie, et le champ à cocher pour un groupe de radios. */
  option?: OptionResolution & { radio?: FieldDescriptor };
  score: number;
  confidence: string;
  valueType?: SemanticValueType;
  candidates: ResolutionCandidate[];
  reasons: string[];
  /** Signature sémantique de la cible (mémoire), quand elle est résolue. */
  targetSignature?: string;
}

/** Le concept qu'une valeur révèle : un courriel, un téléphone, une adresse web, une date. */
const VALUE_CONCEPTS: Partial<Record<SemanticValueType, readonly string[]>> = {
  EMAIL: ['email'],
  PHONE: ['phone'],
  URL: ['website'],
  DATE: ['birthDate', 'startDate', 'endDate'],
};

const STRICT_TYPES = new Set([
  'email',
  'tel',
  'date',
  'datetime',
  'time',
  'number',
  'url',
  'password',
  'range',
]);

/**
 * FIELD MATCHER : « courriel » → le champ « Adresse électronique » (name=electronicMail,
 * type=email). Chaque point a sa raison ; aucun modèle, aucune formule opaque.
 *
 *   score = libellé + alias + attributs + autocomplete + type + valeur + genre
 *         + options + formulaire + historique     (borné à 0..100, divisé par 100)
 *
 * Priorité des preuves : libellé réel (70) > alias du vocabulaire (50) > attributs
 * sémantiques (25) > type (15) > valeur (15) > contexte (8) > historique (15 au plus) :
 * l'historique départage, il ne renverse jamais une preuve forte du DOM.
 */
export class FieldMatcher {
  private readonly options: OptionResolver;

  constructor(
    private readonly vocabulary: SemanticVocabulary,
    private readonly thresholds: ResolutionThresholds,
  ) {
    this.options = new OptionResolver(vocabulary, thresholds);
  }

  resolve(
    intent: FieldIntent,
    fields: readonly FieldDescriptor[],
    context: SemanticResolutionContext,
  ): FieldResolution {
    const intentKey = `${intent.kind.toLowerCase()}:${matchKey(intent.field)}`;
    const value =
      intent.kind === 'FILL' && typeof intent.value === 'string' ? classifyValue(intent.value) : undefined;
    const targets = targetsFor(intent, fields);
    const scored = targets.map((target) => this.scoreTarget(intent, target, value, context, intentKey));
    const candidates = rank(scored.map((entry) => entry.candidate));
    const decision = decide(candidates, this.thresholds);
    const best = decision.best ? scored.find((entry) => entry.candidate.id === decision.best?.id) : undefined;
    const common = {
      intent: describeIntent(intent),
      intentKey,
      ...(value && !context.sensitiveValue ? { valueType: value.type } : {}),
      candidates: candidates.slice(0, 5),
    };
    if (decision.status !== 'RESOLVED' || !best)
      return {
        ...common,
        status: decision.status,
        score: decision.best?.score ?? 0,
        confidence: levelOf(decision.best?.score ?? 0),
        // Une contradiction des preuves n'est jamais masquée, même sans résolution.
        reasons: [decision.reason, ...conflictsOf(candidates.slice(0, 3))],
      };
    // Une option de liste (SELECT) doit elle aussi être résolue.
    if (best.option && best.option.status !== 'RESOLVED' && best.option.status !== 'UNVERIFIED')
      return {
        ...common,
        status: best.option.status,
        selected: best.target,
        option: best.option,
        score: best.candidate.score,
        confidence: levelOf(best.candidate.score),
        reasons: [
          `field "${best.target.label}" found, option "${(intent as SelectIntent).option}": ${best.option.reasons[0] ?? ''}`,
        ],
      };
    const field = best.option?.radio ?? best.target.field;
    if (field.payment)
      return {
        ...common,
        status: 'BLOCKED',
        selected: best.target,
        score: best.candidate.score,
        confidence: levelOf(best.candidate.score),
        reasons: ['payment field: never filled automatically'],
      };
    return {
      ...common,
      status: 'RESOLVED',
      selected: best.target,
      ...(best.option ? { option: best.option } : {}),
      score: best.candidate.score,
      confidence: levelOf(best.candidate.score),
      reasons: [decision.reason, ...best.candidate.components.map(renderComponent)],
      targetSignature: fieldTargetSignature(best.target),
    };
  }

  /** Le score d'une cible pour une intention, composante par composante (utilisé aussi par le FormIntentResolver). */
  scoreTarget(
    intent: FieldIntent,
    target: FieldTarget,
    value: ValueClassification | undefined,
    context: SemanticResolutionContext,
    intentKey: string,
  ): {
    candidate: ResolutionCandidate;
    target: FieldTarget;
    option?: OptionResolution & { radio?: FieldDescriptor };
  } {
    const { field } = target;
    const components: ScoreComponent[] = [];
    const wanted = normalizeForMatch(intent.field);
    const wantedKey = wanted.tokens.join(' ');
    const wantedConcept = this.vocabulary.conceptOf(intent.field);

    // ---- libellé réel (ou nom accessible) : la preuve la plus forte
    const labels = [target.label, field.ariaLabel].filter((text): text is string => Boolean(text));
    let labelPoints = 0;
    let labelDetail = '';
    for (const label of labels) {
      const tokens = normalizeForMatch(label).tokens;
      const key = tokens.join(' ');
      let points = 0;
      let detail = '';
      if (key !== '' && key === wantedKey) {
        points = 70;
        detail = `label "${label}" = "${intent.field}"`;
      } else if (containsPhrase(tokens, wanted.tokens)) {
        const extra = tokens.length - wanted.tokens.length;
        points = Math.max(20, 40 - 5 * extra);
        detail = `label "${label}" contains "${intent.field}"`;
      } else {
        const overlap = tokenOverlap(wanted.tokens, tokens);
        if (overlap.ratio >= 0.5) {
          points = Math.round(20 * overlap.ratio);
          detail = `label "${label}" shares ${overlap.common} word(s) with "${intent.field}"`;
        }
      }
      if (points > labelPoints) {
        labelPoints = points;
        labelDetail = detail;
      }
    }
    if (labelPoints > 0) components.push({ factor: 'label', points: labelPoints, detail: labelDetail });

    // ---- alias du vocabulaire : « courriel » et « Adresse électronique » veulent dire email
    const labelConcept = labels.map((label) => this.vocabulary.conceptOf(label)).find(Boolean);
    if (wantedConcept && labelConcept) {
      if (labelConcept.concept === wantedConcept.concept)
        components.push({
          factor: 'alias',
          points: labelConcept.exact ? 70 : 30,
          detail: `semantic alias "${intent.field}" → ${wantedConcept.concept} ← label "${target.label}"`,
        });
      else if (labelPoints < 70)
        components.push({
          factor: 'alias',
          points: -20,
          detail: `label "${target.label}" means ${labelConcept.concept}, not ${wantedConcept.concept}`,
        });
    }

    // ---- attributs sémantiques : name, id, placeholder
    const attributes: [string, string | undefined][] = [
      ['name', field.name],
      ['id', field.idAttribute],
      ['placeholder', field.placeholder],
    ];
    let attribute: ScoreComponent | undefined;
    const aliasKeys = new Set(
      wantedConcept ? this.vocabulary.aliasesOf(wantedConcept.concept).map((alias) => matchKey(alias)) : [],
    );
    for (const [kind, text] of attributes) {
      if (!text) continue;
      const tokens = normalizeForMatch(text).tokens;
      const key = tokens.join(' ');
      const concept = this.vocabulary.conceptOf(text);
      let candidate: ScoreComponent | undefined;
      if (key === wantedKey || aliasKeys.has(key))
        candidate = { factor: 'attribute', points: 25, detail: `${kind}="${text}" names "${intent.field}"` };
      else if (wantedConcept && concept?.concept === wantedConcept.concept)
        candidate = {
          factor: 'attribute',
          points: 20,
          detail: `${kind}="${text}" means ${wantedConcept.concept}`,
        };
      else if (containsPhrase(tokens, wanted.tokens))
        candidate = {
          factor: 'attribute',
          points: 12,
          detail: `${kind}="${text}" contains "${intent.field}"`,
        };
      if (candidate && (!attribute || candidate.points > attribute.points)) attribute = candidate;
    }
    if (attribute) components.push(attribute);

    // ---- autocomplete (norme HTML)
    const autoConcept = this.vocabulary.conceptOfAutocomplete(field.autocomplete);
    if (wantedConcept && autoConcept === wantedConcept.concept)
      components.push({
        factor: 'autocomplete',
        points: 25,
        detail: `autocomplete="${field.autocomplete ?? ''}" means ${autoConcept}`,
      });

    // ---- analyse statique : ce que le code, le DTO, l'API et OpenAPI disent du champ
    const provenances = context.staticEvidence && field.frameworkName ? context.staticEvidence(field) : [];
    const staticConcepts = new Set(provenances.map((provenance) => provenance.concept));
    const staticConcept = staticConcepts.size === 1 ? [...staticConcepts][0] : undefined;
    if (provenances.length > 0)
      components.push(
        ...staticComponents(provenances, field, wantedConcept?.concept, wantedKey, this.vocabulary),
      );

    // ---- type du champ attendu par le concept
    const expected = this.vocabulary.expectedTypes(wantedConcept?.concept);
    if (expected.includes(field.type))
      components.push({
        factor: 'type',
        points: 15,
        detail: `type=${field.type} expected for ${wantedConcept?.concept ?? ''}`,
      });
    else if (
      expected.length > 0 &&
      STRICT_TYPES.has(field.type) &&
      expected.every((type) => STRICT_TYPES.has(type))
    )
      components.push({
        factor: 'type',
        points: -30,
        detail: `type=${field.type}, ${wantedConcept?.concept ?? ''} expects ${expected.join('/')}`,
      });

    // ---- la valeur du scénario (un signal, jamais une certitude)
    if (value && intent.kind === 'FILL') {
      const compatibility = valueFieldCompatibility(
        value,
        field.type === 'datetime' ? 'datetime-local' : field.type,
      );
      const shown = context.sensitiveValue ? 'value' : `value ${value.type}`;
      if (compatibility === 'compatible')
        components.push({ factor: 'value', points: 15, detail: `${shown} fits type=${field.type}` });
      else if (compatibility === 'conflict')
        components.push({
          factor: 'value',
          points: -120,
          detail: `${shown} does not fit type=${field.type}`,
        });
    }

    // ---- ce que la valeur dit du champ : un courriel va dans le champ courriel
    const valueConcept = value ? VALUE_CONCEPTS[value.type] : undefined;
    const fieldConcept =
      labelConcept?.concept ??
      [field.name, field.idAttribute, field.placeholder]
        .map((text) => this.vocabulary.conceptOf(text)?.concept)
        .find(Boolean) ??
      autoConcept ??
      staticConcept;
    if (valueConcept && fieldConcept && intent.kind === 'FILL' && !context.sensitiveValue) {
      if (valueConcept.includes(fieldConcept))
        components.push({
          factor: 'value',
          points: 30,
          detail: `value ${value?.type ?? ''} and the field both mean ${fieldConcept}`,
        });
      else
        components.push({
          factor: 'value',
          points: -15,
          detail: `value ${value?.type ?? ''} does not mean ${fieldConcept}`,
        });
    }

    // ---- genre de champ attendu par l'intention
    const kind = kindComponent(intent, field, target.radios !== undefined);
    if (kind) components.push(kind);

    // ---- option d'une liste ou d'un groupe de radios
    let option: (OptionResolution & { radio?: FieldDescriptor }) | undefined;
    if (intent.kind === 'SELECT') {
      const choices: OptionChoice[] | undefined = target.radios
        ? target.radios.map((radio) => ({
            label: radio.label ?? radio.ariaLabel ?? '',
            id: radio.id,
            disabled: radio.disabled,
          }))
        : field.options?.map((entry) => ({
            label: entry.label,
            disabled: entry.disabled,
            placeholder: entry.placeholder,
          }));
      const resolution = this.options.resolve(intent.option, choices, {
        intentKey,
        signatureOf: (choice) => `${fieldTargetSignature(target)}#${matchKey(choice.label)}`,
        ...(context.history ? { history: context.history } : {}),
      });
      const radio = target.radios?.find((entry) => entry.id === resolution.selected?.id);
      option = { ...resolution, ...(radio ? { radio } : {}) };
      if (resolution.status === 'RESOLVED')
        components.push({
          factor: 'option',
          points: 15,
          detail: `option "${resolution.selected?.label ?? ''}" available`,
        });
      else if (resolution.status === 'NOT_FOUND')
        components.push({ factor: 'option', points: -40, detail: `no option like "${intent.option}"` });
      else if (resolution.status === 'AMBIGUOUS')
        components.push({ factor: 'option', points: -10, detail: `option "${intent.option}" is ambiguous` });
    }

    // ---- contexte : le formulaire du scénario, ce qui est devant l'écran
    if (context.previousFormGroup && field.formGroup === context.previousFormGroup)
      components.push({ factor: 'form', points: 5, detail: 'same form as the previous step' });
    if (field.foreground)
      components.push({ factor: 'context', points: 3, detail: 'in the foreground (dialog, drawer)' });

    // ---- historique (signal borné, seulement pour un candidat déjà plausible)
    const signature = fieldTargetSignature(target);
    const signal = context.history?.signalFor(intentKey, signature);
    const plausible = components.reduce((sum, component) => sum + component.points, 0) > 0;
    if (signal && plausible && signal.confidence > 0)
      components.push({
        factor: 'history',
        points: Math.round(MAX_HISTORY_POINTS * signal.confidence),
        detail: `historical match ${signal.detail}`,
      });

    if (field.disabled) components.push({ factor: 'kind', points: -100, detail: 'disabled or read-only' });

    return {
      candidate: candidateOf(target.id, target.label, components),
      target,
      ...(option ? { option } : {}),
    };
  }
}

/** La signature sémantique d'une cible de champ (jamais un id DOM généré). */
export function fieldTargetSignature(target: FieldTarget): string {
  return targetSignature({
    kind: target.radios ? 'radio-group' : 'field',
    label: target.label,
    ...(target.field.name && !target.radios ? { name: target.field.name } : {}),
    type: target.radios ? 'radio' : target.field.type,
    ...(target.field.autocomplete ? { autocomplete: target.field.autocomplete } : {}),
  });
}

/** Les cibles possibles d'une intention : champs de saisie, listes, groupes de radios, cases. */
export function targetsFor(intent: FieldIntent, fields: readonly FieldDescriptor[]): FieldTarget[] {
  const labelOf = (field: FieldDescriptor): string =>
    field.label ?? field.ariaLabel ?? field.placeholder ?? field.name ?? field.type;
  if (intent.kind === 'CHECK')
    return fields
      .filter((field) => field.type === 'checkbox' || field.type === 'radio')
      .map((field) => ({ id: field.id, label: labelOf(field), field }));
  const single = fields
    .filter((field) => field.type !== 'checkbox' && field.type !== 'radio')
    .map((field) => ({ id: field.id, label: labelOf(field), field }));
  if (intent.kind === 'FILL') return single;
  // SELECT : les listes, et chaque groupe de radios comme un seul champ.
  const groups = new Map<string, FieldDescriptor[]>();
  for (const field of fields)
    if (field.type === 'radio' && field.choiceGroup !== undefined)
      groups.set(field.choiceGroup, [...(groups.get(field.choiceGroup) ?? []), field]);
  const radioGroups = [...groups.entries()].flatMap(([group, radios]): FieldTarget[] => {
    const first = radios[0];
    if (!first) return [];
    return [{ id: `radio-group:${group}`, label: first.groupLabel ?? group, field: first, radios }];
  });
  return [...single, ...radioGroups];
}

function kindComponent(
  intent: FieldIntent,
  field: FieldDescriptor,
  radioGroup: boolean,
): ScoreComponent | undefined {
  const listLike = field.type === 'select' || field.type === 'combobox' || field.type === 'autocomplete';
  switch (intent.kind) {
    case 'SELECT':
      if (radioGroup || listLike)
        return {
          factor: 'kind',
          points: 10,
          detail: `${radioGroup ? 'radio group' : field.type}: a choice list`,
        };
      return { factor: 'kind', points: -30, detail: `${field.type} is not a choice list` };
    case 'FILL':
      if (field.type === 'select' || field.type === 'combobox')
        return { factor: 'kind', points: -10, detail: `${field.type}: chosen, not typed` };
      return undefined;
    case 'CHECK':
      return field.type === 'checkbox'
        ? { factor: 'kind', points: 10, detail: 'checkbox' }
        : { factor: 'kind', points: -5, detail: 'radio button' };
  }
}

/** Ce que le type du DOM impose comme concept (un champ type=tel est un téléphone). */
const DOM_TYPE_CONCEPTS: Readonly<Record<string, string>> = { email: 'email', tel: 'phone', url: 'website' };

/**
 * Les composantes « static » d'un champ : les preuves fortes (flux de données, DTO,
 * OpenAPI) qui signifient le concept de l'intention, leur convergence, la simple
 * similitude de formControlName, et les contradictions — jamais masquées
 * (SEMANTIC_EVIDENCE_CONFLICT). Les poids viennent de STATIC_EVIDENCE_WEIGHTS.
 */
export function staticComponents(
  provenances: readonly FieldProvenance[],
  field: FieldDescriptor,
  wantedConcept: string | undefined,
  wantedKey: string,
  vocabulary: SemanticVocabulary,
): ScoreComponent[] {
  const { points, strongSources } = STATIC_EVIDENCE_WEIGHTS;
  const concepts = new Set(provenances.map((provenance) => provenance.concept ?? ''));
  const [provenance] = provenances;
  if (!provenance) return [];
  // Le même formControlName dans deux composants qui divergent : pas de preuve utilisable.
  if (concepts.size > 1)
    return [
      {
        factor: 'static',
        points: 0,
        detail: `formControlName="${provenance.control}" is used by ${String(provenances.length)} components with different meanings: no static evidence used`,
      },
    ];
  const components: ScoreComponent[] = [];
  const chain = `${provenance.chain.join(' → ')}${provenance.sourceOrigin ? ` [code from ${provenance.sourceOrigin}]` : ''}`;
  const strong = provenance.evidence.filter((entry) => entry.concept && strongSources.includes(entry.source));
  const matching = wantedConcept ? strong.filter((entry) => entry.concept === wantedConcept) : [];
  if (matching.length > 0 && provenance.concept === wantedConcept) {
    const sources = new Set(matching.map((entry) => entry.source));
    components.push({
      factor: 'static',
      points: points.strong,
      detail: `static evidence means ${wantedConcept ?? ''}: ${chain}`,
    });
    if (sources.size > 1)
      components.push({
        factor: 'static',
        points: Math.min(points.convergenceMax, points.convergence * (sources.size - 1)),
        detail: `${String(sources.size)} independent sources agree (${[...sources].join(', ')})`,
      });
  } else if (wantedConcept && provenance.concept && provenance.concept !== wantedConcept) {
    components.push({
      factor: 'static',
      points: points.contradiction,
      detail: `static evidence means ${provenance.concept}, not ${wantedConcept}: ${chain}`,
    });
  } else {
    const name = provenance.control;
    if (
      (wantedKey !== '' &&
        vocabulary.conceptOf(name) === undefined &&
        name.toLowerCase() === wantedKey.replace(/ /g, '')) ||
      (wantedConcept !== undefined && vocabulary.conceptOf(name)?.concept === wantedConcept)
    )
      components.push({
        factor: 'static',
        points: points.medium,
        detail: `formControlName="${name}" names the field`,
      });
  }
  // Contradictions : le type du DOM, ou des preuves statiques qui divergent.
  const domConcept = DOM_TYPE_CONCEPTS[field.type];
  if (domConcept && provenance.concept && domConcept !== provenance.concept)
    components.push({
      factor: 'static',
      points: -5,
      detail: `SEMANTIC_EVIDENCE_CONFLICT: DOM type=${field.type} means ${domConcept}, code/API mean ${provenance.concept}`,
    });
  for (const conflict of provenance.conflicts)
    components.push({
      factor: 'static',
      points: 0,
      detail: `SEMANTIC_EVIDENCE_CONFLICT: ${conflict.detail}`,
    });
  return components;
}

function conflictsOf(candidates: readonly ResolutionCandidate[]): string[] {
  return candidates.flatMap((candidate) =>
    candidate.components
      .filter((component) => component.detail.startsWith('SEMANTIC_EVIDENCE_CONFLICT'))
      .map((component) => `"${candidate.label}": ${component.detail}`),
  );
}
