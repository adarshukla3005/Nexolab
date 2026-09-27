import { join } from 'path'
import { fileURLToPath } from 'url'

export async function runMigrations(): Promise<void> {
  const { default: migrate } = await import('node-pg-migrate')
  const migrationsDir = join(fileURLToPath(import.meta.url), '..', '..', 'migrations')
  await migrate({
    databaseUrl: process.env.DATABASE_URL!,
    migrationsTable: 'pgmigrations',
    dir: migrationsDir,
    direction: 'up',
    log: (msg: string) => console.log('[migrate]', msg),
  })
}
