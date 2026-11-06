import { Component } from '@angular/core';
import { OrdersService } from './orders.service';

@Component({
  selector: 'app-orders',
  template: `<button (click)="open()">Open</button><button (click)="save()">Save</button>`,
})
export class OrdersComponent {
  constructor(private orders: OrdersService) {}
  open() {
    this.orders.one('1').subscribe();
    this.orders.search('x').subscribe();
  }
  save() {
    this.orders.create({}).subscribe();
    this.orders.archive('1').subscribe();
  }
}
