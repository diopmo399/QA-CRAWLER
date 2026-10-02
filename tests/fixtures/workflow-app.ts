import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Une petite application dont l'interface ÉVOLUE d'une version à l'autre (?v=…), pour le
 * WORKFLOW SELF-HEALING. Le parcours fonctionnel reste le même :
 *
 *   Tasks → Enterprise interview → EUR → (informations de l'entreprise) → Company name,
 *   Business number → Submit (POST /api/company)
 *
 *   v1   l'interface d'origine (bouton « Company information »)
 *   v2   renommages : « Work items », « Company details »
 *   v3   le bouton devient un onglet « Company » (+ un bouton « Remove company information » qui écrit)
 *   v4   v2 + v3 + une nouvelle question obligatoire (SAFE) avant l'onglet « Company »
 *   v5   la section entreprise n'existe plus (régression ou flow obsolète)
 *   amb  deux contrôles aussi plausibles : « Company profile » et « Company details »
 *   ai   le bouton devient un onglet « Enterprise Details » ; un lien « Company Profile » (trompeur :
 *        il n'ouvre qu'une fiche, sans les champs) et un bouton qui écrit (« Remove company information »)
 *        sont aussi à l'écran
 *   inline  les champs sont déjà affichés (l'étape d'ouverture est devenue inutile)
 *   role=viewer  l'utilisateur n'a plus le droit de voir les informations de l'entreprise
 *   fail=1  le bouton existe, mais POST /api/company répond 500 (un vrai bogue)
 *   strict=1  l'envoi reste désactivé tant que les champs ne sont pas remplis (strict=0 : toujours actif)
 */
export interface WorkflowApp {
  url: string;
  counts: { submit: number; removed: number };
  close(): Promise<void>;
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Workflow</title>
<style>.hidden{display:none}</style></head>
<body><main><h1>Case file</h1>
<div id="toolbar"></div>
<section id="interview-box" class="hidden"><button type="button" id="interview">Enterprise interview</button></section>
<section id="eur-box" class="hidden"><label><input type="checkbox" id="eur"> EUR</label></section>
<section id="question-box" class="hidden"><label><input type="checkbox" id="registered"> The applicant is registered</label></section>
<section id="opener" class="hidden"></section>
<section id="company" class="hidden"><h2>Company</h2>
  <label for="company-name">Company name</label><input id="company-name" required>
  <label for="business-number">Business number</label><input id="business-number" required>
  <button type="button" id="submit">Submit</button><p id="status" role="status"></p>
</section>
<p id="notice"></p>
</main>
<script>
  const params = new URLSearchParams(location.search);
  const v = params.get('v') || '1';
  const viewer = params.get('role') === 'viewer';
  const $ = (id) => document.getElementById(id);
  const show = (id) => $(id).classList.remove('hidden');
  const renamed = v === '2' || v === '4';
  $('toolbar').innerHTML = '<button type="button" id="tasks">' + (renamed ? 'Work items' : 'Tasks') + '</button>' +
    '<button type="button" id="settings">Settings</button>';
  $('tasks').addEventListener('click', () => show('interview-box'));
  $('settings').addEventListener('click', () => { $('notice').textContent = 'Settings are read-only'; });
  $('interview').addEventListener('click', () => show('eur-box'));
  const openCompany = () => show('company');
  const opener = $('opener');
  if (viewer) {
    opener.innerHTML = '<p>You do not have permission to view company information.</p>';
  } else if (v === '1') {
    opener.innerHTML = '<button type="button" id="open">Company information</button>';
  } else if (v === '2') {
    opener.innerHTML = '<button type="button" id="open">Company details</button>';
  } else if (v === '3' || v === '4') {
    opener.innerHTML = '<div role="tablist"><button role="tab" aria-selected="true" id="tab-a">Applicant</button>' +
      '<button role="tab" aria-selected="false" id="open">Company</button></div>' +
      (v === '3' ? '<button type="button" id="remove">Remove company information</button>' : '');
  } else if (v === 'ai') {
    opener.innerHTML = '<div role="tablist"><button role="tab" aria-selected="true" id="tab-a">Applicant</button>' +
      '<button role="tab" aria-selected="false" id="open">Enterprise Details</button></div>' +
      '<a href="#profile" id="profile">Company Profile</a><p id="profile-box" class="hidden">Profile: read-only summary</p>' +
      '<button type="button" id="remove">Remove company information</button>';
    $('profile').addEventListener('click', (event) => { event.preventDefault(); show('profile-box'); });
  } else if (v === 'amb') {
    opener.innerHTML = '<button type="button" id="open">Company profile</button><button type="button" id="open2">Company details</button>';
  }
  if ($('open')) $('open').addEventListener('click', () => { if ($('open').getAttribute('role') === 'tab') $('open').setAttribute('aria-selected', 'true'); openCompany(); });
  if ($('open2')) $('open2').addEventListener('click', openCompany);
  if ($('remove')) $('remove').addEventListener('click', () => fetch('/api/company', { method: 'DELETE' }));
  $('eur').addEventListener('change', () => {
    if (!$('eur').checked) return;
    if (v === 'inline') { show('company'); return; }
    if (v === '4') show('question-box'); else show('opener');
  });
  $('registered').addEventListener('change', () => { if ($('registered').checked) show('opener'); else $('opener').classList.add('hidden'); });
  // ?strict=1 : l'envoi reste désactivé tant que les deux champs ne sont pas remplis ; ?strict=0 : toujours actif.
  if (params.has('strict')) {
    const strict = params.get('strict') === '1';
    const refresh = () => { $('submit').disabled = strict && !($('company-name').value && $('business-number').value); };
    $('company-name').addEventListener('input', refresh);
    $('business-number').addEventListener('input', refresh);
    refresh();
  }
  $('submit').addEventListener('click', async () => {
    const response = await fetch('/api/company' + (params.get('fail') === '1' ? '?fail=1' : ''), { method: 'POST', body: '{}' });
    $('status').textContent = response.ok ? 'Saved' : 'Error ' + response.status;
  });
</script></body></html>`;

export async function startWorkflowApp(): Promise<WorkflowApp> {
  const counts = { submit: 0, removed: 0 };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname === '/api/company') {
      if (request.method === 'DELETE') counts.removed += 1;
      if (request.method === 'POST') counts.submit += 1;
      const failing = url.searchParams.get('fail') === '1';
      response.writeHead(failing ? 500 : 201, { 'content-type': 'application/json' });
      response.end(failing ? '{"error":"unexpected"}' : '{"id":1}');
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
