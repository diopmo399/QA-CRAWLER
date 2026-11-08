# Changelog

Versions selon [SemVer](https://semver.org). `@qa-crawler/core` et `@qa-crawler/cli` partagent le même numéro.

## Unreleased

### Serveur du SDK : stockage hybride (base + stockage objet)

- `qa-crawler sdk-server --storage hybrid` : le dossier de travail devient un cache. Fichiers texte en
  base (PostgreSQL, SQL Server, SQLite ; migration additive `006_add_workspace_mirror`), fichiers lourds
  ou binaires dans un stockage objet (dossier monté, S3 et compatibles, Azure Blob), indexés en base,
  dédupliqués par empreinte.
- Restauration avant de servir, envoi toutes les `--sync-interval` secondes, dernier envoi à l'arrêt
  (code de sortie 1 s'il est incomplet), bail d'écriture unique en base (`--storage-takeover` après un
  arrêt brutal, état `LEASE_LOST` pour un serveur dépossédé).
- Secrets dans l'environnement seulement (`QA_DB_*`, `QA_OBJECTS_*`) ; S3 signé en Signature Version 4,
  Azure en Shared Key ou SAS, sans SDK tiers.
- `GET /api/storage`, `POST /api/storage/sync` (administrateur), `client.storage.status()` et `sync()`,
  option `storage` de `startSdkServer`.
- CI : le contrat du miroir sur PostgreSQL et SQL Server réels, et les stockages objet sur moto (S3 avec
  vérification des signatures) et Azurite.

### Cartographie : onglet « Parcours & Graphe »

- Une fonctionnalité de bout en bout en quatre couloirs ordonnés (Angular → BFF → Backend → API
  externe), groupés par nature : stores et services SPA dans Angular, règles métier et persistance
  Hibernate/JPA dans le backend, seulement les services tiers établis dans le couloir externe.
- Relations réunies en faisceaux comptés par catégorie (contient, visible si, dépend de, appelle, flux de
  données, persistance, API externe) ; « Tout » ne trace jamais une ligne par relation. Focus sur un
  élément, tableau paginé de toutes les relations avec statut et preuve, onglets du haut et du bas.
- Lacunes dites avec leur cause : couche absente ou non atteinte, aucun store, éléments non reliés,
  appels non démontrés ou non classés, dépendances non lues, ruptures, coupe à 20 000 relations.
- Route `GET /cartography/feature-map` et `client.cartography.featureMap` ; au plus 40 cartes par groupe
  (les plus reliées), le reste compté. Zoom distinct de « Centrer », ajustement lisible à l'ouverture,
  plein écran.

### Cartographie : contrats d'API des dépendances Maven

- Un contrôleur qui implémente une interface publiée dans un jar de contrat expose ses endpoints : le jar
  de sources, sinon les classes compilées (bytecode lu, jamais chargé), avec les routes héritées et les
  surcharges ; la preuve pointe le fichier du jar.
- Dépendances résolues par application : parents, propriétés, BOM importés, `dependencyManagement`,
  scopes, exclusions, la plus proche l'emporte (conflits notés) ; état par artefact dans
  `scan.sources[].dependencies` et types introuvables dans `unresolvedTypes`.
- Dépôts locaux (lecture seule), cache, dépôts distants autorisés (https, identifiants par nom de variable,
  empreinte SHA-1 vérifiée), mode hors ligne, limites de taille, de nombre et de durée. Désactivé par
  défaut : `--maven-repo`, `--maven-remote`, `--maven-auth`, `--maven-cache`, `--maven-offline`
  (`mavenContracts` dans `startSdkServer`).
- Clients `@HttpExchange` et `@FeignClient` lus dans un jar : appel sortant reconstruit ; sans adresse lue,
  la corrélation BFF → Backend reste `PROBABLE`.
- Version d'analyseur `cartography-10`.

### Cartographie : fiabilisation de la résolution

- Appels Java sur interface ou classe abstraite : implémentation par une classe abstraite intermédiaire,
  méthode héritée d'un type parent, surcharges distinguées par l'arité ; plusieurs implémentations : `@Primary`,
  bean nommé comme le champ, sinon toutes gardées `UNKNOWN` avec leurs candidates. Une classe abstraite
  n'est plus présentée comme l'implémentation exécutée.
- Appels dont la cible est une classe (méthode héritée d'une bibliothèque) : reliés à la classe au lieu
  d'être perdus ; relations non raccordables comptées dans `scan.unattached`.
- Imports Java à la demande pris en compte pour départager les homonymes ; classes homonymes de paquets
  différents : deux nœuds `SERVICE` (nom qualifié) au lieu d'un seul ; champs typés par nom qualifié résolus.
- Fragments de dépôt Spring Data suivis jusqu'à leur implémentation ; plus de lecture déduite du nom pour
  une méthode écrite à la main.
- Frontal : une constante exportée d'un autre fichier forme l'URL d'un appel HTTP (avec sa provenance).
- Lecture sous limite : manifestes et code avant les données ; fichiers non lus nommés.
- Version d'analyseur `cartography-9`.

### Cartographie : premier chargement

- Le scan est écrit en JSON compact, et son relevé dans un fichier léger à côté (`<id>.record.json`) :
  lister les scans ne relit plus chaque scan complet (482 ms → 1 ms sur 5 scans de 6 240 nœuds). Un scan
  plus ancien reçoit son relevé à la première lecture ; l'élagage retire les deux fichiers.
- Le serveur ne relit le scan complet que pour construire l'index : un index en cache en dispense (résumé
  chaud 1 055 ms → 4 ms, page de fonctionnalités 617 ms → 4 ms), et le résumé ne liste plus les scans deux
  fois. Une lecture en échec n'est pas gardée en cache.
- L'écran Cartographie se montre dès que le projet et le résumé sont arrivés (premier contenu à froid
  3 592 ms → 389 ms) ; la liste, la fonctionnalité et ses champs suivent dans leur panneau.
- Les pages de champs d'une fonctionnalité sont gardées par version des données et par requête : rouvrir
  une fonctionnalité visitée ne lance plus aucune requête (715 ms → 86 ms, 0 requête).

### Cartographie : moteur d'investigation

- Moteur d'investigation déterministe au-dessus du graphe (`src/cartography/investigate.ts`) : objectif,
  sens, mode ciblé ou exhaustif, budget (nœuds, branche, nature, profondeur, voisins non causaux, temps),
  exploration meilleur d'abord, natures de relation (cause, donnée, condition, contrat, composition) et sens
  du flux, règles causales (composition, appartenance, lien non démontré), stratégies aux ruptures avec
  tentatives mémorisées, hypothèses (candidates, étayées, contradictoires), cycles par composantes fortement
  connexes avec leurs sorties, chemins démontrables par branche, mesures et limites.
- Reprise ciblée d'une branche (« Explorer cette branche ») sans refaire ce qui est validé ; investigation
  périmée après un nouveau scan, relance reliée à la précédente.
- Routes `…/cartography/investigations` (lancer, lister, lire, reprendre, relancer) et client ; persistance
  des 50 dernières investigations par projet.
- Ruptures typées de l'analyseur du frontal conservées sur les méthodes (`detail.breaks`).
- Fenêtre « Investigation » dans Structure & Conditions.
- Extension facultative de pistes (`applyAdvice`) : désactivée, vérifiée par le graphe, jamais une preuve.

### Cartographie : traçabilité de bout en bout

- Version d'analyseur `cartography-8`.
- Constantes Java lues entre fichiers (imports statiques, `Classe.CHAMP`, même paquetage) : les routes
  écrites avec des constantes d'une autre classe sont résolues.
- Accès aux données hors Spring Data : `EntityManager` (JPQL, SQL natif, `find`, `persist`, `merge`,
  `remove`) et JDBC (`JdbcTemplate`, `NamedParameterJdbcTemplate`, `JdbcClient`), classés en lecture,
  insertion, mise à jour, suppression ou indéterminé ; `@Query` classée ; opération et requête portées par
  le lien (`MapEdge.detail.operation`, `statement`). Table non déclarée par une entité : nœud propre, lien
  probable.
- Écritures des états du gabarit (signal `set`/`update`, affectation) reliées aux conditions : le parcours
  local d'un écran est démontré ; producteurs des conditions classés (démontré, origine locale, candidat,
  inconnu).
- Plus de « méthode introuvable » sur la lecture d'un signal (`signal`, `computed`, `input`, `model`,
  `toSignal`, `linkedSignal`).
- Un bouton qui appelle un service dont l'`Observable` n'est jamais souscrit n'est plus confirmé par le
  raccourci bouton → méthode.
- `MapCorrelation.diagnostic` (départ, dernier élément démontré, relation recherchée, sources examinées et
  manquantes, limites, pistes) ; cause `SOURCE_PARTIAL` quand une source n'a été lue qu'en partie.
- Route `GET …/cartography/trace` et `client.cartography.trace()` : parcours amont, aval ou complet, borné,
  avec frontière, ruptures et appels sortants.
- Structure & Conditions : vues Fiche / Amont / Aval / Complet, critères par couche et par relation,
  bilan, frontière (« Recentrer ici »), ruptures, fenêtre de détail d'un élément qui garde le zoom et la
  position.

### Cartographie : passerelles, destinations et graphe de configuration (étape 2)

- Version d'analyseur `cartography-7`.
- Passerelles lues par adaptateur dans un modèle commun (route, prédicats, transformations, destination) :
  Spring Cloud Gateway, NGINX et Ingress. Une passerelle n'est suivie que si la destination d'un appel la
  désigne.
- Destination d'un appel : la cible du proxy, la base d'URL ou la base d'un client mène à une source par son
  port (`server.port`) ou son nom (`spring.application.name`, `lb://nom`) ; seule cette source est alors
  candidate. Causes : `DESTINATION_SYMBOLIC`, `PROPERTY_UNRESOLVED`, `GATEWAY_EXTERNAL`,
  `MULTIPLE_DESTINATIONS`, `PROXY_DYNAMIC`.
- Frontal : base de l'environnement et proxy propres à chaque configuration d'`angular.json`.
- Clients Java : base d'URL résolue par profil ; client généré réglé par un bean (`setBasePath`).
- `MapCorrelation.variants` : l'issue de chaque variante qui diffère (chemin, chaîne, statut, cible) ;
  `ENVIRONMENT_INCONSISTENT` quand elle change. L'arbre de parcours les affiche.
- `model.configGraph` : dix relations typées (`DECLARES`, `REFERENCES`, `OVERRIDES`, `ACTIVATES`,
  `GENERATES`, `IMPLEMENTS`, `CONFIGURES`, `ROUTES_TO`, `REWRITES_TO`, `DEPENDS_ON`) avec provenance,
  variante et niveau de preuve ; valeurs sensibles masquées.
- La ligne d'un élément de liste YAML est la sienne (et non celle du premier élément).

### Cartographie : configuration par variante (étape 1)

- Version d'analyseur `cartography-6` : un scan incrémental ne reprend pas les faits d'avant.
- La configuration Spring est lue entrée par entrée avec son profil (`application-{profil}`, documents
  `on-profile`). Les profils ne sont plus fusionnés : le défaut et chaque profil sont des variantes, une
  valeur de profil remplace celle du défaut. Les valeurs de clés sensibles sont masquées.
- Le préfixe d'une interface générée n'est plus deviné : il vient des options de génération
  (`@RequestMapping` du contrôleur, `interfaceOnly`, `requestMappingMode`, propriété `base-path`), sinon les routes possibles restent
  listées avec la cause `GENERATION_OPTIONS_INSUFFICIENT`.
- Métadonnées de dépendances locales (dossier rangé comme un dépôt Maven, sous une racine autorisée) :
  pom et contrats empaquetés dans les jars, lus sans téléchargement ni exécution. Un artefact absent
  garde ses identifiants complets (groupe:artefact:version).
- Proxys de développement : `proxy.conf.json`, et `.js` / `.cjs` / `.mjs` lus par leur arbre syntaxique
  (jamais exécutés) ; configurations d'`angular.json` (proxy et remplacements de fichiers). Une règle
  non interprétable reste marquée dynamique.
- Correctif : un gabarit en ligne entre guillemets (`template: ''`) n'est plus signalé introuvable ;
  le message d'avertissement est en français.

### Sécurité

- **zod 4.6.7** (au lieu de 3.25) : corrige GHSA-mrhx-c7xc-m3w5 (épuisement mémoire en validant de très
  grandes collections). Les schémas sont migrés sans changement de comportement :
  - `.prefault()` garde les valeurs par défaut des objets ;
  - `z.partialRecord` garde les clés facultatives ;
  - `z.url()` et `.loose()` remplacent les formes dépréciées.

  Les messages d'erreur de configuration changent de forme (« Invalid input: expected string,
  received number »), pas de sens.

- La copie de zod embarquée par `@github/copilot-sdk` (figée en 4.3.6, même dans sa dernière version)
  est ramenée à 4.6.7 par `overrides`. Ce réglage ne vaut que dans ce dépôt : un projet qui installe
  `@qa-crawler/core` avec l’assistant Copilot doit poser le même `overrides`.
- `source-map-js` 1.2.2 et `vite` 7.3.7 : mises à jour correctives (`npm audit fix`).
- **vitest 4.1.12** (outil de développement, au lieu de 3.2) : corrige GHSA-82fw-gwwq-j7x9 et
  GHSA-qxg6-89mg-rqv8 (`@vitest/mocker`), et retire `tinypool` (GHSA-5gmw-xhrv-c9v3,
  GHSA-85c8-ppgw-ccpr). Les tests ne changent que pour remplacer des formes dépréciées
  (`toThrowError` → `toThrow`, `it.sequential` → `{ concurrent: false }`). La 4.1.12 suffit : la 5
  demanderait Node 22.12 pour développer.
- **Non corrigé, en attente de l'amont :** `@azure/msal-node` (GHSA-xcx6-jx8p-x3h5), tiré par `mssql`
  via `@azure/identity`. Aucune version publiée d'`@azure/identity` n'accepte encore la version
  corrigée de msal-node (7.1). La faille touche le flux OAuth « authorization code », que
  QA-CRAWLER n'utilise pas : la connexion SQL Server se fait par authentification SQL. Aucun
  `overrides` majeur n'est forcé sans test qui le couvre.

### Ajouté

- **Cartographie : corrélation Angular → OpenAPI → BFF → Backend.** Contrats à références suivies (dans la
  source seulement), paramètres, bases des `servers` ; modules Maven (propriétés, dépendances gérées,
  générations openapi-generator et leur contrat d'entrée, y compris depuis un artefact d'une autre source) ;
  routes héritées d'une interface ou d'une classe de base, placeholders et context-path ; endpoints déduits
  d'une interface générée absente (probables) ; bases d'URL du frontal démontrées par `environment` ou un
  jeton injecté (`BASE_PATH`) ; réécriture du proxy ; appels du BFF par un client Java généré ; versions de
  contrat comparées. Chaque appel a une corrélation (confirmée, probable, non démontrée, bloquée) avec ses
  candidats, ses causes précises et sa chaîne prouvée, visible dans l'arbre de parcours. Version des
  analyseurs : `cartography-5`.
