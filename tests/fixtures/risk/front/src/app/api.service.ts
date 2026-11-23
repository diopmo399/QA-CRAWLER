import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../environments/environment';

export interface Client {
  id: number;
  name: string;
}

export interface Contract {
  id: number;
  clientId: number;
}

export interface Order {
  id: number;
  total: number;
}

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly base = environment.api;

  constructor(private http: HttpClient) {}

  clients(): Observable<Client[]> {
    return this.http.get<Client[]>(`${this.base}/clients`);
  }

  contracts(clientId: number): Observable<Contract[]> {
    return this.http.get<Contract[]>(`${this.base}/contracts?client=${clientId}`);
  }

  search(term: string): Observable<Client[]> {
    return this.http.get<Client[]>(`${this.base}/clients/search?q=${term}`);
  }

  saveOrder(order: Order): Observable<Order> {
    return this.http.post<Order>(`${this.base}/orders`, order);
  }
}
