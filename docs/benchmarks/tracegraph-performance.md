# TraceGraph — mesures avant / après V2

Seuls des chiffres mesurés figurent ici. Machine : conteneur de développement (4 cœurs, Node.js 22),
scan complet non incrémental, **médiane de 5 scans** par fixture ; « avant » = `main` (`d0f1e66`),
« après » = branche `feat/tracegraph-v2`, mêmes fixtures (la fixture `tracegraph` a été copiée dans
l'arbre de `main` pour la mesure). Traces : `traceOf(…, { direction: 'DOWN' })` lancé depuis chaque
METHOD et chaque BUTTON du graphe.

## Taille du graphe, liens non résolus, temps

| Fixture              | Nœuds avant → après | Relations avant → après | Non résolus gardés (après) | Scan médian avant → après (ms) |
| -------------------- | ------------------- | ----------------------- | -------------------------- | ------------------------------ |
| tracegraph           | 42 → 46             | 40 → 49                 | 1                          | 21 → 25                        |
| cartography-trace    | 69 → 69             | 75 → 75                 | 2                          | 24 → 28                        |
| cartography-rxjs     | 78 → 78             | 85 → 86                 | 0                          | 33 → 32                        |
| cartography-contract | 74 → 74             | 67 → 67                 | 3                          | 33 → 33                        |
| cartography-config   | 25 → 25             | 15 → 15                 | 1                          | 25 → 24                        |
| cartography          | 137 → 137           | 117 → 117               | 0                          | 32 → 36                        |

Avant V2, `unattached` valait 0 sur les six fixtures alors que 10 relations étaient perdues (mesure
instrumentée, voir `docs/audits/tracegraph-baseline.md`). Après : 7 sont gardées comme non résolues avec
leur cause et leur preuve, 2 sont **résolues** (DISPLAYS `/admin` et `/catalog` : homonymes et alias),
1 n'est plus tentée (corps `@RequestBody String`, sans DTO). Sur `tracegraph`, le graphe gagne 9
relations, dont ces 2 DISPLAYS et les 2 installations d'abonnement de `ngOnInit` détaillées plus bas ;
le détail des 5 autres n'a pas été relevé.

Les écarts de temps (quelques ms, dans les deux sens) sont de l'ordre du bruit de mesure à cette échelle.

## Traces

| Fixture              | Traces  | Nœuds moyens par trace avant → après | Temps total des traces avant → après (ms) |
| -------------------- | ------- | ------------------------------------ | ----------------------------------------- |
| tracegraph           | 25 → 28 | 4,5 → 5,3                            | 1 → 2                                     |
| cartography-trace    | 36      | 5,1 → 6,6                            | 1 → 1                                     |
| cartography-rxjs     | 48      | 6,3 → 7,8                            | 2 → 2                                     |
| cartography-contract | 39      | 4,8 → 3,7                            | 1 → 1                                     |
| cartography-config   | 15      | 2,0 → 2,0                            | 0 → 0                                     |
| cartography          | 62      | 5,2 → 5,2                            | 1 → 2                                     |

Une trace orientée par le flux peut grandir (une condition atteinte par contrôle est désormais en aval
de la donnée qui la commande) ou rétrécir (la provenance remonte au lieu de descendre).

## Faux liens (fixture `tracegraph`)

| Point d'entrée                      | Avant                               | Après                                                          |
| ----------------------------------- | ----------------------------------- | -------------------------------------------------------------- |
| `OrdersComponent#submit` (VALIDATE) | atteint `OrderApi#list`             | n'atteint ni `OrderApi#list` ni `OrderStore#load`              |
| `OrdersComponent#reload` (LOAD)     | n'atteint ni `create` ni `validate` | idem                                                           |
| Composants                          | 2 (`ListComponent` ×1)              | 3 (`ListComponent(admin/list)`, `ListComponent(catalog/list)`) |
| Relations sortantes de `ngOnInit`   | `CALLS dispatch⟨LOAD⟩`              | `CALLS dispatch⟨LOAD⟩`, `READS state$`, `READS saved$`         |

## Non mesuré

- Applications de 100 000 à 500 000 lignes : aucune n'est disponible ici ; aucun chiffre n'est extrapolé.
- Scan incrémental (réutilisation) : correction vérifiée par test (même signature de graphe), durée non
  mesurée.
- Mémoire.

## Application synthétique de grande taille (RxJS mélangés)

Générateur : `tests/large-angular-app.ts`. Chaque module a son API HTTP, son store, son composant, son
gabarit, ses fonctions utilitaires et un fichier de test. Cinq styles RxJS sont mélangés en rotation :

| Style | Construction                                                                                            |
| ----- | ------------------------------------------------------------------------------------------------------- |
| A     | `dispatch` avec `switch`, Subject + `filter` + `switchMap`                                              |
| B     | `debounceTime` / `exhaustMap`, `combineLatest` avec un état partagé entre tous les modules, `takeUntil` |
| C     | créateurs d'actions, un Subject, deux pipes filtrés par type (`filter` en ligne)                        |
| D     | façade + store, souscriptions dans le constructeur, `withLatestFrom` + `concatMap`, pipe `async`        |
| E     | comme C, avec un `ofType` utilitaire                                                                    |

Pièges inclus :

- Les composants A, B et C s'appellent tous `ListComponent` et les routes les importent sous un alias.
- Une route sur 50 importe un composant d'un fichier absent.

**Vérité attendue.** Pour chaque module, `submit` et `reload` doivent atteindre leurs propres appels
HTTP. Ils ne doivent jamais atteindre l'appel de l'autre action, ni l'API d'un autre module. Chaque route
doit afficher son composant. Chaque rupture injectée doit être gardée comme lien non résolue.

**Conditions de mesure.**

- Machine : conteneur de développement, 4 cœurs, Node.js 22.
- Scan complet ; traces `DOWN` depuis chaque `submit` et chaque `reload`.
- « Pic mémoire » : celui du programme de mesure, qui fait deux scans et sérialise le modèle. Ce n'est pas
  la mémoire d'un scan seul.

### Fiabilité avant / après les corrections de cette série (1 200 modules, 504 562 lignes)

| Mesure                                                      | Avant                               | Après                            |
| ----------------------------------------------------------- | ----------------------------------- | -------------------------------- |
| Parcours justes (limites de lecture par défaut)             | 355 / 1 200                         | 1 200 / 1 200                    |
| Parcours justes (limite de fichiers relevée)                | 401 / 1 200                         | 1 200 / 1 200                    |
| Fichiers lus (limite par défaut)                            | 4 000 / 8 644 (source PARTIAL, dit) | 8 644 / 8 644                    |
| Faux liens `submit → list` (styles A, C, E, limite relevée) | 591                                 | 0                                |
| Nœuds COMPONENT (limite relevée)                            | 704 / 1 200                         | 1 200 / 1 200                    |
| Liens non résolus (limite relevée)                          | 3 868                               | 24 (= les 24 ruptures injectées) |

Causes trouvées et corrigées :

1. **Contextes d'appel.**
   - Avant : au plus 300 contextes pour toute l'application, et les branches n'étaient plus distinguées au-delà.
   - Après : 64 contextes par méthode, 50 000 en tout.
   - La limite atteinte est dite, et rend la source PARTIAL.
2. **Budget de syntaxe.**
   - Avant : fixé à 2 millions de nœuds AST et épuisé vers 60 % de l'application. L'avertissement restait dans
     la liste d'erreurs de la source, qui restait marquée « SCANNED ».
   - Après : le budget suit le volume lu, et un budget épuisé rend la source PARTIAL.
3. **Masquage des secrets.**
   - Avant : tout mot de 24 caractères ou plus mêlant lettres et chiffres était masqué.
     `Contract125PageComponent` devenait `[REDACTED]` et le composant disparaissait.
   - Après : un nom du code (mots en casse chameau) est gardé ; un jeton reste masqué (tests à l'appui).
4. **Flux d'actions partagé.**
   - Avant : une émission atteignait tous les pipes du Subject, quelle que soit leur garde de type.
   - Après : un canal par type émis connu (`actions⟨type='SAVE'⟩`), qui ne mène qu'aux pipes qui l'acceptent.
5. **Conjonctions.** `if (a.type === 'VALIDATE' && …)` est décomposée en termes, pour que le contexte
   d'action soit suivi.
6. **Limite de lecture.** Elle passe de 4 000 à 20 000 fichiers par source.

### Temps et volume (après corrections)

| Modules | Lignes  | Fichiers | Scan   | Rescan (faits réutilisés) | Index  | Trace (moy.) | Pic mémoire | Modèle JSON | Parcours justes |
| ------- | ------- | -------- | ------ | ------------------------- | ------ | ------------ | ----------- | ----------- | --------------- |
| 1 200   | 504 562 | 8 644    | 16,7 s | 6,3 s                     | 74 ms  | 0,43 ms      | 1 153 Mo    | 93,6 Mo     | 1 200 / 1 200   |
| 2 000   | 840 914 | 14 404   | 36,8 s | 23,7 s                    | 124 ms | 0,73 ms      | 2 020 Mo    | 177,9 Mo    | 2 000 / 2 000   |

- **Coût quadratique supprimé.**
  - Avant : la construction des concepts de champs et des homonymes parcourait toutes les relations pour
    chaque champ. Le scan prenait 35,4 s / 33,8 s à 1 200 modules (deux exécutions) et 98,9 s à 2 000.
  - Après : un index des relations par origine et des homonymes par nom. Le graphe produit est identique :
    même signature `5a072858c555107b` à 1 200 modules, avant et après.
- **Répétabilité.** Deux scans de la même application donnent la même signature du graphe.
- **Troncature.**
  - Les traces du style B dépassent les 120 nœuds par défaut de `traceOf` : l'état partagé
    `SessionStore.user$` mène à tous les modules B, ce qui est une diffusion réelle à l'exécution.
  - Elles sont marquées tronquées, et restent justes (appels propres atteints, aucun appel d'un autre module).
- **Limites mesurées, non traitées.**
  - Le modèle sérialisé croît d'environ 78 Ko par module (nœuds, relations et leurs preuves).
  - Le rescan d'une source inchangée reconstruit tout le graphe.
  - L'application est synthétique : elle couvre les constructions ci-dessus, pas toutes celles d'une
    application réelle.
