package com.ex.bff;

import com.ex.referentiel.client.ApiClient;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** Le client généré du référentiel, configuré par un bean. */
@Configuration
public class ClientsConfig {
  @Bean
  public ApiClient referentielApiClient(@Value("${referentiel.url}") String url) {
    ApiClient client = new ApiClient();
    client.setBasePath(url);
    return client;
  }
}
