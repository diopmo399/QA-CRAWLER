import { AstBuilder, dialects, GherkinClassicTokenMatcher, Parser } from '@cucumber/gherkin';
import { IdGenerator, type GherkinDocument, type Step } from '@cucumber/messages';
import type { GeneratedFileDiagnostic } from '../core/contracts.js';

/**
 * LE FICHIER .feature, VU COMME DES SCÉNARIOS ET DES ÉTAPES : lu par le parseur Gherkin officiel
 * (`@cucumber/gherkin`, celui du moteur), modifié LIGNE PAR LIGNE. Une étape est un bloc : les
 * commentaires juste au-dessus (provenance), la phrase, et sa table ou son texte. Changer une phrase
 * ne réécrit que sa ligne ; déplacer, dupliquer ou retirer une étape ne touche que son bloc. Tout le
 * reste (commentaires, tags, descriptions, exemples, langue) est gardé tel quel.
 */

export type GherkinKeywordType = 'Context' | 'Action' | 'Outcome' | 'Conjunction' | 'Unknown';

export interface GherkinStepNode {
  /** Rang de l'étape dans son scénario (0…). */
  index: number;
  keyword: string;
  keywordType: GherkinKeywordType;
  text: string;
  /** Ligne de la phrase (1…), et la dernière ligne de sa table ou de son texte. */
  line: number;
  endLine: number;
  /** Première ligne du bloc (les commentaires de provenance juste au-dessus). */
  blockStart: number;
  provenance?: string;
  argument?: 'table' | 'docString';
}

export interface GherkinScenarioNode {
  kind: 'Background' | 'Scenario' | 'Scenario Outline';
  keyword: string;
  name: string;
  line: number;
  rule?: string;
  tags: string[];
  steps: GherkinStepNode[];
  examples: number;
}

export interface GherkinOutline {
  language: string;
  feature?: { keyword: string; name: string; line: number };
  scenarios: GherkinScenarioNode[];
  /** Les mots-clés d'étape de la langue du fichier (sans « * »), pour l'inspecteur. */
  keywords: { given: string[]; when: string[]; then: string[]; and: string[]; but: string[] };
}

export type GherkinParse =
  { ok: true; outline: GherkinOutline } | { ok: false; diagnostics: GeneratedFileDiagnostic[] };

export type GherkinEdit =
  | { op: 'update'; scenario: number; index: number; keyword?: string; text?: string }
  | { op: 'add'; scenario: number; after: number; keyword: string; text: string }
  | { op: 'duplicate'; scenario: number; index: number }
  | { op: 'remove'; scenario: number; index: number }
  | { op: 'move'; scenario: number; from: number; to: number };

export type GherkinEditResult = { text: string } | { error: string };

function parseDocument(text: string): GherkinDocument | { diagnostics: GeneratedFileDiagnostic[] } {
  const parser = new Parser(new AstBuilder(IdGenerator.incrementing()), new GherkinClassicTokenMatcher());
  try {
    return parser.parse(text);
  } catch (error) {
    const errors = (error as { errors?: { message: string; location?: { line: number; column?: number } }[] })
      .errors ?? [error as { message: string; location?: { line: number; column?: number } }];
    return {
      diagnostics: errors.map((entry) => ({
        severity: 'error' as const,
        category: 'syntax' as const,
        message: entry.message.replace(/^\(\d+:\d+\):\s*/, ''),
        ...(entry.location?.line ? { line: entry.location.line } : {}),
        ...(entry.location?.column ? { column: entry.location.column } : {}),
        source: 'gherkin',
      })),
    };
  }
}

function stepEnd(step: Step, lines: readonly string[]): number {
  if (step.dataTable && step.dataTable.rows.length > 0)
    return step.dataTable.rows[step.dataTable.rows.length - 1]?.location.line ?? step.location.line;
  if (step.docString) {
    const start = step.docString.location.line;
    const fence = step.docString.delimiter;
    for (let line = start + 1; line <= lines.length; line += 1)
      if ((lines[line - 1] ?? '').trim().startsWith(fence)) return line;
  }
  return step.location.line;
}

/** Les commentaires collés au-dessus d'une ligne (la provenance de l'étape). */
function commentsAbove(lines: readonly string[], line: number, floor: number): number {
  let start = line;
  while (
    start - 1 > floor &&
    /^\s*#/.test(lines[start - 2] ?? '') &&
    !/^\s*#\s*language\s*:/.test(lines[start - 2] ?? '')
  )
    start -= 1;
  return start;
}

const dialectKeywords = (language: string): GherkinOutline['keywords'] => {
  const dialect = dialects[language] ?? dialects.en;
  const clean = (list: readonly string[] | undefined): string[] =>
    (list ?? []).filter((keyword) => keyword.trim() !== '*');
  return {
    given: clean(dialect?.given),
    when: clean(dialect?.when),
    then: clean(dialect?.then),
    and: clean(dialect?.and),
    but: clean(dialect?.but),
  };
};

