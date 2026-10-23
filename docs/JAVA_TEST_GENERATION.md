# Génération de tests Java — JUnit 5 + Playwright Java

QA-CRAWLER génère, à partir des flows (enregistrés ou écrits en YAML) et de ce que leur dernier run a
appris, un **projet Maven exécutable** : une classe de test JUnit 5 par flow, pilotée par Playwright
Java, avec les actions, localisateurs et navigations enregistrés, les données de test générées par
run, les assertions d'interface, la collecte des preuves et le rapport JUnit XML de Surefire.

C'est un **adaptateur indépendant** (`src/platform/java-junit-playwright-generator.ts`) : il ne lit que
le modèle des flows (`FlowDefinition`) et le rapport du run (`FlowRunReport`), n'exécute rien sur
l'application, n'est importé par aucun moteur. Java et Maven ne servent qu'à exécuter le projet
généré ; rien ne change pour qui ne s'en sert pas.

## Produire le projet

| Moyen                                                                                                     | Où                                                                                       |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `npx qa-crawler generate-tests --java`                                                                    | `qa-crawler/generated-tests-java/` (`--out <dir>`, `--package <nom>`)                    |
| mission : `platform.generatedTests.java.enabled: true`                                                    | `reports/generated-tests-java/` à la fin du run, résumé dans `generated-java-tests.json` |
| API : `generateJavaJUnitPlaywrightProject(flows, reports, options)` puis `writeJavaProject(project, dir)` | où vous voulez                                                                           |

```yaml
# mission
platform:
  generatedTests:
    java:
      enabled: true
      packageName: qa.generated # par défaut
      playwrightVersion: 1.56.0 # par défaut : la version du Playwright Node du projet (x.y.0)
```

La CLI projet lit le dernier `qa-reports/result.json` quand il existe : le statut du run et de
chaque étape, et les checkpoints sémantiques, sont repris en commentaire des tests.

## Ce qui est généré

```
pom.xml                                   Java 17, junit-jupiter 5.14.4, playwright 1.56.0, surefire 3.5.6, compiler 3.14.1
README.md                                 la table des tests, les commandes, les variables d'environnement
src/test/java/<package>/<Flow>Test.java   une classe par flow
src/test/java/<package>/support/
  QaPlaywrightTest.java                   cycle de vie : navigateur par classe, contexte + page par test, erreurs console
  Env.java                                QA_BASE_URL (défaut : baseUrl de la mission), QA_HEADLESS, QA_SLOW_MO, Env.require(nom)
  TestData.java                           une valeur générée par clé et par run, réutilisée entre les étapes
  EvidenceExtension.java                  à l'échec : capture, URL, erreurs console, données du run → target/qa-evidence/
```

Les versions ont été vérifiées sur Maven Central le 2026-10-23 (artefacts publiés et stables).
Playwright Java suit la version du Playwright Node du projet (même révision de navigateur : les
navigateurs déjà installés servent ; `PLAYWRIGHT_BROWSERS_PATH` est respecté).

### Correspondance des étapes

| Étape du flow                    | Java                                                                                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `goto`, `startAt`                | `page.navigate(Env.url(route))`                                                                                                                   |
| `click`, `check`, `uncheck`      | `locator.click()` / `.check()` / `.uncheck()`                                                                                                     |
| `fill` `{ testData: clé }`       | `locator.fill(data.value("clé"))` — générée par run, la même pour toutes les étapes qui la citent                                                 |
| `fill` `{ env: NOM }`            | `locator.fill(Env.require("NOM"))`                                                                                                                |
| `fill` valeur littérale          | `Env.require("QA_REPRO_<FLOW>_STEP_<n>")` — la valeur enregistrée n'est **jamais** copiée                                                         |
| `select`                         | `locator.selectOption(option)`                                                                                                                    |
| `expect.url` / `effects.route`   | `assertThat(page).hasURL(Pattern)`                                                                                                                |
| `expect.text`, `effects.appears` | `assertThat(page.getByText(...).first()).isVisible()` (ou `getByRole` pour `rôle:nom`)                                                            |
| `expect.visible` / `hidden`      | `assertThat(locator).isVisible()` / `.isHidden()`                                                                                                 |
| `expect.noError`                 | `assertThat(page.locator("[role=\"alert\"], .mat-error, .invalid-feedback")).hasCount(0)`                                                         |
| `expect.response`                | `page.waitForResponse(...)` — au mieux, signalé dans les notes                                                                                    |
| `screenshot`                     | `evidence(label)` → `target/qa-evidence/<Classe>/<label>.png` + `.txt`                                                                            |
| `manual`                         | `manual(texte)` : journalisé, jamais un échec                                                                                                     |
| `dragAndDrop`                    | `getByText(item).dragTo(getByText(zone))`                                                                                                         |
| `auto`, `intent`                 | **non rejouables** en Java : `unsupported(raison)` → le test est **abandonné** (JUnit `skipped`), listé dans le résumé et le javadoc de la classe |

