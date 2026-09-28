# PGlite standalone

PGlite built as a standalone WASM module, for hosts other than JS runtimes: it needs no emscripten JS glue, only a [WASI preview1](https://github.com/WebAssembly/WASI/blob/main/legacy/preview1/docs.md) implementation and three small host functions. It runs on Wasmtime and other WASI runtimes, and on Node via `node:wasi`, and can be embedded from any language with such a runtime.

The typical use is a throwaway, in-memory Postgres, for example in test suites of applications written in other languages. The module is the same PostgreSQL 18 single-user backend as PGlite, with the same limitations (one connection at a time).

This package contains:

- `src/index.ts`: a reference host for Node, and the tests. It mirrors what the `PGlite` class does.
- `release/`: the build output, created by `pnpm wasm:build:standalone` in the repository root (see "Standalone build" in `postgres-pglite/README-PGLITE-DEV.md`):
  - `pglite-standalone.wasm`, the module
  - `pglite-standalone-fs.tar.gz`, the runtime filesystem (`share/postgresql`, ICU data, ...)

## Runtime requirements

The module uses native wasm exception handling with the `exnref` encoding:

- Wasmtime: enable `wasm_exceptions` in the engine config
- Node >= 22: `--experimental-wasm-exnref`

## Host interface

### Imports

| Import | Signature | |
| --- | --- | --- |
| `wasi_snapshot_preview1.*` | | Only stdio, environment, clock and random functions are used. No preopened directories are needed: the filesystem is in memory. |
| `pglite.read` | `(ptr: i32, max_len: i32) -> i32` | Copy up to `max_len` bytes of pending frontend (client) protocol data to `ptr`; return the number of bytes copied. |
| `pglite.write` | `(ptr: i32, len: i32) -> i32` | Consume `len` bytes of backend (server) protocol data at `ptr`; return `len`. |
| `env.emscripten_notify_memory_growth` | `(i32) -> ()` | Called when the memory grows; can be a no-op. |

### Exports

In addition to `memory`, `malloc` and `free`:

| Export | |
| --- | --- |
| `_initialize()` | WASI reactor initialization; call first. |
| `pgl_fs_mkdir(path, mode) -> i32` | Create a directory in the in-memory filesystem. Returns 0, or a negative errno. |
| `pgl_fs_write_file(path, buf, len, mode) -> i32` | Create a file in the in-memory filesystem. Returns 0, or a negative errno. |
| `pgl_setPGliteActive(1)` | Must be called before `pgl_call_main`. |
| `pgl_call_main(argc, argv) -> i32` | Run `main()` (single-user startup). |
| `pgl_setPGliteExitStatus(value) -> i32` | Set the exit status, returning the previous one. |
| `pgl_startPGlite()` | Finish setting up the backend, after `pgl_call_main`. |
| `pgl_getMyProcPort() -> i32`, `ProcessStartupPacket(port, 1, 1) -> i32`, `pgl_sendConnData()` | Handle the client startup packet. |
| `pgl_loop_once() -> i32` | Process one frontend message. |
| `pgl_longjmp_recover() -> i32` | Recover from an error (the top level of Postgres' error handling). |
| `pq_buffer_remaining_data() -> i32` | Bytes read from the host but not yet processed. |
| `PostgresSendReadyForQueryIfNecessary()`, `pgl_pq_flush()` | Finish a response. |

`pgl_call_main`, `pgl_loop_once` and `pgl_longjmp_recover` return 1 when Postgres gave control back to the host in the middle of the call (the equivalent of emscripten's "unwind" in the JS build), and 0 otherwise.

### Protocol

**Startup**

1. Instantiate the module and call `_initialize()`.
2. Populate the filesystem: unpack `pglite-standalone-fs.tar.gz` at `/`, and an initialized data directory at `/pglite/data`. The data directory can come from the JS build, e.g. `PGlite.dumpDataDir()`.
3. Set the environment (through WASI) as in `defaultEnv` in `src/index.ts`, in particular `PGDATA=/pglite/data`.
4. Call `pgl_setPGliteActive(1)`, then `pgl_call_main()` with `argv` = `/pglite/bin/postgres`, the `defaultStartParams` from `src/index.ts`, `-D /pglite/data` and the database name. It returns after startup, and `pgl_setPGliteExitStatus(-3)` must then return 99.
5. Call `pgl_startPGlite()`.

**Exchanging messages**

The host passes whole frontend messages, and receives the backend's response:

- **Startup packet** (first byte 0): make the packet available to `pglite.read`, call `ProcessStartupPacket(pgl_getMyProcPort(), 1, 1)` (0 is success), then `pgl_sendConnData()` and `pgl_pq_flush()`.
- **Terminate** (`X`): ignore it.
- **Any other message**:
  1. Make it available to `pglite.read`.
  2. While not all of it has been read, or `pq_buffer_remaining_data() > 0`, call `pgl_loop_once()`. If that returns 1 and `pgl_setPGliteExitStatus(-2)` returns 100, call `pgl_longjmp_recover()`.
  3. Finally, call `PostgresSendReadyForQueryIfNecessary()` and `pgl_pq_flush()`.

Whatever was passed to `pglite.write` during a call is the response.

**Instances**

Each instance is independent, so a host can run as many as it likes, one per database.

## Limitations

- **No extensions.** Nothing can be loaded dynamically, and that includes `plpgsql`.
- **Timeouts never fire.** There are no signals, so `statement_timeout`, `lock_timeout` and similar settings have no effect.
- **In-memory only.** The data directory is lost when the instance is dropped.
