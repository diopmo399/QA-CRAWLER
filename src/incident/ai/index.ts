import { secretValuesOf } from '../../ai/factory.js';
import type { AiConfig } from '../../config/config.js';
import type {
  AiAssistantAnswer,
  AiBudget,
  AiCapabilities,
  AiExperimentProposal,
  AiInvestigationMode,
  AiInvestigationRun,
  AiScopeRequest,
  DeepInvestigationBudget,
  EnvironmentCapabilities,
  Experiment,
  Incident,
  InvestigationDepth,
  InvestigationMemory,
  InvestigationPermission,
  ScopeExtensionKind,
} from '../../sdk/core/incident-contracts.js';
import { incidentReproduction } from '../evidence.js';
import type { GuardedFiles } from '../guarded-fs.js';
import type { ScopePolicy } from '../scope-policy.js';
import type { AgentRunContext, InvestigationAgent, ToolContext, ToolResult } from './agent.js';
import { contradictionHunterAgent } from './agents/contradiction-hunter.js';
import { crossLayerAgent } from './agents/cross-layer.js';
import { evidenceAnalysisAgent } from './agents/evidence-analysis.js';
import { hypothesisAgent } from './agents/hypothesis.js';
import { backendAgent } from './agents/layer-backend.js';
import { bffAgent } from './agents/layer-bff.js';
import { frontendAgent } from './agents/layer-frontend.js';
import { plannerAgent } from './agents/planner.js';
import { synthesisAgent } from './agents/synthesis.js';
import { verificationPlanningAgent } from './agents/verification-planning.js';
import { answerQuestion } from './agents/assistant.js';
import { createBudgetTracker } from './budget.js';
import { incidentAiCapabilities, resolveIncidentAiSettings, type IncidentAiSettings } from './config.js';
import { gitChangesTool } from './deep/git-changes.js';
import {
  addExperiment,
  extendBudget,
  fileMemoryStore,
  loadMemory,
  recordEvent,
  recordPermission,
  saveMemory,
  setStatus,
  type MemoryStore,
} from './deep/memory.js';
import { memoryTool } from './deep/memory-tool.js';
import { runDeepInvestigation, type DeepInvestigationOutcome } from './deep/orchestrator.js';
import { createPacks } from './evidence-pack.js';
import { createAgentLoop } from './loop.js';
import type { InvestigationModelClient } from './model-client.js';
import { defaultCanAutoRun } from './orchestrator.js';
import { createInvestigationModelClient, type ModelClientFactoryOptions } from './providers/factory.js';
import { RefIndex } from './refs.js';
import { createToolRegistry } from './tools.js';
import { INVESTIGATION_TOOL_NAMES } from './agent.js';

/**
 * LE RUNTIME DE L'INVESTIGATION IA, assemblé une fois par serveur : réglages validés, capacités annoncées,
 * client de modèle (ou la raison de son absence), agents, mémoire. Le service d'incidents ne connaît que ce
 * contrat (`IncidentAiRuntime`) ; en DETERMINISTIC le serveur ne charge pas ce module.
 */
export type ActiveMode = Exclude<AiInvestigationMode, 'DETERMINISTIC'>;

export interface AiRunnerInput {
  incident: Incident;
  mode: ActiveMode;
  depth: InvestigationDepth;
  /** Le budget déjà résolu par le service (configuration, bornes, demande plus petite). */
  budget: AiBudget;
  policy: ScopePolicy;
  files: GuardedFiles;
  capabilities?: EnvironmentCapabilities;
  actor: string;
  signal: AbortSignal;
  projectDir: string;
  now: () => string;
  onProgress?: (run: AiInvestigationRun) => void;
  /** Lance une proposition par le chemin ordinaire du service (AI_AGENTIC) ; absent : rien n'est lancé. */
  runExperiment?: (proposal: AiExperimentProposal) => Promise<Experiment>;
  refresh?: () => Promise<Incident>;
  isPaused?: () => boolean;
  runId?: string;
}

export interface AiRunnerOutcome extends DeepInvestigationOutcome {
  /** Les propositions faites par l'outil `propose_experiment` (en plus du plan de vérification). */
  toolProposals: AiExperimentProposal[];
}

export interface AiAskInput {
  incident: Incident;
  question: string;
  policy: ScopePolicy;
  files: GuardedFiles;
  actor: string;
  signal: AbortSignal;
  projectDir: string;
  now: () => string;
}

