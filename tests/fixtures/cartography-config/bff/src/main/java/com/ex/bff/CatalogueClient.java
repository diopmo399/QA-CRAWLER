package com.ex.bff;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestTemplate;

/** Base fournie seulement à l'exécution (variable CATALOGUE_URL). */
@Component
public class CatalogueClient {
  @Value("${catalogue.url}")
  private String catalogueUrl;

  private final RestTemplate restTemplate = new RestTemplate();

  public Object items() {
    return restTemplate.getForObject(catalogueUrl + "/catalogue/items", Object.class);
  }
}
