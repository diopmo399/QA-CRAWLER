package com.acme.common.api;
import org.springframework.web.bind.annotation.GetMapping;
/** Une route commune héritée par les contrats. */
public interface HealthApi {
  @GetMapping("/health") String health();
}
