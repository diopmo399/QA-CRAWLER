import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type * as TS from 'typescript';
import { parse as parseYaml } from 'yaml';
import { flowSchema } from '../config/flow-schema.js';
import type { FlowConfig } from '../config/flow-schema.js';
import { GherkinStepDictionary } from '../flows/gherkin/gherkin-steps.js';
import type { FlowRunReport } from '../model/flow-run.js';
import type { RecordedFlow } from '../recording/model.js';
import { generateFlowFiles } from '../recording/recorded-flow.js';
import { flowForGroups } from '../recording/step-groups.js';
import { translateAssertion } from './assertion-translation.js';
import type { FlowDefinition } from './flow-steps.js';
import {
  generateJavaJUnitPlaywrightProject,
  type JavaGenerationOptions,
} from './java-junit-playwright-generator.js';
import { generatePlaywrightTest } from './playwright-test-generator.js';

/**
 * LE PLAN DE GÉNÉRATION : d'un flow enregistré (ou d'un sous-ensemble de ses groupes), les artefacts
 * demandés — flow YAML, scénario Gherkin, test Playwright TypeScript, projet Java JUnit 5 + Playwright
 * Java — avec, pour chacun, un statut qui ne confond jamais génération, validation statique et
 * exécution réelle :
 *
 *   GENERATED               écrit en mémoire (ou sur disque) ;
 *   STATICALLY_VALIDATED    relu par un outil réel (schéma du flow, dictionnaire Gherkin, compilateur
 *                           TypeScript en syntaxe seule, `mvn test-compile` quand Maven est là) ;
 *   NOT_VALIDATED           aucune validation possible ici (outil absent) — dit, jamais caché ;
 *   EXECUTED / PASSED / FAILED / BLOCKED / INCONCLUSIVE   seulement d'après une exécution réelle
 *                           (le rejeu QA-CRAWLER, ou `mvn test`), rapportée par `applyExecution`.
 *
 * Les assertions suivent la même règle : PROPOSED / APPROVED (décision humaine), puis le statut de
 * leur dernière exécution, jamais un succès par défaut.
 */
export type GenerationFormat = 'yaml' | 'gherkin' | 'playwright' | 'java';

export type GenerationStatus =
  | 'GENERATED'
  | 'STATICALLY_VALIDATED'
  | 'NOT_VALIDATED'
  | 'EXECUTED'
  | 'PASSED'
  | 'FAILED'
  | 'BLOCKED'
  | 'INCONCLUSIVE';

export interface ArtifactAssertion {
  id: string;
  description: string;
  /** NATIVE : vérifiée par le test autonome ; REPLAY_ONLY : par le rejeu QA-CRAWLER seulement. */
  support: 'NATIVE' | 'REPLAY_ONLY';
  status: 'APPROVED' | 'MODIFIED' | 'PASS' | 'FAIL' | 'BLOCKED' | 'INCONCLUSIVE' | 'UNVERIFIABLE';
}

export interface GeneratedArtifact {
  format: GenerationFormat;
  /** Chemin relatif au dossier de génération. */
  path: string;
  content: string;
  status: GenerationStatus;
  validation?: { method: string; ok: boolean; messages: string[] };
  assertions: ArtifactAssertion[];
  /** Ce que l'artefact ne peut pas faire (étapes non rejouables, assertions rejeu seulement). */
  limits: string[];
}

export interface GenerationRequest {
  flow: RecordedFlow;
  formats: readonly GenerationFormat[];
  baseUrl: string;
  language: 'fr' | 'en';
  /** Les groupes à générer (tous quand absent) ; `force` passe outre les entrées manquantes. */
  groupIds?: readonly string[];
  force?: boolean;
  recordedAt?: string;
  testDataFile?: string;
  java?: Pick<JavaGenerationOptions, 'packageName' | 'versions'>;
  reports?: readonly FlowRunReport[];
}

export interface GenerationPlan {
  name: string;
  /** Le flow effectivement généré (le sous-ensemble choisi). */
  flow: RecordedFlow;
  artifacts: GeneratedArtifact[];
  warnings: string[];
}

const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'flow';

function assertionsOf(flow: RecordedFlow, native: boolean): ArtifactAssertion[] {
  return (flow.businessAssertions ?? []).map((assertion) => {
    const translated = translateAssertion(assertion);
    const proposal = flow.proposals?.find((entry) => entry.assertion?.id === assertion.id);
    return {
      id: assertion.id,
      description: assertion.description,
      support: native ? translated.support : 'REPLAY_ONLY',
      status: proposal?.status === 'MODIFIED' ? 'MODIFIED' : 'APPROVED',
    };
  });
}

/** Le FlowDefinition (schéma de la mission) d'un flow enregistré : ce que les générateurs lisent. */
export function definitionOf(flow: RecordedFlow, files: { yaml: string }): FlowDefinition {
  const parsed: FlowConfig = flowSchema.parse(parseYaml(files.yaml));
  return {
    name: parsed.name,
    ...(parsed.description !== undefined ? { description: parsed.description } : {}),
    ...(parsed.startAt !== undefined ? { startAt: parsed.startAt } : {}),
    steps: parsed.steps,
    assertions: parsed.assertions,
    groups: parsed.groups,
  };
}

