import type { EntityEvidence, EntityEvidenceType, EntityIdentity } from './entity-evidence.js';
import type { EntityProvenance } from './provenance-resolver.js';
import { round } from './signals.js';

/**
 * ENTITY CLASSIFIER : un élément OBSERVÉ n'est pas une entité métier. Avant toute corrélation
 * métier, chaque élément suivi est classé :
 *
 *   BUSINESS_ENTITY        des indices convergent : une identité plausible ET un geste de
 *                          l'utilisateur ou une écriture (créer, ouvrir, rechercher, modifier)
 *   APPLICATION_ENTITY     un objet de l'application elle-même (une task, un espace de travail, un
 *                          micro-frontend) — attribué par le modèle de l'application
 *   TECHNICAL_ENTITY       un composant, une ressource statique, une configuration, un nom technique
 *   INFRASTRUCTURE_ENTITY  authentification (OIDC / OAuth / SAML), découverte (.well-known),
 *                          santé, métriques, télémétrie
 *   UNKNOWN                trop peu d'indices : un résultat normal, jamais forcé
 *
 * Les signaux sont des CONVENTIONS DE PROTOCOLE et de FORME (standards OpenID, chemins de santé,
 * extensions de fichiers), jamais un nom métier. Un élément technique ou d'infrastructure n'est
 * jamais promu en métier — pas même par l'IA, qui ne peut que choisir parmi les candidats.
 */
export type EntityClassification =
  'BUSINESS_ENTITY' | 'APPLICATION_ENTITY' | 'TECHNICAL_ENTITY' | 'INFRASTRUCTURE_ENTITY' | 'UNKNOWN';

export interface ClassificationDecision {
  classification: EntityClassification;
  confidence: number;
  reason: string;
  /** Les signaux retenus, lisibles (le « pourquoi »). */
  signals: string[];
  evidenceIds: string[];
  /** UNKNOWN : les classifications encore possibles (la seule liste où une IA peut choisir). */
  candidates?: EntityClassification[];
  analyzer: 'DETERMINISTIC' | 'AI_PROPOSAL';
}

export interface ClassificationSubject {
  identity: EntityIdentity;
  resources: readonly string[];
  provenance: EntityProvenance;
  lifecycle: readonly string[];
}

/** Les poids fixes de la classification métier : une décision se recalcule à la main. */
export const CLASSIFICATION_WEIGHTS = {
  base: 0.2,
  userGesture: 0.35,
  write: 0.3,
  structuralResource: 0.15,
  created: 0.1,
  threshold: 0.6,
  infrastructure: 0.95,
  infrastructureHint: 0.85,
  technical: 0.85,
  aiCap: 0.7,
} as const;

/** Protocoles et services d'infrastructure (normes, pas des noms d'application). */
const INFRASTRUCTURE_PATH =
  /(^|\/)\.well-known(\/|$)|openid-configuration|(^|\/)jwks(\.json)?(\/|$)|(^|\/)(oauth2?|oidc|openid|saml2?|sso|authorize|token|introspect|userinfo|signin-oidc|silent-renew|auth-callback|auth-redirect|callback|logout|login|logon|auth)(\/|$)|(^|\/)(health|healthz|readyz|livez|ready|alive|metrics|telemetry|beacon|ping|rum)(\/|$)/i;
