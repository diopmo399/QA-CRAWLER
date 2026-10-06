import { sha256, type SourceFile, type SourceSet } from '../source-set.js';
import { languageOf, type StaticSourceOrigin, type StaticSourceProvenance } from './model.js';

export interface WorkspaceBudget {
  /** Fichiers au plus dans le workspace (tous fournisseurs confondus). */
  maxExtractedSources: number;
  maxFileSizeBytes: number;
}

export type WorkspaceAddOutcome =
  | 'ADDED'
  /** Même chemin, même contenu (le même module dans deux chunks) : gardé une fois. */
  | 'DUPLICATE'
  /** Deux source maps donnent deux contenus pour le même chemin : le premier est gardé. */
  | 'CONFLICT'
  /** Le dépôt et le build déployé divergent : le build (preuve d'exécution) est gardé. */
  | 'MISMATCH'
  | 'BUDGET'
  | 'TOO_LARGE';

export interface WorkspaceFileInput extends Omit<StaticSourceProvenance, 'contentHash' | 'path'> {
  path: string;
  text: string;
}

/** Un fichier du workspace : le contenu (en mémoire seulement) et sa provenance. */
interface WorkspaceEntry {
  file: SourceFile;
  provenance: StaticSourceProvenance;
}

/**
 * VIRTUAL SOURCE WORKSPACE : l'arborescence reconstruite en MÉMOIRE que l'analyseur
 * existant lit comme un dépôt. Rien n'est écrit sur disque ; seuls chemins et
 * empreintes sortent d'ici (rapport, cache, journal).
 *
 * - Déduplication par chemin normalisé + empreinte du contenu.
 * - Même chemin, contenus différents entre deux source maps : SOURCE_CONTENT_CONFLICT,
 *   le premier est gardé, l'analyse devient PARTIAL.
 * - Dépôt ≠ build déployé (mode hybride) : SOURCE_BUILD_MISMATCH, le contenu issu du
 *   runtime est préféré — c'est lui qui s'exécute dans le navigateur.
 */
export class VirtualSourceWorkspace {
  private readonly entries = new Map<string, WorkspaceEntry>();
  private readonly notes: string[] = [];
  private readonly skipped: string[] = [];
  private exhausted = false;
  readonly conflicts: string[] = [];
  readonly mismatches: string[] = [];
  /** Incrémenté à chaque changement : une analyse n'est refaite que si le workspace a bougé. */
  private revision = 0;

  constructor(private readonly budget: WorkspaceBudget) {}

  add(input: WorkspaceFileInput): WorkspaceAddOutcome {
    const bytes = Buffer.byteLength(input.text, 'utf8');
    if (bytes > this.budget.maxFileSizeBytes) {
      this.skipped.push(input.path);
      return 'TOO_LARGE';
    }
    const hash = sha256(input.text);
    const { text, ...rest } = input;
    const provenance: StaticSourceProvenance = { ...rest, contentHash: hash };
    const existing = this.entries.get(input.path);
    if (existing) {
      if (existing.file.hash === hash) return 'DUPLICATE';
      if (existing.provenance.origin === 'REPOSITORY' && input.origin !== 'REPOSITORY') {
        this.mismatches.push(input.path);
        this.set(input.path, text, hash, bytes, provenance);
        return 'MISMATCH';
      }
      if (existing.provenance.origin !== 'REPOSITORY' && input.origin === 'REPOSITORY') {
        this.mismatches.push(input.path);
        return 'MISMATCH';
      }
      this.conflicts.push(input.path);
      this.note(`SOURCE_CONTENT_CONFLICT: ${input.path} differs between two source maps (first kept)`);
      return 'CONFLICT';
    }
    if (this.entries.size >= this.budget.maxExtractedSources) {
      if (!this.exhausted) this.note('STATIC_ANALYSIS_BUDGET_EXHAUSTED: maxExtractedSources reached');
      this.exhausted = true;
      this.skipped.push(input.path);
      return 'BUDGET';
    }
    this.set(input.path, text, hash, bytes, provenance);
    return 'ADDED';
  }

  private set(
    filePath: string,
    text: string,
    hash: string,
    bytes: number,
    provenance: StaticSourceProvenance,
  ): void {
    this.entries.set(filePath, { file: { path: filePath, text, hash, bytes }, provenance });
    this.revision += 1;
  }

  /** Une limite de la lecture (source map partielle, rejet, repli) : l'analyse sera PARTIAL. */
  note(message: string): void {
    if (!this.notes.includes(message) && this.notes.length < 50) {
      this.notes.push(message);
      this.revision += 1;
    }
  }

  get size(): number {
    return this.entries.size;
  }

  get version(): number {
    return this.revision;
  }

  has(filePath: string): boolean {
    return this.entries.has(filePath);
  }

  /** L'empreinte du contenu déjà gardé à ce chemin (undefined : chemin libre). */
  hashOf(filePath: string): string | undefined {
    return this.entries.get(filePath)?.file.hash;
  }

  origins(): Set<StaticSourceOrigin> {
    return new Set([...this.entries.values()].map((entry) => entry.provenance.origin));
  }

  provenance(): StaticSourceProvenance[] {
    return [...this.entries.values()]
      .map((entry) => entry.provenance)
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Ce que l'analyseur existant lit : un SourceSet ordinaire, plus la provenance de chaque fichier. */
  toSourceSet(root = 'workspace'): SourceSet {
    const files = [...this.entries.values()]
      .map((entry) => entry.file)
      .filter((file) => languageOf(file.path) !== undefined)
      .sort((a, b) => a.path.localeCompare(b.path));
    return {
      root,
      files,
      hash: sha256(files.map((file) => `${file.path}\n${file.hash}`).join('\n')),
      bytes: files.reduce((sum, file) => sum + file.bytes, 0),
      skipped: [...this.skipped],
      budgetExhausted: this.exhausted,
      notes: [...this.notes],
      provenance: this.provenance(),
    };
  }
}
