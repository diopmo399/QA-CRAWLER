import type { Page } from 'playwright';
import type { TestDataProvider } from '../data/test-data-provider.js';
import type { PlaywrightActionExecutor } from '../execution/playwright-action-executor.js';
import { toLocator } from '../execution/locator-resolver.js';
import type { DiscoveredAction } from '../model/discovered-action.js';
import type { PageContext } from '../model/page-context.js';
import type { SafetyPolicy } from '../policies/safety-policy.js';
import type { ApiContract } from '../oracles/api-contract.js';
import { enrichWithContract } from './contract-enrichment.js';
import { DomFormAnalyzer, formName } from './form-analyzer.js';
import { ValidDataFillStrategy, type FormFillStrategy } from './form-fill-strategy.js';
import type { DiscoveredForm, FormField, FormFillPlan } from './form-model.js';
import { validityOf } from './validity.js';
import type { GeneratedFormCase } from '../constraints/test-case-generators.js';

export { formName };

/** Un champ rempli (ou laissé vide) en exerçant un formulaire. */
export interface FilledField {
  action: DiscoveredAction;
  /** Valeur saisie ou option choisie ; undefined pour une case/radio, un champ sensible, ou un champ laissé vide. */
  value?: string;
  /** Pourquoi le champ a été laissé tel quel, ou pourquoi son remplissage a échoué. */
  skipped?: string;
  error?: string;
}

/** Un champ encore invalide une fois le formulaire rempli : ce que l'application en dit. */
export interface ValidationProblem {
  field: FilledField;
  message: string;
}

/**
 * Un cas de validation : une valeur invalide saisie dans un champ. REJECTED
 * (l'application le dit) et NOT_ENTERED (le navigateur l'a refusée) passent ;
 * ACCEPTED reste UNKNOWN — l'application peut valider à l'envoi du formulaire, ce
 * que le crawler ne fait pas pour le savoir.
 */
export interface ValidationCase {
  fieldId: string;
  field: string;
  case: string;
  value: string;
  outcome: 'REJECTED' | 'NOT_ENTERED' | 'ACCEPTED' | 'ERROR';
  verdict: 'PASS' | 'UNKNOWN';
  message?: string;
}

/**
 * Un cas de propriété : un formulaire rempli avec des valeurs générées (bornes,
 * partitions d'équivalence), un champ variant à la fois. Propriétés : une valeur
 * valide est acceptée (PASS si aucun champ n'est refusé), une invalide est refusée
 * (PASS si le champ visé l'est). Une valeur invalide acceptée reste UNKNOWN — la
 * validation peut n'avoir lieu qu'à l'envoi — et une valeur valide refusée est un FAIL.
 */
export interface PropertyCase {
  id: string;
  description: string;
  expectation: 'ACCEPTED' | 'REJECTED';
  outcome: 'ACCEPTED' | 'REJECTED' | 'NOT_ENTERED' | 'ERROR';
  verdict: 'PASS' | 'FAIL' | 'UNKNOWN';
  /** Champ visé, et le message affiché par l'application. */
  field?: string;
  message?: string;
}

export interface FormRun {
  group: string;
  name: string;
  form: DiscoveredForm;
  plan: FormFillPlan;
  fields: FilledField[];
  problems: ValidationProblem[];
  validationCases: ValidationCase[];
  propertyCases?: PropertyCase[];
}

export interface ValidationTestingLimits {
  maxCasesPerField: number;
  maxCasesPerForm: number;
}

/**
 * Orchestre un formulaire : FormAnalyzer (qu'attend-il ?) → FormFillStrategy
 * (quelles valeurs ?) → PlaywrightActionExecutor (remplir) → messages de validation,
 * et en option les tests de validation (valeurs invalides, dans des limites). Il ne
 * clique jamais sur le bouton qui envoie le formulaire : cette décision reste au
 * DecisionEngine et à la SafetyPolicy.
 */
export class FormExerciser {
  private readonly analyzer = new DomFormAnalyzer();
  private readonly strategy: FormFillStrategy;

  constructor(
    private readonly executor: PlaywrightActionExecutor,
    private readonly testData: TestDataProvider,
    safety: SafetyPolicy,
    runId: string,
    strategy?: FormFillStrategy,
    /** Contrat d'API (OpenAPI) qui complète ce que la page dit de ses champs. */
    private readonly contract?: ApiContract,
  ) {
    this.strategy = strategy ?? new ValidDataFillStrategy(testData, safety, runId);
  }

  /** Formulaires logiques de l'écran (la vue du FormAnalyzer). */
  formsOf(context: PageContext): DiscoveredForm[] {
    return this.analyzer.formsOf(context);
  }

  /** Formulaires de l'écran avec au moins un champ à remplir, ce qui est devant l'écran d'abord. */
  groupsOf(context: PageContext): string[] {
    return this.formsOf(context)
      .filter((form) =>
        form.fields.some((field) => {
          const action = context.actions.find((candidate) => candidate.id === field.id);
          return (
            action !== undefined && !action.obscured && this.testData.instructionFor(action).kind !== 'skip'
          );
        }),
      )
      .map((form) => form.group);
  }

