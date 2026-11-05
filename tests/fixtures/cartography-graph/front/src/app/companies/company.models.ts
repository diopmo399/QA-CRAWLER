export interface NewCompany {
  companyName: string;
  companyId: string;
}

export interface CompanyQuery {
  query: string;
}

export interface CompanyChange {
  companyName: string;
  status: string;
}
