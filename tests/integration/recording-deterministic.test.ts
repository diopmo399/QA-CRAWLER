import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfigFile } from '../../src/config/config-loader.js';
import type { FlowStep } from '../../src/config/flow-schema.js';
import type { RawRecordedEvent, RecordedFlowStep, RecordingEvent } from '../../src/recording/model.js';
import { runRecording, type RecordOutcome } from '../../src/recording/record-orchestrator.js';
import { FakeIntelligenceProvider } from '../fixtures/fake-intelligence-provider.js';
import {
  startDeterministicRecordingApp,
  type DeterministicRecordingApp,
} from '../fixtures/deterministic-recording-app.js';

/** Un intent qui ne vient que de l'existant (flow de la mission, ancien enregistrement, IA) : jamais du humain. */
const LEGACY = 'Legacy intent target';

/**
 * ENREGISTREMENT DÉTERMINISTE (niveau 1 événement brut → niveau 2 action humaine validée ; le niveau 3,
 * l'intention, est une couche séparée qui ne touche jamais le niveau 2). L'humain (Playwright) fait :
 * 1 clic parmi 20 actions visibles, une saisie, une case cochée, une case décochée, le 2e `#valueInput`,
 * un panneau re-rendu puis son bouton, un lien qui navigue.
 *
 * L'environnement est piégé : la mission porte un flow avec une étape `intent:`, un ancien
 * enregistrement en contient une, et une seconde session tourne en HYBRID avec une IA qui propose
 * des intentions à chaque appel. Rien de cela ne doit entrer dans le nouvel enregistrement.
 */
async function demonstrate(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Action 7', exact: true }).click();
  await page.waitForTimeout(300);
  await page.getByLabel('First name').click();
  await page.getByLabel('First name').pressSequentially('Alex', { delay: 30 });
  await page.waitForTimeout(300);
  await page.getByLabel('Accept terms').check();
  await page.waitForTimeout(300);
  await page.getByLabel('Receive news').uncheck();
  await page.waitForTimeout(300);
  const second = page.locator('section[aria-label="Secondary"] #valueInput');
  await second.click();
  await second.pressSequentially('42', { delay: 30 });
  await page.waitForTimeout(300);
  // Deux cibles qu'aucune phrase Gherkin ne dit (l'ancien enregistreur en faisait des `intent:`).
  const branch = page.locator('.row input');
  await branch.click();
  await branch.pressSequentially('7', { delay: 30 });
  await page.waitForTimeout(300);
  await page.getByTestId('dark-mode').click();
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'Reload panel' }).click();
  // Le bouton n'existe qu'après le re-rendu : attendu par Playwright (aucune pause fixe).
  await page.getByRole('button', { name: 'Confirm' }).click();
  await page.waitForTimeout(300);
  await page.getByRole('link', { name: 'Continue' }).click();
  await page.waitForURL('**/done');
  await page.waitForTimeout(500);
}

/** Une IA qui « sait » : une intention et une action proposées à CHAQUE appel. */
const intrusiveAi = (): FakeIntelligenceProvider =>
  new FakeIntelligenceProvider((request) => ({
    status: 'PROPOSAL',
    ...(request.availableActions[0] ? { selectedActionId: request.availableActions[0].id } : {}),
    intent: `CLICK ${LEGACY}`,
    supportingEvidenceIds: [],
    uncertainties: [],
    confidence: 0.99,
  }));

const MISSION = (url: string, extra: string): string => `mission: { name: deterministic-recording }
target: { baseUrl: ${url}, startAt: /form }
${extra}
flows:
  - name: Existing flow with an intent
    steps:
      - goto: /form
      - intent: { kind: CLICK, target: "${LEGACY}" }
`;

interface Session {
  outcome: RecordOutcome;
  events: RecordingEvent[];
  files: Record<string, string>;
  steps: RecordedFlowStep[];
  raw: RawRecordedEvent[];
}

