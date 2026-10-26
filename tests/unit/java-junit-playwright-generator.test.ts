import { describe, expect, it } from 'vitest';
import type { FlowStep } from '../../src/config/flow-schema.js';
import { literalEnvName, type FlowDefinition } from '../../src/platform/flow-steps.js';
import {
  JAVA_GENERATOR_VERSIONS,
  defaultPlaywrightJavaVersion,
  generateJavaJUnitPlaywrightProject,
  javaIdentifier,
  javaLocator,
  javaString,
  javaText,
  javaValue,
} from '../../src/platform/java-junit-playwright-generator.js';
import { flow, step } from '../fixtures/qa-platform-results.js';

/**
 * GÉNÉRATEUR JAVA JUNIT 5 + PLAYWRIGHT JAVA : du modèle des flows à un projet Maven. Ces tests
 * vérifient le code produit (ordre et sens des actions, localisateurs, données du run, assertions,
 * étapes signalées), sa pureté (les flows source ne changent pas) et le projet (pom, support).
 * La compilation et l'exécution réelles sont couvertes par le test d'intégration.
 */
/** Les champs communs d'une étape, tels que le schéma les complète. */
const C: Pick<FlowStep, 'allow' | 'optional'> = { allow: [], optional: false };

const CREATE: FlowDefinition = {
  name: 'create a request',
  description: 'the wizard creates a request and finds it again',
  startAt: '/requests',
  steps: [
    {
      ...C,
      kind: 'click',
      target: { strategy: 'role', role: 'link', name: 'New request' },
      effects: { route: '/requests/new', appears: ['button:Next'] },
    },
    {
      ...C,
      kind: 'fill',
      target: { strategy: 'label', value: 'Title' },
      value: { testData: 'request.title' },
    },
    { ...C, kind: 'fill', target: { strategy: 'css', value: '#notes' }, value: 'a recorded note' },
    { ...C, kind: 'fill', target: { strategy: 'label', value: 'Reference' }, value: { env: 'QA_REFERENCE' } },
    { ...C, kind: 'select', target: { strategy: 'label', value: 'Priority' }, option: 'High' },
    { ...C, kind: 'check', target: { strategy: 'label', value: 'Urgent' } },
    { ...C, kind: 'click', target: { strategy: 'role', role: 'button', name: 'Next', exact: true } },
    { ...C, kind: 'expect', expect: { url: '/requests/new/2', text: 'Step 2' } },
    {
      ...C,
      kind: 'click',
      target: {
        strategy: 'role',
        role: 'cell',
        name: 'Open',
        row: { Title: '${testData:request.title}' },
        rowPick: 'first',
      },
    },
    {
      ...C,
      kind: 'expect',
      expect: {
        visible: { strategy: 'text', value: '${testData:request.title}' },
        hidden: { strategy: 'testId', value: 'spinner' },
        noError: true,
        response: { method: 'GET', url: '/api/requests', status: 200 },
      },
    },
    { ...C, kind: 'screenshot', label: 'request opened' },
    { ...C, kind: 'manual', text: 'check the printed layout' },
    { ...C, kind: 'dragAndDrop', item: 'Attachment', to: { section: 'Documents' } },
  ],
};

const OPTIONS = { baseUrl: 'http://app.test' };

function classOf(flows: readonly FlowDefinition[], className: string): string {
  const project = generateJavaJUnitPlaywrightProject(flows, [], OPTIONS);
  const file = project.files.find((entry) => entry.path.endsWith(`/${className}.java`));
  if (!file)
    throw new Error(`${className} not generated: ${project.files.map((entry) => entry.path).join(', ')}`);
  return file.content;
}

