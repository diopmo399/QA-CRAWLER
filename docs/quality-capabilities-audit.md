# Audit des capacités qualité : assertions métier, traçabilité, cohérence des données

Audit fait sur la branche principale avant toute modification, en lisant le code et les tests (pas
seulement les noms des classes). Pour chaque capacité : statut, composants, fonctionnement réel,
tests qui le démontrent, lacunes, solution, risques.

Statuts : `IMPLEMENTED` (intégré au cycle d'exécution, testé), `PARTIAL` (des briques réelles, mais
la capacité demandée n'est pas couverte), `MISSING`, `UNVERIFIED` (présent mais sans preuve
d'intégration ou de test).

## Synthèse

| Capacité                                            | Statut avant | Ce qui manquait surtout                                                                                                    |
| --------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------- |
| A. Moteur d'assertions métier                       | PARTIAL      | des assertions déclaratives, identifiées, comparant les valeurs du run (soumises, retournées, affichées, relues)           |
| B. Traçabilité exigences ↔ règles ↔ tests ↔ preuves | MISSING      | tout le modèle : exigences, règles, liens, couverture, preuves rattachées, rapport                                         |
| C. Cohérence des données UI ↔ API ↔ états           | PARTIAL      | la comparaison au rejeu (saisie → requête → réponse → affichage → recherche), doublons, relations, effets de bord déclarés |
| Modèle commun de preuves                            | PARTIAL      | le run, l'étape, l'assertion, l'exigence, la corrélation et l'expurgation sur chaque preuve                                |

## A. Moteur d'assertions métier — PARTIAL

### Ce qui existe et fonctionne

| Composant                                                                                   | Fonctionnement réel                                                                                                                                                                                                    | Tests                                                                               |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Étape `expect` des flows (`config/flow-schema.ts`, `flows/flow-step-executor.ts#expect`)    | texte visible, URL, élément visible / caché, aucun message d'erreur, une requête observée avec son statut (`response: { method, url, status }`). Aucune comparaison avec les données du run.                           | `tests/unit/flows.test.ts`, intégration `imposed-flows.test.ts`                     |
| Vérification de l'effet (`flows/action-effect-verifier.ts`)                                 | chaque étape porte ses effets attendus (apparition, disparition, route, dialogue…) : `CONFIRMED`, `NO_EFFECT`, `WRONG_EFFECT`… C'est l'effet À L'ÉCRAN de l'action, pas le résultat métier.                            | `tests/unit/action-effect-verifier.test.ts`, intégration `action-effects.test.ts`   |
| Assertions Gherkin (`semantics/resolution/assertion-resolver.ts`, `flow-explorer.ts` ~4518) | `ENTITY_CREATED` = « la dernière écriture a répondu 2xx et aucun message d'erreur » : un statut HTTP sert de preuve du résultat métier. `ENTITY_VISIBLE` = les valeurs saisies sont visibles quelque part sur la page. | `tests/unit/semantic-assertions-bench.test.ts`, intégration `gherkin-flows.test.ts` |
| Oracles (`oracles/*`)                                                                       | jugent chaque action d'EXPLORATION (technique, interface, baseline, contrat OpenAPI, invariants, historique). `SemanticOracle` est documenté comme « résultat métier UNKNOWN sans attente explicite ».                 | `tests/unit/oracles.test.ts`, `invariants.test.ts`                                  |
| Preuve métier (`flows/business-proof.ts`)                                                   | CREATE → SEARCH → OPEN reconstruit d'après les statuts des étapes et des requêtes : `PROVEN` / `PARTIAL`… Aucune valeur comparée, aucun identifiant vérifié.                                                           | `tests/unit/flow-run-analysis.test.ts`                                              |
| Intelligence fonctionnelle (`functional/*`, `SemanticFunctionalOracle`)                     | effets attendus appris (API, état, entité) ; au plus `WARNING`, seulement avec `functionalIntelligence.enabled`.                                                                                                       | `tests/unit/functional-intelligence.test.ts`                                        |

### Lacunes confirmées

- Aucune assertion **déclarative identifiée** (identifiant stable, criticité, source attendue,
  délai, preuves exigées, préconditions).
- Aucune comparaison entre la valeur **soumise** (`TestDataRunContext`) et la valeur **retournée**,
  **affichée** ou **relue** : « 2xx » ou « texte visible » font office de preuve.
- Aucun identifiant métier extrait d'une réponse et réutilisé par une vérification suivante.
- Aucune lecture d'API autorisée en lecture seule pour confirmer un résultat.
- Le statut d'un flow ne dépend que de ses étapes ; aucun statut `BLOCKED`, `INCONCLUSIVE` ou
  `UNVERIFIABLE` pour une attente métier.

### Solution

Un moteur d'assertions déclaratives (`src/quality/`), branché à la fin de chaque flow imposé, qui
lit les preuves déjà produites (réseau de l'étape en empreintes salées, valeurs du run, écran,
contrat) et, si l'assertion le demande, une API de lecture (`GET` seulement, hôte autorisé par la
SafetyPolicy). Résultats `PASS` / `FAIL` / `BLOCKED` / `INCONCLUSIVE` / `UNVERIFIABLE`. Un échec
d'assertion obligatoire fait échouer le flow (anomalie `BUSINESS_ASSERTION`) ; une assertion
obligatoire non vérifiée rend le statut global `INCONCLUSIVE`, jamais `PASS`.

