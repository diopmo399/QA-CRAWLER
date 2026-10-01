import type { ApiContract } from '../oracles/api-contract.js';
import type { StaticFunctionalFacts } from '../static-analysis/model.js';
import type { RuleCondition, RuleEffect } from '../static-analysis/rules/rule-model.js';
import {
  apiMatches,
  entityName,
  literalsMatch,
  entityOfRoute,
  runtimeEvidence,
  sameLabel,
  staticEvidence,
  verbOf,
  type BusinessState,
  type BusinessStateMachine,
  type BusinessTransition,
  type FunctionalActionObservation,
  type ScreenFacts,
} from './model.js';

/** Les propriétés qui portent un état métier. */
const STATE_FIELDS = ['status', 'state', 'statut', 'etat', 'lifecycle', 'stage'];
const isStateField = (name: string): boolean => STATE_FIELDS.includes(name.toLowerCase());

/** Ce que l'observation d'une action a appris d'une machine à états. */
export interface TransitionVerdict {
  transition: BusinessTransition;
  verdict: 'CONFIRMED' | 'CONTRADICTED' | 'OBSERVED' | 'INCONCLUSIVE';
  detail: string;
  /** Une transition vue au runtime que le code ne décrivait pas. */
  discovered?: boolean;
}

/**
 * BUSINESS STATE MACHINE ANALYZER : le cycle de vie des entités, lu dans le code
 * (énumérations, écritures `{ status: 'APPROVED' }`, gardes `if (status !== 'PENDING')
 * return`, boutons `@if (status === 'PENDING') <button (click)="approve()">`), dans le
 * contrat OpenAPI (énumérations de statut), puis confirmé par l'écran : l'état affiché
 * avant et après le déclencheur.
 *
 * Un état métier n'est PAS un état d'écran : il est observé SUR un écran. Une transition
 * interdite est apprise (bouton absent, refus de l'API) — jamais forcée.
 */
export class BusinessStateMachineAnalyzer {
  private readonly machines = new Map<string, BusinessStateMachine>();

  /** salt : le sel du run, pour reconnaître l'état écrit dans un corps de requête par son empreinte. */
  constructor(private readonly salt?: string) {}

  /** Les machines déduites du code et du contrat (STATIC_DISCOVERED). */
  build(facts: StaticFunctionalFacts | undefined, contract?: ApiContract): BusinessStateMachine[] {
    if (facts) this.fromCode(facts);
    if (contract) this.fromContract(contract);
    for (const machine of this.machines.values()) this.forbidden(machine, facts);
    return this.all();
  }

  all(): BusinessStateMachine[] {
    return [...this.machines.values()].filter((machine) => machine.states.length >= 2);
  }

  machine(entityType: string): BusinessStateMachine | undefined {
    return this.machines.get(entityType);
  }

  transitions(): BusinessTransition[] {
    return this.all().flatMap((machine) => machine.transitions);
  }

  private ensure(entityType: string, stateField: string): BusinessStateMachine {
    let machine = this.machines.get(entityType);
    if (!machine) {
      machine = { entityType, stateField, states: [], transitions: [], forbidden: [], evidence: [] };
      this.machines.set(entityType, machine);
    }
    return machine;
  }

  private addState(
    machine: BusinessStateMachine,
    state: string,
    evidence: BusinessState['evidence'][number],
  ): void {
    const known = machine.states.find((entry) => entry.state === state);
    if (known) {
      if (known.evidence.length < 6) known.evidence.push(evidence);
      known.confidence = Math.min(1, known.confidence + 0.05);
      return;
    }
    machine.states.push({
      entityType: machine.entityType,
      state,
      evidence: [evidence],
      confidence: evidence.confidence,
      observed: false,
    });
  }

