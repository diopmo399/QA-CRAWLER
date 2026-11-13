import { Component, OnInit } from '@angular/core';
import { NamedStore } from './c06.store';

@Component({ selector: 'app-c06', template: '<button (click)="save()">Save</button>' })
export class NamedComponent implements OnInit {
  constructor(private store: NamedStore) {}

  ngOnInit(): void {
    this.store.saved$.subscribe();
    this.store.loaded$.subscribe();
    this.store.rejected$.subscribe();
  }

  save(): void {
    this.store.dispatch({ type: 'SAVE' });
  }

  reload(): void {
    this.store.dispatch({ type: 'LOAD' });
  }

  reject(): void {
    this.store.dispatch({ type: 'REJECT' });
  }
}
