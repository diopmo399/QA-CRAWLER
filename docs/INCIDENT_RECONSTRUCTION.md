# Incident Reconstruction

Diagnostic d'un incident fonctionnel à partir de preuves :
**Déclarer → Délimiter → Reproduire → Observer → Inspecter le code → Corréler → Diagnostiquer → Vérifier → Rapporter → Générer un test.**

Exemple traité de bout en bout par le test d'intégration `tests/integration/incident-reconstruction.test.ts` :
« Lors de la création d'un livre, après avoir cliqué sur Enregistrer, l'application affiche une erreur HTTP 500. »

Aucune dépendance Splunk, aucun agent OpenTelemetry, rien à installer dans le BFF ni dans le backend : les
preuves viennent du navigateur (Playwright), du code source (lecture statique), des journaux et des tests
autorisés par le périmètre.

## 1. Audit du dépôt (phase 0)

État constaté sur `main` (1e6d471) avant ce module :

| Brique                                               | État                                                                                                                                    | Réutilisation                                                                                 |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Incident Reconstruction                              | **absent** : aucun code, aucune API, aucun écran, aucun test                                                                            | créé ici                                                                                      |
| Execution Environment Manager (LOCAL / REMOTE / ARO) | **absent** : seul `src/platform/kubernetes-manifest.ts` (Job / CronJob d'une mission) existe                                            | créé ici (`src/incident/environments.ts`), réutilise ses conventions                          |
| Moteur Playwright (rejeu de flows)                   | présent : requêtes par étape (`FlowStepReport.network`), anomalies console / JavaScript / HTTP (`Issue`), captures, annulation, journal | la reproduction passe par le même chemin que les exécutions du SDK                            |
| Bibliothèque de scénarios, flows YAML                | présente                                                                                                                                | scénario de l'incident, scénario qui réussit, test de non-régression                          |
| Projets, environnements cibles, droits (SDK)         | présents (`ROLE_RIGHTS`, `checkRight`, journal d'accès)                                                                                 | routes des incidents sous `/api/projects/:p/incidents`                                        |
| Sécurité                                             | `SafetyPolicy` (actions du navigateur), `OriginPolicy`, `redactor`                                                                      | gardées ; le Scope Policy Engine ajoute fichiers, commandes, réseau, OpenShift                |
| Analyse de code TypeScript / Java / Spring           | absente ; `typescript` est une dépendance d'exécution                                                                                   | analyseur frontend par l'API du compilateur ; analyseur Java écrit pour le module             |
| Corps des réponses HTTP, trace Playwright            | non conservés par le moteur                                                                                                             | options ajoutées, désactivées par défaut (`network.captureBodies`, `browser.playwrightTrace`) |

## 2. Architecture

```
src/incident/
  model.ts            le contrat commun (types, statuts)
  scope.ts            Investigation Scope Manager : défauts (GUIDED), validation, extensions approuvées
  scope-policy.ts     Scope Policy Engine : refus par défaut, fichiers, réseau, tests, commandes, OpenShift
  guarded-fs.ts       la seule lecture de fichiers de l'investigation (passe par la politique)
  incident-store.ts   Incident Manager : persistance, révisions, historique, états, annulation / reprise
  evidence.ts         Playwright Evidence Collector : du run du moteur aux preuves (masquées)
  code/               Code Investigation Engine : frontend (TypeScript), BFF Java, backend Spring Boot
  correlator.ts       Evidence Correlator : le graphe Incident → … → Repository, chaque lien qualifié
  hypotheses.ts       Hypothesis Engine
  experiments.ts      Experiment Runner (vérifications autorisées)
  root-cause.ts       Root Cause Analyzer
  report.ts           Investigation Report Generator (JSON, Markdown)
  regression.ts       Regression Test Generator (flow de la bibliothèque, jamais ajouté sans validation)
  environments.ts     Execution Environment Manager : un contrat, trois adaptateurs (LOCAL, REMOTE, ARO)
  timeline.ts         la chronologie unifiée (actions, requêtes, erreurs, journaux, code, vérifications)
  frontend-trace.ts   la traçabilité frontend d'une action (élément → … → requête → erreur affichée)
  service.ts          l'orchestration (et la lecture du code du périmètre pour l'explorateur)
src/sdk/server/incidents.ts   les routes HTTP
src/sdk/core/incident-contracts.ts   le contrat partagé avec le navigateur
src/sdk/ui/dashboard-incidents*.ts   la liste et la déclaration des incidents
src/sdk/ui/incident-*.ts             l'espace d'investigation (voir § 9)
```

La reproduction et toute vérification qui rejoue l'application passent par le **même chemin que les
exécutions du SDK** (`launchReplay` dans `server.ts`) : le moteur, sa `SafetyPolicy`, l'environnement cible du
projet, l'annulation contrôlée. Le service n'a qu'un code : seul l'adaptateur d'environnement change.

## 3. Statuts

Relations du graphe : `OBSERVED` (vue pendant l'exécution : action → requête), `STATICALLY_RESOLVED` (lue dans
le code sans ambiguïté : méthode et chemin littéraux, type injecté connu), `INFERRED` (reconstruite : préfixe
lu dans une propriété, méthode héritée d'un dépôt Spring Data), `UNKNOWN` (le lien manque : la raison est
donnée). Un parcours lu dans le code n'est jamais présenté comme une trace d'exécution.

Hypothèses : `PROPOSED`, `INVESTIGATING`, `SUPPORTED`, `REFUTED`, `INCONCLUSIVE`, `CONFIRMED`. Une hypothèse
n'est confirmée qu'avec au moins deux vérifications favorables de natures différentes, dont une dynamique, et
aucune preuve contraire. Le diagnostic est `CONFIRMED`, `PROBABLE` ou `INCONCLUSIVE` (avec ce qui manque).

Incident : `DRAFT`, `SCOPED`, `REPRODUCING`, `REPRODUCED`, `NOT_REPRODUCED`, `INVESTIGATING`, `DIAGNOSED`,
`INCONCLUSIVE`, `CANCELLED`, `FAILED`.

## 4. Périmètre et sécurité

Modes : `MANUAL` (rien d'automatique), `GUIDED` (par défaut : l'investigation propose, une personne décide),
`AUTO_WITHIN_SCOPE` (les vérifications sans effet de bord permises s'enchaînent ; le périmètre ne s'étend
jamais seul). Toute extension (application, chemin, classe, endpoint, hôte, profondeur, effets de bord,
commande) est une demande qui attend une approbation (droit `DECIDE`).

Le Scope Policy Engine refuse par défaut et agit dans les adaptateurs (lecture de fichiers, journaux,
tests, commandes, OpenShift) — pas seulement dans l'interface :

- fichiers : chemin réel (liens symboliques résolus) sous la racine du dépôt et un dossier inclus ; pas de
  `..` qui sort, pas de lien qui sort, pas de fichier sensible (`.env`, clés, magasins de certificats, `.git`) ;
  taille et nombre de fichiers bornés ;
- réseau : `http`/`https` seulement, hôtes du périmètre et de l'environnement cible, jamais les adresses de
  métadonnées du cloud ni les adresses lien-local ; requêtes directes `NONE` par défaut, écritures seulement
  avec effets de bord approuvés ;
- tests et commandes : exécutables connus, arguments de test seulement, aucun caractère de shell, jamais
  `shell: true`, commandes dangereuses toujours refusées ;
- OpenShift : lecture seule (`get`, `describe`, `logs`, `events`), ressources sans secrets, namespaces déclarés.

Les preuves sont masquées (`src/security/redactor.ts`, clés sensibles des corps JSON) : aucun secret, jeton ni
valeur de champ sensible n'est conservé.

## 5. Environnements d'exécution

|                          | LOCAL (par défaut)        | REMOTE                                       | ARO                                               |
| ------------------------ | ------------------------- | -------------------------------------------- | ------------------------------------------------- |
| QA-CRAWLER et Playwright | sur le poste              | sur le poste                                 | dans le cluster (Playwright conteneurisé)         |
| Applications             | locales                   | distantes (URL de l'environnement cible)     | joignables depuis le cluster                      |
| Dépôts                   | locaux                    | locaux autorisés                             | montés dans le pod (`repositoriesMount`)          |
| Journaux                 | fichiers autorisés        | fichiers ; OpenShift en lecture si configuré | OpenShift en lecture (ServiceAccount)             |
| Tests                    | locaux, s'ils sont permis | locaux, s'ils sont permis                    | dans le pod, ou Job Kubernetes (manifeste généré) |

## 6. API

Toutes sous `/api/projects/:p/incidents` (JSON) ; droits : `RUN` pour investiguer, `DECIDE` pour approuver une
extension ou refuser le test proposé, `PUBLISH` pour l'ajouter à la bibliothèque, `RUN_WRITES` en plus pour
jouer un environnement qui permet les écritures ou approuver une vérification avec effets de bord.

| Méthode    | Route                                                                                           |                                                                                  |
| ---------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| GET / POST | `/incidents`                                                                                    | lister, déclarer                                                                 |
| GET        | `/incidents/:i`                                                                                 | consulter (avec l'historique et l'investigation)                                 |
| POST       | `/incidents/:i/update`                                                                          | modifier (`revision` attendue, sinon 409)                                        |
| POST       | `/incidents/:i/scope/validate`                                                                  | valider le périmètre                                                             |
| POST       | `/incidents/:i/scope/extensions`, `…/extensions/:e/decision`                                    | demander, décider une extension                                                  |
| GET        | `/incidents/:i/capabilities`                                                                    | capacités de l'environnement d'exécution                                         |
| POST       | `/incidents/:i/reproduce`                                                                       | reproduire (arrière-plan)                                                        |
| POST       | `/incidents/:i/analyze`                                                                         | code, graphe, hypothèses                                                         |
| POST       | `/incidents/:i/experiments`, `…/experiments/:x/run`                                             | planifier, exécuter une vérification                                             |
| POST       | `/incidents/:i/diagnose`                                                                        | diagnostic                                                                       |
| GET        | `/incidents/:i/report?format=json\|markdown`                                                    | rapport                                                                          |
| POST       | `/incidents/:i/regression[/run\|/accept\|/reject]`                                              | test de non-régression                                                           |
| POST       | `/incidents/:i/cancel`, `/resume`                                                               | annuler, reprendre                                                               |
| GET        | `/incidents/:i/sources`                                                                         | fichiers lisibles du périmètre (droit `RUN`)                                     |
| GET        | `/incidents/:i/source?application=&file=`                                                       | un fichier, en lecture seule, valeurs masquées                                   |
| GET        | `/incidents/:i/screenshot?reproduction=&file=`                                                  | une capture enregistrée (URL `data:`)                                            |
| POST       | `/incidents/:i/attachments`                                                                     | ajouter une pièce jointe (droit `RUN`)                                           |
| GET/DELETE | `/incidents/:i/attachments/:a`                                                                  | lire (masquée) / retirer une pièce jointe                                        |
| GET        | `/incidents/:i/scope/tree?application=&depth=`                                                  | dossiers d'un dépôt pour le périmètre (`RUN`)                                    |
| GET        | `/incidents/:i/report?format=json\|markdown\|html\|pdf&sections=`                               | rapport, sections choisies                                                       |
| GET        | `/incidents/:i/regression/spec`                                                                 | test Playwright généré depuis le flow proposé                                    |
| GET        | `/incidents/:i/ai/capabilities`                                                                 | modes IA disponibles, fournisseur, budget, politique de données                  |
| POST       | `/incidents/:i/ai/investigate` `{mode?, depth?, budget?}`                                       | lancer une investigation IA (202 ; run `RUNNING` relu par `GET`)                 |
| POST       | `/incidents/:i/trigger/describe` `{text}`                                                       | interpréter la description (provenance `USER_REPORTED`)                          |
| POST       | `/incidents/:i/trigger/start` `{description?, depth?, budget?, repeats?, confidenceThreshold?}` | lancer la découverte des déclencheurs (202 ; run relu par `GET`)                 |
| POST       | `/incidents/:i/trigger/pause` · `resume` · `cancel`                                             | piloter le run en cours (coopératif, entre deux essais)                          |
| POST       | `/incidents/:i/trigger/experiments/:e/decision` `{approve, reason?}`                            | DECIDE : jouer ou refuser une vérification proposée par la découverte            |
| POST       | `/incidents/:i/trigger/extend-budget` `{added}`                                                 | DECIDE : prolonger le budget du run (plafonds respectés)                         |
| GET        | `/incidents/:i/trigger/report[/:run]`                                                           | le rapport du run (sections en lignes, masqué)                                   |
| POST       | `/incidents/:i/ai/pause`, `/ai/resume`, `/ai/cancel`                                            | mettre en pause, reprendre, annuler le run IA (`RUN`)                            |
| POST       | `/incidents/:i/ai/ask` `{question}`                                                             | l'assistant : réponse qui cite des références existantes                         |
| POST       | `/incidents/:i/ai/experiments/:e/decision` `{approve, reason?}`                                 | trancher une vérification proposée (`DECIDE`)                                    |
| POST       | `/incidents/:i/ai/extend-budget` `{added}`                                                      | prolonger le budget de l'investigation approfondie (`DECIDE`)                    |
| GET        | `/incidents/:i/ai/memory`                                                                       | la mémoire d'investigation (stratégies, expériences, contradictions, couverture) |

## 7. Le scénario d'intégration (incident connu)

`tests/fixtures/incident-site.ts` sert la page « Nouveau livre » et `POST /api/books` : sans éditeur, la page omet
`publisherId` et l'API répond 500 avec l'erreur du backend propagée par le BFF. Le code du frontend, du BFF et
du backend est dans `tests/fixtures/incident-app/`. Le test `tests/integration/incident-reconstruction.test.ts`
joue toute l'investigation avec le vrai moteur et Chromium. Résultat obtenu sur ce scénario :

- reproduction : `REPRODUCED` ; `POST /api/books` → 500, rattachée au clic sur « Enregistrer » (`OBSERVED`), corps
  de la réponse masqué contenant `NullPointerException` ;
- code : endpoints `POST /api/books` (BFF) et `POST /catalog/books` (backend) ; chaîne `BookForm.onSave` →
  `createBook` → `BookController.create` → `BookService.create` → `CatalogClient.register` → `CatalogBookController.register`
  → `CatalogBookService.register` → dépôts (appels de dépôt hérités : `INFERRED`) ;
- hypothèses : relation « publisher » nulle (BACKEND), validation manquante de `publisherId` (frontend
  `payload.ts` / `validation.ts`, `CreateBookRequest`, `NewCatalogBook`), erreur du backend propagée par le BFF ;
- vérifications : le test unitaire est **refusé** par le périmètre par défaut (rien n'est exécuté) ; la
  comparaison avec le scénario qui réussit **soutient** l'hypothèse de la relation nulle ;
- diagnostic : **`PROBABLE`** — `CatalogBookService.register` déréférence `book.getPublisher().getName()` sans
  vérifier la relation ; il manque une seconde vérification d'une autre sorte pour le confirmer (le test
  unitaire refusé est cité dans `missing`) ;
- rapport JSON et Markdown ; test de non-régression proposé, **exécuté** : il **échoue** (le défaut est toujours
  là), et n'entre pas dans la bibliothèque sans validation ;
- Dashboard (Chromium) : liste, page de l'incident, graphe avec les statuts, diagnostic ;
- annulation et reprise ; capacités lues pour LOCAL, REMOTE et ARO avec le même contrat.

## 8. Limites connues

- ARO : aucun cluster n'est disponible pour les tests. L'adaptateur (détection dans le cluster, montage des
  dépôts, `oc logs` par le ServiceAccount) est testé avec un exécuteur simulé ; le manifeste de Job est généré,
  jamais envoyé au cluster.
- REMOTE : la lecture des journaux OpenShift est testée avec un exécuteur simulé.
- Tests Maven ciblés : la vérification existe (`UNIT_TEST`, `INTEGRATION_TEST`, comptes Surefire) mais le
  scénario d'intégration ne lance pas Maven (le périmètre par défaut les refuse, et les dépendances Spring ne
  sont pas disponibles hors ligne).
- Analyse Java : un analyseur écrit pour le module (pas de compilateur Java) ; ce qu'il ne résout pas reste
  `UNKNOWN`.
- Horodatage des actions : le moteur ne garde pas l'heure de début de chaque étape ; elle est estimée à partir du
  début du flow et des durées des étapes précédentes. Une requête vue pendant la fenêtre de l'étape reste
  `OBSERVED` ; un rattachement par l'heure seule est `INFERRED`.

## 9. L'espace d'investigation (Dashboard)

« Investiguer › Investigations » ouvre l'espace d'investigation d'un incident, organisé comme un IDE : il occupe la
hauteur de la fenêtre et la page ne défile pas (1440×900, 1280×800, 1024×768) ; chaque panneau défile seul. La
spécification UX est dans `docs/incident-reconstruction/ux-spec.md`, l'audit de départ dans
`docs/incident-reconstruction/audit.md`, les revues dans `docs/incident-reconstruction/qa-review.md` et
`docs/incident-reconstruction/layout-review.md`.

- **En-tête compact** : titre, gravité, statut, environnement, actions selon les droits ; scénario, description,
  observé / attendu et dates derrière « Détails ». **Progression** en une ligne fine (étape actuelle, n/10), dépliable
  vers les dix étapes (Description → … → Non-régression).
- **Six vues** et leurs sous-onglets : Vue d'ensemble (Résumé, Périmètre, Environnement), Chronologie (Événements,
  Journaux), Traçabilité (Full Stack, Frontend, BFF, Backend, HTTP), Code, Diagnostic (Diagnostic, Hypothèses,
  Expériences), Rapport (Rapport, Non-régression). Les quinze clés de vue historiques restent valides.
- **Panneaux redimensionnables** (`src/sdk/ui/incident-split.ts`) : en Traçabilité et Code, en haut le graphe (ou la
  traçabilité frontend, ou les requêtes HTTP) et le détail de la sélection ; en bas l'arborescence, l'éditeur et les
  lignes signalées. Séparateurs à la souris et au clavier (motif ARIA « window splitter », bornes réelles annoncées),
  tailles minimales, chaque panneau agrandi (Échap le remet), réduit ou masqué. Sur mobile, un panneau à la fois
  avec un sélecteur ; si la place manque (progression et détails dépliés), l'espace défile plutôt que de rogner un
  panneau.
- **Graphe full stack** : remplit son panneau ; zoom avec l'échelle réelle, « Ajuster » à la taille du panneau,
  déplacement, plein écran, chemin d'erreur, menu « Couches », vues restreintes BFF / Backend / Frontend ; légende et
  aide repliées ; un seul arrêt de tabulation. Le tableau de toutes les relations est dans le panneau de détail.
- **Sélection synchronisée** (`src/sdk/ui/incident-links.ts`) : graphe, chronologie, requêtes HTTP, code, preuves et
  hypothèses ; sélectionner un élément ouvre son fichier à la ligne dans l'éditeur quand l'endroit est connu. Une
  puce de preuve n'ouvre que ce qu'elle désigne réellement.
- **Explorateur de code** façon VS Code : arborescence de toutes les applications (réductible), onglets de fichiers,
  recherche dans le fichier, « Aller à la ligne » (Ctrl/Cmd+G), lignes signalées et symboles à droite ; lecture seule,
  périmètre contrôlé, valeurs sensibles masquées. Les méthodes du code n'ont jamais de durée.
- **Détails dépliables** : en-têtes, corps des requêtes et réponses, critères de la chronologie, légendes.
- **Préférences** locales (`localStorage`, clé `qa-crawler:incident-workspace:v2`) : tailles, panneaux, dernier
  onglet, zoom, mode compact, progression ; la page fonctionne sans elles.
- **Démonstration** (`src/sdk/ui/incident-demo.ts`) : un incident fictif du catalogue de livres, bandeau
  « Données de démonstration » affiché une fois dans l'en-tête, aucun appel au serveur ; ce n'est jamais un
  diagnostic réel.

Composants : `incident-workspace.ts` (coquille et vues), `incident-split.ts` (panneaux, séparateurs, préférences), `incident-workspace-controller.ts` (chargement, suivi toutes les
1,5 s sans redessiner si la révision n'a pas changé, sélection, clavier, séparateurs, préférences, annonces dans la zone vivante permanente du Dashboard), `incident-ux.ts` (en-tête, progression, onglets, environnement), `incident-graph.ts`,
`incident-timeline.ts`, `incident-frontend-trace.ts`, `incident-code.ts`, `incident-diagnosis.ts`,
`incident-parts.ts` (primitives partagées : sélection, statuts de relation, liens vers le code, puces de preuves,
états de panneau, bandeau de démonstration).

## 10. Le parcours guidé (maquette en douze écrans)

La liste (onglets Tous / Ouverts / En investigation / Résolus / Fermés, recherche, application, date de création, export
CSV), la déclaration (application, type, sévérité, scénario, pièces jointes : captures et textes, contenu vérifié côté
serveur, 5 Mio et 10 fichiers au plus, noms nettoyés, textes masqués à la lecture), le périmètre (arborescence des dossiers
lue en lecture seule, profondeur 1 à 5, limites ; la mémoire maximale ne s'impose qu'au Job ARO, jamais en LOCAL ni en
REMOTE), l'environnement (cartes LOCAL / REMOTE / ARO d'après les capacités mesurées, « Tester la connectivité » depuis le
serveur), la reproduction en direct (étapes annoncées par le moteur pendant le rejeu, durée seulement quand l'étape est
finie, capture seulement si le moteur en a écrit une), les preuves (requêtes, console, captures, traces, actions ; commande
cURL reconstruite, valeurs masquées), la traçabilité (colonnes ou couloirs horizontaux par couche), le code, le diagnostic
(confiance des hypothèses, cause « confirmée » seulement si elle l'est, vérifications à cocher), le rapport (sections,
export PDF / HTML / Markdown / JSON ; PDF imprimé par Chromium, indisponible sans navigateur) et le test de non-régression
(flow et test Playwright généré ; « Validé » seulement après acceptation, verdict réel de la dernière exécution).

## 11. L'investigation IA (`src/incident/ai`)

Détail : `docs/incident-reconstruction/ai-investigation.md`. Le mode par défaut est **DETERMINISTIC** : aucun module IA
n'est chargé par le serveur, aucun fournisseur n'est créé, l'investigation est celle des règles. `ai.incidents.mode`
(`AI_ASSISTED` : une passe de chaque agent, lecture seule, propositions ; `AI_AGENTIC` : boucle bornée, les vérifications
sans effet de bord déjà permises sont lancées par le chemin ordinaire du service) et la profondeur (`QUICK`, `STANDARD`,
`DEEP` — `DEEP` exige `AI_AGENTIC`) sont choisis dans le sous-onglet **Diagnostic › Investigation IA**.

- **Vérité** : les hypothèses d'un agent sont `PROPOSED`, origine `AI`, confiance plafonnée à 0,7 ; seules les
  vérifications réelles (`applyExperiment`, `meetsConfirmation`, `diagnose()`) confirment ; une relation suggérée est
  écrite `INFERRED` (raison « IA : … ») ; la synthèse est une proposition ; le rapport le dit (section « Investigation IA »,
  limite « n hypothèse(s) d'origine IA non éprouvée(s) »).
- **Périmètre** : chaque appel d'outil (liste fermée, aucun verbe d'exécution) passe par le Scope Policy Engine ; un
  refus revient au modèle comme donnée délimitée et n'est jamais rejoué ; aucun outil n'exécute de commande
  (`maxCommands` reste 0) ; `propose_experiment` et `request_scope_extension` ne font que proposer ; l'historique Git
  n'est lisible qu'avec `scope.permissions.readGitHistory` et `git` dans `allowedCommands`.
- **Données** : masquage (secrets, champs sensibles), bornes (caractères, éléments), captures jamais transmises,
  `allowExternal` faux ⇒ IA indisponible ; les secrets ne sont lus que par leur nom de variable d'environnement.
- **Budgets** : itérations, appels, jetons, coût, durée, fichiers, vérifications ; épuisement ⇒ `PARTIAL` avec la raison ;
  annulation ⇒ `CANCELLED`, l'acquis est conservé ; une prolongation est une décision (`DECIDE`), jamais automatique.
- **Approfondie (DEEP)** : stratégies découvertes et priorisées (gain d'information, jamais un score de certitude),
  expériences générées avec leurs opérations exactes évaluées par la politique (celles qui exigent une personne attendent),
  chasseur de contradictions (une contradiction cite ou est une question ouverte), rôles des hypothèses d'après le
  validateur déterministe, couverture par dimension avec dénominateur (aucun pourcentage global), mémoire persistante
  `<projet>/incidents/<id>/ai/memory.json` (structurée, bornée, reprise possible, jamais une transcription), politique
  d'arrêt (une stratégie utile ou une contradiction décisive, et du budget), pause et reprise.
- **Limites** : seul le fournisseur `anthropic` est pris en charge pour l'investigation (`copilot` est annoncé
  indisponible) ; la synthèse de la passe des agents précède les vérifications de la boucle adaptative ; les tests
  utilisent un client de modèle scripté (aucun appel réseau n'est joué dans la CI).

## 12. La découverte autonome des déclencheurs (`src/incident/trigger`)

Détail : `docs/incident-reconstruction/trigger-discovery.md`. Quand les conditions d'un incident sont inconnues, le
moteur explore un environnement de test : description interprétée (chaque élément avec sa provenance), périmètre
découvert (statuts du Scope Policy Engine, rien n'est accordé), parcours de référence, essais par stratégies (guidée,
limites, paires, guidée par le code Angular et par les erreurs, séquences avec état, différentiel, propositions IA jouées
comme les autres), oracle (sept niveaux de réaction, dix catégories de défaillance silencieuse, verdicts
`FAILURE_REPRODUCED` / `FAILURE_NOT_REPRODUCED` / `INCONCLUSIVE` / `ENVIRONMENT_FAILURE` /
`TEST_INFRASTRUCTURE_FAILURE`), rejouages (fréquence), minimisation (delta debugging), conditions avec leurs taux,
première défaillance, perte de données (sans promesse de récupération), hypothèses `PROPOSED` avec vérifications
(les rejouages attendent une décision), test de non-régression proposé, rapport. Pause, annulation, reprise, budgets
par profondeur. Onglet **Déclencheurs** de l'espace d'investigation ; routes `…/trigger/*` ; client
`incidents.trigger`. Le mode déterministe n'exige aucune IA.
