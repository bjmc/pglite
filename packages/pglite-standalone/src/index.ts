import { readFile } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { WASI } from 'node:wasi'
import { untar } from './tar.js'

/**
 * Reference host for the standalone PGlite WASM module (built by
 * postgres-pglite/build-pglite-standalone.sh), using Node's WASI implementation.
 *
 * The module has no JS glue: it only needs a WASI preview1 implementation and
 * the small "pglite" import module below, so it can equally be hosted from
 * Wasmtime, Wasmer, etc. This host mirrors the startup sequence and
 * execProtocolRawSync() of the regular PGlite class.
 *
 * Requires native wasm exception handling with exnref: Node >= 22 with
 * --experimental-wasm-exnref.
 */

export const PGDATA = '/pglite/data'
const PGLITE_EXIT_ALIVE = 99
const POSTGRES_MAIN_LONGJMP = 100

export const defaultStartParams = [
  '--single',
  '-F',
  '-O',
  '-j',
  '-c',
  'search_path=public',
  '-c',
  'exit_on_error=false',
  '-c',
  'log_checkpoints=false',
  '-c',
  'max_worker_processes=0',
  '-c',
  'max_parallel_workers=0',
  '-c',
  'max_parallel_workers_per_gather=0',
  '-c',
  'io_method=sync',
  '-c',
  'max_parallel_maintenance_workers=0',
  // there is no /dev/shm; sysv shared memory is emulated in-process by pglitec.c
  '-c',
  'dynamic_shared_memory_type=sysv',
]

export const defaultEnv: Record<string, string> = {
  HOME: '/home/postgres',
  USER: 'postgres',
  LOGNAME: 'postgres',
  PGDATA,
  PGUSER: 'postgres',
  PGDATABASE: 'postgres',
  LANG: 'en_US.UTF-8',
  LC_COLLATE: 'en_US.UTF-8',
  LC_CTYPE: 'en_US.UTF-8',
  TZ: 'UTC',
  PGTZ: 'UTC',
  PGCLIENTENCODING: 'UTF8',
  ICU_DATA: '/pglite/icu',
}

export interface StandaloneOptions {
  /** The compiled standalone module (pglite-standalone.wasm) */
  module: WebAssembly.Module
  /**
   * Tarballs (optionally gzipped) to unpack into the in-memory filesystem before
   * startup, with paths relative to "/", e.g. the runtime filesystem
   * (pglite-standalone-fs.tar.gz).
   */
  fs: Uint8Array[]
  /** Tarball holding the contents of an initialized PGDATA (e.g. from PGlite.dumpDataDir) */
  dataDir?: Uint8Array
  startParams?: string[]
  env?: Record<string, string>
}

interface Exports {
  memory: WebAssembly.Memory
  _initialize(): void
  malloc(size: number): number
  free(ptr: number): void
  pgl_fs_mkdir(path: number, mode: number): number
  pgl_fs_write_file(
    path: number,
    buf: number,
    len: number,
    mode: number,
  ): number
  pgl_setPGliteActive(value: number): number
  pgl_setPGliteExitStatus(value: number): number
  pgl_call_main(argc: number, argv: number): number
  pgl_loop_once(): number
  pgl_longjmp_recover(): number
  pgl_startPGlite(): void
  pgl_getMyProcPort(): number
  pgl_sendConnData(): void
  pgl_pq_flush(): void
  ProcessStartupPacket(port: number, sslDone: number, gssDone: number): number
  PostgresSendReadyForQueryIfNecessary(): void
  pq_buffer_remaining_data(): number
}

export async function loadModule(path: string): Promise<WebAssembly.Module> {
  return WebAssembly.compile(await readFile(path))
}

export class StandalonePGlite {
  #ex!: Exports
  #input = new Uint8Array(0)
  #readOffset = 0
  #output: Uint8Array[] = []
  #dirs = new Set<string>()

  private constructor() {}

  static async create(opts: StandaloneOptions): Promise<StandalonePGlite> {
    const env = { ...defaultEnv, ...opts.env }
    const wasi = new WASI({ version: 'preview1', env })
    const self = new StandalonePGlite()
    const instance = await WebAssembly.instantiate(opts.module, {
      wasi_snapshot_preview1: wasi.wasiImport,
      env: { emscripten_notify_memory_growth: () => {} },
      pglite: {
        read: (ptr: number, max: number) => self.#hostRead(ptr, max),
        write: (ptr: number, len: number) => self.#hostWrite(ptr, len),
      },
    })
    self.#ex = instance.exports as unknown as Exports
    wasi.initialize(instance)
    for (const tarball of opts.fs) self.#loadTar(tarball, '/')
    if (opts.dataDir) self.#loadTar(opts.dataDir, PGDATA)
    self.#start(opts.startParams ?? defaultStartParams, env.PGDATABASE)
    return self
  }

