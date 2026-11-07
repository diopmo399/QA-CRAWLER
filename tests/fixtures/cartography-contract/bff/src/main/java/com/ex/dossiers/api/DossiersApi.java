package com.ex.dossiers.api;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestMethod;

/** Interface générée, versionnée avec les sources. */
@RequestMapping("${openapi.dossiers.base-path:}")
public interface DossiersApi {
  @RequestMapping(method = RequestMethod.GET, value = "/dossiers/{dossierId}", produces = { "application/json" })
  default ResponseEntity<Object> lireDossier(@PathVariable("dossierId") Integer dossierId) {
    return ResponseEntity.status(501).build();
  }
}
