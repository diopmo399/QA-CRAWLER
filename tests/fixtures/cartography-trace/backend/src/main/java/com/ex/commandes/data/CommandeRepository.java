package com.ex.commandes.data;

import java.util.List;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;

public interface CommandeRepository extends JpaRepository<Commande, Long> {
  List<Commande> findByClient(String client);

  @Query("select c from Commande c where c.statut = :statut")
  List<Commande> parStatut(String statut);
}
