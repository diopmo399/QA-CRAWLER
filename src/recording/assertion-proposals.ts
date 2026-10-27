import type { FlowExpectation } from '../config/flow-schema.js';
import type { AssertionConfig } from '../config/quality-schema.js';
import { apiTemplate } from '../functional/runtime-learning.js';
import type { FieldMapping } from './analysis/recording-analysis.js';
import { technicalCategoryOf } from './business/entity-classifier.js';
import { isListRead } from './business/signals.js';
import type {
  AssertionCandidate,
  AssertionProposal,
  ProposalCategory,
  ProposalOrigin,
  ProposalStatus,
  RecordedFlow,
  RecordedFlowStep,
  SemanticRecordedAction,
} from './model.js';
import { isWrite } from './normalizer.js';
import { normalizeGroups } from './step-groups.js';
import { observationIds, type ObservationSet } from './observations.js';

/**
 * LES PROPOSITIONS D'ASSERTIONS : ce que le recording permet de vérifier, proposé à l'humain avec son
 * origine, ses observations et preuves, sa méthode de vérification, ses limites et sa confiance.
 *
 *   OBSERVED   tirée d'une observation concrète (une page affichée, un message, une requête acceptée) ;
 *   DEDUCED    d'une relation plausible entre plusieurs observations (la saisie se retrouve dans la
 *              requête, l'enregistrement créé est servi par la recherche suivante) : identifiée comme
 *              déduite, à confirmer ; jamais une règle métier sans décision humaine ;
 *   EXPLICIT   posée par l'humain (point de contrôle).
 *
 * Deux méthodes de vérification, toutes deux exécutées par le rejeu existant :
 *   UI_EXPECT             une étape `expect` du flow (url, text, visible, response, noError) ;
 *   BUSINESS_ASSERTION    une assertion métier du schéma de la mission (`assertions:`), vérifiée par le
 *                         BusinessAssertionEngine sur le réseau observé au rejeu (jamais la base).
 *
 * Sans décision, le flow est celui d'avant (les candidats stables restent retenus) ; une décision
 * l'écrit (acceptée) ou l'en retire (refusée, désactivée). Rien n'est redondant (dédoublonnage par
 * vérification et par action) ; deux propositions contradictoires se signalent l'une l'autre.
 */
export interface ProposalInput {
  flow: RecordedFlow;
  kept: readonly SemanticRecordedAction[];
  observations: ObservationSet;
  /** Les correspondances saisie → propriété de la requête apprises par l'analyse HTTP (facultatives). */
  fieldMappings?: readonly FieldMapping[];
}

const CATEGORY_OF_KIND: Record<AssertionCandidate['kind'], ProposalCategory> = {
  ROUTE: 'NAVIGATION',
  ENTITY_EXISTS: 'UI_CONTENT',
  BUSINESS_STATE: 'BUSINESS_RULE',
  FIELD_STATE: 'UI_STATE',
  MESSAGE: 'UI_CONTENT',
  API_OUTCOME: 'API_RESPONSE',
  RULE: 'BUSINESS_RULE',
  INVARIANT: 'BUSINESS_RULE',
  SIDE_EFFECT: 'NETWORK',
};

const DEDUCED_KINDS = new Set<AssertionCandidate['kind']>([
  'BUSINESS_STATE',
  'RULE',
  'INVARIANT',
  'SIDE_EFFECT',
]);

