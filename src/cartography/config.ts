import { parseAllDocuments } from 'yaml';
import type { ReadFile } from './files.js';

/**
 * LE MODÈLE COMMUN DE CONFIGURATION d'une source : chaque valeur lue garde son fichier, sa ligne et son
 * profil (fichier `application-{profil}`, document YAML `spring.config.activate.on-profile`). Rien n'est
 * fusionné arbitrairement : une valeur est résolue PAR VARIANTE (le défaut, puis chaque profil découvert),
 * selon la seule règle de priorité établie (une valeur d'un profil remplace celle du défaut). Les valeurs
 * dont la clé désigne un secret ne sont jamais conservées. Une valeur fournie seulement à l'exécution
 * (`${VARIABLE}` absente de la configuration) reste symbolique.
 */
export interface ConfigEntry {
  key: string;
  /** La valeur telle qu'écrite (masquée pour un secret). */
  value: string;
  file: string;
  line: number;
  profile?: string;
  secret?: true;
}

export interface ConfigProfile {
  name: string;
  file: string;
  line: number;
  /** FILE : `application-{profil}` ; DOCUMENT : on-profile ; ACTIVE : `spring.profiles.active` ; MAVEN : profil du pom. */
  how: 'FILE' | 'DOCUMENT' | 'ACTIVE' | 'MAVEN';
}

export interface SpringConfig {
  entries: ConfigEntry[];
  profiles: ConfigProfile[];
}

export const DEFAULT_VARIANT = 'default';
const SECRET = /(password|passwd|pwd|secret|token|credential|api[-_.]?key|private[-_.]?key)/i;
export const MASK = '***';
const CONFIG_FILE = /(^|\/)(application|bootstrap)(-([\w.-]+))?\.(ya?ml|properties)$/i;

/**
 * La ligne d'une clé : écrite en entier (`a.b=…`), sinon sa dernière partie ; `occurrence` choisit la n-ième
 * ligne de cette partie (les éléments d'une liste YAML répètent les mêmes noms, lus dans l'ordre du document).
 */
const lineOf = (lines: readonly string[], key: string, occurrence = 0): number => {
  const leaf =
    key
      .split('.')
      .pop()
      ?.replace(/\[\d+\]$/, '') ?? key;
  const exact = lines.findIndex(
    (l) => l.trimStart().startsWith(`${key}=`) || l.trimStart().startsWith(`${key}:`),
  );
  if (exact >= 0) return exact + 1;
  const re = new RegExp(`^\\s*-?\\s*${leaf.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}\\s*[:=]`);
  const all = lines.flatMap((l, i) => (re.test(l) ? [i] : []));
  const near = all[Math.min(occurrence, all.length - 1)];
  return near !== undefined ? near + 1 : 1;
};

function flatten(value: unknown, prefix: string, out: Map<string, string>): void {
  if (value === null || value === undefined) {
    if (prefix) out.set(prefix, '');
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      flatten(item, `${prefix}[${String(index)}]`, out);
    });
    return;
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>))
      flatten(child, prefix ? `${prefix}.${key}` : key, out);
    return;
  }
  if (prefix) out.set(prefix, typeof value === 'string' ? value : JSON.stringify(value));
}

function properties(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    let line = (lines[i] ?? '').trimStart();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    while (/(^|[^\\])(\\\\)*\\$/.test(line) && i + 1 < lines.length)
      line = line.slice(0, -1) + (lines[++i] ?? '').trimStart();
    const at = line.search(/[=:]/);
    if (at < 0) continue;
    out.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  return out;
}

/** La configuration Spring d'une source, entrée par entrée, avec son profil. */
export function readSpringConfig(files: readonly ReadFile[]): SpringConfig {
  const entries: ConfigEntry[] = [];
  const profiles: ConfigProfile[] = [];
  for (const file of files) {
    const match = CONFIG_FILE.exec(file.path);
    if (!match) continue;
    const fileProfile = match[4];
    const lines = file.text.split(/\r?\n/);
    if (fileProfile) profiles.push({ name: fileProfile, file: file.path, line: 1, how: 'FILE' });
    const docs: { values: Map<string, string>; profile?: string }[] = [];
    if (/\.properties$/i.test(file.path)) docs.push({ values: properties(file.text) });
    else {
      let parsed;
      try {
        parsed = parseAllDocuments(file.text);
      } catch {
        continue;
      }
      if (!Array.isArray(parsed)) continue;
      for (const doc of parsed) {
        if (doc.errors.length > 0) continue;
        const values = new Map<string, string>();
        flatten(doc.toJS() as unknown, '', values);
        const on = values.get('spring.config.activate.on-profile') ?? values.get('spring.profiles');
        docs.push({ values, ...(on ? { profile: on } : {}) });
        if (on)
          profiles.push({ name: on, file: file.path, line: lineOf(lines, 'on-profile'), how: 'DOCUMENT' });
      }
    }
    // Combien de fois chaque dernière partie de clé a déjà été vue dans ce fichier (ordre du document).
    const seen = new Map<string, number>();
    for (const doc of docs) {
      const profile = doc.profile ?? fileProfile;
      for (const [key, value] of doc.values) {
        const leaf =
          key
            .split('.')
            .pop()
            ?.replace(/\[\d+\]$/, '') ?? key;
        const occurrence = seen.get(leaf) ?? 0;
        seen.set(leaf, occurrence + 1);
        if (key === 'spring.config.activate.on-profile' || key === 'spring.profiles') continue;
        const secret = SECRET.test(key);
        entries.push({
          key,
          value: secret ? MASK : value,
          file: file.path,
          line: lineOf(lines, key, occurrence),
          ...(profile ? { profile } : {}),
          ...(secret ? { secret: true as const } : {}),
        });
        if (key === 'spring.profiles.active' && !secret)
          for (const name of value
            .split(',')
            .map((p) => p.trim())
            .filter((p) => p && !p.includes('${')))
            profiles.push({ name, file: file.path, line: lineOf(lines, key), how: 'ACTIVE' });
      }
    }
  }
  return { entries, profiles };
}

