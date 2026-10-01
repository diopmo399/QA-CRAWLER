import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Registration } from './registration.models';

@Injectable({ providedIn: 'root' })
export class RegistrationService {
  constructor(private http: HttpClient) {}

  list() {
    return this.http.get<Registration[]>('/api/registrations');
  }

  get(id: string) {
    return this.http.get<Registration>(`/api/registrations/${id}`);
  }

  submit(id: string) {
    return this.http.patch<Registration>(`/api/registrations/${id}`, { status: 'PENDING' });
  }

  approve(id: string) {
    return this.http.patch<Registration>(`/api/registrations/${id}`, { status: 'APPROVED' });
  }

  reject(id: string) {
    return this.http.patch<Registration>(`/api/registrations/${id}`, { status: 'REJECTED' });
  }

  cancel(id: string) {
    return this.http.patch<Registration>(`/api/registrations/${id}`, { status: 'CANCELLED' });
  }

  pay(registration: Registration, amount: number) {
    if (registration.paidAmount + amount > registration.totalAmount) {
      throw new Error('paid amount cannot exceed the total');
    }
    return this.http.post(`/api/registrations/${registration.id}/payments`, { amount });
  }
}
