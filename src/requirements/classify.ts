import { cleanText, type Block, type ExtractedDocument } from './document.js';
import { fingerprint } from './fingerprint.js';
import type {
  Confidence,
  CriterionStructure,
  ExtractedItem,
  ImportIssue,
  ItemKind,
  SourceLocation,
  SourceReference,
} from './model.js';

/**
 * LA NORMALISATION : des blocs d'un document extrait vers des candidats (exigence, règle d'affaires,
 * critère d'acceptation, information, non classé). Aucune IA : des règles explicites, et chaque
 * candidat porte les raisons de sa classification. Un paragraphe n'est pas une exigence par défaut.
 *
 * Classes de confiance (des classes de règles, pas des probabilités) :
 *   HIGH            identifiant explicite d'un préfixe connu (REQ-12, RG-3, CA-7), ou ligne d'un
 *                   tableau dont une colonne porte l'identifiant ;
 *   MEDIUM          section qui nomme le type (« Exigences », « Règles d'affaires », « Critères
 *                   d'acceptation »), forme Étant donné / Quand / Alors, ligne de tableau sans
 *                   identifiant, ou identifiant dont le préfixe contredit la section ;
 *   LOW             verbe normatif seul (« doit », « must », « shall ») hors de toute section typée ;
 *   NOT_EVALUATED   information : aucun signal (rien n'est proposé à la publication).
 * Un tableau sans en-tête reconnu donne des candidats UNCLASSIFIED (LOW) et un avertissement.
 */
export type ClassifiableKind = Exclude<ItemKind, 'INFORMATION' | 'UNCLASSIFIED'>;

/** Les préfixes d'identifiant reconnus par défaut (Q3 : un profil d'importation les remplace). */
export const DEFAULT_ID_PREFIXES: Record<ClassifiableKind, string[]> = {
  REQUIREMENT: ['REQ', 'EXG', 'EF', 'ENF', 'NFR', 'FR', 'US', 'SPEC'],
  BUSINESS_RULE: ['RG', 'RM', 'RA', 'BR', 'RULE'],
  ACCEPTANCE_CRITERION: ['CA', 'AC'],
};

/** Les colonnes d'un tableau d'exigences, et les en-têtes qui les désignent (comparés sans accents ni casse). */
export const TABLE_FIELDS = {
  id: ['id', 'identifiant', 'ref', 'reference', 'no', 'numero', 'code', 'cle', 'key'],
  title: ['titre', 'title', 'nom', 'name', 'intitule', 'libelle', 'resume', 'summary'],
  description: ['description', 'exigence', 'requirement', 'enonce', 'texte', 'text', 'detail'],
  type: ['type', 'categorie', 'category', 'nature'],
  priority: ['priorite', 'priority', 'criticite', 'criticality', 'importance'],
  status: ['statut', 'status', 'etat', 'state'],
  rule: ['regle', 'regle metier', 'regle d affaires', 'regle de gestion', 'business rule', 'rule'],
  criterion: [
    'critere',
    'critere d acceptation',
    'criteres d acceptation',
    'acceptance criteria',
    'acceptance criterion',
  ],
} as const;
export type TableField = keyof typeof TABLE_FIELDS;

export interface ClassifyOptions {
  idPrefixes?: Partial<Record<ClassifiableKind, string[]>>;
  /** Correspondance imposée des colonnes (profil d'importation) : champ → en-tête exact. */
  columns?: Partial<Record<TableField, string>>;
  /** Plafond de candidats (au-delà : un problème, le reste n'est pas lu). */
  maxItems?: number;
}

const MAX_TEXT = 20_000;
const MAX_TITLE = 140;

const plain = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const SECTION_KINDS: [RegExp, ClassifiableKind, string][] = [
  [
    /\bcriteres? d acceptation\b|\bacceptance criteri(a|on)\b/,
    'ACCEPTANCE_CRITERION',
    'critères d’acceptation',
  ],
  [/\bregles?( d affaires| metier| de gestion)?\b|\bbusiness rules?\b/, 'BUSINESS_RULE', 'règles d’affaires'],
  [/\bexigences?\b|\brequirements?\b/, 'REQUIREMENT', 'exigences'],
];
const NON_FUNCTIONAL = /\bnon fonctionnel(le)?s?\b|\bnon functional\b/;

const NORMATIVE =
  /\b(doit|doivent|devra|devront|ne doit pas|ne doivent pas|est tenu|must|shall|should|is required to|must not|shall not)\b/i;
