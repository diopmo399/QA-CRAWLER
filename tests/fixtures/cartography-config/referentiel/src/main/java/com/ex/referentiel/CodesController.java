package com.ex.referentiel;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/codes")
public class CodesController {
  @GetMapping("/{code}")
  public String lireCode(@PathVariable String code) {
    return code;
  }
}
