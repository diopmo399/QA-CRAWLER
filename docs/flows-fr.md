# Créer un flow de test imposé

Par défaut, QA-CRAWLER explore l'application tout seul et choisit lui-même quoi cliquer. Un **flow imposé** lui fait suivre des étapes précises, dans l'ordre : se connecter, remplir un formulaire, vérifier le résultat. La politique de sécurité continue de s'appliquer à chaque étape.

Exemples complets :

- [`scenarios/demo-flows.yaml`](../scenarios/demo-flows.yaml) : le mini back-office de démo (`npm run demo:server`) ;
- [`scenarios/mosquee-flows.yaml`](../scenarios/mosquee-flows.yaml) et [`scenarios/mosquee-devoir.yaml`](../scenarios/mosquee-devoir.yaml) : une application Angular réelle.

## 1. Squelette d'une mission avec flow

Crée un nouveau fichier dans `scenarios/` (par exemple `scenarios/mon-flow.yaml`). Ne modifie pas `demo-flows.yaml` : c'est la démo.

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

## 2. Les étapes

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

## 3. Désigner un élément (cible)

Une seule stratégie par cible, comme dans Playwright :

| Stratégie       | Exemple                                           | Quand l'utiliser                                                       |
| --------------- | ------------------------------------------------- | ---------------------------------------------------------------------- |
| `role` + `name` | `{ role: button, name: Enregistrer }`             | Boutons, liens (`role: link`), onglets (`role: tab`) : le plus robuste |
| `label`         | `{ label: Titre }`                                | Champs avec un `<label>` relié ou un `mat-label`                       |
| `text`          | `{ text: Voir le détail }`                        | Texte visible                                                          |
| `testId`        | `{ testId: btn-save }`                            | Attribut `data-testid`                                                 |
| `css`           | `{ css: 'input[formcontrolname="identifiant"]' }` | Dernier recours                                                        |

- `exact: true` : correspondance exacte du texte (sinon, « contient »).
- `nth: 2` : prend le 3ᵉ élément trouvé (le décompte commence à 0).
- Sans `nth`, si plusieurs éléments correspondent, celui qui est **dans la fenêtre (modale) ouverte** est choisi.

Pour trouver le bon libellé : fais clic droit → **Inspecter** sur l'élément dans ton navigateur, ou lance le test avec `--headed`.

## 4. La sécurité s'applique toujours

Le YAML choisit l'élément, mais la politique de sécurité le classe exactement comme pendant l'exploration automatique, et décide.

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

## 5. Pièges fréquents

| Problème                                                               | Solution                                                                                           |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `élément introuvable` sur un champ dont le `<label>` n'est pas relié   | Utilise `css: 'input[formcontrolname="…"]'`                                                        |
| « Nouveau devoir » est BLOQUÉ                                          | « Nouveau » est un mot de modification : ajoute `allow: MUTATION`                                  |
| « Se connecter » est BLOQUÉ                                            | C'est un envoi de formulaire : ajoute `allow: MUTATION`, ou utilise le bloc `auth`                 |
| Deux champs « Classe » (filtre de la page et fenêtre)                  | Rien à faire : celui de la fenêtre ouverte est choisi                                              |
| Tous les flows échouent, les écrans s'appellent « Opps!!! » ou « 404 » | Mauvaise application : vérifie `baseUrl` et que `QA_BASE_URL` n'est pas défini                     |
| Ça explore alors que `autonomous: false`                               | `thenExplore: true` explore quand même le dernier écran du flow : retire-le                        |
| La fenêtre grise « Connexion » du navigateur apparaît                  | Ce n'est pas un formulaire : utilise `auth: { type: http, origin: https://… }` (voir README)       |
| `expect` échoue alors que le texte est visible                         | Le texte doit être exact au caractère près (accents, tirets « — ») ; essaie une partie plus courte |

## 6. Ordre d'exécution

1. Connexion (`auth`), puis chargement de `target.startAt`.
2. Chaque flow, dans l'ordre, depuis son propre `startAt`. Une étape échouée ou bloquée arrête ce flow ; ses étapes suivantes sont IGNORÉES. Les flows suivants s'exécutent quand même.
3. Avec `thenExplore: true` : exploration du dernier écran du flow (sans le menu général).
4. Avec `exploration.autonomous: true` (défaut) : exploration de toute l'application.

## 7. Résultats

- `reports/index.html`, section **Flows imposés** : chaque flow est RÉUSSI, ÉCHOUÉ, BLOQUÉ ou IGNORÉ ; chaque étape a son statut, sa classe, sa raison, l'état atteint, sa durée et sa capture.
- Une étape échouée ou bloquée crée une anomalie `FLOW` (ERREUR, ou AVERTISSEMENT pour une étape `optional`) : le run échoue avec le code 1, pratique en CI.
- `reports/result.json` contient un tableau `flows` (toujours en anglais, pour les outils).
- Le terminal affiche chaque étape en direct : ✓ réussie, ✗ échouée, ⛔ bloquée, - ignorée.
