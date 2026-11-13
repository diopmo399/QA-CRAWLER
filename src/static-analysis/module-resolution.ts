import path from 'node:path';

/**
 * LA RÉSOLUTION DES MODULES d'une source TypeScript, sans l'exécuter ni charger ses dépendances : un import
 * relatif, un alias de chemin déclaré dans un `tsconfig` de la source (`compilerOptions.paths`, `baseUrl`,
 * `extends` suivi dans la source), et les réexports d'un fichier baril (`export * from`, `export { A as B }
 * from`). Seuls les fichiers lus comptent : un module hors de la source (bibliothèque) n'est jamais résolu,
 * et un alias que rien ne déclare ne désigne aucun fichier.
 */
export interface SourceText {
  path: string;
  text: string;
}

const EXTENSIONS = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];
const MAX_REEXPORT_DEPTH = 8;
const MAX_EXTENDS_DEPTH = 6;
const TSCONFIG = /(^|\/)tsconfig[\w.-]*\.json$/;

/** Un fichier de configuration TypeScript (lu pour ses alias de chemin). */
export const isTsConfig = (file: string): boolean => TSCONFIG.test(file);

/** JSON de configuration : commentaires et virgules finales tolérés ; undefined s'il reste illisible. */
export function parseJsonc(text: string): unknown {
  let out = '';
  let i = 0;
  const n = text.length;
  /** L'indice du prochain caractère significatif (hors blancs et commentaires). */
  const significant = (from: number): number => {
    let j = from;
    for (;;) {
      while (j < n && /\s/.test(text[j] ?? '')) j += 1;
      if (text[j] === '/' && text[j + 1] === '/') {
        while (j < n && text[j] !== '\n') j += 1;
      } else if (text[j] === '/' && text[j + 1] === '*') {
        const end = text.indexOf('*/', j + 2);
        j = end < 0 ? n : end + 2;
      } else return j;
    }
  };
  while (i < n) {
    const c = text[i] ?? '';
    if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
      i = significant(i);
    } else if (c === ',') {
      const next = text[significant(i + 1)];
      if (next !== '}' && next !== ']') out += c;
      i += 1;
    } else {
      out += c;
      i += 1;
    }
  }
  try {
    return JSON.parse(out);
  } catch {
    return undefined;
  }
}

interface PathRule {
  prefix: string;
  suffix: string;
  star: boolean;
  /** Les cibles, relatives à la racine de la source (le `*` y reste). */
  targets: string[];
}
interface Mapping {
  /** Le dossier de base des imports non relatifs (`baseUrl`), relatif à la racine de la source. */
  baseUrl?: string;
  rules: PathRule[];
}
interface Reexports {
  stars: string[];
  named: Map<string, { from: string; name: string }>;
  declared: Set<string>;
}

