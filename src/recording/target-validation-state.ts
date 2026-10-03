import type { FlowTarget, TargetFingerprint } from '../config/flow-schema.js';
import type { HumanJourneyResult } from './human-journey.js';
import type { RawRecordedEvent, SemanticRecordedAction } from './model.js';
import { semanticIdOf } from './recorded-target.js';
import { VALIDATED_STATUSES, type RecordingTargetValidation } from './target-validator.js';

/**
 * L'ÉTAT DE VALIDATION des actions sémantiques : chaque action garde la validation immédiate de
 * sa cible, et la représentation RÉPARÉE (puis revalidée) remplace celle d'origine — avec sa
 * provenance (avant, réparation, après). Une action sans validation n'est jamais retirée.
 */
export function applyTargetValidations(
  actions: readonly SemanticRecordedAction[],
  events: readonly RawRecordedEvent[],
): void {
  const byId = new Map(events.map((event) => [event.id, event]));
  for (const action of actions) {
    if (!action.target && action.type !== 'DRAG_AND_DROP') continue;
    const validations = action.rawEventIds
      .map((id) => byId.get(id)?.targetValidation)
      .filter((validation): validation is RecordingTargetValidation => validation !== undefined)
      .reverse();
    // La validation de CETTE représentation (un clic devenu choix dans une liste a une autre cible).
    const match =
      action.type === 'DRAG_AND_DROP'
        ? validations.find((validation) => validation.action === 'drag')
        : validations.find(
            (validation) => JSON.stringify(validation.targetBefore) === JSON.stringify(action.target?.target),
          );
    if (!match) continue;
    action.targetValidation = match;
    if (!action.target || !match.repairApplied) continue;
    const target = match.targetAfter ?? action.target.target;
    action.target = {
      ...action.target,
      target,
      ...(match.fingerprintAfter ? { fingerprint: match.fingerprintAfter } : {}),
      ambiguous: false,
      reasons: [
        ...action.target.reasons,
        `self-validated during the recording (${match.repair?.reason ?? 'repaired'})`,
      ],
    };
    action.evidence.push(
      `TARGET_FINGERPRINT_AUTO_REPAIRED (${match.repair?.reason ?? ''}): ${(match.repair?.changes ?? [])
        .map((change) => `${change.property} ${change.before ?? '-'} → ${change.after ?? '-'}`)
        .join(', ')} — revalidated ${match.status}`,
    );
  }
}

/**
 * SEMANTIC ACTION GROUP : « champ », « opérateur » puis « valeur » dans la même section forment
 * une FILTER_CONFIGURATION. Les actions restent séparées ; le groupe enrichit le contexte de
 * chaque cible (la valeur est FILTER_VALUE(champ, opérateur), pas « un input »).
 */
export function groupSemanticActions(actions: readonly SemanticRecordedAction[]): number {
  let groups = 0;
  const sectionOf = (action: SemanticRecordedAction): string =>
    action.target?.target.section ??
    action.target?.fingerprint?.section ??
    action.target?.fingerprint?.context ??
    '';
  for (let index = 0; index < actions.length; index += 1) {
    const value = actions[index];
    if (value?.type !== 'FILL' || !value.target) continue;
    const selects: SemanticRecordedAction[] = [];
    for (let back = index - 1; back >= 0 && selects.length < 2; back -= 1) {
      const previous = actions[back];
      if (previous?.type !== 'SELECT' || previous.option === undefined) break;
      if (sectionOf(previous) !== sectionOf(value) || value.at - previous.at > 120_000) break;
      selects.unshift(previous);
    }
    if (selects.length < 2) continue;
    groups += 1;
    const section = sectionOf(value);
    const [field, operator] = selects;
    const context: Record<string, string> = {
      ...(section ? { section } : {}),
      ...(field?.option ? { field: field.option } : {}),
      ...(operator?.option ? { operator: operator.option } : {}),
    };
    const id = `G${String(groups)}`;
    const area = section.split('>').at(-1)?.trim() || 'filter';
    const roles: [SemanticRecordedAction | undefined, string][] = [
      [field, 'field'],
      [operator, 'operator'],
      [value, 'value'],
    ];
    for (const [member, role] of roles) {
      if (!member) continue;
      member.semanticGroup = { kind: 'FILTER_CONFIGURATION', id, context: { ...context, role } };
      member.evidence.push(
        `FILTER_CONFIGURATION ${id}: ${role}${role === 'value' ? ` (field "${context.field ?? '?'}", operator "${context.operator ?? '?'}")` : ''}`,
      );
      // Une identité sémantique stable quand l'élément n'en a pas (une valeur sans libellé).
      const fingerprint = member.target?.fingerprint;
      if (member.target && fingerprint && !fingerprint.semanticId) {
        const semanticId = semanticIdOf(area, role);
        if (semanticId) member.target = { ...member.target, fingerprint: { ...fingerprint, semanticId } };
      }
    }
  }
  return groups;
}

export type TargetValidationClass = 'VALIDATED' | 'VALIDATED_FRAGILE' | 'UNRESOLVED' | 'NOT_VALIDATED';

/** Une ligne du rapport final : une action humaine, sa cible, sa validation. */
export interface TargetValidationEntry {
  humanActionId: string;
  actionId: string;
  action: string;
  label: string;
  flowStep?: number;
  classification: TargetValidationClass;
  status?: string;
  repairApplied: boolean;
  aiAudited: boolean;
  requiresReplayValidation: boolean;
  semanticGroup?: string;
  /** La représentation qui va dans le flow (après réparation et enrichissement du groupe). */
  finalTarget?: FlowTarget;
  finalFingerprint?: TargetFingerprint;
  validation?: RecordingTargetValidation;
}

