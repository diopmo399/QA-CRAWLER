package com.ex.risk;

import java.util.List;
import org.springframework.data.jpa.repository.JpaRepository;

public interface ContractRepository extends JpaRepository<Contract, Long> {
  List<Contract> findByClientId(Long clientId);
}
