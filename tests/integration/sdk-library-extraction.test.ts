import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runRecording } from '../../src/recording/record-orchestrator.js';
import {
  createQaCrawler,
  QaCrawlerError,
  type Environment,
  type ExplorationSnapshot,
  type Project,
  type QaCrawlerClient,
} from '../../src/sdk/core/index.js';
import { engineDefaults } from '../../src/sdk/server/project.js';
import { startSdkServer, type RunningSdkServer } from '../../src/sdk/server/server.js';
import { startTestSite, type TestSite } from '../fixtures/test-site.js';

/**
 * EXTRAIRE PLUSIEURS GROUPES MÉTIER D'UN VRAI ENREGISTREMENT, sur le site de test du dépôt : un parcours
 * enregistré (ouvrir une fiche, chercher un terme, relancer la même recherche), trois groupes créés par
 * commandes ; le plan d'un groupe, de plusieurs, de tous, d'une partie ; la dépendance réelle (la
 * relance lit la donnée saisie par la première recherche) ; la validation qui refuse tout ou rien ; la
 * publication en version 1 avec sa provenance ; un bloc composé qui garde ses groupes ; la comparaison
 * avec la source après une vraie modification de l'enregistrement, la mise à jour demandée puis validée ;
 * enfin la composition des blocs publiés et leur REJEU RÉEL par le moteur.
 */
let site: TestSite;
let workspace: string;
let server: RunningSdkServer;
let client: QaCrawlerClient;
let project: Project;
let environment: Environment;
const N = 'parcours-fiche-et-recherche';
let G1: string[] = [];
let G2: string[] = [];
let G3: string[] = [];
let relaunchStartsWithGoto = false;
let total = 0;

const human = async ({ page }: { page: Page }): Promise<void> => {
  await page.waitForTimeout(300);
  await page.getByRole('link', { name: 'Utilisateurs' }).click();
  await page.waitForURL('**/users');
  await page.waitForTimeout(300);
  await page.getByRole('link', { name: 'Utilisateur 2', exact: true }).click();
  await page.waitForURL('**/users/2');
  await page.waitForTimeout(300);
  for (let i = 0; i < 2; i += 1) {
    await page.goto(`${site.url}/forms`);
    await page.waitForTimeout(300);
    await page.getByPlaceholder('Rechercher').fill('lampe de bureau');
    await page.waitForTimeout(200);
    await page.getByRole('button', { name: 'Rechercher' }).click();
    await page.waitForURL('**/search**');
    await page.waitForTimeout(500);
  }
};

async function finished(started: ExplorationSnapshot): Promise<ExplorationSnapshot> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('the replay did not finish in time'));
    }, 150_000);
    const subscription = client.explorations.subscribe(started.id, (event) => {
      if (event.type === 'completed' || event.type === 'failed') {
        clearTimeout(timer);
        subscription.close();
        resolve();
      }
    });
  });
  return client.explorations.status(started.id);
}

const refusal = async (promise: Promise<unknown>): Promise<QaCrawlerError> => {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(QaCrawlerError);
  return error as QaCrawlerError;
};

beforeAll(async () => {
  site = await startTestSite();
  workspace = await mkdtemp(path.join(tmpdir(), 'qa-library-extraction-'));
  server = await startSdkServer({
    workspace,
    language: 'fr',
    record: (request) =>
      runRecording({ ...request, overrides: { ...request.overrides, headless: true }, drive: human }),
  });
  client = createQaCrawler({ endpoint: `${server.url}/api`, token: server.token });
  project = await client.projects.create({
    ...engineDefaults(),
    project: { name: 'Groupes métier', targetUrl: `${site.url}/`, framework: 'other' },
  });
  environment = await client.environments.create(project.id, {
    name: 'Recette',
    kind: 'TEST',
    baseUrl: site.url,
    allowedDomains: [new URL(site.url).hostname],
    mutations: { enabled: true, maxPerRun: 10 },
  });
  await client.recordings.start(project.id, { name: 'Parcours fiche et recherche' });
  await client.recordings.subscribe(project.id, N, () => undefined).done;
  // Les groupes, tirés des étapes réellement enregistrées (le moteur note ou non le second « goto ») :
  // avant la première page de recherche, la première recherche, la relance.
  const steps = (await client.recordings.studio(project.id, N)).steps;
  const firstGoto = steps.findIndex((step) => step.kind === 'goto');
  const firstSearch = steps.findIndex((step, index) => index > firstGoto && step.kind === 'click');
  G1 = steps.slice(0, firstGoto).map((step) => step.id);
  G2 = steps.slice(firstGoto, firstSearch + 1).map((step) => step.id);
  G3 = steps.slice(firstSearch + 1).map((step) => step.id);
  relaunchStartsWithGoto = steps[firstSearch + 1]?.kind === 'goto';
  total = steps.length;
  // Les groupes du Recorder, créés par commandes (aucun second système de regroupement).
  await client.groups.edit(project.id, N, {
    op: 'create',
    name: 'Ouvrir une fiche utilisateur',
    stepIds: G1,
  });
  await client.groups.edit(project.id, N, { op: 'create', name: 'Rechercher un terme', stepIds: G2 });
  await client.groups.edit(project.id, N, { op: 'create', name: 'Relancer la recherche', stepIds: G3 });
}, 120_000);

