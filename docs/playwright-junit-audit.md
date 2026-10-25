# Audit : génération de tests Playwright et rapport JUnit XML

Audit fait avant toute modification, sur `main` (commit `fe8a583`), conformément à la contrainte
« préserver les fonctionnalités existantes ». Il établit ce qui existe, ce qui manque, les contrats
à préserver et la référence des tests.

## 1. État de départ

- Arbre de travail propre (un seul dossier non suivi, `packages/core/assets/`, préexistant et hors de
  portée de ce travail).
- Tests unitaires sur `main` : **147 fichiers, 1 530 tests, 0 échec**.
- Tests d'intégration sur `main` : voir « Référence » en fin de document.

## 2. Ce qui existe déjà

### Génération de tests Playwright — PRÉSENTE

| Élément        | Où                                                                                                              | Comportement                                                                                                             |
| -------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Générateur     | `src/platform/playwright-test-generator.ts`, `flow-steps.ts`                                                    | pur : `generatePlaywrightTest(s)(flows, reports, { baseUrl, checkpoints })` → `{ fileName, content, steps, assertions }` |
| Entrée         | `FlowDefinition` (`FlowConfig` : nom, étapes, `startAt`)                                                        | les flows de la mission, y compris ceux produits par le recorder (`generated.flow.yaml`)                                 |
| Localisateurs  | `getByRole`, `getByLabel`, `getByText`, `getByTestId`, `locator`, lignes de tableau (`getByRole('row').filter`) | sémantiques d'abord, CSS en repli                                                                                        |
| Valeurs        | `testData[...]` générées par run ; littéraux → `process.env.QA_REPRO_<FLOW>_STEP_<n>`                           | jamais une valeur enregistrée, jamais un secret                                                                          |
| Assertions     | `expect` (url, text, visible, hidden, noError, response), `effects` (route, appears)                            |                                                                                                                          |
| Pendant un run | `platform.generatedTests.enabled` (**false par défaut**)                                                        | `reports/generated-tests/<flow>.spec.ts` + `generated-tests.json` (extension de l'analyse du run)                        |
| CLI projet     | `npx qa-crawler generate-tests [--out <dir>]`                                                                   | relit `result.json` du dernier run pour annoter les tests ; n'exécute rien sur l'application                             |
| API publique   | `generatePlaywrightTests`, `generatePlaywrightTest`, `GeneratedTest` (`src/index.ts`)                           |                                                                                                                          |
| Tests          | `tests/unit/qa-platform-visual-regression.test.ts` (1 cas), `tests/unit/project/project-cli.test.ts` (commande) |                                                                                                                          |
| Doc            | `docs/QA_PLATFORM.md` (phase 11), README (`generate-tests`)                                                     |                                                                                                                          |

Lacunes constatées :

1. **Une erreur du générateur interrompt le run.** Dans `orchestrator.ts`, la génération pendant un
   run n'est pas isolée : une exception (écriture impossible, flow inattendu) ferait échouer un run
   QA par ailleurs valide. La contrainte demande l'inverse.
2. **Aucun test ne prouve** que le générateur ne modifie pas les flows source ni n'agit sur
   l'application, ni qu'un flow issu d'un enregistrement (cibles CSS de repli, lignes de tableau,
   `${testData:…}`) se génère.
3. Le générateur ignore les étapes `fill` dont la valeur est `{ env }` ? Non : `playwrightValue`
   les rend `process.env[...]`. Pas de lacune.

### Rapport JUnit XML — ABSENT

Aucune trace de JUnit dans `src/` : les rapports sont `result.json`, `index.html`, `overview.html`,
`flow-graph.html/json`, `run.json`, `anomalies.json`… (`src/reporting/reporter.ts#writeReports`).
L'interface `Reporter { format; write(result) }` existe et sert à `JsonReporter`, `HtmlReporter`,
`OverviewHtmlReporter`, `FlowGraphHtmlReporter` : un reporter JUnit s'y range sans rien changer.

## 3. Contrats à préserver

