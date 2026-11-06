import path from 'node:path';
import type {
  CorrelationCandidate,
  CorrelationCause,
  CorrelationStatus,
  MapContract,
  MapContractDiff,
  MapLayer,
  MapModule,
} from '../sdk/core/cartography.js';
import { normalizePath } from '../incident/code/paths.js';
import type { ApiDocument, ApiOperation, Loc, MavenGeneration, MavenModule, SourceFacts } from './facts.js';

/**
 * LA CORRÉLATION ENTRE COUCHES, par indices multiples et sans rien inventer :
 *
 * - les CONTRATS : rôle (lu par une génération = contract-first ; produit depuis le code = code-first),
 *   générations qui les lisent (serveur ou client, module, version), comparaison des versions d'un même
 *   contrat opération par opération ;
 * - les ENDPOINTS DÉDUITS d'une interface générée absente : le contrôleur implémente une interface dont le
 *   package est l'`apiPackage` d'une génération serveur de son module ; le contrat d'entrée de cette
 *   génération est établi (fichier, ou ressource d'un artefact dépendant présent dans une source) ; la
 *   méthode `@Override` porte le nom que le générateur donne à une opération de ce contrat, rattachée à
 *   cette interface (étiquette ou premier segment). La route est alors celle du contrat : PROBABLE, jamais
 *   confirmée (le code généré n'est pas lu) ;
 * - les APPELS SORTANTS par un client généré, sur le même principe (génération cliente) ;
 * - la CORRESPONDANCE d'un appel (méthode, chemin) avec les endpoints exposés : préfixes justifiés
 *   seulement (context-path, base du contrat, base démontrée par la configuration), candidats concurrents
 *   gardés avec leurs raisons, et une cause précise quand rien n'est démontré.
 */

export interface Cause {
  code: CorrelationCause;
  message: string;
}

const MAX_CANDIDATES = 8;

// ── Routes ─────────────────────────────────────────────────────────────────────────────────────────

/** Les segments comparés : paramètres (`{id}`, `${id}`, `:id`) ramenés à `{}`. */
export const segmentsOf = (p: string): string[] => normalizePath(p).split('/').filter(Boolean);

/** Joint des préfixes et un chemin (`/api` + `/demandes/{id}` → `/api/demandes/{id}`). */
export const joinRoute = (...parts: (string | undefined)[]): string => {
  const segments = parts.flatMap((part) => (part ?? '').split('/').filter(Boolean));
  return `/${segments.join('/')}`;
};

type Strength = { kind: 'STRONG' | 'WEAK'; score: number };

/**
 * La comparaison d'un chemin d'appel avec un chemin exposé. STRONG : chaque segment est identique, ou est un
 * paramètre côté endpoint ; WEAK : un segment variable de l'appel couvre un segment littéral de l'endpoint
 * (plausible, jamais démontré). `tail` : la base de l'appel est inconnue, seule la fin est comparée.
 */
export function compareRoute(call: string[], target: string[], tail: boolean): Strength | undefined {
  if (tail ? target.length < call.length : target.length !== call.length) return undefined;
  const theirs = target.slice(target.length - call.length);
  let weak = false;
  let score = 0;
  for (let i = 0; i < call.length; i += 1) {
    const mine = call[i] ?? '';
    const other = theirs[i] ?? '';
    if (mine === other) score += mine === '{}' ? 1 : 3;
    else if (other === '{}') score += 1;
    else if (other.includes('{}') && mine !== '{}') {
      const re = new RegExp(
        `^${other
          .split('{}')
          .map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('[^/]+')}$`,
      );
      if (!re.test(mine)) return undefined;
      score += 2;
    } else if (mine === '{}') weak = true;
    else return undefined;
  }
  return { kind: weak ? 'WEAK' : 'STRONG', score };
}

/** Une cible : endpoint servi (annotation lue), endpoint déduit d'une interface générée, opération de contrat. */
export interface Target {
  node: string;
  layer: MapLayer;
  kind: 'SERVED' | 'INFERRED' | 'CONTRACT';
  method: string;
  /** Le chemin exposé (préfixes justifiés compris). */
  path: string;
  /** Ce qui justifie le chemin exposé (préfixes, déduction). */
  why: string[];
}