afterAll(async () => {
  client.dispose();
  await server.close();
  await site.close();
  await rm(workspace, { recursive: true, force: true });
});

describe('library — extracting business groups from a real recording', () => {
  it('lists the groups of the recording with their real dependency (the second search reads q)', async () => {
    expect([G1.length, G2.length]).toEqual([2, 3]);
    // La relance : saisie, clic, et la vérification qui suit ; avec ou sans « goto ».
    expect(G3.length).toBe(relaunchStartsWithGoto ? 4 : 3);
    const groups = await client.groups.list(project.id, N);
    expect(groups.map((group) => [group.id, group.name, group.stepIds])).toEqual([
      ['g1', 'Ouvrir une fiche utilisateur', G1],
      ['g2', 'Rechercher un terme', G2],
      ['g3', 'Relancer la recherche', G3],
    ]);
    const relaunch = groups[2];
    expect(relaunch?.data?.inputs).toEqual([{ key: 'q', producerStepId: G2[1], producerGroupId: 'g2' }]);
    expect(relaunch?.runnableAlone.ok).toBe(false);
  });

  it('plans one group: the data it reads from an unchosen group becomes a required input, never a copied value', async () => {
    const plan = await client.library.planExtraction(project.id, N, {
      selection: [{ groupId: 'g3' }],
      mode: 'separate',
    });
    expect(plan.ok).toBe(true);
    const [block] = plan.blocks;
    expect(block?.dependencies).toEqual([
      { key: 'q', source: 'UNSELECTED_GROUP', group: { id: 'g2', name: 'Rechercher un terme' } },
    ]);
    expect(block?.contract.inputs).toEqual([expect.objectContaining({ key: 'q', required: true })]);
    expect(block?.data.map((entry) => entry.key)).not.toContain('q');
    expect(plan.summary).toMatchObject({ groups: 1, steps: G3.length, external: ['q'] });
    // Sans « goto » enregistré, il commence au milieu de l'enregistrement : c'est dit.
    expect(block?.midway).toBe(!relaunchStartsWithGoto);
  });

  it('plans several and all groups: the producer chosen too, the dependency is between blocks; composite keeps the groups', async () => {
    const several = await client.library.planExtraction(project.id, N, {
      selection: [{ groupId: 'g3' }, { groupId: 'g2' }],
      mode: 'separate',
    });
    // L'ordre est celui de l'enregistrement, pas celui des cases.
    expect(several.blocks.map((block) => block.key)).toEqual(['g2', 'g3']);
    expect(several.blocks[1]?.dependencies).toEqual([
      { key: 'q', source: 'BLOCK', block: 'Rechercher un terme' },
    ]);
    expect(several.blocks[0]?.contract.outputs.map((output) => output.key)).toEqual(['q']);
    expect(several.summary.external).toEqual([]);
    const all = await client.library.planExtraction(project.id, N, {
      selection: [{ groupId: 'g1' }, { groupId: 'g2' }, { groupId: 'g3' }],
      mode: 'composite',
    });
    expect(all.blocks).toHaveLength(1);
    const composite = all.blocks[0];
    expect(composite?.composite).toBe(true);
    expect(composite?.groups.map((group) => group.id)).toEqual(['g1', 'g2', 'g3']);
    expect(composite?.steps).toHaveLength(total);
    expect(composite?.dependencies).toEqual([]);
    expect(composite?.data.map((entry) => entry.key)).toEqual(['q']);
    // Deux groupes qui ne se suivent pas : le second jouera là où le premier s'arrête, sauf s'il va à sa page.
    const gapped = await client.library.planExtraction(project.id, N, {
      selection: [{ groupId: 'g1' }, { groupId: 'g3' }],
      mode: 'composite',
    });
    expect(gapped.blocks[0]?.gaps).toHaveLength(relaunchStartsWithGoto ? 0 : 1);
  });

  it('plans a part of a group, and refuses a part whose check lost the action it follows', async () => {
    const check = G3.at(-1) ?? '';
    const part = await client.library.planExtraction(project.id, N, {
      selection: [{ groupId: 'g3', stepIds: G3.slice(0, -1) }],
      mode: 'separate',
    });
    expect(part.ok).toBe(true);
    expect(part.blocks[0]?.groups[0]).toMatchObject({ id: 'g3', steps: G3.length - 1, partial: true });
    // Garder la vérification sans l'action qu'elle suit (le clic) : refusé, l'étape est nommée.
    const broken = await client.library.planExtraction(project.id, N, {
      selection: [{ groupId: 'g3', stepIds: [...G3.slice(0, -2), check] }],
      mode: 'separate',
    });
    expect(broken.ok).toBe(false);
    expect(broken.errors.join(' ')).toMatch(
      /the check "[^"]+" follows the action "[^"]+", which is not chosen/,
    );
  });

  it('publishes all or nothing: a duplicated name refuses every block, with the reason per block', async () => {
    const error = await refusal(
      client.library.publishExtraction(project.id, N, {
        selection: [{ groupId: 'g2' }, { groupId: 'g3' }],
        mode: 'separate',
        names: { g3: { name: 'Rechercher un terme' } },
      }),
    );
    expect(error.status).toBe(422);
    expect(error.details.join(' ')).toContain(
      'two blocks of this publication are named "Rechercher un terme"',
    );
    expect(await client.library.list(project.id)).toEqual([]);
  });

  it('publishes one block per group in version 1, with the full provenance of the extraction', async () => {
    const blocks = await client.library.publishExtraction(project.id, N, {
      selection: [{ groupId: 'g1' }, { groupId: 'g2' }, { groupId: 'g3' }],
      mode: 'separate',
      navigate: true,
    });
    expect(blocks.map((block) => [block.name, block.state, block.version])).toEqual([
      ['Ouvrir une fiche utilisateur', 'VALID', 1],
      ['Rechercher un terme', 'VALID', 1],
      ['Relancer la recherche', 'VALID', 1],
    ]);
    const relaunch = blocks[2];
    expect(relaunch?.origin).toMatchObject({
      kind: 'recording',
      name: N,
      groupIds: ['g3'],
      stepIds: G3,
      mode: 'separate',
      navigate: true,
    });
    expect(relaunch?.origin?.revision).toMatch(/^[0-9a-f]{16}$/);
    expect(relaunch?.origin?.extractedAt).toBeDefined();
    expect(relaunch?.contract.inputs.map((input) => input.key)).toEqual(['q']);
    // Le premier bloc commence au début du parcours : aller à sa page de départ est une transformation notée.
    const open = await client.library.details(project.id, 'Ouvrir une fiche utilisateur');
    expect(open.steps[0]).toMatchObject({ position: 1, kind: 'goto' });
    expect(open.block.origin?.transformations?.join(' ')).toContain('goto');
    // Les données : la recherche définit q (sa stratégie, jamais sa valeur) ; la relance la lit.
    const search = await client.library.details(project.id, 'Rechercher un terme');
    expect(search.data).toEqual([{ key: 'q', strategy: 'RECORDED_LITERAL', dynamic: false }]);
    expect(JSON.stringify(search)).not.toContain('lampe de bureau');
    expect((await client.library.details(project.id, 'Relancer la recherche')).data).toEqual([]);
  });

  it('publishes a composite block that keeps its internal groups and their original identifiers', async () => {
    const [block] = await client.library.publishExtraction(project.id, N, {
      selection: [{ groupId: 'g2' }, { groupId: 'g3' }],
      mode: 'composite',
      names: {
        composite: { name: 'Recherche répétée', description: 'Cherche un terme puis relance la recherche.' },
      },
    });
    expect(block).toMatchObject({ name: 'Recherche répétée', state: 'VALID', version: 1 });
    expect(block?.groups?.map((group) => group.id)).toEqual(['g2', 'g3']);
    expect(block?.origin).toMatchObject({ mode: 'composite', groupIds: ['g2', 'g3'] });
    const details = await client.library.details(project.id, 'Recherche répétée');
    expect(details.groups).toEqual([
      { id: 'g2', name: 'Rechercher un terme', positions: [1, 2, 3] },
      { id: 'g3', name: 'Relancer la recherche', positions: G3.map((_, index) => 4 + index) },
    ]);
    // Composite et autonome : la donnée produite et lue à l'intérieur n'est plus une entrée.
    expect(block?.contract.inputs).toEqual([]);
  });

  it('compares with the source: a real change of the recording is seen, applied only on request, then validated', async () => {
    expect((await client.library.compareSource(project.id, 'Ouvrir une fiche utilisateur')).status).toBe(
      'SAME',
    );
    // Une vraie modification : retirer « Utilisateur 2 » de l'enregistrement.
    await client.recordings.removeStep(project.id, N, G1[1] ?? '');
    const changed = await client.library.compareSource(project.id, 'Ouvrir une fiche utilisateur');
    expect(changed.status).toBe('DIFFERENT');
    expect(changed.changes.length).toBeGreaterThan(0);
    expect(changed.revision?.extracted).not.toBe(changed.revision?.current);
    // Les autres blocs ne sont pas touchés par cette modification.
    expect((await client.library.compareSource(project.id, 'Rechercher un terme')).status).toBe('SAME');
    // Rien ne change en silence : le bloc reste en version 1 tant que la mise à jour n'est pas demandée.
    const before = (await client.library.list(project.id)).find(
      (block) => block.name === 'Ouvrir une fiche utilisateur',
    );
    expect(before).toMatchObject({ version: 1, state: 'VALID', steps: 3 });
    const updated = await client.library.updateFromSource(project.id, 'Ouvrir une fiche utilisateur');
    expect(updated).toMatchObject({ version: 1, state: 'CHANGED', steps: 2 });
    const validated = await client.library.validateVersion(project.id, 'Ouvrir une fiche utilisateur');
    expect(validated).toMatchObject({ version: 2, state: 'VALID' });
    expect(validated.history.at(-1)?.change).toBe('new content validated');
    expect((await client.library.compareSource(project.id, 'Ouvrir une fiche utilisateur')).status).toBe(
      'SAME',
    );
  });

  it('checks a journey: the reader before its producer is refused; the right order holds', async () => {
    const reversed = await client.scenarios.checkComposition(project.id, {
      name: 'Relance seule',
      parts: ['Relancer la recherche', 'Rechercher un terme'],
    });
    expect(reversed.ok).toBe(false);
    expect(reversed.errors).toContain('#1 "Relancer la recherche" needs q, produced only later by #2');
    const ordered = await client.scenarios.checkComposition(project.id, {
      name: 'Fiche puis deux recherches',
      parts: ['Ouvrir une fiche utilisateur', 'Rechercher un terme', 'Relancer la recherche'],
    });
    expect(ordered.ok).toBe(true);
    expect(ordered.dependencies).toEqual([{ key: 'q', from: 2, to: 3 }]);
  });

  it('replays for real the journey composed of the published blocks, and a composite block', async () => {
    await client.scenarios.compose(project.id, {
      name: 'Fiche puis deux recherches',
      parts: ['Ouvrir une fiche utilisateur', 'Rechercher un terme', 'Relancer la recherche'],
    });
    const [composite] = await client.library.publishExtraction(project.id, N, {
      selection: [{ groupId: 'g1' }, { groupId: 'g2' }],
      mode: 'composite',
      navigate: true,
      names: { composite: { name: 'Fiche puis recherche' } },
    });
    expect(composite).toMatchObject({ state: 'VALID', version: 1 });
    await client.scenarios.compose(project.id, {
      name: 'Fiche puis recherche seule',
      parts: ['Fiche puis recherche'],
    });
    for (const [scenario, minimum] of [
      ['Fiche puis deux recherches', 8],
      ['Fiche puis recherche seule', 5],
    ] as const) {
      const started = await client.executions.start(project.id, {
        environmentId: environment.id,
        scenarios: [scenario],
      });
      const last = await finished(started);
      expect(last.status).toBe('COMPLETED');
      const detail = await client.executions.get(project.id, started.run ?? '');
      const flow = detail.flowsDetail[0];
      // En cas d'échec, le message dit quel scénario, quelle étape et pourquoi (jamais une valeur saisie).
      const why = JSON.stringify({
        scenario,
        divergence: flow?.divergence,
        steps: flow?.steps.map((step) => `${String(step.index)} ${step.status} ${step.label}`),
      });
      expect(detail.flows, why).toMatchObject({ total: 1, passed: 1, failed: 0 });
      expect(flow?.testData).toContain('q');
      expect(flow?.steps.length).toBeGreaterThanOrEqual(minimum);
      expect(flow?.steps.every((step) => step.status === 'PASSED')).toBe(true);
    }
  }, 360_000);
});

