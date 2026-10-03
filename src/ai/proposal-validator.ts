import {
  intelligenceProposalSchema,
  type IntelligenceAction,
  type IntelligenceProposal,
  type IntelligenceRequest,
} from './model.js';

export type ProposalRejection =
  | 'AI_PROPOSAL_INVALID_SCHEMA'
  | 'AI_PROPOSAL_UNKNOWN_ACTION'
  | 'AI_PROPOSAL_INVALID_EVIDENCE'
  | 'AI_PROPOSAL_CONTRADICTS_RUNTIME'
  | 'AI_PROPOSAL_INCOMPATIBLE'
  | 'AI_PROPOSAL_EMPTY';

export type ProposalValidation =
  | {
      valid: true;
      proposal: IntelligenceProposal;
      /** L'action proposée, résolue parmi celles DÉCOUVERTES par QA-Crawler. */
      action?: IntelligenceAction;
      checks: string[];
    }
  | { valid: false; rejection: ProposalRejection; reasons: string[]; proposal?: IntelligenceProposal };

/**
 * EVIDENCE VALIDATOR (§37) : une preuve citée doit EXISTER dans l'EvidenceStore (ou dans la
 * requête). Une seule preuve inventée fait rejeter la proposition : elle n'est jamais « ignorée ».
 */
export function validateEvidence(
  ids: readonly string[],
  request: IntelligenceRequest,
  knownEvidence: (id: string) => boolean,
): string[] {
  const inRequest = new Set(request.relevantEvidence.map((evidence) => evidence.id));
  return ids.filter((id) => !inRequest.has(id) && !knownEvidence(id));
}

/**
 * INTELLIGENCE PROPOSAL VALIDATOR (§36) : le schéma, puis la réalité.
 *
 *   schéma strict → l'action existe (parmi les actions découvertes) → elle n'est pas
 *   contredite par le runtime (désactivée) → les preuves citées existent → la proposition
 *   est compatible avec la requête (identifiants autorisés, plan borné).
 *
 * La SafetyPolicy n'est PAS jugée ici : elle l'est ensuite, par le code qui l'a toujours jugée.
 */
export function validateIntelligenceProposal(
  raw: unknown,
  request: IntelligenceRequest,
  knownEvidence: (id: string) => boolean,
): ProposalValidation {
  const parsed = intelligenceProposalSchema.safeParse(raw);
  if (!parsed.success)
    return {
      valid: false,
      rejection: 'AI_PROPOSAL_INVALID_SCHEMA',
      reasons: parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    };
  const proposal = parsed.data;
  const checks = ['schema valid'];
  const byId = new Map(request.availableActions.map((action) => [action.id, action]));
  const referenced = [
    ...(proposal.selectedActionId ? [proposal.selectedActionId] : []),
    ...(proposal.plan?.steps ?? []),
  ];
  const unknown = referenced.filter((id) => !byId.has(id));
  if (unknown.length > 0)
    return {
      valid: false,
      rejection: 'AI_PROPOSAL_UNKNOWN_ACTION',
      reasons: unknown.map((id) => `${id} is not an action discovered on this screen (fabricated reference)`),
      proposal,
    };
  const outside = referenced.filter((id) => !request.constraints.allowedActionIds.includes(id));
  if (outside.length > 0)
    return {
      valid: false,
      rejection: 'AI_PROPOSAL_INCOMPATIBLE',
      reasons: outside.map((id) => `${id} is not among the actions this request allows`),
      proposal,
    };
  if ((proposal.plan?.steps.length ?? 0) > request.constraints.maxPlanSteps)
    return {
      valid: false,
      rejection: 'AI_PROPOSAL_INCOMPATIBLE',
      reasons: [`plan longer than ${String(request.constraints.maxPlanSteps)} step(s)`],
      proposal,
    };
  const action = proposal.selectedActionId ? byId.get(proposal.selectedActionId) : undefined;
  if (action?.disabled)
    return {
      valid: false,
      rejection: 'AI_PROPOSAL_CONTRADICTS_RUNTIME',
      reasons: [`${action.id} (${action.type} "${action.name}") is disabled at runtime`],
      proposal,
    };
  if (referenced.length > 0) checks.push('every referenced action exists');
  const fabricated = validateEvidence(
    [...proposal.supportingEvidenceIds, ...(proposal.hypothesis?.evidenceIds ?? [])],
    request,
    knownEvidence,
  );
  if (fabricated.length > 0)
    return {
      valid: false,
      rejection: 'AI_PROPOSAL_INVALID_EVIDENCE',
      reasons: fabricated.map((id) => `evidence ${id} does not exist`),
      proposal,
    };
  if (proposal.supportingEvidenceIds.length > 0) checks.push('every cited evidence exists');
  if (
    proposal.status === 'PROPOSAL' &&
    !proposal.selectedActionId &&
    !proposal.plan &&
    !proposal.hypothesis &&
    !proposal.proposedGoal &&
    !proposal.failureCategory &&
    !proposal.missingPrecondition &&
    !proposal.workflowPhase
  )
    return {
      valid: false,
      rejection: 'AI_PROPOSAL_EMPTY',
      reasons: ['a PROPOSAL without content'],
      proposal,
    };
  return { valid: true, proposal, ...(action ? { action } : {}), checks };
}