describe('Java JUnit 5 + Playwright generator — building blocks', () => {
  it('derives Java identifiers from flow names', () => {
    expect(javaIdentifier('create a request', 'class', 'Flow')).toBe('CreateARequest');
    expect(javaIdentifier('create a request', 'method', 'run')).toBe('createARequest');
    expect(javaIdentifier('créer une demande', 'class', 'Flow')).toBe('CreerUneDemande');
    expect(javaIdentifier('2e étape', 'class', 'Flow')).toBe('Flow2eEtape');
    expect(javaIdentifier('!!!', 'class', 'Flow')).toBe('Flow');
    expect(javaIdentifier('test', 'method', 'run')).toBe('testFlow');
  });

  it('escapes Java string literals', () => {
    expect(javaString('a "b" \\ c\n\t\u0001')).toBe('"a \\"b\\" \\\\ c\\n\\t\\u0001"');
    expect(javaString('')).toBe('""');
  });

  it('turns run data and environment citations into run-time values', () => {
    expect(javaText('Hello ${testData:request.title} and ${env:QA_REF}!')).toBe(
      '"Hello " + data.value("request.title") + " and " + Env.require("QA_REF") + "!"',
    );
    expect(javaText('plain')).toBe('"plain"');
    expect(javaText('')).toBe('""');
  });

  it('never copies a recorded literal into the test: environment, run data', () => {
    const literal = javaValue('secret-value', 'QA_REPRO_X_STEP_3');
    expect(literal).toBe('Env.require("QA_REPRO_X_STEP_3")');
    expect(literal).not.toContain('secret-value');
    expect(javaValue({ env: 'QA_PASSWORD' }, 'unused')).toBe('Env.require("QA_PASSWORD")');
    expect(javaValue({ testData: 'request.title' }, 'unused')).toBe('data.value("request.title")');
  });

  it('builds Playwright Java locators for every strategy', () => {
    const notes: string[] = [];
    expect(javaLocator({ strategy: 'role', role: 'button', name: 'Next', exact: true }, notes)).toBe(
      'page.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("Next").setExact(true))',
    );
    expect(javaLocator({ strategy: 'role', role: 'link' }, notes)).toBe('page.getByRole(AriaRole.LINK)');
    expect(javaLocator({ strategy: 'label', value: 'Title' }, notes)).toBe('page.getByLabel("Title")');
    expect(javaLocator({ strategy: 'text', value: 'Open', exact: true }, notes)).toBe(
      'page.getByText("Open", new Page.GetByTextOptions().setExact(true))',
    );
    expect(javaLocator({ strategy: 'testId', value: 'save' }, notes)).toBe('page.getByTestId("save")');
    expect(javaLocator({ strategy: 'css', value: '#notes', nth: 2 }, notes)).toBe(
      'page.locator("#notes").nth(2)',
    );
    expect(
      javaLocator(
        {
          strategy: 'role',
          role: 'cell',
          name: 'Open',
          row: { Title: '${testData:request.title}' },
          rowPick: 'first',
        },
        notes,
      ),
    ).toBe(
      'page.getByRole(AriaRole.ROW).filter(new Locator.FilterOptions().setHasText(data.value("request.title"))).first().getByRole(AriaRole.CELL, new Locator.GetByRoleOptions().setName("Open"))',
    );
    expect(notes).toEqual([]);
    expect(javaLocator({ strategy: 'role', role: 'widget', name: 'Go' }, notes)).toBe(
      'page.locator("[role=\\"widget\\"]").filter(new Locator.FilterOptions().setHasText("Go"))',
    );
    expect(notes).toEqual([
      'role "widget" is not an ARIA role known to Playwright Java: a CSS locator [role] is used',
    ]);
  });

  it('aligns the Playwright Java version on the Node Playwright of the project', () => {
    expect(defaultPlaywrightJavaVersion('1.56.1')).toBe('1.56.0');
    expect(defaultPlaywrightJavaVersion('1.60.0-beta')).toBe('1.60.0');
    expect(defaultPlaywrightJavaVersion('garbage')).toBe(JAVA_GENERATOR_VERSIONS.playwright);
    expect(defaultPlaywrightJavaVersion()).toMatch(/^\d+\.\d+\.0$/);
  });
});

