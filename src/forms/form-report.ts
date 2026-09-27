import type { FieldType } from './form-model.js';
import type { FormRun, ValidationCase } from './form-exerciser.js';

/** What the report says about a form: its fields, what was filled, what the application said. */
export interface FormReport {
  formId: string;
  stateId: string;
  name: string;
  group: string;
  fields: {
    id: string;
    label: string;
    type: FieldType;
    required: boolean;
    sensitive: boolean;
    /** What was done: value typed (never for a sensitive field), option chosen, checked, or why skipped. */
    filled: string;
    source?: string;
    error?: string;
  }[];
  submitActions: string[];
  validationProblems: { field: string; message: string }[];
  validationCases: ValidationCase[];
}

export function formReportOf(run: FormRun, stateId: string): FormReport {
  const byId = new Map(run.plan.operations.map((operation) => [operation.fieldId, operation]));
  return {
    formId: run.form.id,
    stateId,
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
