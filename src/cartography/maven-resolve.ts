import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseJava, type JavaFile } from '../incident/code/java-parser.js';
import type { MavenArtifactStatus } from '../sdk/core/cartography.js';
import { openZip, type ZipArchive } from '../requirements/connectors/zip.js';
import { analyzeMaven } from './analyze-maven.js';
import { ClassFileError, readClassFile } from './classfile.js';
import type { MavenDependency, MavenModule } from './facts.js';
import type { ReadFile } from './files.js';
import type { ExternalParsed } from './java-hierarchy.js';

/**
 * LES CONTRATS DES DÉPENDANCES MAVEN. Pour une source Java dont un contrôleur implémente (ou un service appelle)
 * un type absent des sources, ses dépendances sont résolues à partir de ses pom, seule (le BFF et le Backend
 * n'ont ni les mêmes contrats ni les mêmes versions), puis les types manquants sont lus dans leurs jars : le
 * jar de sources s'il existe, sinon les classes compilées (bytecode lu, jamais chargé ni exécuté).
 *
 * Ordre de recherche d'un artefact : dépôts locaux (cache Maven de l'opérateur, en lecture seule), cache des
 * téléchargements, puis dépôts distants AUTORISÉS (https, sans redirection, identifiants lus dans des
 * variables d'environnement et jamais affichés), avec empreinte SHA-1 vérifiée. Hors ligne : rien n'est
 * contacté. Aucun plugin Maven n'est exécuté : le modèle des pom est lu (parents, propriétés, BOM importés,
 * dependencyManagement, scopes, exclusions, dépendances optionnelles, la plus proche l'emporte).
 */

export interface MavenRemote {
  /** L'identifiant affiché dans les diagnostics (jamais l'adresse complète ni un secret). */
  id: string;
  url: string;
  /** Les noms des variables d'environnement qui portent l'authentification (jamais les valeurs). */
  usernameEnv?: string;
  passwordEnv?: string;
  tokenEnv?: string;
}

export interface MavenLimits {
  /** Profondeur des dépendances indirectes suivies (1 : déclarées seulement). */
  maxDepth: number;
  maxPoms: number;
  /** Jars ouverts pour chercher des types. */
  maxJars: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  requestTimeoutMs: number;
  maxDurationMs: number;
}

export const DEFAULT_MAVEN_LIMITS: MavenLimits = {
  maxDepth: 4,
  maxPoms: 300,
  maxJars: 40,
  maxFileBytes: 20 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
  requestTimeoutMs: 15_000,
  maxDurationMs: 60_000,
};

export interface MavenOptions {
  /** Les dépôts locaux lus (ex. `~/.m2/repository`), réglés par l'opérateur du serveur ; jamais écrits. */
  local: readonly string[];
  /** Les dépôts distants autorisés ; vide : aucun. */
  remote: readonly MavenRemote[];
  /** Où les téléchargements sont gardés (rangement d'un dépôt Maven) ; requis pour un dépôt distant. */
  cacheDir?: string;
  /** Hors ligne : seuls les dépôts locaux et le cache sont lus. */
  offline?: boolean;
  /** Autorise `http://` vers l'adresse de boucle (dépôt de test) ; jamais vers un autre hôte. */
  allowLoopbackHttp?: boolean;
  limits?: Partial<MavenLimits>;
  /** L'environnement où lire les identifiants (défaut : `process.env`). */
  env?: Readonly<Record<string, string | undefined>>;
  /** Le client HTTP (défaut : fetch). */
  fetch?: typeof fetch;
}

export interface ContractResolution {
  external: ExternalParsed[];
  artifacts: MavenArtifactStatus[];
  /** Les types cherchés et introuvables dans les dépendances lues. */
  unresolved: string[];
  notes: string[];
}

/** Les groupes de bibliothèques connues : leurs jars ne portent pas les contrats d'une application. */
const LIBRARY_GROUP =
  /^(org\.springframework|org\.apache|org\.hibernate|org\.slf4j|ch\.qos|com\.fasterxml|io\.micrometer|io\.projectreactor|io\.netty|jakarta|javax|org\.junit|org\.mockito|org\.assertj|org\.yaml|com\.google|io\.swagger|org\.springdoc|org\.openapitools|org\.projectlombok|org\.jboss|org\.glassfish|org\.eclipse|com\.zaxxer|org\.postgresql|com\.h2database|org\.liquibase|org\.flywaydb|org\.aspectj|net\.bytebuddy|org\.ow2|commons-|io\.github\.openfeign|org\.mapstruct)(\.|$)/;

