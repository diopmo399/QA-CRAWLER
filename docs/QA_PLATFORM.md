# QA Platform — Run Workflow Analysis + intelligence QA

La plateforme est une couche d'ANALYSE au-dessus des moteurs existants (explorateur, flows imposés,
WorkflowHealer, moteur cognitif, intelligence fonctionnelle, oracles, régression, persistance,
conseiller d'intelligence). Elle ne réexécute rien et ne redécide rien : elle relie ce que les
moteurs ont produit, catégorise, compare dans le temps, et rend un **statut global** expliqué.

Règles absolues : le runtime l'emporte sur le statique, l'historique et le LLM ; le LLM conseille et
n'exécute jamais ; la SafetyPolicy est prioritaire ; une image différente n'est pas une régression ;
une variation de performance isolée n'est pas une régression ; chaque anomalie cite ses preuves ;
reproduire, c'est reproduire un comportement fonctionnel ; aucun secret dans les rapports, les
journaux, les prompts ou les artefacts ; les sessions des acteurs sont isolées ; les flows d'origine
ne sont jamais modifiés ; toute conclusion porte Conclusion / Evidence / Confidence / Source.

## Statut global

| Statut               | Règle (la première qui s'applique)                                                       |
| -------------------- | ---------------------------------------------------------------------------------------- |
| `INCONCLUSIVE`       | verdict fonctionnel `INCONCLUSIVE`, ou rien n'a été parcouru                             |
| `FAIL`               | un flow a divergé ou a été bloqué, un défaut `ERROR`/`CRITICAL`, une nouvelle régression |
| `DEGRADED`           | réussi grâce à une récupération, régression de performance ou visuelle                   |
| `PASS_WITH_WARNINGS` | défaut `WARNING`, effet non vérifié, comportement instable                               |
| `PASS`               | rien à signaler                                                                          |

`FAST PATH` : aucun défaut, aucune divergence, aucune récupération. `DEEP PATH` : au moins un signal.

## Artefacts (`reports/`)

| Fichier                          | Contenu                                                                                                                     |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `run.json`                       | statut global, raisons, chemin, modèle d'exécution compact, résumé des anomalies, conclusions                               |
| `anomalies.json`                 | anomalies catégorisées : symptôme, cause probable / confirmée, preuves, régression, avis                                    |
| `workflow-graph.json`            | graphe observé : écrans annotés, arêtes, chemin de chaque flow, première divergence                                         |
| `functional-coverage.json`       | couverture fonctionnelle (`COVERED` … `UNKNOWN`) par flow, preuve, checkpoint, workflow, règle                              |
| `api-analysis.json`              | corrélation UI ↔ API par étape, tests d'API tirés du contrat, écarts contrat / runtime                                      |
| `actor-analysis.json`            | profils, différences d'accès classées, écart de comportement avec le run précédent                                          |
| `performance-analysis.json`      | tendances de durée par flow et par étape contre l'historique                                                                |
| `regression-analysis.json`       | `NEW_REGRESSION`, `REGRESSION_PERSISTING`, `REGRESSION_FIXED`, `FLAKY_BEHAVIOR`, …                                          |
| `visual-analysis.json`           | verdict visuel par étape, baseline, image des différences                                                                   |
| `reproductions.json`             | chemin de reproduction minimal et flow YAML autonome par anomalie                                                           |
| `generated-tests/<flow>.spec.ts` | tests Playwright générés                                                                                                    |
| `generated-tests-java/`          | projet Maven JUnit 5 + Playwright Java (`platform.generatedTests.java`, [JAVA_TEST_GENERATION.md](JAVA_TEST_GENERATION.md)) |
| `generated-java-tests.json`      | le résumé de ce projet : classes, étapes, assertions, étapes non rejouables, versions                                       |
| `advisor.json`                   | ce que le conseiller d'ambiguïté a été consulté, et combien d'avis ont été retenus                                          |
| `pull-request-comment.md`        | le commentaire de pull request généré                                                                                       |
| `junit.xml`                      | le run au format JUnit XML pour la CI (`report.junit`, désactivé par défaut)                                                |

Dans `index.html`, la section **Analyse du run de workflow** (analyse détaillée) les résume.

## Les phases : ce qui existait, ce qui est nouveau, ce qui est réutilisé

| Phase | Nouveau                                                                                                                     | Existant réutilisé                                                                                          | Intégration                                                                       |
| ----- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 1     | `RunWorkflowAnalysisReport`, statut global, `RunExecutionModel`, `RunAnomalyAnalyzer` (13 catégories, symptôme ↔ cause)     | `RunAnalysis` (verdict, chaîne causale), issues, divergences analysées, réseau par étape                    | `src/platform/run-workflow-analysis.ts`, `anomaly-analyzer.ts` ; `run.json`       |
| 2     | `ObservedWorkflowGraph`                                                                                                     | FlowGraph (états, transitions), états par flow, checkpoints cognitifs                                       | `workflow-graph.ts` ; `workflow-graph.json`                                       |
| 3     | `FunctionalCoverageGraph` en cinq statuts                                                                                   | checkpoints et lacunes cognitifs, objectifs et workflows fonctionnels, preuve métier, règles d'autorisation | `functional-coverage.ts` ; `functional-coverage.json`                             |
| 4     | `auth.type: sso`, `auth.session.reuse` (`SESSION_NEW/REUSE/RECORD/EXPIRED`), profil d'acteur                                | `Authenticator` (form, http), `AuthorizationObserver`, `BrowserManager`                                     | `src/auth/session-provider.ts`, `authenticator.ts` ; `result.authentication`      |
| 5     | `UIApiCorrelationEngine` au rejeu (`CONSISTENT`, `UI_SUCCESS_API_ERROR`, …, `CONTRACT_UI_MISMATCH`)                         | `StepNetworkReport`, `StepEffectReport`, `ApiContract`                                                      | `ui-api-correlation.ts` ; `api-analysis.json`                                     |
| 6     | `ContractAnalyzer` → modèle de tests → tests d'API dans la session du run → oracle (`UNEXPECTED_STATUS`, `SCHEMA_DRIFT`, …) | `OpenApiContractProvider`, `declares`, le crochet `afterFlows` de l'explorateur                             | `api-testing.ts`, `apiTesting.*` ; `api-analysis.json`                            |
| 7     | `PixelVisualComparator` (codec PNG, masques, image des différences), baseline visuelle, `VISUAL_MATCH … MAJOR_CHANGE`       | interface `VisualComparator`, `ScreenshotService`                                                           | `src/visual/*`, `visual-analysis.ts`, `visual.*` ; `visual-analysis.json`         |
| 8     | `HistoricalBaselineAnalyzer` (médiane, tendance, `firstDetectedRun`, variation isolée ≠ régression)                         | durées par étape, base de connaissances (`performanceHistory`)                                              | `performance-analysis.ts`, `platform.performance.*` ; `performance-analysis.json` |
| 9     | `RegressionAnalyzer` (7 statuts)                                                                                            | cycle de vie des anomalies, écart de flow, dérive, diff de baseline                                         | `regression-analysis.ts` ; `regression-analysis.json`                             |
| 10    | `ReproductionPlanner` (chemin minimal, flow YAML, jugement d'un rejeu)                                                      | étapes des flows, données de test par étape                                                                 | `reproduction-planner.ts`, `flow-steps.ts` ; `reproductions.json`                 |
| 11    | générateur de tests Playwright (localisateurs sémantiques, assertions des effets, données générées)                         | définition des flows, effets enregistrés, checkpoints                                                       | `playwright-test-generator.ts`, `platform.generatedTests` ; `generated-tests/`    |
| 12    | `ActorBehaviorDiff` (`POSSIBLE_AUTHORIZATION_REGRESSION`)                                                                   | `AuthorizationReport`, base de connaissances (`actorAccess`)                                                | `actor-analysis.ts` ; `actor-analysis.json`                                       |
| 13    | `FlowMemoryRepository` dans tous les providers (migration 005, index), `FlowMemoryService`                                  | `PersistenceProvider`, adaptateurs SQLite / PostgreSQL / SQL Server, provider fichier / mémoire             | `src/persistence/*`, `flow-memory.ts`, `platform.flowMemory`                      |
| 14    | `ExplorationJob`, `runExplorationJobs` (sorties, connaissance, persistance, baselines par job)                              | `runMission`                                                                                                | `exploration-jobs.ts`                                                             |
| 15    | `renderQaJobManifest` (Job / CronJob, `secretKeyRef`, Job indexé), commande `qa-crawler k8s-manifest`                       | image Docker, README Kubernetes                                                                             | `kubernetes-manifest.ts`, `src/cli/manifest-command.ts`                           |
| 16    | `PullRequestReporter`, `GitHubPullRequestReporter`, commentaire Markdown remplacé à chaque run                              | le rapport structuré                                                                                        | `pull-request-reporter.ts`, `platform.pullRequest.*`                              |
| 17    | conseiller d'ambiguïté : le LLM consulté seulement pour ce qu'aucune règle n'explique, avis attaché, jamais appliqué        | `IntelligenceProvider`, Copilot / déterministe, `IntelligenceContextSanitizer`                              | `ambiguity-advisor.ts`, `platform.advisor.*` ; `advisor.json`                     |

## Configuration (extraits)

```yaml
auth:
  type: sso
  identityProviderOrigin: https://login.example.test
  usernameSelector: '#user'
  passwordSelector: '#pass'
  submitSelector: '#go'
  session: { reuse: true, maxAgeMinutes: 480 } # storageState hors du dépôt (.qa-crawler/sessions/)
actors:
  - name: reader
    auth:
      { type: form, loginUrl: /login, usernameSelector: '#u', passwordSelector: '#p', submitSelector: '#s' }
    profile: { roles: [reader], permissions: [items.read], claims: [sub, roles] }
openapi: { enabled: true, source: openapi.yaml }
apiTesting: { enabled: true, methods: [GET], maxOperations: 50 } # jamais d'écriture hors d'un flow
visual:
  {
    enabled: true,
    minorChangeRatio: 0.02,
    majorChangeRatio: 0.2,
    masks: [{ x: 0, y: 0, width: 300, height: 40 }],
  }
platform:
  performance: { tolerance: 1.3, minSamples: 3, floorMs: 300 }
  reproductions: { enabled: true }
  generatedTests: { enabled: true }
  advisor: { enabled: true, maxCalls: 5, minConfidence: 0.5 } # actif seulement avec ai.enabled
  flowMemory: { enabled: true } # actif seulement avec persistence.enabled
  pullRequest: { enabled: true, tokenEnv: GITHUB_TOKEN } # owner/repo/number ou GITHUB_REPOSITORY + QA_PR_NUMBER
```

Parallélisation (par programme) : `runExplorationJobs(config, jobsPerActor(config), { concurrency: 2 })`.
Kubernetes : `qa-crawler k8s-manifest --name qa-nightly --image … --config-map qa-missions --mission shop.yaml --secret QA_PASSWORD=qa-credentials/password --claim qa-reports`.

## Tests

`tests/unit/qa-platform-*.test.ts` (statut global, anomalies, graphe, couverture, sessions, SSO,
acteurs, corrélation, tests d'API, visuel, performance, régression, reproduction, générateur,
mémoire des flows, jobs, manifeste, pull request, conseiller), `tests/unit/persistence-sqlite-contract.test.ts`
(contrat des providers avec la mémoire des flows, SQLite compris), `tests/integration/qa-platform.test.ts`
(run sain, second run, run refusé, jobs parallèles, session réutilisée).