export interface CallRoute {
  method: string;
  path: string;
  /** La base de l'URL n'est pas connue (`{base}` en tête) : seule la fin du chemin est comparée. */
  baseUnknown: boolean;
}

export interface Match {
  status: CorrelationStatus;
  target?: Target;
  candidates: CorrelationCandidate[];
  causes: Cause[];
  /** Comment le chemin correspond (pour la raison du lien). */
  how?: 'EXACT' | 'SUFFIX';
}

/**
 * La meilleure cible d'un appel parmi celles d'une couche. Une seule cible forte → retenue (la plus
 * littérale l'emporte à score strictement supérieur) ; plusieurs à égalité → ambiguë, aucune choisie ;
 * seulement des cibles faibles → aucune choisie, candidates gardées ; méthode différente sur le même chemin
 * → incompatible, dit.
 */
export function matchCall(call: CallRoute, targets: readonly Target[]): Match {
  const segments = segmentsOf(call.path);
  // Une base inconnue en tête : `{}` au début, le reste comparé en suffixe.
  const lead = segments.findIndex((s) => s !== '{}');
  const tail = call.baseUnknown && lead > 0;
  const mine = tail ? segments.slice(lead) : segments;
  const strong: { t: Target; s: Strength; exactMethod: boolean }[] = [];
  const weak: { t: Target; s: Strength }[] = [];
  const wrongMethod: { t: Target; s: Strength }[] = [];
  for (const t of targets) {
    const s = compareRoute(mine, segmentsOf(t.path), tail);
    if (!s) continue;
    const sameMethod = t.method === call.method || t.method === '*';
    if (!sameMethod) wrongMethod.push({ t, s });
    else if (s.kind === 'STRONG') strong.push({ t, s, exactMethod: t.method === call.method });
    else weak.push({ t, s });
  }
  const candidate = (t: Target, reasons: string[], rejected?: string): CorrelationCandidate => ({
    node: t.node,
    layer: t.layer,
    method: t.method,
    path: t.path,
    reasons: [...reasons, ...t.why],
    ...(rejected ? { rejected } : {}),
  });
  strong.sort((a, b) => b.s.score - a.s.score || Number(b.exactMethod) - Number(a.exactMethod));
  const best = strong[0];
  const second = strong[1];
  const unique =
    best && (!second || best.s.score > second.s.score || (best.exactMethod && !second.exactMethod));
  if (best && unique) {
    const others = strong
      .slice(1, MAX_CANDIDATES)
      .map((x) => candidate(x.t, ['même méthode, chemin compatible'], 'chemin moins précis'));
    const inferred = best.t.kind === 'INFERRED';
    return {
      status: tail || inferred ? 'PROBABLE' : 'CONFIRMED',
      target: best.t,
      how: tail ? 'SUFFIX' : 'EXACT',
      candidates: [
        candidate(best.t, [
          tail ? 'fin du chemin identique (base de l’appel inconnue)' : 'même méthode, même chemin',
        ]),
        ...others,
      ],
      causes: [
        ...(tail
          ? [
              {
                code: 'PREFIX_UNKNOWN' as const,
                message: `la base de l’URL n’est pas démontrée (${call.path}) : seule la fin du chemin est comparée`,
              },
            ]
          : []),
      ],
    };
  }
  if (strong.length > 1)
    return {
      status: 'UNDEMONSTRATED',
      candidates: strong
        .slice(0, MAX_CANDIDATES)
        .map((x) => candidate(x.t, ['même méthode, chemin compatible'], 'à égalité avec un autre candidat')),
      causes: [
        {
          code: 'AMBIGUOUS',
          message: `${String(strong.length)} endpoints correspondent à ${call.method} ${call.path} (${strong
            .slice(0, 3)
            .map((x) => `${x.t.method} ${x.t.path}`)
            .join(', ')}) : aucun n’est choisi`,
        },
      ],
    };
  if (weak.length > 0)
    return {
      status: 'UNDEMONSTRATED',
      candidates: weak
        .slice(0, MAX_CANDIDATES)
        .map((x) =>
          candidate(
            x.t,
            ['même méthode'],
            'un segment variable de l’appel couvre un segment fixe de l’endpoint',
          ),
        ),
      causes: [
        weak.length > 1
          ? {
              code: 'AMBIGUOUS',
              message: `${String(weak.length)} endpoints correspondent à ${call.method} ${call.path} (${weak
                .slice(0, 3)
                .map((x) => `${x.t.method} ${x.t.path}`)
                .join(', ')}) : aucun n’est choisi`,
            }
          : {
              code: 'DYNAMIC_URL',
              message: `un segment variable de ${call.path} couvre un segment fixe de ${weak[0]?.t.path ?? ''} : la correspondance n’est pas démontrée`,
            },
      ],
    };
  if (wrongMethod.length > 0)
    return {
      status: 'UNDEMONSTRATED',
      candidates: wrongMethod
        .slice(0, MAX_CANDIDATES)
        .map((x) => candidate(x.t, ['chemin compatible'], `méthode ${x.t.method} ≠ ${call.method}`)),
      causes: [
        {
          code: 'METHOD_MISMATCH',
          message: `${call.path} existe en ${[...new Set(wrongMethod.map((x) => x.t.method))].join(', ')}, pas en ${call.method}`,
        },
      ],
    };
  return { status: 'UNDEMONSTRATED', candidates: [], causes: [] };
}

