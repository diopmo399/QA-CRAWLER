import type { SafetyPolicy } from '../policies/safety-policy.js';
import type { GoalSafetyJudgement } from './test-goals.js';

/**
 * La SafetyPolicy juge l'action qui réaliserait un objectif — un clic sur ce libellé —
 * avec les mêmes classify() et evaluate() que toute action découverte, sans rien
 * exécuter. Un refus rend l'objectif BLOCKED : jamais exécuté, jamais favorisé.
 */
export function judgeGoalAction(policy: SafetyPolicy, label: string | undefined): GoalSafetyJudgement {
  if (!label) return { allowed: true, classification: 'SAFE', reason: 'no triggering action' };
  const classification = policy.classify({ type: 'click', category: 'submit', text: label });
  const verdict = policy.evaluate({
    id: 'goal',
    stateId: 'goal',
    type: 'click',
    category: 'submit',
    elementType: 'button',
    text: label,
    disabled: false,
    visible: true,
    classification: classification.classification,
    reason: classification.reason,
    risks: classification.risks,
    locator: { strategy: 'text', value: label },
  });
  return {
    allowed: verdict.verdict === 'ALLOW',
    classification: classification.classification,
    reason: verdict.verdict === 'ALLOW' ? classification.reason : verdict.reason,
  };
}
