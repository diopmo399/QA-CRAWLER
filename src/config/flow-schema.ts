import { z } from 'zod';
import {
  loadTestDataSetFile,
  parseTestDataSet,
  TestDataSetError,
  type TestDataSet,
} from '../data/test-data-set.js';
import { ASSERTION_KINDS, describeIntent, type GherkinIntent } from '../semantics/resolution/intent.js';

/**
 * Flows de test imposés : une liste ordonnée d'étapes exigées par la mission
 * (se connecter, ouvrir un écran, remplir un formulaire, vérifier le résultat).
 * Contrairement à l'exploration autonome, c'est *le YAML* qui décide où cliquer —
 * mais chaque étape passe quand même par la SafetyPolicy avant que Playwright l'exécute.
 */

const nonEmpty = z.string().trim().min(1);

/** Clés qui choisissent comment trouver l'élément ; exactement une est obligatoire. */
export const TARGET_STRATEGIES = ['testId', 'role', 'label', 'text', 'css'] as const;

const targetShape = {
  /** Rôle ARIA (button, link, tab, textbox, combobox…), en général avec `name`. */
  role: nonEmpty.optional(),
  /** Nom accessible, avec `role`. */
  name: z.string().optional(),
  /** Texte du <label> du champ. */
  label: nonEmpty.optional(),
  /** Texte visible. */
  text: nonEmpty.optional(),
  /** Attribut data-testid. */
  testId: nonEmpty.optional(),
  /** Sélecteur CSS, en dernier recours. */
  css: nonEmpty.optional(),
  /** Correspondance exacte (casse respectée, chaîne entière) de name/label/text. */
  exact: z.boolean().optional(),
  /** Index à partir de 0 quand plusieurs éléments correspondent. */
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

/**
 * Valeur saisie dans un champ : littérale, lue dans une variable d'environnement (jamais
 * journalisée), ou une donnée de test valide pour ce champ (`{ testData: email }` : le
 * TestDataProvider la choisit à l'exécution ; un flow enregistré ne garde jamais la saisie).
 */
const testDataValueSchema = z.object({ testData: nonEmpty }).strict();
const valueSchema = z.union([
  z.string(),
  z.number().transform(String),
  z.object({ env: nonEmpty }).strict(),
  testDataValueSchema,
]);

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
    /** Texte visible quelque part sur la page. */
    text: nonEmpty.optional(),
    /** L'URL contient cette chaîne. */
    url: nonEmpty.optional(),
    /** Cet élément est visible. */
    visible: targetSchema.optional(),
    /** Cet élément est absent ou caché. */
    hidden: targetSchema.optional(),
    /** Aucun message d'erreur visible (mat-error, .invalid-feedback, [role=alert]…). */
    noError: z.literal(true).optional(),
    /**
     * Une requête vue depuis le début du flow : méthode facultative, URL (sous-chaîne, ou
     * chemin avec * et **) et statut attendu (un code, ou une classe « 2xx » ; 2xx par défaut).
     */
    response: z
      .object({
        method: nonEmpty.optional(),
        url: nonEmpty,
        status: z
          .union([z.number().int().min(100).max(599), z.enum(['2xx', '3xx', '4xx', '5xx'])])
          .default('2xx'),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (expectation) =>
      expectation.text !== undefined ||
      expectation.url !== undefined ||
      expectation.visible !== undefined ||
      expectation.hidden !== undefined ||
      expectation.noError !== undefined ||
      expectation.response !== undefined,
    'expect needs at least one of text, url, visible, hidden, noError, response',
  );

/**
 * Classes qu'une étape peut exécuter en plus de SAFE. DANGEROUS ne s'exécute
 * que si la mission la liste aussi dans safety.allowedActionClasses.
 */
export const FLOW_ALLOWANCES = ['MUTATION', 'UNKNOWN', 'DANGEROUS'] as const;
export type FlowAllowance = (typeof FLOW_ALLOWANCES)[number];

const STEP_KINDS = [
  'goto',
  'click',
  'fill',
  'select',
  'check',
  'uncheck',
  'expect',
  'screenshot',
  'manual',
  'auto',
  'intent',
] as const;

const intentValueSchema = z.union([z.string(), z.object({ env: nonEmpty }).strict(), testDataValueSchema]);

/**
 * Une INTENTION Gherkin (gherkin.semanticResolution) : ce que la phrase demande, sans
 * sélecteur. La cible est trouvée à l'écran au moment de l'exécution.
 */
const intentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('NAVIGATE'), target: nonEmpty, precondition: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal('CLICK'), target: nonEmpty, role: nonEmpty.optional() }).strict(),
  z.object({ kind: z.literal('FILL'), field: nonEmpty, value: intentValueSchema }).strict(),
  z.object({ kind: z.literal('SELECT'), field: nonEmpty, option: nonEmpty }).strict(),
  z.object({ kind: z.literal('CHECK'), field: nonEmpty, checked: z.boolean() }).strict(),
  z.object({ kind: z.literal('UPLOAD'), field: nonEmpty, file: z.string() }).strict(),
  z
    .object({
      kind: z.literal('SUBMIT'),
      action: z.enum(['submit', 'cancel', 'next', 'previous']),
      verb: nonEmpty.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('FILL_FORM'),
      form: nonEmpty.optional(),
      rows: z.array(z.object({ field: nonEmpty, value: intentValueSchema }).strict()).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('ASSERT'),
      assertion: z.enum(ASSERTION_KINDS),
      subject: nonEmpty.optional(),
      message: z.enum(['confirmation', 'error', 'any']).optional(),
    })
    .strict(),
]);

