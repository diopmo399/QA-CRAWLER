package com.ex.bff;

import com.ex.backend.client.api.DecisionsApi;
import com.ex.backend.client.model.DecisionDto;
import com.ex.demandes.model.Decision;
import com.ex.outils.Horloge;
import org.springframework.stereotype.Service;

/** Appel du Backend par le client Java généré depuis backend-client.json. */
@Service
public class DecisionGateway {
  private final DecisionsApi decisionsApi;
  private final Horloge horloge;

  public DecisionGateway(DecisionsApi decisionsApi, Horloge horloge) {
    this.decisionsApi = decisionsApi;
    this.horloge = horloge;
  }

  public void transmettre(Long demandeId, Decision decision) {
    DecisionDto dto = new DecisionDto();
    horloge.maintenant();
    decisionsApi.enregistrerDecision(dto);
  }
}
