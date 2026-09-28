import { describe, it, expect, beforeAll } from 'vitest'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { Parser, serialize } from '@electric-sql/pg-protocol'
import type { BackendMessage } from '@electric-sql/pg-protocol/messages'
import { StandalonePGlite, loadModule } from '../src/index.js'

const RELEASE = new URL('../release/', import.meta.url)
const WASM = new URL('pglite-standalone.wasm', RELEASE)
const FS = new URL('pglite-standalone-fs.tar.gz', RELEASE)

interface Result {
  rows: (string | null)[][]
  error?: { code: string; message: string }
  status: string
}

/** Run a simple query and collect the parts of the response we check */
function query(pg: StandalonePGlite, sql: string): Result {
  const result: Result = { rows: [], status: '' }
  new Parser().parse(
    pg.execProtocolRaw(serialize.query(sql)),
    (msg: BackendMessage) => {
      if (msg.name === 'dataRow') result.rows.push((msg as any).fields)
      if (msg.name === 'error') {
        result.error = {
          code: (msg as any).code,
          message: (msg as any).message,
        }
      }
      if (msg.name === 'readyForQuery') result.status = (msg as any).status
    },
  )
  return result
}

describe.skipIf(!existsSync(WASM))('standalone module', () => {
  let module: WebAssembly.Module
  let fs: Uint8Array
  let dataDir: Uint8Array

  beforeAll(async () => {
    module = await loadModule(WASM.pathname)
    fs = await readFile(FS)
    // an initialized PGDATA, from the regular (JS) build of the same sources
    const pg = await PGlite.create()
    await pg.exec(`CREATE TABLE from_js (id int, name text);
                   INSERT INTO from_js VALUES (1, 'created by the JS build');`)
    dataDir = new Uint8Array(await (await pg.dumpDataDir('none')).arrayBuffer())
    await pg.close()
  })

  async function start() {
    const pg = await StandalonePGlite.create({ module, fs: [fs], dataDir })
    const messages: string[] = []
    new Parser().parse(
      pg.execProtocolRaw(
        serialize.startup({ user: 'postgres', database: 'postgres' }),
      ),
      (msg: BackendMessage) => messages.push(msg.name),
    )
    expect(messages).toContain('authenticationOk')
    expect(messages.at(-1)).toBe('readyForQuery')
    return pg
  }

  it('runs a query', async () => {
    const pg = await start()
    expect(query(pg, 'SELECT 1')).toEqual({ rows: [['1']], status: 'I' })
    expect(query(pg, 'SELECT version()').rows[0][0]).toMatch(/^PostgreSQL 18/)
  })

  it('reads a data dir created by the JS build', async () => {
    const pg = await start()
    expect(query(pg, 'SELECT * FROM from_js').rows).toEqual([
      ['1', 'created by the JS build'],
    ])
  })

  it('recovers from errors', async () => {
    const pg = await start()
    const err = query(pg, 'SELECT 1/0')
    expect(err.error).toEqual({ code: '22012', message: 'division by zero' })
    expect(err.status).toBe('I')
    expect(query(pg, 'SELECT 2').rows).toEqual([['2']])
  })

  it('recovers from errors in functions and subtransactions', async () => {
    const pg = await start()
    query(
      pg,
      `CREATE FUNCTION div(a int, b int) RETURNS int LANGUAGE sql AS 'SELECT a / b'`,
    )
    query(pg, 'CREATE TABLE s (x int)')
    query(pg, 'BEGIN')
    query(pg, 'INSERT INTO s VALUES (1)')
    query(pg, 'SAVEPOINT sp')
    const err = query(pg, 'INSERT INTO s VALUES (div(1, 0))')
    expect(err.error?.code).toBe('22012')
    expect(err.status).toBe('E')
    expect(query(pg, 'ROLLBACK TO SAVEPOINT sp').status).toBe('T')
    query(pg, 'INSERT INTO s VALUES (div(4, 2))')
    expect(query(pg, 'COMMIT').status).toBe('I')
    expect(query(pg, 'SELECT x FROM s ORDER BY x').rows).toEqual([['1'], ['2']])
  })

  it('keeps transaction semantics across errors', async () => {
    const pg = await start()
    query(pg, 'CREATE TABLE t (id serial primary key, name text)')
    expect(query(pg, 'BEGIN').status).toBe('T')
    query(pg, `INSERT INTO t (name) VALUES ('rolled back')`)
    expect(query(pg, 'SELECT nope').status).toBe('E')
    expect(query(pg, 'SELECT 1').error?.code).toBe('25P02')
    expect(query(pg, 'ROLLBACK').status).toBe('I')
    query(pg, `INSERT INTO t (name) VALUES ('kept')`)
    expect(query(pg, 'SELECT id, name FROM t').rows).toEqual([['2', 'kept']])
  })

  it('handles multiple statements in one message', async () => {
    const pg = await start()
    const res = query(pg, 'SELECT 1; SELECT 1/0; SELECT 3')
    expect(res.rows).toEqual([['1']])
    expect(res.error?.code).toBe('22012')
    expect(res.status).toBe('I')
  })

  it('runs isolated instances side by side', async () => {
    const a = await start()
    const b = await start()
    query(a, 'CREATE TABLE only_in_a (x int)')
    expect(query(b, 'SELECT * FROM only_in_a').error?.code).toBe('42P01')
    expect(query(a, 'SELECT count(*) FROM only_in_a').rows).toEqual([['0']])
  })
})
