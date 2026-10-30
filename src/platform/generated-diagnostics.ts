import type * as TS from 'typescript';
import { isMap, isSeq, LineCounter, parseDocument, type Node as YamlNode } from 'yaml';
import { flowSchema } from '../config/flow-schema.js';
import { GherkinStepDictionary } from '../flows/gherkin/gherkin-steps.js';
import type { GeneratedFileDiagnostic } from '../sdk/core/contracts.js';
import type { GeneratedArtifact } from './generation-plan.js';

/**
 * LES DIAGNOSTICS D'UN FICHIER GÉNÉRÉ, LIGNE PAR LIGNE : les mêmes outils que la vérification de la
 * génération (schéma du flow, dictionnaire Gherkin du moteur, compilateur TypeScript en syntaxe seule,
 * `mvn test-compile`), relus pour dire OÙ est chaque problème. Un diagnostic n'est jamais inventé : sans
 * position donnée par l'outil, il n'a pas de ligne ; un outil absent est une information, pas un échec.
 */

const STEP_LINE =
  /^(\s*)(Étant donné qu['’]|Étant donné que|Étant donné|Soit|Quand|Lorsque|Alors|Et que|Et|Mais|Given|When|Then|And|But)\s+(.+)$/;

function withoutTestDataFile(document: unknown): unknown {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return document;
  const { testData, ...rest } = document as { testData?: unknown };
  return typeof testData === 'string' ? rest : document;
}

/** Le nœud YAML le plus profond qui existe sur le chemin d'un problème du schéma. */
function nodeAt(root: unknown, path: readonly PropertyKey[]): YamlNode | undefined {
  let node = root as YamlNode | undefined;
  let found = node;
  for (const key of path) {
    if (isMap(node)) node = node.get(key, true);
    else if (isSeq(node) && typeof key === 'number') node = node.items[key] as YamlNode | undefined;
    else break;
    if (!node) break;
    found = node;
  }
  return found;
}

export function yamlDiagnostics(content: string): GeneratedFileDiagnostic[] {
  const counter = new LineCounter();
  const doc = parseDocument(content, { lineCounter: counter });
  if (doc.errors.length > 0)
    return doc.errors.map((error) => ({
      severity: 'error',
      category: 'syntax',
      message: error.message.split('\n')[0] ?? error.message,
      source: 'yaml',
      ...(error.linePos?.[0] ? { line: error.linePos[0].line, column: error.linePos[0].col } : {}),
    }));
  const parsed = flowSchema.safeParse(withoutTestDataFile(doc.toJS()));
  if (parsed.success) return [];
  return parsed.error.issues.map((issue) => {
    const node = nodeAt(doc.contents, issue.path);
    const offset = node?.range?.[0];
    const position = offset !== undefined ? counter.linePos(offset) : undefined;
    const step =
      issue.path[0] === 'steps' && typeof issue.path[1] === 'number' ? issue.path[1] + 1 : undefined;
    return {
      severity: 'error' as const,
      category: 'schema' as const,
      message: `${issue.path.join('.') || '(flow)'}: ${issue.message}`,
      source: 'flow schema',
      ...(position ? { line: position.line, column: position.col } : {}),
      ...(step ? { step } : {}),
    };
  });
}

export function featureDiagnostics(content: string): GeneratedFileDiagnostic[] {
  const dictionary = new GherkinStepDictionary();
  const diagnostics: GeneratedFileDiagnostic[] = [];
  content.split('\n').forEach((raw, index) => {
    const match = STEP_LINE.exec(raw);
    if (!match?.[3]) return;
    if (!dictionary.translate(match[3]))
      diagnostics.push({
        severity: 'error',
        category: 'references',
        message: `no step definition for: ${raw.trim()}`,
        source: 'gherkin dictionary',
        line: index + 1,
        column: (match[1]?.length ?? 0) + 1,
      });
  });
  return diagnostics;
}

export async function typescriptDiagnostics(content: string): Promise<GeneratedFileDiagnostic[]> {
  let ts: typeof TS;
  try {
    ts = await import('typescript');
  } catch {
    return [
      {
        severity: 'info',
        category: 'static',
        message: 'typescript is not installed: not validated',
        source: 'typescript',
      },
    ];
  }
  const result = ts.transpileModule(content, {
    reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  const source = ts.createSourceFile('test.ts', content, ts.ScriptTarget.ES2022, true);
  return (result.diagnostics ?? []).map((diagnostic) => {
    const position =
      diagnostic.start !== undefined ? source.getLineAndCharacterOfPosition(diagnostic.start) : undefined;
    return {
      severity: 'error' as const,
      category: 'syntax' as const,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
      source: 'typescript (syntax only)',
      ...(position ? { line: position.line + 1, column: position.character + 1 } : {}),
    };
  });
}

/** Les lignes de Maven qui ne disent rien du problème (aide, rappels, séparateurs). */
const MAVEN_NOISE =
  /^(COMPILATION ERROR\b|-> \[Help|\[Help \d|To see the full|Re-run Maven|For more information|BUILD FAILURE|-+$|\d+ errors?$)/;

/**
 * La sortie de `mvn test-compile` → un diagnostic par erreur du compilateur, avec son fichier, sa ligne
 * et sa colonne (`/…/X.java:[12,5] cannot find symbol`). Maven répète chaque erreur (liste du compilateur,
 * puis résumé de l'échec) : elle n'est dite qu'une fois. Les lignes de détail qui suivent (`symbol:`,
 * `location:`…) complètent son message. Sans erreur positionnée (dépendance introuvable…), les lignes
 * restantes sont rendues telles quelles.
 */
export function mavenDiagnostics(messages: readonly string[]): GeneratedFileDiagnostic[] {
  const located: GeneratedFileDiagnostic[] = [];
  const others: string[] = [];
  let last: GeneratedFileDiagnostic | undefined;
  for (const raw of messages) {
    const text = raw.replace(/^\s*\[ERROR\]\s?/, '').trim();
    if (text === '') continue;
    const match = /([^\s[]+\.java):\[(\d+),(\d+)\]\s*(.*)$/.exec(text);
    if (match?.[1]) {
      const file = match[1].replace(/\\/g, '/').replace(/^.*?\/(java\/src\/)/, '$1');
      const line = Number(match[2]);
      const column = Number(match[3]);
      const message = (match[4] ?? '').trim();
      last = located.find(
        (diagnostic) =>
          diagnostic.file === file &&
          diagnostic.line === line &&
          diagnostic.column === column &&
          diagnostic.message.startsWith(message),
      );
      if (!last) {
        last = {
          severity: 'error',
          category: 'compilation',
          message,
          source: 'mvn test-compile',
          file,
          line,
          column,
        };
        located.push(last);
      }
      continue;
    }
    const detail = /^(symbol|location|required|found|reason)\s*:\s*(.*)$/.exec(text);
    if (detail && last) {
      const part = `${detail[1] ?? ''}: ${(detail[2] ?? '').replace(/\s+/g, ' ')}`;
      if (!last.message.includes(part)) last.message += ` — ${part}`;
      continue;
    }
    last = undefined;
    if (!MAVEN_NOISE.test(text) && !others.includes(text)) others.push(text);
  }
  if (located.length > 0) return located;
  return others.slice(0, 5).map((message) => ({
    severity: 'error',
    category: /resolve|dependenc|artifact/i.test(message) ? 'dependencies' : 'compilation',
    message,
    source: 'mvn test-compile',
  }));
}

/**
 * Les diagnostics d'un artefact vérifié (`validateArtifacts`) : relus avec leur position quand l'outil
 * la donne. Le contenu est celui qui a été vérifié.
 */
export async function artifactDiagnostics(artifact: GeneratedArtifact): Promise<GeneratedFileDiagnostic[]> {
  const validation = artifact.validation;
  const unavailable = validation?.messages.filter((message) => message.endsWith('not validated')) ?? [];
  if (unavailable.length > 0)
    return unavailable.map((message) => ({
      severity: 'info',
      category: 'static',
      message,
      source: validation?.method ?? 'check',
    }));
  switch (artifact.format) {
    case 'yaml':
      return yamlDiagnostics(artifact.content);
    case 'gherkin':
      if (artifact.path.endsWith('.feature')) return featureDiagnostics(artifact.content);
      // La mission qui joue le .feature : le chargeur du moteur ne donne pas de position.
      return (validation?.ok ?? true)
        ? []
        : (validation?.messages ?? []).map((message) => ({
            severity: 'error' as const,
            category: /step definition|\.feature/.test(message)
              ? ('references' as const)
              : ('schema' as const),
            message,
            source: 'mission loader',
          }));
    case 'playwright':
      return artifact.path.endsWith('.ts') ? typescriptDiagnostics(artifact.content) : [];
    case 'java':
      return (validation?.ok ?? true) ? [] : mavenDiagnostics(validation?.messages ?? []);
  }
}
