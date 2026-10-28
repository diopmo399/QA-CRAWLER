import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { JournalEntry, JournalKind, MemberView, Right, Role } from '../core/contracts.js';
import { RECORDING_CONTROLS, ROLE_RIGHTS, ROLES } from '../core/contracts.js';

/**
 * LES ACCÈS, côté serveur : des jetons nominatifs (un par personne ou par robot), leurs rôles dans
 * l'espace et par projet, et le journal des actions.
 *
 *   <espace>/.qa-access/members.json   les membres : nom, rôle, rôles par projet, EMPREINTE du jeton
 *   <espace>/.qa-access/journal.jsonl  le journal, une ligne par action (ajout seulement)
 *
 * Un jeton n'est jamais conservé en clair : seule son empreinte SHA-256 l'est ; il n'est rendu qu'à
 * sa création. Le jeton du service reste administrateur. Le journal ne contient ni corps de
 * requête, ni valeur saisie, ni secret, ni jeton.
 */
export const ACCESS_DIR = '.qa-access';
const MEMBERS_FILE = 'members.json';
const JOURNAL_FILE = 'journal.jsonl';
const MEMBER_ID = /^mbr_[A-Za-z0-9_-]{8,40}$/;
const MAX_NAME = 80;

export interface Identity {
  id: string;
  name: string;
  kind: 'SERVICE' | 'MEMBER';
  role: Role;
  projects: Record<string, Role>;
}

interface StoredMember extends MemberView {
  tokenHash: string;
}

export class AccessError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'INVALID_INPUT',
    message: string,
  ) {
    super(message);
    this.name = 'AccessError';
  }
}

const digest = (token: string): Buffer => createHash('sha256').update(token, 'utf8').digest();

export const isRole = (value: unknown): value is Role =>
  typeof value === 'string' && (ROLES as readonly string[]).includes(value);

/** Le rôle d'une identité dans un projet (son rôle propre au projet, sinon celui de l'espace). */
export function roleIn(identity: Identity, projectId?: string): Role {
  return (projectId ? identity.projects[projectId] : undefined) ?? identity.role;
}

export function can(identity: Identity, right: Right, projectId?: string): boolean {
  return ROLE_RIGHTS[roleIn(identity, projectId)].includes(right);
}

const publicMember = ({ tokenHash: _hash, ...member }: StoredMember): MemberView => member;

export class AccessStore {
  private members?: StoredMember[];
  private chain: Promise<unknown> = Promise.resolve();

  constructor(readonly workspace: string) {}

  private get dir(): string {
    return path.join(this.workspace, ACCESS_DIR);
  }

  private async load(): Promise<StoredMember[]> {
    if (this.members) return this.members;
    try {
      const parsed = JSON.parse(await readFile(path.join(this.dir, MEMBERS_FILE), 'utf8')) as {
        members?: StoredMember[];
      };
      this.members = Array.isArray(parsed.members) ? parsed.members : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.members = [];
    }
    return this.members;
  }