// ── Contrats, modules, générations ───────────────────────────────────────────────────────────────

const CLIENT_GENERATOR =
  /^(java|kotlin|typescript|javascript|csharp|python|go|swift|dart|php|ruby|rust)(-|$)/;
/** Serveur ou client : `spring` avec la bibliothèque `spring-cloud` est un client Feign. */
export const sideOf = (g: MavenGeneration): 'SERVER' | 'CLIENT' | undefined => {
  if (g.plugin === 'springdoc' || !g.generator) return undefined;
  if (/^spring/.test(g.generator) && g.library === 'spring-cloud') return 'CLIENT';
  if (
    /^(spring|kotlin-spring|jaxrs|java-.*server|java-micronaut-server|java-undertow-server|java-play)/.test(
      g.generator,
    )
  )
    return 'SERVER';
  return CLIENT_GENERATOR.test(g.generator) ? 'CLIENT' : undefined;
};

const pascal = (text: string): string =>
  text
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
const flat = (text: string): string => text.replace(/[^A-Za-z0-9]/g, '').toLowerCase();

/** Les noms d'interface que le générateur peut donner à l'opération (étiquette ; ou premier segment). */
export function apiNamesOf(op: ApiOperation, g: MavenGeneration): Set<string> {
  const names = new Set<string>();
  const byTag = op.tags.length ? op.tags.map((t) => `${pascal(t)}Api`) : ['DefaultApi'];
  const first = (op.route ?? op.path).split('/').filter((s) => s && !s.startsWith('{'))[0];
  const byPath = first ? [`${pascal(first)}Api`] : ['DefaultApi'];
  // Générateurs serveurs Spring : `useTags` (défaut : faux) choisit l'étiquette ; les clients : l'étiquette.
  const server = sideOf(g) === 'SERVER';
  if (!server || g.useTags !== false) byTag.forEach((n) => names.add(n));
  if (server && g.useTags !== true) byPath.forEach((n) => names.add(n));
  return names;
}

/** Le nom de méthode que le générateur donne à l'opération correspond-il ? (operationId, sans casse ni signe). */
export const sameOperation = (op: ApiOperation, method: string): boolean =>
  op.operationId !== undefined && flat(op.operationId) === flat(method);

export interface ContractRef {
  sourceId: string;
  doc: ApiDocument;
  /** Le module qui le porte, s'il est connu. */
  module?: { sourceId: string; module: MavenModule };
}

export interface ResolvedSpec {
  contract?: ContractRef;
  steps: { label: string; loc?: { sourceId: string } & Loc }[];
  causes: Cause[];
  /** La version de l'artefact de contrat demandée par le module (dépendance), et celle trouvée. */
  versions?: { wanted?: string; found?: string; artifact: string };
}

