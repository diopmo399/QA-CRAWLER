import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Un formulaire « Angular Material » : trois mat-form-field, chacun dans sa ligne, dont les input
 * n'ont ni libellé relié, ni name, ni id, ni formcontrolname. Leur CSS est structurel et RELATIF
 * au composant (mat-form-field > div > div:nth-of-type(2) > div > input) : le même pour les trois.
 * A est numérique (maxlength 5) ; B et C sont du texte. « Save » envoie les trois valeurs.
 * Par défaut chaque champ a son mat-label ; `?variant=bare` n'en a aucun.
 */
export interface MaterialFormApp {
  url: string;
  /** Les corps reçus par POST /api/requests. */
  created: Record<string, string>[];
  close(): Promise<void>;
}

/** bare : aucun libellé lisible (le cas réel : seul le CSS structurel désigne le champ). */
const field = (label: string, bare: boolean, attributes = ''): string => `
  <div class="row"><mat-form-field>
    <div class="wrapper">
      <div class="prefix"></div>
      <div class="infix">
        ${bare ? '<span class="floating"></span>' : `<mat-label>${label}</mat-label>`}
        <div><input type="text" ${attributes}></div>
      </div>
    </div>
  </mat-form-field></div>`;

const page = (bare: boolean): string => `<!doctype html><html><head><title>New request</title><style>
  mat-form-field { display: block; margin: 8px 0; }
  mat-label { display: block; font-size: 12px; }
</style></head><body><main>
<h1>New request</h1>
<form id="request" onsubmit="return false">
${field('Employee number', bare, 'maxlength="5" inputmode="numeric"')}
${field('Employee name', bare)}
${field('Company name', bare)}
<button type="button" id="save">Save</button>
</form>
<p id="out"></p>
</main><script>
  document.getElementById('save').addEventListener('click', async () => {
    const [employeeNumber, employeeName, companyName] = Array.from(
      document.querySelectorAll('mat-form-field input'),
    ).map((input) => input.value);
    const response = await fetch('/api/requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ employeeNumber, employeeName, companyName }),
    });
    document.getElementById('out').textContent = response.ok ? 'Request saved' : 'Refused';
  });
</script></body></html>`;

export async function startMaterialFormApp(): Promise<MaterialFormApp> {
  const created: Record<string, string>[] = [];
  const server: Server = createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/api/requests') {
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString()));
      request.on('end', () => {
        const parsed = JSON.parse(body) as Record<string, string>;
        // Le champ numérique refuse ce qui n'est pas un numéro (la vraie contrainte du cas réel).
        const valid = /^\d{1,5}$/.test(parsed.employeeNumber ?? '');
        if (valid) created.push(parsed);
        response.writeHead(valid ? 201 : 400, { 'content-type': 'application/json' });
        response.end(JSON.stringify(valid ? { id: created.length } : { error: 'employeeNumber' }));
      });
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(page(new URL(request.url ?? '/', 'http://x').searchParams.get('variant') === 'bare'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    created,
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}
