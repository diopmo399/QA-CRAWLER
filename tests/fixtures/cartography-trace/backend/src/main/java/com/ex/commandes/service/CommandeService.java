package com.ex.commandes.service;

import com.ex.commandes.data.Commande;
import com.ex.commandes.data.CommandeRepository;
import jakarta.persistence.EntityManager;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** Un service partagé : chaque méthode a ses propres accès aux données. */
@Service
public class CommandeService {
  private final CommandeRepository commandeRepository;
  private final EntityManager entityManager;
  private final JdbcTemplate jdbcTemplate;

  public CommandeService(CommandeRepository commandeRepository, EntityManager entityManager, JdbcTemplate jdbcTemplate) {
    this.commandeRepository = commandeRepository;
    this.entityManager = entityManager;
    this.jdbcTemplate = jdbcTemplate;
  }

  public Commande lire(Long id) {
    return commandeRepository.findById(id).orElseThrow();
  }

  @Transactional
  public Commande creer(Commande commande) {
    return commandeRepository.save(commande);
  }

  public Boolean valider(Commande commande) {
    return !commandeRepository.findByClient(commande.getClient()).isEmpty();
  }

  public Long compter() {
    return entityManager.createQuery("select count(c) from Commande c", Long.class).getSingleResult();
  }

  public void purger() {
    jdbcTemplate.update("delete from commandes_archives where cree_le < now()");
  }
}
