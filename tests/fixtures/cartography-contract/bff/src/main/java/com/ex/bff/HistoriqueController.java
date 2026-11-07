package com.ex.bff;

import java.util.List;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class HistoriqueController {
  @GetMapping("/demandes/historique")
  public List<String> demandes() {
    return List.of();
  }

  @GetMapping("/dossiers/historique")
  public List<String> dossiers() {
    return List.of();
  }
}
