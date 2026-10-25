package qa.example.support;

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
