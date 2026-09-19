import { globSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Import in this Jest ESM context. TypeORM's eval-based glob importer can retain
// the first suite's VM context and fail after that environment is torn down.
// Keep exercising the actual compiled entities and migrations from dist.
export async function compiledDatabaseArtifacts() {
  const load = async (pattern: string): Promise<Function[]> => {
    const modules = await Promise.all(
      globSync(pattern).map(
        (path) =>
          import(pathToFileURL(path).href) as Promise<Record<string, unknown>>,
      ),
    );
    return modules.flatMap((module) =>
      Object.values(module).filter(
        (value): value is Function => typeof value === 'function',
      ),
    );
  };
  const [entities, migrations] = await Promise.all([
    load(fileURLToPath(new URL('../dist/**/*.entity.js', import.meta.url))),
    load(
      fileURLToPath(
        new URL('../dist/database/migrations/*.js', import.meta.url),
      ),
    ),
  ]);
  return { entities, migrations };
}
