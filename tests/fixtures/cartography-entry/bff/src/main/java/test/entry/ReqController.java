package test.entry;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/req")
public class ReqController {
  @PostMapping("/validation")
  public Object validation(@RequestBody Object payload) { return null; }

  @PostMapping("/enregistrement")
  public Object enregistrement(@RequestBody Object payload) { return null; }

  @GetMapping("/ping")
  public Object ping() { return null; }
}
