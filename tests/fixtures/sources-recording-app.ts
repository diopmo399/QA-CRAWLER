import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * L'application des SOURCES D'ENREGISTREMENT (current / playwright / hybrid) : un bouton, une tuile
 * <div> cliquable sans rôle, un <span> dans un bouton, un champ, une case, des boutons radio, une
 * liste, un panneau re-rendu, deux boutons identiques (ambiguïté), une iframe, et un lien « Accueil »
 * qui navigue. « Continuer » est visible mais jamais cliqué (une suggestion possible, jamais une action).
 */
const FORM = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Dossier</title></head>
<body>
<h1>Dossier</h1>
<p id="last" role="status"></p>
<button type="button" onclick="document.getElementById('last').textContent='Enregistré'">Enregistrer</button>
<div class="tile" style="cursor:pointer;display:inline-block;padding:8px" onclick="document.getElementById('last').textContent='Tuile'">Ouvrir la tuile</div>
<button type="button" class="button" onclick="document.getElementById('last').textContent='Suivant'"><span class="label">Suivant</span></button>
<button type="button" data-testid="continue" onclick="document.getElementById('last').textContent='Continuer'">Continuer</button>
<form onsubmit="return false">
  <label>Nom <input name="nom" autocomplete="off"></label>
  <label><input type="checkbox" name="ok"> Accepté</label>
  <fieldset><legend>Type</legend>
    <label><input type="radio" name="type" value="a"> Option A</label>
    <label><input type="radio" name="type" value="b"> Option B</label>
  </fieldset>
  <label>Pays <select name="pays"><option value="">—</option><option value="ca">Canada</option><option value="fr">France</option></select></label>
</form>
<div id="panel"><button type="button" id="reload">Recharger</button></div>
<section><button type="button" class="del">Supprimer</button></section>
<section><button type="button" class="del">Supprimer</button></section>
<iframe title="Cadre" srcdoc="<button type='button' onclick='this.textContent=&quot;Cliqué&quot;'>Dans le cadre</button>"></iframe>
<a href="/accueil">Accueil</a>
<script>
  document.getElementById('reload').addEventListener('click', () => {
    setTimeout(() => {
      document.getElementById('panel').innerHTML =
        '<p>Rechargé</p><button type="button" onclick="this.textContent=\\'Confirmé\\'">Confirmer</button>';
    }, 120);
  });
</script>
</body></html>`;

const HOME = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Accueil</title></head>
<body><h1>Accueil</h1>
<form onsubmit="return false">
  <label>Nom <input name="nom" autocomplete="off"></label>
  <label><input type="checkbox" name="accepte"> Accepté</label>
</form>
<button type="button" data-testid="continue">Continuer</button>
</body></html>`;

export interface SourcesRecordingApp {
  url: string;
  close: () => Promise<void>;
}

export async function startSourcesRecordingApp(): Promise<SourcesRecordingApp> {
  const server: Server = createServer((request, response) => {
    const route = (request.url ?? '/').split('?')[0];
    response.setHeader('content-type', 'text/html; charset=utf-8');
    if (route === '/accueil') {
      response.end(HOME);
      return;
    }
    response.end(FORM);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}
