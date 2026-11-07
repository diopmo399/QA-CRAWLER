package com.ex.bff;

import com.ex.referentiel.client.api.CodesApi;
import org.springframework.stereotype.Service;

@Service
public class ReferentielService {
  private final CodesApi codesApi;

  public ReferentielService(CodesApi codesApi) {
    this.codesApi = codesApi;
  }

  public String code(String code) {
    return codesApi.lireCode(code);
  }
}
