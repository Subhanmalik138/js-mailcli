import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  Literal,
  tokenize,
  parseTokens,
  ResponseReader,
  fetchValue,
  parseEnvelopeAddresses,
} from '../src/imap/parser.js';

test('tokenize handles atoms, quoted strings, lists and escapes', () => {
  assert.deepEqual(tokenize('a001 OK [READ-WRITE] Logged in'), ['a001', 'OK', '[READ-WRITE]', 'Logged', 'in']);
  assert.deepEqual(tokenize('* LIST (\\HasNoChildren) "/" "INBOX"'), ['*', 'LIST', '(', '\\HasNoChildren', ')', '/', 'INBOX']);
  assert.deepEqual(tokenize('"a \\"quoted\\" word"'), ['a "quoted" word']);
  assert.deepEqual(tokenize(''), []);
});

test('parseTokens builds nested lists', () => {
  const tree = parseTokens(tokenize('* 1 FETCH (UID 42 FLAGS (\\Seen) ENVELOPE ("date" "subj" NIL NIL NIL NIL NIL NIL NIL "<id>"))'));
  assert.equal(tree[0], '*');
  assert.equal(tree[2], 'FETCH');
  const list = tree[3];
  assert.equal(fetchValue(list, 'UID'), '42');
  assert.deepEqual(fetchValue(list, 'FLAGS'), ['\\Seen']);
  const env = fetchValue(list, 'ENVELOPE');
  assert.equal(env[1], 'subj');
  assert.equal(env[9], '<id>');
});

test('fetchValue is case-insensitive and returns undefined when absent', () => {
  assert.equal(fetchValue(['UID', '7', 'FLAGS', ['\\Seen']], 'uid'), '7');
  assert.equal(fetchValue(['UID', '7'], 'BODY[]'), undefined);
});

test('parseEnvelopeAddresses maps NILs and builds emails', () => {
  const addrs = parseEnvelopeAddresses([
    ['Alice', 'NIL', 'alice', 'x.com'],
    ['NIL', 'NIL', 'NIL', 'NIL'],
    'not-a-list',
  ]);
  assert.deepEqual(addrs, [
    { name: 'Alice', email: 'alice@x.com' },
    { name: '', email: '' },
  ]);
  assert.deepEqual(parseEnvelopeAddresses('NIL'), []);
  assert.deepEqual(parseEnvelopeAddresses(undefined), []);
});

/** A fake socket the test drives by emitting data. */
class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.written = [];
  }
  write(data) {
    this.written.push(data);
  }
}

test('ResponseReader reads lines and literals, resolving tagged responses', async () => {
  const socket = new FakeSocket();
  const reader = new ResponseReader(socket);
  const pending = reader.readResponse('a001');
  socket.emit('data', Buffer.from('* 1 FETCH (UID 1 BODY[] {5}\r\nhello\r\n'));
  socket.emit('data', Buffer.from('a001 OK Fetch completed\r\n'));
  const res = await pending;
  assert.equal(res.status, 'OK');
  assert.equal(res.untagged.length, 1);
  const body = fetchValue(res.untagged[0][2], 'BODY[]');
  assert.ok(body instanceof Literal);
  assert.equal(body.toString(), 'hello');
});

test('ResponseReader waits for the rest of a split literal', async () => {
  const socket = new FakeSocket();
  const reader = new ResponseReader(socket);
  const pending = reader.readLine();
  socket.emit('data', Buffer.from('* 1 FETCH (BODY[] {11}\r\nhel'));
  // Not enough bytes yet: the promise must not resolve.
  let resolved = false;
  pending.then(() => { resolved = true; });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(resolved, false);
  socket.emit('data', Buffer.from('lo world\r\n'));
  const { literal } = await pending;
  assert.equal(literal.toString(), 'hello world');
});

test('ResponseReader rejects waiters on socket error', async () => {
  const socket = new FakeSocket();
  const reader = new ResponseReader(socket);
  const pending = reader.readLine();
  socket.emit('error', new Error('boom'));
  await assert.rejects(pending, /boom/);
});
