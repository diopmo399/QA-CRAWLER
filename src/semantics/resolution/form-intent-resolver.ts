import type { FormFillPlan } from '../../forms/form-model.js';
import type { FieldDescriptor } from './field-descriptor.js';
import {
  targetsFor,
  fieldTargetSignature,
  type FieldIntent,
  type FieldMatcher,
  type FieldTarget,
  type ScoredTarget,
  type SemanticResolutionContext,
} from './field-matcher.js';
import type { FillFormIntent, IntentValue } from './intent.js';
import { matchKey, normalizeForMatch } from './normalize.js';
import {
  levelOf,
  POINTS_FOR_CERTAINTY,
  renderComponent,
  type ResolutionCandidate,
  type ResolutionThresholds,
} from './resolution.js';
import { classifyValue } from './value-classifier.js';

/** Une ligne du tableau résolue vers un champ. */
export interface FormMapping {
  /** « prénom » : la ligne du scénario. */
  intent: string;
  /** Ce que l'écran montre : « Prénom ». */
  target: string;
  fieldId: string;
  operation: 'fill' | 'select' | 'check' | 'uncheck';
  /** Le champ à remplir (pour un groupe de radios : la radio choisie). */
  field: FieldDescriptor;
  value: IntentValue;
  /** SELECT : le libellé exact de l'option à l'écran. */
  option?: string;
  confidence: number;
  level: string;
  reasons: string[];
  intentKey: string;
  targetSignature: string;
}

export interface FormIntentIssue {
  intent: string;
  reason: string;
  candidates: Pick<ResolutionCandidate, 'label' | 'score'>[];
}

/**
 * LE PLAN D'UN FORMULAIRE, calculé AVANT toute saisie :
 *
 *   { form, mappings: [prénom → Prénom 0.98, …], unresolved: [], ambiguous: [], blocked: [] }
 *
 * Exécutable seulement quand unresolved, ambiguous et blocked sont vides.
 */
export interface FormIntentPlan {
  form?: string;
  formGroup?: string;
  mappings: FormMapping[];
  unresolved: FormIntentIssue[];
  ambiguous: FormIntentIssue[];
  blocked: FormIntentIssue[];
}

const YES = new Set(['oui', 'yes', 'true', 'vrai', 'x', 'coche', 'checked', '1', 'on']);

/**
 * FORM INTENT RESOLVER : tout le tableau d'un coup, pas champ par champ.
 *
 * 1. chaque ligne est notée contre chaque champ (FieldMatcher, mêmes composantes) ;
 * 2. appariement global déterministe : les paires les plus sûres d'abord, un champ ne
 *    reçoit qu'une ligne ;
 * 3. deux lignes qui revendiquent le même champ avec des scores proches (« prénom » et
 *    « nom » → « Name ») : les deux sont AMBIGUOUS — jamais la première par défaut ;
 * 4. chaque ligne doit franchir le seuil ET distancer sa meilleure autre possibilité.
 */
export class FormIntentResolver {
  constructor(
    private readonly matcher: FieldMatcher,
    private readonly thresholds: ResolutionThresholds,
  ) {}

