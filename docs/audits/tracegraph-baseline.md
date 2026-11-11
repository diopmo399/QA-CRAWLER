# TraceGraph — audit de référence (avant V2)

Audit du moteur de cartographie tel que fusionné sur `main` (`d0f1e66`), mené en lisant le code et en
le faisant tourner sur des fixtures. Chaque constat ci-dessous est **reproduit** (fixture + mesure) ou
**lu dans le code** ; ce qui n'a pas pu être vérifié est dit comme tel.

## Architecture existante (réutilisée, pas réécrite)

| Étage       | Fichier                          | Rôle                                                                                                                                    |
| ----------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Faits       | `src/cartography/analyze-*.ts`   | AST TypeScript syntaxique (`ts.createSourceFile`, sans TypeChecker), Java lu par l'analyseur statique, gabarits Angular, RxJS/stores    |
| Scan        | `src/cartography/scan.ts`        | `runScan` : faits par source, réutilisés si le hash de la source **et** la version d'analyseur (`ANALYZERS`) sont inchangés             |
| Graphe      | `src/cartography/graph.ts`       | `buildGraph` reconstruit tout le graphe à partir de tous les faits à chaque scan ; `node()` / `edge()` ; id de relation `kind:from->to` |
| Requêtes    | `src/cartography/explorer.ts`    | index, `traceOf` (parcours en largeur borné), structure, conditions                                                                     |
| Natures     | `src/cartography/investigate.ts` | `natureOf` : STRUCTURE / CAUSAL / DATA / CONTROL / CONTRACT / COVERAGE ; `flowOf` : sens du flux                                        |
| Vue         | `src/cartography/feature-map.ts` | « Parcours & Graphe » (`pathOf`)                                                                                                        |
| Persistance | `cartography/` du projet         | fichiers JSON (pas de base de données)                                                                                                  |

## Constats confirmés

| #   | Constat                                         | Où                                                                                                                                                                                               | Preuve                                                                                                                                                                                                                   | Impact                                                                                                                   |
| --- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| 1   | Relations supprimées sans trace                 | `graph.ts`, `edge()`                                                                                                                                                                             | une extrémité absente ou `from === to` → `return` ; seuls les CALLS Java étaient comptés (`unattached`), un appel Java sans cible (`!call.to`) ne l'était pas                                                            | 10 relations perdues sans trace sur 6 fixtures (mesure ci-dessous) ; un parcours s'arrête sans que l'écran dise pourquoi |
| 2   | Deux classes de même nom : la seconde ignorée   | `analyze-rxjs.ts` (`classes.set(info.name)`, avertissement « the first one is kept ») ; `static-analysis/graph-builder.ts` (`if (!classes.has(fact.name))`) ; gabarits et routes indexés par nom | fixture `tracegraph` : `admin/list` et `catalog/list` déclarent `ListComponent` → un seul COMPONENT                                                                                                                      | composant, gabarit et liens de l'autre classe absents ou attribués à la mauvaise                                         |
| 3   | Route avec alias d'import non reliée            | graph-builder : composant de route cherché par nom écrit                                                                                                                                         | `{ path: 'admin', component: AdminList }` (`ListComponent as AdminList`) → aucune relation DISPLAYS, `unattached` vide                                                                                                   | page sans écran, perte silencieuse                                                                                       |
| 4   | Parcours mélangés par la provenance             | `explorer.traceOf`, `feature-map.pathOf`                                                                                                                                                         | ils suivaient toutes les relations dans leur sens d'écriture ; DEPENDS_ON (provenance d'une donnée) descendait donc vers l'amont : l'aval de `OrdersComponent#submit` (VALIDATE) atteignait `OrderApi#list` (LOAD)       | faux lien présenté comme parcours                                                                                        |
| 5   | Installation d'un abonnement absente            | analyse RxJS                                                                                                                                                                                     | `ngOnInit` qui souscrit `state$` / `saved$` : seul le lien flux → rappel existait ; `ngOnInit` ne reliait que `dispatch⟨LOAD⟩`                                                                                           | on ne voit pas qui installe l'écoute ; installation et propagation confondues                                            |
| 6   | Incrémental aveugle aux dépendances externes    | `scan.ts`                                                                                                                                                                                        | réutilisation sur hash de source + analyseur seulement ; un changement de dépôt Maven ou de configuration hors source n'invalide rien ; à la réutilisation, `scan.dependencies` / `unresolvedTypes` ne sont pas reportés | lu dans le code, non reproduit par un test                                                                               |
| 7   | Fusion d'une relation à plusieurs sites d'appel | `graph.ts`, `edge()`                                                                                                                                                                             | le `detail` (condition) du premier site est gardé sauf confiance supérieure ; la preuve du second est ajoutée mais sa condition est perdue                                                                               | lu dans le code                                                                                                          |

### Mesure des pertes silencieuses (constat 1)

`buildGraph` de `main` instrumenté (chaque `return` silencieux de `edge()` et chaque appel Java sans
cible noté), fixtures du dépôt, scan complet :

| Fixture                       | Perdues sans trace | `unattached` affiché | Relations perdues                                                                                                                    |
| ----------------------------- | ------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| tracegraph                    | 3                  | 0                    | DISPLAYS `/admin` → `AdminList`, `/catalog` → `CatalogList` (alias, constats 2 et 3), `/legacy` → `LegacyComponent` (fichier absent) |
| cartography-trace             | 2                  | 0                    | READS `POST /api/v1/commandes` → DTO `Commande`, idem `/validation` (DTO hors des sources)                                           |
| cartography-contract          | 3                  | 0                    | CALLS `DecisionGateway.transmettre` → cible inconnue ; DEPENDS_ON d'un champ vers lui-même ×2                                        |
| cartography-config            | 2                  | 0                    | READS `POST /dossiers` → DTO `String` ; CALLS `ReferentielService.code` → cible inconnue                                             |
| cartography-rxjs, cartography | 0                  | 0                    | —                                                                                                                                    |
| **Total**                     | **10**             | **0**                |                                                                                                                                      |

Une des dix (`READS` d'un `@RequestBody String`) n'était pas une vraie relation : un corps scalaire n'a
pas de DTO. V2 ne la tente plus (`SCALAR_BODY`).

## Non vérifié dans cet audit

- Comportement sur une application de 100 000 à 500 000 lignes : aucune telle application n'est
  disponible dans l'environnement ; aucun chiffre n'est donné.
- Résolution TypeScript par TypeChecker : le moteur n'en utilise pas ; non mesurée.
- Chemin de retour des données Java/BFF (réponse → composant) : non audité en détail.

## Corrections proposées (et suite donnée)

| #    | Proposition                                                     | Suite     |
| ---- | --------------------------------------------------------------- | --------- |
| 1    | Garder toute relation non raccordée avec sa cause et sa preuve  | fait (V2) |
| 2, 3 | Identité de classe par fichier, résolution par imports et alias | fait (V2) |
| 4    | Parcourir dans le sens du flux (`flowOf`)                       | fait (V2) |
| 5    | Relation d'installation d'abonnement distincte                  | fait (V2) |
| 6    | Empreinte des dépendances externes dans la clé de réutilisation | non fait  |
| 7    | Conditions par site d'appel sur une relation fusionnée          | non fait  |
