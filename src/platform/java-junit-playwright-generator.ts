import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { FlowStep, FlowTarget, FlowValue } from '../config/flow-schema.js';
import type { FlowRunReport } from '../model/flow-run.js';
import { literalEnvName, testDataKeysOf, type FlowDefinition } from './flow-steps.js';

/**
 * JAVA JUNIT 5 + PLAYWRIGHT JAVA GENERATOR : d'un flow (et de ce que son exécution a appris) à un
 * projet Maven exécutable — une classe de test JUnit 5 par flow, pilotée par Playwright Java, avec
 * les mêmes règles que le générateur TypeScript :
 *
 *   - les actions gardent leur ordre et leur sens (clic, saisie, sélection, cases, glisser-déposer) ;
 *   - les localisateurs sont sémantiques d'abord (getByRole, getByLabel, getByText, getByTestId),
 *     CSS en repli, ligne de tableau par son contenu ;
 *   - une donnée de test devient une valeur GÉNÉRÉE par run (TestData), réutilisée entre les
 *     étapes ; une valeur littérale du flow et un secret viennent de l'environnement, jamais du
 *     fichier généré ;
 *   - les attentes (`expect`) et les effets appris (`effects`) deviennent des assertions Playwright ;
 *   - une étape que Java ne peut pas rejouer (phrase interprétée à l'exécution, intention sémantique)
 *     est SIGNALÉE : dans le résumé de génération et dans le test (abandon JUnit, jamais un faux succès).
 *
 * Un adaptateur à part : il ne lit que le modèle des flows et le rapport du run, n'exécute rien sur
 * l'application et n'est importé par aucun moteur. Java et Maven ne sont nécessaires qu'à celui qui
 * exécute le projet généré.
 */

export interface JavaGenerationOptions {
  baseUrl: string;
  /** Paquet Java des classes générées (qa.generated par défaut). */
  packageName?: string;
  /** Versions Maven ; par défaut JAVA_GENERATOR_VERSIONS (playwright : celle du projet si connue). */
  versions?: Partial<JavaGeneratorVersions>;
  /** Les checkpoints sémantiques du run, en commentaire d'intention. */
  checkpoints?: readonly { id: string; status: string }[];
}

export interface JavaGeneratorVersions {
  playwright: string;
  junit: string;
  surefire: string;
  compiler: string;
  javaRelease: string;
}

/** Versions stables vérifiées sur Maven Central (voir docs/JAVA_TEST_GENERATION.md). */
export const JAVA_GENERATOR_VERSIONS: JavaGeneratorVersions = {
  playwright: '1.56.0',
  junit: '5.14.4',
  surefire: '3.5.6',
  compiler: '3.14.1',
  javaRelease: '17',
};

/**
 * La version Playwright Java alignée sur le Playwright Node du projet (même révision de navigateur,
 * donc les navigateurs déjà installés servent) ; la version épinglée quand elle est inconnue.
 */
export function defaultPlaywrightJavaVersion(nodeVersion?: string): string {
  let version = nodeVersion;
  if (version === undefined) {
    try {
      version = (createRequire(import.meta.url)('playwright/package.json') as { version?: string }).version;
    } catch {
      version = undefined;
    }
  }
  const match = version === undefined ? null : /^(\d+)\.(\d+)\.\d+/.exec(version);
  return match ? `${match[1] ?? ''}.${match[2] ?? ''}.0` : JAVA_GENERATOR_VERSIONS.playwright;
}

export interface GeneratedFile {
  /** Chemin relatif à la racine du projet généré. */
  path: string;
  content: string;
}

export interface GeneratedJavaTest {
  flow: string;
  className: string;
  /** Chemin du fichier source, relatif à la racine du projet. */
  file: string;
  steps: number;
  assertions: number;
  /** Les étapes que le test Java ne rejoue pas (signalées, le test s'y abandonne). */
  unsupported: string[];
  /** Ce qui mérite relecture (rôle inconnu, attente réseau au mieux…). */
  notes: string[];
}