/** Les propositions d'un recording (pures, déterministes). */
export function proposeAssertions(input: ProposalInput): AssertionProposal[] {
  const proposals: AssertionProposal[] = [];
  const keys = new Map<string, AssertionProposal>();
  const stepOf = (actionId: string): RecordedFlowStep | undefined =>
    input.flow.steps.find((item) => item.step.kind !== 'expect' && item.actionIds.includes(actionId));
  const add = (
    proposal: Omit<AssertionProposal, 'id' | 'status' | 'afterStepId'>,
  ): AssertionProposal | undefined => {
    // La même vérification proposée après une autre action est redondante : la première ancre est gardée,
    // ses preuves s'ajoutent, et elle hérite de la recommandation (un candidat stable retenu par le recorder).
    const key = JSON.stringify(proposal.expect ?? proposal.assertion?.check ?? proposal.description);
    const existing = keys.get(key);
    if (existing) {
      for (const id of proposal.sourceObservationIds)
        if (!existing.sourceObservationIds.includes(id)) existing.sourceObservationIds.push(id);
      if (proposal.recommended && !existing.recommended) {
        existing.recommended = true;
        existing.candidateId = proposal.candidateId ?? existing.candidateId;
      }
      return undefined;
    }
    const step = stepOf(proposal.afterActionId);
    const created: AssertionProposal = {
      id: `p${String(proposals.length + 1)}`,
      ...proposal,
      ...(step ? { afterStepId: step.id } : {}),
      status: 'PROPOSED',
    };
    proposals.push(created);
    keys.set(key, created);
    return created;
  };

  // A. Les candidats d'outcome : observés (un fait), déduits (un état métier lu, une règle), explicites (point de contrôle).
  for (const candidate of input.flow.assertions) {
    const origin: ProposalOrigin =
      candidate.provenance === 'MANUAL_CHECKPOINT'
        ? 'EXPLICIT'
        : DEDUCED_KINDS.has(candidate.kind)
          ? 'DEDUCED'
          : 'OBSERVED';
    const category = CATEGORY_OF_KIND[candidate.kind];
    const limits: string[] = [];
    if (candidate.stability === 'FRAGILE')
      limits.push('fragile: the text or state may depend on run data or timing');
    if (!candidate.expect) limits.push('not executable as such: reported, never verified by the replay');
    add({
      origin,
      category,
      description: candidate.description,
      why: candidate.reason,
      afterActionId: candidate.afterActionId,
      sourceObservationIds: observationIds(
        input.observations,
        candidate.afterActionId,
        kindsFor(candidate.kind),
      ),
      evidence: candidate.evidence,
      verificationMethod: candidate.expect ? 'UI_EXPECT' : 'REPORT_ONLY',
      limits,
      confidence: candidate.confidence,
      needsConfirmation: origin !== 'OBSERVED' || candidate.stability !== 'STABLE' || !candidate.selected,
      recommended: candidate.selected,
      ...(candidate.expect ? { expect: candidate.expect } : {}),
      candidateId: candidate.id,
    });
  }

  // B. Les déductions sur les données : saisie → requête, création → recherche ; l'absence d'erreur après une écriture.
  const fills: { action: SemanticRecordedAction; key: string; label: string }[] = [];
  const created: { key: string; actionId: string; api: string }[] = [];
  for (const action of input.kept) {
    if (action.type === 'FILL' && action.value?.testData && !action.value.sensitive)
      fills.push({ action, key: action.value.testData, label: action.target?.label ?? 'field' });
    for (const exchange of action.network) {
      if (exchange.status === undefined) continue;
      const template = apiTemplate(exchange.path);
      const api = `${exchange.method} ${template}`;
      const technical = technicalCategoryOf(exchange.path) !== undefined || isListRead(exchange);
      const accepted = exchange.status >= 200 && exchange.status < 300;
      if (isWrite(exchange.method) && accepted && !technical) {
        // B1. Chaque donnée saisie avant l'écriture se retrouve dans la requête (champ connu : observé ; sinon déduit).
        for (const fill of fills) {
          const mapping = input.fieldMappings?.find(
            (entry) => entry.uiLabel === fill.label && entry.api === api && entry.source === 'BODY',
          );
          const observed = mapping !== undefined && mapping.state !== 'REJECTED';
          add({
            origin: observed ? 'OBSERVED' : 'DEDUCED',
            category: 'DATA_CONSISTENCY',
            description: `${api} carries the value typed into "${fill.label}" (${fill.key})`,
            why: observed
              ? `the HTTP analysis matched "${fill.label}" with the request property ${mapping.property} (${mapping.transformation})`
              : `"${fill.label}" was typed before the write ${api} accepted by the server: the value is expected in its body`,
            afterActionId: action.id,
            sourceObservationIds: [
              ...observationIds(input.observations, fill.action.id, ['INPUT_VALUE']),
              ...observationIds(input.observations, action.id, ['REQUEST', 'RESPONSE']),
            ],
            evidence: observed
              ? mapping.evidence
              : [`fill "${fill.label}" (${fill.key}) before ${api} → ${String(exchange.status)}`],
            verificationMethod: 'BUSINESS_ASSERTION',
            limits: observed
              ? []
              : [
                  'the request property is not identified: any field of the body carrying the value matches',
                  'the request body must be observed at replay',
                ],
            confidence: observed ? Math.min(0.9, mapping.confidence) : 0.6,
            needsConfirmation: !observed || mapping.confidence < 0.8,
            recommended: false,
            assertion: {
              id: assertionId('REQUEST', fill.key),
              description: `the value of ${fill.key} is sent to ${api}`,
              criticality: 'MEDIUM',
              mandatory: true,
              requires: [],
              entities: [],
              timeoutMs: 0,
              pollMs: 500,
              evidence: ['NETWORK'],
              check: {
                kind: 'value',
                source: 'request',
                method: exchange.method,
                path: template,
                ...(observed ? { field: mapping.property } : {}),
                expected: { testData: fill.key },
                match: observed && mapping.transformation === 'EXACT' ? 'exact' : 'normalized',
              },
            },
          });
          if (!created.some((entry) => entry.key === fill.key))
            created.push({ key: fill.key, actionId: action.id, api });
        }
        fills.length = 0;
        // B3. Aucune erreur affichée après l'écriture acceptée (observé sur l'écran suivant).
        const after = observationIds(input.observations, action.id, ['PAGE_STATE']);
        // Un message de statut (« créé ») n'est pas une erreur : seules les alertes comptent.
        const alerts = input.observations.observations.filter(
          (observation) =>
            observation.actionId === action.id &&
            observation.kind === 'MESSAGE' &&
            observation.summary.startsWith('alert shown'),
        ).length;
        if (after.length > 0 && alerts === 0)
          add({
            origin: 'OBSERVED',
            category: 'ERROR_ABSENCE',
            description: `no error is shown after ${api}`,
            why: 'the screen observed after the accepted write showed no alert and no invalid field',
            afterActionId: action.id,
            sourceObservationIds: after,
            evidence: [`screen after ${api} → ${String(exchange.status)}: no alert`],
            verificationMethod: 'UI_EXPECT',
            limits: ['an error rendered without the alert role or the usual error classes is not detected'],
            confidence: 0.7,
            needsConfirmation: false,
            recommended: false,
            expect: { noError: true },
          });
      } else if (!isWrite(exchange.method) || isListRead(exchange)) {
        // B2. Une lecture après une création sert l'enregistrement créé (déduit : la lecture est peut-être autre chose).
        const served = (exchange.records?.length ?? exchange.listSize ?? 0) > 0;
        if (!served || !accepted) continue;
        for (const entry of created)
          add({
            origin: 'DEDUCED',
            category: 'RELATIONSHIP',
            description: `${api} returns the record created with ${entry.key}`,
            why: `${entry.api} accepted a write carrying ${entry.key}; this later read served records`,
            afterActionId: action.id,
            sourceObservationIds: observationIds(input.observations, action.id, ['RECORDS', 'RESPONSE']),
            evidence: [`${entry.api} then ${api} → ${String(exchange.status)} with records`],
            verificationMethod: 'BUSINESS_ASSERTION',
            limits: [
              'the read may not be the search of that record',
              'the response body must be observed at replay',
            ],
            confidence: 0.5,
            needsConfirmation: true,
            recommended: false,
            assertion: {
              id: assertionId('FOUND', entry.key),
              description: `the record created with ${entry.key} is served by ${api}`,
              criticality: 'MEDIUM',
              mandatory: true,
              requires: [assertionId('REQUEST', entry.key)],
              entities: [],
              timeoutMs: 0,
              pollMs: 500,
              evidence: ['NETWORK'],
              check: {
                kind: 'entity',
                source: 'network',
                by: { testData: entry.key },
                expect: 'present',
                unique: false,
                path: template,
              },
            },
          });
      }
    }
  }

  // C. Les contradictions : la même requête acceptée et refusée après la même action.
  for (const proposal of proposals) {
    const response = proposal.expect?.response;
    if (!response) continue;
    const twins = proposals.filter(
      (other) =>
        other !== proposal &&
        other.afterActionId === proposal.afterActionId &&
        other.expect?.response?.url === response.url &&
        other.expect.response.method === response.method &&
        other.expect.response.status !== response.status,
    );
    if (twins.length > 0) {
      proposal.conflictsWith = twins.map((twin) => twin.id);
      proposal.needsConfirmation = true;
      proposal.limits = [
        ...proposal.limits,
        `contradicts ${twins.map((twin) => twin.id).join(', ')}: the same call was both accepted and refused`,
      ];
    }
  }
  return proposals;
}

