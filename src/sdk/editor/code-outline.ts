/**
 * LE PLAN D'UN TEST EN CODE (Playwright TypeScript, Java JUnit 5) : ses blocs (`test.describe`, classe),
 * ses tests (`test(…)`, méthodes `@Test`) et ses étapes (`// step N`, écrites par le générateur), avec
 * leurs lignes. Une lecture pour naviguer, jamais une édition : le code reste la seule vérité, et
 * aucune vue visuelle ne le remplace (il ne se représente pas sans perte).
 */

export interface CodeOutlineEntry {
  kind: 'suite' | 'test' | 'step' | 'hook';
  label: string;
  line: number;
  /** Les actions et vérifications Playwright comptées dans l'étape ou le test. */
  actions?: number;
}

export type CodeLanguage = 'typescript' | 'java';

const unquote = (value: string): string => value.replace(/^["'`]|["'`]$/g, '');

export function codeOutline(text: string, language: CodeLanguage): CodeOutlineEntry[] {
  const lines = text.split('\n');
  const entries: CodeOutlineEntry[] = [];
  let pendingDisplay: string | undefined;
  let pendingTest = false;
  let current: CodeOutlineEntry | undefined;
  const count = (line: string): void => {
    const actions =
      language === 'typescript'
        ? (line.match(/\bawait\s+(?:page|expect)\b/g) ?? []).length
        : (line.match(/\b(?:page\.|assertThat\()/g) ?? []).length;
    if (actions > 0 && current) current.actions = (current.actions ?? 0) + actions;
  };
  lines.forEach((raw, index) => {
    const line = index + 1;
    const text = raw.trim();
    const step = /^\/\/\s*step\s+(\d+)\b(.*)$/i.exec(text);
    if (step) {
      current = {
        kind: 'step',
        label: `Étape ${step[1] ?? ''}${step[2] ? ` ${step[2].trim()}` : ''}`.trim(),
        line,
        actions: 0,
      };
      entries.push(current);
      return;
    }
    if (language === 'typescript') {
      const suite = /^test\.describe(?:\.\w+)?\(\s*(["'`])(.*?)\1/.exec(text);
      if (suite) {
        entries.push({ kind: 'suite', label: suite[2] ?? '', line });
        current = undefined;
        return;
      }
      const hook = /^test\.(beforeAll|beforeEach|afterAll|afterEach)\(/.exec(text);
      if (hook) {
        current = { kind: 'hook', label: hook[1] ?? '', line, actions: 0 };
        entries.push(current);
        return;
      }
      const test = /^test(?:\.(?:only|skip|fixme))?\(\s*(["'`])(.*?)\1/.exec(text);
      if (test) {
        current = { kind: 'test', label: test[2] ?? '', line, actions: 0 };
        entries.push(current);
        return;
      }
    } else {
      const display = /^@DisplayName\(\s*("(?:[^"\\]|\\.)*")\s*\)/.exec(text);
      if (display?.[1]) pendingDisplay = unquote(display[1]);
      if (/^@(Test|ParameterizedTest|RepeatedTest)\b/.test(text)) pendingTest = true;
      const hook = /^@(BeforeAll|BeforeEach|AfterAll|AfterEach)\b/.exec(text);
      if (hook) {
        current = { kind: 'hook', label: hook[1] ?? '', line, actions: 0 };
        entries.push(current);
        return;
      }
      const type = /^(?:public\s+|final\s+|abstract\s+)*class\s+(\w+)/.exec(text);
      if (type) {
        entries.push({ kind: 'suite', label: pendingDisplay ?? type[1] ?? '', line });
        pendingDisplay = undefined;
        current = undefined;
        return;
      }
      const method = /^(?:public\s+|protected\s+|private\s+)?(?:static\s+)?void\s+(\w+)\s*\(/.exec(text);
      if (method && pendingTest) {
        current = { kind: 'test', label: pendingDisplay ?? method[1] ?? '', line, actions: 0 };
        entries.push(current);
        pendingDisplay = undefined;
        pendingTest = false;
        return;
      }
    }
    count(text);
  });
  return entries;
}