export interface GeneratedJavaProject {
  packageName: string;
  versions: JavaGeneratorVersions;
  files: GeneratedFile[];
  tests: GeneratedJavaTest[];
}

const ARIA_ROLES = new Set([
  'alert',
  'alertdialog',
  'application',
  'article',
  'banner',
  'blockquote',
  'button',
  'caption',
  'cell',
  'checkbox',
  'code',
  'columnheader',
  'combobox',
  'complementary',
  'contentinfo',
  'definition',
  'deletion',
  'dialog',
  'directory',
  'document',
  'emphasis',
  'feed',
  'figure',
  'form',
  'generic',
  'grid',
  'gridcell',
  'group',
  'heading',
  'img',
  'insertion',
  'link',
  'list',
  'listbox',
  'listitem',
  'log',
  'main',
  'marquee',
  'math',
  'meter',
  'menu',
  'menubar',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'navigation',
  'none',
  'note',
  'option',
  'paragraph',
  'presentation',
  'progressbar',
  'radio',
  'radiogroup',
  'region',
  'row',
  'rowgroup',
  'rowheader',
  'scrollbar',
  'search',
  'searchbox',
  'separator',
  'slider',
  'spinbutton',
  'status',
  'strong',
  'subscript',
  'superscript',
  'switch',
  'tab',
  'table',
  'tablist',
  'tabpanel',
  'term',
  'textbox',
  'time',
  'timer',
  'toolbar',
  'tooltip',
  'tree',
  'treegrid',
  'treeitem',
]);

const JAVA_KEYWORDS = new Set([
  'abstract',
  'assert',
  'boolean',
  'break',
  'byte',
  'case',
  'catch',
  'char',
  'class',
  'const',
  'continue',
  'default',
  'do',
  'double',
  'else',
  'enum',
  'extends',
  'final',
  'finally',
  'float',
  'for',
  'goto',
  'if',
  'implements',
  'import',
  'instanceof',
  'int',
  'interface',
  'long',
  'native',
  'new',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'short',
  'static',
  'strictfp',
  'super',
  'switch',
  'synchronized',
  'this',
  'throw',
  'throws',
  'transient',
  'try',
  'void',
  'volatile',
  'while',
  'var',
  'record',
  'yield',
  'test',
  'page',
]);

/** Un littéral Java : échappements et caractères de contrôle. Les sources sont en UTF-8. */
export function javaString(text: string): string {
  let out = '"';
  for (const character of text) {
    switch (character) {
      case '\\':
        out += '\\\\';
        break;
      case '"':
        out += '\\"';
        break;
      case '\n':
        out += '\\n';
        break;
      case '\r':
        out += '\\r';
        break;
      case '\t':
        out += '\\t';
        break;
      default: {
        const code = character.codePointAt(0) ?? 0;
        out += code < 0x20 ? `\\u${code.toString(16).padStart(4, '0')}` : character;
      }
    }
  }
  return `${out}"`;
}

/** Un texte du flow en expression Java : les citations ${testData:clé} et ${env:NOM} deviennent des valeurs du run. */
export function javaText(text: string): string {
  const parts: string[] = [];
  const pattern = /\$\{(testData|env):([^}]+)\}/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index;
    if (index > last) parts.push(javaString(text.slice(last, index)));
    parts.push(
      match[1] === 'testData'
        ? `data.value(${javaString(match[2] ?? '')})`
        : `Env.require(${javaString(match[2] ?? '')})`,
    );
    last = index + match[0].length;
  }
  if (last < text.length || parts.length === 0) parts.push(javaString(text.slice(last)));
  return parts.join(' + ');
}

/** Une valeur de saisie : donnée du run, variable d'environnement, ou un littéral remplacé par une variable. */
export function javaValue(value: FlowValue, literalEnv: string): string {
  if (typeof value === 'string') return `Env.require(${javaString(literalEnv)})`;
  if ('env' in value) return `Env.require(${javaString(value.env)})`;
  return `data.value(${javaString(value.testData)})`;
}

