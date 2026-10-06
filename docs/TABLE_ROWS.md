# Table rows: the same row, whatever the order

In a table, every row often carries the **same** action ("Process request", "Edit", "+"). A recorded
position ("the 3rd row") or the action text alone designates **another row** as soon as the table is
sorted, filtered, refreshed or paginated differently.

A row is designated by its **values**, never by its position:

```yaml
- click: { text: Process request, row: { 'Business key': '2935' } } # this exact row
- click: { text: Process request, row: { Status: NEW, 'Legal name': '~tech' } } # several columns, ~ = contains
- click: { text: Process request, row: { Status: NEW }, rowPick: first } # any matching row
```

- **Columns** by their header (sort icons ignored; exact, then prefix, then contains), or `#3` for
  the 3rd column. Angular Material tables are read through `mat-column-*` classes, otherwise by index.
  HTML tables, ARIA grids (`role=row/cell/columnheader`) and `mat-table` are supported.
- **Values**: exact text, case, accents and spaces ignored; `~text` means "contains".
- **Pagination**: when the row is not on the current page, the table goes back to its first page,
  then page after page ("Next page" / "Page suivante", Material paginator), at most 20 pages.
- **Several rows match**: `rowPick: unique` (default) fails with `AMBIGUOUS_ROW` and nothing is
  clicked; `first` / `last` pick explicitly.
- **No row / unknown column**: `ROW_NOT_FOUND`, with the table's columns or the number of rows read.
- With `row`, no fingerprint healing can replace the target with the element of another row.

## Recording

When the human clicks inside a table row, the recorder finds the row's **key column**: the column
whose values are unique among the visible rows, preferring identifiers (`ID`, `Key`, `Code`, `No`,
`#`…) over names and never a date; the clicked column itself is excluded. If no single column is
unique, the first unique pair of columns is used. The generated flow carries
`row: { <column>: <value> }` instead of a position (`TABLE_ROW` in the target reasons).

To process "a task in this state" rather than "this task", replace the key by criteria in the
generated flow (`row: { Status: NEW }, rowPick: first`).

## Micro-frontends : shadow DOM et iframes

Un shell de micro-frontends monte souvent l'application dans le **shadow root** d'un web component (Angular Elements, module federation), ou dans une **iframe**.

**Avant :** les clics Playwright traversaient ces frontières, mais la lecture du tableau ne lisait que le `document`. Résultat : `ROW_NOT_FOUND: no table column "…" (columns: none)` alors que le tableau était bien à l'écran.

**Maintenant**, la lecture couvre :

- le document ;
- tous les **shadow roots ouverts**, récursivement ;
- tous les **cadres** de la page.

La ligne trouvée est cherchée et cliquée **dans son cadre**, et la pagination se fait dans le cadre qui porte le tableau. Une ligne présente dans plusieurs cadres compte comme plusieurs lignes : avec `rowPick: unique`, c'est `AMBIGUOUS_ROW`.

**Message quand aucun tableau n'est visible :** `ROW_NOT_FOUND: no table on the screen (document, shadow roots and frames read) — the table never appeared within N ms`. Il remplace le trompeur « columns: none ».

**Les sondes ne paginent jamais.** Pendant qu'une étape attend sa transition, le crawler vérifie si la cible de l'étape suivante est prête. Cette vérification ne lit que la page affichée et ne clique jamais « page suivante ». Seule l'exécution de l'étape parcourt les pages du tableau.
