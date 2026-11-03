import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  accessKeywords,
  interpretations,
  maskAccessText,
  parseAccessPath,
  sanitizeAccess,
} from '../../src/incident/access.js';
import { IncidentService, type IncidentHost } from '../../src/incident/service.js';
import { interpretBrief } from '../../src/incident/trigger/brief.js';
import { MAX_ACCESS_STEPS, type Incident } from '../../src/sdk/core/incident-contracts.js';

/**
 * LE SCÉNARIO D'ACCÈS : le parcours écrit en langage naturel devient des étapes (action, cible, élément,
 * étape critique) ; les secrets saisis sont masqués ; l'écran cible, les indications et le mode sont gardés
 * (un mode inconnu est refusé) ; un enregistrement existant s'associe et ses étapes s'ajoutent au parcours
 * (la démonstration passe par un enregistrement, jamais par une vidéo) ; l'analyse localise des portions de code candidates (jamais confirmées) dans le fixture Angular, avec
 * les ressources transversales et les pistes d'un blocage global.
 */
const FIXTURE = path.resolve('tests/fixtures/angular-app');
const NARRATIVE =
  'Je me connecte, j’ouvre le menu Dossiers, je crée un nouveau dossier, je remplis les champs et je clique sur Enregistrer. Après cette action, l’application se bloque et les boutons ne répondent plus.';

describe('scénario d’accès : le parcours en langage naturel', () => {
  it('découpe le texte en étapes, met le symptôme à part et marque l’étape critique', () => {
    const parsed = parseAccessPath({ narrative: NARRATIVE });
    expect(parsed.path.map((step) => step.action)).toEqual(['LOGIN', 'OPEN', 'CREATE', 'FILL', 'SAVE']);
    expect(parsed.path[1]).toMatchObject({ target: 'Dossiers', element: 'MENU', source: 'TEXT' });
    expect(parsed.path[3]).toMatchObject({ element: 'FIELD' });
    expect(parsed.path[4]).toMatchObject({ target: 'Enregistrer', element: 'BUTTON', critical: true });
    expect(parsed.path.filter((step) => step.critical)).toHaveLength(1);
    expect(parsed.symptoms[0]).toMatch(/se bloque/);
  });

  it('garde plusieurs interprétations avec leur confiance (zone, entité, déclencheur)', () => {
    const parsed = parseAccessPath({ narrative: NARRATIVE });
    const brief = interpretBrief(NARRATIVE);
    const found = interpretations(parsed, brief, 'Catalogue');
    const area = found.find((item) => item.kind === 'AREA' && item.value === 'Dossiers');
    expect(area?.confidence).toBe(0.8);
    expect(found.find((item) => item.kind === 'ENTITY')?.value).toBe('dossier');
    expect(found.find((item) => item.kind === 'TRIGGER')?.value).toBe('Enregistrer');
    expect(found.find((item) => item.kind === 'AREA' && item.value === 'Catalogue')?.confidence).toBeLessThan(
      0.5,
    );
    // Les mots de la découverte : ceux du parcours d'abord, au singulier, sans mots génériques.
    const keywords = accessKeywords(parsed, found, brief.keywords);
    expect(keywords[0]).toBe('dossier');
    expect(keywords).not.toContain('application');
    expect(keywords).not.toContain('boutons');
  });

  it('les étapes numérotées et un enregistrement s’ajoutent ; un texte anglais est compris', () => {
    const parsed = parseAccessPath({
      steps: [{ text: 'Open the "Books" tab' }, { text: 'Click on Save' }],
      recording: [{ description: 'Cliquer sur "Nouveau dossier"' }],
    });
    expect(parsed.path.map((step) => [step.source, step.action, step.target])).toEqual([
      ['STEPS', 'OPEN', 'Books'],
      ['STEPS', 'SAVE', 'Save'],
      ['RECORDING', 'CREATE', 'Nouveau dossier'],
    ]);
  });

  it('masque les secrets et refuse une saisie invalide', () => {
    expect(maskAccessText('compte demo, mot de passe : Secret123!')).toBe(
      'compte demo, mot de passe : [masqué]',
    );
    expect(maskAccessText('password=hunter2 token: abc.def')).not.toMatch(/hunter2|abc\.def/);
    const at = '2026-11-02T10:00:00.000Z';
    expect(() => sanitizeAccess({ url: 'javascript:alert(1)' }, undefined, 'alice', at)).toThrow(/url/);
    expect(() =>
      sanitizeAccess(
        { steps: Array.from({ length: MAX_ACCESS_STEPS + 1 }, () => ({ text: 'x x x' })) },
        undefined,
        'alice',
        at,
      ),
    ).toThrow(/at most/);
    const saved = sanitizeAccess(
      {
        url: 'https://user:pw@app.test/dossiers',
        steps: [{ text: 'Ouvrir Dossiers' }, { text: '  ' }],
        mode: 'GUIDED',
        target: '  création d’un nouveau dossier ',
        hints: 'menu Dossiers',
      },
      undefined,
      'alice',
      at,
    );
    expect(saved.url).toBe('https://app.test/dossiers');
    expect(saved.steps).toHaveLength(1);
    expect(saved.steps[0]).toMatchObject({ text: 'Ouvrir Dossiers' });
    expect(saved).toMatchObject({
      mode: 'GUIDED',
      target: 'création d’un nouveau dossier',
      hints: 'menu Dossiers',
    });
    expect(() => sanitizeAccess({ mode: 'VIDEO' as never }, undefined, 'alice', at)).toThrow(/mode must be/);
    expect(saved.steps[0]?.id).toMatch(/^st_[a-f0-9]{12}$/);
  });
});

