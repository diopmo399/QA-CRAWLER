# SDK QA-CRAWLER : créer un projet et lancer une exploration depuis une autre application

Le SDK met l'assistant de création de projet de QA-CRAWLER dans n'importe quelle page web : la page
autonome servie par QA-CRAWLER, ou une application hôte qui l'embarque avec son propre thème. Il ne
remplace pas le moteur : il le **pilote**. Le projet écrit est un `qa-crawler.config.yaml` au format
du moteur, validé par le moteur ; l'exploration est un vrai `runMission` ; les chiffres affichés sont
ceux des événements et du résultat du moteur.

Diagnostic préalable et décisions : [AUDIT.md](./AUDIT.md). Exemple d'hôte :
[examples/sdk-host](../../examples/sdk-host/README.md).

## Les trois parties

| Import                        | Où il tourne | Rôle                                                                |
| ----------------------------- | ------------ | ------------------------------------------------------------------- |
| `@qa-crawler/core/sdk`        | navigateur   | contrats (types, statuts, événements), client HTTP, cycle de vie    |
| `@qa-crawler/core/sdk/ui`     | navigateur   | l'élément `<qa-crawler-project-wizard>` (Web Component, Shadow DOM) |
| `@qa-crawler/core/sdk/server` | Node         | le serveur local qui valide, écrit le projet et lance le moteur     |

Le navigateur ne lit jamais une variable d'environnement, un fichier ni le moteur : tout passe par le
serveur, qui seul a ces droits.

## Démarrer

```bash
qa-crawler sdk-server --workspace ./qa-projects
# QA-CRAWLER SDK sur http://127.0.0.1:4310 — jeton : …
```

Options :

| Option                      | Effet                                                                                  |
| --------------------------- | -------------------------------------------------------------------------------------- |
| `--workspace <dir>`         | dossier où chaque projet créé reçoit son sous-dossier (obligatoire)                    |
| `--host`, `--port`          | adresse d'écoute (défaut `127.0.0.1:4310`)                                             |
| `--allow-origin <origin>`   | origine d'une application hôte autorisée à appeler l'API (répétable)                   |
| `--allow-source-root <dir>` | dossier sous lequel un projet Angular peut désigner ses sources (répétable)            |
| `--token-env <NAME>`        | lire le jeton dans cette variable au lieu d'en générer un (il n'est alors pas affiché) |
| `--language fr\|en`         | langue de la page autonome et des rapports du moteur                                   |
| `--concurrency <n>`         | explorations simultanées (défaut 1 ; les suivantes attendent en file)                  |
| `--quiet`                   | n'affiche que l'adresse                                                                |

Ouvrir l'adresse affichée donne la page autonome : le jeton y est injecté par le serveur.

En code :

```ts
import { startSdkServer } from '@qa-crawler/core/sdk/server';

const sdk = await startSdkServer({
  workspace: './qa-projects',
  allowedOrigins: ['https://portal.example.test'],
});
console.log(sdk.url); // le jeton est dans sdk.token ; sdk.close() arrête tout
```

## L'assistant en cinq étapes

1. **Projet** : nom, adresse de l'application (vérifiée depuis le serveur, pas depuis le navigateur),
   type d'application (Angular, React, Vue, Salesforce Lightning — qui active le profil Lightning du
   moteur, voir `docs/SALESFORCE_LIGHTNING.md` —, autre). Angular avec un dossier de sources active l'analyse statique, seulement sous un
   `--allow-source-root`.
2. **Environnement** : Chromium (le seul navigateur du moteur), taille d'écran, langue, délais
   d'action et de navigation, connexion (aucune, formulaire, HTTP, SSO). Les identifiants sont des
   **noms de variables** `QA_*` ; le serveur dit seulement si elles sont définies.
3. **Exploration** : budgets d'écrans, d'actions, de durée, de profondeur ; hôtes et chemins exclus
   (les chemins de déconnexion du moteur restent toujours exclus) ; vérifications (accessibilité,
   console, réseau). Les modifications de données restent désactivées : le SDK ne les ouvre pas.
4. **Récapitulatif** : validation par le serveur (schéma, variables présentes, schéma du moteur, chargement
   de la mission) et le fichier exact qui sera écrit. Un problème bloquant renvoie à son étape.
5. **Exploration** : lancement, file d'attente, puis suivi en direct (écrans, actions, actions
   bloquées par la sécurité, anomalies, phases) jusqu'au résultat du moteur, puis les rapports.

Chaque compteur est affiché face à son propre budget. Il n'y a ni pourcentage global ni durée
restante : le moteur n'en calcule pas, le SDK n'en invente pas.

## Embarquer l'assistant

```html
<qa-crawler-project-wizard
  mode="embedded"
  locale="fr"
  endpoint="http://127.0.0.1:4310/api"
></qa-crawler-project-wizard>
<script type="module">
  import 'http://127.0.0.1:4310/sdk/ui/index.js';
  const wizard = document.querySelector('qa-crawler-project-wizard');
  // Le jeton vient du back-end de l'hôte, après sa propre vérification de session.
  wizard.token = (await (await fetch('/host-api/qa-crawler-token')).json()).token;
  wizard.initialValues = { project: { name: 'Portail' }, exploration: { maxStates: 30 } };
  wizard.addEventListener('qa-exploration-completed', (event) => console.log(event.detail.summary));
</script>
```

Le serveur doit avoir été lancé avec `--allow-origin <origine de l'hôte>`. Une origine non listée
reçoit `403` ; l'élément affiche alors « Serveur QA-CRAWLER injoignable ».

### Attributs et propriétés

| Nom                         | Type                       | Effet                                                                |
| --------------------------- | -------------------------- | -------------------------------------------------------------------- |
| `endpoint` (attribut)       | URL                        | base de l'API (obligatoire sauf si l'hôte fournit `client`)          |
| `mode` (attribut)           | `standalone` \| `embedded` | `embedded` : barre d'étapes compacte, sans le panneau latéral        |
| `locale` (attribut)         | `fr` \| `en`               | langue de l'interface                                                |
| `product-name`, `logo`      | texte, URL                 | nom et logo de l'en-tête (mode autonome)                             |
| `token` (propriété)         | chaîne                     | jeton du serveur ; jamais en attribut, pour ne pas finir dans le DOM |
| `client` (propriété)        | `QaCrawlerClient`          | client fourni par l'hôte (à la place d'`endpoint` + `token`)         |
| `initialValues` (propriété) | brouillon partiel          | valeurs de départ, fusionnées avec les défauts du moteur             |
| `draft` (lecture)           | `ProjectDraft`             | le brouillon courant                                                 |

### Événements DOM

Tous traversent le Shadow DOM (`composed`) et remontent (`bubbles`).

| Événement                  | `detail`                                           |
| -------------------------- | -------------------------------------------------- |
| `qa-project-created`       | `{ project }`                                      |
| `qa-exploration-started`   | `{ exploration, project }`                         |
| `qa-exploration-progress`  | `{ event, counters }` (un par événement du moteur) |
| `qa-exploration-completed` | `{ exploration, summary }`                         |
| `qa-exploration-failed`    | `{ exploration, error }`                           |
| `qa-error`                 | `{ code, message }`                                |

### Thème

Les styles vivent dans le Shadow DOM : ceux de l'hôte n'y entrent pas, ceux de l'assistant n'en
sortent pas. L'hôte agit par des variables CSS publiques posées sur l'élément :

```css
qa-crawler-project-wizard {
  --qa-color-primary: #10b981;
  --qa-color-primary-2: #059669;
  --qa-radius: 10px;
  --qa-font-family: 'Inter', system-ui, sans-serif;
}
```

Thème sombre : l'attribut `theme` vaut `light` (défaut, inchangé), `dark`, ou `auto` (suit
`prefers-color-scheme` du système). Il vaut pour les quatre composants : assistant, Flow Studio,
comparaison et Run Monitor. Les pages autonomes le prennent dans l'URL (`?theme=dark`). Le thème ne
change que les jetons `--qa-*` : une variable posée par l'hôte sur l'élément l'emporte toujours.

Accessibilité vérifiée par les tests :

- contraste WCAG AA (4,5:1) du texte, du texte secondaire, de l'accent et des statuts de la
  comparaison et du Run Monitor, dans les deux thèmes (`tests/unit/sdk-theme.test.ts`) ;
- onglets au clavier ;
- régions `role="status"` annoncées ;
- refus annoncés (`role="alert"`) ;
- mouvement réduit respecté (`prefers-reduced-motion`).

Aucun audit automatique complet (de type axe) n'est lancé : l'outil n'est pas une dépendance du dépôt.

Variables : `--qa-color-primary`, `--qa-color-primary-2`, `--qa-color-background`,
`--qa-color-surface`, `--qa-color-surface-2`, `--qa-color-panel`, `--qa-color-panel-2`,
`--qa-color-text`, `--qa-color-muted`, `--qa-color-faint`, `--qa-color-border`,
`--qa-color-border-strong`, `--qa-color-success`, `--qa-color-success-soft`, `--qa-color-warning`,
`--qa-color-warning-soft`, `--qa-color-danger`, `--qa-color-danger-soft`, `--qa-radius`,
`--qa-font-family`, `--qa-font-family-heading`, `--qa-font-family-mono`. La mise en page suit la
largeur de l'élément (requêtes de conteneur), pas celle de la fenêtre.

## Le client

```ts
import { createQaCrawler, QaCrawlerError } from '@qa-crawler/core/sdk';

const qa = createQaCrawler({ endpoint: 'http://127.0.0.1:4310/api', token });
const report = await qa.projects.validate(draft); // { ok, blocking, warnings, environment, projectFile }
const project = await qa.projects.create(draft); // 422 DRAFT_INVALID si un problème bloque
const started = await qa.explorations.start(project.id); // 202, statut QUEUED ou RUNNING
const subscription = qa.explorations.subscribe(started.id, (event) => render(event));
await subscription.done; // le flux se ferme après COMPLETED ou FAILED
const summary = await qa.explorations.result(started.id); // 409 tant que ce n'est pas fini
const link = await qa.explorations.reportLink(started.id); // lien valable 10 minutes
```

| Méthode                                   | Route                                           |
| ----------------------------------------- | ----------------------------------------------- |
| `capabilities()`                          | `GET /api/capabilities`                         |
| `connect()`                               | `GET /api/capabilities` + version du contrat    |
| `checks.url(url)`                         | `POST /api/checks/url`                          |
| `checks.env(names)`                       | `POST /api/checks/env` (20 noms `QA_*` au plus) |
| `projects.validate(draft)`                | `POST /api/projects/validate`                   |
| `projects.create(draft)`                  | `POST /api/projects`                            |
| `projects.get(id)`                        | `GET /api/projects/:id`                         |
| `explorations.start(projectId)`           | `POST /api/projects/:id/explorations`           |
| `explorations.status(id)`                 | `GET /api/explorations/:id`                     |
| `explorations.result(id)`                 | `GET /api/explorations/:id/result`              |
| `explorations.subscribe(id, cb, {after})` | `GET /api/explorations/:id/events` (SSE)        |
| `explorations.reportLink(id)`             | `POST /api/explorations/:id/report-links`       |
| `explorations.cancel(id)`                 | `POST /api/explorations/:id/cancel`             |

