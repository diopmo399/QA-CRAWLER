package com.ex.bff;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.client.WebClient;

/** Base d'URL injectée : backend.url, propre à chaque profil. */
@Component
public class BackendClient {
  private final WebClient webClient;

  public BackendClient(WebClient.Builder builder, @Value("${backend.url}") String baseUrl) {
    this.webClient = builder.baseUrl(baseUrl).build();
  }

  public String dossier(Long id) {
    return webClient.get().uri("/api/dossiers/{id}", id).retrieve().bodyToMono(String.class).block();
  }
}
