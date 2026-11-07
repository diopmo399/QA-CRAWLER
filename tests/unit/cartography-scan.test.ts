import path from 'node:path';
import { mkdtemp, cp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CartographyConfig, CartographyModel, MapEdge } from '../../src/sdk/core/cartography.js';
import type { SourceFacts } from '../../src/cartography/facts.js';
import { runScan } from '../../src/cartography/scan.js';

/**
 * Le scan réel du mini-projet Front (Angular) → BFF (Spring) → Backend (Spring, JPA) → contrat (OpenAPI),
 * plus une source dont les technologies ne sont pas prises en charge. Rien n'est simulé : les faits viennent
 * des analyseurs, le graphe est construit à partir d'eux.
 */
const FIXTURE = path.resolve('tests/fixtures/cartography');
const configFor = (root: string): CartographyConfig => ({
  schema: 1,
  sources: [
    {
      id: 'front',
      name: 'Front',
      layer: 'FRONTEND',
      path: path.join(root, 'front'),
      include: [],
      enabled: true,
    },
    { id: 'bff', name: 'BFF', layer: 'BFF', path: path.join(root, 'bff'), include: [], enabled: true },
    {
      id: 'backend',
      name: 'Backend',
      layer: 'BACKEND',
      path: path.join(root, 'backend'),
      include: [],
      enabled: true,
    },
    {
      id: 'contracts',
      name: 'Contracts',
      layer: 'API',
      path: path.join(root, 'contracts'),
      include: [],
      enabled: true,
    },
    {
      id: 'other',
      name: 'Other',
      layer: 'OTHER',
      path: path.join(root, 'other'),
      include: [],
      enabled: true,
    },
  ],
});

const edgeOf = (
  model: CartographyModel,
  kind: MapEdge['kind'],
  from: string,
  to: string,
): MapEdge | undefined => model.edges.find((e) => e.kind === kind && e.from === from && e.to === to);

