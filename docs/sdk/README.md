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

| Méthode                                         | Route                                                            |
| ----------------------------------------------- | ---------------------------------------------------------------- |
| `recordings.start(projectId, input)`            | `POST /api/projects/:id/recordings` (202)                        |
| `recordings.list(projectId)`                    | `GET /api/projects/:id/recordings`                               |
| `recordings.get(projectId, name)`               | `GET /api/projects/:id/recordings/:name`                         |
| `recordings.stop(projectId, name)`              | `POST /api/projects/:id/recordings/:name/stop`                   |
| `recordings.subscribe(projectId, name, cb)`     | `GET /api/projects/:id/recordings/:name/events` (SSE)            |
| `recordings.flow(projectId, name)`              | `GET /api/projects/:id/recordings/:name/flow`                    |
| `assertions.list(projectId, name)`              | `GET /api/projects/:id/recordings/:name/assertions`              |
| `assertions.decide(projectId, name, id, input)` | `POST /api/projects/:id/recordings/:name/assertions/:proposalId` |
| `groups.list(projectId, name)`                  | `GET /api/projects/:id/recordings/:name/groups`                  |
| `groups.edit(projectId, name, command)`         | `POST /api/projects/:id/recordings/:name/groups`                 |
| `generation.run(projectId, name, input)`        | `POST /api/projects/:id/recordings/:name/generation`             |
| `graph.exploration(id)`                         | `GET /api/explorations/:id/graph` (409 avant la fin)             |
| `graph.of(projectId, kind, name)`               | `GET /api/projects/:id/reports/:kind/:name/graph`                |
| `reports.list(projectId)`                       | `GET /api/projects/:id/reports`                                  |
| `reports.link(projectId, kind, name)`           | `POST /api/projects/:id/reports/:kind/:name/links`               |

**Enregistrement** : `RECORDING → PROCESSING → COMPLETED | FAILED` ; `STORED` désigne un
enregistrement lu sur disque (écrit par la CLI, ou avant le démarrage du serveur). Le nom donné
devient le dossier du moteur (`recordings/<nom>/`, en minuscules, les chiffres remplacés par `#`).
Le flux relaie les événements du recorder (sauf les traces brutes, une par événement clavier ou
souris), les phases après l'arrêt, puis le résumé : étapes, raison de l'arrêt, rejeu de validation
(si demandé avec `validate: true`), propositions, groupes, fichiers.

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

## Statuts et événements

```
QUEUED ──▶ RUNNING ──▶ COMPLETED
                  └──▶ FAILED
```

`CANCELLED` existe dans le contrat mais n'est jamais atteint : le moteur n'offre pas d'annulation
(`capabilities().cancellation === false`), l'assistant n'affiche donc pas de bouton « Annuler ».

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

## Limites actuelles

- Pas d'annulation d'une exploration (le moteur ne l'offre pas). Un enregistrement, lui, s'arrête.
- Les explorations et les flux d'enregistrement vivent en mémoire pendant la vie du serveur ; les
  projets, les enregistrements et les rapports restent sur disque, dans le dossier de travail.
- L'enregistrement suppose un écran sur la machine du serveur (un humain joue le parcours).
- L'assistant visuel couvre la création et l'exploration ; les extensions s'utilisent par le client.
- Une exploration à la fois par défaut (`--concurrency`).
- Chromium seulement.
- Rien n'est publié sur un registre : le SDK fait partie de `@qa-crawler/core`.

## Tests

- `tests/unit/sdk-core.test.ts` : cycle de vie, client, flux SSE découpé, reprise, reconnexion
  après coupure sans doublon, refus non réessayé, abandon pendant l'attente, version du contrat.
- `tests/unit/sdk-contract.test.ts` : exports, valeurs et méthodes publiés de la version 1 ; le
  Core et l'UI n'importent ni module Node, ni Playwright, ni classe du moteur.
- `tests/unit/sdk-project.test.ts` : brouillon → projet du moteur, aucun identifiant écrit,
  variables manquantes, sources Angular, validation par le moteur.
- `tests/unit/sdk-server.test.ts` : jeton, origines, variables, modules, CSP, parcours complet avec
  un moteur **simulé** (tests seulement), liens de rapport, reprise du flux ; enregistrements avec un
  recorder **simulé** (un à la fois, arrêt par l'API, noms et chemins refusés, graphe, rapports).
- `tests/unit/sdk-view.test.ts` : rendu pur (échappement, pas de champ mot de passe, compteurs
  sans pourcentage, mode embarqué).
- `tests/integration/sdk-wizard.test.ts` : le **vrai** moteur, Chromium et le site de démo — page
  autonome jusqu'au résultat, projet sans secret, rapport par lien ; hôte sur une autre origine
  (thème, jeton, événements) ; origine refusée.
- `tests/integration/sdk-extensions.test.ts` : le **vrai** recorder (seul l'humain est joué par
  Playwright) — enregistrement par l'API, décision sur une proposition, groupe métier, génération
  YAML / Gherkin / Playwright validée, graphe, liste des rapports, lien, arrêt par l'API.