  private fromCode(facts: StaticFunctionalFacts): void {
    // 1. Énumérations nommées « …Status » / « …State » : les états possibles d'une entité.
    const enumEntity = new Map<string, string>();
    for (const declared of facts.enums) {
      if (!/(Status|State|Statut|Etat)$/i.test(declared.name)) continue;
      const entity = entityName(declared.name);
      if (!entity) continue;
      const machine = this.ensure(entity, 'status');
      machine.evidence.push(staticEvidence(`enum ${declared.name}`, declared.location, 0.8));
      for (const member of declared.members)
        this.addState(machine, member, staticEvidence(`${declared.name}.${member}`, declared.location, 0.8));
      for (const member of declared.members) enumEntity.set(member, entity);
    }
    // 2. Écritures d'un état : PATCH /api/registrations/{id} { status: 'APPROVED' }.
    for (const write of facts.writes) {
      const field = Object.keys(write.literals).find(isStateField);
      const value = field ? write.literals[field] : undefined;
      if (!field || typeof value !== 'string') continue;
      const entity = enumEntity.get(value) ?? entityOfRoute(write.route) ?? entityName(write.owner);
      const machine = this.ensure(entity, field);
      const api = `${write.httpMethod} ${write.route}`;
      this.addState(machine, value, staticEvidence(`${api} { ${field}: '${value}' }`, write.location, 0.75));
      const trigger = verbOf(write.method) ?? write.method;
      // L'état de départ : la garde de la méthode (status !== 'PENDING' → return), ou la condition d'affichage du bouton.
      const callers = [{ component: write.owner, method: write.method }, ...write.callers];
      const froms = new Map<string, { label?: string; evidence: BusinessState['evidence'] }>();
      for (const caller of callers) {
        for (const guard of facts.guards) {
          if (guard.owner !== caller.component || guard.method !== caller.method || guard.exit === 'NONE')
            continue;
          for (const state of requiredStates(guard.condition, 'guard'))
            froms.set(state, {
              ...froms.get(state),
              evidence: [
                staticEvidence(`guard: if (${guard.text}) ${guard.exit.toLowerCase()}`, guard.location, 0.8),
              ],
            });
        }
        for (const action of facts.actions) {
          if (action.component !== caller.component || action.handler !== caller.method) continue;
          const shownWhen = action.conditions.flatMap((condition) => requiredStates(condition, 'display'));
          for (const state of shownWhen)
            froms.set(state, {
              label: action.label,
              evidence: [
                ...(froms.get(state)?.evidence ?? []),
                staticEvidence(
                  `button "${action.label}" shown when ${field} == ${state}`,
                  action.location,
                  0.8,
                ),
              ],
            });
          // Un bouton toujours affiché : son libellé reste le déclencheur.
          if (shownWhen.length === 0 && froms.size === 0)
            froms.set('*', { label: action.label, evidence: [] });
          else if (shownWhen.length === 0)
            for (const [state, entry] of froms)
              froms.set(state, { ...entry, label: entry.label ?? action.label });
        }
      }
      if (froms.size === 0) froms.set('*', { evidence: [] });
      for (const [from, origin] of froms) {
        if (from !== '*')
          this.addState(machine, from, origin.evidence[0] ?? staticEvidence(`${field} == ${from}`));
        const id = `${entity}:${from}>${value}:${trigger}`;
        if (machine.transitions.some((transition) => transition.id === id)) continue;
        const subject = { kind: 'STATE' as const, name: field };
        const preconditions: RuleCondition[] =
          from === '*' ? [] : [{ kind: 'COMPARE', subject, operator: '==', value: from }];
        const postconditions: RuleEffect[] = [
          { kind: 'SET_VALUE', target: { kind: 'STATE', name: field }, value },
          { kind: 'API_REQUEST_EXPECTED', target: { kind: 'API', name: api }, api },
        ];
        machine.transitions.push({
          id,
          entityType: entity,
          from,
          to: value,
          trigger,
          ...(origin.label ? { triggerLabel: origin.label } : {}),
          api,
          preconditions,
          postconditions,
          evidence: [
            staticEvidence(`${write.apiCall} writes ${field} = ${value}`, write.location, 0.8),
            ...origin.evidence,
          ],
          status: 'STATIC_DISCOVERED',
        });
      }
    }
  }

  /** OpenAPI : une propriété status/state énumérée dans le corps d'une opération. */
  private fromContract(contract: ApiContract): void {
    for (const operation of contract.operations) {
      for (const [name, schema] of Object.entries(operation.requestFields)) {
        if (!isStateField(name) || !schema.enum || schema.enum.length < 2) continue;
        const entity = entityOfRoute(operation.path);
        if (!entity) continue;
        const machine = this.machines.get(entity) ?? this.ensure(entity, name);
        const detail = `OpenAPI ${operation.method} ${operation.path} ${name} ∈ {${schema.enum.join(', ')}}`;
        for (const member of schema.enum)
          this.addState(machine, member, {
            source: 'OPENAPI',
            kind: 'functional',
            value: detail,
            confidence: 0.85,
            provenance: { detail },
          });
      }
    }
  }

