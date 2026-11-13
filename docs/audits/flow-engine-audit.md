# Moteur de reconstruction des flux — audit et complément

Branche `feat/flow-engine-completion`, partie de `main` (`52a9991`). Le moteur reste 100 % statique :
TypeScript Compiler API (AST, sans exécution) et analyseurs Java existants.

- Aucun LLM, aucun navigateur.
- Aucun test généré ni exécuté sur les applications analysées.
- Aucune dépendance ajoutée.
- Aucun dépôt cloné modifié.

Les statuts ci-dessous viennent de **cas de code exécutés contre le moteur** (`tests/fixtures/flow-engine`,
23 parcours) et des suites existantes, pas du nom des fonctions.

## 1. Audit de l'existant (avant modification)

Mesure de départ : **10 parcours justes sur 23** sur les cas représentatifs.

| #   | Capacité                        | Statut avant | Où                                                                                    | Limite constatée                                                                              |
| --- | ------------------------------- | ------------ | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1   | AST TypeScript                  | COMPLET      | `src/static-analysis/ts-facts.ts`, `src/cartography/analyze-rxjs.ts`                  | syntaxique, sans TypeChecker (choix assumé)                                                   |
| 2   | Analyse Java                    | COMPLET      | `analyze-java.ts`, `java-hierarchy.ts` — `cartography-java-dispatch.test.ts`          | —                                                                                             |
| 3   | Graphe d'appels (front)         | PARTIEL      | `analyze-rxjs.ts` `callLink`                                                          | fonction utilitaire recevant le store et référence de méthode passée en rappel : aucun lien   |
| 4   | Alias                           | COMPLET      | `receiverOf`, alias `bind`, déstructuration — cas 01 et 02                            | —                                                                                             |
| 5   | Dispatchs                       | PARTIEL      | `specialize`, `decisivePaths`                                                         | un `dispatch(action)` sans condition (`this.actions.next(action)`) n'était pas suivi par type |
| 6   | Flux RxJS                       | PARTIEL      | `readStream`, canaux par type                                                         | voir « Lacunes RxJS » sous ce tableau                                                         |
| 7   | Souscriptions de `ngOnInit`     | COMPLET      | relation `SUBSCRIBES` — cas 03                                                        | —                                                                                             |
| 8   | Valeurs et conditions           | PARTIEL      | `valOf`, `verdictOf`, `controlOf`                                                     | pas de suivi du champ de type à travers les opérateurs d'un pipe                              |
| 9   | Services HTTP                   | PARTIEL      | branches HTTP par contexte — cas 08                                                   | un client HTTP injecté dans une classe de base était inconnu des sous-classes                 |
| 10  | Endpoints Front / BFF / Backend | COMPLET      | `correlate.ts` `matchCall` — `cartography-contract.test.ts` (28 tests)                | passerelle ou profil inaccessible : ambiguïté gardée (voulu)                                  |
| 11  | Contrats Maven                  | COMPLET      | `maven-resolve.ts`, `classfile.ts` — `cartography-maven-contracts.test.ts` (14 tests) | —                                                                                             |
| 12  | Réconciliation entre couches    | COMPLET      | `graph.ts` (liens non résolus, causes, candidats)                                     | état INVALIDATED non représenté                                                               |
| 13  | Preuves et confiance            | COMPLET      | `Evidence`, CONFIRMED / PROBABLE / UNKNOWN                                            | —                                                                                             |
| 14  | Cache incrémental               | PARTIEL      | `scan.ts:174` (empreinte du contenu + version d'analyseur)                            | par source entière, pas par fichier ; le graphe est reconstruit à chaque scan                 |

**Lacunes RxJS (ligne 6).**

- Garde de type lue seulement en premier opérateur d'un pipe.
- Prédicat dans une fonction, une méthode ou un opérateur maison non suivi.
- Émission faite dans un pipe comptée comme une source du flux, et non comme une émission.

Un défaut non listé au départ est apparu pendant le travail : les **membres hérités** (dépendances, client
HTTP, flux déclarés dans une classe de base) n'étaient pas connus des méthodes des sous-classes. Leurs
appels `this.api.save()` étaient ignorés.

## 2. Mécanismes ajoutés (tous dans `src/cartography/analyze-rxjs.ts`)

| Mécanisme                                | Fonction                                           | Ce qu'il fait                                                                                                                                                         |
| ---------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Garde d'un pipe, opérateur par opérateur | `walkOperators` (l. 3023), `applyFilter` (l. 2991) | Suit la forme de la valeur à travers les opérateurs ; un `filter` sur un champ connu restreint les valeurs admises (détail sous le tableau)                           |
| Prédicat suivi                           | `callableOf` (l. 2882), `predOf` (l. 2924)         | Rappel en ligne, fonction de module, méthode de la classe, délégation `(a) => this.isX(a)`, `[...].includes(a.type)`, opérateur maison paramétré (`onAction('LOAD')`) |
| Émission dans un pipe                    | `readStream` (l. 917), boucle des flux             | `tap(() => this.actions.next({ type: 'X' }))` est une émission vers le canal `actions⟨type='X'⟩` : un effet en déclenche un autre                                     |
| Valeur émise décisive                    | `decisivePaths` (l. 2718)                          | Un paramètre émis dans un flux trié par type rend son champ de type décisif : `dispatch(action) { this.actions.next(action) }` est suivi par type                     |
| Fonction utilitaire                      | pré-passe (l. 3187), `ModuleFn.calls`              | `emitOn(this.store, action)` : l'appel fait sur le paramètre est attribué à la méthode. Paramètres substitués, littéraux gardés, le reste inconnu                     |
| Référence de méthode                     | `passedTo` (l. 1692), `Method.invokes`             | `this.runNow(this.doSave)` : CONFIRMED si `runNow` appelle son paramètre, PROBABLE sinon, avec la raison                                                              |
| Récepteur réel                           | `selfSensitive` (l. 3213), contexte `#self`        | Une méthode héritée est suivie pour la sous-classe du récepteur : `BaseStore#dispatch⟨DraftStore, type='SAVE'⟩`                                                       |
| Méthode abstraite                        | `implementationsOf` (l. 3198)                      | Chaque implémentation lue est une candidate PROBABLE, aucune n'est choisie                                                                                            |
| Membres hérités                          | `rereads` (l. 370), `Inherited` (l. 444)           | Le fichier d'une sous-classe est relu avec les dépendances, clients HTTP et flux de ses classes de base                                                               |

**Forme de la valeur dans un pipe (`walkOperators`).**

- Inchangée : après `tap`, `debounceTime`, `distinctUntilChanged`, `takeUntil`, `catchError`…
- Objet recopié : après `map(a => ({ ...a }))`.
- Champ fixé : après `map(a => ({ ...a, type: 'X' }))`.
- Tableau : après `withLatestFrom`.
- Inconnue : après tout autre opérateur.

**Bornes.**

- Profondeur des prédicats et opérateurs maison : `MAX_GATE_DEPTH = 4`.
- Contextes d'appel : 64 par méthode, 50 000 en tout, profondeur 4.
- Parcours de diagnostic : 20 000 visites.
- Implémentations candidates : 20 par méthode abstraite.

Une limite atteinte est signalée et rend la source `PARTIAL` ; rien n'est supprimé en silence.

**Règles de prudence.**

- Un prédicat illisible ne restreint rien.
- Une valeur inconnue reste inconnue : toutes les suites sont gardées.
- Deux pipes qui trient la même source sur deux champs différents ne sont pas découpés.
- Une expression propre à une fonction utilitaire n'est jamais évaluée hors de son fichier.

## 3. Résultat sur les cas représentatifs

| Cas                                                             | Avant                        | Après       |
| --------------------------------------------------------------- | ---------------------------- | ----------- |
| 01 alias de store                                               | ✓                            | ✓           |
| 02 dispatch indirect : rappel, `bind`                           | ✓                            | ✓           |
| 02 fonction utilitaire, référence de méthode                    | ✗                            | ✓           |
| 03 souscription dans `ngOnInit` (5 relations distinctes)        | ✓                            | ✓           |
| 04 dispatch après validation, plusieurs dispatchs               | ✓                            | ✓           |
| 05 `filter` après `map`, effet → effet, action sans effet       | ✗                            | ✓           |
| 06 prédicat dans une fonction, une méthode, un opérateur maison | ✗                            | ✓           |
| 07 plusieurs effets candidats (type inconnu)                    | ✓                            | ✓           |
| 07 même méthode, type connu                                     | ✗                            | ✓           |
| 08 appels HTTP conditionnels                                    | ✓                            | ✓           |
| 10 valeur inconnue, service absent des sources                  | ✓                            | ✓           |
| 11 cycles (méthodes, effets)                                    | ✓ par hasard (garde non lue) | ✓ démontré  |
| 13 héritage, méthode abstraite, dépendance héritée              | ✗                            | ✓           |
| **Total**                                                       | **10 / 23**                  | **23 / 23** |

## 4. Tests

- `tests/unit/flow-engine.test.ts` : 32 tests sur les 12 thèmes demandés, avec des cas négatifs.
  - Une valeur passée en argument n'est pas un appel.
  - Une action que rien n'accepte n'atteint aucun appel.
  - Un `map` qui réécrit le type ferme le `filter`.
  - `saveDraft` n'atteint jamais l'implémentation d'une autre sous-classe.
  - Un service absent ne crée aucun lien.
- Le thème 9 (contrats Java dans une dépendance Maven) est couvert par la suite existante
  `tests/unit/cartography-maven-contracts.test.ts` (14 tests), qui passe sans changement.
- Aucun test ne démarre une application : le code des exemples est seulement lu.

## 5. Performances (conteneur de développement, 4 cœurs)

| Mesure                                                        | Avant              | Après                          |
| ------------------------------------------------------------- | ------------------ | ------------------------------ |
| Petits cas (41 fichiers) — scan                               | 142 ms             | 130 ms                         |
| Application synthétique, 1 200 modules, 504 562 lignes — scan | 16,7 s             | 14,8 s                         |
| Idem — rescan sans changement (faits réutilisés)              | 6,3 s              | 6,0 s                          |
| Idem — parcours justes                                        | 1 200 / 1 200      | 1 200 / 1 200                  |
| Idem — signature du graphe                                    | `5a072858c555107b` | `5a072858c555107b` (identique) |

Les écarts de temps sont dans le bruit de mesure : pas de régression. La relecture des sous-classes ne
concerne que les fichiers dont une classe de base fournit des membres.

## 6. Ambiguïtés et limites restantes

- **Type inconnu à l'émission** (`JSON.parse`, entrée de gabarit, `$event`) : toutes les suites restent
  candidates PROBABLE, avec le diagnostic qui dit d'où vient la valeur.
- **Type abstrait injecté** : toutes les implémentations lues restent candidates. Les `providers` Angular
  (`useClass`, `useExisting`) ne sont pas lus pour trancher.
- **Garde de pipe** : seules l'égalité, `||` et `includes` sur un champ sont lues. Une négation (`!==`) ou
  un prédicat sur plusieurs champs ne restreint rien.
- **Fonction utilitaire** : un seul niveau. Une fonction qui passe le store à une autre fonction n'est pas
  suivie.
- **Opérateurs personnalisés** : suivis s'ils rendent `filter(…)`, `pipe(…)` ou `source => source.pipe(…)`.
  Les autres rendent la valeur inconnue.
- **NgRx** (`createEffect`, `Store.dispatch` de la bibliothèque) : NON VÉRIFIÉ, aucun cas de test. Seul
  `ofType` avec des littéraux est lu.
- **Cache** : par source entière. Un fichier modifié fait relire toute la source, et le graphe est
  reconstruit à chaque scan. Pas de résumé de fonction persistant entre deux scans.
- **Java** : aucune modification dans ce lot. La résolution polymorphe côté Java reste celle de
  `java-hierarchy.ts` (candidates gardées, confiance `UNKNOWN`).
- **Résolution TypeScript** : syntaxique (imports, alias, types écrits). Un type inféré sans annotation
  n'est pas résolu.
