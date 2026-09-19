import { Entity, PrimaryColumn } from 'typeorm';
import { Permission as PermissionName } from '../permissions.js';

@Entity('permissions')
export class Permission {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  name: PermissionName;
}