- **Cartographie : alias, fabriques d'actions, branches HTTP et points d'entrée.** Le contexte d'appel suit
  les alias locaux (chaînes, réaffectations, déstructuration, retours de méthode, paramètres typés), évalue
  les fabriques d'actions quel que soit leur nom (imbriquées, génériques, fléchées) et sépare les appels
  HTTP d'une méthode générique par branche : deux boutons sur la même méthode atteignent chacun leur
  endpoint. Chaque lien dit sa dépendance temporelle (après résultat, sur erreur, à la complétion,
  annulable, concurrente, non démontrée) et `filter(…)` devient une condition. Les boutons, liens, `input
submit`, `(ngSubmit)` et sorties de composants enfants sont des points d'entrée reliés à la version
  contextuelle de leur méthode ; l'arbre de parcours les range sous leur onglet avec leurs conditions
  d'activation. Nouveaux diagnostics : `ALIAS_AMBIGUOUS`, `ACTION_FACTORY_UNRESOLVED`,
  `ASYNC_NOT_DEMONSTRATED`, `UI_DYNAMIC`. Versions : `rxjs-3`, `cartography-4` (faits relus au scan suivant).
- **Cartographie : parcours reconstruits par contexte d'appel.** Une méthode générique (`dispatch(action)`)
  n'est suivie que dans les branches choisies par la valeur transmise (littéral, enum, constante, objet,
  instance) ; une valeur indéterminée garde les branches comme possibles et le dit. Chaque lien porte ses
  conditions (if, switch, retour anticipé, catch, boucle), ce qu'il attend (await, subscribe, then, erreur,
  opérateur, avec annulation par switchMap ou takeUntil) et la provenance de ses données. Nouvel arbre de
  parcours dépliable (fiche et Traçabilité) ; l'impact liste les actions touchées et leur chemin de
  propagation. `forkJoin([...])` compte comme souscrit. Version d'analyseur : `rxjs-2`.
- **Cartographie : onglets Angular.** Les groupes et onglets Angular Material, ng-bootstrap, PrimeNG et
  maison (y compris générés par `*ngFor`/`@for`, imbriqués, routés) sont lus dans les gabarits, avec leurs
  libellés, conditions d'affichage et d'activation, la sélection pilotée par un store, et leur chargement à
  la demande. Les composants affichés sont reliés à leur onglet (réutilisations signalées), les appels
  déclenchés depuis un onglet sont listés, une dépendance entre onglets par un store partagé est présentée
  comme probable, et la fiche d'un onglet donne les préconditions démontrées pour l'atteindre. L'analyse
  d'impact cite les onglets touchés (sûr ou potentiel). Version des analyseurs : `cartography-3`.
- **Cartographie : stores et flux RxJS maison.** Le frontal est suivi à travers les stores détectés par
  leur comportement (Subject, BehaviorSubject…), les émissions, les flux calculés et leurs traitements
  (switchMap…), les façades, les classes de base et les clients HTTP maison, jusqu'au BFF. La souscription
  est vérifiée (un Observable non souscrit n'est pas présenté comme exécuté). Les conditions des gabarits
  sont reliées aux flux qu'elles lisent jusqu'à la réponse du serveur. Chaque rupture de chaîne est dite à
  l'étape exacte ; une correspondance HTTP ambiguë n'est plus choisie au hasard. Les faits portent la
  version des analyseurs : un scan incrémental relit une source analysée par une autre version.
- **Cartographie : écrans Scan & Découverte et Analyse d'impact revus.** Sources en cartes dépliables
  (champs obligatoires, validations avant envoi, jeton Git absent signalé), dernier scan par étapes,
  résumé par source, éléments découverts, scans récents, couverture. L'impact se choisit avec permutation,
  compare les sources, compte les changements (anneau), et détaille chaque changement (source, couche,
  fonctionnalités atteintes, preuve) dans un tableau filtrable. Une source non lue n'est jamais présentée
  comme « sans changement ». Les fichiers lock des dépendances ne sont plus lus ; les fichiers
  trop gros pour être lus sont nommés, et les limites de lecture sont dites en clair.
- **Cartographie : URL d'appel HTTP relues.** Une URL rangée dans une constante locale
  (`const url = …; this.http.post(url, …)`), une constante du module ou une propriété de la classe est
  maintenant relue : l'appel du Front est relié à l'endpoint du BFF au lieu d'être perdu. Une propriété
  qui reçoit plusieurs valeurs, ou un paramètre, n'est jamais deviné.
- **Cartographie : sources Git distantes.** Une source peut être un dépôt Git (`kind: 'GIT'`, `repoUrl`,
  `branch`, `commit`, `tokenEnv`) que le serveur prépare lui-même. Les hôtes sont autorisés par
  `--git-host`, en https seulement, et les adresses internes sont refusées. Git est lancé sans shell,
  sans hooks, sans sous-modules, sans liens symboliques, sans redirection, avec délais et limites ; sous
  Windows, les chemins de plus de 260 caractères sont acceptés. Le
  jeton est désigné par le nom d'une variable d'environnement, jamais stocké ni renvoyé. Chaque scan
  enregistre le commit réellement analysé.
- La révision des sources locales est lue de façon fiable (worktree, sous-module, sous-dossier d'un
  dépôt) ou dite indéterminée. « Voir le code » relit une source distante à la révision exacte et ajoute
  « Voir sur Git » (GitHub, GitLab, Bitbucket, Azure DevOps). L'impact compare les sources des deux
  scans.
- **Cartographie : Structure & Conditions.** Le scan lit les gabarits Angular (conteneurs, boutons,
  `@if`, `*ngIf`, `[hidden]`, `@else`, `[disabled]`, gestionnaires `(click)` et `(ngSubmit)`) et, côté
  Java, les méthodes de décision booléennes (boucles, prédicats, données lues) et les champs calculés
  par un appel de méthode. Le graphe gagne les nœuds `CONTAINER`, `BUTTON`, `CONDITION` et les liens
  `CONTAINS`, `VISIBLE_WHEN`, `ENABLED_WHEN`, `CONTROLLED_BY`, `TRIGGERS`. Nouvelles routes `structure`,
  `element`, `conditions`, `actions` (client `cartography`) et onglet « Structure & Conditions » :
  arbre, graphe en couloirs de l'élément, fiche (condition, décision Backend, appels, preuves,
  scénarios). Une condition dont la décision n'est pas démontrée est dite « non déterminée », avec sa
  cause.
- **Cartographie fonctionnelle** (écran « Cartographie » du Dashboard, routes
  `/api/projects/:id/cartography/…`, client `cartography`) : scan statique des sources d'un projet
  (Angular, Spring, JPA, OpenAPI ; les autres technologies sont signalées « connecteur manquant »),
  graphe typé avec preuves et confiance, fonctionnalités candidates et décisions (confirmer, renommer,
  fusionner, rejeter, hors périmètre), champs et réutilisations suivis de l'écran à la colonne,
  anomalies (champ non utilisé, doublon, types incohérents, validations divergentes, sans test),
  couverture par les scénarios mesurée sur les exécutions réelles, impact entre deux scans et rejeu
  des scénarios choisis. Voir [docs/sdk](docs/sdk/README.md#cartographie-fonctionnelle).
  L'exploration est **progressive** : un résumé et une page de fonctionnalités au premier affichage,
  puis les champs d'une fonctionnalité, puis la fiche d'un champ (sous-graphe borné, séquence,
  réutilisations, scénarios associés / exécutés / vérifiés, impact démontré et potentiel), servis par
  un index construit une fois par version et un cache invalidé par un scan ou une décision (routes
  `summary`, `features`, `feature`, `feature-fields`, `field`, `neighbors`, `concepts`, `issues`).
  La traçabilité d'un champ se lit en **parcours principal** (une carte par couche démontrée, compteurs
  « N liens » vers les relations exactes) ou en **graphe complet** (colonnes ordonnées, sélection,
  extension à la demande), avec zoom, ajustement, déplacement, plein écran, légende comptée,
  regroupement des liens parallèles et tableau « Relations détectées » avec « Voir le code ».
  L'onglet **API & Services** dresse le catalogue des API internes (par contrôleur servi), externes
  (par hôte lu dans le code ou la configuration) et « à classifier » (cible non établie), avec
  endpoints, appelants, champs échangés, contrat OpenAPI, parcours d'intégration démontré,
  fonctionnalités et scénarios liés, impact, criticité justifiée ; renommage métier (`RENAME_API`) et
  classement manuel (`CLASSIFY_API`) ; routes `apis` et `api`.
  Sa **Traçabilité (graphe)** s'ouvre sur le graphe complet de l'API, en couloirs (Frontend, BFF,
  Backend, puis API externe, contrats et base de données empilés) : les nœuds d'un même conteneur forment
  une carte (classe et méthodes, composant et champs, DTO et propriétés, table et colonnes) ; les
  relations entre deux couloirs forment un faisceau orthogonal avec son compteur « N liens », vert pour un
  flux interne, violet pour un appel externe, bleu pour la base, le statut étant montré à part (tirets,
  icône). Un clic liste les relations du faisceau avec leurs preuves, un second les déplie. Le survol
  d'une carte fait ressortir son voisinage. Vues Architecture et Données (flux de champs, champs envoyés
  et reçus par l'API), critères d'affichage par couche, nature, statut et profondeur. La liste exhaustive des
  relations reste accessible. La fiche d'API renvoie désormais tout l'amont démontré, l'aval de ses
  endpoints, ce qui y est rattaché et ses appels sortants (`outbound`), dans une limite de 300 nœuds.

- **Catalogue de blocs et fiche détaillée** :
  - **Catalogue** : cartes avec le statut réel du contrat, le nombre d'étapes, d'entrées et de sorties,
    l'origine et les groupes métier, la date de modification si elle est connue, « Ouvrir » ; pagination (12 à
    96 blocs par page, gardé par le navigateur) ; états chargement, erreur (Réessayer), aucun résultat.
  - **Fiche à côté du catalogue** : ouverte depuis une carte, elle laisse la recherche, les critères, la page et
    la sélection en place (gardées aussi en passant par le compositeur).
  - **Actions de la fiche** : Prévisualiser (l'aperçu statique réel d'un parcours fait de ce seul bloc), Éditer
    (le contrat), Dupliquer (`library.duplicate`), Ajouter au parcours. Pas d'« Exécuter » : un bloc ne se joue
    pas seul.
  - **Onglets** avec leurs nombres réels, dont un onglet Traçabilité : le graphe entrées → bloc → sorties du
    contrat, et pour chaque donnée sa provenance, ses étapes, ses producteurs et consommateurs, en trois
    couches séparées (déclarée, détectée, observée). Une donnée citée par `${testData:…}` reste une entrée ; une
    valeur fixe du jeu n'est jamais dite « générée ».
  - **Dernière exécution** et valeurs observées : la vraie exécution qui a rejoué le bloc (`library.activity`),
    avec un lien vers son rapport.
  - **Compatibilité avec le parcours ouvert**, avant l'ajout : chaque entrée fournie, ambiguë, prise dans le
    jeu du bloc, facultative ou manquante, et une version déjà utilisée différente.

- **Traçabilité des données entre blocs** :
  - **Événements de la trace** : chaque événement a un identifiant (`d1`, `d2`…) et une occurrence de valeur
    (`company.name@1`), commune à sa production et à toutes ses utilisations. Une utilisation pointe vers
    l'événement qui a produit la valeur (`source`).
  - **Sortes d'événements** : génération, capture, transformation, variable d'itération, utilisation
    (`ASSIGN` saisie, `READ` citation, `VALIDATE` vérification) et écrasement refusé. Une valeur fixe du jeu
    est notée `fixed`.
  - **Rétention** : par défaut, les événements et leurs liens sont gardés sans les valeurs ; la vue le dit
    (« non conservée ») et la confirmation repose sur l'occurrence de valeur, pas sur la valeur.
    `testData.traceValues: true` (section `mission` du projet) garde les valeurs ; celles des clés sensibles
    ne le sont jamais.
  - **Modèle d'un parcours** (`journeys.traceability`) : les définitions (contrats des blocs), les
    correspondances (explicites, automatiques, jeu de données, itération, suggérées non confirmées,
    manquantes) et les traces d'une exécution réelle (la plus récente, ou celle choisie). Chaque donnée a un
    statut justifié : confirmée seulement si une production puis une utilisation de la même occurrence ont été
    observées. Une entrée manquante, une collision ou une version ancienne d'un bloc sont signalées.
  - **Vue « Données & Traçabilité »** du compositeur (à côté des modes linéaire et diagramme) :
    - le flux d'exécution en haut, liens de contrôle et liens de données distingués ;
    - les données du scénario à gauche, filtrables ;
    - la chronologie ou le graphe de la donnée au centre ;
    - sa fiche à droite (provenance, version, type, valeur masquée si sensible, producteurs,
      consommateurs, statut et justification) ;
    - les onglets Variables, Correspondances et Graphique de dépendances ;
    - la navigation vers les étapes du bloc, et les états sans exécution, sans trace, en chargement et en
      erreur.

- **Boucles exécutées par le moteur** (étape `loop`, jamais aplatie) :
  - **`REPEAT`** (`times`), **`FOR_EACH`** (`items` écrits, ou `itemsFrom` : une donnée du run en tableau JSON)
    et **`WHILE`** (une condition d'écran vérifiée avant chaque itération).
  - **Limites** : `maxIterations` (100 au plus ; 20 par défaut pour `WHILE`), `timeoutMs` global (10 min au
    plus), `onFailure` : `STOP` ou `CONTINUE`. Une condition `WHILE` encore vraie au plafond est un échec
    (protection contre la boucle infinie). Une collection plus longue que le plafond est refusée, jamais
    tronquée. Deux niveaux d'imbrication au plus.
  - **Variables d'itération** : `${testData:<as>.index}`, `${testData:<as>}`, `${testData:<as>.<champ>}`.
  - **Portée des valeurs** : ce qui est généré ou capturé dans le corps n'existe que pendant l'itération (une
    valeur générée par itération) ; les valeurs produites avant la boucle restent les mêmes.
  - **Attentes, captures, générations et blocs (`run:`)** s'utilisent dans le corps.
  - **Rapport** : chaque itération (variables, étapes, statut, raison) et la raison de l'arrêt
    (`COMPLETED`, `CONDITION_FALSE`, `MAX_ITERATIONS`, `TIMEOUT`, `FAILED`, `REFUSED`).
- **Trace des données de chaque exécution** (`dataTrace`) : chaque valeur générée, capturée ou variable
  d'itération, et chaque lecture, avec l'étape, le bloc et l'itération. La valeur d'une clé sensible n'est
  jamais gardée. Les autres valeurs ne sont gardées (trace et variables des itérations) que si la mission le
  permet : `testData.traceValues: true` ; par défaut, l'événement est gardé sans sa valeur (`withheld`), et
  une valeur produite pendant le run ne sort pas du moteur.
- **Capture `generate` et `transform`** : une étape `capture` peut générer une valeur (`generate:
company`) ; toute capture peut être transformée (`uppercase`, `lowercase`, `trim`, `digits`).
- **« Ajouter une sortie » à un bloc** (`library.addOutput`) : une étape exécutable est insérée dans le bloc.
  - **Sources** : variable générée, texte ou attribut d'un élément, adresse, réponse HTTP observée, entrée
    transmise.
  - **Description** : libellé, sens et type sont enregistrés.
  - **Version** : le bloc passe à `CHANGED` ; sa nouvelle version est à valider. Une clé déjà connue est
    refusée, une source incomplète aussi.
- **Nœud Boucle dans le compositeur** : un conteneur (violet) de blocs et d'attentes, configuré avec ce que le
  moteur exécute.
  - **Compilation** : il se compile en une étape `loop:`.
  - **Vérification** : les entrées des blocs du corps peuvent lire les variables d'itération. Une donnée
    produite dans la boucle et lue après elle est une erreur. Les versions des blocs du corps sont suivies
    comme les autres.
  - **Cycles** : une connexion qui revient en arrière reste refusée (boucle non contrôlée).
- **Simulation d'un parcours** :
  - **Aperçu statique** (`journeys.preview`) : provenance de chaque entrée, portée de chaque sortie,
    itérations et variables connues d'avance. Rien n'est exécuté ; une valeur générée ou capturée est dite
    « connue à l'exécution », jamais inventée.
  - **Exécution de simulation** (`journeys.simulate`) : un vrai rejeu du chemin choisi, seulement dans un
    environnement de développement ou de test (422 sinon). Le parcours n'est pas enregistré ; l'exécution
    est marquée `simulation`.
- **Dashboard** :
  - un onglet Simulation (aperçu, puis exécution réelle) dans le compositeur ;
  - le formulaire « Ajouter une sortie » dans l'onglet Sorties de la fiche ;
  - dans l'écran Exécution, les itérations de chaque boucle et la traçabilité des données (producteurs,
    consommateurs, historique des valeurs).

