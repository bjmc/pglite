/**
 * Minimal tar reader: regular files and directories, with ustar name prefixes,
 * GNU long names and pax path records (as written by GNU tar, and by
 * PGlite.dumpDataDir()).
 */

export interface TarEntry {
  name: string
  type: 'file' | 'directory'
  mode: number
  data: Uint8Array
}

const BLOCK = 512
const decoder = new TextDecoder()

function str(block: Uint8Array, offset: number, length: number): string {
  const field = block.subarray(offset, offset + length)
  const end = field.indexOf(0)
  return decoder.decode(end === -1 ? field : field.subarray(0, end))
}

function octal(block: Uint8Array, offset: number, length: number): number {
  return parseInt(str(block, offset, length).trim() || '0', 8)
}

function paxPath(data: Uint8Array): string | undefined {
  // records are "<length> <key>=<value>\n"
  for (const record of decoder.decode(data).split('\n')) {
    const match = /^\d+ path=(.*)$/.exec(record)
    if (match) return match[1]
  }
  return undefined
}

export function* untar(tarball: Uint8Array): Generator<TarEntry> {
  let offset = 0
  let longName: string | undefined
  while (offset + BLOCK <= tarball.length) {
    const header = tarball.subarray(offset, offset + BLOCK)
    if (header.every((b) => b === 0)) return
    const size = octal(header, 124, 12)
    const type = String.fromCharCode(header[156] || 0x30)
    const data = tarball.subarray(offset + BLOCK, offset + BLOCK + size)
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK

    if (type === 'L') {
      longName = str(data, 0, data.length)
      continue
    }
    if (type === 'x') {
      longName = paxPath(data) ?? longName
      continue
    }
    if (type === 'g') continue

    let name = str(header, 0, 100)
    if (str(header, 257, 6) === 'ustar') {
      const prefix = str(header, 345, 155)
      if (prefix) name = prefix + '/' + name
    }
    if (longName !== undefined) {
      name = longName
      longName = undefined
    }
    const mode = octal(header, 100, 8)
    if (type === '0' || type === '7') {
      yield { name, type: 'file', mode, data }
    } else if (type === '5') {
      yield { name, type: 'directory', mode, data }
    } else {
      throw new Error(`unsupported tar entry type '${type}': ${name}`)
    }
  }
}
