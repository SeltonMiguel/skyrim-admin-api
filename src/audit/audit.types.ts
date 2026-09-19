import type { RoleName } from '../rbac/roles.js';

export enum AuditAction {
  STAFF_CREATE = 'STAFF_CREATE',
  STAFF_UPDATE = 'STAFF_UPDATE',
  STAFF_ROLE_CHANGE = 'STAFF_ROLE_CHANGE',
  STAFF_STATUS_CHANGE = 'STAFF_STATUS_CHANGE',
  AUTH_LOGIN = 'AUTH_LOGIN',
  AUTH_LOGOUT = 'AUTH_LOGOUT',
  COORDINATOR_BOOTSTRAP = 'COORDINATOR_BOOTSTRAP',
}
export enum AuditOutcome {
  SUCCESS = 'SUCCESS',
  FAILURE = 'FAILURE',
}
export enum AuditResource {
  STAFF_USER = 'STAFF_USER',
  STAFF_SESSION = 'STAFF_SESSION',
}
export interface AuditActor {
  id: string;
  username: string;
  displayName: string;
  roleName: RoleName;
}
export type AuditMetadata = Record<string, unknown>;
export interface AuditEvent {
  actor?: AuditActor;
  action: AuditAction;
  resourceType?: AuditResource;
  resourceId?: string;
  metadata?: AuditMetadata;
  statusCode?: number;
}
export interface AuditResult<T> {
  value: T;
  actor?: AuditActor;
  resourceId?: string;
  metadata?: AuditMetadata;
}
