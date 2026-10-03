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

/**
 * Les listes de colonnes (disponibles → sélectionnées) : `dnd=pointer` (glisser maison par
 * événements pointeur), `dnd=html5` (draggable natif), `dnd=broken` (le glisser ne déplace rien),
 * `dnd=recreate` (glisser pointeur, puis l'application recrée tous les éléments des listes).
 */
const lists = (dnd: string): string => `
  <div aria-labelledby="av"><h3 id="av">Available columns</h3>
    <ul id="available"><li${dnd === 'html5' ? ' draggable="true"' : ''} id="col-status">Status</li><li${dnd === 'html5' ? ' draggable="true"' : ''} id="col-owner">Owner</li></ul></div>
  <div aria-labelledby="se"><h3 id="se">Selected columns</h3>
    <ul id="selected" style="min-height:40px"><li${dnd === 'html5' ? ' draggable="true"' : ''} id="col-name">Name</li></ul></div>`;

const dragScript = (dnd: string): string =>
  dnd === 'html5'
    ? `for (const li of document.querySelectorAll('li[draggable]')) li.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', li.id));
  for (const ul of document.querySelectorAll('ul')) {
    ul.addEventListener('dragover', (e) => e.preventDefault());
    ul.addEventListener('drop', (e) => { e.preventDefault(); const li = document.getElementById(e.dataTransfer.getData('text/plain')); if (li) ul.appendChild(li); });
  }`
    : `let dragged = null;
  document.addEventListener('pointerdown', (e) => { const li = e.target.closest && e.target.closest('li'); if (li) dragged = li; });
  document.addEventListener('pointerup', (e) => {
    if (!dragged) return;
    const ul = document.elementFromPoint(e.clientX, e.clientY)?.closest('ul');
    ${dnd === 'broken' ? '' : 'if (ul && ul !== dragged.parentElement) ul.appendChild(dragged);'}
    ${dnd === 'recreate' ? "for (const list of document.querySelectorAll('ul')) list.innerHTML = list.innerHTML;" : ''}
    dragged = null;
  });`;

const page = (layout: string, dnd: string): string => {
  const columnsSearch =
    layout === 'noColumnsSearch'
      ? ''
      : layout === 'twin'
        ? '<label>Search <input id="columnsSearch"></label><label>Search <input id="columnsSearch2"></label>'
        : '<label>Search <input id="columnsSearch"></label>';
  const columns = `<section aria-labelledby="c"><h2 id="c">Columns</h2>${columnsSearch}${lists(dnd)}</section>`;
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
      'priority=' + value('priority') + ' columns=' + value('columnsSearch') + ' filters=' + value('filtersSearch') +
      ' selected=' + Array.from(document.querySelectorAll('#selected li')).map((li) => li.textContent).join(',');
  });
  ${dragScript(dnd)}
</script></body></html>`;
};

export async function startSettingsApp(): Promise<SettingsApp> {
  const server: Server = createServer((request, response) => {
    const params = new URL(request.url ?? '/', 'http://x').searchParams;
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(page(params.get('layout') ?? 'default', params.get('dnd') ?? 'pointer'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}
