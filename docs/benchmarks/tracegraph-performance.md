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
