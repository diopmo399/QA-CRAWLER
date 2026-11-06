package com.acme.backend;

import com.acme.orders.api.OrderDto;
import com.acme.orders.api.OrdersApi;
import org.springframework.web.bind.annotation.RestController;

/** Implémente la version 2.0.0 du même contrat (autres routes) : résolue pour le Backend seul. */
@RestController
public class OrdersBackendController implements OrdersApi {
  private final OrderStore store;

  public OrdersBackendController(OrderStore store) {
    this.store = store;
  }

  @Override
  public OrderDto getOrder(String id) {
    return store.find(id);
  }

  @Override
  public OrderDto updateOrder(String id, OrderDto body) {
    return store.save(body);
  }

  @Override
  public void deleteOrder(String id) {
    store.remove(id);
  }
}