- **Étape `capture` dans le moteur** : une valeur lue pendant le rejeu devient une donnée du run (`as`),
  citée ensuite comme les autres (`${testData:clé}`, `{ testData: clé }`), avec la même valeur.
  - **Sources** : le texte ou un attribut d'un élément (filtré par `pattern`), l'adresse (paramètre ou
    motif), un champ JSON de la réponse d'une requête observée, ou une donnée déjà produite dans le run
    (`data`).
  - **Moment et échec** : la capture attend jusqu'au délai de l'étape. En échec, elle dit pourquoi ; avec
    `optional`, elle avertit sans arrêter le scénario.
  - **Garde-fous** :
    - une clé qui évoque un secret est refusée ;
    - une valeur masquée n'est jamais capturée ;
    - une donnée définie par un jeu n'est pas remplacée ;
    - une donnée qui a déjà une autre valeur dans le run n'est jamais écrasée.
  - **Réponses HTTP** : le moteur ne garde que les corps des écritures (POST, PUT, PATCH) et des erreurs,
    masqués. Pour un rejeu qui contient une capture de réponse, `network.captureBodies` est activé ; sans
    corps gardé, la capture échoue en le disant.
  - **Tests générés** : les générateurs Playwright et Java marquent la capture comme non générée (elle
    remplit le contexte de données de QA-CRAWLER).
- **Contrat de données enrichi** (`contract.fields`). Chaque entrée, sortie ou candidate porte :
  - un identifiant stable et son nom technique ;
  - un libellé, une description et un sens métier ;
  - un type, déclaré, proposé d'après un indice ou `text` par défaut ;
  - son caractère obligatoire et sa provenance (entrée, générée, capturée, valeur du jeu, valeur fixe
    saisie) ;
  - sa version de définition et son statut de détection (confirmée, probable, inconnue), avec sa
    justification ;
  - les étapes qui la produisent ou la lisent.

  Une sortie générée ou capturée est confirmée par les étapes. Une valeur fixe du jeu n'est que probable.
  Une valeur littérale saisie dans un champ est une entrée possible, jamais ajoutée sans une personne. Les
  anciens contrats restent tels quels (`inputs`, `outputs`), sans conversion ni rupture.

- **Déclarations de données** (`library.declareFields`) :
  - confirmer une détection, corriger libellé, description, sens, type et valeur par défaut, retirer une
    sortie ;
  - un changement incompatible (type ou sens déclarés, sortie retirée) incrémente la version de la donnée,
    pas celle du bloc ;
  - sur un bloc utilisé, ce changement est refusé (409, les scénarios et parcours dépendants nommés) tant
    qu'il n'est pas validé explicitement.
- **Raccordement** :
  - la vérification d'un parcours propose, pour chaque entrée manquante, les données disponibles sur tous
    les chemins ;
  - une proposition « fiable » est la seule compatible au plus fort indice (sens métier, puis type, puis
    nom final) ; sinon elle est ambiguë, ou absente ;
  - deux types connus différents donnent une erreur (déclarés) ou un avertissement (proposés) ;
  - rien n'est retenu sans un clic, et retenir une proposition enregistre une correspondance (`MAP`). Mêmes règles en
    mode linéaire et en diagramme.
- **Fiche d'un bloc** :
  - onglets Entrées et Sorties : type, sens, provenance, étapes, version, détection et pourquoi ; Confirmer,
    Corriger, Ne plus exposer, Valider un changement incompatible ;
  - onglet Paramètres (l'ancien « Données ») : entrées configurables, défauts, contraintes, générateurs ;
  - onglet Étapes : le rôle de chaque étape (action, navigation, génération, capture, attente,
    vérification).
- **Attentes (Wait) dans le compositeur et dans les blocs** : un nœud `WAIT` attend une condition avant de
  continuer, jusqu'à un délai (1 à 300 s) : un élément visible ou disparu (sélecteur CSS ou texte), un
  texte métier, une adresse, ou une réponse HTTP (méthode, adresse, statut). Il se compile en étape
  `expect` ordinaire, avec `timeoutMs`, sans rien de nouveau dans l'exécuteur. « Continuer avec un
  avertissement » devient `optional: true` : l'étape reste notée en échec avec ce qui manquait, le
  scénario continue et son verdict n'en dépend pas. Une attente peut citer une donnée produite plus haut
  (`${testData:clé}`) : elle est lue dans le run, jamais régénérée. La vérification exige qu'une donnée
  générée au rejeu soit produite avant l'attente qui la cite, chemin par chemin. Le moteur n'attend pas
  qu'un élément soit cliquable, n'a pas de pause de durée fixe et ne laisse pas régler l'intervalle de
  vérification : ces options sont montrées comme non prises en charge, jamais réglables.
  `library.insertWait` insère une attente entre deux étapes d'un bloc enregistré. Les groupes métier sont
  décalés, le bloc passe à « modifié », et sa version suivante n'existe qu'après validation explicite.
  Les parcours qui l'utilisent gardent leur version tant qu'ils ne l'acceptent pas.
- **Compositeur : contrôle du flux, liens de données et panneau des données.**
  - Le catalogue propose l'attente (et, en diagramme, la condition et la jonction). Boucle, Document et
    API y figurent comme indisponibles, sans bouton, avec la raison.
  - L'attente est orange, avec une horloge. Ses propriétés reprennent le type, la cible, le délai, le
    comportement au délai et la validation de l'attente.
  - Le nœud choisi montre en pointillés ses liens de données, distincts du flux d'exécution, et une
    légende les nomme.
  - Sous la scène, un panneau à quatre onglets lit la vérification réelle : entrées et sorties du
    scénario, correspondances entre blocs (même nom, renommée, valeur saisie, jeu de données, manquante,
    avec les candidates), variables (générées au rejeu ou valeurs des jeux) et erreurs/avertissements.
- Le lien « Ouvrir la bibliothèque » d'une notice de publication ouvre le catalogue, où le bloc publié est
  visible.
- **Fenêtre « Ajouter un bloc »** : une grande fenêtre centrée (la page reste visible, le parcours en cours
  n'est pas touché) avec un assistant en quatre étapes — Informations (nom vérifié avant l'envoi,
  description, catégorie déduite de l'origine, version initiale v1, origine : un scénario ou un groupe
  d'étapes d'un enregistrement avec les étapes retenues), Entrées / Sorties (contrat déduit des étapes, ou
  déclaré explicitement), Paramètres (les entrées, chacune obligatoire ou facultative), Confirmation
  (récapitulatif et vérifications réelles du serveur). « Créer le bloc » n'est possible qu'après une
  vérification réussie ; un échec garde la saisie ; fermer après une saisie demande confirmation. Le type
  de bloc n'est pas un choix : les conditions et jonctions sont des éléments du diagramme.
- **`library.check`** (`POST /library/check`) : vérifie, sans rien écrire, ce qu'un scénario deviendrait en
  bloc (étapes exécutables, schéma, blocs rejoués existants, nom libre, contrat déduit ou déclaré).
  `library.add` accepte un contrat déclaré, refusé (422, rien n'est écrit) s'il ne tient pas.
- **Bibliothèque mise en page comme la maquette** : blocs récemment ouverts à gauche (repliables), onglets
  « Catalogue de blocs » / « Compositeur de parcours » / « Diagnostics », panneau droit « Propriétés »
  (onglets Paramètres, Entrées/Sorties, Détails) et « Validation du parcours » tirée de la vraie
  vérification (jamais « valide » sans elle), actions Enregistrer / Vérifier / Créer en tête. Diagramme :
  connexions orthogonales qui suivent les nœuds, conditions en losange, étiquettes Oui / Non, début et
  fin en capsules, barre d'outils (sélection, bloc choisi, condition, jonction, fin, relier par clics,
  supprimer). Ajout d'un bloc : choisi dans le catalogue (sélection par catégorie réelle), déposé à un
  endroit sans connexion implicite, ou sur une connexion avec insertion proposée ; le bloc ajouté est
  sélectionné (barre d'actions Modifier / Dupliquer / Supprimer), ses propriétés s'ouvrent et une
  confirmation discrète s'affiche. Vérifié à 1366 × 768, 1440 × 900 et 1920 × 1080.
- **Compositeur visuel de parcours** dans la Bibliothèque : le même parcours se construit en **mode
  linéaire** (cartes glissées depuis le catalogue, insertion entre deux cartes, réordonnancement,
  duplication, retrait) ou en **mode libre** (diagramme : début, blocs, conditions Oui/Non, jonctions,
  fins ; connexions tirées depuis les ports ; zoom, ajustement à l'écran, déplacement de la vue). Annuler
  et rétablir (Ctrl+Z, Ctrl+Y), suppression au clavier, panneau de propriétés (paramètres d'instance,
  entrées et sorties, versions, diagnostics), erreurs affichées sur le nœud concerné. Passer en mode
  linéaire n'est permis que sans perte (sinon la raison est dite) ; les branches ne sont jamais aplaties.
  Le menu latéral ne change pas.
- **Parcours enregistrés** (`journeys` dans le SDK et l'API) : graphe, disposition et révision dans
  `sdk-journeys.json` ; vérification par chemin (structure, entrées, données en amont, conflits, boucles
  refusées) ; création d'un scénario, ou d'un scénario par chemin après confirmation explicite quand le
  parcours a des branches (le moteur n'évalue pas les conditions).
- **Sorties d'un parcours et parcours transformé en bloc** : le panneau du parcours liste ses sorties,
  garanties (produites sur tous les chemins) ou seulement sur certains chemins (nommés). « Transformer en
  bloc » fait d'un parcours enregistré, valide et sans condition, un bloc de la bibliothèque dont le
  contrat déclare ces sorties ; il se réutilise dans d'autres parcours et se rejoue comme eux. Le contrat
  d'un bloc qui rejoue d'autres blocs (`run:`) se lit désormais sur ses étapes dépliées.
- **`run:` avec `with:`** : une étape `run` peut renommer les données du bloc rejoué
  (`with: { clé du bloc: clé du scénario }`), pour donner à chaque instance d'un même bloc ses propres
  valeurs sans modifier le bloc.

- **Thème vert et blanc du Dashboard** : la palette (vert principal `#006B3F`, vert foncé `#004D2B`, vert très
  foncé `#003B25`, vert secondaire `#008A4B`, verts clairs `#E6F4EA` et `#F2FAF5`, fond `#F7F9F8`, texte
  `#172B24` et `#64746C`, bordures `#DCE5DF`, rouge `#DC3545`) remplace l'indigo dans les jetons `--qa-*`, avec
  des jetons de panneau (`--qa-color-panel-*`) pour le menu latéral et la console, et un thème sombre assorti.
  Menu latéral vert foncé de 240 px, logo araignée (icône SVG locale), « Pilotage & Investigation », entrée
  active sur fond vert très clair en texte vert foncé, menu défilable. Étapes de l'investigation : terminée en
  cercle vert à coche, active sur fond vert clair, non commencée en cercle blanc à bordure grise. Onglets actifs
  en vert foncé sur fond vert clair. Étape Périmètre : bandeau de présentation avec trois indicateurs qui
  reflètent l'état réel de la découverte (attente, en cours, comptes, échec), champ de chemin avec icône de
  dossier, résumé « Analyse terminée » (applications, modules, fichiers lus, durée mesurée par le serveur :
  `durationMs`), glyphe du cadre et badge « Application principale » sur les cartes, résumé de la sélection
  des applications avec « Gérer » qui replie ou déplie les dossiers. Aucune règle métier ni route ne change.
  Alignement sur la maquette : logo araignée blanc sans cartouche, bouton « Incidents » en pastille vert clair,
  « Annuler l'investigation » en bouton principal, vues principales (Vue d'ensemble, Reproduction, …) avec icône
  et onglet actif en pastille vert clair dans une barre blanche, cercles d'étapes de 24 px ; bandeau du Périmètre
  compact avec illustration portable-loupe, vagues vertes et indicateurs en pastilles blanches ; carte
  « Applications et dépôts » avec icône de dossier, champ « Chemin du projet * » (`required`), icône
  d'information devant l'aide ; résumé d'analyse en une bande (coche verte, sous-titre, puis Application(s),
  Modules, Éléments, Durée d'analyse séparés par des filets, « Éléments » = fichiers lus + modules + points
  d'entrée + configurations + services) ; « Détails de la détection (modules, structure, dépendances) »,
  « Fichiers lus (n) » à droite, « Effacer le résultat » avec corbeille ; « Définition du périmètre » avec icône,
  modes à icônes, « Gérer » avec crayon, « Profondeur d'analyse » avec infobulle. Détails d'alignement : badge
  du cadre en bouclier à la couleur du cadre (Angular, React, Vue, Svelte, Ionic, NestJS, Node, Spring, Java,
  Python, Go, .NET, TypeScript) avec sa lettre, carte d'application sur deux colonnes (nom, badge et raisons à
  gauche ; couche et pastilles à droite), bouton « Analyser automatiquement » aligné sur le champ, dix étapes sur
  une ligne sans traits de liaison, outils de l'espace (« Mode compact », panneaux masqués, réinitialisation) sur
  la ligne des sous-onglets, menu latéral plus compact (lignes de 36 px) qui reste dans la fenêtre sur écran
  large (collant, borné à la hauteur de la fenêtre, défilement interne) : sa fin et son pied se voient sans faire
  défiler la page. Couleurs du menu mesurées sur la maquette : fond `#004D2B` inchangé, sélecteur de projet en
  vert relevé (`--qa-color-panel-raised`, `#005D38`), entrée active sur `#E6F4EA`, et le motif du bas du menu relevé
  sur la maquette : trois facettes à bords droits en vert secondaire (bande translucide en diagonale montante,
  facette médiane, coin vif à droite), puis un filet et le pied ; masqué sur téléphone.
  Ergonomie : « Définition du périmètre » en deux colonnes équilibrées (Applications | Profondeur, puis Éléments
  inclus | Limites ; une colonne sous 760 px) ; le pied de la découverte dit l'état de la sélection (« N cochée(s)
  sur M détectée(s) : une application n'entre dans le périmètre qu'après Ajouter ») ; l'accordéon « Paramètres
  avancés » ne rend son contenu qu'ouvert (l'état reste dans le modèle) ; dans les formulaires, le libellé et
  l'astérisque tiennent sur une ligne et l'aide reste sous son champ (plus de colonne orpheline pour « Cible ») ;
  titres de section du menu plus lisibles, marges du contenu resserrées (24 px).

- **Scénario d'accès et exploration à partir d'un écran cible** (étape « Périmètre », `src/incident/access.ts`,
  `src/incident/target-screen.ts`, `src/sdk/ui/incident-access.ts`) : une carte entre « Applications et dépôts » et
  « Définition du périmètre ». L'utilisateur indique l'écran ou la fonctionnalité cible et décrit le problème (URL et
  indications de navigation facultatives) ; trois modes : « Explorer automatiquement » (recommandé), « Parcours
  guidé » (étapes connues) et « Démonstration » (un enregistrement du module Enregistrements, lancé ou associé ;
  aucune vidéo). « Localiser l'écran » lit le code : l'analyse Angular relève désormais les routes (redirections,
  gardes `canActivate`/`canMatch`), les liens des templates et les titres ; les écrans candidats sont notés sur des
  indices cités (URL, lien entrant, titre, route ; un nom seul reste incertain, plafonné à 45 %), et le parcours est
  trouvé par les liens depuis l'entrée de l'application. Gardes et routes paramétrées sont dites comme limites,
  jamais contournées. « Préparer l'exploration » joue ce parcours dans un vrai navigateur (hôtes du périmètre,
  environnement de test) et inventorie l'écran atteint (boutons, champs, liens, listes, désactivés, requêtes,
  erreurs, capture) ; une page de connexion bloque sans qu'aucun identifiant soit saisi. « Lancer l'investigation »
  démarre le moteur des déclencheurs avec ce parcours comme point d'entrée imposé, rejoué avant chaque essai
  (stratégies, déduplication, répétitions, réduction, budgets, pause, reprise et annulation inchangés). La
  progression vient du run réel (neuf phases, séquences exécutées, états explorés, dernière action, anomalies,
  durée, limites restantes ; aucun pourcentage) ; les résultats donnent la séquence déclenchante et sa fréquence,
  les conditions, les preuves, les hypothèses proposées (jamais confirmées par le moteur seul) et les actions
  recommandées. « Analyser le parcours » (étapes comprises, portions de code candidates, pistes, limites) reste
  disponible. Routes `POST …/access`, `…/access/analyze`, `…/access/locate`, `…/access/prepare`,
  `…/access/explore` (droit `RUN`) ; client `saveAccess`, `analyzeAccess`, `locateAccessTarget`,
  `prepareAccessTarget`, `exploreAccessTarget`. Le scénario est repris dans le Résumé, l'Exécution et le rapport.

