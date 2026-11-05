package test.rx;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/activation")
public class ActivationController {
    private final ActivationBffService service;

    public ActivationController(ActivationBffService service) {
        this.service = service;
    }

    @PostMapping
    public ActivationStatusDto activate(@RequestBody ActivationRequest request) {
        return service.activate(request);
    }

    @GetMapping("/status")
    public ActivationStatusDto status() {
        return service.status();
    }
}
