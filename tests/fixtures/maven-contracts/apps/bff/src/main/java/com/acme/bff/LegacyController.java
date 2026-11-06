package com.acme.bff;

import com.acme.legacy.api.OrdersApi;
import org.springframework.web.bind.annotation.RestController;

/** Implémente l'homonyme d'un autre paquet : ses routes sont celles de ce type, pas de l'autre. */
@RestController
public class LegacyController implements OrdersApi {
  @Override
  public String getOrder(String id) {
    return id;
  }
}
