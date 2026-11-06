package com.ex.commandes.web;

import com.ex.commandes.api.CommandeApi;
import com.ex.commandes.data.Commande;
import com.ex.commandes.service.CommandeService;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class CommandeController implements CommandeApi {
  private final CommandeService commandeService;

  public CommandeController(CommandeService commandeService) {
    this.commandeService = commandeService;
  }

  @Override
  public Commande lire(Long id) {
    return commandeService.lire(id);
  }

  @Override
  public Commande creer(Commande commande) {
    return commandeService.creer(commande);
  }

  @Override
  public Boolean valider(Commande commande) {
    return commandeService.valider(commande);
  }
}
