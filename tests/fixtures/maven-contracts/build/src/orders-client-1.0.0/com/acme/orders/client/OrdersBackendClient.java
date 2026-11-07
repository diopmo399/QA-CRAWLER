package com.acme.orders.client;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.service.annotation.*;
@HttpExchange("/api/v2/orders")
public interface OrdersBackendClient {
  @GetExchange("/{id}") OrderView getOrder(@PathVariable("id") String id);
  @PutExchange("/{id}") OrderView updateOrder(@PathVariable("id") String id, @RequestBody OrderView body);
}
