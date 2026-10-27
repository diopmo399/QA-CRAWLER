import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { EXIT, interruptOnSigint } from '../../src/cli/cli.js';

/** Ctrl+C dans la CLI : le premier demande l'arrêt contrôlé, le second quitte avec 130. */
describe('CLI interruption', () => {
  it('aborts on the first SIGINT, exits with 130 on the second, and stops listening once disposed', () => {
    const source = new EventEmitter();
    const exits: number[] = [];
    const interruption = interruptOnSigint((code) => exits.push(code), source);
    expect(interruption.signal.aborted).toBe(false);
    source.emit('SIGINT');
    expect(interruption.signal.aborted).toBe(true);
    expect(exits).toEqual([]);
    source.emit('SIGINT');
    expect(exits).toEqual([EXIT.CANCELLED]);
    expect(EXIT.CANCELLED).toBe(130);
    interruption.dispose();
    expect(source.listenerCount('SIGINT')).toBe(0);
  });
});