const ariaRole = (role: string): string => `AriaRole.${role.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;

/** Le localisateur Playwright Java d'une cible. `notes` reçoit ce qui mérite relecture. */
export function javaLocator(target: FlowTarget, notes: string[], scope = 'page'): string {
  let base = scope;
  if (target.row) {
    const cells = Object.values(target.row)
      .map((value) => `.filter(new Locator.FilterOptions().setHasText(${javaText(value)}))`)
      .join('');
    base = `${scope}.getByRole(AriaRole.ROW)${cells}`;
    if (target.rowPick === 'first') base += '.first()';
    else if (target.rowPick === 'last') base += '.last()';
  }
  const exact = target.exact === true;
  let locator: string;
  switch (target.strategy) {
    case 'role': {
      const role = (target.role ?? 'button').toLowerCase();
      if (!ARIA_ROLES.has(role)) {
        notes.push(
          `role "${role}" is not an ARIA role known to Playwright Java: a CSS locator [role] is used`,
        );
        locator = `${base}.locator(${javaString(`[role="${role}"]`)})${target.name !== undefined ? `.filter(new Locator.FilterOptions().setHasText(${javaText(target.name)}))` : ''}`;
        break;
      }
      const options =
        target.name !== undefined
          ? `, new ${base === scope && scope === 'page' ? 'Page' : 'Locator'}.GetByRoleOptions().setName(${javaText(target.name)})${exact ? '.setExact(true)' : ''}`
          : '';
      locator = `${base}.getByRole(${ariaRole(role)}${options})`;
      break;
    }
    case 'label':
      locator = `${base}.getByLabel(${javaText(target.value ?? '')}${exact ? `, new ${base === scope && scope === 'page' ? 'Page' : 'Locator'}.GetByLabelOptions().setExact(true)` : ''})`;
      break;
    case 'text':
      locator = `${base}.getByText(${javaText(target.value ?? '')}${exact ? `, new ${base === scope && scope === 'page' ? 'Page' : 'Locator'}.GetByTextOptions().setExact(true)` : ''})`;
      break;
    case 'testId':
      locator = `${base}.getByTestId(${javaText(target.value ?? '')})`;
      break;
    case 'css':
      locator = `${base}.locator(${javaString(target.value ?? '')})`;
      break;
  }
  return target.nth !== undefined ? `${locator}.nth(${String(target.nth)})` : locator;
}

const regex = (text: string): string =>
  `Pattern.compile(${javaString(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))})`;

interface StepCode {
  lines: string[];
  assertions: number;
  unsupported?: string;
}

/** Un contrôle attendu (« button:Suivant » ou un nom) : visible après l'action. */
function appearsAssertion(control: string): string {
  const separator = control.indexOf(':');
  const role = separator > 0 ? control.slice(0, separator).toLowerCase() : 'text';
  const name = separator > 0 ? control.slice(separator + 1) : control;
  if (role === 'text' || name === '' || !ARIA_ROLES.has(role))
    return `assertThat(page.getByText(${javaText(name === '' ? control : name)}).first()).isVisible();`;
  return `assertThat(page.getByRole(${ariaRole(role)}, new Page.GetByRoleOptions().setName(${javaText(name)})).first()).isVisible();`;
}

function stepCode(
  step: FlowStep,
  index: number,
  flowName: string,
  report: FlowRunReport | undefined,
  notes: string[],
): StepCode {
  const observed = report?.steps.find((entry) => entry.index === index);
  const lines: string[] = [
    `// step ${String(index)}${observed ? ` — ${observed.description} (${observed.status} at run time)` : ''}`,
  ];
  let assertions = 0;
  let unsupported: string | undefined;
  switch (step.kind) {
    case 'goto':
      lines.push(`page.navigate(Env.url(${javaString(step.url)}));`);
      break;
    case 'click':
      lines.push(`${javaLocator(step.target, notes)}.click();`);
      break;
    case 'check':
    case 'uncheck':
      lines.push(`${javaLocator(step.target, notes)}.${step.kind}();`);
      break;
    case 'fill':
      lines.push(
        `${javaLocator(step.target, notes)}.fill(${javaValue(step.value, literalEnvName(flowName, index))});`,
      );
      break;
    case 'select':
      lines.push(`${javaLocator(step.target, notes)}.selectOption(${javaString(step.option)});`);
      break;
    case 'expect': {
      const expectation = step.expect;
      if (expectation.url) {
        lines.push(`assertThat(page).hasURL(${regex(expectation.url)});`);
        assertions += 1;
      }
      if (expectation.text) {
        lines.push(`assertThat(page.getByText(${javaText(expectation.text)}).first()).isVisible();`);
        assertions += 1;
      }
      if (expectation.visible) {
        lines.push(`assertThat(${javaLocator(expectation.visible, notes)}).isVisible();`);
        assertions += 1;
      }
      if (expectation.hidden) {
        lines.push(`assertThat(${javaLocator(expectation.hidden, notes)}).isHidden();`);
        assertions += 1;
      }
      if (expectation.noError) {
        lines.push(
          `assertThat(page.locator(${javaString('[role="alert"], .mat-error, .invalid-feedback')})).hasCount(0);`,
        );
        assertions += 1;
      }
      if (expectation.response) {
        const { method, url, status } = expectation.response;
        const statusCheck =
          typeof status === 'number'
            ? `response.status() == ${String(status)}`
            : `String.valueOf(response.status()).startsWith(${javaString(status[0] ?? '2')})`;
        lines.push(
          `// best effort: waits for the next matching response after the previous action`,
          `page.waitForResponse(response -> response.url().contains(${javaString(url)})${method ? ` && response.request().method().equals(${javaString(method)})` : ''} && ${statusCheck}, () -> {});`,
        );
        notes.push(
          `step ${String(index)}: the response expectation waits for the next matching response (best effort)`,
        );
        assertions += 1;
      }
      break;
    }
    case 'screenshot':
      lines.push(`evidence(${javaString(step.label)});`);
      break;
    case 'manual':
      lines.push(`manual(${javaString(step.text)});`);
      break;
    case 'auto':
      unsupported = `step ${String(index)}: sentence interpreted on the screen at run time by QA-CRAWLER: ${step.sentence}`;
      lines.push(`unsupported(${javaString(unsupported)});`);
      break;
    case 'intent':
      unsupported = `step ${String(index)}: semantic intent resolved at run time by QA-CRAWLER: ${JSON.stringify(step.intent)}`;
      lines.push(`unsupported(${javaString(unsupported)});`);
      break;
    case 'dragAndDrop':
      lines.push(
        `page.getByText(${javaText(step.item)}).first().dragTo(page.getByText(${javaText(step.to.label ?? step.to.section ?? '')}).first());`,
      );
      break;
  }
  if (step.effects?.route) {
    lines.push(`assertThat(page).hasURL(${regex(step.effects.route)});`);
    assertions += 1;
  }
  for (const control of step.effects?.appears ?? []) {
    lines.push(appearsAssertion(control));
    assertions += 1;
  }
  return { lines, assertions, ...(unsupported ? { unsupported } : {}) };
}

