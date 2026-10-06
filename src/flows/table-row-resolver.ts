import type { Page } from 'playwright';

/**
 * TABLE ROW RESOLVER — « la ligne dont la colonne Business key vaut 2935 », jamais « la 3e ligne ».
 *
 * Un tableau trié, filtré, paginé ou rafraîchi change l'ordre de ses lignes : une position, ou le texte
 * d'un lien répété sur chaque ligne (« Process request »), désigne alors une AUTRE ligne. La ligne est
 * identifiée par ses VALEURS (colonne → valeur) ; la cible est ensuite cherchée DANS cette ligne.
 *
 *  - Colonnes : par leur en-tête (th, columnheader, mat-header-cell ; icônes de tri ignorées), ou `#3`.
 *    Une table Angular Material relie cellule et en-tête par la classe `mat-column-*`, sinon l'index.
 *  - Valeurs : texte exact, casse, accents et espaces ignorés ; `~texte` : contient.
 *  - 0 ligne : les pages suivantes du tableau sont parcourues (bouton « page suivante »), bornées.
 *  - Plusieurs lignes : `unique` → AMBIGUOUS_ROW (rien d'exécuté), `first` / `last` sinon.
 */
export type RowPick = 'unique' | 'first' | 'last';

export type RowScan =
  | { status: 'FOUND'; token: string; matches: number; columns: string[] }
  | { status: 'AMBIGUOUS'; matches: number; samples: string[]; columns: string[] }
  | { status: 'NONE'; rows: number; columns: string[]; missingColumns: string[]; signature: string };

export const ROW_ATTRIBUTE = 'data-qa-crawler-row';

/** Lit les tableaux de la page et marque LA ligne qui correspond (attribut data-qa-crawler-row). */
export async function scanTableRows(
  page: Page,
  criteria: Record<string, string>,
  pick: RowPick,
  token: string,
): Promise<RowScan> {
  return page.evaluate(
    ({ criteria: wanted, pick: mode, token: mark, attribute }) => {
      const normalize = (text: string | null | undefined): string =>
        (text ?? '')
          .normalize('NFD')
          .replace(/[̀-ͯ]/g, '')
          .replace(/\b(arrow_(upward|downward)|unfold_more|sort|expand_(more|less))\b/gi, '')
          .replace(/[↑↓▲▼⇅]/g, '')
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase();
      const compact = (text: string): string => text.replace(/[\s\u00a0]/g, '');
      const shown = (el: Element): boolean => {
        const rect = el.getBoundingClientRect();
        return (rect.width > 0 || rect.height > 0) && getComputedStyle(el).visibility !== 'hidden';
      };
      for (const old of Array.from(document.querySelectorAll(`[${attribute}]`)))
        old.removeAttribute(attribute);
      const CONTAINER = 'table, [role="grid"], [role="table"], [role="treegrid"], mat-table';
      const CELL = 'td, th, [role="cell"], [role="gridcell"], [role="rowheader"], mat-cell';
      const HEADER_CELL = 'th, [role="columnheader"], mat-header-cell';
      const columnClass = (el: Element): string | undefined =>
        Array.from(el.classList).find(
          (name) => name.startsWith('mat-column-') || name.startsWith('cdk-column-'),
        );
      type Column = { label: string; index: number; klass?: string };
      const headersOf = (container: Element): Column[] => {
        const headerRow =
          container.querySelector('thead tr, [role="row"]:has([role="columnheader"]), mat-header-row') ??
          Array.from(container.querySelectorAll('tr')).find(
            (row) => row.querySelector('th') && !row.querySelector('td'),
          );
        if (!headerRow) return [];
        return Array.from(headerRow.querySelectorAll(HEADER_CELL)).map((cell, index) => {
          const klass = columnClass(cell);
          return { label: normalize(cell.textContent), index, ...(klass ? { klass } : {}) };
        });
      };
      const rowsOf = (container: Element): Element[] =>
        Array.from(container.querySelectorAll('tr, [role="row"], mat-row')).filter(
          (row) =>
            row.closest(CONTAINER) === container &&
            row.querySelector('td, [role="cell"], [role="gridcell"], mat-cell') !== null &&
            shown(row),
        );
      const containers = Array.from(document.querySelectorAll(CONTAINER)).filter(
        (container) => !container.parentElement?.closest(CONTAINER) && shown(container),
      );
      const entries = Object.entries(wanted).map(([column, value]) => ({
        column,
        key: normalize(column),
        contains: value.startsWith('~'),
        value: normalize(value.startsWith('~') ? value.slice(1) : value),
      }));
      const allColumns = new Set<string>();
      const missing = new Set<string>(entries.map((entry) => entry.column));
      const matches: Element[] = [];
      let total = 0;
      for (const container of containers) {
        const columns = headersOf(container);
        for (const column of columns) if (column.label) allColumns.add(column.label);
        // Chaque critère → sa colonne : `#n`, sinon l'en-tête égal, puis celui qui commence par / contient.
        const resolved = entries.map((entry) => {
          const index = /^#(\d+)$/.exec(entry.column.trim());
          if (index) return { ...entry, columnRef: { label: entry.key, index: Number(index[1]) - 1 } };
          const exact = columns.find((column) => column.label === entry.key);
          const prefix = columns.find((column) => column.label.startsWith(entry.key));
          const inside = columns.find((column) => column.label.includes(entry.key));
          return { ...entry, columnRef: exact ?? prefix ?? inside };
        });
        for (const entry of resolved) if (entry.columnRef) missing.delete(entry.column);
        if (resolved.some((entry) => !entry.columnRef)) continue;
        for (const row of rowsOf(container)) {
          total += 1;
          const cells = Array.from(row.querySelectorAll(CELL)).filter(
            (cell) => cell.closest('tr, [role="row"], mat-row') === row,
          );
          const ok = resolved.every((entry) => {
            const ref = entry.columnRef as Column;
            const cell =
              (ref.klass
                ? cells.find((candidate) => candidate.classList.contains(ref.klass ?? ''))
                : undefined) ?? cells[ref.index];
            if (!cell) return false;
            const text = normalize(cell.textContent);
            if (entry.contains) return text.includes(entry.value);
            return text === entry.value || compact(text) === compact(entry.value);
          });
          if (ok) matches.push(row);
        }
      }
      const columns = [...allColumns];
      if (matches.length === 0) {
        const signature = Array.from(document.querySelectorAll('tr, [role="row"], mat-row'))
          .filter((row) => row.querySelector('td, [role="cell"], [role="gridcell"], mat-cell') !== null)
          .slice(0, 3)
          .map((row) => normalize(row.textContent).slice(0, 60))
          .join('|');
        return { status: 'NONE' as const, rows: total, columns, missingColumns: [...missing], signature };
      }
      if (matches.length > 1 && mode === 'unique')
        return {
          status: 'AMBIGUOUS' as const,
          matches: matches.length,
          samples: matches.slice(0, 3).map((row) => normalize(row.textContent).slice(0, 80)),
          columns,
        };
      const chosen = mode === 'last' ? matches[matches.length - 1] : matches[0];
      chosen?.setAttribute(attribute, mark);
      return { status: 'FOUND' as const, token: mark, matches: matches.length, columns };
    },
    { criteria, pick, token, attribute: ROW_ATTRIBUTE },
  );
}