Une erreur est une `QaCrawlerError { status, code, message, issues }` ; un serveur absent donne
`status: 0, code: 'UNREACHABLE'`. `subscribe` lit le flux avec `fetch` (le jeton part en en-tête,
jamais dans l'URL) et reprend après un numéro d'événement (`after`).

**Coupures** : si le flux se ferme avant l'événement de fin (réseau, serveur redémarré, réponse
5xx), le client le rouvre lui-même après le dernier `seq` reçu — 3 tentatives par défaut, à 1 s,
2 s puis 4 s (`reconnect: { retries, delayMs }`, `retries: 0` pour s'en passer ; `onReconnect`
prévient). Un événement déjà reçu n'est jamais transmis deux fois, même si un relais le renvoie.
Un refus (4xx : jeton, origine, exploration inconnue) n'est pas réessayé. Quand les tentatives sont
épuisées, `onError` reçoit la dernière erreur, ou `STREAM_CLOSED` si le flux s'est simplement fermé.

**Version du contrat** : `connect()` rend les capacités et refuse (`API_VERSION_MISMATCH`) un
serveur qui ne parle pas la version du client ; l'assistant l'utilise au chargement.

La CLI de la plateforme (`qa-crawler project|env|scenario|run|overview|doctor`) appelle ce même
client : voir [CLI.md](CLI.md).

### Dans un programme Node : `openQaCrawler`

Pour un script, une CI ou un outil interne, la façade démarre le service dans le programme même
(127.0.0.1, port libre, jeton aléatoire jamais affiché) et rend le client. C'est le même contrat
HTTP que l'assistant et le Dashboard : aucun second moteur.

```js
import { openQaCrawler } from '@qa-crawler/core/sdk/server';

const qa = await openQaCrawler({ workspace: './qa-workspace', language: 'fr' });
try {
  const [project] = await qa.client.projects.list();
  const started = await qa.client.executions.start(project.id);
  // … suivre par qa.client.explorations.subscribe, puis lire qa.client.executions.get
} finally {
  await qa.close(); // annule ce qui tourne encore (rapport écrit), puis ferme le service
}
```

Les options sont celles de `startSdkServer`, sans hôte, port, jeton ni origines : le service n'est
joignable que depuis la machine. L'exemple exécutable
[`examples/sdk-node/replay.mjs`](../../examples/sdk-node/README.md) rejoue un projet dans un
environnement, suit les étapes, et sort avec le code de son verdict (`0`, `1`, `130` annulé par
Ctrl+C).

## Enregistrements, assertions, groupes, génération, graphe, rapports

Au-delà de la création de projet et de l'exploration, le client donne accès à ce que la fenêtre du
recorder et les rapports font déjà dans QA-CRAWLER. Chaque appel passe par le module du moteur qui le
réalise (`runRecording`, `decideProposal`, `applyGroupCommand`, `planGeneration`, `flow-graph.json`) :
une seule implémentation pour la CLI, la fenêtre du recorder et le SDK
(`src/recording/recording-workspace.ts`).

```ts
// 1. Un humain joue le parcours dans le Chromium ouvert sur la machine du serveur.
await qa.recordings.start(project.id, { name: 'Ouvrir un utilisateur', startPath: '/users' });
qa.recordings.subscribe(project.id, 'ouvrir-un-utilisateur', (event) => show(event));
// … il l'arrête depuis la barre d'enregistrement, ou l'hôte l'arrête :
await qa.recordings.stop(project.id, 'ouvrir-un-utilisateur');

// 2. Le flow construit par le moteur, ses propositions d'assertions, ses groupes métier.
const flow = await qa.recordings.flow(project.id, 'ouvrir-un-utilisateur'); // étapes, YAML, .feature
const proposals = await qa.assertions.list(project.id, 'ouvrir-un-utilisateur');
await qa.assertions.decide(project.id, 'ouvrir-un-utilisateur', proposals[0].id, { decision: 'ACCEPT' });
await qa.groups.edit(project.id, 'ouvrir-un-utilisateur', {
  op: 'create',
  name: 'Aller à la liste',
  stepIds,
});

// 3. Les tests générés, validés statiquement avec les outils disponibles (jamais « exécutés » ici).
const { files } = await qa.generation.run(project.id, 'ouvrir-un-utilisateur', {
  formats: ['yaml', 'gherkin', 'playwright', 'java'],
});

// 4. Le graphe d'écrans, la liste des rapports, un lien vers un rapport HTML.
const graph = await qa.graph.exploration(exploration.id); // ou qa.graph.of(projectId, 'recording', nom)
const reports = await qa.reports.list(project.id);
const link = await qa.reports.link(project.id, 'recording', 'ouvrir-un-utilisateur');
```

| Méthode                                          | Route                                                            |
| ------------------------------------------------ | ---------------------------------------------------------------- |
| `recordings.start(projectId, input)`             | `POST /api/projects/:id/recordings` (202)                        |
| `recordings.list(projectId)`                     | `GET /api/projects/:id/recordings`                               |
| `recordings.get(projectId, name)`                | `GET /api/projects/:id/recordings/:name`                         |
| `recordings.stop(projectId, name)`               | `POST /api/projects/:id/recordings/:name/stop`                   |
| `recordings.subscribe(projectId, name, cb)`      | `GET /api/projects/:id/recordings/:name/events` (SSE)            |
| `recordings.flow(projectId, name)`               | `GET /api/projects/:id/recordings/:name/flow`                    |
| `recordings.studio(projectId, name)`             | `GET /api/projects/:id/recordings/:name/studio`                  |
| `recordings.pause/resume/undo(projectId, name)`  | `POST /api/projects/:id/recordings/:name/{pause,resume,undo}`    |
| `recordings.checkpoint(projectId, name, label)`  | `POST /api/projects/:id/recordings/:name/checkpoint`             |
| `recordings.resolve/ignore(projectId, name, …)`  | `POST /api/projects/:id/recordings/:name/{resolve,ignore}`       |
| `recordings.removeStep(projectId, name, step)`   | `POST /api/projects/:id/recordings/:name/steps/remove`           |
| `recordings.replay(projectId, name)`             | `POST /api/projects/:id/recordings/:name/replay` (202)           |
| `recordings.replayStatus(projectId, name)`       | `GET /api/projects/:id/recordings/:name/replay`                  |
| `groups.proposals/acceptProposals(…)`            | `GET`/`POST /api/projects/:id/recordings/:name/groups/proposals` |
| `groups.checks/addCheck(…)`                      | `GET`/`POST /api/projects/:id/recordings/:name/groups/checks`    |
| `recordings.intents/reviewIntent(…)`             | `GET`/`POST /api/projects/:id/recordings/:name/intents`          |
| `recordings.rowSource/editRow(…)`                | `GET`/`POST /api/projects/:id/recordings/:name/steps/row`        |
| `recordings.restoreTarget(…)`                    | `POST /api/projects/:id/recordings/:name/steps/restore`          |
| `corrections.start/get(projectId, name, …)`      | `POST`/`GET /api/projects/:id/recordings/:name/correction`       |
| `corrections.pick/apply/resume/close(…)`         | `POST /api/projects/:id/recordings/:name/correction/<action>`    |
| `library.list/add(projectId, …)`                 | `GET`/`POST /api/projects/:id/library`                           |
| `library.remove(projectId, name)`                | `POST /api/projects/:id/library/:name/remove`                    |
| `library.preview(projectId, scenario)`           | `GET /api/projects/:id/library/preview?scenario=…`               |
| `library.declareContract(projectId, name, c)`    | `PUT /api/projects/:id/library/:name/contract`                   |
| `library.validateVersion(projectId, name)`       | `POST /api/projects/:id/library/:name/version`                   |
| `library.drift(projectId)`                       | `GET /api/projects/:id/library/drift`                            |
| `scenarios.checkComposition(projectId, input)`   | `POST /api/projects/:id/scenarios/compose/check` (`VIEW`)        |
| `scenarios.compose(projectId, input)`            | `POST /api/projects/:id/scenarios/compose` (201)                 |
| `scenarios.insert(projectId, scenario, input)`   | `POST /api/projects/:id/scenarios/:name/insert`                  |
| `scenarios.acceptBlocks(projectId, scenario)`    | `POST /api/projects/:id/scenarios/:name/accept`                  |
| `assertions.list(projectId, name)`               | `GET /api/projects/:id/recordings/:name/assertions`              |
| `data.get(projectId, name)`                      | `GET /api/projects/:id/recordings/:name/data`                    |
| `data.bind(projectId, name, input)`              | `POST /api/projects/:id/recordings/:name/data/bindings`          |
| `assertions.decide(projectId, name, id, input)`  | `POST /api/projects/:id/recordings/:name/assertions/:proposalId` |
| `groups.list(projectId, name)`                   | `GET /api/projects/:id/recordings/:name/groups`                  |
| `groups.edit(projectId, name, command)`          | `POST /api/projects/:id/recordings/:name/groups`                 |
| `generation.run(projectId, name, input)`         | `POST /api/projects/:id/recordings/:name/generation`             |
| `generation.view(projectId, name)`               | `GET /api/projects/:id/recordings/:name/generation`              |
| `generation.execute(projectId, name, input)`     | `POST /api/projects/:id/recordings/:name/test-runs` (202)        |
| `generation.runOf(projectId, name, runId)`       | `GET /api/projects/:id/recordings/:name/test-runs/:runId`        |
| `generation.cancel(projectId, name, runId)`      | `POST …/test-runs/:runId/cancel` (409 une fois terminée)         |
| `generation.reportLink(projectId, name, runId)`  | `POST …/test-runs/:runId/report-links` (rejeu YAML, Gherkin)     |
| `generation.editFile(projectId, name, input)`    | `PUT /api/projects/:id/recordings/:name/generation/file`         |
| `generation.restoreFile(projectId, name, input)` | `POST /api/projects/:id/recordings/:name/generation/restore`     |
| `graph.exploration(id)`                          | `GET /api/explorations/:id/graph` (409 avant la fin)             |
| `graph.of(projectId, kind, name)`                | `GET /api/projects/:id/reports/:kind/:name/graph`                |
| `reports.list(projectId)`                        | `GET /api/projects/:id/reports`                                  |
| `reports.link(projectId, kind, name)`            | `POST /api/projects/:id/reports/:kind/:name/links`               |

