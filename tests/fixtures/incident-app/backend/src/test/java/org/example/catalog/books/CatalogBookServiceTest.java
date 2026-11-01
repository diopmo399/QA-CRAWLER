package org.example.catalog.books;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.when;

import java.util.Optional;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

@ExtendWith(MockitoExtension.class)
class CatalogBookServiceTest {

    @Mock
    CatalogBookRepository catalogBookRepository;

    @Mock
    PublisherRepository publisherRepository;

    @InjectMocks
    CatalogBookService catalogBookService;

    @Test
    void registersBookWithItsPublisher() {
        when(catalogBookRepository.findByIsbn("9782070612758")).thenReturn(Optional.empty());
        when(publisherRepository.findById(7L)).thenReturn(Optional.of(new Publisher(7L, "Éditions du Phare")));
        when(catalogBookRepository.save(any(CatalogBook.class))).thenAnswer(invocation -> invocation.getArgument(0));

        CatalogBookResponse response = catalogBookService.register(new NewCatalogBook("Le Petit Phare", "9782070612758", 7L));

        assertThat(response.catalogLabel()).isEqualTo("Le Petit Phare — Éditions du Phare");
        assertThat(response.publisherName()).isEqualTo("Éditions du Phare");
    }
}