export function parseFeature(text: string): GherkinParse {
  const document = parseDocument(text);
  if ('diagnostics' in document) return { ok: false, diagnostics: document.diagnostics };
  const lines = text.split('\n');
  const feature = document.feature;
  const language = feature?.language ?? 'en';
  const scenarios: GherkinScenarioNode[] = [];
  const visit = (children: NonNullable<typeof feature>['children'], rule?: string): void => {
    for (const child of children) {
      if (child.rule) {
        visit(child.rule.children, child.rule.name);
        continue;
      }
      const node = child.background ?? child.scenario;
      if (!node) continue;
      let floor = node.location.line;
      const steps = node.steps.map((step, index): GherkinStepNode => {
        const blockStart = commentsAbove(lines, step.location.line, floor);
        const endLine = stepEnd(step, lines);
        floor = endLine;
        const provenance = lines
          .slice(blockStart - 1, step.location.line - 1)
          .map((entry) => entry.trim().replace(/^#\s?/, ''))
          .join('\n');
        return {
          index,
          keyword: step.keyword,
          keywordType: step.keywordType ?? 'Unknown',
          text: step.text,
          line: step.location.line,
          endLine,
          blockStart,
          ...(provenance ? { provenance } : {}),
          ...(step.dataTable
            ? { argument: 'table' as const }
            : step.docString
              ? { argument: 'docString' as const }
              : {}),
        };
      });
      const scenario = child.scenario;
      scenarios.push({
        kind: child.background
          ? 'Background'
          : scenario && scenario.examples.length > 0
            ? 'Scenario Outline'
            : 'Scenario',
        keyword: node.keyword,
        name: node.name,
        line: node.location.line,
        ...(rule ? { rule } : {}),
        tags: scenario ? scenario.tags.map((tag) => tag.name) : [],
        steps,
        examples: scenario ? scenario.examples.length : 0,
      });
    }
  };
  if (feature) visit(feature.children);
  return {
    ok: true,
    outline: {
      language,
      ...(feature
        ? { feature: { keyword: feature.keyword, name: feature.name, line: feature.location.line } }
        : {}),
      scenarios,
      keywords: dialectKeywords(language),
    },
  };
}

const allKeywords = (keywords: GherkinOutline['keywords']): string[] => [
  ...keywords.given,
  ...keywords.when,
  ...keywords.then,
  ...keywords.and,
  ...keywords.but,
];

/** Une édition du .feature, par lignes : le reste du fichier ne change pas. */
export function editFeature(text: string, edit: GherkinEdit): GherkinEditResult {
  const parsed = parseFeature(text);
  if (!parsed.ok) return { error: 'the feature does not parse: fix it in the source view first' };
  const scenario = parsed.outline.scenarios[edit.scenario];
  if (!scenario) return { error: 'no such scenario' };
  const lines = text.split('\n');
  const step = (index: number): GherkinStepNode | undefined => scenario.steps[index];
  const keywordOk = (keyword: string): boolean => allKeywords(parsed.outline.keywords).includes(keyword);
  const sentence = (value: string): string | undefined => {
    const clean = value.replace(/\r?\n/g, ' ').trim();
    return clean === '' ? undefined : clean;
  };
  switch (edit.op) {
    case 'update': {
      const target = step(edit.index);
      if (!target) return { error: 'no such step' };
      const keyword = edit.keyword ?? target.keyword;
      if (edit.keyword !== undefined && !keywordOk(keyword))
        return { error: `“${keyword.trim()}” is not a step keyword of this language` };
      const content = edit.text !== undefined ? sentence(edit.text) : target.text;
      if (content === undefined) return { error: 'a step needs a sentence' };
      const current = lines[target.line - 1] ?? '';
      const indent = /^\s*/.exec(current)?.[0] ?? '';
      lines[target.line - 1] = `${indent}${keyword}${content}`;
      return { text: lines.join('\n') };
    }
    case 'add': {
      if (!keywordOk(edit.keyword))
        return { error: `“${edit.keyword.trim()}” is not a step keyword of this language` };
      const content = sentence(edit.text);
      if (content === undefined) return { error: 'a step needs a sentence' };
      const reference = step(edit.after) ?? scenario.steps[scenario.steps.length - 1];
      const at = reference ? reference.endLine : scenario.line;
      const indent = reference
        ? (/^\s*/.exec(lines[reference.line - 1] ?? '')?.[0] ?? '    ')
        : `${/^\s*/.exec(lines[scenario.line - 1] ?? '')?.[0] ?? ''}  `;
      lines.splice(
        edit.after < 0 && scenario.steps[0] ? scenario.steps[0].blockStart - 1 : at,
        0,
        `${indent}${edit.keyword}${content}`,
      );
      return { text: lines.join('\n') };
    }
    case 'duplicate': {
      const target = step(edit.index);
      if (!target) return { error: 'no such step' };
      // La phrase et sa table, sans le commentaire de provenance (la copie n'a pas été enregistrée).
      lines.splice(target.endLine, 0, ...lines.slice(target.line - 1, target.endLine));
      return { text: lines.join('\n') };
    }
    case 'remove': {
      const target = step(edit.index);
      if (!target) return { error: 'no such step' };
      if (scenario.steps.length === 1) return { error: 'a scenario keeps at least one step' };
      lines.splice(target.blockStart - 1, target.endLine - target.blockStart + 1);
      return { text: lines.join('\n') };
    }
    case 'move': {
      const from = step(edit.from);
      if (!from || !step(edit.to)) return { error: 'no such step' };
      if (edit.from === edit.to) return { text };
      const blocks = scenario.steps.map((entry) => lines.slice(entry.blockStart - 1, entry.endLine));
      const [moved] = blocks.splice(edit.from, 1);
      blocks.splice(edit.to, 0, moved ?? []);
      const first = scenario.steps[0];
      const last = scenario.steps[scenario.steps.length - 1];
      if (!first || !last) return { error: 'no such step' };
      // Les lignes entre deux blocs (vides) restent à leur place : seuls les blocs changent d'ordre.
      const between = scenario.steps
        .slice(1)
        .map((entry, index) => lines.slice(scenario.steps[index]?.endLine ?? 0, entry.blockStart - 1));
      const rebuilt = blocks.flatMap((block, index) => [...block, ...(between[index] ?? [])]);
      lines.splice(first.blockStart - 1, last.endLine - first.blockStart + 1, ...rebuilt);
      return { text: lines.join('\n') };
    }
  }
}