export interface IncidentAiMemoryAccess {
  read(incidentId: string): Promise<InvestigationMemory | undefined>;
  /** Une prolongation accordée par une personne (DECIDE) : jamais automatique. */
  extend(incidentId: string, added: Partial<AiBudget>, by: string): Promise<InvestigationMemory | undefined>;
  /** Une décision d'une personne sur une expérience générée : liée à l'opération et à ses paramètres. */
  decide(
    incidentId: string,
    input: {
      experimentId: string;
      decision: InvestigationPermission['decision'];
      by: string;
      reason?: string;
      /** L'expérience planifiée dans l'incident, quand la décision l'a lancée. */
      plannedExperimentId?: string;
    },
  ): Promise<InvestigationMemory | undefined>;
  /** Marque la mémoire en pause (contrôle PAUSE) ; la boucle s'arrête à l'itération suivante. */
  pause(incidentId: string, by: string): Promise<InvestigationMemory | undefined>;
}

export interface IncidentAiRuntime {
  readonly settings: IncidentAiSettings;
  capabilities(): AiCapabilities;
  readonly client?: InvestigationModelClient;
  readonly agents: readonly InvestigationAgent<unknown>[];
  investigate(input: AiRunnerInput): Promise<AiRunnerOutcome>;
  ask(input: AiAskInput): Promise<AiAssistantAnswer>;
  memory(projectDir: string): IncidentAiMemoryAccess;
  close(): Promise<void>;
}

export interface IncidentAiRuntimeOptions {
  /** Un client déjà construit (tests : le client scripté) ; il prime sur la fabrique. */
  client?: InvestigationModelClient;
  loadSdk?: ModelClientFactoryOptions['loadSdk'];
  prices?: ModelClientFactoryOptions['prices'];
  /** Le dépôt de mémoire (tests : en mémoire) ; défaut : fichiers sous `<projectDir>/incidents/<id>/ai/`. */
  memoryStore?: (projectDir: string) => MemoryStore;
  /** Les agents (tests) ; défaut : tous. */
  agents?: readonly InvestigationAgent<unknown>[];
  gitEnv?: NodeJS.ProcessEnv;
}

export const ALL_AGENTS: readonly InvestigationAgent<unknown>[] = [
  plannerAgent,
  evidenceAnalysisAgent,
  frontendAgent,
  bffAgent,
  backendAgent,
  crossLayerAgent,
  hypothesisAgent,
  verificationPlanningAgent,
  contradictionHunterAgent,
  synthesisAgent,
] as readonly InvestigationAgent<unknown>[];

/** Appels au modèle de l'assistant, au plus, par question. */
export const ASSISTANT_MAX_TURNS = 4;
const RESULT_CHARS_PER_SNIPPET = 4;

