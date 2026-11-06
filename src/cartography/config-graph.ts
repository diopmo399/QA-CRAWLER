import type {
  ConfigEdge,
  ConfigNode,
  ConfigRelation,
  MapConfidence,
  MapConfigGraph,
} from '../sdk/core/cartography.js';
import { DEFAULT_VARIANT, MASK } from './config.js';
import type { SourceFacts } from './facts.js';
import { routedPath } from './gateway.js';

/** Au-delà, le graphe est tronqué (signalé) : il reste lisible et l'export reste borné. */
export const CONFIG_GRAPH_LIMIT = 20_000;

/** Jamais d'identifiants dans une adresse (`https://user:secret@hôte`). */
const safe = (text: string): string => text.replace(/\/\/[^/@\s]*@/g, '//');

/**
 * LE GRAPHE DE CONFIGURATION, construit depuis les faits lus (rien n'est déduit hors des fichiers) :
 * fichiers qui DÉCLARENT des propriétés, propriétés qui en RÉFÉRENCENT d'autres ou une variable d'exécution,
 * profils qui en REMPLACENT, profils ACTIVÉS, modules qui DÉPENDENT d'artefacts, générations qui GÉNÈRENT un
 * package depuis un contrat, contrôleurs qui IMPLÉMENTENT une interface générée, propriétés qui CONFIGURENT un
 * client, règles de proxy et routes de passerelle qui MÈNENT À une adresse et RÉÉCRIVENT un chemin. Chaque
 * relation garde sa provenance (fichier, ligne), sa variante et son niveau de preuve ; aucune n'est en double.
 */
