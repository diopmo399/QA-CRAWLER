import { parseAllDocuments } from 'yaml';
import { ConfigResolver, DEFAULT_VARIANT, type SpringConfig } from './config.js';
import type { ReadFile } from './files.js';

/**
 * LES PASSERELLES, PAR ADAPTATEUR (Spring Cloud Gateway, NGINX, Ingress) dans un modèle commun :
 * route → prédicats → transformations → destination. Rien n'est exécuté ; une règle non interprétable est
 * gardée comme dynamique. Une passerelle n'est suivie pour un appel que si la destination de cet appel
 * (cible du proxy, base d'URL, base d'un client) la désigne : sa seule présence ne prouve pas son usage.
 */
export type GatewayAdapter = 'SPRING_CLOUD_GATEWAY' | 'NGINX' | 'INGRESS';

export interface RouteFilter {
  kind: 'STRIP_PREFIX' | 'REWRITE_PATH' | 'PREFIX_PATH';
  parts?: number;
  pattern?: string;
  replacement?: string;
  prefix?: string;
  /** Le texte lu, tel quel (preuve). */
  text: string;
}

export interface GatewayRoute {
  adapter: GatewayAdapter;
  id: string;
  file: string;
  line: number;
  /** La variante (profil) qui définit cette route ; absente : le défaut. */
  variant?: string;
  /** Prédicats de chemin : motifs Spring (`/api/**`), préfixe NGINX, chemin Ingress. */
  paths: string[];
  /** Comment lire `paths`. */
  match: 'SPRING_PATTERN' | 'PREFIX' | 'EXACT' | 'REGEX';
  methods: string[];
  filters: RouteFilter[];
  /** La destination telle qu'écrite (`http://hôte:port/base`, `lb://nom`, `service:port`). */
  uri: string;
  /** Les serveurs d'un upstream NGINX nommé par la destination. */
  upstream?: string[];
  order: number;
  /** Ce qui n'a pas pu être interprété (prédicat, transformation ou destination). */
  dynamic?: string;
}

export interface GatewayFacts {
  routes: GatewayRoute[];
  /** Les ports d'écoute déclarés (NGINX `listen`) ; Spring Cloud Gateway : `server.port` de la source. */
  listens: { port: number; file: string; line: number }[];
  /** Les hôtes déclarés (Ingress `host`, NGINX `server_name`). */
  hosts: string[];
  warnings: string[];
}

const GATEWAY_ROOTS = [
  'spring.cloud.gateway.routes',
  'spring.cloud.gateway.server.webflux.routes',
  'spring.cloud.gateway.mvc.routes',
  'spring.cloud.gateway.server.webmvc.routes',
];