describe('cartography scan of the reference project', () => {
  let model: CartographyModel;
  let facts: SourceFacts[];
  beforeAll(async () => {
    ({ model, facts } = await runScan({
      config: configFor(FIXTURE),
      allowedRoots: [FIXTURE],
      incremental: false,
    }));
  });

  it('scans every source, detects the technologies and names the missing connectors', () => {
    expect(model.scan.state).toBe('COMPLETED');
    const byId = new Map(model.scan.sources.map((s) => [s.sourceId, s]));
    expect(byId.get('front')?.technologies.map((t) => [t.technology, t.supported])).toContainEqual([
      'ANGULAR',
      true,
    ]);
    expect(byId.get('bff')?.technologies.map((t) => t.technology)).toContain('SPRING');
    expect(byId.get('backend')?.technologies.map((t) => t.technology)).toEqual(
      expect.arrayContaining(['SPRING', 'JPA']),
    );
    expect(byId.get('contracts')?.technologies.map((t) => t.technology)).toContain('OPENAPI');
    const other = byId.get('other')?.technologies ?? [];
    expect(other.map((t) => t.technology)).toEqual(expect.arrayContaining(['DOTNET', 'GRAPHQL']));
    for (const t of other) {
      expect(t.supported).toBe(false);
      expect(t.note).toContain('connecteur manquant');
    }
    // Le fichier d'identifiants du backend n'est jamais lu.
    expect(byId.get('backend')?.secretsExcluded).toBe(1);
    expect(JSON.stringify(facts)).not.toContain('credentials.properties');
  });

  it('extracts form fields with their labels, validators and binding', () => {
    const fields = facts.find((f) => f.sourceId === 'front')?.ui?.fields ?? [];
    const company = fields.find((f) => f.id === 'RequestCreateComponent#form.companyName');
    expect(company).toMatchObject({ label: 'Company name', labelHow: 'for', bound: true });
    expect(company?.validators).toEqual(['required', 'maxLength:120']);
    expect(fields.find((f) => f.id === 'RequestCreateComponent#form.contactEmail')).toMatchObject({
      label: 'Contact email',
      labelHow: 'near',
    });
    expect(fields.find((f) => f.id === 'RequestCreateComponent#form.notes')?.bound).toBe(false);
  });

  it('follows the company name from the screen to the column, each step with its evidence', () => {
    const steps: [MapEdge['kind'], string, string, string][] = [
      [
        'SENDS',
        'FIELD:front:RequestCreateComponent#form.companyName',
        'METHOD:front:RequestService#create',
        'CONFIRMED',
      ],
      ['CALLS', 'METHOD:front:RequestService#create', 'API:bff:POST /api/requests', 'CONFIRMED'],
      [
        'SENDS',
        'FIELD:front:RequestCreateComponent#form.companyName',
        'FIELD:bff:CreateRequestDto.companyName',
        'CONFIRMED',
      ],
      [
        'TRANSFORMS',
        'FIELD:bff:CreateRequestDto.companyName',
        'FIELD:bff:BackendRequestBody.organizationName',
        'CONFIRMED',
      ],
      // L'adresse du backend vient d'une propriété : le lien est plausible, pas démontré.
      [
        'SENDS',
        'FIELD:bff:BackendRequestBody.organizationName',
        'FIELD:backend:CreateRequestCommand.organizationName',
        'PROBABLE',
      ],
      [
        'TRANSFORMS',
        'FIELD:backend:CreateRequestCommand.organizationName',
        'COLUMN:backend:Request.organizationName',
        'CONFIRMED',
      ],
      [
        'DEPENDS_ON',
        'FIELD:backend:CreateRequestCommand.organizationName',
        'FIELD:contracts:CreateRequestCommand.organizationName',
        'CONFIRMED',
      ],
    ];
    for (const [kind, from, to, confidence] of steps) {
      const found = edgeOf(model, kind, from, to);
      expect(found, `${kind} ${from} -> ${to}`).toBeDefined();
      expect(found?.confidence).toBe(confidence);
      expect(found?.reason.length).toBeGreaterThan(0);
      expect(found?.evidence.length).toBeGreaterThan(0);
    }
    const mapping = edgeOf(
      model,
      'TRANSFORMS',
      'FIELD:backend:CreateRequestCommand.organizationName',
      'COLUMN:backend:Request.organizationName',
    );
    expect(mapping?.evidence[0]).toMatchObject({
      sourceId: 'backend',
      file: 'src/main/java/test/backend/RequestService.java',
    });
    // La ligne du setter lui-même, pas celle de la méthode.
    expect(mapping?.evidence[0]?.line).toBe(15);
    const column = model.nodes.find((n) => n.id === 'COLUMN:backend:Request.organizationName');
    expect(column).toMatchObject({ name: 'REQUEST.ORGANIZATION_NAME', layer: 'DATABASE' });
    expect(column?.detail).toMatchObject({
      column: 'ORGANIZATION_NAME',
      columnSource: 'annotation',
      required: true,
      maxLength: 100,
    });
    const writes = edgeOf(
      model,
      'WRITES',
      'METHOD:backend:src/main/java/test/backend/RequestService.java#RequestService.create',
      'ENTITY:backend:Request',
    );
    expect(writes?.confidence).toBe('CONFIRMED');
  });

  it('proposes candidate features with their chain, and says where a link is not demonstrated', () => {
    expect(model.features.map((f) => f.name)).toEqual(
      expect.arrayContaining(['Request create', 'Request edit', 'Company form', 'Validate a request']),
    );
    for (const feature of model.features) expect(feature.status).toBe('CANDIDATE');
    const create = model.features.find((f) => f.name === 'Request create');
    expect(create?.layers).toEqual(expect.arrayContaining(['FRONTEND', 'BFF', 'BACKEND', 'API', 'DATABASE']));
    expect(create?.chain.every((step) => !step.gap)).toBe(true);
    const edit = model.features.find((f) => f.name === 'Request edit');
    expect(edit?.chain.find((step) => step.layer === 'API')?.gap).toContain('lien non démontré');
    const validate = model.features.find((f) => f.name === 'Validate a request');
    expect(validate?.basis).toContain('aucun écran');
    expect(validate?.chain.find((step) => step.layer === 'FRONTEND')?.gap).toContain('lien non démontré');
  });

  it('groups fields into concepts by links only: reuse is shown, homonyms are kept apart', () => {
    const request = model.concepts.find(
      (c) => c.id === 'CONCEPT:FIELD:front:RequestCreateComponent#form.companyName',
    );
    expect(request?.name).toBe('Company name');
    // Les écrans de création et de modification écrivent la même colonne : réutilisation démontrée.
    expect(request?.fields).toEqual(
      expect.arrayContaining([
        'FIELD:front:RequestEditComponent#form.companyName',
        'COLUMN:backend:Request.organizationName',
      ]),
    );
    expect(request?.status).toBe('PROBABLE');
    // Le même nom dans le formulaire d'organisation aboutit à une autre colonne : homonyme, pas fusionné.
    const company = model.concepts.find(
      (c) => c.id === 'CONCEPT:FIELD:front:CompanyFormComponent#form.companyName',
    );
    expect(company?.fields).toContain('COLUMN:backend:Company.name');
    expect(company?.fields).not.toContain('COLUMN:backend:Request.organizationName');
    expect(request?.homonyms).toContain(company?.id);
  });

  it('reports unused fields and validation divergences', () => {
    const issues = model.issues.map((i) => `${i.kind} ${i.message}`);
    expect(issues).toContain(
      'UNUSED notes : déclaré, relié à aucun élément du gabarit et envoyé par aucun appel',
    );
    expect(issues).toContain(
      'VALIDATION_DIVERGENCE Company name : longueurs maximales différentes (120 / 100)',
    );
    expect(issues).toContain(
      'VALIDATION_DIVERGENCE Contact email : obligatoire dans FRONTEND, BFF, facultatif dans BACKEND, API',
    );
  });
});

