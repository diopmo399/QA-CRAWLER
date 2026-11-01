package org.example.catalog.books;

import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface CatalogBookRepository extends JpaRepository<CatalogBook, Long> {

    @Query("select b from CatalogBook b where b.isbn = :isbn")
    Optional<CatalogBook> findByIsbn(@Param("isbn") String isbn);
}
