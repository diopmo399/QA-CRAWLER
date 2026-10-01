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

**Aucune saisie en clair ne quitte la page.** D'une valeur tapée, le navigateur n'envoie que
sa forme (vide, longueur, e-mail / nombre / date / téléphone…) et une empreinte salée (le sel
de la session n'est jamais écrit) — et aucune empreinte pour un champ sensible. Mots de passe,
jetons, codes à usage unique, PIN, CVV, clés d'API, cookies : jamais stockés. Un choix de
l'interface (option d'une liste, radio) est gardé : c'est un texte de l'écran.

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

- **Bruit** : clics de focus dans un champ, touches, clics sur un libellé : retirés.
- **Saisies** : plusieurs saisies d'un même champ → une étape, la valeur finale.
- **Corrections** : un champ ressaisi, une case cochée puis décochée → la valeur finale (ou
  rien). Jusqu'au prochain envoi seulement.
- **Navigations** : celles qu'une action a causées (redirection, route d'une SPA) ne sont pas
  des étapes. Un point de contrôle posé après une redirection appartient à l'action qui l'a
  causée.
- **Détours** : un onglet / un lien ouvert puis quitté aussitôt pour un contrôle déjà
  visible avant lui (ou un retour arrière) → retiré.
- **Invalide puis valide** : un envoi refusé, corrigé, puis renvoyé. Avec un point de
  contrôle sur l'erreur, c'est voulu : le flow garde les deux envois et vérifie le refus
  (**NEGATIVE_VALIDATION_FLOW**). Sans point de contrôle, la tentative refusée est écartée
  et signalée (**AMBIGUOUS_RECORDING_INTENT**).
- **Jamais retirée** : une action qui a écrit (requête acceptée), changé un état métier,
  ou qui porte un point de contrôle.

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
`recorded-flow.json`, `generated.flow.yaml`, `generated.feature`, `flow-graph.json` (la carte
des écrans et des actions), `recording-events.jsonl`, `index.html` (résumé en nombres — sans
note globale —, intention comprise, qualité des cibles et des valeurs, trace
RAW → SEMANTIC → FINAL avec le pourquoi de chaque étape, vérifications candidates).

Événements : `RECORDING_STARTED`, `RAW_EVENT_CAPTURED`, `SEMANTIC_ACTION_RESOLVED`,
`CHECKPOINT_ADDED`, `RECORDING_PAUSED`, `RECORDING_RESUMED`, `RECORDING_STOPPED`,
`RECORDING_NORMALIZED`, `OUTCOME_INFERRED`, `FLOW_GENERATED`, `REPLAY_VALIDATION_STARTED`,
`REPLAY_CONFIRMED`, `REPLAY_FAILED`, `RECORDING_COMPLETED`, `RECORDING_FAILED`.

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
```

`qa-crawler run` ne lit pas cette section : désactiver l'enregistrement ne change rien aux runs.

## Limites

- Seule la page principale est enregistrée (pas les iframes).
- Un `confirm()` pendant l'enregistrement est accepté (`recording.dialogs.confirm`) ; au
  rejeu, la règle des dialogues de la mission s'applique (`browserInteractions.dialogs`).
  Un `prompt()` est refusé (sa réponse serait une saisie).
- Un envoi de fichier devient une intention `UPLOAD` sans fichier : à compléter.
- Un message affiché brièvement (toast) n'est proposé qu'en revue.
- L'humain qui va très vite peut regrouper plusieurs actions dans une même observation de
  l'écran : l'ordre et les requêtes restent justes, l'écran intermédiaire peut manquer.