**Enregistrement** : `RECORDING → PROCESSING → COMPLETED | FAILED` ; `STORED` désigne un
enregistrement lu sur disque (écrit par la CLI, ou avant le démarrage du serveur). Le nom donné
devient le dossier du moteur (`recordings/<nom>/`, en minuscules, les chiffres remplacés par `#`).
Le flux relaie les événements du recorder (sauf les traces brutes, une par événement clavier ou
souris), les phases après l'arrêt, puis le résumé : étapes, raison de l'arrêt, rejeu de validation
(si demandé avec `validate: true`), propositions, groupes, fichiers.

Pendant l'enregistrement, le flux porte aussi la **timeline** (`type: 'timeline'`) : les gestes en
phrases, leur statut, les éléments candidats d'une cible ambiguë, la pause, les vérifications posées.
Seul son dernier état est gardé : un abonné qui arrive le reçoit, jamais tout l'historique. Les
commandes de la barre d'enregistrement (`pause`, `resume`, `undo`, `checkpoint`, `resolve`,
`ignore`) demandent le droit `RUN` et ne valent qu'en `RECORDING` (409 sinon).

Après l'arrêt, la revue se fait sur l'enregistrement écrit, comme dans la fenêtre du recorder :
retirer une étape d'action (ses vérifications partent avec elle ; une vérification seule se refuse
par sa proposition), créer les groupes proposés d'après les étapes métier (jamais quand des groupes
existent), ajouter la vérification d'un groupe, et lancer le **rejeu de validation**. Le rejeu tourne
sans fenêtre sur la machine du serveur, avec la mission du projet et sa politique de sécurité ; un
seul à la fois par enregistrement ; `replayStatus` donne sa progression puis son résultat
(`REPLAY_CONFIRMED` ou `REPLAY_FAILED`, statut du dry run, raison) et le dernier rejeu écrit sur
disque (`last`, `stale` quand le flow a changé depuis).

**Correction d'une cible** (`corrections`) : comme dans la fenêtre du recorder, le moteur de rejeu suit
le même chemin (étapes 1 à N-1) dans un navigateur **visible sur la machine du serveur** ; la page reste
tenue devant l'étape et la personne y clique l'élément voulu (mode sélection : le clic n'atteint pas
l'application, Échap annule). `get` suit la session : `REPLAYING`, `PICKING`, `HELD` (rien désigné),
`PICKED` (la proposition : cible actuelle et nouvelle, ordre d'essai, ambiguïté, façons de retrouver une
ligne de tableau), `APPLIED`, `RESUMING`, `RESUMED`, `UNREACHABLE` (le chemin s'est arrêté avant
l'étape) ou `FAILED`. Rien n'est écrit avant `apply` ; `resume` reprend le rejeu à l'étape corrigée
dans la même session. Une session à la fois (et pas pendant un enregistrement) ; une session inactive
se ferme au bout de 10 minutes. Ouvrir et reprendre demandent `RUN` (le parcours est rejoué), valider
demande `DECIDE`. Une ligne de tableau se redéfinit aussi sans navigateur (`editRow`), à partir des
cellules enregistrées ; une nouvelle donnée n'y est possible que si l'enregistrement a un jeu de test.

**Bibliothèque de scénarios** (`library`, `scenarios.compose`, `scenarios.insert`) : un bloc est un
flow `reusable: true`, jamais exécuté seul, que d'autres scénarios rejouent par une étape
`run: <bloc>` (le moteur recopie ses étapes à cet endroit). Un bloc vient d'un scénario
(`from: 'scenario'`) ou d'un groupe métier d'un enregistrement (`from: 'recording'`, `groupId`) ; ses
étapes et ses données de test sont recopiées sous `<flows>/library/<bloc>/`, son origine notée dans
`sdk-library.json`. `compose` crée un scénario fait de blocs (`<flows>/composed/<nom>/`) ; `insert`
ajoute `run: <bloc>` au début ou à la fin d'un scénario. Les données des blocs rejoignent le jeu du
scénario ; une donnée définie autrement des deux côtés est refusée (409), jamais écrasée. Un bloc
rejoué par un scénario ne se retire pas (409, `details` nomme les scénarios) et ne se lance pas seul
(422 `REUSABLE_BLOCK`). Quand on rejoue des scénarios choisis, le moteur charge toujours les blocs.
Écrire demande `PUBLISH` ; vérifier un parcours, `VIEW`.

- **Contrat** : sans déclaration, il est dérivé du contenu (sorties : les clés que le bloc saisit à
  partir de son propre jeu ; entrées obligatoires : celles qu'il saisit ou cite sans les définir).
  `declareContract` déclare entrées (obligatoires ou facultatives), sorties, préconditions et
  postconditions ; un contrat que le contenu contredit rend le bloc `INVALID`.
- **Vérification** (`checkComposition`, rien n'est écrit ni exécuté) : ordre, étapes, dépendances (une
  sortie consommée par un bloc suivant), entrées manquantes, entrée produite trop tard, conflits de
  données (valeur fixe face à une valeur générée au rejeu comprise), données partagées à l'identique,
  données résolues au rejeu, erreurs de structure, avertissements. `compose` et `insert` la refont
  et refusent (409 pour un conflit, 422 sinon) avec chaque raison dans `details`.
- **Écritures** : une opération à la fois par projet ; ses fichiers sont écrits ensemble ou pas du tout.
  `insert` accepte `revision` (celle de `ScenarioView`) : un scénario modifié depuis sa lecture → 409.
- **Versions** : `sdk-library.json` (version 2) garde pour chaque bloc un identifiant stable, sa version
  validée, l'empreinte de son contenu, l'historique, l'origine et le contrat ; pour chaque parcours
  composé (ou bloc inséré), la version de chaque bloc rejoué. Un bloc dont le fichier change devient
  `CHANGED` ; `validateVersion` en fait la version suivante. Un parcours suivi dont un bloc a changé
  n'est pas rejoué (`executions.start` → 409 `BLOCK_VERSION_CHANGED`) tant que `acceptBlocks` ne l'a
  pas vérifié et accepté. Le format de `run:` ne change pas ; l'ancien `sdk-library.json` (origines
  seules) est repris : version 1, historique « repris ».

**Intentions** (`intents`) : l'intention que l'analyse prête à chaque action (créer, rechercher,
ouvrir…). Confirmer, corriger (avec une raison) ou réinitialiser ajoute une décision au registre
(`human-review.json`) ; ni l'action, ni le flow, ni le rejeu ne changent. La mémoire de connaissance
de la mission n'apprend pas ces décisions depuis le SDK (seule la fenêtre du recorder le fait).

Règles :

- **un enregistrement à la fois** (un humain, un navigateur) : un second démarrage répond `409
RECORDING_ACTIVE` ; un nom déjà pris répond `409 NAME_TAKEN` (rien n'est écrasé) ;
- le navigateur est **visible** sur la machine du serveur : l'humain doit y avoir accès ;
- le chemin de départ est un chemin de l'application (`/…`), jamais une autre adresse ;
- pendant l'enregistrement, le flow, les assertions, les groupes et la génération répondent `409
RECORDING_IN_PROGRESS` ; ensuite, les modifications d'un même enregistrement passent une par une ;
- une décision ou un groupe réécrit le flow (YAML, .feature, `recorded-flow.json`,
  `assertion-proposals.json`) avec la même règle que la revue du recorder ; un groupe qui casserait
  une dépendance de données est refusé (`422`) sauf `force` ;
- la génération écrit sous `recordings/<nom>/generated/` ; le statut de chaque fichier dit ce qui a
  été vérifié (`GENERATED`, `STATICALLY_VALIDATED`, `NOT_VALIDATED`…), jamais une exécution.

### Tests générés, exécutables

Chaque format arrive avec ce qu'il faut pour le lancer :

| Format        | Fichiers                                                            | Lancer                                              |
| ------------- | ------------------------------------------------------------------- | --------------------------------------------------- |
| Gherkin       | `<nom>.feature` + `<nom>.gherkin.mission.yaml` (+ `test-data.yaml`) | `qa-crawler --config <nom>.gherkin.mission.yaml`    |
| Playwright TS | `playwright/<nom>.spec.ts` + `playwright/playwright.config.ts`      | `npx playwright test --config playwright.config.ts` |
| Java JUnit 5  | projet Maven (`pom.xml`, tests, README)                             | `mvn test`                                          |

- **Gherkin** : les définitions de steps sont les phrases intégrées du moteur (français et
  anglais). La mission générée joue le `.feature` avec QA-CRAWLER ; le chargeur du moteur la valide
  à la génération (chaque ligne du scénario doit être une phrase connue), d'où
  `STATICALLY_VALIDATED`. Aucune définition de steps pour un exécuteur Gherkin externe n'est
  produite : QA-CRAWLER est l'exécuteur.
- **Playwright TS** : la configuration écrit un rapport JUnit XML
  (`test-results/junit.xml`) ; `@playwright/test` est à installer à côté des tests.
- Les tests générés jouent les actions comme le moteur : sans position enregistrée, la première
  correspondance d'un rôle, d'un libellé ou d'un texte (`.first()`) ; un gabarit de route
  (`/users/{id}`) se lit comme un segment quelconque.
- La génération ne lance rien : ses fichiers gardent leur statut de génération (`GENERATED`,
  `STATICALLY_VALIDATED`, `NOT_VALIDATED`).

### Exécuter les tests générés

`generation.execute(projectId, name, { format })` joue pour de vrai les fichiers d'un format décrits
par `generation.json`, sur une copie (`recordings/<nom>/test-runs/<id>/`) : une nouvelle génération
pendant l'exécution ne change pas ce qui est joué.

| Format        | Outil                                                       | Résultats lus                                | Droits                 |
| ------------- | ----------------------------------------------------------- | -------------------------------------------- | ---------------------- |
| YAML, Gherkin | rejeu du moteur avec la mission du projet (`environmentId`) | les flows du résultat du moteur, son rapport | `RUN` (+ `RUN_WRITES`) |
| Playwright TS | Playwright Test installé à côté de QA-CRAWLER               | `test-results/junit.xml`                     | `RUN` + `RUN_WRITES`   |
| Java JUnit 5  | `mvn -q -B test`, `QA_BASE_URL` = l'origine du projet       | `target/surefire-reports/TEST-*.xml`         | `RUN` + `RUN_WRITES`   |

- Le rejeu du moteur applique la SafetyPolicy, l'authentification et l'environnement du projet ;
  `RUN_WRITES` n'est demandé que si l'environnement permet des écritures, comme pour une exécution.
- Playwright et Java pilotent l'application sans la SafetyPolicy : ils demandent toujours
  `RUN_WRITES`, n'acceptent pas d'environnement et visent l'adresse pour laquelle ils ont été
  générés.
- Statuts : `QUEUED`, `RUNNING`, puis `PASSED` ou `FAILED` d'après les cas rapportés par l'outil ;
  `ERROR` quand l'outil ne rapporte aucun cas exploitable (ou sort en erreur sans cas en échec) ;
  `CANCELLED` ; `UNAVAILABLE` quand l'outil manque. Un format dont l'outil manque est refusé (409
  `TOOL_UNAVAILABLE`) ; `generation.view` dit pour chaque format l'outil, sa version et sa présence.
- Une exécution à la fois ; les suivantes attendent en `QUEUED`. `run.json` est écrit à chaque
  changement : une exécution restée en cours à l'arrêt du serveur se relit `ERROR` (« interrupted »).
- La sortie de l'outil (12 000 derniers caractères) et les messages d'échec sont masqués et tronqués.

### Modifier un fichier généré à la main

`generation.editFile(projectId, name, { path, content, revision })` remplace le contenu d'un fichier
décrit par `generation.json` :

- **Vérifié avant d'être écrit**, avec l'outil de la génération, sur une copie des fichiers du format :
  schéma du flow, dictionnaire Gherkin et chargeur de mission, syntaxe TypeScript, `mvn test-compile`.
  Un échec, ou un autre fichier du format jusque-là vérifié qui échoue à cause de la modification :
  422 avec les raisons, rien n'est écrit. Un outil absent n'est pas un échec : le fichier est
  enregistré `NOT_VALIDATED`.
- `revision` est l'empreinte du contenu lu (`GeneratedFileView.revision`) : un fichier changé depuis
  donne 409 `FILE_CHANGED`. Un fichier montré tronqué (plus de 256 Ko) n'a pas de `revision` et ne se
  modifie pas.
- Le fichier porte `editedAt` ; la version générée est gardée (`generated-originals/`) à la première
  modification. `generation.restoreFile` la remet et retire la marque.
- Régénérer un format dont un fichier a été modifié à la main : 409 `MANUAL_EDITS` (les fichiers dans
  `details`), sauf avec `overwriteManual: true`.
- Une exécution dit les fichiers joués qui avaient été modifiés (`TestRunView.edited`).
- Droits : `DECIDE`, comme la génération ; un test Playwright ou Java demande en plus `RUN_WRITES`.
- La modification ne change pas l'enregistrement : pour une correction durable (cible, assertion,
  donnée), passer par la revue puis régénérer.

### Données de test

`data.get` rend, pour un enregistrement :

- **la lignée de chaque donnée** : l'étape qui la produit et celles qui la saisissent à nouveau ou la
  citent (`dataLineage` du moteur ; jamais un secret) ;
- **la source de chaque saisie** : `FIXED` (la valeur gardée), `GENERATED` (générée à chaque rejeu),
  `REFERENCE` (reprise d'une étape **antérieure** — les seules proposées), `SENSITIVE` (un secret, qui
  vient toujours de sa variable d'environnement et ne se lie pas) ; et si c'est un choix humain ;
- **les données citées sans origine** : ni produites avant l'étape, ni dans le jeu de données. Au
  rejeu, le moteur leur inventerait une valeur ; le SDK le dit **avant** le rejeu.

`data.bind(projectId, name, { stepId, source, variable?, generator?, value? })` applique la règle de la
fenêtre du recorder (`applyTestDataBinding`) : `test-data.yaml`, le flow et le registre des décisions
humaines (`human-review.json`) sont réécrits. Reprendre une donnée produite plus tard est refusé
(`422 REFUSED`) et rien n'est écrit.

### Verdicts des assertions

Chaque proposition d'`assertions.list` porte `verdict`, tiré d'une exécution, jamais supposé :

| Verdict         | Quand                                                                                                             |
| --------------- | ----------------------------------------------------------------------------------------------------------------- |
| `VERIFIED_PASS` | l'étape `expect` a été retrouvée et jouée au rejeu (`MATCHED`), ou le moteur d'assertions métier dit `PASS`       |
| `VERIFIED_FAIL` | vérification différente au rejeu (`ASSERTION_MISMATCH`), ou `FAIL`                                                |
| `BLOCKED`       | refusée par la politique de sécurité, ou `BLOCKED`                                                                |
| `INCONCLUSIVE`  | introuvable, ambiguë, non vérifiée, `INCONCLUSIVE` ou `UNVERIFIABLE` : rien ne prouve ni la conformité ni l'écart |
| `NOT_EXECUTED`  | hors du parcours, jamais rejouée, ou ajoutée depuis le dernier rejeu                                              |

Les sources : le dernier rejeu de validation (`replay/dry-run/…/reconciliation.json`) pour les
vérifications d'écran, `quality-verification.json` du même rejeu pour les assertions métier. `stale`
signale un flow modifié depuis. Les tables sont publiques (`verdictOfReplayOutcome`,
`verdictOfAssertionStatus`) et testées.

Dans le Flow Studio : l'onglet **Données** (lignée, alertes), l'onglet **Assertions** (verdict,
statut, preuves, Accepter / Rejeter / Désactiver / Modifier / Réinitialiser, « Voir l'étape »), et la
**source de la valeur** dans le panneau de chaque saisie.

## Flow Studio

`<qa-crawler-flow-studio>` montre le parcours d'un enregistrement en graphe et permet de l'organiser
en groupes métier. Page autonome : `http://127.0.0.1:4310/studio?project=<id>&recording=<nom>`.

```html
<qa-crawler-flow-studio
  endpoint="https://qa.example/api"
  project="prj_…"
  recording="ouvrir-un-utilisateur"
  locale="fr"
></qa-crawler-flow-studio>
<script type="module">
  import 'https://qa.example/sdk/ui/index.js';
  const studio = document.querySelector('qa-crawler-flow-studio');
  studio.token = await tokenFromMyBackend();
  studio.addEventListener('qa-studio-changed', (event) => console.log(event.detail.command));
</script>
```

| Ce qu'on voit                                      | D'où ça vient                                                                                             |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Les étapes, dans l'ordre, avec leur libellé        | le flow enregistré (`recorded-flow.json`)                                                                 |
| Les groupes métier (cadres repliables)             | les groupes du flow (`groupViews` du moteur)                                                              |
| Les données produites (◆) et citées (◇)            | `stepDependencies` du moteur : la première saisie d'une clé la produit, les citations la consomment       |
| Les liens de données (pointillés bleus)            | producteur → consommateur, d'après les mêmes rôles                                                        |
| Les citations avant production (pointillés rouges) | `dependencyViolations` du moteur                                                                          |
| Le chemin exécuté (pastille de chaque carte)       | le dernier rejeu du flow (`replay/dry-run/…/reconciliation.json`) ; « périmé » si le flow a changé depuis |

Gestes : molette ou boutons pour zoomer, glisser le fond pour déplacer la vue, « Ajuster la vue »,
recherche (texte, clé de donnée, nom de groupe ; Entrée passe au résultat suivant), clic pour choisir,
Maj + clic pour en choisir plusieurs. Clavier : flèches d'une étape à l'autre, Entrée pour choisir,
Échap pour vider la sélection, `+` `-` `0` pour le zoom.

**Ce qui modifie le parcours passe par le moteur** (`groups.edit`) : créer un groupe avec les étapes
choisies, renommer, décrire, replier, avancer / reculer une étape ou un groupe, sortir une étape d'un
groupe, supprimer un groupe (les étapes restent). Glisser une étape sur un groupe l'y place ; sur une
autre étape du même groupe, la place avant elle ; glisser un groupe au-delà d'un autre demande au
moteur de les échanger. Le moteur vérifie les dépendances de données : un refus s'affiche avec
l'étape, la donnée et une proposition (« placez d'abord … »), et **rien n'est modifié**. Déplacer une
carte ailleurs ne change que l'affichage (« Remettre les positions » l'annule).

Événements DOM (`STUDIO_EVENTS`) : `qa-studio-selection` (`{ stepIds, groupId? }`),
`qa-studio-changed` (`{ command, warnings }`), `qa-studio-refused` (`{ command, message, violations }`),
`qa-error`.

Non proposé : **jouer un groupe seul** (le panneau dit si ses entrées sont produites dans le groupe,
mais le SDK ne lance pas de rejeu partiel) ; relancer un rejeu depuis le Studio (enregistrer avec
`validate: true`).

## Run Monitor

`<qa-crawler-run-monitor exploration="exp_…">` (page autonome `/monitor?exploration=…`) suit une
exploration en direct :

- le statut et l'état du flux (connexion, en direct, reconnexion avec le numéro de tentative, flux
  terminé, flux interrompu), annoncés par une région `role="status"` ;