/**
 * Ce que l'action doit produire (appris pendant l'enregistrement) : la preuve qu'elle a
 * FONCTIONNÉ, pas seulement que Playwright a pu cliquer. `appears` / `disappears` : des
 * contrôles (« button:Suivant » ou un nom) ; `route` : la route atteinte ; `request` : une
 * requête (« GET /api/tasks ») ; `required: false` : un effet facultatif (rien n'est exigé).
 */
const effectsSchema = z
  .object({
    appears: z.array(nonEmpty).max(10).optional(),
    disappears: z.array(nonEmpty).max(10).optional(),
    route: nonEmpty.optional(),
    request: nonEmpty.optional(),
    required: z.boolean().optional(),
  })
  .strict();

/** L'empreinte de la cible enregistrée : vérifiée avant de cliquer (un CSS structurel peut viser un autre élément). */
const fingerprintSchema = z
  .object({
    role: nonEmpty.optional(),
    name: nonEmpty.optional(),
    text: nonEmpty.optional(),
    testId: nonEmpty.optional(),
    tag: nonEmpty.optional(),
    /** La section / le titre le plus proche (contexte). */
    context: nonEmpty.optional(),
  })
  .strict();

const stepSchema = z
  .object({
    /** Courte description affichée dans les rapports (par défaut : générée à partir de l'étape). */
    name: nonEmpty.optional(),
    /** Effets attendus de l'action (ACTION EFFECT VERIFIER). */
    effects: effectsSchema.optional(),
    /** Empreinte de la cible (TARGET FINGERPRINT MATCHER, LOCATOR HEALING). */
    fingerprint: fingerprintSchema.optional(),
    goto: nonEmpty.optional(),
    click: targetSchema.optional(),
    fill: fillSchema.optional(),
    select: selectSchema.optional(),
    check: targetSchema.optional(),
    uncheck: targetSchema.optional(),
    expect: expectSchema.optional(),
    /** Capture nommée de l'écran courant. */
    screenshot: nonEmpty.optional(),
    /** Vérification que le robot ne sait pas faire : notée « à vérifier manuellement » dans le rapport, sans arrêter le flow. */
    manual: nonEmpty.optional(),
    /** Phrase Gherkin interprétée sur l'écran à l'exécution (mode automatique, `gherkin.auto`). */
    auto: z
      .object({
        sentence: nonEmpty,
        type: z.enum(['Context', 'Action', 'Outcome', 'Unknown']).default('Unknown'),
      })
      .strict()
      .optional(),
    /** Intention Gherkin résolue sur l'écran à l'exécution (gherkin.semanticResolution). */
    intent: intentSchema.optional(),
    /**
     * Permission explicite pour cette étape seulement : MUTATION (créer, enregistrer,
     * envoyer…) et/ou UNKNOWN (contrôle réduit à une icône). DANGEROUS (supprimer,
     * payer, envoyer…) exige aussi DANGEROUS dans safety.allowedActionClasses.
     */
    allow: z
      .union([z.enum(FLOW_ALLOWANCES), z.array(z.enum(FLOW_ALLOWANCES))])
      .optional()
      .transform((value) => (value === undefined ? [] : Array.isArray(value) ? value : [value])),
    /** Un échec de cette étape est signalé comme WARNING et le flow continue. */
    optional: z.boolean().default(false),
    /** Délai de cette étape (par défaut : exploration.actionTimeoutMs). */
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
      ...(step.effects !== undefined ? { effects: step.effects } : {}),
      ...(step.fingerprint !== undefined ? { fingerprint: step.fingerprint } : {}),
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
      const { text, url, visible, hidden, noError, response } = step.expect;
      return {
        ...common,
        kind: 'expect',
        expect: {
          ...(text !== undefined ? { text } : {}),
          ...(url !== undefined ? { url } : {}),
          ...(visible !== undefined ? { visible: toTarget(visible) } : {}),
          ...(hidden !== undefined ? { hidden: toTarget(hidden) } : {}),
          ...(noError ? { noError } : {}),
          ...(response
            ? {
                response: {
                  ...(response.method !== undefined ? { method: response.method.toUpperCase() } : {}),
                  url: response.url,
                  status: response.status,
                },
              }
            : {}),
        },
      };
    }
    if (step.manual !== undefined) return { ...common, kind: 'manual', text: step.manual };
    if (step.auto !== undefined)
      return { ...common, kind: 'auto', sentence: step.auto.sentence, type: step.auto.type };
    if (step.intent !== undefined) return { ...common, kind: 'intent', intent: step.intent };
    return { ...common, kind: 'screenshot', label: step.screenshot ?? 'screenshot' };
  });

