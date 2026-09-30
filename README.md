# QA Crawler — explorateur autonome de flows QA

Explorateur déterministe, prêt pour les conteneurs, qui teste une application web **en l'utilisant**.

On lui donne une URL et une mission en YAML. Sur chaque écran, il exécute la même boucle :

1. il observe l'écran et découvre toutes les actions possibles de l'utilisateur ;
2. il décide quoi essayer, puis fait valider ce choix par la politique de sécurité ;
3. il exécute l'action avec Playwright et observe le nouvel écran ;
4. il enregistre la transition dans un **graphe des flows** de l'application ;
5. il revient en arrière pour explorer les autres branches, jusqu'aux limites de la mission.

En chemin, il signale les pages cassées, les appels d'API en échec et les erreurs JavaScript. Chaque anomalie indique l'écran, l'action et le chemin qui permettent de la reproduire.

Le YAML ne liste jamais les boutons à cliquer : l'explorateur trouve lui-même les écrans, les onglets, les fenêtres et les étapes des assistants. Quand un test doit suivre un chemin précis, on peut en plus lui **imposer des flows** (voir [Créer un flow de test imposé](#créer-un-flow-de-test-imposé)).

Ni IA, ni LLM, ni jeton d'API, ni GPU : même application, même exploration.

- **Technologies :** Node.js 20+ · TypeScript (strict) · Playwright 1.56 · Chromium sans interface · YAML · Docker
- **Conçu pour :** pipelines CI/CD, Kubernetes / OpenShift (ARO), Angular et autres applications monopages (SPA)

---

## Sommaire

