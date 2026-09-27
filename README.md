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
- [Authentification](#authentification)
- [Interactions navigateur](#interactions-navigateur)
- [Sécurité](#sécurité)
- [Détection des états et protection contre les boucles](#détection-des-états-et-protection-contre-les-boucles)
- [Formulaires](#formulaires)
- [Ce qui est détecté](#ce-qui-est-détecté)
- [Rapports](#rapports)
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

| Étape               | Exemple                                          | Effet                                                                                     |
| ------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `goto`              | `goto: /dossiers`                                | Charge une page (relative à `target.baseUrl`)                                             |
| `click`             | `click: { role: button, name: Suivant }`         | Clique l'élément                                                                          |
| `fill`              | `fill: { label: Titre, value: Devoir QA }`       | Saisit une valeur ; `value: { env: NOM }` la lit dans une variable d'environnement        |
| `select`            | `select: { label: Classe, option: M1 Dimanche }` | Liste native `<select>`, ou `mat-select` Angular : ouvre la liste puis clique l'option    |
| `check` / `uncheck` | `check: { label: J'accepte les conditions }`     | Coche / décoche une case                                                                  |
| `expect`            | `expect: { text: Étape 2 }`                      | Attend que ce soit vrai : `text`, `url` (contient), `visible: <cible>`, `hidden: <cible>` |
| `screenshot`        | `screenshot: confirmation`                       | Capture nommée, avec un lien dans le rapport                                              |

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

| Élément ciblé                                                       | Exécuté ?                                            |
| ------------------------------------------------------------------- | ---------------------------------------------------- |
| SÛR : navigation, onglet, « Suivant », champ normal                 | oui                                                  |
| MODIFICATION : créer, enregistrer, nouveau, envoi de formulaire     | seulement avec `allow: MUTATION` sur l'étape         |
| Icône sans texte                                                    | seulement avec `allow: UNKNOWN` sur l'étape          |
| DANGEREUX : supprimer, payer, envoyer, déconnexion                  | **jamais**                                           |
| Mot de passe, code, secret                                          | seulement avec `value: { env: NOM }`, jamais affiché |
| Carte bancaire, CVV, IBAN                                           | **jamais**                                           |
| Lien ou `goto` hors des hôtes autorisés, chemin ignoré ou dangereux | **jamais**                                           |

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

| Classe      | Exemples                                                                                                              | Exécutée ?                               |
| ----------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `SAFE`      | navigation, onglets, menus, détails, pagination, recherche, filtres, « Suivant » d'un assistant, champ (non sensible) | oui, si son type est dans `safety.allow` |
| `MUTATION`  | créer, enregistrer, modifier, update, submit (envoi de formulaire), oui/ok/confirmer                                  | **jamais** par défaut                    |
| `DANGEROUS` | supprimer/delete, payer/payment, checkout, envoyer/send, réinitialiser, déconnexion/logout, champs sensibles          | **jamais** par défaut                    |
| `UNKNOWN`   | contrôles sans libellé lisible (`⚙`, `×`, icône seule)                                                                | **jamais**                               |

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

**6. Aucun secret dans les sorties.** Jetons, mots de passe, en-têtes `Authorization`, cookies, JWT et paramètres d'URL sensibles sont masqués dans les logs et les rapports. Les en-têtes, corps de requêtes et valeurs des champs ne sont jamais enregistrés.

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

Les nombres sont masqués : `/users/1` et `/users/2` (« Utilisateur 1/2 ») sont un seul état.

Le résultat est un `stateId` lisible et stable, par exemple `parametres-securite-f3a0baba`.

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
- **Valeurs :**
  1. celles de la mission, par champ (`testData.fields`) ;
  2. sinon, d'après l'aide affichée par l'application : `99999` → 5 chiffres, `HH:MM` → `10:00`, `AAAA-MM-JJ` / `JJ/MM/AAAA` → date du jour dans ce format ;
  3. sinon, des valeurs factices déterministes : e-mail `qa-crawler@example.test`, texte `QA Test`, nombres dans min/max/step, dates dans les bornes, première vraie option d'une liste.

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
- **Rien n'est envoyé.** Un bouton qui envoie son formulaire (`submit`, ou « Soumettre », « Enregistrer », « Valider », « Créer »… dans un formulaire ou une fenêtre qui contient des champs) porte le risque `form-submit`, bloqué par défaut, même quand `MUTATION` est autorisé. Pour l'autoriser : `forms.submit: true`, ou `allow: MUTATION` sur l'étape d'un flow imposé. « Suivant » d'un assistant reste une étape.
- **Jamais remplis :** les champs sensibles (mot de passe, carte, IBAN, secret, OTP), même listés dans `testData.fields`.
- Une fois le formulaire rempli, ses champs ne sont pas réessayés un par un. Quand un chemin est rejoué, le formulaire est rempli à nouveau avec les mêmes valeurs.

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

| Fichier                               | Contenu                                                                                                                                                                                       |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reports/result.json`                 | Résumé et statistiques de la mission. États avec leurs actions complètes (localisateurs, classe) et formulaires, transitions, flows, interactions navigateur, anomalies, paramètres effectifs |
| `reports/index.html`                  | Rapport statique : cartes de synthèse, flows imposés, interactions navigateur, arbre des flows découverts, anomalies (état · action · flow), états, actions exécutées et bloquées, captures   |
| `reports/flow-graph.json`             | Le graphe des flows, qui sert de mémoire à l'explorateur (reprise possible avec `memory.resume`)                                                                                              |
| `reports/flow-graph.html`             | Carte de l'application : arbre dépliable, arbre texte, transitions entre états, autres tentatives                                                                                             |
| `screenshots/NNN-<état>[-error…].png` | Une par état découvert, plus une par anomalie ERROR/CRITICAL et par étape `screenshot`                                                                                                        |

Les rapports n'utilisent ni JavaScript, ni framework, ni ressource externe.

**Rapports en français.** Avec `report.language: fr`, `index.html` et `flow-graph.html` sont en français : titres, colonnes, statuts (`RÉUSSI`, `ÉCHOUÉ`, `BLOQUÉ`, `IGNORÉ`), classes, gravités et raisons de la politique de sécurité. `result.json` et `flow-graph.json` restent toujours en anglais, pour que les outils et la CI lisent les mêmes clés et valeurs.

```yaml
report:
  language: fr # en (défaut) | fr
```

## Ligne de commande

```bash
npm run qa -- scenarios/demo.yaml
npm run qa -- --config scenarios/smoke.yaml --base-url https://pr-42.example.com --max-states 30 --max-actions 100
npm run qa -- scenarios/mon-flow.yaml --headed      # voir le navigateur (nécessite un écran)
npm run qa -- --help
```

Le terminal affiche :

- la mission, la cible, les objectifs, les limites, les règles de sécurité et les flows ;
- chaque nouvel état, action (avec son résultat), action bloquée, retour en arrière et interaction navigateur ;
- chaque étape des flows imposés ;
- les anomalies au fur et à mesure ;
- l'arbre des flows découverts ;
- le résumé et l'emplacement des rapports.

**Codes de sortie :** `0` aucune anomalie au niveau `report.failOnSeverity` ou au-dessus, `1` anomalies bloquantes, `2` usage ou mission invalide, `3` erreur d'exécution.

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
               v                                          v
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
                                               Flow Graph
                                               /        \
                                      Flow Memory     Reporters
                                 (flow-graph.json)  JSON · HTML · Graphe
```

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
├── flows/                        exécution des étapes de flow, sécurité et périmètre de thenExplore
├── interactions/                 BrowserEventDiscovery, BrowserInteractionManager, handlers, CredentialProvider
├── data/                         TestDataProvider, DefaultTestDataProvider
├── graph/                        FlowGraph
├── memory/                       interface FlowMemory, JsonFlowMemory
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

Cette version ne contient **aucun code ni dépendance LLM**.

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
- l'authentification HTTP native (identifiants présents, absents, invalides, retry, boucle, origine interdite) et les autres interactions navigateur (dialogues, popup, nouvel onglet, téléchargement, fichier, permission, navigation externe).

## Limites de cette version

- Un seul onglet de navigateur : l'exploration est séquentielle.
- L'empreinte d'état est heuristique : des écrans très dynamiques peuvent produire plus d'états que prévu (limité par `maxStatesPerRoute`).
- Le moteur à règles ne peut pas savoir ce que fait une icône sans libellé, donc les icônes ne sont jamais cliquées (sauf `allow: UNKNOWN` dans un flow).
- Les actions qui modifient des données (créer, enregistrer, envoyer) ne sont jamais exécutées automatiquement. Leurs effets ne sont explorés que si elles sont explicitement autorisées, sur un environnement jetable.
- Le retour en arrière par rejouée demande un chemin déterministe ; les états impossibles à restaurer sont ignorés.
- Un seul rôle par run. La double authentification (MFA/OTP) et les sessions sauvegardées ne sont pas encore gérées.
- Interactions navigateur : l'authentification HTTP est détectée via le protocole de Chromium (Chromium uniquement). Quand une popup est défiée avant que le crawler s'y attache (SSO SiteMinder par exemple), son chargement est rejoué une fois pour capter le défi. Un défi venant d'une iframe d'un autre domaine ou d'un service worker n'est pas vu. NTLM/Kerberos dépendent du serveur. Les popups et nouveaux onglets sont observés puis fermés, pas explorés en parallèle. Les sélecteurs de fichier ne reçoivent jamais de fichier.
- Le Shadow DOM et les iframes ne sont pas explorés.

## Feuille de route

- Authentification multi-rôles (une exploration par rôle, SSO/OIDC, sessions sauvegardées)
- Tests automatiques des formulaires avec le `TestDataProvider` : champs obligatoires, e-mail invalide, valeurs min/max et limites
- Tests de permissions (ce qu'un rôle ne doit pas atteindre)
- Import OpenAPI et tests d'API
- Comparaison visuelle entre runs (captures par état)
- Génération de tests Playwright à partir des flows enregistrés (les localisateurs sont déjà sérialisables)
- Moteurs de décision derrière l'interface `DecisionEngine`, dont un LLM local optionnel
- Runs sur des environnements par pull request, avec un commentaire automatique sur la PR
- Exploration parallèle, `FlowMemory` SQLite/PostgreSQL, manifestes `Job` Kubernetes
