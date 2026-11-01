package org.example.catalog.books;

import jakarta.validation.constraints.NotBlank;

/**
 * Un livre à inscrire au catalogue.
 */
public record NewCatalogBook(@NotBlank String title, @NotBlank String isbn, Long publisherId) {
}
