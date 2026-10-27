# La CLI de la plateforme

Les commandes `project`, `env`, `scenario`, `run`, `overview` et `doctor` pilotent un espace de
travail du SDK depuis un terminal ou une CI. Elles n'ont aucune logique propre : chacune appelle le
client du SDK. Les règles sont donc celles du serveur, les mêmes pour le Dashboard, l'assistant et
un programme Node : SafetyPolicy, environnements, archivage, confirmation d'une suppression.

## Connexion

| Mode    | Options                                                   | Quand                                                        |
| ------- | --------------------------------------------------------- | ------------------------------------------------------------ |
| Local   | `--workspace <dir>`                                       | le service s'ouvre dans la CLI (127.0.0.1, port libre)       |
| Distant | `--endpoint <url>` (`--token-env`, défaut `QA_SDK_TOKEN`) | un `qa-crawler sdk-server` déjà lancé ; jeton jamais affiché |

`run status` et `run cancel` demandent le mode distant : l'état vivant d'une exécution est dans le
serveur qui la joue. `--detach` aussi : un service ouvert par la CLI se ferme avec elle.
`--junit` demande le mode local : le run est lu sur disque.

## Commandes

```bash
qa-crawler doctor --workspace ./qa                       # Node, Chromium, espace de travail, version du contrat
qa-crawler project list --workspace ./qa
qa-crawler project show Demandes --workspace ./qa
qa-crawler env list Demandes --workspace ./qa
qa-crawler env show Demandes Recette --workspace ./qa    # noms des secrets, jamais leur valeur
qa-crawler env validate Demandes Recette --reach --workspace ./qa
qa-crawler scenario list Demandes --workspace ./qa
qa-crawler scenario promote Demandes parcours-1 --workspace ./qa
qa-crawler run start Demandes --env Recette --junit ci/junit.xml --workspace ./qa
qa-crawler run list Demandes --workspace ./qa
qa-crawler run results Demandes run-2026-… --workspace ./qa
qa-crawler overview --days 7 --workspace ./qa
```

Un projet et un environnement se désignent par leur nom ou leur identifiant. Deux projets du même
nom : l'identifiant est demandé.

- `env validate` répond `READY` quand l'environnement respecte les règles du moteur, que chaque
  secret cité est défini sur le serveur et, avec `--reach`, que l'URL répond (`ready` en JSON).
- `run start` suit les étapes en direct (sur stderr), puis lit le verdict écrit par le moteur.
  `--junit <file>` écrit aussi le run en JUnit XML. Le JUnit suit les flows : les anomalies n'y
  deviennent pas des échecs (`failOnSeverity: NONE`), comme le verdict de l'exécution.
- **Ctrl+C** pendant `run start` : le premier annule par le SDK. Le moteur s'arrête avant l'action
  suivante et écrit son rapport, et la commande sort avec `130`. Le second quitte tout de suite.

## Sortie JSON

`--json` écrit un seul document JSON sur stdout : la réponse du SDK (projets, détail d'exécution,
vérification…). Une erreur s'écrit aussi en JSON : `{"error": {"code", "message"}}`. Le suivi en
direct de `run start` n'est pas écrit en mode JSON.

## Codes de sortie

| Code  | Sens                                                                                                                                           |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`   | succès ; verdict `PASSED`                                                                                                                      |
| `1`   | échec QA : verdict `FAILED`                                                                                                                    |
| `2`   | usage ou configuration : argument, projet ou environnement introuvable, refus du serveur (4xx), environnement pas prêt                         |
| `3`   | outil ou infrastructure : serveur injoignable, erreur 5xx, exécution impossible, pas de verdict (`NO_FLOW`, `INCOMPLETE`), diagnostic en échec |
| `130` | annulé par Ctrl+C                                                                                                                              |

## Sécurité

- Le jeton du mode distant est lu dans une variable d'environnement, jamais en argument, jamais
  affiché.
- Les environnements ne renvoient que les noms des variables secrètes.
- Les étapes s'affichent par leur libellé, sans la valeur saisie.
- Toute sortie passe par le masquage des secrets de la CLI.

## Tests

- `tests/unit/cli-platform.test.ts` : usage, erreurs JSON, projets, environnements (secrets jamais
  écrits, `READY` ou non), scénarios, rejeu et JUnit, codes de sortie par verdict, Ctrl+C → `130`,
  vue d'ensemble ; mode distant (`--detach`, `status`, `cancel`, jeton absent ou faux, `doctor`).
  Moteur **simulé**.
- `tests/integration/cli-platform.test.ts` : la CLI lancée comme un programme à part avec le
  **vrai** moteur : `doctor`, `env validate --reach`, `run start` (`0`, JUnit XML), `run results`,
  une assertion en échec (`1`), `run list`, Ctrl+C (`130`, aucune écriture finale).
