import 'reflect-metadata';
import { loadEnvironment } from '../config/environment.js';
import {
  configFindings,
  databaseFindings,
  printFindings,
} from '../ops/preflight.checks.js';

// `npm run preflight` (before migrating: pending is a warning) and
// `npm run preflight -- --require-current` (after migrating: pending is an
// error). Exit code 1 on any ERROR. Prints no secrets.
async function main(): Promise<void> {
  let config;
  try {
    config = loadEnvironment();
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : 'Invalid configuration',
    );
    process.exitCode = 1;
    return;
  }
  const findings = [
    ...configFindings(config),
    ...(await databaseFindings(config, {
      requireCurrent: process.argv.includes('--require-current'),
    })),
  ];
  if (!printFindings(findings)) process.exitCode = 1;
}
await main();
