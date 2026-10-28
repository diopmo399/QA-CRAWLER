/**
 * LES EXIGENCES TELLES QUE L'API LES ÉCHANGE (JSON). Le côté navigateur du SDK n'importe rien hors de
 * `core` et `ui` : ces types reprennent la forme du modèle canonique (src/requirements/model.ts), et
 * le serveur vérifie à la compilation que le modèle leur reste assignable (src/sdk/server/requirements.ts).
 */

export type SourceKind = string;

export interface SourceLocation {
  block: number;
  section?: string[];
  page?: number;
  sheet?: string;
  cell?: string;
  range?: string;
  row?: number;
  anchor?: string;
}

export interface SourceReference {
  kind: SourceKind;
  sourceId: string;
  uri?: string;
  title: string;
  location: SourceLocation;
  version?: string;
  modifiedAt?: string;
  importedAt: string;
  fingerprint: string;
  documentFingerprint?: string;
}

export type ItemKind =
  'REQUIREMENT' | 'BUSINESS_RULE' | 'ACCEPTANCE_CRITERION' | 'INFORMATION' | 'UNCLASSIFIED';
/** Une classe de règles, jamais une probabilité. */
export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW' | 'NOT_EVALUATED';
export type ImportStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'COMPLETED_WITH_WARNINGS'
  | 'FAILED'
  | 'VALIDATION_REQUIRED'
  | 'PARTIAL';
export type DuplicateStatus = 'NEW' | 'UNCHANGED' | 'SOURCE_CHANGED' | 'SAME_ID_OTHER_SOURCE' | 'SIMILAR';

export interface CriterionStructure {
  given: string[];
  when: string[];
  then: string[];
  negative: boolean;
}

export interface ImportIssue {
  severity: 'INFO' | 'WARNING' | 'ERROR';
  code: string;
  message: string;
  location?: SourceLocation;
}

export interface DuplicateCheck {
  status: DuplicateStatus;
  entityId?: string;
  similarity?: number;
  note?: string;
}

export interface ItemDecision {
  action: 'ACCEPT' | 'REJECT' | 'MERGE';
  kind?: 'REQUIREMENT' | 'BUSINESS_RULE' | 'ACCEPTANCE_CRITERION';
  title?: string;
  description?: string;
  mergeInto?: string;
  parent?: string;
  by?: string;
  at: string;
  note?: string;
}

export interface ExtractedItem {
  id: string;
  kind: ItemKind;
  confidence: Confidence;
  reasons: string[];
  externalId?: string;
  title: string;
  description: string;
  attributes: Record<string, string>;
  criterion?: CriterionStructure;
  parentExternalId?: string;
  source: SourceReference;
  duplicate: DuplicateCheck;
  decision?: ItemDecision;
  published?: { entityId: string; version: number; at: string };
}

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
  completeness: 'COMPLETE' | 'PARTIAL' | 'EMPTY';
  items: ExtractedItem[];
  issues: ImportIssue[];
  missingFromSource: string[];
}

export interface Revision {
  version: number;
  at: string;
  change: 'CREATED' | 'UPDATED' | 'MERGED' | 'SOURCE_ADDED';
  batchId: string;
  by?: string;
  note?: string;
  fingerprint: string;
  edited?: boolean;
  previous?: { title: string; description: string };
}

interface CanonicalBase {
  id: string;
  externalId?: string;
  title: string;
  description: string;
  sources: SourceReference[];
  version: number;
  history: Revision[];
  createdAt: string;
  updatedAt: string;
  validation: 'VALIDATED';
}

export interface Requirement extends CanonicalBase {
  kind: 'REQUIREMENT';
  type: 'FUNCTIONAL' | 'NON_FUNCTIONAL' | 'UNSPECIFIED';
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
  observables: string[];
}

export type CanonicalEntity = Requirement | BusinessRule | AcceptanceCriterion;

export type LinkType =
  | 'HAS_RULE'
  | 'HAS_CRITERION'
  | 'DEPENDS_ON'
  | 'DERIVED_FROM'
  | 'IMPLEMENTED_BY'
  | 'TESTED_BY'
  | 'VERIFIED_BY'
  | 'OBSERVED_IN';

export interface LinkEnd {
  kind: string;
  id: string;
  version?: string;
}

export interface LinkDecision {
  action: 'PROPOSE' | 'CONFIRM' | 'REJECT' | 'MODIFY' | 'ADD';
  at: string;
  by?: string;
  note?: string;
}

export interface TraceabilityLink {
  id: string;
  type: LinkType;
  from: LinkEnd;
  to: LinkEnd;
  origin: 'IMPORT' | 'EXPLICIT_ID' | 'DECLARED' | 'ANALYSIS' | 'MANUAL' | 'AI';
  justification: string[];
  confidence: Confidence;
  validation: 'PROPOSED' | 'CONFIRMED' | 'REJECTED';
  freshness: 'CURRENT' | 'POSSIBLY_STALE' | 'UNKNOWN';
  decisions: LinkDecision[];
  createdAt: string;
  updatedAt: string;
}

export interface ImportProfile {
  name: string;
  connector: SourceKind;
  classify: {
    idPrefixes?: Partial<Record<'REQUIREMENT' | 'BUSINESS_RULE' | 'ACCEPTANCE_CRITERION', string[]>>;
    columns?: Partial<
      Record<
        'id' | 'title' | 'description' | 'type' | 'priority' | 'status' | 'rule' | 'criterion' | 'parent',
        string
      >
    >;
  };
  options: Record<string, string | number | boolean | string[] | Record<string, number>>;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectorDescription {
  kind: SourceKind;
  label: string;
  formats: string[];
  maxBytes: number;
  capabilities: {
    headings: boolean;
    lists: boolean;
    tables: boolean;
    pages: boolean;
    versions: boolean;
    refresh: boolean;
    ocr: boolean;
  };
  limits: string[];
}
