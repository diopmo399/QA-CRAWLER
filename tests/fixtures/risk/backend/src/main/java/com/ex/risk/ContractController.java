package com.ex.risk;

import java.util.List;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api")
public class ContractController {
  private final ContractService service;

  public ContractController(ContractService service) {
    this.service = service;
  }

  @GetMapping("/contracts")
  public List<Contract> contracts(@RequestParam("client") Long client) {
    return service.contractsOf(client);
  }
}