/** Un identifiant Java (classe ou méthode) tiré d'un nom de flow. */
export function javaIdentifier(name: string, style: 'class' | 'method', fallback: string): string {
  const words = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  if (words.length === 0) return fallback;
  const pascal = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join('');
  let identifier = style === 'class' ? pascal : pascal.charAt(0).toLowerCase() + pascal.slice(1);
  if (/^[0-9]/.test(identifier)) identifier = `${style === 'class' ? 'Flow' : 'flow'}${identifier}`;
  if (JAVA_KEYWORDS.has(identifier)) identifier = `${identifier}Flow`;
  return identifier;
}

function packagePath(packageName: string): string {
  return packageName.replace(/\./g, '/');
}

function testClass(
  definition: FlowDefinition,
  report: FlowRunReport | undefined,
  options: JavaGenerationOptions,
  packageName: string,
  className: string,
): { content: string; steps: number; assertions: number; unsupported: string[]; notes: string[] } {
  const notes: string[] = [];
  const unsupported: string[] = [];
  const body: string[] = [];
  let assertions = 0;
  definition.steps.forEach((step, position) => {
    const generated = stepCode(step, position + 1, definition.name, report, notes);
    body.push(...generated.lines, '');
    assertions += generated.assertions;
    if (generated.unsupported) unsupported.push(generated.unsupported);
  });
  const keys = testDataKeysOf(definition.steps);
  const checkpoints = (options.checkpoints ?? []).map(
    (checkpoint) => ` *   - ${checkpoint.id}: ${checkpoint.status}`,
  );
  const method = javaIdentifier(definition.name, 'method', 'runFlow');
  const content = [
    `package ${packageName};`,
    '',
    'import static com.microsoft.playwright.assertions.PlaywrightAssertions.assertThat;',
    '',
    'import com.microsoft.playwright.Locator;',
    'import com.microsoft.playwright.Page;',
    'import com.microsoft.playwright.options.AriaRole;',
    'import java.util.regex.Pattern;',
    'import org.junit.jupiter.api.DisplayName;',
    'import org.junit.jupiter.api.Test;',
    `import ${packageName}.support.Env;`,
    `import ${packageName}.support.QaPlaywrightTest;`,
    '',
    '/**',
    ` * Generated by QA-CRAWLER from the flow "${definition.name}"${definition.description ? ` — ${definition.description}` : ''}.`,
    ` * Run status at generation time: ${report?.status ?? 'not executed'}.`,
    ' * Test data is generated per run (TestData, never a recorded value); literal values of the flow and',
    ' * secrets come from the environment (QA_REPRO_<FLOW>_STEP_<n>).',
    ...(keys.length > 0 ? [` * Run data used: ${keys.join(', ')}.`] : []),
    ...(checkpoints.length > 0 ? [' * Semantic checkpoints observed:', ...checkpoints] : []),
    ...(unsupported.length > 0
      ? [
          ' * Steps the Java test cannot replay (the test is aborted there, never reported as passed):',
          ...unsupported.map((entry) => ` *   - ${entry}`),
        ]
      : []),
    ' */',
    `@DisplayName(${javaString(definition.name)})`,
    `class ${className} extends QaPlaywrightTest {`,
    '',
    '  @Test',
    `  @DisplayName(${javaString(definition.description ?? definition.name)})`,
    `  void ${method}() {`,
    `    page.navigate(Env.url(${javaString(definition.startAt ?? '/')}));`,
    '',
    ...body.map((line) => (line ? `    ${line}` : '')),
    '  }',
    '}',
    '',
  ].join('\n');
  return { content, steps: definition.steps.length, assertions, unsupported, notes };
}

