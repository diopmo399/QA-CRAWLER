import type { ApiContract } from '../oracles/api-contract.js';
import {
  describeConditions,
  describeEffect,
  type ApplicationRule,
} from '../static-analysis/rules/rule-model.js';
import { goalPriority, riskOf } from './goal-scoring.js';
import type {
  ActionSideEffect,
  ApplicationInvariant,
  BusinessStateMachine,
  ErrorPath,
  FunctionalWorkflow,
  SemanticTarget,
  TestGoal,
  TestGoalCategory,
} from './model.js';

/** Ce que la SafetyPolicy dit de l'action qui réaliserait un objectif. */
export interface GoalSafetyJudgement {
  allowed: boolean;
  classification: string;
  reason: string;
}

export interface GoalSources {
  machines: readonly BusinessStateMachine[];
  workflows: readonly FunctionalWorkflow[];
  invariants: readonly ApplicationInvariant[];
  errorPaths: readonly ErrorPath[];
  sideEffects: readonly ActionSideEffect[];
  rules: readonly ApplicationRule[];
  contract?: ApiContract;
}

/**
 * TEST GOAL GENERATOR — la pièce centrale : de la connaissance fonctionnelle aux
 * OBJECTIFS DE TEST (« Verify PENDING registration can transition to APPROVED »).
 * Chaque objectif dit d'où il vient (generatedFrom, sourceId, preuves) et pourquoi il
 * existe (reason) ; il est dédupliqué par signature sémantique (CATEGORY:signature).
 *
 * La SafetyPolicy juge l'action déclencheuse AVANT tout : un objectif dont l'action est
 * interdite est BLOCKED à sa naissance et ne sera jamais exécuté ni favorisé.
 */
export class TestGoalGenerator {
  private readonly goals = new Map<string, TestGoal>();
  /** Objectifs écartés par le budget maxGoalsPerRun. */
  deferred = 0;

  constructor(
    private readonly safety: (target: SemanticTarget, category: TestGoalCategory) => GoalSafetyJudgement,
    private readonly maxGoals = 50,
  ) {}

  all(): TestGoal[] {
    return [...this.goals.values()].sort((a, b) => b.priority - a.priority);
  }

  get(id: string): TestGoal | undefined {
    return this.goals.get(id);
  }