function kindsFor(kind: AssertionCandidate['kind']): Parameters<typeof observationIds>[2] {
  switch (kind) {
    case 'ROUTE':
      return ['NAVIGATION', 'PAGE_STATE', 'ELEMENT_APPEARED'];
    case 'MESSAGE':
      return ['MESSAGE'];
    case 'ENTITY_EXISTS':
      return ['PAGE_STATE', 'RECORDS'];
    case 'API_OUTCOME':
    case 'SIDE_EFFECT':
      return ['REQUEST', 'RESPONSE'];
    case 'BUSINESS_STATE':
      return ['RESPONSE'];
    case 'FIELD_STATE':
      return ['CONTROL_STATE', 'INPUT_VALUE'];
    default:
      return ['PAGE_STATE'];
  }
}

function assertionId(prefix: string, key: string): string {
  return `ASSERT-${prefix}-${key
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')}`;
}

// ------------------------------------------------------------------ décisions

export type ProposalDecisionType = 'ACCEPT' | 'REJECT' | 'DISABLE' | 'RESET' | 'MODIFY';

export interface ProposalDecision {
  id: string;
  decision: ProposalDecisionType;
  /** MODIFY : la description, l'obligation et la criticité de l'assertion (jamais sa vérification). */
  description?: string;
  mandatory?: boolean;
  criticality?: AssertionConfig['criticality'];
  note?: string;
}

