import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Un Artifactory SIMULÉ (pas le produit JFrog) qui reproduit ce dont le stockage objet dépend, d'après
 * l'API REST documentée : `/artifactory/api/storage/<dépôt>`, déploiement PUT (empreintes
 * `X-Checksum-Sha1` / `X-Checksum-Sha256` vérifiées, 409 si elles ne correspondent pas), GET, DELETE,
 * erreurs `{ errors: [{ status, message }] }`, jeton Bearer ou Basic, droits par utilisateur.
 */
export interface FakeArtifactory {
  url: string;
  /** Les fichiers stockés : « dépôt/chemin » → contenu. */
  files: Map<string, Buffer>;
  requests: { method: string; path: string }[];
  close(): Promise<void>;
}

export interface FakeArtifactoryUser {
  token?: string;
  username?: string;
  password?: string;
  canDeploy?: boolean;
  canDelete?: boolean;
}

export async function startFakeArtifactory(options: {
  repositories: string[];
  users: FakeArtifactoryUser[];
}): Promise<FakeArtifactory> {
  const files = new Map<string, Buffer>();
  const requests: { method: string; path: string }[] = [];
  const fail = (response: ServerResponse, status: number, message: string): void => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ errors: [{ status, message }] }));
  };
  const userOf = (request: IncomingMessage): FakeArtifactoryUser | undefined => {
    const header = request.headers.authorization ?? '';
    if (header.startsWith('Bearer ')) return options.users.find((u) => u.token === header.slice(7));
    if (header.startsWith('Basic ')) {
      const [username, ...rest] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
      return options.users.find((u) => u.username === username && u.password === rest.join(':'));
    }
    return undefined;
  };
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const method = request.method ?? 'GET';
      requests.push({ method, path: url.pathname });
      if (!url.pathname.startsWith('/artifactory/')) {
        fail(response, 404, 'Not Found');
        return;
      }
      const user = userOf(request);
      if (!user) {
        fail(response, 401, 'Bad credentials');
        return;
      }
      const rest = url.pathname.slice('/artifactory/'.length);
      if (rest.startsWith('api/storage/')) {
        const repository = decodeURIComponent(rest.slice('api/storage/'.length).split('/')[0] ?? '');
        if (!options.repositories.includes(repository)) {
          fail(response, 404, `Unable to find item`);
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ repo: repository, path: '/', children: [] }));
        return;
      }
      const [repoSegment, ...segments] = rest.split('/');
      const repository = decodeURIComponent(repoSegment ?? '');
      if (!options.repositories.includes(repository)) {
        fail(response, 404, `Repository ${repository} not found`);
        return;
      }
      const key = `${repository}/${segments.map((s) => decodeURIComponent(s)).join('/')}`;
      if (method === 'PUT') {
        if (!user.canDeploy) {
          fail(response, 403, 'Not enough permissions to deploy');
          return;
        }
        const body = Buffer.concat(chunks);
        const sha1 = createHash('sha1').update(body).digest('hex');
        const sha256 = createHash('sha256').update(body).digest('hex');
        const sentSha1 = request.headers['x-checksum-sha1'];
        const sentSha256 = request.headers['x-checksum-sha256'];
        if ((sentSha1 && sentSha1 !== sha1) || (sentSha256 && sentSha256 !== sha256)) {
          fail(response, 409, 'Checksum policy rejected the artifact: checksums do not match');
          return;
        }
        files.set(key, body);
        response.writeHead(201, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({ repo: repository, path: `/${segments.join('/')}`, checksums: { sha1, sha256 } }),
        );
        return;
      }
      if (method === 'GET') {
        const body = files.get(key);
        if (!body) {
          fail(response, 404, 'File not found.');
          return;
        }
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        response.end(body);
        return;
      }
      if (method === 'DELETE') {
        if (!user.canDelete) {
          fail(response, 403, 'Not enough permissions to delete');
          return;
        }
        if (!files.delete(key)) {
          fail(response, 404, 'Could not locate artifact');
          return;
        }
        response.writeHead(204);
        response.end();
        return;
      }
      fail(response, 405, 'Method Not Allowed');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}/artifactory`,
    files,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
