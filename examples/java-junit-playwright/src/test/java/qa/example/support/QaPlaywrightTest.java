package qa.example.support;

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
              + "mvn -q exec:java -e -D exec.mainClass=com.microsoft.playwright.CLI -D exec.args=\"install chromium\" "
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

  /** A screenshot requested by the flow (step `screenshot`). */
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
