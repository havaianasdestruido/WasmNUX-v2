import assert from 'node:assert/strict';
import test from 'node:test';
import {BlockDevice} from '../../host/storage/opfs.mjs';
import {layout} from '../../host/terminal/text.mjs';

function fakeDirectory() {
  const chunks = new Map();
  let flushes = 0, handles = 0, failWrites = false;
  return {
    get flushes() { return flushes; }, get handles() { return handles; },
    limit() { failWrites = true; },
    async getFileHandle(name, {create}) {
      if (!chunks.has(name) && !create) throw new DOMException('missing chunk', 'NotFoundError');
      if (!chunks.has(name)) chunks.set(name, {bytes:new Uint8Array(4096), length:0});
      const file = chunks.get(name);
      return {async createSyncAccessHandle() {
        handles++;
        return {
          read(dst, {at}) { const count = Math.min(1024, file.length-at, dst.length); if (count <= 0) return 0; dst.set(file.bytes.subarray(at,at+count)); return count; },
          write(src, {at}) {
            if (failWrites) throw new DOMException('quota exceeded', 'QuotaExceededError');
            const count = Math.min(1024,src.length);
            file.bytes.set(src.subarray(0,count),at); file.length = Math.max(file.length,at+count); return count;
          },
          flush() { flushes++; }, close() { handles--; }
        };
      }};
    }
  };
}

test('block device splits sector requests, retries short IO, zero-fills and closes', async () => {
  const dir = fakeDirectory(), b = new BlockDevice(dir, 12288,4096);
  const bytes = new Uint8Array(8192); bytes.fill(6,0,4096); bytes.fill(23,4096);
  await b.write(4096,bytes); b.flush(); assert.equal(dir.flushes,2);
  const target = new Uint8Array(12288).fill(55);
  await b.read(0,target);
  assert.ok(target.subarray(0,4096).every(x => x===0));
  assert.deepEqual(target.subarray(4096),bytes);
  await assert.rejects(b.read(1,target),RangeError);
  await assert.rejects(b.read(8192,bytes),RangeError);
  b.close(); assert.equal(dir.handles,0); await assert.rejects(b.read(0, target), /closed/);
});
test('quota errors propagate without changing the previously flushed control sector', async () => {
  const dir = fakeDirectory(), b = new BlockDevice(dir, 8192,4096);
  const data = new Uint8Array(4096).fill(1);
  await b.write(0,data); b.flush(); dir.limit();
  await assert.rejects(b.write(4096,data), {name:'QuotaExceededError'});
  const read = new Uint8Array(4096); await b.read(0,read); assert.deepEqual(read,data);
  b.close(); assert.equal(dir.handles,0);
});
test('graphemes, ligature spans and wide cells preserve columns', () => {
  const shaped = layout('fi界e\u0301👩‍💻🇧🇷');
  assert.deepEqual(shaped.map(({col,cells})=>[col,cells]), [[0,2],[2,2],[4,1],[5,2],[7,2]]);
  assert.deepEqual(layout('fi', {ligatures:false}).map(x=>x.text), ['f','i']);
  assert.deepEqual(layout('fi\u0301').map(x=>x.text), ['f','i\u0301']);
});

test('IWA fixture advertises policy and local TCP/UDP echo endpoints', {timeout:3000}, async () => {
  const [{startIwaFixture}, {createConnection}, {createSocket}, {once}] = await Promise.all([
    import('../../web/iwa/serve.mjs'), import('node:net'), import('node:dgram'), import('node:events')
  ]);
  const fixture = await startIwaFixture(0,0);
  const host = '127.0.0.1';
  const tcp = createConnection({host,port:fixture.echoPort});
  const udp = createSocket('udp4');
  try {
    const resp = await fetch(`http://${host}:${fixture.port}/.well-known/manifest.webmanifest`);
    assert.equal(resp.status,200);
    const manifest = await resp.json();
    assert.deepEqual(manifest.permissions_policy['direct-sockets'], ['self']);
    assert.equal((await fetch(`http://${host}:${fixture.port}${manifest.icons[0].src}`)).status,200);
    const tcpData = once(tcp,'data'); tcp.write('tcp'); assert.equal(String((await tcpData)[0]), 'tcp');
    const udpData = once(udp,'message'); udp.send('udp',fixture.echoPort,host); assert.equal(String((await udpData)[0]), 'udp');
  } finally { tcp.destroy(); udp.close(); await fixture.close(); }
});
