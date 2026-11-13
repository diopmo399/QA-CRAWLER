import type { MapLayer } from '../sdk/core/cartography.js';
import type { SpringConfig } from './config.js';
import type { GatewayFacts } from './gateway.js';

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
  /** L'appel passe par une méthode d'enveloppe (« ApiClient#post ») qui reçoit l'URL en paramètre. */
  via?: string;
  /** L'URL telle qu'écrite, quand elle n'a pas pu être résolue statiquement, et pourquoi. */
  expression?: string;
  unresolved?: string;
  /**
   * La base de l'URL tirée de la configuration (fichiers environment, fournisseur d'un jeton injecté) :
   * ce qui la justifie (expression, valeur, fichiers).
   */
  base?: string;
  /** La clé environment de la base quand ses fichiers ne concordent pas (une valeur par configuration). */
  baseKey?: string;
  loc: Loc;
}

/**
 * Un symbole du frontal suivi à travers les stores et les flux RxJS : une méthode (`Classe#méthode`) ou un
 * flux (`Classe.propriété` : Subject, BehaviorSubject…, ou Observable calculé par pipe/combineLatest…).
 */
export interface UiSymbol {
  id: string;
  kind: 'METHOD' | 'STREAM';
  owner: string;
  name: string;
  /** STORE : classe qui garde un état RxJS (Subject…) et l'expose ; SERVICE : injectable sans état RxJS. */
  role: 'COMPONENT' | 'STORE' | 'SERVICE' | 'CLASS';
  /** Méthode de composant : appelée par le gabarit, par le cycle de vie, ou seulement en interne. */
  entry?: 'TEMPLATE' | 'LIFECYCLE' | 'INTERNAL';
  stream?: {
    kind: 'SUBJECT' | 'DERIVED';
    /** Subject, BehaviorSubject, ReplaySubject, AsyncSubject. */
    type?: string;
    operators: string[];
    /** Comment le flux est consommé : souscription explicite, pipe async d'un gabarit, via un flux qui en
     * dérive, ou nulle part (un Observable non souscrit n'est jamais exécuté). */
    consumed: 'SUBSCRIBED' | 'ASYNC' | 'DERIVED' | 'NONE';
    consumers?: string[];
    /** Les expressions de filter() (texte, borné) et les propriétés lues par map()/filter(). */
    filters?: string[];
    reads?: string[];
  };
  /**
   * Une méthode générique vue dans un contexte d'appel (`OrderStore#dispatch⟨OrderAction.Submit⟩`) : `of` est
   * la méthode, `context` la valeur transmise qui choisit ses branches ; `branches` compte celles qui restent
   * (sûres ou non déterminées) et celles écartées par cette valeur.
   */
  of?: string;
  context?: string;
  branches?: { kept: number; pruned: number; unknown: number };
  loc: Loc;
}

/**
 * Un lien entre deux symboles du frontal. Déclenchement : CALL (appel de méthode), EMIT (next() sur un
 * Subject), PROPAGATES (une émission traverse un flux qui en dérive), PIPE (le traitement d'un flux appelle
 * une méthode : switchMap…), OUTPUT (@Output d'un enfant → gestionnaire du parent). Données : DERIVES (un
 * flux est calculé à partir d'un autre), FEEDS (la réponse d'un appel alimente un flux).
 */
export interface UiLink {
  from: string;
  to: string;
  /**
   * SUBSCRIBES : l'INSTALLATION d'un abonnement (la méthode, souvent ngOnInit, s'abonne au flux une fois) ;
   * la PROPAGATION (émission → rappel) est un autre lien, du flux vers le rappel.
   */
  kind: 'CALL' | 'EMIT' | 'PROPAGATES' | 'PIPE' | 'OUTPUT' | 'DERIVES' | 'FEEDS' | 'SUBSCRIBES';
  confidence: 'CONFIRMED' | 'PROBABLE' | 'UNKNOWN';
  reason: string;
  /** Les conditions qui entourent l'appel (« action = OrderAction.Submit », « valid est faux »…). */
  condition?: string;
  /** Ce qui doit s'être produit avant : réponse attendue (await, subscribe), erreur, minuterie, opérateur. */
  async?: string;
  /** La provenance des arguments (« payload = résultat de this.validate(form) »). */
  data?: string;
  /** Le contexte d'appel retenu pour une méthode générique (valeur de l'action transmise). */
  context?: string;
  /**
   * La nature temporelle du lien : DIRECT (appel synchrone), AFTER_RESULT (après une réponse, une émission
   * ou un await), ON_ERROR, ON_COMPLETE (fin du flux, sans valeur), ON_EVENT, DEFERRED (minuterie),
   * UNDEMONSTRATED (rappel dont l'appel n'est pas démontré). `concurrent` : peut se chevaucher avec d'autres
   * traitements ; `cancellable` : une nouvelle émission ou un opérateur peut l'interrompre.
   */
  timing?:
    'DIRECT' | 'AFTER_RESULT' | 'ON_ERROR' | 'ON_COMPLETE' | 'ON_EVENT' | 'DEFERRED' | 'UNDEMONSTRATED';
  concurrent?: boolean;
  cancellable?: boolean;
  loc: Loc;
}

