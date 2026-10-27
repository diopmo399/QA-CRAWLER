/**
 * LE MODÈLE CANONIQUE DES EXIGENCES : le même pour toutes les sources (Confluence, Word, Excel,
 * PDF…). Une source n'apporte que des blocs et leur provenance ; le modèle, les statuts et les
 * décisions sont communs. Rien n'est publié dans le référentiel sans décision humaine.
 */

/** Les sources connues. Un connecteur ajouté plus tard prend un nouveau nom sans changer le modèle. */
export const SOURCE_KINDS = ['CONFLUENCE', 'WORD', 'EXCEL', 'PDF'] as const;
export type KnownSourceKind = (typeof SOURCE_KINDS)[number];
export type SourceKind = KnownSourceKind | (string & { readonly brand?: 'SourceKind' });

/** Où se trouve un élément dans sa source : selon le format, page, feuille, cellule, section… */
export interface SourceLocation {
  /** Rang du bloc dans le document extrait (ordre de lecture), toujours présent. */
  block: number;
  /** Les titres qui l'englobent, du plus haut au plus proche. */
  section?: string[];
  /** Numéro de page (PDF). */
  page?: number;
  /** Feuille et cellule ou plage (Excel). */
  sheet?: string;
  cell?: string;
  range?: string;
  /** Rang de la ligne dans un tableau (1 = première ligne de données). */
  row?: number;
  /** Ancre ou identifiant de l'élément dans la source, si elle en donne un. */
  anchor?: string;
}

/** LA PROVENANCE d'un élément importé. */
export interface SourceReference {
  kind: SourceKind;
  /** Identifiant stable de la source (identifiant de page, chemin normalisé d'un fichier…). */
  sourceId: string;
  /** URL ou chemin lisible (jamais une URL qui porte un jeton). */
  uri?: string;
  /** Nom du document ou titre de la page. */
  title: string;
  location: SourceLocation;
  /** Version ou révision donnée par la source (numéro de version Confluence…). */
  version?: string;
  /** Dernière modification donnée par la source. */
  modifiedAt?: string;
  importedAt: string;
  /** Empreinte du texte de l'élément (changements). */
  fingerprint: string;
  /** Empreinte du document entier, quand elle a un sens. */
  documentFingerprint?: string;
}

export const ITEM_KINDS = [
  'REQUIREMENT',
  'BUSINESS_RULE',
  'ACCEPTANCE_CRITERION',
  'INFORMATION',
  'UNCLASSIFIED',
] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

/**
 * La confiance d'une classification ou d'un lien. Ce sont des CLASSES DE RÈGLES (documentées dans
 * `classify.ts` et `docs/requirements/`), pas des probabilités : aucune calibration ne le justifierait.
 */
export const CONFIDENCE_LEVELS = ['HIGH', 'MEDIUM', 'LOW', 'NOT_EVALUATED'] as const;
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

export const REQUIREMENT_TYPES = ['FUNCTIONAL', 'NON_FUNCTIONAL', 'UNSPECIFIED'] as const;
export type RequirementType = (typeof REQUIREMENT_TYPES)[number];

/** Un critère d'acceptation structuré quand la forme le permet ; le texte reste la référence. */
export interface CriterionStructure {
  given: string[];
  when: string[];
  then: string[];
  /** Cas négatif (« ne doit pas », « refusé », « erreur »). */
  negative: boolean;
}

export const IMPORT_STATUSES = [
  'PENDING',
  'RUNNING',
  'COMPLETED',
  'COMPLETED_WITH_WARNINGS',
  'FAILED',
  'VALIDATION_REQUIRED',
  'PARTIAL',
] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

export const ISSUE_SEVERITIES = ['INFO', 'WARNING', 'ERROR'] as const;
export type IssueSeverity = (typeof ISSUE_SEVERITIES)[number];

/** Un problème d'importation, dit tel quel (jamais masqué) et localisé quand c'est possible. */
export interface ImportIssue {
  severity: IssueSeverity;
  code: string;
  message: string;
  location?: SourceLocation;
}

/**
 * Le résultat de la recherche de doublons pour un candidat :
 *   NEW                    rien de proche dans le référentiel ;
 *   UNCHANGED              même élément, même source, même texte (déjà importé) ;
 *   SOURCE_CHANGED         même identifiant et même source, texte modifié dans la source ;
 *   SAME_ID_OTHER_SOURCE   même identifiant venu d'une autre source (conflit à résoudre) ;
 *   SIMILAR                texte proche sans identifiant commun : une fusion PROPOSÉE, jamais faite seule.
 */