describe('Deterministic recorder (tests 1-10)', () => {
  let app: DeterministicRecordingApp;
  let dir: string;
  let off: Session;
  let hybrid: Session;
  let ai: FakeIntelligenceProvider;

  const record = async (
    name: string,
    extra: string,
    provider?: FakeIntelligenceProvider,
  ): Promise<Session> => {
    const missionFile = path.join(dir, `${name}.mission.yaml`);
    await writeFile(missionFile, MISSION(app.url, extra));
    const events: RecordingEvent[] = [];
    const outcome = await runRecording({
      name,
      missionFile,
      overrides: { headless: true, reportsDir: path.join(dir, 'reports') },
      env: {},
      language: 'en',
      onEvent: (event) => events.push(event),
      ...(provider ? { intelligenceProvider: provider } : {}),
      drive: async ({ page }) => demonstrate(page),
    });
    const files: Record<string, string> = {};
    for (const file of await readdir(outcome.directory))
      if (/\.(json|yaml|feature|jsonl)$/.test(file))
        files[file] = await readFile(path.join(outcome.directory, file), 'utf8');
    const recorded = JSON.parse(files['recorded-flow.json'] ?? '{}') as { steps: RecordedFlowStep[] };
    const raw = JSON.parse(files['raw-recording.json'] ?? '{}') as { rawEvents: RawRecordedEvent[] };
    return { outcome, events, files, steps: recorded.steps, raw: raw.rawEvents };
  };

  beforeAll(async () => {
    app = await startDeterministicRecordingApp();
    dir = await mkdtemp(path.join(tmpdir(), 'qa-record-deterministic-'));
    // Un ancien enregistrement (mémoire sur disque) qui contient une étape `intent:`.
    const old = path.join(dir, 'reports', 'recordings', 'old');
    await mkdir(old, { recursive: true });
    await writeFile(
      path.join(old, 'generated.flow.yaml'),
      `name: old\nstartAt: /form\nsteps:\n  - intent: { kind: CLICK, target: "${LEGACY}" }\n`,
    );
    off = await record('det-off', '');
    ai = intrusiveAi();
    hybrid = await record('det-hybrid', 'ai: { enabled: true, mode: HYBRID }', ai);
  }, 300_000);

  afterAll(async () => {
    await app.close();
  });

  const kinds = (session: Session): string[] => session.steps.map((item) => item.step.kind);
  const stepsWhere = (session: Session, predicate: (step: FlowStep) => boolean): FlowStep[] =>
    session.steps.map((item) => item.step).filter(predicate);
  const targetOf = (step: FlowStep): Record<string, unknown> =>
    'target' in step ? (step.target as unknown as Record<string, unknown>) : {};

  it('precondition: the mission really carries a flow with an intent step', async () => {
    const { config } = await loadConfigFile(path.join(dir, 'det-off.mission.yaml'), {}, {});
    expect(config.flows[0]?.steps.some((step) => step.kind === 'intent')).toBe(true);
  });

  it('TEST 1 — a simple click is recorded as a click on the element touched', () => {
    const [first] = off.steps;
    expect(first?.step.kind).toBe('click');
    expect(first ? targetOf(first.step) : {}).toMatchObject({
      strategy: 'role',
      role: 'button',
      name: 'Action 7',
    });
    expect(first?.provenance).toBe('HUMAN_RECORDED');
  });

  /** Les rapports d'avis APRÈS l'enregistrement (couche IA) : ils peuvent citer l'IA, jamais modifier le flow. */
  const ADVISORY = new Set(['flow-audit.json', 'semantic-audit.json', 'recording-intelligence.json']);

  it('TEST 2 — an intent present in a flow (mission, older recording) never appears in a new recording', () => {
    // Sans IA : aucun fichier produit ne contient l'intent de l'existant.
    for (const [file, content] of Object.entries(off.files)) expect(content, file).not.toContain(LEGACY);
    for (const session of [off, hybrid]) {
      expect(kinds(session)).not.toContain('intent');
      // Avec IA : seuls ses rapports d'avis la citent ; l'enregistrement (niveaux 1 et 2) jamais.
      for (const [file, content] of Object.entries(session.files))
        if (!ADVISORY.has(file)) expect(content, file).not.toContain(LEGACY);
      expect(session.files['generated.flow.yaml']).not.toMatch(/\bintent\b/i);
      expect(session.files['generated.feature']).not.toMatch(/\bintent\b/i);
      // Le flow enregistré (niveau 2) ne porte aucune intention : elle est dans la couche séparée.
      expect(Object.keys(JSON.parse(session.files['recorded-flow.json'] ?? '{}') as object)).not.toContain(
        'intent',
      );
      expect(JSON.parse(session.files['semantic-intents.json'] ?? '{}')).toMatchObject({
        layer: 'SEMANTIC_POST_RECORDING',
        modifiesRecording: false,
      });
    }
  });

  it('TEST 2b — targets no Gherkin sentence can say stay concrete steps on the touched element (never an intent)', () => {
    const fills = stepsWhere(off, (step) => step.kind === 'fill');
    expect(fills).toHaveLength(3);
    const branch = fills.find((step) => !['First name', 'Value'].includes(String(targetOf(step).value)));
    expect(branch ? targetOf(branch) : {}).toMatchObject({ strategy: 'css' });
    const [toggle] = stepsWhere(off, (step) => step.kind === 'click' && targetOf(step).strategy === 'testId');
    expect(toggle ? targetOf(toggle) : {}).toMatchObject({ value: 'dark-mode' });
    // Le .feature garde ces étapes en commentaire : aucune phrase d'intention inventée.
    expect(off.files['generated.feature']).not.toContain('"Dark mode"');
    expect(off.files['generated.feature']).not.toContain('"Branch code"');
    expect(off.files['generated.feature']).toContain('without a selector: Dark mode');
  });

  it('TEST 3 — check: the checkbox state before (unchecked) and after (checked) is real', () => {
    const [check] = stepsWhere(off, (step) => step.kind === 'check');
    expect(check ? targetOf(check) : {}).toMatchObject({ strategy: 'label', value: 'Accept terms' });
    expect(check && 'fingerprint' in check ? check.fingerprint?.expectedState : undefined).toBe('checked');
    const change = off.raw.find((event) => event.type === 'change' && event.element?.name === 'Accept terms');
    expect(change?.element?.checked).toBe(false);
    expect(change?.value?.checked).toBe(true);
  });

  it('TEST 4 — uncheck: a checked box unchecked by the human is an uncheck (never a check)', () => {
    const [uncheck] = stepsWhere(off, (step) => step.kind === 'uncheck');
    expect(uncheck ? targetOf(uncheck) : {}).toMatchObject({ strategy: 'label', value: 'Receive news' });
    expect(uncheck && 'fingerprint' in uncheck ? uncheck.fingerprint?.expectedState : undefined).toBe(
      'unchecked',
    );
    expect(stepsWhere(off, (step) => step.kind === 'check')).toHaveLength(1);
  });

  it('TEST 5 — duplicate #valueInput: the second one, disambiguated (section + match index), never the first', () => {
    const fills = stepsWhere(off, (step) => step.kind === 'fill' && targetOf(step).value === 'Value');
    expect(fills).toHaveLength(1);
    expect(targetOf(fills[0] as FlowStep)).toMatchObject({ section: 'Secondary' });
    const change = off.raw.find((event) => event.type === 'change' && event.element?.css === '#valueInput');
    expect(change?.element).toMatchObject({ sameRoleName: 2, roleNameIndex: 1 });
    const debug = off.events.find(
      (event) => event.type === 'RECORDER_DEBUG' && event.message.includes(`RAW EVENT ${change?.id ?? '?'} `),
    );
    expect(debug?.message).toContain('matches=2 index=1');
  });

  it('TEST 6 — a framework re-render (new DOM nodes) adds no step; the click after it is recorded', () => {
    const labels = off.steps.map((item) => item.label);
    const reload = labels.indexOf('Reload panel');
    expect(reload).toBeGreaterThanOrEqual(0);
    expect(labels[reload + 1]).toBe('Confirm');
    expect(stepsWhere(off, (step) => step.kind === 'click').map((step) => targetOf(step).name)).toEqual([
      'Action 7',
      undefined,
      'Reload panel',
      'Confirm',
      'Continue',
    ]);
  });

  it('TEST 7 — typing a name character by character gives ONE fill with the final value', () => {
    const fills = stepsWhere(off, (step) => step.kind === 'fill' && targetOf(step).value === 'First name');
    expect(fills).toHaveLength(1);
    // Le texte tapé n'est jamais écrit tel quel dans la trace brute.
    expect(off.files['raw-recording.json']).not.toContain('Alex');
  });

  it('TEST 8 — a navigation is the outcome of the click: no goto, no invented intent', () => {
    expect(kinds(off)).not.toContain('goto');
    const [next] = stepsWhere(off, (step) => step.kind === 'click' && targetOf(step).name === 'Continue');
    expect(next && 'effects' in next ? next.effects?.route : undefined).toBe('/done');
    expect(off.steps.at(-1)?.step).toMatchObject({ kind: 'expect', expect: { url: '/done' } });
  });

  it('TEST 9 — 20 actions discovered on the screen, 1 executed: only that one is recorded', () => {
    // La découverte voit les autres actions (graphe d'écran) …
    expect(off.files['flow-graph.json']).toContain('Action 12');
    // … mais seule l'action exécutée par l'humain est une étape.
    const actions = stepsWhere(off, (step) => {
      const name = targetOf(step).name;
      return typeof name === 'string' && /^Action \d+$/.test(name);
    });
    expect(actions).toHaveLength(1);
    expect(
      off.steps.filter((item) => item.provenance !== 'HUMAN_RECORDED' && item.step.kind !== 'expect'),
    ).toEqual([]);
  });

  it('TEST 10 — an AI proposing intents (HYBRID) leaves the recording identical to the deterministic one', () => {
    expect(ai.requests.length).toBeGreaterThan(0);
    const shape = (session: Session): unknown[] =>
      session.steps.map((item) => ({
        kind: item.step.kind,
        target: 'target' in item.step ? item.step.target : undefined,
        value: 'value' in item.step ? item.step.value : undefined,
        provenance: item.provenance,
      }));
    expect(shape(hybrid)).toEqual(shape(off));
    const rawShape = (session: Session): unknown[] =>
      session.raw.map((event) => [event.type, event.element?.css, event.element?.name, event.noise]);
    expect(rawShape(hybrid)).toEqual(rawShape(off));
    // L'IA ne choisit jamais une cible pendant l'enregistrement (audit IA OFF par défaut).
    expect(hybrid.files['generated.flow.yaml']).not.toContain('AFTER_AI_AUDIT');
    expect(hybrid.events.some((event) => event.message.includes('[TARGET_AI_AUDIT]'))).toBe(false);
  });

  it('DEBUG — every raw event is traced, every interaction is RECORDED or IGNORED with a reason', () => {
    const lines = off.events.filter((event) => event.type === 'RECORDER_DEBUG').map((event) => event.message);
    for (const event of off.raw)
      expect(lines.some((line) => line.startsWith(`[RECORDER] RAW EVENT ${event.id} `))).toBe(true);
    expect(lines.filter((line) => line.startsWith('[RECORDER] RECORDED '))).toHaveLength(10);
    for (const line of lines.filter((entry) => entry.includes('EVENT IGNORED')))
      expect(line).toMatch(
        /reason=(element_not_interacted|duplicate_event|ambiguous_target|blocked_by_policy)/,
      );
    expect(lines.some((line) => line.includes('checkedBefore=false checkedAfter=true'))).toBe(true);
    expect(lines.some((line) => line.startsWith('[RECORDER] VALIDATION '))).toBe(true);
    expect(lines.some((line) => line.startsWith('[RECORDER] STABILIZATION '))).toBe(true);
    // Jamais une valeur saisie dans la trace.
    expect(lines.join('\n')).not.toContain('Alex');
  });
});