const STATUS_OF: Record<ProposalDecisionType, ProposalStatus> = {
  ACCEPT: 'APPROVED',
  REJECT: 'REJECTED',
  DISABLE: 'DISABLED',
  RESET: 'PROPOSED',
  MODIFY: 'MODIFIED',
};

/** Une proposition est dans le flow quand elle est acceptée, modifiée, ou recommandée sans décision. */
export function inFlow(proposal: Pick<AssertionProposal, 'status' | 'recommended'>): boolean {
  return (
    proposal.status === 'APPROVED' ||
    proposal.status === 'MODIFIED' ||
    (proposal.status === 'PROPOSED' && proposal.recommended)
  );
}

/**
 * Applique une décision humaine au flow (en place) : la proposition change de statut, l'étape `expect`
 * ou l'assertion métier est écrite dans le flow ou en est retirée. Le flow d'avant est conservé pour
 * tout ce qui n'est pas décidé.
 */
export function decideProposal(
  flow: RecordedFlow,
  decision: ProposalDecision,
  at = new Date().toISOString(),
): { ok: true } | { error: string } {
  const proposal = flow.proposals?.find((entry) => entry.id === decision.id);
  if (!proposal) return { error: `unknown proposal ${decision.id}` };
  if (
    proposal.verificationMethod === 'REPORT_ONLY' &&
    (decision.decision === 'ACCEPT' || decision.decision === 'MODIFY')
  )
    return { error: `${proposal.id} is not executable: it stays in the report` };
  if (decision.decision === 'MODIFY') {
    if (decision.description) proposal.description = decision.description;
    if (proposal.assertion) {
      if (decision.description) proposal.assertion.description = decision.description;
      if (decision.mandatory !== undefined) proposal.assertion.mandatory = decision.mandatory;
      if (decision.criticality) proposal.assertion.criticality = decision.criticality;
    }
  }
  proposal.status = STATUS_OF[decision.decision];
  proposal.decidedAt = at;
  if (decision.note !== undefined) proposal.note = decision.note;
  else if (decision.decision === 'RESET') delete proposal.note;
  applyProposal(flow, proposal);
  return { ok: true };
}