  /**
   * Transitions interdites (STATIC_DISCOVERED) : le bouton d'un déclencheur n'est affiché
   * que dans certains états — dans les autres, la transition n'est pas offerte.
   */
  private forbidden(machine: BusinessStateMachine, facts: StaticFunctionalFacts | undefined): void {
    if (!facts) return;
    const byTrigger = new Map<string, { label: string; allowed: Set<string> }>();
    for (const transition of machine.transitions) {
      if (!transition.trigger || !transition.triggerLabel || transition.from === '*') continue;
      const entry = byTrigger.get(transition.trigger) ?? {
        label: transition.triggerLabel,
        allowed: new Set(),
      };
      entry.allowed.add(transition.from);
      byTrigger.set(transition.trigger, entry);
    }
    for (const [trigger, entry] of byTrigger) {
      for (const state of machine.states) {
        if (entry.allowed.has(state.state)) continue;
        if (machine.forbidden.some((known) => known.from === state.state && known.trigger === trigger))
          continue;
        machine.forbidden.push({
          entityType: machine.entityType,
          from: state.state,
          trigger,
          reason: `"${entry.label}" is shown only when ${machine.stateField} is ${[...entry.allowed].join(' or ')}`,
          evidence: [staticEvidence(`button "${entry.label}" condition`)],
          status: 'STATIC_DISCOVERED',
        });
      }
    }
  }

  /** Les états d'une machine affichés à l'écran (badge, statut) — mot entier, casse ignorée. */
  statesShown(machine: BusinessStateMachine, screen: ScreenFacts | undefined): string[] {
    if (!screen) return [];
    const labels = new Set(screen.buttons.map((button) => button.label.toLowerCase()));
    return machine.states
      .map((state) => state.state)
      .filter((state) => {
        // Un bouton « Cancel » n'affiche pas l'état CANCEL : les libellés de boutons ne comptent pas.
        if (labels.has(state.toLowerCase())) return false;
        return new RegExp(`(^|[^\\p{L}\\p{N}_])${escape(state)}([^\\p{L}\\p{N}_]|$)`, 'iu').test(screen.text);
      });
  }

  /** Un écran est montré : les états vus, et les transitions interdites confirmées (bouton absent). */
  observeScreen(screen: ScreenFacts): void {
    for (const machine of this.all()) {
      const shown = this.statesShown(machine, screen);
      for (const state of machine.states) if (shown.includes(state.state)) state.observed = true;
      // Une seule valeur d'état affichée : un écran de détail ; les déclencheurs absents sont interdits ici.
      if (shown.length !== 1) continue;
      const current = shown[0];
      for (const forbidden of machine.forbidden) {
        if (forbidden.from !== current || forbidden.status === 'RUNTIME_CONFIRMED') continue;
        const label = machine.transitions.find(
          (transition) => transition.trigger === forbidden.trigger,
        )?.triggerLabel;
        const offered = label
          ? screen.buttons.some((button) => button.enabled && sameLabel(button.label, label))
          : false;
        if (label && !offered && screen.buttons.length > 0) {
          forbidden.status = 'RUNTIME_CONFIRMED';
          forbidden.evidence.push(
            runtimeEvidence(`${current}: "${label}" not offered on ${screen.route ?? screen.url}`),
          );
        }
      }
    }
  }