export class ContractIndex {
  readonly documents: ContractRef[] = [];
  private readonly modules: { sourceId: string; module: MavenModule }[] = [];
  constructor(private readonly facts: readonly SourceFacts[]) {
    for (const f of facts) {
      for (const m of f.maven?.modules ?? []) this.modules.push({ sourceId: f.sourceId, module: m });
      for (const doc of f.openapi?.documents ?? []) this.documents.push({ sourceId: f.sourceId, doc });
    }
    for (const ref of this.documents) {
      const owner = this.moduleOf(ref.sourceId, ref.doc.file);
      if (owner) ref.module = owner;
    }
  }

  /** Le module Maven dont le dossier contient le fichier (le plus profond). */
  moduleOf(sourceId: string, file: string): { sourceId: string; module: MavenModule } | undefined {
    return this.modules
      .filter((m) => m.sourceId === sourceId)
      .map((m) => ({ m, dir: path.posix.dirname(m.module.file) }))
      .filter(({ dir }) => dir === '.' || file.startsWith(`${dir}/`))
      .sort((a, b) => b.dir.length - a.dir.length)[0]?.m;
  }

  operations(ref: ContractRef): ApiOperation[] {
    return (
      this.facts
        .find((f) => f.sourceId === ref.sourceId)
        ?.openapi?.operations.filter((op) => (op.document ?? op.loc.file) === ref.doc.file) ?? []
    );
  }

  /** Le contrat d'entrée d'une génération : fichier de la source, ou ressource d'un artefact présent ailleurs. */
  resolveSpec(sourceId: string, owner: MavenModule, g: MavenGeneration): ResolvedSpec {
    const steps: ResolvedSpec['steps'] = [];
    const causes: Cause[] = [];
    const spec = g.spec;
    if (!spec)
      return {
        steps,
        causes: [
          {
            code: 'CONTRACT_NOT_FOUND',
            message: `la génération ${g.execution ?? g.generator ?? ''} ne déclare pas de contrat d’entrée lisible`,
          },
        ],
      };
    if (spec.unresolved) return { steps, causes: [{ code: 'CONTRACT_NOT_FOUND', message: spec.unresolved }] };
    if (spec.file) {
      const contract = this.documents.find((d) => d.sourceId === sourceId && d.doc.file === spec.file);
      return contract
        ? {
            contract,
            steps: [
              { label: `contrat ${spec.file} lu par la génération ${g.execution ?? g.generator ?? ''}` },
            ],
            causes,
          }
        : {
            steps,
            causes: [
              { code: 'CONTRACT_NOT_FOUND', message: `${spec.file} n’est pas un contrat OpenAPI lisible` },
            ],
          };
    }
    const artifacts = (spec.artifact ?? '').split(',').filter(Boolean);
    for (const artifact of artifacts) {
      const wanted = owner.dependencies.find((d) => d.artifactId === artifact)?.version;
      const found = this.modules.filter((m) => m.module.artifactId === artifact);
      if (found.length === 0) {
        // Les identifiants Maven connus de la dépendance, et où elle a été cherchée.
        const dep = owner.dependencies.find((d) => d.artifactId === artifact);
        const coords = `${dep?.groupId ?? '?'}:${artifact}:${wanted ?? '?'}`;
        const metadata = this.facts
          .filter((f) => f.sourceId.startsWith('meta:'))
          .map((f) => f.sourceId.slice(5));
        causes.push(
          metadata.length
            ? {
                code: 'DEPENDENCY_UNAVAILABLE',
                message: `${coords} (contrat ${spec.resource ?? ''}) : absent des sources et des métadonnées locales (${metadata.join(', ')}) ; il faudrait son pom et son jar dans une racine de métadonnées autorisée`,
              }
            : {
                code: 'MAVEN_MODULE_MISSING',
                message: `${coords} (contrat ${spec.resource ?? ''}) n’est dans aucune source analysée, et aucune racine de métadonnées locale n’est configurée`,
              },
        );
        continue;
      }
      const sameVersion = wanted ? found.filter((m) => m.module.version === wanted) : found;
      const chosen = sameVersion.length === 1 ? sameVersion[0] : found.length === 1 ? found[0] : undefined;
      if (!chosen) {
        causes.push({
          code: 'MAVEN_DEPENDENCY_AMBIGUOUS',
          message: `${String(found.length)} modules ${artifact} lus (${found.map((m) => `${m.module.version ?? '?'} dans ${m.sourceId}`).join(', ')}) : aucun n’est choisi`,
        });
        continue;
      }
      const dir = path.posix.dirname(chosen.module.file);
      const resource = spec.resource ?? '';
      const doc = this.documents.find(
        (d) =>
          d.sourceId === chosen.sourceId &&
          (dir === '.' || d.doc.file.startsWith(`${dir}/`)) &&
          (d.doc.file === resource || d.doc.file.endsWith(`/${resource}`)),
      );
      if (!doc) {
        causes.push({
          code: 'CONTRACT_NOT_FOUND',
          message: `${resource} est introuvable dans le module ${artifact} (${chosen.sourceId})`,
        });
        continue;
      }
      const versions = {
        artifact,
        ...(wanted ? { wanted } : {}),
        ...(chosen.module.version ? { found: chosen.module.version } : {}),
      };
      if (wanted && chosen.module.version && wanted !== chosen.module.version)
        causes.push({
          code: 'CONTRACT_VERSION_UNKNOWN',
          message: `le module dépend de ${artifact}:${wanted}, la source analysée contient ${chosen.module.version} : le contrat lu n’est pas celui de la version utilisée`,
        });
      else if (!wanted)
        causes.push({
          code: 'CONTRACT_VERSION_UNKNOWN',
          message: `la version de ${artifact} utilisée par le module n’est pas lisible (aucune dépendance déclarée)`,
        });
      steps.push({
        label: `artefact ${artifact}${wanted ? `:${wanted}` : ''} → ${doc.doc.file} (${chosen.sourceId})`,
      });
      return { contract: doc, steps, causes, versions };
    }
    return { steps, causes };
  }

