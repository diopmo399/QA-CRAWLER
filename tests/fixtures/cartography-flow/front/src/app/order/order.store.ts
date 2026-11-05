import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';
import { OrderAction, REFRESH } from './actions';
import { OrderApi } from './order-api.service';

/** Un store générique : une seule méthode d'entrée, les traitements choisis par l'action reçue. */
@Injectable({ providedIn: 'root' })
export class OrderStore {
  private readonly state = new Subject<string>();
  readonly state$ = this.state.asObservable();

  constructor(private api: OrderApi) {}

  dispatch(action: OrderAction | string, payload?: unknown): void {
    switch (action) {
      case OrderAction.Submit:
        // F : un dispatch qui en déclenche un autre, seulement si la réponse le dit.
        this.api.submit(payload).subscribe((r) => {
          if (r.ok) this.dispatch(OrderAction.Archive, r.id);
        });
        break;
      case OrderAction.Cancel:
        this.api.cancel(payload).subscribe();
        break;
      case REFRESH:
        this.api.refresh().subscribe();
        break;
      default:
        this.api.archive(payload).subscribe(() => this.state.next('archived'));
    }
  }

  /** Une action passée dans un objet : la branche dépend de `type`. */
  reduce(event: { type: OrderAction; id?: string }): void {
    if (event.type === OrderAction.Cancel) {
      this.api.cancel(event.id).subscribe();
    } else {
      this.dispatch(event.type, event.id);
    }
  }
}
