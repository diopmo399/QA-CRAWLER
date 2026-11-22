import { Component, OnInit } from '@angular/core';
import { MappedStore } from './c05.store';

@Component({ selector: 'app-c05', template: '<button (click)="save()">Save</button>' })
export class MappedComponent implements OnInit {
  constructor(private store: MappedStore) {}

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

  validate(): void {
    this.store.dispatch({ type: 'VALIDATE' });
  }
}