  /** Les contrats, leur rôle et leurs consommateurs. */
  contracts(): MapContract[] {
    const consumers = new Map<string, MapContract['consumers']>();
    for (const { sourceId, module } of this.modules)
      for (const g of module.generations) {
        const side = sideOf(g);
        if (!side) continue;
        const resolved = this.resolveSpec(sourceId, module, g);
        if (!resolved.contract) continue;
        const key = `${resolved.contract.sourceId}:${resolved.contract.doc.file}`;
        consumers.set(key, [
          ...(consumers.get(key) ?? []),
          {
            module: `${module.groupId ?? '?'}:${module.artifactId}`,
            ...(g.execution ? { execution: g.execution } : {}),
            ...(g.generator ? { generator: g.generator } : {}),
            side,
            ...(resolved.versions?.wanted ? { version: resolved.versions.wanted } : {}),
          },
        ]);
      }
    return this.documents.map((ref) => {
      const id = `${ref.sourceId}:${ref.doc.file}`;
      const used = consumers.get(id) ?? [];
      const producer = ref.module?.module.generations.some((g) => g.plugin === 'springdoc');
      return {
        id,
        source: ref.sourceId,
        file: ref.doc.file,
        ...(ref.doc.title ? { title: ref.doc.title } : {}),
        ...(ref.doc.version ? { version: ref.doc.version } : {}),
        role: used.length > 0 ? 'GENERATOR_INPUT' : producer ? 'PRODUCED_FROM_CODE' : 'UNDETERMINED',
        consumers: used,
        operations: this.operations(ref).length,
        unresolved: ref.doc.unresolved ?? [],
      };
    });
  }

