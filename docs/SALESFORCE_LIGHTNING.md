# Salesforce Lightning

> **Statut** : prise en charge construite à partir du fonctionnement **documenté** de Lightning
> Experience, et vérifiée sur une **imitation locale** (`tests/fixtures/lightning-app.ts`). Elle n'a
> **jamais** été validée sur une vraie organisation Salesforce. La section « Évaluer sur une sandbox »
> dit comment mesurer la compatibilité réelle, le jour où une sandbox est disponible.

## Activer le profil

Projet (`qa-crawler.config.yaml`) :

```yaml
qaCrawler:
  application:
    baseUrl: https://mon-domaine--recette.sandbox.lightning.force.com
    startAt: /lightning/page/home
    platform: salesforce-lightning
```

Mission : `target.platform: salesforce-lightning`. Assistant du SDK : type « Salesforce Lightning ».
Sans ce réglage, la plateforme est `generic` et rien de ce qui suit ne s'applique, sauf les
améliorations générales signalées comme telles.

## Ce que le profil change

| Trait de Lightning                                                                               | Sans le profil                                                               | Avec le profil                                                                                                                                                                                                    | Vérifié par                                                 |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Les **lectures** passent par `POST /aura` (Aura) ou `POST …/graphql` (UI API GraphQL)            | la garde d'écriture annule ces POST : les listes et les fiches restent vides | un `POST /aura` passe si **toutes** ses actions lisent (méthode `get…`, `load…`, `search…`, `list…`, `describe…`…) ; une requête GraphQL passe si elle ne contient aucune `mutation` ; tout le reste reste bloqué | `tests/integration/salesforce-lightning.test.ts`, unitaires |
| Les **écritures** passent aussi par `POST /aura` (`updateRecord`, `createRecord`, Apex `saveX`…) | bloquées                                                                     | toujours bloquées et listées dans le rapport des écritures bloquées                                                                                                                                               | idem                                                        |

Le jeton CSRF d'Aura (`aura.token`) voyage dans ces corps : le moteur les lit pour décider, ne les
écrit nulle part et ne les journalise pas.

**L'heuristique a une limite** : elle se fie au nom de la méthode. Une méthode Apex nommée `getX` qui
écrirait passerait ; une lecture au nom inhabituel (`process`, `run`) est bloquée. Une écriture
attendue s'autorise explicitement (`safety.writeGuard.allow`) ; une lecture bloquée apparaît dans le
rapport, avec son URL.

## Ce que le moteur fait désormais pour toutes les applications

Ces changements ne dépendent pas du profil ; Lightning en a été l'occasion.

| Changement                                                                                                  | Pourquoi                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| L'attente d'écran cherche les chargeurs **dans les arbres Shadow DOM** et compte leurs éléments (stabilité) | dans un composant web, `document.querySelectorAll` ne voit pas le chargeur : l'écran semblait prêt trop tôt (mesuré : 229 ms au lieu des 800 ms du chargeur) |
| `lightning-spinner` fait partie des chargeurs reconnus                                                      | le chargeur standard de Lightning                                                                                                                            |
| `/lightning/r/<Objet>/<Id 15 ou 18 caractères>/…` devient `/lightning/r/<objet>/:recordid/…`                | sans cela, chaque enregistrement est une route nouvelle et consomme le budget d'exploration                                                                  |
| Une valeur `123:0` (`data-aura-rendered-by`) est un attribut généré, jamais une identité d'élément          | compteur de rendu Aura, différent à chaque affichage                                                                                                         |

## Ce qui existait déjà et sert Lightning

- Les sélecteurs de Playwright traversent les arbres Shadow DOM ouverts ; la découverte des actions, la
  capture du recorder et les formulaires en Shadow DOM sont pris en charge.
- Les identifiants d'éléments qui portent un nombre (`input-17`, `combobox-button-45`) sont déjà
  traités comme générés ; les cibles passent par le rôle et le nom accessibles.
- Onglets (`role=tab`), listes déroulantes (`role=combobox` / `listbox`), grilles (`role=grid`) et
  fenêtres (`role=dialog`) font partie du contexte d'interaction de chaque action.
- Les mots « Supprimer », « Soumettre », « Approuver » (et leurs équivalents anglais) classent une
  action comme dangereuse : elle n'est pas jouée en exploration.
- Connexion par formulaire, SSO, réutilisation d'une session enregistrée (utile quand la connexion
  demande une vérification en deux étapes).

