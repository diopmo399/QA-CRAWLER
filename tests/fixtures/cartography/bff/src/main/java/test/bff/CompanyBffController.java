package test.bff;

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
        service.create(dto);
    }
}
