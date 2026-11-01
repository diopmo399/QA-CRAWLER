package org.example.bff.books;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestTemplate;

/**
 * Le client HTTP du service catalogue (backend).
 */
@Component
public class CatalogClient {

    private final RestTemplate restTemplate;
    private final String catalogUrl;

    public CatalogClient(RestTemplate restTemplate, @Value("${catalog.url}") String catalogUrl) {
        this.restTemplate = restTemplate;
        this.catalogUrl = catalogUrl;
    }

    public CatalogBookView register(CatalogBookPayload body) {
        return restTemplate.postForObject(catalogUrl + "/catalog/books", body, CatalogBookView.class);
    }

    public CatalogBookView find(long id) {
        return restTemplate.getForObject(catalogUrl + "/catalog/books/{id}", CatalogBookView.class, id);
    }
}
