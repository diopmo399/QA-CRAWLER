/**
 * PROGRESS — ce que le système fait APRÈS la dernière action (fin d'un enregistrement, fin des flows) :
 * finalisation, analyse, audits, rapports. Sans retour, ces secondes (ou minutes) ressemblent à un blocage.
 *
 * Un suivi par phases : la liste des phases est connue d'avance (une phase sautée avance quand même),
 * chaque phase peut donner un détail (« 3 validations restantes »). Indépendant de l'affichage : le terminal
 * (barre animée), le bandeau du navigateur ou un journal reçoivent les mêmes mises à jour.
 */
export interface ProgressUpdate {
  /** Ce qui est en cours dans son ensemble (« Finalizing the recording »). */
  task: string;
  /** La phase en cours, 1…total ; total+1 une fois terminé. */
  step: number;
  total: number;
  label: string;
  detail?: string;
  /** Temps écoulé depuis le début de la tâche (ms). */
  elapsedMs: number;
  state: 'RUNNING' | 'DONE' | 'FAILED';
}

export type ProgressSink = (update: ProgressUpdate) => void;

export class ProgressTracker {
  private index = 0;
  private label = '';
  /** Le temps compte à partir de la première phase (pas de la création du suivi). */
  private started: number | undefined;
  private finished = false;

  constructor(
    private readonly task: string,
    private readonly phases: readonly string[],
    private readonly sink: ProgressSink | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  /** Commence la phase `id` (une des phases annoncées) ; les phases d'avant sont considérées faites. */
  start(id: string, detail?: string): void {
    if (this.finished) return;
    this.started ??= this.now();
    const position = this.phases.indexOf(id);
    this.index =
      position >= 0 ? Math.max(this.index, position + 1) : Math.min(this.index + 1, this.phases.length);
    this.label = id;
    this.emit('RUNNING', detail);
  }

  /** Un détail pour la phase en cours (compte à rebours, élément traité). */
  detail(text: string): void {
    if (!this.finished && this.index > 0) this.emit('RUNNING', text);
  }

  done(summary?: string): void {
    if (this.finished) return;
    this.finished = true;
    this.index = this.phases.length + 1;
    this.label = summary ?? 'done';
    this.emit('DONE');
  }

  fail(reason: string): void {
    if (this.finished) return;
    this.finished = true;
    this.label = reason;
    this.emit('FAILED');
  }

  /** Une phase, du début à la fin (l'erreur remonte telle quelle). */
  async run<T>(id: string, work: () => Promise<T> | T): Promise<T> {
    this.start(id);
    // Laisse l'affichage montrer la phase avant un travail synchrone (qui bloque la boucle d'événements).
    await new Promise((resolve) => setImmediate(resolve));
    return work();
  }

  private emit(state: ProgressUpdate['state'], detail?: string): void {
    try {
      this.sink?.({
        task: this.task,
        step: this.index,
        total: this.phases.length,
        label: this.label,
        ...(detail ? { detail } : {}),
        elapsedMs: this.now() - (this.started ?? this.now()),
        state,
      });
    } catch {
      // L'affichage ne casse jamais le travail.
    }
  }
}
