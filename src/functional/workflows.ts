import type { StaticApplicationGraph } from '../static-analysis/model.js';
import {
  apiMatches,
  crudVerb,
  entityName,
  entityOfRoute,
  runtimeEvidence,
  sameLabel,
  staticEvidence,
  verbOf,
  type BusinessTransition,
  literalsMatch,
  type FunctionalActionObservation,
  type FunctionalExchange,
  type FunctionalWorkflow,
} from './model.js';

/** Un scénario déclaré (Gherkin, flow YAML) : son nom suffit à reconnaître l'intention. */
export interface DeclaredScenario {
  name: string;
  source: 'GHERKIN' | 'FLOW_YAML';
}

/**
 * WORKFLOW INTENT ANALYZER : les intentions fonctionnelles de l'application
 * (CREATE:USER, APPROVE:REGISTRATION), reconstruites à partir de ce qui existe déjà —
 * écritures HTTP du code et qui les appelle, routes et composants, formulaires,
 * boutons, transitions métier, scénarios déclarés (Gherkin, flow YAML).
 *
 * La signature (VERBE:ENTITÉ) est stable d'un run à l'autre : c'est la clé de
 * l'historique et des objectifs de test.
 */
export class WorkflowIntentAnalyzer {
  private readonly workflows = new Map<string, FunctionalWorkflow>();

  constructor(private readonly salt?: string) {}

  build(
    graph: StaticApplicationGraph | undefined,
    transitions: readonly BusinessTransition[],
    declared: readonly DeclaredScenario[] = [],
  ): FunctionalWorkflow[] {
    const facts = graph?.functionalFacts;
    for (const write of facts?.writes ?? []) {
      const transition = transitions.find(
        (entry) =>
          entry.api === `${write.httpMethod} ${write.route}` &&
          entry.trigger === (verbOf(write.method) ?? write.method),
      );
      const entity = transition?.entityType ?? entityOfRoute(write.route) ?? entityName(write.owner);
      const verb = (transition?.trigger ?? verbOf(write.method) ?? crudVerb(write.httpMethod)).toUpperCase();
      const id = `${verb}:${entity}`;
      const api = `${write.httpMethod} ${write.route}`;
      const caller = write.callers[0];
      const button = caller
        ? facts?.actions.find(
            (action) => action.component === caller.component && action.handler === caller.method,
          )
        : undefined;
      const route = caller
        ? graph?.routes.find((entry) => entry.component === caller.component)?.path
        : undefined;
      const form = caller ? graph?.forms.find((entry) => entry.component === caller.component) : undefined;
      const workflow = this.workflows.get(id) ?? {
        id,
        intent: `${verb.toLowerCase()} ${entity.toLowerCase()}`,
        entityType: entity,
        preconditions: [],
        steps: [],
        expectedOutcomes: [],
        evidence: [],
        status: 'DISCOVERED' as const,
        origin: 'STATIC' as const,
        api,
      };
      if (workflow.steps.length === 0) {
        if (route)
          workflow.steps.push({ kind: 'NAVIGATE', description: `open /${route.replace(/^\//, '')}` });
        if (form)
          workflow.steps.push({ kind: 'FILL', description: `fill the ${caller?.component ?? ''} form` });
        if (button) workflow.steps.push({ kind: 'CLICK', description: `click "${button.label}"` });
        workflow.steps.push({ kind: 'API', description: api });
        workflow.expectedOutcomes.push({ kind: 'API', description: `${api} succeeds` });
        if (transition) {
          workflow.preconditions.push(
            ...(transition.from !== '*'
              ? [
                  {
                    description: `${entity} is ${transition.from}`,
                    ...(transition.preconditions?.[0] ? { condition: transition.preconditions[0] } : {}),
                  },
                ]
              : []),
          );
          workflow.expectedOutcomes.push({
            kind: 'STATE_CHANGE',
            description: `${entity} becomes ${transition.to}`,
          });
        } else if (verb === 'CREATE')
          workflow.expectedOutcomes.push({
            kind: 'ENTITY',
            description: `a ${entity.toLowerCase()} is created`,
          });
        else if (verb === 'DELETE')
          workflow.expectedOutcomes.push({
            kind: 'ENTITY',
            description: `the ${entity.toLowerCase()} is removed`,
          });
      }
      if (button) workflow.triggerLabel ??= button.label;
      if (Object.keys(write.literals).length > 0) workflow.requestLiterals ??= write.literals;
      if (workflow.evidence.length < 6)
        workflow.evidence.push(
          staticEvidence(
            `${write.apiCall} (${api})${caller ? ` called by ${caller.component}.${caller.method}` : ''}`,
            write.location,
            caller ? 0.8 : 0.6,
          ),
        );
      this.workflows.set(id, workflow);
    }
    // Scénarios déclarés : « Créer un utilisateur » appuie CREATE:USER (preuve GHERKIN / FLOW_YAML).
    for (const scenario of declared) {
      const words = scenario.name.split(/\s+/);
      const verb = (verbOf(scenario.name) ?? crudOfWords(words))?.toUpperCase();
      if (!verb) continue;
      for (const workflow of this.workflows.values()) {
        if (!workflow.id.startsWith(`${verb}:`) || !workflow.entityType) continue;
        const entity = workflow.entityType.toLowerCase();
        if (!words.some((word) => entityName(word).toLowerCase() === entity)) continue;
        workflow.evidence.push({
          source: 'STATIC_CODE',
          kind: 'declared-scenario',
          value: `${scenario.source}: ${scenario.name}`,
          confidence: 0.9,
          provenance: { detail: scenario.source },
        });
      }
    }
    return this.all();
  }

