import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

@Entity('game_servers')
@Unique('game_servers_code_key', ['code'])
export class GameServer {
  @PrimaryGeneratedColumn('uuid')
  id: string;
  @Column({ name: 'code', type: 'varchar', length: 64 })
  code: string;
  @Column({ name: 'name', type: 'varchar', length: 100 })
  name: string;
  @Column({ name: 'enabled', type: 'boolean', default: true })
  enabled: boolean;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