export const DUPLICATE_STATUSES = [
  'NEW',
  'UNCHANGED',
  'SOURCE_CHANGED',
  'SAME_ID_OTHER_SOURCE',
  'SIMILAR',
] as const;
export type DuplicateStatus = (typeof DUPLICATE_STATUSES)[number];

export interface DuplicateCheck {
  status: DuplicateStatus;
  /** L'élément du référentiel concerné. */
  entityId?: string;
  /** Similarité (0..1) pour SIMILAR : un indice de proximité des mots, pas une probabilité. */
  similarity?: number;
  note?: string;
}

export const DECISION_ACTIONS = ['ACCEPT', 'REJECT', 'MERGE'] as const;
export type DecisionAction = (typeof DECISION_ACTIONS)[number];

/** La décision humaine sur un candidat. Une suggestion automatique ne l'écrase jamais. */
export interface ItemDecision {
  action: DecisionAction;
  /** ACCEPT : le type retenu (corrige la classification). */
  kind?: Exclude<ItemKind, 'INFORMATION' | 'UNCLASSIFIED'>;
  /** Corrections du texte. */
  title?: string;
  description?: string;
  /** MERGE : l'élément du référentiel qui absorbe le candidat. */
  mergeInto?: string;
  /** Le parent retenu (exigence ou règle) d'une règle ou d'un critère, par identifiant externe ou interne. */
  parent?: string;
  /** Qui a décidé (tel que l'appelant le déclare ; voir Q1). */
  by?: string;
  at: string;
  note?: string;
}

/** UN CANDIDAT extrait d'une source, en attente de décision. */
export interface ExtractedItem {
  /** Identifiant du candidat dans son lot. */
  id: string;
  kind: ItemKind;
  confidence: Confidence;
  /** Les règles qui ont produit la classification (explicabilité). */
  reasons: string[];
  /** Identifiant présent dans la source (REQ-12…). */
  externalId?: string;
  title: string;
  description: string;
  /** Attributs lus dans la source (priorité, statut, type…), tels quels. */
  attributes: Record<string, string>;
  criterion?: CriterionStructure;
  /** Le parent proposé (identifiant externe de l'exigence ou de la règle précédente dans la section). */
  parentExternalId?: string;
  source: SourceReference;
  duplicate: DuplicateCheck;
  decision?: ItemDecision;
  /** Ce que la publication a produit pour ce candidat. */
  published?: { entityId: string; version: number; at: string };
}

/** UN LOT D'IMPORTATION : une source lue, ses candidats, ses problèmes, ses décisions. */
export interface ImportBatch {
  id: string;
  connector: SourceKind;
  status: ImportStatus;
  createdAt: string;
  updatedAt: string;
  source: {
    sourceId: string;
    title: string;
    uri?: string;
    version?: string;
    modifiedAt?: string;
    documentFingerprint?: string;
  };
  /** COMPLETE : tout a été lu ; PARTIAL : une partie n'a pas pu l'être (voir issues) ; EMPTY. */
  completeness: 'COMPLETE' | 'PARTIAL' | 'EMPTY';
  items: ExtractedItem[];
  issues: ImportIssue[];
  /** Éléments du référentiel venus de cette source mais absents de cette version (jamais supprimés). */
  missingFromSource: string[];
}

export const REVISION_CHANGES = ['CREATED', 'UPDATED', 'MERGED', 'SOURCE_ADDED'] as const;
export type RevisionChange = (typeof REVISION_CHANGES)[number];

export interface Revision {
  version: number;
  at: string;
  change: RevisionChange;
  batchId: string;
  by?: string;
  note?: string;
  fingerprint: string;
  /** Le texte a été corrigé par une personne (et non repris tel quel de la source). */
  edited?: boolean;
  /** Le texte avant la révision (historique lisible). */
  previous?: { title: string; description: string };
}

interface CanonicalBase {
  /** Identifiant interne stable, attribué à la création, jamais réutilisé. */
  id: string;
  externalId?: string;
  title: string;
  description: string;
  /** Toutes les provenances (une exigence peut venir de plusieurs sources). */
  sources: SourceReference[];
  version: number;
  history: Revision[];
  createdAt: string;
  updatedAt: string;
  /** Publiée après décision humaine. */
  validation: 'VALIDATED';
}

