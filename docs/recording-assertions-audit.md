# Diagnostic : assertions issues du recording, groupes métier, génération multi-format

Audit fait avant toute modification, sur la branche `feat/recording-assertions` = `main` (`fe8a583`)

- PR #133 (JUnit XML, générateur Java) + PR #132 (assertions métier, cohérence, traçabilité), les deux
  PR n'étant pas encore fusionnées. Travaux non commités préservés : `packages/core/assets/` (hors
  portée). Typecheck et lint propres sur cette base ; référence des tests en fin de document.

## 1. Architecture actuelle (ce qui existe réellement)

```
capture-script (page) ──► RawRecordedEvent[] ──► normalizer ──► SemanticRecordedAction[] ──► inferOutcomes
     │                      states: RecordedState[]  (stateBefore/After, network: FunctionalExchange[])      │
     │                      checkpoints, warnings                                                            ▼
     │                                                                                   AssertionCandidate[] (ROUTE, MESSAGE,
     │                                                                                   ENTITY_EXISTS, API_OUTCOME… ; stable /
     └── analyse HTTP (journal réseau, opérations), données de test (TestDataSet,            fragile ; selected)
         lignage, liaison humaine), intentions fonctionnelles, modèle d'application          │
                                                                                            ▼
                                           buildRecordedFlow ──► RecordedFlow { steps: RecordedFlowStep[], assertions, intent, quality }
                                                                        │   (LA représentation intermédiaire, unique source du YAML et du Gherkin)
                                                                        ▼
                                   generateFlowFiles ──► generated.flow.yaml (expect/effects) + generated.feature (suggestedFeature)
                                                                        │
             fenêtre du recorder (panel-state → recorder-panel-html, commandes __qaPanelCommand → RecordingConsole.ReviewActions)
                                                                        │
     replay (FlowExplorer) ──► FlowRunReport { steps, quality?: FlowQualityReport } ◄── BusinessAssertionEngine (#132) + checkConsistency
                                                                        │
     rapports : result.json, index.html (section qualité), run-analysis, traceability (#132), junit.xml (#133)
     générateurs : playwright-test-generator (TS), java-junit-playwright-generator (#133), suggestedFeature (Gherkin)
```

