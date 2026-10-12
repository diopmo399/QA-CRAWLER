# Migration : du dépôt cloné au paquet installable

QA-Crawler reste utilisable exactement comme avant depuis le dépôt (`npm run qa -- scenarios/x.yaml`,
`npm start -- …`, Docker, Kubernetes). Ce guide décrit ce qui change pour **consommer** l'outil
depuis un projet applicatif, et comment passer d'un mode à l'autre sans perdre ce qui existe.

## Avant / après

| Usage                    | Avant (dépôt cloné)                                        | Après (paquet dans votre projet)                                       |
| ------------------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------- |
| Installation             | `git clone` + `npm ci` + `npx playwright install chromium` | `npm install -D @qa-crawler/cli` + `npx playwright install chromium`   |
| Lancer une mission       | `npm run qa -- scenarios/ma-mission.yaml`                  | `npx qa-crawler explore scenarios/ma-mission.yaml` (inchangé)          |
| Configurer l'application | une mission YAML par application                           | `qa-crawler.config.yaml` écrit par `npx qa-crawler init`               |
| Flows                    | `flows:` dans la mission                                   | `qa-crawler/flows/*.yaml` et `*.feature`, découverts                   |
| Rejouer / analyser       | `npm run qa -- scenarios/x.yaml`                           | `npx qa-crawler replay` / `analyze` / `test-api`                       |
| Enregistrer              | `npm run qa -- record --url …`                             | `npx qa-crawler record --url …` (reporte dans qa-reports/)             |
| Rapports                 | `reports/`, `screenshots/`, `knowledge/` du dépôt          | `qa-reports/`, `qa-crawler/knowledge/`, `qa-crawler/memory/` du projet |
| Version                  | `package.json` du dépôt                                    | `npx qa-crawler --version` ; `tool` dans `result.json` / `run.json`    |
| Codes de sortie          | 0 / 1 / 2 / 3                                              | identiques (0 succès, 1 échec QA, 2 configuration, 3 infrastructure)   |

## Ce qui ne change pas

- Le format des missions YAML, des flows, des scénarios Gherkin, des données de test, des baselines,
  des enregistrements et des bases de connaissances : la configuration de projet est **traduite** en
  mission (`qa-crawler/.derived/<commande>.mission.yaml`) et confiée au chargeur et à l'orchestrateur
  existants. Les commandes historiques (`learn`, `verify`, `explore <mission>`, `dry-run`, `record`,
  `sources`, `k8s-manifest`) sont toutes conservées et s'appellent via le même binaire.
- Les variables d'environnement (`QA_BASE_URL`, `QA_USERNAME` / `QA_PASSWORD`, `QA_INTELLIGENCE_MODE`,
  `QA_PERSISTENCE_*`, …) et leur priorité : ligne de commande > environnement > fichier > défauts.
- La sécurité : `SafetyPolicy`, masquage des secrets, aucune valeur saisie dans les artefacts.
- Le déterminisme : l'IA reste optionnelle (`intelligence.enabled: false` par défaut) et consultative.
- Les providers de persistance : `memory`, `file` (défaut dans un projet : `qa-crawler/memory/`),
  `database` (PostgreSQL, SQL Server, SQLite) avec les mêmes migrations.

## Pas à pas

1. Dans le projet applicatif : `npm install -D @qa-crawler/cli` puis `npx playwright install chromium`
   si le projet n'a pas déjà de navigateurs Playwright.
2. `npx qa-crawler init` : la détection (cadre, Playwright, OpenAPI, Git, CI, Docker…) écrit
   `qa-crawler.config.yaml` et l'arborescence `qa-crawler/`. Rien d'existant n'est écrasé.
3. Déplacer les flows : copiez les entrées `flows:` de vos missions dans `qa-crawler/flows/*.yaml`
   (un fichier = un flow, ou un fichier `flows:` liste) et vos `.feature` dans le même dossier.
   Les autres clés de mission (`safety`, `goals`, `oracles`, `gherkin`, `knowledge`, …) vont sous
   `qaCrawler.mission:` et l'emportent sur la traduction.
4. Acteurs : `qaCrawler.actors` (le premier `primary: true` devient `auth`, les autres `actors`).
   Les identifiants restent dans l'environnement (`usernameEnv` / `passwordEnv`) ; les sessions
   réutilisables vont dans `qa-crawler/actors/<nom>.json` (ignoré par Git).
5. Playwright : si le projet a un `playwright.config.*`, `init` le référence et `baseURL`, `headless`,
   `viewport`, `storageState` sont repris. Sinon QA-Crawler utilise son propre Playwright.
6. CI : `npx qa-crawler analyze --base-url <url>` et publication de `qa-reports/` ; le code de sortie
   fait échouer le job (1) ou signale une mauvaise configuration (2).
7. Facultatif : garder une mission complète pour les cas avancés et la lancer avec
   `npx qa-crawler explore chemin/mission.yaml` — exactement la CLI d'avant.

## Correspondance des clés

| `qaCrawler.*`                              | Mission                                                  |
| ------------------------------------------ | -------------------------------------------------------- |
| `application.baseUrl` / `startAt` / `name` | `target.baseUrl` / `target.startAt` / `mission.name`     |
| `browser.headless`                         | `browser.headless`                                       |
| `exploration.enabled` (commande `explore`) | `exploration.autonomous`                                 |
| `actors[primary].auth`                     | `auth` (`oidc` → `sso`, `reuseSession` → `auth.session`) |
| `actors[autres]`                           | `actors` + `authorization.primaryActor`                  |
| `api.openapi` / `api.testing`              | `openapi.source` / `apiTesting.enabled`                  |
| `visual`, `staticAnalysis`, `recording`    | `visual`, `staticAnalysis` (`source.root`), `recording`  |
| `intelligence`                             | `ai` (`enabled`, `mode`, `provider`, …)                  |
| `persistence`                              | `persistence` (+ `file.directory = paths.memory`)        |
| `reporting`                                | `output` (`reportsDir`, `html`, `json`) + `report`       |
| `paths.knowledge` / `paths.baselines`      | `knowledge.file` / `baseline.dir`                        |
| `mission`                                  | fusion finale (gagne)                                    |

## Pour les mainteneurs du dépôt

- Les sources restent dans `src/` ; `npm run build` compile dans `packages/core/dist` et copie
  `domain-packs/` et le README à côté. `packages/cli/bin/qa-crawler.js` est la seule source du CLI.
- Les workspaces npm lient `node_modules/@qa-crawler/{core,cli}` vers `packages/` : `npm start`
  exécute le bin exactement comme un projet consommateur.
- `npm run pack:check` refuse un tarball contenant `src/`, `tests/`, `scenarios/`, des `.map` ou
  des `.test.`. `npm run test:packaging` installe réellement les tarballs dans quatre projets d'exemple.
- `npm run release -- <patch|minor|major|x.y.z>` aligne les trois `package.json`, transforme
  `## Unreleased` du `CHANGELOG.md` en version datée, construit et vérifie. Publiez ensuite
  `packages/core` puis `packages/cli` sur le registre voulu (`--registry`).
- Node minimale : 20 (`engines`). `node:sqlite` demande Node 22.5+ pour le provider SQLite seulement.
