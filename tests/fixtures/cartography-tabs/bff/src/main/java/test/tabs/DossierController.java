package test.tabs;

import java.util.List;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/dossier")
public class DossierController {
    @PostMapping("/validate")
    public ValidationDto validate() { return new ValidationDto(); }

    @GetMapping("/documents")
    public List<String> documents() { return List.of(); }

    @GetMapping("/history")
    public List<String> history() { return List.of(); }
}
