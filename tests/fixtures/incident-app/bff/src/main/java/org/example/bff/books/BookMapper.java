package org.example.bff.books;

import org.springframework.stereotype.Component;

@Component
public class BookMapper {

    public CatalogBookPayload toCatalog(CreateBookRequest request) {
        return new CatalogBookPayload(request.title().trim(), request.isbn(), request.publisherId());
    }

    public BookView toView(CatalogBookView book) {
        return new BookView(book.id(), book.title(), book.isbn(), book.publisherName());
    }
}