/** Les routes Spring Cloud Gateway lues dans la configuration, par variante (le défaut, puis chaque profil). */
export function springGatewayRoutes(config: SpringConfig): GatewayRoute[] {
  const resolver = new ConfigResolver(config);
  const keys = [...new Set(config.entries.map((e) => e.key))];
  const indexOf = new Map<string, { root: string; index: number }>();
  for (const key of keys)
    for (const root of GATEWAY_ROOTS) {
      const m = new RegExp(`^${root.replace(/\./g, '\\.')}\\[(\\d+)\\]\\.`).exec(key);
      if (m) indexOf.set(`${root}[${m[1] ?? '0'}]`, { root, index: Number(m[1]) });
    }
  if (indexOf.size === 0) return [];
  const out: GatewayRoute[] = [];
  const signature = (r: GatewayRoute): string =>
    JSON.stringify([r.paths, r.methods, r.filters.map((f) => f.text), r.uri, r.order]);
  const byDefault = new Map<string, string>();
  for (const variant of resolver.variants()) {
    for (const [prefix] of indexOf) {
      const raw = (leaf: string): string | undefined => {
        const r = resolver.resolve(`${prefix}.${leaf}`, variant);
        return r.from[0]?.value;
      };
      const list = (leaf: string): string[] => {
        const values: string[] = [];
        for (let i = 0; i < 50; i += 1) {
          const v = raw(`${leaf}[${String(i)}]`);
          if (v === undefined) {
            // La forme développée : `predicates[0].name` + `args.*`.
            const name = raw(`${leaf}[${String(i)}].name`);
            if (name === undefined) break;
            const args = keys
              .filter((k) => k.startsWith(`${prefix}.${leaf}[${String(i)}].args.`))
              .map((k) => resolver.resolve(k, variant).from[0]?.value)
              .filter((x): x is string => x !== undefined);
            values.push(`${name}=${args.join(',')}`);
            continue;
          }
          values.push(v);
        }
        return values;
      };
      const uriResolved = resolver.resolve(`${prefix}.uri`, variant);
      const uri = uriResolved.value ?? raw('uri') ?? '';
      if (!uri && list('predicates').length === 0) continue;
      const entry = uriResolved.from[0] ?? resolver.resolve(`${prefix}.id`, variant).from[0];
      const route: GatewayRoute = {
        adapter: 'SPRING_CLOUD_GATEWAY',
        id: raw('id') ?? prefix,
        file: entry?.file ?? '',
        line: entry?.line ?? 1,
        paths: [],
        match: 'SPRING_PATTERN',
        methods: [],
        filters: [],
        uri,
        order: Number(raw('order') ?? '0') || 0,
      };
      // Une destination à `${…}` non résolue reste telle quelle : la résolution des destinations la dit symbolique.
      const notes: string[] = [];
      for (const p of list('predicates')) {
        const [name, args] = splitOnce(p, '=');
        const values = args
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean);
        if (/^path$/i.test(name)) route.paths.push(...values);
        else if (/^method$/i.test(name)) route.methods.push(...values.map((m) => m.toUpperCase()));
        else notes.push(`prédicat ${p} non interprété (la route peut ne pas valoir)`);
      }
      for (const f of list('filters')) {
        const [name, args] = splitOnce(f, '=');
        if (/^stripprefix$/i.test(name))
          route.filters.push({ kind: 'STRIP_PREFIX', parts: Number(args.trim()) || 1, text: f });
        else if (/^prefixpath$/i.test(name))
          route.filters.push({ kind: 'PREFIX_PATH', prefix: args.trim(), text: f });
        else if (/^rewritepath$/i.test(name)) {
          const at = args.indexOf(',');
          const pattern = (at < 0 ? args : args.slice(0, at)).trim();
          // `$\{segment}` (forme échappée de Spring) et `${segment}` : groupes nommés.
          const replacement = (at < 0 ? '' : args.slice(at + 1)).trim().replace(/\$\\?\{(\w+)\}/g, '$<$1>');
          route.filters.push({ kind: 'REWRITE_PATH', pattern, replacement, text: f });
        } else if (/^(setpath|rewritelocationresponseheader|rewriteresponseheader)$/i.test(name))
          notes.push(`transformation ${f} non interprétée`);
      }
      if (notes.length) route.dynamic = notes.join(' ; ');
      if (variant === DEFAULT_VARIANT) {
        byDefault.set(prefix, signature(route));
        out.push(route);
      } else if (byDefault.get(prefix) !== signature(route)) out.push({ ...route, variant });
    }
  }
  return out;
}

function splitOnce(text: string, sep: string): [string, string] {
  const at = text.indexOf(sep);
  return at < 0 ? [text.trim(), ''] : [text.slice(0, at).trim(), text.slice(at + 1)];
}

// ── NGINX ───────────────────────────────────────────────────────────────────────────────────────

interface Directive {
  name: string;
  args: string[];
  line: number;
  block?: Directive[];
}