- les compteurs (écrans, actions, refus, anomalies, étapes de flow), qui sont des nombres
  d'événements reçus ;
- l'avancement de chaque flow imposé, avec le statut de fin donné par le moteur (« en cours » tant
  que le flow n'est pas terminé) ;
- le journal des événements, à afficher par flow, statut d'étape, type d'événement ou type
  d'anomalie.

Un flux coupé est rouvert après le dernier événement reçu (5 tentatives) et un événement déjà reçu
n'est jamais affiché deux fois. Événements DOM : `qa-monitor-connection` (`{ state, attempt }`) et
`qa-error`.

Le flux d'une exploration porte désormais les flows imposés de la mission :

- `{ type: 'flow', flow, phase: 'start' | 'end', status?, durationMs?, steps? }` ;
- `{ type: 'flow-step', flow, index, kind, label, status, durationMs, reason? }`.

Le libellé d'une étape ne porte jamais de valeur. Une saisie (`fill`) ou un choix (`select`) est
décrit par sa cible seule. Une phrase libre (`auto`, `intent`, `manual`) n'est désignée que par son
genre. La raison d'un échec n'est pas relayée pour ces étapes.

Limite : les groupes métier d'un enregistrement ne sont pas portés par les événements d'exploration.
Le suivi se fait donc par flow et par étape, pas par groupe.

## Comparaison et traçabilité des exécutions

Deux explorations d'un projet se comparent sans rien rejouer. Le SDK lit ce que le moteur a écrit dans
le dossier de chaque run : `result.json`, `quality-verification.json` et `regression-analysis.json`.

| Client                                   | Route                                                         |
| ---------------------------------------- | ------------------------------------------------------------- |
| `reports.compare(projectId, base, head)` | `GET /api/projects/:id/reports/compare?base=run-…&head=run-…` |
| `reports.traceability(projectId, run)`   | `GET /api/projects/:id/reports/exploration/:run/traceability` |
| `reports.regression(projectId, run)`     | `GET /api/projects/:id/reports/exploration/:run/regression`   |

- **Flow par flow** : `compareFlowRuns` du moteur, la règle de l'écart avec le run précédent du
  rapport. On obtient le statut dans chaque run, `SAME` ou `CHANGED`, et les écarts (statut, étape
  plus lente, cible changée ou réparée, étape ajoutée ou retirée…). Un flow absent d'un des deux runs
  est marqué `ONLY_BASE` ou `ONLY_HEAD`.
- **Exigence par exigence** : la couverture calculée par le moteur dans chaque run (`NOT_COVERED`,
  `COVERED_NOT_EXECUTED`, `VERIFIED_PASS`, `VERIFIED_FAIL`, `BLOCKED`, `INCONCLUSIVE`,
  `STALE_EVIDENCE`). Sans traçabilité, la liste est vide et `traceability.base/head` vaut `false` :
  rien n'est déduit.
