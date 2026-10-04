import type { FlowStep, TargetFingerprint } from '../config/flow-schema.js';
import type { FunctionalTargetIdentity, TemporalActionContext } from './functional-target.js';

/**
 * INTERACTION TARGET IDENTITY : « quel contrôle métier, dans quel contexte, pour quel état ? » —
 * pour TOUTE interaction (saisie, bouton, lien, liste, option, case, radio, onglet, menu, accordéon,
 * dialogue, composant maison), jamais « quel CSS cliquer ? ».
 *
 * Les adaptateurs lisent tous la MÊME empreinte enregistrée (une seule capture, un seul moteur de
 * résolution : functional-target.ts) ; ils ne diffèrent que par ce qui fait l'identité de leur type
 * (le libellé d'un champ, le propriétaire d'un bouton, la liste d'une option, l'état d'une case).
 */
export type InteractionType =
  | 'FILL'
  | 'CLICK'
  | 'SELECT'
  | 'CHECK'
  | 'UNCHECK'
  | 'RADIO'
  | 'TOGGLE'
  | 'MENU'
  | 'TAB'
  | 'ACCORDION'
  | 'AUTOCOMPLETE'
  | 'OPTION'
  | 'BUTTON'
  | 'LINK'
  | 'CUSTOM_COMPONENT';

/** Le conteneur qui possède l'interaction (dialogue « Filter », liste « Operator », ligne…). */
export interface InteractionOwner {
  kind: string;
  name: string;
}

export interface ElementFingerprint {
  tag?: string;
  role?: string;
  inputType?: string;
  /** Un indice structurel faible (#id, CSS) : jamais l'identité. */
  locatorHint?: string;
}

export interface FrameworkIdentity {
  formControlName?: string;
  component?: string;
  testId?: string;
}

export interface AccessibleIdentity {
  role?: string;
  name?: string;
  label?: string;
}

export interface BusinessIdentity {
  /** filter.operator, request.employee_name… */
  concept?: string;
}

export interface StructuralContext {
  dialog?: string;
  section?: string;
  tab?: string;
  accordion?: string;
  form?: string;
  row?: string;
  /** Le contrôle d'une option (« Operator »). */
  listbox?: string;
}

export interface FunctionalContext {
  workflowPhase?: string;
  activeSection?: string;
  previousAction?: string;
  nextExpectedAction?: string;
}

export interface InteractionTargetIdentity {
  type: InteractionType;
  /** APPLY_FILTER, SELECT_OPERATOR, CHECK_INTERVIEW_DONE… */
  semanticIntent: string;
  directElement: ElementFingerprint;
  owner?: InteractionOwner;
  frameworkIdentity?: FrameworkIdentity;
  accessibleIdentity?: AccessibleIdentity;
  businessIdentity?: BusinessIdentity;
  structuralContext?: StructuralContext;
  functionalContext?: FunctionalContext;
  /** L'état attendu après l'action (une case). */
  expectedState?: 'checked' | 'unchecked';
  /** 0..1 : la force des preuves d'identité enregistrées (un CSS générique seul : faible). */
  confidence: number;
  /** Ce qui fonde la confiance. */
  basis: string[];
}

/**
 * ACTION CONTEXT FINGERPRINT : l'identité de la cible + son propriétaire + son contexte (route,
 * dialogue, section, onglet, formulaire) + l'action sémantique d'avant et celle attendue après.
 * Une clé stable pour comparer « la même action au même endroit du parcours », pas un localisateur.
 */
export interface ActionContextFingerprint {
  key: string;
  parts: Record<string, string>;
}

/** Un adaptateur : reconnaît son type d'interaction, nomme son intention, dit ce qui fait son identité. */
interface TargetAdapter {
  name: string;
  matches: (step: TargetStep, fingerprint: TargetFingerprint | undefined) => InteractionType | undefined;
  /** L'objet de l'intention (le libellé du champ, le propriétaire du bouton…). */
  subject: (fingerprint: TargetFingerprint | undefined, label: string | undefined) => string | undefined;
}

type TargetStep = Extract<FlowStep, { target: unknown }>;

const slug = (text: string | undefined): string =>
  (text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);

const ownerName = (fingerprint: TargetFingerprint | undefined): string | undefined =>
  fingerprint?.owner?.slice(fingerprint.owner.indexOf(':') + 1);

/**
 * Les adaptateurs, du plus spécifique au plus générique. FieldTargetAdapter, ButtonTargetAdapter,
 * SelectionTargetAdapter, CheckboxTargetAdapter, RadioTargetAdapter, TabTargetAdapter,
 * MenuTargetAdapter, DialogTargetAdapter, CustomComponentTargetAdapter : une table, un moteur.
 */