  /**
   * Après une action : quelle transition voulait-elle réaliser (libellé du bouton, verbe,
   * appel d'API) et l'écran le montre-t-il ? Jugé seulement sur un écran qui montre UN
   * état de l'entité avant et après (un écran de détail) ; sinon INCONCLUSIVE.
   */
  observeAction(observation: FunctionalActionObservation): TransitionVerdict[] {
    const verdicts: TransitionVerdict[] = [];
    for (const machine of this.all()) {
      const before = this.statesShown(machine, observation.before);
      const after = this.statesShown(machine, observation.after);
      const candidates = triggeredTransitions(machine.transitions, observation, this.salt);
      const single = before.length === 1 && after.length === 1;
      const from = single ? before[0] : undefined;
      const to = single ? after[0] : undefined;
      const matching = candidates.filter((transition) => transition.from === '*' || transition.from === from);
      for (const transition of matching.length > 0 ? matching : candidates) {
        const write = observation.exchanges.find(
          (exchange) =>
            transition.api !== undefined && apiMatches(transition.api, exchange.method, exchange.path),
        );
        const accepted = write?.status !== undefined && write.status < 400;
        let verdict: TransitionVerdict['verdict'];
        let detail: string;
        if (!single || (transition.from !== '*' && transition.from !== from)) {
          verdict = 'INCONCLUSIVE';
          detail = `${transition.id}: state shown before ${before.join('/') || 'none'}, after ${after.join('/') || 'none'}`;
        } else if (to === transition.to) {
          verdict = 'CONFIRMED';
          detail = `${from ?? '?'} → ${transition.to} after "${observation.label}"${write ? ` (${write.method} ${write.path} → ${String(write.status ?? '?')})` : ''}`;
        } else if (write && !accepted) {
          // Refusé par l'API : la transition n'a pas eu lieu, ce n'est pas une contradiction de la machine.
          verdict = 'INCONCLUSIVE';
          detail = `${transition.id}: ${write.method} ${write.path} → ${String(write.status)}`;
        } else {
          verdict = 'CONTRADICTED';
          detail = `"${observation.label}"${write ? ` (${write.method} ${write.path} → ${String(write.status ?? '?')})` : ''}: expected ${transition.to}, screen still shows ${to ?? 'nothing'}`;
        }
        this.record(transition, verdict, detail);
        verdicts.push({ transition, verdict, detail });
      }
      // Un changement d'état vu sans transition connue : découvert au runtime.
      if (single && from && to && from !== to && candidates.every((transition) => transition.to !== to)) {
        const trigger = verbOf(observation.label) ?? observation.label.toLowerCase();
        const id = `${machine.entityType}:${from}>${to}:${trigger}`;
        let transition = machine.transitions.find((entry) => entry.id === id);
        if (!transition) {
          transition = {
            id,
            entityType: machine.entityType,
            from,
            to,
            trigger,
            triggerLabel: observation.label,
            evidence: [],
            status: 'RUNTIME_OBSERVED',
          };
          machine.transitions.push(transition);
        }
        const detail = `${from} → ${to} after "${observation.label}" (not described by the code)`;
        this.record(transition, 'OBSERVED', detail);
        verdicts.push({ transition, verdict: 'OBSERVED', detail, discovered: true });
      }
    }
    return verdicts;
  }

  private record(
    transition: BusinessTransition,
    verdict: TransitionVerdict['verdict'],
    detail: string,
  ): void {
    transition.observations = [...(transition.observations ?? []), `${verdict}: ${detail}`].slice(-6);
    if (verdict === 'CONFIRMED') {
      transition.status = 'RUNTIME_CONFIRMED';
      transition.evidence.push(runtimeEvidence(detail));
    } else if (verdict === 'CONTRADICTED' && transition.status !== 'RUNTIME_CONFIRMED') {
      transition.status = 'RUNTIME_CONTRADICTED';
      transition.evidence.push(runtimeEvidence(detail, 0.7));
    } else if (verdict === 'OBSERVED' && transition.status === 'STATIC_DISCOVERED') {
      transition.status = 'RUNTIME_OBSERVED';
    }
  }

  /**
   * Un état appris au runtime (code lu dans une réponse) ou d'un run précédent : la
   * machine de l'entité est créée au besoin.
   */
  learnState(
    entityType: string,
    stateField: string,
    state: string,
    evidence: BusinessState['evidence'][number],
  ): void {
    const machine = this.machines.get(entityType) ?? this.ensure(entityType, stateField);
    this.addState(machine, state, evidence);
  }

