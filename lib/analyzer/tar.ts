/**
 * Minimal streaming tar (ustar + pax + GNU long name) reader.
 *
 * Bytes are pushed in arbitrary chunks; entry bodies are only buffered when the
 * `select` callback asks for them, so a 200 MB archive can be scanned while only
 * holding the handful of source files we care about in memory.
 */

const BLOCK = 512;

export interface TarEntryHeader {
  path: string;
  size: number;
  type: 'file' | 'dir' | 'other';
}

export interface TarCallbacks {
  /** Return true to receive this entry's body through `onFile`. */
  select(entry: TarEntryHeader): boolean;
  onFile(entry: TarEntryHeader, body: Buffer): void;
  /** pax global header (git archive puts `comment=<commit sha>` here). */
  onGlobal?(records: Record<string, string>): void;
}

type State = 'header' | 'body' | 'pad' | 'done';

interface Pending {
  header: TarEntryHeader;
  /** Raw typeflag: '0' file, 'x' pax, 'g' global pax, 'L' GNU long name... */
  flag: string;
  sink: Buffer | null;
  written: number;
}

export class TarStreamParser {
  private chunks: Buffer[] = [];
  private head = 0; // read offset into chunks[0]
  private buffered = 0;
  private state: State = 'header';
  private remaining = 0;
  private padRemaining = 0;
  private pending: Pending | null = null;
  private paxNext: Record<string, string> | null = null;
  private longName: string | null = null;
  private zeroBlocks = 0;

  constructor(private readonly cb: TarCallbacks) {}

  get finished(): boolean {
    return this.state === 'done';
  }

  push(chunk: Buffer): void {
    if (this.state === 'done' || chunk.length === 0) return;
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    this.drain();
  }

  end(): void {
    if (this.state === 'body' || (this.state === 'header' && this.buffered > 0)) {
      throw new Error('Unexpected end of tar archive');
    }
  }

  private drain(): void {
    while (this.state !== 'done') {
      if (this.state === 'header') {
        if (this.buffered < BLOCK) return;
        this.readHeader(this.take(BLOCK));
      } else if (this.state === 'body') {
        if (this.buffered === 0 && this.remaining > 0) return;
        const n = Math.min(this.remaining, this.buffered);
        const p = this.pending!;
        if (p.sink) {
          this.copyInto(p.sink, p.written, n);
          p.written += n;
        } else {
          this.skip(n);
        }
        this.remaining -= n;
        if (this.remaining === 0) this.finishEntry();
      } else {
        if (this.buffered === 0 && this.padRemaining > 0) return;
        const n = Math.min(this.padRemaining, this.buffered);
        this.skip(n);
        this.padRemaining -= n;
        if (this.padRemaining === 0) this.state = 'header';
      }
    }
  }

  private readHeader(block: Buffer): void {
    if (isZeroBlock(block)) {
      // Two consecutive zero blocks terminate the archive.
      if (++this.zeroBlocks >= 2) this.state = 'done';
      return;
    }
    this.zeroBlocks = 0;
    verifyChecksum(block);

    const flag = String.fromCharCode(block[156] || 48 /* '0' */);
    let size = readNumber(block, 124, 12);
    let path = readString(block, 0, 100);
    if (readString(block, 257, 5) === 'ustar') {
      const prefix = readString(block, 345, 155);
      if (prefix) path = `${prefix}/${path}`;
    }

    const isMeta = flag === 'x' || flag === 'g' || flag === 'L' || flag === 'K';
    if (!isMeta) {
      if (this.longName !== null) path = this.longName;
      if (this.paxNext) {
        if (this.paxNext.path) path = this.paxNext.path;
        if (this.paxNext.size) size = Number(this.paxNext.size);
      }
      this.longName = null;
      this.paxNext = null;
    }

    const type: TarEntryHeader['type'] =
      flag === '0' || flag === '\0' || flag === '7' ? 'file' : flag === '5' ? 'dir' : 'other';
    const header: TarEntryHeader = { path, size, type };
    const wanted = isMeta || (type === 'file' && this.cb.select(header));

    this.pending = { header, flag, sink: wanted ? Buffer.allocUnsafe(size) : null, written: 0 };
    this.remaining = size;
    this.padRemaining = (BLOCK - (size % BLOCK)) % BLOCK;
    if (size === 0) this.finishEntry();
    else this.state = 'body';
  }

  private finishEntry(): void {
    const p = this.pending!;
    this.pending = null;
    if (p.flag === 'x') this.paxNext = parsePax(p.sink!);
    else if (p.flag === 'g') this.cb.onGlobal?.(parsePax(p.sink!));
    else if (p.flag === 'L') this.longName = p.sink!.toString('utf8').replace(/\0+$/, '');
    else if (p.sink) this.cb.onFile(p.header, p.sink);
    this.state = this.padRemaining > 0 ? 'pad' : 'header';
  }

  /** Consume exactly n bytes (n <= buffered) into a fresh buffer. */
  private take(n: number): Buffer {
    const out = Buffer.allocUnsafe(n);
    this.copyInto(out, 0, n);
    return out;
  }

  private copyInto(target: Buffer, offset: number, n: number): void {
    let copied = 0;
    while (copied < n) {
      const chunk = this.chunks[0];
      const take = Math.min(n - copied, chunk.length - this.head);
      chunk.copy(target, offset + copied, this.head, this.head + take);
      copied += take;
      this.advance(take);
    }
  }

  private skip(n: number): void {
    while (n > 0) {
      const take = Math.min(n, this.chunks[0].length - this.head);
      n -= take;
      this.advance(take);
    }
  }

  private advance(n: number): void {
    this.head += n;
    this.buffered -= n;
    if (this.head === this.chunks[0].length) {
      this.chunks.shift();
      this.head = 0;
    }
  }
}

function isZeroBlock(block: Buffer): boolean {
  for (let i = 0; i < BLOCK; i++) if (block[i] !== 0) return false;
  return true;
}

function verifyChecksum(block: Buffer): void {
  const expected = readNumber(block, 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : block[i];
  if (sum !== expected) throw new Error('Corrupt tar header (checksum mismatch)');
}

function readString(block: Buffer, offset: number, length: number): string {
  let end = offset;
  const max = offset + length;
  while (end < max && block[end] !== 0) end++;
  return block.toString('utf8', offset, end);
}

/** Octal ASCII, or GNU base-256 when the high bit of the first byte is set. */
function readNumber(block: Buffer, offset: number, length: number): number {
  if (block[offset] & 0x80) {
    let value = block[offset] & 0x7f;
    for (let i = 1; i < length; i++) value = value * 256 + block[offset + i];
    return value;
  }
  const text = readString(block, offset, length).trim();
  return text ? parseInt(text, 8) : 0;
}

/** pax records: "<len> <key>=<value>\n" where len counts the whole record. */
function parsePax(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let pos = 0;
  while (pos < buf.length) {
    const space = buf.indexOf(0x20, pos);
    if (space < 0) break;
    const len = parseInt(buf.toString('ascii', pos, space), 10);
    if (!len) break;
    const record = buf.toString('utf8', space + 1, pos + len - 1);
    const eq = record.indexOf('=');
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    pos += len;
  }
  return out;
}
