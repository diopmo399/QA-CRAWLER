import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RawRecordedEvent, RecordedFlowStep } from '../../src/recording/model.js';
import { runRecording } from '../../src/recording/record-orchestrator.js';
import type { SourcesReport } from '../../src/recording/sources/recording-sources.js';
import { FakeIntelligenceProvider } from '../fixtures/fake-intelligence-provider.js';
import { startSourcesRecordingApp, type SourcesRecordingApp } from '../fixtures/sources-recording-app.js';

/**
 * LES SOURCES D'ENREGISTREMENT (CURRENT, PLAYWRIGHT, HYBRID) de bout en bout. L'environnement est
 * piégé : la mission porte un flow « Créer un dossier » avec l'intention « Continuer », un ancien
 * enregistrement en contient une, « Continuer » est visible à l'écran (une suggestion possible),
 * et une IA propose « Continuer » à chaque appel. Rien de cela ne doit entrer dans un enregistrement.
 */
type Mode = 'current' | 'playwright' | 'hybrid';

interface Session {
  steps: RecordedFlowStep[];
  raw: RawRecordedEvent[];
  files: Record<string, string>;
  sources?: SourcesReport;
}

/** Tout ce que la page sait faire, une fois chacun (tests 1 à 12). */
async function everything(page: Page): Promise<void> {
  const pause = (): Promise<void> => page.waitForTimeout(250);
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  await pause();
  await page.getByText('Ouvrir la tuile').click();
  await pause();
  await page.locator('span.label').click();
  await pause();
  await page.getByLabel('Nom').click();
  await page.getByLabel('Nom').pressSequentially('Alex', { delay: 20 });
  await page.waitForTimeout(400);
  await page.getByLabel('Accepté').check();
  await pause();
  await page.getByLabel('Option B').check();
  await pause();
  await page.getByLabel('Pays').selectOption('fr');
  await pause();
  await page.getByRole('button', { name: 'Recharger' }).click();
  await page.getByRole('button', { name: 'Confirmer' }).click();
  await pause();
  await page.locator('button.del').nth(1).click();
  await pause();
  await page.frameLocator('iframe').getByRole('button', { name: 'Dans le cadre' }).click();
  await pause();
  await page.getByRole('link', { name: 'Accueil' }).click();
  await page.waitForURL('**/accueil');
  await page.waitForTimeout(600);
}

/** Le critère de succès : 1. « Accueil », 2. « Nom », 3. « Accepté » — rien d'autre. */
async function successScenario(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Accueil' }).click();
  await page.waitForURL('**/accueil');
  await page.waitForTimeout(400);
  await page.getByLabel('Nom').click();
  await page.getByLabel('Nom').pressSequentially('Martin', { delay: 20 });
  await page.waitForTimeout(400);
  await page.getByLabel('Accepté').check();
  await page.waitForTimeout(600);
}

/** Une IA qui « sait » : elle propose « Continuer » (et une intention) à chaque appel. */
const intrusiveAi = (): FakeIntelligenceProvider =>
  new FakeIntelligenceProvider((request) => {
    const action =
      request.availableActions.find((candidate) => /Continuer/.test(candidate.name)) ??
      request.availableActions[0];
    return {
      status: 'PROPOSAL',
      ...(action ? { selectedActionId: action.id } : {}),
      intent: 'CLICK Continuer',
      supportingEvidenceIds: [],
      uncertainties: [],
      confidence: 0.99,
    };
  });

