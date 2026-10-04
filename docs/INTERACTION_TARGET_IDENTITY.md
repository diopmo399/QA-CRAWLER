# Identité de cible d'interaction (InteractionTargetIdentity)

> FOUND ELEMENT ≠ CORRECT ELEMENT · PLAYWRIGHT ACTION SUCCEEDED ≠ FUNCTIONAL SUCCESS ·
> URL DID NOT CHANGE ≠ NO TRANSITION · TARGET NOT FOUND ≠ TARGET DOES NOT EXIST

La classe de problèmes traitée : « le crawler connaît un élément DOM mais ne comprend pas assez
son identité fonctionnelle et son contexte ». Le correctif #86 (FieldIdentity) la réglait pour les
saisies. Celui-ci l'étend à toute interaction : bouton, lien, liste, option, case, radio, onglet,
menu, accordéon, dialogue, composant maison.

## Audit : ce qui existait, ce qui manquait

| Demande                                               | Existant                                                                                                                                                                                                    | Manque (corrigé ici)                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Contexte structurel (§3)                              | `sectionPath`, `dialogName`, `componentTag`, `formField` (#84/#86)                                                                                                                                          | le **propriétaire** de l'interaction (formulaire, onglet, accordéon, ligne de tableau, menu, liste → contrôle), l'état de son conteneur (onglet sélectionné, panneau ouvert)                                                                                                                                                               |
| Résolution contextuelle (§9, §10)                     | `functional-target.ts` : découverte, score (libellé, section, dialogue, voisins, parcours), décision `AMBIGUOUS`, jamais le premier (#84, #86)                                                              | l'appartenance (onglet, accordéon, formulaire, ligne, propriétaire) dans le score ; une pénalité pour un id généré                                                                                                                                                                                                                         |
| SELECT (§6)                                           | un clic d'ouverture suivi d'une option devient `SELECT` avec la cible de la liste (le contrôle parent)                                                                                                      | une `mat-option` cliquée seule ne connaissait pas sa liste : elle connaît maintenant son contrôle (`listboxOwner`)                                                                                                                                                                                                                         |
| CHECK (§7)                                            | `setCheckedRobust` relit l'état (natif ou `aria-checked`) et échoue s'il ne change pas                                                                                                                      | la preuve n'apparaissait pas : `CHECKED_STATE_CHANGED` / `CHECKED_STATE_NOT_CHANGED` est émis et l'état attendu (`expectedState`) est enregistré dans l'empreinte ; un état contraire relu après l'action est un `WRONG_EFFECT`                                                                                                            |
| WRONG_TAB_SELECTED / PARENT_SECTION_CLOSED (§15, §16) | `expected-target.ts` **devine** la section parente par ressemblance de libellés (confiance 0,35 à 0,65)                                                                                                     | la cible porte son onglet et son accordéon **enregistrés** : `TARGET_CONTEXT_MISMATCH` exact (attendu / réel), puis une récupération SAFE (ouvrir la section, sélectionner l'onglet) par le planificateur existant                                                                                                                         |
| AUTH (§17)                                            | `AUTH_STATE_CHANGED` / `ROLE_PERMISSION_CHANGED` bloquent la récupération                                                                                                                                   | `AUTH_CONTEXT_DIVERGENCE` : rôle et capacités attendus / observés, quand ils sont connus                                                                                                                                                                                                                                                   |
| Première divergence (§14)                             | `rootStepIndex` = l'étape d'avant si son effet a été différé (une seule étape en arrière)                                                                                                                   | une recherche sur **toutes** les étapes précédentes : la dernière étape après laquelle le contexte requis (onglet, dialogue, route) a été perdu                                                                                                                                                                                            |
| Transition (§11, §12, §21, §22)                       | `TransitionTracker` : signaux, stabilité, cible suivante, borne (#83)                                                                                                                                       | avec des effets déclarés non observés, une route changée et un écran stable attendaient **la borne entière** (10 s). Corrigé par le `TransitionSuccessPredicate` (route changée, OU écran reconnu, OU cible suivante disponible, ET interface stable) et le `NO_PROGRESS_TIMEOUT` (plus aucun progrès : on conclut sans attendre la borne) |
| Effets causaux (§18, §19, §20)                        | #85 : frontière à l'action humaine suivante, `CausalEffectCandidate` (propriétaire, confiance, preuves), provenance dans le YAML ; la cible suivante sert de point de contrôle sans jamais devenir un effet | rien à refaire : la règle « une action ne récupère jamais l'effet d'une action future » est déjà testée (test I)                                                                                                                                                                                                                           |

## Architecture

```
DOM → InteractionOwner (capture) → identité framework / sémantique / structurelle → InteractionTargetIdentity
    → TargetResolver contextuel (functional-target.ts, un seul moteur) → SafetyPolicy → Playwright
    → TransitionTracker (prédicat de succès, progrès) → ActionEffectVerifier → point de contrôle fonctionnel
```

- **InteractionOwner** (capture) : le plus proche conteneur sémantique qui possède l'interaction :
  `dialog`, `tabpanel` (et son onglet), `accordion` (et son état), `form`, `fieldset`, `card`,
  `row`, `menu`, `listbox` (et le contrôle qui l'ouvre), `toolbar`, ou le composant maison (balise
  à tiret) découvert génériquement.
- **InteractionTargetIdentity** (`src/flows/interaction-target-identity.ts`). Les adaptateurs
  (Field, Button, Selection, Checkbox, Radio, Tab, Menu, Dialog, CustomComponent) lisent tous la
  **même** empreinte enregistrée. Ils produisent une identité commune (élément direct, propriétaire,
  identités framework, accessible et métier, contexte structurel et fonctionnel) et une
  `ActionContextFingerprint`. Il n'y a pas de moteur de résolution parallèle : l'identité nourrit le
  score de `functional-target.ts`.

## Défauts trouvés en reproduisant les scénarios (navigateur réel)

1. **Contamination par un effet synchrone de l'action suivante.** Le cas : cocher une case, puis
   cliquer « Filter », qui ouvre son dialogue **dans** le gestionnaire du clic. #85 traitait
   l'action suivante qui **navigue** (route). Ici, la capture de frontière prise au clic suivant
   contenait déjà le dialogue : la case attendait `+ textbox:Keyword, + button:Apply`, puis
   échouait au rejeu.
   - Correctif : la capture pré-action (au `pointerdown`, **avant** le gestionnaire de
     l'application) fige maintenant les noms des contrôles visibles (`pre.controls`). C'est
     l'écran laissé par l'action précédente.
   - Un contrôle apparu qui n'y est pas encore est `BELONGS_TO_NEXT_ACTION`.
   - Il est **réattribué** à l'action suivante (`EFFECT_REASSIGNED`) : « Filter » attend son
     dialogue, la case n'attend rien qui ne soit pas à elle.
2. **Une action jamais exécutée, pourtant réussie.** Une case dans un accordéon fermé : la
   récupération jugeait l'objectif « déjà atteint ». L'objectif d'une case excluait la case
   elle-même ; il ne restait que la cible de l'étape suivante, visible. L'étape passait sans
   avoir coché (`GOAL_ALREADY_REACHED`).
   - Correctif : la case fait partie de son propre objectif.
   - Une récupération qui n'a rétabli que la **précondition** (contexte, section ouverte, champ
     disponible) réexécute toujours l'action d'origine : CHECK, UNCHECK, et toute étape dont la
     divergence est un `TARGET_CONTEXT_MISMATCH`.
3. **Le contexte de la suite.** Une étape qui échoue sur son point de contrôle « cible suivante
   disponible » exige aussi le contexte de cette cible (son onglet) pour la recherche de la
   première divergence fonctionnelle.
4. **La liste blanche de l'enregistreur.** Les nouveaux champs de capture y sont ajoutés (leçon
   de #86 : un champ absent de la liste blanche disparaît sans bruit).

## Tests (spécification §26)

| Test | Où             | Vérifie                                                                                                                                                                      |
| ---- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A    | unitaire + E2E | deux « Apply » de deux dialogues ouverts : celui de « Filter » (propriétaire) ; le serveur reçoit `Filter`                                                                   |
| B    | unitaire       | deux `#valueInput` de deux formulaires : le formulaire les distingue                                                                                                         |
| C    | unitaire       | deux listes de même structure : le libellé ; une option appartient à sa liste (`SELECT_OPERATOR`)                                                                            |
| D    | unitaire + E2E | une case sans id stable : son libellé et sa section ; `CHECKED_STATE_CHANGED` relu au rejeu                                                                                  |
| E    | unitaire       | cible enregistrée dans « Company », « Individual » sélectionné : `WRONG_TAB_SELECTED` exact (0,92)                                                                           |
| F    | unitaire + E2E | accordéon fermé : `TARGET_NOT_RENDERED_BECAUSE_PARENT_CLOSED`, ouverture SAFE, case réellement cochée                                                                        |
| G    | unitaire       | route changée et cible suivante disponible à 1,45 s : fin à environ 1,9 s, jamais 10 s ; effets non observés mais route changée et écran stable : `FUNCTIONAL_STATE_REACHED` |
| H    | unitaire       | réseau encore actif : aucune conclusion tant qu'une requête est en cours                                                                                                     |
| I    | unitaire + E2E | N suivi immédiatement de N+1 : les effets de N+1 ne sont jamais attribués à N (et lui reviennent)                                                                            |
| J    | unitaire       | id généré changé (`mat-input-12` → `mat-input-31`) : résolution par l'identité                                                                                               |
| K    | unitaire       | deux candidats indiscernables : `AMBIGUOUS`, jamais le premier                                                                                                               |
| L    | unitaire       | composant maison inconnu : propriétaire `component:x-rating-stars`, type `CUSTOM_COMPONENT`                                                                                  |
| M    | unitaire       | exécutée, autre effet : `WRONG_EFFECT`                                                                                                                                       |
| N    | unitaire + E2E | bonne cible, bon effet, suite disponible : `ACTION_CONFIRMED`                                                                                                                |
| O    | unitaire + E2E | l'étape qui devait établir l'onglet ne l'a pas fait : `FIRST_FUNCTIONAL_DIVERGENCE` = cette étape, pas l'étape en échec                                                      |
| AUTH | unitaire       | écran de connexion + 401 : `AUTH_CONTEXT_DIVERGENCE` (rôle et capacités attendus / observés), jamais récupéré                                                                |
