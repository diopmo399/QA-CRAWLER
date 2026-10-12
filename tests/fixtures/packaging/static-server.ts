import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

/**
 * Sert le dossier `public/` d'une fixture de packaging, plus une petite API (/api/items) pour la
 * fixture OpenAPI. Rien d'autre : la fixture n'est pas un vrai build de framework.
 */
export interface StaticApp {
  url: string;
  requests: string[];
  close(): Promise<void>;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const ITEMS = [
  { id: 1, label: 'Bolt' },
  { id: 2, label: 'Washer' },
];

export async function serveStaticApp(root: string, port = 0): Promise<StaticApp> {
  const requests: string[] = [];
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    requests.push(`${request.method ?? 'GET'} ${url.pathname}`);
    if (url.pathname === '/api/items') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(ITEMS));
      return;
    }
    const item = /^\/api\/items\/(\d+)$/.exec(url.pathname);
    if (item) {
      const found = ITEMS.find((candidate) => candidate.id === Number(item[1]));
      response.writeHead(found ? 200 : 404, { 'content-type': 'application/json' });
      response.end(JSON.stringify(found ?? { error: 'unknown item' }));
      return;
    }
    const relative = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    const file = path.join(root, 'public', relative);
    if (!file.startsWith(path.join(root, 'public'))) {
      response.writeHead(403).end();
      return;
    }
    void readFile(file).then(
      (content) => {
        response.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
        response.end(content);
      },
      () => {
        response.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<!doctype html><html lang="en"><body><h1>Not found</h1></body></html>');
      },
    );
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://localhost:${String(address.port)}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}