const coords = (d: { groupId?: string; artifactId: string; version?: string; classifier?: string }): string =>
  `${d.groupId ?? '?'}:${d.artifactId}:${d.version ?? '?'}${d.classifier ? `:${d.classifier}` : ''}`;
const key = (d: { groupId?: string; artifactId: string }): string => `${d.groupId ?? '?'}:${d.artifactId}`;
const repoPath = (g: string, a: string, v: string, file: string): string =>
  `${g.replace(/\./g, '/')}/${a}/${v}/${file}`;
const sha1 = (data: Uint8Array): string => createHash('sha1').update(data).digest('hex');
const isLoopback = (host: string): boolean =>
  host === 'localhost' || host === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(host);

type Fetched =
  | { ok: true; data: Buffer; origin: 'LOCAL' | 'CACHE' | 'REMOTE'; repository: string; sha1: string }
  | { ok: false; state: MavenArtifactStatus['state']; note: string };

/** L'accès aux artefacts : dépôts locaux, cache, dépôts distants autorisés ; budgets et empreintes. */
class Repository {
  private readonly limits: MavenLimits;
  private readonly started = Date.now();
  private bytes = 0;
  constructor(
    private readonly options: MavenOptions,
    private readonly signal?: AbortSignal,
  ) {
    this.limits = { ...DEFAULT_MAVEN_LIMITS, ...(options.limits ?? {}) };
  }
  get budget(): MavenLimits {
    return this.limits;
  }
  expired(): boolean {
    return Date.now() - this.started > this.limits.maxDurationMs || this.signal?.aborted === true;
  }

  /** Les fichiers déjà cherchés pendant cette résolution : jamais demandés deux fois. */
  private readonly memo = new Map<string, Promise<Fetched>>();

  /** Un fichier d'artefact ; `localOnly` : sans dépôt distant (fichier complémentaire d'un artefact local). */
  get(g: string, a: string, v: string, file: string, localOnly = false): Promise<Fetched> {
    const id = `${repoPath(g, a, v, file)}|${String(localOnly)}`;
    const known = this.memo.get(id);
    if (known) return known;
    const pending = this.lookup(g, a, v, file, localOnly);
    this.memo.set(id, pending);
    return pending;
  }

  private async lookup(g: string, a: string, v: string, file: string, localOnly: boolean): Promise<Fetched> {
    if (this.expired()) return { ok: false, state: 'BUDGET', note: 'durée maximale de résolution atteinte' };
    const rel = repoPath(g, a, v, file);
    for (const [index, dir] of this.options.local.entries()) {
      const hit = await this.readLocal(path.join(dir, rel));
      if (hit) return hit.ok ? { ...hit, origin: 'LOCAL', repository: `local-${String(index + 1)}` } : hit;
    }
    if (this.options.cacheDir) {
      const hit = await this.readLocal(path.join(this.options.cacheDir, rel));
      if (hit) return hit.ok ? { ...hit, origin: 'CACHE', repository: 'cache' } : hit;
    }
    if (localOnly) return { ok: false, state: 'NOT_FOUND', note: 'absent des dépôts locaux' };
    if (this.options.remote.length === 0)
      return {
        ok: false,
        state: 'NOT_FOUND',
        note: 'absent des dépôts locaux ; aucun dépôt distant autorisé',
      };
    if (this.options.offline)
      return {
        ok: false,
        state: 'OFFLINE',
        note: 'absent des dépôts locaux ; mode hors ligne : aucun dépôt contacté',
      };
    if (!this.options.cacheDir)
      return { ok: false, state: 'NOT_FOUND', note: 'aucun dossier de cache réglé pour les téléchargements' };
    let last: Extract<Fetched, { ok: false }> = {
      ok: false,
      state: 'NOT_FOUND',
      note: 'absent des dépôts autorisés',
    };
    for (const remote of this.options.remote) {
      const got = await this.download(remote, rel);
      if (got.ok) return got;
      // Un refus ou une empreinte fausse est gardé de préférence à un simple « absent ».
      if (last.state === 'NOT_FOUND') last = got;
    }
    return last;
  }

