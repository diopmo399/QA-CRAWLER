# Exemple : le SDK dans un programme Node

`replay.mjs` ouvre le service du SDK dans le programme même (`openQaCrawler`), rejoue les scénarios
d'un projet par le moteur, suit les étapes en direct et sort avec le code de son verdict. C'est la
même API que l'assistant et le Dashboard : aucun second moteur, aucun serveur à lancer à part.

```bash
npm run build
node examples/sdk-node/replay.mjs --workspace ./qa-workspace --project Demandes --env Recette
node examples/sdk-node/replay.mjs --workspace ./qa-workspace --project Demandes --json
```

| Option              | Rôle                                                        |
| ------------------- | ----------------------------------------------------------- |
| `--workspace <dir>` | l'espace de travail du SDK (un dossier par projet)          |
| `--project <nom>`   | le projet, par nom ou identifiant                           |
| `--env <nom>`       | l'environnement, par nom ou identifiant (sinon : le projet) |
| `--scenario <nom>`  | un scénario à rejouer (répétable ; sinon : tous)            |
| `--json`            | une seule ligne JSON : verdict, environnement, assertions   |

| Code  | Sens                                                               |
| ----- | ------------------------------------------------------------------ |
| `0`   | verdict `PASSED`                                                   |
| `1`   | verdict `FAILED`                                                   |
| `2`   | usage : projet ou environnement introuvable                        |
| `3`   | exécution impossible, ou sans verdict (`NO_FLOW`, `INCOMPLETE`)    |
| `130` | annulé par Ctrl+C : le moteur s'est arrêté avant l'action suivante |

Le jeton du service n'est jamais affiché ; les valeurs saisies ne sont jamais dans la sortie
(seulement les libellés d'étape et les clés de données). Testé par
`tests/integration/sdk-node-example.test.ts` avec le vrai moteur.
