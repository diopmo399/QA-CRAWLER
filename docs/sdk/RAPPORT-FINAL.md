# SDK embarquable — rapport final (phases 0 à 7)

Branche `feat/sdk-studio`, PR #139, empilée sur `feat/salesforce-lightning` (#138). Ce rapport dit
ce qui est fait et prouvé, ce qui ne l'est qu'en partie, et ce qui ne l'est pas. Un test cité a été
**exécuté** ; rien n'est déclaré « exécutable » sans qu'un test ait joué la sortie.

## 1. Implémenté et testé

| Phase | Capacité                                                                                                              | Preuve                                                                                     |
| ----- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 0     | Audit des capacités A–L (quatre états), base de référence, architecture cible, risques                                | `docs/sdk/MASTER-AUDIT.md`                                                                 |
| 1     | Flux d'événements rouvert après coupure, sans doublon (`seq`, `after`) ; refus 4xx non réessayé                       | `sdk-core.test.ts` ; reprise dans Chromium : `sdk-monitor.test.ts`                         |
| 1     | `connect()` vérifie `apiVersion` ; contrat public figé (exports, valeurs, méthodes) ; Core et UI sans Node            | `sdk-contract.test.ts`                                                                     |
| 3     | Flow Studio : graphe, groupes, dépendances de données, chemin du dernier rejeu, modifications vérifiées par le moteur | `sdk-studio.test.ts` (unitaire) et intégration avec le vrai recorder et le vrai rejeu      |
| 4     | Données de test : lignée, sources, données sans origine, liaison par le moteur (refus sans écriture)                  | `sdk-data-assertions.test.ts`, `sdk-studio.test.ts` (intégration)                          |
| 4     | Verdicts d'assertions lus dans le dernier rejeu ; `NOT_EXECUTED` sans exécution                                       | idem                                                                                       |
| 5     | Gherkin : mission générée qui joue le `.feature` ; **jouée** sur l'application                                        | `sdk-generated-execution.test.ts`                                                          |
| 5     | Playwright TS : configuration générée (JUnit XML) ; **lancé** par Playwright Test (`1 passed`)                        | idem                                                                                       |
| 5     | Java JUnit 5 + Playwright Java : `mvn test`                                                                           | `java-generated-tests.test.ts` (existant, relancé)                                         |
| 5     | Correctifs trouvés en exécutant la sortie : première correspondance, gabarit de route (TS et Java)                    | `playwright-generator-regression.test.ts`, `java-junit-playwright-generator.test.ts`       |
| 6     | Comparaison de deux exécutions (règle `compareFlowRuns` du moteur) et des couvertures d'exigences                     | `sdk-runs.test.ts` (unitaire ; intégration avec deux vrais runs, le second avec un défaut) |
| 6     | Traçabilité (`NOT_COVERED` … `STALE_EVIDENCE`) et régression servies telles que le moteur les écrit                   | idem                                                                                       |
| 6     | `<qa-crawler-run-compare>` (page `/runs`)                                                                             | piloté dans Chromium                                                                       |
| 7     | Événements `flow` / `flow-step` (libellés sans valeur saisie) ; `<qa-crawler-run-monitor>` (page `/monitor`)          | `sdk-monitor.test.ts` (unitaire ; vrai moteur ; Chromium avec flux coupé puis repris)      |
| 7     | Thème sombre (`theme="dark"`, `"auto"`) des quatre composants ; variables de l'hôte prioritaires                      | `sdk-theme.test.ts` ; rendu dans Chromium (`sdk-runs.test.ts`)                             |
| 7     | Contraste WCAG AA (4,5:1) du texte et des statuts de la comparaison et du Run Monitor, dans les deux thèmes           | `sdk-theme.test.ts` (calcul sur les jetons réels)                                          |

## 2. Fait mais non testé complètement

- **Exemple hôte** (`examples/sdk-host/host.mjs`), qui montre les quatre composants avec un thème
  commun. Il a été lancé une fois après `npm run build` et ouvert dans Chromium : quatre éléments
  définis, thème appliqué aux quatre, aucune erreur de console. Aucun test automatique ne le joue.
- **Thème sombre de l'assistant et du Studio** : les règles sont vérifiées par test et l'assistant
  a été contrôlé sur capture. Le contraste n'est pas calculé pour ces deux composants.

## 3. Partiel

- **Run Monitor** : il suit par flow, statut d'étape, type d'événement et type d'anomalie. Il ne
  suit **pas par groupe métier**, car les groupes d'un enregistrement ne figurent pas dans les
  événements d'exploration.
- **Accessibilité** : clavier, régions annoncées et contraste sont testés composant par composant.
  Aucun audit axe automatique n'est lancé : l'outil n'est pas une dépendance du dépôt.
