import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addLink,
  classify,
  ConnectorError,
  decide,
  decideLink,
  importSource,
  publish,
  RequirementsStore,
  upsertLink,
  type Block,
  type ExtractedDocument,
  type ExtractedItem,
  type ImportBatch,
  type SourceConnector,
} from '../../src/requirements/index.js';

/**
 * LE SOCLE DU RÉFÉRENTIEL D'EXIGENCES (phase 2) : normalisation expliquée, provenance, doublons et
 * conflits, décisions humaines, publication versionnée, liens et persistance. Les documents viennent
 * d'un connecteur de TEST (en mémoire) : aucune source réelle n'est lue ici.
 */
const at = (minute: number): Date => new Date(Date.UTC(2026, 9, 27, 10, minute));
const loc = (block: number) => ({ block });

function doc(
  blocks: Block[],
  extra: Partial<ExtractedDocument['source']> = {},
  completeness: ExtractedDocument['completeness'] = 'COMPLETE',
): ExtractedDocument {
  return {
    source: { kind: 'TEST', sourceId: 'doc-1', title: 'Spécification demandes', version: '1', ...extra },
    blocks,
    metadata: {},
    links: [],
    issues:
      completeness === 'PARTIAL'
        ? [{ severity: 'WARNING', code: 'PAGE_UNREADABLE', message: 'page 3 not read' }]
        : [],
    completeness,
  };
}

/** Un connecteur de test : rend le document qu'on lui donne, ou l'erreur qu'on lui donne. */
const testConnector: SourceConnector<ExtractedDocument | ConnectorError | 'invalid'> = {
  kind: 'TEST',
  describe: () => ({
    kind: 'TEST',
    label: 'test',
    formats: [],
    maxBytes: 1,
    capabilities: {
      headings: true,
      lists: true,
      tables: true,
      pages: false,
      versions: true,
      refresh: true,
      ocr: false,
    },
    limits: [],
  }),
  validate: (input) =>
    input === 'invalid' ? [{ severity: 'ERROR', code: 'INVALID_INPUT', message: 'bad input' }] : [],
  extract: (input) =>
    input instanceof ConnectorError ? Promise.reject(input) : Promise.resolve(input as ExtractedDocument),
};

const SPEC: Block[] = [
  { type: 'heading', level: 1, text: 'Demandes', location: loc(0) },
  { type: 'paragraph', text: 'Ce document décrit la gestion des demandes.', location: loc(1) },
  { type: 'heading', level: 2, text: 'Exigences', location: loc(2) },
  {
    type: 'paragraph',
    text: 'REQ-1 : Créer une demande. Le système doit enregistrer une demande avec son titre.',
    location: loc(3),
  },
  {
    type: 'paragraph',
    text: 'RG-1 Le titre est obligatoire et fait au plus 80 caractères.',
    location: loc(4),
  },
  {
    type: 'list',
    ordered: false,
    items: [
      'Étant donné un formulaire vide, quand on enregistre, alors la demande est refusée avec une erreur',
      'Les demandes sont listées par date.',
    ],
    location: loc(5),
  },
  { type: 'heading', level: 2, text: 'Contexte', location: loc(6) },
  { type: 'paragraph', text: 'Le service doit répondre en moins de 2 secondes.', location: loc(7) },
  { type: 'paragraph', text: 'Historique du projet.', location: loc(8) },
];

const byExternal = (items: ExtractedItem[], id: string): ExtractedItem =>
  items.find((item) => item.externalId === id) as ExtractedItem;

