import type { FlowAllowance } from '../config/flow-schema.js';
import type { DiscoveredAction } from '../model/discovered-action.js';
import type { SafetyPolicy, SafetyVerdict } from '../policies/safety-policy.js';

export interface FlowStepPermission {
  /** Classes que l'étape permet explicitement en plus de SAFE. */
  allow: readonly FlowAllowance[];
  /** La valeur saisie dans le champ vient d'une variable d'environnement. */
  valueFromEnv?: boolean;
}

/**
 * Contrôle de sécurité des étapes de flow imposé : le YAML a choisi l'élément, la
 * SafetyPolicy décide quand même s'il peut s'exécuter.
 *
 * - SAFE : s'exécute.
 * - MUTATION / UNKNOWN : seulement quand l'étape dit `allow: MUTATION` / `allow: UNKNOWN`.
 * - DANGEROUS (supprimer, payer, envoyer, déconnexion, irréversible…) : seulement quand
 *   l'étape dit `allow: DANGEROUS` ET que la mission liste DANGEROUS dans allowedActionClasses.
 * - Liens : les hôtes autorisés et les chemins ignorés s'appliquent toujours.
 * - Champs sensibles (mot de passe, OTP, secret) : remplis seulement à partir d'une
 *   variable d'environnement ; les champs de paiement (carte, IBAN…) ne sont jamais remplis.
 */
export function evaluateFlowAction(
  safety: SafetyPolicy,
  action: DiscoveredAction,
  permission: FlowStepPermission,
): SafetyVerdict {
  const isField =
    action.type === 'fill' ||
    action.type === 'select' ||
    action.type === 'check' ||
    action.type === 'uncheck';
  if (isField) {
    if (!action.risks.includes('sensitive-data')) return { verdict: 'ALLOW', reason: action.reason };
    if (safety.isPaymentField(action)) {
      return { verdict: 'BLOCK', reason: 'payment field (card, IBAN…): never filled automatically' };
    }
    if (action.type === 'fill' && permission.valueFromEnv === true) {
      return {
        verdict: 'ALLOW',
        reason: 'sensitive field filled from an environment variable (value never logged)',
      };
    }
    return {
      verdict: 'BLOCK',
      reason:
        'sensitive field (password, secret…): its value must come from an environment variable ({ env: NAME })',
    };
  }

  if (action.classification === 'DANGEROUS') {
    if (!safety.isExecutionAllowed('DANGEROUS'))
      return {
        verdict: 'BLOCK',
        reason: `DANGEROUS actions are not allowed by the mission (${action.reason}): list DANGEROUS in safety.allowedActionClasses`,
      };
    if (!permission.allow.includes('DANGEROUS'))
      return {
        verdict: 'BLOCK',
        reason: `DANGEROUS action (${action.reason}): add "allow: DANGEROUS" to this step to execute it`,
      };
  }
  if (action.href && (action.type === 'navigate' || action.external === true)) {
    const verdict = evaluateFlowUrl(safety, action.href);
    if (verdict.verdict === 'BLOCK') return verdict;
  }
  if (action.classification === 'MUTATION' && !permission.allow.includes('MUTATION')) {
    return {
      verdict: 'BLOCK',
      reason: `MUTATION action (${action.reason}): add "allow: MUTATION" to this step to execute it`,
    };
  }
  if (action.classification === 'UNKNOWN' && !permission.allow.includes('UNKNOWN')) {
    return {
      verdict: 'BLOCK',
      reason: `UNKNOWN action (${action.reason}): add "allow: UNKNOWN" to this step to execute it`,
    };
  }
  return { verdict: 'ALLOW', reason: action.reason };
}

/** Une étape `goto` ou la cible d'un lien : hôtes autorisés, chemins ignorés, URL dangereuses. */
export function evaluateFlowUrl(safety: SafetyPolicy, href: string): SafetyVerdict {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return { verdict: 'BLOCK', reason: `invalid URL ${href}` };
  }
  const classified = safety.classifyUrl(url.toString());
  if (classified.classification === 'DANGEROUS') {
    return { verdict: 'BLOCK', reason: `DANGEROUS URL is never opened (${classified.reason})` };
  }
  const decision = safety.navigation.evaluate(url);
  if (!decision.allowed) {
    return { verdict: 'BLOCK', reason: `navigation refused: ${decision.reason} (${decision.detail})` };
  }
  return { verdict: 'ALLOW', reason: 'navigation allowed' };
}
