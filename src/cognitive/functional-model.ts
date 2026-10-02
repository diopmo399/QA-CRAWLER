import type { FlowConfig, FlowStep } from '../config/flow-schema.js';
import type { FunctionalWorkflow } from '../functional/model.js';
import type { EvidenceReference } from './evidence.js';

/**
 * FUNCTIONAL MODEL : l'application vue par ce qu'elle PERMET de faire, pas par ses pages.
 *
 *   capacités métier (CREATE_REQUEST, SELECT_CURRENCY, ENTER_COMPANY_INFORMATION…)
 *   phases du parcours (COMPANY_INFORMATION : les champs qu'elle regroupe, ce qui l'ouvre)
 *   choix (Currency : EUR | CAD), entités, transitions entre phases, action d'envoi.
 *
 * Construit à partir de ce qui existe déjà : un parcours démontré par un humain (flow
 * enregistré = preuve d'intention), les workflows de l'intelligence fonctionnelle (code,
 * réseau). Le modèle ne dit pas ce qui est vrai à l'écran : c'est le rôle du BusinessStateEngine.
 */
export interface BusinessCapability {
  id: string;
  label: string;
  kind: 'MISSION' | 'PHASE' | 'CHOICE' | 'SUBMISSION' | 'WORKFLOW';
  evidence: EvidenceReference[];
}

export interface WorkflowPhase {
  id: string;
  label: string;
  /** Les champs que la phase regroupe (libellés), dans l'ordre du parcours. */
  fields: string[];
  /** Ce qui l'ouvre dans le parcours démontré (bouton, onglet…), s'il y en a. */
  opener?: { role?: string; label: string };
  order: number;
}

export interface ChoiceGroup {
  /** « Currency » (libellé du groupe) ou le libellé de l'option quand le groupe est inconnu. */
  name: string;
  options: string[];
}

export interface PhaseTransition {
  from: string;
  to: string;
  via: string;
}

export interface FunctionalModel {
  mission?: BusinessCapability;
  capabilities: BusinessCapability[];
  phases: WorkflowPhase[];
  choices: ChoiceGroup[];
  entities: string[];
  transitions: PhaseTransition[];
  /** L'action qui envoie le parcours (allow: MUTATION, ou un bouton d'envoi). */
  submit?: { label: string; role?: string };
}

/** « Company information » → COMPANY_INFORMATION. */
export function capabilityId(text: string): string {
  return (
    text
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9]+/g, ' ')
      .trim()
      .split(' ')
      .filter((word) => word.length > 0 && !/^(the|of|a|an|le|la|les|de|des|du|l|d)$/i.test(word))
      .slice(0, 5)
      .join('_')
      .toUpperCase() || 'UNNAMED'
  );
}

const label = (step: Extract<FlowStep, { target: unknown }>): string =>
  step.target.name ?? step.target.value ?? '';
const SUBMIT_WORDS =
  /\b(submit|send|save|confirm|create|register|envoyer|soumettre|enregistrer|confirmer|cr[ée]er|valider)\b/i;

export class FunctionalModelBuilder {
  private readonly model: FunctionalModel = {
    capabilities: [],
    phases: [],
    choices: [],
    entities: [],
    transitions: [],
  };

  /**
   * Un parcours démontré : une action d'ouverture suivie de champs forme une PHASE ; une case
   * ou une option forme un CHOIX ; l'action autorisée à écrire (ou un bouton d'envoi) est l'ENVOI.
   */
  addFlow(flow: Pick<FlowConfig, 'name' | 'steps'>, evidence: EvidenceReference[] = []): this {
    const mission: BusinessCapability = {
      id: capabilityId(flow.name),
      label: flow.name,
      kind: 'MISSION',
      evidence,
    };
    this.model.mission ??= mission;
    this.capability(mission);
    let phase: WorkflowPhase | undefined;
    let opener: { role?: string; label: string } | undefined;
    const closePhase = (): void => {
      if (phase && phase.fields.length > 0) {
        const previous = this.model.phases.at(-1);
        if (previous && previous.id !== phase.id && phase.opener)
          this.model.transitions.push({ from: previous.id, to: phase.id, via: phase.opener.label });
        if (!this.model.phases.some((known) => known.id === phase?.id)) this.model.phases.push(phase);
        this.capability({ id: `ENTER_${phase.id}`, label: phase.label, kind: 'PHASE', evidence });
      }
      phase = undefined;
    };
    for (const step of flow.steps) {
      if (!('target' in step)) continue;
      const text = label(step);
      if (!text) continue;
      if (step.kind === 'fill' || step.kind === 'select') {
        if (!phase) {
          const name = opener?.label ?? `${flow.name} form`;
          phase = {
            id: capabilityId(name),
            label: name,
            fields: [],
            ...(opener ? { opener } : {}),
            order: this.model.phases.length,
          };
        }
        if (!phase.fields.includes(text)) phase.fields.push(text);
        continue;
      }
      if (step.kind === 'check' || step.kind === 'uncheck') {
        closePhase();
        this.capability({ id: `SELECT_${capabilityId(text)}`, label: text, kind: 'CHOICE', evidence });
        continue;
      }
      // Un clic : ouvre une phase, ou envoie le parcours.
      const writes = step.allow.some((allowed) => allowed === 'MUTATION' || allowed === 'DANGEROUS');
      if (writes || (SUBMIT_WORDS.test(text) && phase)) {
        closePhase();
        this.model.submit = { label: text, ...(step.target.role ? { role: step.target.role } : {}) };
        this.capability({ id: `SUBMIT_${mission.id}`, label: text, kind: 'SUBMISSION', evidence });
        continue;
      }
      closePhase();
      opener = { ...(step.target.role ? { role: step.target.role } : {}), label: text };
    }
    closePhase();
    return this;
  }

  /** Les workflows connus de l'intelligence fonctionnelle (CREATE:USER → CREATE_USER). */
  addWorkflows(workflows: readonly FunctionalWorkflow[]): this {
    for (const workflow of workflows) {
      this.capability({
        id: workflow.id.replace(/[:]/g, '_'),
        label: workflow.intent,
        kind: 'WORKFLOW',
        evidence: [],
      });
      if (workflow.entityType && !this.model.entities.includes(workflow.entityType))
        this.model.entities.push(workflow.entityType);
    }
    return this;
  }

  /** Un choix observé (case, radio) : son groupe, quand l'écran le nomme. */
  choice(group: string, option: string): this {
    const existing = this.model.choices.find((choice) => choice.name === group);
    if (existing) {
      if (!existing.options.includes(option)) existing.options.push(option);
    } else this.model.choices.push({ name: group, options: [option] });
    return this;
  }

  build(): FunctionalModel {
    return structuredClone(this.model);
  }

  private capability(capability: BusinessCapability): void {
    if (!this.model.capabilities.some((known) => known.id === capability.id))
      this.model.capabilities.push(capability);
  }
}