const GHERKIN_GIVEN = /^(etant donne|etant donnes|etant donnee|soit|given)\b/;
const GHERKIN_WHEN = /\b(quand|lorsque|when)\b/;
const GHERKIN_THEN = /\b(alors|then)\b/;
const NEGATIVE =
  /\b(ne (doit|doivent|peut|peuvent) pas|refus|refuse|rejet|rejete|erreur|invalide|interdit|must not|shall not|cannot|error|rejected|denied|invalid)\b/i;

interface Context {
  document: ExtractedDocument;
  importedAt: string;
  prefixes: Record<ClassifiableKind, string[]>;
  idPattern: RegExp;
  options: ClassifyOptions;
  items: ExtractedItem[];
  issues: ImportIssue[];
  /** Le dernier identifiant vu par type, dans la section courante (parent proposé). */
  lastId: Partial<Record<ClassifiableKind, string>>;
  sectionKind?: { kind: ClassifiableKind; label: string; nonFunctional: boolean };
  /** Les titres qui englobent le bloc courant (section des lieux). */
  path: string[];
  levels: number[];
  stopped: boolean;
}

export function classify(
  document: ExtractedDocument,
  importedAt: string,
  options: ClassifyOptions = {},
): { items: ExtractedItem[]; issues: ImportIssue[] } {
  const prefixes: Record<ClassifiableKind, string[]> = {
    REQUIREMENT: options.idPrefixes?.REQUIREMENT ?? DEFAULT_ID_PREFIXES.REQUIREMENT,
    BUSINESS_RULE: options.idPrefixes?.BUSINESS_RULE ?? DEFAULT_ID_PREFIXES.BUSINESS_RULE,
    ACCEPTANCE_CRITERION:
      options.idPrefixes?.ACCEPTANCE_CRITERION ?? DEFAULT_ID_PREFIXES.ACCEPTANCE_CRITERION,
  };
  const all = [...prefixes.REQUIREMENT, ...prefixes.BUSINESS_RULE, ...prefixes.ACCEPTANCE_CRITERION]
    .map((prefix) => prefix.replace(/[^A-Za-z0-9]/g, ''))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const context: Context = {
    document,
    importedAt,
    prefixes,
    idPattern: new RegExp(`\\b(${all.join('|')})[-_.]?(\\d+(?:[.-]\\d+)*)\\b`),
    options,
    items: [],
    issues: [],
    lastId: {},
    path: [],
    levels: [],
    stopped: false,
  };
  const blocks = document.blocks;
  for (let index = 0; index < blocks.length && !context.stopped; index += 1) {
    const block = blocks[index] as Block;
    if (block.type === 'heading') {
      index = heading(context, blocks, index);
      continue;
    }
    if (block.type === 'paragraph') candidate(context, block.text, block.location);
    else if (block.type === 'list')
      block.items.forEach((item, position) => {
        candidate(context, item, { ...block.location, row: position + 1 });
      });
    else table(context, block);
  }
  findDuplicateIds(context);
  return { items: context.items, issues: context.issues };
}

/** Un titre : il change la section ; un titre qui porte un identifiant ouvre un candidat dont le corps suit. */
function heading(context: Context, blocks: Block[], index: number): number {
  const block = blocks[index] as Extract<Block, { type: 'heading' }>;
  const text = cleanText(block.text);
  while (context.levels.length > 0 && (context.levels.at(-1) ?? 0) >= block.level) {
    context.levels.pop();
    context.path.pop();
  }
  context.levels.push(block.level);
  context.path.push(text);
  const id = idOf(context, text);
  const detected = SECTION_KINDS.find(([pattern]) => pattern.test(plain(text)));
  if (detected) {
    context.sectionKind = {
      kind: detected[1],
      label: detected[2],
      nonFunctional: NON_FUNCTIONAL.test(plain(text)),
    };
    context.lastId = {};
  } else if (!id) {
    // Un titre neutre referme la section typée de même niveau ou plus haut (rien n'est deviné au-delà).
    context.sectionKind = undefined;
  }
  if (!id) return index;
  // Le corps : les paragraphes et listes jusqu'au titre suivant.
  const body: string[] = [];
  let next = index + 1;
  for (; next < blocks.length; next += 1) {
    const following = blocks[next] as Block;
    if (following.type === 'heading' || following.type === 'table') break;
    if (following.type === 'paragraph') {
      if (idOf(context, following.text)) break;
      body.push(cleanText(following.text));
    } else body.push(...following.items.map(cleanText));
  }
  const title = stripId(text, id.raw);
  push(context, {
    kind: id.kind,
    confidence: 'HIGH',
    reasons: [`identifiant explicite ${id.raw} dans un titre`],
    externalId: id.raw,
    title: title || id.raw,
    description: body.join('\n') || title,
    attributes: {},
    location: block.location,
    text: `${text}\n${body.join('\n')}`,
  });
  return next - 1;
}

