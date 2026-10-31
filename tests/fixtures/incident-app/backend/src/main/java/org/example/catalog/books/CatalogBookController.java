package org.example.catalog.books;

import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/catalog/books")
public class CatalogBookController {

    private final CatalogBookService catalogBookService;

    public CatalogBookController(CatalogBookService catalogBookService) {
        this.catalogBookService = catalogBookService;
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public CatalogBookResponse register(@RequestBody NewCatalogBook body) {
        return catalogBookService.register(body);
    }

    @GetMapping("/{id}")
    public CatalogBookResponse find(@PathVariable Long id) {
        return catalogBookService.find(id);
    }
}