### Risques

Faible : rien ne change sans assertion déclarée. La lecture des corps de réponse (empreintes) est
activée seulement si la mission déclare des assertions ou des règles de cohérence (sinon, comme
avant, seulement avec l'intelligence fonctionnelle).

## B. Traçabilité exigences, règles, tests, résultats, preuves — MISSING

### Constat

- Aucun modèle d'exigence ni de règle métier déclarée : `grep -ri requirement src` ne renvoie qu'un
  commentaire de `cognitive/planning.ts`.
- Les tags Gherkin servent à choisir les scénarios (`flows/gherkin/gherkin-loader.ts` : `tags`,
  `@skip`, autorisations) puis sont **perdus** : `flowSchema` n'a aucun champ pour les porter.
- `rules/` (RuleGraph) contient des règles **découvertes dans le code** (candidates confirmées ou
  contredites au runtime) : utile comme source, ce n'est pas une exigence.
- `platform/functional-coverage.ts` mesure la couverture des workflows **observés**, pas celle
  d'exigences.

### Solution

`requirements` et `businessRules` dans la mission (même fichier YAML, validés par Zod), liens
`COVERS` (flow → exigence, aussi par tag Gherkin `@REQ-…`), `VERIFIES` (assertion → règle),
`DEPENDS_ON`, `CONFLICTS_WITH`, `DERIVED_FROM`. La couverture se calcule à partir des résultats
RÉELS des assertions du run : `NOT_COVERED`, `COVERED_NOT_EXECUTED`, `VERIFIED_PASS`,
`VERIFIED_FAIL`, `BLOCKED`, `INCONCLUSIVE`, `STALE_EVIDENCE` (une preuve d'un run précédent, gardée
dans un historique, ne vérifie jamais le run courant). Rapport JSON + section HTML.

### Risques

Faible : nouvelles clés facultatives. Les missions existantes restent valides.

## C. Cohérence des données UI ↔ API ↔ états — PARTIAL

### Ce qui existe et fonctionne

| Composant                                                    | Fonctionnement réel                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `forms/state/form-knowledge-observer.ts` + `value-digest.ts` | pour chaque XHR / fetch autorisé : les valeurs ENVOYÉES en empreintes salées (`requestCriteria`), les identifiants d'une écriture acceptée (`identifiers`), les enregistrements d'une lecture avec leurs attributs en empreintes (`records`), les codes d'état. Jamais une valeur en clair. **Actif seulement avec l'intelligence fonctionnelle** (sel). |
| `data/test-data-run-context.ts`                              | une valeur par clé et par run (générée, modèle, référence) : la vraie valeur du run, jamais celle de l'enregistrement.                                                                                                                                                                                                                                   |
| `recording/business/entity-correlation.ts`                   | corrélation CREATE → SEARCH → RESULT → OPEN par empreintes, **pendant l'enregistrement** seulement.                                                                                                                                                                                                                                                      |
| `platform/ui-api-correlation.ts`                             | au rejeu, issue de l'écran vs issue de l'API **par statut** (UI_SUCCESS_API_ERROR…), sans valeurs.                                                                                                                                                                                                                                                       |
| `functional/side-effects.ts`                                 | effets attendus appris, écriture inattendue `UNEXPECTED` ; au plus un avertissement, avec l'intelligence fonctionnelle.                                                                                                                                                                                                                                  |

### Lacunes confirmées

- La réponse d'une écriture ne garde que ses identifiants : impossible de comparer la valeur
  retournée à la valeur envoyée.
- Aucune comparaison au REJEU : saisie → requête, requête → réponse, réponse → écran, création →
  recherche ultérieure.
- Aucune règle d'unicité (doublon par clé métier), aucune relation déclarée, aucun effet de bord
  déclaré (écritures permises, créations attendues).

### Solution

Un moteur de cohérence (`src/quality/`) qui réutilise l'observateur (une fenêtre par flow, les
empreintes de la réponse d'une écriture en plus), les valeurs du run et l'écran final. Statuts
`CONSISTENT`, `INCONSISTENT`, `MISSING_DATA`, `AMBIGUOUS_ENTITY`, `NOT_OBSERVABLE`,
`PENDING_EVENTUAL_CONSISTENCY`, `INCONCLUSIVE`, avec règle, champ, sources, normalisation,
confiance et preuves. Jamais une valeur sensible dans le rapport.

### Risques

Moyen sur un point : lire les corps de réponse a un coût. Il n'est payé que si la mission déclare
des assertions ou de la cohérence. Les empreintes restent salées par run.

## Modèle de preuves — PARTIAL

`cognitive/evidence.ts` définit `Evidence` (`id`, `type`, `source`, `timestamp`, `confidence`,
`details` sans valeur saisie) et un plafond de confiance par type (`EVIDENCE_TRUST` : le runtime 1,
le réseau 0,95, une proposition de LLM 0,2). Il manque le run, l'étape, l'assertion, l'exigence, la
corrélation et l'expurgation. **Solution** : `QualityEvidence` étend `Evidence` (mêmes types, même
plafond) au lieu d'un second modèle.