- **Traçabilité d'un run** : exigences, règles, assertions et preuves, verdict métier, et ce que la
  vérification ne peut pas affirmer. `404` quand la mission ne déclare pas d'exigence.
- **Régression** : l'analyse du moteur par rapport à son historique (`NEW_REGRESSION`,
  `REGRESSION_FIXED`…), servie telle quelle.

`<qa-crawler-run-compare>` (page autonome `/runs?project=…&base=…&head=…`) montre la comparaison et
la traçabilité de l'exécution comparée.

- Attributs : `endpoint`, `project`, `base`, `head` (par défaut les deux plus récents), `locale`.
- Propriétés : `token`, `client`.
- Événements : `qa-runs-selection` (`{ base, head }`) et `qa-error`.
- Onglets au clavier (flèches gauche et droite), écarts d'un flow dépliables, liste des exigences
  par statut de couverture.
- Les compteurs sont des nombres : aucun pourcentage n'est affiché.

## Plateforme : projets, environnements, scénarios, exécutions, vue d'ensemble

Le SDK central de la plateforme (audit : [PLATFORM-AUDIT.md](PLATFORM-AUDIT.md)). Tout est lu ou
écrit dans le dossier du projet (`<workspace>/<id>/`), et chaque exécution est une mission du moteur.

| Client                                                        | Route                                               |
| ------------------------------------------------------------- | --------------------------------------------------- |
| `projects.list({ archived? })`                                | `GET /api/projects[?archived=true]`                 |
| `projects.detail(id)`                                         | `GET /api/projects/:id/detail`                      |
| `projects.update(id, draft)`                                  | `POST /api/projects/:id/config`                     |
| `projects.duplicate(id, { name })`                            | `POST /api/projects/:id/duplicate`                  |
| `projects.archive(id)`, `projects.restore(id)`                | `POST /api/projects/:id/archive`, `…/restore`       |
| `environments.list(projectId)`                                | `GET /api/projects/:id/environments`                |
| `environments.check(projectId, input, { reach? })`            | `POST /api/projects/:id/environments/check`         |
| `environments.create(projectId, input)`                       | `POST /api/projects/:id/environments`               |
| `environments.update(projectId, envId, input)`                | `POST /api/projects/:id/environments/:envId`        |
| `environments.remove(projectId, envId, { confirm: true })`    | `POST /api/projects/:id/environments/:envId/remove` |
| `scenarios.list(projectId)`                                   | `GET /api/projects/:id/scenarios`                   |
| `scenarios.promote(projectId, recording)`                     | `POST /api/projects/:id/scenarios`                  |
| `scenarios.history(projectId, { limit? })`                    | `GET /api/projects/:id/scenarios/history[?limit=]`  |
| `executions.start(projectId, { scenarios?, environmentId? })` | `POST /api/projects/:id/executions`                 |
| `executions.list(projectId)`                                  | `GET /api/projects/:id/executions`                  |
| `executions.get(projectId, run)`                              | `GET /api/projects/:id/executions/:run`             |
| `overview.get({ days? })`                                     | `GET /api/overview[?days=30]`                       |

`explorations.start(projectId)` accepte aussi `{ environmentId }`.

`scenarios.history` lit le statut de chaque scénario dans les derniers runs (`result.json`, 10 par
défaut, 50 au plus), du plus récent au plus ancien. Il compte les réussites, les échecs et les
**bascules** : un passage de réussi à échoué, ou l'inverse, entre deux runs consécutifs. Le Dashboard
marque un scénario **instable** à partir de deux bascules.

**Projets.**

- **Modifier** : le brouillon est revalidé par le moteur, comme à la création, puis
  `qa-crawler.config.yaml` est réécrit. L'identifiant et la date de création restent.
- **Dupliquer** : copie la configuration, les environnements (de nouveaux identifiants, des noms de
  variables seulement) et les scénarios. Ne copie jamais les exécutions ni les enregistrements.
- **Archiver** : rien n'est supprimé. Un projet archivé n'apparaît dans la liste qu'avec
  `archived: true`, et refuse toute exécution, exploration ou modification (`409 PROJECT_ARCHIVED`)
  jusqu'à sa restauration.

**Environnements** (`DEVELOPMENT`, `TEST`, `CERTIFICATION`, `PREPRODUCTION`, `OTHER`). Chacun porte :

- une URL de base ;
- des domaines autorisés (`safety.allowedHosts` du moteur), qui doivent contenir l'hôte de la cible ;
- des variables non secrètes, passées au moteur comme variables d'environnement d'exécution (`${env:NOM}`) ;
  un nom qui ressemble à un secret y est refusé ;
- des noms de secrets (`secretEnv`), lus sur le serveur et jamais renvoyés ;
- des délais et limites ;
- les écritures permises (`mutations: { enabled, maxPerRun }`). Absent : la mission du projet garde
  son réglage. Les actions `DANGEROUS` restent toujours bloquées.

`check` vérifie tout cela sans rien écrire, plus l'accès à l'URL avec `reach: true`. Supprimer un
environnement exige `{ confirm: true }`.

**Scénarios** : les flows du dossier `qa-crawler/flows` du projet (YAML nommés, fichiers
`.feature`). `promote` copie le flow YAML d'un enregistrement et son `test-data.yaml` dans ce
dossier, comme « Sauvegarder » dans la fenêtre du recorder.

**Exécutions** : `executions.start` construit la mission `replay` du projet (`loadProjectMission`)
avec les scénarios choisis, applique l'environnement, puis lance `runMission`. Le suivi passe par la
même mécanique que les explorations : `explorations.status`, `explorations.subscribe` (événements
`flow` et `flow-step`) et le Run Monitor. Le snapshot porte `kind: 'REPLAY'` et `run`. Ensuite,
`executions.get` lit le run sur disque :

- le verdict (`PASSED` quand tous les flows sont `PASSED`, `FAILED` sinon, `NO_FLOW`, `INCOMPLETE`) ;
- les flows et leurs étapes, avec des libellés sans valeur saisie ;
- la première divergence ;
- les assertions métier et leur statut, sans jamais de succès par défaut ;
- les clés de données de test, jamais leurs valeurs ;
- les captures, en chemins relatifs servis par un lien de rapport ;
- les anomalies et les rapports.

Un run sans fiche du SDK (lancé par la CLI) est classé `REPLAY` s'il n'a joué que des flows.

**Vue d'ensemble** : projets actifs et archivés, scénarios, enregistrements, exécutions de la
période par type, anomalies par gravité, dix dernières exécutions, tendance par jour, et alertes :

- dernière exécution en échec ;
- anomalies critiques ;
- secret d'un environnement absent du serveur.

Le **taux de réussite** dit son périmètre dans `replays.definition` : les exécutions de rejeu
terminées dans la période (le moteur a écrit leur résultat), réussies quand leur verdict est
`PASSED`. Les explorations n'y entrent pas. Sans rejeu terminé, `passRate` est absent : jamais `0`
ni `100` par défaut.

## Exigences

Le référentiel d'exigences d'un projet (`<projet>/requirements/`, voir
[docs/requirements](../requirements/README.md)) est servi par l'API. Rien n'y entre sans décision
humaine : un import produit des **candidats** ; une personne décide ; la publication écrit le
référentiel.

| Client                                                                | Route                                                                            |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `requirements.get(projectId)`                                         | `GET /api/projects/:id/requirements` (éléments, liens, candidats en attente)     |
| `requirements.connectors(projectId)`                                  | `GET …/requirements/connectors` (formats, taille maximale, capacités, limites)   |
| `requirements.profiles(projectId)`                                    | `GET …/requirements/profiles`                                                    |
| `requirements.imports(projectId)`                                     | `GET …/requirements/imports` (lots résumés, du plus récent au plus ancien)       |
| `requirements.importBatch(projectId, batchId)`                        | `GET …/requirements/imports/:batch`                                              |
| `requirements.importFile(projectId, { connector, name, data })`       | `POST …/requirements/imports/file?connector=WORD\|EXCEL\|PDF&name=…[&profile=…]` |
| `requirements.importConfluence(projectId, input)`                     | `POST …/requirements/imports`                                                    |
| `requirements.decide(projectId, batchId, decisions)`                  | `POST …/requirements/imports/:batch/decisions`                                   |
| `requirements.publish(projectId, batchId, { acknowledgePartial? })`   | `POST …/requirements/imports/:batch/publish`                                     |
| `requirements.matrix(projectId)`, `requirements.matrixCsv(projectId)` | `GET …/requirements/matrix[?format=csv]`                                         |
| `requirements.addLink(projectId, input)`                              | `POST …/requirements/links`                                                      |
| `requirements.decideLink(projectId, linkId, 'CONFIRM'\|'REJECT')`     | `POST …/requirements/links/:link`                                                |
| `requirements.indicators(projectId, { days? })`                       | `GET …/requirements/indicators[?days=]`                                          |
| `trends.get({ weeks?, projectId? })`                                  | `GET /api/trends[?weeks=8&projectId=]`                                           |

- **Fichiers** (Word, Excel, PDF) : le contenu est envoyé tel quel (`application/octet-stream`),
  borné à la taille maximale du connecteur (25 Mo) **avant** d'être lu en entier. Il est lu en
  mémoire, jamais écrit sur le disque.
- **Confluence** : l'entrée donne l'adresse du site, la page, la variante et les **noms** des
  variables du jeton et du courriel. Le serveur refuse un nom qu'il ne lit pas (`QA_*` par défaut,
  `ENV_NAME_REFUSED`). Une variable absente fait échouer l'import (`FAILED`, problème
  `AUTHENTICATION`), sans requête vers Confluence.
- **Décisions** : `ACCEPT` (avec `kind` pour un candidat non classé), `REJECT`, `MERGE` (avec
  `mergeInto`). Un conflit d'identifiant venu d'une autre source ne s'accepte pas : il se fusionne
  ou se refuse (`409 CONFLICT_REQUIRES_MERGE`). L'auteur n'est pas enregistré : un `by` envoyé est
  ignoré tant que l'identité des personnes n'est pas définie.
- **Publication** : une lecture partielle n'est publiée qu'avec `acknowledgePartial: true`
  (`409 PARTIAL_NOT_ACKNOWLEDGED` sinon).
- **Liens** : un lien ajouté à la main est confirmé et demande une justification
  (`422 INVALID_DECISION` sinon). Un lien rejeté n'est jamais réactivé par une proposition
  automatique.
- **CSV** : chaque cellule est entre guillemets ; une cellule qui commence par `=`, `+`, `-` ou `@`
  est préfixée d'une apostrophe, pour qu'un tableur ne la lise jamais comme une formule.
- **Projet archivé** : toute écriture est refusée (`409 PROJECT_ARCHIVED`) ; la lecture reste
  possible.

