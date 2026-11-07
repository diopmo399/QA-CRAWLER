package com.acme.legacy.api;
import org.springframework.web.bind.annotation.*;
/** Un homonyme d'un autre paquet : jamais confondu avec com.acme.orders.api.OrdersApi. */
@RequestMapping("/legacy/orders")
public interface OrdersApi {
  @GetMapping("/{id}") String getOrder(@PathVariable("id") String id);
}
