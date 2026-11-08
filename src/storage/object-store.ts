import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Le stockage objet du stockage hybride : les fichiers lourds ou binaires du dossier de travail
 * (captures, traces, rapports HTML…). Une clé est un chemin relatif (`a/b/c`) ; le contenu est opaque.
 * Trois implémentations : un dossier (disque réseau monté, tests), S3 et compatibles (AWS, MinIO…),
 * Azure Blob Storage.
 */
export interface ObjectStore {
  readonly kind: 'filesystem' | 's3' | 'azure-blob';
  /** Où sont les objets, sans aucun secret (affiché dans l'état du stockage). */
  describe(): string;
  put(key: string, body: Buffer, contentType?: string): Promise<void>;
  /** undefined : l'objet n'existe pas. */
  get(key: string): Promise<Buffer | undefined>;
  /** Supprimer un objet absent n'est pas une erreur. */
  delete(key: string): Promise<void>;
  /** Le stockage répond-il ? Une erreur claire sinon (sans secret). */
  healthCheck(): Promise<void>;
}

/** Une clé d'objet sûre : segments non vides, sans `..`, sans chemin absolu ni caractère de contrôle. */
export function assertObjectKey(key: string): void {
  // eslint-disable-next-line no-control-regex
  if (key === '' || key.startsWith('/') || /[\\\u0000-\u001f]/.test(key))
    throw new Error(`invalid object key: ${JSON.stringify(key)}`);
  for (const segment of key.split('/'))
    if (segment === '' || segment === '.' || segment === '..')
      throw new Error(`invalid object key: ${JSON.stringify(key)}`);
}

/**
 * Les objets dans un dossier (par exemple un partage réseau monté). L'écriture passe par un fichier
 * temporaire renommé : un lecteur ne voit jamais un objet à moitié écrit.
 */
export class FilesystemObjectStore implements ObjectStore {
  readonly kind = 'filesystem' as const;
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  describe(): string {
    return this.root;
  }

  private file(key: string): string {
    assertObjectKey(key);
    return path.join(this.root, ...key.split('/'));
  }

  async put(key: string, body: Buffer): Promise<void> {
    const target = this.file(key);
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(temporary, body);
    await rename(temporary, target);
  }

  async get(key: string): Promise<Buffer | undefined> {
    return readFile(this.file(key)).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
  }

  async delete(key: string): Promise<void> {
    await rm(this.file(key), { force: true });
  }

  async healthCheck(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const probe = path.join(this.root, `.probe-${randomBytes(6).toString('hex')}`);
    await writeFile(probe, 'ok');
    await rm(probe, { force: true });
  }
}