**Indicateurs.** Chaque valeur est rendue avec son numérateur et son dénominateur ; sans
dénominateur, aucune valeur.

| Indicateur       | Formule                                                                                       |
| ---------------- | --------------------------------------------------------------------------------------------- |
| `coverage`       | éléments avec au moins un lien `TESTED_BY` ou `VERIFIED_BY` confirmé ÷ éléments publiés       |
| `replays`        | rejeux dont chaque flow est `PASSED` ÷ rejeux terminés avec un verdict, dans la période       |
| `links`          | liens `CONFIRMED` ÷ liens non rejetés                                                         |
| `gaps`           | éléments sans lien d'implémentation, sans lien de test ; liens périmés ; candidats en attente |
| `recentEvidence` | toujours `available: false` : il demande la corrélation avec les runs (phase 5)               |

**Tendances** : par semaine ISO (lundi, UTC), sur un projet ou sur tous les projets actifs. Elles
donnent :

- le taux de réussite des rejeux (même formule) ;
- les anomalies par gravité ;
- la durée médiane d'un rejeu terminé ;
- la couverture à la fin de chaque semaine. Elle est recalculée en rejouant les décisions de
  chaque lien de test, et elle est absente avant la première publication ;
- les scénarios qui ont basculé sur leurs 10 derniers runs.

Une semaine sans donnée n'a pas de valeur.

## Accès : jetons nominatifs, rôles, journal

Par défaut (`access: 'single'`), un seul jeton de service ouvre toute l'API, et les pages servies le
portent. Avec `access: 'named'` (`qa-crawler sdk-server --access named`), chaque personne ou robot
a son propre jeton, un rôle, et ses actions sont journalisées. Le jeton du service reste
administrateur : c'est par lui qu'on crée les premiers membres.

| Droit                                                          | Lecteur | Analyste | Pilote QA | Administrateur |
| -------------------------------------------------------------- | :-----: | :------: | :-------: | :------------: |
| `VIEW` : voir                                                  |    ✓    |    ✓     |     ✓     |       ✓        |
| `RUN` : rejeu ou exploration en lecture seule                  |    —    |    ✓     |     ✓     |       ✓        |
| `RUN_WRITES` : lancer avec écritures permises                  |    —    |    —     |     ✓     |       ✓        |
| `DECIDE` : décider les candidats d'un import                   |    —    |    ✓     |     ✓     |       ✓        |
| `PUBLISH` : publier, confirmer un lien, promouvoir un scénario |    —    |    —     |     ✓     |       ✓        |
| `MANAGE_ENVIRONMENTS` : environnements et noms de secrets      |    —    |    —     |     —     |       ✓        |
| `MANAGE_PROJECTS` : créer, modifier, archiver un projet        |    —    |    —     |     —     |       ✓        |
| `MANAGE_ACCESS` : membres, jetons, journal                     |    —    |    —     |     —     |       ✓        |

| Client                                             | Route                                 |
| -------------------------------------------------- | ------------------------------------- |
| `access.me({ projectId? })`                        | `GET /api/access/me[?projectId=]`     |
| `access.members()`                                 | `GET /api/access/members`             |
| `access.createMember({ name, role })`              | `POST /api/access/members`            |
| `access.setRole(id, role \| null, { projectId? })` | `POST /api/access/members/:id`        |
| `access.revoke(id)`                                | `POST /api/access/members/:id/revoke` |
| `access.journal({ projectId?, kind?, limit? })`    | `GET /api/access/journal`             |

- **Vérifié par le serveur** : chaque route demande un droit (une lecture demande `VIEW`, une
  écriture inconnue le droit le plus large). Un rejeu ou une exploration dans un environnement qui
  permet les écritures demande en plus `RUN_WRITES`. Un refus rend `403 FORBIDDEN`. Le Dashboard
  masque ce que le rôle ne permet pas, mais un bouton masqué ne protège rien à lui seul.
- **Rôle par projet** : un membre peut avoir dans un projet un rôle qui remplace celui de l'espace.
- **Jetons** : `qa_` suivi de 32 octets aléatoires. Seule l'empreinte SHA-256 est conservée
  (`<espace>/.qa-access/members.json`, droits `0600`). Le jeton n'est rendu qu'à la création. La
  comparaison se fait en temps constant. Une révocation vaut tout de suite ; le membre reste dans le
  journal.
- **Auteur** : la décision sur un candidat, la publication et les liens sont signés du nom lié au
  jeton, jamais de ce que l'appelant déclare. Le jeton du service ne signe rien (ce n'est personne).
- **Journal** (`<espace>/.qa-access/journal.jsonl`, ajout seulement) : chaque écriture et chaque
  refus. Une entrée dit quand, qui (et son rôle), l'action (d'après la route), le chemin sans sa
  chaîne de requête, le projet, le code et le résultat (`OK`, `DENIED`, `FAILED`). Jamais un corps
  de requête, une valeur saisie, un secret ou un jeton.
- **Pages** : en mode nominatif, aucune page ne porte de jeton. Le Dashboard demande le jeton
  personnel (champ masqué) et le garde pour l'onglet (`sessionStorage`). Les autres pages de la même
  origine (Flow Studio, Run Monitor, comparaison) le lisent de là.

## Dashboard

`<qa-crawler-dashboard>` pilote un espace de travail. La page autonome est servie par le serveur
SDK sur `/dashboard` (`?theme=dark|auto`, `?days=1|7|30`). Le composant peut aussi être embarqué
comme les autres, avec `endpoint`, `token` ou `client`, `locale` et `theme`.

| Vue              | Contenu                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vue d'ensemble   | taux de réussite des rejeux avec numérateur, dénominateur et exclusions ; exécutions, anomalies, projets et scénarios de la période ; rejeux par jour ; alertes ; exécutions récentes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Projets          | cartes (état, comptes, dernière exécution), archivés sur demande                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Projet           | onglets : Lancer (rejeu dans un environnement ou exploration de la cible), Environnements (prêt ou non : règles, secrets présents sur le serveur, URL jointe sur demande ; noms des secrets seulement), Scénarios, Exécutions, Sécurité (risques toujours bloqués, écritures, domaines, chemins jamais visités) ; archivage confirmé dans la page, restauration                                                                                                                                                                                                                                                                                                               |
| Exécutions       | les exécutions du projet choisi dans le menu                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Exécution        | suivi en direct (étapes, phase du moteur, durée ; écrans et actions pour une exploration), annulation confirmée dans la page ; puis verdict, étapes, assertions vérifiées ou en échec, clés de données, anomalies, preuves, lien vers le rapport                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Historique       | les exécutions du projet ; deux cochées sont comparées (`reports.compare`) : régressions, corrections, écarts flow par flow et étape par étape, écart de durée ; rejeu des seuls flows qui échouent maintenant                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Scénarios        | chaque scénario avec ses derniers runs (`scenarios.history`) : stable, instable (deux bascules ou plus), jamais rejoué ; rejeu d'un scénario ; enregistrements terminés pas encore promus, promotion en un clic (`scenarios.promote`)                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Enregistrements  | démarrer l'enregistrement d'un parcours (nom, chemin de départ, rejeu de validation ; un seul à la fois) ; pendant la session, la barre d'enregistrement : gestes en phrases et leur statut, pause, annulation du dernier geste, vérification posée, choix de l'élément d'une cible ambiguë, arrêt ; après l'arrêt, les phases en mots ; la liste du projet, la revue, le lien vers le Flow Studio et la promotion en scénario                                                                                                                                                                                                                                                |
| Bibliothèque     | catalogue des blocs (version, provenance, entrées et sorties, état du contrat, utilisation ; recherche, origine, contrat, utilisation, tri) ; détails (historique, contrat, scénarios dépendants, valider une nouvelle version, déclarer le contrat) ; compositeur (ordre, d'où vient chaque entrée, vérification du serveur, création) ; ajout d'un bloc dans un panneau, avec l'aperçu de la source ; depuis Scénarios, insérer un bloc, accepter la nouvelle version d'un bloc ; depuis la revue, ajouter un groupe                                                                                                                                                        |
| Tests générés    | pour un enregistrement terminé : générer les formats choisis ; par format, l'outil du serveur, sa présence et ce qu'il garantit (SafetyPolicy pour le rejeu du moteur, aucune pour Playwright et Java), le statut des fichiers, la dernière exécution ; exécuter (environnement au choix pour le rejeu du moteur), suivre en direct, annuler ; les exécutions avec leurs cas, messages d'échec, sortie de l'outil et rapport QA-CRAWLER ; le contenu de chaque fichier généré, modifiable à la main (vérifié avant d'être enregistré, Ctrl+S, marque « Modifié à la main », retour à la version générée, régénération confirmée)                                              |
| Revue            | d'un enregistrement terminé : rejeu de validation suivi étape par étape ; parcours en groupes (découpage proposé, vérifications suggérées, créer, renommer, déplacer, supprimer un groupe, cocher des étapes, monter, descendre, détacher, retirer une étape avec confirmation) ; assertions (recommandées, à décider, faibles, décidées ; une à une ou en lot) ; source de chaque saisie ; intentions (confirmer, corriger, réinitialiser) ; correction d'une cible dans le navigateur ouvert par le serveur, puis reprise du rejeu ; ligne de tableau redéfinie colonne par colonne ; restauration de la cible d'origine ; génération des tests et statut de chaque fichier |
| Environnements   | création, modification (URL, domaines, écritures et leur plafond, noms des secrets, variables, limites), vérification par le serveur avec l'URL jointe, suppression confirmée dans la page ; une ligne de variable sans `=` est refusée avant l'envoi                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Explorations     | les explorations du projet ; pour l'une d'elles : écrans, actions, actions bloquées, anomalies ; carte des écrans tirée du graphe du run (`graph.of`), anomalies par écran, actions bloquées par la politique de sécurité ; anomalies choisies par gravité                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Référentiel      | les éléments publiés, par type et par source ; pour l'un d'eux : provenance (source, section, page, feuille, cellule), historique des versions, liens avec leur justification et leur confiance, liens proposés à confirmer ou rejeter, lien ajouté à la main ; le menu compte les candidats en attente                                                                                                                                                                                                                                                                                                                                                                       |
| Traçabilité      | la matrice : règles et critères, implémentation, vérification, autres liens, chacun avec son état ; export CSV ; la corrélation automatique est dite non disponible                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Sources          | les connecteurs (formats, taille, limites) ; un import de fichier (.docx, .xlsx, .pdf) ou d'une page Confluence (noms des variables seulement), avec un profil ; l'historique des imports                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Validation       | les candidats d'un lot : type, identifiant, confiance (une classe), doublon, raisons, lieu ; accepter, refuser, fusionner (un conflit d'identifiant se fusionne ou se refuse) ; publication, avec accord explicite pour une lecture partielle ; problèmes signalés ; éléments absents de la source                                                                                                                                                                                                                                                                                                                                                                            |
| Indicateurs      | couverture par un test, taux de réussite des rejeux, liens confirmés : chacun avec sa formule, son dénominateur, ses exclusions et ses limites ; la vérification par une preuve récente est dite non disponible ; écarts à traiter                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Tendances        | par semaine : taux de réussite des rejeux (sur 0 à 100 %), anomalies, durée médiane, couverture ; scénarios les plus instables ; un projet ou tous                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Accès et journal | qui est connecté ; la matrice des rôles et des droits ; pour l'administration : membres (rôle de l'espace, rôle dans le projet choisi, jeton montré une fois à la création, révocation confirmée) et journal par nature d'action ; en mode nominatif, connexion par jeton personnel et déconnexion                                                                                                                                                                                                                                                                                                                                                                            |

