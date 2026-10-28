# Changelog

Versions selon [SemVer](https://semver.org). `@qa-crawler/core` et `@qa-crawler/cli` partagent le même numéro.

## Unreleased

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

### Corrigé

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