| Contrat                                                   | Détail                                                                                                        | Décision                                                                                       |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Schéma mission (`config.ts`)                              | `report` est un objet **strict** `{ failOnSeverity, language }` ; `output` strict ; `platform.generatedTests` | ajouter `report.junit` (facultatif, défaut désactivé) : les anciennes missions restent valides |
| Schéma projet (`project-config.ts`)                       | `reporting.format: ['html' \| 'json']`, `.passthrough()`                                                      | ajouter la valeur `junit` à l'énumération (les anciennes valeurs restent valides)              |
| CLI mission (`args.ts`)                                   | options listées dans l'aide ; `parseArgs` strict (option inconnue = erreur d'usage)                           | ajouter `--junit` (booléen) ; rien d'autre ne change                                           |
| CLI projet                                                | `PROJECT_COMMANDS`, `generate-tests` inchangés                                                                | aucun changement de commande                                                                   |
| `writeReports(result, output, flowGraphFile?, language?)` | signature publique                                                                                            | **inchangée** ; JUnit écrit par l'orchestrateur après, isolé                                   |
| `ExplorationResult.artifacts`                             | clés existantes                                                                                               | ajouter `junit?: string`                                                                       |
| Codes de sortie                                           | 0 / 1 (`failOnSeverity`, régressions `verify`) / 2 / 3                                                        | inchangés ; JUnit reflète le même seuil, ne décide rien                                        |
| Événements, ids                                           | flows, étapes, runs, événements du moteur                                                                     | aucun changement                                                                               |
| Rapports existants                                        | fichiers et formats                                                                                           | aucun changement ; JUnit est un fichier de plus, seulement si activé                           |

## 4. Dépendances

```
config (YAML) ─► orchestrator ─► FlowExplorer (recorder / replay / exploration / données / sécurité / IA optionnelle)
                     │
                     ├─► analyses (run-analysis, workflow-analysis, …)
                     ├─► platform.generatedTests ─► playwright-test-generator (pur, lit FlowConfig + FlowRunReport)
                     ├─► writeReports (json, html, overview, flow-graph)
                     └─► [nouveau] JUnit (pur, lit ExplorationResult) ─ jamais lu par le cœur
```

Le générateur Playwright et le reporter JUnit ne sont importés par aucun module du cœur
(explorateur, recorder, replay, persistance) : aucune dépendance circulaire possible.

## 5. Plan (additif)

1. `src/reporting/junit-reporter.ts` : `junitXmlOf(result, { failOnSeverity })` (pur) et
   `JUnitReporter implements Reporter`.
2. `report.junit: { enabled: false, file: 'junit.xml', required: false }` dans le schéma de mission ;
   `--junit` dans la CLI mission ; `reporting.format: [..., junit]` dans la configuration projet.
3. Orchestrateur : après `writeReports`, écrire JUnit **dans un try/catch** ; une erreur devient un
   avertissement (`onWarning`) sauf `required: true`, où elle fait échouer le run.
4. Orchestrateur : isoler de la même façon la génération Playwright pendant un run (avertissement,
   jamais une interruption).
5. Tests : unitaires (XML, statuts, seuil, échappement, aucune valeur sensible ; générateur pur,
   flow enregistré), non-régression (ancienne mission sans `junit` → aucun fichier, mêmes artefacts ;
   ancien recording rejoué ; sans IA, sans persistance), intégration (`runMission` avec JUnit activé,
   fichier lisible, un run FAILED donne des `<failure>`).
6. Docs : README (rapports, CLI), `docs/QA_PLATFORM.md`, CHANGELOG.

## 6. Référence des tests avant modification

Sur `main` (`fe8a583`), arbre propre, avant la première modification :

