import { Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import type { Relation } from 'typeorm';
import { Role } from './role.entity.js';
import { Permission } from './permission.entity.js';
import { RoleName } from '../roles.js';
import { Permission as PermissionName } from '../permissions.js';

@Entity('role_permissions')
export class RolePermission {
  @PrimaryColumn({ name: 'role_name', type: 'varchar', length: 32 })
  roleName: RoleName;

  @PrimaryColumn({ name: 'permission_name', type: 'varchar', length: 64 })
  permissionName: PermissionName;

  @ManyToOne(() => Role, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'role_name',
    foreignKeyConstraintName: 'role_permissions_role_name_fkey',
  })
  role: Relation<Role>;

  @ManyToOne(() => Permission, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'permission_name',
    foreignKeyConstraintName: 'role_permissions_permission_name_fkey',
  })
  permission: Relation<Permission>;
}