  /** Génère (ou complète) les objectifs ; les objectifs déjà connus gardent leur état. Renvoie les nouveaux. */
  generate(sources: GoalSources): TestGoal[] {
    const created: TestGoal[] = [];
    // judgeAs : ce que la SafetyPolicy juge quand aucun bouton n'est connu (« pay registration »).
    const add = (
      goal: Omit<TestGoal, 'priority' | 'status' | 'risk'> & { confidence: number; judgeAs?: string },
    ): void => {
      if (this.goals.has(goal.id)) return;
      if (this.goals.size >= this.maxGoals) {
        this.deferred += 1;
        return;
      }
      const label = goal.target?.actionLabel ?? goal.judgeAs;
      const judgement = goal.target
        ? this.safety({ ...goal.target, ...(label ? { actionLabel: label } : {}) }, goal.category)
        : undefined;
      const risk = riskOf(judgement?.classification);
      const { confidence, judgeAs: _judgeAs, ...rest } = goal;
      const entry: TestGoal = {
        ...rest,
        risk,
        priority: goalPriority({
          category: goal.category,
          coverageGain: goal.coverageGain,
          estimatedCost: goal.estimatedCost,
          risk,
          confidence,
        }),
        status: judgement && !judgement.allowed ? 'BLOCKED' : 'CANDIDATE',
        ...(judgement && !judgement.allowed
          ? { observations: [`blocked by the SafetyPolicy: ${judgement.reason}`] }
          : {}),
      };
      this.goals.set(entry.id, entry);
      created.push(entry);
    };

    // 1. Transitions métier (la précondition est connue) : « Verify PENDING registration can transition to APPROVED ».
    const covered = new Set<string>();
    for (const machine of sources.machines) {
      for (const transition of machine.transitions) {
        if (transition.from === '*') continue;
        const entity = machine.entityType.toLowerCase();
        const workflow = sources.workflows.find(
          (entry) => entry.id === `${(transition.trigger ?? '').toUpperCase()}:${machine.entityType}`,
        );
        if (workflow) covered.add(workflow.id);
        const effects = workflow
          ? sources.sideEffects.filter((effect) => effect.actionIntent === workflow.id)
          : [];
        add({
          id: `STATE_TRANSITION:${transition.id}`,
          category: 'STATE_TRANSITION',
          intent: `Verify ${transition.from} ${entity} can transition to ${transition.to}`,
          target: {
            entityType: machine.entityType,
            ...(transition.triggerLabel ? { actionLabel: transition.triggerLabel } : {}),
            ...(transition.api ? { api: transition.api } : {}),
            ...(workflow?.steps[0]?.kind === 'NAVIGATE'
              ? { route: workflow.steps[0].description.replace(/^open /, '') }
              : {}),
          },
          preconditions: [
            {
              description: `${machine.entityType} is ${transition.from}`,
              ...(transition.preconditions?.[0] ? { condition: transition.preconditions[0] } : {}),
            },
          ],
          expectedOutcomes: [
            { kind: 'STATE_CHANGE', description: `${machine.entityType} becomes ${transition.to}` },
            ...effects
              .filter((effect) => effect.category !== 'STATE_CHANGE')
              .map((effect) => ({
                kind:
                  effect.category === 'ENTITY'
                    ? ('ENTITY' as const)
                    : effect.category === 'UI'
                      ? ('UI' as const)
                      : ('API' as const),
                description: effect.expectedEffect,
              })),
          ],
          evidence: transition.evidence.slice(0, 3),
          estimatedCost: 3,
          coverageGain: 1 + effects.length,
          generatedFrom: `state machine ${machine.entityType}: transition ${transition.from} → ${transition.to} (${transition.status})`,
          sourceId: transition.id,
          reason: `the ${transition.trigger ?? 'transition'} transition is ${transition.status === 'RUNTIME_CONFIRMED' ? 'confirmed' : 'not yet verified at runtime'}`,
          confidence: Math.max(...transition.evidence.map((entry) => entry.confidence), 0.6),
        });
      }
    }
    // 2. Workflows sans transition (CREATE:USER, DELETE:USER).
    for (const workflow of sources.workflows) {
      if (covered.has(workflow.id)) continue;
      const route = workflow.steps
        .find((step) => step.kind === 'NAVIGATE')
        ?.description.replace(/^open /, '');
      add({
        id: `WORKFLOW:${workflow.id}`,
        category: 'WORKFLOW',
        intent: `Verify workflow ${workflow.id} (${workflow.intent})`,
        target: {
          ...(workflow.entityType ? { entityType: workflow.entityType } : {}),
          ...(workflow.triggerLabel ? { actionLabel: workflow.triggerLabel } : {}),
          ...(workflow.api ? { api: workflow.api } : {}),
          ...(route ? { route } : {}),
        },
        preconditions: workflow.preconditions,
        expectedOutcomes: workflow.expectedOutcomes,
        evidence: workflow.evidence.slice(0, 3),
        estimatedCost: workflow.steps.length,
        coverageGain: workflow.expectedOutcomes.length,
        generatedFrom: `workflow ${workflow.id} (${workflow.evidence.length} evidence)`,
        sourceId: workflow.id,
        reason: `${workflow.id} is ${workflow.status}`,
        judgeAs: workflow.intent,
        confidence: Math.max(...workflow.evidence.map((entry) => entry.confidence), 0.5),
      });
    }
    // 3. Invariants (hors contraintes de contrat, couvertes par les objectifs CONTRACT).
    for (const invariant of sources.invariants) {
      if (invariant.scope === 'API') continue;
      const transition = invariant.transitionId
        ? sources.machines
            .flatMap((machine) => machine.transitions)
            .find((entry) => entry.id === invariant.transitionId)
        : undefined;
      // INV:Owner.method:texte — la méthode gardée est l'action qui exercerait l'invariant.
      const method = /^INV:\w+\.(\w+):/.exec(invariant.id)?.[1];
      const label = transition?.triggerLabel ?? method;
      const workflow = method
        ? sources.workflows.find((entry) => entry.id.startsWith(`${method.toUpperCase()}:`))
        : undefined;
      const api = transition?.api ?? workflow?.api;
      add({
        id: `INVARIANT:${invariant.id.replace(/^INV:/, '')}`,
        category: 'INVARIANT',
        intent: `Verify invariant ${invariant.assertion.text}${invariant.entityType ? ` on ${invariant.entityType}` : ''}`,
        target: {
          ...(invariant.entityType ? { entityType: invariant.entityType } : {}),
          ...(label ? { actionLabel: label } : {}),
          ...(api ? { api } : {}),
          ...(invariant.assertion.fields[0] ? { field: invariant.assertion.fields[0] } : {}),
        },
        preconditions: (invariant.conditions ?? []).map((condition) => ({
          description: describeConditions([condition]),
          condition,
        })),
        expectedOutcomes: [{ kind: 'UI', description: `${invariant.assertion.text} still holds` }],
        evidence: invariant.evidence.slice(0, 3),
        estimatedCost: invariant.scope === 'FIELD' || invariant.scope === 'FORM' ? 2 : 4,
        coverageGain: Math.max(1, invariant.assertion.fields.length),
        generatedFrom: `invariant (${invariant.scope}) ${invariant.assertion.text}`,
        sourceId: invariant.id,
        reason: `${invariant.assertion.kind === 'COMPARISON' && invariant.assertion.fields.length > 1 ? 'cross-field constraint' : 'invariant'} ${invariant.status}`,
        confidence: invariant.confidence,
      });
    }
    // 4. Chemins d'erreur prévus par le code (chaîne jusqu'au champ ou au message).
    for (const path of sources.errorPaths) {
      if (path.uiResult === 'UNKNOWN' && !path.businessCode) continue;
      const workflow = sources.workflows.find((entry) => entry.id === path.operation);
      add({
        id: `ERROR_PATH:${path.id}`,
        category: 'ERROR_PATH',
        intent: `Verify ${path.operation} → ${String(path.httpStatus ?? 'error')}${path.businessCode ? ` ${path.businessCode}` : ''} shows ${path.uiTarget ? `an error on ${path.uiTarget}` : 'a message'}`,
        target: {
          ...(workflow?.triggerLabel ? { actionLabel: workflow.triggerLabel } : {}),
          ...(workflow?.api ? { api: workflow.api } : {}),
          ...(path.uiTarget ? { field: path.uiTarget } : {}),
        },
        preconditions: [
          {
            description: `the API answers ${String(path.httpStatus ?? '4xx')}${path.businessCode ? ` ${path.businessCode}` : ''} (data that triggers it is never fabricated)`,
          },
        ],
        expectedOutcomes: [
          ...(path.uiTarget
            ? [{ kind: 'UI' as const, description: `${path.uiTarget} marked in error` }]
            : []),
          ...(path.uiMessage ? [{ kind: 'MESSAGE' as const, description: path.uiMessage }] : []),
        ],
        evidence: path.evidence.slice(0, 2),
        estimatedCost: 6,
        coverageGain: 1 + (path.uiTarget ? 1 : 0),
        generatedFrom: `error path ${path.id} (${path.status})`,
        sourceId: path.id,
        reason: 'the error chain is described by the code but not observed',
        confidence: 0.7,
      });
    }
    // 5. Contrat : chaque écriture décrite par l'OpenAPI, quand l'interface l'appelle.
    for (const operation of sources.contract?.operations ?? []) {
      if (operation.method === 'GET' || Object.keys(operation.requestFields).length === 0) continue;
      const api = `${operation.method} ${operation.path}`;
      const workflow = sources.workflows.find(
        (entry) =>
          entry.api?.split(' ')[0] === operation.method &&
          operation.matcher.test((entry.api.split(' ')[1] ?? '').replace(/\{[^}]+\}/g, 'x')),
      );
      if (!workflow) continue;
      add({
        id: `CONTRACT:${api}`,
        category: 'CONTRACT',
        intent: `Verify ${api} requests match the contract`,
        target: { api, ...(workflow.triggerLabel ? { actionLabel: workflow.triggerLabel } : {}) },
        preconditions: [],
        expectedOutcomes: [{ kind: 'API', description: `${api} body matches the OpenAPI request schema` }],
        evidence: [
          {
            source: 'OPENAPI',
            kind: 'operation',
            value: api,
            confidence: 0.85,
            provenance: { detail: sources.contract?.source ?? 'openapi' },
          },
        ],
        estimatedCost: workflow.steps.length,
        coverageGain: 1,
        generatedFrom: `OpenAPI operation ${api} called by ${workflow.id}`,
        sourceId: api,
        reason: 'runtime request not yet compared with the contract',
        confidence: 0.85,
      });
    }
    // 6. Règles du RuleGraph encore ouvertes (PERMISSION à part).
    for (const rule of sources.rules) {
      if (rule.coverage === 'VERIFIED' || rule.coverage === 'BLOCKED_BY_POLICY') continue;
      const category: TestGoalCategory = rule.category === 'PERMISSION' ? 'PERMISSION' : 'RULE';
      const control = rule.conditions
        .map((condition) =>
          condition.kind === 'COMPARE' || condition.kind === 'FLAG'
            ? (condition.subject.control ?? condition.subject.name)
            : undefined,
        )
        .find(Boolean);
      add({
        id: `${category}:${rule.signature}`,
        category,
        intent: `Verify rule ${rule.name}: IF ${describeConditions(rule.conditions)} THEN ${rule.effects.map(describeEffect).join('; ')}`,
        target: {
          ...(control ? { field: control } : {}),
          ...(rule.component ? { entityType: rule.component } : {}),
        },
        preconditions: rule.conditions.map((condition) => ({
          description: describeConditions([condition]),
          condition,
        })),
        expectedOutcomes: rule.effects
          .slice(0, 4)
          .map((effect) => ({ kind: 'UI' as const, description: describeEffect(effect) })),
        evidence: rule.evidence.slice(0, 2),
        estimatedCost: 1 + rule.conditions.length,
        coverageGain: rule.effects.length,
        generatedFrom: `rule ${rule.id} (${rule.category}, ${rule.status})`,
        sourceId: rule.id,
        reason: `rule coverage ${rule.coverage ?? 'NOT_VERIFIED'}`,
        confidence: rule.confidence,
      });
    }
    return created;
  }

  /** Un effet manquant observé : un objectif SIDE_EFFECT pour le revoir (une fois). */
  sideEffectGoal(effect: ActionSideEffect, workflow: FunctionalWorkflow | undefined): TestGoal | undefined {
    const id = `SIDE_EFFECT:${effect.actionIntent}:${effect.category}:${effect.expectedEffect}`;
    if (this.goals.has(id) || this.goals.size >= this.maxGoals) return undefined;
    const goal: TestGoal = {
      id,
      category: 'SIDE_EFFECT',
      intent: `Verify ${effect.actionIntent} produces ${effect.expectedEffect}`,
      target: {
        ...(workflow?.triggerLabel ? { actionLabel: workflow.triggerLabel } : {}),
        ...(workflow?.api ? { api: workflow.api } : {}),
      },
      preconditions: workflow?.preconditions ?? [],
      expectedOutcomes: [{ kind: 'UI', description: effect.expectedEffect }],
      evidence: effect.evidence.slice(-2),
      priority: goalPriority({
        category: 'SIDE_EFFECT',
        coverageGain: 1,
        estimatedCost: 3,
        risk: 0.5,
        confidence: 0.7,
      }),
      estimatedCost: 3,
      risk: 0.5,
      coverageGain: 1,
      status: 'FAILED',
      generatedFrom: `side effect ${effect.status}: ${effect.expectedEffect}`,
      sourceId: effect.actionIntent,
      reason: `expected effect ${effect.status.toLowerCase()} after ${effect.actionIntent}`,
      observations: effect.observations?.slice(-2) ?? [],
    };
    this.goals.set(id, goal);
    return goal;
  }

  /** Passe un objectif dans un nouvel état (jamais un objectif BLOCKED vers RUNNING). */
  transition(goal: TestGoal, status: TestGoal['status'], detail?: string): boolean {
    if (goal.status === status) return false;
    if (goal.status === 'BLOCKED') return false;
    if (
      (goal.status === 'VERIFIED' || goal.status === 'FAILED') &&
      (status === 'RUNNING' || status === 'PLANNED' || status === 'CANDIDATE')
    )
      return false;
    goal.status = status;
    if (detail) goal.observations = [...(goal.observations ?? []), detail].slice(-6);
    return true;
  }

  /** La planification a estimé un coût : la priorité suit (calculée par goal-scoring seulement). */
  reprice(goal: TestGoal, estimatedCost: number, confidence: number): void {
    goal.estimatedCost = estimatedCost;
    goal.priority = goalPriority({
      category: goal.category,
      coverageGain: goal.coverageGain,
      estimatedCost,
      risk: goal.risk,
      confidence,
    });
  }
}
