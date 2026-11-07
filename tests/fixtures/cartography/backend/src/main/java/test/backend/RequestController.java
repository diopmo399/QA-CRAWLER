package test.backend;

import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/requests")
public class RequestController {
    private final RequestService service;

    public RequestController(RequestService service) {
        this.service = service;
    }

    @PostMapping
    public Request create(@Valid @RequestBody CreateRequestCommand command) {
        return service.create(command);
    }

    @GetMapping("/{id}")
    public Request get(@PathVariable Long id) {
        return service.get(id);
    }

    @PutMapping("/{id}")
    public Request update(@PathVariable Long id, @Valid @RequestBody UpdateRequestCommand command) {
        return service.update(id, command);
    }

    @PostMapping("/{id}/validate")
    public Request validate(@PathVariable Long id) {
        return service.validate(id);
    }
}