describe('library — the same journey in the Dashboard (Chromium)', () => {
  it('publishes from the review: the unchosen producer is told, added, previewed, published as one block', async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(String(error)));
      const dashboard = page.locator('qa-crawler-dashboard');
      await page.goto(`${server.url}/dashboard`);
      await dashboard.locator('select[data-action="project-context"]').selectOption(project.id);
      await dashboard.locator('.drawer [data-action="nav"][data-view="recordings"]').click();
      await dashboard.locator(`[data-action="open-review"][data-recording="${N}"]`).first().click();
      await dashboard.locator('.rv-facts [data-action="review-tab"][data-tab="publish"]').click();
      // La relance seule : elle lit q, produite par la recherche qui n'est pas cochée.
      await dashboard.locator('[data-pub="group"][value="g3"]').check();
      const warning = dashboard.locator('.pub-warn', { hasText: 'qui n’est pas coché' });
      await warning.waitFor({ timeout: 15_000 });
      expect(await warning.textContent()).toContain(
        '« Relancer la recherche » lit q, produite par « Rechercher un terme »',
      );
      await dashboard
        .locator('.pub-foot', { hasText: 'Dépendances externes : q' })
        .waitFor({ timeout: 15_000 });
      await warning.locator('[data-action="pub-add-group"][data-group="g2"]').click();
      await dashboard
        .locator('.pub-foot', { hasText: 'Aucune dépendance externe' })
        .waitFor({ timeout: 15_000 });
      // Un seul bloc composé, renommé dans l'aperçu ; le serveur le vérifie avant l'écriture.
      await dashboard.locator('[data-action="pub-mode"][data-mode="composite"]').click();
      await dashboard.locator('.pub-foot [data-action="pub-preview"]').first().click();
      const sheet = dashboard.locator('.pub-sheet');
      await sheet.locator('.pub-tag.ok', { hasText: 'Prêt' }).waitFor({ timeout: 15_000 });
      const name = sheet.locator('[data-pub="name"]');
      await name.fill('Recherche depuis le Dashboard');
      await name.press('Tab');
      await expect
        .poll(() => sheet.locator('[data-action="pub-publish"]').isDisabled(), { timeout: 15_000 })
        .toBe(false);
      await sheet.locator('[data-action="pub-publish"]').click();
      await dashboard
        .locator('.notice', { hasText: 'Publié dans la bibliothèque : Recherche depuis le Dashboard' })
        .waitFor({ timeout: 15_000 });
      const published = (await client.library.list(project.id)).find(
        (block) => block.name === 'Recherche depuis le Dashboard',
      );
      expect(published).toMatchObject({ state: 'VALID', version: 1 });
      expect(published?.origin).toMatchObject({
        kind: 'recording',
        name: N,
        groupIds: ['g2', 'g3'],
        mode: 'composite',
      });

      // La bibliothèque : la fiche du bloc, ses groupes internes, la comparaison avec la source.
      await dashboard.locator('.notice [data-action="nav"][data-view="library"]').click();
      await dashboard.locator('.lib-title[data-block="Recherche depuis le Dashboard"]').click();
      const fiche = dashboard.locator('.lib-fiche');
      await fiche.waitFor();
      expect(await fiche.textContent()).toContain('Composé · 2 groupe(s)');
      await dashboard.locator('[data-action="lib-sheet-tab"][data-tab="steps"]').click();
      await fiche.locator('.lib-sgroup', { hasText: 'Relancer la recherche' }).waitFor({ timeout: 15_000 });
      await dashboard.locator('[data-action="lib-sheet-tab"][data-tab="provenance"]').click();
      await fiche.locator('[data-action="lib-compare"]').click();
      await fiche
        .locator('.lib-compare.ok', { hasText: 'Identique à la source' })
        .waitFor({ timeout: 15_000 });
      await page.keyboard.press('Escape');
      await expect.poll(() => dashboard.locator('.lib-fiche').count()).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  }, 180_000);
});
