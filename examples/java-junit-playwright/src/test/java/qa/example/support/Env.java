package qa.example.support;

import java.net.URI;

/** Configuration by environment variables: nothing is hard-coded except the known base URL of the mission. */
public final class Env {
  /** The base URL the flows were recorded against; QA_BASE_URL overrides it. */
  public static final String DEFAULT_BASE_URL = "http://localhost:4174";

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