  resolve(
    intent: FillFormIntent & { rows: NonNullable<FillFormIntent['rows']> },
    fields: readonly FieldDescriptor[],
    context: SemanticResolutionContext,
  ): FormIntentPlan {
    const scope = formScope(fields, intent.form);
    const targets = [
      ...targetsFor({ kind: 'FILL', field: '', value: '' }, scope.fields),
      ...targetsFor({ kind: 'SELECT', field: '', option: '' }, scope.fields).filter(
        (target) => target.radios,
      ),
      ...targetsFor({ kind: 'CHECK', field: '', checked: true }, scope.fields).filter(
        (target) => target.field.type === 'checkbox',
      ),
    ];
    const pairs: { row: number; scored: ScoredTarget; rowIntent: FieldIntent }[] = [];
    intent.rows.forEach((row, index) => {
      for (const target of targets) {
        const rowIntent = rowIntentFor(row.field, row.value, target);
        const value =
          rowIntent.kind === 'FILL' && typeof rowIntent.value === 'string'
            ? classifyValue(rowIntent.value)
            : undefined;
        const scored = this.matcher.scoreTarget(
          rowIntent,
          target,
          value,
          { ...context, ...(scope.formGroup ? { previousFormGroup: scope.formGroup } : {}) },
          `${rowIntent.kind.toLowerCase()}:${matchKey(row.field)}`,
        );
        if (scored.candidate.score >= this.thresholds.minCandidateScore)
          pairs.push({ row: index, scored, rowIntent });
      }
    });
    // Les paires les plus sûres d'abord ; égalité : ordre du tableau, puis id du champ (déterministe).
    pairs.sort(
      (a, b) =>
        b.scored.candidate.points - a.scored.candidate.points ||
        a.row - b.row ||
        a.scored.target.id.localeCompare(b.scored.target.id),
    );
    const assigned = new Map<number, (typeof pairs)[number]>();
    const used = new Map<string, number>();
    for (const pair of pairs) {
      if (assigned.has(pair.row) || used.has(pair.scored.target.id)) continue;
      assigned.set(pair.row, pair);
      used.set(pair.scored.target.id, pair.row);
    }

    const plan: FormIntentPlan = {
      ...(intent.form ? { form: intent.form } : {}),
      ...(scope.formGroup ? { formGroup: scope.formGroup } : {}),
      mappings: [],
      unresolved: [],
      ambiguous: [],
      blocked: [],
    };
    const margin = this.thresholds.ambiguityMargin * POINTS_FOR_CERTAINTY;
    intent.rows.forEach((row, index) => {
      const own = pairs.filter((pair) => pair.row === index);
      const candidates = own
        .slice(0, 5)
        .map((pair) => ({ label: pair.scored.target.label, score: pair.scored.candidate.score }));
      const chosen = assigned.get(index);
      if (!chosen) {
        const taken = own[0];
        (taken ? plan.ambiguous : plan.unresolved).push({
          intent: row.field,
          reason: taken
            ? `its best field "${taken.scored.target.label}" is taken by "${intent.rows[used.get(taken.scored.target.id) ?? 0]?.field ?? ''}"`
            : 'no field on the screen matches',
          candidates,
        });
        return;
      }
      const { candidate, target } = chosen.scored;
      // Un autre champ libre presque aussi bon : ambigu.
      const alternative = own.find(
        (pair) =>
          pair !== chosen && (!used.has(pair.scored.target.id) || used.get(pair.scored.target.id) === index),
      );
      // Une autre ligne qui voulait ce champ presque autant : collision.
      const rival = pairs.find(
        (pair) =>
          pair.row !== index &&
          pair.scored.target.id === target.id &&
          candidate.points - pair.scored.candidate.points < margin,
      );
      if (candidate.score < this.thresholds.autoResolveThreshold)
        plan.ambiguous.push({
          intent: row.field,
          reason: `best field "${target.label}" scores ${candidate.score} < ${this.thresholds.autoResolveThreshold}`,
          candidates,
        });
      else if (alternative && candidate.points - alternative.scored.candidate.points < margin)
        plan.ambiguous.push({
          intent: row.field,
          reason: `"${target.label}" and "${alternative.scored.target.label}" are too close`,
          candidates,
        });
      else if (rival)
        plan.ambiguous.push({
          intent: row.field,
          reason: `collision: "${row.field}" and "${intent.rows[rival.row]?.field ?? ''}" both point to "${target.label}"`,
          candidates,
        });
      else if (chosen.scored.option && !['RESOLVED', 'UNVERIFIED'].includes(chosen.scored.option.status))
        (chosen.scored.option.status === 'NOT_FOUND' ? plan.unresolved : plan.ambiguous).push({
          intent: row.field,
          reason: `field "${target.label}": ${chosen.scored.option.reasons[0] ?? 'option not found'}`,
          candidates,
        });
      else {
        const field = chosen.scored.option?.radio ?? target.field;
        if (field.payment) {
          plan.blocked.push({
            intent: row.field,
            reason: `"${target.label}" is a payment field: never filled`,
            candidates,
          });
          return;
        }
        plan.mappings.push({
          intent: row.field,
          target: target.label,
          fieldId: field.id,
          operation: operationOf(chosen.rowIntent, chosen.scored),
          field,
          value: row.value,
          ...(chosen.scored.option?.selected && !chosen.scored.option.radio
            ? { option: chosen.scored.option.selected.label }
            : {}),
          confidence: candidate.score,
          level: levelOf(candidate.score),
          reasons: candidate.components.map(renderComponent),
          intentKey: `${chosen.rowIntent.kind.toLowerCase()}:${matchKey(row.field)}`,
          targetSignature: fieldTargetSignature(target),
        });
      }
    });
    // Collisions : la ligne qui a gagné le champ disputé est aussi ambiguë.
    for (const issue of [...plan.ambiguous]) {
      const match = /^collision: "(.*)" and "(.*)" both point to/.exec(issue.reason);
      if (!match) continue;
      const other = plan.mappings.findIndex((mapping) => mapping.intent === match[2]);
      if (other >= 0) {
        const [removed] = plan.mappings.splice(other, 1);
        if (removed)
          plan.ambiguous.push({
            intent: removed.intent,
            reason: `collision: "${removed.intent}" and "${match[1] ?? ''}" both point to "${removed.target}"`,
            candidates: [],
          });
      }
    }
    return plan;
  }
}