  get #heap() {
    return new Uint8Array(this.#ex.memory.buffer)
  }

  #hostRead(ptr: number, max: number): number {
    const chunk = this.#input.subarray(this.#readOffset, this.#readOffset + max)
    this.#heap.set(chunk, ptr)
    this.#readOffset += chunk.length
    return chunk.length
  }

  #hostWrite(ptr: number, len: number): number {
    this.#output.push(this.#heap.slice(ptr, ptr + len))
    return len
  }

  #cstr(s: string): number {
    const bytes = new TextEncoder().encode(s + '\0')
    const ptr = this.#ex.malloc(bytes.length)
    this.#heap.set(bytes, ptr)
    return ptr
  }

  #mkdir(path: string) {
    if (this.#dirs.has(path)) return
    const p = this.#cstr(path)
    const rc = this.#ex.pgl_fs_mkdir(p, 0o700)
    this.#ex.free(p)
    if (rc !== 0) throw new Error(`mkdir ${path} failed (${rc})`)
    this.#dirs.add(path)
  }

  #mkdirs(path: string) {
    const parts = path.split('/').filter(Boolean)
    for (let i = 1; i <= parts.length; i++) {
      this.#mkdir('/' + parts.slice(0, i).join('/'))
    }
  }

  #loadTar(tarball: Uint8Array, prefix: string) {
    const data =
      tarball[0] === 0x1f && tarball[1] === 0x8b ? gunzipSync(tarball) : tarball
    for (const entry of untar(data)) {
      const rel = entry.name.replace(/^\.?\/+/, '').replace(/\/+$/, '')
      if (!rel) continue
      const path = (prefix === '/' ? '' : prefix) + '/' + rel
      this.#mkdirs(path.slice(0, path.lastIndexOf('/')))
      if (entry.type === 'directory') {
        this.#mkdir(path)
        continue
      }
      const p = this.#cstr(path)
      const buf = this.#ex.malloc(Math.max(entry.data.length, 1))
      this.#heap.set(entry.data, buf)
      const rc = this.#ex.pgl_fs_write_file(
        p,
        buf,
        entry.data.length,
        entry.mode & 0o777 || 0o600,
      )
      this.#ex.free(buf)
      this.#ex.free(p)
      if (rc !== 0) throw new Error(`writing ${path} failed (${rc})`)
    }
  }

  #start(startParams: string[], database: string) {
    const args = [
      '/pglite/bin/postgres',
      ...startParams,
      '-D',
      PGDATA,
      database,
    ]
    const ptrs = args.map((a) => this.#cstr(a))
    const argv = this.#ex.malloc(4 * (ptrs.length + 1))
    new Uint32Array(this.#ex.memory.buffer, argv, ptrs.length + 1).set([
      ...ptrs,
      0,
    ])
    this.#ex.pgl_setPGliteActive(1)
    this.#ex.pgl_call_main(args.length, argv)
    const status = this.#ex.pgl_setPGliteExitStatus(-3)
    if (status !== PGLITE_EXIT_ALIVE) {
      throw new Error(`PGlite failed to initialize properly (${status})`)
    }
    this.#ex.pgl_startPGlite()
  }

  /**
   * Execute one or more complete frontend protocol messages and return the
   * backend's response, like PGlite.execProtocolRawSync().
   */
  execProtocolRaw(message: Uint8Array): Uint8Array {
    const ex = this.#ex
    this.#input = message
    this.#readOffset = 0
    this.#output = []

    if (message[0] === 'X'.charCodeAt(0)) return new Uint8Array(0)

    if (message[0] === 0) {
      // startup packet
      if (ex.ProcessStartupPacket(ex.pgl_getMyProcPort(), 1, 1) !== 0) {
        throw new Error('Cannot process startup packet')
      }
      ex.pgl_sendConnData()
      ex.pgl_pq_flush()
    } else {
      try {
        while (
          this.#readOffset < message.length ||
          ex.pq_buffer_remaining_data() > 0
        ) {
          if (ex.pgl_loop_once() !== 0) {
            // unwound to the host: a top level error longjmp
            if (ex.pgl_setPGliteExitStatus(-2) === POSTGRES_MAIN_LONGJMP) {
              ex.pgl_longjmp_recover()
            }
          }
        }
      } finally {
        ex.PostgresSendReadyForQueryIfNecessary()
        ex.pgl_pq_flush()
      }
    }

    this.#input = new Uint8Array(0)
    const out = new Uint8Array(this.#output.reduce((n, c) => n + c.length, 0))
    let offset = 0
    for (const chunk of this.#output) {
      out.set(chunk, offset)
      offset += chunk.length
    }
    this.#output = []
    return out
  }
}