/** Une lecture de la syntaxe NGINX : directives `nom args;` et blocs `nom args { … }`, commentaires ôtés. */
function nginxTree(text: string): Directive[] {
  const tokens: { t: string; line: number }[] = [];
  let line = 1;
  for (let i = 0; i < text.length;) {
    const c = text[i] ?? '';
    if (c === '\n') {
      line += 1;
      i += 1;
    } else if (/\s/.test(c)) i += 1;
    else if (c === '#') while (i < text.length && text[i] !== '\n') i += 1;
    else if (c === '{' || c === '}' || c === ';') {
      tokens.push({ t: c, line });
      i += 1;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += 1;
      tokens.push({ t: text.slice(i + 1, j), line });
      i = j + 1;
    } else {
      let j = i;
      while (j < text.length && !/[\s{};]/.test(text[j] ?? '')) j += 1;
      tokens.push({ t: text.slice(i, j), line });
      i = j;
    }
  }
  let at = 0;
  const parse = (): Directive[] => {
    const out: Directive[] = [];
    while (at < tokens.length) {
      const first = tokens[at];
      if (!first || first.t === '}') {
        at += 1;
        return out;
      }
      const d: Directive = { name: first.t, args: [], line: first.line };
      at += 1;
      while (at < tokens.length && tokens[at]?.t !== ';' && tokens[at]?.t !== '{' && tokens[at]?.t !== '}')
        d.args.push(tokens[at++]?.t ?? '');
      if (tokens[at]?.t === '{') {
        at += 1;
        d.block = parse();
      } else if (tokens[at]?.t === ';') at += 1;
      out.push(d);
    }
    return out;
  };
  return parse();
}

function nginxGateway(file: ReadFile, out: GatewayFacts): void {
  const tree = nginxTree(file.text);
  const all = (list: Directive[], name: string): Directive[] =>
    list.flatMap((d) => [...(d.name === name ? [d] : []), ...(d.block ? all(d.block, name) : [])]);
  const upstreams = new Map<string, string[]>();
  for (const u of all(tree, 'upstream'))
    upstreams.set(
      u.args[0] ?? '',
      (u.block ?? []).filter((d) => d.name === 'server').map((d) => d.args[0] ?? ''),
    );
  let order = 0;
  for (const server of all(tree, 'server').filter((d) => d.block)) {
    for (const listen of (server.block ?? []).filter((d) => d.name === 'listen')) {
      const port = Number(/(\d+)(?!.*\d)/.exec(listen.args[0] ?? '')?.[1]);
      if (port) out.listens.push({ port, file: file.path, line: listen.line });
    }
    for (const name of (server.block ?? []).filter((d) => d.name === 'server_name'))
      out.hosts.push(...name.args.filter((a) => a !== '_'));
    for (const location of (server.block ?? []).filter((d) => d.name === 'location' && d.block)) {
      const modifier = ['=', '~', '~*', '^~'].includes(location.args[0] ?? '') ? location.args[0] : undefined;
      const path = modifier ? (location.args[1] ?? '') : (location.args[0] ?? '');
      const pass = (location.block ?? []).find((d) => d.name === 'proxy_pass');
      if (!pass) continue;
      const uri = pass.args[0] ?? '';
      const filters: RouteFilter[] = [];
      const notes: string[] = [];
      for (const rw of (location.block ?? []).filter((d) => d.name === 'rewrite'))
        filters.push({
          kind: 'REWRITE_PATH',
          pattern: rw.args[0] ?? '',
          replacement: rw.args[1] ?? '',
          text: `rewrite ${rw.args.join(' ')}`,
        });
      if (/\$/.test(uri)) notes.push(`proxy_pass ${uri} dépend d’une variable`);
      const host = /^[a-z]+:\/\/([^/:]+)/i.exec(uri)?.[1];
      const upstream = host ? upstreams.get(host) : undefined;
      out.routes.push({
        adapter: 'NGINX',
        id: `location ${modifier ? `${modifier} ` : ''}${path}`,
        file: file.path,
        line: location.line,
        paths: [path],
        match: modifier === '=' ? 'EXACT' : modifier === '~' || modifier === '~*' ? 'REGEX' : 'PREFIX',
        methods: [],
        filters,
        uri,
        ...(upstream ? { upstream } : {}),
        order: order++,
        ...(notes.length ? { dynamic: notes.join(' ; ') } : {}),
      });
    }
  }
}

