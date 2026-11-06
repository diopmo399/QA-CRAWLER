package com.ex.bff;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/dossiers")
public class DossiersController {
  private final BackendClient backendClient;

  public DossiersController(BackendClient backendClient) {
    this.backendClient = backendClient;
  }

  @GetMapping("/{id}")
  public String lire(@PathVariable Long id) {
    return backendClient.dossier(id);
  }

  @PostMapping
  public String creer(@RequestBody String dossier) {
    return dossier;
  }
}