let projectDir: string;
let service: IncidentService;
let incident: Incident;

const host = (): IncidentHost => ({
  projectId: 'prj_access',
  projectDir,
  replay: () => Promise.reject(new Error('no replay in this test')),
  scenarioYaml: () => Promise.resolve(undefined),
  addScenario: () => Promise.reject(new Error('no library in this test')),
  environment: () => Promise.resolve({ baseUrl: 'http://catalogue.test/' }),
  runDir: (run) => path.join(projectDir, 'reports', run),
  recordingSteps: (name) =>
    Promise.resolve(
      name === 'creation-dossier'
        ? {
            name,
            startAt: 'http://catalogue.test/dossiers',
            steps: [
              { id: 's1', kind: 'click', description: 'Cliquer sur "Nouveau dossier"' },
              { id: 's2', kind: 'fill', description: 'Saisir dans "Code"' },
            ],
          }
        : undefined,
    ),
});

beforeAll(async () => {
  projectDir = await mkdtemp(path.join(tmpdir(), 'incident-access-'));
  service = new IncidentService(host());
  incident = await service.create(
    {
      title: 'Blocage après l’enregistrement d’un dossier',
      description: 'Les boutons ne répondent plus après Enregistrer.',
      observed: 'aucune réaction',
      expected: 'dossier enregistré',
      severity: 'HIGH',
      application: 'Dossiers',
      scope: {
        applications: [
          { id: 'web', name: 'web', layer: 'FRONTEND', repository: { root: FIXTURE, include: [] } },
        ],
      },
    },
    'alice',
  );
});