describe('requirements — normalisation', () => {
  const { items, issues } = classify(doc(SPEC), at(0).toISOString());

  it('classifies with explicit rules and says why, never a paragraph as a requirement by default', () => {
    const req = byExternal(items, 'REQ-1');
    expect(req).toMatchObject({ kind: 'REQUIREMENT', confidence: 'HIGH', title: 'Créer une demande' });
    expect(req.reasons).toEqual(['identifiant explicite REQ-1']);
    expect(req.source).toMatchObject({
      kind: 'TEST',
      sourceId: 'doc-1',
      version: '1',
      location: { block: 3, section: ['Demandes', 'Exigences'] },
    });
    // Préfixe de règle dans la section « Exigences » : le préfixe l'emporte, la confiance baisse et le dit.
    const rule = byExternal(items, 'RG-1');
    expect(rule).toMatchObject({ kind: 'BUSINESS_RULE', confidence: 'MEDIUM', parentExternalId: 'REQ-1' });
    expect(rule.reasons[1]).toContain('contredit la section');
    const criterion = items.find((item) => item.kind === 'ACCEPTANCE_CRITERION') as ExtractedItem;
    expect(criterion).toMatchObject({ confidence: 'MEDIUM', parentExternalId: 'RG-1' });
    expect(criterion.criterion).toEqual({
      given: ['un formulaire vide'],
      when: ['on enregistre'],
      then: ['la demande est refusée avec une erreur'],
      negative: true,
    });
    const listed = items.find((item) => item.description === 'Les demandes sont listées par date.');
    expect(listed).toMatchObject({
      kind: 'REQUIREMENT',
      confidence: 'MEDIUM',
      reasons: ['dans la section « exigences »'],
    });
    const normative = items.find((item) => item.description.startsWith('Le service doit'));
    expect(normative).toMatchObject({ kind: 'REQUIREMENT', confidence: 'LOW' });
    expect(items.filter((item) => item.kind === 'INFORMATION').map((item) => item.description)).toEqual([
      'Ce document décrit la gestion des demandes.',
      'Historique du projet.',
    ]);
    expect(issues).toEqual([]);
  });

  it('a heading with an identifier opens a candidate whose body follows', () => {
    const { items: found } = classify(
      doc([
        { type: 'heading', level: 2, text: 'REQ-7 Export des demandes', location: loc(0) },
        { type: 'paragraph', text: 'Un export CSV est proposé.', location: loc(1) },
        { type: 'list', ordered: true, items: ['colonnes titre et date'], location: loc(2) },
        { type: 'heading', level: 2, text: 'Suite', location: loc(3) },
      ]),
      at(0).toISOString(),
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      externalId: 'REQ-7',
      title: 'Export des demandes',
      description: 'Un export CSV est proposé.\ncolonnes titre et date',
      confidence: 'HIGH',
    });
  });

  it('reads requirement tables by their headers, with child rules; an unknown table is unclassified', () => {
    const { items: found, issues: problems } = classify(
      doc([
        {
          type: 'table',
          header: ['ID', 'Titre', 'Priorité', 'Règle métier'],
          rows: [
            ['REQ-10', 'Annuler une demande', 'Haute', 'Une demande clôturée ne peut pas être annulée'],
            ['', 'Archiver', 'Basse', ''],
          ],
          cells: [
            ['A2', 'B2', 'C2', 'D2'],
            ['A3', 'B3', 'C3', 'D3'],
          ],
          location: { block: 0, sheet: 'Exigences' },
        },
        {
          type: 'table',
          header: ['Colonne 1', 'Colonne 2'],
          rows: [['x', 'Le système doit tout faire']],
          location: loc(1),
        },
      ]),
      at(0).toISOString(),
    );
    expect(found[0]).toMatchObject({
      externalId: 'REQ-10',
      kind: 'REQUIREMENT',
      confidence: 'HIGH',
      attributes: { priority: 'Haute' },
      source: { location: { sheet: 'Exigences', row: 1, cell: 'A2' } },
    });
    expect(found[1]).toMatchObject({
      kind: 'BUSINESS_RULE',
      confidence: 'MEDIUM',
      parentExternalId: 'REQ-10',
    });
    expect(found[2]).toMatchObject({ title: 'Archiver', confidence: 'MEDIUM' });
    expect(found.at(-1)).toMatchObject({ kind: 'UNCLASSIFIED', confidence: 'LOW' });
    expect(problems.map((problem) => problem.code)).toEqual(['TABLE_NOT_MAPPED']);
  });

  it('a profile imposes the columns and the identifier prefixes', () => {
    const { items: found } = classify(
      doc([
        {
          type: 'table',
          header: ['Réf. interne', 'Énoncé'],
          rows: [['EXI-4', 'Le client voit son solde']],
          location: loc(0),
        },
      ]),
      at(0).toISOString(),
      { columns: { id: 'Réf. interne', description: 'Énoncé' }, idPrefixes: { REQUIREMENT: ['EXI'] } },
    );
    expect(found[0]).toMatchObject({
      externalId: 'EXI-4',
      kind: 'REQUIREMENT',
      description: 'Le client voit son solde',
    });
  });

  it('flags an identifier present twice in the same source', () => {
    const { issues: problems } = classify(
      doc([
        { type: 'paragraph', text: 'REQ-2 Première version', location: loc(0) },
        { type: 'paragraph', text: 'REQ-2 Seconde version', location: loc(1) },
      ]),
      at(0).toISOString(),
    );
    expect(problems.map((problem) => problem.code)).toEqual(['DUPLICATE_ID_IN_SOURCE']);
  });
});

