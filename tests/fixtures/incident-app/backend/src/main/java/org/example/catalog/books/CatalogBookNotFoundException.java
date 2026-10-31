package org.example.catalog.books;

import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.ResponseStatus;

@ResponseStatus(HttpStatus.NOT_FOUND)
public class CatalogBookNotFoundException extends RuntimeException {

    public CatalogBookNotFoundException(Long id) {
        super("Catalog book not found: " + id);
    }
}