const join = (...parts: string[]): string => {
  const joined = path.posix.normalize(path.posix.join(...parts));
  return joined === '.' ? '' : joined.replace(/^\.\//, '');
};

/** Retire les commentaires (bloc et ligne) sans toucher aux chaînes simples des imports. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

const EXPORT_STAR = /\bexport\s+\*\s+from\s*['"]([^'"]+)['"]/g;
const EXPORT_NAMED = /\bexport\s+(?:type\s+)?\{([^}]*)\}(\s*from\s*['"]([^'"]+)['"])?/g;
const EXPORT_DECLARED =
  /\bexport\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:class|const|let|var|function\*?|enum|interface|type)\s+([A-Za-z_$][\w$]*)/g;

export class ModuleResolver {
  private readonly known: ReadonlySet<string>;
  private readonly texts: ReadonlyMap<string, string>;
  /** dossier → les alias valables pour ses fichiers (ceux des `tsconfig` du dossier). */
  private readonly mappings = new Map<string, Mapping>();
  private readonly exportsOf = new Map<string, Reexports>();
  private readonly resolved = new Map<string, string | null>();

  /** `files` : les fichiers de code ; `configs` : les `tsconfig*.json` de la source (défaut : ceux de `files`). */
  constructor(files: readonly SourceText[], configs: readonly SourceText[] = files) {
    this.known = new Set(files.map((f) => f.path));
    this.texts = new Map(files.map((f) => [f.path, f.text]));
    const byPath = new Map(configs.filter((f) => isTsConfig(f.path)).map((f) => [f.path, f]));
    const effective = (file: string, depth: number): Mapping | undefined => {
      const config = byPath.get(file);
      const json = config ? parseJsonc(config.text) : undefined;
      if (!json || typeof json !== 'object') return undefined;
      const dir = path.posix.dirname(file) === '.' ? '' : path.posix.dirname(file);
      const record = json as { extends?: unknown; compilerOptions?: { baseUrl?: unknown; paths?: unknown } };
      let inherited: Mapping | undefined;
      const parents = Array.isArray(record.extends) ? record.extends : [record.extends];
      if (depth < MAX_EXTENDS_DEPTH)
        for (const parent of parents) {
          if (typeof parent !== 'string' || !parent.startsWith('.')) continue;
          const base = join(dir, parent);
          const found = [base, `${base}.json`].find((candidate) => byPath.has(candidate));
          const got = found ? effective(found, depth + 1) : undefined;
          // Plusieurs parents : le dernier l'emporte, comme pour le compilateur.
          if (got) inherited = { ...inherited, ...got };
        }
      const options = record.compilerOptions ?? {};
      const baseUrl = typeof options.baseUrl === 'string' ? join(dir, options.baseUrl) : inherited?.baseUrl;
      let rules = inherited?.rules ?? [];
      if (options.paths && typeof options.paths === 'object') {
        // Les cibles sont relatives à `baseUrl` s'il est donné, sinon au dossier du fichier qui les déclare.
        const from = baseUrl ?? dir;
        rules = Object.entries(options.paths as Record<string, unknown>).flatMap(([pattern, targets]) => {
          if (!Array.isArray(targets)) return [];
          const star = pattern.indexOf('*');
          return [
            {
              prefix: star < 0 ? pattern : pattern.slice(0, star),
              suffix: star < 0 ? '' : pattern.slice(star + 1),
              star: star >= 0,
              targets: targets.filter((t): t is string => typeof t === 'string').map((t) => join(from, t)),
            },
          ];
        });
      }
      return { ...(baseUrl !== undefined ? { baseUrl } : {}), rules };
    };
    // Dans un dossier, `tsconfig.json` passe avant ses variantes (app, spec, base).
    const ordered = [...byPath.keys()].sort(
      (a, b) =>
        Number(!a.endsWith('/tsconfig.json') && a !== 'tsconfig.json') -
          Number(!b.endsWith('/tsconfig.json') && b !== 'tsconfig.json') || (a < b ? -1 : a > b ? 1 : 0),
    );
    for (const file of ordered) {
      const got = effective(file, 0);
      if (!got || (got.rules.length === 0 && got.baseUrl === undefined)) continue;
      const dir = path.posix.dirname(file) === '.' ? '' : path.posix.dirname(file);
      const before = this.mappings.get(dir);
      if (!before) this.mappings.set(dir, got);
      else {
        const seen = new Set(before.rules.map((r) => `${r.prefix}*${r.suffix}`));
        before.rules.push(...got.rules.filter((r) => !seen.has(`${r.prefix}*${r.suffix}`)));
        before.baseUrl ??= got.baseUrl;
      }
    }
  }

  /** La source déclare-t-elle au moins un alias de chemin ? */
  get hasAliases(): boolean {
    return this.mappings.size > 0;
  }

  private exists(base: string): string | undefined {
    const clean = base.replace(/\.js$/, '');
    return EXTENSIONS.map((ext) => clean + ext).find((candidate) => this.known.has(candidate));
  }

  /** Le fichier de la source que `specifier` désigne depuis `fromFile` ; undefined : hors de la source. */
  resolve(fromFile: string, specifier: string): string | undefined {
    const key = `${fromFile}\u0000${specifier}`;
    const cached = this.resolved.get(key);
    if (cached !== undefined) return cached ?? undefined;
    const found = this.locate(fromFile, specifier);
    this.resolved.set(key, found ?? null);
    return found;
  }

  private locate(fromFile: string, specifier: string): string | undefined {
    const fromDir = path.posix.dirname(fromFile) === '.' ? '' : path.posix.dirname(fromFile);
    if (specifier.startsWith('.')) return this.exists(join(fromDir, specifier));
    if (this.mappings.size === 0) return undefined;
    // Du dossier du fichier vers la racine : le premier `tsconfig` dont un alias mène à un fichier lu.
    for (let dir = fromDir; ; dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '') {
      const mapping = this.mappings.get(dir);
      if (mapping) {
        const matching = mapping.rules
          .filter((r) =>
            r.star
              ? specifier.startsWith(r.prefix) &&
                specifier.endsWith(r.suffix) &&
                specifier.length >= r.prefix.length + r.suffix.length
              : specifier === r.prefix,
          )
          .sort((a, b) => b.prefix.length - a.prefix.length);
        for (const rule of matching) {
          const captured = rule.star
            ? specifier.slice(rule.prefix.length, specifier.length - rule.suffix.length)
            : '';
          for (const target of rule.targets) {
            const hit = this.exists(target.replace('*', captured));
            if (hit) return hit;
          }
        }
        if (mapping.baseUrl !== undefined) {
          const hit = this.exists(join(mapping.baseUrl, specifier));
          if (hit) return hit;
        }
      }
      if (dir === '') return undefined;
    }
  }

  private reexportsOf(file: string): Reexports {
    let found = this.exportsOf.get(file);
    if (found) return found;
    found = { stars: [], named: new Map(), declared: new Set() };
    const text = withoutComments(this.texts.get(file) ?? '');
    if (text.includes('export')) {
      for (const m of text.matchAll(EXPORT_STAR)) if (m[1]) found.stars.push(m[1]);
      for (const m of text.matchAll(EXPORT_DECLARED)) if (m[1]) found.declared.add(m[1]);
      for (const m of text.matchAll(EXPORT_NAMED))
        for (const part of (m[1] ?? '').split(',')) {
          const binding = /^\s*(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(part);
          if (!binding?.[1]) continue;
          // `export { A as B } from './x'` : B vient de A dans x ; sans `from`, B est déclaré ici.
          if (m[3]) found.named.set(binding[2] ?? binding[1], { from: m[3], name: binding[1] });
          else found.declared.add(binding[2] ?? binding[1]);
        }
    }
    this.exportsOf.set(file, found);
    return found;
  }

  /**
   * Le fichier qui déclare réellement `name`, exporté par `file` : `file` lui-même, ou le fichier atteint en
   * suivant ses réexports (profondeur bornée, cycles ignorés). undefined : rien de lu ne le déclare.
   */
  origin(file: string, name: string): { file: string; name: string } | undefined {
    const seen = new Set<string>();
    const follow = (
      current: string,
      wanted: string,
      depth: number,
    ): { file: string; name: string } | undefined => {
      const key = `${current}\u0000${wanted}`;
      if (depth > MAX_REEXPORT_DEPTH || seen.has(key)) return undefined;
      seen.add(key);
      const exports = this.reexportsOf(current);
      if (exports.declared.has(wanted)) return { file: current, name: wanted };
      const named = exports.named.get(wanted);
      if (named) {
        const target = this.resolve(current, named.from);
        return target ? follow(target, named.name, depth + 1) : undefined;
      }
      for (const star of exports.stars) {
        const target = this.resolve(current, star);
        const hit = target ? follow(target, wanted, depth + 1) : undefined;
        if (hit) return hit;
      }
      return undefined;
    };
    return follow(file, name, 0);
  }
}