/** Les artefacts demandés, générés en mémoire (statut GENERATED), sans rien exécuter. */
export function planGeneration(request: GenerationRequest): GenerationPlan | { error: string } {
  let flow = request.flow;
  const warnings: string[] = [];
  if (request.groupIds && request.groupIds.length > 0) {
    const subset = flowForGroups(request.flow, request.groupIds, { force: request.force === true });
    if ('error' in subset) return { error: subset.error };
    flow = subset.flow;
    if (request.force && flow.steps.length < request.flow.steps.length)
      warnings.push(
        'generated from a selection of groups: data produced outside the selection must be provided at run time',
      );
  }
  if (flow.steps.length === 0) return { error: 'nothing to generate: the flow has no step' };
  const files = generateFlowFiles(flow, {
    language: request.language,
    recordedAt: request.recordedAt ?? new Date().toISOString(),
    ...(request.testDataFile ? { testDataFile: request.testDataFile } : {}),
  });
  const base = slug(flow.name);
  const artifacts: GeneratedArtifact[] = [];
  const replayOnly = assertionsOf(flow, true).filter((assertion) => assertion.support === 'REPLAY_ONLY');
  const limitsOf = (format: GenerationFormat): string[] =>
    format === 'yaml'
      ? []
      : replayOnly.map(
          (assertion) => `${assertion.id} is verified by the QA-CRAWLER replay only (run the flow YAML)`,
        );
  for (const format of request.formats) {
    switch (format) {
      case 'yaml':
        artifacts.push({
          format,
          path: `${base}.flow.yaml`,
          content: files.yaml,
          status: 'GENERATED',
          assertions: assertionsOf(flow, false).map((assertion) => ({ ...assertion, support: 'NATIVE' })),
          limits: [],
        });
        break;
      case 'gherkin':
        artifacts.push({
          format,
          path: `${base}.feature`,
          content: files.feature,
          status: 'GENERATED',
          assertions: assertionsOf(flow, true),
          limits: limitsOf(format),
        });
        break;
      case 'playwright': {
        const definition = definitionOf(flow, files);
        const test = generatePlaywrightTest(
          definition,
          request.reports?.find((report) => report.name === flow.name),
          { baseUrl: request.baseUrl },
        );
        artifacts.push({
          format,
          path: `playwright/${test.fileName}`,
          content: test.content,
          status: 'GENERATED',
          assertions: assertionsOf(flow, true),
          limits: limitsOf(format),
        });
        break;
      }
      case 'java': {
        const definition = definitionOf(flow, files);
        const project = generateJavaJUnitPlaywrightProject([definition], request.reports ?? [], {
          baseUrl: request.baseUrl,
          ...(request.java ?? {}),
        });
        const limits = [...limitsOf(format), ...project.tests.flatMap((test) => test.unsupported)];
        for (const file of project.files)
          artifacts.push({
            format,
            path: `java/${file.path}`,
            content: file.content,
            status: 'GENERATED',
            assertions:
              file.path.endsWith('Test.java') && !file.path.includes('/support/')
                ? assertionsOf(flow, true)
                : [],
            limits: file.path.endsWith('Test.java') && !file.path.includes('/support/') ? limits : [],
          });
        break;
      }
    }
  }
  return { name: flow.name, flow, artifacts, warnings };
}

// ------------------------------------------------------------------ validation statique (outils réels)

function run(command: string, args: string[], cwd: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    let output = '';
    try {
      const child = spawn(command, args, { cwd });
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.on('error', (error) => {
        resolve({ code: null, output: `${output}\n${error.message}` });
      });
      child.on('close', (code) => {
        resolve({ code, output });
      });
    } catch (error) {
      resolve({ code: null, output: error instanceof Error ? error.message : String(error) });
    }
  });
}

async function validateTypeScript(
  content: string,
): Promise<{ method: string; ok: boolean; messages: string[] }> {
  try {
    const ts: typeof TS = await import('typescript');
    const result = ts.transpileModule(content, {
      reportDiagnostics: true,
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    });
    const messages = (result.diagnostics ?? []).map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    );
    return {
      method: 'typescript syntax (transpileModule; types are not checked without @playwright/test)',
      ok: messages.length === 0,
      messages,
    };
  } catch {
    return { method: 'typescript', ok: false, messages: ['typescript is not installed: not validated'] };
  }
}

function validateGherkin(content: string): { method: string; ok: boolean; messages: string[] } {
  const dictionary = new GherkinStepDictionary();
  const messages: string[] = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    const match =
      /^(Étant donné qu['’]|Étant donné que|Étant donné|Soit|Quand|Lorsque|Alors|Et que|Et|Mais|Given|When|Then|And|But)\s+(.+)$/.exec(
        line,
      );
    if (!match || !match[2]) continue;
    if (!dictionary.translate(match[2])) messages.push(`no step definition for: ${line}`);
  }
  return {
    method: 'gherkin dictionary (every sentence has a step definition)',
    ok: messages.length === 0,
    messages,
  };
}

