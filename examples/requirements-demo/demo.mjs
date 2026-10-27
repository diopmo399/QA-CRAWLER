// Démonstration : importer des exigences depuis Word, Excel et PDF, valider, publier, réimporter.
//
//   npm run build
//   node examples/requirements-demo/demo.mjs [--workspace <dossier>] [--json]
//
// Les documents de data/ décrivent une médiathèque FICTIVE (tout le contenu est inventé). Le script
// déroule le parcours complet du référentiel, étape par étape :
//   1. la spécification Word v1 : candidats classés avec la raison de chaque classement, décisions,
//      publication (entités en version 1, liens proposés vers les parents) ;
//   2. le classeur Excel, lu avec un profil d'importation : un identifiant déjà pris par le document
//      Word (conflit), un texte très proche d'une exigence existante (doublon probable) ;
//   3. l'annexe PDF (si pdfjs-dist est installé) ;
//   4. la spécification Word v2 : inchangé, modifié, nouveau, retiré de la source.
//
// LES DÉCISIONS SONT CELLES DE LA DÉMONSTRATION : dans un vrai usage, une personne les prend (rien
// n'est publié sans elle). Le script les déclare sous le nom « demo ».
//
// Le référentiel est écrit dans le dossier donné (par défaut : un dossier temporaire), en fichiers
// JSON lisibles : repository.json, imports/<lot>.json, profiles/<nom>.json.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  decide,
  ExcelConnector,
  importSource,
  pdfjsModule,
  PdfConnector,
  publish,
  RequirementsStore,
  WordConnector,
} from '@qa-crawler/core/requirements';

const { values } = parseArgs({
  options: { workspace: { type: 'string' }, json: { type: 'boolean', default: false } },
});
const data = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
const dir = path.resolve(values.workspace ?? (await mkdtemp(path.join(tmpdir(), 'qa-requirements-demo-'))));
const store = new RequirementsStore(dir);
const BY = 'demo';
// Des dates fixes : la sortie est la même à chaque lancement.
const day = (n) => ({ now: new Date(Date.UTC(2026, 9, 20 + n, 9, 0)), env: {} });
const SPEC = 'word:mediatheque-specification';

const report = { workspace: dir, steps: [] };
const out = (line = '') => {
  if (!values.json) console.log(line);
};

const KIND = {
  REQUIREMENT: 'exigence',
  BUSINESS_RULE: 'règle',
  ACCEPTANCE_CRITERION: 'critère',
  INFORMATION: 'information',
  UNCLASSIFIED: 'à classer',
};
const CONFIDENCE = { HIGH: 'ÉLEVÉ', MEDIUM: 'MOYEN', LOW: 'FAIBLE', NOT_EVALUATED: 'NON ÉVALUÉ' };
const DUPLICATE = {
  NEW: 'nouveau',
  UNCHANGED: 'inchangé',
  SOURCE_CHANGED: 'modifié dans la source',
  SAME_ID_OTHER_SOURCE: 'CONFLIT : identifiant déjà pris par une autre source',
  SIMILAR: 'doublon probable',
};

async function showBatch(title, batch) {
  out(`\n━━ ${title}`);
  out(`   lot ${batch.id} · ${batch.source.title} · statut ${batch.status} · lecture ${batch.completeness}`);
  for (const item of batch.items) {
    const id = item.externalId ?? '(sans id)';
    const parent = item.parentExternalId ? ` ← ${item.parentExternalId}` : '';
    const dup =
      item.duplicate.status === 'SIMILAR'
        ? `${DUPLICATE.SIMILAR} (${String(item.duplicate.similarity)})`
        : DUPLICATE[item.duplicate.status];
    out(
      `   · ${KIND[item.kind].padEnd(11)} ${id.padEnd(9)} ${CONFIDENCE[item.confidence].padEnd(10)} ${dup}${parent}`,
    );
    out(`       « ${item.title} »`);
    if (item.kind !== 'INFORMATION') out(`       pourquoi : ${item.reasons.join(' ; ')}`);
  }
  for (const issue of batch.issues) out(`   ! ${issue.severity} ${issue.code} : ${issue.message}`);
  if (batch.missingFromSource.length > 0) {
    const { entities } = await store.readRepository();
    const names = batch.missingFromSource.map(
      (id) => entities.find((entity) => entity.id === id)?.externalId ?? id,
    );
    out(`   ! absents de la nouvelle version (signalés, jamais supprimés) : ${names.join(', ')}`);
  }
  report.steps.push({
    title,
    batch: batch.id,
    status: batch.status,
    items: batch.items.map((item) => ({
      kind: item.kind,
      externalId: item.externalId,
      confidence: item.confidence,
      duplicate: item.duplicate.status,
      parent: item.parentExternalId,
    })),
    issues: batch.issues.map((issue) => issue.code),
    missingFromSource: batch.missingFromSource,
  });
}

/**
 * Les décisions de la démonstration : accepter ce qui est classé, accepter la phrase normative sans
 * identifiant comme une règle, refuser le conflit d'identifiant, fusionner le doublon probable.
 */
