import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Un écran de paramètres d'un rapport : trois sections (General, Columns, Filters), deux champs
 * « Search » identiques (même balise, même libellé) dans Columns et dans Filters, un champ
 * « Priority » sans libellé relié. Variantes : `noColumnsSearch` (le champ de Columns a disparu),
 * `twin` (deux « Search » dans Columns), `swap` (Filters affiché avant Columns).
 */
export interface SettingsApp {
  url: string;
  close(): Promise<void>;
}

const page = (layout: string): string => {
  const columnsSearch =
    layout === 'noColumnsSearch'
      ? ''
      : layout === 'twin'
        ? '<label>Search <input id="columnsSearch"></label><label>Search <input id="columnsSearch2"></label>'
        : '<label>Search <input id="columnsSearch"></label>';
  const columns = `<section aria-labelledby="c"><h2 id="c">Columns</h2>${columnsSearch}</section>`;
  const filters =
    '<section aria-labelledby="f"><h2 id="f">Filters</h2><label>Search <input id="filtersSearch"></label></section>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Report settings</title></head><body><main>
<h1>Report settings</h1>
<section aria-labelledby="g"><h2 id="g">General</h2>
  <div class="row"><span>Priority</span><input id="priority"></div>
</section>
${layout === 'swap' ? filters + columns : columns + filters}
<button type="button" id="save">Save</button>
<p id="out"></p>
</main><script>
  const value = (id) => (document.getElementById(id) || { value: '' }).value;
  document.getElementById('save').addEventListener('click', () => {
    document.getElementById('out').textContent =
      'priority=' + value('priority') + ' columns=' + value('columnsSearch') + ' filters=' + value('filtersSearch');
  });
</script></body></html>`;
};

export async function startSettingsApp(): Promise<SettingsApp> {
  const server: Server = createServer((request, response) => {
    const layout = new URL(request.url ?? '/', 'http://x').searchParams.get('layout') ?? 'default';
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(page(layout));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