## Verdict global

`platform/run-workflow-analysis.ts#overallStatusOf` calcule déjà `PASS`, `PASS_WITH_WARNINGS`,
`DEGRADED`, `FAIL`, `INCONCLUSIVE`. Il est réutilisé : une anomalie `BUSINESS_ASSERTION` de
sévérité `ERROR` donne `FAIL` ; une assertion obligatoire non vérifiée donne `INCONCLUSIVE`.

## Tests de départ

- Unitaires sur la branche principale, avant toute modification : 1 528 réussis, **2 échecs**, tous
  deux dans `tests/unit/static-analysis-worker.test.ts` (« builds the same graph in a worker
  thread » dépasse sa limite de 5 s ; « keeps the event loop free » mesure 965 ms au lieu de moins
  de 500 ms). Ce sont des seuils de temps sensibles à la charge de la machine, sans lien avec cette
  mission ; ils passent sur des machines moins chargées (CI verte).
- La CI de la branche principale est verte (intégration en 3 parties, packaging, persistance).

## Plan d'implémentation (par priorité)

1. Modèle de preuves (`QualityEvidence`) et modèle d'assertion déclarative, validé par Zod.
2. Moteur d'assertions : évaluateurs purs sur un contexte de preuves (réseau, valeurs du run,
   écran, API de lecture), délais, préconditions, statuts.
3. Branchement au rejeu des flows : fenêtre réseau du flow, contexte, évaluation à la fin du flow,
   anomalie, statut du flow, événements.
4. Traçabilité : exigences, règles, liens, tags Gherkin, couverture, historique des preuves.
5. Cohérence des données : règles automatiques et déclarées.
6. Rapports (`quality-verification.json`, section HTML), statut global, métriques.
7. Tests unitaires et d'intégration (application de test déterministe), documentation.

## Résultats

| Capacité          | Avant   | Après       | Réutilisé                                                                                                               | Ajouté                                                                                                                     |
| ----------------- | ------- | ----------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Assertions métier | PARTIAL | IMPLEMENTED | empreintes salées et fenêtres de `FormKnowledgeObserver`, `TestDataRunContext`, `declares` / `parseOpenApi`, `Evidence` | `quality-schema.ts`, `assertion-engine.ts` (9 genres), branchement à `FlowExplorer.runFlow`, anomalie `BUSINESS_ASSERTION` |
| Traçabilité       | MISSING | IMPLEMENTED | tags du chargeur Gherkin, contrat OpenAPI, dossier de connaissance                                                      | `traceability.ts`, `requirements` / `businessRules`, `x-requirements`, historique (STALE_EVIDENCE)                         |
| Cohérence         | PARTIAL | IMPLEMENTED | `businessProofOf`, `requestCriteria` / `records` / `identifiers` en empreintes                                          | `consistency-engine.ts` (7 règles), `responseValues`, anomalie `DATA_CONSISTENCY`                                          |
| Modèle de preuves | PARTIAL | IMPLEMENTED | `Evidence` et son plafond de confiance                                                                                  | `QualityEvidence` (run, flow, étape, assertion, exigences, corrélation, source, expurgation)                               |
| Verdict           | —       | ÉTENDU      | `overallStatusOf`, `buildRunAnalysis`                                                                                   | assertion contredite → FAIL ; non vérifiée → INCONCLUSIVE ; toutes PASS → preuve métier faite                              |

Un défaut de l'observateur réseau, trouvé par le test d'intégration, est corrigé : une réponse
suivie d'une navigation immédiate (créer puis ouvrir) n'était plus lisible par Playwright, et
l'échange paraissait sans identifiant. Le corps est maintenant relu par une session CDP de lecture
(messages réseau durables) ; s'il reste illisible, l'échange le dit (`responseUnread`) et
l'assertion est INCONCLUSIVE au lieu de FAIL.

Tests ajoutés : `business-assertions` (16), `data-consistency` (11), `traceability` (8),
`quality-verification` (3) en unitaires ; `business-verification` (5, application de démonstration
`tests/fixtures/quality-app.ts` avec défauts activables) en intégration. Utilisation :
`docs/BUSINESS_ASSERTIONS.md`.
