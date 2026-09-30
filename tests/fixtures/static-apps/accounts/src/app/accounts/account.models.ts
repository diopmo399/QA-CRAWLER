export interface Profile {
  email: string;
  accountType: string;
}

export interface CreateAccountRequest {
  email: string;
  accountType: string;
  country: string;
  province?: string;
  taxNumber?: string;
}
