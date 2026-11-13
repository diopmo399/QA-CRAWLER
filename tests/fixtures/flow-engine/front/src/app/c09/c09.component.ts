import { Component, OnInit } from '@angular/core';
import { ShapeStore } from './c09.store';

@Component({ selector: 'app-c09', template: '<button (click)="save()">Save</button>' })
export class ShapeComponent implements OnInit {
  constructor(private store: ShapeStore) {}

  ngOnInit(): void {
    this.store.forced$.subscribe();
    this.store.opaque$.subscribe();
    this.store.paired$.subscribe();
  }

  save(): void {
    this.store.dispatch({ type: 'SAVE' });
  }

  reload(): void {
    this.store.dispatch({ type: 'LOAD' });
  }
}
