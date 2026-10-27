import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ConfluenceConnector,
  importSource,
  pageIdOf,
  pageRefOf,
  RequirementsStore,
  storageToBlocks,
  variantOf,
  type ConfluenceInput,
} from '../../src/requirements/index.js';

/**
 * LE CONNECTEUR CONFLUENCE contre un serveur SIMULÉ. Le serveur reproduit les réponses documentées
 * de l'API REST v2 de Confluence Cloud et de l'API content de Confluence Data Center : il ne prouve
 * PAS la compatibilité avec un Confluence réel (validation restante :
 * docs/requirements/AUDIT-ET-CONCEPTION.md, Q2). Le contenu est fictif.
 */
const EMAIL = 'analyste@example.test';
const API_TOKEN = 'cloud-api-token-0123456789';
const PAT = 'dc-personal-token-0123456789';
const SERVER_USER = 'svc-qa';
const SERVER_PASSWORD = 'server-password-0123456789';
const TITLE = 'Spécification demandes (fictive)';

const STORAGE = `<h1>Gestion des demandes</h1>
<p>Cette page d&eacute;crit les exigences du module de demandes (exemple fictif).</p>
<h2>Exigences</h2>
<p><strong>REQ-101</strong> : Cr&eacute;er une demande. Le syst&egrave;me doit enregistrer une demande avec son titre.</p>
<ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">D&eacute;tails</ac:parameter><ac:rich-text-body><p>RG-11 Le titre est obligatoire.</p></ac:rich-text-body></ac:structured-macro>
<ul><li>&Eacute;tant donn&eacute; un titre vide, quand on enregistre, alors un message d&#39;erreur est affich&eacute;<ul><li>Le message cite le champ</li></ul></li></ul>
<table><tbody><tr><th>ID</th><th>Titre</th><th>Priorit&eacute;</th><th>Statut</th></tr>
<tr><td>REQ-102</td><td>Rechercher une demande</td><td>Haute</td><td><ac:structured-macro ac:name="status"><ac:parameter ac:name="colour">Green</ac:parameter><ac:parameter ac:name="title">VALIDÉE</ac:parameter></ac:structured-macro></td></tr></tbody></table>
<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[if (title.isEmpty()) throw new Error();]]></ac:plain-text-body></ac:structured-macro>
<p>Voir <ac:link><ri:page ri:content-title="Glossaire" /><ac:plain-text-link-body><![CDATA[le glossaire]]></ac:plain-text-link-body></ac:link> et <a href="https://example.test/norme">la norme</a>.</p>
<ac:image><ri:attachment ri:filename="flux.png" /></ac:image>
<ac:structured-macro ac:name="excerpt-include"><ac:parameter ac:name="">Règles communes</ac:parameter></ac:structured-macro>`;

let server: Server;
let base = '';
const seen: { url: string; authorization: string | undefined }[] = [];
let mode:
  'ok' | '401' | '403' | '404' | '429-once' | '429-always' | 'slow' | 'huge' | 'redirect' | 'not-json' = 'ok';
let rateLimited = 0;

function cloudPage(id: string): unknown {
  return {
    id,
    status: 'current',
    title: 'Spécification demandes (fictive)',
    spaceId: '98304',
    version: { number: 7, createdAt: '2026-10-20T08:30:00.000Z' },
    body: { storage: { value: STORAGE, representation: 'storage' } },
    _links: { webui: `/spaces/DEM/pages/${id}/Specification`, base: `${base}/wiki` },
  };
}

function datacenterPage(id: string): unknown {
  return {
    id,
    type: 'page',
    title: 'Spécification demandes (fictive)',
    space: { key: 'DEM', name: 'Demandes' },
    version: { number: 3, when: '2026-10-21T09:00:00.000+02:00' },
    body: { storage: { value: STORAGE, representation: 'storage' } },
    _links: { webui: `/pages/viewpage.action?pageId=${id}`, base },
  };
}