  /** Remplit chaque champ du formulaire à partir d'un plan ; rien n'est envoyé. */
  async fill(page: Page, context: PageContext, group: string): Promise<FormRun> {
    const found = this.formsOf(context).find((candidate) => candidate.group === group) ?? {
      id: `${context.stateId}:${group}`,
      stateId: context.stateId,
      group,
      name: formName(group, context),
      fields: [],
      submitActions: [],
      validationMessages: [],
      foreground: false,
    };
    const form = enrichWithContract(found, this.contract);
    const plan = await this.strategy.fill(form, context);
    const actionOf = (fieldId: string): DiscoveredAction | undefined =>
      context.actions.find((candidate) => candidate.id === fieldId);
    const results = await this.executor.executePlan(page, plan, actionOf);
    const fields: FilledField[] = [];
    for (const operation of plan.operations) {
      const action = actionOf(operation.fieldId);
      if (!action) continue;
      if (operation.operation === 'skip') {
        fields.push({ action, skipped: operation.reason ?? 'skipped' });
        continue;
      }
      const result = results.find((candidate) => candidate.fieldId === operation.fieldId);
      fields.push({
        action,
        ...(operation.value ? { value: operation.value } : {}),
        ...(result?.status === 'FAILED' ? { error: result.error ?? 'failed' } : {}),
      });
    }
    return { group, name: form.name, form, plan, fields, problems: [], validationCases: [] };
  }

  /**
   * Quitte chaque champ (l'application valide au blur : « touched » d'Angular), puis
   * relève ce qui reste invalide et le message affiché à côté.
   */
  async validate(page: Page, run: FormRun): Promise<ValidationProblem[]> {
    const problems: ValidationProblem[] = [];
    const seen = new Set<string>();
    for (const field of run.fields) {
      const { action } = field;
      // Les champs sensibles (jamais remplis) et ceux que la mission interdit ne sont pas jugés.
      if (action.risks.includes('sensitive-data') || field.skipped === 'not allowed by the mission') continue;
      const choice = action.field?.choiceGroup;
      if (choice !== undefined) {
        if (seen.has(choice)) continue;
        seen.add(choice);
      }
      const base = toLocator(page, action.locator);
      const locator = action.locator.nth !== undefined ? base.nth(action.locator.nth) : base.first();
      if ((await base.count().catch(() => 0)) === 0) continue;
      if (action.type !== 'check') {
        await locator.focus({ timeout: 1000 }).catch(() => undefined);
        await locator.blur({ timeout: 1000 }).catch(() => undefined);
      }
      const state = await validityOf(locator);
      if (state?.invalid) problems.push({ field, message: state.message || 'invalid value' });
    }
    return problems;
  }

  /**
   * Tests de validation : pour chaque champ, quelques valeurs invalides (vide quand il
   * est obligatoire, hors min/max, trop long, mauvais format…), une à la fois, chacune
   * suivie à nouveau de la valeur valide du champ. Bornés par champ et par formulaire.
   */
  async testValidation(
    page: Page,
    context: PageContext,
    run: FormRun,
    limits: ValidationTestingLimits,
  ): Promise<ValidationCase[]> {
    if (!this.testData.generateInvalidValues) return [];
    const cases: ValidationCase[] = [];
    for (const field of run.form.fields) {
      if (cases.length >= limits.maxCasesPerForm) break;
      const action = context.actions.find((candidate) => candidate.id === field.id);
      if (!action || action.obscured || field.sensitive || field.payment) continue;
      const planned = run.plan.operations.find((operation) => operation.fieldId === field.id);
      if (!planned || planned.operation === 'skip') continue;
      const invalid = (
        await this.testData.generateInvalidValues(field, { runId: '', formName: run.name })
      ).slice(0, Math.min(limits.maxCasesPerField, limits.maxCasesPerForm - cases.length));
      for (const value of invalid) {
        const operation = value.kind === 'uncheck' ? 'uncheck' : 'fill';
        const plan: FormFillPlan = {
          formId: run.form.id,
          operations: [{ fieldId: field.id, operation, value: value.value ?? '' }],
        };
        const { outcome, message } = await this.tryValue(page, plan, action, operation, value.value ?? '');
        cases.push({
          fieldId: field.id,
          field: fieldLabel(field),
          case: value.case ?? 'invalid',
          value: value.value ?? '',
          outcome,
          verdict: outcome === 'REJECTED' || outcome === 'NOT_ENTERED' ? 'PASS' : 'UNKNOWN',
          ...(message ? { message } : {}),
        });
        // Retour à la valeur valide, pour les cas suivants et pour la suite.
        await this.executor.executePlan(page, { formId: run.form.id, operations: [planned] }, () => action);
      }
    }
    return cases;
  }