describe('requirements — import, decisions, publication', () => {
  let dir = '';
  let store: RequirementsStore;
  const ctx = (minute: number) => ({ now: at(minute), env: {} });

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'req-'));
    store = new RequirementsStore(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function importAndPublishAll(document: ExtractedDocument, minute: number): Promise<ImportBatch> {
    const batch = await importSource(store, testConnector, document, ctx(minute));
    await decide(
      store,
      batch.id,
      batch.items
        .filter((item) => item.kind !== 'INFORMATION' && item.duplicate.status !== 'UNCHANGED')
        .map((item) => ({
          itemId: item.id,
          decision: {
            action: 'ACCEPT',
            ...(item.kind === 'UNCLASSIFIED' ? { kind: 'REQUIREMENT' } : {}),
            by: 'analyste',
          },
        })),
      at(minute),
    );
    await publish(store, batch.id, at(minute));
    return (await store.readBatch(batch.id)) as ImportBatch;
  }

  it('an import waits for validation; nothing enters the repository before a decision', async () => {
    const batch = await importSource(store, testConnector, doc(SPEC), ctx(0));
    expect(batch.status).toBe('VALIDATION_REQUIRED');
    expect((await store.readRepository()).entities).toEqual([]);
    expect((await store.listBatches()).map((entry) => entry.id)).toEqual([batch.id]);
    // L'information n'est pas proposée ; l'accepter demanderait un type explicite.
    const info = batch.items.find((item) => item.kind === 'INFORMATION') as ExtractedItem;
    await expect(
      decide(store, batch.id, [{ itemId: info.id, decision: { action: 'ACCEPT' } }], at(1)),
    ).rejects.toMatchObject({
      code: 'INVALID_DECISION',
    });
  });

  it('publishes decided candidates with provenance, version 1, history and parent links', async () => {
    const batch = await importSource(store, testConnector, doc(SPEC), ctx(0));
    const req = byExternal(batch.items, 'REQ-1');
    const rule = byExternal(batch.items, 'RG-1');
    const criterion = batch.items.find((item) => item.kind === 'ACCEPTANCE_CRITERION') as ExtractedItem;
    const low = batch.items.find((item) => item.confidence === 'LOW') as ExtractedItem;
    await decide(
      store,
      batch.id,
      [
        { itemId: req.id, decision: { action: 'ACCEPT', by: 'analyste' } },
        {
          itemId: rule.id,
          decision: {
            action: 'ACCEPT',
            description: 'Le titre est obligatoire (80 caractères au plus).',
            by: 'analyste',
          },
        },
        { itemId: criterion.id, decision: { action: 'ACCEPT', parent: 'RG-1', by: 'analyste' } },
        {
          itemId: low.id,
          decision: { action: 'REJECT', note: 'exigence d’architecture, hors périmètre', by: 'analyste' },
        },
      ],
      at(1),
    );
    const result = await publish(store, batch.id, at(2));
    expect(result.created).toHaveLength(3);
    const repository = await store.readRepository();
    const published = repository.entities.find((entity) => entity.externalId === 'REQ-1');
    expect(published).toMatchObject({
      kind: 'REQUIREMENT',
      version: 1,
      validation: 'VALIDATED',
      sources: [{ sourceId: 'doc-1', version: '1', location: { block: 3 } }],
      history: [{ version: 1, change: 'CREATED', batchId: batch.id, by: 'analyste' }],
    });
    const publishedRule = repository.entities.find((entity) => entity.externalId === 'RG-1');
    expect(publishedRule).toMatchObject({ description: 'Le titre est obligatoire (80 caractères au plus).' });
    expect(publishedRule?.history[0]?.edited).toBe(true);
    // Le lien proposé (même section) et le lien donné par la personne (confirmé).
    expect(repository.links.map((link) => [link.type, link.validation, link.confidence])).toEqual([
      ['HAS_RULE', 'PROPOSED', 'MEDIUM'],
      ['HAS_CRITERION', 'CONFIRMED', 'HIGH'],
    ]);
    expect(repository.links[0]?.justification[0]).toContain('follows REQ-1 in the same section');
    const after = (await store.readBatch(batch.id)) as ImportBatch;
    expect(after.items.find((item) => item.id === low.id)?.decision?.action).toBe('REJECT');
    expect(after.status).toBe('VALIDATION_REQUIRED');
  });

  it('re-importing the same source changes nothing; a modified source needs a decision and makes a new version', async () => {
    await importAndPublishAll(doc(SPEC), 0);
    const again = await importSource(store, testConnector, doc(SPEC), ctx(5));
    expect(
      again.items
        .filter((item) => item.kind !== 'INFORMATION')
        .every((item) => item.duplicate.status === 'UNCHANGED'),
    ).toBe(true);
    expect(again.status).toBe('COMPLETED');

    const changed = SPEC.map((block) =>
      block.type === 'paragraph' && block.text.startsWith('REQ-1')
        ? {
            ...block,
            text: 'REQ-1 : Créer une demande. Le système doit enregistrer une demande avec son titre et sa date.',
          }
        : block,
    );
    const update = await importSource(store, testConnector, doc(changed, { version: '2' }), ctx(10));
    const item = byExternal(update.items, 'REQ-1');
    expect(item.duplicate.status).toBe('SOURCE_CHANGED');
    expect(update.status).toBe('VALIDATION_REQUIRED');
    // Tant que personne ne décide, le référentiel garde l'ancienne version.
    expect(
      (await store.readRepository()).entities.find((entity) => entity.externalId === 'REQ-1')?.version,
    ).toBe(1);
    await decide(
      store,
      update.id,
      [{ itemId: item.id, decision: { action: 'ACCEPT', by: 'analyste' } }],
      at(11),
    );
    await publish(store, update.id, at(12));
    const repository = await store.readRepository();
    const req = repository.entities.find((entity) => entity.externalId === 'REQ-1');
    expect(req).toMatchObject({ version: 2, sources: [{ version: '2' }] });
    expect(req?.history.map((revision) => revision.change)).toEqual(['CREATED', 'UPDATED']);
    expect(req?.history[1]?.previous?.description).toContain('avec son titre.');
    // Ses liens sont à réexaminer, sans être supprimés.
    const link = repository.links.find((entry) => entry.type === 'HAS_RULE');
    expect(link).toMatchObject({ freshness: 'POSSIBLY_STALE', validation: 'PROPOSED' });
  });

  it('an element gone from its source is reported, never deleted', async () => {
    await importAndPublishAll(doc(SPEC), 0);
    const shorter = SPEC.filter((block) => !(block.type === 'paragraph' && block.text.startsWith('RG-1')));
    const update = await importSource(store, testConnector, doc(shorter, { version: '3' }), ctx(5));
    const repository = await store.readRepository();
    const rule = repository.entities.find((entity) => entity.externalId === 'RG-1');
    expect(update.missingFromSource).toContain(rule?.id);
    expect(repository.entities).toContainEqual(expect.objectContaining({ externalId: 'RG-1' }));
  });

  it('the same identifier from another source is a conflict: merge or reject, never a silent second copy', async () => {
    await importAndPublishAll(doc(SPEC), 0);
    const other = await importSource(
      store,
      testConnector,
      doc([{ type: 'paragraph', text: 'REQ-1 Créer une demande depuis le portail', location: loc(0) }], {
        sourceId: 'doc-2',
        title: 'Cahier portail',
      }),
      ctx(5),
    );
    const item = other.items[0] as ExtractedItem;
    expect(item.duplicate).toMatchObject({ status: 'SAME_ID_OTHER_SOURCE' });
    await expect(
      decide(store, other.id, [{ itemId: item.id, decision: { action: 'ACCEPT' } }], at(6)),
    ).rejects.toMatchObject({
      code: 'CONFLICT_REQUIRES_MERGE',
    });
    await decide(
      store,
      other.id,
      [
        {
          itemId: item.id,
          decision: { action: 'MERGE', mergeInto: item.duplicate.entityId, by: 'analyste' },
        },
      ],
      at(6),
    );
    await publish(store, other.id, at(7));
    const req = (await store.readRepository()).entities.find((entity) => entity.externalId === 'REQ-1');
    expect(req?.sources.map((source) => source.sourceId)).toEqual(['doc-1', 'doc-2']);
    expect(req?.history.at(-1)).toMatchObject({ change: 'MERGED', by: 'analyste' });
    // Le texte n'a pas changé : la fusion ajoute une provenance.
    expect(req?.title).toBe('Créer une demande');
  });

  it('a close text without identifier is only a merge proposal', async () => {
    await importAndPublishAll(
      doc([
        { type: 'heading', level: 1, text: 'Exigences', location: loc(0) },
        {
          type: 'paragraph',
          text: 'Le client peut consulter le solde de son compte courant en ligne.',
          location: loc(1),
        },
      ]),
      0,
    );
    const similar = await importSource(
      store,
      testConnector,
      doc(
        [
          { type: 'heading', level: 1, text: 'Exigences', location: loc(0) },
          {
            type: 'paragraph',
            text: 'Le client peut consulter en ligne le solde de son compte courant.',
            location: loc(1),
          },
        ],
        {
          sourceId: 'doc-3',
          title: 'Autre document',
        },
      ),
      ctx(5),
    );
    expect(similar.items[0]?.duplicate).toMatchObject({ status: 'SIMILAR' });
    expect(similar.items[0]?.duplicate.similarity).toBeGreaterThanOrEqual(0.75);
    expect((await store.readRepository()).entities).toHaveLength(1);
  });

  it('refuses to publish a partial read without an explicit acknowledgement', async () => {
    const batch = await importSource(store, testConnector, doc(SPEC, {}, 'PARTIAL'), ctx(0));
    expect(batch.status).toBe('PARTIAL');
    const req = byExternal(batch.items, 'REQ-1');
    await decide(store, batch.id, [{ itemId: req.id, decision: { action: 'ACCEPT' } }], at(1));
    await expect(publish(store, batch.id, at(2))).rejects.toMatchObject({ code: 'PARTIAL_NOT_ACKNOWLEDGED' });
    const result = await publish(store, batch.id, at(2), { acknowledgePartial: true, by: 'analyste' });
    expect(result.created).toHaveLength(1);
  });

  it('records a failed import: invalid input, or the connector error code', async () => {
    const invalid = await importSource(store, testConnector, 'invalid', ctx(0));
    expect(invalid).toMatchObject({ status: 'FAILED', issues: [{ code: 'INVALID_INPUT' }] });
    const denied = await importSource(
      store,
      testConnector,
      new ConnectorError('PERMISSION', 'no read access'),
      ctx(1),
    );
    expect(denied).toMatchObject({
      status: 'FAILED',
      issues: [{ code: 'PERMISSION', message: 'no read access' }],
    });
    expect(await store.listBatches()).toHaveLength(2);
  });
});

