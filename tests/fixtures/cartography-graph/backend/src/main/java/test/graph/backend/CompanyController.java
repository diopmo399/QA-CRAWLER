package test.graph.backend;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/companies")
public class CompanyController {
    private final CompanyService service;

    public CompanyController(CompanyService service) {
        this.service = service;
    }

    @PostMapping
    public Company create(@RequestBody CompanyCommand command) {
        return service.createCompany(command);
    }

    @PostMapping("/search")
    public void search(@RequestBody CompanyCommand command) {
        service.searchCompany(command);
    }

    @PutMapping("/current")
    public Company update(@RequestBody CompanyCommand command) {
        return service.updateCompany(command);
    }

    @GetMapping("/current")
    public Company load() {
        return service.loadCompany();
    }
}
