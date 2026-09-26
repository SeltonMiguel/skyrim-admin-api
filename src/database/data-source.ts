import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { loadEnvironment } from '../config/environment.js';
import { createMigrationOptions } from './database.options.js';

// TypeORM CLI (development): the migration timeouts, never the API's.
export default new DataSource(createMigrationOptions(loadEnvironment()));
