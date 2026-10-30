# ADR 0002 — Extraire plusieurs groupes métier d'un enregistrement vers la bibliothèque

- Statut : accepté
- Portée : serveur SDK (bibliothèque, enregistrements), client, Dashboard (revue, bibliothèque)

## Contexte (audit)

**Les groupes métier existent déjà, dans le Recorder.** `RecordedFlow.groups` (`recorded-flow.json`)
porte des `BusinessStepGroup` : un identifiant stable, un nom, une description, les identifiants des
étapes (`stepIds`). Ils sont proposés par l'analyse (`proposeGroups`, avec une confiance), jamais
créés sans décision humaine, et modifiés par commandes (`applyGroupCommand` : créer, renommer,
déplacer, détacher…). Le YAML généré les recopie (`groups:` avec les positions des étapes).

**Le Recorder calcule déjà les dépendances entre groupes.** `groupViews` donne pour chaque groupe :
ses positions, sa page de départ (le dernier `goto` avant lui, sinon le départ du flow), ses
vérifications et ses assertions métier, ses entrées (une donnée produite ailleurs, avec l'étape et le
groupe producteurs) et ses sorties (une donnée produite ici et citée ailleurs), et s'il est jouable
seul (`runnableAlone`). Une donnée est produite par la première saisie de sa clé (`{ testData: clé }`)
et consommée par une citation (`${testData:clé}`). `flowForGroups` réduit déjà un flow à des groupes
choisis (génération, exécution), en refusant une sélection à laquelle il manque une donnée.

**La bibliothèque** (`src/sdk/server/library.ts`, `library-contract.ts`) range des blocs
(`reusable: true`) sous `<flows>/library/<bloc>/`, avec un registre (`sdk-library.json`, version 2) :
identifiant, version validée, empreinte, historique, origine, contrat déclaré ; et pour chaque
parcours composé, la version de chaque bloc rejoué. Le contrat est dérivé du contenu (entrées : les
clés lues sans être définies ; sorties : les clés saisies à partir de son propre jeu) ou déclaré, puis
comparé au contenu. `checkComposition` vérifie un parcours sans rien exécuter.

**Manques constatés :**

1. Un seul groupe à la fois (`addGroupToLibrary`), sans aperçu ni rapport de validation.
2. Le bloc reçoit **tout** le jeu de données de l'enregistrement. Une donnée produite par un autre
   groupe y reste définie : le bloc ne déclare pas l'entrée qu'il lit, et une valeur générée au
   rejeu serait regénérée dans le bloc au lieu de venir du groupe producteur. La dépendance disparaît
   au lieu d'être signalée.
3. Les assertions métier du groupe (`assertions:` avec `after:`) ne sont pas recopiées.
4. La provenance garde le nom de l'enregistrement et du groupe, pas les étapes, la date, l'auteur
   ni la version de l'enregistrement ; aucune comparaison avec la source.
5. Aucun bloc n'est validé contre le schéma des flows : un flow invalide entre dans la bibliothèque,
   est composé, puis le rejeu échoue en `500 INTERNAL` (et l'écran Scénarios ne dit rien).
6. Dans un parcours composé, le moteur recopie les étapes d'un bloc, pas sa page de départ ; rien ne
   le dit.

## Décision

1. **Réutiliser les groupes du Recorder.** Aucun second système de regroupement : la sélection porte
   sur les `BusinessStepGroup` existants (identifiants, étapes, dépendances de `groupViews`).

2. **Un plan d'extraction, calculé sans rien écrire** (`library-extract.ts`, fonctions pures) :
   pour une sélection (des groupes ; pour un groupe, une partie de ses étapes) et un mode, chaque bloc
   prévu reçoit ses étapes (telles que dans le YAML généré), ses assertions métier (positions
   renumérotées), ses groupes internes (mode composé), **son jeu de données restreint** aux clés
   qu'il utilise et que ni un groupe non sélectionné ni un autre bloc du plan ne produit, son contrat
   dérivé, ses dépendances (données reçues d'un groupe sélectionné, d'un groupe non sélectionné, ou de
   nulle part), sa provenance et un **rapport de validation**.
   - Mode « un bloc par groupe » et mode « un bloc composé » (les groupes internes et leurs
     identifiants d'origine sont gardés dans `groups:` du bloc).
   - Une partie d'un groupe n'est acceptée que si chaque vérification garde l'action qu'elle suit.
   - Une donnée produite par un groupe non sélectionné devient une **entrée obligatoire** du bloc,
     signalée avec son producteur. L'utilisateur peut ajouter le producteur à la sélection, ou
     fournir explicitement une valeur fixe pour cette clé (notée « fournie à la publication » dans la
     provenance). Aucune valeur n'est jamais inventée.

3. **Publier = vérifier puis écrire tout ou rien.** Un bloc dont la validation échoue n'est jamais
   écrit ; avec plusieurs blocs, aucun n'est écrit si l'un échoue. La validation : schéma des flows
   (actions, stratégies de ciblage, `run:`), jeu de données, clés lues, contrat, noms et identifiants,
   provenance. Les erreurs sont localisées (« étape 3 (fill) : … »).

4. **Provenance étendue** (registre, ajout seul, compatible) : enregistrement, session, groupe(s),
   identifiants des étapes, date d'extraction, auteur (accès nominatif), empreinte du flow de
   l'enregistrement, transformations. **Comparaison avec la source** : le serveur refait le plan avec
   les groupes d'origine et compare ; **mise à jour contrôlée** : le nouveau contenu remplace celui du
   bloc, qui passe `CHANGED` et doit être validé comme toute nouvelle version.

5. **Validation de tous les blocs** : un bloc dont le flow est invalide est `INVALID` (il ne se
   compose plus) ; l'ajout d'un scénario au catalogue est validé de même ; un scénario invalide au
   lancement répond `422` (et non `500`). La vérification d'un parcours avertit quand un bloc a une
   page de départ sans commencer par y aller.

6. **API (ajouts seuls)** :
   - `POST /projects/:id/recordings/:nom/library/plan` → `ExtractionPlan` (droit `VIEW`) ;
   - `POST /projects/:id/recordings/:nom/library` → les blocs créés (droit `PUBLISH`) ;
   - `GET /projects/:id/library/:bloc` → le détail d'un bloc (étapes, groupes internes, données) ;
   - `GET|POST /projects/:id/library/:bloc/source` → comparaison, mise à jour depuis la source.
     Client : `library.planExtraction`, `library.publishExtraction`, `library.details`,
     `library.compareSource`, `library.updateFromSource`.

7. **Interface** : la revue d'un enregistrement gagne une sélection de groupes (cases, tout, aucun),
   un résumé, l'aperçu de chaque bloc et un panneau de publication ; la bibliothèque passe à un
   catalogue compact (grille ou liste, regroupement par origine, récents) et à une fiche par onglets ;
   le compositeur en trois colonnes. Tout est branché sur ces routes.

## Conséquences

- Les blocs déjà publiés restent lisibles tels quels : les nouveaux champs de provenance sont
  facultatifs, le registre reste en version 2.
- Un bloc extrait d'un groupe qui reçoit une donnée d'un autre groupe déclare désormais cette entrée :
  il ne se compose qu'après un bloc qui la produit, ou avec un jeu qui la définit.
- Un bloc publié n'est jamais modifié en silence : une modification de l'enregistrement se voit dans la
  comparaison, et ne s'applique que par une mise à jour demandée puis une nouvelle version validée.