| Suite                                       | Résultat                                                                                                                                                                                                                          |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx vitest run --project unit`             | 147 fichiers, **1 530 tests, 0 échec**                                                                                                                                                                                            |
| `npx vitest run --project integration`      | 104 fichiers : 100 réussis, 3 ignorés (bases de données absentes), **1 échec préexistant** : `recording-intent-review.test.ts` › « the replay is unchanged » (instable, déjà vu sur `main` et en CI avant ce travail ; sans lien) |
| `npm run lint`, `typecheck`, `format:check` | propres                                                                                                                                                                                                                           |

## 7. Exigence ajoutée en cours : générateur Java JUnit 5 + Playwright Java

Même méthode : un **adaptateur indépendant** (`src/platform/java-junit-playwright-generator.ts`) qui ne
lit que `FlowDefinition` + `FlowRunReport`, n'est importé par aucun moteur, et n'exécute rien sur
l'application. Produits : `pom.xml` (Java 17, JUnit Jupiter 5.14.4, Playwright Java alignée sur le
Playwright Node du projet, Surefire 3.5.6, compiler 3.14.1 — versions vérifiées sur Maven Central le
2026-10-23), classes de support (cycle de vie, `Env`, `TestData`, preuves), une classe par flow, README.
Points d'entrée (tous facultatifs, inertes par défaut) : `npx qa-crawler generate-tests --java`,
`platform.generatedTests.java.enabled`, API `generateJavaJUnitPlaywrightProject` / `writeJavaProject`.
Détail : [JAVA_TEST_GENERATION.md](JAVA_TEST_GENERATION.md).

Vérification réelle, pas seulement la compilation : le test d'intégration génère le projet depuis
l'application de test, vérifie qu'aucune requête n'est faite à la génération, puis `mvn test` :
le flow valide passe, le flow à l'attente fausse échoue (preuves écrites), le flow non rejouable
(`auto`) est `skipped`. L'exemple livré (`examples/java-junit-playwright/`) a aussi été exécuté
contre l'application de démonstration (`npm run demo:server`) : `mvn test` vert (1 réussi, 1 ignoré).

Deux faits appris à l'exécution, et traités :

- `Playwright.create()` installe par défaut **tous** les navigateurs (Chromium, Firefox, WebKit) au
  premier usage : lent, et impossible hors ligne. Le cycle de vie généré réutilise les navigateurs
  déjà installés (`PLAYWRIGHT_BROWSERS_PATH`, ou le cache partagé avec le Playwright Node de la même
  version) et ne télécharge rien de lui-même ; `QA_INSTALL_BROWSERS=true` rétablit l'installation.
- Une preuve à l'échec doit écrire son contexte **avant** la capture d'écran (la capture peut
  elle-même expirer).

## 8. Bilan

### Fonctionnalités préservées (vérifiées par les suites, pas déclarées)

Recorder, replay, exploration, données dynamiques, assertions, rapports (`result.json`, `index.html`,
`overview.html`, `flow-graph.*`, `run.json`, …), persistance, IA optionnelle, CLI mission et projet,
codes de sortie, schémas YAML (toute mission ou configuration de projet d'avant est valide telle
quelle : les nouvelles clés ont un défaut désactivé). `writeReports` garde sa signature ; aucun
composant public n'a été renommé ni remplacé.

### Nouveaux fichiers

| Fichier                                              | Rôle                                                                                                                                            |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/reporting/junit-reporter.ts`                    | `junitXmlOf`, `junitSuitesOf`, `JUnitReporter` (pur, lit `ExplorationResult`)                                                                   |
| `src/platform/java-junit-playwright-generator.ts`    | générateur Java (pur) + `writeJavaProject`, `defaultPlaywrightJavaVersion`                                                                      |
| `tests/unit/junit-reporter.test.ts`                  | XML, statuts, seuil, échappement, aucune valeur sensible                                                                                        |
| `tests/unit/junit-config.test.ts`                    | non-régression : mission / projet / CLI d'avant inchangés, JUnit désactivé                                                                      |
| `tests/unit/playwright-generator-regression.test.ts` | générateur Playwright pur et déterministe ; flow issu d'un enregistrement                                                                       |
| `tests/unit/java-junit-playwright-generator.test.ts` | générateur Java : briques, projet, ordre des actions, étapes signalées                                                                          |
| `tests/integration/junit-report.test.ts`             | `runMission` : JUnit activé / désactivé / erreur d'écriture / `required` ; générateurs en échec = avertissement ; activés et inertes par défaut |
| `tests/integration/java-generated-tests.test.ts`     | génération sans requête, `mvn test` réel, XML Surefire, preuves (ignoré sans Java/Maven)                                                        |
| `examples/java-junit-playwright/`                    | projet exécutable livré, généré de `flows.yaml`                                                                                                 |
| `docs/JAVA_TEST_GENERATION.md`, ce document          | documentation                                                                                                                                   |

