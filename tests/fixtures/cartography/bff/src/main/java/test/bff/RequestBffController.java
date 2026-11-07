package test.bff;

import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/requests")
public class RequestBffController {
    private final RequestBffService service;

    public RequestBffController(RequestBffService service) {
        this.service = service;
    }

    @PostMapping
    public RequestBffView create(@Valid @RequestBody CreateRequestDto dto) {
        return service.create(dto);
    }

    @GetMapping("/{id}")
    public RequestBffView get(@PathVariable Long id) {
        return service.get(id);
    }

    @PutMapping("/{id}")
    public RequestBffView update(@PathVariable Long id, @Valid @RequestBody UpdateRequestDto dto) {
        return service.update(id, dto);
    }
}