function handle(request: IncomingMessage, response: ServerResponse): void {
  const url = new URL(request.url ?? '/', 'http://x');
  seen.push({ url: `${url.pathname}${url.search}`, authorization: request.headers.authorization });
  const json = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
    response.writeHead(status, { 'content-type': 'application/json', ...headers });
    response.end(JSON.stringify(body));
  };
  if (mode === 'slow') return; // ne répond jamais
  if (mode === '401') {
    json(401, { message: 'Unauthorized' });
    return;
  }
  if (mode === '403') {
    json(403, { message: 'Forbidden' });
    return;
  }
  if (mode === '404') {
    json(404, { message: 'Not found' });
    return;
  }
  if (mode === 'redirect') {
    response.writeHead(302, { location: 'https://other.example.test/login' });
    response.end();
    return;
  }
  if (mode === '429-always' || (mode === '429-once' && rateLimited === 0)) {
    rateLimited += 1;
    json(429, { message: 'Too many requests' }, { 'retry-after': '0' });
    return;
  }
  if (mode === 'not-json') {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<html>login</html>');
    return;
  }
  if (mode === 'huge') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ body: { storage: { value: 'x'.repeat(4096) } } }));
    return;
  }
  const cloudAuth = `Basic ${Buffer.from(`${EMAIL}:${API_TOKEN}`).toString('base64')}`;
  const dcAuth = [
    `Bearer ${PAT}`,
    `Basic ${Buffer.from(`${SERVER_USER}:${SERVER_PASSWORD}`).toString('base64')}`,
  ];
  const refuse = (expected: string[]): boolean => {
    if (expected.includes(request.headers.authorization ?? '')) return false;
    json(401, { message: 'Unauthorized' });
    return true;
  };
  // CLOUD (API v2) : page par identifiant, espace par clé, page par titre, lien court.
  const cloud = /^\/wiki\/api\/v2\/pages\/(\d+)$/.exec(url.pathname);
  if (cloud && url.searchParams.get('body-format') === 'storage') {
    if (!refuse([cloudAuth])) json(200, cloudPage(cloud[1] ?? ''));
    return;
  }
  if (url.pathname === '/wiki/api/v2/spaces') {
    if (!refuse([cloudAuth]))
      json(200, { results: url.searchParams.get('keys') === 'DEM' ? [{ id: '98304', key: 'DEM' }] : [] });
    return;
  }
  if (url.pathname === '/wiki/api/v2/pages' && url.searchParams.get('body-format') === 'storage') {
    if (refuse([cloudAuth])) return;
    const found = url.searchParams.get('space-id') === '98304' && url.searchParams.get('title') === TITLE;
    json(200, { results: found ? [cloudPage('65538')] : [] });
    return;
  }
  if (url.pathname.startsWith('/wiki/x/')) {
    if (refuse([cloudAuth])) return;
    response.writeHead(302, {
      location:
        url.pathname === '/wiki/x/AgAB'
          ? '/wiki/spaces/DEM/pages/65538/Specification'
          : 'https://other.example.test/x',
    });
    response.end();
    return;
  }
  // DATA CENTER (API content), installé à la racine ou sous /confluence.
  const path = url.pathname.replace(/^\/confluence(?=\/)/, '');
  const dc = /^\/rest\/api\/content\/(\d+)$/.exec(path);
  if (dc && url.searchParams.get('expand') === 'body.storage,version,space') {
    if (!refuse(dcAuth)) json(200, datacenterPage(dc[1] ?? ''));
    return;
  }
  if (path === '/rest/api/content' && url.searchParams.get('expand') === 'body.storage,version,space') {
    if (refuse(dcAuth)) return;
    const found = url.searchParams.get('spaceKey') === 'DEM' && url.searchParams.get('title') === TITLE;
    json(200, { results: found ? [datacenterPage('4242')] : [], size: found ? 1 : 0 });
    return;
  }
  if (path.startsWith('/x/')) {
    if (refuse(dcAuth)) return;
    response.writeHead(302, {
      location: path === '/x/AgAB' ? '/pages/viewpage.action?pageId=4242' : '/display/DEM/Page+inconnue',
    });
    response.end();
    return;
  }
  json(404, { message: 'Not found' });
}

