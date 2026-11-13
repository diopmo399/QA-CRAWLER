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

## 6. Second lot : combler les limites du premier

Même règle que le premier lot : chaque capacité est éprouvée par un cas de code lu par le moteur, avec ce
qu'il doit atteindre et ce qu'il ne doit jamais atteindre. Rien n'est exécuté ; aucune dépendance n'est
ajoutée ni chargée. Version d'analyseur : `cartography-13;rxjs-8`.

### 6.1 Mécanismes ajoutés

| Limite du premier lot                           | Ce que le moteur fait maintenant                                                                                                                                                                                                                                                                                                                                                                                              | Code                                                                                                              | Test                                                |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Aucune mesure de ce qui est perdu               | Chaque scan compte ses liens par confiance, ses relations non raccordées par cause, ses interruptions de chaîne par code (`scan.resolution`), sans rien citer du code                                                                                                                                                                                                                                                         | `scan.ts` `resolutionOf` (L89)                                                                                    | `flow-engine.test.ts` « 0 — the measure of a scan » |
| Imports par alias et fichiers barils non suivis | `paths`, `baseUrl`, `extends` des `tsconfig` de la source ; `export *` et `export { A as B } from` suivis jusqu'à la déclaration ; une classe ou une constante homonyme est celle que l'import désigne                                                                                                                                                                                                                        | `module-resolution.ts` `ModuleResolver` (L99), `class-identity.ts` (L151, L164)                                   | `module-resolution.test.ts` (9), « 14 — imports »   |
| Classe ambiguë dite « introuvable »             | Diagnostic propre `CLASS_AMBIGUOUS` : plusieurs classes de ce nom, aucune choisie                                                                                                                                                                                                                                                                                                                                             | `analyze-rxjs.ts` `callTarget`                                                                                    | « 14 » cas négatif                                  |
| Garde de pipe : ni négation ni conjonction      | `!==`, `!liste.includes`, `!(…)`, `&&` (un terme illisible ne peut que restreindre ; sa négation n'est jamais déduite)                                                                                                                                                                                                                                                                                                        | `analyze-rxjs.ts` `merge` (L4095), `predOf` (L4116)                                                               | « 15 »                                              |
| Valeur inconnue : toutes les suites             | Bornée par son type écrit (union de littéraux, enum, champ discriminant d'une interface) : chaque valeur admise est suivie comme possibilité (PROBABLE), jamais comme preuve ; l'éventail n'est ouvert que s'il écarte un traitement                                                                                                                                                                                          | `shapeOfType` (L3588), `unionVal` (L3566), `channelsOf` (L4482), `callLink` (`given`)                             | « 15 »                                              |
| NgRx non vérifié                                | Store d'actions de la bibliothèque vu comme un store au flux partagé ; `createAction`, `createActionGroup` (import nommé ou par espace de noms) ; `createEffect` + `ofType` ; actions rendues au store (`dispatch: false` respecté) ; `createReducer`/`on` ; sélecteurs reliés au réducteur enregistré sous leur clé (`provideState`, `forFeature`, `createFeature`, `provideStore`) ; `ComponentStore` (`effect`, `updater`) | `actionTypeOf` (L299), `ngrxStateOf` (L187), `reducersOf` (L1207), `effectOf` (L1422), `componentStoreFn` (L1680) | « 16 — NgRx », « 17 — component store »             |
| Signaux reconnus mais non suivis                | Signal écrit (`set`, `update`) = émission ; `computed` suit les signaux lus ; `effect()` rejoué à chaque changement d'un signal lu (de la classe ou d'une dépendance, confirmé par la classe de la dépendance) ; `toObservable`, `toSignal` ; signal lu par un gabarit tenu à jour                                                                                                                                            | `signalKindOf` (L1647), `signalReadsOf` (L1662), `pipelineSource` (L3264)                                         | « 18 — Angular signals »                            |
| `providers` Angular non lus                     | `useClass`, `useExisting`, `useFactory` (classe construite ou injectée) ; `inject(JETON)`, `@Inject(JETON)` ; fournisseur d'un composant valable pour lui et les composants qu'il affiche ; plusieurs fournisseurs différents gardés candidats ; preuve citée (fichier, ligne) ; intercepteurs HTTP listés sur chaque appel                                                                                                   | `providingOf` (L524), `providersFor` (L3175), `providerOf` (L3189), `within` (L3157)                              | « 19 — Angular injection »                          |
| Type inféré non résolu                          | Lecture locale : `x = new X()`, propriété ou accesseur typé, type de retour écrit, `inject(X)` et `injector.get(X)` sur place. Puis second avis du vérificateur de types TypeScript, sur les fichiers de la source seule (AST partagé, mini-bibliothèque de types interne, bornes : 50 000 questions, 20 s) ; il ne répond que par une classe déclarée dans la source                                                         | `soften` (L1399), `receiverOf`, `inferenceOf` (L409), `TYPE_LIB` (L368)                                           | « 20 — receivers found without an injection »       |
| Java : appel polymorphe non tranché             | `@Qualifier` / `@Named` au point d'injection (devant `@Primary`), nom de bean écrit (`@Service("x")`), `@Profile` cité quand il distingue des candidates, qui restent alors toutes gardées                                                                                                                                                                                                                                    | `incident/code/java.ts` (L676–684), `incident/code/resolve.ts` (L291, L339, L355)                                 | `cartography-java-dispatch.test.ts` (12)            |
| 64 contextes par méthode                        | 1 024 (borne globale de 50 000 inchangée) : un store central à 200 types d'action passe de 64 à 200 parcours exacts                                                                                                                                                                                                                                                                                                           | `MAX_CLONES_PER_METHOD` (L4534)                                                                                   | `flow-engine-bounds.test.ts` (2)                    |
| Durées fixes (60 s, 120 s)                      | Elles suivent le nombre de fichiers (10 ms et 40 ms par fichier, jamais moins que la borne) ; une borne donnée par l'appelant est tenue                                                                                                                                                                                                                                                                                       | `files.ts` `readSource`, `analyze-angular.ts`                                                                     | suites existantes                                   |
| Graphe reconstruit à chaque scan                | Repris tel quel quand rien n'a changé (mêmes entrées, chaque source reprise à la même révision) : `scan.graphReused`                                                                                                                                                                                                                                                                                                          | `scan.ts` `inputsOf` (L120), `unchanged` (L348)                                                                   | « 12 — cache and invalidation »                     |

### 6.2 Tests

- `tests/unit/flow-engine.test.ts` : 69 tests (32 au premier lot).
- `tests/unit/module-resolution.test.ts` : 9 ; `tests/unit/flow-engine-bounds.test.ts` : 2 ;
  `tests/unit/cartography-java-dispatch.test.ts` : 12 (10 avant).
- Suite unitaire complète : voir le rapport de la PR (aucun test retiré ni désactivé).
- Une régression rencontrée et corrigée : un signal local lu par un gabarit perdait ses écrivains une fois
  vu aussi comme un flux (`cartography-trace.test.ts`, cas 18) ; les deux lectures sont gardées
  (`analyze-angular.ts`).

### 6.3 Mesures (même conteneur, 4 cœurs)

Application synthétique de 1 200 modules, 504 562 lignes, 8 644 fichiers :

| Mesure                       | Avant ce lot (`e0d45d8`) | Après                          |
| ---------------------------- | ------------------------ | ------------------------------ |
| Parcours justes              | 1 200 / 1 200            | 1 200 / 1 200                  |
| Signature du graphe          | `5a072858c555107b`       | `5a072858c555107b` (identique) |
| Scan complet                 | 15,4 s                   | 13,4 s                         |
| Nouveau scan sans changement | 6,0 s                    | 1,7 s (graphe repris)          |
| Mémoire maximale (RSS)       | 1 161 Mo                 | 1 416 Mo (+22 %)               |

- Le temps d'un scan se répartit ainsi (mesuré) : lecture 1,5 s, graphe statique 3,1 s, analyse RxJS 6,3 s
  (dont environ 2,8 s pour créer le programme du vérificateur de types), gabarits 0,2 s, graphe 4,4 s.
- Le vérificateur de types coûte la mémoire ajoutée ; son temps est compensé par l'AST partagé entre les
  passes. Sur cette application synthétique il répond à 0 question sur 240 : elle n'a rien d'inféré.
- Petite fixture (une centaine de fichiers) : 68 ms avant, 97 ms après (médiane de 5 scans).
- Store central : 200 types d'action, 200 parcours exacts en 0,2 s ; 1 000 types, 1 000 exacts en 1,2 s.
- Mesure de la fixture : 447 liens, 359 confirmés, 87 probables, 1 inconnu ; 7 questions au vérificateur
  de types, 5 réponses.

## 7. Ambiguïtés et limites restantes

- **Aucune application réelle n'a été mesurée.** La grande application est synthétique (cinq styles
  répétés) : elle prouve la tenue en volume, pas la tenue face à du code irrégulier. `scan.resolution`
  est fait pour mesurer cela sur un vrai dépôt.
