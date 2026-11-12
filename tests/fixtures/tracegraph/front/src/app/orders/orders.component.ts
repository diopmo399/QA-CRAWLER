import { Component, OnInit } from '@angular/core';
import { OrderStore } from './order.store';

@Component({
  selector: 'app-orders',
  templateUrl: './orders.component.html',
})
export class OrdersComponent implements OnInit {
  status = 'IDLE';
  savedId?: string;

  constructor(private store: OrderStore) {}

  ngOnInit(): void {
    this.store.state$.subscribe((state) => this.onState(state.status));
    this.store.saved$.subscribe((result) => this.onSaved(result.id));
    this.store.dispatch({ type: 'LOAD' });
  }

  submit(title: string): void {
    const s = this.store;
    s.dispatch({ type: 'VALIDATE', title });
  }

  reload(): void {
    this.store.dispatch({ type: 'LOAD' });
  }

  private onState(status: string): void {
    this.status = status;
  }

  private onSaved(id: string): void {
    this.savedId = id;
  }
}
