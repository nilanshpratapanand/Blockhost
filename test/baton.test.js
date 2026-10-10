'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { encodeCode, decodeCode, stripProps, mergeProps } = require('../dashboard/lib/baton');

test('group code round-trips', () => {
  const c = encodeCode('https://x.example.workers.dev/', 'supersecret1');
  assert.deepStrictEqual(decodeCode(c), { url: 'https://x.example.workers.dev', secret: 'supersecret1' });
});

test('group code rejects junk and plain http hosts', () => {
  assert.throws(() => decodeCode('nope'));
  assert.throws(() => decodeCode(encodeCode('http://evil.example', 'supersecret1')));
  assert.throws(() => decodeCode(encodeCode('https://ok.example', 'short')));
});

test('server.properties: timestamp and machine-local keys do not count as changes', () => {
  const a = '#Mon Jan 1\nmotd=hi\nserver-port=25565\n';
  const b = '#Tue Jan 2\nmotd=hi\nserver-port=25999\n';
  assert.strictEqual(stripProps(a), stripProps(b));
});

test('mergeProps keeps this machine\'s local keys but takes the shared rest', () => {
  const out = mergeProps('motd=new\nserver-port=25565\n', 'motd=old\nserver-port=25999\n');
  assert.match(out, /motd=new/);
  assert.match(out, /server-port=25999/);
});
