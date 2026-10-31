package org.example.bff.books;

/**
 * La réponse du service catalogue.
 */
public record CatalogBookView(Long id, String title, String isbn, String catalogLabel, String publisherName) {
}