export function buildConfigGraph(facts: readonly SourceFacts[]): MapConfigGraph {
  const nodes = new Map<string, ConfigNode>();
  const edges = new Map<string, ConfigEdge>();
  // Un objet : la fonction `edge` le modifie (un `let` y paraîtrait toujours faux).
  const state = { truncated: false };
  const node = (n: ConfigNode): string => {
    if (!nodes.has(n.id)) nodes.set(n.id, n);
    return n.id;
  };
  const edge = (
    from: string,
    to: string,
    kind: ConfigRelation,
    sourceId: string,
    variant: string,
    extra: { confidence?: MapConfidence; file?: string; line?: number; detail?: string } = {},
  ): void => {
    const key = `${from}|${to}|${kind}|${variant}`;
    if (edges.has(key)) return;
    if (edges.size >= CONFIG_GRAPH_LIMIT) {
      state.truncated = true;
      return;
    }
    edges.set(key, {
      from,
      to,
      kind,
      sourceId,
      variant,
      confidence: extra.confidence ?? 'CONFIRMED',
      ...(extra.file ? { file: extra.file } : {}),
      ...(extra.line ? { line: extra.line } : {}),
      ...(extra.detail !== undefined ? { detail: safe(extra.detail).slice(0, 240) } : {}),
    });
  };
  const address = (raw: string): string =>
    node({ id: `ADDRESS:${safe(raw)}`, kind: 'ADDRESS', label: safe(raw) });
  const pathNode = (sourceId: string, p: string): string =>
    node({ id: `PATH:${sourceId}:${p}`, kind: 'PATH', label: p, sourceId });

  for (const f of facts) {
    const src = f.sourceId;
    node({ id: `SOURCE:${src}`, kind: 'SOURCE', label: src, sourceId: src });

    // Spring : propriétés par fichier et profil, références, remplacements, profils actifs.
    const entries = f.config?.entries ?? [];
    for (const e of entries) {
      const variant = e.profile ?? DEFAULT_VARIANT;
      const file = node({ id: `FILE:${src}:${e.file}`, kind: 'FILE', label: e.file, sourceId: src });
      const prop = node({ id: `PROPERTY:${src}:${e.key}`, kind: 'PROPERTY', label: e.key, sourceId: src });
      edge(file, prop, 'DECLARES', src, variant, {
        file: e.file,
        line: e.line,
        detail: e.secret ? MASK : e.value,
      });
      if (!e.secret)
        for (const m of e.value.matchAll(/\$\{([^}:]+)(?::[^}]*)?\}/g)) {
          const key = m[1] ?? '';
          const runtime = /^[A-Z][A-Z0-9_]*$/.test(key) && !entries.some((x) => x.key === key);
          const target = runtime
            ? node({ id: `VARIABLE:${src}:${key}`, kind: 'VARIABLE', label: key, sourceId: src })
            : node({ id: `PROPERTY:${src}:${key}`, kind: 'PROPERTY', label: key, sourceId: src });
          edge(prop, target, 'REFERENCES', src, variant, {
            file: e.file,
            line: e.line,
            detail: runtime ? 'fournie à l’exécution' : m[0],
          });
        }
      const base = e.profile ? entries.find((x) => x.key === e.key && !x.profile) : undefined;
      if (e.profile && base) {
        const profile = node({
          id: `PROFILE:${src}:${e.profile}`,
          kind: 'PROFILE',
          label: e.profile,
          sourceId: src,
        });
        edge(profile, prop, 'OVERRIDES', src, e.profile, {
          file: e.file,
          line: e.line,
          detail: `${e.secret ? MASK : e.value} remplace ${base.secret ? MASK : base.value} (${base.file}:${String(base.line)})`,
        });
      }
    }
    for (const p of f.config?.profiles ?? []) {
      const profile = node({ id: `PROFILE:${src}:${p.name}`, kind: 'PROFILE', label: p.name, sourceId: src });
      const file = node({ id: `FILE:${src}:${p.file}`, kind: 'FILE', label: p.file, sourceId: src });
      edge(file, profile, p.how === 'ACTIVE' ? 'ACTIVATES' : 'DECLARES', src, DEFAULT_VARIANT, {
        file: p.file,
        line: p.line,
        detail:
          p.how === 'ACTIVE'
            ? 'spring.profiles.active'
            : p.how === 'FILE'
              ? 'fichier de profil'
              : 'document on-profile',
      });
    }

    // Maven : dépendances, parent, profils et leur activation, générations depuis un contrat.
    for (const m of f.maven?.modules ?? []) {
      const gav = `${m.groupId ?? m.parent?.groupId ?? ''}:${m.artifactId}${m.version ? `:${m.version}` : ''}`;
      const mod = node({ id: `MODULE:${src}:${m.file}`, kind: 'MODULE', label: gav, sourceId: src });
      if (m.parent) {
        const parent = node({
          id: `ARTIFACT:${m.parent.groupId ?? ''}:${m.parent.artifactId}`,
          kind: 'ARTIFACT',
          label: `${m.parent.groupId ?? ''}:${m.parent.artifactId}`,
        });
        edge(mod, parent, 'DEPENDS_ON', src, DEFAULT_VARIANT, {
          file: m.file,
          detail: `parent ${m.parent.version ?? ''}`.trim(),
        });
      }
      for (const d of m.dependencies) {
        const art = node({
          id: `ARTIFACT:${d.groupId ?? ''}:${d.artifactId}`,
          kind: 'ARTIFACT',
          label: `${d.groupId ?? ''}:${d.artifactId}`,
        });
        edge(mod, art, 'DEPENDS_ON', src, DEFAULT_VARIANT, {
          file: m.file,
          ...(d.line ? { line: d.line } : {}),
          detail: [d.version, d.scope].filter(Boolean).join(' ') || 'version gérée',
        });
      }
      for (const p of m.profileDetails ?? []) {
        const profile = node({
          id: `PROFILE:${src}:maven:${p.id}`,
          kind: 'PROFILE',
          label: `${p.id} (Maven)`,
          sourceId: src,
        });
        edge(mod, profile, p.activation ? 'ACTIVATES' : 'DECLARES', src, p.id, {
          file: m.file,
          line: p.line,
          detail: p.activation ?? 'activation explicite (-P)',
        });
      }
      for (const g of m.generations) {
        const variant = g.profile ?? DEFAULT_VARIANT;
        const gen = node({
          id: `GENERATION:${src}:${m.file}:${g.execution ?? String(g.line)}`,
          kind: 'GENERATION',
          label: `${g.generator ?? g.plugin}${g.execution ? ` (${g.execution})` : ''}`,
          sourceId: src,
        });
        edge(mod, gen, 'DECLARES', src, variant, { file: m.file, line: g.line, detail: g.plugin });
        if (g.apiPackage) {
          const pkg = node({ id: `PACKAGE:${g.apiPackage}`, kind: 'PACKAGE', label: g.apiPackage });
          edge(gen, pkg, 'GENERATES', src, variant, {
            file: m.file,
            line: g.line,
            detail: Object.entries(g.options ?? {})
              .map(([k, v]) => `${k}=${v}`)
              .join(', '),
          });
        }
        const spec = g.spec?.file ?? g.spec?.artifact ?? g.spec?.resource ?? g.inputSpec;
        if (spec) {
          const contract = node({ id: `CONTRACT:${spec}`, kind: 'CONTRACT', label: spec });
          edge(gen, contract, 'REFERENCES', src, variant, {
            file: m.file,
            line: g.line,
            ...(g.spec?.unresolved ? { confidence: 'UNKNOWN' as const, detail: g.spec.unresolved } : {}),
          });
        }
      }
    }

    // Java : interfaces générées implémentées, bases de clients réglées par un bean, propriétés des appels.
    for (const impl of f.java?.implementations ?? []) {
      const cls = node({
        id: `CLASS:${src}:${impl.controller}`,
        kind: 'CLASS',
        label: impl.controller,
        sourceId: src,
      });
      for (const missing of impl.missing) {
        const iface = node({
          id: `CLASS:${missing.qualified ?? missing.name}`,
          kind: 'CLASS',
          label: missing.qualified ?? missing.name,
        });
        edge(cls, iface, 'IMPLEMENTS', src, DEFAULT_VARIANT, {
          file: impl.loc.file,
          line: impl.loc.line,
          detail: 'interface absente des sources (générée au build)',
        });
      }
    }
    for (const b of f.java?.clientBases ?? []) {
      const client = node({ id: `CLIENT:${src}:${b.type}`, kind: 'CLIENT', label: b.type, sourceId: src });
      const from = b.property
        ? node({ id: `PROPERTY:${src}:${b.property}`, kind: 'PROPERTY', label: b.property, sourceId: src })
        : address(b.value ?? '');
      edge(from, client, 'CONFIGURES', src, b.profile ?? DEFAULT_VARIANT, {
        file: b.loc.file,
        line: b.loc.line,
        ...(b.condition
          ? { confidence: 'PROBABLE' as const, detail: `@ConditionalOnProperty(${b.condition})` }
          : {}),
      });
    }
    for (const out of f.java?.outgoing ?? [])
      for (const key of new Set(out.properties ?? [])) {
        const method = node({
          id: `METHOD:${out.from}`,
          kind: 'METHOD',
          label: out.from.split('#').pop() ?? out.from,
          sourceId: src,
        });
        const prop = node({ id: `PROPERTY:${src}:${key}`, kind: 'PROPERTY', label: key, sourceId: src });
        edge(method, prop, 'REFERENCES', src, DEFAULT_VARIANT, {
          file: out.loc.file,
          line: out.loc.line,
          detail: `base d’URL de ${out.method ?? ''} ${out.path ?? ''}`.trim(),
        });
      }

    // Angular : configurations (remplacements de fichiers), règles du proxy (destination, réécriture).
    for (const v of f.ui?.variants ?? []) {
      const angular = node({
        id: `FILE:${src}:angular.json`,
        kind: 'FILE',
        label: 'angular.json',
        sourceId: src,
      });
      for (const r of v.replacements) {
        const target = node({ id: `FILE:${src}:${r.with}`, kind: 'FILE', label: r.with, sourceId: src });
        edge(angular, target, 'CONFIGURES', src, v.name, {
          file: 'angular.json',
          detail: `${r.replace} → ${r.with}`,
        });
      }
    }
    for (const p of f.ui?.proxies ?? []) {
      const variant = p.variant ?? DEFAULT_VARIANT;
      const rule = node({
        id: `PROXY_RULE:${src}:${p.file}:${p.context}`,
        kind: 'PROXY_RULE',
        label: `${p.file} « ${p.context} »`,
        sourceId: src,
      });
      if (p.target) edge(rule, address(p.target), 'ROUTES_TO', src, variant, { file: p.file, line: p.line });
      if (p.dynamic)
        edge(rule, address('(exécution)'), 'ROUTES_TO', src, variant, {
          file: p.file,
          line: p.line,
          confidence: 'UNKNOWN',
          detail: p.dynamic,
        });
      if (p.rewrite) {
        let after = p.context;
        try {
          after = p.context.replace(new RegExp(p.rewrite.pattern), p.rewrite.replacement) || '/';
        } catch {
          // Une expression non valide en JavaScript : la réécriture reste écrite, sans résultat calculé.
        }
        edge(pathNode(src, p.context), pathNode(src, after), 'REWRITES_TO', src, variant, {
          file: p.file,
          line: p.line,
          detail: `« ${p.rewrite.pattern} » → « ${p.rewrite.replacement} »`,
        });
      }
    }

    // Passerelles : route → destination, transformations du chemin.
    for (const r of f.gateway?.routes ?? []) {
      const variant = r.variant ?? DEFAULT_VARIANT;
      const route = node({
        id: `ROUTE:${src}:${r.adapter}:${r.id}`,
        kind: 'ROUTE',
        label: `${r.id} (${r.adapter})`,
        sourceId: src,
      });
      edge(route, address(r.uri), 'ROUTES_TO', src, variant, {
        file: r.file,
        line: r.line,
        detail: `${r.paths.join(', ')}${r.methods.length ? ` ${r.methods.join(',')}` : ''}${r.upstream?.length ? ` ; upstream ${r.upstream.join(', ')}` : ''}`,
        // Une destination à `${…}` n'est connue qu'à l'exécution ; un prédicat non interprété rend la route probable.
        ...(/\$\{/.test(r.uri)
          ? { confidence: 'UNKNOWN' as const }
          : r.dynamic
            ? { confidence: 'PROBABLE' as const }
            : {}),
      });
      const sample = (r.paths[0] ?? '/').replace(/\/\*\*$/, '').replace(/\*+/g, '') || '/';
      const routed = routedPath(r, sample);
      if (routed.path !== sample)
        edge(pathNode(src, sample), pathNode(src, routed.path), 'REWRITES_TO', src, variant, {
          file: r.file,
          line: r.line,
          detail: routed.steps.join(' ; '),
        });
    }
  }
  return {
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    ...(state.truncated ? { truncated: true } : {}),
  };
}