function supportFiles(packageName: string, baseUrl: string): GeneratedFile[] {
  const dir = `src/test/java/${packagePath(packageName)}/support`;
  return [
    {
      path: `${dir}/Env.java`,
      content: `package ${packageName}.support;

import java.net.URI;

/** Configuration by environment variables: nothing is hard-coded except the known base URL of the mission. */
public final class Env {
  /** The base URL the flows were recorded against; QA_BASE_URL overrides it. */
  public static final String DEFAULT_BASE_URL = ${javaString(baseUrl)};

  private Env() {}

  public static String baseUrl() {
    String value = System.getenv("QA_BASE_URL");
    return value == null || value.isBlank() ? DEFAULT_BASE_URL : value;
  }

  /** An absolute URL for a route of the application (QA_BASE_URL + route). */
  public static String url(String route) {
    if (route.startsWith("http://") || route.startsWith("https://")) return route;
    String base = baseUrl().endsWith("/") ? baseUrl() : baseUrl() + "/";
    return URI.create(base).resolve(route.startsWith("/") ? route.substring(1) : route).toString();
  }

  /** A value the test needs from the environment: a literal of the flow or a secret is never copied into the test. */
  public static String require(String name) {
    String value = System.getenv(name);
    if (value == null || value.isBlank())
      throw new IllegalStateException("missing environment variable " + name + " (values of the flow are never copied into the generated tests)");
    return value;
  }

  public static boolean headless() {
    return !"false".equalsIgnoreCase(System.getenv("QA_HEADLESS"));
  }

  public static double slowMo() {
    String value = System.getenv("QA_SLOW_MO");
    return value == null || value.isBlank() ? 0 : Double.parseDouble(value);
  }
}
`,
    },
    {
      path: `${dir}/TestData.java`,
      content: `package ${packageName}.support;

import java.util.HashMap;
import java.util.Map;

/**
 * The test data of one test execution: one generated value per key, marked with the run tag, reused by
 * every step that cites the key (a creation then a search then an opening share the same value).
 */
public final class TestData {
  private final String runTag = "QA-" + Long.toString(System.currentTimeMillis(), 36);
  private final Map<String, String> values = new HashMap<>();

  public String runTag() {
    return runTag;
  }

  public String value(String key) {
    return values.computeIfAbsent(key, k -> k.substring(k.lastIndexOf('.') + 1) + "-" + runTag);
  }

  public Map<String, String> all() {
    return Map.copyOf(values);
  }
}
`,
    },
    {
      path: `${dir}/EvidenceExtension.java`,
      content: `package ${packageName}.support;

import org.junit.jupiter.api.extension.AfterTestExecutionCallback;
import org.junit.jupiter.api.extension.ExtensionContext;

/** After a failed test method (before @AfterEach closes the page): screenshot, URL, console errors and run data. */
public final class EvidenceExtension implements AfterTestExecutionCallback {
  @Override
  public void afterTestExecution(ExtensionContext context) {
    if (context.getExecutionException().isEmpty()) return;
    Throwable failure = context.getExecutionException().get();
    // An aborted test (a step this generator cannot replay) is skipped, not a failure to document.
    if (failure instanceof org.opentest4j.TestAbortedException) return;
    Object instance = context.getRequiredTestInstance();
    if (instance instanceof QaPlaywrightTest test)
      test.captureEvidence(context.getRequiredTestMethod().getName() + "-failure", failure);
  }
}
`,
    },
    {
      path: `${dir}/QaPlaywrightTest.java`,
      content: `package ${packageName}.support;

import com.microsoft.playwright.Browser;
import com.microsoft.playwright.BrowserContext;
import com.microsoft.playwright.BrowserType;
import com.microsoft.playwright.Page;
import com.microsoft.playwright.Playwright;
import com.microsoft.playwright.PlaywrightException;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.extension.ExtendWith;

/**
 * The Playwright lifecycle shared by the generated tests: one browser per class, one context and page
 * per test, console and page errors collected, evidence written under target/qa-evidence on failure.
 */
@ExtendWith(EvidenceExtension.class)
public abstract class QaPlaywrightTest {
  protected static Playwright playwright;
  protected static Browser browser;
  protected BrowserContext context;
  protected Page page;
  protected TestData data;
  protected final List<String> consoleErrors = new ArrayList<>();

  @BeforeAll
  static void startBrowser() {
    // Playwright.create() would install every browser (Chromium, Firefox, WebKit) on first use: slow, and
    // impossible offline. The browsers already installed are used instead (PLAYWRIGHT_BROWSERS_PATH, or the
    // cache shared with the Node Playwright of the same version); QA_INSTALL_BROWSERS=true restores the
    // automatic installation.
    Map<String, String> env = new HashMap<>();
    if (!"true".equalsIgnoreCase(System.getenv("QA_INSTALL_BROWSERS"))) env.put("PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD", "1");
    playwright = Playwright.create(new Playwright.CreateOptions().setEnv(env));
    try {
      browser = playwright.chromium().launch(new BrowserType.LaunchOptions().setHeadless(Env.headless()).setSlowMo(Env.slowMo()));
    } catch (PlaywrightException error) {
      throw new IllegalStateException(
          "Chromium could not be launched. If it is not installed for this Playwright version, run once: "
              + "mvn -q exec:java -e -D exec.mainClass=com.microsoft.playwright.CLI -D exec.args=\\"install chromium\\" "
              + "(or point PLAYWRIGHT_BROWSERS_PATH to installed browsers, or set QA_INSTALL_BROWSERS=true)",
          error);
    }
  }

  @BeforeEach
  void openPage() {
    context = browser.newContext();
    page = context.newPage();
    data = new TestData();
    consoleErrors.clear();
    page.onConsoleMessage(message -> {
      if ("error".equals(message.type())) consoleErrors.add("console: " + message.text());
    });
    page.onPageError(error -> consoleErrors.add("page error: " + error));
  }

  @AfterEach
  void closeContext() {
    if (context != null) context.close();
  }

  @AfterAll
  static void stopBrowser() {
    if (browser != null) browser.close();
    if (playwright != null) playwright.close();
  }

  /** A check QA-CRAWLER leaves to a human: logged, never a failure. */
  protected void manual(String text) {
    System.out.println("MANUAL: " + text);
  }

  /** A step this generator cannot replay: the test is aborted (reported as skipped), never passed. */
  protected void unsupported(String reason) {
    Assumptions.abort("unsupported by the generated Java test — " + reason);
  }

  /** A screenshot requested by the flow (step \`screenshot\`). */
  protected void evidence(String label) {
    captureEvidence(label, null);
  }

  void captureEvidence(String label, Throwable cause) {
    try {
      Path dir = Paths.get("target", "qa-evidence", getClass().getSimpleName());
      Files.createDirectories(dir);
      String name = label.replaceAll("[^A-Za-z0-9._-]+", "_");
      List<String> lines = new ArrayList<>();
      lines.add("url: " + (page == null ? "" : page.url()));
      if (cause != null) lines.add("failure: " + cause);
      lines.add("run data: " + (data == null ? "{}" : data.all()));
      lines.addAll(consoleErrors);
      Files.write(dir.resolve(name + ".txt"), lines, StandardCharsets.UTF_8);
      if (page != null && !page.isClosed())
        page.screenshot(
            new Page.ScreenshotOptions().setPath(dir.resolve(name + ".png")).setFullPage(true).setTimeout(10_000));
    } catch (IOException | RuntimeException error) {
      System.err.println("evidence not written: " + error);
    }
  }
}
`,
    },
  ];
}

