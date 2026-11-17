// SMTP client (RFC 5321) — hand-rolled on top of node:net / node:tls.
// Zero dependencies. Covers EHLO, STARTTLS upgrade, AUTH LOGIN / PLAIN,
// MAIL FROM / RCPT TO / DATA, and QUIT.
import net from 'node:net';
import tls from 'node:tls';

/** Minimal line reader for SMTP's CRLF-delimited replies. */
class LineReader {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.waiters = [];
    this.error = null;
    socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
    socket.on('error', (err) => {
      this.error = err;
      for (const w of this.waiters.splice(0)) w.reject(err);
    });
    socket.on('close', () => {
      if (!this.error) this.error = new Error('connection closed');
      for (const w of this.waiters.splice(0)) w.reject(this.error);
    });
  }

  drain() {
    while (this.waiters.length) {
      const eol = this.buffer.indexOf('\r\n');
      if (eol === -1) return;
      const line = this.buffer.subarray(0, eol).toString('latin1');
      this.buffer = this.buffer.subarray(eol + 2);
      this.waiters.shift().resolve(line);
    }
  }

  readLine() {
    const eol = this.buffer.indexOf('\r\n');
    if (eol !== -1) {
      const line = this.buffer.subarray(0, eol).toString('latin1');
      this.buffer = this.buffer.subarray(eol + 2);
      return Promise.resolve(line);
    }
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
}

export class SmtpClient {
  /**
   * @param {object} opts
   * @param {string} opts.host
   * @param {number} [opts.port=587]
   * @param {boolean} [opts.tls=false] — implicit TLS (port 465). Set true for 465.
   * @param {boolean} [opts.starttls=true] — upgrade a plain connection via STARTTLS.
   * @param {string} [opts.user] — if set, AUTH LOGIN is attempted after EHLO.
   * @param {string} [opts.pass]
   * @param {number} [opts.timeout=30000]
   */
  constructor({ host, port = 587, tls: useTls = false, starttls = true, user, pass, timeout = 30000 }) {
    if (!host) throw new Error('SmtpClient needs host');
    this.host = host;
    this.port = port;
    this.useTls = useTls;
    this.starttls = starttls;
    this.user = user;
    this.pass = pass;
    this.timeout = timeout;
    this.socket = null;
    this.reader = null;
    this.extensions = [];
  }

  async connect() {
    this.socket = this.useTls
      ? tls.connect({ host: this.host, port: this.port, servername: this.host })
      : net.connect({ host: this.host, port: this.port });
    this.socket.setTimeout(this.timeout);
    this.socket.on('timeout', () => this.socket.destroy(new Error('connection timed out')));
    this.reader = new LineReader(this.socket);
    await new Promise((resolve, reject) => {
      this.socket.once('error', reject);
      if (this.useTls) this.socket.once('secureConnect', resolve);
      else this.socket.once('connect', resolve);
    });
    await this.readReply(220);
    await this.ehlo();
    if (this.starttls && !this.useTls && this.extensions.includes('STARTTLS')) {
      await this.sendCommand('STARTTLS', 220);
      this.socket = tls.connect({ socket: this.socket, host: this.host, servername: this.host });
      this.reader = new LineReader(this.socket);
      await new Promise((resolve, reject) => {
        this.socket.once('error', reject);
        this.socket.once('secureConnect', resolve);
      });
      await this.ehlo();
    }
    if (this.user) await this.auth();
    return this.extensions;
  }

  /** Read a (possibly multi-line) reply; require one of the expected codes. */
  async readReply(...expected) {
    const lines = [];
    for (;;) {
      const line = await this.reader.readLine();
      lines.push(line);
      const code = parseInt(line.slice(0, 3), 10);
      if (line[3] !== '-') break;
      if (Number.isNaN(code)) break;
    }
    const code = parseInt(lines[lines.length - 1].slice(0, 3), 10);
    if (expected.length && !expected.includes(code)) {
      throw new Error(`SMTP error ${code}: ${lines.join(' | ')}`);
    }
    return { code, lines };
  }

  async sendCommand(cmd, ...expected) {
    this.socket.write(`${cmd}\r\n`);
    return this.readReply(...expected);
  }

  async ehlo() {
    const { lines } = await this.sendCommand(`EHLO ${this.host}`, 250);
    this.extensions = lines.slice(1).map((l) => l.slice(4).split(' ')[0].toUpperCase());
    return this.extensions;
  }

  /** AUTH LOGIN (default) with AUTH PLAIN fallback. */
  async auth() {
    if (!this.user || this.pass === undefined) throw new Error('auth needs user and pass');
    try {
      const { code } = await this.sendCommand('AUTH LOGIN', 334);
      if (code !== 334) throw new Error('unexpected AUTH LOGIN reply');
      await this.sendCommand(Buffer.from(this.user, 'utf8').toString('base64'), 334);
      await this.sendCommand(Buffer.from(this.pass, 'utf8').toString('base64'), 235);
      return;
    } catch (err) {
      // Fall back to AUTH PLAIN once; rethrow if that fails too.
      const token = Buffer.from(`\0${this.user}\0${this.pass}`, 'utf8').toString('base64');
      await this.sendCommand(`AUTH PLAIN ${token}`, 235);
    }
  }

  /**
   * Send one message. `raw` is a full RFC 5322 message (see buildMessage).
   * @param {object} msg
   * @param {string} msg.from
   * @param {string|string[]} msg.to
   * @param {string|string[]} [msg.cc]
   * @param {string} msg.raw
   */
  async sendMail({ from, to, cc = [], raw }) {
    if (!from || !to || !raw) throw new Error('sendMail needs from, to and raw');
    await this.sendCommand(`MAIL FROM:<${from}>`, 250);
    for (const rcpt of [to].flat().concat([cc].flat())) {
      await this.sendCommand(`RCPT TO:<${rcpt}>`, 250, 251);
    }
    await this.sendCommand('DATA', 354);
    // Dot-stuff lines that start with a dot, then end with <CRLF>.<CRLF>.
    const stuffed = raw.replace(/^\./gm, '..').replace(/\r?\n/g, '\r\n');
    this.socket.write(`${stuffed}\r\n.\r\n`);
    await this.readReply(250);
  }

  async quit() {
    try {
      if (this.socket && !this.socket.destroyed) await this.sendCommand('QUIT', 221);
    } finally {
      if (this.socket) this.socket.end();
      this.socket = null;
      this.reader = null;
    }
  }
}
