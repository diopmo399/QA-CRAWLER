import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { CreateRequest, RequestView, UpdateRequest } from './request.models';

@Injectable({ providedIn: 'root' })
export class RequestService {
  constructor(private http: HttpClient) {}

  create(request: CreateRequest) {
    return this.http.post<RequestView>('/api/requests', request);
  }

  get(id: string) {
    return this.http.get<RequestView>(`/api/requests/${id}`);
  }

  update(id: string, request: UpdateRequest) {
    return this.http.put<RequestView>(`/api/requests/${id}`, request);
  }
}
