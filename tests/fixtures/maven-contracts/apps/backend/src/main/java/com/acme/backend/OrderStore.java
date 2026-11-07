package com.acme.backend;

import com.acme.orders.api.OrderDto;
import org.springframework.stereotype.Service;

@Service
public class OrderStore {
  public OrderDto find(String id) { return new OrderDto(); }
  public OrderDto save(OrderDto dto) { return dto; }
  public void remove(String id) { }
}