// ── Ingress ─────────────────────────────────────────────────────────────────────────────────────

function ingressGateway(file: ReadFile, out: GatewayFacts): void {
  let docs;
  try {
    docs = parseAllDocuments(file.text);
  } catch {
    return;
  }
  if (!Array.isArray(docs)) return;
  let order = 0;
  for (const doc of docs) {
    if (doc.errors.length) continue;
    const value = doc.toJS() as {
      kind?: string;
      metadata?: { name?: string; annotations?: Record<string, string> };
      spec?: {
        rules?: {
          host?: string;
          http?: {
            paths?: {
              path?: string;
              pathType?: string;
              backend?: {
                service?: { name?: string; port?: { number?: number; name?: string } };
                serviceName?: string;
                servicePort?: number | string;
              };
            }[];
          };
        }[];
      };
    } | null;
    if (value?.kind !== 'Ingress') continue;
    const rewrite = value.metadata?.annotations?.['nginx.ingress.kubernetes.io/rewrite-target'];
    const regex =
      value.metadata?.annotations?.['nginx.ingress.kubernetes.io/use-regex'] === 'true' || !!rewrite;
    for (const rule of value.spec?.rules ?? []) {
      if (rule.host) out.hosts.push(rule.host);
      for (const p of rule.http?.paths ?? []) {
        const service = p.backend?.service?.name ?? p.backend?.serviceName;
        const port =
          p.backend?.service?.port?.number ?? p.backend?.service?.port?.name ?? p.backend?.servicePort;
        if (!service) continue;
        const path = p.path ?? '/';
        const line = file.text.split(/\r?\n/).findIndex((l) => l.includes(`path: ${path}`)) + 1 || 1;
        out.routes.push({
          adapter: 'INGRESS',
          id: `${value.metadata?.name ?? 'ingress'} ${rule.host ?? '*'}${path}`,
          file: file.path,
          line,
          paths: [path],
          match: regex && /[()$^|*+?]/.test(path) ? 'REGEX' : p.pathType === 'Exact' ? 'EXACT' : 'PREFIX',
          methods: [],
          filters: rewrite
            ? [
                {
                  kind: 'REWRITE_PATH',
                  pattern: `^${path}`,
                  replacement: rewrite,
                  text: `rewrite-target: ${rewrite}`,
                },
              ]
            : [],
          uri: `${service}${port !== undefined ? `:${String(port)}` : ''}`,
          order: order++,
        });
      }
    }
  }
}

/** Les passerelles d'une source : NGINX (`*.conf`), Ingress (YAML `kind: Ingress`), Spring Cloud Gateway. */
export function readGateways(files: readonly ReadFile[], config?: SpringConfig): GatewayFacts | undefined {
  const out: GatewayFacts = { routes: [], listens: [], hosts: [], warnings: [] };
  for (const file of files) {
    if (/(^|\/)(nginx[\w.-]*|[\w.-]+)\.conf$/i.test(file.path) && /\bproxy_pass\b/.test(file.text))
      nginxGateway(file, out);
    else if (/\.ya?ml$/i.test(file.path) && /^kind:\s*Ingress\s*$/m.test(file.text))
      ingressGateway(file, out);
  }
  if (config) out.routes.push(...springGatewayRoutes(config));
  return out.routes.length ? out : undefined;
}

// ── Application d'une route à un chemin ─────────────────────────────────────────────────────────