export interface Requirement extends CanonicalBase {
  kind: 'REQUIREMENT';
  type: RequirementType;
  priority?: string;
  status?: string;
  dependsOn: string[];
}

export interface BusinessRule extends CanonicalBase {
  kind: 'BUSINESS_RULE';
  preconditions: string[];
  conditions: string[];
  expected?: string;
  exceptions: string[];
  constraints: string[];
}

export interface AcceptanceCriterion extends CanonicalBase {
  kind: 'ACCEPTANCE_CRITERION';
  structure?: CriterionStructure;
  /** Les éléments observables qui permettent de vérifier le résultat (à compléter par une personne). */
  observables: string[];
}

export type CanonicalEntity = Requirement | BusinessRule | AcceptanceCriterion;

/** Les types de lien du référentiel (correspondance avec le moteur : docs/requirements/AUDIT-ET-CONCEPTION.md, D6). */
export const LINK_TYPES = [
  'HAS_RULE',
  'HAS_CRITERION',
  'DEPENDS_ON',
  'DERIVED_FROM',
  'IMPLEMENTED_BY',
  'TESTED_BY',
  'VERIFIED_BY',
  'OBSERVED_IN',
] as const;
export type LinkType = (typeof LINK_TYPES)[number];

/** D'où vient un lien proposé. */
export const LINK_ORIGINS = ['IMPORT', 'EXPLICIT_ID', 'DECLARED', 'ANALYSIS', 'MANUAL', 'AI'] as const;
export type LinkOrigin = (typeof LINK_ORIGINS)[number];

export const LINK_VALIDATIONS = ['PROPOSED', 'CONFIRMED', 'REJECTED'] as const;
export type LinkValidation = (typeof LINK_VALIDATIONS)[number];

export const FRESHNESS = ['CURRENT', 'POSSIBLY_STALE', 'UNKNOWN'] as const;
export type Freshness = (typeof FRESHNESS)[number];

export interface LinkEnd {
  /** REQUIREMENT, BUSINESS_RULE, ACCEPTANCE_CRITERION, CODE, TEST, ASSERTION, EVIDENCE, OPERATION… */
  kind: string;
  id: string;
  /** La version de l'élément quand le lien a été établi (version canonique, commit, révision). */
  version?: string;
}

export interface LinkDecision {
  action: 'PROPOSE' | 'CONFIRM' | 'REJECT' | 'MODIFY' | 'ADD';
  at: string;
  by?: string;
  note?: string;
}

/** UNE RELATION TYPÉE entre deux éléments, avec son origine, sa justification et ses décisions. */
export interface TraceabilityLink {
  id: string;
  type: LinkType;
  from: LinkEnd;
  to: LinkEnd;
  origin: LinkOrigin;
  /** Les éléments réels qui motivent le lien (texte, identifiant cité, fichier et ligne…). */
  justification: string[];
  confidence: Confidence;
  validation: LinkValidation;
  freshness: Freshness;
  decisions: LinkDecision[];
  createdAt: string;
  updatedAt: string;
}

/**
 * UN PROFIL D'IMPORTATION réutilisable : la normalisation (préfixes, correspondance des colonnes) et
 * les réglages du connecteur (feuilles, ligne d'en-tête…), enregistrés sous un nom.
 */
export interface ImportProfile {
  name: string;
  connector: SourceKind;
  classify: {
    idPrefixes?: Partial<Record<'REQUIREMENT' | 'BUSINESS_RULE' | 'ACCEPTANCE_CRITERION', string[]>>;
    columns?: Partial<
      Record<'id' | 'title' | 'description' | 'type' | 'priority' | 'status' | 'rule' | 'criterion', string>
    >;
  };
  /** Réglages du connecteur, sans secret ni contenu (ex. Excel : `{ sheets, headerRow }`). */
  options: Record<string, string | number | boolean | string[]>;
  createdAt: string;
  updatedAt: string;
}

/** Le référentiel d'un projet : ce qui est publié, et les liens. */
export interface RequirementsRepository {
  formatVersion: 1;
  entities: CanonicalEntity[];
  links: TraceabilityLink[];
}