/** FINAL RECORDING AUDIT : « le parcours généré est-il cohérent et rejouable ? » (jamais un nouveau NOT_FOUND). */
export interface TargetValidationReport {
  summary: {
    humanActions: number;
    validated: number;
    validatedAfterRepair: number;
    fragile: number;
    ambiguous: number;
    unresolved: number;
    notValidated: number;
    contextMismatches: number;
    aiAudits: number;
    aiConfirmed: number;
    aiRejected: number;
    aiInconclusive: number;
  };
  /** Une confiance de rejeu lisible, jamais à la place des détails. */
  replayConfidence: 'HIGH' | 'MEDIUM' | 'LOW';
  coherence: string[];
  entries: TargetValidationEntry[];
}

export function targetValidationReport(
  actions: readonly SemanticRecordedAction[],
  journey: HumanJourneyResult,
  options: { enabled: boolean },
): TargetValidationReport {
  const accountOf = new Map(
    journey.accounts.filter((account) => account.actionId).map((account) => [account.actionId, account]),
  );
  const entries: TargetValidationEntry[] = [];
  for (const action of actions) {
    if (!action.target && action.type !== 'DRAG_AND_DROP') continue;
    const validation = action.targetValidation;
    const account = accountOf.get(action.id);
    if (validation && account) validation.humanActionId = account.interactionId;
    const status = validation?.status;
    // NOT_VALIDATABLE : l'écran a changé avant la validation — pas une preuve contre la cible.
    const classification: TargetValidationClass =
      !validation || status === 'NOT_VALIDATABLE'
        ? 'NOT_VALIDATED'
        : status === 'VALIDATED_FRAGILE'
          ? 'VALIDATED_FRAGILE'
          : status && VALIDATED_STATUSES.has(status)
            ? 'VALIDATED'
            : 'UNRESOLVED';
    entries.push({
      humanActionId: account?.interactionId ?? action.id,
      actionId: action.id,
      action: action.type,
      label: action.drag?.item ?? action.target?.label ?? action.type,
      ...(account?.flowStep !== undefined ? { flowStep: account.flowStep } : {}),
      classification,
      ...(status ? { status } : {}),
      repairApplied: validation?.repairApplied ?? false,
      aiAudited: validation?.aiAudited ?? false,
      // Rien n'est retiré : une cible non prouvée est gardée, à confirmer au rejeu.
      requiresReplayValidation:
        classification === 'UNRESOLVED' || (options.enabled && classification === 'NOT_VALIDATED'),
      ...(action.semanticGroup
        ? { semanticGroup: `${action.semanticGroup.kind} ${action.semanticGroup.id}` }
        : {}),
      ...(action.target ? { finalTarget: action.target.target } : {}),
      ...(action.target?.fingerprint ? { finalFingerprint: action.target.fingerprint } : {}),
      ...(validation ? { validation } : {}),
    });
  }
  // COHÉRENCE : deux actions humaines différentes représentées par la même cible, mais validées sur
  // des éléments différents — le parcours ne serait pas rejouable tel quel.
  const coherence: string[] = [];
  const seen = new Map<string, TargetValidationEntry>();
  for (const entry of entries) {
    const target = actions.find((action) => action.id === entry.actionId)?.target;
    if (!target) continue;
    const key = JSON.stringify(target.target);
    const other = seen.get(key);
    if (
      other &&
      other.validation?.original.section !== entry.validation?.original.section &&
      other.validation?.original.section &&
      entry.validation?.original.section
    )
      coherence.push(
        `${other.humanActionId} and ${entry.humanActionId} share the target ${key} but were used in different sections`,
      );
    seen.set(key, entry);
  }
  const count = (test: (entry: TargetValidationEntry) => boolean): number => entries.filter(test).length;
  const outcome = (value: string): number => count((entry) => entry.validation?.aiAudit?.outcome === value);
  const summary = {
    humanActions: entries.length,
    validated: count((entry) => entry.classification === 'VALIDATED'),
    validatedAfterRepair: count((entry) => entry.classification === 'VALIDATED' && entry.repairApplied),
    fragile: count((entry) => entry.classification === 'VALIDATED_FRAGILE'),
    ambiguous: count((entry) => entry.status === 'AMBIGUOUS'),
    unresolved: count((entry) => entry.classification === 'UNRESOLVED'),
    notValidated: count((entry) => entry.classification === 'NOT_VALIDATED'),
    contextMismatches: count((entry) => entry.validation?.validationBefore.status === 'CONTEXT_MISMATCH'),
    aiAudits: count((entry) => entry.aiAudited),
    aiConfirmed: outcome('AI_PROPOSAL_RUNTIME_CONFIRMED'),
    aiRejected: outcome('AI_PROPOSAL_RUNTIME_REJECTED'),
    aiInconclusive: outcome('INCONCLUSIVE') + outcome('UNAVAILABLE'),
  };
  const total = Math.max(1, summary.humanActions);
  const replayConfidence: TargetValidationReport['replayConfidence'] =
    summary.unresolved === 0 &&
    coherence.length === 0 &&
    summary.fragile / total <= 0.1 &&
    summary.notValidated / total <= 0.2
      ? 'HIGH'
      : summary.unresolved / total <= 0.2 && coherence.length === 0
        ? 'MEDIUM'
        : 'LOW';
  return { summary, replayConfidence, coherence, entries };
}
