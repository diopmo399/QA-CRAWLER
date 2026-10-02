import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Un parcours métier sur une seule adresse (/simulator) après la liste des tâches, fait de
 * contrôles d'interface sans requête ni changement de route :
 *
 *   /                 lien « Task list » (pushState → /tasks)
 *   /tasks            une carte maison <div class="task-card"> « Request 42 » (ni rôle, ni
 *                     curseur, ni tabindex) qui ouvre le simulateur
 *   /simulator        bouton « Company interview » → case « Premium plan » → en-tête maison
 *                     « Employee section » (aria-expanded) → champ « Employee name » ;
 *                     onglet « Company » → « Legal name », « Business number » ;
 *                     bouton « Advanced mode » (aucun effet visible) ;
 *                     « Continue » → étape 2 (Request type, Description) → « Continue » →
 *                     étape 3 « Confirm » → « Submit » : POST /api/requests → 201
 */
export interface JourneyApp {
  url: string;
  created: Record<string, unknown>[];
  close(): Promise<void>;
}

const SHELL = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Journey</title>
<style>.hidden{display:none}.task-card{border:1px solid #888;padding:8px;display:inline-block}</style></head>
<body><main id="app"></main>
<script>
  const app = document.getElementById('app');
  const go = (path) => { history.pushState({}, '', path); render(); };
  const $ = (id) => document.getElementById(id);
  const show = (id) => $(id).classList.remove('hidden');
  window.addEventListener('popstate', () => render());
  function render() {
    const path = location.pathname;
    if (path === '/') {
      app.innerHTML = '<h1>Home</h1><a href="/tasks" id="tasks">Task list</a>';
      $('tasks').addEventListener('click', (event) => { event.preventDefault(); go('/tasks'); });
    } else if (path === '/tasks') {
      app.innerHTML = '<h1>Tasks</h1><div class="task-card" id="card"><span>Request 42</span></div>';
      $('card').addEventListener('click', () => go('/simulator'));
    } else if (path === '/simulator') {
      app.innerHTML = '<h1>Simulator</h1>' +
        '<button type="button" id="interview">Company interview</button>' +
        '<div id="plan" class="hidden"><label><input type="checkbox" id="premium"> Premium plan</label></div>' +
        '<div id="employee" class="hidden"><div class="panel-header" id="employee-header" aria-expanded="false">Employee section</div>' +
        '<div id="employee-body" class="hidden"><label for="employeeName">Employee name</label><input id="employeeName" name="employeeName"></div></div>' +
        '<div role="tablist"><button role="tab" id="tab-applicant" aria-selected="true">Applicant</button><button role="tab" id="tab-company" aria-selected="false">Company</button></div>' +
        '<div id="company" class="hidden"><label for="legalName">Legal name</label><input id="legalName" name="legalName">' +
        '<label for="businessNumber">Business number</label><input id="businessNumber" name="businessNumber"></div>' +
        '<button type="button" id="advanced">Advanced mode</button>' +
        '<div id="step2" class="hidden"><label for="requestType">Request type</label><select id="requestType" name="requestType"><option value="">--</option><option value="INCIDENT">Incident</option><option value="QUESTION">Question</option></select>' +
        '<label for="description">Description</label><textarea id="description" name="description"></textarea></div>' +
        '<div id="step3" class="hidden"><button type="button" id="confirm">Confirm</button></div>' +
        '<div id="final" class="hidden"><button type="button" id="submit">Submit</button></div>' +
        '<button type="button" id="continue">Continue</button>' +
        '<p id="result" role="status"></p>';
      let step = 1;
      $('interview').addEventListener('click', () => show('plan'));
      $('premium').addEventListener('change', () => show('employee'));
      $('employee-header').addEventListener('click', () => { $('employee-header').setAttribute('aria-expanded', 'true'); show('employee-body'); });
      $('tab-company').addEventListener('click', () => { $('tab-company').setAttribute('aria-selected', 'true'); show('company'); });
      $('advanced').addEventListener('click', () => { window.advanced = true; });
      $('continue').addEventListener('click', () => {
        step += 1;
        if (step === 2) show('step2');
        if (step === 3) { show('step3'); $('continue').classList.add('hidden'); }
      });
      $('confirm').addEventListener('click', () => show('final'));
      $('submit').addEventListener('click', async () => {
        const body = {
          employeeName: $('employeeName').value, legalName: $('legalName').value, businessNumber: $('businessNumber').value,
          requestType: $('requestType').value, description: $('description').value, premium: $('premium').checked,
        };
        const response = await fetch('/api/requests', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        $('result').textContent = response.status === 201 ? 'Request saved' : 'Error';
      });
    } else {
      app.innerHTML = '<h1>Not found</h1>';
    }
  }
  render();
</script></body></html>`;

export async function startJourneyApp(): Promise<JourneyApp> {
  const created: Record<string, unknown>[] = [];
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname === '/api/requests' && request.method === 'POST') {
      let raw = '';
      request.on('data', (chunk: Buffer) => {
        raw += chunk.toString('utf8');
      });
      request.on('end', () => {
        created.push(JSON.parse(raw || '{}') as Record<string, unknown>);
        response.writeHead(201, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: created.length }));
      });
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(SHELL);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    created,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