  /** Les modifications passent l'une après l'autre ; l'écriture est atomique. */
  private update<T>(change: (members: StoredMember[]) => T): Promise<T> {
    const next = this.chain.then(async () => {
      const members = await this.load();
      const result = change(members);
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const file = path.join(this.dir, MEMBERS_FILE);
      const temporary = `${file}.${randomBytes(4).toString('hex')}.tmp`;
      await writeFile(temporary, `${JSON.stringify({ formatVersion: 1, members }, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      await rename(temporary, file);
      return result;
    });
    this.chain = next.catch(() => undefined);
    return next;
  }

  async list(): Promise<MemberView[]> {
    return (await this.load()).map(publicMember);
  }

  /** Créer un membre : son jeton est rendu ici, une seule fois. */
  async create(
    input: { name: unknown; role: unknown },
    now = new Date(),
  ): Promise<{ member: MemberView; token: string }> {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (
      name === '' ||
      name.length > MAX_NAME ||
      Array.from({ length: name.length }, (_, index) => name.charCodeAt(index)).some((code) => code < 32)
    )
      throw new AccessError('INVALID_INPUT', `name is required (${String(MAX_NAME)} characters at most)`);
    if (!isRole(input.role))
      throw new AccessError('INVALID_INPUT', `role must be one of ${ROLES.join(', ')}`);
    const role = input.role;
    const token = `qa_${randomBytes(32).toString('base64url')}`;
    const member: StoredMember = {
      id: `mbr_${randomBytes(9).toString('base64url')}`,
      name,
      role,
      projects: {},
      createdAt: now.toISOString(),
      tokenHash: digest(token).toString('hex'),
    };
    await this.update((members) => members.push(member));
    return { member: publicMember(member), token };
  }

  /** Le rôle dans l'espace, ou dans un projet (`role: null` retire le rôle propre au projet). */
  async setRole(id: string, role: unknown, projectId?: string): Promise<MemberView> {
    if (projectId === undefined ? !isRole(role) : role !== null && !isRole(role))
      throw new AccessError('INVALID_INPUT', `role must be one of ${ROLES.join(', ')}`);
    return this.update((members) => {
      const member = members.find((candidate) => candidate.id === id && MEMBER_ID.test(id));
      if (!member) throw new AccessError('NOT_FOUND', `member ${id} not found`);
      if (projectId === undefined) member.role = role as Role;
      else if (role === null)
        member.projects = Object.fromEntries(
          Object.entries(member.projects).filter(([key]) => key !== projectId),
        );
      else member.projects[projectId] = role as Role;
      return publicMember(member);
    });
  }

  /** Révoquer : le jeton cesse de fonctionner ; le membre reste, pour le journal. */
  async revoke(id: string, now = new Date()): Promise<MemberView> {
    return this.update((members) => {
      const member = members.find((candidate) => candidate.id === id && MEMBER_ID.test(id));
      if (!member) throw new AccessError('NOT_FOUND', `member ${id} not found`);
      member.revokedAt ??= now.toISOString();
      return publicMember(member);
    });
  }

  /** Le membre dont c'est le jeton (comparaison des empreintes en temps constant), ou rien. */
  async resolve(token: string): Promise<Identity | undefined> {
    if (!token.startsWith('qa_')) return undefined;
    const given = digest(token);
    for (const member of await this.load()) {
      const stored = Buffer.from(member.tokenHash, 'hex');
      if (stored.length === given.length && timingSafeEqual(stored, given) && !member.revokedAt)
        return {
          id: member.id,
          name: member.name,
          kind: 'MEMBER',
          role: member.role,
          projects: { ...member.projects },
        };
    }
    return undefined;
  }

  async record(entry: JournalEntry): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await appendFile(path.join(this.dir, JOURNAL_FILE), `${JSON.stringify(entry)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  }

  /** Le journal, du plus récent au plus ancien. */
  async journal(
    options: { projectId?: string; kind?: JournalKind; limit?: number } = {},
  ): Promise<JournalEntry[]> {
    let text: string;
    try {
      text = await readFile(path.join(this.dir, JOURNAL_FILE), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 200) || 200, 1), 1000);
    const entries: JournalEntry[] = [];
    const lines = text.split('\n');
    for (let index = lines.length - 1; index >= 0 && entries.length < limit; index -= 1) {
      const line = lines[index]?.trim();
      if (!line) continue;
      let entry: JournalEntry;
      try {
        entry = JSON.parse(line) as JournalEntry;
      } catch {
        continue;
      }
      if (options.projectId && entry.projectId !== options.projectId) continue;
      if (options.kind && entry.kind !== options.kind) continue;
      entries.push(entry);
    }
    return entries;
  }
}

// ── Droits par route ──────────────────────────────────────────────────────────────────────────

/**
 * Le droit qu'une requête de l'API demande. Une lecture demande VIEW (sauf les accès). Une écriture
 * inconnue demande le droit le plus large : rien n'est permis par oubli. Une exécution qui permet
 * les écritures demande en plus RUN_WRITES (vérifié quand l'environnement est connu).
 */
export function rightFor(segments: readonly string[], method: string): Right {
  const [, resource, id, sub, item, action] = segments;
  if (resource === 'access') return id === 'me' && method === 'GET' ? 'VIEW' : 'MANAGE_ACCESS';
  if (method === 'GET' || method === 'HEAD') return 'VIEW';
  if (resource === 'checks') return 'RUN';
  if (resource === 'explorations') return sub === 'report-links' ? 'VIEW' : 'RUN';
  if (resource !== 'projects') return 'MANAGE_ACCESS';
  if (id === 'validate') return 'VIEW';
  if (id === undefined) return 'MANAGE_PROJECTS';
  switch (sub) {
    case 'config':
    case 'duplicate':
    case 'archive':
    case 'restore':
      return 'MANAGE_PROJECTS';
    case 'environments':
      return item === 'check' ? 'RUN' : 'MANAGE_ENVIRONMENTS';
    case 'scenarios':
      return 'PUBLISH';
    case 'executions':
    case 'explorations':
      return 'RUN';
    case 'recordings':
      // Démarrer, arrêter, et les commandes de la barre d'enregistrement : piloter une session.
      // Rejouer joue l'application, comme une exécution ; ouvrir une correction aussi (le chemin est
      // rejoué jusqu'à l'étape). Valider la correction est une décision.
      if (action === 'correction') return segments[6] === 'apply' ? 'DECIDE' : 'RUN';
      return item === undefined || action === 'stop' || action === 'replay' || LIVE_CONTROLS.has(action ?? '')
        ? 'RUN'
        : 'DECIDE';
    case 'reports':
      return 'VIEW';
    case 'requirements':
      // …/requirements/links[/:link] ; …/requirements/imports/:batch/publish
      return item === 'links' || segments[6] === 'publish' ? 'PUBLISH' : 'DECIDE';
    default:
      return 'MANAGE_ACCESS';
  }
}

const LIVE_CONTROLS = new Set<string>(RECORDING_CONTROLS);

const KEYWORDS = new Set([
  ...RECORDING_CONTROLS,
  'access',
  'me',
  'members',
  'revoke',
  'journal',
  'checks',
  'url',
  'env',
  'projects',
  'validate',
  'config',
  'duplicate',
  'archive',
  'restore',
  'environments',
  'check',
  'remove',
  'scenarios',
  'executions',
  'explorations',
  'cancel',
  'report-links',
  'recordings',
  'stop',
  'assertions',
  'data',
  'bindings',
  'groups',
  'generation',
  'steps',
  'proposals',
  'checks',
  'replay',
  'intents',
  'row',
  'correction',
  'apply',
  'resume',
  'close',
  'reports',
  'links',
  'requirements',
  'imports',
  'file',
  'decisions',
  'publish',
]);

/** L'action d'une requête, d'après les mots de sa route (les identifiants sont omis). */
export function actionOf(segments: readonly string[]): { action: string; kind: JournalKind } {
  const words = segments.slice(1).filter((segment) => KEYWORDS.has(segment));
  const action = words.join('.') || 'unknown';
  const kind: JournalKind = words.includes('access')
    ? 'ACCESS'
    : words.includes('requirements')
      ? 'REQUIREMENTS'
      : words.some((word) => ['executions', 'explorations', 'recordings', 'checks', 'check'].includes(word))
        ? 'RUN'
        : words.some((word) =>
              ['environments', 'config', 'duplicate', 'archive', 'restore', 'scenarios'].includes(word),
            ) ||
            (words.length === 1 && words[0] === 'projects')
          ? 'CONFIGURATION'
          : 'OTHER';
  return { action, kind };
}
