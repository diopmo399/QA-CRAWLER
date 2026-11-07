package test.cond.backend;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/requests")
public class RequestController {
    private final RequestStateService states;
    private final RequestValidationService validation;

    public RequestController(RequestStateService states, RequestValidationService validation) {
        this.states = states;
        this.validation = validation;
    }

    @PostMapping
    public void create(@RequestBody RequestCommand command) {
        validation.create(command);
    }

    @GetMapping("/current/state")
    public RequestStateView state() {
        return states.state();
    }

    @PostMapping("/validate")
    public void validate(@RequestBody ValidationCommand command) {
        validation.validate(command);
    }

    @PostMapping("/refuse")
    public void refuse(@RequestBody ValidationCommand command) {
        validation.refuse(command);
    }
}
