import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { ImapClient } from '../src/imap/client.js';

/**
 * A canned IMAP server: greets, then answers the commands the client sends
 * with fixed responses. Records every command line it receives.
 */
function startFakeImap() {
  const seen = [];
  const server = net.createServer((socket) => {
    socket.write('* OK FakeIMAP ready\r\n');
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      let idx;
      while ((idx = buf.indexOf('\r\n')) !== -1) {
        const line = buf.subarray(0, idx).toString('latin1');
        buf = buf.subarray(idx + 2);
        const [tag, verb, ...rest] = line.split(' ');
        seen.push(line);
        const v = (verb || '').toUpperCase();
        if (v === 'LOGIN') {
          socket.write(`${tag} OK Logged in\r\n`);
        } else if (v === 'LIST') {
          socket.write('* LIST (\\HasNoChildren) "/" "INBOX"\r\n');
          socket.write('* LIST (\\HasNoChildren) "/" "Sent"\r\n');
          socket.write(`${tag} OK List completed\r\n`);
        } else if (v === 'SELECT') {
          socket.write('* 2 EXISTS\r\n* 0 RECENT\r\n* OK [UNSEEN 1] First unseen\r\n');
          socket.write('* OK [UIDVALIDITY 123] UIDs valid\r\n* OK [UIDNEXT 3] Next UID\r\n');
          socket.write(`${tag} OK [READ-WRITE] Select completed\r\n`);
        } else if (v === 'FETCH') {
          const body = 'From: a@x.com\r\nSubject: Hi\r\n\r\nHello body';
          socket.write('* 1 FETCH (UID 1 FLAGS (\\Seen) ENVELOPE ("Mon, 16 Nov 2026 10:00:00 +0000" "Hi" (("Alice" NIL "a" "x.com")) NIL NIL NIL NIL NIL NIL "<m1>"))\r\n');
          socket.write('* 2 FETCH (UID 2 FLAGS () ENVELOPE ("Tue, 17 Nov 2026 11:00:00 +0000" "Yo" (("Bob" NIL "b" "y.com")) NIL NIL NIL NIL NIL NIL "<m2>"))\r\n');
          socket.write(`${tag} OK Fetch completed\r\n`);
          void body;
        } else if (v === 'UID') {
          const sub = (rest[0] || '').toUpperCase();
          if (sub === 'FETCH') {
            const raw = 'From: a@x.com\r\nSubject: Hi\r\n\r\nHello body';
            const payload = Buffer.from(raw, 'utf8');
            socket.write(`* 1 FETCH (UID 1 BODY[] {${payload.length}}\r\n`);
            socket.write(payload);
            socket.write('\r\n)\r\n');
            socket.write(`${tag} OK Fetch completed\r\n`);
          } else if (sub === 'SEARCH') {
            socket.write('* SEARCH 1 2\r\n');
            socket.write(`${tag} OK Search completed\r\n`);
          }
        } else if (v === 'LOGOUT') {
          socket.write(`* BYE FakeIMAP logging out\r\n${tag} OK Logout completed\r\n`);
          socket.end();
        } else {
          socket.write(`${tag} BAD unknown command\r\n`);
        }
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, seen });
    });
  });
}

test('ImapClient drives a full session against a fake server', async (t) => {
  const { server, port, seen } = await startFakeImap();
  t.after(() => server.close());
  const client = new ImapClient({ host: '127.0.0.1', port, tls: false, user: 'u', pass: 'p' });
  await client.connect();
  await client.login();

  const folders = await client.listFolders();
  assert.deepEqual(folders.map((f) => f.name), ['INBOX', 'Sent']);
  assert.deepEqual(folders[0].flags, ['\\HasNoChildren']);

  const info = await client.select('INBOX');
  assert.equal(info.exists, 2);
  assert.equal(info.unseen, 1);
  assert.equal(info.uidValidity, 123);
  assert.equal(info.uidNext, 3);

  const envelopes = await client.fetchEnvelopes(1, 2);
  assert.equal(envelopes.length, 2);
  assert.equal(envelopes[0].uid, 1);
  assert.equal(envelopes[0].subject, 'Hi');
  assert.equal(envelopes[0].from.email, 'a@x.com');
  assert.equal(envelopes[0].messageId, '<m1>');
  assert.equal(envelopes[1].subject, 'Yo');
  assert.deepEqual(envelopes[0].flags, ['\\Seen']);

  const raw = await client.fetchBody(1);
  assert.match(raw, /Hello body/);

  const uids = await client.search('ALL');
  assert.deepEqual(uids, [1, 2]);

  await client.logout();
  assert.ok(seen.some((l) => l.includes('LOGIN')));
  assert.ok(seen.some((l) => l.includes('SELECT INBOX')));
});

test('ImapClient throws on a NO response', async (t) => {
  const { server, port } = await startFakeImap();
  t.after(() => server.close());
  const client = new ImapClient({ host: '127.0.0.1', port, tls: false, user: 'u', pass: 'p' });
  await client.connect();
  await assert.rejects(client.command('NOPE'), /failed/);
  await client.logout();
});

test('ImapClient requires host, user and pass', () => {
  assert.throws(() => new ImapClient({ host: '', user: 'u', pass: 'p' }), /needs host/);
});
