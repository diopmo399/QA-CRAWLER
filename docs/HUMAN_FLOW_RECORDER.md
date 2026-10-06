# Human Flow Recorder (Record & Learn)

`qa-crawler record` ouvre Chromium sur l'application. Un humain s'en sert normalement ;
QA-CRAWLER observe, puis écrit **un** flow imposé propre, en `flow.yaml` **et** en
`.feature`, tirés de la **même** représentation (ils disent la même chose). Le flow est
directement utilisable par `qa-crawler run` (flows imposés) et par `qa-crawler dry-run`.

Ce n'est pas un enregistreur de macros : pas de `#mat-input-23`, pas de `nth-child`, pas
une étape par touche. Ce qui est enregistré, c'est l'**intention** : « remplir l'e-mail »,
« choisir Business », « enregistrer », et ce que l'application a fait en retour.

```bash
npm run qa -- record --url https://qa.example.com/users --name "Create business user"
npm run qa -- record -c mission.yaml --name "Create user" --url /users --output-format both
npm run qa -- record -c mission.yaml --name "Create user" --validate
npm run qa -- record --help
```

## Pendant l'enregistrement

Un bandeau **● RECORDING** s'affiche en bas à droite de la page (Checkpoint, Pause, Stop).
Il vit dans un shadow root fermé, sous un hôte marqué `data-qa-crawler-overlay` : il n'est
ni enregistré, ni vu par l'observation de l'écran, ni dans les captures.

| Geste                                | Bandeau                             | Terminal                                |
| ------------------------------------ | ----------------------------------- | --------------------------------------- |
| Arrêter                              | **Stop**                            | Entrée, Ctrl+C, ou fermer le navigateur |
| Point de contrôle (« vérifier ici ») | **Checkpoint** (libellé facultatif) | `c <libellé>` + Entrée                  |
| Pause / reprise                      | **Pause** / **Resume**              | `p` + Entrée                            |

