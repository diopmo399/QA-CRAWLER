import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AttachmentError,
  decodeAttachment,
  sanitizeAttachmentName,
  sniffAttachment,
} from '../../src/incident/attachments.js';
import {
  createQaCrawler,
  QaCrawlerError,
  type Project,
  type QaCrawlerClient,
} from '../../src/sdk/core/index.js';
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  type Incident,
} from '../../src/sdk/core/incident-contracts.js';
import { engineDefaults } from '../../src/sdk/server/project.js';
import { startSdkServer, type RunningSdkServer } from '../../src/sdk/server/server.js';

/**
 * LES PIÈCES JOINTES D'UN INCIDENT : le type déclaré est vérifié sur les octets, la taille et le nombre
 * sont bornés, le nom est nettoyé (aucun chemin) et le fichier est rangé sous son identifiant ; un texte
 * est rendu masqué ; lire, ajouter et retirer demandent le droit d'investiguer (RUN).
 */

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

const code = (run: () => unknown): string => {
  try {
    run();
    return 'accepted';
  } catch (error) {
    return error instanceof AttachmentError ? error.code : String(error);
  }
};

describe('attachments — names, content sniffing, size', () => {
  it('keeps only the last segment of a name, without control or reserved characters', () => {
    expect(sanitizeAttachmentName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeAttachmentName('..\\..\\Windows\\capture écran.png')).toBe('capture écran.png');
    expect(sanitizeAttachmentName('  journal\u0000\u0007 <serveur>.log ')).toBe('journal _serveur_.log');
    expect(sanitizeAttachmentName('.cache')).toBe('cache');
    expect(sanitizeAttachmentName('a\u202Egnp.exe')).toBe('agnp.exe');
    const long = sanitizeAttachmentName(`${'x'.repeat(300)}.json`);
    expect(long).toHaveLength(120);
    expect(long.endsWith('.json')).toBe(true);
    expect(code(() => sanitizeAttachmentName('..'))).toBe('INVALID');
    expect(code(() => sanitizeAttachmentName('dir/'))).toBe('INVALID');
    expect(code(() => sanitizeAttachmentName(42))).toBe('INVALID');
  });

  it('checks the bytes against the declared type', () => {
    const png = Buffer.from(PNG_1X1, 'base64');
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
    expect(
      code(() => {
        sniffAttachment('image/png', png);
      }),
    ).toBe('accepted');
    expect(
      code(() => {
        sniffAttachment('image/jpeg', jpeg);
      }),
    ).toBe('accepted');
    expect(
      code(() => {
        sniffAttachment('image/webp', webp);
      }),
    ).toBe('accepted');
    expect(
      code(() => {
        sniffAttachment('text/plain', Buffer.from('ligne 1\nligne 2 é'));
      }),
    ).toBe('accepted');
    expect(
      code(() => {
        sniffAttachment('application/json', Buffer.from('\uFEFF{"a":1}'));
      }),
    ).toBe('accepted');
    // Usurpations : un texte déclaré image, une image déclarée texte, un binaire, un JSON illisible.
    expect(
      code(() => {
        sniffAttachment('image/png', Buffer.from('not a png'));
      }),
    ).toBe('CONTENT_MISMATCH');
    expect(
      code(() => {
        sniffAttachment('image/jpeg', png);
      }),
    ).toBe('CONTENT_MISMATCH');
    expect(
      code(() => {
        sniffAttachment('image/webp', jpeg);
      }),
    ).toBe('CONTENT_MISMATCH');
    expect(
      code(() => {
        sniffAttachment('text/plain', png);
      }),
    ).toBe('CONTENT_MISMATCH');
    expect(
      code(() => {
        sniffAttachment('text/plain', Buffer.from([0x61, 0x00, 0x62]));
      }),
    ).toBe('CONTENT_MISMATCH');
    expect(
      code(() => {
        sniffAttachment('text/plain', Buffer.from([0xc3, 0x28]));
      }),
    ).toBe('CONTENT_MISMATCH');
    expect(
      code(() => {
        sniffAttachment('application/json', Buffer.from('{oops'));
      }),
    ).toBe('CONTENT_MISMATCH');
  });

  it('decodes strict base64 and refuses what is too large before decoding it', () => {
    expect(decodeAttachment(b64('bonjour')).toString('utf8')).toBe('bonjour');
    expect(code(() => decodeAttachment('***'))).toBe('INVALID');
    expect(code(() => decodeAttachment(''))).toBe('INVALID');
    expect(code(() => decodeAttachment(undefined))).toBe('INVALID');
    expect(code(() => decodeAttachment('A'.repeat(Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 8)))).toBe(
      'TOO_LARGE',
    );
    expect(
      code(() => decodeAttachment(Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 0x61).toString('base64'))),
    ).toBe('TOO_LARGE');
  });
});