| Attente de la mission                                                  | État    | Où                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Observations d'une action (écran, réseau, DOM)                         | PARTIEL | `SemanticRecordedAction` (stateBefore/After, network, domEffects, expectedEffects), `RecordedState`, journal HTTP ; **pas de liste d'observations identifiées, par source, avec fiabilité**                                                                                                         |
| Assertions candidates du recording                                     | PARTIEL | `inferOutcomes` → `AssertionCandidate` (UI : route, message, entité, état, requête) ; stabilité, confiance, `selected`, preuves (chaînes) ; **pas d'origine OBSERVÉE / DÉDUITE / EXPLICITE, pas de validation humaine, pas de catégories de la mission, jamais d'assertion métier (#132) proposée** |
| Moteur d'assertions indépendant des formats                            | PRÉSENT | #132 : `assertionSchema` (check request / value / entity / state / cardinality / relation / transition / sideEffects / contract), `BusinessAssertionEngine`, statuts PASS / FAIL / BLOCKED / INCONCLUSIVE / UNVERIFIABLE, preuves `QualityEvidence`, `requires` (préconditions), `after`            |
| Vérification des résultats métier au rejeu                             | PRÉSENT | #132, dans `FlowExplorer` (fenêtre réseau par étape, relecture d'API autorisée, jamais la base)                                                                                                                                                                                                     |
| Cohérence des données (saisie → requête → réponse → écran → recherche) | PRÉSENT | #132 `checkConsistency` (UI_TO_REQUEST, REQUEST_TO_RESPONSE, RESPONSE_TO_UI, CREATE_TO_SEARCH, RELATION, DUPLICATE, SIDE_EFFECT)                                                                                                                                                                    |
| Valeurs dynamiques réutilisées entre étapes                            | PRÉSENT | `{ testData }`, `TestDataSet` (FIXED / GENERATED / REFERENCE), `availableVariables`, `dataLineage`, liaison dans la fenêtre (`bindTestData`)                                                                                                                                                        |
| Groupes métier dans le recording                                       | ABSENT  | `PanelStep.group` est un libellé d'affichage (étape métier déduite ou écran) ; aucun objet groupe, aucune opération                                                                                                                                                                                 |
| Traçabilité exigences ↔ tests ↔ preuves                                | PRÉSENT | #132 `buildTraceability` ; statuts NOT_COVERED, COVERED_NOT_EXECUTED, VERIFIED_PASS, VERIFIED_FAIL, BLOCKED, INCONCLUSIVE, STALE_EVIDENCE ; exigences manuelles (`requirements:` de la mission), `flow.requirements`                                                                                |
| Génération Playwright TypeScript                                       | PRÉSENT | `generatePlaywrightTests` (étapes `expect` / `effects`) ; **ignore `flow.assertions` (#132)**                                                                                                                                                                                                       |
| Génération Gherkin                                                     | PRÉSENT | `suggestedFeature` depuis le `RecordedFlow` ; exécuté par le moteur Gherkin de QA-CRAWLER (dictionnaire FR/EN) ; **ignore `flow.assertions`**                                                                                                                                                       |
| Génération Java JUnit 5 + Playwright Java                              | PRÉSENT | #133 ; **ignore `flow.assertions`**                                                                                                                                                                                                                                                                 |
| JUnit XML                                                              | PRÉSENT | #133 : étapes et anomalies ; **les assertions métier n'y figurent pas**                                                                                                                                                                                                                             |
| Interface de génération (sélection, aperçu, statuts)                   | ABSENT  | la fenêtre a un onglet « aperçu » du YAML et « Enregistrer » ; pas de choix de format, de groupes, d'assertions, pas de statut de génération                                                                                                                                                        |
| Rapports (groupes, assertions, preuves)                                | PARTIEL | section qualité (#132), rapport d'enregistrement ; pas de groupes, pas de propositions                                                                                                                                                                                                              |

## 2. Composants réutilisés (aucune deuxième architecture)

- Modèle d'assertion : `assertionSchema` / `AssertionConfig` (#132) **est** le modèle commun ; les propositions
  du recording produisent des `AssertionConfig` + des étapes `expect`, que le rejeu exécute déjà.
- Preuves : `Evidence` / `QualityEvidence` (plafonds de confiance par type, §122) ; `AssertionCandidate.evidence`.
- Données : `TestDataSet`, `dataLineage`, `availableVariables` (dépendances entre étapes par les données).
- Génération : `generateFlowFiles` (YAML + feature), `generatePlaywrightTests`, `generateJavaJUnitPlaywrightProject`,
  `suggestedFeature`, dictionnaire Gherkin (`GherkinStepDictionary`, `builtinSentences`).
- Fenêtre : `PanelState` → `recorder-panel-html` → `__qaPanelCommand` → `RecordingConsole` / `ReviewActions`.
- Rapports : `FlowQualityReport`, `buildTraceability`, `JUnitReporter`.

## 3. Écarts fonctionnels (ce qui est à construire)

1. **Observations structurées** : `RecordingObservation` (id stable, étape, ordre, source, résumé, fiabilité,
   références) dérivées de la session ; absentes quand non capturées (jamais reconstituées) ; `observations.json`.
2. **Propositions d'assertions** avec origine (OBSERVÉE / DÉDUITE / EXPLICITE), catégorie, confiance, preuves,
   limites, confirmation requise ; dédoublonnage et conflits ; décision humaine (accepter / refuser / modifier /
   désactiver) persistée ; les acceptées écrites dans le YAML (`expect` + `assertions:` #132).
3. **Groupes métier** : objets `BusinessStepGroup` dans le `RecordedFlow` (optionnels : anciens recordings OK),
   opérations (créer, renommer, décrire, regrouper, déplacer, réordonner, replier, détacher, supprimer en gardant
   les étapes), dépendances de données (lignage) qui avertissent ou bloquent, exécutabilité d'un groupe seul.
4. **Traduction commune des assertions** vers Playwright TS, Gherkin et Java : ce qu'un test autonome peut
   vérifier (écran) est traduit ; ce qui exige le réseau ou une API relue est **signalé** comme vérifié par le
   rejeu QA-CRAWLER seulement, jamais omis en silence.
5. **Interface de génération** : groupes / étapes / formats / assertions à inclure, origine et preuves, aperçu
   des fichiers, validations disponibles, export, statuts distincts (PROPOSED … INCONCLUSIVE).
6. **JUnit XML** : un cas par assertion métier exécutée (PASS → réussi, FAIL → failure, BLOCKED / INCONCLUSIVE /
   UNVERIFIABLE → skipped avec le motif) ; le détail reste dans JSON / HTML.
7. **Rapports** : groupes, propositions et décisions, statuts de génération, dans le rapport d'enregistrement.

## 4. Risques de régression, et parades

| Risque                                                   | Parade                                                                                                                               |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `RecordedFlow` / `recorded-flow.json` changent de forme  | champs **optionnels** seulement (`groups?`, `proposals?`) ; les anciens fichiers se chargent                                         |
| Le YAML généré change pour qui n'a rien demandé          | sans décision humaine, le YAML reste celui d'avant (mêmes `expect`) ; `assertions:` n'apparaît que pour une proposition **acceptée** |
| La fenêtre du recorder (tests E2E existants)             | nouvelles sections ajoutées, rien de retiré ; commandes nouvelles, anciennes inchangées                                              |
| Les générateurs TS / Java / Gherkin changent leur sortie | sans `flow.assertions`, sortie identique (tests de non-régression existants et nouveaux)                                             |
| JUnit XML                                                | cas ajoutés seulement quand `flow.quality` existe                                                                                    |
| `flow-explorer.ts` (10 k lignes)                         | non modifié : le rejeu des assertions est celui de #132                                                                              |

## 5. Plan par étapes

1. **Socle** : ce document ; référence des tests (unitaires, intégration) sur la branche.
2. **Observations + propositions** (`src/recording/observations.ts`, `src/recording/assertion-proposals.ts`, purs) ;
   branchement dans `processRecording` ; fichiers `observations.json`, `assertion-proposals.json` ; décision
   humaine (`reviewAssertion`) dans la console et la fenêtre ; régénération du YAML / feature.
3. **Groupes métier** (`src/recording/step-groups.ts`, pur) ; commandes de la fenêtre ; dépendances ;
   persistance dans `recorded-flow.json` ; génération par groupe.
4. **Génération multi-format** (`src/platform/assertion-translation.ts`) : traduction des `AssertionConfig`
   dans les trois générateurs ; plan de génération (`src/platform/generation-plan.ts`) avec aperçu, validation
   statique réelle (YAML / Gherkin relus par les chargeurs, TypeScript transpilé, Java compilé si `mvn`
   disponible) et statuts ; onglet de génération dans la fenêtre.
5. **Traçabilité et rapports** : JUnit XML (assertions), rapport d'enregistrement, documentation.
6. **Validation finale** : suites complètes, projets générés compilés / exécutés, bilan.

## 6. Référence des tests avant modification

Mesurée sur la branche de travail (`origin/main` + #132 + #133 fusionnés), avant la première ligne de
code de ce lot :

| Suite                           | Fichiers | Tests | Échecs |
| ------------------------------- | -------- | ----- | ------ |
| `npx vitest run --project unit` | 155      | 1591  | 0      |

`npm run -s lint`, `npm run -s typecheck`, `npm run -s format:check` : propres.

## 7. Bilan (après implémentation)

| Suite                                  | Fichiers         | Tests            | Échecs | Note                                                                                                      |
| -------------------------------------- | ---------------- | ---------------- | ------ | --------------------------------------------------------------------------------------------------------- |
| `npx vitest run --project unit`        | 159              | 1611             | 0      | +4 fichiers, +20 tests ; un aléa de délai (`static-analysis`, cache 5 s sous charge) repassé seul : 17/17 |
| `npx vitest run --project integration` | 104 (+3 ignorés) | 612 (+4 ignorés) | 0      | suite complète, dont les projets Java générés compilés et exécutés par Maven                              |

`npm run -s lint`, `npm run -s typecheck`, `npm run -s format:check` : propres.

Tests ajoutés : `tests/unit/assertion-proposals.test.ts` (observations → propositions, origine, décision,
YAML), `tests/unit/step-groups.test.ts` (groupes, dépendances, refus expliqué, YAML),
`tests/unit/assertion-translation.test.ts` (natif / rejeu seulement, TS, Java, Gherkin),
`tests/unit/generation-plan.test.ts` (trois formats, validation par outils réels, statuts),
`tests/unit/junit-reporter.test.ts` (un cas par assertion métier exécutée) ; adapté :
`tests/unit/playwright-generator-regression.test.ts` (les citations deviennent la donnée du run).

Ce qui n'a pas été exécuté ici : un enregistrement humain réel dans la fenêtre (les commandes
`assertion-decide`, `group` et `generate` sont testées par le modèle et la console, pas par un clic) ;
`mvn test` d'un projet généré depuis un enregistrement (le projet Java de la mission est compilé et exécuté
par `tests/integration/java-generated-tests.test.ts`).
