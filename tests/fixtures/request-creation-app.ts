import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * « Create request » : quatre champs construits par les MÊMES composants maison (structure Material
 * interne identique, ids générés mat-input-N, AUCUN attribut propre à l'input). Ce qui les distingue
 * est porté par l'HÔTE : <app-input-mask formcontrolname="branchNumber">, <app-input
 * formcontrolname="legalName">… Le chemin structurel « mat-form-field > … > input » désigne plusieurs
 * champs. Les libellés (mat-label) ne sont pas reliés aux inputs.
 *
 * Variantes : `v2` (le composant de masque est renommé app-masked-input et le DOM interne Material
 * gagne une enveloppe : le CSS préféré enregistré ne trouve plus rien), `shuffled` (l'ordre des champs
 * change : un chemin de positions viserait un autre champ), `late-init` (la première saisie dans
 * « Legal name » déclenche le chargement tardif des valeurs par défaut, qui VIDE ce champ une fois — un
 * formulaire initialisé après coup), `always-reset` (le champ est vidé après chaque saisie : une vraie
 * perte, jamais masquée), `dependent-reset` (remplir le prénom du contact vide « Legal name », déjà
 * confirmé : signalé avant l'écriture). « Save » envoie les quatre valeurs.
 */
export interface RequestCreationApp {
  url: string;
  saved: Record<string, string>[];
  close(): Promise<void>;
}

interface Field {
  control: string;
  label: string;
  host: 'mask' | 'plain';
  maxLength: number;
}

const FIELDS: Field[] = [
  { control: 'branchNumber', label: 'Branch number', host: 'mask', maxLength: 5 },
  { control: 'legalName', label: 'Legal name', host: 'plain', maxLength: 80 },
  { control: 'contactFirstName', label: 'Contact first name', host: 'plain', maxLength: 40 },
  { control: 'contactLastName', label: 'Contact last name', host: 'plain', maxLength: 40 },
];

const page = (variant: string): string => {
  const fields = variant === 'shuffled' ? [FIELDS[1], FIELDS[0], FIELDS[3], FIELDS[2]] : FIELDS;
  const field = (entry: Field | undefined, index: number): string => {
    if (!entry) return '';
    const host =
      entry.host === 'mask' ? (variant === 'v2' ? 'app-masked-input' : 'app-input-mask') : 'app-input';
    const inner = `<input id="mat-input-${String(index)}" class="mat-mdc-input-element" maxlength="${String(entry.maxLength)}"${entry.host === 'mask' ? ' inputmode="numeric"' : ''}>`;
    const wrapped = variant === 'v2' ? `<div class="mat-mdc-form-field-infix-v2">${inner}</div>` : inner;
    return `<${host} formcontrolname="${entry.control}">
  <mat-form-field class="mat-mdc-form-field">
    <div class="mat-mdc-text-field-wrapper">
      <div class="mat-mdc-form-field-flex">
        <span class="mat-mdc-floating-label"><mat-label>${entry.label}</mat-label></span>
        <div class="mat-mdc-form-field-infix">${wrapped}</div>
      </div>
    </div>
  </mat-form-field>
</${host}>`;
  };
  return `<!doctype html><html><head><title>Create request</title></head><body><main>
<h1>Create request</h1>
<form id="request" onsubmit="return false">
<section><h2>Company</h2>
${field(fields[0], 0)}
${field(fields[1], 1)}
</section>
<section><h2>Contact</h2>
${field(fields[2], 2)}
${field(fields[3], 3)}
</section>
<button type="button" id="save">Save</button>
</form>
<p id="out"></p>
</main><script>
  // Le masque : seulement des chiffres (comme un composant de saisie masquée).
  for (const input of document.querySelectorAll('app-input-mask input, app-masked-input input'))
    input.addEventListener('input', () => { input.value = input.value.replace(/\\D/g, '').slice(0, 5); });
  const variant = ${JSON.stringify(variant)};
  if (variant === 'late-init' || variant === 'always-reset') {
    const legal = document.querySelector('[formcontrolname="legalName"] input');
    let loaded = false;
    legal.addEventListener('input', async () => {
      if (loaded && variant === 'late-init') return;
      loaded = true;
      await fetch('/api/defaults');
      // Les valeurs par défaut arrivent : le formulaire est (ré)initialisé, la saisie est perdue.
      legal.value = '';
    });
  }
  if (variant === 'dependent-reset')
    // Un champ dépendant : saisir le prénom du contact réinitialise « Legal name », déjà saisi.
    document.querySelector('[formcontrolname="contactFirstName"] input').addEventListener('input', () => {
      document.querySelector('[formcontrolname="legalName"] input').value = '';
    });
  document.getElementById('save').addEventListener('click', async () => {
    const values = {};
    for (const host of document.querySelectorAll('[formcontrolname]'))
      values[host.getAttribute('formcontrolname')] = host.querySelector('input').value;
    await fetch('/api/requests', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(values) });
    document.getElementById('out').textContent = 'Request saved';
  });
</script></body></html>`;
};

export async function startRequestCreationApp(): Promise<RequestCreationApp> {
  const saved: Record<string, string>[] = [];
  const server: Server = createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/api/requests') {
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString()));
      request.on('end', () => {
        saved.push(JSON.parse(body) as Record<string, string>);
        response.writeHead(201, { 'content-type': 'application/json' });
        response.end('{"id":1}');
      });
      return;
    }
    if (request.url === '/api/defaults') {
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{}');
      }, 400);
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(page(new URL(request.url ?? '/', 'http://x').searchParams.get('variant') ?? 'default'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    saved,
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}