const env = {
  QA_CONFLUENCE_USER: EMAIL,
  QA_CONFLUENCE_TOKEN: API_TOKEN,
  QA_CONFLUENCE_PAT: PAT,
  QA_CONFLUENCE_SERVER_USER: SERVER_USER,
  QA_CONFLUENCE_SERVER_PASSWORD: SERVER_PASSWORD,
};
const context = (extra: Partial<{ signal: AbortSignal }> = {}) => ({
  now: new Date('2026-10-27T10:00:00Z'),
  env,
  ...extra,
});
const cloudInput = (extra: Partial<ConfluenceInput> = {}): ConfluenceInput => ({
  baseUrl: base,
  page: '65538',
  variant: 'cloud',
  auth: { userEnv: 'QA_CONFLUENCE_USER', tokenEnv: 'QA_CONFLUENCE_TOKEN' },
  ...extra,
});
const dcInput = (extra: Partial<ConfluenceInput> = {}): ConfluenceInput => ({
  baseUrl: base,
  page: `${base}/pages/viewpage.action?pageId=4242`,
  variant: 'datacenter',
  auth: { tokenEnv: 'QA_CONFLUENCE_PAT' },
  ...extra,
});

beforeAll(async () => {
  server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
});

describe('Confluence storage format → blocks', () => {
  const result = storageToBlocks(STORAGE);

  it('reads headings, paragraphs, layout macros, nested lists and tables, in reading order', () => {
    const summary = result.blocks.map((block) =>
      block.type === 'heading'
        ? `h${String(block.level)} ${block.text}`
        : block.type === 'paragraph'
          ? `p ${block.text}`
          : block.type === 'list'
            ? `list ${block.items.join(' | ')}`
            : `table ${block.header.join(',')} / ${block.rows.map((row) => row.join(',')).join(';')}`,
    );
    expect(summary).toEqual([
      'h1 Gestion des demandes',
      'p Cette page décrit les exigences du module de demandes (exemple fictif).',
      'h2 Exigences',
      'p REQ-101 : Créer une demande. Le système doit enregistrer une demande avec son titre.',
      'p Détails',
      'p RG-11 Le titre est obligatoire.',
      "list Étant donné un titre vide, quand on enregistre, alors un message d'erreur est affiché",
      'list Le message cite le champ',
      'table ID,Titre,Priorité,Statut / REQ-102,Rechercher une demande,Haute,VALIDÉE',
      'p Voir le glossaire et la norme.',
    ]);
  });

  it('says what it does not read: code, image, include macro (partial read); links are listed, never followed', () => {
    expect(result.issues.map((issue) => issue.code)).toEqual([
      'CODE_SKIPPED',
      'IMAGE_NOT_READ',
      'MACRO_NOT_EXPANDED',
    ]);
    expect(result.partial).toBe(true);
    expect(result.links.map((link) => link.target)).toEqual(['page:Glossaire', 'https://example.test/norme']);
  });

  it('repairs malformed markup and says so', () => {
    const repaired = storageToBlocks('<p>REQ-1 Texte <strong>gras</p><p>Suite');
    expect(repaired.blocks.map((block) => (block.type === 'paragraph' ? block.text : ''))).toEqual([
      'REQ-1 Texte gras',
      'Suite',
    ]);
    expect(repaired.issues[0]?.code).toBe('MARKUP_REPAIRED');
  });
});