describe('Java JUnit 5 + Playwright generator — the project', () => {
  it('writes a Maven project: pom with the verified versions, support classes, one test class per flow', () => {
    const project = generateJavaJUnitPlaywrightProject([CREATE], [], OPTIONS);
    const paths = project.files.map((file) => file.path).sort();
    expect(paths).toEqual([
      '.gitignore',
      'README.md',
      'pom.xml',
      'src/test/java/qa/generated/CreateARequestTest.java',
      'src/test/java/qa/generated/support/Env.java',
      'src/test/java/qa/generated/support/EvidenceExtension.java',
      'src/test/java/qa/generated/support/QaPlaywrightTest.java',
      'src/test/java/qa/generated/support/TestData.java',
    ]);
    const pom = project.files.find((file) => file.path === 'pom.xml')?.content ?? '';
    expect(pom).toContain(`<playwright.version>${JAVA_GENERATOR_VERSIONS.playwright}</playwright.version>`);
    expect(pom).toContain(`<junit.version>${JAVA_GENERATOR_VERSIONS.junit}</junit.version>`);
    expect(pom).toContain(
      `<artifactId>maven-surefire-plugin</artifactId>\n        <version>${JAVA_GENERATOR_VERSIONS.surefire}</version>`,
    );
    expect(pom).toContain(
      `<maven.compiler.release>${JAVA_GENERATOR_VERSIONS.javaRelease}</maven.compiler.release>`,
    );
    expect(project.tests).toEqual([
      expect.objectContaining({
        flow: 'create a request',
        className: 'CreateARequestTest',
        file: 'src/test/java/qa/generated/CreateARequestTest.java',
        steps: 13,
        assertions: 8,
        unsupported: [],
      }),
    ]);
    expect(project.tests[0]?.notes).toEqual([
      'step 10: the response expectation waits for the next matching response (best effort)',
    ]);
    const env = project.files.find((file) => file.path.endsWith('Env.java'))?.content ?? '';
    expect(env).toContain('DEFAULT_BASE_URL = "http://app.test"');
    expect(env).toContain('System.getenv("QA_BASE_URL")');
    const readme = project.files.find((file) => file.path === 'README.md')?.content ?? '';
    expect(readme).toContain('mvn test');
    expect(readme).toContain('| `CreateARequestTest` | create a request | 13 | 8 | none |');
  });

  it('keeps the order and meaning of the recorded actions, with run data reused across steps', () => {
    const content = classOf([CREATE], 'CreateARequestTest');
    const expected = [
      'page.navigate(Env.url("/requests"));',
      'page.getByRole(AriaRole.LINK, new Page.GetByRoleOptions().setName("New request")).first().click();',
      'assertThat(page).hasURL(Pattern.compile("/requests/new"));',
      'assertThat(page.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("Next")).first()).isVisible();',
      'page.getByLabel("Title").first().fill(data.value("request.title"));',
      `page.locator("#notes").fill(Env.require("${literalEnvName(CREATE.name, 3)}"));`,
      'page.getByLabel("Reference").first().fill(Env.require("QA_REFERENCE"));',
      'page.getByLabel("Priority").first().selectOption("High");',
      'page.getByLabel("Urgent").first().check();',
      'page.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("Next").setExact(true)).first().click();',
      'assertThat(page).hasURL(Pattern.compile("/requests/new/2"));',
      'assertThat(page.getByText("Step 2").first()).isVisible();',
      'page.getByRole(AriaRole.ROW).filter(new Locator.FilterOptions().setHasText(data.value("request.title"))).first().getByRole(AriaRole.CELL, new Locator.GetByRoleOptions().setName("Open")).click();',
      'assertThat(page.getByText(data.value("request.title"))).isVisible();',
      'assertThat(page.getByTestId("spinner")).isHidden();',
      '.hasCount(0);',
      'page.waitForResponse(response -> response.url().contains("/api/requests") && response.request().method().equals("GET") && response.status() == 200, () -> {});',
      'evidence("request opened");',
      'manual("check the printed layout");',
      'page.getByText("Attachment").first().dragTo(page.getByText("Documents").first());',
    ];
    let position = -1;
    for (const line of expected) {
      const index = content.indexOf(line, position + 1);
      expect(index, line).toBeGreaterThan(position);
      position = index;
    }
    // La valeur enregistrée ne figure nulle part : elle vient de l'environnement.
    expect(content).not.toContain('a recorded note');
    expect(content).toContain('class CreateARequestTest extends QaPlaywrightTest');
    expect(content).toContain('@DisplayName("the wizard creates a request and finds it again")');
    expect(content).toContain('Run data used: request.title.');
    expect(content).toContain(
      'import static com.microsoft.playwright.assertions.PlaywrightAssertions.assertThat;',
    );
  });

  it('flags the steps Java cannot replay: the test is aborted there, never passed', () => {
    const flow: FlowDefinition = {
      name: 'interpreted steps',
      steps: [
        { ...C, kind: 'auto', sentence: 'open the first request', type: 'Action' },
        { ...C, kind: 'intent', intent: { kind: 'SUBMIT', action: 'submit' } },
        { ...C, kind: 'expect', expect: { text: 'Done' } },
      ],
    };
    const project = generateJavaJUnitPlaywrightProject([flow], [], OPTIONS);
    expect(project.tests[0]?.unsupported).toEqual([
      'step 1: sentence interpreted on the screen at run time by QA-CRAWLER: open the first request',
      'step 2: semantic intent resolved at run time by QA-CRAWLER: {"kind":"SUBMIT","action":"submit"}',
    ]);
    const content = classOf([flow], 'InterpretedStepsTest');
    expect(content).toContain(
      'unsupported("step 1: sentence interpreted on the screen at run time by QA-CRAWLER: open the first request");',
    );
    expect(content).toContain(
      ' * Steps the Java test cannot replay (the test is aborted there, never reported as passed):',
    );
    const support = project.files.find((file) => file.path.endsWith('QaPlaywrightTest.java'))?.content ?? '';
    expect(support).toContain('Assumptions.abort("unsupported by the generated Java test — " + reason);');
    const readme = project.files.find((file) => file.path === 'README.md')?.content ?? '';
    expect(readme).toContain('2 unsupported step(s)');
  });

  it('reports the run status of the flow and its steps as comments, with the checkpoints', () => {
    const report = flow('create a request', [step(1, 'click link "New request"')]);
    const project = generateJavaJUnitPlaywrightProject([CREATE], [report], {
      ...OPTIONS,
      checkpoints: [{ id: 'request-created', status: 'REACHED' }],
    });
    const content = project.files[0]?.content ?? '';
    expect(content).toContain('Run status at generation time: PASSED.');
    expect(content).toContain('// step 1 — click link "New request" (PASSED at run time)');
    expect(content).toContain(' *   - request-created: REACHED');
  });

  it('does not modify the flows and is deterministic', () => {
    const before = JSON.stringify([CREATE]);
    const first = generateJavaJUnitPlaywrightProject([CREATE], [], OPTIONS);
    const second = generateJavaJUnitPlaywrightProject([CREATE], [], OPTIONS);
    expect(JSON.stringify([CREATE])).toBe(before);
    expect(second).toEqual(first);
  });

  it('gives homonymous flows distinct class names and validates the package and versions', () => {
    const project = generateJavaJUnitPlaywrightProject(
      [
        { name: 'open file', steps: [{ ...C, kind: 'expect', expect: { text: 'a' } }] },
        { name: 'Open-File', steps: [{ ...C, kind: 'expect', expect: { text: 'b' } }] },
      ],
      [],
      { ...OPTIONS, packageName: 'com.example.qa', versions: { playwright: '1.99.0' } },
    );
    expect(project.tests.map((test) => test.className)).toEqual(['OpenFileTest', 'OpenFile2Test']);
    expect(project.files.map((file) => file.path)).toContain(
      'src/test/java/com/example/qa/OpenFile2Test.java',
    );
    expect(project.files.find((file) => file.path === 'pom.xml')?.content).toContain(
      '<playwright.version>1.99.0</playwright.version>',
    );
    expect(project.files.find((file) => file.path === 'pom.xml')?.content).toContain(
      '<groupId>com.example.qa</groupId>',
    );
    expect(() =>
      generateJavaJUnitPlaywrightProject([], [], { ...OPTIONS, packageName: 'Not.Valid' }),
    ).toThrow('invalid Java package name "Not.Valid"');
  });
});
