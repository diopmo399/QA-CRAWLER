# SDK : diagnostic préalable et décisions

Ce document consigne ce qui existait avant le SDK, ce qui manquait, et chaque décision prise pour
que l'assistant ne montre que ce que le moteur fait réellement.

## 1. L'existant

| Sujet                      | Constat                                                                                                                                       |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Format de projet           | `qa-crawler.config.yaml` sous `qaCrawler:`, schéma `projectConfigSchema` ; `loadProjectMission` en dérive une mission (`mission:` l'emporte). |
| Lancement                  | `runMission(config, { listener, env, onWarning, onProgress })` rend un `RunOutcome`.                                                          |
| Suivi en direct            | `ExplorationListener` : `onState`, `onTransition`, `onBlocked`, `onIssue`, `onAuthenticated` ; `onProgress` pour les phases.                  |
| Résultat                   | `ExplorationResult` : statistiques, raison d'arrêt, anomalies, chemins des rapports.                                                          |
| Navigateurs                | Chromium seulement (`browser.browser`).                                                                                                       |
| Annulation                 | aucune : `runMission` ne prend pas de signal d'arrêt.                                                                                         |
| Pourcentage d'avancement   | aucun : le moteur connaît ses budgets, pas la taille de l'application.                                                                        |
| Identifiants               | lus par le moteur dans des variables d'environnement nommées par la configuration.                                                            |
| Serveurs HTTP existants    | Knowledge Center et fenêtre du recorder : `node:http`, local, jeton, sans dépendance web.                                                     |
| Interface web réutilisable | aucune : chaque fenêtre est une page servie par sa commande.                                                                                  |

## 2. Ce qui manquait

1. Un contrat stable côté navigateur (types, statuts, événements, erreurs).
2. Un adaptateur serveur : valider un brouillon avec le moteur, écrire le projet, lancer et suivre
   l'exploration, servir les rapports.
3. Un composant embarquable dont les styles ne fuient ni n'entrent.
4. Une commande pour démarrer le tout.

## 3. Décisions

| Question                                     | Décision                                                                                      | Raison                                                                   |
| -------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Où valider ?                                 | sur le serveur, par le moteur (schéma + chargement de la mission)                             | une seule vérité ; le navigateur ne vérifie que les formats, pour guider |
| Quel fichier écrire ?                        | `qa-crawler.config.yaml` au format du moteur, plus `sdk-project.json` (le brouillon)          | le projet reste utilisable sans le SDK (`qa-crawler explore`)            |
| Identifiants                                 | noms de variables `QA_*` seulement ; le serveur dit « définie » ou non                        | aucun secret dans le brouillon, le fichier, les journaux ni l'écran      |
| Variables lisibles                           | `^QA_[A-Z0-9_]+$`                                                                             | empêcher de sonder les variables du serveur (`AWS_*`, …)                 |
| Paramètres proposés                          | seulement ceux qui ont un effet dans la mission dérivée                                       | pas de réglage décoratif                                                 |
| Navigateur                                   | Chromium affiché comme seul disponible                                                        | c'est le seul du moteur                                                  |
| Modifications de données                     | interrupteur visible, figé sur « désactivées »                                                | la SafetyPolicy n'est jamais assouplie depuis le SDK                     |
| Chemins de déconnexion                       | toujours ajoutés aux chemins exclus, même retirés du brouillon                                | défauts du moteur conservés                                              |
| Analyse statique                             | Angular avec un dossier sous `--allow-source-root` seulement                                  | le serveur ne lit pas un dossier arbitraire                              |
| Suivi                                        | Server-Sent Events, numérotés, rejouables (`after`)                                           | un rechargement ne perd rien ; pas de dépendance WebSocket               |
| Jeton dans le flux                           | en-tête, via `fetch` en flux (pas `EventSource`)                                              | le jeton n'apparaît jamais dans une URL                                  |
| Compteurs                                    | chacun face à son budget ; remplacés par les statistiques du moteur à la fin                  | aucun pourcentage ni durée restante inventés                             |
| « Terminé »                                  | seulement sur l'événement `completed` du moteur ; `result` et les liens répondent `409` avant | un lancement accepté n'est pas une exploration finie                     |
| Annulation                                   | statut `CANCELLED` réservé, jamais atteint ; pas de bouton                                    | le moteur ne l'offre pas                                                 |
| Rapports                                     | lien à ticket de 10 minutes, CSP `sandbox`, chemin contenu dans le dossier de l'exploration   | ouvrir un rapport sans exposer le jeton ni le disque                     |
| Explorations simultanées                     | une par défaut, file d'attente visible (`QUEUED`)                                             | Chromium et le moteur sont lourds                                        |
| Composant                                    | Web Component + Shadow DOM, sans framework, rendu par fonctions pures                         | s'intègre à toute application ; testable sans navigateur                 |
| Thème                                        | variables CSS publiques `--qa-*`, requêtes de conteneur                                       | l'hôte habille sans casser l'isolement                                   |
| Modules navigateur                           | servis par le serveur SDK (`/sdk/core`, `/sdk/ui`), compilés ou transpilés à la volée         | aucun CDN ; rien chargé d'ailleurs                                       |
| Origines                                     | refus des origines non listées ; CORS pour les seules origines listées                        | une page tierce ne pilote pas le serveur                                 |
| Extensions (recordings, graphe, assertions…) | espaces de noms réservés `{ available: false }`                                               | annoncer sans simuler                                                    |
| Publication                                  | aucune : exports `./sdk`, `./sdk/ui`, `./sdk/server` de `@qa-crawler/core`                    | rien n'est poussé sur un registre                                        |

## 4. Non-régression

Le SDK ajoute des fichiers (`src/sdk/**`, `src/cli/sdk-server-command.ts`) et une entrée de
commande ; il ne modifie ni le moteur, ni le format de projet, ni les commandes existantes. Les
suites unitaires et d'intégration existantes passent inchangées.
