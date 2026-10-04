import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Une application aux CONTEXTES multiples (InteractionTargetIdentity) :
 *  - deux onglets (Company / Individual), chacun son panneau ;
 *  - un accordéon « Interview » (motif ARIA aria-expanded / aria-controls) qui contient une case ;
 *  - deux dialogues non modaux ouverts en même temps, chacun avec SON bouton « Apply ».
 * Variantes : `swap` (l'onglet « Company » ouvre le mauvais panneau : une régression qui rend
 * l'étape SUIVANTE impossible), `collapsed` (l'accordéon est fermé au chargement).
 */
export interface ContextApp {
  url: string;
  /** Les « Apply » reçus (le dialogue qui a été appliqué). */
  applied: string[];
  close(): Promise<void>;
}

const page = (variant: string): string => `<!doctype html><html><head><title>Client</title><style>
  [hidden] { display: none !important; }
  .dialog { border: 1px solid #888; padding: 8px; margin: 8px 0; }
</style></head><body><main>
<h1>Client</h1>
<div role="tablist" aria-label="Client type">
  <button role="tab" id="tab-individual" aria-controls="panel-individual" aria-selected="true">Individual</button>
  <button role="tab" id="tab-company" aria-controls="panel-company" aria-selected="false">Company</button>
</div>
<div role="tabpanel" id="panel-individual" aria-labelledby="tab-individual">
  <label>Full name <input id="fullName"></label>
</div>
<div role="tabpanel" id="panel-company" aria-labelledby="tab-company" hidden>
  <label>Business number <input id="businessNumber"></label>
</div>
<h2>Follow-up</h2>
<button id="interview-header" aria-expanded="${variant === 'collapsed' ? 'false' : 'true'}" aria-controls="interview-panel">Interview</button>
<div id="interview-panel" ${variant === 'collapsed' ? 'hidden' : ''}>
  <label><input type="checkbox" id="interviewDone"> Interview done</label>
</div>
<p>
  <button id="open-filter">Filter</button>
  <button id="open-edit">Edit request</button>
</p>
<div class="dialog" role="dialog" aria-label="Filter" id="dlg-filter" hidden>
  <label>Keyword <input id="keyword"></label>
  <button class="apply" data-dialog="Filter">Apply</button>
</div>
<div class="dialog" role="dialog" aria-label="Edit request" id="dlg-edit" hidden>
  <label>Comment <input id="comment"></label>
  <button class="apply" data-dialog="Edit request">Apply</button>
</div>
<p id="out"></p>
</main><script>
  const select = (name) => {
    for (const tab of document.querySelectorAll('[role="tab"]')) {
      const on = tab.textContent === name;
      tab.setAttribute('aria-selected', String(on));
      document.getElementById(tab.getAttribute('aria-controls')).hidden = !on;
    }
  };
  document.getElementById('tab-individual').addEventListener('click', () => select('Individual'));
  // swap : une régression — « Company » ouvre le panneau Individual.
  document.getElementById('tab-company').addEventListener('click', () => select(${variant === 'swap' ? "'Individual'" : "'Company'"}));
  document.getElementById('interview-header').addEventListener('click', (event) => {
    const open = event.currentTarget.getAttribute('aria-expanded') !== 'true';
    event.currentTarget.setAttribute('aria-expanded', String(open));
    document.getElementById('interview-panel').hidden = !open;
  });
  document.getElementById('open-filter').addEventListener('click', () => { document.getElementById('dlg-filter').hidden = false; });
  document.getElementById('open-edit').addEventListener('click', () => { document.getElementById('dlg-edit').hidden = false; });
  for (const button of document.querySelectorAll('.apply'))
    button.addEventListener('click', async (event) => {
      const dialog = event.currentTarget.dataset.dialog;
      await fetch('/api/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dialog }) });
      document.getElementById('out').textContent = dialog + ' applied';
    });
</script></body></html>`;

export async function startContextApp(): Promise<ContextApp> {
  const applied: string[] = [];
  const server: Server = createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/api/apply') {
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString()));
      request.on('end', () => {
        applied.push((JSON.parse(body) as { dialog: string }).dialog);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"ok":true}');
      });
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(page(new URL(request.url ?? '/', 'http://x').searchParams.get('variant') ?? 'default'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    applied,
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}
