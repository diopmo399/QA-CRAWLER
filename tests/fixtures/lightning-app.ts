import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * UNE IMITATION DE SALESFORCE LIGHTNING, pour les tests. Ce n'est PAS Salesforce : aucune ligne n'en
 * vient, rien n'y est validé. Elle reproduit les traits documentés qui comptent pour un explorateur :
 *   - des composants web en Shadow DOM natif (la page n'a presque rien hors des arbres « shadow ») ;
 *   - des LECTURES envoyées en `POST /aura` (une liste d'actions dans le paramètre `message`) ;
 *   - un chargeur `lightning-spinner` le temps de la réponse ;
 *   - des enregistrements à l'URL `/lightning/r/<Objet>/<Id 18 caractères>/view` ;
 *   - des identifiants d'éléments générés (`input-17`) et `data-aura-rendered-by` ;
 *   - une modification dans une fenêtre, enregistrée par `POST /aura` (updateRecord), puis un toast.
 */
export interface LightningApp {
  url: string;
  /** Chaque action Aura reçue : le descripteur, et si elle a été servie. */
  auraActions: string[];
  /** Les écritures effectivement reçues (updateRecord) : la garde d'écriture doit les empêcher en exploration. */
  writes: string[];
  close(): Promise<void>;
}

const RECORDS = [
  { id: '001Dn00000AbCdEIAV', name: 'Acme Nord', city: 'Lyon', phone: '04 00 00 00 01' },
  { id: '001Dn00000AbCdFIAV', name: 'Acme Sud', city: 'Nice', phone: '04 00 00 00 02' },
  { id: '001Dn00000AbCdGIAV', name: 'Acme Ouest', city: 'Nantes', phone: '02 00 00 00 03' },
];

const READ_DELAY_MS = 900;

const COMPONENTS = String.raw`
let seq = 0;
const nextId = (prefix) => prefix + '-' + String(++seq);
const rendered = () => String(100 + ++seq) + ':0';

async function aura(descriptor, params) {
  const message = JSON.stringify({ actions: [{ id: '1;a', descriptor, callingDescriptor: 'UNKNOWN', params }] });
  const body = 'message=' + encodeURIComponent(message) + '&aura.context=%7B%7D&aura.token=imitation-token';
  const response = await fetch('/aura?r=' + String(++seq) + '&imitation=1', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body,
  });
  const json = await response.json();
  return json.actions[0].returnValue;
}

class LightningSpinner extends HTMLElement {
  connectedCallback() {
    const root = this.shadowRoot ?? this.attachShadow({ mode: 'open' });
    root.innerHTML = '<style>.slds-spinner_container{padding:24px;color:#0176d3}</style><div class="slds-spinner_container"><div class="slds-spinner" role="status">Chargement…</div></div>';
  }
}

class XLoading extends HTMLElement {
  showSpinner(root) { root.innerHTML = '<lightning-spinner></lightning-spinner>'; }
  showError(root) { root.innerHTML = '<p role="alert">Impossible de charger les données.</p>'; }
}

class XAppNav extends HTMLElement {
  connectedCallback() {
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = '<style>nav{display:flex;gap:16px;padding:12px;background:#032d60}a{color:#fff}</style>' +
      '<nav aria-label="Navigation de l’application"><a href="/lightning/page/home">Accueil</a><a href="/lightning/o/Account/list">Comptes</a></nav>';
  }
}

class XListView extends XLoading {
  async connectedCallback() {
    const root = this.attachShadow({ mode: 'open' });
    this.showSpinner(root);
    try {
      const value = await aura('aura://ListUiController/ACTION$getListUi', { objectApiName: 'Account' });
      root.innerHTML = '<h1>Comptes</h1><table role="grid" aria-label="Comptes récents"><thead><tr><th>Nom du compte</th><th>Ville</th></tr></thead><tbody>' +
        value.records.map((record) => '<tr><td><a data-aura-rendered-by="' + rendered() + '" href="/lightning/r/Account/' + record.id + '/view">' + record.name + '</a></td><td>' + record.city + '</td></tr>').join('') +
        '</tbody></table>';
    } catch (error) {
      this.showError(root);
    }
  }
}

class XInput extends HTMLElement {
  connectedCallback() {
    const root = this.attachShadow({ mode: 'open' });
    const id = nextId('input');
    root.innerHTML = '<div class="slds-form-element"><label for="' + id + '">' + this.getAttribute('label') + '</label><input id="' + id + '" value="' + (this.getAttribute('value') ?? '') + '"></div>';
  }
  get value() { return this.shadowRoot.querySelector('input').value; }
}

class XRecordPage extends XLoading {
  async connectedCallback() {
    const root = this.attachShadow({ mode: 'open' });
    this.showSpinner(root);
    const recordId = this.getAttribute('record-id');
    try {
      const record = await aura('aura://RecordUiController/ACTION$getRecordWithFields', { recordId });
      this.render(root, record);
    } catch (error) {
      this.showError(root);
    }
  }
  render(root, record) {
    root.innerHTML = '<style>[role=tabpanel][hidden]{display:none}.slds-notify_toast{background:#2e844a;color:#fff;padding:8px}</style>' +
      '<header><p>Compte</p><h1>' + record.name + '</h1>' +
      '<button type="button" id="' + nextId('button') + '" data-act="edit">Modifier</button> ' +
      '<button type="button" id="' + nextId('button') + '" data-act="delete">Supprimer</button></header>' +
      '<div role="tablist" aria-label="Sections du compte">' +
      '<button role="tab" aria-selected="true" aria-controls="p-details" id="t-details">Détails</button>' +
      '<button role="tab" aria-selected="false" aria-controls="p-related" id="t-related">Associé</button></div>' +
      '<section role="tabpanel" id="p-details" aria-labelledby="t-details"><dl><dt>Ville</dt><dd>' + record.city + '</dd><dt>Téléphone</dt><dd>' + record.phone + '</dd></dl></section>' +
      '<section role="tabpanel" id="p-related" aria-labelledby="t-related" hidden><p>Aucun contact associé.</p></section>' +
      '<div id="toast"></div>';
    for (const tab of root.querySelectorAll('[role=tab]'))
      tab.addEventListener('click', () => {
        for (const other of root.querySelectorAll('[role=tab]')) other.setAttribute('aria-selected', String(other === tab));
        for (const panel of root.querySelectorAll('[role=tabpanel]')) panel.hidden = panel.id !== tab.getAttribute('aria-controls');
      });
    root.querySelector('[data-act=edit]').addEventListener('click', () => this.edit(root, record));
    root.querySelector('[data-act=delete]').addEventListener('click', () => {
      root.querySelector('#toast').innerHTML = '<div role="alert">Suppression impossible dans cette imitation.</div>';
    });
  }
  edit(root, record) {
    const dialog = document.createElement('section');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-label', 'Modifier ' + record.name);
    dialog.innerHTML = '<h2>Modifier ' + record.name + '</h2><x-input label="Nom du compte" value="' + record.name + '"></x-input>' +
      '<button type="button" data-act="cancel">Annuler</button> <button type="button" data-act="save">Enregistrer</button>';
    root.appendChild(dialog);
    dialog.querySelector('[data-act=cancel]').addEventListener('click', () => dialog.remove());
    dialog.querySelector('[data-act=save]').addEventListener('click', async () => {
      const name = dialog.querySelector('x-input').value;
      try {
        await aura('aura://RecordUiController/ACTION$updateRecord', { recordId: record.id, fields: { Name: name } });
        dialog.remove();
        root.querySelector('#toast').innerHTML = '<div class="slds-notify_toast" role="status">Compte « ' + name + ' » enregistré.</div>';
      } catch (error) {
        root.querySelector('#toast').innerHTML = '<div role="alert">Enregistrement refusé.</div>';
      }
    });
  }
}

customElements.define('lightning-spinner', LightningSpinner);
customElements.define('x-app-nav', XAppNav);
customElements.define('x-list-view', XListView);
customElements.define('x-input', XInput);
customElements.define('x-record-page', XRecordPage);
`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${title} | Imitation Lightning</title></head>
<body><x-app-nav></x-app-nav><main>${body}</main><script type="module">${COMPONENTS}</script></body></html>`;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function startLightningApp(): Promise<LightningApp> {
  const app: LightningApp = { url: '', auraActions: [], writes: [], close: () => Promise.resolve() };
  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname === '/aura' && request.method === 'POST') {
        const body = await readBody(request);
        const message = new URLSearchParams(body).get('message') ?? '{}';
        const action = (
          JSON.parse(message) as { actions?: { descriptor: string; params?: Record<string, unknown> }[] }
        ).actions?.[0];
        const descriptor = action?.descriptor ?? '';
        app.auraActions.push(descriptor);
        const reply = (returnValue: unknown): void => {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ actions: [{ id: '1;a', state: 'SUCCESS', returnValue }] }));
        };
        if (descriptor.endsWith('ACTION$getListUi')) {
          await new Promise((resolve) => setTimeout(resolve, READ_DELAY_MS));
          reply({ records: RECORDS });
          return;
        }
        if (descriptor.endsWith('ACTION$getRecordWithFields')) {
          await new Promise((resolve) => setTimeout(resolve, READ_DELAY_MS));
          reply(RECORDS.find((record) => record.id === action?.params?.recordId) ?? RECORDS[0]);
          return;
        }
        if (descriptor.endsWith('ACTION$updateRecord')) {
          app.writes.push(descriptor);
          reply({ ok: true });
          return;
        }
        response.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"unknown action"}');
        return;
      }
      const html = (title: string, body: string): void => {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(page(title, body));
      };
      if (url.pathname === '/' || url.pathname === '/lightning/page/home') {
        html(
          'Accueil',
          '<h1>Accueil</h1><p>Imitation de Lightning Experience pour les tests de QA-CRAWLER.</p>',
        );
        return;
      }
      if (url.pathname === '/lightning/o/Account/list') {
        html('Comptes', '<x-list-view></x-list-view>');
        return;
      }
      const record = /^\/lightning\/r\/Account\/([A-Za-z0-9]{18})\/view$/.exec(url.pathname);
      if (record) {
        html('Compte', `<x-record-page record-id="${record[1] ?? ''}"></x-record-page>`);
        return;
      }
      response
        .writeHead(404, { 'content-type': 'text/html' })
        .end(page('Introuvable', '<h1>Introuvable</h1>'));
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  app.url = `http://localhost:${String((server.address() as AddressInfo).port)}`;
  app.close = () =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
      server.closeAllConnections();
    });
  return app;
}