let workspace: string;
let server: RunningSdkServer;
let admin: QaCrawlerClient;
let reader: QaCrawlerClient;
let project: Project;
let incident: Incident;
const clients: QaCrawlerClient[] = [];

const as = (token: string): QaCrawlerClient => {
  const client = createQaCrawler({ endpoint: `${server.url}/api`, token });
  clients.push(client);
  return client;
};

const refusal = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return 'accepted';
  } catch (error) {
    return error instanceof QaCrawlerError ? `${String(error.status)} ${error.code}` : String(error);
  }
};

const directoryOf = (incidentId: string): string =>
  path.join(workspace, project.id, 'incidents', incidentId, 'attachments');

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'incident-attachments-ws-'));
  server = await startSdkServer({ workspace, language: 'fr', access: 'named', env: {} });
  admin = as(server.token);
  reader = as((await admin.access.createMember({ name: 'Lecteur fictif', role: 'READER' })).token);
  project = await admin.projects.create({
    ...engineDefaults(),
    project: { name: 'Catalogue', targetUrl: 'http://127.0.0.1:9/', framework: 'other' },
  });
  incident = await admin.incidents.create(project.id, {
    title: 'Erreur 500 à la création d’un livre',
    description: 'Après Enregistrer, une erreur HTTP 500.',
    observed: 'Erreur HTTP 500',
    expected: 'Livre créé',
    severity: 'HIGH',
    application: 'Catalogue',
    kind: 'FUNCTIONAL',
  });
});

afterAll(async () => {
  for (const client of clients) client.dispose();
  await server.close();
  await rm(workspace, { recursive: true, force: true });
});

