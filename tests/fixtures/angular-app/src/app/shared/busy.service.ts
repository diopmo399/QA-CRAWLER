import { Injectable } from '@angular/core';

/** Un indicateur d'occupation partagé par tout l'écran : tant qu'il est posé, les actions sont ignorées. */
@Injectable({ providedIn: 'root' })
export class BusyService {
  locked = false;

  lock(): void {
    this.locked = true;
  }

  unlock(): void {
    this.locked = false;
  }
}
