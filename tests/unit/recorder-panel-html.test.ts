import { describe, expect, it } from 'vitest';
import { recorderPanelHtml } from '../../src/recording/recorder-panel-html.js';

/**
 * La fenêtre d'enregistrement : les pictogrammes des gestes (clic, saisie, case…) ont leur propre
 * table de SVG complets, distincte de celle des boutons. Une seule table `SVG` partagée par les
 * deux rendait « undefined » pour une saisie et un fragment invisible pour un clic.
 */
describe('recorder panel HTML: gesture pictograms', () => {
  for (const language of ['fr', 'en'] as const) {
    it(`${language}: the gesture table is declared once, apart from the button icons, and every gesture maps to a full SVG`, () => {
      const html = recorderPanelHtml(language);
      expect(html.match(/var SVG = \{/g)).toHaveLength(1);
      expect(html.match(/var KIND_SVG = \{/g)).toHaveLength(1);
      // Le rendu d'un geste (la ligne du parcours) passe par kindSvg, jamais par SVG[...].
      expect(html.match(/kindSvg\(step\.kind\)/g)).toHaveLength(1);
      expect(html).not.toContain('SVG[KIND_ICON[step.kind]');
      const kinds = /var KIND_ICON = \{([^}]*)\}/.exec(html)?.[1] ?? '';
      const icons = [...kinds.matchAll(/:\s*'([a-z]+)'/g)].map((match) => match[1]);
      const table = /var KIND_SVG = \{([\s\S]*?)\n {2}\};/.exec(html)?.[1] ?? '';
      expect(icons.length).toBeGreaterThan(5);
      for (const icon of new Set(icons)) expect(table, icon).toMatch(new RegExp(`\\n\\s+${icon}: '<svg `));
    });
  }
});

describe('panel commands: proposals, groups and generation', () => {
  it('keeps the decision, group operation and generation fields, each validated, and drops the malformed ones', async () => {
    const { commandOf } = await import('../../src/recording/recorder-panel.js');
    expect(commandOf({ type: 'assertion-decide', id: 'p3', decision: 'ACCEPT' })).toEqual({
      type: 'assertion-decide',
      id: 'p3',
      decision: 'ACCEPT',
    });
    expect(commandOf({ type: 'assertion-decide', id: 'p3', decision: 'DROP TABLE' })).toEqual({
      type: 'assertion-decide',
      id: 'p3',
    });
    expect(
      commandOf({ type: 'group', op: 'create', name: '  Création de la demande ', stepIds: ['s1', 's2'] }),
    ).toEqual({ type: 'group', op: 'create', name: 'Création de la demande', stepIds: ['s1', 's2'] });
    expect(commandOf({ type: 'group', op: 'move-group', groupId: 'g1', direction: 'up' })).toEqual({
      type: 'group',
      op: 'move-group',
      groupId: 'g1',
      direction: 'up',
    });
    // Une liste avec une entrée mal formée est ignorée en bloc ; un identifiant de groupe hors format aussi.
    expect(commandOf({ type: 'group', op: 'detach', stepIds: ['s1', '../x'], groupId: 'nope' })).toEqual({
      type: 'group',
      op: 'detach',
    });
    expect(commandOf({ type: 'generate', formats: ['yaml', 'java'], groupIds: ['g2'], force: true })).toEqual(
      {
        type: 'generate',
        formats: ['yaml', 'java'],
        groupIds: ['g2'],
        force: true,
      },
    );
    expect(commandOf({ type: 'generate', formats: ['yaml', 'rust'] })).toEqual({ type: 'generate' });
  });

  it('keeps the organised-review commands: grouped decisions, group proposals, group checks', async () => {
    const { commandOf } = await import('../../src/recording/recorder-panel.js');
    // « Accepter les 3 » / « Tout refuser » : des identifiants de proposition, une seule décision.
    expect(commandOf({ type: 'assertion-decide', ids: ['p1', 'p4', 'p12'], decision: 'ACCEPT' })).toEqual({
      type: 'assertion-decide',
      ids: ['p1', 'p4', 'p12'],
      decision: 'ACCEPT',
    });
    expect(commandOf({ type: 'assertion-decide', ids: ['p1', 's2'], decision: 'REJECT' })).toEqual({
      type: 'assertion-decide',
      decision: 'REJECT',
    });
    expect(commandOf({ type: 'group', op: 'accept-proposals' })).toEqual({
      type: 'group',
      op: 'accept-proposals',
    });
    expect(commandOf({ type: 'group', op: 'dismiss-proposals' })).toEqual({
      type: 'group',
      op: 'dismiss-proposals',
    });
    expect(commandOf({ type: 'group', op: 'add-check', groupId: 'g2', variable: 'company.name' })).toEqual({
      type: 'group',
      op: 'add-check',
      groupId: 'g2',
      variable: 'company.name',
    });
    expect(commandOf({ type: 'group', op: 'drop-everything', groupId: 'g2' })).toEqual({
      type: 'group',
      groupId: 'g2',
    });
  });
});
