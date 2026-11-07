package com.ex.backend;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/dossiers")
public class BackendDossiersController {
  @GetMapping("/{id}")
  public String lire(@PathVariable Long id) {
    return "dossier";
  }
}
