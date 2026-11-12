# Réconciliation des liens

Règle : **une relation lue dans le code n'est jamais supprimée sans trace.** Si elle ne peut pas être
raccordée au graphe, elle est gardée comme lien non résolu, avec sa cause et l'endroit où le code
l'écrit. Elle n'entre dans aucun parcours.

## Modèle

```ts
type UnresolvedCause = 'SOURCE_MISSING' | 'TARGET_MISSING' | 'BOTH_MISSING' | 'TARGET_UNKNOWN' | 'SELF';

interface MapUnresolvedLink {
  id: string; // `${kind}:${from}->${to}`, comme une relation
  kind: MapEdgeKind;
  from: string;
  to: string; // '?' quand le résolveur n'a trouvé aucune cible
  state: 'UNRESOLVED';
  cause: UnresolvedCause;
  reason: string;
  evidence: Evidence[]; // toutes les lectures de cette relation
}
```

| Cause          | Quand                                                                                  |
| -------------- | -------------------------------------------------------------------------------------- |
| TARGET_MISSING | l'origine est dans le graphe, la cible non (ex. composant importé d'un fichier absent) |
| SOURCE_MISSING | l'inverse                                                                              |
| BOTH_MISSING   | aucune des deux extrémités                                                             |
| TARGET_UNKNOWN | appel Java dont le résolveur n'a trouvé aucune cible                                   |
| SELF           | relation d'un élément vers lui-même (non tracée)                                       |

`buildGraph` dédoublonne par id, fusionne les preuves, incrémente `scan.unattached[kind]` et garde au
plus `MAX_UNRESOLVED_LINKS` (5 000) entrées ; au-delà, elles sont seulement comptées (`uncounted`).

## États et preuves

Le prompt demandait des états RESOLVED / AMBIGUOUS / UNRESOLVED / INVALIDATED. V2 ne crée pas un
second vocabulaire : il rattache ces états à ceux qui existent déjà.

| État demandé              | Représentation existante                                                                                                                                  |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RESOLVED, preuve statique | relation du graphe, confiance CONFIRMED, preuve STATIC_CODE                                                                                               |
| RESOLVED, probable        | relation du graphe, confiance PROBABLE                                                                                                                    |
| AMBIGUOUS                 | corrélation à plusieurs candidats (cause AMBIGUOUS de la corrélation d'API) ; référence de classe ambiguë laissée non résolue par `ClassIdentity.resolve` |
| UNRESOLVED                | `MapUnresolvedLink`                                                                                                                                       |
| INVALIDATED               | non représenté (aucun mécanisme d'invalidation d'une relation après coup)                                                                                 |

## Consultation

- `unresolvedOf(index, { type, status, q, page, size })` : sélection par type de relation (`type`),
  par cause (`status`), recherche texte ; renvoie `byCause`, `byKind`, `uncounted`.
- `GET /cartography/unresolved` (sous `/projects/:id`), `client.cartography.unresolved(projectId, query)`.
- Dashboard, Cartographie → « Liens non résolus » : relation, origine, cible, cause et raison, preuve
  (fichier:ligne), pagination.

## Vérifié par

`tests/unit/tracegraph-v2.test.ts` : la route `/legacy` (composant importé d'un fichier absent) donne
un DISPLAYS `TARGET_MISSING` avec la preuve `src/app/app.routes.ts:12`, comptée dans `unattached` ;
la sélection et le rendu de l'onglet (échappement compris) sont testés.
