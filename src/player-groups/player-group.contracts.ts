// Provisional party size (leader + 4). Change here; capacity is enforced under
// the group row lock, so no migration is needed to adjust it.
export const MAX_GROUP_MEMBERS = 5;

export enum GroupStatus {
  ACTIVE = 'ACTIVE',
  DISBANDED = 'DISBANDED',
}
export enum GroupRole {
  LEADER = 'LEADER',
  MEMBER = 'MEMBER',
}
export enum GroupInviteStatus {
  PENDING = 'PENDING',
  ACCEPTED = 'ACCEPTED',
  DECLINED = 'DECLINED',
  CANCELLED = 'CANCELLED',
  EXPIRED = 'EXPIRED',
}
