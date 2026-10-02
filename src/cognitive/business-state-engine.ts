import type { UiSnapshot } from '../model/ui-snapshot.js';
import { referenceOf, type Evidence, type EvidenceReference } from './evidence.js';
import type { FunctionalModel, WorkflowPhase } from './functional-model.js';

/**
 * Ce que l'écran montre, réduit à ce qui compte pour l'état métier. Jamais une valeur
 * saisie : seulement « le champ a une valeur », « il est invalide », « l'option cochée ».
 */
export interface ScreenObservation {
  route: string;
  fields: {
    label: string;
    visible: boolean;
    hasValue: boolean;
    required: boolean;
    invalid: boolean;
    disabled: boolean;
  }[];
  choices: { group?: string; label: string; checked: boolean; kind: 'checkbox' | 'radio' }[];
  buttons: { label: string; enabled: boolean; submit: boolean }[];
  tabs: { label: string; selected: boolean }[];
  alerts: string[];
  busy: boolean;
}

const FIELD_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'listbox']);

/** Observation métier d'un instantané de l'UIObserver (aucune valeur lue). */
export function observationOf(snapshot: UiSnapshot, route: string): ScreenObservation {
  const visible = snapshot.elements.filter((element) => element.visible);
  return {
    route,
    fields: visible
      .filter(
        (element) =>
          FIELD_ROLES.has(element.role) ||
          element.tag === 'textarea' ||
          element.tag === 'select' ||
          (element.tag === 'input' &&
            !['checkbox', 'radio', 'button', 'submit'].includes(element.inputType ?? 'text')),
      )
      .map((element) => ({
        label: element.label ?? element.name,
        visible: true,
        hasValue: element.hasValue === true || element.selectedOption !== undefined,
        required: element.required,
        invalid: element.ariaInvalid === true || element.frameworkValid === false,
        disabled: element.disabled || element.readOnly,
      }))
      .filter((field) => field.label),
    choices: visible
      .filter((element) => element.role === 'checkbox' || element.role === 'radio')
      .map((element) => ({
        ...(element.groupLabel ? { group: element.groupLabel } : {}),
        label: element.label ?? element.name,
        checked: element.checked === true,
        kind: element.role === 'radio' ? ('radio' as const) : ('checkbox' as const),
      })),
    buttons: visible
      .filter((element) => element.role === 'button')
      .map((element) => ({ label: element.name, enabled: !element.disabled, submit: element.isSubmit })),
    tabs: visible
      .filter((element) => element.role === 'tab')
      .map((element) => ({ label: element.name, selected: element.selected === true })),
    alerts: snapshot.signals?.alerts ?? [],
    busy: snapshot.signals?.busy ?? false,
  };
}

export interface BusinessFact {
  name: string;
  value: string;
  evidence: EvidenceReference[];
}

export type PhaseCompletion = 'UNAVAILABLE' | 'INCOMPLETE' | 'INVALID' | 'COMPLETE';

export interface PhaseState {
  phase: string;
  status: PhaseCompletion;
  missing: string[];
  invalid: string[];
}

export type SubmissionState = 'BLOCKED' | 'READY' | 'ALLOWED_WHILE_INCOMPLETE' | 'NOT_VISIBLE';

export interface BlockedGoal {
  goal: string;
  missing: string[];
  reason: string;
}

/** BUSINESS STATE (§8) : l'état fonctionnel qu'un testeur lirait à l'écran. */
export interface BusinessSituation {
  mission?: string;
  phase?: string;
  facts: BusinessFact[];
  phases: PhaseState[];
  submission: SubmissionState;
  /** Les conditions métier qui manquent (champs requis vides, choix non faits). */
  missing: string[];
  evidence: EvidenceReference[];
}

/** FUNCTIONAL STATE (§9) : capacités, phase, faits, objectifs atteints / disponibles / bloqués. */
export interface FunctionalState {
  capabilities: { id: string; status: 'COMPLETED' | 'AVAILABLE' | 'BLOCKED' | 'UNAVAILABLE' }[];
  workflowPhase?: string;
  businessFacts: BusinessFact[];
  completedGoals: string[];
  availableGoals: string[];
  blockedGoals: BlockedGoal[];
  evidence: EvidenceReference[];
}

