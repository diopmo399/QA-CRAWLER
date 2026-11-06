package com.ex.backend;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/decisions")
public class DecisionsController {
  @PostMapping
  public DecisionDto enregistrer(@RequestBody DecisionDto decision) {
    return decision;
  }

  @GetMapping("/{id}")
  public DecisionDto lire(@PathVariable Long id) {
    return new DecisionDto();
  }
}
