import { appendFile, readFile } from 'node:fs/promises';
import { REDACTED, redactText } from '../../security/redactor.js';
import type { RunLogEvent, RunLogsInfo } from '../core/contracts.js';

/**
 * LE JOURNAL D'UNE EXÉCUTION DE TEST GÉNÉRÉ : chaque événement reçu d'une source réelle (moteur,
 * reporter, sortie d'un outil, serveur) est masqué, numéroté, horodaté, envoyé aux abonnés (console en
 * direct) et ajouté à `events.jsonl` dans le dossier de l'exécution. La mémoire est bornée : pendant le
 * run, les derniers événements ; une fois terminé, plus rien (le fichier fait foi).
 */

export const EVENTS_FILE = 'events.jsonl';

/** Les derniers événements gardés en mémoire pendant un run (abonnés qui reprennent après une coupure). */
const MAX_MEMORY = 5000;
/** Au-delà, les événements ne sont plus conservés (le nombre écarté est dit). */
export const MAX_STORED_EVENTS = 50_000;
const MAX_MESSAGE = 2000;
const MAX_DATA_VALUE = 500;
const FLUSH_MS = 150;

export type RunLogInput = Omit<RunLogEvent, 'seq' | 'at' | 'runId'> & { at?: string };

/**
 * Masque, dans un texte, les valeurs secrètes connues de ce run (variables d'identifiants de la mission
 * et de l'environnement), en plus des règles générales du masquage (jetons, en-têtes, mots de passe).
 */
export function maskSecrets(text: string, secrets: readonly string[]): string {
  let result = redactText(text);
  for (const secret of secrets) if (secret.length >= 4) result = result.split(secret).join(REDACTED);
  return result;
}

/** Les codes de couleur et de curseur d'un terminal (erreurs de Playwright, sortie de Maven) : illisibles dans une page. */
// eslint-disable-next-line no-control-regex -- le caractère d'échappement est ce qui est cherché
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export class RunEventLog {
  private seq = 0;
  private memory: RunLogEvent[] = [];
  private readonly listeners = new Set<(event: RunLogEvent) => void>();
  private pending: string[] = [];
  private timer: NodeJS.Timeout | undefined;
  private writing: Promise<void> = Promise.resolve();
  private stored = 0;
  private droppedCount = 0;
  private finished = false;

  constructor(
    readonly runId: string,
    readonly file: string,
    private readonly secrets: readonly string[] = [],
  ) {}

  get lastSeq(): number {
    return this.seq;
  }

  get closed(): boolean {
    return this.finished;
  }

  info(): RunLogsInfo {
    return {
      state: this.finished ? 'STORED' : 'LIVE',
      count: this.stored,
      ...(this.droppedCount > 0 ? { dropped: this.droppedCount } : {}),
    };
  }

  /** Un événement reçu : masqué, numéroté, distribué, écrit. Rien après la fin du run. */
  emit(input: RunLogInput): RunLogEvent | undefined {
    if (this.finished) return undefined;
    const final = input.type === 'RUN_FINISHED';
    if (this.stored >= MAX_STORED_EVENTS && !final) {
      this.droppedCount += 1;
      return undefined;
    }
    const mask = (text: string): string => maskSecrets(text.replace(ANSI, ''), this.secrets);
    const data = input.data
      ? Object.fromEntries(
          Object.entries(input.data).map(([key, value]) => [
            key,
            typeof value === 'string' ? clip(mask(value), MAX_DATA_VALUE) : value,
          ]),
        )
      : undefined;
    const { at, data: _data, ...rest } = input;
    const event: RunLogEvent = {
      ...rest,
      seq: ++this.seq,
      at: at ?? new Date().toISOString(),
      runId: this.runId,
      message: clip(mask(input.message), MAX_MESSAGE),
      ...(input.scenario !== undefined ? { scenario: clip(mask(input.scenario), 300) } : {}),
      ...(data && Object.keys(data).length > 0 ? { data } : {}),
    };
    this.stored += 1;
    this.memory.push(event);
    if (this.memory.length > MAX_MEMORY) this.memory.splice(0, this.memory.length - MAX_MEMORY);
    this.pending.push(JSON.stringify(event));
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, FLUSH_MS);
    this.timer.unref();
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // un abonné défaillant n'arrête ni le run ni les autres abonnés
      }
    }
    return event;
  }

  /** Écrit ce qui attend (dans l'ordre) ; résolue quand c'est sur le disque. */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const lines = this.pending;
    this.pending = [];
    if (lines.length > 0) {
      this.writing = this.writing
        .then(() => appendFile(this.file, `${lines.join('\n')}\n`, 'utf8'))
        .catch(() => undefined);
    }
    return this.writing;
  }

  /** Les événements en mémoire après `after` (les plus anciens sont relus sur le disque). */
  eventsAfter(after: number): RunLogEvent[] {
    return this.memory.filter((event) => event.seq > after);
  }

  /** Le plus petit `seq` encore en mémoire (0 : aucun). */
  get firstInMemory(): number {
    return this.memory[0]?.seq ?? 0;
  }

  subscribe(listener: (event: RunLogEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** La fin du run : plus rien n'est reçu, tout est écrit, la mémoire est rendue. */
  async close(): Promise<void> {
    this.finished = true;
    await this.flush();
    this.memory = [];
    this.listeners.clear();
  }
}

/** Les événements conservés d'un run (events.jsonl), après `after` ; un fichier absent : `undefined`. */
export async function readStoredEvents(
  file: string,
  options: { after?: number; limit?: number } = {},
): Promise<RunLogEvent[] | undefined> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
  const after = options.after ?? 0;
  const events: RunLogEvent[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const event = JSON.parse(line) as RunLogEvent;
      if (typeof event.seq === 'number' && event.seq > after) events.push(event);
    } catch {
      // une ligne interrompue (arrêt du serveur pendant l'écriture) est ignorée
    }
  }
  return options.limit !== undefined && events.length > options.limit
    ? events.slice(events.length - options.limit)
    : events;
}

const pad = (text: string, width: number): string => text.padEnd(width, ' ');

/** Une ligne de texte d'un événement (export texte, copie). */
export function eventLine(event: RunLogEvent): string {
  const where = [
    event.scenario ? event.scenario : '',
    event.step !== undefined ? `step ${String(event.step)}` : '',
    event.line !== undefined ? `line ${String(event.line)}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return [
    event.at,
    pad(event.level, 5),
    pad(event.category, 9),
    pad(event.type, 28),
    pad(event.status ?? '', 9),
    `${where ? `[${where}] ` : ''}${event.message}${event.durationMs !== undefined ? ` (${String(event.durationMs)} ms)` : ''}`,
  ].join(' ');
}
