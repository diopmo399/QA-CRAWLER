import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import type { RawRecordedEvent } from '../../src/recording/model.js';
import { ignoredDebugLine, rawEventDebugLine } from '../../src/recording/recorder-trace.js';

describe('Deterministic recorder: defaults and trace', () => {
  it('the AI never audits (nor picks) a recorded target by default, whatever ai.mode is', () => {
    const { config } = parseConfig(
      'mission: { name: x }\ntarget: { baseUrl: "http://localhost" }\nai: { enabled: true, mode: HYBRID }\n',
      {},
      {},
    );
    expect(config.recording.targetValidation.aiAudit).toBe(false);
  });

  it('a raw event line tells the checkbox state before and after, never the typed text', () => {
    const element = {
      tag: 'input',
      role: 'checkbox',
      name: 'Accept terms',
      css: 'input[name="terms"]',
      sameRoleName: 1,
      roleNameIndex: 0,
      checked: false,
    } as unknown as RawRecordedEvent['element'];
    const change = {
      id: 'r6',
      sequence: 6,
      type: 'change',
      at: 0,
      url: '/form',
      ...(element ? { element } : {}),
      value: { empty: false, length: 4, shape: 'text', checked: true },
    } as RawRecordedEvent;
    expect(rawEventDebugLine(change)).toBe(
      '[RECORDER] RAW EVENT r6 type=change element=checkbox "Accept terms" css=input[name="terms"] checkedBefore=false checkedAfter=true',
    );
    // Au clic, la case a déjà basculé : son état « avant » n'est pas affiché (il serait faux).
    expect(rawEventDebugLine({ ...change, type: 'click', value: undefined })).not.toContain('checkedBefore');
    const typed = { ...change, value: { empty: false, length: 4, shape: 'text' } } as RawRecordedEvent;
    expect(rawEventDebugLine(typed)).toContain('value=text(4)');
    expect(ignoredDebugLine('h002 [r3]', 'duplicate_event', 'kept in h003')).toBe(
      '[RECORDER] EVENT IGNORED h002 [r3] reason=duplicate_event (kept in h003)',
    );
  });
});
