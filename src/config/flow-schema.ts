import { z } from 'zod';

/**
 * Imposed test flows: an ordered list of steps the mission requires
 * (log in, open a screen, fill a form, check the result). Unlike the
 * autonomous exploration, *the YAML* decides what to click here — but every
 * step still goes through the SafetyPolicy before Playwright runs it.
 */

const nonEmpty = z.string().trim().min(1);

/** Keys that choose how to find the element; exactly one is required. */
export const TARGET_STRATEGIES = ['testId', 'role', 'label', 'text', 'css'] as const;

const targetShape = {
  /** ARIA role (button, link, tab, textbox, combobox…), usually with `name`. */
  role: nonEmpty.optional(),
  /** Accessible name, with `role`. */
  name: z.string().optional(),
  /** Text of the field's <label>. */
  label: nonEmpty.optional(),
  /** Visible text. */
  text: nonEmpty.optional(),
  /** data-testid attribute. */
  testId: nonEmpty.optional(),
  /** CSS selector, as a last resort. */
  css: nonEmpty.optional(),
  /** Exact (case-sensitive, whole string) match of name/label/text. */
  exact: z.boolean().optional(),
  /** 0-based index when several elements match. */
  nth: z.number().int().min(0).optional(),
};

type TargetInput = { [K in keyof typeof targetShape]?: unknown };

function checkTarget(target: TargetInput, ctx: z.RefinementCtx): void {
  const used = TARGET_STRATEGIES.filter((key) => target[key] !== undefined);
  if (used.length !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `exactly one of ${TARGET_STRATEGIES.join(', ')} is required${used.length > 0 ? ` (got ${used.join(', ')})` : ''}`,
    });
  }
  if (target.name !== undefined && target.role === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: '"name" is only valid with "role"' });
  }
}

const targetSchema = z.object(targetShape).strict().superRefine(checkTarget);

/** A value typed in a field: literal, or read from an environment variable (never logged). */
const valueSchema = z.union([z.string(), z.number().transform(String), z.object({ env: nonEmpty }).strict()]);

const fillSchema = z
  .object({ ...targetShape, value: valueSchema })
  .strict()
  .superRefine(checkTarget);
const selectSchema = z
  .object({ ...targetShape, option: z.union([nonEmpty, z.number().transform(String)]) })
  .strict()
  .superRefine(checkTarget);

const expectSchema = z
  .object({
    /** Text visible somewhere on the page. */
    text: nonEmpty.optional(),
    /** The URL contains this string. */
    url: nonEmpty.optional(),
    /** This element is visible. */
    visible: targetSchema.optional(),
    /** This element is absent or hidden. */
    hidden: targetSchema.optional(),
  })
  .strict()
  .refine(
    (expectation) =>
      expectation.text !== undefined ||
      expectation.url !== undefined ||
      expectation.visible !== undefined ||
      expectation.hidden !== undefined,
    'expect needs at least one of text, url, visible, hidden',
  );

/** Classes a step may execute on top of SAFE. DANGEROUS is never allowed. */
export const FLOW_ALLOWANCES = ['MUTATION', 'UNKNOWN'] as const;
export type FlowAllowance = (typeof FLOW_ALLOWANCES)[number];

const STEP_KINDS = ['goto', 'click', 'fill', 'select', 'check', 'uncheck', 'expect', 'screenshot'] as const;

const stepSchema = z
  .object({
    /** Short description shown in reports (default: generated from the step). */
    name: nonEmpty.optional(),
    goto: nonEmpty.optional(),
    click: targetSchema.optional(),
    fill: fillSchema.optional(),
    select: selectSchema.optional(),
    check: targetSchema.optional(),
    uncheck: targetSchema.optional(),
    expect: expectSchema.optional(),
    /** Named screenshot of the current screen. */
    screenshot: nonEmpty.optional(),
    /**
     * Explicit permission for this step only: MUTATION (create, save,
     * submit…) and/or UNKNOWN (icon-only control). DANGEROUS actions
     * (delete, pay, send, logout…) are never executed.
     */
    allow: z
      .union([z.enum(FLOW_ALLOWANCES), z.array(z.enum(FLOW_ALLOWANCES))])
      .optional()
      .transform((value) => (value === undefined ? [] : Array.isArray(value) ? value : [value])),
    /** A failure of this step is reported as a WARNING and the flow goes on. */
    optional: z.boolean().default(false),
    /** Timeout of this step (default: exploration.actionTimeoutMs). */
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((step, ctx) => {
    const kinds = STEP_KINDS.filter((kind) => step[kind] !== undefined);
    if (kinds.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `a step needs exactly one of ${STEP_KINDS.join(', ')}${kinds.length > 0 ? ` (got ${kinds.join(', ')})` : ''}`,
      });
    }
  })
  .transform((step): FlowStep => {
    const common = {
      ...(step.name !== undefined ? { name: step.name } : {}),
      allow: step.allow,
      optional: step.optional,
      ...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {}),
    };
    if (step.goto !== undefined) return { ...common, kind: 'goto', url: step.goto };
    if (step.fill !== undefined) {
      const { value, ...target } = step.fill;
      return { ...common, kind: 'fill', target: toTarget(target), value };
    }
    if (step.select !== undefined) {
      const { option, ...target } = step.select;
      return { ...common, kind: 'select', target: toTarget(target), option };
    }
    if (step.click !== undefined) return { ...common, kind: 'click', target: toTarget(step.click) };
    if (step.check !== undefined) return { ...common, kind: 'check', target: toTarget(step.check) };
    if (step.uncheck !== undefined) return { ...common, kind: 'uncheck', target: toTarget(step.uncheck) };
    if (step.expect !== undefined) {
      const { text, url, visible, hidden } = step.expect;
      return {
        ...common,
        kind: 'expect',
        expect: {
          ...(text !== undefined ? { text } : {}),
          ...(url !== undefined ? { url } : {}),
          ...(visible !== undefined ? { visible: toTarget(visible) } : {}),
          ...(hidden !== undefined ? { hidden: toTarget(hidden) } : {}),
        },
      };
    }
    return { ...common, kind: 'screenshot', label: step.screenshot ?? 'screenshot' };
  });