- [Démarrage rapide](#démarrage-rapide)
- [Fonctionnement](#fonctionnement)
- [Mission (YAML)](#mission-yaml)
- [Créer un flow de test imposé](#créer-un-flow-de-test-imposé)
- [Scénarios Gherkin](#scénarios-gherkin)
- [Dry Run : confronter un scénario à l'application](#dry-run--confronter-un-scénario-à-lapplication)
- [Authentification](#authentification)
- [Interactions navigateur](#interactions-navigateur)
- [Sécurité](#sécurité)
- [Détection des états et protection contre les boucles](#détection-des-états-et-protection-contre-les-boucles)
- [Formulaires](#formulaires)
- [Oracles de test](#oracles-de-test)
- [Récupération après un problème](#récupération-après-un-problème)
- [Plusieurs acteurs et autorisations](#plusieurs-acteurs-et-autorisations)
- [Accessibilité](#accessibilité)
- [Données créées et budget de modifications](#données-créées-et-budget-de-modifications)
- [Générer des flows YAML à partir de l'exploration](#générer-des-flows-yaml-à-partir-de-lexploration)
- [Ce qui est détecté](#ce-qui-est-détecté)
- [Rapports](#rapports)
- [Modes LEARN / VERIFY / EXPLORE](#modes-learn--verify--explore)
- [Choix des actions (scoring) et objectifs](#choix-des-actions-scoring-et-objectifs)
- [Moteur de décision avancé](#moteur-de-décision-avancé)
- [Persistance et mémoire](#persistance-et-mémoire)
- [Corrélation réseau](#corrélation-réseau)
- [Ligne de commande](#ligne-de-commande)
- [Docker](#docker)
- [Kubernetes / OpenShift](#kubernetes--openshift)
- [CI/CD](#cicd)
- [Architecture](#architecture)
- [Développement](#développement)
- [Limites de cette version](#limites-de-cette-version)
- [Feuille de route](#feuille-de-route)

---

## Démarrage rapide

```bash
npm install
npx playwright install chromium            # une fois : télécharge le Chromium correspondant

npm run qa -- scenarios/smoke.yaml --base-url http://localhost:4200
```

Essai sur les applications de démo fournies :

```bash
npm run demo:server                        # terminal 1 : back-office sur :4174, site piège sur :4173
npm run qa -- scenarios/demo.yaml          # terminal 2 : découvre les flows du back-office
npm run qa -- scenarios/demo-traps.yaml    #              pièges (404, 500, erreurs JS, boucles…)
QA_DEMO_PASSWORD=demo npm run qa -- scenarios/demo-flows.yaml   # flows imposés
open reports/index.html reports/flow-graph.html
```

Exemple de résultat sur le back-office de démo. L'explorateur a trouvé seul la structure, y compris les trois étapes d'un assistant qui ne change jamais d'URL :

```
Tableau de bord
├── Utilisateurs  ⟵ navigate "Gérer les utilisateurs"
│   └── Utilisateur 1 › Profil  ⟵ navigate "Voir"
│       └── Utilisateur 1 › Historique  ⟵ click "Historique"
├── Dossiers  ⟵ navigate "Dossiers"
│   └── Nouveau dossier › Étape 1 — Informations  ⟵ navigate "Nouveau dossier"
│       └── Nouveau dossier › Étape 2 — Détails  ⟵ click "Suivant"          (même URL)
│           └── Nouveau dossier › Étape 3 — Confirmation  ⟵ click "Suivant" (même URL)
├── Paramètres › Général  ⟵ navigate "Paramètres"
│   ├── Paramètres › Notifications  ⟵ click "Notifications"                 (onglet)
│   └── Paramètres › Sécurité  ⟵ click "Sécurité"                           (onglet)
└── Administration  ⟵ navigate "Administration"
    └── Journal  ⟵ navigate "Journal"
```

## Fonctionnement

La boucle fondamentale :

```
OBSERVER → DÉCOUVRIR LES ACTIONS → DÉCIDER → CONTRÔLE DE SÉCURITÉ → EXÉCUTER AVEC PLAYWRIGHT
   ↑                                                                          ↓
RECOMMENCER ← ENREGISTRER LA TRANSITION ← ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ OBSERVER LE NOUVEL ÉTAT
```

Chaque question a exactement un composant pour y répondre :

| Question                   | Composant                                    | Remarques                                                                                                                                                                       |
| -------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| « Où suis-je ? »           | `UIObserver` + `StateDetector`               | DOM, rôles ARIA et noms accessibles, titres, fenêtres, onglets sélectionnés, formulaires. Produit un `PageContext` et un `stateId` stable                                       |
| « Que puis-je faire ? »    | `ActionDiscovery`                            | Liens, boutons, `[role=button]`, `[routerLink]`, onglets, menus, champs, zones de texte, listes, cases à cocher, boutons radio. Chaque action a un `LocatorDescriptor` et un id |
| « Que dois-je essayer ? »  | `DecisionEngine` → `RuleBasedDecisionEngine` | Renvoie `EXECUTE`, `BACKTRACK` ou `STOP`                                                                                                                                        |
| « Est-ce autorisé ? »      | `SafetyPolicy.evaluate()`                    | S'exécute **après** la décision et **avant** Playwright, quel que soit le moteur                                                                                                |
| « Exécute-le. »            | `PlaywrightActionExecutor`                   | Traduit le descripteur en `getByRole(...).click()`, `fill`, `selectOption`, `setChecked`. Il ne prend aucune décision                                                           |
| « Qu'est-ce qui a raté ? » | Observateurs réseau, console et erreurs      | Chaque anomalie est rattachée au `stateId`, à l'`actionId` et au chemin du flow                                                                                                 |
| « Qu'ai-je appris ? »      | `FlowGraph` + `FlowMemory`                   | États, transitions, ce qui a été essayé. Enregistré dans `reports/flow-graph.json`                                                                                              |

`FlowExplorer` ne fait qu'enchaîner ces composants, gérer la pile de navigation, revenir en arrière et faire respecter les limites.

**Retour en arrière.** Quand un écran n'a plus rien à explorer, l'explorateur revient à l'état précédent. Il essaie d'abord la méthode la moins coûteuse, et vérifie chaque tentative avec le `stateId` attendu :

1. l'historique du navigateur (`goBack`) ;
2. puis l'URL de l'état ;
3. puis la **rejouée** du chemin enregistré depuis l'état de départ. C'est nécessaire pour les états sans URL propre : étapes d'assistant, onglets, fenêtres.

Quand tout le chemin est épuisé, il saute vers n'importe quel état connu qui a encore des actions inexplorées.

## Mission (YAML)

Le YAML décrit une **mission** : un objectif et des limites. Seul `target.baseUrl` est obligatoire. Pour faire suivre en plus des étapes précises, ajoute des [flows imposés](#créer-un-flow-de-test-imposé).
[`scenarios/example.yaml`](scenarios/example.yaml) documente chaque clé avec sa valeur par défaut.

```yaml
mission:
  name: explore-application

target:
  baseUrl: http://localhost:4200
  startAt: /

exploration:
  maxStates: 100
  maxActions: 500
  maxDepth: 10
  maxDurationMinutes: 15
  actionTimeoutMs: 10000

goals:
  discoverNavigation: true # suivre les liens et les routerLinks
  discoverForms: true # remplir les formulaires avec des données factices avant leurs boutons d'étape
  discoverFlows: true # cliquer onglets, menus, détails, bascules, étapes d'assistant
  detectErrors: true # observateurs réseau / console / JavaScript

safety:
  allow: [navigation, search, filter, pagination, tabs] # types d'actions SAFE autorisés
  block: [delete, payment, external-navigation] # risques toujours refusés
```

| Clé                                                                            | Défaut                         | Rôle                                                                                                                                  |
| ------------------------------------------------------------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `exploration.maxStates`                                                        | 100                            | États fonctionnels distincts découverts                                                                                               |
| `exploration.maxActions`                                                       | 500                            | Actions exécutées                                                                                                                     |
| `exploration.maxDepth`                                                         | 10                             | Transitions depuis l'état de départ                                                                                                   |
| `exploration.maxDurationMinutes`                                               | 15                             | Durée maximale                                                                                                                        |
| `exploration.actionTimeoutMs`                                                  | 10000                          | Localiser et exécuter une action                                                                                                      |
| `exploration.maxStatesPerRoute`                                                | 3                              | Échantillons par modèle de route (`/users/:id`)                                                                                       |
| `exploration.settleTimeMs`                                                     | 400                            | Attente après chaque action (rendu SPA, appels d'API)                                                                                 |
| `exploration.maxSimilarActions`                                                | 2                              | Contrôles semblables essayés par écran (jours d'un calendrier, numéros de page, « Voir » de chaque ligne)                             |
| `forms.exercise`                                                               | `true`                         | Remplir les formulaires de chaque écran (même sans `<form>`) puis relever les messages de validation                                  |
| `forms.submit`                                                                 | non défini                     | Boutons qui envoient un formulaire : `false` jamais, `true` comme une MUTATION ; non défini : `safety.block` (`form-submit`) décide   |
| `testData.fields`                                                              | `{}`                           | Valeur par champ (libellé, name ou placeholder). Voir [Formulaires](#formulaires)                                                     |
| `exploration.queryParams.mode`                                                 | `pattern`                      | `?page=1..N` comptent comme une seule route (`ignore` / `keep`)                                                                       |
| `exploration.autonomous`                                                       | `true`                         | Explorer seul après les flows ; `false` n'exécute que les flows                                                                       |
| `goals.*`                                                                      | tous à `true`                  | Ce qu'il faut explorer (voir ci-dessus)                                                                                               |
| `safety.allowedActionClasses`                                                  | `[SAFE]`                       | Classes exécutables : `SAFE`, `MUTATION`, `DANGEROUS`, `UNKNOWN`                                                                      |
| `safety.allow`                                                                 | tous les types                 | `navigation`, `tabs`, `menus`, `details`, `pagination`, `search`, `filter`, `forms`, `other`                                          |
| `safety.block`                                                                 | voir ci-dessous                | `delete`, `payment`, `send`, `logout`, `irreversible`, `sensitive-data`, `external-navigation`, `form-submit`, `mutation`, `download` |
| `safety.allowedHosts` / `ignoredPaths`                                         | hôte de `baseUrl` / `/logout`… | Où l'explorateur peut aller                                                                                                           |
| `flows`                                                                        | `[]`                           | [Flows imposés](#créer-un-flow-de-test-imposé), exécutés avant l'exploration autonome                                                 |
| `credentials`, `browserInteractions`                                           |                                | [Interactions navigateur](#interactions-navigateur) (fenêtre d'authentification native, dialogues, popups…)                           |
| `memory.resume`                                                                | `false`                        | Reprendre depuis le `flow-graph.json` précédent, sans refaire les actions déjà essayées                                               |
| `report.language`                                                              | `en`                           | Langue des rapports HTML : `en` ou `fr`                                                                                               |
| `checks.*`, `http.*`, `browser.*`, `auth`, `output.*`, `report.failOnSeverity` |                                | Comme dans le fichier d'exemple                                                                                                       |

Les clés inconnues sont refusées : une faute de frappe comme `explorations:` échoue au lieu d'être ignorée.

Les scénarios écrits pour la première version (`name`, `maxPages`, `maxUrlsPerRoute`, `clickSafeActions`) se chargent encore, avec un avertissement.

## Créer un flow de test imposé

Par défaut, l'explorateur choisit lui-même quoi cliquer. Un **flow imposé** lui fait suivre des étapes précises, dans l'ordre : se connecter, remplir un formulaire, vérifier le résultat. La politique de sécurité continue de s'appliquer à chaque étape.

Exemples complets :

- [`scenarios/demo-flows.yaml`](scenarios/demo-flows.yaml) : le back-office de démo (`npm run demo:server`) ;
- [`scenarios/mosquee-flows.yaml`](scenarios/mosquee-flows.yaml) et [`scenarios/mosquee-devoir.yaml`](scenarios/mosquee-devoir.yaml) : une application Angular réelle.

### 1. Squelette d'une mission avec flow

Crée un nouveau fichier dans `scenarios/`, par exemple `scenarios/mon-flow.yaml`. Ne modifie pas `demo-flows.yaml` : c'est la démo.

```yaml
mission:
  name: mon-flow

target:
  baseUrl: http://localhost:4200
  startAt: /app/admin/dashboard

auth: # connexion faite une fois, avant les flows
  type: form
  loginUrl: /login
  usernameSelector: input[formcontrolname="identifiant"]
  passwordSelector: input[type="password"]
  submitSelector: button[type="submit"]
  successUrlContains: /app/

exploration:
  autonomous: false # false = seulement les flows ; true = explore ensuite toute l'application

report:
  language: fr # rapport HTML en français

flows:
  - name: creer-un-devoir
    description: Nouveau devoir via le dialogue en 2 étapes
    startAt: /app/admin/devoirs # page chargée avant la première étape
    steps:
      - click: { role: button, name: Nouveau devoir }
        allow: MUTATION
      - fill: { label: Titre, value: Devoir QA }
      - select: { label: Classe, option: M1 Dimanche }
      - click: { role: button, name: Suivant }
      - expect: { text: Étape 2 }
      - screenshot: etape-2
      - click: { role: button, name: Enregistrer }
        allow: MUTATION
      - expect: { text: Devoir enregistré }
```

Les identifiants viennent **toujours** de variables d'environnement, jamais du fichier :

```bash
# macOS / Linux
QA_USERNAME=admin@exemple.com QA_PASSWORD='mot-de-passe' npm run qa -- scenarios/mon-flow.yaml

# Windows PowerShell
$env:QA_USERNAME="admin@exemple.com"; $env:QA_PASSWORD="mot-de-passe"; npm run qa -- scenarios/mon-flow.yaml
```

Pour regarder le navigateur travailler, ajoute `--headed` (et `browser.slowMoMs: 500` dans le YAML pour ralentir).

### 2. Les étapes

Chaque étape contient **une seule** action.

| Étape               | Exemple                                                            | Effet                                                                                           |
| ------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `goto`              | `goto: /dossiers`                                                  | Charge une page (relative à `target.baseUrl`)                                                   |
| `click`             | `click: { role: button, name: Suivant }`                           | Clique l'élément                                                                                |
| `fill`              | `fill: { label: Titre, value: Devoir QA }`                         | Saisit une valeur ; `value: { env: NOM }` la lit dans une variable d'environnement              |
| `select`            | `select: { label: Classe, option: M1 Dimanche }`                   | Liste native `<select>`, ou `mat-select` Angular : ouvre la liste puis clique l'option          |
| `check` / `uncheck` | `check: { label: J'accepte les conditions }`                       | Coche / décoche une case                                                                        |
| `expect`            | `expect: { text: Étape 2 }`                                        | Attend que ce soit vrai : `text`, `url` (contient), `visible: <cible>`, `hidden: <cible>`       |
| `expect.noError`    | `expect: { noError: true }`                                        | Aucun message d'erreur visible (`mat-error`, `.invalid-feedback`, `[role=alert]`…)              |
| `expect.response`   | `expect: { response: { method: PUT, url: /api/dossiers/*/code } }` | La dernière requête du flow qui correspond a répondu `status` (défaut `2xx` ; ou `201`, `4xx`…) |
| `screenshot`        | `screenshot: confirmation`                                         | Capture nommée, avec un lien dans le rapport                                                    |
| `manual`            | `manual: aucune autre donnée n'est modifiée`                       | Vérification à faire à la main : « À VÉRIFIER » dans le rapport, le flow continue               |
| `run`               | `run: creer-dossier`                                               | Rejoue ici les étapes d'un autre flow (une précondition écrite une fois)                        |

Options possibles sur **chaque** étape :

| Option           | Effet                                                                |
| ---------------- | -------------------------------------------------------------------- |
| `name`           | Libellé affiché dans le rapport à la place de la description auto    |
| `allow`          | `MUTATION` et/ou `UNKNOWN` : autorisation pour cette étape seulement |
| `optional: true` | Un échec donne seulement un avertissement, le flow continue          |
| `timeoutMs`      | Délai maximum de l'étape (défaut : `exploration.actionTimeoutMs`)    |

Options d'un flow :

| Option        | Effet                                                                                               |
| ------------- | --------------------------------------------------------------------------------------------------- |
| `name`        | Nom unique du flow                                                                                  |
| `description` | Texte affiché dans le rapport                                                                       |
| `startAt`     | Page chargée avant la première étape (défaut : `target.startAt`)                                    |
| `thenExplore` | `true` : explore aussi le dernier écran du flow (onglets, boutons, sous-pages), sans suivre le menu |
| `reusable`    | `true` : flow rejoué seulement par `run`, jamais exécuté seul                                       |

### 3. Désigner un élément (cible)

Une seule stratégie par cible, comme dans Playwright :

| Stratégie       | Exemple                                           | Quand l'utiliser                                                       |
| --------------- | ------------------------------------------------- | ---------------------------------------------------------------------- |
| `role` + `name` | `{ role: button, name: Enregistrer }`             | Boutons, liens (`role: link`), onglets (`role: tab`) : le plus robuste |
| `label`         | `{ label: Titre }`                                | Champs avec un `<label>` relié ou un `mat-label`                       |
| `text`          | `{ text: Voir le détail }`                        | Texte visible                                                          |
| `testId`        | `{ testId: btn-save }`                            | Attribut `data-testid`                                                 |
| `css`           | `{ css: 'input[formcontrolname="identifiant"]' }` | Dernier recours                                                        |

- `exact: true` : correspondance exacte du texte (sinon, « contient ») ;
- `nth: 2` : prend le 3ᵉ élément trouvé (le décompte commence à 0) ;
- sans `nth`, si plusieurs éléments correspondent, celui qui est **dans la fenêtre (modale) ouverte** est choisi.

Pour trouver le bon libellé : clic droit → **Inspecter** sur l'élément dans ton navigateur, ou lance le test avec `--headed`.

### 4. La sécurité s'applique toujours

Le YAML choisit l'élément, mais la `SafetyPolicy` le classe exactement comme pendant l'exploration automatique, et décide.

| Élément ciblé                                                       | Exécuté ?                                                                                                         |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| SÛR : navigation, onglet, « Suivant », champ normal                 | oui                                                                                                               |
| MODIFICATION : créer, enregistrer, nouveau, envoi de formulaire     | seulement avec `allow: MUTATION` sur l'étape                                                                      |
| Icône sans texte                                                    | seulement avec `allow: UNKNOWN` sur l'étape                                                                       |
| DANGEREUX : supprimer, payer, envoyer, déconnexion                  | seulement avec `allow: DANGEROUS` sur l'étape **et** `DANGEROUS` dans `safety.allowedActionClasses` de la mission |
| Mot de passe, code, secret                                          | seulement avec `value: { env: NOM }`, jamais affiché                                                              |
| Carte bancaire, CVV, IBAN                                           | **jamais**                                                                                                        |
| Lien ou `goto` hors des hôtes autorisés, chemin ignoré ou dangereux | **jamais**                                                                                                        |

Un flow qui utilise `allow: MUTATION` modifie de vraies données : lance-le seulement sur une base locale ou de test.

### 5. Pièges fréquents

| Problème                                                                 | Solution                                                                                                               |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `élément introuvable` sur un champ dont le `<label>` n'est pas relié     | Utilise `css: 'input[formcontrolname="…"]'`                                                                            |
| « Nouveau devoir » est BLOQUÉ                                            | « Nouveau » est un mot de modification : ajoute `allow: MUTATION`                                                      |
| « Se connecter » est BLOQUÉ                                              | C'est un envoi de formulaire : ajoute `allow: MUTATION`, ou utilise le bloc `auth`                                     |
| Deux champs « Classe » (filtre de la page et fenêtre)                    | Rien à faire : celui de la fenêtre ouverte est choisi                                                                  |
| Tous les flows échouent, les écrans s'appellent « Opps!!! » ou « 404 »   | Mauvaise application : vérifie `baseUrl` et que `QA_BASE_URL` n'est pas défini                                         |
| Ça explore alors que `autonomous: false`                                 | `thenExplore: true` explore quand même le dernier écran du flow : retire-le                                            |
| La fenêtre grise « Connexion » du navigateur apparaît                    | Ce n'est pas un formulaire : utilise `auth: { type: http, origin: https://… }` ([Authentification](#authentification)) |
| Cette fenêtre apparaît dans une **popup** SSO (SiteMinder `smntlm.ntc`…) | Voir [Connexion SSO dans une popup](#connexion-sso-dans-une-popup-siteminder-ntlm) et `scenarios/sso-popup.yaml`       |
| `expect` échoue alors que le texte est visible                           | Le texte doit être exact au caractère près (accents, tirets « — ») : essaie une partie plus courte                     |

### Élément introuvable : la suggestion

Quand une étape ne trouve pas son élément, le crawler **inspecte l'écran** (la fenêtre du dessus s'il y en a une) :

- il cherche le texte de la cible (`label`, `name` ou `text`) et prend le champ, l'option ou le bouton qui va avec (le champ qui suit un libellé non relié, l'input d'une option radio…) ;
- il propose l'étape corrigée, prête à copier, avec la cible la plus robuste qui ne trouve que cet élément : `testId`, `role` + `name`, `id`, `formcontrolname` / `name`, sinon un XPath ancré sur le texte ;
- il liste aussi les libellés des champs (ou les noms des boutons) présents à l'écran.

Dans le rapport HTML (sous la raison de l'étape) et dans la console :

```text
✗  5. fill label="Code agence" = "12345" FAILED (element not found within 20000 ms)
   Suggested step (found on the screen):
     - fill: { css: "input[formcontrolname=\"agence\"]", value: "12345" }
     - fill: { css: "xpath=//*[text()[contains(normalize-space(.),'Code agence')]]/following::*[…][1]", value: "12345" }
   On the screen: Code agence · Raison sociale · Téléphone · Courriel
```

Les valeurs des champs ne sont jamais lues.

### 6. Ordre d'exécution

1. Connexion (`auth`), puis chargement de `target.startAt`.
2. Chaque flow, dans l'ordre, depuis son propre `startAt`. Une étape échouée ou bloquée arrête ce flow ; ses étapes suivantes sont IGNORÉES. Les flows suivants s'exécutent quand même.
3. Avec `thenExplore: true` : exploration du dernier écran du flow, même si `exploration.autonomous` vaut `false`. Elle reste dans la section de cet écran : contrôles de la page et pages sous son chemin (`/admin/fideles` → `/admin/fideles/12`), jamais le menu général.
4. Avec `exploration.autonomous: true` (défaut) : exploration de toute l'application depuis `target.startAt`.

### 7. Résultats

- `reports/index.html`, section **Flows imposés** : chaque flow est RÉUSSI, ÉCHOUÉ, BLOQUÉ ou IGNORÉ ; chaque étape a son statut, sa classe, sa raison, l'état atteint, sa durée et sa capture.
- Une étape échouée ou bloquée crée une anomalie `FLOW` (ERREUR, ou AVERTISSEMENT pour une étape `optional`) avec une capture : le run échoue avec le code 1, pratique en CI.
- Les transitions des flows sont enregistrées dans le graphe, avec le nom du flow.
- `reports/result.json` contient un tableau `flows` (en anglais, pour les outils).
- Le terminal affiche chaque étape en direct : ✓ réussie, ✗ échouée, ⛔ bloquée, - ignorée.

## Scénarios Gherkin

Les scénarios écrits par l'équipe QA (fichiers `.feature`, en français ou en anglais) s'exécutent comme des flows imposés, sans les réécrire en YAML :

```yaml
flows:
  - gherkin: ./features/clients.feature # chemin relatif au fichier de mission
  - gherkin: ./features/recherche.feature
    scenarios: ['Recherche par nom'] # facultatif : seulement ces scénarios
    tags: ['@smoke'] # facultatif : seulement les scénarios qui ont l'un de ces tags
    thenExplore: true # facultatif : explorer le dernier écran de chaque scénario
  - name: accueil # un flow YAML classique peut suivre
    steps:
      - goto: /
```

```gherkin
# language: fr
Fonctionnalité: Clients

  Contexte:
    Étant donné que je suis sur "/clients"

  @mutation
  Scénario: Création d'un client
    Quand je clique sur le bouton "Nouveau client"
    Et je remplis le formulaire :
      | champ        | valeur              |
      | Nom          | Dupont              |
      | Mot de passe | <env:APP_PASSWORD>  |
    Et je choisis "Entreprise" dans "Type"
    Et je coche la case "J'accepte les conditions"
    Et je clique sur le bouton "Enregistrer"
    Alors je vois "Client créé"
    Et l'URL contient "/clients/"
    Et je prends une capture "fiche" (optionnel)
```

- Chaque **scénario** devient un flow. Le **Contexte** est joué au début de chaque scénario. Un **Plan du scénario** donne un flow par ligne d'**Exemples** (`Recherche [Dupont, 1 client]`).
- Les **valeurs** sont entre guillemets : `"…"`, `« … »` ou `'…'`. Un secret s'écrit `<env:NOM_DE_VARIABLE>` : il est lu dans l'environnement, jamais écrit dans le fichier ni dans les rapports.
- Une phrase **inconnue** n'est jamais devinée : le chargement échoue avec le fichier et la ligne (`clients.feature:14: "Quand je fais quelque chose"`).
- Le rapport montre chaque phrase avec son statut (réussie, échouée, bloquée, ignorée). Les règles de sécurité sont celles des flows YAML : une phrase qui crée ou modifie des données exige le tag `@mutation`.

| Phrase (FR)                                                                        | Phrase (EN)                                                 | Étape                                 |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------- |
| `je suis sur "/x"`, `je vais sur "/x"`, `j'ouvre la page "/x"`                     | `I am on "/x"`, `I go to "/x"`, `I visit "/x"`              | `goto` (dans un Alors : `expect.url`) |
| `je clique sur [le bouton / le lien / l'onglet / le menu] "X"`, `j'appuie sur "X"` | `I click [on] [the button / link / tab] "X"`, `I press "X"` | `click` (sans type : texte visible)   |
| `je saisis "v" dans "Champ"`, `je remplis [le champ] "Champ" avec "v"`             | `I type "v" into "Field"`, `I fill in "Field" with "v"`     | `fill`                                |
| `je remplis le formulaire :` + tableau `\| champ \| valeur \|`                     | `I fill in the form:` + table                               | un `fill` par ligne                   |
| `je choisis "Option" dans [la liste] "Champ"`                                      | `I select "Option" from "Field"`                            | `select`                              |
| `je coche [la case] "X"`, `je décoche "X"`                                         | `I check "X"`, `I uncheck "X"`                              | `check` / `uncheck`                   |
| `je vois "Texte"`, `le bouton "X" est visible`, `le message "X" s'affiche`         | `I should see "Text"`, `the button "X" is visible`          | `expect` (texte ou élément)           |
| `je ne vois pas "Texte"`                                                           | `I should not see "Text"`                                   | `expect.hidden`                       |
| `l'URL contient "/x"`, `je suis redirigé vers "/x"`                                | `the URL contains "/x"`, `I am redirected to "/x"`          | `expect.url`                          |
| `je prends une capture "nom"`                                                      | `I take a screenshot "nom"`                                 | `screenshot`                          |

| Tag                                   | Effet                                                                                    |
| ------------------------------------- | ---------------------------------------------------------------------------------------- |
| `@mutation`, `@dangerous`, `@unknown` | `allow` sur les étapes du scénario (DANGEROUS exige aussi `safety.allowedActionClasses`) |
| `@explorer`                           | `thenExplore: true`                                                                      |
| `@ignore`, `@skip`, `@wip`            | scénario non exécuté                                                                     |
| `(optionnel)` en fin de phrase        | cette étape seulement : un échec est un AVERTISSEMENT, le flow continue                  |

Les tags se placent sur la fonctionnalité (tous ses scénarios), un scénario ou un bloc d'exemples.

**Phrases de l'équipe** : les phrases métier (« une demande est créée », « l'utilisateur modifie le code de <ancien> à <nouveau> ») se traduisent une fois dans la mission ; elles passent avant les phrases intégrées.

| Emplacement | Accepte                                                |
| ----------- | ------------------------------------------------------ |
| `{x}`       | une valeur entre guillemets : `"Dupont"`, `« Dupont »` |
| `{x:mot}`   | la même chose, ou un mot sans guillemets : `112310`    |
| `{x:texte}` | la même chose, ou n'importe quel texte (le plus court) |

```yaml
flows:
  - name: creer-dossier
    reusable: true # rejoué par « run », jamais exécuté seul
    steps:
      - click: { role: button, name: Nouveau dossier }
        allow: MUTATION
      - fill: { label: Nom, value: Essai }
      - click: { role: button, name: Enregistrer }
        allow: MUTATION
  - gherkin: ./features/code.feature

gherkin:
  steps:
    # une précondition : rejouer un flow
    - pattern: un dossier est créé avec succès
      steps: [{ run: creer-dossier }]
    # plusieurs étapes, valeurs d'exemples sans guillemets, droit d'écrire pour ces étapes
    - pattern: "l'utilisateur modifie le code de {ancien:mot} à {nouveau:mot}"
      steps:
        - fill: { label: Code, value: '{nouveau}' }
        - click: { role: button, name: Valider le code }
      allow: MUTATION
    - pattern: 'le code {code:mot} est affiché dans le dossier'
      step: { expect: { text: 'Code : {code}' } }
    # ce que le robot ne sait pas vérifier : « À VÉRIFIER » dans le rapport, le flow continue
    - pattern: "aucune autre donnée du dossier n'est modifiée"
      manual: true
```

Phrases intégrées en plus : `aucun message d'erreur n'est affiché` (→ `expect.noError`), `la requête PUT "/api/dossiers/*/code" réussit` / `répond 201` (→ `expect.response`, sur les requêtes vues depuis le début du scénario). Un fichier sans `Feature:` / `Fonctionnalité:` est refusé avec l'explication.

### Mode automatique (sans traduction)

```yaml
gherkin:
  auto: true # ou, pour un seul fichier : flows: - gherkin: ./x.feature \n auto: true
```

Une phrase que ni les phrases intégrées ni celles de l'équipe ne reconnaissent n'est plus une erreur : elle est **interprétée sur l'écran, au moment de l'exécution**. Les phrases intégrées et celles de l'équipe passent toujours en premier.

| Phrase                                                                                               | Interprétation (sur l'écran courant)                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| verbe de navigation + noms entre guillemets : `accède à l'onglet "Profil" et à la section "Adresse"` | un clic par nom, dans l'ordre ; un nom pas encore affiché (section d'un panneau fermé) est réessayé après les clics suivants ; « l'onglet », « le bouton »… départagent |
| verbe de saisie + libellé d'un champ de l'écran + valeur : `modifie le code postal de 11111 à 22222` | `fill` du champ dont le libellé est dans la phrase (le plus long gagne), valeur entre guillemets, après le dernier « à / avec / to », ou dernier mot avec des chiffres  |
| `choisit "Canada" comme pays`, `coche j'accepte les conditions`                                      | `select` / `check` du champ nommé                                                                                                                                       |
| **Alors** avec des valeurs : `le code 22222 est affiché`, `le taux demeure à 60`                     | chaque valeur visible (entre guillemets, avec des chiffres, ou après « demeure / reste / vaut »)                                                                        |
| **Alors** … `avec succès`                                                                            | aucun message d'erreur, et la dernière écriture (POST/PUT/…) du scénario a répondu 2xx                                                                                  |
| **Alors** `aucun message d'erreur…` / `"X" n'est pas affiché`                                        | aucun message d'erreur / texte absent                                                                                                                                   |
| tout le reste (`une demande est créée`, `aucune autre donnée n'est modifiée`…)                       | **À VÉRIFIER**, avec la raison ; jamais une action devinée                                                                                                              |

Le rapport et le terminal montrent sous chaque phrase ce qu'elle est devenue (`↳ click tab "Profil" → click button "Adresse"`). Les actions passent par la même SafetyPolicy et la même garde d'écriture que les étapes YAML : un clic « Enregistrer » exige `@mutation` sur le scénario. Si une interprétation ne convient pas, écrire la phrase dans `gherkin.steps` : elle passe alors avant le mode automatique.

Aucune IA : le fichier est lu par le lecteur officiel de Cucumber (`@cucumber/gherkin`), puis chaque phrase est comparée aux modèles, un à un ; le mode automatique n'utilise que des listes de verbes (FR/EN), les valeurs de la phrase et les libellés présents à l'écran.

### Résolution sémantique (intentions sans sélecteur)

Un scénario exprime une **intention fonctionnelle**, sans connaître les libellés exacts, les sélecteurs CSS ni les attributs HTML :

```gherkin
# language: fr
@mutation
Fonctionnalité: Utilisateurs
  Scénario: Création utilisateur
    Étant donné que je suis sur la page des utilisateurs
    Quand je clique sur "Créer un utilisateur"
    Et je renseigne le prénom avec "Mohamed"
    Et je renseigne le nom avec "Diop"
    Et je renseigne le courriel avec "mohamed@example.com"
    Et je sélectionne "Administrateur" comme rôle
    Et je valide le formulaire
    Alors un message de confirmation est affiché
    Et l'utilisateur doit apparaître dans la liste
```

Ce scénario remplit un formulaire dont les champs s'appellent `givenName`, `familyName`, `electronicMail` et `accountType`, et dont le courriel est libellé « Adresse électronique ». Le test d'intégration `tests/integration/semantic-resolution.test.ts` le vérifie sur une vraie page.

```yaml
gherkin:
  semanticResolution:
    enabled: true # désactivée par défaut : les scénarios existants se traduisent comme avant
    autoResolveThreshold: 0.85 # score minimal pour agir seul
    ambiguityMargin: 0.15 # écart minimal avec le deuxième candidat
    minCandidateScore: 0.25 # en dessous : pas un candidat
    historicalKnowledge: true # les résolutions réussies des runs précédents départagent
    explain: true # l'explication dans le rapport
    vocabulary:
      fields: { matricule: [matricule, numéro d'employé, employee id] }
      actions: { submit: [soumettre la demande] }
```

**Chemin d'une phrase** : Gherkin → intention (`FILL prénom`, sans sélecteur) → écran observé (ActionDiscovery, FormAnalyzer) → SemanticResolver → candidats → score → décision → localisateur → **SafetyPolicy** → exécution → ExplorationListener → KnowledgeBase. Le resolver ne clique, ne remplit et ne navigue jamais : il trouve une cible. L'exécution reste celle des flows. Une action interdite reste interdite : `je valide le formulaire` exige `@mutation`, comme `je clique sur "Enregistrer"`.

**Phrases reconnues** (FR et EN, seulement quand aucune phrase de l'équipe ni phrase intégrée ne correspond) :

| Intention   | Exemples                                                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NAVIGATE`  | je suis sur la page des utilisateurs · j'ouvre les paramètres · j'accède à la gestion des rôles · I go to the settings                                        |
| `CLICK`     | je clique sur le bouton créer · I click on new user                                                                                                           |
| `FILL`      | je renseigne le prénom avec "X" · je saisis "X" dans le courriel · I fill in the first name with "X" · I enter "X" in the email field                         |
| `SELECT`    | je sélectionne "Administrateur" comme rôle · je choisis "Annuel" pour la fréquence · I select "Admin" as role                                                 |
| `CHECK`     | je coche la case compte actif · je décoche les notifications · I check terms                                                                                  |
| `SUBMIT`    | je valide le formulaire · j'enregistre · j'annule · je passe à l'étape suivante · je reviens en arrière · I save · I cancel · I continue                      |
| `FILL_FORM` | je remplis le formulaire utilisateur avec : (tableau \| champ \| valeur \|) · je remplis le formulaire utilisateur (données synthétiques du TestDataProvider) |
| `ASSERT`    | la page Utilisateurs est affichée · un message de confirmation est affiché · l'utilisateur doit apparaître dans la liste · l'utilisateur doit être créé       |
| `UPLOAD`    | je joins "cv.pdf" dans le curriculum (reconnue pour être **refusée** : jamais de téléversement automatique)                                                   |

**Phrases métier** : elles sont aussi reconnues à la 3e personne ou sans sujet, telles que le métier les écrit.

| Phrase                                                                                           | Intention                                                          |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `l'utilisateur renseigne le prénom avec "Julie"`, `Et valide le formulaire` (sujet sous-entendu) | la même que `je renseigne…`, `je valide…` (liste fermée de verbes) |
| `modifie le code de catégorie de <Code> à <Nouveau code>` (aussi `en`, `pour`, `remplace … par`) | `FILL` du champ avec la **nouvelle** valeur                        |
| `accède à l'étape "Analyse" à l'onglet "Détails" et à la section "Activité"`                     | trois `NAVIGATE`, dans l'ordre                                     |

Les valeurs d'**Exemples** s'écrivent sans guillemets. Dans un `Étant donné`, « un dossier est créé » est une précondition : elle se traduit dans `gherkin.steps` (`run: creer-dossier`), jamais en vérification. Avec `auto: true` en plus, les phrases que la résolution sémantique ne reconnaît pas (« le code 222 est affiché ») passent au mode automatique.

**Score d'un champ** : chaque composante est affichée avec ses points. Le score vaut `points / 80`, borné à [0, 1]. L'écart avec le deuxième candidat se mesure sur les points bruts.

| Composante                                                                           | Points                                                 |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| libellé réel identique (normalisé : casse, accents, ponctuation, camelCase, pluriel) | +70                                                    |
| libellé qui contient l'intention                                                     | +40 − 5 par mot en trop (au moins +20)                 |
| alias du vocabulaire (« courriel » → email ← libellé « Adresse électronique »)       | +70 si le libellé est l'alias, +30 s'il le contient    |
| libellé d'un autre concept (« Prénom » pour « nom »)                                 | −20                                                    |
| attribut `name`, `id` stable ou `placeholder` qui nomme ou signifie l'intention      | +12 à +25                                              |
| `autocomplete` normalisé (`given-name` → prénom)                                     | +25                                                    |
| type attendu par le concept (email, tel, date, number…)                              | +15, ou −30 pour un type contraire                     |
| valeur compatible avec le type (`test@example.com` → `type=email`)                   | +15                                                    |
| valeur que le champ refuserait (un texte dans une date)                              | −120                                                   |
| la valeur et le champ ont le même sens (un courriel dans le champ courriel)          | +30, sinon −15                                         |
| genre de champ (une liste pour SELECT, une case pour CHECK)                          | +10, ou −30                                            |
| option trouvée dans la liste                                                         | +15 ; introuvable −40                                  |
| même formulaire que l'étape précédente · premier plan                                | +5 · +3                                                |
| historique (ConfidenceEngine)                                                        | jusqu'à +15, seulement pour un candidat déjà plausible |

**Priorité des preuves** : la phrase du scénario, puis le libellé réel et l'accessibilité, les attributs HTML, le type, la valeur, le contexte, et l'historique en dernier. L'historique départage des candidats ; il ne renverse jamais une preuve forte du DOM. Quand l'interface change (`email` devient `contactEmail`, avec un libellé clair), la nouvelle cible est choisie.

**Règle d'ambiguïté** (la même pour les champs, les options, les boutons et la navigation) :

- `meilleur ≥ autoResolveThreshold` et `meilleur − deuxième ≥ ambiguityMargin` → `RESOLVED` ;
- aucun candidat au-dessus de `minCandidateScore` → `NOT_FOUND` ;
- sinon → `AMBIGUOUS`. Avec « Adresse principale » et « Adresse de facturation », la phrase « je renseigne l'adresse » donne `AMBIGUOUS_FIELD`, jamais le premier champ ;
- un champ de paiement ou un téléversement donne `BLOCKED`.

Une étape non résolue échoue avec l'explication et les candidats.

**Formulaire complet** : le tableau est résolu en entier **avant** la première saisie, par un appariement global déterministe (les paires les plus sûres d'abord, un champ par ligne). Deux lignes qui revendiquent le même champ avec des scores proches sont `AMBIGUOUS`. Le plan est converti en `FormFillPlan`, compatible avec la FormFillStrategy.

**Vérifications** :

- « la page … est affichée » : `PASSED` si un titre de section, le titre ou le libellé de l'écran nomme la page. Une simple mention donne `MANUAL`, et une autre page `FAILED`.
- « un message de confirmation » : une alerte, un statut ou une notification classés confirmation ou erreur.
- « … apparaît dans la liste » : les valeurs d'identité saisies (noms, sinon courriel) sont visibles.
- « … doit être créé » : la dernière écriture a réussi, sans message d'erreur.

Une preuve faible reste `À VÉRIFIER`, jamais un PASS.

**Mémoire** : chaque résolution exécutée devient une transition de connaissance `écran —intent:fill:courriel→ cible`. La cible est enregistrée par sa signature sémantique (libellé, name, type, autocomplete), jamais par un id DOM généré comme `#mat-input-23`. Cette transition va dans la KnowledgeBase en mémoire (fichier de connaissance) et, avec la persistance, dans `transition_knowledge`, sans nouvelle table. Au run suivant, le ConfidenceEngine note ce signal : 147 réussites sur 148 donnent un signal fort (+14), 1 sur 1 un signal faible (+3). Le resolver ne fait aucune requête SQL. Avec `memory.enabled: false`, seul le run courant compte, et PostgreSQL ou SQL Server ne sont jamais nécessaires.

**Traçabilité** :

- Le journal `engine-log.jsonl` reçoit `SEMANTIC_RESOLUTION_SUCCEEDED`, `…_FAILED` et `…_AMBIGUOUS`.
- `result.json` contient `flows[].steps[].resolution` : statut, cible, score, niveau, type de valeur, raisons, candidats et explication.
- Le rapport HTML affiche la « Résolution Gherkin » de chaque étape.

Aucune valeur saisie n'est écrite : le type de la valeur (`EMAIL`) peut l'être, et une variable d'environnement donne `Value: [REDACTED]`.

**Performance** : tout le matching se fait en mémoire. Temps mesurés (`tests/unit/semantic-assertions-bench.test.ts`) :

| Champs | Une résolution | Un tableau de 5 lignes |
| ------ | -------------- | ---------------------- |
| 10     | ≈ 1 ms         | ≈ 3 ms                 |
| 50     | ≈ 3 ms         | ≈ 6 ms                 |
| 100    | ≈ 5 ms         | ≈ 12 ms                |
| 500    | ≈ 22 ms        | ≈ 55 ms                |

Autres exemples : `tests/fixtures/features/semantic-users.feature` (création, tableau, assistant) et `semantic-users-en.feature` (phrases anglaises sur un écran français).

## Dry Run : confronter un scénario à l'application

`qa-crawler dry-run` prend le scénario d'un développeur (`.feature` ou `flow.yaml`) et vérifie s'il correspond **vraiment** à l'application. Le scénario n'est pas une suite d'actions à rejouer aveuglément : c'est une liste ordonnée d'**intentions**, des points de passage. Quand une étape ne correspond pas, l'analyse **ne s'arrête pas** : exploration guidée vers cette étape ou les suivantes, puis, à la fin seulement, **une** réconciliation et **un** flow suggéré complet. Le fichier d'origine n'est jamais modifié.

```bash
npm run qa -- dry-run features/create-user.feature -c mission.yaml
npm run qa -- dry-run flows/create-user.flow.yaml -c mission.yaml --output-format both
npm run qa -- dry-run create-user.feature --base-url https://qa.example.com --no-history --max-actions 60
npm run qa -- dry-run features/create-user.feature -c mission.yaml --isolated-memory
npm run qa -- dry-run --help
```

```
flow du développeur (EXPECTED) → FlowIntentGraph → application réelle (OBSERVED)
      → réconciliation → flow suggéré (SUGGESTED) → suggested.feature + suggested.flow.yaml
```

Les trois restent séparés : **EXPECTED** (le scénario), **OBSERVED** (ce que l'application a montré), **SUGGESTED** (la proposition).

**Exemple.** Le scénario dit :

```gherkin
Étant donné que je suis connecté
Quand je vais dans Utilisateurs
Et je crée un utilisateur
Alors l'utilisateur apparaît dans la liste
```

L'application passe par le tableau de bord, l'administration et un assistant en trois écrans :

```
Original                        Suggested
─────────────────────────────────────────────────────────
je suis connecté           ✓    je suis connecté
                           +    Administration
Utilisateurs               ✓    Utilisateurs
Créer un utilisateur       ✓    Créer un utilisateur
                           +    (formulaire) Suivant
                           +    (formulaire) Suivant
                           +    Confirmer la création
Utilisateur créé           ✓    Utilisateur créé

Scenario status : PARTIALLY_MATCHED · 4 matched · 4 inserted · 0 possibly obsolete
```

Le test de bout en bout `tests/integration/dry-run.test.ts` le vérifie dans Chromium, en Gherkin et en YAML : même flow suggéré.

**Une étape à la fois, sans jamais conclure trop tôt :**

1. L'intention est-elle sur l'écran ? (SemanticResolver pour une phrase d'intention, localisateur pour une étape YAML, lecture seule pour une vérification.) Oui : elle est exécutée, avec la SafetyPolicy des flows imposés.
2. Non : **exploration guidée** vers elle et vers les 3 suivantes. D'abord une étape suivante déjà à l'écran (l'attendue est dépassée). Ensuite les **chemins connus** (graphe du run, graphe mémorisé, KnowledgeBase) : la mémoire propose, l'application confirme, chaque pas est rejoué sur l'écran réel. Enfin une recherche best-first, les écrans les plus proches d'abord.
3. Une intention dépassée est mise de côté, réessayée après chaque étape trouvée (**réordonnancement**), puis qualifiée à la fin. Elle est aussi guettée sur **chaque écran intermédiaire** de l'exploration guidée : si elle y apparaît en cherchant une autre étape, elle est exécutée là, marquée `REORDERED` (trouvée plus tard que prévu), jamais `MISSING`.

**Score de l'exploration guidée :** le score du moteur de décision existant (ActionScorer, AdaptiveScoring), plus la proximité avec l'intention cherchée (mots, concepts du dictionnaire, adresse du lien), le premier pas d'un chemin connu, la progression (un bouton de formulaire vers un résultat attendu) et la nouveauté ; moins la répétition, l'instabilité et le risque. Un couple (écran, intention) déjà cherché ne l'est jamais deux fois.

**Sécurité, toujours :** une étape du scénario passe par la SafetyPolicy des flows (`allow`, tags `@mutation`…). Une étape **insérée**, que le développeur n'a pas écrite, passe par la SafetyPolicy **de la mission** ET les permissions du scénario. Une action refusée pour une étape attendue n'est jamais exécutée par l'exploration guidée non plus. Une piste qui exige une action refusée donne `BLOCKED_BY_POLICY`, jamais `UNREACHABLE`.

| Statut               | Signification                                                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `MATCHED`            | l'étape du scénario, retrouvée et exécutée                                                                             |
| `INSERTED`           | une étape de l'application absente du scénario (observée)                                                              |
| `REORDERED`          | l'étape existe, ailleurs dans l'ordre                                                                                  |
| `ALTERNATIVE`        | une étape d'un autre chemin valide, **vu dans ce run** ; celui qui a été utilisé est proposé, l'autre est cité         |
| `POSSIBLY_OBSOLETE`  | introuvable, les étapes suivantes ont été trouvées sans elle ; **jamais supprimée** : gardée en commentaire pour revue |
| `MISSING`            | la cible existe dans l'application (vue ailleurs pendant le run), mais pas à cet endroit du flow                       |
| `UNREACHABLE`        | tout l'espace accessible (profondeur et politique permises) a été parcouru sans la trouver                             |
| `AMBIGUOUS`          | plusieurs cibles possibles : jamais choisie au hasard                                                                  |
| `ASSERTION_MISMATCH` | la vérification ne se vérifie pas (le résultat attendu n'est pas observé)                                              |
| `BLOCKED_BY_POLICY`  | la cible, ou le seul chemin trouvé, exige une action refusée : jamais exécutée                                         |
| `NOT_VERIFIED`       | budget épuisé, vérification manuelle, ou page de départ inaccessible                                                   |

Chaque ligne donne sa **confiance**, ses **raisons** et ses **preuves** (écran, action, provenance, champs remplis). Pour `POSSIBLY_OBSOLETE`, l'historique change la confiance : une étape vue lors de runs précédents a peut-être seulement bougé (0,4) ; jamais vue (0,7) ; sans mémoire (0,6). Une fréquence historique (« 97 % des runs ») est une fréquence observée, jamais une probabilité d'être correcte.

**Statut global** (jamais un booléen) : `FULLY_MATCHED` (le scénario tel quel), `PARTIALLY_MATCHED` (tout est retrouvé, avec des étapes en plus, ailleurs ou alternatives), `DIVERGED` (une étape introuvable, obsolète ou un résultat différent), `BLOCKED`, `INCONCLUSIVE` (budget, ambiguïté).

**Flow suggéré.** Chaque étape a sa **provenance** : `ORIGINAL` (l'étape du scénario), `OBSERVED` (vue pendant ce run) ou `HISTORICAL_CONFIRMED` (proposée par la mémoire et confirmée sur l'application). Une étape seulement historique n'est jamais présentée comme observée. Un clic qui a rempli un formulaire avec des données de test est précédé de « je remplis le formulaire » (intention `FILL_FORM`, qui exige `gherkin.semanticResolution.enabled: true`). Les deux formats viennent du même `SuggestedFlowGraph`, quelle que soit l'entrée :

- `suggested.feature` : les phrases du projet (phrases intégrées et d'intention, FR ou EN selon le `.feature` d'origine ou `report.language`), les phrases d'origine reprises telles qu'écrites, `@mutation` si besoin, jamais un sélecteur CSS/XPath ;
- `suggested.flow.yaml` : le schéma des flows du projet (validé par `flowSchema`), statut et provenance en commentaire.

**Fichiers** (`<reportsDir>/dry-run/<scénario>/`) : `expected-flow.json` (sans les valeurs saisies), `observed-flow.json`, `suggested-flow.json`, `reconciliation.json`, `suggested.feature`, `suggested.flow.yaml`, `dry-run-events.jsonl`, `index.html` (original et suggéré côte à côte, explication de chaque différence), et `exploration/` (le rapport du run sous-jacent : graphe, journal, captures). Un fichier avec plusieurs scénarios, ou un Plan du scénario, donne un sous-dossier par flow.

**Événements** (journal du moteur, masqués comme les autres) : `DRY_RUN_STARTED`, `FLOW_INTENT_PARSED`, `INTENT_MATCHED`, `INTENT_MISMATCH`, `GUIDED_EXPLORATION_STARTED`, `PATH_DISCOVERED`, `FLOW_STEP_INSERTED`, `FLOW_STEP_POSSIBLY_OBSOLETE`, `FLOW_STEP_REORDERED`, `FLOW_STEP_AMBIGUOUS`, `FLOW_RECONCILIATION_COMPLETED`, `SUGGESTED_FLOW_GENERATED`, `DRY_RUN_COMPLETED`.

```yaml
dryRun:
  continueAfterMismatch: true # false : arrêt au premier écart (le reste : NOT_VERIFIED)
  useHistoricalKnowledge: true # chemins connus d'abord (mémoire activée) ; --use-history / --no-history
  maxDepth: 15 # actions au plus entre deux intentions retrouvées
  maxActions: 100 # actions de l'exploration guidée au plus
  maxDurationMs: 120000
  maxAlternativePaths: 5 # actions essayées au plus par écran, chemins connus rejoués au plus
  suggestion: { generateGherkin: true, generateYaml: true } # --output-format gherkin | yaml | both
```

La mission donne la cible, la connexion, la sécurité, `gherkin.steps` et les flows `reusable` ; ses autres flows sont ignorés. Une mission donnée comme scénario (`dry-run scenarios/ma-mission.yaml`) vérifie ses propres flows, avec sa cible et sa connexion. Sans mission : `--base-url` (ou `QA_BASE_URL`). En Dry Run, le **mode automatique** et la **résolution sémantique** sont actifs par défaut : une phrase métier inconnue n'arrête pas le chargement, elle devient une intention à vérifier sur l'écran (`gherkin.auto: false` dans la mission les coupe). Sans mémoire ni persistance, le Dry Run n'utilise que l'exploration courante : aucune base de données n'est nécessaire.

**Connaissance partagée :** le Dry Run lit et enrichit le **même** fichier de connaissance que les runs de la mission (`knowledge.file`, par défaut `knowledge/knowledge-base.json` à côté du dossier des rapports) : ce qu'il découvre sert aux runs suivants, et inversement. `--isolated-memory` le garde à part, dans `<reportsDir>/dry-run/<scénario>/knowledge/` (pour essayer sans toucher la mémoire de la mission).

**Codes de sortie :** `0` FULLY_MATCHED ou PARTIALLY_MATCHED, `1` DIVERGED, BLOCKED ou INCONCLUSIVE, `2` usage ou scénario invalide, `3` erreur d'exécution.

**Limites.** Une exploration peut ne pas suffire : `POSSIBLY_OBSOLETE` n'est jamais une suppression. Une étape déjà sur l'écran courant peut dépasser une étape attendue plus loin (elle est alors réessayée après chaque étape trouvée). L'exploration guidée remplit un formulaire avant son bouton avec les données de test, mais ne remplit pas de champ isolé. Une action de modification exécutée pendant la recherche n'est pas annulée : elle n'est permise qu'avec `@mutation` (ou `allow: MUTATION`) ET une mission qui l'autorise, et compte dans le budget de modifications.

## Authentification

Les identifiants viennent toujours de variables d'environnement (`QA_USERNAME` / `QA_PASSWORD` par défaut, voir `usernameEnv` / `passwordEnv`), jamais du fichier de mission. Ils ne sont jamais écrits dans les logs ni dans les rapports.

**Page de connexion** (un formulaire dans la page, y compris une page SSO comme un formulaire SiteMinder `login.fcc`) :

```yaml
auth:
  type: form
  loginUrl: /login # ou l'URL de l'application qui redirige vers la page SSO
  usernameSelector: input[name="USER"]
  passwordSelector: input[type="password"]
  submitSelector: button[type="submit"]
  successUrlContains: /app/ # retour sur l'application = connecté
```

**Fenêtre de connexion du navigateur** (la boîte grise « Connexion » : HTTP Basic, par exemple le schéma Basic de SiteMinder ; NTLM selon le serveur) :

```yaml
auth:
  type: http
  origin: https://sso.example.com # n'envoyer les identifiants qu'à ce serveur (recommandé)
  checkUrl: / # page chargée pour vérifier la connexion (défaut : target.startAt)
```

Rien n'est tapé dans une page : cette fenêtre ne fait pas partie du DOM. Elle est détectée et traitée par le protocole du navigateur, via le `HttpAuthHandler` (voir [Interactions navigateur](#interactions-navigateur)). `auth.type: http` est un raccourci vers un profil d'identifiants nommé `auth`. Sans `origin`, les identifiants ne partent que vers la cible et ses hôtes autorisés. `AUTH_REQUIRED`, `AUTH_FAILED` ou `CREDENTIALS_NOT_ALLOWED` sur `checkUrl` arrête le run avec un message clair.

### Connexion SSO dans une popup (SiteMinder, NTLM)

Certaines applications ouvrent une **popup** vers le serveur SSO (par exemple `https://sso.example.com/siteminderagent/ntlm/smntlm.ntc?…`), et c'est dans cette popup que le navigateur affiche sa fenêtre « Se connecter ». La popup commence à charger avant que le crawler puisse s'y attacher : le défi est mémorisé, puis le chargement de la popup est rejoué une fois pour que le `HttpAuthHandler` y réponde.

```yaml
safety:
  allowedHosts: [app.example.com, sso.example.com] # la popup SSO doit être autorisée

credentials:
  sso: { usernameEnv: QA_USERNAME, passwordEnv: QA_PASSWORD }

browserInteractions:
  httpAuth:
    credentialProfile: sso
    origins: [https://sso.example.com] # seul serveur qui reçoit les identifiants
  popups:
    closeAfterMs: 10000 # laisser la popup se connecter puis se refermer ou rediriger seule
```

Exemple complet : [`scenarios/sso-popup.yaml`](scenarios/sso-popup.yaml). Pour NTLM, le nom d'utilisateur peut devoir être au format `DOMAINE\utilisateur`.

`FORM_AUTH` (un formulaire de connexion dans la page) reste dans le monde du DOM : `auth.type: form`, ou un flow imposé. `HTTP_AUTH` (la fenêtre du navigateur) est une interaction navigateur. Les deux mécanismes ne sont jamais mélangés.

## Interactions navigateur

Certaines interactions viennent du navigateur lui-même, pas du DOM de l'application : on ne peut pas les trouver avec des localisateurs, et elles peuvent bloquer un flow sans bruit. Le `BrowserInteractionManager` les détecte, les classe, applique la politique de sécurité, les confie à un gestionnaire (handler), enregistre ce qui s'est passé, puis laisse le crawl continuer.

```
DOM ActionDiscovery ─────────────────────────────────────────────┐
                                                                 ├─► Playwright ─► Chromium
Browser Event Discovery ─► BrowserInteractionManager ─► handlers ┘
 (événements Playwright + CDP)  anti-boucle · SafetyPolicy ·       HttpAuth · Dialog · Popup ·
                                retry · timeout · enregistrement   Download · FileChooser ·
                                                                   Permission · ExternalNavigation
```

| Type                          | Source                                         | Comportement par défaut                                                                                                   |
| ----------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `HTTP_AUTH`                   | protocole du navigateur (`Fetch.authRequired`) | identifiants d'un profil, vers les origines de confiance seulement ; sinon `AUTH_REQUIRED` et la transition est `BLOCKED` |
| `JS_ALERT`                    | `page.on('dialog')`                            | acceptée (OK)                                                                                                             |
| `JS_CONFIRM`                  | `page.on('dialog')`                            | refusée ; avec `confirm: accept-safe`, acceptée seulement si le message n'est ni destructif ni modifiant                  |
| `JS_PROMPT`                   | `page.on('dialog')`                            | répondu seulement avec une valeur de `promptValues` ; sinon refusé, `PROMPT_VALUE_REQUIRED`                               |
| `POPUP` / `NEW_TAB`           | `context.on('page')` (avec / sans ouvreur)     | origine autorisée : observée comme nouvel état lié à l'action (`CLICK → POPUP → page`), puis fermée                       |
| `DOWNLOAD`                    | `page.on('download')`                          | action, nom du fichier, type MIME et taille enregistrés ; le fichier n'est jamais sauvegardé ni ouvert                    |
| `FILE_CHOOSER`                | `page.on('filechooser')`                       | ne s'ouvre jamais, aucun fichier choisi : `FILE_INPUT_REQUIRED`                                                           |
| `PERMISSION_REQUEST`          | script d'initialisation autour des API         | refusée sauf si listée dans `permissions.grant`                                                                           |
| `EXTERNAL_NAVIGATION`         | navigation de la page principale               | classée (`SAME_ORIGIN`, `ALLOWED_ORIGIN`, `EXTERNAL_ORIGIN`, `BLOCKED_ORIGIN`), non explorée                              |
| `UNKNOWN_BROWSER_INTERACTION` | par exemple les dialogues `beforeunload`       | `UNSUPPORTED`, repli sûr                                                                                                  |

```yaml
credentials: # uniquement des NOMS de variables d'environnement, jamais de secrets
  qa-default: { usernameEnv: QA_USERNAME, passwordEnv: QA_PASSWORD }

browserInteractions:
  enabled: true
  timeoutMs: 15000 # durée maximale d'un gestionnaire
  retry: { maxAttempts: 2 } # ex. identifiants refusés : 2 essais, puis AUTH_FAILED
  loopThreshold: 5 # même interaction (type, origine, action) plus souvent : INTERACTION_LOOP_DETECTED
  blockedOrigins: [] # jamais suivies ni considérées comme de confiance
  httpAuth:
    credentialProfile: qa-default # aucun : AUTH_REQUIRED
    origins: [https://sso.example.com] # qui peut recevoir les identifiants (défaut : cible + hôtes autorisés)
  dialogs:
    alert: accept # accept | dismiss
    confirm: dismiss # dismiss | accept-safe
    promptValues: [{ match: 'Nom du dossier', value: 'Dossier QA' }] # value : texte ou { env: NOM }
  popups: { observe: true, closeAfterMs: 0 } # closeAfterMs : laisser une popup SSO finir seule (ex. 10000)
  permissions: { grant: [] } # geolocation, notifications, camera, microphone, clipboard-read, clipboard-write
```

**Résultats.** Chaque interaction est enregistrée avec :

- son type et son statut (`DETECTED`, `HANDLED`, `BLOCKED`, `FAILED`, `SKIPPED`, `UNSUPPORTED`) ;
- son résultat (`AUTHENTICATED`, `AUTH_REQUIRED`, `AUTH_FAILED`, `INTERACTION_LOOP_DETECTED`, `FILE_INPUT_REQUIRED`…) ;
- le gestionnaire et l'action, l'état et l'action d'origine, la cible, la classe d'origine, la tentative, et des détails sans secret.

Où les retrouver :

- dans `result.json` (`browserInteractions`, `stats.interactionsByType` / `interactionsByStatus`), dans `index.html` (section _Interactions navigateur_) et dans `flow-graph.json` (`interactions`). Les popups et nouveaux onglets ajoutent aussi une transition vers la page observée ;
- les interactions bloquantes (`AUTH_REQUIRED`, `AUTH_FAILED`, `CREDENTIALS_NOT_ALLOWED`, boucles) font passer la transition en `BLOCKED` et créent une anomalie `ERROR` ; `FILE_INPUT_REQUIRED`, `PROMPT_VALUE_REQUIRED` et les interactions non gérées créent un `WARNING` ;
- le terminal affiche une ligne structurée par interaction : `[BROWSER_INTERACTION] type=HTTP_AUTH origin=https://… handler=HttpAuthHandler status=HANDLED outcome=AUTHENTICATED attempt=1`.

**Secrets.** Les identifiants sont fournis par un `CredentialProvider` (aujourd'hui les variables d'environnement ; un coffre-fort ou un gestionnaire de secrets peut implémenter la même interface), seulement quand une origine de confiance les demande, et ne sont transmis qu'au navigateur. Ils n'apparaissent jamais dans la mission, le graphe des flows, les logs, les rapports ni les captures ; seul le nom du profil (`credentialProfile: "qa-default"`) est enregistré.

**Extension.** Une nouvelle interaction demande une source dans `BrowserEventDiscovery`, une règle dans `InteractionPolicy` et un `BrowserInteractionHandler` enregistré dans le manager. Le crawl engine ne change pas.

## Sécurité

L'explorateur est fait pour être lancé sur de vrais environnements sans les casser.

**1. Chaque action est classée** par la `SafetyPolicy` :

- un vocabulaire français/anglais, comparé sur des mots entiers sans accents ;
- le libellé de l'élément, la cible du lien, son `routerLink` et la fenêtre qui le contient (« Confirmer » dans « Supprimer l'utilisateur ? » est DANGEROUS).

| Classe      | Exemples                                                                                                              | Exécutée ?                                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `SAFE`      | navigation, onglets, menus, détails, pagination, recherche, filtres, « Suivant » d'un assistant, champ (non sensible) | oui, si son type est dans `safety.allow`                                                                         |
| `MUTATION`  | créer, enregistrer, modifier, update, submit (envoi de formulaire), oui/ok/confirmer                                  | **jamais** par défaut ; avec `safety.mutations`, dans un budget                                                  |
| `DANGEROUS` | supprimer/delete, payer/payment, checkout, envoyer/send, réinitialiser, déconnexion/logout, champs sensibles          | **jamais** par défaut ; seulement si listée dans `allowedActionClasses` (et son risque retiré de `safety.block`) |
| `UNKNOWN`   | contrôles sans libellé lisible (`⚙`, `×`, icône seule)                                                                | **jamais**                                                                                                       |

**2. Le contrôle a lieu après la décision et avant l'exécution.** `SafetyPolicy.evaluate()` bloque une action dans ces cas :

- elle est désactivée ou cachée ;
- elle porte un risque bloqué ;
- elle navigue hors des hôtes autorisés, vers un chemin ignoré ou vers un téléchargement ;
- sa classe n'est pas autorisée ;
- son type n'est pas dans `safety.allow`.

Un futur moteur de décision, même un LLM local ou dans le cloud, ne peut pas contourner ce contrôle.

**3. Les actions bloquées sont enregistrées** dans le graphe (transitions `BLOCKED`, avec la raison) et affichées dans les rapports.

**4. Les données sensibles ne sont jamais remplies automatiquement**, quelle que soit la configuration :

- mots de passe ;
- cartes de paiement (`autocomplete="cc-*"`, numéro de carte, CVV, IBAN) ;
- codes OTP, secrets, numéros de sécurité sociale.

Un [flow imposé](#créer-un-flow-de-test-imposé) peut remplir un mot de passe ou un secret seulement avec une valeur lue dans une variable d'environnement (`value: { env: NOM }`). Les champs de paiement ne sont jamais remplis.

**5. Les interactions du navigateur** (`alert`, `confirm`, `prompt`, nouvelles fenêtres, téléchargements…) passent par le [Browser Interaction Manager](#interactions-navigateur) : une confirmation destructive n'est jamais acceptée, aucune valeur n'est inventée, aucun fichier n'est choisi ni sauvegardé, et l'exploration reste dans un seul onglet.

**6. Aucun secret dans les sorties.** Jetons, mots de passe, en-têtes `Authorization`, cookies, JWT et paramètres d'URL sensibles sont masqués dans les logs, le journal moteur et les rapports. Les en-têtes, corps de requêtes et valeurs des champs sensibles ne sont jamais enregistrés. Un test d'intégration dédié (`tests/integration/security-artifacts.test.ts`) vérifie qu'aucun mot de passe, cookie, jeton Bearer, clé d'API ou jeton d'URL n'apparaît dans `result.json`, `flow-graph.json`, les rapports HTML ou `engine-log.jsonl`.

**7. Les actions DANGEROUS ne sont exécutées que sur demande explicite.** Il faut ajouter `DANGEROUS` à `safety.allowedActionClasses` (un avertissement le rappelle à chaque run). Les risques encore listés dans `safety.block` restent bloqués : pour laisser l'explorateur supprimer, retirez aussi `delete` de `block`. Les champs sensibles (mot de passe, carte…) ne sont jamais remplis automatiquement, et les actions DANGEROUS comptent dans le budget de `safety.mutations`. Dans un flow imposé, l'étape doit en plus dire `allow: DANGEROUS`. À réserver aux environnements jetables.

```yaml
safety:
  allowedActionClasses: [SAFE, MUTATION, DANGEROUS]
  block: [payment, logout, sensitive-data, external-navigation, download] # delete retiré : les suppressions s'exécutent
```

## Détection des états et protection contre les boucles

Un état n'est pas une URL :

- `/dossiers/create` peut afficher les étapes 1, 2 et 3 ;
- un onglet ou une fenêtre change l'écran sans changer la route.

Le `StateDetector` calcule une empreinte de chaque observation à partir de plusieurs signaux :

- le modèle de route ;
- le titre et les en-têtes ;
- les fenêtres ouvertes, les onglets sélectionnés et les éléments `aria-current` ;
- les contrôles visibles (rôle et nom), sans les liens de données ni les menus ;
- les champs de formulaire.

Ce qui change avec les données est masqué : identifiants générés (UUID, hash, jetons), e-mails, dates, heures, compteurs et numéros. `/users/1` et `/users/2` (« Utilisateur 1/2 »), « Commentaires (3) » et « Commentaires (12) » donnent le même état. Les notifications, régions `aria-live` et minuteurs, qui vont et viennent, ne comptent pas. L'ordre des contrôles non plus.

Deux étapes d'un assistant sur la même URL restent deux états : `/dossiers/create` avec les champs Client, Produit, Date et les boutons Continuer, Annuler n'est pas le même état que le récapitulatif avec Précédent et Confirmer.

Le résultat est un `stateId` lisible et stable, par exemple `parametres-securite-f3a0baba`.

**Retour en arrière :** une pile logique du chemin parcouru est tenue. Quand un état n'a plus d'action intéressante, le moteur remonte vers le dernier état qui en a encore : les ancêtres épuisés sont sautés sans y retourner (le moteur de décision est consulté sur leur dernière observation). Pour y revenir : fermer le calque du dessus, puis `goBack()` en vérifiant le `stateId`, puis l'URL connue, puis le chemin connu du graphe rejoué depuis l'accueil.

**Ce qui est devant l'écran passe en premier :**

- une fenêtre (`role=dialog`, `aria-modal`, `<dialog>`), un tiroir, un menu déroulant ou une liste d'options flottants (`role=menu` / `listbox`, `.cdk-overlay-pane`) sont détectés comme **premier plan** ;
- un **overlay sans rôle ARIA** est aussi détecté : un calque `fixed`/`absolute` qui couvre la majeure partie de l'écran (fond grisé + boîte) ;
- en mode exploration, les actions du premier plan sont essayées avant celles de la page derrière ;
- les calques s'empilent : un calendrier ouvert depuis une fenêtre pose son propre fond (transparent) sur la fenêtre. Seul le calque du dessus est au premier plan ; un élément dont le point de clic tombe sur un autre calque est masqué et n'est pas cliqué ;
- derrière un calque **modal**, la page est marquée masquée (`obscured`) et n'est pas cliquée tant que le calque est ouvert. Derrière un calque non modal (bandeau cookies), la page reste explorée ensuite ;
- les éléments du premier plan sont gardés même au-delà de la limite d'éléments observés, et un overlay ouvert donne un état distinct ;
- pour revenir à l'écran du dessous, le crawler **ferme d'abord le calque du dessus** (touche Échap, sinon son bouton « Fermer » / « Close ») au lieu de recharger la page : la fenêtre et ce qui y est saisi sont conservés ;
- un titre, une fenêtre ou un bloc de texte qui prend seulement le focus (`tabindex="0"` sans curseur de clic ni rôle interactif) n'est pas une action ;
- un clic pris par un autre élément échoue vite (≈ 2,5 s) avec le coupable dans le rapport : « clic intercepté par `<div class="cdk-overlay-backdrop">` ».

**Contrôles semblables :** les jours d'un calendrier, les numéros de page ou le « Voir » de chaque ligne ne sont pas essayés un par un : `exploration.maxSimilarActions` (2 par défaut) exemples par écran suffisent.

Après un échec, si l'écran de départ ne peut pas être retrouvé (fenêtre fermée par le rechargement), l'exploration repart de ce qui est réellement affiché au lieu d'essayer les actions de l'écran perdu.

**Protection contre les boucles :**

- chaque action essayée depuis un état est mémorisée dans le graphe et jamais réessayée ;
- `maxStatesPerRoute` limite à la fois les états et les navigations par modèle de route, y compris les UUID, empreintes, dates et `?page=N` ;
- les onglets déjà sélectionnés et ceux déjà ouverts depuis un état voisin sont ignorés, et rien n'est décoché ;
- un lien déjà suivi depuis un autre état n'est pas suivi à nouveau ;
- revenir sur un état déjà présent dans le chemin raccourcit le chemin, ce qui gère la navigation circulaire ;
- les boucles de redirection sont détectées ;
- toutes les limites de la mission s'appliquent.

## Formulaires

En exploration, un écran qui contient des champs est d'abord **rempli comme le ferait un utilisateur**, puis vérifié. Rien n'est envoyé par défaut.

- **Un formulaire, même sans `<form>`.** Les champs d'un `<form>`, ou ceux d'une fenêtre ou d'un calque (les fenêtres Angular Material n'ont souvent pas de `<form>`), forment un formulaire. Ce qui est devant l'écran est rempli en premier.
- **Tous les types de champ :** texte, nombre, date (saisie directe ou champ avec calendrier), heure, liste native `<select>`, liste Material (`mat-select`, `role=combobox`) ouverte puis choisie, groupe de boutons radio (une option par groupe), case à cocher (obligatoires seulement). Les radios et cases stylées (input natif masqué) sont gérées.
- **Champ déjà rempli** (date proposée par défaut…) : laissé tel quel.
- **Ce que le formulaire attend** (`FormAnalyzer`) : pour chaque champ, son type (texte, e-mail, téléphone, URL, nombre, date, heure, liste, liste Material, autocomplétion, case, radio…), obligatoire, désactivé, min/max, longueurs, motif, options (et celles désactivées ou « -- Choisir -- »), aide affichée, sensibilité. Les boutons qui l'envoient ou font avancer un assistant sont repérés. Avec un contrat OpenAPI (`openapi`), les contraintes que la page ne déclare pas (format e-mail, longueurs, bornes, valeurs permises) sont complétées ; le DOM reste la référence.
- **Tous les types de formulaire.** `<form>` classique, fenêtres et calques sans `<form>`, pages sans `<form>` (SPA), Angular Material, et **composants web** (Ionic, Shoelace, Lit, Stencil…) : les champs dessinés dans un _shadow root_ ouvert sont trouvés et rattachés au `<form>` qui entoure le composant. Leur libellé vient du composant : `<label for>` interne, contenu de `<slot name="label">`, attribut `label="…"` ou `aria-label` du composant. Les zones `contenteditable` (texte riche, champs personnalisés) sont remplies comme des champs texte. Les _shadow roots_ fermés (`mode: 'closed'`) et les iframes restent hors de portée.
- **Valeurs** (`TestDataProvider`), dans cet ordre de priorité :
  1. celles de la mission, par champ (`testData.fields`, texte ou `{ value: … }`) ;
  2. une règle selon le sens du champ : prénom, nom, entreprise, e-mail, téléphone, code postal, ville, pays, adresse, URL… (surchargeables avec `testData.defaults`), ou l'aide affichée par l'application : `99999` → 5 chiffres, `HH:MM` → `10:00`, `AAAA-MM-JJ` / `JJ/MM/AAAA` → date du jour dans ce format ;
  3. une valeur selon le type : nombres dans min/max/step, dates dans les bornes, première vraie option d'une liste ;
  4. une valeur de repli lisible (`Valeur de test` / `Test value`), sauf pour un champ qui attend des chiffres (voir ci-dessous).
- **Des données cohérentes et compréhensibles.** Chaque run utilise une personne fictive dont toutes les valeurs vont ensemble, dans la langue du rapport (`report.language`) : prénom, nom, e-mail, téléphone, adresse, ville, code postal et pays (par exemple Julie Tremblay, `julie.tremblay.qa-crawler-<runId>@example.test`, 514 555-0101, 1250 rue Principale, Montréal, H2X 1Y4, Canada). Le même run garde toujours la même personne ; les numéros sont réservés à la fiction (555-01xx) et le domaine `example.test` aux tests. Une date de naissance est dans le passé (35 ans), toujours dans les bornes du champ ; les autres dates restent celles du jour. Les textes sont lisibles (`Texte de test`, `Donnée de test saisie automatiquement par QA-Crawler (QA-CRAWLER-<runId>).`).
- **Champs qui attendent des chiffres** sans être `type="number"` : attribut `inputmode="numeric"` ou `"decimal"`, `pattern` fait de chiffres (`\d{5}`, `[0-9]+`), ou aide affichée (`99999`). Ils reçoivent une suite de chiffres de la bonne longueur — celle du motif, sinon le `maxlength` (jusqu'à 10), sinon 5 — et jamais un texte. Un sens qui donne des chiffres (téléphone) est gardé ; un code postal avec des lettres ne l'est pas. L'aide affichée vaut pour tous les champs où l'on tape, autocomplétion comprise.
- **Un champ qui n'accepte que des chiffres sans le dire** (filtrage en JavaScript, sans `inputmode`, `pattern` ni aide) ou **qui doit contenir une valeur existante** (code d'une agence, numéro de dossier connu de l'application) : donnez sa valeur dans la mission.

```yaml
testData:
  fields:
    Code agence: '12345' # le libellé affiché à l'écran ; majuscules, accents et « * » ignorés
    Numéro de dossier: { value: '000123' }
```

- **Données reconnaissables.** Les valeurs créées portent l'identifiant du run quand c'est possible : e-mail `prenom.nom.qa-crawler-<runId>@example.test`, titres et entreprises `Test QA-CRAWLER-<runId>` / `Entreprise Test QA-CRAWLER-<runId>` (`testData.runId`, sinon généré à chaque run). Elles pourront être retrouvées et nettoyées.
- **Un plan, puis l'exécution.** La `FormFillStrategy` produit un plan (champ → remplir / choisir / cocher / ignorer, et pourquoi), exécuté par le `PlaywrightActionExecutor`. Le rapport montre ce plan : ce qui a été saisi (jamais une valeur sensible), la source de la valeur et la réponse de l'application.

```yaml
testData:
  defaults: # par sens de champ
    firstName: QA
    lastName: Crawler
  fields: # libellé, name ou placeholder ; majuscules, accents et « * » ignorés
    email:
      value: qa@example.test
    country: Canada
```

- **Tests de validation** (`forms.validationTesting: true`) : après le remplissage valide, quelques valeurs invalides sont essayées champ par champ — vide pour un champ obligatoire, e-mail ou URL mal formés, sous le minimum, au-dessus du maximum, trop court, trop long, motif non respecté, case obligatoire décochée — puis la valeur valide est remise. Un refus de l'application est un `PASS` ; une valeur invalide acceptée reste `UNKNOWN` (l'application peut la corriger plus tard), jamais un échec inventé. Limites : `maxValidationCasesPerField` (3) et `maxValidationCasesPerForm` (10). Les champs sensibles ne sont jamais testés.

```yaml
testData:
  fields: # libellé, name ou placeholder ; majuscules, accents et « * » ignorés
    'Code agence': '12345'
    'Raison sociale': QA TEST
    'Canal de contact': Téléphone # groupe de radios : l'option à cocher
    'Type de dossier': Ouverture # liste : l'option à choisir
    "M'assigner le dossier": oui # case à cocher
```

- **Validation.** Chaque champ est quitté (comme un utilisateur, ce qui déclenche la validation Angular), puis le crawler relève ce qui reste invalide (`aria-invalid`, `mat-error`, `invalid-feedback`, validation HTML…). Chaque champ refusé devient une anomalie `FORM_VALIDATION` (WARNING) : formulaire, champ, valeur saisie et message de l'application, par exemple `formulaire « Nouveau dossier » : champ « Numéro de dossier » (valeur « QA Test ») : Format attendu : AB-1234`. Elles sont listées dans la section _Validation des formulaires_ du rapport.
- **Rien n'est envoyé par défaut.** Un bouton qui envoie son formulaire (`submit`, ou « Soumettre », « Enregistrer », « Valider », « Créer »… dans un formulaire ou une fenêtre qui contient des champs) porte le risque `form-submit`, bloqué par défaut. Pour l'autoriser : `safety.mutations.enabled: true` (dans un budget, voir [Données créées](#données-créées-et-budget-de-modifications)), `forms.submit: true`, ou `allow: MUTATION` sur l'étape d'un flow imposé. « Suivant » d'un assistant reste une étape.
- **Jamais remplis :** les champs sensibles (mot de passe, carte, IBAN, secret, OTP), même listés dans `testData.fields`.
- Une fois le formulaire rempli, ses champs ne sont pas réessayés un par un. Quand un chemin est rejoué, le formulaire est rempli à nouveau avec les mêmes valeurs.

## Oracles de test

« Le résultat semble-t-il correct ? » Chaque action exécutée est jugée par plusieurs oracles ; leur avis est attaché à la transition (`transitions[].oracle` dans `result.json`) et résumé dans le rapport.

| Oracle      | Ce qu'il regarde                                                                                             | Verdicts                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `technical` | action impossible, plantage, exception JavaScript, HTTP 5xx, 404 d'API, appel en échec, message console      | FAIL (confirmé) · WARNING · PASS                                          |
| `ui`        | message d'erreur apparu, formulaire encore invalide après des données valides, écran vide, chargement infini | WARNING · PASS (confiance faible : rien de visible ne prouve le succès)   |
| `baseline`  | même action, même état de départ : mène-t-elle au même écran que dans la baseline ?                          | PASS · WARNING « régression potentielle » · UNKNOWN (transition inconnue) |
| `contract`  | statut HTTP de chaque appel décrit par le contrat OpenAPI                                                    | PASS · WARNING (statut non déclaré) · UNKNOWN (aucun appel décrit)        |

Le `CompositeTestOracle` agrège : FAIL l'emporte sur WARNING, WARNING sur PASS ; sans avis, **UNKNOWN**. Un UNKNOWN n'est jamais transformé en PASS. Chaque verdict a une **confiance** (0 à 1, un ordre de grandeur, pas une mesure) et des **assertions observées** :

```text
✓ action executable
✓ no HTTP 5xx
✗ POST /api/users returned HTTP 500
? this transition is not in the baseline
? business result unknown
```

Sans attente métier connue, le résultat métier reste `? business result unknown`. L'interface `SemanticOracle` est prévue pour brancher plus tard des règles métier (ou un modèle), sans toucher à l'explorateur ; aucune implémentation n'est fournie.

Les avertissements des oracles écran, baseline et contrat deviennent des anomalies `UI_ERROR`, `REGRESSION` et `CONTRACT`.

```yaml
oracles:
  technical: { api404: warning } # warning | fail
  ui: { errorTexts: [refusé] } # mots qui font d'une alerte visible un message d'erreur
openapi:
  enabled: true
  source: openapi.yaml # fichier, ou URL sur un hôte autorisé (aucun identifiant envoyé)
```

## Récupération après un problème

Après un échec, le `RecoveryEngine` essaie des stratégies dans l'ordre configuré, jusqu'à retrouver un état connu. Chaque tentative est enregistrée (rapport, `result.json`, journal moteur).

| Stratégie        | Quand                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------- |
| `retry`          | erreur passagère (élément détaché, pas stable), une fois, jamais pour une action qui envoie des données |
| `dismiss-dialog` | un dialogue, un menu ou un calendrier était devant l'écran                                              |
| `escape`         | l'action n'a pas changé de page                                                                         |
| `back`           | l'action a changé de page                                                                               |
| `known-url`      | recharger l'URL de l'état de départ                                                                     |
| `replay-path`    | rejouer le chemin enregistré depuis l'écran de départ                                                   |
| `reauthenticate` | la session a expiré (renvoi vers la page de connexion) : nouvelle connexion, dans une limite            |
| `abandon-branch` | abandonner cet état et continuer ailleurs                                                               |

- **Session expirée.** Avec `auth.type: form`, une action ou une navigation qui aboutit sur la page de connexion déclenche une nouvelle connexion (`maxReauthentications`), le retour à l'écran, puis l'action est retentée une fois.
- **Coupe-circuit.** Le même échec sur la même action du même état deux fois (`circuitBreaker.threshold`) : l'action n'est plus retentée, même dans un chemin rejoué. Trop d'échecs sur un état (`maxFailuresPerState`) : l'état est abandonné.
- **Détection de blocage.** Deux états visités en alternance (A → B → A → B…), une série d'actions qui ne changent rien, un écran qui charge sans fin : la branche est abandonnée et signalée (_Branches abandonnées_).

```yaml
recovery:
  strategies: [retry, dismiss-dialog, escape, back, known-url, replay-path, reauthenticate, abandon-branch]
  maxRetries: 1
  maxReauthentications: 2
  circuitBreaker: { threshold: 2, maxFailuresPerState: 5 }
  stuck: { oscillationCycles: 3, maxNoOpActions: 15, maxBusyObservations: 3 }
```

### Navigations pendant une lecture (Navigation Guard)

Une redirection (connexion unique), un envoi de formulaire, un rechargement ou un changement de route peuvent remplacer le document pendant que le crawler le lit : Playwright répond `page.evaluate: Execution context was destroyed, most likely because of a navigation`. Ce n'est pas une panne de l'application, c'est un changement d'état du navigateur ; le `NavigationGuard` le traite comme tel, à un seul endroit.

- **Il distingue les erreurs** : contexte détruit, cadre détaché, navigation interrompue (récupérables) ; page fermée, délai dépassé, erreur fonctionnelle (propagées telles quelles, jamais masquées).
- **Il est passif** quand rien ne navigue : il compte les navigations du cadre principal (`framenavigated` : chargement, redirection, envoi de formulaire, route d'application monopage par l'API history), sans attente ni pause.
- **Une LECTURE est refaite** (instantané du DOM, puis découverte des actions) : la lecture interrompue est abandonnée, le garde attend que la nouvelle page soit utilisable (`domcontentloaded`, jamais `networkidle` ni une pause fixe), puis relit — 4 lectures au plus. L'état, l'instantané et les actions de l'ancien document ne sont jamais réutilisés : le nouvel écran est observé, identifié et exploré.
- **Une ACTION n'est jamais rejouée.** Si le document change pendant un clic, c'est ce clic qui a navigué : il a eu lieu, la nouvelle page est observée, jamais un second clic. Une saisie dont le champ a disparu est un échec récupérable, pas une nouvelle tentative. Cela vaut pour toutes les classes (SAFE, MUTATION, DANGEROUS, UNKNOWN) : un formulaire n'est jamais envoyé deux fois par la récupération, et la SafetyPolicy reste appliquée à chaque action de la nouvelle page.
- **Si la page ne cesse pas de naviguer**, `NAVIGATION_RECOVERY_FAILED` est signalé avec la cause d'origine ; l'action est marquée comme essayée et l'exploration repart de l'état d'où elle partait (sinon d'un autre état connu), sans arrêter la mission.
- **Journal** : `[NAVIGATION] detected / recovering / DOM ready / snapshot invalidated / recovered` (URL précédente et actuelle, raison, nouvelles lectures, durée) ou `[NAVIGATION_RECOVERY_FAILED]`, dans la console et dans `engine-log.jsonl`. Les événements sont dans `result.json` (`recovery.navigation`, seulement quand il y en a eu). Une navigation récupérée n'est jamais une anomalie de l'application.

## Plusieurs acteurs et autorisations

La mission explore avec son utilisateur (`auth`). D'autres acteurs peuvent être déclarés : après l'exploration, chacun se connecte dans son propre navigateur et **ouvre les écrans trouvés** — de simples chargements de page, jamais un clic ni un envoi.

Pour chaque écran et chaque acteur : `ALLOWED`, `DENIED` (HTTP 401/403, renvoi vers la connexion ou vers un autre écran, message de refus), `NOT_FOUND` ou `ERROR`. Les différences entre acteurs sont des **observations** (`ACCESS DIFFERENCE`). Seules des règles les transforment en PASS ou FAIL ; une règle en échec est une anomalie `AUTHORIZATION` (ERROR).

```yaml
actors:
  - name: reader
    auth:
      {
        type: form,
        loginUrl: /login,
        usernameSelector: '#user',
        passwordSelector: '#pass',
        submitSelector: 'button[type=submit]',
        usernameEnv: QA_READER_USER,
        passwordEnv: QA_READER_PASSWORD,
      }
authorization:
  primaryActor: admin # nom de l'utilisateur de la mission dans les rapports
  rules:
    - { actor: reader, path: /admin/*, expect: denied }
    - { actor: reader, path: /reports, expect: allowed }
```

Comme pour `auth`, seuls les **noms** des variables d'environnement figurent dans le YAML.

## Accessibilité

Chaque nouvel écran passe des vérifications de base (un premier signal, pas un audit) : champ ou bouton sans nom accessible, lien qui ne montre qu'une image sans texte alternatif, image sans `alt`, identifiant en double, élément cliquable inaccessible au clavier. Avec `accessibility.keyboardNavigation: true`, l'écran est aussi parcouru avec Tab : le focus doit bouger et ne pas rester piégé. Les constats sont des anomalies `ACCESSIBILITY` (INFO ou WARNING).

## Données créées et budget de modifications

Par défaut, rien n'est modifié. Sur un environnement de test, on peut autoriser les actions qui créent ou modifient des données, dans un budget :

```yaml
safety:
  mutations:
    enabled: true # MUTATION et envoi de formulaire autorisés ; DANGEROUS seulement via allowedActionClasses
    maxPerRun: 10 # au-delà : bloqué (« mutation budget spent »)
```

- Chaque action de modification exécutée est comptée (`result.mutations`).
- Les écritures réussies (POST/PUT/PATCH 2xx) sont listées dans `result.createdData`, avec le marqueur du run (`QA-CRAWLER-<runId>`) — jamais les valeurs envoyées.
- **Rien n'est supprimé automatiquement.** L'interface `TestDataCleanup` permet de brancher un nettoyage propre à l'application ; par défaut, le rapport liste ce qui reste à supprimer et comment le retrouver.

### Exemple : la mission d'acceptation

```yaml
mission: { name: explore-users, mode: explore }
target: { baseUrl: http://application }
goals: { keywords: [users, utilisateurs] }
forms: { autoFill: true, validationTesting: true }
safety: { mutations: { enabled: true, maxPerRun: 10 } }
```

Sans aucun flow écrit à la main, l'explorateur ouvre l'application, trouve « Users » (mot-clé d'objectif), puis « Create user », analyse le formulaire, le remplit avec des données marquées, l'envoie (budget), observe `POST /api/users` et l'écran, juge le résultat avec les oracles, enregistre la transition, revient et continue. `scenarios/explore-users.yaml` et `tests/integration/acceptance.test.ts` en sont l'exemple complet.

## Générer des flows YAML à partir de l'exploration

À la fin de chaque run, les chemins trouvés sont écrits comme des **flows imposés** dans `reports/generated-flows.yaml`, prêts à être copiés sous `flows:` dans une mission. Ils servent de tests de non-régression écrits sans effort.

- **Un flow par écran en bout de chemin** (les écrans intermédiaires sont couverts par les flows qui y passent), au plus `flowGeneration.maxFlows`.
- **Les étapes rejouent le chemin enregistré :**
  - les clics avec les mêmes cibles que l'explorateur (`testId`, `role` + `name`, `label`, `text`, `css`) ;
  - les formulaires remplis avec les valeurs utilisées ;
  - une vérification finale de l'écran atteint (`expect: { text: … }`).
- **Permissions :** une action `MUTATION`, `UNKNOWN` ou `DANGEROUS` du chemin porte son `allow:`.
- **Champs sensibles :** ils ne reçoivent jamais de valeur. Un mot de passe devient `value: { env: QA_FIELD_… }`, la variable à définir. Les champs de paiement sont laissés de côté.
- **Validation :** chaque flow est vérifié avec le schéma des flows ; un chemin impossible à écrire est laissé de côté.
- Le fichier reste dans `reports/`, qui n'est pas versionné : relisez-le avant de l'ajouter à une mission.

```yaml
flowGeneration:
  enabled: true # défaut
  maxFlows: 30
```

Exemple généré :

```yaml
flows:
  - name: to-create-user
    description: 'Recorded path: dashboard → Users → Create user'
    startAt: /
    steps:
      - click: { role: link, name: Users, exact: true }
      - click: { role: link, name: Create user, exact: true }
      - fill: { role: textbox, name: Email, exact: true, value: qa-crawler-abc123@example.test }
      - select: { role: combobox, name: Role, exact: true, option: Reader }
      - name: on create-user
        expect: { text: Create user }
```

## Ce qui est détecté

| Type d'anomalie       | Source                                                             | Gravité par défaut          |
| --------------------- | ------------------------------------------------------------------ | --------------------------- |
| `HTTP`                | réponse d'API ou de ressource ≥ `http.failOnStatus`                | 5xx → ERROR, 4xx → WARNING  |
| `BROKEN_LINK`         | un écran dont le document répond ≥ `failOnStatus`                  | 404/410/5xx → ERROR         |
| `REQUEST_FAILED`      | échec réseau (DNS, refus, CORS)                                    | WARNING                     |
| `CONSOLE`             | `console.error` (et `console.warn` si activé)                      | ERROR (WARNING)             |
| `PAGE_ERROR`          | exception JavaScript non interceptée                               | ERROR                       |
| `PAGE_CRASH`          | plantage du moteur de rendu                                        | CRITICAL                    |
| `NAVIGATION`          | boucle de redirection, délai dépassé, action menant hors des hôtes | ERROR (WARNING)             |
| `FLOW`                | étape d'un flow imposé échouée ou bloquée                          | ERROR (WARNING si optional) |
| `BROWSER_INTERACTION` | interaction navigateur bloquante ou à traiter (`AUTH_REQUIRED`…)   | ERROR / WARNING             |
| `FORM_VALIDATION`     | champ encore refusé après des données valides                      | WARNING                     |
| `UI_ERROR`            | oracle écran : message d'erreur, écran vide, chargement infini     | WARNING                     |
| `REGRESSION`          | oracle baseline : l'action ne mène plus au même écran              | WARNING                     |
| `CONTRACT`            | oracle contrat : statut HTTP non déclaré par l'OpenAPI             | WARNING                     |
| `ACCESSIBILITY`       | vérifications d'accessibilité de base, parcours clavier            | INFO / WARNING              |
| `AUTHORIZATION`       | règle d'autorisation en échec, acteur impossible à connecter       | ERROR / WARNING             |

Chaque anomalie est rattachée à son contexte pour pouvoir la reproduire :

```json
{
  "type": "HTTP",
  "severity": "ERROR",
  "status": 500,
  "requestUrl": "http://localhost:4174/api/logs",
  "stateId": "journal-fd0e3d2c",
  "actionId": "a-3f81c2d9e0",
  "flow": ["tableau-de-bord-e511f0f8", "administration-316d9318", "journal-fd0e3d2c"]
}
```

Les anomalies identiques sont regroupées en une seule, qui compte ses occurrences et liste tous les états où elle a été vue.

## Rapports

| Fichier                               | Contenu                                                                                                                                                                                                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `reports/result.json`                 | Résumé et statistiques de la mission. États avec leurs actions complètes (localisateurs, classe) et formulaires, transitions, flows, interactions navigateur, anomalies, paramètres effectifs                                                                      |
| `reports/index.html`                  | Rapport statique : cartes de synthèse, flows imposés, interactions navigateur, arbre des flows découverts, anomalies (état · action · flow), états, actions exécutées et bloquées, captures                                                                        |
| `reports/flow-graph.json`             | Le graphe des flows, qui sert de mémoire à l'explorateur (reprise possible avec `memory.resume`)                                                                                                                                                                   |
| `reports/flow-graph.html`             | Carte de l'application : arbre dépliable, arbre texte, transitions entre états, autres tentatives                                                                                                                                                                  |
| `reports/generated-flows.yaml`        | Flows imposés générés à partir des chemins trouvés (voir [Générer des flows YAML](#générer-des-flows-yaml-à-partir-de-lexploration))                                                                                                                               |
| `reports/engine-log.jsonl`            | Journal structuré du moteur, une ligne JSON par événement (`FLOW_STATE_DISCOVERED`, `ACTION_SELECTED`, `ACTION_BLOCKED`, `ACTION_EXECUTED`, `ORACLE_VERDICT`, `RECOVERY_ATTEMPT`, `STUCK_DETECTED`…), niveaux `ERROR` à `TRACE` (`logging.level`), secrets masqués |
| `screenshots/NNN-<état>[-error…].png` | Une par état découvert, plus une par anomalie ERROR/CRITICAL et par étape `screenshot`                                                                                                                                                                             |

`index.html` montre aussi, quand il y a lieu : les verdicts des oracles (FAIL d'abord, décompte PASS / FAIL / WARNING / UNKNOWN, assertions observées), les formulaires découverts (champs, saisie, source, cas de validation), les événements de récupération, les branches abandonnées, les différences d'accès et les règles d'autorisation, les données créées et le budget de modifications, les anomalies d'accessibilité. Chaque anomalie garde son chemin de reproduction (états → action) et sa capture.

**Lecture du rapport.** `index.html` s'ouvre sur les cartes de synthèse (anomalies par gravité, flows réussis, puis les chiffres de l'exploration) et un sommaire, fixe sur le côté sur grand écran, qui mène à chaque section ; les sections qui contiennent des anomalies y sont marquées en rouge. Trois groupes suivent : **Résultats** (flows imposés, vérification, différences, anomalies), **Exploration** (parcours découvert, états, actions, captures) et **Analyse détaillée** (moteur de décision, régression, persistance, oracles, formulaires, autorisation, récupération, données, interactions), repliée par défaut : un clic sur un titre la déplie. Le rapport reste sans JavaScript, suit le thème clair ou sombre du système, se lit sur mobile (les tableaux larges défilent horizontalement) et, dans les navigateurs récents, s'imprime avec toutes les sections dépliées.

Les rapports n'utilisent ni JavaScript, ni framework, ni ressource externe.

**Rapports en français.** Avec `report.language: fr`, `index.html` et `flow-graph.html` sont en français : titres, colonnes, statuts (`RÉUSSI`, `ÉCHOUÉ`, `BLOQUÉ`, `IGNORÉ`), classes, gravités et raisons de la politique de sécurité. `result.json` et `flow-graph.json` restent toujours en anglais, pour que les outils et la CI lisent les mêmes clés et valeurs.

```yaml
report:
  language: fr # en (défaut) | fr
```

## Modes LEARN / VERIFY / EXPLORE

```bash
npm run qa -- learn   scenarios/app.yaml   # construit la baseline
npm run qa -- verify  scenarios/app.yaml   # rejoue la baseline, détecte les régressions
npm run qa -- explore scenarios/app.yaml   # cherche du nouveau (la baseline n'est qu'un indice)
```

Sans commande, le mode est `mission.mode` (par défaut `explore`) : `npm run qa -- scenarios/app.yaml` se comporte comme avant tant qu'aucune baseline n'existe.

| Mode      | Ce qu'il fait                                                                                                                                                                                                   | À la fin                                                                                                                   |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `learn`   | explore l'application et construit le graphe des flows                                                                                                                                                          | le graphe devient la **baseline** ; la précédente est conservée dans l'historique ; le diff avec la précédente est affiché |
| `verify`  | lance les flows imposés, puis **rejoue chaque transition connue** de la baseline : rejoint l'état de départ (par son URL, sinon par le chemin connu depuis l'accueil), exécute l'action, compare l'état atteint | un statut par transition, le diff et le code de sortie `1` s'il y a des régressions                                        |
| `explore` | explore ; les actions déjà connues de la baseline passent **après** les nouvelles (`knownInBaseline`), sans être interdites                                                                                     | le diff : ce qui est nouveau et ce qui a changé                                                                            |

**Statuts de `verify` :**

| Statut           | Signification                                                                  | Régression |
| ---------------- | ------------------------------------------------------------------------------ | ---------- |
| `PASSED`         | même action, même état d'arrivée                                               | non        |
| `CHANGED`        | l'action mène maintenant à un autre état                                       | **oui**    |
| `FAILED`         | l'action échoue                                                                | **oui**    |
| `ACTION_MISSING` | l'état est là, l'action n'y est plus                                           | **oui**    |
| `UNREACHABLE`    | l'état de départ n'est plus atteignable (la raison indique où le chemin casse) | **oui**    |
| `BLOCKED`        | la politique de sécurité actuelle refuse l'action                              | non        |
| `SKIPPED`        | limite de la mission atteinte avant                                            | non        |

`verify.failOnRegression: false` désactive le code de sortie `1` sur régression.

Une baseline apprise sur un environnement (QA) se vérifie sur un autre (environnement de PR, `--base-url`) : les URL de la baseline sont rapportées sur la cible, et une action est retrouvée par son libellé et son modèle de route même quand son URL exacte change (`/users/1` appris, `/users/2` atteint).

### Baseline versionnée

```text
baseline/
  flow-graph.json          ← dernière baseline (lue par verify et explore)
  metadata.json
  runs/<runId>/flow-graph.json, metadata.json   ← chaque learn, les 20 derniers (baseline.keepRuns)
```

```json
{
  "runId": "2026-09-27T10-32-05Z-1a2b3c4",
  "application": "example",
  "mission": "example",
  "targetUrl": "https://app.example.com",
  "createdAt": "2026-09-27T10:32:05.123Z",
  "branch": "main",
  "commit": "1a2b3c4d…",
  "environment": "qa",
  "states": 42,
  "transitions": 97
}
```

La branche et le commit sont ceux de **l'application testée**, tous facultatifs : `baseline.branch` / `baseline.commit` dans le YAML, sinon `QA_BRANCH` / `QA_COMMIT`, sinon les variables de CI (GitHub Actions, GitLab CI), sinon `git` dans `baseline.gitDir` si indiqué. L'environnement : `baseline.environment` ou `QA_ENVIRONMENT`.

`baseline/` est dans le `.gitignore` : elle contient les écrans et les URL de l'application testée. Versionne-la dans ton propre dépôt si tu le souhaites.

### Flow diff

`FlowDiffEngine` compare deux graphes : états ajoutés et disparus (par empreinte), transitions ajoutées, disparues et modifiées. Une transition est identifiée par son état de départ et son contrôle (type, libellé, modèle de route de sa cible), donc de façon stable d'un environnement à l'autre. Elle est **modifiée** quand elle mène à un autre état, change de résultat, ou appelle d'autres API (même méthode + modèle de route + famille de statut : `GET /api/roles 2xx` → `5xx`).

```text
FLOW DIFF

+ Import users (/users/import)
+ Users → "Import" → Import users
- Permissions (/settings/permissions)
- Settings → "Permissions" → Permissions

Changed:
  Users → "Create user"
    target: Create user → Error
    network: + GET /api/roles 5xx, - GET /api/roles 2xx
```

Il est affiché dans le terminal, dans `index.html` (section _Différences de flows_) et écrit dans `reports/flow-diff.json`. En `explore`, seul ce qui est nouveau ou modifié est listé : ce qui n'a pas été revu n'a pas disparu pour autant. En `verify`, la comparaison porte sur les transitions rejouées.

## Choix des actions (scoring) et objectifs

Le moteur de décision ne prend pas la première action disponible : chaque action est notée par l'`ActionScorer`, et la meilleure note gagne (à égalité, l'ordre du document). Les poids sont centralisés dans `DEFAULT_SCORING_WEIGHTS` (`src/decision/scoring-weights.ts`) et modifiables par mission :

| Règle                                                                              | Poids           | Règle                                     | Poids |
| ---------------------------------------------------------------------------------- | --------------- | ----------------------------------------- | ----- |
| mène à un état nouveau (route jamais vue, onglet jamais ouvert, étape d'assistant) | +100            | action déjà utilisée depuis un autre état | −100  |
| jamais exécutée depuis cet état                                                    | +80             | route cible déjà bien explorée            | −40   |
| fait avancer un formulaire                                                         | +70             | exporter / télécharger / imprimer         | −30   |
| lien interne                                                                       | +60             | déconnexion                               | −100  |
| onglet                                                                             | +50             | déjà connue de la baseline (`explore`)    | −50   |
| voir le détail                                                                     | +40             | au premier plan (fenêtre, menu ouvert)    | +200  |
| recherche / filtre / pagination                                                    | +30 / +20 / +10 | libellé qui correspond à un objectif      | +100  |
| entrée du menu global                                                              | +20             | URL qui correspond à un objectif          | +80   |

Ce qui ne doit jamais s'exécuter (suppression, paiement, navigation externe…) n'est pas une note : c'est exclu, comme les actions déjà essayées, désactivées ou couvertes par une fenêtre. Chaque décision garde ses raisons (`score 240: never executed from this state (+80), navigation link (+60), new route /users (+100)`).

**Exploration dirigée par un objectif :**

```yaml
mission:
  name: user-management
  mode: explore

goals:
  keywords: [users, utilisateurs, administration, permissions]
  discover: { navigation: true, forms: true, dialogs: true }

scoring:
  weights: { goalText: 150, export: 0 } # facultatif : ajuster une règle
```

Une action dont le libellé contient un mot-clé (« Utilisateurs ») passe devant (+100), une action dont seule l'URL correspond (`/admin/permissions`) aussi (+80) ; « Parking » ne gagne rien. La correspondance est déterministe (mots entiers, sans accents ni casse), sans modèle de langage.

## Moteur de décision avancé

Le moteur reste **entièrement déterministe et local** : aucun modèle de langage, aucune dépendance OpenAI, Anthropic, Gemini, Ollama ou LangChain, aucun apprentissage automatique. L'« intelligence » vient de règles, de motifs, de contraintes, d'une recherche dans le graphe, de statistiques historiques, de la couverture, des invariants et du contrat OpenAPI. Playwright ne fait qu'exécuter les actions.

```
Mission → Goal Planner → Observation → Pattern Detector → Action Discovery → Goal Matcher
       → Action Scorer V2 → Frontière + Best-First → Decision Engine → Safety Policy (+ garde d'écriture)
       → Playwright → Observation → Oracles (technique, écran, contrat, baseline, invariants, historique)
       → Flow Graph → Knowledge Base → run suivant
```

### Objectifs fonctionnels (Goal Planner)

```yaml
mission: { name: users, mode: explore }
goals: [users, create-user, permissions] # ou la forme objet : goals: { targets: [...], keywords: [...] }
```

Le planner ne produit **jamais une liste de clics**, seulement des objectifs vérifiables :

| Objectif      | Sous-objectifs                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------- |
| `users`       | trouver « user » (URL, titre, région, fil d'Ariane) → explorer sa liste / sa fiche                |
| `create-user` | trouver « user » → trouver l'action « créer » → atteindre le formulaire de création (CREATE_FORM) |
| `delete-user` | … → **BLOCKED** dès le départ quand la SafetyPolicy bloque `delete`                               |

Un objectif ne passe `REACHED` **qu'avec une preuve observable** (URL, titre, région nommée, fil d'Ariane, motif détecté) ; un bouton qui en parle rapproche mais ne prouve rien. Statuts : `PENDING`, `ACTIVE`, `REACHED`, `UNREACHABLE`, `BLOCKED`. La forme objet accepte `{ id, description, keywords, priority }`.

### Vocabulaire, synonymes et packs de domaine

```yaml
semantics:
  concepts: { create: [enrôler] } # s'ajoute aux concepts intégrés (create, delete, save, cancel, next…)
  synonyms: { users: [utilisateurs, membres, agents] }
domainPacks: [generic, administration] # ou un fichier : ./packs/mon-domaine.yaml
```

Le dictionnaire (FR/EN, accents et casse ignorés, pluriels simples) est utilisé par le PatternDetector, le GoalMatcher, l'ActionScorer et la SafetyPolicy — qui ne peut qu'y **ajouter** des mots à bloquer, jamais en retirer. Les packs livrés (`domain-packs/generic.yaml`, `administration.yaml`, `ecommerce.yaml`) n'apportent que du vocabulaire, des synonymes, des invariants et des indices de score ; jamais une règle propre à une application.

### Motifs d'interface (Pattern Detector)

`LOGIN`, `CRUD_LIST`, `CREATE_FORM`, `EDIT_FORM`, `DETAIL`, `SEARCH`, `FILTER`, `PAGINATION`, `WIZARD`, `CONFIRMATION_DIALOG`, `ERROR_PAGE`, `EMPTY_STATE`, `DASHBOARD`, `MASTER_DETAIL`, `TABS`, `MENU`, `UPLOAD` — chacun avec une confiance et ses preuves. **Le texte d'un bouton n'est jamais une preuve suffisante** : tableau + lignes + bouton « Ajouter » + pagination font une CRUD_LIST, pas un bouton seul. Les règles d'intérêt par motif sont centralisées dans `src/patterns/pattern-rules.ts` (CRUD_LIST : créer +80, détail +60, recherche +40, filtre +30, pagination +20, supprimer BLOCK ; WIZARD : suivant +80, précédent +20, annuler −40 ; ERROR_PAGE : retour +80, accueil +60, réessayer +20).

### Score expliqué (Action Scorer V2) et best-first

```
score = base + objectif + motif + nouveauté + historique + couverture − risque − répétition
```

Chaque point a sa raison, rendue dans la langue du rapport :

```
ACTION CHOISIE   Nouvel utilisateur   score 535
+240 score de base (jamais exécutée depuis cet écran, lien de navigation, nouvelle route /users/new)
+118 pertinence pour l'objectif : atteindre l'écran « create » pour « user »
 +76 CRUD_LIST : action create
 +40 jamais explorée
 +32 zone users peu couverte (0 %)
```

```yaml
exploration:
  strategy: best-first # ou depth-first (comportement historique)
  goalWeight: 1.5
  patternWeight: 1.0
  noveltyWeight: 1.0
  coverageWeight: 0.8
  historyWeight: 0.5
  switchMargin: 60 # quitter l'écran courant seulement pour nettement mieux
  agingBonus: 2 # anti-famine : une branche faible finit toujours par passer
  # seed: 42        # départage pseudo-aléatoire reproductible (absent : aucun hasard)
logging:
  decisionTrace: true # reports/decision-trace.json : chaque décision avec tous ses candidats
```

La **frontière d'exploration** garde les candidats de chaque écran visité (sans doublon) ; la stratégie best-first choisit le meilleur où qu'il soit, en payant le coût du déplacement. Les boucles `A → B → A` et `A → B → C → A` sont d'abord **pénalisées**, puis la branche est quittée si la boucle revient. Un budget central (`maxStates`, `maxActions`, mutations, cas de validation, cas de propriété, durée) s'applique à toutes les stratégies.

### Base de connaissances (d'un run à l'autre)

```yaml
knowledge:
  enabled: true # par défaut
  file: knowledge/knowledge-base.json # par défaut : à côté du dossier des rapports (gardé hors du dépôt)
  halfLifeDays: 30 # les observations anciennes comptent moins, sans être supprimées
  minObservations: 3
  dominance: 0.8
  commit: ${QA_APP_COMMIT} # ou GITHUB_SHA / CI_COMMIT_SHA : une nouvelle version donne une nouvelle chance
```

Elle enregistre, par application et environnement, **des signatures et des compteurs seulement** (jamais un corps de requête, une valeur saisie ou une donnée affichée) : taux de succès des actions, cibles des transitions, statuts d'API par opération, durées (médiane, p95), indices appris (« Ajouter » → CREATE_FORM 12/13 : un indice, **jamais** une règle de sécurité). Format versionné avec migration.

Elle alimente l'oracle **historique** : `UNEXPECTED_TRANSITION` quand « Utilisateurs → Créer » mène à la connexion alors qu'il menait au formulaire 18 fois sur 19 (une **attente historique**, jamais une attente métier), statut d'API jamais vu, `PERFORMANCE_WARNING` (jamais un échec à lui seul). En VERIFY, l'historique aide mais l'état courant est toujours vérifié.

### Invariants

```yaml
invariants:
  - id: USER-CREATE
    severity: WARNING # INFO, WARNING, ERROR (défaut), CRITICAL
    when: { actionMatches: [créer utilisateur, create user] }
    expect: { resultingPattern: [CREATE_FORM] }
  - id: ADMIN-ACCESS
    severity: CRITICAL
    when: { actor: user, path: /admin/** }
    expect: { access: [denied, forbidden] }
```

`when` : `anyRequest`, `request` (« POST /api/users »), `actionMatches`, `pattern`, `actor`, `path`. `expect` : `statusBelow`, `resultingPattern`, `access`, `textPresent`, `textAbsent`, `maxDurationMs`. Chaque verdict dit la règle, l'attendu et l'observé. Les règles d'accès sont jugées sur les observations multi-acteurs.

**Contrôle des faux positifs** : un comportement inhabituel n'est pas automatiquement un bug. Chaque verdict porte une catégorie — `CONFIRMED_FAILURE`, `CONTRACT_VIOLATION`, `INVARIANT_VIOLATION`, `POTENTIAL_REGRESSION`, `UNEXPECTED_BEHAVIOR`, `UNKNOWN` — et une source de confiance (invariant explicite > contrat OpenAPI > historique répété > observation unique / heuristique de texte).

### Contraintes, bornes et property testing

```yaml
propertyTesting: { enabled: true, maxCasesPerForm: 15, maxCasesPerRun: 100 }
```

Le `ConstraintExtractor` fusionne ce que la page déclare (attributs HTML : `required`, `min`, `max`, `step`, `minlength`, `maxlength`, `pattern`, type, `multiple`, `disabled`, `readonly` ; ARIA : `aria-required`, et `aria-invalid` comme constat) et le contrat OpenAPI (`required`, `nullable`, type, format, `minimum`/`maximum`, `exclusiveMinimum`/`exclusiveMaximum` en 3.0 comme en 3.1, `minLength`/`maxLength`, `pattern`, `enum`). Chaque contrainte garde ses sources (`maxLength` → HTML, OPENAPI) et une confiance, plus haute quand les sources s'accordent. Quand elles se contredisent (page `maxlength=100`, API `maxLength: 80`), rien n'est départagé en silence : un conflit `CONSTRAINT_MISMATCH` garde les deux valeurs, et la valeur de la page reste celle qu'on teste par l'interface, puisque l'utilisateur ne peut rien saisir d'autre. Ce que le contrat a ajouté à un champ n'est jamais pris pour une déclaration de la page. Valeurs aux bornes (min 18 / max 65 → 17, 18, 19, 64, 65, 66), partitions d'équivalence (<18, 18..65, >65 : une valeur par partition), puis cas générés un champ à la fois : une valeur valide doit être acceptée, une invalide refusée. Rien n'est envoyé.

### Garde d'écriture, suggestions, options

- **Garde d'écriture** (`safety.writeGuard`, activée par défaut) : toute requête `POST`/`PUT`/`PATCH`/`DELETE` vers l'application est annulée si l'action en cours n'a pas le droit de modifier des données (une saisie qui déclenche un `PUT`…), et signalée comme effet de bord. Permis : la connexion, les échanges d'authentification (jeton OIDC / OAuth, SAML, SSO, session — reconnus par leur chemin `/oidc/`, `/oauth2/`, `/token`, `/saml2/`, `/sso/`, `/login`… ou leur corps `grant_type=`, `SAMLResponse=`), les actions MUTATION/DANGEROUS autorisées, les étapes de flow avec `allow`, et `writeGuard.allow: ["POST /api/search", "/graphql"]`. En dernier recours : `safety.writeGuard.enabled: false`.
- **Champs à suggestions** (autocomplete, Angular Material) : après la saisie, la suggestion qui correspond est cliquée (sinon la première) ; le rapport l'indique (`fill "1000" → "10001 — Agence Nord"`).
- **Options d'un groupe** (radios Oui/Non…) : chaque option n'est essayée qu'une fois par run, pas sur chaque écran où le groupe réapparaît.
- **Écran jumeau** : en revenant sur un écran, la page peut montrer le même écran avec un contrôle en plus ou en moins (une réservation, une bannière, une page cassée entre-temps), donc un autre id. Quand tout le reste est identique (route, titres, fenêtres, onglets), que les contrôles se ressemblent (75 % en commun) et que les actions restantes y sont, l'explorateur y continue le travail : ce qui a déjà été tenté ne l'est pas une seconde fois. Sinon, le message de fin liste les écrans abandonnés et leurs actions non tentées (`nothing left to explore; 1 screen(s) could not be reached again…`).

Le rapport HTML a une section **Moteur de décision** (en français avec `report.language: fr`) : objectifs et preuves, motifs, couverture par zone (DÉCOUVERT / EXÉCUTÉ / BLOQUÉ / INACCESSIBLE), actions choisies expliquées, catégories de verdict, invariants, écritures bloquées, cas de propriété. Démonstration : `tests/fixtures/decision-app.ts` et `tests/integration/decision-engine.test.ts`.

## Persistance et mémoire

**Persistance ≠ mémoire** : deux réglages indépendants.

- **Persistance** : _où_ les runs, états, transitions et connaissances sont enregistrés (mémoire, fichiers JSON, base de données).
- **Mémoire** : _est-ce que_ les runs précédents influencent le run actuel.

| `persistence.enabled` | `memory.enabled` | Résultat                                                                                     |
| --------------------- | ---------------- | -------------------------------------------------------------------------------------------- |
| false                 | false            | run complètement isolé                                                                       |
| true                  | false            | le run est enregistré, l'historique n'influence **aucune** décision                          |
| true                  | true             | enregistré, et l'historique est préchargé dans la mémoire de travail                         |
| false                 | true             | mémoire du run courant seulement                                                             |
| (absent)              | (absent)         | **comportement d'avant**, inchangé : base de connaissances fichier `knowledge.*` (ci-dessus) |

Par défaut, rien n'est persisté et **QA-CRAWLER n'exige jamais de base de données**. Une mission sans bloc `persistence` fonctionne exactement comme avant ; aucun pilote de base de données n'est chargé.

### Configuration

```yaml
persistence:
  enabled: true
  provider: database # memory | file | database
  database:
    type: postgres # postgres | sqlserver | sqlite (mysql : prévu, pas encore implémenté)
    hostEnv: QA_DB_HOST # noms de variables d'environnement (valeurs par défaut)
    portEnv: QA_DB_PORT
    databaseEnv: QA_DB_NAME
    usernameEnv: QA_DB_USERNAME
    passwordEnv: QA_DB_PASSWORD
    migrate: true # applique les migrations manquantes (uniquement des ajouts)
    # tls: { enabled: true, trustServerCertificate: false }
  failureMode: fallback # fail : arrêt clair ; fallback : avertissement + repli
  fallback: { provider: file, directory: .qa-crawler/memory }
  flushEvery: 25 # écritures par lots

memory:
  enabled: true
  historicalKnowledge: true
  preload: { maxStates: 1000, maxTransitions: 5000 } # jamais toute la base
```

Exemples complets : `scenarios/persistence-file.yaml`, `scenarios/persistence-postgres.yaml`, `scenarios/persistence-sqlserver.yaml`.

**Priorité** : ligne de commande → variables d'environnement → YAML → valeurs par défaut (comme `--base-url` / `QA_BASE_URL`).

| Ligne de commande                                                                     | Variable d'environnement                                                     |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `--persistence memory \| file \| postgres \| sqlserver \| sqlite`, `--no-persistence` | `QA_PERSISTENCE_ENABLED`, `QA_PERSISTENCE_PROVIDER`, `QA_DB_TYPE`            |
| `--memory`, `--no-memory`                                                             | `QA_MEMORY_ENABLED`                                                          |
| —                                                                                     | `QA_DB_HOST`, `QA_DB_PORT`, `QA_DB_NAME`, `QA_DB_USERNAME`, `QA_DB_PASSWORD` |

```bash
npm run qa -- mission.yaml --persistence postgres
npm run qa -- mission.yaml --persistence sqlserver --no-memory
npm run qa -- mission.yaml --no-persistence
```

**Jamais d'identifiants dans le YAML** : `password`, `username`, `connectionString` sous `persistence.database` sont refusés au chargement. Hôte, port et nom de base peuvent être écrits (`host`, `port`, `database`) ou lus dans l'environnement ; l'utilisateur et le mot de passe viennent **toujours** de l'environnement. Les messages d'erreur de connexion n'affichent jamais les identifiants.

### Providers

| Provider               | Stockage                                     | Testé                                                    |
| ---------------------- | -------------------------------------------- | -------------------------------------------------------- |
| `memory`               | RAM (rien ne survit au processus)            | contrat commun                                           |
| `file`                 | un fichier JSON par table, écriture atomique | contrat commun                                           |
| `database` / postgres  | PostgreSQL (pilote `pg`)                     | contrat commun + migrations/transactions + crawl complet |
| `database` / sqlserver | SQL Server (pilote `mssql`)                  | contrat commun + migrations/transactions + crawl complet |
| `database` / sqlite    | SQLite (`node:sqlite`, Node.js 22.5+)        | contrat commun + migrations/transactions                 |
| `database` / mysql     | —                                            | **non implémenté** : signalé comme indisponible          |

Les pilotes `pg` et `mssql` sont des dépendances **facultatives**, chargées seulement à la connexion. Passer de PostgreSQL à SQL Server ne change que `database.type` : aucun composant du moteur (FlowExplorer, DecisionEngine, FlowGraph, oracles, SafetyPolicy) ne connaît le stockage. L'enregistrement passe par un `ExplorationListener` (le même mécanisme d'événements que le journal du moteur), la lecture par la mémoire de travail.

Différences gérées par le dialecte (`SqlDialect`, un seul fichier par moteur) :

| PostgreSQL               | SQL Server                                | SQLite            |
| ------------------------ | ----------------------------------------- | ----------------- |
| `VARCHAR`                | `NVARCHAR` (Unicode)                      | `TEXT`            |
| `JSONB`                  | `NVARCHAR(MAX)`                           | `TEXT`            |
| `TIMESTAMPTZ`            | `DATETIMEOFFSET(3)`                       | texte ISO 8601    |
| `DOUBLE PRECISION`       | `FLOAT`                                   | `REAL`            |
| `$1`                     | `@p1` (types explicites)                  | `?`               |
| `LIMIT n`                | `OFFSET 0 ROWS FETCH NEXT n ROWS ONLY`    | `LIMIT n`         |
| `SELECT … FOR UPDATE`    | `WITH (UPDLOCK, HOLDLOCK)`                | `BEGIN IMMEDIATE` |
| `CREATE … IF NOT EXISTS` | `IF OBJECT_ID(…) IS NULL` / `sys.indexes` | `IF NOT EXISTS`   |

Pas de `RETURNING` / `OUTPUT` ni d'`ON CONFLICT` / `MERGE` : les identifiants sont des UUID générés par le crawler (aucun auto-incrément), et les écritures de connaissance lisent la ligne en la bloquant (lock), la fusionnent (une seule règle en TypeScript, la même pour tous les providers), puis la mettent à jour ou l'insèrent — dans une transaction, rejouée si un autre crawler a créé la même ligne au même moment.

### Modèle de données (V1)

| Table                  | Contenu                                                                                                                                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crawl_run`            | un lancement : application, mission, environnement, branche, commit, version du crawler, mode, début / fin, statut, nombres d'états, d'actions, de transitions, d'anomalies                               |
| `run_state`            | un état du run : signature (celle du StateDetector, via `knowledge/signatures`), id, route, URL (secrets masqués), titre, profondeur, première / dernière vue, `context_json` normalisé                   |
| `run_transition`       | ÉTAT A → ACTION → ÉTAT B (B nul si BLOQUÉE ou ÉCHOUÉE) : signature et libellé de l'action, statut, classe et décision de sécurité, verdict des oracles, durée                                             |
| `transition_knowledge` | la mémoire historique : **une ligne par destination** (écran + action + destination), compteurs vu / succès / échec / bloqué, durée moyenne, première / dernière vue, contexte de la dernière observation |

Une même action peut mener à plusieurs écrans (« Users + Create » → formulaire 97 fois, connexion 2 fois, erreur 1 fois) : les trois lignes sont gardées, et les probabilités sont calculées à partir des observations (aucun apprentissage automatique).

### Migrations

`qa_schema_migrations` garde les migrations appliquées (`001_initial_schema`, `002_add_transition_knowledge`, `003_add_knowledge_context` : colonne `transition_knowledge.last_context_json`, nullable ; `004_add_evolution_and_anomalies` : tables `flow_evolution` et `anomaly_lifecycle`) ; la version du schéma est leur nombre (affichée dans le rapport). Chaque migration est appliquée une fois, dans une transaction, et ne fait qu'**ajouter** (tables, index) : jamais de suppression au démarrage. Avec `migrate: false`, une base en retard est une erreur claire (à appliquer par un compte autorisé à créer des tables) ; une base plus récente que le crawler n'est jamais modifiée.

### Mémoire de travail et mémoire long terme

```
début du run : provider → KnowledgeRepository → préchargement (budget) → mémoire de travail (RAM) → DecisionEngine
pendant le run : action → StateDetector → oracles → FlowGraph → ExplorationListener → tampon → écriture par lots
```

- La **mémoire de travail** est la base de connaissances du moteur, en RAM : le DecisionEngine, le scorer et l'oracle historique la lisent sans jamais interroger la base (pas de requête SQL par bouton comparé).
- Le **préchargement** respecte le budget : au plus `maxTransitions` lignes, les plus récentes, et seulement celles des `maxStates` écrans les plus récemment vus.
- Les **écritures** sont des incréments (l'historique préchargé n'est jamais recompté), groupées toutes les `flushEvery` observations, puis à la fin du run. Un crash peut perdre au plus les observations pas encore écrites ; une écriture qui échoue est gardée pour la suivante et signalée dans le rapport, sans arrêter le crawl.

**L'historique n'est jamais une vérité métier.** « Users + Create » a mené 19 fois sur 20 au formulaire et, cette fois, à une page d'erreur : l'oracle historique donne `UNEXPECTED_TRANSITION`, catégorie `POTENTIAL_REGRESSION` (ou `UNEXPECTED_BEHAVIOR`), statut WARNING — jamais un bug confirmé. L'application a pu changer légitimement.

### Confiance, vieillissement et contexte (`intelligence`)

Désactivé par défaut : sans `intelligence.enabled: true`, les décisions et les verdicts sont exactement ceux d'avant (test de non-régression dédié).

```yaml
intelligence:
  enabled: true
  confidence: { enabled: true, sampleHalfPoint: 5 } # confiance d'échantillon n / (n + 5)
  aging: { enabled: true, minWeight: 0.05 } # halfLifeDays : par défaut knowledge.halfLifeDays
  context: { enabled: true } # comparer environnement, acteur, version, navigateur, classe d'écran
```

**ConfidenceEngine** — déterministe, sans apprentissage automatique :

```
confiance = échantillon × stabilité × récence × similarité du contexte
```

| Composante  | Calcul                                                                                                                                                                   | Exemple                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| échantillon | n / (n + k) : croît progressivement, jamais 1                                                                                                                            | 1 obs. 0,17 · 5 → 0,5 · 20 → 0,8 · 100 → 0,95 |
| stabilité   | part de la destination dominante                                                                                                                                         | 19/20 → 0,95                                  |
| récence     | poids de vieillissement (demi-vie), plancher `minWeight`                                                                                                                 | aujourd'hui 1 · une demi-vie 0,5              |
| contexte    | produit des poids des dimensions différentes (acteur 0,5, environnement 0,7, version 0,85, classe d'écran 0,9, navigateur 0,95) ; une dimension inconnue ne pénalise pas | acteur admin ≠ user → 0,5                     |

Niveaux : VERY_LOW < 0,2 ≤ LOW < 0,4 ≤ MEDIUM < 0,6 ≤ HIGH < 0,8 ≤ VERY_HIGH. **Des données faibles ne donnent jamais une certitude forte** : 2 observations identiques restent LOW, et l'oracle historique ne classe une transition inattendue `POTENTIAL_REGRESSION` qu'à partir du niveau MEDIUM ; en dessous, elle reste `UNEXPECTED_BEHAVIOR`. Chaque message d'anomalie historique donne le détail (« confidence 0.76 HIGH (20 observation(s); stability 0.95; recency 1; context 1) »).

**Vieillissement** : le stockage garde tout ; seul le poids dans la décision décroît. 500 observations vieilles de 10 mois (demi-vie 30 j) pèsent moins de 1 observation effective ; 80 observations d'hier en pèsent environ 78.

**Contexte** : chaque connaissance garde le contexte de sa dernière observation (`last_context_json`, nettoyé comme tout ce qui part vers un provider). Une connaissance vue pour un autre acteur ne contredit pas la connaissance courante : elle s'applique moins.

Le rapport ajoute une section « Connaissance historique (confiance) » : contexte courant, nombre de connaissances par niveau, vieillies, vues dans un autre contexte, et les plus observées avec le détail de leur confiance. Les événements `KNOWLEDGE_LOADED`, `CONFIDENCE_EVALUATED` et `KNOWLEDGE_AGED` sont écrits dans le journal du moteur.

### Nouveauté, stabilité et score adaptatif

Trois capacités de plus sous `intelligence`, chacune avec son interrupteur :

```yaml
intelligence:
  enabled: true
  novelty: { enabled: true }
  stability: { enabled: true, minDurationSamples: 5, variabilityRatio: 3, minConfidence: 0.4 }
  adaptiveScoring: { enabled: false, confidenceWeight: 1, noveltyWeight: 1, stabilityWeight: 1 }
```

- **NoveltyScore** : `k / (k + exécutions passées pondérées par la récence + exécutions de ce run)`. NEW (jamais exécutée), RARE (≥ 0,5), KNOWN (≥ 0,2), FAMILIAR. 500 exécutions vieilles de 10 mois redeviennent RARE ; 80 exécutions d'hier sont FAMILIAR.
- **StabilityScore** : `résultat (taux de succès) × destination (part dominante) × durée (p95 / p50)`. p50 et p95 viennent **uniquement d'échantillons réels** (au moins `minDurationSamples`) ; jamais d'une moyenne. Sans assez d'échantillons, la durée n'entre pas dans le score, et c'est dit. En dessous de `minConfidence` (peu d'observations) : UNCERTAIN, jamais UNSTABLE.
- **AdaptiveScoring** (désactivé par défaut, car il change les décisions) : un facteur `adaptive` de plus dans la décomposition du score, borné entre −60 et +30 :
  - le succès historique ne compte qu'à hauteur de sa confiance (2 succès ne valent pas 200) ;
  - une action peu explorée dans les runs précédents gagne un peu ;
  - une action instable, avec assez d'observations, perd un peu.

  Sans historique (`memory.enabled: false`, ou aucune base de connaissances), l'impact est **nul**. Une action exclue (SafetyPolicy, motif BLOCK, déjà essayée) le reste : le score classe, il n'autorise jamais.

Chaque score s'explique : le rapport montre l'équation (`264 = base 240 + history 20 + adaptive 4`) sous chaque décision, puis chaque raison (« -14 succès historique pris à 0.286 (2 exécution(s)) »).

### Régression d'une version à l'autre (`regression`)

Désactivée par défaut. Elle exige la persistance (`persistence.enabled: true`), et une mémoire qui n'est pas coupée (`memory.enabled` différent de `false`). Sinon, le rapport indique pourquoi rien n'a été calculé.

```yaml
regression:
  flowEvolution: { enabled: true, historyLimit: 20 }
  anomalyLifecycle: { enabled: true, resolveAfterChecks: 3, flakyAfterFlips: 2 }
intelligence:
  enabled: true
  flakyDetection: { enabled: true, stableAt: 0.95, mostlyStableAt: 0.8, unstableAt: 0.5, minConfidence: 0.4 }
```

**Évolution des flows** : on ne compare plus seulement une baseline au run courant, on suit la suite v1 → v2 → v3 → v4.

- **Stockage** : une ligne par état, par transition et par flow imposé (table `flow_evolution`, ou fichier `flow-evolution.json`), mise à jour à chaque run. Les graphes ne sont jamais copiés.
- **Comparaison** : le FlowDiffEngine existant compare le run à une référence reconstruite depuis ces lignes.
- **Questions auxquelles l'historique répond** :
  - quand cet état est-il apparu ? (`firstSeen`, avec la version) ;
  - quand cette action a-t-elle disparu ? (`disappeared`) ;
  - depuis quand cette transition mène-t-elle ailleurs ? (`targetSince`) ;
  - combien de versions ce flow a-t-il traversées ? (`versionCount`, avec les changements de chemin).
- **Prudence** : une exploration partielle ne prouve rien.
  - Une action n'est déclarée disparue que si son écran a été revu sans elle.
  - Un état n'est déclaré disparu qu'après une exploration complète (`stopReason: exhausted`).

**Détection d'instabilité (flaky)** : chaque transition connue est classée par le StabilityScore (taux de réussite × part de la destination dominante).

| Classe          | Score  |
| --------------- | ------ |
| STABLE          | ≥ 0,95 |
| MOSTLY_STABLE   | ≥ 0,8  |
| UNSTABLE        | ≥ 0,5  |
| HIGHLY_UNSTABLE | < 0,5  |

- Exemple : « Search → Results », 72 réussites et 28 échecs sur 100 observations, est UNSTABLE.
- Avec trop peu d'observations, la classe est UNKNOWN.
- Une transition instable n'est jamais un bug en soi : quand elle change, l'oracle historique donne `UNEXPECTED_BEHAVIOR` (WARNING) si elle est UNSTABLE, et `UNKNOWN` si elle est HIGHLY_UNSTABLE, jamais `POTENTIAL_REGRESSION`.
- Une transition stable qui change garde les règles habituelles.
- Le rapport affiche la répartition.

**Cycle de vie des anomalies** : chaque anomalie est suivie de run en run.

- **Clé** : celle du regroupement existant (même type, même requête, même message, nombres masqués).
- **Stockage** : table `anomaly_lifecycle`, ou fichier `anomaly-lifecycle.json`.

| Statut   | Règle                                                                                                                                                       |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NEW      | vue pour la première fois                                                                                                                                   |
| KNOWN    | revue                                                                                                                                                       |
| RESOLVED | absente pendant `resolveAfterChecks` vérifications **consécutives** : son écran a été revisité et son action rejouée. Ne pas repasser par là ne prouve rien |
| REOPENED | revenue après RESOLVED                                                                                                                                      |
| FLAKY    | elle va et vient (`flakyAfterFlips` allers-retours)                                                                                                         |

- **Informations gardées** : première et dernière observation (date, run, version), nombre d'occurrences, runs, environnements, acteurs, chemin de reproduction.
- **Dans le rapport** : chaque anomalie du run porte son statut (`issues[].lifecycle`).
- **Journal du moteur** : `ANOMALY_CREATED`, `ANOMALY_RESOLVED`, `ANOMALY_REOPENED`, `ANOMALY_FLAKY` et `FLOW_EVOLVED`, sans aucune valeur saisie.

La migration `004_add_evolution_and_anomalies` ajoute les deux tables, en mode ajout seulement ; le schéma passe en version 4.

### Repli (failureMode)

- `fail` : base inutilisable → le run s'arrête avec une erreur claire (code de sortie 3).
- `fallback` (défaut) : AVERTISSEMENT, puis le provider de repli (`file` ou `memory`), et le crawl continue. Le rapport et le terminal indiquent :

```
Persistence   : file (fallback)  configured database (SQL Server) — SQL Server connection failed: …
```

### Sécurité

Chaque écriture passe par le masquage du crawler (URL, Bearer, JWT, Authorization, Cookie, `password=`…) puis par des règles propres au stockage long terme (numéros de carte validés par Luhn, IBAN) ; les clés sensibles (`password`, `token`, `cookie`, `otp`…) sont retirées de `context_json`. Aucune valeur saisie dans un formulaire n'est jamais enregistrée. Des tests interrogent directement chaque provider (et les fichiers sur disque) pour vérifier l'absence de secrets.

### Rapport

Section **Persistance et mémoire** du rapport HTML (et `persistence` dans `result.json`) : persistance activée, provider configuré et réellement utilisé, raison du repli, état, latence, version du schéma, id du run ; mémoire activée, mode, états et transitions historiques chargés, nouveaux états et transitions appris.

### CI/CD

Sans configuration, rien ne change : pas de base, pas de pilote. Pour garder l'historique entre les pipelines, pointer `QA_DB_*` vers une base partagée (secrets de la CI) avec `--persistence postgres` ou `--persistence sqlserver` ; avec `failureMode: fallback`, une base indisponible ne bloque pas le pipeline. Le job `persistence` du workflow lance les tests de contrat et un crawl complet contre de vrais PostgreSQL et SQL Server (conteneurs de service) :

```bash
# PostgreSQL et SQL Server locaux (conteneurs jetables)
docker run -d --name qa-pg -e POSTGRES_USER=qa -e POSTGRES_PASSWORD=<test> -e POSTGRES_DB=qa_crawler -p 55432:5432 postgres:16-alpine
docker run -d --name qa-mssql -e ACCEPT_EULA=Y -e MSSQL_SA_PASSWORD=<Test-1> -p 51433:1433 mcr.microsoft.com/mssql/server:2022-latest
export QA_TEST_PG_HOST=127.0.0.1 QA_TEST_PG_PORT=55432 QA_TEST_PG_DATABASE=qa_crawler QA_TEST_PG_USERNAME=qa QA_TEST_PG_PASSWORD=<test>
export QA_TEST_MSSQL_HOST=127.0.0.1 QA_TEST_MSSQL_PORT=51433 QA_TEST_MSSQL_DATABASE=qa_crawler QA_TEST_MSSQL_USERNAME=sa QA_TEST_MSSQL_PASSWORD=<Test-1> QA_TEST_MSSQL_TRUST_CERT=true
npx vitest run tests/integration/persistence-postgres.test.ts tests/integration/persistence-sqlserver.test.ts
```

Sans ces variables, ces tests sont ignorés (et l'indiquent) ; les providers mémoire, fichier et SQLite sont testés à chaque `npm test`.

## Corrélation réseau

Chaque action ouvre une fenêtre d'observation réseau, fermée une fois l'état suivant observé. Les échanges vus entre les deux sont attachés à la transition :

```json
{
  "from": "users-list",
  "action": { "type": "click", "text": "Nouvel utilisateur" },
  "network": [
    {
      "method": "GET",
      "url": "https://app.example.com/api/roles",
      "status": 200,
      "durationMs": 42,
      "resourceType": "fetch"
    }
  ],
  "to": "create-user"
}
```

Seuls sont gardés la méthode, l'URL (passée au masquage des paramètres sensibles), le statut, la durée et le type de ressource. **Jamais** les en-têtes (Authorization, cookies), ni les corps, ni les mots de passe. Réglages : `network.trace` (par défaut `true`), `network.resourceTypes` (`[document, xhr, fetch]`), `network.maxRequestsPerAction` (50). Les échanges s'affichent sous chaque transition dans `flow-graph.html`.

## Ligne de commande

```bash
npm run qa -- scenarios/demo.yaml
npm run qa -- learn scenarios/demo.yaml
npm run qa -- verify scenarios/demo.yaml --baseline-dir baselines/qa
npm run qa -- --config scenarios/smoke.yaml --base-url https://pr-42.example.com --max-states 30 --max-actions 100
npm run qa -- scenarios/mon-flow.yaml --headed      # voir le navigateur (nécessite un écran)
npm run qa -- dry-run features/create-user.feature -c scenarios/demo.yaml   # voir « Dry Run »
npm run qa -- --help
```

Le terminal affiche :

- la mission, la cible, les objectifs, les limites, les règles de sécurité et les flows ;
- chaque nouvel état, action (avec son résultat), action bloquée, retour en arrière et interaction navigateur ;
- chaque étape des flows imposés ;
- les anomalies au fur et à mesure ;
- l'arbre des flows découverts ;
- le résumé et l'emplacement des rapports.

**Codes de sortie :** `0` aucune anomalie au niveau `report.failOnSeverity` ou au-dessus, `1` anomalies bloquantes ou régressions (`verify`), `2` usage ou mission invalide, ou `verify` sans baseline, `3` erreur d'exécution.

## Docker

L'image est basée sur l'image officielle Playwright (`mcr.microsoft.com/playwright:v1.56.1-noble`). Elle s'exécute avec l'utilisateur non-root `pwuser`, sans GPU, sans écran et sans privilège particulier.

```bash
docker build -t qa-crawler .

docker run --rm \
  -e QA_BASE_URL=https://staging.example.com \
  -v "$PWD/reports:/app/reports" -v "$PWD/screenshots:/app/screenshots" \
  qa-crawler --config scenarios/smoke.yaml
```

> Garde la version de `playwright` dans `package.json` et le tag de l'image dans le `Dockerfile` identiques.

## Kubernetes / OpenShift

L'image est prête pour un `Job` ou un `CronJob` :

- **Ressources :**
  - requests : `cpu: 500m`, `memory: 1Gi` ;
  - limits : `cpu: 1–2`, `memory: 2Gi` ;
  - la mémoire augmente avec les SPA lourdes et les captures pleine page.
- **Sans interface uniquement :** ni GPU, ni serveur X, ni `privileged`, ni capacité ajoutée. Chromium tourne sans son propre bac à sable (comportement par défaut de Playwright), ce qui permet un UID arbitraire.
- **UID arbitraire (OpenShift) :** les sorties sont accessibles en écriture au groupe 0 et `HOME=/tmp`, donc l'image fonctionne sous `restricted-v2`.
- **Mémoire partagée :** `--disable-dev-shm-usage` est activé par défaut. Sinon, monter un `emptyDir` (`medium: Memory`) sur `/dev/shm`.
- **Réseau :** sortie uniquement vers l'application cible (et son fournisseur d'identité pour l'authentification).
- **Sorties :** écrire `reports/` et `screenshots/` sur un volume monté. `--reports-dir` / `--screenshots-dir` changent les chemins.
- **Configuration :**
  - missions depuis une `ConfigMap` ;
  - l'URL via `QA_BASE_URL` ;
  - les identifiants depuis un `Secret` exposé en `QA_USERNAME` / `QA_PASSWORD`.

| Variable                     | Rôle                                                                 |
| ---------------------------- | -------------------------------------------------------------------- |
| `QA_BASE_URL`                | URL cible (remplace celle de la mission)                             |
| `QA_USERNAME`, `QA_PASSWORD` | Variables d'identifiants par défaut pour `auth.type: form` et `http` |
| `PLAYWRIGHT_BROWSERS_PATH`   | Emplacement de Chromium (défini par l'image Playwright)              |
| `NO_COLOR`                   | Sortie sans couleurs (défini dans l'image)                           |

## CI/CD

`.github/workflows/qa-crawler.yml` s'exécute à chaque push et pull request, dans cet ordre :

1. `npm ci`
2. vérification des types
3. lint
4. vérification du formatage
5. tests unitaires
6. build
7. installation de Chromium et tests d'intégration sur les applications de test fournies

Un job optionnel explore un vrai environnement et publie les rapports. Il s'exécute quand la variable de dépôt `TARGET_URL` est définie, ou lors d'un lancement manuel.

## Architecture

```
                         Mission YAML
                              |
                              v
                      QA Orchestrator
                              |
               +--------------+--------------+
               v                             v
          Flow Explorer                 Safety Policy
               |
               v
          UI Observation  (DOM · accessibilité · URL/état)
               |
               v
          Page Context ──> State Detector
               |
               +------------------------------------------+
               v                                          v
        Action Discovery (DOM)                 Browser Event Discovery
        (lien · bouton · onglet · champ…)      (auth native · dialogues · popups…)
               |                                          |
               v                                          |
        Action Scorer (poids · objectifs)                  |
               |                                          v
        Decision Engine ──> Safety Policy     Browser Interaction Manager ──> handlers
               |                                          |
               +---------------------+--------------------+
                                     v
                    Playwright ──> Chromium ──> Application
                                                    |
                              Réseau · Console · Erreurs de page
                                                    |
                                          Anomaly collector
                                                    |
                                   State Detector (nouvel état)
                                                    |
                                  Flow Graph (+ réseau par transition)
                                  /         |            \
                        Flow Memory    Baseline Store    Flow Diff Engine
                   (flow-graph.json)  (learn / verify)  (verify · explore · learn)
                                                    |
                                                Reporters
                                     JSON · HTML · Graphe · flow-diff.json
```

Chaque composant répond à une seule question : `UIObserver` (que vois-je ?), `ActionDiscovery` (que puis-je faire ?), `FormAnalyzer` (qu'attend ce formulaire ?), `TestDataProvider` (quelles données synthétiques ?), `ActionScorer` (qu'est-ce qui est intéressant ?), `DecisionEngine` (que dois-je essayer ?), `SafetyPolicy` (ai-je le droit ?), `PlaywrightActionExecutor` (exécute), observateurs (que s'est-il passé techniquement ?), `StateDetector` (dans quel état suis-je ?), `TestOracle` (le résultat semble-t-il correct ?), `FlowGraph` (qu'ai-je découvert ?), `RecoveryEngine` (comment continuer après un problème ?), `FlowMemory` (que connaissais-je déjà ?), reporters (comment l'expliquer ?).

Modes : **LEARN** (explorer, puis enregistrer la baseline), **VERIFY** (rejouer la baseline, détecter les régressions), **EXPLORE** (chercher du nouveau). Playwright reste uniquement le moteur d'exécution : la décision, le scoring, la sécurité, la mémoire et la comparaison n'en dépendent pas.

```
src/
├── main.ts, orchestrator.ts      point d'entrée ; mission → explorateur → rapports → verdict
├── cli/                          arguments, sortie console, codes de sortie
├── config/                       schéma de mission (zod) avec défauts, chargeur YAML, flows, migration V1
├── explorer/flow-explorer.ts     la boucle, pile de navigation, retour arrière, limites, flows imposés
├── observation/                  UIObserver (script d'instantané du DOM), StateDetector
├── discovery/                    ActionDiscovery (pure), construction des localisateurs
├── decision/                     interface DecisionEngine, RuleBasedDecisionEngine
├── policies/                     SafetyPolicy, NavigationPolicy, AllowedOriginPolicy, InteractionPolicy, vocabulaire
├── execution/                    PlaywrightActionExecutor, résolution des localisateurs
├── flows/                        exécution des étapes de flow, sécurité, périmètre de thenExplore, génération de flows YAML
│   └── gherkin/                  scénarios .feature → flows (lecteur Cucumber, phrases types FR/EN)
├── dry-run/                      Dry Run : FlowIntentGraph, DryRunEngine, IntentPathResolver, alignement,
│                                 réconciliation, flow suggéré (.feature / flow.yaml), rapport, orchestrateur
├── interactions/                 BrowserEventDiscovery, BrowserInteractionManager, handlers, CredentialProvider
├── data/                         TestDataProvider, DefaultTestDataProvider, données créées, TestDataCleanup
├── forms/                        FormAnalyzer, FormFillStrategy (plan), FormExerciser, tests de validation, OpenAPI
├── oracles/                      TestOracle : technique, écran, baseline, contrat (OpenAPI), CompositeTestOracle
├── recovery/                     RecoveryEngine, CircuitBreaker, StuckDetector
├── actors/                       AuthorizationObserver (plusieurs acteurs, règles d'accès)
├── accessibility/                vérifications de base, parcours clavier
├── logging/                      journal structuré du moteur (engine-log.jsonl)
├── visual/                       interface VisualComparator (sans implémentation)
├── graph/                        FlowGraph
├── memory/                       interface FlowMemory, JsonFlowMemory
├── persistence/                  PersistenceProvider (mémoire, fichier, base), repositories, KnowledgeService, enregistreur
│   └── database/                 DatabaseAdapter + SqlDialect (PostgreSQL, SQL Server, SQLite), migrations
├── observers/                    réseau, console, erreurs de page (avec rattachement)
├── anomaly/                      règles de gravité, collecteur d'anomalies
├── crawler/                      normalisation des URL et des routes
├── browser/                      cycle de vie de Chromium, captures
├── auth/                         authentification formulaire et HTTP (identifiants depuis l'environnement)
├── reporting/                    construction du résultat, JSON, HTML, graphe HTML, arbre, traductions (en/fr)
├── security/                     masquage des secrets
└── model/                        PageContext, DiscoveredAction, LocatorDescriptor, FlowNode/Edge, Issue…
```

### Remplacer le moteur de décision

```ts
interface DecisionEngine {
  readonly name: string;
  decide(context: PageContext, graph: FlowGraph): Promise<ActionDecision>; // EXECUTE | BACKTRACK | STOP
}
```

Le moteur ne reçoit que des données simples et sérialisables :

- le `PageContext` : URL, état, titres, extrait de texte, actions classées avec leurs localisateurs, formulaires, erreurs connues ;
- le `FlowGraph`.

Un `LocalLLMDecisionEngine` ou un `CloudLLMDecisionEngine` peut être passé à `runMission(config, { decisionEngine })`. Rien d'autre ne change : l'explorateur, le contrôle de sécurité, l'exécuteur et les observateurs restent identiques.

Cette version ne contient **aucun code ni dépendance LLM** (ni OpenAI, ni Anthropic, ni Gemini, ni Ollama, ni LangChain). Les points d'extension sont des interfaces : `DecisionEngine` (choix de l'action), `FormFillStrategy` et `TestDataProvider` (raisonnement sur un formulaire), `SemanticOracle` (résultat métier), `VisualComparator`, `TestDataCleanup`.

## Développement

```bash
npm run typecheck        # tsc --noEmit (strict)
npm run lint             # ESLint, typescript-eslint strict type-checked
npm run format:check     # Prettier
npm test                 # tests unitaires (Vitest), sans navigateur
npm run test:integration # vrai Chromium sur les applications de test fournies
npm run build            # dist/
```

**Les tests unitaires** couvrent :

- `ActionDiscovery`, les descripteurs de localisateurs et leur traduction Playwright ;
- `StateDetector`, `FlowGraph` et `JsonFlowMemory` ;
- `SafetyPolicy`, `NavigationPolicy` et `RuleBasedDecisionEngine` ;
- le schéma des flows, leur sécurité et le périmètre de `thenExplore` ;
- le `BrowserInteractionManager`, l'`InteractionPolicy`, l'`AllowedOriginPolicy` et les `Credentials` ;
- le `TestDataProvider`, la normalisation des routes et des URL, les traductions ;
- le chargeur de configuration, le masquage des secrets, l'arbre des flows et les arguments de la CLI.

**Les tests d'intégration** utilisent de vraies pages locales :

- `tests/fixtures/flow-app.ts`, un mini back-office. Le test vérifie que l'explorateur découvre :
  - les écrans ;
  - les onglets et les 3 étapes d'assistant sur une seule URL ;
  - les transitions, avec retour en arrière ;
  - l'arbre attendu.

  Il vérifie aussi qu'aucun point d'accès destructif n'est jamais appelé et que le champ de carte bancaire n'est jamais rempli.

- `tests/fixtures/test-site.ts`, un site plein de bugs et de pièges : chaque anomalie doit être détectée et rattachée, sans fuite de secret.
- les flows imposés (assistant, MUTATION, DANGEROUS, mot de passe depuis l'environnement, fenêtre modale, `thenExplore`) ;
- l'authentification HTTP native (identifiants présents, absents, invalides, retry, boucle, origine interdite) et les autres interactions navigateur (dialogues, popup, nouvel onglet, téléchargement, fichier, permission, navigation externe) ;
- `tests/fixtures/acceptance-app.ts`, l'application d'acceptation (connexion, tableau de bord, utilisateurs liste/création/détail, assistant, dialogue, API cassée, branche cassée, pagination sans fin, erreur JavaScript, session qui expire). Avec la mission d'acceptation, sans flow écrit à la main, le test vérifie que l'explorateur : découvre le formulaire, génère les données, remplit les champs, suit l'assistant, détecte le HTTP 500, produit un FAIL via le `TechnicalOracle`, détecte une différence avec la baseline, se rétablit (échec, session expirée), évite la boucle et continue après une branche cassée ;
- la récupération, le coupe-circuit et la détection de blocage, plusieurs acteurs et leurs règles, l'accessibilité, le budget de modifications, le journal moteur ;
- l'absence de tout secret (mot de passe, cookie, jeton Bearer, clé d'API, jeton d'URL) dans tous les fichiers produits.

## Limites de cette version

- Un seul onglet de navigateur : l'exploration est séquentielle.
- `verify` rejoue les transitions de l'exploration autonome. Les flows imposés sont relancés tels quels ; un formulaire rempli n'est rejoué que s'il est sur le chemin d'un état ; les échecs déjà connus de la baseline ne sont pas rejoués.
- Si l'empreinte d'un écran change (nouveau bouton, nouveau champ), ses transitions deviennent `UNREACHABLE` en `verify` : c'est voulu (l'écran a changé), le diff montre l'ancien et le nouvel état.
- L'empreinte d'état est heuristique : des écrans très dynamiques peuvent produire plus d'états que prévu (limité par `maxStatesPerRoute`).
- Le moteur à règles ne peut pas savoir ce que fait une icône sans libellé, donc les icônes ne sont jamais cliquées (sauf `allow: UNKNOWN` dans un flow).
- Les actions qui modifient des données (créer, enregistrer, envoyer) ne sont exécutées qu'avec `safety.mutations.enabled`, dans un budget, sur un environnement de test. Rien n'est supprimé automatiquement.
- Les oracles ne connaissent pas le métier : sans `SemanticOracle`, le résultat métier reste `UNKNOWN`. Les avertissements écran/baseline/contrat sont des signaux à confirmer.
- Les vérifications d'accessibilité sont un premier signal, pas un audit (contrastes, ARIA avancé et lecteurs d'écran non couverts).
- Les autres acteurs ne font qu'ouvrir les écrans trouvés par l'utilisateur principal : ce qu'ils peuvent faire sur ces écrans n'est pas exploré.
- Le retour en arrière par rejouée demande un chemin déterministe ; les états impossibles à restaurer sont ignorés.
- Une seule exploration par run (celle de l'utilisateur principal). La double authentification (MFA/OTP) et les sessions sauvegardées ne sont pas encore gérées.
- Interactions navigateur : l'authentification HTTP est détectée via le protocole de Chromium (Chromium uniquement). Quand une popup est défiée avant que le crawler s'y attache (SSO SiteMinder par exemple), son chargement est rejoué une fois pour capter le défi. Un défi venant d'une iframe d'un autre domaine ou d'un service worker n'est pas vu. NTLM/Kerberos dépendent du serveur. Les popups et nouveaux onglets sont observés puis fermés, pas explorés en parallèle. Les sélecteurs de fichier ne reçoivent jamais de fichier.
- Les iframes et les _shadow roots_ fermés (`mode: 'closed'`) ne sont pas explorés ; les _shadow roots_ ouverts le sont.

## Feuille de route

- Une exploration complète par acteur (SSO/OIDC, sessions sauvegardées)
- Tests d'API à partir du contrat OpenAPI
- Comparaison visuelle entre runs : une implémentation de `VisualComparator` (captures par état)
- Nettoyage automatique des données créées, par une implémentation de `TestDataCleanup` propre à l'application
- Génération de tests Playwright à partir des flows enregistrés (les localisateurs sont déjà sérialisables)
- Reproduction de bug : à partir d'une anomalie, rejouer le chemin minimal (état → action → réseau) qui la déclenche
- Plusieurs baselines comparées dans le temps (tendance des états, des régressions, des temps de réponse)
- Moteurs de décision derrière l'interface `DecisionEngine`, dont un LLM local optionnel
- Runs sur des environnements par pull request, avec un commentaire automatique sur la PR
- Exploration parallèle, `FlowMemory` SQLite/PostgreSQL, manifestes `Job` Kubernetes