export function createIncidentAiRuntime(
  ai: AiConfig | undefined,
  env: NodeJS.ProcessEnv,
  options: IncidentAiRuntimeOptions = {},
): IncidentAiRuntime {
  let settings = resolveIncidentAiSettings(ai, env);
  let client = options.client;
  // Un client fourni (tests, intégration hôte) : la configuration dit le mode et la politique, pas les secrets.
  if (
    client &&
    !settings.enabled &&
    settings.configuredMode !== 'DETERMINISTIC' &&
    settings.dataPolicy.allowExternal
  ) {
    const { unavailableReason: _unavailable, ...rest } = settings;
    settings = { ...rest, mode: settings.configuredMode, enabled: true };
  }
  if (!client) {
    const made = createInvestigationModelClient(settings, ai, {
      env,
      ...(options.loadSdk ? { loadSdk: options.loadSdk } : {}),
      ...(options.prices ? { prices: options.prices } : {}),
    });
    client = made.client;
    if (!client && settings.enabled)
      settings = {
        ...settings,
        mode: 'DETERMINISTIC',
        enabled: false,
        unavailableReason: made.unavailableReason ?? 'aucun client de modèle',
      };
  }
  const agents = options.agents ?? ALL_AGENTS;
  const secretValues = secretValuesOf(env);
  const storeOf = options.memoryStore ?? fileMemoryStore;
  const gitEnv = options.gitEnv ?? env;

  const toolContext = (
    input: Pick<AiRunnerInput, 'incident' | 'policy' | 'files' | 'signal'>,
    collected: { proposals: AiExperimentProposal[]; scopeRequests: AiScopeRequest[] },
    runId: string,
  ): ToolContext => {
    const { incident } = input;
    return {
      incident,
      policy: input.policy,
      files: input.files,
      ...(incident.investigation.code ? { code: incident.investigation.code } : {}),
      ...(incident.investigation.graph ? { graph: incident.investigation.graph } : {}),
      ...(incidentReproduction(incident) ? { reproduction: incidentReproduction(incident) } : {}),
      dataPolicy: settings.dataPolicy,
      repositories: incident.scope.applications.map((application) => ({
        applicationId: application.id,
        root: application.repository.root,
        layer: application.layer,
      })),
      proposals: {
        proposeExperiment: (raw) =>
          Promise.resolve(collectProposal(raw, collected.proposals, runId, incident)),
        requestScopeExtension: (raw) =>
          Promise.resolve(collectScopeRequest(raw, collected.scopeRequests, runId)),
      },
      signal: input.signal,
    };
  };

  const runtime: IncidentAiRuntime = {
    settings,
    capabilities: () => incidentAiCapabilities(settings),
    ...(client ? { client } : {}),
    agents,
    async investigate(input) {
      if (!client) throw new Error(settings.unavailableReason ?? 'IA indisponible');
      const runId = input.runId ?? `ai_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const collected = { proposals: [] as AiExperimentProposal[], scopeRequests: [] as AiScopeRequest[] };
      const ctx = toolContext(input, collected, runId);
      const refs = new RefIndex(input.incident);
      let latestMemory: InvestigationMemory | undefined;
      const tools = createToolRegistry(ctx, INVESTIGATION_TOOL_NAMES, {
        maxResultChars: settings.dataPolicy.maxSnippetChars * RESULT_CHARS_PER_SNIPPET,
        secretValues,
        refs,
        extra: [gitChangesTool({ env: gitEnv }), memoryTool(() => latestMemory)],
        now: input.now,
      });
      const packs = createPacks(
        {
          ...ctx,
          hypotheses: input.incident.investigation.hypotheses,
          experiments: input.incident.investigation.experiments,
        },
        settings.dataPolicy,
        { secretValues },
      );
      const budget: DeepInvestigationBudget = {
        ...input.budget,
        maxCommands: 0,
        maxConcurrentAgents: 3,
        extensions: [],
      };
      const outcome = await runDeepInvestigation({
        incident: input.incident,
        mode: input.mode,
        depth: input.depth,
        client,
        tools,
        packs,
        budget,
        dataPolicy: settings.dataPolicy,
        signal: input.signal,
        actor: input.actor,
        now: input.now,
        agents: [...agents],
        store: storeOf(input.projectDir),
        policy: input.policy,
        ...(input.capabilities ? { capabilities: input.capabilities } : {}),
        ...(input.onProgress ? { onProgress: input.onProgress } : {}),
        ...(input.runExperiment ? { runExperiment: input.runExperiment } : {}),
        ...(input.refresh ? { refresh: input.refresh } : {}),
        ...(input.isPaused ? { isPaused: input.isPaused } : {}),
        runId,
        timeoutMs: settings.timeoutMs,
        maxTurnsPerAgent: settings.maxTurnsPerAgent,
        refs,
        canAutoRun: defaultCanAutoRun,
        collectScopeRequests: () => collected.scopeRequests,
        onMemory: (memory) => {
          latestMemory = memory;
        },
      });
      return { ...outcome, toolProposals: collected.proposals };
    },
    async ask(input) {
      const askedAt = input.now();
      const base = {
        id: `ans_${Date.parse(askedAt).toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        askedAt,
        askedBy: input.actor,
        question: input.question.slice(0, 1000),
        answer: '',
        refs: [],
        locations: [],
      };
      if (!client || settings.mode === 'DETERMINISTIC')
        return { ...base, unavailable: settings.unavailableReason ?? 'IA indisponible (mode DETERMINISTIC)' };
      const collected = { proposals: [] as AiExperimentProposal[], scopeRequests: [] as AiScopeRequest[] };
      const ctx = toolContext(input, collected, 'assistant');
      const refs = new RefIndex(input.incident);
      const tools = createToolRegistry(ctx, INVESTIGATION_TOOL_NAMES, {
        maxResultChars: settings.dataPolicy.maxSnippetChars * RESULT_CHARS_PER_SNIPPET,
        secretValues,
        refs,
        now: input.now,
      });
      const packs = createPacks(
        {
          ...ctx,
          hypotheses: input.incident.investigation.hypotheses,
          experiments: input.incident.investigation.experiments,
        },
        settings.dataPolicy,
        { secretValues },
      );
      const budget = createBudgetTracker({ ...settings.budget, maxModelCalls: ASSISTANT_MAX_TURNS });
      const loop = createAgentLoop({
        client,
        tools,
        budget,
        signal: input.signal,
        timeoutMs: settings.timeoutMs,
        dataPolicy: settings.dataPolicy,
        now: input.now,
      });
      const context: AgentRunContext & { askedBy: string; refs: RefIndex } = {
        mode: settings.mode,
        incident: input.incident,
        tools,
        loop,
        budget: budget.budget,
        packs,
        previous: {},
        signal: input.signal,
        now: input.now,
        askedBy: input.actor,
        refs,
      };
      return answerQuestion(context, input.question);
    },
    memory(projectDir) {
      const store = storeOf(projectDir);
      const fallback = (): {
        depth: InvestigationDepth;
        mode: AiInvestigationMode;
        budget: DeepInvestigationBudget;
      } => ({
        depth: 'STANDARD',
        mode: settings.mode,
        budget: { ...settings.budget, maxConcurrentAgents: 3, extensions: [] },
      });
      const existing = async (incidentId: string): Promise<InvestigationMemory | undefined> => {
        const loaded = await loadMemory(store, incidentId, fallback());
        return loaded.fresh ? undefined : loaded.memory;
      };
      return {
        read: existing,
        async extend(incidentId, added, by) {
          const memory = await existing(incidentId);
          if (!memory) return undefined;
          return saveMemory(store, extendBudget(memory, added, by));
        },
        async decide(incidentId, input) {
          const memory = await existing(incidentId);
          if (!memory) return undefined;
          const experiment = memory.experiments.find((item) => item.id === input.experimentId);
          if (!experiment) return memory;
          const at = new Date().toISOString();
          let next = recordPermission(memory, {
            at,
            by: input.by,
            experimentId: experiment.id,
            operation: `${experiment.kind}${experiment.operations[0] ? ` ${experiment.operations[0].kind}` : ''}`,
            parameters: Object.fromEntries(
              Object.entries(experiment.verification.params).map(([key, value]) => [key, String(value)]),
            ),
            decision: input.decision,
            ...(input.reason ? { reason: input.reason } : {}),
          });
          next = addExperiment(
            next,
            {
              ...experiment,
              status: input.decision === 'APPROVED' ? 'PLANNED' : 'REFUSED',
              ...(input.plannedExperimentId ? { experimentId: input.plannedExperimentId } : {}),
              ...(input.decision === 'REFUSED' ? { refusal: input.reason ?? `refusée par ${input.by}` } : {}),
            },
            { at },
          ).memory;
          return saveMemory(store, next);
        },
        async pause(incidentId, by) {
          const memory = await existing(incidentId);
          if (!memory) return undefined;
          const at = new Date().toISOString();
          const next = recordEvent(setStatus(memory, 'PAUSED', 'PAUSED', at), {
            kind: 'PAUSE',
            at,
            actor: by,
            summary: 'Pause demandée : la boucle s’arrête à la prochaine itération.',
          });
          return saveMemory(store, next);
        },
      };
    },
    async close() {
      await client?.close?.();
    },
  };
  return runtime;
}