/** Écrit (ou retire) ce que la proposition vérifie, selon qu'elle est dans le flow. */
export function applyProposal(flow: RecordedFlow, proposal: AssertionProposal): void {
  const wanted = inFlow(proposal);
  const candidate = proposal.candidateId
    ? flow.assertions.find((entry) => entry.id === proposal.candidateId)
    : undefined;
  if (candidate) candidate.selected = wanted;
  if (proposal.verificationMethod === 'UI_EXPECT' && proposal.expect) {
    const expect = proposal.expect;
    const key = JSON.stringify(expect);
    const existing = flow.steps.findIndex(
      (item) =>
        item.step.kind === 'expect' &&
        item.actionIds.includes(proposal.afterActionId) &&
        JSON.stringify(item.step.expect) === key,
    );
    if (wanted && existing < 0) {
      const anchor = flow.steps.findIndex(
        (item) => item.step.kind !== 'expect' && item.actionIds.includes(proposal.afterActionId),
      );
      if (anchor < 0) return;
      // Après l'action et les vérifications qui la suivent déjà.
      let position = anchor + 1;
      while (
        position < flow.steps.length &&
        flow.steps[position]?.step.kind === 'expect' &&
        flow.steps[position]?.actionIds.includes(proposal.afterActionId)
      )
        position += 1;
      const source = flow.steps[anchor];
      flow.steps.splice(position, 0, {
        id: nextStepId(flow.steps),
        step: { kind: 'expect', expect, allow: [], optional: false },
        label: proposal.description,
        actionIds: [proposal.afterActionId],
        rawEventIds: source?.rawEventIds ?? [],
        provenance: proposal.status === 'PROPOSED' ? 'INFERRED_OUTCOME' : 'HUMAN_DECISION',
        confidence: proposal.confidence,
        explanation: `${proposal.origin.toLowerCase()} assertion ${proposal.id} ${proposal.status === 'PROPOSED' ? 'kept' : 'accepted by the human'}: ${proposal.why}`,
      });
    } else if (!wanted && existing >= 0) flow.steps.splice(existing, 1);
    // Une vérification suit son action : elle entre dans (ou sort de) son groupe métier avec elle.
    normalizeGroups(flow);
  }
  if (proposal.verificationMethod === 'BUSINESS_ASSERTION' && proposal.assertion) {
    const assertions = (flow.businessAssertions ??= []).filter(
      (entry) => entry.id !== proposal.assertion?.id,
    );
    if (wanted) assertions.push(proposal.assertion);
    flow.businessAssertions = assertions;
    if (flow.businessAssertions.length === 0) delete flow.businessAssertions;
  }
}

function nextStepId(steps: readonly RecordedFlowStep[]): string {
  const max = steps.reduce((best, item) => {
    const match = /^s(\d+)$/.exec(item.id);
    return match ? Math.max(best, Number(match[1])) : best;
  }, 0);
  return `s${String(max + 1)}`;
}

/**
 * UNE VÉRIFICATION DE DONNÉE posée par l'humain : la donnée de test `key` est visible après l'étape
 * `afterStepId` (« le résultat contient la fiche créée »). Elle devient une proposition EXPLICIT acceptée
 * — une étape `expect` qui CITE la donnée, résolue au rejeu par la valeur du run, jamais par une valeur
 * enregistrée. La retirer, la désactiver ou la réinitialiser passe par les décisions habituelles.
 */
