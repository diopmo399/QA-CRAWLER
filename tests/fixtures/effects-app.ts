import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Une page qui met à l'épreuve « CLICKED != SUCCEEDED » :
 *
 *   « Tasks »          révèle « Company interview » (?broken=1 : ne fait plus rien)
 *   « Settings »       ouvre « Settings panel » (compté côté serveur : jamais cliqué par erreur)
 *   ?layout=b          Settings passe AVANT Tasks (un CSS de position vise alors Settings)
 *   onglet « Company » révèle « Legal name » (même adresse, même écran pour le StateDetector)
 *   en-tête « More information » (aria-expanded) révèle « Details »
 *   « Load tasks »     GET /api/tasks (lent) puis la liste « Task one »
 *   « Submit »         POST /api/submit → 500 (effet métier ambigu : jamais renvoyé)
 *   ?overlay=1         un voile couvre la page 1,2 s au chargement
 *   <x-panel>          un web component (shadow DOM ouvert) : bouton « Open details » → champ « Inner name »
 */
export interface EffectsApp {
  url: string;
  counts: { settings: number; submit: number; tasks: number };
  close(): Promise<void>;
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Effects</title>
<style>.hidden{display:none}#veil{position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:10}</style></head>
<body><main><h1>Workspace</h1>
<div id="toolbar"></div>
<button type="button" id="interview" class="hidden">Company interview</button>
<section id="settings-panel" class="hidden"><h2>Settings panel</h2></section>
<div role="tablist"><button role="tab" id="tab-a" aria-selected="true">Applicant</button><button role="tab" id="tab-company" aria-selected="false">Company</button></div>
<div id="company" class="hidden"><label for="legal">Legal name</label><input id="legal"></div>
<div class="panel-header" id="more" aria-expanded="false">More information</div>
<div id="details-box" class="hidden"><label for="details">Details</label><input id="details"></div>
<button type="button" id="load">Load tasks</button><ul id="tasks-list"></ul>
<button type="button" id="submit">Submit</button><p id="status" role="status"></p>
<x-panel></x-panel>
</main>
<script>
  const params = new URLSearchParams(location.search);
  const $ = (id) => document.getElementById(id);
  const show = (id) => $(id).classList.remove('hidden');
  const tasks = '<button type="button" id="tasks">Tasks</button>';
  const settings = '<button type="button" id="settings">Settings</button>';
  $('toolbar').innerHTML = params.get('layout') === 'b' ? settings + tasks : tasks + settings;
  $('tasks').addEventListener('click', () => { if (params.get('broken') !== '1') show('interview'); });
  $('settings').addEventListener('click', () => { fetch('/api/settings-opened'); show('settings-panel'); });
  $('tab-company').addEventListener('click', () => { $('tab-company').setAttribute('aria-selected', 'true'); show('company'); });
  $('more').addEventListener('click', () => { $('more').setAttribute('aria-expanded', 'true'); show('details-box'); });
  $('load').addEventListener('click', async () => {
    const response = await fetch('/api/tasks');
    const list = await response.json();
    $('tasks-list').innerHTML = list.map((name) => '<li><button type="button">' + name + '</button></li>').join('');
  });
  $('submit').addEventListener('click', async () => {
    const response = await fetch('/api/submit', { method: 'POST', body: '{}' });
    $('status').textContent = 'answer ' + response.status;
  });
  if (params.get('overlay') === '1') {
    const veil = document.createElement('div'); veil.id = 'veil'; document.body.appendChild(veil);
    setTimeout(() => veil.remove(), 1200);
  }
  customElements.define('x-panel', class extends HTMLElement {
    connectedCallback() {
      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML = '<div><button type="button" id="open">Open details</button>' +
        '<div id="inner" style="display:none"><label for="inner-name">Inner name</label><input id="inner-name"></div></div>';
      root.getElementById('open').addEventListener('click', () => { root.getElementById('inner').style.display = 'block'; });
    }
  });
</script></body></html>`;

export async function startEffectsApp(): Promise<EffectsApp> {
  const counts = { settings: 0, submit: 0, tasks: 0 };
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname === '/api/settings-opened') {
      counts.settings += 1;
      response.writeHead(204);
      response.end();
      return;
    }
    if (url.pathname === '/api/tasks') {
      counts.tasks += 1;
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(['Task one', 'Task two']));
      }, 600);
      return;
    }
    if (url.pathname === '/api/submit' && request.method === 'POST') {
      counts.submit += 1;
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end('{"error":"unexpected"}');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    counts,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
