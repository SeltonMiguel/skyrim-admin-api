import { Entity, PrimaryColumn } from 'typeorm';
import { RoleName } from '../roles.js';

@Entity('roles')
export class Role {
  @PrimaryColumn({ type: 'varchar', length: 32 })
  name: RoleName;
}
