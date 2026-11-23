package com.ex.risk;

import jakarta.persistence.Entity;
import jakarta.persistence.Id;

@Entity
public class Client {
  @Id
  private Long id;
  private String name;
}
