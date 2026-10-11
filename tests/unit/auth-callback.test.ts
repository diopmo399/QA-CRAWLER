import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { parseConfig } from '../../src/config/config-loader.js';
import type { RawRecordedEvent, RecordingSession } from '../../src/recording/model.js';
import { processRecording } from '../../src/recording/process-recording.js';
import { isAuthCallback } from '../../src/recording/recorded-flow.js';

/** NON_REPLAYABLE_AUTH_CALLBACK : un retour OAuth / OIDC (code + state) n'est jamais une étape rejouable. */
describe('Recording: an authentication callback (code + state) is never replayed', () => {
  const APP = 'http://app.test';
  const record = (gap: number): { gotos: string[]; warnings: string[] } => {
    const navigation = (sequence: number, url: string): RawRecordedEvent => ({
      id: `r${String(sequence)}`,
      sequence,
      type: 'navigation',
      at: 1000 + sequence * gap,
      url,
    });
    const session: RecordingSession = {
      id: 'rec-auth',
      name: 'Sign in then work',
      startedAt: '2026-01-01T00:00:00.000Z',
      startUrl: `${APP}/`,
      status: 'PROCESSING',
      rawEvents: [
        navigation(0, `${APP}/`),
        navigation(1, `${APP}/callback?code=one-time-code&state=s1`),
        navigation(2, `${APP}/reports`),
      ],
      semanticActions: [],
      checkpoints: [],
      states: [],
      warnings: [],
      droppedEvents: 0,
    };
    const config = parseConfig(
      `mission: { name: auth }\ntarget: { baseUrl: "${APP}", startAt: / }\n`,
      {},
      {},
    ).config;
    const result = processRecording(session, config, { language: 'en', typedValues: new Map() });
    const flow = parseYaml(result.files.yaml) as { steps?: { goto?: string }[] };
    return {
      gotos: (flow.steps ?? []).flatMap((step) => (step.goto ? [step.goto] : [])),
      warnings: result.warnings.map((warning) => warning.code),
    };
  };

  it('recognizes code + state in the query or in a SPA hash, never one of them alone', () => {
    expect(isAuthCallback('/callback?code=abc&state=xyz')).toBe(true);
    expect(isAuthCallback('/#/auth?state=xyz&code=abc')).toBe(true);
    expect(isAuthCallback('/callback?code=abc')).toBe(false);
    expect(isAuthCallback('/search?state=open')).toBe(false);
    expect(isAuthCallback('/companies/12')).toBe(false);
  });

  it('the callback navigation stays out of the flow, with a warning; other navigations are kept', () => {
    const { gotos, warnings } = record(20_000);
    expect(gotos.some((url) => url.includes('code='))).toBe(false);
    expect(gotos).toContain('/reports');
    expect(warnings).toContain('NON_REPLAYABLE_AUTH_CALLBACK');
  });

  it('a callback that redirects at once (a redirect chain) never leaves its code in the flow either', () => {
    expect(record(300).gotos.some((url) => url.includes('code='))).toBe(false);
  });
});
