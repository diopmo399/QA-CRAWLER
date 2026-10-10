import {
  apiMatches,
  crudVerb,
  entityName,
  runtimeEvidence,
  verbOf,
  type FunctionalActionObservation,
  type FunctionalExchange,
  type FunctionalWorkflow,
} from './model.js';
import { isTechnicalOperation } from '../recording/business/entity-classifier.js';
import type { SemanticEvidence } from '../static-analysis/model.js';

/** Ce qu'un run a appris du réseau, gardé pour les runs suivants (jamais une preuve). */
export interface LearnedKnowledge {
  workflows: {
    id: string;
    api: string;
    entityType: string;
    triggerLabel?: string;
    requestLiterals?: Record<string, string>;
    /** HUMAN_RECORDED : montré par un humain (qa-crawler record) ; sinon vu par un run. */
    provenance?: 'RUNTIME_OBSERVED' | 'HUMAN_RECORDED';
    recordingSessionId?: string;
  }[];
  states: { entityType: string; stateField: string; state: string }[];
  transitions: {
    entityType: string;
    stateField: string;
    from: string;
    to: string;
    trigger: string;
    triggerLabel?: string;
    api?: string;
  }[];
}

/** Ce que l'apprentissage d'une action a produit, pour le coordinateur. */
export interface LearnedFromAction {
  workflows: FunctionalWorkflow[];
  states: LearnedKnowledge['states'];
  transitions: LearnedKnowledge['transitions'];
}

const PARAM =
  /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{12,}|(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{16,})$/i;
const TECHNICAL = /^(api|v\d+|rest|public|internal|private|bff|gateway|svc|services?)$/i;

/** /api/dossiers/12/approve → /api/dossiers/{param}/approve : identifiants remplacés, jamais conservés. */
export function apiTemplate(path: string): string {
  const segments = (path.split('?')[0] ?? path).split('/').filter(Boolean);
  return `/${segments.map((segment) => (PARAM.test(segment) ? '{param}' : segment)).join('/')}`;
}

/**
 * L'intention d'une écriture vue au runtime : le verbe (libellé du bouton, dernier
 * segment d'action, ou CRUD selon la méthode) et l'entité (dernier segment nommé).
 * POST /api/dossiers/{param}/documents « Ajouter » → CREATE:DOCUMENT ;
 * POST /api/dossiers/{param}/approve → APPROVE:DOSSIER.
 */
export function intentOf(
  method: string,
  template: string,
  label: string,
): { verb: string; entity: string } | undefined {
  // Authentification, OIDC / OAuth, JWKS, découverte OpenID, santé, télémétrie, configuration,
  // ressources statiques : des opérations techniques, jamais un intent métier (pas de CREATE:TOKEN).
  if (isTechnicalOperation(template)) return undefined;
  const named = template
    .split('/')
    .filter((segment) => segment && segment !== '{param}' && !TECHNICAL.test(segment));
  const last = named.at(-1);
  if (!last) return undefined;
  const segmentVerb = verbOf(last.replace(/[-_]/g, ' '));
  const entitySegment = segmentVerb && named.length > 1 ? named.at(-2) : last;
  if (!entitySegment) return undefined;
  const verb = verbOf(label) ?? segmentVerb ?? crudVerb(method).toLowerCase();
  return { verb: verb.toUpperCase(), entity: entityName(entitySegment) };
}

/**
 * RUNTIME LEARNING — quand le code ne dit pas comment l'application écrit (client
 * généré, service générique, bundle illisible), le réseau le dit : chaque écriture
 * acceptée (2xx) que rien ne décrit devient un workflow APPRIS ; chaque code d'état
 * (status: 'PENDING') lu dans une réponse devient un état métier ; l'état d'une
 * ressource avant et après une écriture devient une transition.
 *
 * Ce qui est appris est RUNTIME_OBSERVED pour ce run, et gardé comme HISTORIQUE pour
 * les suivants : il guide (objectifs, planification), il ne prouve rien tant que le run
 * courant ne l'a pas revu. Aucun identifiant de ressource ni aucune valeur saisie.
 */
export class RuntimeLearner {
  /** Dernier état connu d'une ressource (chemin concret → code), en mémoire seulement. */
  private readonly resourceStates = new Map<string, { field: string; code: string }>();
  private readonly learned: LearnedKnowledge = { workflows: [], states: [], transitions: [] };

  constructor(private readonly limits = { workflows: 100, states: 200, transitions: 200 }) {}

  knowledge(): LearnedKnowledge {
    return this.learned;
  }

