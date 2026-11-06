package com.ex.commandes.web;

import com.ex.commandes.api.Routes;
import com.ex.commandes.service.CommandeService;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping(Routes.STATS)
public class StatistiquesController {
  private final CommandeService commandeService;

  public StatistiquesController(CommandeService commandeService) {
    this.commandeService = commandeService;
  }

  @GetMapping("/total")
  public Long total() {
    return commandeService.compter();
  }

  @DeleteMapping("/archives")
  public void purger() {
    commandeService.purger();
  }
}