export function addDataCheck(
  flow: RecordedFlow,
  input: { afterStepId: string; key: string; groupName?: string },
  at = new Date().toISOString(),
): { ok: true; proposalId: string } | { error: string } {
  if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,79}$/.test(input.key))
    return { error: `invalid test data key ${input.key}` };
  const anchor = flow.steps.find((item) => item.id === input.afterStepId);
  if (!anchor || anchor.step.kind === 'expect') return { error: `unknown action step ${input.afterStepId}` };
  const actionId = anchor.actionIds[anchor.actionIds.length - 1];
  if (actionId === undefined) return { error: `step ${input.afterStepId} has no recorded action` };
  const expect: FlowExpectation = { text: `\${testData:${input.key}}` };
  const same = JSON.stringify(expect);
  if (
    (flow.proposals ?? []).some(
      (entry) => entry.afterActionId === actionId && JSON.stringify(entry.expect) === same && inFlow(entry),
    )
  )
    return { error: `testData.${input.key} is already checked after step ${input.afterStepId}` };
  const proposals = (flow.proposals ??= []);
  const max = proposals.reduce((best, entry) => {
    const match = /^p(\d+)$/.exec(entry.id);
    return match ? Math.max(best, Number(match[1])) : best;
  }, 0);
  const proposal: AssertionProposal = {
    id: `p${String(max + 1)}`,
    origin: 'EXPLICIT',
    category: 'DATA_CONSISTENCY',
    description: `testData.${input.key} is displayed${input.groupName ? ` at the end of "${input.groupName}"` : ''}`,
    why: `asked by the human: the value of testData.${input.key} used by this run must be visible here`,
    afterActionId: actionId,
    afterStepId: anchor.id,
    sourceObservationIds: [],
    evidence: [],
    verificationMethod: 'UI_EXPECT',
    limits: ['the text is looked for anywhere on the page, not in a given element'],
    confidence: 1,
    needsConfirmation: false,
    recommended: false,
    status: 'APPROVED',
    decidedAt: at,
    expect,
  };
  proposals.push(proposal);
  applyProposal(flow, proposal);
  return { ok: true, proposalId: proposal.id };
}

/**
 * Les assertions métier à écrire dans le YAML : `after` est l'index (à partir de 1) de l'étape
 * d'ancrage dans le flow TEL QU'IL EST ÉCRIT ; `requires` ne cite que des assertions écrites.
 */
export function businessAssertionsForYaml(flow: RecordedFlow): Record<string, unknown>[] {
  const assertions = flow.businessAssertions ?? [];
  if (assertions.length === 0) return [];
  const ids = new Set(assertions.map((entry) => entry.id));
  return assertions.map((assertion) => {
    const proposal = flow.proposals?.find((entry) => entry.assertion?.id === assertion.id);
    const anchor = proposal?.afterStepId
      ? flow.steps.findIndex((item) => item.id === proposal.afterStepId)
      : -1;
    const requires = assertion.requires.filter((id) => ids.has(id));
    return {
      id: assertion.id,
      description: assertion.description,
      ...(assertion.criticality !== 'MEDIUM' ? { criticality: assertion.criticality } : {}),
      ...(assertion.mandatory ? {} : { mandatory: false }),
      ...(anchor >= 0 ? { after: anchor + 1 } : {}),
      ...(requires.length > 0 ? { requires } : {}),
      ...(assertion.entities.length > 0 ? { entities: assertion.entities } : {}),
      ...(assertion.evidence.length > 0 ? { evidence: assertion.evidence } : {}),
      check: assertion.check,
    };
  });
}

/** Le résumé des propositions (rapport, fenêtre). */
export function proposalSummary(proposals: readonly AssertionProposal[]): {
  total: number;
  byOrigin: Record<ProposalOrigin, number>;
  byStatus: Record<ProposalStatus, number>;
  inFlow: number;
  needingConfirmation: number;
  conflicts: number;
} {
  const byOrigin: Record<ProposalOrigin, number> = { OBSERVED: 0, DEDUCED: 0, EXPLICIT: 0 };
  const byStatus: Record<ProposalStatus, number> = {
    PROPOSED: 0,
    APPROVED: 0,
    MODIFIED: 0,
    REJECTED: 0,
    DISABLED: 0,
  };
  let kept = 0;
  let confirm = 0;
  let conflicts = 0;
  for (const proposal of proposals) {
    byOrigin[proposal.origin] += 1;
    byStatus[proposal.status] += 1;
    if (inFlow(proposal)) kept += 1;
    if (proposal.needsConfirmation && proposal.status === 'PROPOSED') confirm += 1;
    if (proposal.conflictsWith && proposal.conflictsWith.length > 0) conflicts += 1;
  }
  return {
    total: proposals.length,
    byOrigin,
    byStatus,
    inFlow: kept,
    needingConfirmation: confirm,
    conflicts,
  };
}

export type { FlowExpectation };