  /**
   * Apprend d'une action : known(method, path) dit si une écriture est déjà décrite (code,
   * historique). Les états avant l'action servent d'état de départ des transitions.
   */
  learn(
    observation: FunctionalActionObservation,
    known: (exchange: FunctionalExchange) => boolean,
  ): LearnedFromAction {
    const result: LearnedFromAction = { workflows: [], states: [], transitions: [] };
    const before = new Map(this.resourceStates);
    for (const exchange of observation.exchanges) {
      const template = apiTemplate(exchange.path);
      const write = exchange.method !== 'GET' && exchange.method !== 'HEAD' && exchange.method !== 'OPTIONS';
      const accepted = exchange.status !== undefined && exchange.status >= 200 && exchange.status < 300;
      const intent = intentOf(exchange.method, template, write ? observation.label : '');
      // États lus dans les réponses (lecture comme écriture).
      for (const state of [exchange.responseState, accepted ? exchange.requestState : undefined]) {
        if (!state || !intent) continue;
        this.resourceStates.set(resourceKey(exchange.path), state);
        if (this.addState({ entityType: intent.entity, stateField: state.field, state: state.code }))
          result.states.push({ entityType: intent.entity, stateField: state.field, state: state.code });
      }
      if (!write || !accepted || !intent) continue;
      const api = `${exchange.method} ${template}`;
      // Une écriture que rien ne décrit encore : un workflow appris.
      if (!known(exchange)) {
        const literals = exchange.requestState
          ? { [exchange.requestState.field]: exchange.requestState.code }
          : undefined;
        const id = `${intent.verb}:${intent.entity}`;
        const exists = this.learned.workflows.some((entry) => entry.id === id && entry.api === api);
        if (!exists && this.learned.workflows.length < this.limits.workflows) {
          const label = observation.type === 'click' && observation.label ? observation.label : undefined;
          this.learned.workflows.push({
            id,
            api,
            entityType: intent.entity,
            ...(label ? { triggerLabel: label } : {}),
            ...(literals ? { requestLiterals: literals } : {}),
          });
          result.workflows.push(
            learnedWorkflow(
              {
                id,
                api,
                entityType: intent.entity,
                ...(label ? { triggerLabel: label } : {}),
                ...(literals ? { requestLiterals: literals } : {}),
              },
              runtimeEvidence(
                `learned from ${api} → ${String(exchange.status)} after "${observation.label}"`,
                0.7,
              ),
            ),
          );
        }
      }
      // L'état de la ressource avant et après l'écriture : une transition. La réponse fait foi
      // (une écriture acceptée qui ne change rien n'apprend rien).
      const after = exchange.responseState ?? exchange.requestState;
      const previous =
        before.get(resourceKey(exchange.path)) ?? before.get(resourceKey(parentPath(exchange.path)));
      if (after && previous && previous.code !== after.code && previous.field === after.field) {
        const transition = {
          entityType: intent.entity,
          stateField: after.field,
          from: previous.code,
          to: after.code,
          trigger: intent.verb.toLowerCase(),
          ...(observation.type === 'click' && observation.label ? { triggerLabel: observation.label } : {}),
          api,
        };
        const id = `${transition.entityType}:${transition.from}>${transition.to}:${transition.trigger}`;
        if (
          !this.learned.transitions.some(
            (entry) => `${entry.entityType}:${entry.from}>${entry.to}:${entry.trigger}` === id,
          ) &&
          this.learned.transitions.length < this.limits.transitions
        ) {
          this.learned.transitions.push(transition);
          result.transitions.push(transition);
        }
      }
    }
    return result;
  }

  private addState(state: LearnedKnowledge['states'][number]): boolean {
    if (this.learned.states.length >= this.limits.states) return false;
    if (
      this.learned.states.some(
        (entry) => entry.entityType === state.entityType && entry.state === state.state,
      )
    )
      return false;
    this.learned.states.push(state);
    return true;
  }
}

/** Un workflow à partir de ce qui a été appris (ce run ou un précédent). */
export function learnedWorkflow(
  learned: LearnedKnowledge['workflows'][number],
  evidence: SemanticEvidence,
  origin: 'RUNTIME_LEARNED' | 'HISTORICAL' = 'RUNTIME_LEARNED',
): FunctionalWorkflow {
  const verb = learned.id.split(':')[0] ?? 'UPDATE';
  const entity = learned.entityType;
  return {
    id: learned.id,
    intent: `${verb.toLowerCase()} ${entity.toLowerCase()}`,
    entityType: entity,
    preconditions: [],
    steps: [
      ...(learned.triggerLabel
        ? [{ kind: 'CLICK' as const, description: `click "${learned.triggerLabel}"` }]
        : []),
      { kind: 'API', description: learned.api },
    ],
    expectedOutcomes: [
      { kind: 'API', description: `${learned.api} succeeds` },
      ...(learned.requestLiterals
        ? Object.entries(learned.requestLiterals).map(([, value]) => ({
            kind: 'STATE_CHANGE' as const,
            description: `${entity} becomes ${value}`,
          }))
        : []),
    ],
    evidence: [evidence],
    status: 'DISCOVERED',
    origin,
    api: learned.api,
    ...(learned.triggerLabel ? { triggerLabel: learned.triggerLabel } : {}),
    ...(learned.requestLiterals ? { requestLiterals: learned.requestLiterals } : {}),
  };
}

/** Une écriture déjà décrite par un workflow (route et littéraux). */
export function describedBy(workflows: readonly FunctionalWorkflow[], exchange: FunctionalExchange): boolean {
  return workflows.some((workflow) => {
    if (workflow.api === undefined || !apiMatches(workflow.api, exchange.method, exchange.path)) return false;
    // Même route, autre état écrit (approve / reject) : une autre intention.
    const state = exchange.requestState;
    const literal = state ? workflow.requestLiterals?.[state.field] : undefined;
    return !state || literal === undefined || literal === state.code;
  });
}

function resourceKey(path: string): string {
  return (path.split('?')[0] ?? path).replace(/\/+$/, '');
}

/** /api/dossiers/12/approve → /api/dossiers/12 : la ressource d'une action sur elle. */
function parentPath(path: string): string {
  return resourceKey(path).replace(/\/[^/]+$/, '');
}