- **Comparaison** : elle porte sur les flows, les étapes et les exigences. Les captures d'écran de
  deux exécutions ne sont pas comparées, bien que le moteur sache le faire (régression visuelle à
  seuil).
- **Flow Studio** : il ne rejoue pas un groupe seul.

## 4. Non implémenté

- **Définitions de steps pour un exécuteur Gherkin externe** : c'est un choix. QA-CRAWLER est
  l'exécuteur, et ses phrases intégrées sont les définitions. C'est documenté.
- **Publication sur un registre** : non faite, car elle est interdite sans autorisation.

## 5. Bloqué

Rien n'est bloqué techniquement. La fusion des PR #136, #137, #138 et #139 attend votre décision
explicite (« Merge »).

## 6. Défaut connu du moteur, non corrigé

En acceptant une proposition d'assertion, `decideProposal` peut enregistrer l'étape `expect` sous
l'action suivante (a5) alors que la proposition vise l'action d'ancrage (a4). Le SDK rattache donc
d'abord le verdict par l'action d'ancrage et le JSON identique, puis, à défaut, par l'unique étape
`expect` identique. Le moteur n'a pas été modifié.

## 7. Fichiers

Créés :

- `docs/sdk/MASTER-AUDIT.md`, `docs/sdk/RAPPORT-FINAL.md`
- `src/sdk/core/verdicts.ts`
- `src/sdk/server/runs.ts`
- `src/sdk/ui/studio.ts`, `studio-view.ts`, `studio-layout.ts`, `studio-i18n.ts`, `studio-styles.ts`
- `src/sdk/ui/runs.ts`, `runs-view.ts`, `runs-i18n.ts`, `runs-styles.ts`
- `src/sdk/ui/monitor.ts`, `monitor-view.ts`, `monitor-model.ts`, `monitor-i18n.ts`, `monitor-styles.ts`
- `src/sdk/ui/theme.ts`
- `tests/unit/sdk-contract.test.ts`, `sdk-studio.test.ts`, `sdk-data-assertions.test.ts`,
  `sdk-runs.test.ts`, `sdk-monitor.test.ts`, `sdk-theme.test.ts`
- `tests/integration/sdk-studio.test.ts`, `sdk-generated-execution.test.ts`, `sdk-runs.test.ts`,
  `sdk-monitor.test.ts`

Modifiés :

- `CHANGELOG.md`, `docs/sdk/README.md`, `examples/sdk-host/host.mjs`, `examples/sdk-host/README.md`
- `package.json`, `package-lock.json` (`@playwright/test` 1.56.1 en dépendance de développement)
- `src/platform/flow-steps.ts`, `generation-plan.ts`, `playwright-test-generator.ts`,
  `java-junit-playwright-generator.ts`
- `src/recording/recording-workspace.ts`, `test-data-binding.ts`
- `src/sdk/core/client.ts`, `contracts.ts`, `index.ts`
- `src/sdk/server/explorations.ts`, `page.ts`, `recordings.ts`, `server.ts`
- `src/sdk/ui/index.ts`, `styles.ts`, `wizard.ts`
- `tests/unit/sdk-core.test.ts`, `sdk-server.test.ts`, `generation-plan.test.ts`,
  `playwright-generator-regression.test.ts`, `java-junit-playwright-generator.test.ts`,
  `qa-platform-visual-regression.test.ts`
- `tests/integration/sdk-extensions.test.ts`, `qa-platform.test.ts`

Aucun test n'a été désactivé. Les attentes figées des générateurs ont été mises à jour pour les
deux correctifs de la phase 5, et chaque changement est expliqué dans le CHANGELOG.

## 8. Commandes de validation exécutées

Avant chaque commit :

```bash
npm run -s lint
npx tsc --noEmit -p tsconfig.json
npm run -s format:check
npm run -s build
npx vitest run --project unit            # dernière exécution : 1751/1751
```

Tests d'intégration ciblés, avec le vrai moteur et Chromium :

```bash
npx vitest run --project integration tests/integration/sdk-generated-execution.test.ts   # 3/3
npx vitest run --project integration tests/integration/java-generated-tests.test.ts      # 1/1 (mvn test)
npx vitest run --project integration tests/integration/sdk-studio.test.ts                # 12/12
npx vitest run --project integration tests/integration/sdk-runs.test.ts                  # 5/5
npx vitest run --project integration tests/integration/sdk-monitor.test.ts               # 2/2
npx vitest run --project integration tests/integration/sdk-wizard.test.ts tests/integration/sdk-extensions.test.ts tests/integration/qa-platform.test.ts tests/integration/recording-test-data-binding.test.ts
```

CI GitHub, sur chaque commit poussé de la PR #139 : `build`, `integration` (3 shards),
`persistence`, `packaging`, `packaging-windows`. Le statut de chaque commit est indiqué dans la PR.
