package qa.example.support;

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