/** Le plan au format de la FormFillStrategy (aucune valeur sensible, aucune variable d'environnement résolue). */
export function toFormFillPlan(formId: string, plan: FormIntentPlan): FormFillPlan {
  return {
    formId,
    operations: plan.mappings.map((mapping) => ({
      fieldId: mapping.fieldId,
      operation: mapping.operation,
      ...(typeof mapping.value === 'string' && !mapping.field.sensitive
        ? { value: mapping.option ?? mapping.value }
        : {}),
      source: 'configured',
      reason: `Gherkin "${mapping.intent}" → "${mapping.target}" (${mapping.confidence})`,
    })),
  };
}

/** Le formulaire visé : ce qui est devant l'écran, sinon celui qui porte le nom demandé, sinon tout l'écran. */
function formScope(
  fields: readonly FieldDescriptor[],
  name: string | undefined,
): { fields: readonly FieldDescriptor[]; formGroup?: string } {
  const front = fields.filter((field) => field.foreground);
  if (front.length > 0)
    return { fields: front, ...(front[0]?.formGroup ? { formGroup: front[0].formGroup } : {}) };
  const groups = [
    ...new Set(fields.map((field) => field.formGroup).filter((group): group is string => Boolean(group))),
  ];
  if (name && groups.length > 1) {
    const wanted = normalizeForMatch(name).tokens;
    const named = groups.find((group) =>
      fields
        .filter((field) => field.formGroup === group)
        .some((field) =>
          field.nearbyText.some((text) =>
            wanted.every((token) => normalizeForMatch(text).tokens.includes(token)),
          ),
        ),
    );
    if (named) return { fields: fields.filter((field) => field.formGroup === named), formGroup: named };
  }
  if (groups.length === 1 && groups[0]) return { fields, formGroup: groups[0] };
  return { fields };
}

function rowIntentFor(field: string, value: IntentValue, target: FieldTarget): FieldIntent {
  const type = target.field.type;
  if (target.radios || type === 'select' || type === 'combobox')
    return { kind: 'SELECT', field, option: typeof value === 'string' ? value : '' };
  if (type === 'checkbox')
    return {
      kind: 'CHECK',
      field,
      checked: typeof value === 'string' && YES.has(value.trim().toLowerCase()),
    };
  return { kind: 'FILL', field, value };
}

function operationOf(intent: FieldIntent, scored: ScoredTarget): FormMapping['operation'] {
  if (intent.kind === 'CHECK') return intent.checked ? 'check' : 'uncheck';
  if (intent.kind === 'SELECT') return scored.option?.radio ? 'check' : 'select';
  return 'fill';
}