  /** Saisit une valeur dans un champ puis lit ce que l'application et le navigateur en disent. */
  private async tryValue(
    page: Page,
    plan: FormFillPlan,
    action: DiscoveredAction,
    operation: 'fill' | 'uncheck' | 'select',
    value: string,
  ): Promise<TriedValue> {
    const [result] = await this.executor.executePlan(page, plan, () => action);
    const base = toLocator(page, action.locator);
    const locator = action.locator.nth !== undefined ? base.nth(action.locator.nth) : base.first();
    if (result?.status === 'FAILED') return { outcome: 'ERROR' };
    const validity = await validityOf(locator);
    const entered =
      operation === 'fill' ? await locator.inputValue({ timeout: 1000 }).catch(() => undefined) : undefined;
    const outcome: TriedValue['outcome'] = validity?.invalid
      ? 'REJECTED'
      : entered !== undefined && entered !== value
        ? 'NOT_ENTERED'
        : 'ACCEPTED';
    return { outcome, ...(validity?.message ? { message: validity.message } : {}) };
  }

  /**
   * Property-based testing : chaque cas généré (OneFactorPropertyTestGenerator) remplit
   * les champs concernés, puis vérifie la propriété ; le formulaire revient ensuite à
   * ses valeurs valides. Rien n'est envoyé.
   */
  async testProperties(
    page: Page,
    context: PageContext,
    run: FormRun,
    cases: readonly GeneratedFormCase[],
  ): Promise<PropertyCase[]> {
    const results: PropertyCase[] = [];
    const actionOf = (fieldId: string): DiscoveredAction | undefined =>
      context.actions.find((candidate) => candidate.id === fieldId && !candidate.obscured);
    for (const generated of cases) {
      const operations = Object.entries(generated.values)
        .map(([fieldId, value]) => {
          const field = run.form.fields.find((candidate) => candidate.id === fieldId);
          const kind: 'fill' | 'select' =
            field?.type === 'select' || field?.type === 'combobox' ? 'select' : 'fill';
          return { fieldId, operation: kind, value };
        })
        .filter((operation) => actionOf(operation.fieldId) !== undefined);
      if (operations.length === 0) continue;
      const others = operations.filter((operation) => operation.fieldId !== generated.fieldId);
      if (others.length > 0)
        await this.executor.executePlan(page, { formId: run.form.id, operations: others }, actionOf);
      let outcome: PropertyCase['outcome'] = 'ACCEPTED';
      let message: string | undefined;
      const target = generated.fieldId
        ? operations.find((operation) => operation.fieldId === generated.fieldId)
        : undefined;
      const targetAction = target ? actionOf(target.fieldId) : undefined;
      if (target && targetAction) {
        const tried = await this.tryValue(
          page,
          { formId: run.form.id, operations: [target] },
          targetAction,
          target.operation,
          target.value,
        );
        outcome = tried.outcome;
        message = tried.message;
      } else {
        // Tous valides : aucun champ ne doit être refusé.
        for (const operation of operations) {
          const action = actionOf(operation.fieldId);
          if (!action) continue;
          const base = toLocator(page, action.locator);
          const locator = action.locator.nth !== undefined ? base.nth(action.locator.nth) : base.first();
          const validity = await validityOf(locator);
          if (validity?.invalid) {
            outcome = 'REJECTED';
            message = validity.message;
            break;
          }
        }
      }
      const rejected = outcome === 'REJECTED' || outcome === 'NOT_ENTERED';
      const verdict: PropertyCase['verdict'] =
        outcome === 'ERROR'
          ? 'UNKNOWN'
          : generated.expectation === 'REJECTED'
            ? rejected
              ? 'PASS'
              : 'UNKNOWN'
            : rejected
              ? 'FAIL'
              : 'PASS';
      const field = generated.fieldId
        ? run.form.fields.find((candidate) => candidate.id === generated.fieldId)
        : undefined;
      results.push({
        id: generated.id,
        description: generated.description,
        expectation: generated.expectation,
        outcome,
        verdict,
        ...(field ? { field: fieldLabel(field) } : {}),
        ...(message ? { message } : {}),
      });
    }
    // Retour aux valeurs valides du plan, pour la suite de l'exploration.
    const restore = run.plan.operations.filter(
      (operation) => operation.operation === 'fill' || operation.operation === 'select',
    );
    if (restore.length > 0)
      await this.executor.executePlan(page, { formId: run.form.id, operations: restore }, actionOf);
    return results;
  }
}

/** Ce qui arrive à une valeur saisie : refusée par l'application, par le navigateur, acceptée, ou erreur. */
interface TriedValue {
  outcome: 'REJECTED' | 'NOT_ENTERED' | 'ACCEPTED' | 'ERROR';
  message?: string;
}

function fieldLabel(field: FormField): string {
  const name =
    field.choiceGroup !== undefined && field.groupLabel
      ? field.groupLabel
      : (field.label ?? field.name ?? field.id);
  return name.replace(/^\*\s*|\s*\*$/g, '');
}
