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
