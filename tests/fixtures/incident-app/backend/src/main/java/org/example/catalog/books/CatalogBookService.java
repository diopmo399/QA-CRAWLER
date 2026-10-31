package org.example.catalog.books;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class CatalogBookService {

    private final CatalogBookRepository catalogBookRepository;
    private final PublisherRepository publisherRepository;

    public CatalogBookService(CatalogBookRepository catalogBookRepository, PublisherRepository publisherRepository) {
        this.catalogBookRepository = catalogBookRepository;
        this.publisherRepository = publisherRepository;
    }

    @Transactional
    public CatalogBookResponse register(NewCatalogBook body) {
        catalogBookRepository.findByIsbn(body.isbn()).ifPresent(existing -> {
            throw new DuplicateIsbnException(body.isbn());
        });
        Publisher publisher = body.publisherId() != null
                ? publisherRepository.findById(body.publisherId()).orElse(null)
                : null;
        CatalogBook book = new CatalogBook(body.title(), body.isbn(), publisher);
        // Le libellé du catalogue : « Titre — Éditeur ».
        book.setCatalogLabel(book.getTitle() + " — " + book.getPublisher().getName());
        CatalogBook saved = catalogBookRepository.save(book);
        return CatalogBookResponse.from(saved);
    }

    @Transactional(readOnly = true)
    public CatalogBookResponse find(Long id) {
        return catalogBookRepository.findById(id)
                .map(CatalogBookResponse::from)
                .orElseThrow(() -> new CatalogBookNotFoundException(id));
    }
}
