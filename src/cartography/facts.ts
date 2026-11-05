import type { MapLayer } from '../sdk/core/cartography.js';

/**
 * LES FAITS D'UNE SOURCE, tels que ses analyseurs les ont lus (sérialisables : un scan incrémental reprend
 * ceux d'une source inchangée). Le graphe est construit ensuite, à partir des faits de toutes les sources.
 */
export interface Loc {
  file: string;
  line: number;
}

export interface UiRoute {
  path: string;
  component?: string;
  title?: string;
  loc: Loc;
}

export interface UiComponent {
  name: string;
  selector?: string;
  loc: Loc;
}

export interface UiField {
  /** composant#formulaire.contrôle */
  id: string;
  component: string;
  control: string;
  label?: string;
  /** for : `<label for>` relié à l'id ; near : libellé voisin ; mat-label ; placeholder. */
  labelHow?: 'for' | 'near' | 'mat-label' | 'placeholder';
  tag?: string;
  inputType?: string;
  /** « required », « maxLength:120 »… */
  validators: string[];
  /** Le gabarit relie un élément à ce contrôle. */
  bound: boolean;
  loc: Loc;
}

export interface UiCall {
  /** Service#méthode */
  id: string;
  owner: string;
  method: string;
  path?: string;
  bodyType?: string;
  loc: Loc;
}

export interface UiFlow {
  field?: string;
  component?: string;
  requestProperty?: string;
  dtoProperty?: string;
  call?: string;
  resolved: boolean;
  reason?: string;
  loc: Loc;
}

export interface UiRead {
  field?: string;
  call?: string;
  responseProperty?: string;
  loc: Loc;
}

export interface UiDto {
  name: string;
  properties: { name: string; type?: string; optional: boolean }[];
  loc: Loc;
}

export interface UiFacts {
  routes: UiRoute[];
  components: UiComponent[];
  fields: UiField[];
  calls: UiCall[];
  flows: UiFlow[];
  reads: UiRead[];
  dtos: UiDto[];
  warnings: string[];
}

export type JavaRole = 'DTO' | 'ENTITY' | 'REPOSITORY' | 'SERVICE' | 'CONTROLLER' | 'CLIENT' | 'OTHER';

export interface JavaField {
  name: string;
  type: string;
  /** @JsonProperty("…") */
  jsonName?: string;
  required: boolean;
  validations: string[];
  /** Entité : la colonne (@Column(name) ou le nommage par défaut). */
  column?: string;
  columnHow?: 'annotation' | 'default';
  maxLength?: number;
  line: number;
}

export interface JavaClass {
  name: string;
  qualified: string;
  role: JavaRole;
  table?: string;
  tableHow?: 'annotation' | 'default';
  /** Dépôt Spring Data : l'entité gérée. */
  repositoryOf?: string;
  fields: JavaField[];
  loc: Loc;
}

export interface JavaEndpoint {
  id: string;
  method: string;
  path: string;
  /** L'identifiant du symbole de la méthode du contrôleur. */
  handler: string;
  handlerName: string;
  requestBody?: string;
  returns?: string;
  validated?: boolean;
  loc: Loc;
}

export interface JavaMethod {
  id: string;
  name: string;
  owner: string;
  role: JavaRole;
  /** Spring Data : lecture ou écriture d'après le nom (save…, find…). */
  access?: 'READ' | 'WRITE';
  loc: Loc;
}

export interface JavaOutgoing {
  from: string;
  method?: string;
  path?: string;
  status: 'STATICALLY_RESOLVED' | 'INFERRED' | 'UNKNOWN';
  /** Le type de l'objet envoyé dans le corps, quand le code le montre. */
  bodyType?: string;
  /** Le type de la réponse attendue, lu sur la ligne de l'appel (`Resultat.class`). */
  responseType?: string;
  /** L'origine de l'URL (« https://hôte ») quand elle est lue dans le code ou la configuration. */
  origin?: string;
  client?: string;
  /** Les clés de configuration lues pour l'URL. */
  properties?: string[];
  loc: Loc;
}

export interface JavaCall {
  from: string;
  to?: string;
  status: 'STATICALLY_RESOLVED' | 'INFERRED' | 'UNKNOWN';
  loc: Loc;
}

/** Une correspondance explicite lue dans le code (`a.setX(b.getY())`, `Type.builder().x(b.getY())`). */
export interface JavaMapping {
  fromClass: string;
  fromField: string;
  toClass: string;
  toField: string;
  how: 'setter' | 'builder';
  method: string;
  loc: Loc;
}

export interface JavaFacts {
  classes: JavaClass[];
  endpoints: JavaEndpoint[];
  methods: JavaMethod[];
  outgoing: JavaOutgoing[];
  calls: JavaCall[];
  mappings: JavaMapping[];
  /** Les lectures et écritures d'une entité par un dépôt, lues à l'appel (`repository.save(x)`). */
  repositoryAccess?: JavaRepositoryAccess[];
  warnings: string[];
}

export interface JavaRepositoryAccess {
  /** La méthode appelante. */
  from: string;
  repository: string;
  entity: string;
  operation: string;
  access: 'READ' | 'WRITE';
  loc: Loc;
}

export interface ApiOperation {
  id: string;
  method: string;
  path: string;
  operationId?: string;
  summary?: string;
  tags: string[];
  request?: string;
  response?: string;
  loc: Loc;
}

export interface ApiSchemaProperty {
  name: string;
  type: string;
  format?: string;
  required: boolean;
  maxLength?: number;
  pattern?: string;
}

export interface ApiSchema {
  name: string;
  properties: ApiSchemaProperty[];
  loc: Loc;
}

/** Un document de contrat (fichier OpenAPI/Swagger) : ce qu'il déclare de lui-même. */
export interface ApiDocument {
  file: string;
  format: string;
  title?: string;
  version?: string;
  /** Lien de documentation déclaré par le contrat (`externalDocs.url`), seulement s'il est http(s). */
  documentation?: string;
  servers: string[];
}

export interface OpenApiFacts {
  operations: ApiOperation[];
  schemas: ApiSchema[];
  documents?: ApiDocument[];
  warnings: string[];
}

export interface SourceFacts {
  sourceId: string;
  layer: MapLayer;
  revision?: string;
  ui?: UiFacts;
  java?: JavaFacts;
  openapi?: OpenApiFacts;
}
