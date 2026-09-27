import type { FieldType } from './form-model.js';
import type { FormRun, ValidationCase } from './form-exerciser.js';

/** Ce que dit le rapport sur un formulaire : ses champs, ce qui a été rempli, ce que l'application a répondu. */
export interface FormReport {
  formId: string;
  stateId: string;
  /** Transition qui l'a rempli (form-…), pour le rejouer ou en faire un flow. */
  actionId?: string;
  name: string;
  group: string;
  fields: {
    id: string;
    label: string;
    type: FieldType;
    required: boolean;
    sensitive: boolean;
    /** Ce qui a été fait : valeur saisie (jamais pour un champ sensible), option choisie, case cochée, ou la raison de l'avoir ignoré. */
    filled: string;
    /** Ce qui a été fait, et la valeur (jamais pour un champ sensible). */
    operation?: 'fill' | 'select' | 'check' | 'uncheck' | 'skip';
    value?: string;
    source?: string;
    error?: string;
  }[];
  submitActions: string[];
  validationProblems: { field: string; message: string }[];
  validationCases: ValidationCase[];
}

export function formReportOf(run: FormRun, stateId: string, actionId?: string): FormReport {
  const byId = new Map(run.plan.operations.map((operation) => [operation.fieldId, operation]));
  return {
    formId: run.form.id,
    stateId,
    ...(actionId ? { actionId } : {}),
    name: run.name,
    group: run.group,
    fields: run.form.fields.map((field) => {
      const operation = byId.get(field.id);
      const filled = run.fields.find((candidate) => candidate.action.id === field.id);
      const label =
        (field.choiceGroup !== undefined && field.groupLabel ? `${field.groupLabel}: ` : '') +
        (field.label ?? field.name ?? field.id);
      const done = !operation
        ? 'not filled'
        : operation.operation === 'skip'
          ? `skipped (${operation.reason ?? ''})`
          : field.sensitive
            ? operation.operation
            : operation.operation === 'check' || operation.operation === 'uncheck'
              ? operation.operation
              : `${operation.operation} "${operation.value ?? ''}"`;
      return {
        id: field.id,
        label: label.replace(/\s*\*$/, ''),
        type: field.type,
        required: field.required,
        sensitive: field.sensitive,
        filled: done,
        ...(operation ? { operation: operation.operation } : {}),
        ...(operation?.value !== undefined && !field.sensitive ? { value: operation.value } : {}),
        ...(operation?.source ? { source: operation.source } : {}),
        ...(filled?.error ? { error: filled.error } : {}),
      };
    }),
    submitActions: run.form.submitActions.map((action) => action.text ?? action.label ?? action.id),
    validationProblems: run.problems.map((problem) => ({
      field: problem.field.action.field?.label ?? problem.field.action.label ?? problem.field.action.id,
      message: problem.message,
    })),
    validationCases: run.validationCases,
  };
}
