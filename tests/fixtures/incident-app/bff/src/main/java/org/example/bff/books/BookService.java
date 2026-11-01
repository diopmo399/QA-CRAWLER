package org.example.bff.books;

import org.springframework.stereotype.Service;

@Service
public class BookService {

    private final BookMapper bookMapper;
    private final CatalogClient catalogClient;

    public BookService(BookMapper bookMapper, CatalogClient catalogClient) {
        this.bookMapper = bookMapper;
        this.catalogClient = catalogClient;
    }

    public BookView create(CreateBookRequest request) {
        CatalogBookPayload payload = bookMapper.toCatalog(request);
        CatalogBookView created = catalogClient.register(payload);
        return bookMapper.toView(created);
    }

    public BookView get(long id) {
        return bookMapper.toView(catalogClient.find(id));
    }
}