  private async readLocal(file: string): Promise<Fetched | undefined> {
    const info = await stat(file).catch(() => undefined);
    if (!info?.isFile()) return undefined;
    if (info.size > this.limits.maxFileBytes)
      return {
        ok: false,
        state: 'TOO_LARGE',
        note: `fichier de ${String(info.size)} octets (limite ${String(this.limits.maxFileBytes)})`,
      };
    const data = await readFile(file);
    // Une empreinte publiée à côté (dépôt ou cache) est vérifiée ; sans elle, le fichier est lu tel quel.
    const published = await readFile(`${file}.sha1`, 'utf8').catch(() => undefined);
    const digest = sha1(data);
    if (published && published.trim().split(/\s+/)[0]?.toLowerCase() !== digest)
      return {
        ok: false,
        state: 'INTEGRITY',
        note: `empreinte SHA-1 différente de ${path.basename(file)}.sha1`,
      };
    return { ok: true, data, origin: 'LOCAL', repository: '', sha1: digest };
  }

  private async download(remote: MavenRemote, rel: string): Promise<Fetched> {
    let url: URL;
    try {
      url = new URL(`${remote.url.replace(/\/+$/, '')}/${rel}`);
    } catch {
      return { ok: false, state: 'DENIED', note: `adresse du dépôt ${remote.id} illisible` };
    }
    const loopback = isLoopback(url.hostname);
    if (
      url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && loopback && this.options.allowLoopbackHttp)
    )
      return { ok: false, state: 'DENIED', note: `dépôt ${remote.id} : seul https est autorisé` };
    if (url.username || url.password)
      return { ok: false, state: 'DENIED', note: `dépôt ${remote.id} : identifiants dans l'adresse refusés` };
    const env = this.options.env ?? process.env;
    const headers: Record<string, string> = { 'user-agent': 'qa-crawler-maven' };
    if (remote.tokenEnv) {
      const token = env[remote.tokenEnv];
      if (!token)
        return {
          ok: false,
          state: 'DENIED',
          note: `dépôt ${remote.id} : variable ${remote.tokenEnv} absente`,
        };
      headers.authorization = `Bearer ${token}`;
    } else if (remote.usernameEnv || remote.passwordEnv) {
      const user = remote.usernameEnv ? env[remote.usernameEnv] : undefined;
      const pass = remote.passwordEnv ? env[remote.passwordEnv] : undefined;
      if (user === undefined || pass === undefined)
        return {
          ok: false,
          state: 'DENIED',
          note: `dépôt ${remote.id} : identifiants absents de l'environnement`,
        };
      headers.authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
    }
    const get = async (target: URL): Promise<{ status: number; data?: Buffer; note?: string }> => {
      const fetcher = this.options.fetch ?? fetch;
      const timeout = AbortSignal.timeout(this.limits.requestTimeoutMs);
      const signal = this.signal ? AbortSignal.any([timeout, this.signal]) : timeout;
      let response: Response;
      try {
        response = await fetcher(target, { headers, redirect: 'manual', signal });
      } catch (error) {
        return {
          status: 0,
          note: (error as Error).name === 'TimeoutError' ? 'délai dépassé' : 'dépôt injoignable',
        };
      }
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        return { status: response.status };
      }
      const declared = Number(response.headers.get('content-length') ?? '0');
      if (declared > this.limits.maxFileBytes) {
        await response.body?.cancel().catch(() => undefined);
        return { status: 413 };
      }
      // Lecture plafonnée : une réponse plus longue que la limite est abandonnée.
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = response.body?.getReader();
      for (;;) {
        if (!reader) break;
        const part = await reader.read();
        if (part.done) break;
        const chunk: Uint8Array = part.value;
        size += chunk.length;
        if (size > this.limits.maxFileBytes || this.bytes + size > this.limits.maxTotalBytes) {
          await reader.cancel().catch(() => undefined);
          return { status: 413 };
        }
        chunks.push(chunk);
      }
      this.bytes += size;
      return { status: 200, data: Buffer.concat(chunks) };
    };
    const main = await get(url);
    if (main.status === 0)
      return { ok: false, state: 'ERROR', note: `dépôt ${remote.id} : ${main.note ?? ''}` };
    if (main.status === 401 || main.status === 403)
      return {
        ok: false,
        state: 'DENIED',
        note: `dépôt ${remote.id} : accès refusé (${String(main.status)})`,
      };
    if (main.status >= 300 && main.status < 400)
      return { ok: false, state: 'DENIED', note: `dépôt ${remote.id} : redirection non suivie` };
    if (main.status === 413)
      return { ok: false, state: 'TOO_LARGE', note: `dépôt ${remote.id} : fichier au-delà des limites` };
    if (main.status !== 200 || !main.data)
      return { ok: false, state: 'NOT_FOUND', note: `absent du dépôt ${remote.id}` };
    const digest = sha1(main.data);
    const check = await get(new URL(`${url.toString()}.sha1`));
    const published =
      check.status === 200 ? check.data?.toString('utf8').trim().split(/\s+/)[0]?.toLowerCase() : undefined;
    if (published && published !== digest)
      return {
        ok: false,
        state: 'INTEGRITY',
        note: `dépôt ${remote.id} : empreinte SHA-1 publiée différente : fichier refusé`,
      };
    // Gardé dans le cache (écriture atomique), avec son empreinte : une analyse suivante ne le retélécharge pas.
    const target = path.join(this.options.cacheDir ?? '', rel);
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${String(process.pid)}.${String(Date.now())}.tmp`;
    await writeFile(temporary, main.data);
    await rename(temporary, target);
    await writeFile(`${target}.sha1`, digest);
    return {
      ok: true,
      data: main.data,
      origin: 'REMOTE',
      repository: remote.id,
      sha1: digest,
    };
  }
}

/** Le modèle effectif d'un pom du dépôt (ses parents lus aussi dans le dépôt), mémorisé. */
interface Effective {
  module: MavenModule;
  /** Les versions gérées : du pom, de ses parents, et des BOM importés. */
  managed: MavenDependency[];
}

/** Les archives déjà ouvertes, par empreinte : une même version n'est lue qu'une fois tant que le serveur tourne. */
const ARCHIVES = new Map<string, { zip: ZipArchive; names: Set<string> }>();
const MAX_ARCHIVES = 64;

export async function resolveContracts(input: {
  sourceId: string;
  /** Les pom.xml de la source. */
  poms: readonly ReadFile[];
  /** Les noms qualifiés des types cherchés (absents des sources). */
  needed: readonly string[];
  /** Les noms qualifiés des types des sources (jamais remplacés par ceux d'un jar). */
  known: ReadonlySet<string>;
  options: MavenOptions;
  signal?: AbortSignal;
}): Promise<ContractResolution> {
  const repo = new Repository(input.options, input.signal);
  const limits = repo.budget;
  const notes: string[] = [];
  const statuses = new Map<string, MavenArtifactStatus>();
  const effective = new Map<string, Effective | undefined>();
  let poms = 0;

  // ── Le modèle effectif d'un pom : parents lus dans le dépôt, propriétés résolues par analyzeMaven. ──
  const pomFile = async (g: string, a: string, v: string): Promise<ReadFile | Fetched> => {
    const got = await repo.get(g, a, v, `${a}-${v}.pom`);
    if (!got.ok) return got;
    return {
      path: `@repo/${repoPath(g, a, v, `${a}-${v}.pom`)}`,
      text: got.data.toString('utf8'),
      hash: got.sha1,
      bytes: got.data.length,
    };
  };
  /** Les pom d'une lignée (le pom, puis ses parents absents de l'ensemble), lus jusqu'à 10 niveaux. */
  const withParents = async (files: ReadFile[]): Promise<ReadFile[]> => {
    const out = [...files];
    for (let round = 0; round < 10; round++) {
      const modules = analyzeMaven(out).modules;
      const missing = modules
        .map((m) => m.parent)
        .filter(
          (p): p is NonNullable<MavenModule['parent']> =>
            !!p?.version &&
            !!p.groupId &&
            !modules.some(
              (m) => m.artifactId === p.artifactId && (m.groupId ?? m.parent?.groupId) === p.groupId,
            ),
        );
      if (missing.length === 0) break;
      let added = false;
      for (const parent of missing) {
        if (++poms > limits.maxPoms) return out;
        const file = await pomFile(parent.groupId ?? '', parent.artifactId, parent.version ?? '');
        if ('text' in file) {
          out.push(file);
          added = true;
        } else notes.push(`parent ${coords(parent)} : ${file.ok ? '' : file.note}`);
      }
      if (!added) break;
    }
    return out;
  };
  /** Les versions gérées d'un module, BOM importés compris (lus dans le dépôt, récursivement). */
  const managedOf = async (lineage: readonly MavenModule[], depth = 0): Promise<MavenDependency[]> => {
    const own = lineage.flatMap((m) => m.managed);
    const out: MavenDependency[] = [];
    for (const m of own) {
      if (m.scope === 'import' && m.type === 'pom' && m.groupId && m.version && depth < 5) {
        const bom = await loadEffective(m.groupId, m.artifactId, m.version, depth + 1);
        if (bom) out.push(...bom.managed);
        else notes.push(`BOM ${coords(m)} illisible : ses versions gérées ne sont pas connues`);
      } else out.push(m);
    }
    return out;
  };
  const loadEffective = async (
    g: string,
    a: string,
    v: string,
    depth = 0,
  ): Promise<Effective | undefined> => {
    const k = `${g}:${a}:${v}`;
    if (effective.has(k)) return effective.get(k);
    effective.set(k, undefined);
    if (++poms > limits.maxPoms) return undefined;
    const file = await pomFile(g, a, v);
    if (!('text' in file)) return undefined;
    const files = await withParents([file]);
    const modules = analyzeMaven(files).modules;
    const module = modules.find((m) => m.file === file.path);
    if (!module) return undefined;
    const lineage = lineageOf(module, modules);
    const result: Effective = { module, managed: await managedOf(lineage, depth) };
    effective.set(k, result);
    return result;
  };

  // ── Les modules de la source : leur lignée complétée par les parents du dépôt. ──
  const sourceFiles = await withParents([...input.poms]);
  const sourceModules = analyzeMaven(sourceFiles).modules;
  const roots = sourceModules.filter((m) => !m.file.startsWith('@repo/') && m.packaging !== 'pom');
  const ownCoords = new Set(
    sourceModules.map((m) => key({ groupId: m.groupId ?? m.parent?.groupId, artifactId: m.artifactId })),
  );

  // ── Les dépendances, la plus proche l'emporte ; versions gérées par la racine, exclusions par chemin. ──
  interface Pending {
    dep: MavenDependency;
    depth: number;
    via?: string;
    exclusions: string[];
    rootManaged: MavenDependency[];
  }
  const queue: Pending[] = [];
  for (const root of roots) {
    const lineage = lineageOf(root, sourceModules);
    const rootManaged = await managedOf(lineage);
    for (const dep of root.dependencies) {
      if (dep.scope === 'test' || dep.scope === 'system' || dep.scope === 'import') continue;
      const version = dep.version ?? rootManaged.find((m) => key(m) === key(dep))?.version;
      queue.push({
        dep: { ...dep, ...(version ? { version } : {}) },
        depth: 1,
        exclusions: dep.exclusions ?? [],
        rootManaged,
      });
    }
  }
  const order: string[] = [];
  const excluded = (list: readonly string[], d: MavenDependency): boolean =>
    list.some((e) => {
      const [g, a] = e.split(':');
      return (g === '*' || g === d.groupId) && (a === '*' || a === d.artifactId);
    });
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) break;
    const { dep, depth } = next;
    const k = key(dep);
    if (ownCoords.has(k)) continue; // Un module de la même source : ses types sont déjà lus.
    const seen = statuses.get(k);
    if (seen) {
      // La plus proche l'emporte ; une autre version demandée est notée comme conflit.
      if (
        dep.version &&
        !seen.coordinates.endsWith(`:${dep.version}`) &&
        !(seen.conflicts ?? []).includes(dep.version)
      )
        (seen.conflicts ??= []).push(dep.version);
      continue;
    }
    const status: MavenArtifactStatus = {
      coordinates: coords(dep),
      ...(dep.scope ? { scope: dep.scope } : {}),
      depth,
      ...(next.via ? { requestedBy: next.via } : {}),
      state: 'RESOLVED',
    };
    statuses.set(k, status);
    order.push(k);
    if (!dep.groupId || !dep.version || /\$\{/.test(`${dep.groupId}${dep.version}`)) {
      status.state = 'NO_VERSION';
      status.note = 'version non établie (propriété ou gestion de version introuvable)';
      continue;
    }
    if (LIBRARY_GROUP.test(dep.groupId)) {
      status.state = 'LIBRARY';
      status.note = 'bibliothèque connue : non analysée';
      continue;
    }
    const model = await loadEffective(dep.groupId, dep.artifactId, dep.version);
    if (!model) {
      const probe = await repo.get(
        dep.groupId,
        dep.artifactId,
        dep.version,
        `${dep.artifactId}-${dep.version}.pom`,
      );
      status.state = probe.ok ? 'ERROR' : probe.state;
      status.note = probe.ok ? 'pom illisible' : probe.note;
      if (probe.ok) Object.assign(status, { origin: probe.origin, repository: probe.repository });
      continue;
    }
    status.read = ['POM'];
    if (depth >= limits.maxDepth) continue;
    for (const child of model.module.dependencies) {
      // Les dépendances indirectes : compile et runtime seulement ; optionnelles et exclues : non suivies.
      if (child.optional || (child.scope && !['compile', 'runtime'].includes(child.scope))) continue;
      if (excluded(next.exclusions, child)) continue;
      const managedByRoot = next.rootManaged.find((m) => key(m) === key(child))?.version;
      const version =
        managedByRoot ?? child.version ?? model.managed.find((m) => key(m) === key(child))?.version;
      queue.push({
        dep: { ...child, ...(version ? { version } : {}) },
        depth: depth + 1,
        via: status.coordinates,
        exclusions: [...next.exclusions, ...(child.exclusions ?? [])],
        rootManaged: next.rootManaged,
      });
    }
  }

  // ── Les types cherchés : lus dans les jars, à la demande, avec leurs types parents. ──
  const external: ExternalParsed[] = [];
  const wanted = new Set(input.needed.filter((n) => !input.known.has(n)));
  const done = new Set<string>();
  const candidates = order
    .map((k) => statuses.get(k))
    .filter((s): s is MavenArtifactStatus => s?.state === 'RESOLVED')
    .sort((a, b) => affinity(b.coordinates, wanted) - affinity(a.coordinates, wanted) || a.depth - b.depth);
  let jars = 0;
  for (const status of candidates) {
    if ([...wanted].every((w) => done.has(w))) break;
    if (jars >= limits.maxJars || repo.expired()) {
      status.note = `${status.note ? `${status.note} ; ` : ''}jar non ouvert (budget)`;
      continue;
    }
    jars++;
    const [g = '', a = '', v = ''] = status.coordinates.split(':');
    // Les classes d'abord ; le jar de sources n'est demandé à un dépôt distant que si les classes en viennent
    // aussi (un artefact déjà présent localement ne déclenche aucun téléchargement de plus).
    const classes = await openArchive(repo, g, a, v, `${a}-${v}.jar`);
    const local = !classes.fetched?.ok || classes.fetched.origin !== 'REMOTE';
    const sources = await openArchive(repo, g, a, v, `${a}-${v}-sources.jar`, local);
    if (!classes.archive && !sources.archive) {
      status.note = classes.note ?? sources.note ?? 'jar absent';
      // Un jar refusé (empreinte, taille, accès, budget) : l'artefact n'est pas lu, son état le dit.
      if (classes.fetched && !classes.fetched.ok && classes.fetched.state !== 'NOT_FOUND')
        status.state = classes.fetched.state;
      continue;
    }
    if (classes.fetched?.ok)
      Object.assign(status, {
        origin: classes.fetched.origin,
        repository: classes.fetched.repository,
        sha1: classes.fetched.sha1,
      });
    // Les types cherchés et leurs parents, tant qu'il en reste dans cet artefact.
    for (let progress = true; progress;) {
      progress = false;
      for (const name of [...wanted]) {
        if (done.has(name)) continue;
        const parsed = readType(name, status.coordinates, sources.archive, classes.archive, notes);
        if (!parsed) continue;
        done.add(name);
        progress = true;
        external.push(parsed);
        (status.types ??= []).push(name);
        const read = status.read ?? [];
        if (!read.includes(parsed.read)) read.push(parsed.read);
        status.read = read;
        for (const parent of supertypes(parsed)) if (!input.known.has(parent)) wanted.add(parent);
      }
    }
  }
  const unresolved = [...wanted].filter((w) => !done.has(w)).sort();
  return {
    external,
    artifacts: order.map((k) => statuses.get(k)).filter((s): s is MavenArtifactStatus => !!s),
    unresolved,
    notes: notes.slice(0, 50),
  };
}

/** La lignée d'un module dans un ensemble (lui, puis ses parents trouvés), comme le lit analyzeMaven. */
function lineageOf(module: MavenModule, modules: readonly MavenModule[]): MavenModule[] {
  const out = [module];
  let cur = module;
  while (cur.parent && out.length < 10) {
    const p = cur.parent;
    const from = cur;
    const next = modules.find(
      (m) =>
        m !== from &&
        m.artifactId === p.artifactId &&
        (!p.groupId || (m.groupId ?? m.parent?.groupId) === p.groupId),
    );
    if (!next || out.includes(next)) break;
    out.push(next);
    cur = next;
  }
  return out;
}

/** Un classement (jamais une preuve) : un groupe qui partage le début d'un paquet cherché est ouvert d'abord. */
function affinity(coordinates: string, wanted: ReadonlySet<string>): number {
  const group = (coordinates.split(':')[0] ?? '').split('.');
  let best = 0;
  for (const name of wanted) {
    const parts = name.split('.');
    let n = 0;
    while (n < group.length && n < parts.length && group[n] === parts[n]) n++;
    best = Math.max(best, n);
  }
  return best;
}

async function openArchive(
  repo: Repository,
  g: string,
  a: string,
  v: string,
  file: string,
  localOnly = false,
): Promise<{ archive?: ZipArchive; fetched?: Fetched; note?: string }> {
  const fetched = await repo.get(g, a, v, file, localOnly);
  if (!fetched.ok) return { fetched, note: fetched.note };
  const cached = ARCHIVES.get(fetched.sha1);
  if (cached) return { archive: cached.zip, fetched };
  try {
    const zip = openZip(fetched.data, {
      maxEntries: 50_000,
      maxEntryBytes: 4 * 1024 * 1024,
      maxTotalBytes: 400 * 1024 * 1024,
      maxRatio: 200,
    });
    if (ARCHIVES.size >= MAX_ARCHIVES) ARCHIVES.delete(ARCHIVES.keys().next().value ?? '');
    ARCHIVES.set(fetched.sha1, { zip, names: new Set(zip.names) });
    return { archive: zip, fetched };
  } catch (error) {
    return { fetched, note: `${file} : archive illisible (${(error as Error).message})` };
  }
}

/** Un type lu dans un artefact : sa source (jar de sources) de préférence, sinon sa classe compilée. */
function readType(
  qualified: string,
  artifact: string,
  sources: ZipArchive | undefined,
  classes: ZipArchive | undefined,
  notes: string[],
): ExternalParsed | undefined {
  // Un type imbriqué (`a.B.C`) : son fichier est celui du type englobant ; essayé du plus long au plus court.
  const parts = qualified.split('.');
  for (let cut = parts.length; cut > 1; cut--) {
    const outer = parts.slice(0, cut).join('/');
    const nested = parts.slice(cut);
    const javaPath = `${outer}.java`;
    if (sources?.has(javaPath)) {
      const text = sources.text(javaPath);
      if (text === undefined) continue;
      try {
        const java: JavaFile = parseJava(text);
        const target = java.types.find((t) => t.qualifiedName === qualified);
        if (target)
          return {
            file: `${artifact}!/${javaPath}`,
            java: { ...java, types: [target] },
            artifact,
            read: 'SOURCES_JAR',
          };
      } catch {
        notes.push(`${artifact}!/${javaPath} : source illisible`);
      }
    }
    const classPath = `${outer}${nested.length ? `$${nested.join('$')}` : ''}.class`;
    if (classes?.has(classPath)) {
      const data = classes.bytes(classPath);
      if (!data) continue;
      try {
        const read = readClassFile(data);
        return { file: `${artifact}!/${classPath}`, java: read.file, artifact, read: 'CLASS' };
      } catch (error) {
        notes.push(
          `${artifact}!/${classPath} : ${error instanceof ClassFileError ? error.message : 'classe illisible'}`,
        );
      }
    }
  }
  return undefined;
}

/** Les noms qualifiés des types parents d'un type lu (pour les chercher à leur tour). */
function supertypes(parsed: ExternalParsed): string[] {
  const out: string[] = [];
  for (const decl of parsed.java.types)
    for (const ref of [...decl.extends, ...decl.implements]) {
      const written = ref.text.replace(/<.*$/, '');
      if (written.includes('.')) out.push(written);
      else {
        // Écrit dans une source : par son import, sinon dans le même paquet.
        const imported = parsed.java.imports.find((i) => i.endsWith(`.${written}`));
        out.push(imported ?? (parsed.java.package ? `${parsed.java.package}.${written}` : written));
      }
    }
  return out.filter((n) => !/^(java|javax|jakarta)\./.test(n));
}