## Limites connues (non traitées)

- **Shadow DOM synthétique** : Lightning Experience émule le Shadow DOM (LWC « synthetic shadow »).
  L'imitation utilise le Shadow DOM natif. Le comportement de la traversée sur l'émulation n'est pas
  vérifié ici : c'est le premier point à mesurer sur une sandbox (scénario S3).
- **Iframes** (pages Visualforce, certains composants tiers) : les actions dans une iframe ne sont pas
  explorées.
- **Console de service** (onglets d'espace de travail, sous-onglets) : non testée.
- **Vérification en deux étapes** : non automatisable ; passer par une session enregistrée.
- **Limites d'API** de l'organisation : une exploration fait de nombreuses lectures Aura ; garder des
  budgets modestes.
- **Méthodes Apex** : classification par le nom seulement (voir plus haut).

## Évaluer sur une sandbox

À faire **sur une sandbox**, jamais en production, avec un utilisateur de test qui ne voit que des
données de test.

### Préparation

1. Un utilisateur de test dédié, profil en lecture, plus les jeux d'autorisations des écrans à tester.
2. Les identifiants dans des variables `QA_USERNAME` / `QA_PASSWORD` sur la machine qui lance
   QA-CRAWLER (jamais dans un fichier ni dans une conversation). Avec une vérification en deux
   étapes : réutiliser la session après une connexion (`auth.session.reuse: true`, fichier hors du
   dépôt).
3. Les hôtes autorisés : le domaine de l'organisation (`*.lightning.force.com`,
   `*.my.salesforce.com`, `*.sandbox.my.salesforce.com` selon l'organisation) — rien d'autre.
4. Des budgets courts pour commencer : `maxStates: 15`, `maxActions: 60`, `maxDurationMinutes: 10`.

```yaml
mission: { name: sandbox-lightning, mode: explore }
target:
  baseUrl: https://mon-domaine--recette.sandbox.lightning.force.com
  startAt: /lightning/page/home
  platform: salesforce-lightning
auth:
  type: form
  loginUrl: https://mon-domaine--recette.sandbox.my.salesforce.com/
  usernameSelector: '#username'
  passwordSelector: '#password'
  submitSelector: '#Login'
  usernameEnv: QA_USERNAME
  passwordEnv: QA_PASSWORD
  successUrlContains: /lightning/
  session: { reuse: true }
exploration: { maxStates: 15, maxActions: 60, maxDurationMinutes: 10, maxStatesPerRoute: 2 }
```

### Scénarios et grille

Pour chaque scénario, noter **Réussi**, **Partiel**, **Échec** ou **Non testé**, avec ce qui a été
observé (chiffres, catégories d'erreurs) — sans copier de données de l'organisation.

| #   | Scénario                                    | Ce qu'on observe                                   | Réussi si                                                                                     |
| --- | ------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| S1  | Connexion                                   | statut d'authentification, écran d'arrivée         | l'exploration démarre sur `/lightning/…` connecté                                             |
| S2  | Navigation de l'application                 | écrans découverts depuis la barre de navigation    | les onglets de l'application apparaissent comme écrans distincts                              |
| S3  | Vue de liste                                | les lignes de la liste, écritures bloquées         | des fiches `/lightning/r/…` sont atteintes ; aucune lecture Aura parmi les écritures bloquées |
| S4  | Fiche d'enregistrement                      | onglets Détails / Associé, actions découvertes     | les onglets sont des contextes distincts ; « Supprimer » est bloqué                           |
| S5  | Recherche globale                           | saisie, résultats                                  | la recherche s'exécute (lecture) et mène à une fiche                                          |
| S6  | Composants de l'application métier (Apex)   | lectures Apex bloquées ou admises                  | les lectures nécessaires passent, ou sont listées pour `writeGuard.allow`                     |
| S7  | Parcours enregistré par un humain           | `qa-crawler record`, puis rejeu                    | le flow rejoue sur une deuxième session                                                       |
| S8  | Modification (enregistrement de test dédié) | avec `safety.mutations.enabled` limité à cet écran | la modification passe, le toast est observé, rien d'autre n'est modifié                       |

Ce qu'il faut rapporter : la grille, les compteurs du rapport (écrans, actions, actions bloquées,
anomalies par gravité), la liste des écritures bloquées (méthode et chemin, sans paramètres) et les
messages d'erreur du moteur. Pas de captures d'écran ni de valeurs de l'organisation.