/** La proposition faite par l'outil `propose_experiment` (déjà validée par zod) : enregistrée PROPOSED, jamais exécutée. */
function collectProposal(
  raw: unknown,
  into: AiExperimentProposal[],
  runId: string,
  incident: Incident,
): ToolResult {
  const value = raw as Partial<AiExperimentProposal> & {
    verification?: AiExperimentProposal['verification'];
  };
  if (!value.hypothesisId || !value.kind || !value.verification || !value.objective)
    return { ok: false, error: 'incomplete proposal', rule: 'proposal.shape' };
  if (!incident.investigation.hypotheses.some((hypothesis) => hypothesis.id === value.hypothesisId))
    return { ok: false, error: `unknown hypothesis ${value.hypothesisId}`, rule: 'proposal.hypothesis' };
  const id = `${runId}-tool-${String(into.length + 1)}`;
  into.push({
    id,
    hypothesisId: value.hypothesisId,
    kind: value.kind,
    objective: value.objective,
    verification: value.verification,
    resources: value.resources ?? [],
    permissions: value.permissions ?? [],
    risks: value.risks ?? [],
    sideEffects: value.sideEffects ?? false,
    expected: value.expected ?? '',
    confirmIf: value.confirmIf ?? '',
    refuteIf: value.refuteIf ?? '',
    status: 'PROPOSED',
  });
  return { ok: true, data: { id, status: 'PROPOSED', note: 'recorded; a person decides whether it runs' } };
}

function collectScopeRequest(raw: unknown, into: AiScopeRequest[], runId: string): ToolResult {
  const value = raw as Partial<{
    kind: ScopeExtensionKind;
    target: string;
    applicationId?: string;
    reason: string;
  }>;
  if (!value.kind || !value.target || !value.reason)
    return { ok: false, error: 'incomplete request', rule: 'scope.shape' };
  const id = `${runId}-scope-${String(into.length + 1)}`;
  into.push({
    id,
    kind: value.kind,
    target: value.target,
    ...(value.applicationId ? { applicationId: value.applicationId } : {}),
    reason: value.reason,
  });
  return { ok: true, data: { id, status: 'PENDING', note: 'a person decides' } };
}

export type { IncidentAiSettings } from './config.js';
export { resolveIncidentAiSettings, incidentAiCapabilities } from './config.js';