export interface Resolved {
  variant: string;
  value?: string;
  /** Les entrées qui ont donné la valeur (la dernière gagne) et celles qu'elle remplace. */
  from: ConfigEntry[];
  overrides: ConfigEntry[];
  /** Variables fournies seulement à l'exécution (`${VARIABLE}` absente de la configuration). */
  runtime: string[];
  /** Clés référencées sans valeur ni défaut. */
  unresolved: string[];
  secret?: true;
}

/**
 * La résolution d'une clé ou d'un texte à `${…}` dans une variante. Le défaut ne lit que les entrées sans
 * profil ; un profil lit le défaut puis ses propres entrées, qui le remplacent (règle Spring établie). Les
 * profils activés ensemble ne sont pas combinés : chacun est une variante.
 */
export class ConfigResolver {
  private readonly byKey = new Map<string, ConfigEntry[]>();
  constructor(readonly config: SpringConfig) {
    for (const e of config.entries) this.byKey.set(e.key, [...(this.byKey.get(e.key) ?? []), e]);
  }

  variants(): string[] {
    return [
      DEFAULT_VARIANT,
      ...new Set(this.config.profiles.filter((p) => p.how !== 'ACTIVE').map((p) => p.name)),
    ];
  }

  /** Les profils déclarés actifs par défaut (`spring.profiles.active` du défaut), s'il y en a. */
  active(): ConfigProfile[] {
    return this.config.profiles.filter((p) => p.how === 'ACTIVE');
  }

  private entry(key: string, variant: string): { winner?: ConfigEntry; overridden: ConfigEntry[] } {
    const list = this.byKey.get(key) ?? [];
    const base = list.filter((e) => !e.profile);
    const own = variant === DEFAULT_VARIANT ? [] : list.filter((e) => e.profile === variant);
    const winner = own[own.length - 1] ?? base[base.length - 1];
    return { ...(winner ? { winner } : {}), overridden: own.length ? base : [] };
  }

  resolve(key: string, variant = DEFAULT_VARIANT): Resolved {
    const { winner, overridden } = this.entry(key, variant);
    if (!winner) return { variant, from: [], overrides: [], runtime: [], unresolved: [key] };
    if (winner.secret)
      return { variant, from: [winner], overrides: overridden, runtime: [], unresolved: [], secret: true };
    const text = this.text(winner.value, variant);
    return { ...text, from: [winner, ...text.from], overrides: overridden };
  }

  /** Un texte où `${clé:défaut}` est remplacé par sa valeur dans la variante (profondeur bornée). */
  text(template: string, variant = DEFAULT_VARIANT, depth = 0): Resolved {
    const out: Resolved = { variant, from: [], overrides: [], runtime: [], unresolved: [] };
    // Un objet : la fonction de remplacement le modifie (un `let` y paraîtrait toujours faux).
    const state = { symbolic: false };
    const value = template.replace(
      /\$\{([^}:]+)(?::([^}]*))?\}/g,
      (whole, key: string, fallback?: string) => {
        const found = depth < 8 ? this.entry(key, variant).winner : undefined;
        if (found && !found.secret) {
          const inner = this.text(found.value, variant, depth + 1);
          out.from.push(found, ...inner.from);
          out.runtime.push(...inner.runtime);
          out.unresolved.push(...inner.unresolved);
          if (inner.value === undefined) state.symbolic = true;
          return inner.value ?? whole;
        }
        if (found?.secret) {
          out.secret = true;
          state.symbolic = true;
          return whole;
        }
        if (fallback !== undefined) return fallback;
        // Une variable d'environnement (MAJUSCULES) ou une clé absente : fournie à l'exécution, jamais inventée.
        if (/^[A-Z][A-Z0-9_]*$/.test(key)) out.runtime.push(key);
        else out.unresolved.push(key);
        state.symbolic = true;
        return whole;
      },
    );
    return state.symbolic ? out : { ...out, value };
  }

  /** La valeur d'une clé dans chaque variante ; une seule entrée quand toutes concordent. */
  alternatives(key: string): Resolved[] {
    const all = this.variants().map((v) => this.resolve(key, v));
    const distinct = new Set(
      all.map((r) => r.value ?? `\u0000${r.unresolved.join(',')}${r.runtime.join(',')}`),
    );
    return distinct.size <= 1 ? all.slice(0, 1) : all;
  }
}