function pom(versions: JavaGeneratorVersions, packageName: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>

  <!-- Generated by QA-CRAWLER: JUnit 5 + Playwright Java tests of the recorded flows. -->
  <groupId>${packageName}</groupId>
  <artifactId>qa-crawler-generated-tests</artifactId>
  <version>1.0.0-SNAPSHOT</version>
  <packaging>jar</packaging>

  <properties>
    <maven.compiler.release>${versions.javaRelease}</maven.compiler.release>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
    <project.reporting.outputEncoding>UTF-8</project.reporting.outputEncoding>
    <playwright.version>${versions.playwright}</playwright.version>
    <junit.version>${versions.junit}</junit.version>
  </properties>

  <dependencies>
    <dependency>
      <groupId>org.junit.jupiter</groupId>
      <artifactId>junit-jupiter</artifactId>
      <version>\${junit.version}</version>
      <scope>test</scope>
    </dependency>
    <dependency>
      <groupId>com.microsoft.playwright</groupId>
      <artifactId>playwright</artifactId>
      <version>\${playwright.version}</version>
      <scope>test</scope>
    </dependency>
  </dependencies>

  <build>
    <plugins>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-compiler-plugin</artifactId>
        <version>${versions.compiler}</version>
      </plugin>
      <plugin>
        <!-- Runs the tests and writes target/surefire-reports/TEST-*.xml (JUnit XML for the CI). -->
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-surefire-plugin</artifactId>
        <version>${versions.surefire}</version>
        <configuration>
          <trimStackTrace>false</trimStackTrace>
        </configuration>
      </plugin>
    </plugins>
  </build>
</project>
`;
}

function readme(
  project: { packageName: string; versions: JavaGeneratorVersions; tests: GeneratedJavaTest[] },
  baseUrl: string,
): string {
  const rows = project.tests
    .map(
      (test) =>
        `| \`${test.className}\` | ${test.flow} | ${String(test.steps)} | ${String(test.assertions)} | ${test.unsupported.length > 0 ? `${String(test.unsupported.length)} unsupported step(s)` : 'none'} |`,
    )
    .join('\n');
  return `# Generated JUnit 5 + Playwright Java tests

Generated by QA-CRAWLER from the recorded flows. Java ${project.versions.javaRelease}+, Maven, JUnit Jupiter ${project.versions.junit}, Playwright Java ${project.versions.playwright}.

| Class | Flow | Steps | Assertions | Limits |
| --- | --- | --- | --- | --- |
${rows}

## Run

\`\`\`bash
# once: the browser of this Playwright version (or point PLAYWRIGHT_BROWSERS_PATH to existing browsers)
mvn -q exec:java -e -D exec.mainClass=com.microsoft.playwright.CLI -D exec.args="install chromium"

export QA_BASE_URL=${baseUrl}      # the application under test (default: the base URL of the mission)
mvn test                                  # JUnit XML in target/surefire-reports/TEST-*.xml
\`\`\`

Browsers: the tests use the browsers already installed (\`PLAYWRIGHT_BROWSERS_PATH\`, or the cache shared with the
Node Playwright of the same version) and never download them by themselves; \`QA_INSTALL_BROWSERS=true\` lets
Playwright install them on first use.

Environment variables: \`QA_BASE_URL\` (application), \`QA_HEADLESS=false\` (show the browser), \`QA_SLOW_MO=<ms>\`,
and one \`QA_REPRO_<FLOW>_STEP_<n>\` (or the \`{ env }\` names of the flow) per literal value: values of the
flow are never copied into the tests. Test data cited by the flows is generated per run (\`TestData\`).

Evidence of a failed test: \`target/qa-evidence/<TestClass>/<test>-failure.png\` and \`.txt\` (URL, failure,
run data, console errors). A step the generator cannot replay aborts the test (JUnit \`skipped\`), it never
passes silently.

A test that compiles and passes here proves that the recorded actions and assertions hold on the
application it ran against; it does not prove more than QA-CRAWLER's own run did.
`;
}