- **Découverte automatique du périmètre** (étape « Périmètre » de l'investigation, `src/incident/scope-discovery.ts`) :
  le bloc « Applications et dépôts » remplace la saisie manuelle des applications (identifiant, nom, couche, dossiers,
  classes, racine) par un chemin de projet — ou un dépôt déjà connu de l'environnement, réutilisé d'un clic — et
  « Analyser automatiquement ». Le serveur détecte les applications (package.json, angular.json, pom.xml, build.gradle,
  pyproject.toml, requirements.txt, go.mod, *.csproj), leurs cadres et langages, leur couche probable, leurs modules,
  points d'entrée, configurations et services, les relations entre applications (dépendances déclarées, proxy ou URL vers
  le port d'une autre application) et la structure du dépôt (application seule, monorepo npm/pnpm/Nx/Lerna/Turborepo,
  Maven multi-module, Gradle multi-projets, plusieurs applications). Les applications proposées pour l'incident (mots de
  la description retrouvés, application nommée, dépendances transversales) sont cochées ; la couche se corrige d'un
  choix ; chaque détection cite ses preuves, ce qui n'est pas déterminable devient une question ; un chemin relatif,
  introuvable, qui n'est pas un dossier ou protégé est expliqué avec sa correction. Lecture seule par le Scope Policy
  Engine (fichiers sensibles refusés, liens jamais suivis, bornes), rien n'est écrit ; « Ajouter au périmètre »
  complète le périmètre (brouillon, périmètre défini) ou demande des extensions `ADD_APPLICATION` à décider une fois
  l'investigation commencée ; chaque application ajoutée garde sa provenance (`origin`). La saisie manuelle reste dans
  « Paramètres avancés », repliée. Routes `POST …/scope/discover`, `GET …/scope/repositories` (droit `RUN`), client
  `incidents.discoverScope`, `incidents.knownRepositories`.

- **Découverte autonome des déclencheurs** (`src/incident/trigger`, `docs/incident-reconstruction/trigger-discovery.md`) :
  interprète de description (FR/EN, provenance), découverte du périmètre (statuts du Scope Policy Engine), analyse
  statique Angular (`src/incident/code/angular.ts`), collecteur d'observations navigateur, oracle de défaillance
  silencieuse, stratégies d'exploration, rejouages, minimisation (delta debugging), conditions, première défaillance,
  perte de données, hypothèses et vérifications, test de non-régression proposé, rapport ; routes `…/trigger/*`,
  client `incidents.trigger`, onglet « Déclencheurs » du Dashboard ; application Angular de test avec défaut contrôlé
  (`tests/fixtures/angular-app`, `tests/fixtures/angular-site.ts`).