/** Un jeu de données : chemin d'un fichier (déjà absolu après chargement) ou le jeu lui-même. */
export const testDataSetInput = z.unknown().transform((input, ctx): TestDataSet => {
  try {
    if (typeof input === 'string') return loadTestDataSetFile(input, process.cwd());
    return parseTestDataSet(input, 'inline');
  } catch (error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof TestDataSetError ? error.message : String(error),
    });
    return z.NEVER;
  }
});

export const flowSchema = z
  .object({
    name: nonEmpty,
    description: z.string().optional(),
    /** Page chargée avant la première étape (par défaut : target.startAt). */
    startAt: nonEmpty.optional(),
    steps: z.array(stepSchema).min(1),
    /**
     * Les données du flow (TestDataSet) : un fichier (`test-data.yaml`, relatif au fichier qui
     * le cite) ou le jeu lui-même. `{ testData: request.title }` y est résolu au rejeu.
     */
    testData: testDataSetInput.optional(),
    /**
     * Une fois le flow réussi, explorer son dernier écran : seulement les contrôles
     * de la page et les pages sous son chemin (jamais le menu global). S'exécute
     * même quand exploration.autonomous vaut false.
     */
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
  /** role, pour la stratégie role. */
  role?: string;
  /** Nom accessible, pour la stratégie role. */
  name?: string;
  /** testId, libellé, texte ou sélecteur CSS. */
  value?: string;
  exact?: boolean;
  nth?: number;
}

export type FlowValue = string | { env: string } | { testData: string };

export interface FlowExpectation {
  text?: string;
  url?: string;
  visible?: FlowTarget;
  hidden?: FlowTarget;
  noError?: true;
  response?: { method?: string; url: string; status: number | '2xx' | '3xx' | '4xx' | '5xx' };
}

export interface StepEffects {
  appears?: string[];
  disappears?: string[];
  route?: string;
  request?: string;
  required?: boolean;
}

export interface TargetFingerprint {
  role?: string;
  name?: string;
  text?: string;
  testId?: string;
  tag?: string;
  context?: string;
}

interface StepCommon {
  name?: string;
  effects?: StepEffects;
  fingerprint?: TargetFingerprint;
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
    | { kind: 'manual'; text: string }
    | { kind: 'auto'; sentence: string; type: 'Context' | 'Action' | 'Outcome' | 'Unknown' }
    | { kind: 'intent'; intent: GherkinIntent }
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

/** Description lisible d'une cible, pour les logs et les rapports : role=button[name="Suivant"]. */
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
 * Description lisible d'une étape. Les valeurs lues dans l'environnement ne sont
 * jamais affichées ; `maskValue` masque aussi les valeurs littérales (champs sensibles).
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
    case 'manual':
      return `manual check: ${step.text}`;
    case 'auto':
      return `auto: ${step.sentence}`;
    case 'intent':
      return `intent: ${describeIntent(step.intent)}`;
  }
}

export function describeValue(value: FlowValue): string {
  if (typeof value === 'string') return `"${value}"`;
  return 'env' in value ? `\${env:${value.env}}` : `\${testData:${value.testData}}`;
}

export function describeExpectation(expectation: FlowExpectation): string {
  const parts: string[] = [];
  if (expectation.text !== undefined) parts.push(`text "${expectation.text}"`);
  if (expectation.url !== undefined) parts.push(`url contains "${expectation.url}"`);
  if (expectation.visible) parts.push(`visible ${describeTarget(expectation.visible)}`);
  if (expectation.hidden) parts.push(`hidden ${describeTarget(expectation.hidden)}`);
  if (expectation.noError) parts.push('no error message');
  if (expectation.response)
    parts.push(
      `response ${expectation.response.method ? `${expectation.response.method} ` : ''}"${expectation.response.url}" ${String(expectation.response.status)}`,
    );
  return parts.join(', ');
}
