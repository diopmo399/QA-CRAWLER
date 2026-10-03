import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Le panneau « Filter » d'une liste : champ (select), opérateur (select), puis une VALEUR sans
 * libellé (`#valueInput`, avec une liste de suggestions — la capture la lit « combobox », le
 * rejeu « textbox »), puis « Apply ». Chaque « Apply » est compté : une validation de cible ne doit
 * jamais rejouer l'action. Variantes : `rerender` (le champ valeur est remplacé à chaque saisie),
 * `twins` (trois champs de valeur identiques sans libellé).
 */
export interface FilterApp {
  url: string;
  close(): Promise<void>;
}

const page = (
  variant: string,
): string => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Requests</title>
<style>.hidden{display:none}</style></head><body><main>
<h1>Requests</h1>
<button type="button" id="open">Filter</button>
<div role="dialog" aria-label="Filter" id="panel" class="hidden">
  <label>Field <select id="field"><option value="">--</option><option>Company name</option><option>City</option></select></label>
  <label>Operator <select id="operator"><option value="">--</option><option>Like</option><option>Equals</option></select></label>
  <div id="valueBox"><input id="valueInput" list="hints"></div>
  ${variant === 'twins' ? '<div><input class="extra"></div><div><input class="extra"></div>' : ''}
  <datalist id="hints"><option>alpha</option><option>beta</option></datalist>
  <button type="button" id="apply">Apply</button>
</div>
<p id="result"></p>
<p>Applied <span id="count">0</span> time(s)</p>
</main><script>
  document.getElementById('open').addEventListener('click', (event) => {
    document.getElementById('panel').classList.remove('hidden');
    ${variant === 'hideOpener' ? "event.currentTarget.classList.add('hidden');" : ''}
  });
  let count = 0;
  document.getElementById('apply').addEventListener('click', () => {
    count += 1;
    document.getElementById('count').textContent = String(count);
    const value = document.getElementById('valueInput').value;
    document.getElementById('result').textContent = value
      ? 'Filtered: ' + document.getElementById('field').value + ' ' + document.getElementById('operator').value + ' ' + value
      : '';
  });
  ${
    variant === 'rerender'
      ? `document.getElementById('valueBox').addEventListener('change', (event) => {
    // Un framework qui remplace le nœud après la saisie : même identité, autre élément.
    const old = event.target;
    const next = old.cloneNode(true);
    next.value = old.value;
    old.replaceWith(next);
  });`
      : ''
  }
</script></body></html>`;

export async function startFilterApp(): Promise<FilterApp> {
  const server: Server = createServer((request, response) => {
    const variant = new URL(request.url ?? '/', 'http://x').searchParams.get('variant') ?? 'default';
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(page(variant));
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
