import type { TestDataProvider } from '../data/test-data-provider.js';
import type { PageContext } from '../model/page-context.js';
import type { SafetyPolicy } from '../policies/safety-policy.js';
import type { DiscoveredForm, FormFillOperation, FormFillPlan } from './form-model.js';

/**
 * "What goes into this form?" Produces a plan — which field gets which
 * value, and why — without touching the browser. The PlaywrightActionExecutor
 * executes the plan; the FormExerciser orchestrates.
 */
export interface FormFillStrategy {
  fill(form: DiscoveredForm, context: PageContext): Promise<FormFillPlan>;
}

/**
 * Every field gets the valid value of the TestDataProvider; one option per
 * radio group; fields the SafetyPolicy refuses and sensitive fields are
 * skipped, without any value in the plan.
 */
export class ValidDataFillStrategy implements FormFillStrategy {
  constructor(
    private readonly testData: TestDataProvider,
    private readonly safety: SafetyPolicy,
    private readonly runId: string,
  ) {}

  async fill(form: DiscoveredForm, context: PageContext): Promise<FormFillPlan> {
    const operations: FormFillOperation[] = [];
    const answered = new Set<string>();
    for (const field of form.fields) {
      const action = context.actions.find((candidate) => candidate.id === field.id);
      if (field.disabled || action?.obscured) continue;
      if (field.sensitive || field.payment) {
        operations.push({
          fieldId: field.id,
          operation: 'skip',
          reason: 'sensitive field: never filled automatically',
        });
        continue;
      }
      if (action && this.safety.evaluate(action).verdict === 'BLOCK') {
        operations.push({ fieldId: field.id, operation: 'skip', reason: 'not allowed by the mission' });
        continue;
      }
      const value = await this.testData.generateValidValue(field, {
        runId: this.runId,
        formName: form.name,
        stateId: form.stateId,
      });
      if (value.kind === 'skip') {
        operations.push({
          fieldId: field.id,
          operation: 'skip',
          reason: value.reason ?? 'skipped',
          source: value.source,
        });
        continue;
      }
      // One option per radio group.
      if (field.type === 'radio' && field.choiceGroup !== undefined) {
        if (answered.has(field.choiceGroup)) {
          operations.push({
            fieldId: field.id,
            operation: 'skip',
            reason: 'another option of the group is chosen',
          });
          continue;
        }
        answered.add(field.choiceGroup);
      }
      operations.push({
        fieldId: field.id,
        operation: value.kind,
        ...(value.value !== undefined ? { value: value.value } : {}),
        source: value.source,
      });
    }
    return { formId: form.id, operations };
  }
}