describe('requirements — links and persistence', () => {
  let dir = '';
  let store: RequirementsStore;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'req-links-'));
    store = new RequirementsStore(dir);
    const batch = await importSource(store, testConnector, doc(SPEC), { now: at(0), env: {} });
    await decide(
      store,
      batch.id,
      [byExternal(batch.items, 'REQ-1'), byExternal(batch.items, 'RG-1')].map((item) => ({
        itemId: item.id,
        decision: { action: 'ACCEPT' as const },
      })),
      at(0),
    );
    await publish(store, batch.id, at(0));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('a rejected link is never revived by an automatic proposal; a manual link needs a justification', async () => {
    const repository = await store.readRepository();
    const link = repository.links[0];
    await decideLink(store, link?.id ?? '', 'REJECT', at(1), { by: 'analyste', note: 'règle commune' });
    const after = await store.readRepository();
    const rejected = after.links[0];
    upsertLink(after, {
      type: 'HAS_RULE',
      from: rejected?.from ?? { kind: '', id: '' },
      to: rejected?.to ?? { kind: '', id: '' },
      origin: 'ANALYSIS',
      justification: ['same section again'],
      confidence: 'HIGH',
      at: at(2).toISOString(),
    });
    expect(after.links[0]).toMatchObject({ validation: 'REJECTED' });
    expect(after.links[0]?.decisions.map((decision) => decision.action)).toEqual(['PROPOSE', 'REJECT']);

    const req = after.entities.find((entity) => entity.externalId === 'REQ-1');
    await expect(
      addLink(
        store,
        {
          type: 'TESTED_BY',
          from: { kind: 'REQUIREMENT', id: req?.id ?? '' },
          to: { kind: 'TEST', id: 'create-request' },
          justification: [],
        },
        at(3),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_DECISION' });
    const manual = await addLink(
      store,
      {
        type: 'TESTED_BY',
        from: { kind: 'REQUIREMENT', id: req?.id ?? '' },
        to: { kind: 'TEST', id: 'create-request' },
        justification: ['le flow create-request crée une demande'],
        by: 'testeur',
      },
      at(3),
    );
    expect(manual).toMatchObject({
      origin: 'MANUAL',
      validation: 'CONFIRMED',
      decisions: [{ action: 'ADD', by: 'testeur' }],
    });
    await expect(
      addLink(
        store,
        {
          type: 'TESTED_BY',
          from: { kind: 'REQUIREMENT', id: 'req_missing' },
          to: { kind: 'TEST', id: 'x' },
          justification: ['x'],
        },
        at(3),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('writes plain JSON files, refuses a path-like import id and an unknown file format', async () => {
    expect((await readdir(dir)).sort()).toEqual(['imports', 'repository.json']);
    expect(JSON.parse(await readFile(path.join(dir, 'repository.json'), 'utf8'))).toMatchObject({
      formatVersion: 1,
    });
    await expect(store.readBatch('../repository')).rejects.toThrow('invalid import identifier');
    await writeFile(path.join(dir, 'repository.json'), '{"entities":[]}');
    await expect(store.readRepository()).rejects.toThrow('not a requirements repository');
  });
});