describe('attachments — routes', () => {
  it('declares application and kind through the API, and refuses an unknown kind', async () => {
    expect(incident).toMatchObject({ application: 'Catalogue', kind: 'FUNCTIONAL' });
    const updated = await admin.incidents.update(project.id, incident.id, incident.revision, {
      kind: 'PERFORMANCE',
    });
    expect(updated.kind).toBe('PERFORMANCE');
    incident = updated;
    expect(
      await refusal(
        admin.incidents.create(project.id, {
          title: 't',
          description: 'd',
          observed: 'o',
          expected: 'e',
          severity: 'LOW',
          kind: 'COSMETIC' as never,
        }),
      ),
    ).toBe('400 BAD_REQUEST');
  });

  it('stores an image under its id (never its name), reads it back as a data: URL', async () => {
    const saved = await admin.incidents.addAttachment(project.id, incident.id, {
      name: '../../../etc/capture.png',
      type: 'image/png',
      dataBase64: PNG_1X1,
    });
    const attachment = saved.attachments?.at(-1);
    expect(attachment).toMatchObject({ name: 'capture.png', type: 'image/png' });
    expect(typeof attachment?.addedBy).toBe('string');
    expect(attachment?.id).toMatch(/^att_[A-Za-z0-9_-]{12}$/);
    expect(attachment?.bytes).toBe(Buffer.from(PNG_1X1, 'base64').byteLength);
    expect(saved.history.at(-1)?.kind).toBe('ATTACHMENT');
    expect(await readdir(directoryOf(incident.id))).toEqual([attachment?.id]);
    const content = await admin.incidents.attachment(project.id, incident.id, attachment?.id ?? '');
    expect(content).toEqual({
      id: attachment?.id,
      type: 'image/png',
      dataUrl: `data:image/png;base64,${PNG_1X1}`,
    });
  });

  it('returns a text masked: secrets of a log and of a JSON export never leave the server', async () => {
    const log = await admin.incidents.addAttachment(project.id, incident.id, {
      name: 'serveur.log',
      type: 'text/plain',
      dataBase64: b64('ERROR 500 on POST /api/books\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz0123\n'),
    });
    const json = await admin.incidents.addAttachment(project.id, incident.id, {
      name: 'export.json',
      type: 'application/json',
      dataBase64: b64('{\n  "user": "alice",\n  "password": "hunter22-secret"\n}\n'),
    });
    const logText = await admin.incidents.attachment(
      project.id,
      incident.id,
      log.attachments?.at(-1)?.id ?? '',
    );
    const jsonText = await admin.incidents.attachment(
      project.id,
      incident.id,
      json.attachments?.at(-1)?.id ?? '',
    );
    expect('text' in logText && logText.text).toContain('ERROR 500 on POST /api/books');
    expect('text' in logText && logText.text).not.toContain('abcdefghijklmnopqrstuvwxyz0123');
    expect('text' in jsonText && jsonText.text).toContain('"user": "alice"');
    expect('text' in jsonText && jsonText.text).not.toContain('hunter22-secret');
  });

  it('refuses a type outside the list, a spoofed content, an oversize file, bad base64', async () => {
    const add = (input: { name: string; type: string; dataBase64: string }) =>
      refusal(admin.incidents.addAttachment(project.id, incident.id, input as never));
    expect(await add({ name: 'outil.exe', type: 'application/x-msdownload', dataBase64: b64('MZ') })).toBe(
      '415 UNSUPPORTED_TYPE',
    );
    expect(await add({ name: 'faux.png', type: 'image/png', dataBase64: b64('<script>x</script>') })).toBe(
      '415 CONTENT_MISMATCH',
    );
    expect(await add({ name: 'faux.txt', type: 'text/plain', dataBase64: PNG_1X1 })).toBe(
      '415 CONTENT_MISMATCH',
    );
    // Juste au-delà de la limite : le corps est accepté par le serveur, le contenu est refusé.
    const oversize = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 0x61).toString('base64');
    expect(await add({ name: 'gros.txt', type: 'text/plain', dataBase64: oversize })).toBe('413 TOO_LARGE');
    // Bien au-delà : le corps lui-même est refusé avant d'être lu en entier.
    expect(await add({ name: 'gros.txt', type: 'text/plain', dataBase64: oversize + oversize })).toBe(
      '413 TOO_LARGE',
    );
    expect(await add({ name: 'x.txt', type: 'text/plain', dataBase64: '%%%' })).toBe('400 BAD_REQUEST');
    expect(await add({ name: '../..', type: 'text/plain', dataBase64: b64('x') })).toBe('400 BAD_REQUEST');
    // Rien n'a été écrit pour ces refus.
    const current = await admin.incidents.get(project.id, incident.id);
    expect(await readdir(directoryOf(incident.id))).toHaveLength(current.attachments?.length ?? -1);
  });

  it('a reader sees the list but cannot read, add or remove an attachment (RUN)', async () => {
    const current = await reader.incidents.get(project.id, incident.id);
    const first = current.attachments?.[0];
    expect(first).toBeDefined();
    expect(await refusal(reader.incidents.attachment(project.id, incident.id, first?.id ?? ''))).toBe(
      '403 FORBIDDEN',
    );
    expect(
      await refusal(
        reader.incidents.addAttachment(project.id, incident.id, {
          name: 'a.txt',
          type: 'text/plain',
          dataBase64: b64('a'),
        }),
      ),
    ).toBe('403 FORBIDDEN');
    expect(await refusal(reader.incidents.removeAttachment(project.id, incident.id, first?.id ?? ''))).toBe(
      '403 FORBIDDEN',
    );
  });

  it('removes an attachment and its file; an unknown id is not found', async () => {
    const before = await admin.incidents.get(project.id, incident.id);
    const target = before.attachments?.[0];
    const after = await admin.incidents.removeAttachment(project.id, incident.id, target?.id ?? '');
    expect(after.attachments?.some((entry) => entry.id === target?.id)).toBe(false);
    expect(after.history.at(-1)).toMatchObject({ kind: 'ATTACHMENT' });
    await expect(stat(path.join(directoryOf(incident.id), target?.id ?? 'x'))).rejects.toThrow();
    expect(await refusal(admin.incidents.attachment(project.id, incident.id, target?.id ?? ''))).toBe(
      '404 NOT_FOUND',
    );
    expect(await refusal(admin.incidents.attachment(project.id, incident.id, '../../incident.json'))).toBe(
      '404 NOT_FOUND',
    );
    expect(await refusal(admin.incidents.removeAttachment(project.id, incident.id, 'att_000000000000'))).toBe(
      '404 NOT_FOUND',
    );
  });

  it(`holds at most ${String(MAX_ATTACHMENTS)} attachments, and none on a cancelled incident`, async () => {
    const other = await admin.incidents.create(project.id, {
      title: 'Plafond',
      description: 'd',
      observed: 'o',
      expected: 'e',
      severity: 'LOW',
    });
    for (let index = 0; index < MAX_ATTACHMENTS; index += 1)
      await admin.incidents.addAttachment(project.id, other.id, {
        name: `n${String(index)}.txt`,
        type: 'text/plain',
        dataBase64: b64(`ligne ${String(index)}`),
      });
    const extra = { name: 'trop.txt', type: 'text/plain' as const, dataBase64: b64('trop') };
    expect(await refusal(admin.incidents.addAttachment(project.id, other.id, extra))).toBe('409 TOO_MANY');
    expect(await readdir(directoryOf(other.id))).toHaveLength(MAX_ATTACHMENTS);
    await admin.incidents.cancel(project.id, incident.id);
    expect(await refusal(admin.incidents.addAttachment(project.id, incident.id, extra))).toBe('409 STATE');
    // La liste des incidents ignore le dossier des pièces jointes.
    expect((await admin.incidents.list(project.id)).map((entry) => entry.id).sort()).toEqual(
      [incident.id, other.id].sort(),
    );
  });
});
