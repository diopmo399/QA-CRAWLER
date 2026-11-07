package test.graph.bff;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/companies")
public class CompanyBffController {
    private final CompanyBffService service;

    public CompanyBffController(CompanyBffService service) {
        this.service = service;
    }

    @PostMapping
    public void create(@RequestBody CompanyDto dto) {
        service.createCompany(dto);
    }

    @PostMapping("/search")
    public void search(@RequestBody CompanyDto dto) {
        service.searchCompany(dto);
    }

    @PutMapping("/current")
    public void update(@RequestBody CompanyDto dto) {
        service.updateCompany(dto);
    }

    @GetMapping("/current")
    public CompanyDto load() {
        return service.loadCompany();
    }
}