Le menu range les écrans par section et porte le projet choisi (« Tous les projets » par défaut) ; il
dit la version de l'API et du moteur. Sous 960 px de large (requête de conteneur), il se replie
derrière un bouton « Menu » (`aria-expanded`, Échap le referme) ; sous 600 px tout passe sur une
colonne et les tableaux défilent dans leur cadre, sans défilement horizontal de la page. Les contrôles font 36 px de haut avec une souris, 44 px sur écran tactile ; les listes déroulantes ont une seule apparence, qui suit le thème. La page
`/dashboard` charge IBM Plex Sans depuis le serveur (aucune police externe).

Le Dashboard n'appelle que le client du SDK : chaque règle est vérifiée par le serveur. Un bouton ne
donne aucun droit que l'API refuse : archivage, écritures par environnement, annulation. Une action
qui change l'état se confirme dans la page, jamais par une boîte de dialogue du navigateur.
L'annulation n'est proposée que si le serveur l'offre (`capabilities.cancellation`).

Événements (bubbles, composed) : `qa-dashboard-navigate` `{ route }`, `qa-execution-started`
`{ projectId, exploration }`, `qa-error` `{ code, message }`. La méthode `open(route)` ouvre une vue
depuis l'hôte.

## Statuts et événements

```
QUEUED ──▶ RUNNING ──▶ COMPLETED
   │              ├──▶ FAILED
   └──────────────┴──▶ CANCELLED
```

**Annulation contrôlée** (`capabilities().cancellation === true`) : `client.explorations.cancel(id)`
(`POST /api/explorations/:id/cancel`).

- En file (`QUEUED`) : l'exploration n'est jamais lancée, `CANCELLED` tout de suite.
- En cours (`RUNNING`) : le moteur reçoit le signal (`RunOptions.signal`) et s'arrête à la prochaine
  vérification de ses limites — avant l'action ou l'étape suivante, jamais au milieu d'une action.
  Les étapes restantes sont `SKIPPED`, le navigateur est fermé, le résultat est écrit avec
  `stopReason: 'cancelled'`, puis l'exploration passe `CANCELLED`. L'événement
  `phase: 'cancellation requested'` est émis à la demande.
- Terminée : refus `409 NOT_CANCELLABLE`.

Le Dashboard offre l'annulation d'une exécution suivie en direct, après confirmation.
Une exécution annulée a le verdict `CANCELLED` : elle n'est ni une réussite ni un échec, et n'entre
ni dans le taux de réussite ni dans les alertes de la vue d'ensemble.

Chaque événement porte `seq` (croissant) et `at` (horodatage serveur) :

| `type`          | Source dans le moteur                  | Contenu                                       |
| --------------- | -------------------------------------- | --------------------------------------------- |
| `status`        | le gestionnaire d'explorations         | `status`                                      |
| `authenticated` | `ExplorationListener.onAuthenticated`  | —                                             |
| `state`         | `onState` (nouvel écran)               | `stateId`, `label`, `route`, `title`          |
| `transition`    | `onTransition`                         | `from`, `to`, `action`, `changed`             |
| `blocked`       | `onBlocked` (refus de la SafetyPolicy) | `stateId`, `action`, `reason`                 |
| `issue`         | `onIssue` (nouvelle anomalie)          | `severity`, `issueType`, `message`            |
| `phase`         | `onProgress`                           | `phase`                                       |
| `completed`     | le `RunOutcome` du moteur              | `summary` (stats, arrêt, anomalies, rapports) |
| `failed`        | l'exception du moteur                  | `error`                                       |

Les compteurs en direct (`applyEvent`) sont remplacés par les statistiques du résultat à
`completed` : l'écran final montre toujours les chiffres du moteur.

## Versionnement

