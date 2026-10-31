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

| Méthode    | Route                                                        |                                                  |
| ---------- | ------------------------------------------------------------ | ------------------------------------------------ |
| GET / POST | `/incidents`                                                 | lister, déclarer                                 |
| GET        | `/incidents/:i`                                              | consulter (avec l'historique et l'investigation) |
| POST       | `/incidents/:i/update`                                       | modifier (`revision` attendue, sinon 409)        |
| POST       | `/incidents/:i/scope/validate`                               | valider le périmètre                             |
| POST       | `/incidents/:i/scope/extensions`, `…/extensions/:e/decision` | demander, décider une extension                  |
| GET        | `/incidents/:i/capabilities`                                 | capacités de l'environnement d'exécution         |
| POST       | `/incidents/:i/reproduce`                                    | reproduire (arrière-plan)                        |
| POST       | `/incidents/:i/analyze`                                      | code, graphe, hypothèses                         |
| POST       | `/incidents/:i/experiments`, `…/experiments/:x/run`          | planifier, exécuter une vérification             |
| POST       | `/incidents/:i/diagnose`                                     | diagnostic                                       |
| GET        | `/incidents/:i/report?format=json\|markdown`                 | rapport                                          |
| POST       | `/incidents/:i/regression[/run\|/accept\|/reject]`           | test de non-régression                           |
| POST       | `/incidents/:i/cancel`, `/resume`                            | annuler, reprendre                               |
| GET        | `/incidents/:i/sources`                                      | fichiers lisibles du périmètre (droit `RUN`)     |
| GET        | `/incidents/:i/source?application=&file=`                    | un fichier, en lecture seule, valeurs masquées   |
| GET        | `/incidents/:i/screenshot?reproduction=&file=`               | une capture enregistrée (URL `data:`)            |

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

« Investiguer › Investigations » ouvre l'espace d'investigation d'un incident ; la spécification UX est dans
`docs/incident-reconstruction/ux-spec.md`, l'audit de départ dans `docs/incident-reconstruction/audit.md`, la revue
QA et accessibilité dans `docs/incident-reconstruction/qa-review.md`.

- **En-tête** : titre, gravité, environnement, scénario, statut, actions selon les droits ; **progression** en dix
  étapes (Description → Périmètre → Environnement → Reproduction → Preuves → Analyse du code → Traçabilité →
  Diagnostic → Rapport → Non-régression), calculée d'après l'investigation.
- **Quinze onglets** : vue d'ensemble, périmètre, environnement, chronologie, traçabilité, requêtes HTTP, frontend,
  BFF, backend, journaux, hypothèses, expériences, diagnostic, rapport, non-régression (navigation clavier : flèches, Début, Fin), chacun avec ses états chargement / vide / erreur /
  accès refusé.
- **Graphe full stack** en bande pleine largeur : couches Frontend, Réseau, BFF, Backend, Données ; statut de chaque
  relation (trait et légende), chemin d'erreur, zoom avec l'échelle réelle et une échelle minimale lisible,
  déplacement, un seul arrêt de tabulation (les flèches parcourent les nœuds) ; le tableau des relations donne la
  même information sous forme accessible.
- **Sélection synchronisée** (`src/sdk/ui/incident-links.ts`) : nœud, relation, requête, événement, preuve,
  symbole, fichier, hypothèse, vérification et étape ont une clé ; les liens viennent des données de
  l'investigation (jamais d'une supposition) et sont parcourus sur deux sauts. Une puce de preuve n'ouvre que ce
  qu'elle désigne réellement ; une référence sans élément sélectionnable reste du texte.
- **Panneau contextuel** : le détail de la sélection (preuve, requête avec en-têtes autorisés et corps masqué,
  extrait de code, capture, erreur, hypothèse, vérification).
- **Explorateur de code** : arborescence du périmètre, coloration TypeScript / Java / YAML / XML / properties,
  lignes désignées par l'investigation (erreur, chemin, hypothèse) ; lecture seule, chemins absolus et `..`
  refusés, liens symboliques qui sortent du dépôt refusés, valeurs sensibles des fichiers de configuration
  masquées. Les méthodes du code n'ont jamais de durée : seules les étapes et les requêtes observées en ont.
- **Démonstration** (`src/sdk/ui/incident-demo.ts`) : un incident fictif du catalogue de livres, bandeau
  « Données de démonstration » toujours visible, aucun appel au serveur ; ce n'est jamais un diagnostic réel.

Composants : `incident-workspace.ts` (coquille), `incident-workspace-controller.ts` (chargement, suivi toutes les
1,5 s sans redessiner si la révision n'a pas changé, sélection, clavier, annonces dans la zone vivante du
Dashboard), `incident-ux.ts` (en-tête, progression, onglets, environnement), `incident-graph.ts`,
`incident-timeline.ts`, `incident-frontend-trace.ts`, `incident-code.ts`, `incident-diagnosis.ts`,
`incident-parts.ts` (primitives partagées : sélection, statuts de relation, liens vers le code, puces de preuves,
états de panneau, bandeau de démonstration).