export const TARGET_ADAPTERS: readonly TargetAdapter[] = [
  {
    name: 'FieldTargetAdapter',
    matches: (step) => (step.kind === 'fill' ? 'FILL' : undefined),
    subject: (fingerprint, label) => fingerprint?.formField ?? label,
  },
  {
    name: 'SelectionTargetAdapter',
    matches: (step, fingerprint) =>
      step.kind === 'select'
        ? fingerprint?.role === 'combobox' && fingerprint.tag === 'input'
          ? 'AUTOCOMPLETE'
          : 'SELECT'
        : fingerprint?.role === 'option'
          ? 'OPTION'
          : undefined,
    // Une option appartient à SON contrôle : « Operator », pas « Like ».
    subject: (fingerprint, label) => fingerprint?.listbox ?? label,
  },
  {
    name: 'RadioTargetAdapter',
    matches: (step, fingerprint) =>
      (step.kind === 'check' || step.kind === 'click') && fingerprint?.role === 'radio' ? 'RADIO' : undefined,
    subject: (fingerprint, label) => fingerprint?.owner?.split(':')[1] ?? label,
  },
  {
    name: 'CheckboxTargetAdapter',
    matches: (step, fingerprint) =>
      step.kind === 'check'
        ? 'CHECK'
        : step.kind === 'uncheck'
          ? 'UNCHECK'
          : fingerprint?.role === 'switch' || fingerprint?.role === 'checkbox'
            ? 'TOGGLE'
            : undefined,
    subject: (_fingerprint, label) => label,
  },
  {
    name: 'TabTargetAdapter',
    matches: (_step, fingerprint) => (fingerprint?.role === 'tab' ? 'TAB' : undefined),
    subject: (_fingerprint, label) => label,
  },
  {
    name: 'MenuTargetAdapter',
    matches: (_step, fingerprint) =>
      fingerprint?.role?.startsWith('menuitem') || fingerprint?.owner?.startsWith('menu:')
        ? 'MENU'
        : undefined,
    subject: (fingerprint, label) =>
      ownerName(fingerprint) ? `${ownerName(fingerprint) ?? ''} ${label ?? ''}` : label,
  },
  {
    name: 'DialogTargetAdapter',
    // Un bouton DANS un dialogue : son intention se lit avec le dialogue (« Apply » de « Filter »).
    matches: (_step, fingerprint) =>
      fingerprint?.owner?.startsWith('dialog:') || fingerprint?.dialog ? 'BUTTON' : undefined,
    subject: (fingerprint, label) => `${label ?? ''} ${fingerprint?.dialog ?? ownerName(fingerprint) ?? ''}`,
  },
  {
    name: 'ButtonTargetAdapter',
    matches: (step, fingerprint) =>
      step.kind === 'click'
        ? fingerprint?.role === 'link'
          ? 'LINK'
          : fingerprint?.role === 'button' || fingerprint?.tag === 'button'
            ? 'BUTTON'
            : fingerprint?.expectedState === undefined && fingerprint?.owner?.startsWith('accordion:')
              ? 'ACCORDION'
              : undefined
        : undefined,
    subject: (fingerprint, label) =>
      fingerprint?.owner && !fingerprint.owner.startsWith('section:')
        ? `${label ?? ''} ${ownerName(fingerprint) ?? ''}`
        : label,
  },
  {
    name: 'CustomComponentTargetAdapter',
    // Un composant maison inconnu : identifié génériquement par sa balise et son propriétaire.
    matches: () => 'CUSTOM_COMPONENT',
    subject: (fingerprint, label) => label ?? fingerprint?.component ?? ownerName(fingerprint),
  },
];

const VERB: Partial<Record<InteractionType, string>> = {
  FILL: 'FILL',
  SELECT: 'SELECT',
  AUTOCOMPLETE: 'SELECT',
  OPTION: 'SELECT',
  CHECK: 'CHECK',
  UNCHECK: 'UNCHECK',
  RADIO: 'CHOOSE',
  TOGGLE: 'TOGGLE',
  TAB: 'OPEN_TAB',
  MENU: 'MENU',
  ACCORDION: 'EXPAND',
  LINK: 'OPEN',
};