Localisateurs : `getByRole(AriaRole.X, new Page.GetByRoleOptions().setName(...).setExact(true))`,
`getByLabel`, `getByText`, `getByTestId`, `locator(css)` en repli ; une cible « dans la ligne »
devient `getByRole(AriaRole.ROW).filter(new Locator.FilterOptions().setHasText(...))` (+ `.first()` /
`.last()` selon `rowPick`), `nth` → `.nth(n)`. Un rôle inconnu de Playwright Java devient un
sélecteur `[role="..."]`, avec une note.

Les citations `${testData:clé}` et `${env:NOM}` dans les textes, noms et lignes deviennent des
expressions (`data.value(...)`, `Env.require(...)`).

### Ce que le test généré **ne** prouve **pas**

- Un test qui compile n'est pas un test validé : seul `mvn test` contre l'application le dit, et
  il ne prouve que ce que ses actions et assertions couvrent (pas plus que le run QA-CRAWLER lui-même).
- Les assertions métier de la mission (`flow.assertions`, PR #132) ne sont pas encore sur `main` :
  le projet généré porte les assertions d'interface (`expect`, `effects`) et les checkpoints en
  commentaire ; les preuves réseau/données restent celles du rapport QA-CRAWLER.
- Les étapes `auto` / `intent` et la récupération intelligente (healing, re-résolution) n'existent
  pas en Java : le test s'arrête (`skipped`) plutôt que d'inventer.

## Exécuter

```bash
cd qa-crawler/generated-tests-java

# une fois, si les navigateurs de cette version Playwright ne sont pas installés
mvn -q exec:java -e -D exec.mainClass=com.microsoft.playwright.CLI -D exec.args="install chromium"
# (ou PLAYWRIGHT_BROWSERS_PATH=<dossier des navigateurs déjà installés>)

export QA_BASE_URL=http://localhost:4200     # l'application testée
export QA_REPRO_CREER_UNE_DEMANDE_STEP_3=...  # une variable par valeur littérale du flow (voir le README généré)
mvn test                                       # JUnit XML : target/surefire-reports/TEST-*.xml
QA_HEADLESS=false QA_SLOW_MO=200 mvn test      # voir le navigateur
```

Preuves d'un test en échec : `target/qa-evidence/<Classe>/<test>-failure.png` et `.txt` (URL,
exception, données du run, erreurs console et de page).

Exemple livré : [`examples/java-junit-playwright/`](../examples/java-junit-playwright/README.md), généré
des flows de l'application de démonstration (`npm run demo:server`, port 4174).

## Tests

- `tests/unit/java-junit-playwright-generator.test.ts` : identifiants, littéraux, citations, valeurs
  (jamais un littéral enregistré), localisateurs, ordre et sens des actions, étapes signalées,
  statuts du run en commentaire, pureté et déterminisme, homonymes, versions.
- `tests/integration/java-generated-tests.test.ts` : génère depuis l'application de test, vérifie
  qu'aucune requête n'est faite à la génération, puis `mvn test` : le flow qui passe passe, celui
  dont l'attente est fausse échoue avec ses preuves, celui qu'un test Java ne peut pas rejouer est
  `skipped` — lu dans les XML Surefire. Ignoré quand Java ou Maven manquent.
