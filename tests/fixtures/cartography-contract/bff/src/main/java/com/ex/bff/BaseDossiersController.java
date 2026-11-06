package com.ex.bff;

import com.ex.dossiers.api.DossiersApi;
import org.springframework.http.ResponseEntity;

/** Implémentation indirecte : la classe concrète hérite de cette base. */
public abstract class BaseDossiersController implements DossiersApi {
  @Override
  public ResponseEntity<Object> lireDossier(Integer dossierId) {
    return ResponseEntity.ok().build();
  }
}