function candidate(context: Context, raw: string, location: SourceLocation): void {
  const text = cleanText(raw);
  if (!text) return;
  const id = idOf(context, text);
  const lower = plain(text);
  const reasons: string[] = [];
  let kind: ItemKind;
  let confidence: Confidence;
  const gherkin = GHERKIN_GIVEN.test(lower) || (GHERKIN_WHEN.test(lower) && GHERKIN_THEN.test(lower));
  const section = context.sectionKind;
  if (id) {
    kind = id.kind;
    confidence = 'HIGH';
    reasons.push(`identifiant explicite ${id.raw}`);
    if (section && section.kind !== id.kind) {
      confidence = 'MEDIUM';
      reasons.push(`le préfixe contredit la section « ${section.label} » : à vérifier`);
    }
  } else if (gherkin) {
    kind = 'ACCEPTANCE_CRITERION';
    confidence = 'MEDIUM';
    reasons.push('forme Étant donné / Quand / Alors');
  } else if (section) {
    kind = section.kind;
    confidence = 'MEDIUM';
    reasons.push(`dans la section « ${section.label} »`);
  } else if (NORMATIVE.test(text)) {
    kind = 'REQUIREMENT';
    confidence = 'LOW';
    reasons.push(
      `verbe normatif « ${(NORMATIVE.exec(text)?.[0] ?? '').toLowerCase()} » sans identifiant ni section`,
    );
  } else {
    kind = 'INFORMATION';
    confidence = 'NOT_EVALUATED';
    reasons.push('aucun identifiant, aucune section typée, aucun verbe normatif');
  }
  const title = id ? stripId(text, id.raw) : text;
  push(context, {
    kind,
    confidence,
    reasons,
    ...(id ? { externalId: id.raw } : {}),
    title: firstSentence(title || text),
    description: id ? title || text : text,
    attributes: {},
    location,
    text,
    nonFunctional: section?.nonFunctional ?? false,
  });
}

function table(context: Context, block: Extract<Block, { type: 'table' }>): void {
  const mapping = mapColumns(block.header, context.options.columns);
  const mapped = mapping.id !== undefined || mapping.description !== undefined || mapping.title !== undefined;
  if (!mapped) {
    context.issues.push({
      severity: 'WARNING',
      code: 'TABLE_NOT_MAPPED',
      message: `table without a recognised header (${block.header.join(' | ') || 'no header'}): its rows are proposed as unclassified`,
      location: block.location,
    });
  }
  block.rows.forEach((row, position) => {
    const location: SourceLocation = {
      ...block.location,
      row: position + 1,
      ...(block.cells?.[position]?.[0] ? { cell: block.cells[position][0] } : {}),
    };
    const cell = (field: TableField): string => {
      const column = mapping[field];
      return column === undefined ? '' : cleanText(row[column] ?? '');
    };
    const text = row.map(cleanText).filter(Boolean).join(' — ');
    if (!text) return;
    if (!mapped) {
      push(context, {
        kind: NORMATIVE.test(text) ? 'UNCLASSIFIED' : 'INFORMATION',
        confidence: NORMATIVE.test(text) ? 'LOW' : 'NOT_EVALUATED',
        reasons: ['ligne d’un tableau sans en-tête reconnu'],
        title: firstSentence(text),
        description: text,
        attributes: {},
        location,
        text,
      });
      return;
    }
    const rawId = cell('id');
    const id = rawId ? idOf(context, rawId) : undefined;
    const typeText = plain(cell('type'));
    const reasons: string[] = [];
    let kind: ClassifiableKind = 'REQUIREMENT';
    if (/regle|rule/.test(typeText)) kind = 'BUSINESS_RULE';
    else if (/critere|criteri/.test(typeText)) kind = 'ACCEPTANCE_CRITERION';
    else if (id) kind = id.kind;
    else if (context.sectionKind) kind = context.sectionKind.kind;
    if (typeText) reasons.push(`colonne type « ${cell('type')} »`);
    const externalId = rawId || undefined;
    const confidence: Confidence = externalId ? 'HIGH' : 'MEDIUM';
    reasons.push(
      externalId
        ? `colonne identifiant « ${externalId} »`
        : 'ligne d’un tableau d’exigences sans identifiant',
    );
    const description = cell('description') || cell('title') || text;
    const attributes: Record<string, string> = {};
    for (const field of ['priority', 'status', 'type'] as const)
      if (cell(field)) attributes[field] = cell(field);
    push(context, {
      kind,
      confidence,
      reasons,
      ...(externalId ? { externalId } : {}),
      title: firstSentence(cell('title') || description),
      description,
      attributes,
      location,
      text,
      nonFunctional:
        /non fonctionnel|non functional|nfr/.test(typeText) || (context.sectionKind?.nonFunctional ?? false),
    });
    // Une règle ou un critère écrit dans la même ligne : un candidat de plus, rattaché à la ligne.
    for (const [field, childKind] of [
      ['rule', 'BUSINESS_RULE'],
      ['criterion', 'ACCEPTANCE_CRITERION'],
    ] as const) {
      const childText = cell(field);
      if (!childText) continue;
      push(context, {
        kind: childKind,
        confidence: 'MEDIUM',
        reasons: [
          `colonne « ${block.header[mapping[field] ?? 0] ?? field} » de la ligne ${externalId ?? String(position + 1)}`,
        ],
        title: firstSentence(childText),
        description: childText,
        attributes: {},
        location,
        text: childText,
        ...(externalId ? { parent: externalId } : {}),
      });
    }
  });
}

