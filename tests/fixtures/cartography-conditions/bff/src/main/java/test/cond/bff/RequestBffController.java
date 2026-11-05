package test.cond.bff;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/requests")
public class RequestBffController {
    private final RequestBffService service;

    public RequestBffController(RequestBffService service) {
        this.service = service;
    }

    @PostMapping
    public void create(@RequestBody NewRequestDto dto) {
        service.create(dto);
    }

    @GetMapping("/current/state")
    public RequestStateDto state() {
        return service.state();
    }

    @PostMapping("/validate")
    public void validate() {
        service.validate();
    }

    @PostMapping("/refuse")
    public void refuse() {
        service.refuse();
    }
}