async function decideAll(batch, now) {
  const decisions = [];
  for (const item of batch.items) {
    if (item.kind === 'INFORMATION' || item.duplicate.status === 'UNCHANGED' || item.published) continue;
    if (item.duplicate.status === 'SAME_ID_OTHER_SOURCE')
      decisions.push({
        itemId: item.id,
        decision: { action: 'REJECT', by: BY, note: 'identifiant déjà utilisé : la source est à corriger' },
      });
    else if (item.duplicate.status === 'SIMILAR')
      decisions.push({
        itemId: item.id,
        decision: { action: 'MERGE', mergeInto: item.duplicate.entityId, by: BY, note: 'même exigence' },
      });
    else if (item.kind === 'UNCLASSIFIED' || (item.kind === 'REQUIREMENT' && !item.externalId))
      decisions.push({ itemId: item.id, decision: { action: 'ACCEPT', kind: 'BUSINESS_RULE', by: BY } });
    else decisions.push({ itemId: item.id, decision: { action: 'ACCEPT', by: BY } });
  }
  if (decisions.length === 0) return undefined;
  await decide(store, batch.id, decisions, now);
  const result = await publish(store, batch.id, now, { by: BY });
  const counts = decisions.reduce(
    (acc, { decision }) => ({ ...acc, [decision.action]: (acc[decision.action] ?? 0) + 1 }),
    {},
  );
  out(
    `   ✔ décisions (démonstration) : ${Object.entries(counts)
      .map(([action, count]) => `${action} ${String(count)}`)
      .join(', ')}`,
  );
  out(
    `   ✔ publié : ${String(result.created.length)} créé(s), ${String(result.updated.length)} nouvelle(s) version(s), ${String(result.merged.length)} fusionné(s), ${String(result.links.length)} lien(s)`,
  );
  report.steps.at(-1).published = {
    created: result.created.length,
    updated: result.updated.length,
    merged: result.merged.length,
    links: result.links.length,
  };
  return result;
}

out(`Référentiel : ${dir}`);

// 1. La spécification Word, version 1.
let batch = await importSource(
  store,
  new WordConnector(),
  { file: path.join(data, 'mediatheque-specification-v1.docx'), sourceId: SPEC },
  day(0),
);
await showBatch('1. Spécification Word v1', batch);
await decideAll(batch, day(0).now);

// 2. Le classeur Excel, avec un profil : la feuille « Exigences » a une ligne de titre au-dessus de l'en-tête.
const profile = await store.saveProfile(
  { name: 'portail-excel', connector: 'EXCEL', classify: {}, options: { headerRow: { Exigences: 2 } } },
  day(1).now,
);
batch = await importSource(
  store,
  new ExcelConnector(),
  { file: path.join(data, 'mediatheque-portail.xlsx'), ...profile.options },
  day(1),
  { classify: profile.classify },
);
await showBatch(`2. Classeur Excel (profil « ${profile.name} »)`, batch);
await decideAll(batch, day(1).now);

// 3. L'annexe PDF : pdf.js est une dépendance facultative.
if (pdfjsModule()) {
  batch = await importSource(
    store,
    new PdfConnector(),
    { file: path.join(data, 'mediatheque-annexe-qualite.pdf') },
    day(2),
  );
  await showBatch('3. Annexe PDF', batch);
  if (batch.status !== 'FAILED') await decideAll(batch, day(2).now);
} else {
  out('\n━━ 3. Annexe PDF : sautée (pdfjs-dist n’est pas installé)');
  report.steps.push({ title: '3. Annexe PDF', skipped: 'pdfjs-dist not installed' });
}

// 4. La spécification Word, version 2 (même source, nouvelle version).
batch = await importSource(
  store,
  new WordConnector(),
  { file: path.join(data, 'mediatheque-specification-v2.docx'), sourceId: SPEC },
  day(3),
);
await showBatch('4. Spécification Word v2 (réimportation)', batch);
await decideAll(batch, day(3).now);

// Le référentiel final.
const repository = await store.readRepository();
const byKind = repository.entities.reduce(
  (acc, entity) => ({ ...acc, [entity.kind]: (acc[entity.kind] ?? 0) + 1 }),
  {},
);
out('\n━━ Référentiel');
out(
  `   ${String(repository.entities.length)} élément(s) : ${Object.entries(byKind)
    .map(([kind, count]) => `${String(count)} ${KIND[kind]}(s)`)
    .join(', ')}`,
);
for (const entity of repository.entities) {
  const sources = entity.sources.map((source) => source.title).join(' + ');
  out(
    `   · ${(entity.externalId ?? entity.id).padEnd(16)} v${String(entity.version)}  ${KIND[entity.kind].padEnd(11)} ${entity.title}  [${sources}]`,
  );
}
out(`   ${String(repository.links.length)} lien(s) :`);
const name = (id) => repository.entities.find((entity) => entity.id === id)?.externalId ?? id;
for (const link of repository.links)
  out(
    `   · ${name(link.from.id)} ${link.type} ${name(link.to.id)}  confiance ${CONFIDENCE[link.confidence]} · ${link.validation} · ${link.freshness}`,
  );
out('\nAucune corrélation avec le code ou les tests ici : c’est la phase suivante du chantier.');

report.repository = {
  entities: repository.entities.length,
  byKind,
  links: repository.links.length,
  versions: Object.fromEntries(
    repository.entities.map((entity) => [entity.externalId ?? entity.id, entity.version]),
  ),
};
if (values.json) console.log(JSON.stringify(report));