/** L'identité d'interaction d'une étape (empreinte enregistrée, identité fonctionnelle, parcours). */
export function interactionTargetIdentityOf(
  step: TargetStep,
  functional: FunctionalTargetIdentity,
  temporal?: TemporalActionContext,
): InteractionTargetIdentity & { adapter: string } {
  const fingerprint = step.fingerprint;
  let type: InteractionType = 'CUSTOM_COMPONENT';
  let adapter = TARGET_ADAPTERS[TARGET_ADAPTERS.length - 1] as TargetAdapter;
  for (const candidate of TARGET_ADAPTERS) {
    const matched = candidate.matches(step, fingerprint);
    if (matched) {
      type = matched;
      adapter = candidate;
      break;
    }
  }
  const label = functional.label;
  // Un bouton : son propre nom fait le verbe (« Apply » → APPLY), son propriétaire l'objet.
  const verb = VERB[type] ?? slug(label).split('_')[0] ?? 'ACT';
  const subject = slug(adapter.subject(fingerprint, label));
  const object =
    type === 'BUTTON' || type === 'CUSTOM_COMPONENT'
      ? subject.replace(new RegExp(`^${verb}_?`), '')
      : subject;
  const semanticIntent = [verb, object].filter(Boolean).join('_') || 'INTERACT';
  const owner = fingerprint?.owner
    ? { kind: fingerprint.owner.slice(0, fingerprint.owner.indexOf(':')), name: ownerName(fingerprint) ?? '' }
    : fingerprint?.dialog
      ? { kind: 'dialog', name: fingerprint.dialog }
      : undefined;
  const structural: StructuralContext = {
    ...(functional.dialog ? { dialog: functional.dialog } : {}),
    ...(functional.section ? { section: functional.section } : {}),
    ...(functional.tab ? { tab: functional.tab } : {}),
    ...(functional.accordion ? { accordion: functional.accordion } : {}),
    ...(functional.form ? { form: functional.form } : {}),
    ...(functional.row ? { row: functional.row } : {}),
    ...(functional.listbox ? { listbox: functional.listbox } : {}),
  };
  // La confiance : les identifiants forts enregistrés, et le contexte qui les situe.
  const basis: string[] = [];
  let confidence = 0.2;
  const add = (weight: number, reason: string): void => {
    confidence += weight;
    basis.push(reason);
  };
  if (fingerprint?.testId) add(0.35, 'test id');
  if (fingerprint?.formControl) add(0.3, 'formControlName');
  if (label) add(0.25, `accessible name / label "${label}"`);
  if (functional.businessConcept) add(0.1, `business concept ${functional.businessConcept}`);
  if (owner) add(0.15, `owner ${owner.kind} "${owner.name}"`);
  if (Object.keys(structural).length > 1) add(0.05, 'structural context');
  if (functional.fragileLocator && !label && !fingerprint?.testId)
    basis.push('only a structural locator (weak)');
  return {
    type,
    adapter: adapter.name,
    semanticIntent,
    directElement: {
      ...(functional.tag ? { tag: functional.tag } : {}),
      ...(functional.role ? { role: functional.role } : {}),
      ...(fingerprint?.inputType ? { inputType: fingerprint.inputType } : {}),
      ...(step.target.value ? { locatorHint: `${step.target.strategy}=${step.target.value}` } : {}),
    },
    ...(owner ? { owner } : {}),
    ...(fingerprint?.formControl || fingerprint?.component || fingerprint?.testId
      ? {
          frameworkIdentity: {
            ...(fingerprint.formControl ? { formControlName: fingerprint.formControl } : {}),
            ...(fingerprint.component ? { component: fingerprint.component } : {}),
            ...(fingerprint.testId ? { testId: fingerprint.testId } : {}),
          },
        }
      : {}),
    accessibleIdentity: {
      ...(functional.role ? { role: functional.role } : {}),
      ...(fingerprint?.name ? { name: fingerprint.name } : {}),
      ...(label ? { label } : {}),
    },
    ...(functional.businessConcept ? { businessIdentity: { concept: functional.businessConcept } } : {}),
    ...(Object.keys(structural).length > 0 ? { structuralContext: structural } : {}),
    ...(temporal
      ? {
          functionalContext: {
            workflowPhase: temporal.workflowPhase,
            ...(temporal.activeSection ? { activeSection: temporal.activeSection } : {}),
            ...(temporal.previousActions.at(-1)
              ? {
                  previousAction:
                    `${temporal.previousActions.at(-1)?.type ?? ''} ${temporal.previousActions.at(-1)?.target ?? ''}`.trim(),
                }
              : {}),
            ...(temporal.nextActions[0]
              ? {
                  nextExpectedAction:
                    `${temporal.nextActions[0].type} ${temporal.nextActions[0].target}`.trim(),
                }
              : {}),
          },
        }
      : {}),
    ...(fingerprint?.expectedState ? { expectedState: fingerprint.expectedState } : {}),
    confidence: Number(Math.min(0.99, confidence).toFixed(2)),
    basis,
  };
}

/** La clé d'action en contexte (identité + propriétaire + contexte + avant / après). */
export function actionContextFingerprintOf(
  identity: InteractionTargetIdentity,
  route?: string,
): ActionContextFingerprint {
  const parts: Record<string, string> = {
    intent: identity.semanticIntent,
    ...(identity.owner ? { owner: `${identity.owner.kind}:${identity.owner.name}` } : {}),
    ...(route ? { route } : {}),
    ...Object.fromEntries(
      Object.entries(identity.structuralContext ?? {}).map(([key, value]) => [key, value]),
    ),
    ...(identity.functionalContext?.previousAction
      ? { previous: identity.functionalContext.previousAction }
      : {}),
    ...(identity.functionalContext?.nextExpectedAction
      ? { next: identity.functionalContext.nextExpectedAction }
      : {}),
  };
  const text = Object.entries(parts)
    .map(([key, value]) => `${key}=${value.toLowerCase()}`)
    .join('|');
  let hash = 2166136261;
  for (const char of text) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return { key: `act_${(hash >>> 0).toString(36)}`, parts };
}
