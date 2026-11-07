package com.acme.orders.api;
import com.acme.common.api.HealthApi;
import org.springframework.web.bind.annotation.*;
@RequestMapping("/api/orders")
public interface OrdersApi extends HealthApi {
  @GetMapping("/{id}") OrderDto getOrder(@PathVariable("id") String id);
  @PostMapping OrderDto createOrder(@RequestBody OrderDto body);
  @GetMapping("/search") java.util.List<OrderDto> search(@RequestParam("q") String q);
  @GetMapping("/search/page") java.util.List<OrderDto> search(@RequestParam("q") String q, @RequestParam("page") int page);
}