/** L'étape exacte où une chaîne de preuves s'interrompt, depuis une méthode d'un composant. */
export interface UiDiagnostic {
  /** Composant#méthode d'où part la chaîne. */
  from: string;
  /** Le symbole où elle s'arrête. */
  at: string;
  code:
    | 'SERVICE_NOT_FOUND'
    | 'CLASS_AMBIGUOUS'
    | 'METHOD_NOT_FOUND'
    | 'SUBJECT_NO_CONSUMER'
    | 'STREAM_NOT_SUBSCRIBED'
    | 'OBSERVABLE_NOT_SUBSCRIBED'
    | 'NO_HTTP'
    | 'URL_DYNAMIC'
    | 'CYCLE'
    | 'LIMIT'
    | 'CONTEXT_UNRESOLVED'
    | 'ACTION_FACTORY_UNRESOLVED'
    | 'ALIAS_AMBIGUOUS'
    | 'ASYNC_NOT_DEMONSTRATED'
    | 'UI_DYNAMIC';
  message: string;
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

/** Une condition lue dans un gabarit : l'expression brute, telle qu'écrite (jamais évaluée). */
export interface UiCondition {
  expression: string;
  /** if : bloc `@if` ; ngIf : `*ngIf` ; hidden : `[hidden]` (visible quand l'expression est fausse) ;
   * else : branche `@else` (visible quand l'expression est fausse) ; disabled : `[disabled]`. */
  how: 'if' | 'ngIf' | 'hidden' | 'else' | 'case' | 'disabled' | 'selected';
  loc: Loc;
}

/** Un conteneur (section, bloc conditionnel…) ou un bouton d'un gabarit, avec son parent. */
export interface UiElement {
  /** Stable : composant, sorte, nom (et rang si le nom se répète). */
  id: string;
  component: string;
  kind: 'CONTAINER' | 'BUTTON';
  name: string;
  tag: string;
  parent?: string;
  /** Les contrôles de formulaire directement dedans (hors conteneurs imbriqués). */
  fields: string[];
  visibleWhen?: UiCondition;
  disabledWhen?: UiCondition;
  /** La méthode du composant appelée par le bouton (`(click)`, ou `(ngSubmit)` du formulaire). */
  handler?: string;
  submit?: boolean;
  /** L'événement qui déclenche l'élément (click, ngSubmit, une sortie d'un composant…), et son expression. */
  event?: string;
  expression?: string;
  /** Ce que l'expression déclenche, résolu dans le TypeScript (méthode, ou méthode vue dans un contexte). */
  target?: string;
  targetContext?: string;
  /** L'expression ne désigne aucune méthode résolue (gestionnaire dynamique, objet inconnu). */
  unresolved?: string;
  /** Un groupe d'onglets ou un onglet (Angular Material, ng-bootstrap, PrimeNG, composant maison). */
  tab?: UiTab;
  loc: Loc;
}

/** Ce qui fait d'un conteneur un groupe d'onglets ou un onglet, tel que le gabarit le montre. */
export interface UiTab {
  role: 'GROUP' | 'TAB';
  /** material, ngb, primeng, custom (balise ou rôle ARIA), route (lien d'onglet vers une route). */
  library: 'material' | 'ngb' | 'primeng' | 'custom' | 'route';
  /** Le libellé quand il est écrit dans le gabarit (attribut, gabarit de libellé, lien). */
  label?: string;
  /** Contenu instancié seulement à la sélection : gabarit différé, @defer, outlet, route. */
  lazy?: 'TEMPLATE' | 'DEFER' | 'OUTLET' | 'ROUTE';
  /** Onglets générés par une boucle : l'expression, et les libellés lus dans le tableau de la classe. */
  repeat?: string;
  items?: string[];
  /** routerLink d'un onglet routé. */
  route?: string;
  /** Groupe : l'expression qui choisit l'onglet actif (`[selectedIndex]`, `[activeId]`…). */
  selectedBy?: UiCondition;
}

/** Un composant affiché dans le gabarit d'un autre (balise, ngComponentOutlet), et où. */
export interface UiChild {
  /** Le composant parent. */
  component: string;
  /** La balise (`app-history`) ou la classe (ngComponentOutlet). */
  tag?: string;
  className?: string;
  /** Le conteneur (onglet…) qui l'affiche ; absent : à la racine du gabarit. */
  container?: string;
  /** Affiché seulement plus tard (gabarit différé, @defer, outlet). */
  lazy?: 'TEMPLATE' | 'DEFER' | 'OUTLET';
  loc: Loc;
}

/** D'où vient un membre du composant lu par une condition. */
export interface UiState {
  component: string;
  member: string;
  /** RESPONSE : affecté depuis la réponse d'un appel ; GETTER : accesseur calculé ; FORM : état du
   * formulaire ; INPUT : entrée du composant ; LOCAL : valeur posée dans le composant. */
  kind: 'RESPONSE' | 'GETTER' | 'FORM' | 'INPUT' | 'LOCAL' | 'STREAM';
  /** STREAM : le flux lu (`Classe.propriété`), par le pipe async ou une propriété du composant. */
  stream?: string;
  /** Service#méthode de l'appel dont la réponse est lue. */
  call?: string;
  property?: string;
  expression?: string;
  /** Les méthodes du composant qui écrivent ce membre (`this.x = …`, `this.x.set(…)`, `.update(…)`). */
  writers?: { method: string; how: 'ASSIGN' | 'SET' | 'UPDATE'; loc: Loc }[];
  loc: Loc;
}

/** Une méthode du composant et les appels de service qu'elle fait. */
export interface UiHandler {
  component: string;
  method: string;
  calls: string[];
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
  /** La structure des gabarits : conteneurs, boutons, conditions ; l'origine des états ; les gestionnaires. */
  elements?: UiElement[];
  states?: UiState[];
  handlers?: UiHandler[];
  /** Les composants affichés dans d'autres (onglets compris). */
  children?: UiChild[];
  /** Les stores, flux RxJS et appels traversés (absents des scans d'avant : rien n'est supposé). */
  symbols?: UiSymbol[];
  links?: UiLink[];
  diagnostics?: UiDiagnostic[];
  /**
   * Les règles du proxy de développement (proxy.conf.json) : préfixe, cible, réécriture du chemin. Une
   * réécriture (`"^/api": ""`) est la seule preuve qui permet de retirer un préfixe pour comparer les routes.
   */
  proxies?: {
    context: string;
    target?: string;
    rewrite?: { pattern: string; replacement: string };
    file: string;
    line: number;
    /** La configuration Angular (angular.json) qui utilise ce fichier ; absente : la configuration par défaut. */
    variant?: string;
    /** Ce qui n'a pas pu être interprété statiquement (process.env, fonction, import…). */
    dynamic?: string;
    secure?: boolean;
    changeOrigin?: boolean;
  }[];
  /** Les clés des fichiers environment, valeur par fichier (une valeur absente : clé non déclarée là). */
  environment?: { key: string; values: { file: string; value?: string }[] }[];
  /** Les configurations Angular (angular.json) : fichiers environment remplacés, fichier de proxy. */
  variants?: { name: string; replacements: { replace: string; with: string }[]; proxyConfig?: string }[];
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
  /**
   * La route vient d'un type parent (interface générée, classe de base) : le type qui porte l'annotation et
   * où, et le contrôleur concret qui l'expose.
   */
  via?: {
    type: string;
    file: string;
    line: number;
    /** Le type vient d'une dépendance Maven (absent des sources) : son artefact et ce qui a été lu. */
    artifact?: string;
    read?: 'SOURCES_JAR' | 'CLASS';
  };
  controller?: string;
  loc: Loc;
}

/**
 * Un contrôleur concret et ses types parents : ceux lus dans la source et ceux ABSENTS (une interface générée
 * au build, non versionnée) avec leur nom qualifié tiré des imports. Ses méthodes qui implémentent un parent
 * absent (`@Override`, sans annotation de route lisible) sont listées : leur route ne peut venir que du
 * contrat d'où l'interface est générée.
 */
export interface JavaImplementation {
  controller: string;
  /** Le préfixe de type que le contrôleur déclare lui-même (`@RequestMapping` de la classe), s'il existe. */
  basePath?: string;
  missing: { name: string; qualified?: string }[];
  methods: { name: string; arity: number; handler: string; loc: Loc }[];
  loc: Loc;
}

/** Un appel sur un objet dont le type est importé mais absent de la source (client généré, bibliothèque). */
/** La base d'un client généré, réglée dans un bean : propriété lue (`@Value`) ou texte écrit, et sa condition. */
export interface JavaClientBase {
  /** Le type configuré (`ApiClient`). */
  type: string;
  property?: string;
  value?: string;
  /** `@Profile` du bean ou de sa classe : la base ne vaut que dans cette variante. */
  profile?: string;
  /** `@ConditionalOnProperty` du bean, en clair (non évaluée). */
  condition?: string;
  loc: Loc;
}

export interface JavaClientCall {
  /** La méthode appelante (symbole). */
  from: string;
  type: string;
  qualified: string;
  operation: string;
  loc: Loc;
}

/** Le préfixe sous lequel l'application expose ses routes, lu dans sa configuration. */
export interface JavaExposure {
  key: string;
  value: string;
  file: string;
  line: number;
  /** Le profil Spring qui la déclare (absent : la variante par défaut). */
  profile?: string;
}

export interface JavaMethod {
  id: string;
  name: string;
  owner: string;
  role: JavaRole;
  /** Spring Data : lecture ou écriture d'après le nom (save…, find…), ou d'après sa requête `@Query`. */
  access?: 'READ' | 'WRITE';
  /** La requête `@Query` d'une méthode de dépôt (JPQL ou SQL natif). */
  query?: { text: string; native: boolean };
  loc: Loc;
}

/** Un accès aux données lu dans le corps d'une méthode (EntityManager, JdbcTemplate). */
export interface JavaDataAccess {
  /** La méthode qui accède. */
  from: string;
  mechanism: 'JPQL' | 'NATIVE_SQL' | 'JDBC' | 'ENTITY_MANAGER';
  /** SELECT, INSERT, UPDATE, DELETE ; UNKNOWN quand le texte de la requête n'est pas lisible. */
  operation: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'UNKNOWN';
  /** Entités (JPQL, `find(X.class)`) ou tables (SQL) citées par la requête. */
  targets: { name: string; kind: 'ENTITY' | 'TABLE' }[];
  statement?: string;
  via: string;
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
  /** L'adresse du service appelé n'est pas lue (base d'une interface HTTP réglée à l'exécution). */
  addressUnknown?: boolean;
  loc: Loc;
}

export interface JavaCall {
  from: string;
  to?: string;
  status: 'STATICALLY_RESOLVED' | 'INFERRED' | 'UNKNOWN';
  /** Comment la cible a été trouvée, quand ce n'est pas le type du receveur (implémentation, @Primary…). */
  via?: string;
  /** Appel ambigu : toutes les cibles possibles (implémentations sans désignation), dont celle-ci. */
  candidates?: string[];
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

/** Un champ dont la valeur est calculée par une méthode (`dto.setX(service.m(…))`, `.x(service.m(…))`). */
export interface JavaComputed {
  toClass: string;
  toField: string;
  /** La classe et la méthode appelées (« EligibilityService.canValidate »). */
  callee: string;
  method: string;
  loc: Loc;
}

/** Une méthode qui rend un booléen : ses boucles, ses prédicats et les données qu'elle lit (bornés). */
export interface JavaDecision {
  owner: string;
  name: string;
  loops: number;
  predicates: string[];
  reads: string[];
  /** Les types des paramètres (pour relier une entité lue). */
  params: string[];
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
  computed?: JavaComputed[];
  decisions?: JavaDecision[];
  implementations?: JavaImplementation[];
  clients?: JavaClientCall[];
  /** Les accès aux données hors Spring Data (EntityManager, JdbcTemplate), classés par opération. */
  dataAccess?: JavaDataAccess[];
  /** Les bases d'URL données aux clients générés par un bean (`apiClient.setBasePath(url)`). */
  clientBases?: JavaClientBase[];
  exposure?: JavaExposure[];
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

export interface ApiParameter {
  name: string;
  /** path, query, header, cookie (OpenAPI 3) ; body, formData (Swagger 2). */
  in: string;
  required: boolean;
  type?: string;
}

export interface ApiOperation {
  id: string;
  method: string;
  /** Le chemin comparé jusqu'ici : celui de `paths`, préfixé du `basePath` d'un contrat Swagger 2. */
  path: string;
  /** Le chemin tel qu'écrit sous `paths`, sans base. */
  route?: string;
  /**
   * Les préfixes que le contrat déclare pour cette opération : chemins de ses `servers` (opération, chemin
   * ou document, variables remplacées par leur valeur par défaut) ou `basePath` (Swagger 2).
   */
  bases?: string[];
  operationId?: string;
  summary?: string;
  tags: string[];
  request?: string;
  response?: string;
  /** Paramètres du chemin et de l'opération, références résolues. */
  params?: ApiParameter[];
  /** Les extensions `x-…` de l'opération (valeurs simples, bornées). */
  extensions?: Record<string, string>;
  /** Le document qui déclare l'opération. */
  document?: string;
  /** Les références `$ref` de l'opération qui n'ont pas pu être suivies. */
  unresolved?: string[];
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
  /** Les autres fichiers de la source atteints par ses `$ref`. */
  refs?: string[];
  /** Les références qui n'ont pas pu être suivies, et pourquoi (distante, hors de la source, absente…). */
  unresolved?: { ref: string; cause: string }[];
}

export interface OpenApiFacts {
  operations: ApiOperation[];
  schemas: ApiSchema[];
  documents?: ApiDocument[];
  warnings: string[];
}

/** Une dépendance Maven ; `managed` : sa version vient d'un `dependencyManagement` (module ou parent). */
export interface MavenDependency {
  groupId?: string;
  artifactId: string;
  version?: string;
  scope?: string;
  /** `jar` par défaut ; `pom` pour un BOM importé. */
  type?: string;
  classifier?: string;
  optional?: boolean;
  /** Les dépendances indirectes écartées (`groupe:artefact`, `*` permis). */
  exclusions?: string[];
  managed?: boolean;
  line: number;
}

/**
 * Une génération de code déclarée par un plugin (openapi-generator, swagger-codegen) ou une production de
 * contrat depuis le code (springdoc). `spec` dit où est le contrat d'entrée : fichier de la source, ressource
 * d'un artefact dépendant (dépaqueté ou sur le classpath du plugin), ou pourquoi il n'est pas établi.
 */
export interface MavenGeneration {
  plugin: 'openapi-generator' | 'swagger-codegen' | 'springdoc';
  execution?: string;
  generator?: string;
  library?: string;
  inputSpec?: string;
  spec?: { file?: string; artifact?: string; resource?: string; unresolved?: string };
  apiPackage?: string;
  modelPackage?: string;
  interfaceOnly?: boolean;
  useTags?: boolean;
  /** La version du plugin de génération (résolue), et les options de génération lues telles quelles. */
  version?: string;
  options?: Record<string, string>;
  /** Le profil qui la déclare (absente : build par défaut). */
  profile?: string;
  line: number;
}

export interface MavenModule {
  /** Le pom.xml, relatif à la racine de la source. */
  file: string;
  groupId?: string;
  artifactId: string;
  version?: string;
  packaging?: string;
  parent?: { groupId?: string; artifactId: string; version?: string; relativePath?: string };
  modules: string[];
  properties: Record<string, string>;
  dependencies: MavenDependency[];
  managed: MavenDependency[];
  profiles: string[];
  /** Les profils : activation déclarée (activeByDefault, propriété, jdk, fichier) et propriétés propres. */
  profileDetails?: { id: string; activation?: string; properties: Record<string, string>; line: number }[];
  generations: MavenGeneration[];
  /** Les dossiers de sources ajoutés (build-helper) : du code généré qui peut être absent de la source. */
  sourceDirs: string[];
  /** Les propriétés `${…}` restées sans valeur lisible. */
  unresolved: string[];
}

export interface MavenFacts {
  modules: MavenModule[];
  warnings: string[];
}

export interface SourceFacts {
  sourceId: string;
  layer: MapLayer;
  revision?: string;
  /** La version des analyseurs qui ont produit ces faits : un scan incrémental ne reprend que les faits de
   * la version courante (absente : faits d'avant, toujours réanalysés). */
  analyzer?: string;
  ui?: UiFacts;
  java?: JavaFacts;
  openapi?: OpenApiFacts;
  maven?: MavenFacts;
  /** La configuration Spring par entrée et par profil (valeurs secrètes masquées). */
  config?: SpringConfig;
  /** Les limites atteintes à la lecture de la source (fichiers, durée) : ses faits sont partiels. */
  partial?: string[];
  /** Les routes de passerelle lues (Spring Cloud Gateway, NGINX, Ingress), avec leur preuve. */
  gateway?: GatewayFacts;
}
