package test.flow;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/orders")
public class OrderController {
  @PostMapping("/validate")
  public Object validate(@RequestBody Object form) { return null; }

  @GetMapping("/check")
  public boolean check() { return true; }

  @PostMapping
  public Object submit(@RequestBody Object payload) { return null; }

  @PostMapping("/{id}/cancel")
  public void cancel(@PathVariable String id) {}

  @PostMapping("/{id}/archive")
  public void archive(@PathVariable String id) {}

  @GetMapping
  public Object list() { return null; }

  @GetMapping("/search")
  public Object search(@RequestParam String q) { return null; }
}
