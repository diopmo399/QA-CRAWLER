import type { BrowserInteractionResult } from '../interactions/types.js';
import type { Severity } from '../model/issue.js';

/**
 * Seul endroit où les anomalies reçoivent leur gravité : la politique peut être
 * relue et ajustée sans toucher aux observateurs ni au moteur d'exploration.
 */
export const SeverityRules = {
  /** Réponse HTTP d'une sous-ressource (appel d'API, script, image…). */
  httpResponse(status: number): Severity {
    if (status >= 500) return 'ERROR';
    if (status === 401 || status === 403) return 'WARNING';
    if (status >= 400) return 'WARNING';
    return 'INFO';
  },

  /** Document principal d'une page visitée. Une page absente ou en échec est toujours une erreur. */
  pageResponse(status: number): Severity {
    if (status >= 500) return 'ERROR';
    if (status === 404 || status === 410) return 'ERROR';
    if (status >= 400) return 'WARNING';
    return 'INFO';
  },

  /** Échec réseau (DNS, connexion refusée, CORS, annulation…). */
  requestFailed(isDocument: boolean): Severity {
    return isDocument ? 'ERROR' : 'WARNING';
  },

  /** Un champ encore invalide une fois le formulaire rempli : mauvaises données de test, ou bug de validation. */
  formValidation(): Severity {
    return 'WARNING';
  },

  consoleError(): Severity {
    return 'ERROR';
  },

  consoleWarning(): Severity {
    return 'WARNING';
  },

  /** Exception non interceptée dans la page. */
  pageError(): Severity {
    return 'ERROR';
  },

  /** Plantage du processus de rendu. */
  pageCrash(): Severity {
    return 'CRITICAL';
  },

  /** Une étape de flow imposé a échoué ou a été bloquée ; les étapes optionnelles ne font qu'avertir. */
  flowStep(optional: boolean): Severity {
    return optional ? 'WARNING' : 'ERROR';
  },

  /**
   * Interaction du navigateur hors du DOM. Les bloquantes (authentification
   * requise ou refusée, boucle) sont des erreurs ; ce que le crawler ne doit pas
   * faire seul (choisir un fichier, répondre à un prompt) et les interactions
   * inconnues sont des avertissements ; le reste est seulement enregistré.
   */
  browserInteraction(result: BrowserInteractionResult): Severity | undefined {
    if (result.blocking) return 'ERROR';
    if (
      result.status === 'UNSUPPORTED' ||
      result.status === 'FAILED' ||
      result.outcome === 'FILE_INPUT_REQUIRED' ||
      result.outcome === 'PROMPT_VALUE_REQUIRED'
    )
      return 'WARNING';
    return undefined;
  },

  /** Navigation qui n'a pas pu aboutir (délai dépassé, boucle de redirection, redirection hors du site…). */
  navigationFailure(kind: 'timeout' | 'redirect-loop' | 'external-redirect' | 'other'): Severity {
    return kind === 'external-redirect' ? 'WARNING' : 'ERROR';
  },
} as const;
