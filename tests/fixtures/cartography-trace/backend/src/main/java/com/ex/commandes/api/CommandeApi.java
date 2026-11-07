package com.ex.commandes.api;

import static com.ex.commandes.api.Routes.COMMANDES;

import com.ex.commandes.data.Commande;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;

/** Le contrat de l'API, porté par une interface que le contrôleur implémente. */
@RequestMapping(COMMANDES)
public interface CommandeApi {
  @GetMapping("/{id}")
  Commande lire(@PathVariable("id") Long id);

  @PostMapping
  Commande creer(@RequestBody Commande commande);

  @PostMapping("/validation")
  Boolean valider(@RequestBody Commande commande);
}
