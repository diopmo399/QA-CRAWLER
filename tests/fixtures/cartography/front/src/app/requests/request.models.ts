export interface CreateRequest {
  companyName: string;
  contactEmail: string;
}

export interface UpdateRequest {
  companyName: string;
}

export interface RequestView {
  id: number;
  companyName: string;
  contactEmail: string;
}