Avec une mission qui se connecte (`auth`), la connexion est faite **avant** l'enregistrement
(`recording.recordAfterAuthentication: true`, par défaut) : elle n'est pas dans le flow, le
rejeu se connecte avec la mission (identifiants lus dans l'environnement).

## Ce qui est capturé, et ce qui ne l'est jamais

Capture **passive** : écouteurs en phase de capture, `passive`, jamais de `preventDefault`,
aucune requête interceptée. Clics, saisies, changements, choix, cases, envois de formulaire,
navigations, dialogues du navigateur, nouvelles fenêtres, téléchargements, choix de fichier.
Ni mouvements de souris, ni défilement. Un clic fait par un script (`isTrusted=false`) n'est
pas un geste humain. Les saisies ne partent jamais touche par touche : la dernière valeur
après une pause (`recording.inputDebounceMs`).

**Aucun secret ne quitte la page.** D'une valeur tapée, le navigateur envoie sa forme (vide,
longueur, e-mail / nombre / date / téléphone…) et une empreinte salée (le sel de la session
n'est jamais écrit) ; pour un champ **non sensible**, aussi son texte, qui devient une donnée
de test (voir [Données de test enregistrées](#données-de-test-enregistrées)) — gardé en
mémoire, hors de la trace brute, et écrit seulement dans `test-data.yaml` quand la politique
le garde (`recording.testData.extractRecordedValues: false` : seulement la forme, comme avant).
Un champ sensible n'envoie ni texte ni empreinte. Mots de passe, jetons, codes à usage
unique, PIN, CVV, clés d'API, cookies : jamais stockés ; une valeur qui ressemble à un jeton
(JWT, clé, longue suite hexadécimale), même tapée dans un champ ordinaire, n'est jamais
gardée. Un choix de l'interface (option d'une liste, radio) est gardé : c'est un texte de l'écran.

Le tampon est borné (`recording.maxRawEvents`) : au-delà, des clics et des saisies sont
écartés (signalé), jamais un envoi, une navigation, un changement ou un point de contrôle.

## RAW → SEMANTIC → FINAL

Trois représentations séparées, jamais réécrites :

1. **RAW** (`raw-recording.json`) : les événements tels quels (avec l'écran observé après
   chacun, et les requêtes qu'il a déclenchées : méthode, chemin, statut, forme du corps).
2. **SEMANTIC** (`semantic-recording.json`) : des actions `NAVIGATE`, `CLICK`, `FILL`,
   `SELECT`, `CHECK`, `UNCHECK`, `SUBMIT`, `CONFIRM`, `CANCEL`, `UPLOAD`… avec une cible
   stable, un classement de la SafetyPolicy, des preuves et une confiance.
3. **FINAL** (`recorded-flow.json`) : le flow nettoyé, avec ses vérifications. C'est lui qui
   devient `generated.flow.yaml` et `generated.feature` (par les générateurs du Dry Run).

### Cible stable (locator)

Du plus stable au plus fragile : **SEMANTIC** (libellé du champ, rôle + nom d'un bouton ou
d'un lien) › **ACCESSIBLE** (rôle + nom, texte visible) › **STABLE_ATTRIBUTE** (`data-testid`,
attribut `name`) › **FRAMEWORK_BINDING** (`formControlName`) › **CSS_STABLE** (id non généré)
› **FRAGILE** (position dans la page, en dernier recours, signalée). Un id généré
(`mat-input-23`, `:r1:`, `cdk-…`) n'est jamais utilisé. Un nom qui désigne plusieurs
éléments (Playwright sans `exact`) laisse la place à un attribut stable ; sinon la cible est
**AMBIGUOUS_RECORDED_TARGET**. Une cible qu'aucune phrase Gherkin ne sait dire devient une
**intention** (le SemanticResolver la retrouve au rejeu) dans les deux fichiers.

### Normalisation

- **Bruit** : clics de focus dans un champ, touches, clics sur un libellé : fusionnés dans
  la saisie ou le choix qu'ils précèdent (statut `MERGED` et sa règle dans le manifeste).
- **Saisies** : plusieurs saisies d'un même champ → une étape, la valeur finale.
- **Corrections** : un champ ressaisi, une case cochée puis décochée → la valeur finale (ou
  rien). Jusqu'au prochain envoi seulement, et jamais si une action a dépendu de la valeur
  intermédiaire (une case qui a révélé des champs, utilisés ensuite). En `EXACT`, aucune.
- **Navigations** : celles qu'une action a causées (redirection, route d'une SPA) ne sont pas
  des étapes. Un point de contrôle posé après une redirection appartient à l'action qui l'a
  causée.
- **Détours** : ne sont plus retirés. Un onglet ouvert par l'humain reste une étape ; seul
  l'optimiseur séparé (`recording.optimization`, `optimized.flow.yaml`) propose de les retirer.
- **Invalide puis valide** : un envoi refusé, corrigé, puis renvoyé. Avec un point de
  contrôle sur l'erreur, c'est voulu : le flow garde les deux envois et vérifie le refus
  (**NEGATIVE_VALIDATION_FLOW**). Sans point de contrôle, la tentative refusée est écartée
  et signalée (**AMBIGUOUS_RECORDING_INTENT**).
- **Jamais retirée** : une action qui a écrit (requête acceptée), changé un état métier,
  porte un point de contrôle, a changé l'écran (section ouverte, champ révélé, fenêtre), ou
  dont une action suivante dépend ; un bouton, un onglet, un menu, une case, un choix, un
  envoi ; un contrôle dont l'intention n'est pas comprise (`UNRESOLVED_BUT_PRESERVED`).

Une action écartée garde sa raison dans la trace : rien n'est supprimé.

### Valeurs

| Classe                   | Exemple                           | Dans le flow                                                                                                                                                                 |
| ------------------------ | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GENERATED_TEST_DATA`    | prénom, e-mail tapés              | `value: { testData: firstName }` / `"<testData:firstName>"` : une valeur **valide** choisie au rejeu par le TestDataProvider (`testData.fields[clé]` si la mission la donne) |
| `LITERAL_BUSINESS_VALUE` | option « Business », radio        | la valeur telle quelle                                                                                                                                                       |
| `SENSITIVE_REFERENCE`    | mot de passe, identifiant, secret | `value: { env: QA_PASSWORD }` (`recording.credentials`)                                                                                                                      |
| `PREEXISTING_VALUE`      | champ pré-rempli non modifié      | aucune étape                                                                                                                                                                 |

Un fichier choisi : son extension seulement (jamais le chemin) ; un téléchargement est un
résultat, pas une étape.

## Parcours humain (Human journey)

**PRESERVE FIRST, UNDERSTAND SECOND, OPTIMIZE LAST.** L'enregistreur ne cherche pas le chemin
le plus court vers l'écran final : `generated.flow.yaml` est le parcours **enseigné** par
l'humain. Ne pas comprendre une action n'est jamais une raison de la retirer.

**Chronologie.** Chaque interaction humaine reçoit un id (`h001`, `h002`…) et un numéro
d'ordre dès la trace brute (les frappes d'un même champ sont une interaction). Ces ids
suivent l'action jusqu'à l'étape du flow (`# HUMAN_RECORDED · SEMANTIC · h005 · raw r20`).

**Comptage.** Chaque interaction termine dans exactement un statut :

| Statut                     | Sens                                                                     |
| -------------------------- | ------------------------------------------------------------------------ |
| `PRESERVED`                | une étape du flow                                                        |
| `UNRESOLVED_BUT_PRESERVED` | une étape du flow, intention pas (encore) comprise                       |
| `MERGED`                   | représentée par une autre (focus → saisie, frappes, clic + envoi)        |
| `COLLAPSED_CORRECTION`     | une valeur corrigée ensuite (rien n'en dépendait)                        |
| `SUPERSEDED`               | un envoi refusé, corrigé puis renvoyé                                    |
| `EXCLUDED_WITH_REASON`     | valeur déjà là, valeur calculée, dialogue du navigateur…                 |
| `HUMAN_NOISE`              | bruit confirmé (clic sur du texte sans effet, rien n'en dépend)          |
| `UNACCOUNTED`              | **interdit** : perdue sans raison → `FLOW_GENERATION_LOST_HUMAN_ACTIONS` |

`meaningful = preserved + merged + excluded + noise`, et « Lost without explanation » vaut 0.
Le HumanJourneyValidator vérifie aussi que les étapes gardent l'ordre humain.

**Effets et dépendances.** Un clic peut être fonctionnel sans changer d'adresse ni appeler le
serveur : l'écran observé avant et après dit ce qu'il a changé (`FIELD_ADDED`,
`HIDDEN_TO_VISIBLE`, `MODAL_OPENED`, `ROUTE_CHANGED`…), même quand l'empreinte de l'écran est
la même (les contrôles visibles comptent). Une action dont la cible n'était pas accessible
avant un clic dépend de ce clic (`FORWARD` : vue juste après ; `BACKWARD` : absente avant,
utilisée ensuite) : ce clic ne peut pas être retiré.

**Contrôles maison.** Un clic sur un élément que la capture ne reconnaît pas (une carte, un
en-tête de composant) est observé : s'il change l'écran ou si l'action suivante en dépend,
c'est une action `UNRESOLVED_BUT_PRESERVED`, avec un localisateur stable. Les attributs
`aria-expanded`, `aria-controls`, `aria-pressed`, `aria-selected`, `aria-haspopup`,
`data-toggle`, `jsaction`, et les classes `btn`, `button`, `accordion`, `panel-header`,
`step-header`, `toggle` désignent un contrôle. Un vrai bouton cliqué sans aucun effet observé
reste une étape, `UNRESOLVED`.

**Phases.** Le parcours est lu par phases (une phase commence à une action qui ouvre quelque
chose, ou après un envoi) : dans le rapport et `human-journey.json`, sans rien retirer.

**Fidélité** (`recording.fidelity`) : `EXACT` (chaque valeur saisie reste une étape),
`SEMANTIC` (défaut : frappe et corrections fusionnées, jamais un contrôle), `OPTIMIZED`
(SEMANTIC, plus `optimized.flow.yaml` raccourci par le FlowOptimizer : jamais à la place).

**Fichiers.** `human-journey.json` (interactions, dépendances, phases, résumé) et
`action-preservation.json` (une ligne par interaction : statut, étape, règle, fusionnée dans,
raison). Le rapport montre la chronologie, les dépendances, les phases et les actions
fusionnées ou écartées avec leur règle.

## Rejeu vérifié : effet des actions

**CLICKED ≠ SUCCEEDED.** Un clic que Playwright réussit prouve seulement que le clic a eu lieu.
Au rejeu, chaque clic, case ou choix suit : RESOLVE → VERIFY TARGET → EXECUTE → OBSERVE →
VERIFY EFFECT → CONFIRM. L'étape n'est réussie que si son effet est observé.

**Effets appris à l'enregistrement** (`effects` dans `generated.flow.yaml`) : les contrôles
nommés apparus ou disparus (jamais un horodatage, un compteur ou un indicateur de chargement),
la route atteinte, la requête envoyée. Et, sans rien apprendre, la **cible de l'étape
suivante** : absente avant l'action, elle doit être là après (NEXT_ACTION_TARGET_AVAILABLE).

```yaml
- click: { role: button, name: Tasks }
  effects:
    appears: ['button:Company interview']
    request: GET /api/tasks
```

| Effet          | Sens                                                                              |
| -------------- | --------------------------------------------------------------------------------- |
| `CONFIRMED`    | un effet attendu est observé (même écran pour le StateDetector : onglet, section) |
| `NO_EFFECT`    | clic exécuté, rien de changé → `ACTION_NOT_CONFIRMED`                             |
| `WRONG_EFFECT` | l'écran a changé, mais pas comme à l'enregistrement (mauvaise cible ?)            |
| `AMBIGUOUS`    | une écriture sans réponse claire : `MUTATION_EFFECT_AMBIGUOUS`, jamais renvoyée   |
| `NOT_REQUIRED` | rien à exiger (rien appris, cible suivante déjà là, `effects.required: false`)    |

L'attente d'un effet est **sur condition** et bornée (`replay.effectTimeoutMs`) : le contrôle
attendu, la route, la cible suivante — jamais un sommeil fixe.

**Première divergence.** Le rejeu s'arrête à l'action dont l'effet manque, pas dix étapes plus
loin sur « element not found » : le rapport et le terminal donnent `Root divergence: step N`
et le dernier point de reprise confirmé.

**Empreinte de la cible** (`fingerprint`, pour un CSS de position ou une cible ambiguë) : rôle,
nom, texte, test id, balise, section. Avant de cliquer, l'élément trouvé est comparé
(EXACT / STRONG / WEAK / MISMATCH) : une cible qui n'est pas la bonne n'est **jamais cliquée**
(`TARGET_FINGERPRINT_MISMATCH`). Le **même** élément est alors cherché par son empreinte
(rôle + nom, test id, texte ; un CSS de position est essayé en dernier) : localisateur guéri,
signalé dans le rapport, jamais réécrit dans le flow.

**Récupération.** Une action sûre (onglet, section, menu) sans effet est retentée une fois
(cible re-résolue, puis les autres localisateurs de son empreinte). Une action qui écrit
(envoi, création) n'est **jamais** retentée automatiquement. Un voile qui couvre la cible est
attendu par Playwright (jamais de `force: true`).

**Web components.** Vu du document, un clic dans un shadow DOM est « retargeté » sur l'hôte
(sans texte, souvent un conteneur : `click "element"`, `css=main > div:nth-of-type(…)`).
L'enregistreur lit le chemin composé du clic : la cible est le vrai bouton interne (rôle +
nom), le CSS traverse l'hôte, les saisies dans un shadow DOM sont enregistrées.

```yaml
replay:
  verifyActionEffects: true # false : le comportement d'avant
  detectFirstDivergence: true
  verifyNextActionPrecondition: true
  targetFingerprintMatching: true
  locatorHealing: true
  effectTimeoutMs: 8000
  recovery: { enabled: true, retrySafeActions: true, retryMutations: false }
  locator: { preferSemantic: true, structuralCssFallback: true, rejectFingerprintMismatch: true }
```

## Données de test enregistrées

Le flow dit **quoi faire**, le jeu de données dit **avec quoi**. Les valeurs saisies pendant
l'enregistrement ne sont ni perdues, ni codées en dur dans le flow, ni remplacées par un
`testData: text` générique : elles deviennent un **TestDataSet** (`test-data.yaml`, à côté du
flow), cité par le flow **et** par le `.feature` — un seul jeu de données.

```yaml
# generated.flow.yaml
name: create request
startAt: /requests/new
testData: test-data.yaml
steps:
  - fill: { label: Title, value: { testData: request.title } }
  - fill: { label: Description, value: { testData: request.description } }
  - select: { label: Request type, option: Incident }
  - fill: { label: Contact e-mail, value: { testData: request.contactEmail } }
  - check: { label: Urgent }
  - click: { role: button, name: Submit }
    allow: MUTATION
```

```yaml
# test-data.yaml
name: create request-recorded-data
source: HUMAN_RECORDING
values:
  request:
    title: { strategy: recorded, value: Imprimante bureau }
    description: { strategy: recorded, value: "Impossible d'imprimer" }
    contactEmail: { strategy: generated, generator: email, semanticType: email }
```

Le `.feature` commence par `# testData: test-data.yaml` et dit
`Quand je remplis "Title" avec "<testData:request.title>"`.

**Le nom d'une donnée** (TestDataKeyResolver) est l'identité sémantique du champ, jamais son
localisateur (`mat-input-17`, `input3`, CSS, XPath) : la propriété du corps envoyé qui porte
exactement cette valeur (même empreinte : la propriété du DTO), puis le nom technique stable
(`formControlName`, `name`, test id), puis le sens reconnu (`email`, `firstName`…), puis le
libellé. **Espace de noms** : l'entité de l'écriture qui suit (`POST /api/requests` →
`request.title`) ; deux entités créées → `customer1.name`, `customer2.name`.

**La politique** (RecordedDataGeneralizationPolicy), dans cet ordre de priorité :
configuration explicite → sécurité → sens métier → inférence → type sémantique → repli.

| Donnée                                    | Classement            | Au rejeu                                     |
| ----------------------------------------- | --------------------- | -------------------------------------------- |
| texte libre, nombre, date (description…)  | `RECORDED_TEST_DATA`  | `recorded` : la valeur enregistrée           |
| e-mail, identifiant, référence (unicité)  | `GENERATED_TEST_DATA` | `generated` : une nouvelle valeur par run    |
| prénom, nom, téléphone, adresse, ville…   | `GENERATED_TEST_DATA` | `generated` (pas d'archive de données perso) |
| code métier tapé (`BUSINESS`, `INCIDENT`) | `BUSINESS_LITERAL`    | `literal` : la valeur exacte                 |
| option d'une liste, radio                 | `BUSINESS_LITERAL`    | gardée dans le flow (`select … option`)      |
| case cochée                               | `FLOW_BEHAVIOR`       | une étape `check`, pas une donnée            |
| mot de passe, PIN, jeton, identifiant     | `SENSITIVE_REFERENCE` | `{ env: QA_PASSWORD }`, jamais une valeur    |
| valeur déjà là, inchangée                 | `PREFILLED_VALUE`     | aucune étape (`PRESERVE_EXISTING`)           |
| champ calculé en lecture seule (total)    | `DERIVED_VALUE`       | jamais une entrée (`IGNORE_DERIVED`)         |

**Occurrences.** La même valeur saisie deux fois (même empreinte) est **une** donnée. Une
autre valeur pour le même champ n'écrase jamais la première : `request.description.initial`,
`request.description.updated` (avertissement `TEST_DATA_COLLISION`). La même valeur sous un
autre champ (recherche par l'e-mail créé, confirmation) devient une **référence** :
`search: { strategy: reference, reference: user.email }`.

**Au rejeu** (TestDataRunContext), chaque clé est résolue **une fois par run** : un e-mail
généré cité trois fois (créer, chercher, vérifier) est le même pendant le run, et nouveau au
run suivant ; deux clés générées ne reçoivent jamais la même valeur. `recorded` / `literal` :
la valeur ; `generated` : le TestDataProvider (`email`, `firstName`, `phone`, `text`,
`unique`…) ; `template` : `"QA ${runId}"` ; `reference` : la valeur de l'autre clé ;
`credential` : la variable d'environnement ; `preserve` : rien n'est saisi. Une clé absente du
jeu : la valeur du TestDataProvider, comme avant. `testData.fields` de la mission reste
prioritaire sur tout. Le jeu d'un flow (`testData:` du flow ou `# testData:` du `.feature`)
l'emporte sur celui de la mission (`testData.include: [chemin]`, `testData.values: {…}`).

**Apprentissage.** Une donnée `recorded` réutilisée telle quelle et une réponse `409` pendant
le flow : une suggestion `TEST_DATA_STRATEGY_CANDIDATE`
(`request.contactEmail: RECORDED_LITERAL → GENERATE_AT_REPLAY`) dans le rapport du flow —
jamais une modification silencieuse du flow ou du jeu.

**Sécurité.** Une valeur sensible n'est jamais lue, ni écrite dans `test-data.yaml` : un jeu
qui en contiendrait une en clair (`password: …`) est **refusé** au chargement. Le rapport
« Recorded test data » ne montre aucune valeur : clés, stratégies, raisons, et les compteurs
« Sensitive recorded values », « Converted to credential references »,
« Clear-text sensitive values persisted » (toujours 0, vérifié). Les valeurs ne sont que dans
`test-data.yaml` : ni dans `raw-recording.json`, ni dans le flow, ni dans le journal.

Reprendre un flow enregistré dans une mission : copier `test-data.yaml` avec lui (le chemin
`testData:` est relatif au fichier qui le cite), ou le citer par `testData.include`.

## Causalité des navigations (action → effet)

**L'action humaine est la cause ; la navigation est d'abord un effet.** Un clic sur
« Demandes » suivi d'un changement de route reste `click "Demandes"` ; la route `/demandes`
devient le résultat de ce clic (preuve runtime, provenance `RUNTIME_OBSERVED`), pas une
étape `goto`. Un envoi, une action qui modifie des données, n'est jamais remplacé par la page
qu'il produit.

L'ACTION CORRELATION ENGINE rattache chaque navigation observée (navigation complète, ou
route d'une application monopage par `history.pushState` : Angular Router, React Router…)
à l'action humaine récente qui l'a causée, dans une fenêtre bornée
(`recording.actionCorrelation.causalWindowMs`, 10 s par défaut : un bouton qui charge des
données puis appelle `router.navigate` 3 s plus tard reste ce bouton). Le temps n'est qu'un
signal ; les autres :

- la cible du clic pointe vers la destination (`href`, `routerLink`) ;
- c'est la dernière action humaine avant la navigation (avec une liste puis « Continuer »,
  c'est « Continuer ») ;
- le clic envoie un formulaire, une écriture est acceptée par le serveur (POST 201) avant la
  navigation ;
- un lien, un onglet, un menu.

Chaque rattachement a une confiance (`VERY_HIGH`, `HIGH`, `MEDIUM`) et ses raisons, dans le
rapport. Un clic suivi d'une redirection (garde de route, 302) garde toute la chaîne
(`/protected → /login`). Un élément sans rôle mais cliquable (une tuile `<div (click)>`, un
`<span>` dans une carte) est un vrai clic : son ancêtre au curseur « main » est la cible ; à
défaut, le clic est promu s'il a causé une navigation.

`goto` n'est plus qu'un repli, toujours avec sa raison :

| Raison                | Quand                                                   |
| --------------------- | ------------------------------------------------------- |
| `INITIAL_NAVIGATION`  | la première page : c'est `startAt`, jamais une étape    |
| `DIRECT_URL_ENTRY`    | l'adresse a été tapée ou collée dans la barre d'adresse |
| `BACK_FORWARD`        | bouton précédent / suivant du navigateur                |
| `EXTERNAL_NAVIGATION` | un autre site, sans action corrélée                     |
| `NO_CAUSAL_ACTION`    | aucune action humaine fiable dans la fenêtre            |

Avant la génération, un contrôle de préservation vérifie qu'aucune action qui modifie des
données n'a été perdue (`SEMANTIC_ACTION_LOST`) et signale un flow fait de goto alors que
l'humain a cliqué (`SUSPICIOUS_NAVIGATION_COLLAPSE`). La section « Navigation causality » du
rapport montre, pour chaque navigation, ce qui l'a causée ou pourquoi elle reste un goto.

`recording.actionCorrelation.enabled: false` rétablit l'ancien comportement. Limite : la
connaissance statique (le code qui appelle `router.navigate`) n'est pas encore utilisée
comme preuve par l'enregistreur ; seule l'exécution observée l'est.

## Identité sémantique des cibles (section, contexte)

Un champ n'est pas « un input » : c'est **Priorité dans Général**, **Rechercher dans Colonnes**.
À l'enregistrement, chaque élément reçoit son **chemin de sections** (du plus large au plus
proche, 3 au plus) : `aria-labelledby`, `aria-label` d'un conteneur, l'en-tête qui contrôle un
accordéon (`aria-controls`), ou le titre (`legend`, `h1`–`h6`, `mat-panel-title`…) posé avant
l'élément dans son conteneur. Le titre d'une section SŒUR ne nomme jamais l'élément qui la suit.
La même fonction (`src/recording/semantic-dom.ts`) calcule ce chemin à l'enregistrement et au
rejeu : une seule définition de l'identité.

- Deux champs de même libellé dans deux sections : la cible garde sa section
  (`fill: { label: Search, section: "Report settings > Columns", value: … }`).
- Un champ sans libellé relié, avec une section connue : le texte posé devant lui devient sa
  cible (`label` + `section`), plus jamais un CSS structurel (`main > div:nth-of-type(3)`).
- L'empreinte (`fingerprint`) s'enrichit : `label`, `section`, `component`, `formControl`,
  `placeholder`, `semanticId` (`general.priorite` : un nom stable, pas un localisateur).
- Gherkin : `Quand je saisis "x" dans "Search" dans la section "Columns"` (la section se dit en
  fin de phrase, pour toute phrase de clic, saisie, choix ou case).

**Au rejeu (ContextualTargetResolver)**, une cible qui a une section est cherchée par son
identité : libellé (associé, aria, placeholder, ou deviné), rôle, et section. Un candidat d'une
AUTRE section connue est exclu ; deux candidats aussi plausibles donnent `AMBIGUOUS_TARGET`
(jamais le premier du DOM au hasard) ; la cible absente de sa section donne
`element "…" not found in section "…"` — jamais le champ de même libellé d'une autre section.
Un localisateur structurel qui atteint un élément d'une autre section est rejeté par l'empreinte
(`TARGET_FINGERPRINT_MISMATCH … section "Filters" instead of "Columns"`), avant toute action.

## Auto-validation de la cible pendant l'enregistrement

RECORD → RESOLVE → VALIDATE → ENRICH → REVALIDATE → PERSIST. Un sélecteur généré ne suffit plus :
juste après chaque action humaine, QA-CRAWLER se demande « si je n'avais plus que la
représentation que je viens de construire, retrouverais-je EXACTEMENT l'élément utilisé ? ».

- **Élément original** : le script de capture garde une référence en mémoire à l'élément de
  chaque action (bornée, jamais sérialisée, jamais écrite dans le DOM).
- **Recherche à sec** (`RecordingTargetValidator`) : la cible est résolue comme au rejeu
  (`toLocator`, ou le ContextualTargetResolver pour une cible avec section) et comparée à
  l'élément original — même nœud, puis l'empreinte face à ce que le rejeu en lira (`readTarget` :
  rôle, balise, nom, test id, section). **Jamais** `click`, `fill`, `press`, `selectOption`, glisser,
  `submit` ni `dispatchEvent` : on valide l'identité de la cible, pas l'action.
- **Statuts** : `VALIDATED`, `VALIDATED_FRAGILE` (retrouvée seulement par position),
  `VALIDATED_AFTER_RERENDER` (nœud remplacé : comparaison par instantané sémantique),
  `VALIDATED_AFTER_AI_AUDIT`, `AMBIGUOUS` (plusieurs candidats : jamais le premier),
  `MISMATCH` (ex. `RECORDED_ROLE_INCORRECT`), `CONTEXT_MISMATCH` (autre section),
  `SEMANTIC_MISMATCH`, `NOT_FOUND`, `STALE_BEFORE_VALIDATION`, `NOT_VALIDATABLE` (l'écran a changé
  avant la validation, ou l'action elle-même a masqué ou renommé l'élément —
  `TARGET_HIDDEN_BY_ACTION`, `TARGET_CHANGED_BY_ACTION` : jamais une erreur de la cible, qui est
  gardée telle quelle et jamais « réparée » en sélecteur).
- **Réparation déterministe** (au plus `maxDeterministicRepairAttempts`), toujours **revalidée** :
  l'empreinte prend ce que le runtime montre de l'élément original (`role: combobox → textbox`),
  ou la cible est remplacée par une alternative sémantique (section de l'élément original d'abord ;
  jamais une position). Tracée : avant, réparation, après, preuve `runtime-original-target`.
- **Traits distinctifs** : l'élément original et chaque candidate sont décrits par ce qui les
  distingue (`formControlName`, `name`, `id` stable, `placeholder`, texte posé avant le champ,
  composant, fenêtre, visible, **focus**). Un attribut stable propre à l'original suffit à réparer
  sans conseiller (`input[formcontrolname="zip"]`) ; sinon le conseiller reçoit ces traits pour
  chaque candidate — jamais une valeur saisie ni le texte d'une ligne de tableau.
- **Contexte pré-action** : la capture (phase de capture, avant les gestionnaires de
  l'application) relève l'écran tel que l'humain le voyait : route, titre, fenêtre ouverte, titres,
  unicité de la cible (CSS, texte, rôle + nom, libellé), choix déjà faits (listes, cases — jamais
  une saisie libre), onglet actif, éléments du même genre, chargement en cours. Quand l'action fait
  disparaître sa cible (un bouton « Filter » qui ouvre une fenêtre et se masque), l'ordre est :
  résolution live → élément original → contexte pré-action. Une cible unique avant l'action est
  `VALIDATED_PRE_ACTION` ; avec un effet observé après (fenêtre apparue, route, titre),
  `VALIDATED_WITH_EFFECT` (`semanticallyConfirmed`). L'effet ne remplace jamais l'identité : il
  s'y ajoute. Une cible disparue et ambiguë avant l'action reste ambiguë (jamais « prouvée »).
- **Contexte du conseiller (CONTEXT BEFORE DECISION)** : `RecordingIntelligenceContextBuilder`
  joint à la requête un `recordingContext` structuré — mission `RECORDING_TARGET_AUDIT`, parcours,
  écran (fenêtre, section, composant, onglet, titres), action (type, intention en hypothèse, type de
  valeur — jamais la valeur), cible réelle et ses attributs stables, 3 à 5 actions précédentes de la
  même zone, actions SUIVANTES déjà reçues (une preuve, pas une vérité), configuration en cours
  (« Field = …, Operator = … »), état du formulaire, dépendances observées, effets, preuves runtime,
  candidats décrits par leur identité fonctionnelle et leur similarité avec l'original,
  contradictions (C1…), scores (des indices), indices statiques (`SUPPORTING_EVIDENCE`) et
  historiques (`EXPERIENCE`). Le `ContextRelevanceSelector` borne la fenêtre ; tout passe par
  l'`IntelligenceContextSanitizer`. Le prompt système précise l'autorité des preuves (runtime d'abord).
  La proposition peut ajouter `semanticTarget` et `contradictionsResolved` : un `semanticId` n'est
  repris qu'après confirmation runtime, un rôle qui contredit le runtime est ignoré. Résumé assaini
  de chaque contexte envoyé : `ai-context-summary.json` ; journal `[AI_CONTEXT_BUILT]`,
  `[AI_CONTEXT_SANITIZED]`, `[AI_TARGET_AUDIT_REQUESTED]`, `[AI_TARGET_PROPOSAL]`.
- **Audit par le conseiller** (même `IntelligenceGateway`, déclencheurs de
  `recording.intelligenceAudit`) seulement si le déterministe ne suffit pas : il choisit une
  candidate fournie (T…), QA-CRAWLER la **résout** et la compare à l'original. Une proposition qui ne
  retrouve pas la cible est `AI_PROPOSAL_RUNTIME_REJECTED` : l'action humaine reste telle quelle.
  `ai.mode: OFF` → zéro appel ; fournisseur indisponible → le résultat déterministe est gardé.
- **Glisser-déposer** : jamais un second glisser ; l'élément (dans sa zone d'arrivée) et la zone
  de dépôt sont retrouvés par leur identité, le déplacement observé sert de preuve.
- **Groupe sémantique** : « champ », « opérateur » puis « valeur » dans la même section forment une
  `FILTER_CONFIGURATION` ; les actions restent séparées, la valeur reçoit `semanticId: filter.value`.
- **Génération** : la représentation réparée va dans le flow (avec son empreinte) ; une cible non
  prouvée est **gardée**, commentée `REQUIRES_REPLAY_VALIDATION`. Le commentaire de chaque étape
  dit `target VALIDATED (repaired)`, `target AMBIGUOUS`…
- **Audit final** : « le parcours est-il cohérent et rejouable ? », à partir des validations
  immédiates (un écran passé n'est jamais « NOT_FOUND ») ; confiance de rejeu HIGH / MEDIUM / LOW,
  jamais à la place du détail.
- **Connaissance** : une réparation prouve « cette représentation retrouvait la cible dans CE
  runtime » (`recordingValidated: true`) ; `replayValidated` attend un rejeu réussi. Rien n'est
  promu automatiquement.

Fichiers : `target-validation.json` (par action : original, empreinte et validation avant,
réparation, empreinte et validation après, audit, cible finale) ; section **Target validation** du
rapport (badges VALIDATED, REPAIRED, FRAGILE, AMBIGUOUS, UNRESOLVED, AI_AUDITED) ; dans le
terminal, une ligne par étape (`[TARGET_MISMATCH] … role recorded=combobox runtime=textbox`,
`[TARGET_REPAIRED]`, `[TARGET_REVALIDATED]`) et le bilan **RECORDING VALIDATION**.

### Capture pré-action des candidats (CAPTURE FIRST, VALIDATE LATER)

**Le défaut corrigé.** Une saisie n'était envoyée par la page qu'après la pause de frappe (ou au
`change`). Le contexte « pré-action » (combien d'éléments le CSS trouvait, les pairs) et la
description de la cible étaient donc lus **après** le re-rendu de l'application. Un champ remplacé
dès la première frappe donnait `#valueInput matched 0 elements before the action`. Les pairs
excluaient en plus la cible elle-même : `candidates=0`, et le conseiller ne pouvait rien choisir.

**Désormais, la page fige la preuve au PREMIER événement du geste**, en phase de capture, avant
tout gestionnaire de l'application :

| Geste                      | Événement de capture                                   |
| -------------------------- | ------------------------------------------------------ |
| clic, liste, case, glisser | `pointerdown` (sinon `dragstart`)                      |
| saisie                     | `focusin`, puis `beforeinput` si la preuve manque      |
| clavier                    | `keydown`                                              |
| repli                      | l'événement lui-même (`AT_EVENT`, en phase de capture) |

**Ce qui est figé ensemble** :

- la description de la cible ;
- le contexte d'écran ;
- la **génération du DOM**, un compteur léger des re-rendus ;
- un **ensemble borné de candidats** (`recording.preActionCapture.maxCandidates`, 12 par défaut).

Les candidats sont pris dans cet ordre :

1. la cible originale **T1** (`ORIGINAL_HUMAN_TARGET`), jamais retirée par le budget ;
2. les éléments du même formulaire, de la même fenêtre, de la même section ;
3. un rôle compatible ailleurs à l'écran.

Un candidat est une **description**, pas un localisateur. Il porte :

- son rôle, son nom et son libellé ;
- ses attributs stables ;
- sa section et sa fenêtre ;
- son voisinage ;
- l'hôte du composant et le conteneur sémantique (`mat-form-field` + `mat-label`) ;
- `cssHint`, qui n'est qu'un indice.

Jamais une valeur saisie. La référence au nœud reste dans la page. `captureId`
(originalTargetRuntimeId) relie l'événement brut, la preuve et la validation.

**Validation.** Deux univers distincts :

- le runtime **actuel** (ce qui existe maintenant) ;
- l'instantané **pré-action** (ce qui existait quand l'humain a agi).

Ordre de décision :

1. le nœud original encore présent ;
2. le runtime actuel ;
3. le candidat original pré-action ;
4. la reconstruction depuis les candidats (`PRE_ACTION_CANDIDATE_RECONSTRUCTION` : l'identité de
   T1 était la seule parmi eux) ;
5. le conseiller.

Un `#valueInput` qui désigne maintenant un autre nœud ne crée plus de faux `MISMATCH`.

**Glisser-déposer.** Au départ du glisser (`pointerdown` / `dragstart`), la page fige :

- l'élément (T1) et ses candidats ;
- les **zones de dépôt candidates** (D1 = la zone d'origine, puis les autres zones visibles, bornées) ;
- la liste de chaque zone **avant** le dépôt.

Après le dépôt, la zone d'arrivée est reliée à sa candidate (`destinationCandidateId`) et à sa liste
d'avant (`lists.destinationBefore`). L'élément absent de cette zone avant, présent après, prouve le
déplacement, même si l'application recrée les nœuds. Les nœuds recréés introuvables sont
alors validés par la capture pré-action (`VALIDATED_PRE_ACTION`), jamais par un second glisser.

**Invariant.** Une action sur un élément capturée a au moins un candidat, et T1 en fait partie.
Sinon `PRE_ACTION_CAPTURE_INCOMPLETE`, diagnostiqué. Sans candidat, le conseiller n'est **jamais**
consulté : il ne peut pas inventer la cible.

**Conseiller.** Il reçoit les candidats pré-action (provenance, voisinage, conteneur) et les actions
précédentes et suivantes. Il choisit un identifiant. Choisir T1 → `AI_PRE_ACTION_PROPOSAL_CONFIRMED` ;
un autre → `AI_PRE_ACTION_PROPOSAL_REJECTED`, l'action humaine est gardée.

Statuts publiés (`validation.status` dans `target-validation.json`) :

- `VALIDATED_LIVE` ;
- `VALIDATED_PRE_ACTION` ;
- `VALIDATED_PRE_ACTION_WITH_EFFECT` ;
- `VALIDATED_AFTER_RERENDER` ;
- `AMBIGUOUS_PRE_ACTION` ;
- `MISMATCH`, `CONTEXT_MISMATCH` ;
- `NOT_CAPTURED`, `NOT_VALIDATABLE`.

Le fichier contient aussi `preActionCapture` (`phase`, `domGeneration`, `postGeneration`,
`candidateCount`, `originalCandidateId`, `diagnostic`) et `currentRuntime.originalStillPresent`.

Journal :

- `[PRE_ACTION_CAPTURE] action=… type=… target=input#valueInput phase=FOCUSIN generation=… candidates=… originalCandidate=T1` ;
- `[PRE_ACTION_CAPTURE_INCOMPLETE]`, `[DOM_GENERATION_CHANGED] a → b` ;
- `[TARGET_VALIDATED_LIVE]`, `[TARGET_VALIDATED_PRE_ACTION(_WITH_EFFECT)] … candidate=T1` ;
- `[AI_PRE_ACTION_AUDIT_REQUESTED]`, `[AI_PRE_ACTION_PROPOSAL(_CONFIRMED|_REJECTED)]`.

Le rapport HTML affiche :

```text
Pre-action captured ✓ · candidates · original candidate · DOM a → b · statut · IA
```

La capture est locale, synchrone et bornée : elle ne sérialise jamais tout le DOM, n'attend pas le
réseau et n'appelle jamais le conseiller. Les preuves restent celles de l'enregistrement en cours ;
la connaissance générale attend le rejeu réussi.

```yaml
recording:
  preActionCapture:
    enabled: true
    maxCandidates: 12 # la cible originale n'est jamais retirée
    includeSameForm: true
    includeSameDialog: true
    includeSameSection: true
```

### Validation d'enregistrement ≠ récupération de rejeu (`ValidationMode.RECORDING`)

Pendant l'enregistrement, l'action humaine est **déjà exécutée** : la valider, c'est prouver
qu'elle a été bien comprise, jamais la refaire ni la « réparer » comme un rejeu en échec. Le
validateur travaille en `ValidationMode.RECORDING` (`src/recording/validation-mode.ts`) : jamais
de clic, de saisie, de sélection ni de glisser, jamais le `RecoveryEngine`, jamais
`GOAL_ALREADY_REACHED` comme preuve d'identité.

Trois verdicts **séparés** par action (`target-validation.json` : `mode`, `target`, `effect`,
`goal` ; journal `[RECORDING_VERDICT] … target=… effect=… goal=…`) :

| Verdict  | Question                               | Preuves                                                                           |
| -------- | -------------------------------------- | --------------------------------------------------------------------------------- |
| `target` | quel élément l'humain a-t-il utilisé ? | identité seulement, par priorité (ci-dessous) ; `source` dit laquelle a décidé    |
| `effect` | qu'a produit l'action ?                | l'écran d'après : `CONFIRMED` / `NOT_OBSERVED` / `NOT_VERIFIABLE`                 |
| `goal`   | le but fonctionnel est-il atteint ?    | suit l'effet (`REACHED`), nommé par le groupe sémantique (`filter.value applied`) |

Un effet confirmé ou un objectif atteint ne valide **jamais** une cible.

Priorité des preuves d'identité : 1. la cible originale au moment exact de l'action
(`ORIGINAL_HUMAN_TARGET`) ; 2. son instantané pré-action (`PRE_ACTION_TARGET_SNAPSHOT`) ; 3. le
contexte pré-action (`PRE_ACTION_CONTEXT`) ; 4. l'empreinte capturée avant toute mutation
(`TARGET_FINGERPRINT`) ; 5. l'effet observé (complément seulement) ; 6. la reconstruction
déterministe (`DETERMINISTIC_RECONSTRUCTION`) ; 7. le conseiller, revalidé
(`ADVISOR_REVALIDATED`).

**Le nœud original a disparu** (re-rendu après la saisie, le sélecteur désigne maintenant un
nœud B) : ce que le localisateur trouve **après** n'est qu'une preuve complémentaire
(`validationBefore.postState`), jamais un écart d'identité. Si la cible était unique juste avant
l'action, elle est `VALIDATED_PRE_ACTION` ; si le nœud B (même identité) serait lu autrement au
rejeu, seule la **représentation** est alignée (`REPRESENTATION_ALIGNED_POST_STATE`) et
revalidée — l'identité reste pré-action. Exemple (saisie dans le champ valeur d'un filtre) :

```yaml
target: { status: VALIDATED_PRE_ACTION, source: PRE_ACTION_CONTEXT }
effect: { status: CONFIRMED, evidence: ['"…" holds the typed value (post-state: the re-rendered field)'] }
goal: { status: REACHED, evidence: ['filter.value applied', …] }
```

L'effet d'une saisie se compare par **empreinte salée** (le sel de la session) : la valeur n'est
jamais relue en clair ni écrite, et un champ sensible reste `NOT_VERIFIABLE`.

Si l'identité pré-action reste **ambiguë** (`PRE_ACTION_AMBIGUOUS`), même quand le localisateur
trouve un seul élément après l'action, le conseiller est consulté avec le contexte d'enregistrement
(mode `RECORDING` dans sa mission) ; ses candidates sont les éléments visibles **avant** l'action.
Sa proposition est **revalidée contre les preuves pré-action** : même rôle, même libellé, même
section que l'instantané, et seule ainsi avant l'action → `VALIDATED_AFTER_AI_AUDIT`
(`ADVISOR_REVALIDATED`) ; identité contredite → `AI_PROPOSAL_RUNTIME_REJECTED` (l'action humaine
est gardée) ; plusieurs éléments identiques → `INCONCLUSIVE`.

Au **rejeu**, la récupération par objectif garde sa place, mais pour une saisie ou une sélection
`GOAL_ALREADY_REACHED` n'est que la **précondition** de l'étape : si le champ reste introuvable,
l'étape est en échec et la récupération est `NO_SAFE_RECOVERY` (jamais `RECOVERED`).

### Arrêt (« Stop ») : ce qui reste à faire, et combien de temps

**Avant.** Au « Stop », le recorder attendait toutes les validations de cible encore en file : elles
sont sérialisées, et chacune pouvait consulter le conseiller (plusieurs secondes par appel). Venaient
ensuite l'enrichissement et l'audit sémantique, avec leurs propres appels IA, faits les uns après les
autres. Un audit sémantique pouvait aussi redemander à l'IA l'identité d'une cible déjà prouvée
pendant l'enregistrement.

**Désormais :**

- **Validations en file** : dès le Stop, elles restent faites (déterministes, en lecture seule), mais
  le conseiller n'est plus consulté. L'audit non fait est noté `NOT_CALLED: recording stopped`.
- **Progression** : `RECORDING_STOPPING` dit ce qu'il reste à finir.
- **Audit sémantique** : pour une cible déjà validée ou auditée pendant l'enregistrement, les doutes
  d'identité (`AMBIGUOUS_TARGET`, `FRAGILE_LOCATOR`, `CONTEXT_MISMATCH`) sont réglés. Il n'y a plus
  d'appel IA pour eux ; les autres doutes restent audités. Le mode `FULL` audite toujours tout.
- **Bilan du temps** : `RECORDING_STOP_TIMING` donne le temps total après Stop et chaque phase, les
  plus longues d'abord :
  - saisie en attente, dernière observation, validations en file ;
  - fermeture du navigateur, traitement, écriture, connaissance ;
  - enrichissement IA, audit sémantique, rejeu `--validate`.

  Les audits IA sautés à cause de l'arrêt sont comptés. Exemple :
  `after Stop: 3.4 s — semantic audit 1.9 s · stop: pending validations and observations 0.8 s · …`.

## Glisser-déposer (DRAG_AND_DROP)

Un glisser-déposer est **une** action humaine de premier ordre, jamais un clic ni une perte.
La capture corrèle l'appui et le relâchement (pointeur : CDK, implémentations maison) ou
`dragstart` → `drop` (HTML5) : l'élément est décrit **au départ** (avant que l'application ne le
déplace), puis les éléments des deux zones sont relus après le dépôt — l'élément est-il dans la
destination et plus dans la source (`ITEM_MOVED`) ? Le clic qui suit un glisser est du bruit.

```yaml
- dragAndDrop:
    item: Status
    from: { section: Report settings > Columns > Available columns }
    to: { section: Report settings > Columns > Selected columns }
```

```gherkin
Quand je glisse "Status" de la section "Columns > Available columns" vers la section "Columns > Selected columns"
```

Au rejeu : la SafetyPolicy décide d'abord (le texte de l'élément est classé comme un clic ; une
écriture causée par le dépôt reste soumise au garde des écritures et à `allow`), l'élément et la
zone sont trouvés par leur identité (texte + section), puis le glisser est joué (`dragTo` pour un
élément `draggable`, une suite pointeur sinon). L'étape n'est réussie que si `ITEM_MOVED` est
observé ; un glisser exécuté sans déplacement est `ACTION_EFFECT_MISMATCH` (effet `NO_EFFECT`),
jamais un succès technique pris pour un succès fonctionnel. Une zone de dépôt non comprise à
l'enregistrement : l'action est gardée (UNRESOLVED, étape `manual`), jamais perdue.

## Audit sémantique par l'intelligence (Recording AI Audit)

PRESERVE FIRST, UNDERSTAND SECOND, OPTIMIZE LAST. La capture est **toujours** déterministe :
l'intelligence n'y participe jamais. Après la capture, le `RecordingSemanticAuditor` relit
l'interprétation déterministe de chaque action humaine, en passant par l'`IntelligenceGateway`
existant (contexte `RECORDING`, avis seulement : aucune exécution, aucun second client).

- **Déclencheurs** (déterministes) : cible ambiguë, localisateur fragile, confiance faible,
  interaction inconnue (UNRESOLVED), glisser sans déplacement observé, interaction humaine sans
  compte (perte de normalisation), même libellé ailleurs sans section, fusion d'éléments différents.
- **Modes** : `OFF`, `SUSPICIOUS_ONLY` (défaut : seules les actions qui déclenchent),
  `FULL` (toutes, bornées par `maxCalls`). `ai.mode: OFF` → zéro appel, quoi qu'il soit écrit.
- **Preuves** : des faits d'interface numérotés `E1`, `E2`… (libellé, section, liaison de
  formulaire, zones d'un glisser) ; jamais une valeur saisie, un mot de passe, un jeton, un cookie.
- **Arbitre** (`RecordingAuditArbiter`) : même cible → `CONFIRMED` ; une autre cible →
  `DISAGREEMENT` ; doutes exprimés → `SUSPICIOUS` ; rien de clair, réponse invalide ou fournisseur
  indisponible → `INCONCLUSIVE`. L'**interprétation finale reste la déterministe** : une autre
  lecture est une hypothèse (`origin: AI_PROPOSAL`, `runtimeConfirmed: false`), signalée pour
  revue, que seul le rejeu pourra confirmer. Rien n'est appris avant cette confirmation.

`semantic-audit.json` : pour chaque action, `humanActionId` (h001… : le même identifiant de la
trace brute au flow généré), `deterministicInterpretation`, `deterministicConfidence`,
`auditTrigger`, `aiDecisionId`, `aiAssessment`, `aiProposal`, `evidence`, `citedEvidence`,
`disagreement`, `finalInterpretation`, `decisionReason`, `runtimeConfirmation`. Le rapport
`index.html` montre la section **Recording AI Audit** : action humaine → déterministe → audit →
final → rejeu.

## Résultats et vérifications

Chaque action est corrélée au réseau (fenêtre par action), à l'écran observé après elle
(UIObserver → StateDetector) et à l'intention métier (verbe + entité de l'écriture, comme
l'apprentissage au runtime : `POST /api/users` après « Save » → `CREATE:USER`).

Vérifications candidates : `API_OUTCOME` (requête 2xx / 4xx), `ROUTE` (page atteinte, ou un
bouton que seule la nouvelle page montre quand l'URL ne discrimine pas : `/users/new` contient
`/users`), `MESSAGE`, `BUSINESS_STATE`, `ENTITY_EXISTS`, `FIELD_STATE`, `SIDE_EFFECT`. Chacune
a une stabilité (`STABLE`, `LIKELY_STABLE`, `FRAGILE`) et une confiance ; seules les stables
(et celles qu'un point de contrôle demande) entrent dans le flow. Un message qui contient une
donnée (nombre, adresse, texte long) est `FRAGILE` : gardé pour revue, jamais vérifié.

## Provenance

`HUMAN_RECORDED`, `NORMALIZED_FROM_HUMAN`, `INFERRED_OUTCOME`, `MANUAL_CHECKPOINT` (et
`STATIC_ENRICHED`, `RUNTIME_OBSERVED`). Chaque étape générée porte en commentaire sa
provenance, la qualité de sa cible, la classe de sa valeur et les événements bruts d'où elle
vient (`raw r5,r6`).

## Validation par le rejeu (`--validate`)

Le flow généré est rejoué par le **Dry Run** existant (même SafetyPolicy qu'un flow imposé) :
`REPLAY_CONFIRMED` si chaque étape est retrouvée et exécutée (`FULLY_MATCHED`), sinon
`REPLAY_FAILED` avec le rapport du Dry Run. Le flow généré n'est **jamais** modifié par la
validation. La SafetyPolicy reste absolue : une étape `allow: MUTATION` ne s'exécute que si la
mission permet les modifications.

## Connaissance

Avec `recording.knowledge: true` (défaut), le workflow montré (`CREATE:USER`, son API, le
libellé du bouton) rejoint la connaissance fonctionnelle de la mission
(`knowledge/functional/`, la même que les runs), provenance `HUMAN_RECORDED`, avec l'id de
la session, la version et l'environnement. Les runs suivants la reprennent comme historique
(jamais une preuve tant que le run ne l'a pas revue).

## Fichiers

`<reportsDir>/recordings/<nom>/` : `raw-recording.json`, `semantic-recording.json`,
`recorded-flow.json`, `generated.flow.yaml`, `generated.feature`, `test-data.yaml` (le jeu de
données du flow), `human-journey.json`, `action-preservation.json`, `semantic-audit.json`, `target-validation.json`, `ai-context-summary.json`, `optimized.flow.yaml`
(seulement avec l'optimiseur), `flow-graph.json` (la carte
des écrans et des actions), `recording-events.jsonl`, `index.html` (résumé en nombres — sans
note globale —, intention comprise, qualité des cibles et des valeurs, trace
RAW → SEMANTIC → FINAL avec le pourquoi de chaque étape, vérifications candidates).

Événements : `RECORDING_STARTED`, `RAW_EVENT_CAPTURED`, `SEMANTIC_ACTION_RESOLVED`,
`CHECKPOINT_ADDED`, `RECORDING_PAUSED`, `RECORDING_RESUMED`, `RECORDING_STOPPED`,
`RECORDING_NORMALIZED`, `OUTCOME_INFERRED`, `FLOW_GENERATED`, `REPLAY_VALIDATION_STARTED`,
`REPLAY_CONFIRMED`, `REPLAY_FAILED`, `RECORDING_COMPLETED`, `RECORDING_FAILED`, et pour la causalité : `ACTION_CORRELATION_STARTED`, `ACTION_EFFECT_CORRELATED`, `NAVIGATION_CORRELATED_TO_ACTION`, `NAVIGATION_UNCORRELATED`, `GOTO_FALLBACK_GENERATED`, `CAUSALITY_AMBIGUOUS`, `SUSPICIOUS_NAVIGATION_COLLAPSE`, `FLOW_SEMANTIC_PRESERVATION_CHECK`, et pour les données : `RECORDED_TEST_DATA_DISCOVERED`, `TEST_DATA_KEY_RESOLVED`, `TEST_DATA_CLASSIFIED`, `TEST_DATA_GENERALIZED`, `TEST_DATA_LITERAL_PRESERVED`, `TEST_DATA_REFERENCE_CREATED`, `SENSITIVE_RECORDED_VALUE_REDACTED`, `TEST_DATA_COLLISION_DETECTED` (enregistrement), `TEST_DATA_GENERATED_FOR_RUN`, `TEST_DATA_STRATEGY_CANDIDATE` (rejeu), et pour le parcours humain : `HUMAN_INTERACTION_CAPTURED`, `HUMAN_INTERACTION_PRESERVED`, `HUMAN_INTERACTION_MERGED`, `HUMAN_INTERACTION_EXCLUDED`, `HUMAN_INTERACTION_UNRESOLVED`, `HUMAN_ACTION_DEPENDENCY_DISCOVERED`, `HUMAN_JOURNEY_BUILT`, `HUMAN_JOURNEY_VALIDATION_STARTED`, `HUMAN_JOURNEY_VALIDATED`, `HUMAN_JOURNEY_VALIDATION_FAILED`, `HUMAN_ACTION_LOST`, `FLOW_OPTIMIZATION_STARTED`, `FLOW_OPTIMIZATION_COMPLETED`, et pour l'audit : `RECORDING_SEMANTIC_AUDITED`, `TARGET_VALIDATION`. Jamais une valeur dans un événement.

## Configuration

```yaml
recording:
  enabled: true # false : la commande record refuse de démarrer (sans effet sur run)
  outputFormat: both # yaml | gherkin | both
  language: fr # langue du .feature (défaut : report.language)
  overlay: true # le bandeau ● RECORDING
  recordAfterAuthentication: true
  maxRawEvents: 5000
  maxDurationMinutes: 60
  inputDebounceMs: 400 # une saisie est envoyée après cette pause
  settleMs: 600 # attente avant d'observer l'écran après une action
  dialogs: { confirm: accept } # confirm() pendant l'enregistrement : accept | dismiss
  credentials: { usernameEnv: QA_USERNAME, passwordEnv: QA_PASSWORD }
  knowledge: true
  validate: false
  actionCorrelation:
    enabled: true # false : l'ancien comportement
    causalWindowMs: 10000 # une action peut avoir causé une navigation jusqu'à 10 s après
    redirectWindowMs: 1500 # une navigation qui en suit une autre de si près : une redirection
    minScore: 0.5 # confiance minimale pour rattacher une navigation à une action
    promoteNoiseClicks: true # un clic « sans rôle » qui navigue est un vrai clic
    networkEvidence: true # une écriture acceptée avant la navigation est une preuve
  validation:
    detectSemanticActionLoss: true
    detectNavigationCollapse: true
    collapseMinGotos: 2
  fidelity: SEMANTIC # EXACT | SEMANTIC | OPTIMIZED
  preserveHumanJourney: true
  targetValidation: # auto-validation de la cible juste après chaque action (recherche à sec)
    enabled: true
    maxDeterministicRepairAttempts: 2
    aiAudit: true # le conseiller audite ce que le déterministe ne règle pas (ai.mode OFF → aucun appel)
  intelligenceAudit: # relecture par l'intelligence (ai.*) ; ai.mode OFF → aucun appel
    enabled: true
    mode: SUSPICIOUS_ONLY # OFF | SUSPICIOUS_ONLY | FULL
    maxCalls: 10
    triggers:
      ambiguousTarget: true
      fragileLocator: true
      lowSemanticConfidence: true
      unknownInteraction: true
      possibleDragAndDrop: true
      normalizationLoss: true
      contextMismatch: true
      suspiciousMerge: true
  preserveUnknownInteractiveActions: true # un composant maison qui a un effet : gardé, UNRESOLVED
  preserveDomChangingActions: true
  preserveDependencyActions: true
  normalization:
    mergeTyping: true
    collapseCorrections: true
    removeTechnicalNoise: true
    removeUnresolvedClicks: false
  optimization:
    enabled: false # true : optimized.flow.yaml en plus (generated.flow.yaml reste le parcours humain)
  testData:
    enabled: true # false : l'ancien comportement ({ testData: clé } choisi au rejeu, aucun fichier)
    extractRecordedValues: true # false : la saisie n'est jamais lue (seulement sa forme)
    replaceFlowLiterals: true # le flow cite le jeu au lieu des valeurs
    generalizeValues: true # noms, e-mails, téléphones, adresses : régénérés au rejeu
    generatePerRun: true
    preserveBusinessLiterals: true
    preserveExistingValues: true
    namespaceByEntity: true # POST /api/requests → request.title
    maxValueLength: 500 # au-delà : régénérée au rejeu
    sensitiveValues: { useCredentialReferences: true }
    strategies: { email: generated, description: recorded } # par sens ou par nom de champ
    overrides: # priorité absolue, sauf la sécurité
      description: { strategy: template, template: 'QA ${runId}' }
```

`qa-crawler run` ne lit pas cette section : désactiver l'enregistrement ne change rien aux runs.

## Limites

- Seule la page principale est enregistrée (pas les iframes).
- Un `confirm()` pendant l'enregistrement est accepté (`recording.dialogs.confirm`) ; au
  rejeu, la règle des dialogues de la mission s'applique (`browserInteractions.dialogs`).
  Un `prompt()` est refusé (sa réponse serait une saisie).
- Un envoi de fichier devient une intention `UPLOAD` sans fichier : à compléter.
- Un message affiché brièvement (toast) n'est proposé qu'en revue.
- Glisser-déposer : l'élément est identifié par son texte visible ; une requête envoyée au
  dépôt peut être rattachée à l'action précédente (le glisser est envoyé 300 ms après le dépôt,
  le temps de relire les zones). Un réordonnancement dans la même zone est gardé sans phrase
  dédiée de vérification de position.
- L'humain qui va très vite peut regrouper plusieurs actions dans une même observation de
  l'écran : l'ordre et les requêtes restent justes, l'écran intermédiaire peut manquer.

## Flow audit (`flow-audit.json`, `flow-audit.txt`)

Après l'enregistrement, le **flow généré est relu dans son ensemble** (`src/recording/flow-audit.ts`) —
l'audit sémantique, lui, juge chaque action isolément.

Règles déterministes (toujours, sans appel) :

| Règle                                 | Sévérité | Constat                                                                                         |
| ------------------------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `EFFECTLESS_CLICK_BEFORE_SAME_TARGET` | WARNING  | un clic sans effet suivi du même clic qui a l'effet (au rejeu, le premier peut déjà naviguer)   |
| `CONSECUTIVE_DUPLICATE_STEP`          | WARNING  | deux étapes consécutives identiques (même action, même cible, même ligne / section / fenêtre)   |
| `DOUBLE_MUTATION_RISK`                | ERROR    | deux étapes d'action consécutives envoient la même écriture (POST / PUT / PATCH / DELETE)       |
| `TRAILING_INPUT_NOT_SUBMITTED`        | WARNING  | le flow finit par des saisies jamais envoyées                                                   |
| `NO_FINAL_CHECK`                      | WARNING  | aucune vérification : un rejeu qui atteint la dernière étape passe même si le résultat est faux |
| `FRAGILE_TARGET` / `AMBIGUOUS_TARGET` | WARNING  | une cible par position, ou une cible ambiguë                                                    |
| `UNRESOLVED_STEP`                     | INFO     | une étape sans effet observé, que rien d'autre n'explique                                       |
| `TARGET_NOT_SEEN_ON_SCREEN`           | INFO     | la cible d'un clic n'était pas parmi les contrôles observés juste avant                         |

Avec `ai.mode` ≠ OFF (`recording.flowAudit.ai`, `maxCalls`, défaut 5), le conseiller (même passerelle,
contexte RECORDING, avis seulement) **confirme ou conteste** chaque constat (`AI_CONFIRMED`,
`AI_DISPUTED`, `AI_INCONCLUSIVE`), puis relit tout le flow et signale l'étape la plus douteuse que les
règles n'ont pas vue (`AI_FINDING`, origine `AI_PROPOSAL`). Les étapes lui sont données comme candidates
et des faits d'interface comme preuves — jamais une valeur saisie.

**Le flow n'est jamais modifié** (`flowModified: false`) : chaque constat est une revue à faire. Il
apparaît en commentaire au-dessus de l'étape concernée dans `generated.flow.yaml` :

```yaml
steps:
  # FLOW AUDIT F1 [WARNING] EFFECTLESS_CLICK_BEFORE_SAME_TARGET (AI_CONFIRMED): remove step 2 (a click that did nothing: …)
  # UNRESOLVED_HUMAN_ACTION · ACCESSIBLE · h013 · raw r19
  - click:
      text: Process request
```

Événement : `RECORDING_FLOW_AUDITED`. Configuration : `recording.flowAudit: { enabled, ai, maxCalls }`.

## Progression après l'arrêt

Après **Stop**, le système continue de travailler avant de rendre la main. Sans retour, ce temps ressemblait à un blocage. Il est maintenant **montré** à deux endroits.

**Dans le navigateur** (encore ouvert pendant la finalisation de la capture), le bandeau devient :

- « ⏳ FINALIZING — N pending task(s) », avec une barre animée, pendant que les validations en file se terminent ;
- « ✓ CAPTURE DONE — building the flow (see the terminal) » juste avant la fermeture.

Les boutons disparaissent dès l'arrêt.

**Dans le terminal**, une ligne animée affiche la tâche, la barre, la phase sur le total, un détail et le temps écoulé :

```
⠹ Finalizing the recording [█████░░░░░░░░░░░░░] 3/6 Building the flow · 4.2 s
✓ Finalizing the recording — 12 step(s) · REPLAY_CONFIRMED (38.5 s)
```

**Les phases :**

1. Finishing the capture : saisies en attente, dernier écran, validations en file (compte à rebours).
2. Closing the browser.
3. Building the flow.
4. Writing the files.
5. Auditing the flow : avec le conseiller d'intelligence si `ai.mode` ≠ OFF.
6. Validating by replay : avec `--validate` seulement.
7. Writing the report.

**Fin d'un run** (`learn`, `verify`, `explore`) : après le dernier flow, la même barre « Finishing the run » suit ces phases :

- Closing the run ;
- Checking the other actors (multi-acteurs) ;
- Comparing with earlier runs ;
- Saving the knowledge ;
- Writing the artifacts ;
- Saving the baseline (`learn`) ;
- Writing the reports.

**Comportement de l'affichage :**

- **Sortie redirigée** (CI, fichier, variable `CI`) : une ligne par phase, sans animation.
- **Messages ordinaires** : ils effacent la ligne animée, qui revient ensuite.
- **Code d'intégration** : il reçoit les mêmes mises à jour avec `onProgress` (de `runRecording` et `runMission`).
