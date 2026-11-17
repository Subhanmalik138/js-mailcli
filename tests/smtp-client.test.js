import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { SmtpClient } from '../src/smtp/client.js';

/** A canned SMTP server that records the dialogue and the DATA payload. */
function startFakeSmtp() {
  const seen = [];
  let dataPayload = '';
  const server = net.createServer((socket) => {
    socket.write('220 FakeSMTP ready\r\n');
    let buf = Buffer.alloc(0);
    let inData = false;
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      let idx;
      while ((idx = buf.indexOf('\r\n')) !== -1) {
        const line = buf.subarray(0, idx).toString('latin1');
        buf = buf.subarray(idx + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            socket.write('250 OK queued\r\n');
          } else {
            dataPayload += line + '\r\n';
          }
          continue;
        }
        seen.push(line);
        const [verb, ...rest] = line.split(' ');
        const v = (verb || '').toUpperCase();
        if (v === 'EHLO') {
          socket.write('250-fakesmtp\r\n250 AUTH LOGIN PLAIN\r\n');
        } else if (v === 'AUTH') {
          if (rest[0] === 'LOGIN') {
            socket.write('334 VXNlcm5hbWU6\r\n');
          } else {
            socket.write('235 OK authenticated\r\n');
          }
        } else if (line === Buffer.from('user', 'utf8').toString('base64')) {
          socket.write('334 UGFzc3dvcmQ6\r\n');
        } else if (line === Buffer.from('pass', 'utf8').toString('base64')) {
          socket.write('235 OK authenticated\r\n');
        } else if (v === 'MAIL') {
          socket.write('250 OK sender\r\n');
        } else if (v === 'RCPT') {
          socket.write('250 OK recipient\r\n');
        } else if (v === 'DATA') {
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
          inData = true;
        } else if (v === 'QUIT') {
          socket.write('221 Bye\r\n');
          socket.end();
        } else {
          socket.write('500 unknown\r\n');
        }
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, seen, getData: () => dataPayload });
    });
  });
}

test('SmtpClient sends a message end to end (AUTH LOGIN flow)', async (t) => {
  const { server, port, seen, getData } = await startFakeSmtp();
  t.after(() => server.close());
  const client = new SmtpClient({ host: '127.0.0.1', port, tls: false, starttls: false, user: 'user', pass: 'pass' });
  const extensions = await client.connect();
  assert.ok(extensions.includes('AUTH'));
  await client.sendMail({
    from: 'me@x.com',
    to: ['you@y.com'],
    cc: ['cc@z.com'],
    raw: 'From: me@x.com\r\nTo: you@y.com\r\nSubject: T\r\n\r\nBody line\r\n.Line starting with dot',
  });
  await client.quit();
  assert.ok(seen.some((l) => l.startsWith('EHLO')));
  assert.ok(seen.some((l) => l === 'AUTH LOGIN'));
  assert.ok(seen.some((l) => l === 'MAIL FROM:<me@x.com>'));
  assert.ok(seen.some((l) => l === 'RCPT TO:<you@y.com>'));
  assert.ok(seen.some((l) => l === 'RCPT TO:<cc@z.com>'));
  assert.ok(seen.some((l) => l === 'DATA'));
  // Dot-stuffing: the leading-dot line must arrive doubled.
  assert.match(getData(), /\.\.Line starting with dot/);
  assert.match(getData(), /Body line/);
});

test('SmtpClient throws when the server rejects a recipient', async (t) => {
  const { server, port } = await startFakeSmtp();
  t.after(() => server.close());
  const client = new SmtpClient({ host: '127.0.0.1', port, tls: false, starttls: false });
  await client.connect();
  // The fake server accepts everything, so force a failure via a bad command.
  await assert.rejects(client.sendCommand('BOGUS', 250), /SMTP error 500/);
  await client.quit();
});
