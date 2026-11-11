# TraceGraph Engine V2

V2 corrige le moteur de cartographie existant sans le réécrire : mêmes faits, même `buildGraph`, même
index, même persistance JSON. Les changements portent sur ce que le graphe **garde**, sur l'**identité**
des classes et sur le **sens** dans lequel les parcours sont lus. Aucun LLM, aucune exécution
d'application, aucun navigateur : tout est déterministe et reproductible (même entrée → même graphe,
test « déterminisme » de `tests/unit/tracegraph-v2.test.ts`).

## Trois graphes logiques sur un seul modèle

Le prompt demandait trois graphes. Ils ne sont pas trois structures stockées : ce sont trois lectures
du même `CartographyModel`, séparées par la nature de chaque relation (`investigate.natureOf`).

| Graphe logique                                            | Natures                                   | Lu par                                     |
| --------------------------------------------------------- | ----------------------------------------- | ------------------------------------------ |
| Structurel (ce qui contient / déclare quoi)               | STRUCTURE, CONTRACT                       | onglet Structure, cartes de la feature map |
| Causal et données (ce qui déclenche, ce qui alimente)     | CAUSAL, DATA, CONTROL                     | `traceOf`, `pathOf`, investigation         |
| Trace contextuelle (un parcours depuis un point d'entrée) | sous-ensemble causal orienté par `flowOf` | « Parcours & Graphe », traçabilité         |

Une relation structurelle n'est jamais présentée comme une cause : `natureOf` classe par exemple le
CALLS d'un COMPONENT vers une méthode liée par son gabarit en STRUCTURE (composition), pas en CAUSAL.

## Changements

1. **Conservation des liens** — `graph.ts` : toute relation lue mais non raccordée devient un
   `MapUnresolvedLink` (cause, raison, preuves) dans `model.unresolved`, comptée dans
   `scan.unattached`. Voir `link-reconciliation.md`.
2. **Identité des classes** — `src/static-analysis/class-identity.ts` : une classe par (fichier, nom) ;
   deux homonymes deviennent `ListComponent(admin/list)` et `ListComponent(catalog/list)`. Les
   références (types injectés, classe de base, composant de route, types de champ du gabarit) sont
   résolues par les imports du fichier, alias compris ; une référence ambiguë reste non résolue. Une
   seule instance est partagée par l'analyse statique, RxJS et les gabarits (`analyze-angular.ts`).
3. **Sens du flux** — `explorer.traceOf` et `feature-map.pathOf` orientent chaque relation par
   `flowOf(edge, natureOf(edge))` : la provenance d'une donnée (DEPENDS_ON de nature DATA) et le
   contrôle (CONTROL) remontent au lieu de descendre.
4. **Installation d'abonnement** — nouvelle relation de fait `SUBSCRIBES` (méthode → flux), rendue
   comme `READS` avec la raison « installe un abonnement » et le détail asynchrone « installation de
   l'abonnement (une fois) ». Voir `reactive-causality-resolver.md`.
5. **API et Dashboard** — `GET /cartography/unresolved` (sous `/projects/:id`), `client.cartography.unresolved`,
   onglet « Liens non résolus ».
6. **Version d'analyseur** — `ANALYZERS = cartography-11;rxjs-5` : les faits d'un scan antérieur ne
   sont pas réutilisés (test « faits cartography-10 re-scannés »).

## Ce que V2 ne fait pas

- Pas de TypeChecker TypeScript : la résolution reste syntaxique (imports, alias, noms uniques).
- Pas d'évaluation abstraite VRAI / FAUX / INCONNU des conditions RxJS selon le contexte.
- Pas de vérification ciblée exécutée (conception seulement : `targeted-verification.md`).
- Pas de budgets FAST / BALANCED / DEEP propres au scan.
- Pas de persistance du graphe en base : il reste en JSON.
- Pas d'invalidation incrémentale par les dépendances Maven ou la configuration.