- **Incident Reconstruction** (`docs/INCIDENT_RECONSTRUCTION.md`) : diagnostic d'un incident fonctionnel à partir de
  preuves — déclarer, délimiter, reproduire, observer, inspecter le code, corréler, diagnostiquer, vérifier,
  rapporter, générer un test.
  - Incident Manager : création, consultation, modification (révisions), historique, états, annulation et reprise,
    persistance par projet (`incidents/`), routes `/api/projects/:p/incidents/…`, client `client.incidents`.
  - Investigation Scope Manager (modes `MANUAL`, `GUIDED` par défaut, `AUTO_WITHIN_SCOPE`) et Scope Policy Engine
    (refus par défaut) exercé dans les adaptateurs : fichiers (chemins réels, liens symboliques, fichiers
    sensibles, tailles), réseau (hôtes du périmètre, jamais les adresses de métadonnées), tests et commandes
    (arguments contrôlés, aucun shell), OpenShift en lecture seule. Toute extension est approuvée (`DECIDE`).
  - Reproduction par le moteur Playwright (le chemin des exécutions) ; preuves : actions, requêtes rattachées à
    l'action qui les déclenche, réponses en erreur, erreurs console et JavaScript, captures, trace.
  - Code Investigation Engine : frontend TypeScript (API du compilateur), BFF Java et backend Spring Boot
    (routes, DTO et validations, services, clients HTTP, dépôts, `@Query`, transactions, exceptions).
  - Evidence Correlator (graphe Incident → … → Repository, liens `OBSERVED`, `STATICALLY_RESOLVED`, `INFERRED`,
    `UNKNOWN`), Hypothesis Engine, Experiment Runner (rejeu, comparaisons, comparaison avec le scénario qui
    réussit, tests ciblés, journaux, validations), Root Cause Analyzer (confirmé seulement sur preuves), rapport
    JSON et Markdown, test de non-régression proposé, exécuté réellement, ajouté à la bibliothèque après validation.
  - Execution Environment Manager : un contrat pour LOCAL (par défaut), REMOTE et ARO (Playwright conteneurisé,
    dépôts montés, journaux OpenShift par le ServiceAccount, manifeste de Job Kubernetes).
  - Dashboard : section « Investiguer › Incidents » (liste, déclaration, périmètre, environnement, reproduction,
    chronologie, graphe, code, hypothèses, expériences, diagnostic, rapport, non-régression).
  - **Espace d'investigation** (Dashboard, « Investiguer › Investigations ») : en-tête de l'incident, progression en
    dix étapes, quinze onglets (vue d'ensemble, périmètre, environnement, chronologie, traçabilité, requêtes HTTP, frontend, BFF,
    backend, journaux, hypothèses, expériences, diagnostic, rapport, non-régression), graphe
    full stack (zoom, déplacement, clavier, chemin d'erreur, tableau des relations), panneau contextuel, sélection
    synchronisée entre toutes les vues (une requête met en évidence son étape, ses nœuds, ses événements, son
    code), explorateur de code en lecture seule (périmètre, valeurs sensibles masquées, lignes désignées par
    l'investigation), traçabilité frontend (élément → composant → gestionnaire → service → client HTTP →
    requête → erreur affichée), chronologie unifiée, choix de l'environnement LOCAL / REMOTE / ARO, thème sombre,
    responsive, accessibilité (navigation clavier, contrastes AA, annonces) ; démonstration étiquetée
    « Données de démonstration », sans appel au serveur, jamais présentée comme un diagnostic réel.
  - **Investigation IA** (`src/incident/ai`, `docs/incident-reconstruction/ai-investigation.md`) : modes `DETERMINISTIC`
    (défaut : rien n'est chargé), `AI_ASSISTED`, `AI_AGENTIC` ; profondeurs `QUICK`, `STANDARD`, `DEEP` ; agents
    (plan, preuves, frontend, BFF, backend, inter-couches, hypothèses, plan de vérification, chasseur de contradictions,
    synthèse, assistant) sur des outils en lecture seule gardés par le Scope Policy Engine (liste fermée, résultats
    délimités comme données, refus jamais rejoués, aucune commande) ; hypothèses d'origine IA toujours `PROPOSED` et
    plafonnées, relations `INFERRED`, confirmation réservée au validateur déterministe ; budgets bornés, annulation,
    pause et reprise ; investigation approfondie (stratégies, expériences avec opérations exactes, contradictions,
    rôles, couverture par dimension, mémoire persistante, politique d'arrêt) ; routes `…/ai/*`, client
    `client.incidents.ai`, sous-onglet « Diagnostic › Investigation IA », section « Investigation IA » du rapport.
    Fournisseur `anthropic` (SDK optionnel) ; tests avec un client de modèle scripté.
  - **Espace d'investigation façon IDE** : hauteur de la fenêtre sans défilement de la page, en-tête compact,
    progression repliable, six vues avec sous-onglets, panneaux redimensionnables (souris et clavier), agrandis,
    réduits ou masqués, défilement propre à chaque panneau, graphe qui remplit son panneau (plein écran, « Ajuster »,
    menu « Couches »), explorateur de code (onglets de fichiers, recherche, « Aller à la ligne »), ouverture du code à
    la sélection, préférences locales, un panneau à la fois sur mobile.
  - **Parcours guidé en douze écrans** : liste à onglets et recherche, déclaration avec application, type et pièces
    jointes, périmètre par arborescence de dossiers, profondeur et limites (mémoire imposée au Job ARO), cartes
    d'environnement et test de connectivité, reproduction suivie étape par étape pendant le rejeu, preuves avec commande
    cURL reconstruite, graphe en couloirs horizontaux, tableau du diagnostic, rapport par sections exporté en PDF, HTML,
    Markdown ou JSON, test de non-régression Playwright généré. Routes `…/attachments`, `…/scope/tree`,
    `…/report?format=html|pdf&sections=`, `…/regression/spec`.
  - Routes `GET …/incidents/:i/sources`, `…/source?application=&file=` (droit `RUN`) et
    `…/screenshot?reproduction=&file=` ; en-têtes HTTP des échanges restreints à une liste autorisée.
- Moteur : `network.captureBodies` (corps des échanges en erreur et des écritures, masqués, tronqués à 8 Kio) et
  `browser.playwrightTrace` (trace Playwright du run, `trace.zip`), désactivés par défaut.

- **Extraire plusieurs groupes métier d'un enregistrement vers la bibliothèque** (ADR 0002) :
  - un, plusieurs ou tous les groupes du Recorder, ou une partie d'un groupe ; un bloc par groupe ou
    un bloc composé qui garde ses groupes internes et leurs identifiants ;
  - plan calculé sans rien écrire : étapes, données restreintes à ce que le bloc utilise, contrat,
    dépendances (produite par un autre bloc, par un groupe non choisi, ailleurs ou nulle part ; valeur
    fournie explicitement), départ au milieu de l'enregistrement, groupes internes non consécutifs ;
  - publication tout ou rien après validation (schéma, données, contrat, noms), en version 1, avec la
    provenance complète ; comparaison avec la source et mise à jour demandée, à revalider ;
  - API : `library.planExtraction`, `publishExtraction`, `details`, `compareSource`,
    `updateFromSource`.
- **Revue d'un enregistrement, onglet Publier** : faits de l'enregistrement et action principale ;
  groupes avec leurs données et dépendances, panneau du groupe (étapes à garder), résumé du plan,
  ajout du producteur manquant ou valeur fournie, aperçu de chaque bloc, publication.
- **Bibliothèque refondue** : catalogue compact (grille ou liste, type, regroupement par origine,
  récents), fiche à onglets (étapes, contrat, données, graphe des dépendances, versions, provenance et
  comparaison avec la source), compositeur en trois colonnes avec le contrat du parcours.
- La vérification d'un parcours avertit quand un bloc a une page de départ sans y aller.
- **Console d'exécution dans l'éditeur** : le journal réel d'une exécution (Dry Run ou Rejouer), en
  direct, pour les quatre formats :
  - le moteur (YAML, `.feature`) : début et fin de chaque étape avec sa ligne, effet exécuté ou
    confirmé, requêtes de l'étape, résolutions de cible, réparations proposées, anomalies ;
  - le Dry Run : intentions et verdict de chaque étape attendue ;
  - Playwright Test : un reporter donne chaque geste et vérification avec sa ligne et son étape ;
  - Java : Maven et le journal du pilote Playwright (`DEBUG=pw:api`).

  Onglets Console, Étapes, Erreurs, Réseau, Navigateur, Résumé et Diagnostics ; critères d'affichage (niveau,
  catégorie, étape, type, statut, période, texte) ; suivi en bas et pause ; copie ; téléchargement JSON
  ou texte ; arrêt (demandé puis confirmé) et relance ; une ligne mène à son étape et à sa ligne.
  La console s'étend sous les trois colonnes ; une poignée règle sa hauteur, « Agrandir » lui donne tout
  l'espace ; une seule barre d'outils, et une barre d'état sous le journal.

- **Navigateur visible** : le Dry Run, Rejouer, Relancer et l'écran Exécutions (rejeu ou exploration)
  peuvent jouer dans un navigateur visible, sur la machine du serveur, avec un ralenti au choix
  (250 ms, 500 ms, 1 s par geste). Moteur : `browser.headless: false` ; Playwright Test : `--headed` ;
  Java : `QA_HEADLESS=false`, `QA_SLOW_MO`. SDK : `headed` et `slowMoMs` dans `generation.execute`,
  `executions.start` et `explorations.start` ; `capabilities().visibleBrowser`. Sans écran sur le
  serveur, la demande est refusée (`409 NO_DISPLAY`) et la case du Dashboard dit pourquoi.
- Dashboard : la liste d'une sélection (projet, exécution, critères) s'ouvre en un menu aux couleurs du
  Dashboard là où le navigateur le permet (`appearance: base-select`, Chromium 135 et plus) ; ailleurs,
  la liste du système, comme avant.

- SDK : `generation.runEvents` (flux SSE du journal, reprise après une coupure sans doublon) et
  `generation.runLogs` (export) ; contrat `RunLogEvent` ; `TestRunView.logs` (en direct, conservé,
  indisponible). Le journal est écrit dans `events.jsonl` et masqué (secrets du run compris).
- Moteur : `RunOptions.onLog` (le journal structuré en direct), `ExplorationListener.onFlowStepStart`
  (début d'une étape) et `sourceLine` sur une étape venue d'une phrase Gherkin.
- Client du SDK : après `close()`, un flux ne transmet plus les événements déjà lus du même paquet.

- **Dashboard : Éditeur des tests générés** (menu Piloter, ou « Ouvrir dans l'éditeur » depuis les Tests
  générés). Un seul écran pour le flow YAML, le `.feature`, le test Playwright et le projet Java :
  - explorateur des fichiers, onglets, inspecteur de l'étape, diagnostics et résultats ;
  - vue **visuelle** du flow YAML et du `.feature` (ajouter, dupliquer, supprimer après confirmation,
    déplacer par glisser-déposer ou Alt+↑/↓, groupes) : chaque geste modifie le texte source à sa place,
    commentaires et reste du fichier gardés, références de groupes et d'assertions renumérotées ;
  - vue **source** avec CodeMirror 6 (coloration, numéros de ligne, recherche, repli, annulation,
    diagnostics dans la marge, Ctrl+S) et plan des tests pour TypeScript et Java ;
  - **comparaison** côte à côte avec la version enregistrée, la version générée ou une régénération ;
  - actions réelles : Valider (outils du serveur), Dry Run du moteur (brouillon compris), Rejouer,
    Enregistrer (vérifié, jamais d'écrasement silencieux), revenir à la version générée.
- SDK : `generation.checkFile` (vérifier sans écrire), `generation.original` (version générée),
  `generation.preview` (ce qu'une régénération écrirait) et le Dry Run des tests générés
  (`generation.execute` avec `mode: 'DRY_RUN'`). Les refus et vérifications portent des diagnostics
  positionnés (`GeneratedFileDiagnostic` : famille, outil, ligne, colonne, étape).
- Java : une erreur de `mvn test-compile` donne un seul diagnostic, sur son fichier et sa ligne, avec son
  détail (`symbol`, `location`). Elle n'est plus répétée sur chaque fichier du projet Java, et les lignes
  d'aide de Maven ne comptent plus comme des erreurs.
- Dépendances de développement : CodeMirror 6 et esbuild, versions fixées ; le kit de l'éditeur est
  regroupé au build (`dist/sdk/ui/editor-kit.js`, licences à côté) et chargé à la demande.

- **Dashboard : écran « Tests générés »** (menu Piloter). Pour un enregistrement terminé : générer les
  formats choisis, lire chaque fichier et son statut de génération, puis **exécuter pour de vrai** :
  - le flow YAML et le `.feature` rejoués par le moteur avec la mission du projet (SafetyPolicy,
    authentification, environnement au choix), avec le rapport QA-CRAWLER ;
  - le test Playwright lancé par Playwright Test (JUnit XML lu) ;
  - le projet Java lancé par `mvn test` (rapports Surefire lus).

  Chaque format dit l'outil du serveur et s'il est présent ; l'exécution se suit en direct, s'annule,
  et montre les cas, les messages d'échec et la sortie de l'outil. Playwright et Java, qui pilotent
  l'application sans la SafetyPolicy, demandent le droit `RUN_WRITES`.

- **Modifier un fichier généré à la main**, depuis l'Éditeur (ou `generation.editFile`). Le
  contenu est vérifié avec l'outil de son format avant d'être écrit ; refusé, rien ne change et les
  raisons s'affichent. Le fichier est marqué « Modifié à la main », sa version générée est gardée
  (« Revenir à la version générée »), une régénération qui le remplacerait demande une confirmation, et
  une exécution dit qu'elle a joué des fichiers modifiés. Modifier un test Playwright ou Java demande
  `RUN_WRITES`.
- SDK : `generation.view`, `generation.execute`, `generation.runOf`, `generation.cancel`,
  `generation.reportLink` ; routes `GET …/recordings/:name/generation` et `…/recordings/:name/test-runs`.
  `generation.json` garde désormais les fichiers des formats non régénérés.

- Export `@qa-crawler/core/requirements` : le module d'exigences depuis Node.
- **Référentiel d'exigences : socle et connecteur Confluence** (`docs/requirements/`).
  - Audit et conception : ce qui existe, ce qui manque, les décisions, le plan.
  - Modèle canonique (exigence, règle d'affaires, critère d'acceptation, provenance, lien de
    traçabilité) et contrat de connecteur.
  - Normalisation par règles explicites : chaque candidat dit pourquoi il est classé.
  - Doublons et conflits, décisions humaines avant publication, versions et historique, liens
    proposés ou confirmés, persistance en fichiers JSON.
  - Connecteur Confluence Cloud et Data Center (API REST officielles), testé contre un serveur
    **simulé** seulement.
  - Connecteur PDF : `pdfjs-dist` 6.4.299, dépendance facultative à version exacte, sans
    vulnérabilité connue. La lecture est durcie (worker isolé, `isEvalSupported: false`, aucun accès
    réseau) ; la page de chaque bloc est gardée ; une page sans texte est signalée ; aucun OCR.
  - Connecteurs Word (`.docx`) et Excel (`.xlsx`), sans dépendance.
    - Un lecteur ZIP défensif refuse les bombes de décompression, les archives chiffrées, les CRC
      faux et les anciens formats.
    - Word : titres par style ou niveau de plan, listes, tableaux, modifications suivies signalées.
    - Excel : feuille et cellule d'origine, en-tête par feuille, formules non calculées et
      cellules en erreur signalées.
    - Profils d'importation réutilisables (colonnes, préfixes, feuilles).
  - La corrélation et les interfaces (SDK, CLI, Dashboard) restent à venir.

- **Annulation contrôlée** d'une exploration ou d'un rejeu (`docs/sdk/README.md`, « Statuts »).
  - Moteur : `RunOptions.signal` ; il s'arrête avant l'action ou l'étape suivante, ferme le
    navigateur et écrit son rapport (`stopReason: cancelled`).
  - SDK : `client.explorations.cancel(id)`, statut et verdict `CANCELLED`
    (`capabilities.cancellation: true`). Une exécution annulée n'entre pas dans le taux de réussite.
  - CLI : le premier Ctrl+C demande cet arrêt, avec le code de sortie `130` ; un second Ctrl+C
    quitte tout de suite.

- **Dashboard, écran Enregistrements et finitions** :
  - démarrer, suivre en direct et arrêter l'enregistrement d'un parcours ; liste des enregistrements
    du projet, lien vers le Flow Studio, promotion en scénario ;
  - contrôles compacts (36 px à la souris, 44 px au doigt), listes déroulantes et choix de fichier
    au style du Dashboard, champs numériques à leur largeur, boutons qui ne s'étirent plus ;
  - la note « auteur non enregistré » ne s'affiche plus qu'en mode à jeton unique ; une description
    qui ne fait que répéter le titre n'est plus affichée.
- **Dashboard, tout le recorder** : ce que fait la fenêtre du recorder se fait aussi dans le Dashboard.
  - Pendant l'enregistrement : les gestes en phrases avec leur statut (les messages bruts du recorder
    sont repliés dans un journal technique), pause et reprise, annulation du dernier geste,
    vérification posée sur l'écran courant, choix de l'élément touché quand la cible est ambiguë ;
    après l'arrêt, les phases du traitement en mots avec leur progression.
  - Revue d'un enregistrement terminé (bouton « Revoir ») :
    - parcours en groupes : découpage proposé d'après les étapes métier, créé sur décision ;
      vérifications de groupe suggérées ; cocher des étapes pour créer un groupe, y ajouter ou en
      détacher ; renommer, déplacer, supprimer un groupe ; monter ou descendre une étape ; retirer
      une étape, confirmé dans la page ;
    - assertions rangées comme dans le recorder (recommandées, à décider, faibles, décidées) :
      accepter, refuser, désactiver, modifier, réinitialiser, une à une ou en lot ;
    - source de chaque saisie (fixe, générée, reprise d'une étape antérieure) ; un secret ne se lie pas ;
    - génération des tests (YAML, Gherkin, Playwright, Java) et ce qu'est chaque fichier produit ;
    - rejeu de validation sans fenêtre sur le serveur, suivi étape par étape ;
    - correction d'une cible : le serveur rejoue les étapes précédentes dans un navigateur ouvert sur sa
      machine, la personne y clique l'élément voulu, le Dashboard montre la proposition (cible actuelle et
      nouvelle, ordre d'essai, façon de retrouver une ligne de tableau) ; la cible n'est remplacée qu'à la
      validation ; le rejeu reprend ensuite à l'étape corrigée ; l'original se restaure ;
    - ligne de tableau redéfinie colonne par colonne à partir des cellules enregistrées, sans navigateur ;
    - revue des intentions : confirmer, corriger avec une raison, réinitialiser (registre des décisions).
  - SDK : `recordings.pause/resume/undo/checkpoint/resolve/ignore` (droit `RUN`),
    `recordings.removeStep`, `recordings.replay/replayStatus` (droit `RUN`),
    `groups.proposals/acceptProposals/checks/addCheck`, `recordings.intents/reviewIntent`,
    `recordings.rowSource/editRow/restoreTarget`, `corrections.start/get/pick/apply/resume/close` (une
    session à la fois ; ouvrir et reprendre demandent `RUN`, valider `DECIDE`) ; événement `timeline`
    (seul le dernier état est gardé) ; les phases portent leur rang et leur détail.
  - Les étapes du Studio et du flow sont dites dans la langue du serveur (« Vérifier : "À propos" »
    au lieu de « the link … ») ; le dernier rejeu du Studio est dit en mots (« conforme »).
  - Moteur : le rejeu de validation (`replayRecordedFlow`), le retrait d'une étape et la vérification
    de groupe sont partagés entre la fenêtre du recorder et le SDK.
- **Bibliothèque de scénarios** : des blocs réutilisables (`reusable: true`), jamais exécutés seuls,
  que d'autres scénarios rejouent par une étape `run: <bloc>`.
  - Un scénario, ou un groupe métier d'un enregistrement (depuis la revue), devient un bloc ; ses
    étapes et ses données de test sont recopiées sous `<flows>/library/<bloc>/`.
  - Composer un parcours à partir de blocs (écran Bibliothèque) : un nouveau scénario sous
    `<flows>/composed/`, rejouable comme les autres ; insérer un bloc au début ou à la fin d'un
    scénario existant (écran Scénarios). Les données des blocs rejoignent le jeu du scénario ; une
    donnée définie autrement des deux côtés est refusée, jamais écrasée.
  - Un bloc rejoué par un scénario ne se retire pas ; un bloc ne se lance pas seul (`REUSABLE_BLOCK`).
  - Moteur : quand on rejoue des scénarios choisis, les blocs suivent toujours (un `run:` les trouve).
- **Bibliothèque de scénarios, contrats et versions** :
  - Contrat de chaque bloc : dérivé de son contenu, ou déclaré (entrées obligatoires ou facultatives,
    sorties, préconditions, postconditions) et confronté à ce contenu.
  - Vérification d'un parcours avant sa création (dry run de composition, rien n'est exécuté) :
    dépendances entre blocs, entrées manquantes ou produites trop tard, conflits de données (une valeur
    fixe face à une valeur générée au rejeu comprise), données partagées, erreurs de structure.
  - Insertion et composition atomiques (tous les fichiers ou aucun), une opération à la fois par projet,
    révision du scénario vérifiée (409 si modifié depuis sa lecture) ; les refus détaillent leurs raisons.
  - Versions : `sdk-library.json` passe en version 2 (identifiant, version, empreinte, historique,
    origine, contrat ; version de chaque bloc rejoué par un parcours). Un bloc modifié devient une
    nouvelle version seulement quand on la valide ; un parcours suivi n'est pas rejoué avec ce bloc
    (409 `BLOCK_VERSION_CHANGED`) tant que la nouvelle version n'est pas acceptée. L'ancien registre est repris.
  - Dashboard : catalogue avec recherche, origine, contrat, utilisation et tri ; cartes compactes et
    détails (provenance, historique, contrat, dépendants) ; compositeur fixe à droite avec la
    vérification du serveur ; ajout d'un bloc dans un panneau latéral, avec l'aperçu de la source.
- **Carte des écrans visités** (rapport `index.html` et `flow-graph.html`) : refaite pour rester lisible
  avec de nombreux écrans et branches, sans dépendance nouvelle.
  - Disposition en couches qui tient compte de la taille réelle des cartes : de haut en bas pour un
    parcours qui tient dans la largeur du rapport, de gauche à droite sinon. Les branches alternatives
    prennent des colonnes distinctes, séparées par un espace supplémentaire.
  - Flèches orthogonales : chacune part d'un bord et arrive sur un bord, ne traverse aucune carte et
    a sa propre piste (aucun trajet partagé). Les retours, raccourcis et cycles passent par les côtés,
    en tirets, avec leur pointe. L'action est posée sur sa flèche, dans une bande réservée hors des cartes.
  - Cartes : titre et adresse sur deux lignes au plus, statut (validé, échec, avertissement, non jugé :
    jamais validé sans vérification réussie à l'arrivée), nombre d'actions et de vérifications.
  - Cliquer un écran montre ses actions, ses arrivées, les vérifications, les anomalies et la capture ;
    mise en avant par statut, zoom, ajustement à la fenêtre (refait quand le cadre change de taille),
    déplacement à la souris. Sans JavaScript, la carte se lit et les détails s'ouvrent par ancre.
  - SDK : `library.list/add/remove`, `scenarios.compose/insert` (droit `PUBLISH`) ; `ScenarioView`
    porte `reusable`, `uses` et `description`.
- **Flow Studio** : un onglet Tests génère les tests (formats, groupes) et dit ce qu'est chaque fichier ;
  les phrases du moteur (assertions, raisons du rejeu et de la reprise) s'affichent en français dans le
  Studio et le Dashboard ; Monter et Descendre au lieu d'Avancer et Reculer ; la recherche garde un
  texte d'aide court ; une étape rejouée ne montre plus de raison inutile.
- **Accès nominatifs** (`sdk-server --access named`, `startSdkServer({ access: 'named' })`) :
  - jetons par personne ou robot, conservés par leur seule empreinte et montrés une fois ;
  - quatre rôles (Lecteur, Analyste, Pilote QA, Administrateur), un rôle possible par projet ;
  - droits vérifiés par le serveur à chaque appel ; un rejeu avec écritures demande `RUN_WRITES` ;
  - auteur des décisions tiré du jeton ;
  - journal de chaque écriture et de chaque refus, sans valeur ni jeton ;
  - écran Accès et journal, et connexion par jeton personnel dans le Dashboard.

  Le mode à jeton unique reste le défaut et ne change pas.

- **Exigences dans le SDK et le Dashboard** :
  - API `requirements.*` : connecteurs, import d'un fichier Word, Excel ou PDF (envoyé tel quel,
    25 Mo au plus) ou d'une page Confluence (noms des variables seulement), lots, décisions,
    publication (accord explicite pour une lecture partielle), matrice et son CSV protégé contre les
    formules, liens ajoutés, confirmés ou rejetés, indicateurs ; `trends.get` par semaine ISO.
  - Écrans Sources, Validation d'un import, Référentiel, Traçabilité, Indicateurs (formule,
    dénominateur, exclusions, limites) et Tendances ; le menu compte les candidats en attente.
  - Non disponibles, et dits comme tels : la corrélation automatique (phase 5), l'auteur des
    décisions, la création d'un profil par l'API.
- **Dashboard, écrans d'exploitation** :
  - Historique : deux exécutions cochées sont comparées par le serveur (régressions, corrections,
    écarts par flow et par étape, durée), et les flows qui échouent maintenant se rejouent.
  - Scénarios : stabilité sur les derniers runs, avec « instable » à partir de deux bascules ;
    rejeu d'un scénario ; promotion des enregistrements terminés.
  - Environnements : création, modification, vérification avec l'URL jointe, suppression confirmée
    dans la page.
  - Explorations : carte des écrans tirée du graphe du run, actions bloquées, anomalies par écran
    et sélection par gravité.
  - Nouveau point d'API `scenarios.history(projectId, { limit? })`
    (`GET …/scenarios/history`), ajouté à la v1.

- **Dashboard selon la maquette, responsive** : menu par sections avec le projet choisi et les
  versions du service et du moteur ; écran Projet en onglets (Lancer, Environnements, Scénarios,
  Exécutions, Sécurité) ; lancement d'un rejeu ou d'une exploration ; environnements « prêts » ou
  non (règles, secrets présents sur le serveur, URL jointe sur demande) ; politique de sécurité
  (risques toujours bloqués, écritures, domaines) ; écran Exécutions du projet ; exécution avec
  durée, compteurs d'exploration, assertions, anomalies et preuves. Sous 960 px le menu se replie
  derrière un bouton ; sous 600 px tout passe sur une colonne. IBM Plex Sans servi par le serveur.
  `capabilities.safety.blocked` : les risques que le moteur bloque toujours (ajout à la v1).
- **Dashboard** (`<qa-crawler-dashboard>`, page `/dashboard`, `docs/sdk/README.md`) : vue
  d'ensemble, projets, lancement d'un rejeu, suivi en direct, annulation et archivage confirmés
  dans la page, détail d'une exécution. Il est construit sur le client du SDK, en thème clair
  (accent violet) avec thème sombre, en français et en anglais, et il est testé dans Chromium avec
  le vrai moteur.
  - Le taux de réussite s'affiche avec son numérateur, son dénominateur et ses exclusions.
  - Les phases du moteur sont traduites dans le Run Monitor et l'assistant.

- **Audit et plan du SDK central** (`docs/sdk/MASTER-PLAN.md`) et décision d'architecture
  (`docs/sdk/adr/0001-sdk-central.md`) : un service local, un client, une façade Node ; la CLI et le
  Dashboard en sont des clients.

- **CLI de la plateforme** (`docs/sdk/CLI.md`) : `project list|show`, `env list|show|validate`,
  `scenario list|promote`, `run start|list|results|status|cancel`, `overview`, `doctor`, sur le
  client du SDK.
  - Deux modes : local (`--workspace`) ou distant (`--endpoint`, jeton par variable).
  - Sortie `--json`, et JUnit XML d'un run (`--junit`).
  - Codes de sortie : `0`, `1`, `2`, `3` et `130` (Ctrl+C annule).
  - Le client accepte `selfId` pour vérifier un environnement existant.

- **SDK dans un programme Node** : `openQaCrawler({ workspace })` démarre le service sur 127.0.0.1
  (port libre, jeton jamais affiché) et rend le client ; `close()` annule ce qui tourne. Exemple
  exécutable `examples/sdk-node/replay.mjs` (codes de sortie selon le verdict), testé avec le vrai
  moteur. L'arrêt du serveur SDK annule désormais les exécutions en cours avant de fermer.

- **SDK : plateforme** (`docs/sdk/README.md`, audit `docs/sdk/PLATFORM-AUDIT.md`).
  - **Projets** : liste, détail, modification revalidée par le moteur, duplication sans secret,
    archivage sans suppression, restauration.
  - **Environnements** : cible, domaines autorisés, variables non secrètes, noms de secrets, délais,
    limites et écritures permises. Ils sont vérifiés avant le lancement et appliqués à la mission.
  - **Scénarios** : les flows du projet, et la promotion d'un enregistrement en scénario.
  - **Exécutions** : rejeu par le moteur (`runMission`, mission `replay`), suivi en direct, puis
    détail lu dans le run (verdict, étapes, assertions, preuves).
  - **Vue d'ensemble** : calculée sur disque, avec un taux de réussite qui dit son périmètre.
    Uniquement des ajouts : `SDK_API_VERSION` reste `1`.

- **Recorder : revue organisée** (`docs/RECORDING_ASSERTIONS.md`). Groupes proposés d'après les étapes
  métier reconnues (créés d'un clic, jamais sans décision, ordre des étapes intact) ; vérification de
  groupe « la donnée reçue est visible à la fin du groupe », écrite comme une étape `expect` qui cite
  `${testData:…}` (valeur du run au rejeu) ; fil des trois étapes de la revue ; groupes en cartes qui
  contiennent leurs étapes ; barre de sélection seulement quand des étapes sont cochées ; propositions
  triées en recommandées, à décider et faibles (décisions groupées) ; génération repliée ; en-tête sur
  deux lignes dans une fenêtre étroite.

- **SDK : thème sombre** (`theme="dark"` ou `"auto"`) pour l'assistant, le Flow Studio, la
  comparaison et le Run Monitor ; les variables de l'hôte gardent la priorité. Les couleurs de statut
  de la comparaison et du Run Monitor sont foncées vers la couleur du texte pour atteindre le contraste
  WCAG AA dans les deux thèmes (calculé par un test).
- **SDK : Run Monitor** (`docs/sdk/README.md`). Le flux d'une exploration porte les flows imposés et
  leurs étapes (`flow`, `flow-step`), avec des libellés sans valeur saisie. `<qa-crawler-run-monitor>`
  (page `/monitor`) suit l'exploration en direct : statut, état du flux et reprise annoncés, avancement
  des flows, journal à afficher par flow, statut d'étape, type d'événement ou type d'anomalie.
- **SDK : comparaison de deux exécutions et traçabilité** (`docs/sdk/README.md`). `reports.compare`
  compare deux explorations flow par flow (règle `compareFlowRuns` du moteur) et exigence par
  exigence (couverture du moteur dans chaque run) ; `reports.traceability` et `reports.regression`
  servent `quality-verification.json` et `regression-analysis.json`. Le composant
  `<qa-crawler-run-compare>` (page `/runs`) les montre, sans recalcul ni pourcentage.
- **SDK : tests générés exécutables** (`docs/sdk/README.md`). Le format Gherkin ajoute une mission
  (`<nom>.gherkin.mission.yaml`) qui joue le `.feature` avec le moteur, validée par son chargeur à la
  génération ; le format Playwright ajoute `playwright.config.ts`, qui écrit un rapport JUnit XML. Un
  test d'intégration enregistre un parcours, le génère et joue les deux sorties (`.feature` par la
  mission, spec par Playwright Test). `@playwright/test` 1.56.1 rejoint les dépendances de
  développement (les tests du dépôt l'utilisent ; le paquet publié n'en dépend pas).
- **SDK : données de test et verdicts d'assertions** (`docs/sdk/README.md`). `client.data.get` donne
  la lignée de chaque donnée, la source de chaque saisie et les données citées sans origine (que le
  rejeu inventerait) ; `client.data.bind` choisit la source d'une saisie (fixe, générée, reprise d'une
  étape antérieure) avec la règle de la fenêtre du recorder. Chaque proposition d'assertion porte un
  verdict `VERIFIED_PASS / VERIFIED_FAIL / BLOCKED / INCONCLUSIVE / NOT_EXECUTED` lu dans le dernier
  rejeu (étape `expect` ou moteur d'assertions métier), jamais supposé. Le Flow Studio gagne les
  onglets Données et Assertions et la source de la valeur de chaque saisie. Le module de liaison
  accepte un enregistrement relu sur disque (`BindingContext`).
- **SDK : Flow Studio** (`<qa-crawler-flow-studio>`, page `/studio`, `docs/sdk/README.md`). Le parcours
  d'un enregistrement en graphe : groupes métier en cadres repliables, étapes, données produites et
  citées, liens producteur → consommateur, citations avant production, chemin du dernier rejeu.
  Zoom, déplacement, recherche, ajustement de la vue, panneau latéral, clavier. Créer, renommer,
  décrire, replier, réordonner, déposer une étape sur un groupe : chaque geste est une commande que le
  moteur vérifie ; un refus est expliqué et ne change rien. Nouvelle route
  `GET /api/projects/:id/recordings/:name/studio` (`client.recordings.studio`), lue dans les fichiers
  du moteur.
- **SDK : flux d'événements qui survit aux coupures, contrat versionné** (`docs/sdk/README.md`, audit
  `docs/sdk/MASTER-AUDIT.md`). Le client rouvre lui-même un flux coupé avant sa fin, après le dernier
  événement reçu, et ne transmet jamais deux fois le même événement ; un refus n'est pas réessayé.
  `client.connect()` vérifie la version du contrat annoncée par le serveur (`API_VERSION_MISMATCH`),
  l'assistant l'utilise. Un test fige le contrat public de la version 1 et vérifie que le Core et
  l'UI n'importent rien de Node, de Playwright ni du moteur.
- **Salesforce Lightning : profil de plateforme** (`docs/SALESFORCE_LIGHTNING.md`). `target.platform:
salesforce-lightning` (projet : `application.platform`, assistant du SDK : type « Salesforce
  Lightning ») : la garde d'écriture laisse passer les `POST /aura` dont toutes les actions lisent
  (reconnues au nom de la méthode) et les requêtes GraphQL sans `mutation` ; les écritures restent
  bloquées et signalées. Pour toutes les applications : l'attente d'écran voit les chargeurs et les
  éléments dans les arbres Shadow DOM (`lightning-spinner` reconnu), les routes
  `/lightning/r/<Objet>/<Id>/…` deviennent un modèle (`:recordid`), `data-aura-rendered-by` est un
  attribut généré. Vérifié sur une imitation locale de Lightning (`tests/fixtures/lightning-app.ts`),
  jamais sur une vraie organisation Salesforce ; la documentation donne les scénarios et la grille
  pour l'évaluer sur une sandbox.
- **SDK : enregistrements, assertions, groupes, génération, graphe et rapports** (`docs/sdk/README.md`).
  Les espaces de noms réservés deviennent des appels réels du client (`recordings`, `assertions`,
  `groups`, `generation`, `graph`, `reports`) et du serveur : un enregistrement lancé par l'API
  ouvre le vrai recorder (navigateur visible, un à la fois, arrêt par la barre ou par l'API, flux
  d'événements), puis décisions sur les propositions d'assertions, groupes métier (dépendances de
  données vérifiées), génération YAML / Gherkin / Playwright / Java validée statiquement, graphe
  d'écrans d'une exploration ou d'un enregistrement, liste des rapports d'un projet et liens à ticket.
  La logique de la revue du recorder est extraite dans `src/recording/recording-workspace.ts`,
  partagée par la fenêtre du recorder et le SDK.
- **SDK : l'assistant de création de projet, autonome ou embarqué** (`docs/sdk/README.md`, décisions
  `docs/sdk/AUDIT.md`). `qa-crawler sdk-server --workspace <dir>` (`--allow-origin`,
  `--allow-source-root`, `--token-env`, `--concurrency`) sert une API locale à jeton et l'élément
  `<qa-crawler-project-wizard>` (Web Component, Shadow DOM, FR/EN, variables de thème `--qa-*`,
  mode `embedded`) : projet, environnement (Chromium, connexion par noms de variables `QA_*` dont le
  serveur ne donne que la présence), exploration (budgets, exclusions, vérifications ; modifications
  figées sur désactivées), récapitulatif validé par le moteur avec le fichier exact, puis
  l'exploration par `runMission` suivie en direct (SSE numérotés et rejouables) jusqu'au résultat du
  moteur et aux rapports (liens à ticket, CSP `sandbox`). Contrats, client (`createQaCrawler`) et
  cycle de vie dans `@qa-crawler/core/sdk`, élément dans `@qa-crawler/core/sdk/ui`, serveur dans
  `@qa-crawler/core/sdk/server`. Ni annulation, ni pourcentage, ni durée restante : le moteur n'en
  offre pas. Exemple d'hôte sur une autre origine : `examples/sdk-host/`.
- **Knowledge Center** (`qa-crawler knowledge-center`, `npm run qa -- knowledge-center -c <mission>`) :
  le tableau de bord de la mémoire, servi en local (`node:http`, page au thème QA-CRAWLER, API JSON),
  branché sur les données réelles : tables de persistance, base de connaissances fichier, connaissance
  fonctionnelle, règles, enregistrements. Vue d'ensemble (métriques avec formule, « Non disponible »
  sinon), Knowledge Explorer (recherche, critères, tri, pagination côté serveur, détail avec preuves,
  provenance, historique, exécutions), flows et graphe interactif, variables des enregistrements
  (producteur, consommateurs, problèmes détectés), qualité (statuts de fiabilité calculés à partir des
  compteurs, signaux définis), historique, persistance (provider réel, santé, comptages, schéma), export
  versionné (`qa-crawler-knowledge-export` v1, validé par zod), import avec aperçu et politique explicite,
  sauvegardes et restauration confirmée. Les décisions humaines (valider, invalider) vont dans un
  registre à part (`knowledge-center/review-ledger.json`, ajout seul, versions) que le moteur ne lit
  jamais. Écritures protégées (jeton de session, en-tête dédié, origine), `--read-only`, aucun secret lu.
  Ajout facultatif `inventory` au `PersistenceProvider` (applications et comptages), implémenté par les
  providers mémoire, fichier et base de données. Documentation : `docs/KNOWLEDGE_CENTER.md`, diagnostic
  préalable `docs/knowledge-center-audit.md`.
- **Assertions issues du recording, groupes métier, génération multi-format**
  (`docs/RECORDING_ASSERTIONS.md`, diagnostic `docs/recording-assertions-audit.md`). À l'arrêt d'un
  enregistrement : des **observations** identifiées par source et fiabilité (`observations.json`, ce qui
  manque est dit, rien n'est reconstitué) ; des **propositions d'assertions** avec origine (observée,
  déduite — à confirmer —, explicite), catégorie, preuves, méthode, limites et confiance
  (`assertion-proposals.json`), décidées dans la fenêtre du recorder (accepter, refuser, désactiver,
  réinitialiser, modifier) : une acceptation écrit une étape `expect` ou une assertion métier
  (`assertions:` du schéma de la mission, vérifiée par le rejeu) ; sans décision, le flow est celui
  d'avant. Des **groupes métier** (`src/recording/step-groups.ts`) : créer, renommer, décrire,
  regrouper, déplacer, réordonner, replier, détacher, supprimer (étapes gardées), avec les dépendances
  de données vérifiées (un ordre qui cite une valeur avant sa production est bloqué et expliqué),
  l'exécutabilité d'un groupe seul, et `groups:` dans le YAML (positions). Une **traduction commune des
  assertions** (`src/platform/assertion-translation.ts`) pour les trois générateurs : natives sur
  l'écran, sinon « vérifiée par le rejeu seulement » en commentaire explicite ; les groupes en en-têtes.
  Un **plan de génération** (`src/platform/generation-plan.ts`, section « Génération des tests » de la
  fenêtre, `generation.json`, `generated/`) avec des statuts honnêtes : `GENERATED`,
  `STATICALLY_VALIDATED` (schéma, dictionnaire Gherkin, TypeScript en syntaxe, `mvn test-compile`),
  `NOT_VALIDATED`, et `EXECUTED` / `PASSED` / `FAILED` / `BLOCKED` / `INCONCLUSIVE` seulement d'après une
  exécution réelle. `npx qa-crawler generate-tests --gherkin` (`src/platform/gherkin-feature-generator.ts`).
  Le rapport JUnit XML ajoute un cas par assertion métier exécutée (`PASS` → réussi, `FAIL` →
  `failure`, sinon `skipped` avec le motif). API exportée : `observationsOf`, `proposeAssertions`,
  `decideProposal`, `applyGroupCommand`, `groupViews`, `flowForGroups`, `translateAssertions`,
  `planGeneration`, `validateArtifacts`, `generateGherkinFeatures`.

- **Rapport JUnit XML** (`src/reporting/junit-reporter.ts`, `report.junit`, option `--junit`,
  `reporting.format: [html, json, junit]` dans la configuration de projet). Un reporter de plus,
  désactivé par défaut, qui ne lit que le résultat du run et ne change rien aux rapports existants :
  `reports/junit.xml` avec une suite par flow et un cas par étape (`FAILED` → `failure`, `BLOCKED` →
  `error`, ignorée, manuelle ou facultative échouée → `skipped`), une suite `anomalies` pour les
  anomalies au seuil de `report.failOnSeverity`, et un cas réussi quand rien n'a tourné. Une erreur
  d'écriture est un avertissement (`report.junit.required: true` la rend bloquante). Exporté par
  l'API (`JUnitReporter`, `junitXmlOf`). Audit préalable : `docs/playwright-junit-audit.md`.
- **Générateur Java JUnit 5 + Playwright Java** (`src/platform/java-junit-playwright-generator.ts`,
  `npx qa-crawler generate-tests --java [--out] [--package]`, `platform.generatedTests.java`, API
  `generateJavaJUnitPlaywrightProject` / `writeJavaProject`). Un adaptateur indépendant du moteur qui
  produit un projet Maven exécutable des flows : une classe JUnit 5 par flow pilotée par Playwright
  Java (localisateurs sémantiques, lignes de tableau, données de test générées par run et réutilisées
  entre les étapes, valeurs littérales et secrets par variables d'environnement, assertions `expect` et
  `effects`, preuves à l'échec, `manual` journalisé, `auto`/`intent` signalés et abandonnés plutôt que
  faussement réussis), classes de support, `pom.xml` (Java 17, JUnit Jupiter 5.14.4, Playwright Java
  alignée sur le Playwright Node du projet, Surefire 3.5.6), README. Vérifié par compilation et
  exécution réelles contre l'application de test (`tests/integration/java-generated-tests.test.ts`).
  Java et Maven ne servent qu'à exécuter le projet généré. Exemple : `examples/java-junit-playwright/`.
  Documentation : `docs/JAVA_TEST_GENERATION.md`.
- **Génération Playwright isolée** : pendant un run, une erreur du générateur de tests
  (`platform.generatedTests`) devient un avertissement au lieu d'interrompre un run QA par ailleurs
  valide. Tests de non-régression : le générateur ne modifie pas les flows source, n'agit pas sur
  l'application, et génère un flow issu d'un enregistrement (cible CSS de repli, ligne de tableau,
  donnée du run citée).

- **Vérification métier : assertions, cohérence des données, traçabilité** (`src/quality/`,
  `docs/BUSINESS_ASSERTIONS.md`, audit `docs/quality-capabilities-audit.md`). Un flow déclare ses
  assertions métier (`flows[].assertions`, 9 genres : requête, valeur, entité, état, cardinalité,
  relation, transition, effets de bord, contrat), jugées sur le trafic observé en empreintes salées,
  l'écran final et des lectures d'API autorisées (GET, hôte permis, jamais une écriture), avec les
  valeurs DU RUN, préconditions, attente asynchrone et preuves exigées. Statuts PASS / FAIL /
  BLOCKED / INCONCLUSIVE / UNVERIFIABLE : une assertion obligatoire contredite fait échouer le flow
  (anomalie `BUSINESS_ASSERTION`) et le run ; non vérifiée, le run est INCONCLUSIVE, jamais PASS.
  La cohérence des données suit la valeur du run de la saisie à la requête, à la réponse, à l'écran
  et à la recherche, plus les relations, les clés uniques déclarées et les effets de bord
  (`flows[].consistency`, anomalie `DATA_CONSISTENCY`). La traçabilité relie exigences
  (`requirements`), règles (`businessRules`), flows (`flows[].requirements`, tags Gherkin `@REQ-…`,
  `x-requirements` OpenAPI), assertions et preuves, avec un historique pour les preuves périmées.
  Rapports `quality-verification.json` et section « Vérification métier ». L'observateur réseau
  relit, par une session CDP de lecture, le corps d'une réponse suivie d'une navigation immédiate.
- **Nouveau design de la fenêtre du recorder et de la barre d'enregistrement**
  (`src/recording/recorder-panel-html.ts`, `src/recording/capture-script.ts` ; `docs/HUMAN_FLOW_RECORDER.md`).
  Polices IBM Plex Sans et Mono intégrées (`assets/fonts`, SIL OFL 1.1, copiées dans le paquet ; rien du
  réseau). Un en-tête unique : « QA-CRAWLER / flow », pastille d'état et chrono, chiffres clés (actions,
  requêtes reliées ou à vérifier, qualité) et les actions de la phase (Annuler la dernière / Pause /
  Arrêter, puis Fermer / Rejouer / Sauvegarder le flow) ; la barre de résumé du bas et la carte qualité
  disparaissent. Onglets soulignés Parcours, Réseau, Données de test (revue), Analyse. Le parcours : une
  ligne par action (numéro, pictogramme, phrase avec la valeur en puce et le champ en gras, statut en
  point et en mot ; Rejouée / Échec / Non rejouée après un rejeu), groupes par écran, étapes métier en
  tête de groupe en revue. L'inspecteur suit la dernière action pendant l'enregistrement ; en revue,
  sous-onglets Détails / Cible / Réseau, clés-valeurs en mots (élément, emplacement, repérage, donnée),
  source de la valeur résumée (Modifier ouvre l'éditeur), Retirer l'étape. La correction devient la
  carte « Corriger la cible » (Avant / Après, « Identifier la ligne par » colonne par colonne avec Source
  et Comparaison, aperçu, détails techniques repliés). Barre dans la page : sombre, point rouge et chrono,
  Ajouter une vérification, icônes Annuler / Pause, Arrêter, notification blanche, version réduite en
  pastille ; ses polices sont ajoutées sous un nom propre à QA-CRAWLER, aucune feuille de style de
  l'application n'est touchée. Thème clair et sombre. En revue, l'aperçu montre l'écran de l'étape
  choisie : une image prise juste après chaque action pendant l'enregistrement, son élément encadré
  (mesuré sans rien afficher dans l'application), en mémoire seulement, 60 au plus. Pour un clic,
  l'écran d'avant le clic, le bouton encadré là où il était à l'appui (bascule Avant le clic / Après),
  jamais une image prise avant le dernier changement de la page (un écran de chargement) ; l'aperçu
  reprend une image quand la page change sans action, une fois posée (jamais pendant un geste). En
  plein écran, le cadre reste sur l'élément (l'image réduite et centrée le décalait).
- **Fournisseur IA Anthropic** (`ai.provider: anthropic`, `--ai-provider anthropic`) : un modèle de
  l'API Anthropic comme conseiller de raisonnement, par le SDK officiel `@anthropic-ai/sdk`
  (dépendance optionnelle, chargée dynamiquement). Même circuit que Copilot : requête nettoyée,
  proposition au schéma (sorties structurées, contraintes non prises en charge retirées puis
  revérifiées par le validateur), validation, SafetyPolicy, exécution, vérification au runtime.
  Aucun modèle fixé dans le code : `ai.anthropic.model` ou `--ai-model` est obligatoire.
  Raisonnement adaptatif, effort configurable (`ai.anthropic.effort`), instructions mises en
  cache, repli côté serveur sur refus en option (`serverSideFallback`), signalé quand il sert ; un
  refus devient une abstention `INCONCLUSIVE`, une réponse coupée est invalide. Clé lue dans
  `ANTHROPIC_API_KEY` (ou `ai.anthropic.apiKeyEnv`), jamais écrite. Tests : faux SDK (unitaires)
  et vrai SDK contre un point d'accès Messages local (intégration).
- **Démo Orbit Desk** (`tests/fixtures/orbit-desk-app.ts`, `scenarios/demo-orbit.yaml`, `npm run
demo:server` sur le port 4180) : un back-office de demandes moderne et fictif pour les démonstrations.
  Création réelle (POST → 201 + `Location`, référence propre à chaque création), liste par session,
  actions qui modifient ou détruisent, écran Rapports en panne (HTTP 500). La mission livrée produit un
  rapport, un Gherkin et des tests Playwright en français, avec des données de test générées (`testData.
defaults`). Test d'intégration : flows passés, panne détectée, écritures bloquées, aucune création.
- **Ligne de tableau : toutes les colonnes, valeurs modifiables** (`src/recording/target-correction.ts`,
  fenêtre du recorder ; `docs/HUMAN_FLOW_RECORDER.md`). Les cellules de la ligne cliquée sont gardées dès
  l'enregistrement (`RecordedElement.rowCells`), plus seulement la clé de ligne. **Choisir les colonnes de la
  ligne** (correction dans le navigateur) et **Modifier la ligne** (revue, sans navigateur) montrent toutes les
  colonnes : on en combine plusieurs et chacune prend sa valeur d'une source — valeur lue, valeur modifiée dans
  la fenêtre, donnée du run, ou nouvelle donnée de test ajoutée à `test-data.yaml` — avec un critère « égale » ou
  « contient ». **Aperçu dans la page** compte les lignes qui correspondent (`scanTableRows`, rien n'est
  cliqué). `rowOfColumns`, `editFlowRow`, `recordedRowCells`, `addRowVariables`, commandes `row-preview` et
  `row-edit`, option `columns` de `correct-apply`. Remplace « Lier une colonne à une donnée du run » (l'option
  `manual` reste acceptée). Tests unitaires `row-columns`, intégration `recording-row-columns` et aperçu dans
  `recording-row-correction`.
- **Restauration du contexte à la reprise d'un rejeu corrigé** (`src/replay/context-checkpoint.ts`,
  `src/replay/context-capture.ts`, session de correction, fenêtre du recorder ; `docs/CONTEXT_RECOVERY.md`).
  Un checkpoint de contexte est pris devant chaque étape de la session (URL complète, route, cadres, onglets,
  dialogue, champs, défilement, contrôles, données du run, étapes à effet métier, préconditions). Après une
  correction validée, **Reprendre ici** compare la page tenue au checkpoint et décide : REVALIDATE (préconditions
  dures vérifiées), RESTORE (les étapes qui remplissent les champs perdus), REBUILD (les étapes précédentes avec
  les mêmes données du run) ou MANUAL_RECOVERY (session expirée, création qui serait répétée, précondition non
  satisfaite). L'étape corrigée et la suite sont rejouées dans la même session ; un échec suivant garde la page
  devant l'étape en échec. `TestDataRunContext.seed()`, `replay.contextRecovery`, `replay-checkpoints.json`
  (empreintes), événements `REPLAY_CONTEXT_RECOVERY`, `REPLAY_RESUMED`, `REPLAY_RESUME_BLOCKED`. Tests unitaires
  (17) et d'intégration `recording-context-recovery`.
- **Bloc de correction redessiné** (fenêtre du recorder). Cartes Avant / Après lisibles (rôle, nom de l'élément,
  ligne du tableau sur sa propre ligne, donnée du run en pastille ; la cible brute reste en infobulle), façons
  d'identifier la ligne en cartes à choisir (« Recommandé », « Propre à ce run »), avertissements en encarts,
  ordre de résolution sur une ligne, traits techniques repliés dans « Détails techniques », Tester / Annuler /
  Valider sur une seule ligne, en-tête de l'action masqué pendant la correction. L'historique d'une correction
  utilise les mêmes cartes. Grand écran (≥ 1400 px) : la colonne du détail grandit avec l'écran (34 %, de 440 à
  760 px), une action du parcours tient sur une ligne, le titre « Enregistrement terminé » en double disparaît ;
  Valider n'est jamais coupé ; un replay réussi liste ses coches sur une ligne.
