import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { loadEnvironment } from '../config/environment.js';
import { createDatabaseOptions } from './database.options.js';

export default new DataSource(createDatabaseOptions(loadEnvironment()));