/** Les contrôles de pagination d'un tableau (Angular Material, ARIA, libellés FR / EN). */
const NEXT_PAGE =
  '.mat-mdc-paginator-navigation-next, .mat-paginator-navigation-next, [aria-label*="next page" i], [aria-label*="page suivante" i], [aria-label="Next" i], [aria-label="Suivant" i], [title*="page suivante" i], [title*="next page" i], a[rel="next"]';
const FIRST_PAGE =
  '.mat-mdc-paginator-navigation-first, .mat-paginator-navigation-first, [aria-label*="first page" i], [aria-label*="première page" i], [title*="première page" i], [title*="first page" i]';

/** Clique le contrôle de pagination s'il est visible et actif ; false sinon. */
export async function goToPage(page: Page, which: 'next' | 'first'): Promise<boolean> {
  const control = page.locator(which === 'next' ? NEXT_PAGE : FIRST_PAGE).first();
  if ((await control.count()) === 0) return false;
  const usable = await control
    .evaluate(
      (el) =>
        !(el as HTMLButtonElement).disabled &&
        el.getAttribute('aria-disabled') !== 'true' &&
        !el.classList.contains('mat-mdc-button-disabled') &&
        (el.getBoundingClientRect().width > 0 || el.getBoundingClientRect().height > 0),
    )
    .catch(() => false);
  if (!usable) return false;
  await control.click({ timeout: 3000 }).catch(() => undefined);
  return true;
}

/** Attend que les lignes affichées changent (la page suivante est arrivée), borné. */
export async function waitForRowsChange(page: Page, signature: string, timeoutMs: number): Promise<void> {
  await page
    .waitForFunction(
      (before) => {
        const normalize = (text: string | null): string =>
          (text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
        const rows = Array.from(document.querySelectorAll('tr, [role="row"], mat-row')).filter(
          (row) => row.querySelector('td, [role="cell"], [role="gridcell"], mat-cell') !== null,
        );
        const now = rows
          .slice(0, 3)
          .map((row) => normalize(row.textContent).slice(0, 60))
          .join('|');
        return now !== '' && now !== before;
      },
      signature,
      { timeout: timeoutMs, polling: 100 },
    )
    .catch(() => undefined);
}

export function describeRow(criteria: Record<string, string>): string {
  return Object.entries(criteria)
    .map(([column, value]) => `${column}=${value}`)
    .join(', ');
}
