import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Le panneau « Filter » d'une liste : champ (select), opérateur (select), puis une VALEUR sans
 * libellé (`#valueInput`, avec une liste de suggestions — la capture la lit « combobox », le
 * rejeu « textbox »), puis « Apply ». Chaque « Apply » est compté : une validation de cible ne doit
 * jamais rejouer l'action. Variantes : `rerender` (le champ valeur est remplacé à chaque saisie),
 * `twins` (trois champs de valeur identiques sans libellé), `volatile` (dès la première frappe, le
 * champ valeur est remplacé par un nœud SANS l'id : `#valueInput` ne désigne plus rien), `reuse`
 * (idem, puis `#valueInput` désigne le champ de recherche global), `material` (le champ valeur dans
 * un mat-form-field avec mat-label), `selectRerender` (la liste « Field » est remplacée après son
 * choix), `closeOnApply` (la fenêtre se ferme à « Apply »).
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
<label>Search <input id="search" placeholder="Search requests"></label>
<button type="button" id="open">Filter</button>
<div role="dialog" aria-label="Filter" id="panel" class="hidden">
  <label>Field <select id="field"><option value="">--</option><option>Company name</option><option>City</option></select></label>
  <label>Operator <select id="operator"><option value="">--</option><option>Like</option><option>Equals</option></select></label>
  <div id="valueBox">${
    variant === 'material'
      ? '<mat-form-field><mat-label>Value</mat-label><input id="valueInput" list="hints"></mat-form-field>'
      : '<input id="valueInput" list="hints">'
  }</div>
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
    const value = document.querySelector('#valueBox input').value;
    ${variant === 'closeOnApply' ? "document.getElementById('panel').classList.add('hidden');" : ''}
    document.getElementById('result').textContent = value
      ? 'Filtered: ' + document.getElementById('field').value + ' ' + document.getElementById('operator').value + ' ' + value
      : '';
  });
  ${
    variant === 'volatile' || variant === 'reuse'
      ? `document.getElementById('valueBox').addEventListener('input', (event) => {
    // Dès la première frappe, le framework remplace le champ par un nœud SANS l'id.
    const old = event.target;
    if (!old.id) return;
    const next = document.createElement('input');
    next.className = 'value-field';
    next.setAttribute('list', 'hints');
    next.value = old.value;
    old.replaceWith(next);
    ${variant === 'reuse' ? "document.getElementById('search').id = 'valueInput';" : ''}
  });`
      : ''
  }
  ${
    variant === 'selectRerender'
      ? `document.getElementById('field').addEventListener('change', (event) => {
    const old = event.target;
    const next = old.cloneNode(true);
    next.value = old.value;
    old.replaceWith(next);
  });`
      : ''
  }
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
