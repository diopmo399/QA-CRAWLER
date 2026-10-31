package org.example.catalog.books;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.Table;

@Entity
@Table(name = "catalog_book")
public class CatalogBook {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false, length = 200)
    private String title;

    @Column(nullable = false, unique = true, length = 13)
    private String isbn;

    @Column(name = "catalog_label")
    private String catalogLabel;

    @ManyToOne
    @JoinColumn(name = "publisher_id")
    private Publisher publisher;

    protected CatalogBook() {
    }

    public CatalogBook(String title, String isbn, Publisher publisher) {
        this.title = title;
        this.isbn = isbn;
        this.publisher = publisher;
    }

    public Long getId() {
        return id;
    }

    public String getTitle() {
        return title;
    }

    public String getIsbn() {
        return isbn;
    }

    public String getCatalogLabel() {
        return catalogLabel;
    }

    public void setCatalogLabel(String catalogLabel) {
        this.catalogLabel = catalogLabel;
    }

    public Publisher getPublisher() {
        return publisher;
    }
}
