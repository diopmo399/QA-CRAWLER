import path from 'node:path';

/**
 * L'IDENTITÉ DES CLASSES d'une source TypeScript. Une classe est d'abord désignée par son nom ; deux classes
 * de même nom dans des fichiers différents (`admin/list/list.component.ts` et `catalog/list/…`) reçoivent
 * chacune une identité distincte, « ListComponent(admin/list) », au lieu que la seconde soit ignorée. Une
 * référence (type injecté, classe de base, composant d'une route) est résolue par les imports du fichier
 * qui l'écrit, alias compris (`import { ListComponent as AdminList }`), jamais par le nom seul quand il est
 * ambigu : une référence ambiguë reste non résolue plutôt que d'être attribuée au hasard.
 */
export interface ImportBinding {
  /** Le nom exporté par le module (`ListComponent` dans `ListComponent as AdminList`). */
  name: string;
  /** Le fichier du dépôt qui l'exporte (chemin relatif à la source), quand l'import est relatif et trouvé. */
  file?: string;
  /** Le module tel qu'écrit (`./admin/list/list.component`, `@angular/core`). */
  specifier: string;
}

const EXTENSIONS = ['', '.ts', '.tsx', '/index.ts'];
const DECLARATION = /(?:^|[\s;}])(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g;
const IMPORT = /\bimport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;

/** Retire les commentaires (bloc et ligne) sans toucher aux chaînes simples des imports. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

/** Les classes déclarées dans un texte TypeScript (hors commentaires). */
export function declaredClasses(text: string): string[] {
  return [...withoutComments(text).matchAll(DECLARATION)].map((m) => m[1] ?? '').filter(Boolean);
}

/** Les liaisons d'import nommées d'un fichier : nom local → nom exporté, fichier du dépôt s'il est trouvé. */
export function importBindingsOf(
  file: string,
  text: string,
  known: ReadonlySet<string>,
): Map<string, ImportBinding> {
  const out = new Map<string, ImportBinding>();
  for (const m of withoutComments(text).matchAll(IMPORT)) {
    const specifier = m[2] ?? '';
    let target: string | undefined;
    if (specifier.startsWith('.')) {
      const base = path.posix
        .normalize(path.posix.join(path.posix.dirname(file), specifier))
        .replace(/\.js$/, '');
      target = EXTENSIONS.map((ext) => base + ext).find((candidate) => known.has(candidate));
    }
    for (const part of (m[1] ?? '').split(',')) {
      const binding = /^\s*(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(part);
      if (!binding?.[1]) continue;
      out.set(binding[2] ?? binding[1], {
        name: binding[1],
        specifier,
        ...(target ? { file: target } : {}),
      });
    }
  }
  return out;
}

const isAnalyzed = (file: string): boolean => /\.(ts|tsx)$/.test(file) && !/\.(spec|test|d)\.ts$/.test(file);

export class ClassIdentity {
  /** nom → fichiers qui déclarent une classe de ce nom. */
  private readonly declarations = new Map<string, string[]>();
  private readonly keys = new Map<string, string>();
  private readonly imports = new Map<string, Map<string, ImportBinding>>();
  private readonly texts: ReadonlyMap<string, string>;
  private readonly known: ReadonlySet<string>;

  constructor(files: readonly { path: string; text: string }[]) {
    this.texts = new Map(files.map((f) => [f.path, f.text]));
    this.known = new Set(files.map((f) => f.path));
    for (const f of files) {
      if (!isAnalyzed(f.path)) continue;
      for (const name of new Set(declaredClasses(f.text))) {
        const list = this.declarations.get(name);
        if (list) list.push(f.path);
        else this.declarations.set(name, [f.path]);
      }
    }
    for (const [name, list] of this.declarations) {
      if (list.length < 2) continue;
      const sorted = [...list].sort();
      const dirs = sorted.map((f) =>
        path.posix
          .dirname(f)
          .split('/')
          .filter((s) => s && s !== '.'),
      );
      // Le plus court suffixe de dossiers qui distingue toutes les déclarations ; sinon le fichier.
      let suffixes: string[] | undefined;
      const longest = Math.max(...dirs.map((d) => d.length));
      for (let depth = 1; depth <= longest && !suffixes; depth += 1) {
        const candidate = dirs.map((d) => d.slice(-depth).join('/'));
        if (new Set(candidate).size === candidate.length) suffixes = candidate;
      }
      suffixes ??= sorted.map((f) => f.replace(/\.(ts|tsx)$/, ''));
      sorted.forEach((file, i) => this.keys.set(`${file}\u0000${name}`, `${name}(${suffixes[i] ?? file})`));
    }
  }

  /** Plusieurs classes portent-elles ce nom ? */
  duplicated(name: string): boolean {
    return (this.declarations.get(name)?.length ?? 0) > 1;
  }

  /** Les noms qui désignent plusieurs classes. */
  duplicates(): string[] {
    return [...this.declarations].filter(([, list]) => list.length > 1).map(([name]) => name);
  }

  /** L'identité de la classe `name` déclarée dans `file` (son nom, s'il est unique). */
  key(file: string, name: string): string {
    return this.keys.get(`${file}\u0000${name}`) ?? name;
  }

  importsOf(file: string): Map<string, ImportBinding> {
    let found = this.imports.get(file);
    if (!found) {
      found = importBindingsOf(file, this.texts.get(file) ?? '', this.known);
      this.imports.set(file, found);
    }
    return found;
  }

  /**
   * L'identité de la classe que `ref` désigne dans `fromFile` : une classe du même fichier, l'import (alias
   * compris), ou le nom s'il est unique. undefined : le nom est ambigu et rien ne permet de trancher.
   * Un nom inconnu (classe d'une bibliothèque) est rendu tel quel.
   */
  resolve(fromFile: string, ref: string): string | undefined {
    const files = this.declarations.get(ref);
    if (files?.includes(fromFile)) return this.key(fromFile, ref);
    const imported = this.importsOf(fromFile).get(ref);
    if (imported) {
      if (imported.file && this.declarations.get(imported.name)?.includes(imported.file))
        return this.key(imported.file, imported.name);
      // Un module hors du dépôt, ou un fichier qui ne déclare pas la classe (réexport) : le nom exporté.
      return this.duplicated(imported.name) ? undefined : imported.name;
    }
    return this.duplicated(ref) ? undefined : ref;
  }
}