function validateYaml(content: string): { method: string; ok: boolean; messages: string[] } {
  const parsed = flowSchema.safeParse(parseYaml(content));
  return {
    method: 'flow schema',
    ok: parsed.success,
    messages: parsed.success
      ? []
      : parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
  };
}

/** Écrit les artefacts sous `directory` ; renvoie les chemins absolus. */
export async function writeArtifacts(
  artifacts: readonly GeneratedArtifact[],
  directory: string,
): Promise<string[]> {
  const written: string[] = [];
  for (const artifact of artifacts) {
    const target = path.join(directory, artifact.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, artifact.content, 'utf8');
    written.push(target);
  }
  return written;
}

/**
 * Valide statiquement chaque artefact avec l'outil réel disponible, et le dit quand aucun ne l'est.
 * Java : `mvn -q test-compile` dans `directory/java` (les artefacts doivent être écrits avant).
 */
export async function validateArtifacts(
  artifacts: readonly GeneratedArtifact[],
  options: { directory?: string; maven?: boolean } = {},
): Promise<GeneratedArtifact[]> {
  const result: GeneratedArtifact[] = [];
  let javaValidation: GeneratedArtifact['validation'] | undefined;
  for (const artifact of artifacts) {
    let validation: GeneratedArtifact['validation'];
    switch (artifact.format) {
      case 'yaml':
        validation = validateYaml(artifact.content);
        break;
      case 'gherkin':
        validation = validateGherkin(artifact.content);
        break;
      case 'playwright':
        validation = await validateTypeScript(artifact.content);
        break;
      case 'java': {
        if (!javaValidation) {
          if (options.maven !== false && options.directory) {
            const maven = await run(
              'mvn',
              ['-q', '-B', 'test-compile'],
              path.join(options.directory, 'java'),
            );
            javaValidation =
              maven.code === null
                ? { method: 'maven', ok: false, messages: ['Maven is not available: not validated'] }
                : {
                    method:
                      'mvn test-compile (compiled with the declared JUnit 5 and Playwright Java versions)',
                    ok: maven.code === 0,
                    messages:
                      maven.code === 0
                        ? []
                        : maven.output
                            .split('\n')
                            .filter((line) => /ERROR|error:/.test(line))
                            .slice(0, 20),
                  };
          } else
            javaValidation = {
              method: 'maven',
              ok: false,
              messages: ['not written to disk, or Maven disabled: not validated'],
            };
        }
        validation = javaValidation;
        break;
      }
    }
    const unavailable = validation.messages.some((message) => message.endsWith('not validated'));
    result.push({
      ...artifact,
      validation,
      status: validation.ok ? 'STATICALLY_VALIDATED' : unavailable ? 'NOT_VALIDATED' : 'GENERATED',
    });
  }
  return result;
}

/** Le statut d'exécution réel (rejeu QA-CRAWLER du flow YAML, ou `mvn test`), jamais déduit. */
export function applyExecution(
  artifacts: readonly GeneratedArtifact[],
  execution: {
    format: GenerationFormat;
    status: Exclude<GenerationStatus, 'GENERATED' | 'STATICALLY_VALIDATED' | 'NOT_VALIDATED'>;
    assertions?: Record<string, ArtifactAssertion['status']>;
  },
): GeneratedArtifact[] {
  return artifacts.map((artifact) =>
    artifact.format === execution.format
      ? {
          ...artifact,
          status: execution.status,
          assertions: artifact.assertions.map((assertion) => ({
            ...assertion,
            status: execution.assertions?.[assertion.id] ?? assertion.status,
          })),
        }
      : artifact,
  );
}

/** Le résumé d'un plan : par format, le statut et les limites ; par assertion, son soutien. */
export function planSummary(plan: GenerationPlan): {
  formats: { format: GenerationFormat; files: number; status: GenerationStatus; limits: number }[];
  assertions: { native: number; replayOnly: number };
} {
  const byFormat = new Map<GenerationFormat, GeneratedArtifact[]>();
  for (const artifact of plan.artifacts)
    (byFormat.get(artifact.format) ?? byFormat.set(artifact.format, []).get(artifact.format))?.push(artifact);
  const order: GenerationStatus[] = [
    'FAILED',
    'BLOCKED',
    'INCONCLUSIVE',
    'NOT_VALIDATED',
    'GENERATED',
    'STATICALLY_VALIDATED',
    'EXECUTED',
    'PASSED',
  ];
  const formats = [...byFormat.entries()].map(([format, artifacts]) => ({
    format,
    files: artifacts.length,
    status:
      artifacts.map((artifact) => artifact.status).sort((a, b) => order.indexOf(a) - order.indexOf(b))[0] ??
      'GENERATED',
    limits: new Set(artifacts.flatMap((artifact) => artifact.limits)).size,
  }));
  const assertions = assertionsOf(plan.flow, true);
  return {
    formats,
    assertions: {
      native: assertions.filter((assertion) => assertion.support === 'NATIVE').length,
      replayOnly: assertions.filter((assertion) => assertion.support === 'REPLAY_ONLY').length,
    },
  };
}
