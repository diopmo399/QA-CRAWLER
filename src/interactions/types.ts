import type { Dialog, Download, FileChooser, Page } from 'playwright';

/**
 * Interactions qui viennent du navigateur lui-même, hors du DOM de l'application :
 * on ne peut pas les trouver avec des localisateurs et elles peuvent bloquer un flow
 * (la fenêtre native « Se connecter », alert/confirm/prompt, une nouvelle fenêtre, un téléchargement…).
 */
export const BROWSER_INTERACTION_TYPES = [
  'HTTP_AUTH',
  'JS_ALERT',
  'JS_CONFIRM',
  'JS_PROMPT',
  'POPUP',
  'NEW_TAB',
  'DOWNLOAD',
  'FILE_CHOOSER',
  'PERMISSION_REQUEST',
  'EXTERNAL_NAVIGATION',
  'UNKNOWN_BROWSER_INTERACTION',
] as const;
export type BrowserInteractionType = (typeof BROWSER_INTERACTION_TYPES)[number];

/**
 * - DETECTED : vue, rien à faire.
 * - HANDLED : un handler s'en est chargé (authentifié, dialogue répondu, popup observée…).
 * - BLOCKED : refusée par la politique de sécurité, ou demande quelque chose que le crawler ne doit pas inventer.
 * - FAILED : le handler a essayé sans réussir (identifiants refusés, délai dépassé…).
 * - SKIPPED : ignorée volontairement (fonction désactivée).
 * - UNSUPPORTED : aucun handler pour cette interaction ; un repli sûr a été appliqué.
 */
export const INTERACTION_STATUSES = [
  'DETECTED',
  'HANDLED',
  'BLOCKED',
  'FAILED',
  'SKIPPED',
  'UNSUPPORTED',
] as const;
export type InteractionStatus = (typeof INTERACTION_STATUSES)[number];

/** Pourquoi une interaction s'est terminée ainsi (codes stables pour les rapports et la CI). */
export const INTERACTION_OUTCOMES = [
  'AUTHENTICATED',
  'AUTH_REQUIRED',
  'AUTH_FAILED',
  'CREDENTIALS_NOT_ALLOWED',
  'INTERACTION_LOOP_DETECTED',
  'DIALOG_ACCEPTED',
  'DIALOG_DISMISSED',
  'PROMPT_VALUE_REQUIRED',
  'PROMPT_ANSWERED',
  'POPUP_OBSERVED',
  'POPUP_CLOSED',
  'DOWNLOAD_RECORDED',
  'FILE_INPUT_REQUIRED',
  'PERMISSION_DENIED',
  'PERMISSION_GRANTED',
  'EXTERNAL_ORIGIN',
  'BLOCKED_ORIGIN',
  'NO_HANDLER',
  'TIMEOUT',
  'ERROR',
] as const;
export type InteractionOutcome = (typeof INTERACTION_OUTCOMES)[number];

/** Où se situe une URL par rapport à la cible de la mission (voir AllowedOriginPolicy). */
export const ORIGIN_CLASSES = ['SAME_ORIGIN', 'ALLOWED_ORIGIN', 'EXTERNAL_ORIGIN', 'BLOCKED_ORIGIN'] as const;
export type OriginClass = (typeof ORIGIN_CLASSES)[number];

/** Faits non secrets sur une interaction, sûrs à journaliser et à rapporter. */
export type InteractionDetails = Record<string, string | number | boolean>;

/**
 * Ce que le navigateur permet de faire avec l'interaction. Chaque source fournit
 * la poignée native ; les handlers l'utilisent, le moteur d'exploration jamais.
 */
export type NativeHandle =
  | {
      kind: 'http-auth';
      /** Répond au défi du navigateur. Les identifiants ne vont qu'au navigateur, jamais ailleurs. */
      provideCredentials(username: string, password: string): Promise<void>;
      cancel(): Promise<void>;
    }
  | { kind: 'dialog'; dialog: Dialog }
  | { kind: 'page'; page: Page }
  | { kind: 'download'; download: Download }
  | { kind: 'file-chooser'; chooser: FileChooser }
  | { kind: 'none' };

/** Une interaction détectée par la BrowserEventDiscovery, avant d'être traitée. */
export interface BrowserInteraction {
  id: string;
  type: BrowserInteractionType;
  /** Page sur laquelle elle a eu lieu (la page d'origine pour les popups). */
  page: Page;
  sourceUrl: string;
  targetUrl?: string;
  /** Origine concernée (le serveur qui demande des identifiants, l'origine de la popup…). */
  origin?: string;
  details: InteractionDetails;
  native: NativeHandle;
  /**
   * Sortie sûre quand personne ne traite l'interaction, pour ne jamais laisser le
   * navigateur bloqué : annuler l'authentification, refuser le dialogue, fermer la popup…
   */
  fallback: () => Promise<void>;
}

/** Où en était l'exploration quand l'interaction a eu lieu. */
export interface InteractionContext {
  /** État sur lequel l'action déclenchante a été exécutée. */
  stateId?: string;
  actionId?: string;
  /** Flow imposé en cours. */
  flow?: string;
}

/** Résultat enregistré d'une interaction : rapports, graphe des flows, CLI. Ne contient jamais de secret. */
export interface BrowserInteractionResult {
  id: string;
  type: BrowserInteractionType;
  status: InteractionStatus;
  outcome?: InteractionOutcome;
  /** Handler qui s'en est occupé. */
  handler?: string;
  /** Ce qui a été fait : AUTHENTICATE, CANCEL, ACCEPT, DISMISS, OBSERVE, CLOSE, DENY… */
  action?: string;
  sourceUrl: string;
  targetUrl?: string;
  origin?: string;
  originClass?: OriginClass;
  timestamp: string;
  /** 1 pour le premier essai ; plus quand le navigateur a redemandé (nouvelle tentative). */
  attempt: number;
  retryAttempted: boolean;
  success: boolean;
  reason?: string;
  stateId?: string;
  actionId?: string;
  flow?: string;
  /** État observé dans la nouvelle page (popups, nouveaux onglets). */
  targetStateId?: string;
  /** Profil d'identifiants logique utilisé — jamais les identifiants. */
  credentialProfile?: string;
  /** Le flow ne peut pas continuer normalement (authentification requise ou refusée, boucle…). */
  blocking: boolean;
  details: InteractionDetails;
}
