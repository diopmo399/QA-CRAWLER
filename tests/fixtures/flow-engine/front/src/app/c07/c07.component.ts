import { Component, Input, OnInit } from '@angular/core';
import { ManyAction } from './c07.api';
import { ManyStore } from './c07.store';

@Component({ selector: 'app-c07', template: '<button (click)="forward(pending)">Go</button>' })
export class ManyComponent implements OnInit {
  @Input() pending!: ManyAction;

  constructor(private store: ManyStore) {}

  ngOnInit(): void {
    this.store.saved$.subscribe();
    this.store.loaded$.subscribe();
  }

  forward(action: ManyAction): void {
    this.store.dispatch(action);
  }

  save(): void {
    this.forward({ type: 'SAVE' });
  }
}
