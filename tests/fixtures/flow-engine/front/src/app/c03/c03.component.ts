import { Component, OnInit } from '@angular/core';
import { InitStore } from './c03.store';

@Component({ selector: 'app-c03', template: '<button (click)="validate()">Validate</button>' })
export class InitComponent implements OnInit {
  constructor(private store: InitStore) {}

  ngOnInit(): void {
    this.store.validation$.subscribe((result) => {
      if (result.valid) {
        this.submit();
      }
    });
  }

  validate(): void {
    this.store.dispatch({ type: 'VALIDATE' });
  }

  submit(): void {
    this.store.dispatch({ type: 'SAVE' });
  }
}
