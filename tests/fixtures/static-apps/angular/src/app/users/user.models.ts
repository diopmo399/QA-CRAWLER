export interface CreateUserRequest {
  firstName: string;
  email: string;
  backupEmail?: string;
}

export interface User {
  id: string;
  email: string;
}
