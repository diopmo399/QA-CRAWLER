package com.ex.risk;

import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class ContractService {
  private static final Logger log = LoggerFactory.getLogger(ContractService.class);
  private final ContractRepository contracts;
  private final ClientRepository clients;
  @Value("${risk.limit:10}")
  private int limit;
  /** Partagé entre toutes les requêtes : écrit à chaque appel. */
  private Long lastClient;

  public ContractService(ContractRepository contracts, ClientRepository clients) {
    this.contracts = contracts;
    this.clients = clients;
  }

  public List<Contract> contractsOf(Long client) {
    this.lastClient = client;
    return contracts.findByClientId(client);
  }

  /** Deux écritures sans transaction : la seconde peut échouer après la première. */
  public void attach(Contract contract, Client client) {
    contracts.save(contract);
    clients.save(client);
  }

  @Transactional
  public void transfer(Contract contract, Client client) {
    contracts.save(contract);
    clients.save(client);
  }

  public Contract read(Long id) {
    try {
      return contracts.findById(id).orElseThrow();
    } catch (RuntimeException e) {
      log.warn("not found {}", id);
    }
    return null;
  }

  public Contract strict(Long id) {
    try {
      return contracts.findById(id).orElseThrow();
    } catch (RuntimeException e) {
      throw new IllegalStateException(e);
    }
  }
}