/** La colonne de chaque champ : celle du profil d'abord, sinon l'en-tête reconnu. */
export function mapColumns(
  header: string[],
  imposed: Partial<Record<TableField, string>> = {},
): Partial<Record<TableField, number>> {
  const normalized = header.map(plain);
  const mapping: Partial<Record<TableField, number>> = {};
  const taken = new Set<number>();
  for (const field of Object.keys(TABLE_FIELDS) as TableField[]) {
    const wanted = imposed[field];
    const index =
      wanted !== undefined
        ? header.findIndex((name) => cleanText(name) === cleanText(wanted))
        : normalized.findIndex(
            (name, position) =>
              !taken.has(position) && (TABLE_FIELDS[field] as readonly string[]).includes(name),
          );
    if (index >= 0) {
      mapping[field] = index;
      taken.add(index);
    }
  }
  return mapping;
}

interface Draft {
  kind: ItemKind;
  confidence: Confidence;
  reasons: string[];
  externalId?: string;
  title: string;
  description: string;
  attributes: Record<string, string>;
  location: SourceLocation;
  /** Le texte source complet (empreinte). */
  text: string;
  nonFunctional?: boolean;
  /** Parent imposé (ligne de tableau). */
  parent?: string;
}

function push(context: Context, draft: Draft): void {
  const limit = context.options.maxItems ?? 5000;
  if (context.items.length >= limit) {
    context.stopped = true;
    context.issues.push({
      severity: 'ERROR',
      code: 'TOO_MANY_ITEMS',
      message: `more than ${String(limit)} candidates: the rest of the document was not read`,
      location: draft.location,
    });
    return;
  }
  let description = draft.description;
  if (description.length > MAX_TEXT) {
    description = description.slice(0, MAX_TEXT);
    context.issues.push({
      severity: 'WARNING',
      code: 'TEXT_TRUNCATED',
      message: `text longer than ${String(MAX_TEXT)} characters, truncated`,
      location: draft.location,
    });
  }
  const doc = context.document.source;
  const source: SourceReference = {
    kind: doc.kind,
    sourceId: doc.sourceId,
    ...(doc.uri ? { uri: doc.uri } : {}),
    title: doc.title,
    location:
      draft.location.section || context.path.length === 0
        ? draft.location
        : { ...draft.location, section: [...context.path] },
    ...(doc.version ? { version: doc.version } : {}),
    ...(doc.modifiedAt ? { modifiedAt: doc.modifiedAt } : {}),
    importedAt: context.importedAt,
    fingerprint: fingerprint(draft.text),
    ...(doc.documentFingerprint ? { documentFingerprint: doc.documentFingerprint } : {}),
  };
  const attributes = { ...draft.attributes };
  if (draft.kind === 'REQUIREMENT' && draft.nonFunctional && !attributes.type)
    attributes.type = 'NON_FUNCTIONAL';
  const parent =
    draft.parent ??
    (draft.kind === 'BUSINESS_RULE'
      ? context.lastId.REQUIREMENT
      : draft.kind === 'ACCEPTANCE_CRITERION'
        ? (context.lastId.BUSINESS_RULE ?? context.lastId.REQUIREMENT)
        : undefined);
  const item: ExtractedItem = {
    id: `itm_${String(context.items.length + 1).padStart(4, '0')}`,
    kind: draft.kind,
    confidence: draft.confidence,
    reasons: draft.reasons,
    ...(draft.externalId ? { externalId: draft.externalId } : {}),
    title: draft.title.slice(0, MAX_TITLE),
    description,
    attributes,
    ...(draft.kind === 'ACCEPTANCE_CRITERION' ? { criterion: criterionOf(draft.text) } : {}),
    ...(parent && parent !== draft.externalId ? { parentExternalId: parent } : {}),
    source,
    duplicate: { status: 'NEW' },
  };
  context.items.push(item);
  if (draft.externalId && (draft.kind === 'REQUIREMENT' || draft.kind === 'BUSINESS_RULE')) {
    context.lastId[draft.kind] = draft.externalId;
    if (draft.kind === 'REQUIREMENT') delete context.lastId.BUSINESS_RULE;
  }
}

