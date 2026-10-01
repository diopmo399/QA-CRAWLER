export enum RegistrationStatus {
  DRAFT = 'DRAFT',
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  CANCELLED = 'CANCELLED',
}

export interface Registration {
  id: string;
  name: string;
  status: RegistrationStatus;
  paidAmount: number;
  totalAmount: number;
}
