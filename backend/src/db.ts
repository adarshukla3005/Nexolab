import pg from 'pg'

const { Pool } = pg

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required')
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL })

// Using `any` here because pg's QueryResultRow constraint is overly strict with ESM
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function query<T = Record<string, any>>(
  sql: string,
  params?: unknown[],
): Promise<{ rows: T[]; rowCount: number | null }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return pool.query(sql, params as any) as any
}

export async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}
