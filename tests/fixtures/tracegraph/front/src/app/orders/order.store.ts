import { Injectable } from '@angular/core';
import { BehaviorSubject, Subject, filter, switchMap } from 'rxjs';
import { OrderApi } from './order.api';
import { OrderAction, OrderState } from './order.models';

/** Un store maison : dispatch(action) aiguille par type ; un Subject d'actions partagé, filtré par type. */
@Injectable({ providedIn: 'root' })
export class OrderStore {
  private readonly state = new BehaviorSubject<OrderState>({ status: 'IDLE', items: [] });
  readonly state$ = this.state.asObservable();
  private readonly actions = new Subject<OrderAction>();
  readonly saved$ = this.actions.pipe(
    filter((a) => a.type === 'SAVE'),
    switchMap((a) => this.api.create(a.type === 'SAVE' ? a.title : '')),
  );

  constructor(private api: OrderApi) {}

  dispatch(action: OrderAction): void {
    switch (action.type) {
      case 'LOAD':
        this.load();
        break;
      case 'SAVE':
        this.actions.next(action);
        break;
      case 'VALIDATE':
        this.validate(action.title);
        break;
    }
  }

  private load(): void {
    this.api.list().subscribe((items) => this.state.next({ status: 'LOADED', items }));
  }

  private validate(title: string): void {
    if (title.length > 0) this.dispatch({ type: 'SAVE', title });
    else this.state.next({ status: 'INVALID', items: [] });
  }
}
