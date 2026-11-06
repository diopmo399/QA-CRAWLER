package com.acme.orders.api;
import org.springframework.web.bind.annotation.*;
@RequestMapping("/api/v2/orders")
public interface OrdersApi {
  @GetMapping("/{id}") OrderDto getOrder(@PathVariable("id") String id);
  @PutMapping("/{id}") OrderDto updateOrder(@PathVariable("id") String id, @RequestBody OrderDto body);
  @DeleteMapping("/{id}") void deleteOrder(@PathVariable("id") String id);
}