  /** Les versions d'un même contrat (même titre) comparées opération par opération. */
  diffs(): MapContractDiff[] {
    const byTitle = new Map<string, ContractRef[]>();
    for (const ref of this.documents)
      if (ref.doc.title) byTitle.set(ref.doc.title, [...(byTitle.get(ref.doc.title) ?? []), ref]);
    const out: MapContractDiff[] = [];
    for (const [title, refs] of byTitle)
      for (let i = 0; i < refs.length; i += 1)
        for (let j = i + 1; j < refs.length; j += 1) {
          const a = refs[i];
          const b = refs[j];
          if (!a || !b) continue;
          const key = (op: ApiOperation) => `${op.method} ${normalizePath(op.route ?? op.path)}`;
          const left = new Map(this.operations(a).map((op) => [key(op), op]));
          const right = new Map(this.operations(b).map((op) => [key(op), op]));
          const removed = [...left.keys()].filter((k) => !right.has(k));
          const added = [...right.keys()].filter((k) => !left.has(k));
          const changed: MapContractDiff['changed'] = [];
          for (const [k, op] of left) {
            const other = right.get(k);
            if (!other) continue;
            const params = (o: ApiOperation) =>
              (o.params ?? [])
                .filter((p) => p.in !== 'header')
                .map((p) => `${p.in}:${p.name}${p.required ? '!' : ''}`)
                .sort()
                .join(',');
            if (params(op) !== params(other))
              changed.push({
                operation: k,
                what: `paramètres ${params(op) || '—'} → ${params(other) || '—'}`,
              });
            if ((op.request ?? '') !== (other.request ?? ''))
              changed.push({ operation: k, what: `corps ${op.request ?? '—'} → ${other.request ?? '—'}` });
          }
          // Même chemin, autre méthode : une méthode modifiée plutôt qu'une suppression et un ajout.
          for (const r of [...removed])
            for (const ad of [...added])
              if (r.split(' ')[1] === ad.split(' ')[1]) {
                changed.push({
                  operation: r.split(' ')[1] ?? r,
                  what: `méthode ${r.split(' ')[0] ?? ''} → ${ad.split(' ')[0] ?? ''}`,
                });
                removed.splice(removed.indexOf(r), 1);
                added.splice(added.indexOf(ad), 1);
              }
          out.push({
            title,
            from: {
              contract: `${a.sourceId}:${a.doc.file}`,
              ...(a.doc.version ? { version: a.doc.version } : {}),
            },
            to: {
              contract: `${b.sourceId}:${b.doc.file}`,
              ...(b.doc.version ? { version: b.doc.version } : {}),
            },
            identical: removed.length === 0 && added.length === 0 && changed.length === 0,
            removed,
            added,
            changed,
          });
        }
    return out;
  }

  moduleList(): MapModule[] {
    return this.modules.map(({ sourceId, module: m }) => ({
      source: sourceId,
      file: m.file,
      id: `${m.groupId ?? '?'}:${m.artifactId}:${m.version ?? '?'}`,
      ...(m.packaging ? { packaging: m.packaging } : {}),
      ...(m.parent
        ? { parent: `${m.parent.groupId ?? '?'}:${m.parent.artifactId}:${m.parent.version ?? '?'}` }
        : {}),
      dependencies: m.dependencies.map((d) => `${d.groupId ?? '?'}:${d.artifactId}:${d.version ?? '?'}`),
      ...((): { indirect?: string[] } => {
        // Les dépendances indirectes CONNUES : suivies à travers les pom lus (sources, métadonnées locales).
        const out = new Set<string>();
        const direct = new Set(m.dependencies.map((d) => d.artifactId));
        const visit = (deps: MavenModule['dependencies'], depth: number): void => {
          if (depth > 5) return;
          for (const d of deps) {
            const next = this.modules.find(
              (x) => x.module.artifactId === d.artifactId && (!d.version || x.module.version === d.version),
            );
            if (!next) continue;
            for (const t of next.module.dependencies) {
              const key = `${t.groupId ?? '?'}:${t.artifactId}:${t.version ?? '?'}`;
              if (direct.has(t.artifactId) || out.has(key) || t.scope === 'test') continue;
              out.add(key);
            }
            visit(next.module.dependencies, depth + 1);
          }
        };
        visit(m.dependencies, 1);
        return out.size ? { indirect: [...out].sort() } : {};
      })(),
      generations: m.generations.map((g) => ({
        plugin: g.plugin,
        ...(g.execution ? { execution: g.execution } : {}),
        ...(g.generator ? { generator: g.generator } : {}),
        ...(g.spec?.file
          ? { spec: g.spec.file }
          : g.spec?.artifact
            ? { spec: `${g.spec.artifact}!${g.spec.resource ?? ''}` }
            : g.spec?.unresolved
              ? { spec: g.spec.unresolved }
              : {}),
        ...(g.apiPackage ? { apiPackage: g.apiPackage } : {}),
      })),
      unresolved: m.unresolved,
    }));
  }
}