### Composants modifiés, et pourquoi

| Fichier                                  | Modification                                                                                                                | Raison                                                         |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `src/config/config.ts`                   | `report.junit` et `platform.generatedTests.java` (objets stricts, défaut off)                                               | activer les options depuis une mission, sans changer le défaut |
| `src/config/config-loader.ts`            | surcharge `junit`                                                                                                           | `--junit`                                                      |
| `src/cli/args.ts`, `src/cli/cli.ts`      | option `--junit`, ligne d'artefact                                                                                          | CLI mission                                                    |
| `src/cli/project-command.ts`             | `--junit` transmis ; `generate-tests --java [--package]`                                                                    | CLI projet                                                     |
| `src/project/project-config.ts`          | `reporting.format: [.., junit]`                                                                                             | configuration de projet                                        |
| `src/model/exploration-result.ts`        | `artifacts.junit?`                                                                                                          | chemin du fichier produit                                      |
| `src/orchestrator.ts`                    | JUnit après `writeReports` (try/catch, `required`) ; génération Playwright isolée (try/catch) ; génération Java (try/catch) | les produits dérivés ne font jamais échouer un run valide      |
| `src/index.ts`                           | exports                                                                                                                     | API publique additive                                          |
| README, `docs/QA_PLATFORM.md`, CHANGELOG | documentation                                                                                                               |                                                                |

### Tests exécutés

| Moment         | Unitaires                                                                                                                                                            | Intégration                                                                                                                                                                                                                                                                                                                |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Avant (`main`) | 1 530 / 1 530                                                                                                                                                        | 600 réussis, 1 échec préexistant (`recording-intent-review`), 3 ignorés                                                                                                                                                                                                                                                    |
| Après          | 1 552 réussis / 1 553 (151 fichiers) ; 1 échec par délai (5 s) de `static-analysis.test.ts` › « cache: MISS then HIT » sous charge, **repasse vert isolé** (17 / 17) | 606 réussis / 611 (106 fichiers), 4 ignorés (bases absentes, Java présent donc le cas « toolchain absent » ignoré) ; 1 échec de `recording-deterministic.test.ts` › TEST 10, instabilité connue de `main` et de la CI, **repasse vert isolé** (13 / 13) ; l'échec préexistant `recording-intent-review` n'est pas réapparu |

### Régressions

Aucune régression imputable aux changements : les deux échecs de la passe complète sont des instabilités de temps (délai unitaire de 5 s, enregistrement déterministe) déjà observées avant ce travail, et chacun repasse vert seul ; les nouveaux tests passent tous (unitaires : 12 + 5 + 4 + 2 ; intégration : 5 + 1).

### Ce qui n'a pas pu être vérifié ici

- Les tests Java générés contre une **application réelle** d'un utilisateur : seule l'application
  de test et celle de démonstration ont servi. Un test qui passe ici prouve que ses actions et
  assertions tiennent sur cette application, pas davantage.
- Le téléchargement des navigateurs par Playwright Java (réseau fermé ici) : le chemin « navigateurs
  déjà installés » est testé, le chemin « installation automatique » (`QA_INSTALL_BROWSERS=true`) ne
  l'est pas.
- Les bases de données PostgreSQL / SQL Server (tests ignorés ici comme sur `main`).
- La CI GitHub : l'application GitHub n'est pas installée sur le dépôt ; le résultat des workflows
  sera lu sur la pull request.
