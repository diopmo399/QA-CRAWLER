import { Injectable } from '@angular/core';
import { ActivationService } from './activation.service';

/** Une façade sans état : elle relaie vers le service. */
@Injectable({ providedIn: 'root' })
export class ActivationFacade {
  constructor(private service: ActivationService) {}

  activate(id: string) {
    return this.service.activate(id);
  }
}