- **Valeur qui n'existe qu'à l'exécution** (`JSON.parse`, réponse serveur, `$event`, configuration
  distante) : toutes les suites restent candidates PROBABLE, bornées par le type écrit s'il y en a un.
- **Type écrit** : une valeur déduite d'un type n'est jamais CONFIRMED (un `as` peut le contredire). Au-delà
  de 12 valeurs admises, le type n'aide plus et la valeur reste inconnue. Un seul chemin décisif à la fois
  est ouvert en éventail (pas de produit de plusieurs paramètres).
- **NgRx** : effets fonctionnels (`createEffect` hors classe), actions écrites en classes, `signalStore`,
  méta-réducteurs et `router-store` ne sont pas lus. Un réducteur nommé `reducer` importé sous un autre nom
  n'est pas relié à ses sélecteurs. Deux créateurs de même nom ne sont départagés que par leur import.
- **Signaux** : la lecture d'un signal d'une dépendance dans un gabarit n'est reconnue que sous la forme
  `dép.signal()` ; `untracked` et les effets créés dans une fonction utilitaire ne sont pas lus.
- **Injection** : `useValue`, les fabriques à plusieurs retours, les fournisseurs de routes (`providers` d'une
  route) et `providedIn` d'un module ne tranchent rien. Les intercepteurs sont listés sur les appels, pas
  reliés un à un ; un intercepteur fonctionnel n'a pas ses propres appels suivis.
- **Vérificateur de types** : il ne voit pas les bibliothèques (un type venu d'une bibliothèque reste
  inconnu), ne tranche pas une union de classes, et n'est interrogé que pour le récepteur d'un appel dans
  une méthode (pas dans la définition d'un flux).
- **Gardes de pipe** : comparaison d'un champ à des valeurs connues seulement ; un prédicat sur deux champs
  ne restreint que par le premier lu.
- **Fonction utilitaire** : un seul niveau.
- **Java** : `@ConditionalOnProperty`, les beans déclarés par méthode `@Bean` et les qualificateurs
  personnalisés ne sont pas lus ; le profil actif n'est jamais supposé.
- **Cache** : toujours par source entière. Un seul fichier modifié fait relire sa source (environ 13 s pour
  500 000 lignes). Un cache par fichier demanderait de garder en mémoire des structures que l'analyse
  modifie ; non fait.
- **Parallélisme** : non fait. Les arbres syntaxiques ne passent pas d'un fil d'exécution à un autre, et
  les deux phases qui pèsent (analyse du frontal, construction du graphe) sont séquentielles par nature ici.
- **Mémoire** : tout est en mémoire (1,4 Go pour 500 000 lignes) ; rien n'est fait pour un dépôt qui la
  dépasserait.