/** Un identifiant dans le texte, et le type que son préfixe désigne. */
function idOf(context: Context, text: string): { raw: string; kind: ClassifiableKind } | undefined {
  const match = context.idPattern.exec(text);
  if (!match) return undefined;
  const prefix = match[1] ?? '';
  const kind = (Object.keys(context.prefixes) as ClassifiableKind[]).find((name) =>
    context.prefixes[name].map((value) => value.replace(/[^A-Za-z0-9]/g, '')).includes(prefix),
  );
  return kind ? { raw: match[0], kind } : undefined;
}

function stripId(text: string, id: string): string {
  return cleanText(text.replace(id, '').replace(/^[\s:;,.–—-]+/, ''));
}

function firstSentence(text: string): string {
  const cut = /^(.{12,}?)(?:[.!?](?:\s|$)| — | : )/.exec(text);
  return cleanText((cut?.[1] ?? text).slice(0, MAX_TITLE));
}

/** La structure Étant donné / Quand / Alors d'un critère, quand le texte l'a ; sinon tout va dans « then ». */
export function criterionOf(text: string): CriterionStructure {
  const parts: CriterionStructure = { given: [], when: [], then: [], negative: NEGATIVE.test(text) };
  // Une frontière de mot Unicode : `\b` ne vaut que pour l'ASCII (« Étant » n'y commencerait pas).
  const pattern =
    /(?<!\p{L})(Étant donnée?s?|Etant donnée?s?|Soit|Given|Quand|Lorsque|When|Alors|Then|Et|And|Mais|But)(?!\p{L})/giu;
  const marks = [...text.matchAll(pattern)];
  if (
    marks.length === 0 ||
    (!GHERKIN_GIVEN.test(plain(text)) && !(GHERKIN_WHEN.test(plain(text)) && GHERKIN_THEN.test(plain(text))))
  ) {
    parts.then.push(cleanText(text));
    return parts;
  }
  let current: keyof Omit<CriterionStructure, 'negative'> = 'given';
  marks.forEach((mark, position) => {
    const keyword = plain(mark[0]);
    if (/^(etant donne|etant donnee|etant donnes|etant donnees|soit|given)$/.test(keyword)) current = 'given';
    else if (/^(quand|lorsque|when)$/.test(keyword)) current = 'when';
    else if (/^(alors|then)$/.test(keyword)) current = 'then';
    const start = mark.index + mark[0].length;
    const end = marks[position + 1]?.index ?? text.length;
    const segment = cleanText(text.slice(start, end).replace(/^[\s,:]+|[\s,]+$/g, ''));
    if (segment) parts[current].push(segment);
  });
  return parts;
}

/** Deux candidats du même lot avec le même identifiant : signalé (le document se contredit peut-être). */
function findDuplicateIds(context: Context): void {
  const seen = new Map<string, ExtractedItem>();
  for (const item of context.items) {
    if (!item.externalId) continue;
    const first = seen.get(item.externalId);
    if (first && first.kind === item.kind)
      context.issues.push({
        severity: 'WARNING',
        code: 'DUPLICATE_ID_IN_SOURCE',
        message: `${item.externalId} appears more than once in this source (blocks ${String(first.source.location.block)} and ${String(item.source.location.block)})`,
        location: item.source.location,
      });
    else seen.set(item.externalId, item);
  }
}
