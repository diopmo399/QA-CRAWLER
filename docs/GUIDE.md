# Guide d'utilisation de QA-CRAWLER

Ce guide présente **chaque fonctionnalité** et **les différentes manières de l'utiliser**, avec un exemple prêt à copier. Il est organisé par besoin : « je veux faire X ». Le [README](../README.md) donne ensuite tous les détails (chaque clé, chaque statut, l'architecture).

> Rien dans QA-CRAWLER n'utilise d'IA : même application, même mission, même résultat.

## Sommaire

1. [Installer et lancer](#1-installer-et-lancer)
2. [Donner les identifiants (terminal, `.env`, CI)](#2-donner-les-identifiants)
3. [Explorer une application tout seul](#3-explorer-une-application-tout-seul)
4. [Imposer un parcours précis (flows YAML)](#4-imposer-un-parcours-précis-flows-yaml)
5. [Écrire les tests en Gherkin (4 manières)](#5-écrire-les-tests-en-gherkin)
6. [Vérifier un scénario contre l'application (Dry Run)](#6-vérifier-un-scénario-contre-lapplication-dry-run)
7. [Se connecter à l'application](#7-se-connecter-à-lapplication)
8. [Sécurité : ce qui peut être cliqué ou modifié](#8-sécurité--ce-qui-peut-être-cliqué-ou-modifié)
9. [Formulaires et données de test](#9-formulaires-et-données-de-test)
10. [Détecter les régressions (learn / verify / explore)](#10-détecter-les-régressions)
11. [Générer des tests à partir de l'exploration](#11-générer-des-tests-à-partir-de-lexploration)
12. [Comparer les droits de plusieurs utilisateurs](#12-comparer-les-droits-de-plusieurs-utilisateurs)
13. [Mémoire et persistance d'un run à l'autre](#13-mémoire-et-persistance)
14. [Lire les résultats](#14-lire-les-résultats)
15. [Lancer en CI, Docker, Kubernetes](#15-ci-docker-kubernetes)
16. [Référence de la ligne de commande](#16-référence-de-la-ligne-de-commande)
17. [Dépannage](#17-dépannage)

---

## 1. Installer et lancer

**Une fois :**

```bash
npm install
npx playwright install chromium
```

**Trois manières de lancer :**

| Manière            | Commande                                                           | Quand                       |
| ------------------ | ------------------------------------------------------------------ | --------------------------- |
| Depuis les sources | `npm run qa -- scenarios/ma-mission.yaml`                          | sur ton poste, au quotidien |
| Version compilée   | `npm run build` puis `node dist/main.js scenarios/ma-mission.yaml` | serveur, script, sans `tsx` |
| Image Docker       | `docker run --rm qa-crawler --config scenarios/ma-mission.yaml`    | CI, Kubernetes / OpenShift  |

**Essayer sans ton application** (applications de démo fournies) :

```bash
npm run demo:server                          # terminal 1
npm run qa -- scenarios/demo.yaml            # terminal 2 : exploration
npm run qa -- scenarios/demo-traps.yaml      # pages cassées, erreurs, boucles
```

**Voir le navigateur travailler :** ajoute `--headed` (et `browser.slowMoMs: 500` dans la mission pour ralentir).

---

## 2. Donner les identifiants

Les identifiants ne sont **jamais** écrits dans une mission ou un `.feature` : seulement le **nom** d'une variable d'environnement. Leurs valeurs ne sont jamais affichées dans la console, les journaux ou les rapports.

**Manière 1 — un fichier `.env` (recommandé sur ton poste).** Il est lu automatiquement par toutes les commandes, et il est dans le `.gitignore`.

```bash
cp .env.example .env        # Windows : copy .env.example .env
```

```dotenv
QA_BASE_URL=https://qa.example.com
QA_USERNAME=mon-identifiant
QA_PASSWORD='mot de passe # avec espace'
```

**Manière 2 — un autre fichier :** `npm run qa -- --dotenv .env.recette scenarios/ma-mission.yaml`

**Manière 3 — dans le terminal** (prioritaire sur le fichier) :

```bash
# macOS / Linux
QA_USERNAME=moi QA_PASSWORD='secret' npm run qa -- scenarios/ma-mission.yaml
# Windows PowerShell
$env:QA_USERNAME="moi"; $env:QA_PASSWORD="secret"; npm run qa -- scenarios/ma-mission.yaml
```

**Manière 4 — en CI ou Kubernetes :** secrets du pipeline ou `Secret` Kubernetes exposés en variables d'environnement.

**Utiliser une variable dans un test :**

| Où           | Syntaxe                                                                             |
| ------------ | ----------------------------------------------------------------------------------- |
| Mission YAML | `fill: { label: Mot de passe, value: { env: APP_PASSWORD } }`                       |
| Connexion    | `auth: { usernameEnv: QA_USERNAME, passwordEnv: QA_PASSWORD }` (valeurs par défaut) |
| Gherkin      | `\| Mot de passe \| <env:APP_PASSWORD> \|`                                          |

---

## 3. Explorer une application tout seul

Tu donnes une adresse et des limites ; il découvre lui-même les écrans, menus, onglets, fenêtres, assistants et formulaires, et signale ce qui est cassé (pages 404/500, appels d'API en échec, erreurs JavaScript, boucles…).

**Le minimum :**

```yaml
mission: { name: exploration }
target:
  baseUrl: https://qa.example.com
  startAt: /
```

**Avec des limites et un objectif :**

```yaml
mission: { name: exploration-utilisateurs }
target: { baseUrl: https://qa.example.com, startAt: / }
exploration:
  maxStates: 50 # écrans distincts au plus
  maxActions: 200
  maxDepth: 8
  maxDurationMinutes: 10
goals:
  keywords: [utilisateurs, users] # ce qu'il cherche en priorité
report: { language: fr }
```

**Manières de régler l'exploration :**

| Besoin                                         | Réglage                                                                            |
| ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| Aller plus vite / moins loin                   | `exploration.maxStates`, `maxActions`, `maxDepth`, `--max-states`, `--max-actions` |
| Rester dans une partie de l'application        | `safety.ignoredPaths`, `safety.allowedHosts`                                       |
| Application lente (roues de chargement)        | `exploration.readyTimeoutMs: 20000`                                                |
| Seulement les flows imposés, pas d'exploration | `exploration.autonomous: false`                                                    |
| Explorer seulement l'écran atteint par un flow | `thenExplore: true` sur le flow                                                    |
| Reprendre là où le run précédent s'est arrêté  | `memory.resume: true`                                                              |

---

## 4. Imposer un parcours précis (flows YAML)

Un **flow imposé** suit des étapes dans l'ordre. La sécurité s'applique à chaque étape.

```yaml
flows:
  - name: creer-un-dossier
    startAt: /dossiers
    steps:
      - click: { role: button, name: Nouveau dossier }
        allow: MUTATION
      - fill: { label: Titre, value: Dossier de test }
      - select: { label: Catégorie, option: Standard }
      - check: { label: J'accepte les conditions }
      - click: { role: button, name: Suivant }
      - expect: { text: Étape 2 }
      - screenshot: etape-2
      - click: { role: button, name: Enregistrer }
        allow: MUTATION
      - expect: { text: Dossier enregistré }
```

**Les étapes :** `goto`, `click`, `fill`, `select`, `check` / `uncheck`, `expect` (`text`, `url`, `visible`, `hidden`, `noError`, `response`), `screenshot`, `manual`, `run`.

**Cinq manières de désigner un élément :**

| Manière          | Exemple                                    | Conseil                           |
| ---------------- | ------------------------------------------ | --------------------------------- |
| rôle + nom       | `{ role: button, name: Enregistrer }`      | la plus robuste                   |
| libellé          | `{ label: Titre }`                         | champs avec `<label>`             |
| texte visible    | `{ text: Traiter la demande }`             | liens sans adresse, textes        |
| identifiant test | `{ testId: btn-save }`                     | si l'équipe met des `data-testid` |
| CSS              | `{ css: 'input[formcontrolname="code"]' }` | dernier recours                   |

`nth: 2` prend le 3ᵉ élément trouvé ; `exact: true` exige le texte exact.

**Options utiles :**

| Option                          | Effet                                                               |
| ------------------------------- | ------------------------------------------------------------------- |
| `allow: MUTATION` (étape)       | autorise une création / modification pour cette étape               |
| `optional: true` (étape)        | un échec devient un avertissement, le flow continue                 |
| `timeoutMs` (étape)             | délai de cette étape                                                |
| `reusable: true` (flow)         | flow rejoué seulement par `run:` (une précondition écrite une fois) |
| `run: creer-un-dossier` (étape) | rejoue ici un flow réutilisable                                     |
| `thenExplore: true` (flow)      | explore aussi l'écran atteint                                       |

**Élément introuvable ?** Le rapport propose l'étape corrigée, prête à copier, avec la liste des libellés présents à l'écran.

---

## 5. Écrire les tests en Gherkin

Les fichiers `.feature` (français ou anglais) s'exécutent comme des flows imposés :

```yaml
flows:
  - gherkin: ./features/dossiers.feature
    tags: ['@smoke'] # facultatif
    scenarios: ['Création simple'] # facultatif
```

Il y a **quatre manières** de faire comprendre une phrase, essayées dans cet ordre :

### Manière 1 — les phrases intégrées

```gherkin
# language: fr
Fonctionnalité: Dossiers
  @mutation
  Scénario: Création simple
    Étant donné que je suis sur "/dossiers"
    Quand je clique sur le bouton "Nouveau dossier"
    Et je saisis "Dossier de test" dans "Titre"
    Et je choisis "Standard" dans "Catégorie"
    Et je coche la case "J'accepte les conditions"
    Et je clique sur "Enregistrer"
    Alors je vois "Dossier enregistré"
    Et l'URL contient "/dossiers/"
```

Autres phrases : `je remplis le formulaire :` + tableau, `je ne vois pas "…"`, `aucun message d'erreur n'est affiché`, `la requête PUT "/api/x" réussit`, `je prends une capture "nom"`. Liste complète : README, « Scénarios Gherkin ».

### Manière 2 — les phrases de l'équipe (`gherkin.steps`)

Une phrase métier est traduite **une fois** dans la mission :

```yaml
gherkin:
  steps:
    - pattern: je traite la première demande
      step: { click: { text: Traiter la demande } }
    - pattern: un dossier est créé
      steps: [{ run: creer-un-dossier }] # précondition = un flow réutilisable
    - pattern: "l'utilisateur change le code de {ancien:mot} à {nouveau:mot}"
      steps:
        - fill: { label: Code, value: '{nouveau}' }
        - click: { role: button, name: Valider }
      allow: MUTATION
    - pattern: aucune autre donnée n'est modifiée
      manual: true # « À VÉRIFIER » dans le rapport
```

### Manière 3 — la résolution sémantique (sans connaître les libellés exacts)

```yaml
gherkin:
  semanticResolution: { enabled: true }
```

```gherkin
Quand je clique sur créer un utilisateur
Et je renseigne le courriel avec "julie@example.test"
Et je sélectionne "Administrateur" comme rôle
Et je valide le formulaire
Alors un message de confirmation est affiché
```

Il trouve le bon champ par son sens (« courriel » ↔ « Adresse électronique »). S'il hésite entre deux cibles, il ne devine jamais : l'étape est `AMBIGUOUS` avec les candidats. Un même lien répété sur chaque ligne d'une liste prend la **première ligne**.

### Manière 4 — le mode automatique (`gherkin.auto: true`)

Une phrase inconnue est interprétée **sur l'écran** au moment de l'exécution (noms entre guillemets à cliquer, champ nommé dans la phrase à remplir, valeurs à vérifier). Ce qui reste incompréhensible devient « À VÉRIFIER », jamais une action devinée.

**Tags :**

| Tag                                    | Effet                                   |
| -------------------------------------- | --------------------------------------- |
| `@mutation` (`@dangerous`, `@unknown`) | autorise les modifications du scénario  |
| `@explorer`                            | explore l'écran atteint                 |
| `@ignore`, `@skip`, `@wip`             | scénario non exécuté                    |
| `(optionnel)` en fin de phrase         | un échec de cette étape = avertissement |

Un **Plan du scénario** donne un test par ligne d'**Exemples** ; le **Contexte** est joué avant chaque scénario.

---

## 6. Vérifier un scénario contre l'application (Dry Run)

Le Dry Run prend un scénario (`.feature` ou `flow.yaml`) et vérifie s'il correspond **vraiment** à l'application. S'il manque des étapes, il explore pour les trouver, ne s'arrête pas au premier écart, puis propose **un flow complet corrigé**. Le fichier d'origine n'est jamais modifié.

**Manières de le lancer :**

```bash
# 1. un .feature avec la mission (cible, connexion, sécurité, phrases de l'équipe)
npm run qa -- dry-run features/dossiers.feature -c scenarios/ma-mission.yaml

# 2. un flow YAML
npm run qa -- dry-run flows/creer-dossier.flow.yaml -c scenarios/ma-mission.yaml

# 3. la mission elle-même : vérifie ses propres flows
npm run qa -- dry-run scenarios/ma-mission.yaml

# 4. sans mission : seulement une adresse
npm run qa -- dry-run features/dossiers.feature --base-url https://qa.example.com
```

**Options :**

| Option                                                    | Effet                                                  |
| --------------------------------------------------------- | ------------------------------------------------------ |
| `--output-format gherkin\|yaml\|both`                     | format du flow suggéré                                 |
| `--use-history` / `--no-history`                          | essayer d'abord les chemins déjà connus, ou non        |
| `--isolated-memory`                                       | ne pas partager la mémoire avec les runs de la mission |
| `--max-actions 60`, `--max-depth 10`, `--max-duration 2m` | budgets de recherche                                   |
| `--headed`                                                | voir le navigateur                                     |

**Ce que tu obtiens** (dans `reports/dry-run/<scénario>/`) : `index.html` (original et suggéré côte à côte, avec l'explication de chaque différence), `suggested.feature`, `suggested.flow.yaml`, `reconciliation.json`.

**Statuts d'une étape :** `MATCHED` (trouvée), `INSERTED` (étape de l'application absente du scénario), `REORDERED` (ailleurs dans l'ordre), `ALTERNATIVE`, `POSSIBLY_OBSOLETE` (introuvable, jamais supprimée), `MISSING`, `UNREACHABLE`, `AMBIGUOUS`, `ASSERTION_MISMATCH`, `BLOCKED_BY_POLICY`, `NOT_VERIFIED`.

**Statut global :** `FULLY_MATCHED`, `PARTIALLY_MATCHED`, `DIVERGED`, `BLOCKED`, `INCONCLUSIVE`.

**Bon à savoir :**

- En Dry Run, la résolution sémantique et le mode automatique sont actifs par défaut.
- Une précondition (« Étant donné qu'une demande est créée ») doit être traduite dans `gherkin.steps` (`run: …`), sinon tout ce qui suit reste `NOT_VERIFIED`.
- Pour revenir à un écran, il utilise le « Précédent » du navigateur (sans recharger une application monopage) et ne refait **jamais** une action qui modifie des données.

---

## 7. Se connecter à l'application

| Manière                              | Quand                                              | Réglage                               |
| ------------------------------------ | -------------------------------------------------- | ------------------------------------- |
| Formulaire de connexion dans la page | page de connexion classique ou page SSO            | `auth.type: form`                     |
| Fenêtre grise du navigateur          | HTTP Basic / NTLM (« Se connecter » du navigateur) | `auth.type: http`                     |
| Popup SSO                            | la connexion s'ouvre dans une popup                | `credentials` + `browserInteractions` |
| Un flow de connexion                 | connexion en plusieurs étapes particulières        | un flow `reusable` + `run:`           |

**Formulaire :**

```yaml
auth:
  type: form
  loginUrl: /login
  usernameSelector: input[name="username"]
  passwordSelector: input[type="password"]
  submitSelector: button[type="submit"]
  successUrlContains: /app/
```

**Fenêtre du navigateur :**

```yaml
auth:
  type: http
  origin: https://sso.example.com # seul serveur qui reçoit les identifiants
```

**Popup SSO :** voir [`scenarios/sso-popup.yaml`](../scenarios/sso-popup.yaml).

---

## 8. Sécurité : ce qui peut être cliqué ou modifié

Par défaut, **rien n'est modifié** : seules les actions sûres (navigation, onglets, recherche, filtres, pagination…) sont exécutées.

| Élément                                       | Exécuté ?                                                                     |
| --------------------------------------------- | ----------------------------------------------------------------------------- |
| Navigation, onglet, « Suivant », champ normal | oui                                                                           |
| Créer, enregistrer, envoyer un formulaire     | avec `allow: MUTATION` (étape) ou `@mutation` (Gherkin)                       |
| Icône sans texte                              | avec `allow: UNKNOWN`                                                         |
| Supprimer, payer, déconnexion                 | avec `allow: DANGEROUS` **et** `DANGEROUS` dans `safety.allowedActionClasses` |
| Carte bancaire, IBAN                          | **jamais**                                                                    |
| Autre site, chemin ignoré                     | **jamais**                                                                    |

**Autoriser les modifications pendant l'exploration** (environnement de test seulement) :

```yaml
safety:
  mutations: { enabled: true, maxPerRun: 10 } # budget
  allowedActionClasses: [SAFE, MUTATION]
```

**Garanties :** une action de modification n'est jamais refaite pour revenir à un écran ; les données créées sont listées dans le rapport (avec le marqueur du run) ; rien n'est supprimé automatiquement.

> Sur une vraie application partagée, garde `safety.mutations.enabled: false`.

---

## 9. Formulaires et données de test

Pendant l'exploration, un formulaire est **rempli comme un utilisateur** (même sans balise `<form>`, y compris les champs sans libellé), puis sa validation est vérifiée. Rien n'est envoyé par défaut.

**Manières de choisir les valeurs** (par priorité) :

1. **Par champ, dans la mission :**
   ```yaml
   testData:
     fields:
       Code agence: '12345'
       Numéro de dossier: { value: '100200' }
   ```
2. **Selon le sens du champ :** une personne fictive cohérente par run (prénom, nom, courriel `…@example.test`, téléphone 555-01xx, adresse…), ou l'aide affichée (`99999` → 5 chiffres, `JJ/MM/AAAA` → date du jour).
3. **Selon le type :** nombres dans les bornes, dates valides, première vraie option d'une liste.

**Options :**

| Réglage                         | Effet                                                  |
| ------------------------------- | ------------------------------------------------------ |
| `forms.exercise: false`         | ne pas remplir les formulaires pendant l'exploration   |
| `forms.validationTesting: true` | essayer aussi des valeurs invalides (vide, trop long…) |
| `forms.submit: true`            | envoyer les formulaires (comme une MUTATION)           |
| `openapi: …`                    | compléter les contraintes avec le contrat d'API        |

Les champs sensibles (mots de passe, secrets) ne sont remplis qu'avec `value: { env: … }` ; les champs de paiement jamais.

---

## 10. Détecter les régressions

```bash
npm run qa -- learn   scenarios/app.yaml   # 1. construit la référence (baseline)
npm run qa -- verify  scenarios/app.yaml   # 2. rejoue chaque transition connue
npm run qa -- explore scenarios/app.yaml   # 3. cherche ce qui est nouveau
```

| Manière                                          | Commande                                                         |
| ------------------------------------------------ | ---------------------------------------------------------------- |
| Vérifier une autre version (environnement de PR) | `verify scenarios/app.yaml --base-url https://pr-42.example.com` |
| Garder plusieurs références                      | `--baseline-dir baselines/qa`                                    |
| Ne pas faire échouer la CI sur régression        | `verify: { failOnRegression: false }`                            |

Résultat de `verify` par transition : `PASSED`, `CHANGED`, `FAILED`, `ACTION_MISSING`, `UNREACHABLE` (régressions), `BLOCKED`, `SKIPPED`. Le **flow diff** liste les écrans et transitions ajoutés, disparus ou modifiés.

---

## 11. Générer des tests à partir de l'exploration

Après chaque run, les chemins trouvés sont écrits comme flows prêts à copier dans `reports/generated-flows.yaml` :

```yaml
flowGeneration: { enabled: true, maxFlows: 30 }
```

Relis-les, puis copie ceux qui t'intéressent sous `flows:` de ta mission : ce sont des tests de non-régression écrits sans effort. Le Dry Run, lui, produit un `suggested.feature` / `suggested.flow.yaml` corrigé pour un scénario donné.

---

## 12. Comparer les droits de plusieurs utilisateurs

Après l'exploration, chaque acteur ouvre les écrans trouvés (lecture seule) ; les différences d'accès sont signalées, et des règles les transforment en PASS / FAIL.

```yaml
actors:
  - name: lecteur
    auth:
      type: form
      loginUrl: /login
      usernameSelector: '#user'
      passwordSelector: '#pass'
      submitSelector: 'button[type=submit]'
      usernameEnv: QA_READER_USER
      passwordEnv: QA_READER_PASSWORD
authorization:
  primaryActor: admin
  rules:
    - { actor: lecteur, path: /admin/*, expect: denied }
    - { actor: lecteur, path: /rapports, expect: allowed }
```

---

## 13. Mémoire et persistance

- **Mémoire** : est-ce que les runs précédents aident le run actuel ?
- **Persistance** : où les runs sont enregistrés.

| Manière                                   | Réglage                                                       |
| ----------------------------------------- | ------------------------------------------------------------- |
| Rien d'enregistré (défaut)                | aucun bloc `persistence`                                      |
| Fichiers JSON locaux                      | `--persistence file`                                          |
| Base de données                           | `--persistence postgres` / `sqlserver` / `sqlite` + `QA_DB_*` |
| Enregistrer sans influencer les décisions | `--no-memory`                                                 |
| Dry Run sans toucher la mémoire commune   | `--isolated-memory`                                           |

Les identifiants de base de données viennent **toujours** de l'environnement (`QA_DB_USERNAME`, `QA_DB_PASSWORD`). Exemples : `scenarios/persistence-*.yaml`.

---

## 14. Lire les résultats

| Fichier                        | Contenu                                                        |
| ------------------------------ | -------------------------------------------------------------- |
| `reports/index.html`           | rapport complet : synthèse, flows, anomalies, écrans, captures |
| `reports/flow-graph.html`      | carte de l'application                                         |
| `reports/result.json`          | la même chose pour les outils (toujours en anglais)            |
| `reports/generated-flows.yaml` | flows générés                                                  |
| `reports/engine-log.jsonl`     | journal détaillé du moteur (secrets masqués)                   |
| `reports/dry-run/<scénario>/`  | résultats d'un Dry Run                                         |
| `screenshots/`                 | une capture par écran et par anomalie                          |

Rapports en français : `report: { language: fr }`. Faire échouer la CI à partir d'une gravité : `report.failOnSeverity`.

**Codes de sortie :** `0` OK · `1` anomalies bloquantes, régressions ou Dry Run en écart · `2` usage ou fichier invalide · `3` erreur d'exécution.

---

## 15. CI, Docker, Kubernetes

**Docker :**

```bash
docker build -t qa-crawler .
docker run --rm \
  -e QA_BASE_URL=https://staging.example.com \
  -e QA_USERNAME -e QA_PASSWORD \
  -v "$PWD/reports:/app/reports" -v "$PWD/screenshots:/app/screenshots" \
  qa-crawler --config scenarios/smoke.yaml
```

**Kubernetes / OpenShift :** `Job` ou `CronJob`, mission dans une `ConfigMap`, identifiants dans un `Secret`, `reports/` sur un volume. L'image tourne sans privilège et avec un UID arbitraire.

**CI :** `.github/workflows/qa-crawler.yml` vérifie le code à chaque PR ; un job optionnel explore un vrai environnement quand la variable `TARGET_URL` est définie.

---

## 16. Référence de la ligne de commande

```bash
npm run qa -- [learn|verify|explore] <mission.yaml> [options]
npm run qa -- dry-run <scénario.feature|flow.yaml|mission.yaml> [-c <mission.yaml>] [options]
```

| Option                                                 | Effet                                              |
| ------------------------------------------------------ | -------------------------------------------------- |
| `-c, --config <fichier>`                               | la mission                                         |
| `--base-url <url>`                                     | autre cible (aussi `QA_BASE_URL`)                  |
| `--max-states <n>`, `--max-actions <n>`                | limites                                            |
| `--headed`                                             | voir le navigateur                                 |
| `--reports-dir`, `--screenshots-dir`, `--baseline-dir` | dossiers de sortie                                 |
| `--persistence <p>`, `--no-persistence`                | où enregistrer                                     |
| `--memory`, `--no-memory`                              | utiliser ou ignorer la mémoire                     |
| `--dotenv <fichier>`                                   | fichier de variables (défaut : `.env` s'il existe) |
| `-q, --quiet`                                          | seulement le résumé                                |
| `-h, --help`, `-v, --version`                          | aide, version                                      |

Options propres au Dry Run : [section 6](#6-vérifier-un-scénario-contre-lapplication-dry-run), ou `npm run qa -- dry-run --help`.

---

## 17. Dépannage

| Symptôme                                                    | Solution                                                                       |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `target: Required` / « No target application »              | donne `-c <mission.yaml>`, `--base-url`, ou `QA_BASE_URL` dans `.env`          |
| `Unrecognised Gherkin sentence`                             | écris la phrase dans `gherkin.steps`, ou active `gherkin.auto: true`           |
| Une étape « Nouveau… », « Enregistrer » est BLOQUÉE         | ajoute `allow: MUTATION` (YAML) ou `@mutation` (Gherkin)                       |
| Élément introuvable                                         | copie l'étape suggérée par le rapport ; essaie `text:` ou `css:`               |
| Il clique trop tôt, l'écran n'est pas chargé                | augmente `exploration.readyTimeoutMs`                                          |
| Le même lien sur chaque ligne (`Traiter…`) n'est pas cliqué | `je clique sur "Traiter …"` (première ligne), ou `nth:` pour une autre ligne   |
| Tout le Dry Run est `NOT_VERIFIED` après le « Étant donné » | traduis la précondition dans `gherkin.steps` (`run: <flow réutilisable>`)      |
| La fenêtre grise « Connexion » du navigateur apparaît       | `auth.type: http`                                                              |
| `Environment: …` n'apparaît pas                             | lance la commande depuis le dossier qui contient `.env`, ou utilise `--dotenv` |
| `expect` échoue alors que le texte est visible              | le texte doit être exact (accents, tirets) : essaie une partie plus courte     |

Pour aller plus loin : le [README](../README.md) détaille chaque clé de mission, les oracles, le moteur de décision, la persistance et l'architecture.