  /** Une transition apprise : RUNTIME_OBSERVED pour ce run, historique (non prouvée) sinon. */
  learnTransition(input: {
    entityType: string;
    stateField: string;
    from: string;
    to: string;
    trigger: string;
    triggerLabel?: string;
    api?: string;
    evidence: BusinessState['evidence'][number];
    historical: boolean;
  }): BusinessTransition | undefined {
    const machine = this.machines.get(input.entityType) ?? this.ensure(input.entityType, input.stateField);
    this.addState(machine, input.from, input.evidence);
    this.addState(machine, input.to, input.evidence);
    const id = `${input.entityType}:${input.from}>${input.to}:${input.trigger}`;
    const known = machine.transitions.find((entry) => entry.id === id);
    if (known) {
      if (!input.historical && known.status === 'STATIC_DISCOVERED') known.status = 'RUNTIME_OBSERVED';
      if (input.historical) known.historical = true;
      return known;
    }
    const subject = { kind: 'STATE' as const, name: input.stateField };
    const transition: BusinessTransition = {
      id,
      entityType: input.entityType,
      from: input.from,
      to: input.to,
      trigger: input.trigger,
      ...(input.triggerLabel ? { triggerLabel: input.triggerLabel } : {}),
      ...(input.api ? { api: input.api } : {}),
      preconditions: [{ kind: 'COMPARE', subject, operator: '==', value: input.from }],
      postconditions: [
        { kind: 'SET_VALUE', target: { kind: 'STATE', name: input.stateField }, value: input.to },
        ...(input.api
          ? [
              {
                kind: 'API_REQUEST_EXPECTED' as const,
                target: { kind: 'API' as const, name: input.api },
                api: input.api,
              },
            ]
          : []),
      ],
      evidence: [input.evidence],
      status: input.historical ? 'STATIC_DISCOVERED' : 'RUNTIME_OBSERVED',
      ...(input.historical ? { historical: true } : {}),
    };
    machine.transitions.push(transition);
    return transition;
  }

  /** Ce qu'un run précédent avait vu (jamais une preuve : HISTORICAL seulement). */
  recallHistory(id: string, status: string): void {
    const transition = this.transitions().find((entry) => entry.id === id);
    if (!transition) return;
    transition.historical = status === 'RUNTIME_CONFIRMED';
  }
}

/**
 * Les transitions qu'une action déclenche : d'abord par le libellé du bouton (Approve) ;
 * sinon par l'appel d'API vu, dont le corps doit porter l'état d'arrivée (empreinte) —
 * plusieurs transitions partagent souvent la même route (PATCH /registrations/{id}).
 */
export function triggeredTransitions(
  transitions: readonly BusinessTransition[],
  observation: FunctionalActionObservation,
  salt?: string,
): BusinessTransition[] {
  const byLabel = transitions.filter(
    (transition) =>
      transition.triggerLabel !== undefined && sameLabel(transition.triggerLabel, observation.label),
  );
  if (byLabel.length > 0) return byLabel;
  return transitions.filter((transition) => {
    if (transition.api !== undefined) {
      const api = transition.api;
      const field =
        transition.postconditions?.find((effect) => effect.kind === 'SET_VALUE')?.target.name ?? 'status';
      if (
        observation.exchanges.some(
          (exchange) =>
            apiMatches(api, exchange.method, exchange.path) &&
            exchange.requestFields?.[field]?.digest !== undefined &&
            literalsMatch({ [field]: transition.to }, exchange, salt),
        )
      )
        return true;
    }
    return (
      transition.trigger !== undefined &&
      !transition.triggerLabel &&
      verbOf(observation.label) === transition.trigger
    );
  });
}

/**
 * Les états qu'une condition exige : une garde `status !== 'PENDING'` qui sort exige
 * PENDING ; un affichage `status === 'PENDING'` aussi.
 */
function requiredStates(condition: RuleCondition | undefined, mode: 'guard' | 'display'): string[] {
  if (!condition) return [];
  if (
    condition.kind === 'COMPARE' &&
    isStateField(condition.subject.name) &&
    typeof condition.value === 'string'
  ) {
    const exits = mode === 'guard' ? '!=' : '==';
    return condition.operator === exits ? [condition.value] : [];
  }
  // Garde « status !== A && status !== B » → A ou B ; affichage « status === A || status === B » → A ou B.
  if ((mode === 'guard' && condition.kind === 'AND') || (mode === 'display' && condition.kind === 'OR'))
    return condition.items.flatMap((item) => requiredStates(item, mode));
  if (mode === 'display' && condition.kind === 'AND')
    return condition.items.flatMap((item) => requiredStates(item, mode));
  return [];
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
