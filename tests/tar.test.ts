import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TarStreamParser } from '../lib/analyzer/tar';

/** Minimal ustar writer for test archives. */
function header(name: string, size: number, type: string): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.write(type, 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  h.fill(' ', 148, 156);
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}

function entry(name: string, body: Buffer | string, type = '0'): Buffer {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([header(name, data.length, type), data, pad]);
}

function pax(records: Record<string, string>): Buffer {
  const lines = Object.entries(records).map(([k, v]) => {
    const body = ` ${k}=${v}\n`;
    let len = body.length + 1;
    while (String(len).length + body.length !== len) len = String(len).length + body.length;
    return `${len}${body}`;
  });
  return Buffer.from(lines.join(''));
}

test('parses ustar, pax global/local headers and long paths across arbitrary chunk boundaries', () => {
  const longPath = `repo-abc/${'deep/'.repeat(30)}file.ts`;
  const archive = Buffer.concat([
    entry('pax_global_header', pax({ comment: 'a'.repeat(40) }), 'g'),
    entry('repo-abc/', '', '5'),
    entry('repo-abc/src/index.ts', 'export const x = 1;\n'),
    entry('PaxHeader', pax({ path: longPath }), 'x'),
    entry('ignored-name', 'export const deep = true;\n'),
    entry('repo-abc/big.bin', Buffer.alloc(5000, 7)),
    Buffer.alloc(1024),
  ]);

  for (const chunkSize of [1, 7, 512, 513, 4096, archive.length]) {
    const seen = new Map<string, string>();
    let global: Record<string, string> = {};
    const skipped: string[] = [];
    const parser = new TarStreamParser({
      select: (e) => {
        if (e.path.endsWith('.bin')) {
          skipped.push(e.path);
          return false;
        }
        return true;
      },
      onFile: (e, body) => seen.set(e.path, body.toString()),
      onGlobal: (r) => (global = r),
    });
    for (let i = 0; i < archive.length; i += chunkSize) parser.push(archive.subarray(i, i + chunkSize));
    parser.end();
    assert.equal(global.comment, 'a'.repeat(40), `chunk ${chunkSize}: global pax`);
    assert.equal(seen.get('repo-abc/src/index.ts'), 'export const x = 1;\n', `chunk ${chunkSize}: plain file`);
    assert.equal(seen.get(longPath), 'export const deep = true;\n', `chunk ${chunkSize}: pax path override`);
    assert.deepEqual(skipped, ['repo-abc/big.bin']);
    assert.ok(parser.finished);
  }
});

test('rejects corrupt headers', () => {
  const bad = entry('x.ts', 'hi');
  bad[0] ^= 0xff;
  const parser = new TarStreamParser({ select: () => true, onFile: () => {} });
  assert.throws(() => parser.push(bad), /checksum/);
});
