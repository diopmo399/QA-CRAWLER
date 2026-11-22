import { Component, OnInit } from '@angular/core';
import { LoopStore } from './c11.store';

@Component({ selector: 'app-c11', template: '<button (click)="start()">Start</button>' })
export class LoopComponent implements OnInit {
  constructor(private store: LoopStore) {}

  ngOnInit(): void {
    this.store.ping$.subscribe();
    this.store.pong$.subscribe();
  }

  start(): void {
    this.store.start();
  }

  recurse(): void {
    this.store.first(3);
  }
}
