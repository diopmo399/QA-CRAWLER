import type { ExtractedDocument } from './document.js';
import type { ImportIssue, SourceKind } from './model.js';

/**
 * LE CONTRAT D'UN CONNECTEUR DE SOURCE. Un connecteur ACCÈDE à sa source et EXTRAIT des blocs avec
 * leur provenance ; il ne classe pas, ne détecte pas les doublons, ne persiste rien et ne corrèle
 * rien. Ajouter une source = écrire un connecteur ; le modèle et le moteur ne changent pas.
 */
export interface ConnectorDescription {
  kind: SourceKind;
  label: string;
  /** Les formats acceptés (extensions de fichier, variantes d'API). */
  formats: string[];
  /** Taille maximale d'une entrée, en octets. */
  maxBytes: number;
  capabilities: {
    headings: boolean;
    lists: boolean;
    tables: boolean;
    /** La source a des pages (PDF). */
    pages: boolean;
    /** La source donne une version ou une révision. */
    versions: boolean;
    /** La même source peut être relue (actualisation). */
    refresh: boolean;
    ocr: boolean;
  };
  /** Ce que le connecteur ne sait pas faire, dit à l'utilisateur. */
  limits: string[];
}

export interface ExtractionContext {
  /** L'heure de l'importation (horloge injectée pour les tests). */
  now: Date;
  /** L'annulation de l'importation. */
  signal?: AbortSignal;
  /** Les variables d'environnement d'où lire les secrets (par nom, jamais passés en argument). */
  env: NodeJS.ProcessEnv;
}

export interface SourceConnector<Input> {
  readonly kind: SourceKind;
  describe(): ConnectorDescription;
  /** Vérifier l'entrée avant tout accès (format, taille, URL, noms de secrets) : des problèmes, ou rien. */
  validate(input: Input, context: ExtractionContext): ImportIssue[];
  /**
   * Lire la source et rendre ses blocs. Une erreur d'accès (authentification, permission, réseau,
   * source introuvable) est levée comme `ConnectorError` ; une lecture partielle est rendue avec
   * `completeness: 'PARTIAL'` et ses problèmes, jamais comme complète.
   */
  extract(input: Input, context: ExtractionContext): Promise<ExtractedDocument>;
}

export const CONNECTOR_ERROR_CODES = [
  'INVALID_INPUT',
  'TOO_LARGE',
  'AUTHENTICATION',
  'PERMISSION',
  'NOT_FOUND',
  'RATE_LIMITED',
  'NETWORK',
  'TIMEOUT',
  'UNSUPPORTED',
  'CORRUPTED',
  'CANCELLED',
] as const;
export type ConnectorErrorCode = (typeof CONNECTOR_ERROR_CODES)[number];

/** Une erreur d'accès ou d'extraction : son code, un message sans secret. */
export class ConnectorError extends Error {
  constructor(
    readonly code: ConnectorErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ConnectorError';
  }
}
