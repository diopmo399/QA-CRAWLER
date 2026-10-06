import type { ProgressSink, ProgressUpdate } from '../progress/progress.js';
import { redactText } from '../security/redactor.js';
import { color, setLoggerInterrupt } from './logger.js';

/**
 * La progression dans le terminal :
 *  - terminal interactif : UNE ligne animée (spinner, barre, phase, détail, temps écoulé), redessinée
 *    tant que le travail dure ; les messages ordinaires l'effacent puis elle revient ;
 *  - sortie redirigée (CI, fichier) : une ligne par phase, sans animation.
 */
export interface ProgressRenderer {
  sink: ProgressSink;
  /** Arrête l'animation (fin anormale) : la ligne est effacée. */
  stop(): void;
}

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const BAR = 18;

export function seconds(ms: number): string {
  return ms < 60_000
    ? `${(ms / 1000).toFixed(1)} s`
    : `${String(Math.floor(ms / 60_000))} min ${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')} s`;
}

/** La ligne d'une mise à jour (sans couleur) : testable, et la même pour les deux affichages. */
export function progressLine(update: ProgressUpdate, frame = '', elapsedMs = update.elapsedMs): string {
  const total = Math.max(1, update.total);
  const step = Math.min(update.step, total);
  const filled = Math.round((Math.max(0, step - 1) / total) * BAR);
  const bar = `[${'█'.repeat(filled)}${'░'.repeat(BAR - filled)}]`;
  const detail = update.detail ? ` — ${update.detail}` : '';
  return `${frame ? `${frame} ` : ''}${update.task} ${bar} ${String(step)}/${String(total)} ${update.label}${detail} · ${seconds(elapsedMs)}`;
}

export function terminalProgress(
  stream: NodeJS.WriteStream = process.stderr,
  interactive: boolean = stream.isTTY && !process.env.CI,
): ProgressRenderer {
  let current: { update: ProgressUpdate; at: number } | undefined;
  let frame = 0;
  let drawn = false;
  let timer: NodeJS.Timeout | undefined;
  let lastPrinted = '';

  const clear = (): void => {
    if (drawn) stream.write('\r\u001b[2K');
    drawn = false;
  };
  const draw = (): void => {
    if (!current) return;
    const elapsed = current.update.elapsedMs + (Date.now() - current.at);
    const text = progressLine(current.update, FRAMES[frame % FRAMES.length], elapsed);
    frame += 1;
    const width = Math.max(20, (stream.columns || 100) - 1);
    stream.write(
      `\r\u001b[2K${color.cyan(redactText(text.length > width ? `${text.slice(0, width - 1)}…` : text))}`,
    );
    drawn = true;
  };
  const stop = (): void => {
    if (timer) clearInterval(timer);
    timer = undefined;
    clear();
    current = undefined;
    setLoggerInterrupt(undefined);
  };
  const finish = (update: ProgressUpdate): void => {
    stop();
    const line =
      update.state === 'DONE'
        ? color.green(`✓ ${update.task} — ${update.label} (${seconds(update.elapsedMs)})`)
        : color.red(`✗ ${update.task} — ${update.label} (${seconds(update.elapsedMs)})`);
    stream.write(`${redactText(line)}\n`);
  };

  const sink: ProgressSink = (update) => {
    if (update.state !== 'RUNNING') {
      finish(update);
      return;
    }
    if (!interactive) {
      // Une ligne par phase (pas de détail répété) : lisible dans un journal de CI.
      const line = `… ${update.task} ${String(update.step)}/${String(update.total)} ${update.label}`;
      if (line !== lastPrinted) stream.write(`${redactText(line)}\n`);
      lastPrinted = line;
      return;
    }
    current = { update, at: Date.now() };
    if (!timer) {
      setLoggerInterrupt(clear);
      timer = setInterval(draw, 100);
      // L'animation ne retient jamais le processus.
      timer.unref();
    }
    draw();
  };
  return { sink, stop };
}
