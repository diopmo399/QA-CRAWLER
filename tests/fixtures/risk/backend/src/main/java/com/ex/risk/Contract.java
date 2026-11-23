package com.ex.risk;

import jakarta.persistence.Entity;
import jakarta.persistence.Id;

@Entity
public class Contract {
  @Id
  private Long id;
  private Long clientId;
}