/**
 * BUSINESS STATE ENGINE : observations techniques → état métier.
 *
 *   route=/request/create · EUR coché · champs entreprise visibles · numéro vide · envoi désactivé
 *     → mission CREATE_REQUEST · phase COMPANY_INFORMATION · currency=EUR
 *       companyInformation INCOMPLETE (missing: Business number) · submission BLOCKED
 *
 * Chaque fait porte sa preuve (DOM, l'écran de la route). Un écran ne prouve qu'un état
 * d'écran : les objectifs restent à confirmer par leurs effets (ActionEffectVerifier).
 */
export class BusinessStateEngine {
  constructor(
    private readonly model: FunctionalModel,
    private readonly addEvidence: (input: Omit<Evidence, 'id'>) => Evidence,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  evaluate(screen: ScreenObservation): { situation: BusinessSituation; state: FunctionalState } {
    const proof = (details: Record<string, string>): EvidenceReference =>
      referenceOf(
        this.addEvidence({
          type: 'DOM',
          source: `screen ${screen.route}`,
          timestamp: this.now(),
          confidence: 0.9,
          details,
        }),
      );
    const facts: BusinessFact[] = [];
    for (const choice of screen.choices.filter((candidate) => candidate.checked)) {
      const group =
        choice.group ?? this.model.choices.find((known) => known.options.includes(choice.label))?.name;
      facts.push({
        name: group ?? choice.label,
        value: group ? choice.label : 'selected',
        evidence: [proof({ fact: group ?? choice.label, value: group ? choice.label : 'selected' })],
      });
    }
    for (const tab of screen.tabs.filter((candidate) => candidate.selected))
      facts.push({ name: 'tab', value: tab.label, evidence: [proof({ tab: tab.label })] });

    const phases = this.model.phases.map((phase) => this.phaseState(phase, screen));
    // Un écran sans modèle : chaque groupe de champs visibles reste lisible (une phase anonyme).
    if (phases.length === 0 && screen.fields.length > 0)
      phases.push(
        this.phaseState(
          { id: 'FORM', label: 'form', fields: screen.fields.map((field) => field.label), order: 0 },
          screen,
        ),
      );
    // Un champ requis, visible et vide que le modèle ne connaît pas encore : une condition manquante
    // de la phase affichée (l'écran le déclare requis ; le parcours démontré ne l'avait pas rempli).
    const norm = (text: string): string =>
      text
        .trim()
        .toLowerCase()
        .replace(/[*:]+$/, '')
        .trim();
    const known = new Set(this.model.phases.flatMap((phase) => phase.fields.map(norm)));
    const extras = screen.fields.filter(
      (field) => field.required && !field.hasValue && !field.disabled && !known.has(norm(field.label)),
    );
    const shown = phases.find((phase) => phase.status !== 'UNAVAILABLE');
    if (shown && extras.length > 0) {
      shown.missing.push(...extras.map((field) => field.label));
      if (shown.status === 'COMPLETE') shown.status = 'INCOMPLETE';
    }
    const current =
      phases.find((phase) => phase.status === 'INCOMPLETE' || phase.status === 'INVALID') ??
      [...phases].reverse().find((phase) => phase.status === 'COMPLETE');
    const missing = phases.flatMap((phase) => [
      ...phase.missing,
      ...phase.invalid.map((field) => `${field} (invalid)`),
    ]);
    const submitLabel = this.model.submit?.label.toLowerCase();
    const submit =
      screen.buttons.find((button) => submitLabel && button.label.toLowerCase() === submitLabel) ??
      screen.buttons.find((button) => button.submit);
    const submission: SubmissionState = !submit
      ? 'NOT_VISIBLE'
      : !submit.enabled
        ? 'BLOCKED'
        : missing.length > 0
          ? 'ALLOWED_WHILE_INCOMPLETE'
          : 'READY';
    const evidence = [...facts.flatMap((fact) => fact.evidence)];
    if (submit) evidence.push(proof({ submit: submit.label, enabled: String(submit.enabled) }));
    for (const phase of phases)
      if (phase.status !== 'UNAVAILABLE')
        evidence.push(proof({ phase: phase.phase, status: phase.status, missing: phase.missing.join(', ') }));
    const situation: BusinessSituation = {
      ...(this.model.mission ? { mission: this.model.mission.id } : {}),
      ...(current ? { phase: current.phase } : {}),
      facts,
      phases,
      submission,
      missing,
      evidence,
    };
    return { situation, state: this.functionalState(situation) };
  }

  private phaseState(phase: WorkflowPhase, screen: ScreenObservation): PhaseState {
    const norm = (text: string): string =>
      text
        .trim()
        .toLowerCase()
        .replace(/[*:]+$/, '')
        .trim();
    const shown = phase.fields
      .map((name) => screen.fields.find((field) => norm(field.label) === norm(name)))
      .filter((field): field is ScreenObservation['fields'][number] => field !== undefined);
    if (shown.length === 0) return { phase: phase.id, status: 'UNAVAILABLE', missing: [], invalid: [] };
    // Requis : déclaré par l'écran ; sinon, tout champ que le parcours démontré remplit.
    const anyRequired = shown.some((field) => field.required);
    const missing = phase.fields.filter((name) => {
      const field = shown.find((candidate) => norm(candidate.label) === norm(name));
      if (!field) return true;
      return (anyRequired ? field.required : true) && !field.hasValue;
    });
    const invalid = shown.filter((field) => field.invalid).map((field) => field.label);
    return {
      phase: phase.id,
      status: invalid.length > 0 ? 'INVALID' : missing.length > 0 ? 'INCOMPLETE' : 'COMPLETE',
      missing,
      invalid,
    };
  }

  private functionalState(situation: BusinessSituation): FunctionalState {
    const completed = situation.phases
      .filter((phase) => phase.status === 'COMPLETE')
      .map((phase) => `${phase.phase}_COMPLETE`);
    const blocked: BlockedGoal[] = situation.phases
      .filter((phase) => phase.status === 'INCOMPLETE' || phase.status === 'INVALID')
      .map((phase) => ({
        goal: `${phase.phase}_COMPLETE`,
        missing: [...phase.missing, ...phase.invalid],
        reason: phase.status === 'INVALID' ? 'invalid fields' : 'required fields are empty',
      }));
    if (this.model.mission && situation.submission === 'BLOCKED')
      blocked.push({
        goal: `SUBMIT_${this.model.mission.id}`,
        missing: situation.missing,
        reason: 'the submit action is disabled',
      });
    const available = [
      ...situation.phases
        .filter((phase) => phase.status === 'INCOMPLETE' || phase.status === 'INVALID')
        .map((phase) => `${phase.phase}_COMPLETE`),
      ...(this.model.mission && situation.submission === 'READY' ? [`SUBMIT_${this.model.mission.id}`] : []),
    ];
    return {
      capabilities: this.model.capabilities.map((capability) => {
        const phase = situation.phases.find((candidate) => `ENTER_${candidate.phase}` === capability.id);
        const status = phase
          ? phase.status === 'COMPLETE'
            ? ('COMPLETED' as const)
            : phase.status === 'UNAVAILABLE'
              ? ('UNAVAILABLE' as const)
              : ('AVAILABLE' as const)
          : capability.kind === 'SUBMISSION'
            ? situation.submission === 'READY'
              ? ('AVAILABLE' as const)
              : situation.submission === 'BLOCKED'
                ? ('BLOCKED' as const)
                : ('UNAVAILABLE' as const)
            : capability.kind === 'CHOICE'
              ? situation.facts.some(
                  (fact) =>
                    `SELECT_${fact.value.toUpperCase()}` === capability.id ||
                    fact.name.toUpperCase() === capability.label.toUpperCase(),
                )
                ? ('COMPLETED' as const)
                : ('AVAILABLE' as const)
              : ('AVAILABLE' as const);
        return { id: capability.id, status };
      }),
      ...(situation.phase ? { workflowPhase: situation.phase } : {}),
      businessFacts: situation.facts,
      completedGoals: completed,
      availableGoals: available,
      blockedGoals: blocked,
      evidence: situation.evidence,
    };
  }
}

/** « currency=EUR · COMPANY_INFORMATION INCOMPLETE (missing: Business number) · submission BLOCKED » */
export function describeSituation(situation: BusinessSituation): string {
  return [
    ...(situation.mission ? [`mission ${situation.mission}`] : []),
    ...(situation.phase ? [`phase ${situation.phase}`] : []),
    ...situation.facts.map((fact) => `${fact.name}=${fact.value}`),
    ...situation.phases
      .filter((phase) => phase.status !== 'UNAVAILABLE')
      .map(
        (phase) =>
          `${phase.phase} ${phase.status}${phase.missing.length > 0 ? ` (missing: ${phase.missing.join(', ')})` : ''}`,
      ),
    `submission ${situation.submission}`,
  ].join(' · ');
}
