import type { BrowserInteractionsConfig } from '../config/config.js';
import type { BrowserInteraction, InteractionOutcome, OriginClass } from '../interactions/types.js';
import type { AllowedOriginPolicy } from './origin-policy.js';
import type { SafetyPolicy } from './safety-policy.js';

/** Décision de sécurité pour une interaction du navigateur, prise avant l'exécution de tout handler. */
export interface InteractionDecision {
  verdict: 'ALLOW' | 'BLOCK';
  reason: string;
  /** Résultat enregistré quand l'interaction est bloquée. */
  outcome?: InteractionOutcome;
  originClass?: OriginClass;
  /** HTTP_AUTH : profil d'identifiants que le handler peut utiliser. */
  credentialProfile?: string;
  /** Dialogues : quoi répondre. */
  dialog?: { accept: boolean; value?: string | { env: string } };
}

/**
 * Les règles de la SafetyPolicy appliquées aux interactions qui ne viennent pas du
 * DOM. Rien n'est accepté « juste pour continuer l'exploration » :
 * - les identifiants ne vont qu'aux origines autorisées, depuis un profil configuré ;
 * - confirm() n'est jamais accepté quand son message semble destructif ou modificateur ;
 * - prompt() n'est répondu qu'avec une valeur écrite dans la mission ;
 * - les sélecteurs de fichier ne reçoivent jamais de fichier ; les permissions sont refusées sauf si la mission les accorde ;
 * - les popups et navigations vers des origines externes ou bloquées ne sont pas suivies.
 */
export class InteractionPolicy {
  constructor(
    private readonly config: BrowserInteractionsConfig,
    private readonly safety: SafetyPolicy,
    private readonly origins: AllowedOriginPolicy,
  ) {}

  evaluate(interaction: BrowserInteraction): InteractionDecision {
    const url = interaction.origin ?? interaction.targetUrl ?? interaction.sourceUrl;
    const originClass = this.origins.classify(url);
    const withOrigin = originClass ? { originClass } : {};

    switch (interaction.type) {
      case 'HTTP_AUTH': {
        if (originClass === 'BLOCKED_ORIGIN') {
          return {
            verdict: 'BLOCK',
            outcome: 'CREDENTIALS_NOT_ALLOWED',
            reason: 'origin is blocked by the mission',
            ...withOrigin,
          };
        }
        const allowedOrigins = this.config.httpAuth.origins;
        const trusted =
          allowedOrigins.length > 0
            ? interaction.origin !== undefined && allowedOrigins.includes(interaction.origin)
            : originClass === 'SAME_ORIGIN' || originClass === 'ALLOWED_ORIGIN';
        if (!trusted) {
          return {
            verdict: 'BLOCK',
            outcome: 'CREDENTIALS_NOT_ALLOWED',
            reason: `credentials are not sent to ${interaction.origin ?? 'this origin'} (not in browserInteractions.httpAuth.origins / allowed hosts)`,
            ...withOrigin,
          };
        }
        const profile = this.config.httpAuth.credentialProfile;
        if (!profile) {
          return {
            verdict: 'BLOCK',
            outcome: 'AUTH_REQUIRED',
            reason:
              'no credential profile configured for HTTP authentication (browserInteractions.httpAuth.credentialProfile)',
            ...withOrigin,
          };
        }
        return {
          verdict: 'ALLOW',
          reason: `credential profile "${profile}"`,
          credentialProfile: profile,
          ...withOrigin,
        };
      }

      case 'JS_ALERT':
        return {
          verdict: 'ALLOW',
          reason: `alert: ${this.config.dialogs.alert}`,
          dialog: { accept: this.config.dialogs.alert === 'accept' },
        };

      case 'JS_CONFIRM': {
        if (this.config.dialogs.confirm === 'dismiss') {
          return { verdict: 'ALLOW', reason: 'confirm() is dismissed by default', dialog: { accept: false } };
        }
        const message = String(interaction.details.message ?? '');
        const classified = this.safety.classify({ type: 'click', category: 'other', text: message });
        return classified.classification === 'SAFE'
          ? { verdict: 'ALLOW', reason: 'harmless confirmation', dialog: { accept: true } }
          : {
              verdict: 'ALLOW',
              reason: `never confirmed automatically: ${classified.classification} (${classified.reason})`,
              dialog: { accept: false },
            };
      }

      case 'JS_PROMPT': {
        const message = String(interaction.details.message ?? '');
        const answer = this.config.dialogs.promptValues.find((candidate) =>
          message.includes(candidate.match),
        );
        if (!answer) {
          return {
            verdict: 'BLOCK',
            outcome: 'PROMPT_VALUE_REQUIRED',
            reason:
              'no value for this prompt in browserInteractions.dialogs.promptValues: dismissed, nothing invented',
          };
        }
        return {
          verdict: 'ALLOW',
          reason: `value from promptValues ("${answer.match}")`,
          dialog: { accept: true, value: answer.value },
        };
      }

      case 'POPUP':
      case 'NEW_TAB': {
        if (originClass === 'EXTERNAL_ORIGIN' || originClass === 'BLOCKED_ORIGIN') {
          return {
            verdict: 'BLOCK',
            outcome: originClass === 'BLOCKED_ORIGIN' ? 'BLOCKED_ORIGIN' : 'EXTERNAL_ORIGIN',
            reason: 'new page outside the allowed origins: closed without being explored',
            originClass,
          };
        }
        return { verdict: 'ALLOW', reason: 'new page on an allowed origin', ...withOrigin };
      }

      case 'DOWNLOAD':
        return { verdict: 'ALLOW', reason: 'recorded only: never saved nor opened', ...withOrigin };

      case 'FILE_CHOOSER':
        return {
          verdict: 'BLOCK',
          outcome: 'FILE_INPUT_REQUIRED',
          reason: 'a file is requested: the crawler never picks a file by itself',
          ...withOrigin,
        };

      case 'PERMISSION_REQUEST': {
        const permission = String(interaction.details.permission ?? '');
        const granted = (this.config.permissions.grant as readonly string[]).includes(permission);
        return granted
          ? { verdict: 'ALLOW', reason: `"${permission}" granted by the mission`, ...withOrigin }
          : {
              verdict: 'BLOCK',
              outcome: 'PERMISSION_DENIED',
              reason: `"${permission}" is not granted (browserInteractions.permissions.grant): denied`,
              ...withOrigin,
            };
      }

      case 'EXTERNAL_NAVIGATION':
        return {
          verdict: 'BLOCK',
          outcome: originClass === 'BLOCKED_ORIGIN' ? 'BLOCKED_ORIGIN' : 'EXTERNAL_ORIGIN',
          reason: 'navigation outside the allowed origins is not explored',
          ...withOrigin,
        };

      case 'UNKNOWN_BROWSER_INTERACTION':
        return {
          verdict: 'BLOCK',
          outcome: 'NO_HANDLER',
          reason: 'unknown browser interaction',
          ...withOrigin,
        };
    }
  }
}