export const flowSchema = z
  .object({
    name: nonEmpty,
    description: z.string().optional(),
    /** Page loaded before the first step (default: target.startAt). */
    startAt: nonEmpty.optional(),
    steps: z.array(stepSchema).min(1),
    /** Explore autonomously from the flow's last screen once it passed. */
    thenExplore: z.boolean().default(false),
  })
  .strict();

export const flowsSchema = z
  .array(flowSchema)
  .default([])
  .superRefine((flows, ctx) => {
    const seen = new Set<string>();
    flows.forEach((flow, index) => {
      if (seen.has(flow.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'name'],
          message: `duplicate flow name "${flow.name}"`,
        });
      }
      seen.add(flow.name);
    });
  });

export interface FlowTarget {
  strategy: (typeof TARGET_STRATEGIES)[number];
  /** role, for the role strategy. */
  role?: string;
  /** Accessible name, for the role strategy. */
  name?: string;
  /** testId, label, text or CSS selector. */
  value?: string;
  exact?: boolean;
  nth?: number;
}

export type FlowValue = string | { env: string };

export interface FlowExpectation {
  text?: string;
  url?: string;
  visible?: FlowTarget;
  hidden?: FlowTarget;
}

interface StepCommon {
  name?: string;
  allow: FlowAllowance[];
  optional: boolean;
  timeoutMs?: number;
}

export type FlowStep = StepCommon &
  (
    | { kind: 'goto'; url: string }
    | { kind: 'click' | 'check' | 'uncheck'; target: FlowTarget }
    | { kind: 'fill'; target: FlowTarget; value: FlowValue }
    | { kind: 'select'; target: FlowTarget; option: string }
    | { kind: 'expect'; expect: FlowExpectation }
    | { kind: 'screenshot'; label: string }
  );

export type FlowConfig = z.output<typeof flowSchema>;

function toTarget(input: {
  role?: string | undefined;
  name?: string | undefined;
  label?: string | undefined;
  text?: string | undefined;
  testId?: string | undefined;
  css?: string | undefined;
  exact?: boolean | undefined;
  nth?: number | undefined;
}): FlowTarget {
  const options = {
    ...(input.exact !== undefined ? { exact: input.exact } : {}),
    ...(input.nth !== undefined ? { nth: input.nth } : {}),
  };
  if (input.role !== undefined) {
    return {
      strategy: 'role',
      role: input.role,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...options,
    };
  }
  if (input.testId !== undefined) return { strategy: 'testId', value: input.testId, ...options };
  if (input.label !== undefined) return { strategy: 'label', value: input.label, ...options };
  if (input.text !== undefined) return { strategy: 'text', value: input.text, ...options };
  return { strategy: 'css', value: input.css ?? '', ...options };
}

/** Human description of a target, for logs and reports: role=button[name="Suivant"]. */
export function describeTarget(target: FlowTarget): string {
  const nth = target.nth !== undefined && target.nth > 0 ? ` [${target.nth}]` : '';
  switch (target.strategy) {
    case 'role':
      return `role=${target.role ?? ''}${target.name !== undefined ? `[name="${target.name}"]` : ''}${nth}`;
    case 'testId':
      return `testId=${target.value ?? ''}${nth}`;
    case 'label':
      return `label="${target.value ?? ''}"${nth}`;
    case 'text':
      return `text="${target.value ?? ''}"${nth}`;
    case 'css':
      return `css=${target.value ?? ''}${nth}`;
  }
}

/**
 * Human description of a step. Values read from the environment are never
 * shown; `maskValue` hides literal values too (sensitive fields).
 */
export function describeStep(step: FlowStep, maskValue = false): string {
  if (step.name) return step.name;
  switch (step.kind) {
    case 'goto':
      return `goto ${step.url}`;
    case 'click':
    case 'check':
    case 'uncheck':
      return `${step.kind} ${describeTarget(step.target)}`;
    case 'fill':
      return `fill ${describeTarget(step.target)} = ${maskValue && typeof step.value === 'string' ? '"***"' : describeValue(step.value)}`;
    case 'select':
      return `select ${describeTarget(step.target)} = "${step.option}"`;
    case 'expect':
      return `expect ${describeExpectation(step.expect)}`;
    case 'screenshot':
      return `screenshot "${step.label}"`;
  }
}

export function describeValue(value: FlowValue): string {
  return typeof value === 'string' ? `"${value}"` : `\${env:${value.env}}`;
}

export function describeExpectation(expectation: FlowExpectation): string {
  const parts: string[] = [];
  if (expectation.text !== undefined) parts.push(`text "${expectation.text}"`);
  if (expectation.url !== undefined) parts.push(`url contains "${expectation.url}"`);
  if (expectation.visible) parts.push(`visible ${describeTarget(expectation.visible)}`);
  if (expectation.hidden) parts.push(`hidden ${describeTarget(expectation.hidden)}`);
  return parts.join(', ');
}