/** Ressources techniques : fichiers statiques, configuration, traductions. */
const TECHNICAL_PATH =
  /\.(m?js|css|map|json|svg|png|jpe?g|gif|webp|ico|woff2?|ttf|html?)(\?|#|$)|(^|\/)(assets|static|i18n|locales?|fonts?|images?|config|configuration|env|settings|manifest)(\/|$)/i;
/** Un nom technique : des mots reliés par des tirets sans chiffre, ou un nom versionné (icon-v4-4-0). */
const TECHNICAL_NAME = /^[a-z][a-z]*(-[a-z]+)+$|^[a-z][a-z0-9]*(-[a-z0-9]+)*[-_.]v\d+([-_.]\d+)*$/i;

const GESTURES: ReadonlySet<EntityEvidenceType> = new Set([
  'USER_INPUT',
  'RESULT_SELECTED',
  'DIRECT_NAVIGATION',
  'EDIT_INPUT',
  'SAVE_ACTION',
  'DELETE_ACTION',
  'CREATE_ACTION',
  'SEARCH_ACTION',
  // La recherche par données métier qui retrouve l'entité : un geste de l'utilisateur.
  'SEARCH_RESULT',
]);
const WRITES: ReadonlySet<EntityEvidenceType> = new Set([
  'NEW_ENTITY_ID',
  // Créée (écriture acceptée), puis retrouvée par ses données : une écriture métier.
  'CORRELATED_CREATION',
  'WRITE_REQUEST',
  'UPDATE_REQUEST',
  'DELETE_REQUEST',
]);

export function classifyEntity(
  subject: ClassificationSubject,
  evidence: readonly EntityEvidence[],
  proposal?: EntityClassification,
): ClassificationDecision {
  const decision = decide(subject, evidence);
  // Une IA (facultative) choisit seulement parmi les candidats d'un UNKNOWN : jamais un élément
  // technique ou d'infrastructure promu en métier.
  if (decision.classification === 'UNKNOWN' && proposal && decision.candidates?.includes(proposal))
    return {
      ...decision,
      classification: proposal,
      confidence: CLASSIFICATION_WEIGHTS.aiCap,
      reason: `${decision.reason}; AI chose ${proposal} among the candidates`,
      analyzer: 'AI_PROPOSAL',
    };
  return decision;
}

function decide(subject: ClassificationSubject, evidence: readonly EntityEvidence[]): ClassificationDecision {
  const W = CLASSIFICATION_WEIGHTS;
  const ids = evidence.map((entry) => entry.id);
  const locations = evidence.flatMap((entry) =>
    [entry.details.url, entry.details.route].filter((value): value is string => !!value),
  );
  const value = subject.identity.value ?? '';
  const make = (
    classification: EntityClassification,
    confidence: number,
    reason: string,
    signals: string[],
    extra: Partial<ClassificationDecision> = {},
  ): ClassificationDecision => ({
    classification,
    confidence: round(Math.min(0.99, confidence)),
    reason,
    signals,
    evidenceIds: ids,
    analyzer: 'DETERMINISTIC',
    ...extra,
  });

  // ------------------------------------------------------------ infrastructure (protocoles, santé, télémétrie)
  const infrastructure = locations.filter((location) => INFRASTRUCTURE_PATH.test(pathOf(location)));
  if (infrastructure.length > 0 || INFRASTRUCTURE_PATH.test(`/${value}`)) {
    const standard = [...infrastructure, value].some((entry) =>
      /\.well-known|openid-configuration|jwks/i.test(entry),
    );
    return make(
      'INFRASTRUCTURE_ENTITY',
      standard ? W.infrastructure : W.infrastructureHint,
      standard
        ? 'a standard discovery / key resource (.well-known, OpenID configuration, JWKS)'
        : 'an authentication, health or telemetry resource',
      [...new Set(infrastructure.map(pathOf))].slice(0, 5).map((path) => `infrastructure path ${path}`),
    );
  }
  // ------------------------------------------------------------ technique (statique, configuration, nom technique)
  const technical = locations.filter((location) => TECHNICAL_PATH.test(pathOf(location)));
  if (technical.length > 0 && technical.length === locations.length)
    return make(
      'TECHNICAL_ENTITY',
      W.technical,
      'only seen through static or configuration resources',
      [...new Set(technical.map(pathOf))].slice(0, 5),
    );
  if (TECHNICAL_NAME.test(value))
    return make(
      'TECHNICAL_ENTITY',
      W.technical,
      'a technical name (words and dashes, no digit), not a record identity',
      [`name ${value}`],
    );

  // ------------------------------------------------------------ métier : des indices qui convergent
  const types = new Set(evidence.map((entry) => entry.type));
  const signals: string[] = [];
  let score = W.base;
  const gesture = [...types].some((type) => GESTURES.has(type));
  if (gesture) {
    score += W.userGesture;
    signals.push('reached through a user gesture (selection, typing, navigation, edit)');
  }
  const write = [...types].some((type) => WRITES.has(type));
  if (write) {
    score += W.write;
    signals.push('written by the application (creation, update, deletion)');
  }
  if (subject.resources.length > 0) {
    score += W.structuralResource;
    signals.push(`structural resource ${subject.resources.join('+')}`);
  }
  if (subject.provenance === 'CREATED_DURING_RECORDING') {
    score += W.created;
    signals.push('created during the recording');
  }
  if (score >= W.threshold)
    return make('BUSINESS_ENTITY', score, `business evidence converges (${signals.join('; ')})`, signals);
  return make(
    'UNKNOWN',
    score,
    signals.length
      ? `insufficient evidence for a business role (${signals.join('; ')})`
      : 'insufficient evidence: observed without any user gesture or write',
    signals,
    { candidates: ['BUSINESS_ENTITY', 'TECHNICAL_ENTITY', 'INFRASTRUCTURE_ENTITY'] },
  );
}

export type TechnicalCategory =
  'AUTHENTICATION' | 'DISCOVERY' | 'HEALTH_TELEMETRY' | 'STATIC_RESOURCE' | 'CONFIGURATION';

/**
 * Le rôle TECHNIQUE d'un chemin (appel réseau, route), par convention de protocole ou de fichier :
 * absent si rien ne le dit (le chemin peut alors être métier, ou inconnu).
 */
export function technicalCategoryOf(location: string): TechnicalRole | undefined {
  const role = categoryOf(location);
  if (!role) return undefined;
  const operation = operationOf(pathOf(location), role.category);
  return { ...role, operation, intent: TECHNICAL_INTENT[operation] };
}

/**
 * L'OPÉRATION technique (d'après les conventions de protocole) et l'INTENT TECHNIQUE qui en
 * découle : un POST /token est une ACQUISITION DE JETON (ACQUIRE_TOKEN), jamais une création.
 */
export type TechnicalOperation =
  | 'TOKEN_ACQUISITION'
  | 'AUTHORIZATION'
  | 'USER_INFO'
  | 'AUTH_REDIRECT'
  | 'LOGOUT'
  | 'AUTHENTICATION'
  | 'OPENID_DISCOVERY'
  | 'KEY_SET'
  | 'HEALTH_CHECK'
  | 'TELEMETRY'
  | 'CONFIGURATION_READ'
  | 'STATIC_RESOURCE';
export type TechnicalIntent =
  | 'ACQUIRE_TOKEN'
  | 'AUTHORIZE'
  | 'READ_USER_INFO'
  | 'AUTHENTICATE'
  | 'LOGOUT'
  | 'DISCOVER_PROVIDER'
  | 'READ_KEYS'
  | 'CHECK_HEALTH'
  | 'REPORT_TELEMETRY'
  | 'LOAD_CONFIGURATION'
  | 'LOAD_RESOURCE';
export interface TechnicalRole {
  classification: 'TECHNICAL_ENTITY' | 'INFRASTRUCTURE_ENTITY';
  category: TechnicalCategory;
  operation: TechnicalOperation;
  intent: TechnicalIntent;
  reason: string;
  confidence: number;
}
const TECHNICAL_INTENT: Record<TechnicalOperation, TechnicalIntent> = {
  TOKEN_ACQUISITION: 'ACQUIRE_TOKEN',
  AUTHORIZATION: 'AUTHORIZE',
  USER_INFO: 'READ_USER_INFO',
  AUTH_REDIRECT: 'AUTHENTICATE',
  LOGOUT: 'LOGOUT',
  AUTHENTICATION: 'AUTHENTICATE',
  OPENID_DISCOVERY: 'DISCOVER_PROVIDER',
  KEY_SET: 'READ_KEYS',
  HEALTH_CHECK: 'CHECK_HEALTH',
  TELEMETRY: 'REPORT_TELEMETRY',
  CONFIGURATION_READ: 'LOAD_CONFIGURATION',
  STATIC_RESOURCE: 'LOAD_RESOURCE',
};

function operationOf(path: string, category: TechnicalCategory): TechnicalOperation {
  const has = (pattern: string): boolean => new RegExp(`(^|/)(${pattern})(/|$)`, 'i').test(path);
  switch (category) {
    case 'DISCOVERY':
      return /(^|\/)jwks(\.json)?(\/|$)/i.test(path) ? 'KEY_SET' : 'OPENID_DISCOVERY';
    case 'HEALTH_TELEMETRY':
      return has('health|healthz|readyz|livez|ready|alive|ping') ? 'HEALTH_CHECK' : 'TELEMETRY';
    case 'CONFIGURATION':
      return 'CONFIGURATION_READ';
    case 'STATIC_RESOURCE':
      return 'STATIC_RESOURCE';
    case 'AUTHENTICATION':
      if (has('token|introspect')) return 'TOKEN_ACQUISITION';
      if (has('authorize')) return 'AUTHORIZATION';
      if (has('userinfo')) return 'USER_INFO';
      if (has('logout')) return 'LOGOUT';
      if (has('callback|auth-callback|auth-redirect|signin-oidc|silent-renew')) return 'AUTH_REDIRECT';
      return 'AUTHENTICATION';
  }
}

/** Une opération technique (authentification, découverte, santé, configuration, statique) : jamais métier. */
export function isTechnicalOperation(location: string): boolean {
  return categoryOf(location) !== undefined;
}

function categoryOf(location: string): Omit<TechnicalRole, 'operation' | 'intent'> | undefined {
  const path = pathOf(location);
  const W = CLASSIFICATION_WEIGHTS;
  if (/(^|\/)\.well-known(\/|$)|openid-configuration|(^|\/)jwks(\.json)?(\/|$)/i.test(path))
    return {
      classification: 'INFRASTRUCTURE_ENTITY',
      category: 'DISCOVERY',
      reason: 'a standard discovery / key resource (.well-known, OpenID configuration, JWKS)',
      confidence: W.infrastructure,
    };
  if (/(^|\/)(health|healthz|readyz|livez|ready|alive|metrics|telemetry|beacon|ping|rum)(\/|$)/i.test(path))
    return {
      classification: 'INFRASTRUCTURE_ENTITY',
      category: 'HEALTH_TELEMETRY',
      reason: 'a health, metrics or telemetry resource',
      confidence: W.infrastructureHint,
    };
  if (INFRASTRUCTURE_PATH.test(path))
    return {
      classification: 'INFRASTRUCTURE_ENTITY',
      category: 'AUTHENTICATION',
      reason: 'an authentication resource (OIDC / OAuth / SAML, login, callback, token)',
      confidence: W.infrastructureHint,
    };
  if (/(^|\/)(config|configuration|env|settings|manifest)(\/|$|\.)/i.test(path))
    return {
      classification: 'TECHNICAL_ENTITY',
      category: 'CONFIGURATION',
      reason: 'an application configuration resource',
      confidence: W.technical,
    };
  if (TECHNICAL_PATH.test(path))
    return {
      classification: 'TECHNICAL_ENTITY',
      category: 'STATIC_RESOURCE',
      reason: 'a static resource (script, style, font, image, translation)',
      confidence: W.technical,
    };
  return undefined;
}

/** Une entité qui peut porter des événements et des relations métier (jamais technique ni infrastructure). */
export function isBusinessCandidate(classification: EntityClassification | undefined): boolean {
  return classification === undefined || classification === 'BUSINESS_ENTITY' || classification === 'UNKNOWN';
}

function pathOf(location: string): string {
  try {
    return new URL(location, 'http://local.invalid').pathname;
  } catch {
    return location;
  }
}