- `SDK_API_VERSION` (aujourd'hui `1`) est la version du **contrat** : routes, formes des réponses,
  statuts, noms d'événements DOM. Le serveur l'annonce (`capabilities.apiVersion`), le client la
  vérifie (`connect()`).
- Dans une version de contrat, on **ajoute** seulement : une route, un champ facultatif, une
  méthode du client, une valeur de statut (annoncée dans le CHANGELOG). Rien n'est retiré, renommé
  ni ne change de sens. `tests/unit/sdk-contract.test.ts` fige ce qui est publié et échoue sinon.
- Retirer ou changer le sens d'un élément exige la version suivante du contrat ; le serveur
  servirait alors les deux versions le temps de la transition.
- Le paquet suit sa propre version (`@qa-crawler/core`), indépendante du contrat.
- Phases 1 à 7 : uniquement des ajouts ; `SDK_API_VERSION` reste `1`. Le flux d'une exploration a
  gagné deux types d'événements (`flow`, `flow-step`) : un hôte ignore les types qu'il ne connaît pas
  (l'assistant le fait), comme le prévoit cette règle.

## Sécurité

- **Jeton** : toute l'API exige `Authorization: Bearer <jeton>`, comparé en temps constant. Les
  modules navigateur (`/sdk/core/*`, `/sdk/ui/*`) sont publics : ils ne contiennent aucune donnée.
- **Origines** : une requête avec un en-tête `Origin` étranger et non listé est refusée (`403`).
  Les en-têtes CORS ne sont donnés qu'aux origines listées.
- **Écoute locale** par défaut (`127.0.0.1`).
- **Aucun secret** dans le projet, le brouillon, les journaux ni le récapitulatif : seuls les noms
  de variables `QA_*` circulent ; le serveur répond « définie » ou « non définie », jamais la valeur,
  et refuse tout autre nom. Le brouillon est validé strictement : un champ non déclaré est refusé.
- **SafetyPolicy** : la mission dérivée garde les règles du moteur (modifications désactivées,
  hôtes autorisés, chemins de déconnexion exclus). Ni l'hôte ni l'assistant ne peuvent les lever.
- **Rapports** : servis par un lien à ticket (10 minutes), sous une CSP `sandbox`, sans remonter
  au-dessus du dossier de l'exploration ou de l'enregistrement.
- **Noms et chemins** : un nom d'enregistrement ou de rapport est vérifié avant tout accès disque ;
  un chemin de départ d'enregistrement reste dans l'application.
- **Page autonome** : CSP stricte avec nonce, `frame-ancestors 'none'`.
- **Textes** : tout texte venant du serveur ou de l'utilisateur est échappé avant affichage.
- **Accès nominatifs** (option) : rôles vérifiés à chaque appel, jetons conservés par leur empreinte
  seulement, journal sans valeur ni jeton (voir « Accès »).

## Limites actuelles

- L'annulation attend la prochaine vérification des limites du moteur : une action déjà lancée
  (un clic, une attente de transition) va jusqu'à son délai. Pas de suspension ni de reprise.
- Un flow coupé par une limite de mission (annulation comprise) garde le statut de ses étapes
  jouées : il peut être `PASSED` avec des étapes `SKIPPED`. Le verdict de l'exécution, lui, est
  `CANCELLED`.
- Les environnements changent la cible, les domaines, les délais, les limites, les variables et les
  écritures. Ils ne changent pas l'authentification du projet : une page de connexion écrite en
  absolu reste celle du projet.
- Les scénarios Gherkin se choisissent par leur fichier ; un `.feature` est lu par le moteur au
  lancement, ses étapes ne sont donc pas comptées dans la liste.
- Les explorations et les flux d'enregistrement vivent en mémoire pendant la vie du serveur ; les
  projets, les enregistrements et les rapports restent sur disque, dans le dossier de travail.
- L'enregistrement suppose un écran sur la machine du serveur (un humain joue le parcours).
- L'assistant visuel couvre la création et l'exploration ; le Flow Studio, les groupes et le
  chemin exécuté d'un enregistrement ; le reste des extensions s'utilise par le client.
- Une exploration à la fois par défaut (`--concurrency`).
- Chromium seulement.
- Pas de définitions de steps pour un exécuteur Gherkin externe : le `.feature` se joue avec QA-CRAWLER.
- Tests générés : Playwright Test doit être installé à côté de QA-CRAWLER (`@playwright/test`), Maven
  et Java sur le serveur ; Maven résout ses dépendances depuis son dépôt (sans accès : `ERROR`). Le
  test Playwright vise l'adresse écrite à la génération, aucun environnement ne la change. L'écran
  génère tous les groupes ; un sous-ensemble se choisit dans la revue.
- Le Flow Studio ne rejoue pas un groupe seul.
- Le Run Monitor suit les flows et les étapes, pas les groupes métier (absents des événements
  d'exploration).
- La comparaison ne compare pas les captures d'écran de deux exécutions.
- Exigences : la corrélation automatique avec le code, les tests et les preuves n'existe pas encore
  (phase 5) ; seuls les liens issus de l'import et ceux ajoutés à la main comptent. L'auteur d'une
  décision n'est enregistré en mode nominatif seulement. Un profil d'importation se crée dans le
  dossier du projet (aucune route pour l'écrire).
- Accès : pas d'annuaire ni de SSO ; les jetons nominatifs sont créés par l'administration. Le
  journal grandit sans rotation.
- Accessibilité : clavier, annonces et contraste testés composant par composant ; aucun audit axe
  automatique.
- Rien n'est publié sur un registre : le SDK fait partie de `@qa-crawler/core`.

## Tests

- `tests/unit/sdk-dashboard.test.ts` : rendu du Dashboard. Chiffres tels que le SDK les donne ;
  taux expliqué en champs (la définition du serveur est vérifiée) ; jamais de taux sans rejeu
  terminé ; échappement ; noms de secrets seulement ; archivage et annulation confirmés dans la
  page ; annulation absente quand le serveur ne l'offre pas ; statuts traduits ; état d'erreur.
- `tests/unit/sdk-dashboard-ops.test.ts` : historique et comparaison (écarts échappés), stabilité
  des scénarios et enregistrements à promouvoir, formulaire d'environnement (aller-retour, variable
  invalide refusée, suppression confirmée), carte d'une exploration et sélection par gravité.
- `tests/unit/sdk-requirements.test.ts` : les exigences par le client et le vrai serveur, avec de
  vrais `.docx` et `.xlsx` (fictifs) : import, décisions, publication, matrice et CSV protégé, lien
  ajouté puis rejeté, indicateurs, tendances, refus (taille, profil d'un autre connecteur, variable
  non lue, secret absent, projet archivé) ; semaines ISO, couverture à une date, tendances lues sur
  des runs écrits sur disque.
- `tests/unit/sdk-dashboard-requirements.test.ts` : rendu des écrans d'exigences (échappement,
  secrets par leur nom, conflit à fusionner, lecture partielle, formules, taux sur 0 à 100 %).
- `tests/integration/sdk-dashboard-requirements.test.ts` : dans Chromium, un `.docx` choisi dans
  le champ fichier est importé, décidé et publié ; un lien est ajouté ; la matrice, son CSV
  téléchargé, les indicateurs et les tendances en tiennent compte ; un import Confluence sans
  jeton échoue en le disant ; sur téléphone, aucun défilement horizontal.
- `tests/unit/sdk-access.test.ts` : jetons nominatifs par le vrai serveur (empreinte seulement),
  droits de chaque rôle, rejeu avec écritures refusé à un analyste, auteur tiré du jeton, rôle par
  projet, révocation, journal sans corps ni jeton, page sans jeton en mode nominatif ; droit et
  action de chaque route.
- `tests/unit/sdk-dashboard-access.test.ts` : rendu de l'écran Accès et journal, de la connexion,
  et des actions masquées selon le rôle.
- `tests/integration/sdk-dashboard-access.test.ts` : dans Chromium, en mode nominatif : jeton
  inconnu refusé, lecteur sans action, déconnexion, membre créé (jeton montré une fois), rôle de
  projet, révocation, journal ; téléphone sans défilement horizontal.
- `tests/unit/sdk-dashboard-recordings.test.ts`, `tests/unit/sdk-dashboard-review.test.ts` et
  `tests/integration/sdk-dashboard-recordings.test.ts` : l'écran Enregistrements et la revue. Dans
  Chromium, une personne simulée joue le parcours avec le **vrai** recorder pendant que le Dashboard le
  met en pause, le reprend, y pose une vérification et annule un geste ; puis la revue crée et renomme
  un groupe, accepte une assertion, génère les tests, lance un **vrai** rejeu de validation (conforme) et
  retire une étape ; une vraie correction de cible (rejeu jusqu'à l'étape, élément désigné à la souris,
  validation, reprise du rejeu réussie, restauration) ; la revue des intentions ; téléphone sans
  défilement horizontal.
- `tests/unit/generated-file-edit.test.ts` : modifier un fichier généré (vérifié, refusé sans écriture,
  version générée gardée puis remise, aucun chemin hors de `generated/`).
- `tests/unit/sdk-test-runs.test.ts` : lecture du JUnit XML (Playwright Test, Surefire), verdict jamais
  réussi sans cas, file d'exécution (une à la fois, annulation en file et en cours), `run.json` relu
  après un arrêt. `tests/unit/sdk-dashboard-tests.test.ts` : rendu de l'écran Tests générés (outil et
  garantie de chaque format, exécution refusée et pourquoi, droits par rôle, échappement).
- `tests/integration/sdk-generated-test-runs.test.ts` : par le client, un parcours du **vrai** recorder
  généré puis exécuté : YAML et `.feature` rejoués par le moteur (`PASSED`, rapport servi), test
  Playwright par Playwright Test (`PASSED`, puis `FAILED` une fois la cible cassée), annulation, refus ;
  Java par `mvn test` quand Maven est là. `tests/integration/sdk-dashboard-tests.test.ts` : le même
  parcours depuis l'écran, dans Chromium, téléphone compris.
- `tests/unit/recording-workspace-review.test.ts` : retirer une étape, groupes proposés, vérification
  de groupe, ligne redéfinie, restauration, correction appliquée et revue des intentions sur un
  enregistrement écrit.
- `tests/integration/sdk-dashboard.test.ts` : `/dashboard` dans Chromium avec le **vrai** moteur.
  Il couvre :
  - la vue d'ensemble ;
  - un rejeu lancé dans un environnement, suivi en direct, puis lu (verdict, assertion) ;
  - une annulation confirmée : aucune écriture, verdict `CANCELLED` ;
  - l'archivage confirmé, puis la restauration.
- `tests/unit/sdk-engine-phases.test.ts` : chaque phase annoncée par le moteur est traduite ; le
  Run Monitor l'affiche dans sa langue.

- `tests/unit/sdk-cancellation.test.ts` : transitions vers `CANCELLED`, exécution en file jamais
  lancée, exécution en cours arrêtée par le signal du moteur, refus `409 NOT_CANCELLABLE`, exclusion
  du taux de réussite ; `openQaCrawler` dont la fermeture annule ce qui tourne. Moteur **simulé**.
- `tests/integration/sdk-cancellation.test.ts` : le **vrai** moteur, annulé par le SDK après la
  première étape : étapes suivantes `SKIPPED`, aucune écriture, `stopReason: cancelled`, verdict
  `CANCELLED`.
- `tests/integration/cli-cancellation.test.ts` : la CLI et le **vrai** moteur, Ctrl+C après la
  première étape : code de sortie `130`, rapport écrit, aucune écriture.
- `tests/integration/sdk-node-example.test.ts` : `openQaCrawler` prépare un projet, puis
  `examples/sdk-node/replay.mjs` est lancé comme un programme à part avec le **vrai** moteur :
  `0` et verdict JSON, `1` sur une assertion en échec, `130` sur Ctrl+C, `2` sur un projet inconnu.
- `tests/unit/sdk-core.test.ts` : cycle de vie, client, flux SSE découpé, reprise, reconnexion
  après coupure sans doublon, refus non réessayé, abandon pendant l'attente, version du contrat.
- `tests/unit/sdk-platform.test.ts` : cycle de vie des projets (modifier, dupliquer, archiver,
  restaurer), environnements (règles, secrets jamais renvoyés, confirmation, isolation entre
  projets), mission du rejeu (scénarios, cible, domaines, limites, variables, sans IA), lecture d'un
  run sans valeur saisie, promotion d'un enregistrement, vue d'ensemble et périmètre du taux de
  réussite. Le moteur y est **simulé** (tests seulement).
- `tests/integration/sdk-platform.test.ts` : le **vrai** moteur. Un scénario est rejoué dans deux
  environnements (deux instances de l'application) et suivi en direct. Une seule instance reçoit
  l'écriture. L'assertion métier passe dans l'un et échoue dans l'autre, puis viennent la
  comparaison, la vue d'ensemble et le refus d'un projet archivé.
- `tests/unit/sdk-contract.test.ts` : exports, valeurs et méthodes publiés de la version 1 ; le
  Core et l'UI n'importent ni module Node, ni Playwright, ni classe du moteur.
- `tests/unit/sdk-project.test.ts` : brouillon → projet du moteur, aucun identifiant écrit,
  variables manquantes, sources Angular, validation par le moteur.
- `tests/unit/sdk-server.test.ts` : jeton, origines, variables, modules, CSP, parcours complet avec
  un moteur **simulé** (tests seulement), liens de rapport, reprise du flux ; enregistrements avec un
  recorder **simulé** (un à la fois, arrêt par l'API, noms et chemins refusés, graphe, rapports).
- `tests/unit/sdk-studio.test.ts` : la vue bâtie avec le moteur (données produites et citées,
  liens, dernier rejeu par position, aucun résultat inventé sans rejeu), disposition (cadres,
  repli, colonnes, 150 étapes), zoom, recherche, rendu échappé et explication d'un refus.
- `tests/unit/sdk-data-assertions.test.ts` : tables de verdicts ; lignée, sources et données sans
  origine d'un enregistrement écrit ; liaison (fichiers et registre réécrits) et refus sans écriture ;
  verdicts lus dans le dernier rejeu (étape `expect`, moteur d'assertions, rien sans exécution) ;
  panneaux Données, Assertions et source de la valeur.
- `tests/integration/sdk-studio.test.ts` : le **vrai** recorder et le **vrai** rejeu, puis le Studio
  dans Chromium — zoom, déplacement, recherche, création d'un groupe, dépôt d'une étape sur un groupe,
  carte déplacée sans changer l'ordre, repli et renommage gardés par le moteur, refus affiché, clavier ;
  puis une saisie liée à une valeur générée, la lignée, un verdict `VERIFIED_PASS` venu du rejeu, et
  une proposition rejetée depuis l'onglet Assertions.
- `tests/unit/sdk-view.test.ts` : rendu pur (échappement, pas de champ mot de passe, compteurs
  sans pourcentage, mode embarqué).
- `tests/integration/sdk-wizard.test.ts` : le **vrai** moteur, Chromium et le site de démo — page
  autonome jusqu'au résultat, projet sans secret, rapport par lien ; hôte sur une autre origine
  (thème, jeton, événements) ; origine refusée.
- `tests/unit/sdk-theme.test.ts` : thème sombre présent dans les quatre composants (attribut et
  système), chaque jeton redéfini, contraste WCAG AA calculé dans les deux thèmes.
- `tests/unit/sdk-monitor.test.ts` : libellés d'étape sans valeur ; événements `flow` et
  `flow-step` relayés par l'écouteur du moteur ; modèle du suivi ; rendu échappé, reconnexion
  annoncée.
- `tests/integration/sdk-monitor.test.ts` : le **vrai** moteur joue deux flows (l'un passe, l'autre
  échoue) ; le flux porte les flows et les étapes ; `<qa-crawler-run-monitor>` dans Chromium, après une
  première ouverture du flux coupée : reprise sans doublon, puis choix par statut d'étape et par flow.
- `tests/unit/sdk-runs.test.ts` : vocabulaires alignés sur le moteur ; comparaison (règle du
  moteur, flows retirés ou nouveaux, exigences changées, rien sans traçabilité) ; routes et refus ;
  rendu échappé et sans pourcentage.
- `tests/integration/sdk-runs.test.ts` : deux **vrais** runs du moteur (le second avec un défaut de
  l'application) ; la comparaison et la traçabilité par l'API, puis `<qa-crawler-run-compare>` dans
  Chromium (écarts dépliés, exigence passée en échec, liste par statut, onglets au clavier) ; thème
  sombre par attribut, `auto` selon le système, variable de l'hôte prioritaire.
- `tests/integration/sdk-generated-execution.test.ts` : un parcours enregistré par le **vrai**
  recorder, généré par le SDK, puis **exécuté** : le `.feature` par la mission générée (chaque
  scénario `PASSED` sur l'application), le test Playwright par Playwright Test avec la configuration
  générée (sortie `1 passed`, JUnit XML sans échec). Le projet Java est joué par `mvn test` dans
  `tests/integration/java-generated-tests.test.ts`.
- `tests/integration/sdk-extensions.test.ts` : le **vrai** recorder (seul l'humain est joué par
  Playwright) — enregistrement par l'API, décision sur une proposition, groupe métier, génération
  YAML / Gherkin / Playwright validée, graphe, liste des rapports, lien, arrêt par l'API.
