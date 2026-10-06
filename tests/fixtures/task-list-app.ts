import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * « Task list » : chaque ligne porte le MÊME lien « Process request » ; ce qui distingue les lignes est
 * dans les autres colonnes (Business key unique, Status, Legal name…). L'ordre change (tri, nouveaux
 * éléments en tête), le tableau est paginé (5 lignes par page, boutons « First page » / « Next page »).
 *
 * Paramètres : `order=desc` (tri inverse), `fresh=1` (deux éléments récents en tête),
 * `material=1` (grille ARIA / Angular Material : mat-row, mat-cell, classes mat-column-*).
 * Un clic sur « Process request » ouvre /task/<business key>.
 */
export interface TaskListApp {
  url: string;
  close(): Promise<void>;
}

interface Task {
  key: string;
  status: string;
  legalName: string;
  start: string;
}

const TASKS: Task[] = [
  { key: '1615', status: 'IN_PROGRESS', legalName: 'North Bakery', start: '2025-12-22 / 08:50' },
  { key: '1616', status: 'IN_PROGRESS', legalName: 'Blue Paints', start: '2025-12-22 / 09:49' },
  { key: '2074', status: 'IN_PROGRESS', legalName: 'Falls Corp', start: '2026-01-22 / 14:38' },
  { key: '2929', status: 'IN_PROGRESS', legalName: 'Tech One', start: '2026-10-01 / 17:29' },
  { key: '2930', status: 'IN_PROGRESS', legalName: 'The Best Co', start: '2026-10-01 / 19:38' },
  { key: '2931', status: 'IN_PROGRESS', legalName: 'Hill Partners', start: '2026-10-01 / 19:41' },
  { key: '2934', status: 'NEW', legalName: 'Crawler Inc', start: '2026-10-04 / 00:43' },
  { key: '2935', status: 'NEW', legalName: 'IMC Ltd', start: '2026-10-04 / 12:01' },
  { key: '2936', status: 'NEW', legalName: 'Tech One', start: '2026-10-04 / 13:38' },
];
const FRESH: Task[] = [
  { key: '3001', status: 'NEW', legalName: 'Fresh Start', start: '2026-10-06 / 07:00' },
  { key: '3002', status: 'NEW', legalName: 'Early Bird', start: '2026-10-06 / 07:10' },
];

const page = (params: URLSearchParams): string => {
  let tasks = [...(params.get('fresh') === '1' ? FRESH : []), ...TASKS];
  if (params.get('order') === 'desc') tasks = tasks.reverse();
  const material = params.get('material') === '1';
  const data = JSON.stringify(tasks);
  return `<!doctype html><html><head><title>Task list</title></head><body><main>
<h1>Task list</h1>
<div id="grid"></div>
<div class="paginator">
  <button type="button" aria-label="First page" id="first">|&lt;</button>
  <button type="button" aria-label="Previous page" id="prev">&lt;</button>
  <span id="label"></span>
  <button type="button" aria-label="Next page" id="next">&gt;</button>
</div>
</main><script>
  const tasks = ${data};
  const material = ${String(material)};
  const size = 5;
  let current = 0;
  const columns = ['Task name', 'Process', 'Status', 'Legal name', 'Start date', 'Business key'];
  const classes = ['taskName', 'process', 'status', 'legalName', 'start', 'businessKey'];
  const cells = (task) => [
    '<a href="/task/' + task.key + '">Process request</a>',
    'Request processing',
    task.status,
    task.legalName,
    task.start,
    task.key,
  ];
  function render() {
    const rows = tasks.slice(current * size, current * size + size);
    const pages = Math.ceil(tasks.length / size);
    if (material) {
      document.getElementById('grid').innerHTML =
        '<mat-table role="table">' +
        '<mat-header-row role="row">' + columns.map((c, i) => '<mat-header-cell role="columnheader" class="mat-column-' + classes[i] + '">' + c + (i === 5 ? ' <span class="sort">↑</span>' : '') + '</mat-header-cell>').join('') + '</mat-header-row>' +
        rows.map((t) => '<mat-row role="row">' + cells(t).map((v, i) => '<mat-cell role="cell" class="mat-column-' + classes[i] + '">' + v + '</mat-cell>').join('') + '</mat-row>').join('') +
        '</mat-table>';
    } else {
      document.getElementById('grid').innerHTML =
        '<table><thead><tr>' + columns.map((c) => '<th>' + c + '</th>').join('') + '</tr></thead><tbody>' +
        rows.map((t) => '<tr>' + cells(t).map((v) => '<td>' + v + '</td>').join('') + '</tr>').join('') +
        '</tbody></table>';
    }
    document.getElementById('label').textContent = 'Page ' + (current + 1) + ' of ' + pages;
    document.getElementById('first').disabled = current === 0;
    document.getElementById('prev').disabled = current === 0;
    document.getElementById('next').disabled = current >= pages - 1;
  }
  document.getElementById('first').onclick = () => { current = 0; setTimeout(render, 150); };
  document.getElementById('prev').onclick = () => { current = Math.max(0, current - 1); setTimeout(render, 150); };
  document.getElementById('next').onclick = () => { current += 1; setTimeout(render, 150); };
  // La liste arrive après un court chargement (comme une réponse d'API).
  setTimeout(render, 200);
</script></body></html>`;
};

export async function startTaskListApp(): Promise<TaskListApp> {
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://x');
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    const task = /^\/task\/(\d+)$/.exec(url.pathname);
    if (task) {
      response.end(
        `<!doctype html><html><head><title>Task</title></head><body><main><h1>Task ${task[1] ?? ''}</h1></main></body></html>`,
      );
      return;
    }
    response.end(page(url.searchParams));
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