describe('Recording sources — CURRENT / PLAYWRIGHT / HYBRID', () => {
  let app: SourcesRecordingApp;
  let dir: string;
  const full: Partial<Record<Mode, Session>> = {};
  const success: Partial<Record<Mode | 'hybrid-ai', Session>> = {};

  const record = async (
    name: string,
    mode: Mode,
    drive: (page: Page) => Promise<void>,
    extra = '',
    provider?: FakeIntelligenceProvider,
  ): Promise<Session> => {
    const missionFile = path.join(dir, `${name}.mission.yaml`);
    await writeFile(
      missionFile,
      `mission: { name: ${name} }
target: { baseUrl: ${app.url}, startAt: /form }
recording: { mode: ${mode}, playwrightRecording: ${mode === 'current' ? 'false' : 'true'} }
${extra}
flows:
  - name: Créer un dossier
    steps:
      - goto: /form
      - intent: { kind: CLICK, target: "Continuer" }
`,
    );
    const outcome = await runRecording({
      name,
      missionFile,
      overrides: { headless: true, reportsDir: path.join(dir, 'reports') },
      env: {},
      language: 'fr',
      ...(provider ? { intelligenceProvider: provider } : {}),
      drive: async ({ page }) => drive(page),
    });
    const files: Record<string, string> = {};
    for (const file of await readdir(outcome.directory))
      if (/\.(json|yaml|feature)$/.test(file))
        files[file] = await readFile(path.join(outcome.directory, file), 'utf8');
    const recorded = JSON.parse(files['recorded-flow.json'] ?? '{}') as { steps: RecordedFlowStep[] };
    const raw = JSON.parse(files['raw-recording.json'] ?? '{}') as { rawEvents: RawRecordedEvent[] };
    return {
      steps: recorded.steps,
      raw: raw.rawEvents,
      files,
      ...(files['recording-sources.json']
        ? { sources: JSON.parse(files['recording-sources.json']) as SourcesReport }
        : {}),
    };
  };

  beforeAll(async () => {
    app = await startSourcesRecordingApp();
    dir = await mkdtemp(path.join(tmpdir(), 'qa-record-sources-'));
    const old = path.join(dir, 'reports', 'recordings', 'old');
    await mkdir(old, { recursive: true });
    await writeFile(
      path.join(old, 'generated.flow.yaml'),
      'name: Créer un dossier\nstartAt: /form\nsteps:\n  - intent: { kind: CLICK, target: "Continuer" }\n',
    );
    for (const mode of ['current', 'playwright', 'hybrid'] as const) {
      full[mode] = await record(`full-${mode}`, mode, everything);
      success[mode] = await record(`success-${mode}`, mode, successScenario);
    }
    success['hybrid-ai'] = await record(
      'success-hybrid-ai',
      'hybrid',
      successScenario,
      'ai: { enabled: true, mode: HYBRID }',
      intrusiveAi(),
    );
  }, 300_000);

  afterAll(async () => {
    await app.close();
  });

  const actions = (session: Session | undefined): string[] =>
    (session?.steps ?? [])
      .filter((item) => item.step.kind !== 'expect')
      .map((item) => {
        const step = item.step as { kind: string; target?: { name?: string; value?: string } };
        const target = step.target ?? {};
        return `${step.kind} ${target.name ?? target.value ?? ''}`.trim();
      });
  const stepOn = (session: Session | undefined, text: string): RecordedFlowStep | undefined =>
    session?.steps.find((item) => JSON.stringify(item.step).includes(text));
  const rawClickOn = (session: Session | undefined, name: string): RawRecordedEvent | undefined =>
    session?.raw.find((event) => event.type === 'click' && event.element?.name === name);

  it('SUCCESS — whatever the mode, the recording holds only the three gestures, nothing from the existing flow', () => {
    for (const key of ['current', 'playwright', 'hybrid', 'hybrid-ai'] as const) {
      expect(actions(success[key]), key).toEqual(['click Accueil', 'fill Nom', 'check Accepté']);
      expect(success[key]?.files['recorded-flow.json'], key).not.toMatch(
        /Continuer|Créer un dossier|"intent"/,
      );
    }
  });

  it('TESTS 1–3 — button, clickable tile, span inside a button (the button is the target, the span is traced)', () => {
    for (const mode of ['current', 'playwright', 'hybrid'] as const) {
      expect(stepOn(full[mode], 'Enregistrer')?.step.kind, mode).toBe('click');
      expect(stepOn(full[mode], 'Ouvrir la tuile')?.step.kind, mode).toBe('click');
      expect((stepOn(full[mode], 'Suivant')?.step as { target?: unknown }).target, mode).toEqual({
        strategy: 'role',
        role: 'button',
        name: 'Suivant',
      });
      const suivant = rawClickOn(full[mode], 'Suivant');
      expect(suivant?.element?.rawTag, mode).toBe('span');
      expect(suivant?.element?.tag, mode).toBe('button');
    }
    // PLAYWRIGHT / HYBRID : le localisateur de Playwright, lu sur l'élément touché, compté, unique.
    const evidence = rawClickOn(full.playwright, 'Suivant')?.element?.playwright;
    expect(evidence).toMatchObject({
      status: 'RESOLVED',
      locator: "getByRole('button', { name: 'Suivant' })",
      strategy: 'role',
      matchCount: 1,
      sameElement: true,
      mode: 'PLAYWRIGHT',
    });
    // CURRENT : aucun appel à Playwright.
    expect(rawClickOn(full.current, 'Suivant')?.element?.playwright).toBeUndefined();
    expect(full.current?.files['recording-sources.json']).toBeUndefined();
  });

  it('TESTS 4–7 — input, checkbox, radio and select are recorded once each, in every mode', () => {
    for (const mode of ['current', 'playwright', 'hybrid'] as const) {
      const list = actions(full[mode]);
      expect(
        list.filter((entry) => entry.startsWith('fill')),
        mode,
      ).toEqual(['fill Nom']);
      expect(
        list.filter((entry) => entry.startsWith('check')),
        mode,
      ).toEqual(['check Accepté', 'check Option B']);
      expect(
        list.filter((entry) => entry.startsWith('select')),
        mode,
      ).toEqual(['select Pays']);
    }
  });

  it('TEST 8 / 13 — the navigation seen by both sources is ONE action (the two references kept)', () => {
    for (const mode of ['playwright', 'hybrid'] as const) {
      const report = full[mode]?.sources;
      expect(report?.duplicates, mode).toBeGreaterThanOrEqual(1);
      const navigation = full[mode]?.raw.find(
        (event) => event.type === 'navigation' && event.sources?.length === 2,
      );
      expect(navigation?.correlatedWith, mode).toMatch(/^p\d+$/);
      expect(
        actions(full[mode]).filter((entry) => entry === 'click Accueil'),
        mode,
      ).toHaveLength(1);
    }
  });

  it('TEST 9 — a re-rendered element: Playwright reads the page after the click, its stale locator is refused', () => {
    for (const mode of ['current', 'playwright', 'hybrid'] as const)
      expect(
        actions(full[mode]).filter((entry) => /Confirm/.test(entry)),
        mode,
      ).toHaveLength(0);
    const confirm = full.playwright?.raw.find(
      (event) => event.type === 'click' && event.element?.playwright?.locator?.includes('Confirmé'),
    );
    expect(confirm?.element?.playwright?.target).toBeUndefined();
    expect(confirm?.element?.playwright?.reason).toMatch(/before the gesture/);
  });

  it('TESTS 10–11 — two identical buttons: never the first by default, Playwright position never a stable target', () => {
    for (const mode of ['current', 'playwright', 'hybrid'] as const)
      expect((stepOn(full[mode], 'Supprimer')?.step as { target?: unknown }).target, mode).toMatchObject({
        name: 'Supprimer',
        nth: 1,
      });
    const del = rawClickOn(full.playwright, 'Supprimer')?.element?.playwright;
    expect(del?.target).toBeUndefined();
  });

  it('TEST 12 — an iframe is not recorded (unchanged): nothing is invented for it', () => {
    for (const mode of ['current', 'playwright', 'hybrid'] as const)
      expect(full[mode]?.files['recorded-flow.json'], mode).not.toMatch(/Dans le cadre/);
  });

  it('TEST 14 — every recorded action comes from a raw browser event', () => {
    for (const mode of ['current', 'playwright', 'hybrid'] as const) {
      const ids = new Set(full[mode]?.raw.map((event) => event.id));
      for (const item of full[mode]?.steps ?? []) {
        if (item.step.kind === 'expect') continue;
        expect(item.rawEventIds.length, `${mode} ${item.step.kind}`).toBeGreaterThan(0);
        for (const id of item.rawEventIds) expect(ids.has(id), `${mode} ${id}`).toBe(true);
      }
    }
  });

  it('TESTS 15–18 — the existing flow intent and the visible suggestion « Continuer » never appear', () => {
    for (const mode of ['current', 'playwright', 'hybrid'] as const) {
      expect(full[mode]?.files['recorded-flow.json'], mode).not.toMatch(
        /Continuer|Créer un dossier|"intent"/,
      );
      expect(full[mode]?.files['generated.flow.yaml'], mode).not.toMatch(/intent:|Continuer/);
    }
  });

  it('TESTS 19–20 — with an AI that proposes « Continuer » everywhere, the recording is identical to the one without AI', () => {
    expect(actions(success['hybrid-ai'])).toEqual(actions(success.hybrid));
    expect(success['hybrid-ai']?.sources?.rejected).toBe(0);
  });
});