/** Un motif de chemin Spring (`/api/**`, `/x/{id}`, `*`) en expression régulière. */
function springPattern(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i] ?? '';
    if (pattern.startsWith('/**', i)) {
      re += '(?:/.*)?';
      i += 2;
    } else if (pattern.startsWith('**', i)) {
      re += '.*';
      i += 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '{') {
      const end = pattern.indexOf('}', i);
      re += '[^/]+';
      i = end < 0 ? pattern.length : end;
    } else re += c.replace(/[.+?^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** Les paramètres d'appel (`{id}`) sont comparés comme un segment quelconque. */
const sample = (path: string): string => path.replace(/\{[^}]*\}/g, 'x');

export function routeMatches(route: GatewayRoute, method: string, path: string): boolean {
  if (route.methods.length && !route.methods.includes(method.toUpperCase())) return false;
  const p = sample(path);
  return route.paths.some((pattern) => {
    try {
      if (route.match === 'SPRING_PATTERN') return springPattern(pattern).test(p);
      if (route.match === 'EXACT') return p === pattern;
      if (route.match === 'REGEX') return new RegExp(pattern).test(p);
      return (
        p === pattern.replace(/\/$/, '') ||
        p.startsWith(pattern.endsWith('/') ? pattern : `${pattern}/`) ||
        pattern === '/'
      );
    } catch {
      return false;
    }
  });
}

/**
 * Le chemin reçu en aval par la destination : transformations (dans l'ordre), puis, pour NGINX, la partie chemin de
 * `proxy_pass` qui remplace le préfixe de la location, et la base de chemin de l'URI de destination.
 */
export function routedPath(route: GatewayRoute, path: string): { path: string; steps: string[] } {
  const steps: string[] = [];
  // Les paramètres sont gardés tels quels : seuls les segments littéraux comptent pour les transformations.
  let out = path;
  for (const f of route.filters) {
    const before = out;
    if (f.kind === 'STRIP_PREFIX')
      out = `/${out
        .split('/')
        .filter(Boolean)
        .slice(f.parts ?? 1)
        .join('/')}`;
    else if (f.kind === 'PREFIX_PATH') out = `${(f.prefix ?? '').replace(/\/$/, '')}${out}`;
    else
      try {
        out = out.replace(new RegExp(f.pattern ?? ''), f.replacement ?? '') || '/';
      } catch {
        continue;
      }
    if (out !== before) steps.push(`${f.text} : ${before} → ${out}`);
  }
  if (route.adapter === 'NGINX' && route.match === 'PREFIX' && route.filters.length === 0) {
    const uriPath = /^[a-z]+:\/\/[^/]+(\/.*)?$/i.exec(route.uri)?.[1];
    if (uriPath !== undefined) {
      const prefix = route.paths[0] ?? '/';
      const before = out;
      out = `${uriPath}${out.slice(prefix.length)}`.replace(/\/{2,}/g, '/');
      if (out !== before) steps.push(`proxy_pass ${route.uri} remplace ${prefix} : ${before} → ${out}`);
    }
  } else if (route.adapter !== 'NGINX') {
    const base = /^[a-z]+:\/\/[^/]+(\/[^?#]*)$/i.exec(route.uri)?.[1];
    if (base && base !== '/') {
      const before = out;
      out = `${base.replace(/\/$/, '')}${out}`;
      steps.push(`base de la destination ${base} : ${before} → ${out}`);
    }
  }
  return { path: out || '/', steps };
}

// ── Les services : à quelle source mène une adresse ─────────────────────────────────────────────

export interface ServiceSource {
  sourceId: string;
  name: string;
  /** `spring.application.name` (défaut), noms donnés à la source. */
  names: string[];
  /** Le port par variante (`server.port`), s'il est écrit. */
  ports: Record<string, number | undefined>;
  /** Une application qui sert des requêtes (code Java lu) : seule candidate à un port ou un nom. */
  serves: boolean;
  gateway?: GatewayFacts;
}

export interface Destination {
  /** Les sources désignées (une seule : démontrée ; plusieurs : ambiguë ; aucune : hors des sources). */
  sources: string[];
  rule: string;
  /** Une destination fournie seulement à l'exécution. */
  symbolic?: string;
  /** Une destination hors des sources analysées (passerelle ou service externe). */
  external?: string;
}

/** Les services lus dans les sources : noms et ports par variante (configuration Spring), passerelles. */
export function servicesOf(
  sources: {
    sourceId: string;
    name: string;
    serves: boolean;
    config?: SpringConfig;
    gateway?: GatewayFacts;
  }[],
): ServiceSource[] {
  return sources.map((s) => {
    const resolver = s.config ? new ConfigResolver(s.config) : undefined;
    const ports: Record<string, number | undefined> = {};
    for (const v of resolver?.variants() ?? [DEFAULT_VARIANT]) {
      const port = resolver?.resolve('server.port', v).value;
      ports[v] = port && /^\d+$/.test(port) ? Number(port) : undefined;
    }
    const app = resolver?.resolve('spring.application.name').value;
    return {
      sourceId: s.sourceId,
      name: s.name,
      names: [
        ...new Set([app, s.name, s.sourceId].filter((x): x is string => !!x).map((x) => x.toLowerCase())),
      ],
      ports,
      serves: s.serves,
      ...(s.gateway ? { gateway: s.gateway } : {}),
    };
  });
}

const LOCAL = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/i;

/**
 * La source qu'une adresse désigne : un port local égal au `server.port` d'une source (ou à l'écoute d'une
 * passerelle NGINX), un nom de service égal au nom d'application ou de source (`lb://nom`, service
 * Kubernetes, hôte). Une adresse à `${…}` non résolue reste symbolique ; rien n'est deviné.
 */
export function destinationOf(
  address: string,
  services: readonly ServiceSource[],
  variant = DEFAULT_VARIANT,
  upstream?: readonly string[],
): Destination {
  if (/\$\{|\$[A-Za-z_]/.test(address))
    return { sources: [], rule: `adresse ${address} fournie à l’exécution`, symbolic: address };
  const hosts = upstream?.length ? upstream : [address];
  const found = new Set<string>();
  const rules: string[] = [];
  const unknownPort: string[] = [];
  for (const h of hosts) {
    const m = /^(?:([a-z]+):\/\/)?([^/:]+)(?::(\d+))?/i.exec(h.trim());
    if (!m) continue;
    const scheme = m[1]?.toLowerCase();
    const host = (m[2] ?? '').toLowerCase();
    const port = m[3] ? Number(m[3]) : undefined;
    for (const s of services) {
      if (!s.serves && !s.gateway) continue;
      const sPort = s.ports[variant] ?? s.ports[DEFAULT_VARIANT];
      if (LOCAL.test(host) && sPort === undefined && !s.gateway?.listens.length) unknownPort.push(s.name);
      const listens = s.gateway?.listens.map((l) => l.port) ?? [];
      if (LOCAL.test(host) && port !== undefined && (sPort === port || listens.includes(port))) {
        found.add(s.sourceId);
        rules.push(`port ${String(port)} = ${sPort === port ? 'server.port' : 'listen'} de ${s.name}`);
      } else if (
        !LOCAL.test(host) &&
        (s.names.includes(host) || s.gateway?.hosts.map((x) => x.toLowerCase()).includes(host)) &&
        (scheme === 'lb' ||
          port === undefined ||
          sPort === undefined ||
          sPort === port ||
          listens.includes(port))
      ) {
        found.add(s.sourceId);
        rules.push(`${scheme === 'lb' ? 'lb://' : 'hôte '}${host} = nom de ${s.name}`);
      }
    }
  }
  if (found.size) return { sources: [...found], rule: rules.join(' ; ') };
  // Un port local qu'aucune source ne déclare, alors que certaines n'écrivent pas le leur : indéterminé.
  if (unknownPort.length)
    return {
      sources: [],
      rule: `${address} : aucune source ne déclare ce port ; sans port écrit : ${[...new Set(unknownPort)].join(', ')} (destination indéterminée)`,
    };
  return { sources: [], rule: `${address} ne désigne aucune source analysée`, external: address };
}