afterAll(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

describe('scénario d’accès : service', () => {
  it('enregistre le parcours masqué, associe un enregistrement existant et refuse un inconnu', async () => {
    const saved = await service.saveAccess(
      incident.id,
      {
        start: 'page d’accueil après connexion',
        url: '/dossiers',
        narrative: NARRATIVE,
        steps: [{ text: 'Ouvrir le menu Dossiers' }],
        testData: 'compte recette, mot de passe : Secret123',
        recording: 'creation-dossier',
      },
      'alice',
    );
    expect(saved.access).toMatchObject({
      url: '/dossiers',
      recording: { name: 'creation-dossier', linkedBy: 'alice' },
    });
    expect(saved.access?.testData).toBe('compte recette, mot de passe : [masqué]');
    expect(JSON.stringify(saved)).not.toContain('Secret123');
    expect(saved.history.at(-1)?.message).toMatch(/scénario d’accès enregistré/);
    await expect(service.saveAccess(incident.id, { recording: 'inconnu' }, 'alice')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    // Un champ non renvoyé est gardé ; null dissocie l'enregistrement.
    const partial = await service.saveAccess(incident.id, { observed: 'boutons inertes' }, 'alice');
    expect(partial.access).toMatchObject({
      narrative: NARRATIVE,
      observed: 'boutons inertes',
      recording: { name: 'creation-dossier' },
    });
  });

  it('analyse le parcours : étapes, enregistrement, candidats du code, transversaux, pistes, limites', async () => {
    const analyzed = await service.analyzeAccess(incident.id, 'alice');
    const analysis = analyzed.access?.analysis;
    expect(analysis?.sources).toEqual(['TEXT', 'STEPS', 'RECORDING']);
    expect(
      analysis?.path.some((step) => step.source === 'RECORDING' && step.target === 'Nouveau dossier'),
    ).toBe(true);
    expect(analysis?.path.find((step) => step.critical)?.target).toBe('Enregistrer');
    expect(analysis?.keywords[0]).toBe('dossier');
    const matched = analysis?.candidates.filter((item) => item.match === 'MATCHED') ?? [];
    expect(matched.some((item) => item.kind === 'COMPONENT' && item.ref.startsWith('src/app/dossier/'))).toBe(
      true,
    );
    // Aucun candidat n'est confirmé : MATCHED ou UNCERTAIN seulement.
    expect(new Set(analysis?.candidates.map((item) => item.match))).toEqual(
      new Set(['MATCHED', 'UNCERTAIN']),
    );
    const transversal = analysis?.candidates.filter((item) => item.transversal) ?? [];
    expect(transversal.map((item) => item.ref.split(':')[0]).sort()).toEqual(
      expect.arrayContaining([
        'src/app/shared/auth.interceptor.ts',
        'src/app/shared/global-error.handler.ts',
      ]),
    );
    expect(analysis?.anomalies).toContain('GLOBAL_ACTION_FAILURE');
    const errorLead = analysis?.leads.find((lead) => lead.kind === 'ERROR_HANDLER');
    expect(errorLead?.refs.some((ref) => ref.startsWith('src/app/shared/global-error.handler.ts'))).toBe(
      true,
    );
    expect(analysis?.leads.find((lead) => lead.kind === 'CHANGE_DETECTION')?.refs).toEqual([]);
    expect(analysis?.limits.some((limit) => /vidéo/.test(limit))).toBe(false);
    expect(analyzed.history.at(-1)?.message).toMatch(/parcours analysé/);
  });

  it('sans lecture des sources : aucune portion de code, la limite est dite ; sans parcours : refusé', async () => {
    const blind = await service.create(
      {
        title: 'Sans lecture',
        description: 'd',
        observed: 'o',
        expected: 'e',
        severity: 'LOW',
        scope: {
          applications: [
            { id: 'web', name: 'web', layer: 'FRONTEND', repository: { root: FIXTURE, include: [] } },
          ],
          permissions: { readSources: false },
        },
      } as unknown as Parameters<IncidentService['create']>[0],
      'alice',
    );
    await expect(service.analyzeAccess(blind.id, 'alice')).rejects.toMatchObject({ code: 'INVALID' });
    await service.saveAccess(
      blind.id,
      { narrative: 'Ouvrir Dossiers puis cliquer sur Enregistrer' },
      'alice',
    );
    const analysis = (await service.analyzeAccess(blind.id, 'alice')).access?.analysis;
    expect(analysis?.candidates).toEqual([]);
    expect(analysis?.limits.some((limit) => /lecture des sources/.test(limit))).toBe(true);
    expect(analysis?.path.map((step) => step.action)).toEqual(['OPEN', 'SAVE']);
  });
});
