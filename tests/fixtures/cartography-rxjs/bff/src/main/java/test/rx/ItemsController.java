package test.rx;

import java.util.List;
import org.springframework.web.bind.annotation.*;

/** Deux endpoints finissent par /items : un appel `/{kind}/items` est ambigu. */
@RestController
public class ItemsController {
    @GetMapping("/a/items")
    public List<String> a() { return List.of(); }

    @GetMapping("/b/items")
    public List<String> b() { return List.of(); }
}
