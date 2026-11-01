package org.example.bff.books;

/**
 * Le corps envoyé au service catalogue (POST /catalog/books).
 */
public record CatalogBookPayload(String title, String isbn, Long publisherId) {
}
