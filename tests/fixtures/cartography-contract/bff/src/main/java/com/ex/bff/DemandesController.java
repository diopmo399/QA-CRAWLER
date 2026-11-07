package com.ex.bff;

import com.ex.demandes.api.DemandesApi;
import com.ex.demandes.model.Decision;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.RestController;

/** Contract-first : l'interface DemandesApi est générée au build (absente des sources). */
@RestController
public class DemandesController implements DemandesApi {
  private final DecisionGateway gateway;

  public DemandesController(DecisionGateway gateway) {
    this.gateway = gateway;
  }

  @Override
  public ResponseEntity<Void> validerDemande(Long demandeId, Decision decision) {
    gateway.transmettre(demandeId, decision);
    return ResponseEntity.ok().build();
  }

  @Override
  public ResponseEntity<Object> lireDemande(Long demandeId, Boolean details) {
    return ResponseEntity.ok().build();
  }

  /** Aucune opération du contrat ne porte ce nom : aucune route n'est déduite. */
  @Override
  public ResponseEntity<Void> archiverDemande(Long demandeId) {
    return ResponseEntity.ok().build();
  }
}