- **Ligne liée à une donnée du run : le lien répété n'est plus une ambiguïté.** Le contrôle de corrélation compte la cible
  dans la ligne qui porte la donnée (et non tous les liens identiques de l'écran) : une ligne `~${testData:clé}` trouvée
  seule passe ; plusieurs lignes qui portent la donnée restent refusées (rien n'est exécuté, quel que soit `rowPick`).
  Test d'intégration `table-row`.
- **Ligne de tableau : liaison plus robuste et liaison manuelle.** Une cellule qui contient la donnée du run (accents, casse,
  espaces, suffixe ignorés) est liée avec un critère « contient » ; sinon la fenêtre le dit et propose **Lier une colonne à
  une donnée du run** (colonnes de la ligne et données du run avec leur valeur ; `RowBinding`, commande `correct-apply`
  avec `column` et `variable`). La colonne des détails ne déborde plus (titre de la correction qui passe à la ligne, cible
  JSON et CSS longs coupés, « Copier » entier).
- **Correction manager** (`src/recording/target-correction.ts`, fenêtre du recorder, script de capture) :
  corriger la cible d'une action **dans le navigateur**. Mode sélection dans la page (bandeau, élément
  survolé encadré avec rôle · nom · test id, clic jamais transmis à l'application, Échap annule) ; dans la
  fenêtre : ancienne cible → nouvelle cible, traits de l'élément, ordre de résolution au rejeu (le résolveur
  de l'enregistrement, jamais un second moteur), Tester / Annuler / Valider, historique et « Restaurer
  l'original ». Pendant l'enregistrement : la correction est posée sur les événements bruts
  (`userCorrection`) et le flow généré la porte (`userDecision: TARGET_CORRECTED_BY_USER`,
  `corrections`). En revue (carte « Replay interrompu », détails d'une étape) : une **session de correction**
  (`src/recording/correction-session.ts`) suit le même chemin — les étapes précédentes sont rejouées par le
  moteur de la mission (connexion, SafetyPolicy, données du run), puis la page reste ouverte dans cet état en
  mode sélection seul ; un chemin arrêté avant l'étape est signalé. L'étape du flow est réécrite et les fichiers
  régénérés. `DryRunDriver.page()`. Événements `TARGET_CORRECTED`, `RECORDING_TARGET_CORRECTED` ; commandes `correct-*` de la fenêtre.
  **Ligne de tableau liée à la donnée du run** : quand l'élément désigné est dans une ligne dont une cellule
  porte une valeur connue du run (saisie, donnée du jeu, donnée produite par le rejeu de la session —
  `DryRunDriver.testDataValues()`, `TestDataRunContext.values()`), la fenêtre propose « Identifier la ligne
  par : la donnée du run » (`row: { colonne: ${testData:clé} }`, par défaut) ou « la clé lue dans le tableau »,
  marquée « propre à ce run » quand l'ancienne cible visait la même colonne avec une autre valeur
  (`CorrectionProposal.rowOptions`, `PickedElement.rowCells`, commande `correct-apply` avec `option`).
  **Fenêtre sur écran de portable** (largeur ≤ 1400 px ou hauteur ≤ 820 px) : moins d'espace et moins de
  défilement — barre d'état sur une ligne, une ligne par action (statut à droite), détail et parcours qui
  défilent chacun pour soi (le détail passe avant l'aperçu), carte « Replay interrompu » sur une ligne avec ses
  actions, bouton « Corriger dans le navigateur » sur la ligne du titre, Tester / Annuler / Valider collés en
  bas du détail pendant que la correction défile.
- **Dock dans la page** (`recording.panelLayout: docked`, script de capture, console) : une seule fenêtre
  Chromium pendant l'enregistrement. Le bandeau de l'application devient le mini-dock (compteurs ✓ ⚠ ✕, les
  trois dernières actions et leur statut en direct, Pause / Annuler / Arrêter, repli en pastille, coin au
  choix) ; « Résoudre » sur une action ambiguë et « ▣ Fenêtre » ouvrent le cockpit à la demande (fermé : le
  dock reste) ; la revue ouvre la fenêtre d'elle-même. Node pousse l'état (`HumanFlowRecorder.showDock`),
  le dock envoie les commandes (`control: window`) ; `RecordingConsole` ouvre la fenêtre à la demande ;
  `PanelState.focus` amène l'étape demandée à l'écran. Test d'intégration `recording-dock`.
- **Vue d'ensemble** (`reports/overview.html`, `src/reporting/overview-*.ts`) : une page autonome par run —
  indicateurs (actions validées, intentions CONFIRMED / PROBABLE contre UNKNOWN, durée et durées par étape),
  parcours détecté (une carte par étape, ton validé / avertissement / échec / inconnu, étape d'arrêt, écritures
  HTTP, liens « réutilise la même valeur » tirés de `testDataReport`), détails du run (preuve métier, confiance,
  dérive), timeline avec recherche, dépliable, lignée des données de test (source, réutilisations, citations ; seule
  une valeur générée est affichée). Thème clair / sombre, recherche, choix du flow, lien depuis `index.html`.
  Configuration `output.overviewHtml` (par défaut `true`).
- **Thème QA-CRAWLER partagé** (`src/reporting/theme.ts`) : la vue d'ensemble, `index.html`, `flow-graph.html`,
  le rapport d'enregistrement, le rapport de dry-run et la fenêtre du recorder utilisent les mêmes jetons de
  couleur, le même logo et un bouton clair / sombre (clair par défaut, choix gardé pour toutes les pages).
- **Rejeu piloté par intention et état** (`src/replay/`) : `ReplayStateMachine` (position fonctionnelle,
  checkpoints confirmés, dernière action commise, divergence localisée entre le dernier checkpoint
  confirmé et le premier manquant), checkpoints fonctionnels dérivés des effets enregistrés, de
  l'intention, des `expect` et de l'étape suivante ; préconditions (`TARGET_PRESENT`, `FIELD_FILLED`,
  `ROUTE`, `DIALOG_OPEN`, `NO_OVERLAY`, `CHECKPOINT`, `TEST_DATA`) et dépendances entre étapes
  (`FILLS_FIELD`, `REVEALS_TARGET`, `OPENS_DIALOG`, `REACHES_ROUTE`, `PRODUCES_DATA`) avec l'explication
  jusqu'à l'étape racine ; `ReplayPlanner` (RECORDED / HISTORICAL / SEMANTIC / AMBIGUOUS, jamais un
  champ, SafetyPolicy puis effet) ; verdict transactionnel par étape (execution ≠ target ≠ effect ≠
  functional state) et confiance combinée (`REPLAY_LOW_CONFIDENCE` sous le seuil) ; mémoire des
  résolutions (`KnowledgeBase.recordTargetResolution`, apprises d'une récupération confirmée ou d'un
  plan confirmé, proposées d'abord ensuite). `FlowStepReport.replay`, `FlowRunReport.replay`, bloc
  « Intent-driven replay » du rapport HTML, configuration `replay.intentDriven`, événements
  `REPLAY_*`, `CHECKPOINT_*`, `PRECONDITION_*`, `RESOLUTION_*`.
- **Intention fonctionnelle** (`src/intent/`) : element + contexte + action humaine + état → intention à
  trois niveaux (geste, interface, opération × entité) pour chaque action enregistrée, avec preuves typées
  (libellé, rôle, contexte structurel, actions voisines, effets, réseau, cycle de vie des entités, décision
  humaine, bibliothèque, contrat), candidats classés, contradictions et statut CONFIRMED / PROBABLE /
  AMBIGUOUS / UNKNOWN. Écrite à côté de l'action, jamais à sa place : `functionalIntent:` dans le YAML,
  `functional-intents.json`, rapport d'enregistrement, modèle de l'application ; le self-healing la lit
  avant l'heuristique du libellé. Arbitre IA sur AMBIGUOUS seulement (choix parmi les candidats),
  bibliothèque d'intentions dans la connaissance fonctionnelle. Configuration `recording.intent`.
- `Issue.details` : nom de l'erreur, source (`fichier:ligne:colonne`), pile d'appels complète
  (`PAGE_ERROR`), texte complet d'un message console sur plusieurs lignes (`CONSOLE`), type de
  ressource et en-têtes de diagnostic d'une réponse en échec (`HTTP`, `BROKEN_LINK`,
  `REQUEST_FAILED`). Masqués et bornés par le collecteur comme le message.
- Rapport HTML : bloc « Détails » dépliable sous le message de chaque anomalie (source,
  informations clé → valeur, pile d'appels, texte complet).
- **Réconciliation sémantique du Dry Run** (`src/dry-run/semantic-reconciliation.ts`) : après
  l'alignement brut, une étape attendue restée `MISSING` / `POSSIBLY_OBSOLETE` / `UNREACHABLE` et une
  étape observée restée `INSERTED` qui désignent le même événement fonctionnel forment une seule
  entrée, jamais `MISSING` + `INSERTED`. Score par dimension (cible, intention, entité, contexte,
  séquence, effet) et total pondéré ; statuts `MATCHED_WITH_TARGET_CHANGE`, `MATCHED_SEMANTICALLY`,
  `MATCHED_WITH_CONTEXT_CHANGE`, `MATCHED_AFTER_INSERTION`, `DUPLICATE_CANDIDATE` (deux candidats
  aussi plausibles : rien n'est choisi, scénario `INCONCLUSIVE`). Un libellé d'abandon, un champ, une
  vérification ou une adresse ne sont jamais appariés. `ReconciliationEntry.pairing` (détail du score,
  autres candidats), résumé `matchedWithVariation` / `duplicateCandidate`, événement `FLOW_STEP_PAIRED`,
  rapport HTML et CLI, configuration `dryRun.semanticPairing` (`minScore` 0.7, `ambiguityMargin` 0.1).

### Modifié

- Fenêtre d'enregistrement : nouvelle apparence, alignée sur la maquette QA-CRAWLER — palette indigo
  (clair et sombre), cartes arrondies, étapes plus aérées avec la sélection cerclée, statuts en texte
  coloré, carte « Replay interrompu » blanche à bord rouge avec ses détails en bloc, barre de résumé et
  boutons plus grands. Aucune ressource réseau : police système.
- Tests d'intégration plus rapides : un worker vitest par cœur (8 au plus, `QA_TEST_WORKERS` pour
  régler), tests concurrents à l'intérieur des fichiers longs (chacun dans son propre dossier de
  rapports), et job CI `integration` découpé en trois shards parallèles (le job `build` ne lance
  plus l'intégration). Sur une machine à 4 cœurs : de 1 250 s à environ 600 s.
- Dashboard : passer d'un menu à l'autre est plus rapide.
  - Le menu suit le clic tout de suite. L'écran quitté reste affiché, grisé et inactif, avec une fine
    barre de progression si le chargement dure, jusqu'à ce que le nouvel écran soit prêt. Dans un même
    menu (fichier de l'éditeur, détail d'une exécution), l'écran reste utilisable comme avant ; l'éditeur
    s'affiche dès les lectures communes faites et dit lui-même ce qu'il charge encore.
  - Les lectures d'un écran (catalogue, droits, projet, données de la vue) partent ensemble au lieu de
    se suivre ; les capacités du serveur ne se relisent qu'au premier chargement.
  - Le serveur garde ce qu'il tire de chaque run (fiche, verdict, statuts des flows, anomalies par
    gravité), les flows des scénarios et la configuration du projet tant que leur fichier garde sa date
    de modification et sa taille ; un fichier modifié depuis moins de deux secondes est toujours relu.
    Avec 315 runs, la liste des projets passe de 206 à 38 ms, le détail d'un projet de 194 à 36 ms,
    la liste des exécutions de 171 à 36 ms, l'historique des scénarios de 356 à 54 ms et la vue
    d'ensemble de 411 à 69 ms.
  - Maven est sondé (`mvn -v`) en arrière-plan dès l'ouverture du Dashboard : le premier passage sur
    l'écran Tests n'attend plus le démarrage de la JVM.

### Corrigé

- Dashboard : une saisie validée par Entrée pouvait ne pas apparaître (par exemple le nom d'une étape
  dans l'éditeur, sans la mention « Modifications non enregistrées »). Chromium déclenche le « change »
  d'un champ qui a le focus quand un redessin le retire ; la validation redessinait alors pendant le
  redessin en cours, dont le HTML, calculé avant, l'emportait. Un redessin demandé pendant un autre est
  désormais rejoué juste après, sur l'état à jour.

- Un flow invalide n'entre plus dans la bibliothèque (le bloc est `INVALID`) ; un scénario invalide au
  lancement répond 422 au lieu de 500, et l'écran Scénarios dit le refus de « Rejouer » au lieu de
  rester muet.
- Retirer une étape d'un enregistrement retire aussi son identifiant de son groupe métier.

- **Exigences : le parent proposé reste dans sa section.** Un titre neutre (une autre section, une
  autre feuille Excel) ne remettait pas à zéro le parent proposé : un critère pouvait être rattaché
  à l'exigence d'une section voisine. Le parent est maintenant cherché dans la section courante puis
  dans les sections englobantes seulement.
- **Exigences : une cellule qui ne contient qu'un identifiant est une référence.** Dans un tableau
  de critères, une colonne « Exigence » (`CA-5 | REQ-5 | …`) devenait le texte du critère ; elle en
  donne maintenant le parent, comme une colonne « Exigence liée ». Ce lien, écrit dans la source,
  est proposé avec la confiance ÉLEVÉ et sa justification cite la ligne du tableau.
- **PDF : une ligne qui commence par un identifiant ouvre un paragraphe.** Deux exigences sur des
  lignes consécutives (`ENF-02 …`, `ENF-03 …`) n'en faisaient qu'une.
- **Recorder : une vérification acceptée rejoint le groupe de son action.** Accepter une proposition
  (ou ajouter une vérification de groupe) après avoir créé des groupes laissait l'étape `expect` hors du
  groupe de l'action vérifiée ; les groupes sont renormalisés à chaque décision.
- **Tests Playwright TS et Java générés, joués comme le moteur** (trouvé en les exécutant) : une
  action sur un rôle, un libellé ou un texte sans position enregistrée prend la première
  correspondance (`.first()`), comme le moteur — « Utilisateur 1 » désigne aussi « Utilisateur 10 »
  et le mode strict de Playwright refusait le clic ; un gabarit de route d'effet (`/users/{id}`,
  `/users/:id`) devient un segment quelconque au lieu d'un texte littéral qui ne correspondait jamais.
- **Citations `${testData:clé}` dans les tests Playwright générés** : dans un texte attendu, un nom de
  cible ou une ligne de tableau, la citation devient la donnée du run (`` `${testData["clé"]}` ``) au
  lieu du texte littéral de la citation (qui ne pouvait jamais correspondre).

- **Rapport HTML en français : la section « Intelligence IA » entièrement traduite.** Précondition
  manquante, contexte fonctionnel (objectif, progression, manquant, bloqué), sélection et découverte des
  modèles, en-têtes des tableaux de modèles et d'efficacité, validation, runtime, apport à la
  connaissance et contrôle des compteurs suivent `report.language` ; seuls les codes (statuts,
  déclencheurs) restent tels quels.
- **Rapport HTML : des tableaux qui tiennent dans leur carte.** Décisions IA en quatre colonnes (décision,
  proposition, contrôles, résultat) au lieu de treize, le contexte fonctionnel sur sa propre ligne ; anomalies
  du run en cinq colonnes (la gravité rejoint la catégorie, régression · source · confiance deviennent des
  indices) ; hypothèses du moteur cognitif en six colonnes (preuves pour / contre et horodatages regroupés).
  Les mots restent entiers (plus de « Paramètre|s ») ; seuls les longs jetons (URL, identifiants,
  localisateurs) se coupent ; les tableaux imbriqués sont plus compacts. Vérifié en navigateur : une fois
  tout déplié, aucun tableau ne dépasse sa carte à 1366 et 1920 px (`ai-blocked-goal`).
- **Une violation d'invariant n'est plus classée « autorisation ».** « Aucune erreur serveur » et les autres
  invariants d'écran sont des `FUNCTIONAL_FAILURE` ; seuls les invariants d'accès (`ISSUE-INV-…`, « l'acteur
  X n'accède pas à… ») restent des `AUTHORIZATION_FAILURE`.
- Fenêtre d'enregistrement : le pictogramme du geste de chaque étape (clic, saisie, case…) affichait
  « undefined » pour une saisie et rien pour un clic — deux tables `SVG` du même script se
  masquaient. Table des gestes à part (`KIND_SVG`), test unitaire et assertion E2E.
- Écriture atomique (`writeFileAtomic`) : deux écritures du même fichier en vol dans le même processus
  (par exemple la base de connaissances de deux missions concurrentes) n'ont plus le même fichier
  temporaire ; le renommage de la seconde n'échoue plus en `ENOENT`.
- Windows, Git Bash et WSL : les scripts npm `build`, `clean` et `pack` passent par Node
  (`scripts/clean.mjs`, `scripts/pack.mjs`) au lieu de `rm -rf` / `mkdir -p` ; le test
  d'installation (`test:packaging`) lance `npm.cmd` et `qa-crawler.cmd` sous Windows ;
  `.gitattributes` force les fins de ligne LF ; job CI `packaging-windows` (build, tarballs,
  installation des tarballs, tests unitaires sur `windows-latest`) ; section README
  « Windows, Git Bash et WSL » et lignes de dépannage.

## 0.2.0 — 2026-10-12

### Ajouté

- Paquets installables `@qa-crawler/core` (moteurs + API publique `index.ts`) et `@qa-crawler/cli`
  (façade `qa-crawler`), workspaces npm, build dans `packages/core/dist`, `npm run pack:check`,
  `npm run test:packaging`, `npm run release`.
- Commandes de projet : `init`, `replay`, `explore`, `analyze`, `test-api`, `reproduce`,
  `generate-tests`, `record` (dans un projet), `--version`, `--help` ; options `--cwd`, `-c`,
  `--base-url`, `--headless/--headed`, `--playwright-config`, `--reports-dir`, `--flow`, `--force`,
  `--no-example`, `--out` ; codes de sortie 0 / 1 / 2 / 3.
- `qa-crawler.config.yaml` (`qaCrawler:`) traduit en mission (`qa-crawler/.derived/`), flows
  découverts dans `qa-crawler/flows/` (YAML et `.feature`), priorité CLI > env > fichier > défauts.
- Détection de projet (Angular, React, Vue, TypeScript, Playwright, OpenAPI, source maps, Git,
  GitHub, CI, Docker, Kubernetes) et réutilisation du `playwright.config` du projet
  (`baseURL`, `headless`, `viewport`, `storageState`).
- Métadonnées d'outil dans chaque résultat : `tool: { coreVersion, cliVersion, projectVersion, node }`.
- Fixtures de packaging (Angular, React, générique, OpenAPI), job CI `packaging`, Dockerfile basé sur
  le bin du paquet, `docs/MIGRATION_TO_PACKAGE.md`, exemples de pipelines consommateurs sans base de
  données (`examples/ci/`, mémoire restaurée et sauvegardée dans un dépôt générique Artifactory).

### Inchangé

- Toutes les commandes historiques (`learn`, `verify`, `explore <mission>`, `dry-run`, `record`,
  `sources`, `k8s-manifest`), le format des missions, flows, Gherkin, données de test, baselines,
  enregistrements, bases de connaissances et providers de persistance.