  /** Un workflow appris au runtime ou gardé d'un run précédent : ajouté s'il n'existe pas. */
  learn(workflow: FunctionalWorkflow): boolean {
    if (this.workflows.has(workflow.id)) return false;
    this.workflows.set(workflow.id, workflow);
    return true;
  }

  all(): FunctionalWorkflow[] {
    return [...this.workflows.values()];
  }

  get(id: string): FunctionalWorkflow | undefined {
    return this.workflows.get(id);
  }

  /**
   * Les workflows qu'une action réalise : le libellé de son bouton d'abord ; sinon l'appel
   * d'API vu, dont le corps porte les littéraux du code (empreintes) — APPROVE et REJECT
   * partagent la même route.
   */
  matching(observation: FunctionalActionObservation): FunctionalWorkflow[] {
    const byLabel = this.all().filter(
      (workflow) =>
        workflow.triggerLabel !== undefined && sameLabel(workflow.triggerLabel, observation.label),
    );
    if (byLabel.length > 0) return byLabel;
    return this.all().filter((workflow) => this.realizedBy(workflow, observation) !== undefined);
  }

  /** L'appel de la fenêtre qui réalise ce workflow (route et littéraux du corps). */
  realizedBy(
    workflow: FunctionalWorkflow,
    observation: FunctionalActionObservation,
  ): FunctionalExchange | undefined {
    const api = workflow.api;
    if (!api) return undefined;
    return observation.exchanges.find(
      (exchange) =>
        apiMatches(api, exchange.method, exchange.path) &&
        literalsMatch(workflow.requestLiterals, exchange, this.salt),
    );
  }

  /**
   * Après une action : un appel accepté (2xx) avance le workflow ; un état attendu vu à
   * l'écran le vérifie ; un 5xx l'échoue ; un refus métier (4xx) le laisse INCONCLUSIVE.
   */
  observe(
    observation: FunctionalActionObservation,
    stateConfirmed: (workflow: FunctionalWorkflow) => boolean | undefined,
  ): FunctionalWorkflow[] {
    const touched = this.matching(observation);
    for (const workflow of touched) {
      const exchange = observation.exchanges.find((entry) =>
        apiMatches(workflow.api ?? '', entry.method, entry.path),
      );
      let detail: string;
      if (!exchange || exchange.status === undefined) {
        detail = `"${observation.label}": no ${workflow.api ?? 'API'} call seen`;
        if (workflow.status === 'DISCOVERED') workflow.status = 'INCONCLUSIVE';
      } else if (exchange.status >= 500) {
        detail = `${exchange.method} ${exchange.path} → ${String(exchange.status)}`;
        workflow.status = 'FAILED';
      } else if (exchange.status >= 400) {
        detail = `${exchange.method} ${exchange.path} → ${String(exchange.status)} (refused)`;
        if (workflow.status !== 'VERIFIED') workflow.status = 'INCONCLUSIVE';
      } else {
        const state = stateConfirmed(workflow);
        detail = `${exchange.method} ${exchange.path} → ${String(exchange.status)}${state === true ? ', expected state shown' : state === false ? ', expected state NOT shown' : ''}`;
        workflow.status =
          state === false
            ? 'FAILED'
            : state === true || !workflow.expectedOutcomes.some((outcome) => outcome.kind === 'STATE_CHANGE')
              ? 'VERIFIED'
              : 'PARTIALLY_VERIFIED';
        workflow.evidence.push(runtimeEvidence(detail));
      }
      workflow.observations = [...(workflow.observations ?? []), detail].slice(-5);
    }
    return touched;
  }
}

function crudOfWords(words: string[]): string | undefined {
  const lower = words.map((word) => word.toLowerCase());
  if (
    lower.some((word) =>
      ['create', 'add', 'new', 'créer', 'creer', 'ajouter', 'nouveau', 'nouvel', 'nouvelle'].includes(word),
    )
  )
    return 'create';
  if (lower.some((word) => ['delete', 'remove', 'supprimer', 'retirer'].includes(word))) return 'delete';
  if (lower.some((word) => ['update', 'edit', 'modify', 'modifier', 'éditer', 'editer'].includes(word)))
    return 'update';
  return undefined;
}
