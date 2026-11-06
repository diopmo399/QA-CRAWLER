package com.acme.bff;

import com.acme.orders.api.OrderDto;
import com.acme.orders.api.OrdersApi;
import com.acme.orders.client.OrdersBackendClient;
import com.acme.orders.client.OrderView;
import java.util.List;
import org.springframework.web.bind.annotation.RestController;

/** Implémente le contrat sans répéter ses annotations : les routes viennent du jar. */
@RestController
public class OrdersBffController implements OrdersApi {
  private final OrdersBackendClient backend;

  public OrdersBffController(OrdersBackendClient backend) {
    this.backend = backend;
  }

  @Override
  public OrderDto getOrder(String id) {
    OrderView view = backend.getOrder(id);
    OrderDto dto = new OrderDto();
    dto.id = view.id;
    return dto;
  }

  @Override
  public OrderDto createOrder(OrderDto body) {
    return body;
  }

  @Override
  public List<OrderDto> search(String q) {
    return List.of();
  }

  @Override
  public List<OrderDto> search(String q, int page) {
    return List.of();
  }

  @Override
  public String health() {
    return "ok";
  }
}
