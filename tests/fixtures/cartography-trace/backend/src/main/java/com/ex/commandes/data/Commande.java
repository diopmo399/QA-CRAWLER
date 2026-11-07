package com.ex.commandes.data;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

@Entity
@Table(name = "commandes")
public class Commande {
  @Id
  private Long id;

  @Column(name = "client_nom")
  private String client;

  private String statut;

  public String getClient() {
    return client;
  }
}