describe('Confluence connector — simulated server', () => {
  const connector = new ConfluenceConnector();

  it('finds the page identifier in an identifier or a URL, and the variant from the host', () => {
    expect(pageIdOf('123')).toBe('123');
    expect(pageIdOf('https://example.atlassian.net/wiki/spaces/DEM/pages/65538/Spec')).toBe('65538');
    expect(pageIdOf('https://confluence.example.org/pages/viewpage.action?pageId=4242')).toBe('4242');
    expect(pageIdOf('https://confluence.example.org/display/DEM/Spec')).toBeUndefined();
    expect(variantOf({ baseUrl: 'https://example.atlassian.net' })).toBe('cloud');
    expect(variantOf({ baseUrl: 'https://confluence.example.org' })).toBe('datacenter');
  });

  it('validates before any request: https, page, QA_* variable names, defined secrets, Cloud email', () => {
    const codes = (input: ConfluenceInput, environment: NodeJS.ProcessEnv = env) =>
      connector.validate(input, { now: new Date(), env: environment }).map((issue) => issue.code);
    expect(codes(cloudInput())).toEqual([]);
    expect(codes(cloudInput({ baseUrl: 'http://confluence.example.org' }))).toEqual(['INVALID_INPUT']);
    expect(codes(cloudInput({ baseUrl: 'https://user:pass@confluence.example.org' }))).toEqual([
      'INVALID_INPUT',
    ]);
    expect(codes(cloudInput({ page: '/display/DEM/Spec' }))).toEqual(['INVALID_INPUT']);
    expect(codes(cloudInput({ auth: { userEnv: 'QA_CONFLUENCE_USER', tokenEnv: 'HOME' } }))).toEqual([
      'INVALID_INPUT',
    ]);
    expect(codes(cloudInput(), { QA_CONFLUENCE_USER: EMAIL })).toEqual(['AUTHENTICATION']);
    expect(codes(cloudInput({ auth: { tokenEnv: 'QA_CONFLUENCE_TOKEN' } }))).toEqual(['INVALID_INPUT']);
    expect(
      connector
        .validate(cloudInput(), { now: new Date(), env: {} })
        .map((issue) => issue.message)
        .join(' '),
    ).not.toContain(API_TOKEN);
  });

  it('Cloud: REST API v2, Basic with the email and the API token, version and provenance', async () => {
    mode = 'ok';
    seen.length = 0;
    const document = await connector.extract(cloudInput(), context());
    expect(seen).toEqual([
      {
        url: '/wiki/api/v2/pages/65538?body-format=storage',
        authorization: `Basic ${Buffer.from(`${EMAIL}:${API_TOKEN}`).toString('base64')}`,
      },
    ]);
    expect(document.source).toMatchObject({
      kind: 'CONFLUENCE',
      sourceId: `confluence:${new URL(base).host}:65538`,
      title: 'Spécification demandes (fictive)',
      uri: `${base}/wiki/spaces/DEM/pages/65538/Specification`,
      version: '7',
      modifiedAt: '2026-10-20T08:30:00.000Z',
    });
    expect(document.metadata).toEqual({ variant: 'cloud', spaceId: '98304' });
    expect(document.completeness).toBe('PARTIAL');
  });

  it('Data Center: content API, Bearer personal token, page URL, space key', async () => {
    mode = 'ok';
    seen.length = 0;
    const document = await connector.extract(dcInput(), context());
    expect(seen).toEqual([
      { url: '/rest/api/content/4242?expand=body.storage,version,space', authorization: `Bearer ${PAT}` },
    ]);
    expect(document.source).toMatchObject({
      version: '3',
      modifiedAt: '2026-10-21T09:00:00.000+02:00',
      uri: `${base}/pages/viewpage.action?pageId=4242`,
    });
    expect(document.metadata).toEqual({ variant: 'datacenter', space: 'DEM' });
  });

  it('reports access errors by code, without the secret', async () => {
    const failure = async (): Promise<{ code: string; message: string }> => {
      try {
        await connector.extract(cloudInput({ timeoutMs: 300 }), context());
      } catch (error) {
        return error as { code: string; message: string };
      }
      throw new Error('expected a failure');
    };
    for (const [current, code] of [
      ['401', 'AUTHENTICATION'],
      ['403', 'PERMISSION'],
      ['404', 'NOT_FOUND'],
      ['redirect', 'UNSUPPORTED'],
      ['not-json', 'CORRUPTED'],
      ['slow', 'TIMEOUT'],
    ] as const) {
      mode = current;
      const error = await failure();
      expect(error.code, current).toBe(code);
      expect(error.message).not.toContain(API_TOKEN);
      expect(error.message).not.toContain(EMAIL);
    }
    // La redirection n'est pas suivie : l'autorisation ne part pas vers l'autre hôte.
    expect(seen.some((entry) => entry.url.includes('login'))).toBe(false);
  });

  it('retries after a rate limit (Retry-After), then gives up with RATE_LIMITED', async () => {
    mode = '429-once';
    rateLimited = 0;
    const document = await connector.extract(cloudInput(), context());
    expect(document.source.version).toBe('7');
    expect(rateLimited).toBe(1);
    mode = '429-always';
    await expect(connector.extract(cloudInput({ maxRetries: 1 }), context())).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
  });

  it('refuses a page larger than the limit, an unreachable server and a cancelled import', async () => {
    mode = 'huge';
    await expect(connector.extract(cloudInput({ maxBytes: 1024 }), context())).rejects.toMatchObject({
      code: 'TOO_LARGE',
    });
    await expect(
      connector.extract(cloudInput({ baseUrl: 'http://127.0.0.1:9' }), context()),
    ).rejects.toMatchObject({ code: 'NETWORK' });
    mode = 'ok';
    const abort = new AbortController();
    abort.abort();
    await expect(connector.extract(cloudInput(), context({ signal: abort.signal }))).rejects.toMatchObject({
      code: 'CANCELLED',
    });
  });

  it('recognises every page address form, for both variants', () => {
    expect(pageRefOf('https://example.atlassian.net/wiki/display/DEM/Sp%C3%A9cification+demandes')).toEqual({
      spaceKey: 'DEM',
      title: 'Spécification demandes',
    });
    expect(pageRefOf('https://confluence.example.org/confluence/display/DEM/Page+A')).toEqual({
      spaceKey: 'DEM',
      title: 'Page A',
    });
    expect(
      pageRefOf('https://confluence.example.org/pages/viewpage.action?spaceKey=DEM&title=Page+A'),
    ).toEqual({
      spaceKey: 'DEM',
      title: 'Page A',
    });
    expect(pageRefOf('https://example.atlassian.net/wiki/x/AgAB')).toEqual({ tiny: 'AgAB' });
    expect(pageRefOf('https://confluence.example.org/x/AgAB')).toEqual({ tiny: 'AgAB' });
    expect(pageRefOf('https://confluence.example.org/dashboard.action')).toBeUndefined();
  });

  for (const [label, variant, page, expectedId] of [
    [
      'Cloud, /display/ address',
      'cloud',
      '/wiki/display/DEM/Sp%C3%A9cification+demandes+%28fictive%29',
      '65538',
    ],
    ['Cloud, short link', 'cloud', '/wiki/x/AgAB', '65538'],
    [
      'Data Center, /display/ address',
      'datacenter',
      '/display/DEM/Sp%C3%A9cification+demandes+%28fictive%29',
      '4242',
    ],
    [
      'Data Center, viewpage by space and title',
      'datacenter',
      `/pages/viewpage.action?spaceKey=DEM&title=${encodeURIComponent(TITLE)}`,
      '4242',
    ],
    ['Data Center, short link', 'datacenter', '/x/AgAB', '4242'],
  ] as const) {
    it(`${label}: the page is found by the official API`, async () => {
      mode = 'ok';
      const input =
        variant === 'cloud' ? cloudInput({ page: `${base}${page}` }) : dcInput({ page: `${base}${page}` });
      const document = await connector.extract(input, context());
      expect(document.source.sourceId).toBe(`confluence:${new URL(base).host}:${expectedId}`);
      expect(document.source.title).toBe(TITLE);
    });
  }

  it('Data Center under a context path, and older servers with a user and a password (Basic)', async () => {
    mode = 'ok';
    seen.length = 0;
    const document = await connector.extract(
      dcInput({
        baseUrl: `${base}/confluence`,
        page: '4242',
        auth: { userEnv: 'QA_CONFLUENCE_SERVER_USER', tokenEnv: 'QA_CONFLUENCE_SERVER_PASSWORD' },
      }),
      context(),
    );
    expect(seen[0]).toEqual({
      url: '/confluence/rest/api/content/4242?expand=body.storage,version,space',
      authorization: `Basic ${Buffer.from(`${SERVER_USER}:${SERVER_PASSWORD}`).toString('base64')}`,
    });
    expect(document.source.version).toBe('3');
  });

  it('says when a title, a space or a short link leads nowhere, and never follows a link to another host', async () => {
    mode = 'ok';
    await expect(
      connector.extract(dcInput({ page: `${base}/display/DEM/Page+inconnue` }), context()),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: expect.stringContaining('Page inconnue') as string,
    });
    await expect(
      connector.extract(cloudInput({ page: `${base}/wiki/display/AUTRE/Page` }), context()),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: expect.stringContaining('space AUTRE') as string,
    });
    await expect(connector.extract(dcInput({ page: `${base}/x/ZZZZ` }), context())).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    seen.length = 0;
    await expect(
      connector.extract(cloudInput({ page: `${base}/wiki/x/EVIL` }), context()),
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    });
    expect(seen.map((entry) => entry.url)).toEqual(['/wiki/x/EVIL']);
  });

  it('imports a page into a batch: candidates with Confluence provenance, partial read flagged, no secret stored', async () => {
    mode = 'ok';
    const dir = await mkdtemp(path.join(tmpdir(), 'req-confluence-'));
    try {
      const store = new RequirementsStore(dir);
      const batch = await importSource(store, connector, cloudInput(), context());
      expect(batch).toMatchObject({ connector: 'CONFLUENCE', status: 'PARTIAL', completeness: 'PARTIAL' });
      const ids = batch.items
        .filter((item) => item.externalId)
        .map((item) => [item.externalId, item.kind, item.confidence]);
      expect(ids).toEqual([
        ['REQ-101', 'REQUIREMENT', 'HIGH'],
        ['RG-11', 'BUSINESS_RULE', 'MEDIUM'],
        ['REQ-102', 'REQUIREMENT', 'HIGH'],
      ]);
      const req = batch.items.find((item) => item.externalId === 'REQ-101');
      expect(req?.source).toMatchObject({
        kind: 'CONFLUENCE',
        version: '7',
        location: { section: ['Gestion des demandes', 'Exigences'] },
      });
      expect(batch.items.find((item) => item.externalId === 'REQ-102')?.attributes).toEqual({
        priority: 'Haute',
        status: 'VALIDÉE',
      });
      expect(batch.items.find((item) => item.kind === 'ACCEPTANCE_CRITERION')?.criterion?.negative).toBe(
        true,
      );
      expect(batch.issues.map((issue) => issue.code)).toEqual([
        'CODE_SKIPPED',
        'IMAGE_NOT_READ',
        'MACRO_NOT_EXPANDED',
      ]);
      const stored = await readFile(path.join(dir, 'imports', `${batch.id}.json`), 'utf8');
      expect(stored).not.toContain(API_TOKEN);
      expect(stored).not.toContain(EMAIL);
      // Un échec d'accès devient un lot FAILED, avec son code.
      mode = '403';
      const denied = await importSource(store, connector, cloudInput(), context());
      expect(denied).toMatchObject({ status: 'FAILED', issues: [{ code: 'PERMISSION' }] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
