package org.example.catalog.books;

public record CatalogBookResponse(Long id, String title, String isbn, String catalogLabel, String publisherName) {

    static CatalogBookResponse from(CatalogBook book) {
        String publisherName = book.getPublisher() == null ? null : book.getPublisher().getName();
        return new CatalogBookResponse(book.getId(), book.getTitle(), book.getIsbn(), book.getCatalogLabel(), publisherName);
    }
}
