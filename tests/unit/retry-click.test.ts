import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import type { SemanticRecordedAction } from '../../src/recording/model.js';
import { normalizeRecording } from '../../src/recording/normalizer.js';

/**
 * RETRY CLICK : l'humain clique la cellule « Process request » d'une ligne (rien ne se passe : le
 * gestionnaire est sur le lien qu'elle contient), puis reclique aussitôt — la navigation part. Deux
 * événements, UNE intention : l'étape gardée est celle qui a l'effet ; le premier clic est expliqué
 * (MERGED, RETRY_CLICK_MERGED), jamais perdu. Un clic qui a lui-même un effet n'est jamais retiré.
 */
const config = parseConfig(
  `mission: { name: retry }\ntarget: { baseUrl: "http://app.test", startAt: / }\n`,
  {},
  {},
).config;

const click = (
  id: string,
  at: number,
  label: string,
  effect: { route?: string; dom?: string[] } = {},
  fingerprint: Record<string, string> = { row: 'Request 42', section: 'Tasks' },
  tag = 'td',
): SemanticRecordedAction =>
  ({
    id,
    type: 'CLICK',
    at,
    rawEventIds: [`r${id}`],
    evidence: [],
    network: [],
    provenance: 'HUMAN_RECORDED',
    target: {
      target: { strategy: 'text', value: label },
      quality: 'ACCESSIBLE',
      fingerprint: { tag, name: label, ...fingerprint },
      label,
      named: true,
      alternatives: [],
      ambiguous: false,
      reasons: [],
    },
    ...(effect.dom ? { domEffects: effect.dom } : {}),
    ...(effect.route ? { navigation: { route: effect.route } } : {}),
  }) as unknown as SemanticRecordedAction;

const run = (actions: SemanticRecordedAction[], fidelity: 'SAFE' | 'EXACT' = 'SAFE') =>
  normalizeRecording(actions, [], [], 0, config.recording.credentials, true, {
    mergeRetryClicks: fidelity !== 'EXACT',
  });

describe('RETRY_CLICK_MERGED', () => {
  it('a click without effect, then the same target clicked again with the navigation: ONE step (the one with the effect), the first is explained', () => {
    const result = run([
      click('h013', 1000, 'Process request'),
      click(
        'h014',
        1700,
        'Process request',
        { route: '/process', dom: ['+ button:Filter'] },
        { row: 'Request 42' },
        'a',
      ),
    ]);
    expect(result.kept.map((action) => action.id)).toEqual(['h014']);
    const first = result.actions.find((action) => action.id === 'h013');
    expect(first?.dropped).toMatch(/^retry click: .*RETRY_CLICK_MERGED/);
    expect(result.kept[0]?.evidence.join(' ')).toMatch(
      /RETRY_CLICK_MERGED: the previous click on the same target \(rh013\) had no effect/,
    );
  });

  it('every click that HAS an effect is kept (a "Next page" clicked twice, a "+" counter)', () => {
    const result = run([
      click('a1', 1000, 'Next page', { dom: ['page 2'] }),
      click('a2', 1500, 'Next page', { dom: ['page 3'] }),
    ]);
    expect(result.kept.map((action) => action.id)).toEqual(['a1', 'a2']);
  });

  it('never across rows, never after a long pause, never when the second click has no effect either', () => {
    // Deux lignes différentes : deux cibles.
    expect(
      run([
        click('b1', 1000, 'Edit', {}, { row: 'Request 41' }),
        click('b2', 1500, 'Edit', { route: '/edit' }, { row: 'Request 42' }),
      ]).kept.map((action) => action.id),
    ).toEqual(['b1', 'b2']);
    // Une longue pause : un autre geste.
    expect(
      run([click('c1', 1000, 'Process request'), click('c2', 9000, 'Process request', { route: '/process' })])
        .kept,
    ).toHaveLength(2);
    // Aucun des deux n'a d'effet : rien ne permet de dire lequel compte, les deux restent.
    expect(run([click('d1', 1000, 'Refresh'), click('d2', 1400, 'Refresh')]).kept).toHaveLength(2);
  });

  it('EXACT fidelity keeps every click', () => {
    expect(
      run(
        [click('e1', 1000, 'Process request'), click('e2', 1500, 'Process request', { route: '/process' })],
        'EXACT',
      ).kept,
    ).toHaveLength(2);
  });
});