describe('cartography scan robustness', () => {
  let copy: string;
  beforeAll(async () => {
    copy = await mkdtemp(path.join(tmpdir(), 'qa-map-'));
    await cp(FIXTURE, copy, { recursive: true });
  });
  afterAll(async () => {
    await rm(copy, { recursive: true, force: true });
  });

  it('reuses the facts of an unchanged source and re-analyses a changed one', async () => {
    const first = await runScan({ config: configFor(copy), allowedRoots: [copy], incremental: true });
    const file = path.join(copy, 'backend/src/main/java/test/backend/CreateRequestCommand.java');
    await writeFile(file, (await readFile(file, 'utf8')).replace('@Size(max = 100)', '@Size(max = 120)'));
    const second = await runScan({
      config: configFor(copy),
      allowedRoots: [copy],
      incremental: true,
      previous: { facts: first.facts, sources: first.model.scan.sources },
    });
    const states = Object.fromEntries(second.model.scan.sources.map((s) => [s.sourceId, s.state]));
    expect(states).toMatchObject({ front: 'REUSED', bff: 'REUSED', backend: 'SCANNED', contracts: 'REUSED' });
    const field = second.model.nodes.find(
      (n) => n.id === 'FIELD:backend:CreateRequestCommand.organizationName',
    );
    expect(field?.detail.maxLength).toBe(120);
    // Les faits repris donnent le même graphe que les faits relus.
    expect(second.model.edges.length).toBe(first.model.edges.length);
  });

  it('refuses a source outside the allowed roots and one that escapes through a symbolic link', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'qa-map-outside-'));
    try {
      await symlink(outside, path.join(copy, 'escape'));
      const config: CartographyConfig = {
        schema: 1,
        sources: [
          { id: 'out', name: 'Out', layer: 'BACKEND', path: outside, include: [], enabled: true },
          {
            id: 'link',
            name: 'Link',
            layer: 'BACKEND',
            path: path.join(copy, 'escape'),
            include: [],
            enabled: true,
          },
          {
            id: 'off',
            name: 'Off',
            layer: 'BACKEND',
            path: path.join(copy, 'backend'),
            include: [],
            enabled: false,
          },
        ],
      };
      const { model } = await runScan({ config, allowedRoots: [copy], incremental: false });
      expect(model.scan.sources.map((s) => s.state)).toEqual(['DENIED', 'DENIED', 'DISABLED']);
      expect(model.scan.state).toBe('FAILED');
      expect(model.nodes).toHaveLength(0);
    } finally {
      await rm(path.join(copy, 'escape'), { force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('stops at the size limits (partial scan) and on cancellation', async () => {
    const limited = await runScan({
      config: configFor(copy),
      allowedRoots: [copy],
      incremental: false,
      limits: { maxFiles: 3, maxFileBytes: 512 * 1024, maxDurationMs: 60_000 },
    });
    expect(limited.model.scan.state).toBe('PARTIAL');
    expect(limited.model.scan.sources.find((s) => s.sourceId === 'bff')?.state).toBe('PARTIAL');
    const controller = new AbortController();
    controller.abort();
    const cancelled = await runScan({
      config: configFor(copy),
      allowedRoots: [copy],
      incremental: false,
      signal: controller.signal,
    });
    expect(cancelled.model.scan.state).toBe('CANCELLED');
  });
});
