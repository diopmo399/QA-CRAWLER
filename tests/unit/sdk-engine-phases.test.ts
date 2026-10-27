import { describe, expect, it } from 'vitest';
import { EXPLORER_CLOSING_PHASES } from '../../src/explorer/flow-explorer.js';
import { RUN_PHASES } from '../../src/orchestrator.js';
import { RECORDING_PHASES } from '../../src/recording/record-orchestrator.js';
import { enginePhase, TRANSLATED_ENGINE_PHASES } from '../../src/sdk/ui/engine-phases.js';
import { monitorStrings } from '../../src/sdk/ui/monitor-i18n.js';
import { renderMonitor, type MonitorState } from '../../src/sdk/ui/monitor-view.js';
import { EMPTY_VIEW } from '../../src/sdk/ui/monitor-model.js';

/** Les phases du moteur, annoncées en anglais, s'affichent dans la langue du composant. */
describe('engine phases in the components', () => {
  it('translates every phase the engine announces', () => {
    const engine = [
      'Finishing the run',
      ...Object.values(RUN_PHASES),
      ...Object.values(EXPLORER_CLOSING_PHASES),
      ...Object.values(RECORDING_PHASES),
      'cancellation requested',
    ];
    expect(engine.filter((phase) => !TRANSLATED_ENGINE_PHASES.includes(phase))).toEqual([]);
    expect(enginePhase('Writing the reports', 'fr')).toBe('Écriture des rapports');
    expect(enginePhase('Writing the reports', 'en')).toBe('Writing the reports');
    expect(enginePhase('An unknown phase', 'fr')).toBe('An unknown phase');
  });

  it('the Run Monitor shows the phase in its language', () => {
    const at = '2026-01-01T00:00:00.000Z';
    const state = (locale: 'fr' | 'en'): MonitorState => ({
      t: monitorStrings(locale),
      phase: 'ready',
      events: [{ seq: 1, at, type: 'phase', phase: 'Writing the reports' }],
      connection: 'live',
      attempt: 0,
      view: { ...EMPTY_VIEW },
    });
    expect(renderMonitor(state('fr'))).toContain('Écriture des rapports');
    expect(renderMonitor(state('en'))).toContain('Writing the reports');
  });
});
