package com.ex.bff;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestTemplate;

/** Propriété absente de toute configuration : la destination n'est pas résolue. */
@Component
public class PartenaireClient {
  @Value("${partenaire.url}")
  private String partenaireUrl;

  private final RestTemplate restTemplate = new RestTemplate();

  public Object dossier(Long id) {
    return restTemplate.getForObject(partenaireUrl + "/api/dossiers/{id}", Object.class, id);
  }
}