/** Écrit le projet généré sous `directory` ; renvoie les chemins écrits. */
export async function writeJavaProject(project: GeneratedJavaProject, directory: string): Promise<string[]> {
  const written: string[] = [];
  for (const file of project.files) {
    const target = path.join(directory, file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content, 'utf8');
    written.push(target);
  }
  return written;
}

/** Le projet Maven d'une mission : un test par flow, les classes de support, pom.xml, README. */
export function generateJavaJUnitPlaywrightProject(
  definitions: readonly FlowDefinition[],
  reports: readonly FlowRunReport[],
  options: JavaGenerationOptions,
): GeneratedJavaProject {
  const packageName = options.packageName ?? 'qa.generated';
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/.test(packageName))
    throw new Error(`invalid Java package name "${packageName}"`);
  const versions = { ...JAVA_GENERATOR_VERSIONS, ...options.versions };
  const used = new Set<string>();
  const tests: GeneratedJavaTest[] = [];
  const files: GeneratedFile[] = [];
  for (const definition of definitions) {
    let className = `${javaIdentifier(definition.name, 'class', 'Flow')}Test`;
    let suffix = 2;
    while (used.has(className))
      className = `${javaIdentifier(definition.name, 'class', 'Flow')}${String(suffix++)}Test`;
    used.add(className);
    const report = reports.find((entry) => entry.name === definition.name);
    const generated = testClass(definition, report, options, packageName, className);
    const file = `src/test/java/${packagePath(packageName)}/${className}.java`;
    files.push({ path: file, content: generated.content });
    tests.push({
      flow: definition.name,
      className,
      file,
      steps: generated.steps,
      assertions: generated.assertions,
      unsupported: generated.unsupported,
      notes: [...new Set(generated.notes)],
    });
  }
  files.push(...supportFiles(packageName, options.baseUrl));
  files.push({ path: 'pom.xml', content: pom(versions, packageName) });
  files.push({ path: 'README.md', content: readme({ packageName, versions, tests }, options.baseUrl) });
  files.push({ path: '.gitignore', content: 'target/\n' });
  return { packageName, versions, files, tests };
}