/**
 * Les opérations d'un contrat qu'une génération attribue à une interface et à une méthode : interface du
 * nom attendu, méthode du nom de l'operationId. Rien n'est attribué sur un nom approchant.
 */
export function operationsFor(
  ops: readonly ApiOperation[],
  g: MavenGeneration,
  iface: string,
  method: string,
): ApiOperation[] {
  return ops.filter((op) => apiNamesOf(op, g).has(iface) && sameOperation(op, method));
}

/** Le package d'un nom qualifié (`com.ex.api.DemandesApi` → `com.ex.api`). */
export const packageOf = (qualified: string): string => qualified.split('.').slice(0, -1).join('.');

// ── Préfixe d'une interface générée absente ──────────────────────────────────────────────────────

export interface GeneratedPrefix {
  /** DETERMINED : une règle de génération démontrée par les options lues ; sinon les possibilités. */
  status: 'DETERMINED' | 'UNDETERMINED';
  prefixes: string[];
  rule: string;
}

/**
 * Le préfixe de type d'une interface générée par openapi-generator (Spring) qu'on ne peut pas lire. Il n'est
 * DÉTERMINÉ que par une preuve : le contrôleur déclare lui-même son `@RequestMapping` de type (il l'emporte),
 * ou l'option `requestMappingMode` est écrite (`none` : aucun ; `controller` avec `interfaceOnly` : il irait
 * sur un contrôleur généré, non produit ; `api_interface` : `${openapi.<nom>.base-path:<base du contrat>}`,
 * lu dans la configuration quand une seule propriété de ce nom existe). Sans cette option, la valeur par
 * défaut dépend de la version du générateur : les possibilités sont gardées, aucune n'est choisie.
 */
export function generatedPrefix(
  g: MavenGeneration,
  controllerBase: string | undefined,
  contractBases: readonly string[],
  basePathProperties: readonly { key: string; value?: string }[],
): GeneratedPrefix {
  const gen = `${g.generator ?? '?'}${g.version ? ` ${g.version}` : ' (version inconnue)'}`;
  if (controllerBase !== undefined)
    return {
      status: 'DETERMINED',
      prefixes: [controllerBase],
      rule: `le contrôleur déclare son @RequestMapping de type « ${controllerBase} »`,
    };
  const mode = g.options?.requestMappingMode;
  if (mode === 'none')
    return {
      status: 'DETERMINED',
      prefixes: [''],
      rule: `requestMappingMode=none (${gen}) : l’interface n’a pas de @RequestMapping de type`,
    };
  if (mode === 'controller' && g.interfaceOnly === true)
    return {
      status: 'DETERMINED',
      prefixes: [''],
      rule: `requestMappingMode=controller avec interfaceOnly=true (${gen}) : le préfixe irait sur un contrôleur généré, qui n’est pas produit`,
    };
  if (mode === 'api_interface') {
    const known = basePathProperties.filter((p) => p.value !== undefined);
    if (basePathProperties.length === 1 && known[0])
      return {
        status: 'DETERMINED',
        prefixes: [known[0].value ?? ''],
        rule: `requestMappingMode=api_interface (${gen}) : \${${known[0].key}} = « ${known[0].value ?? ''} »`,
      };
    if (basePathProperties.length === 0)
      return {
        status: 'DETERMINED',
        prefixes: [contractBases[0] ?? ''],
        rule: `requestMappingMode=api_interface (${gen}) : aucune propriété openapi.*.base-path, défaut = base du contrat « ${contractBases[0] ?? ''} »`,
      };
    return {
      status: 'UNDETERMINED',
      prefixes: [...new Set(known.map((p) => p.value ?? ''))],
      rule: `requestMappingMode=api_interface (${gen}) : ${String(basePathProperties.length)} propriétés openapi.*.base-path, celle de l’interface n’est pas établie`,
    };
  }
  return {
    status: 'UNDETERMINED',
    prefixes: [...new Set(['', ...contractBases])],
    rule: `requestMappingMode ${mode ? `= ${mode}` : 'non déclaré'} (${gen}) : le préfixe de type dépend de cette option et de son défaut propre à la version`,
  };
}
