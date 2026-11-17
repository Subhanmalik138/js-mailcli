// IMAP client (RFC 3501) — hand-rolled on top of node:net / node:tls.
// Zero dependencies. Covers connect, LOGIN, LIST, SELECT, FETCH
// (envelopes + full bodies), SEARCH and LOGOUT.
import net from 'node:net';
import tls from 'node:tls';
import {
  ResponseReader,
  fetchValue,
  parseEnvelopeAddresses,
  tokenize,
} from './parser.js';

/** Quote an IMAP atom when it is not safe to send bare. */
function quote(value) {
  const s = String(value);
  if (/^[^\s"\\(){}]+$/.test(s)) return s;
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export class ImapClient {
  /**
   * @param {object} opts
   * @param {string} opts.host
   * @param {number} [opts.port=993]
   * @param {boolean} [opts.tls=true] — implicit TLS (port 993). Set false for port 143.
   * @param {string} opts.user
   * @param {string} opts.pass
   * @param {number} [opts.timeout=30000]
   */
  constructor({ host, port = 993, tls: useTls = true, user, pass, timeout = 30000 }) {
    if (!host || !user || pass === undefined) {
      throw new Error('ImapClient needs host, user and pass');
    }
    this.host = host;
    this.port = port;
    this.useTls = useTls;
    this.user = user;
    this.pass = pass;
    this.timeout = timeout;
    this.tagSeq = 0;
    this.socket = null;
    this.reader = null;
  }

  /** Open the connection and read the server greeting. */
  async connect() {
    const socket = this.useTls
      ? tls.connect({ host: this.host, port: this.port, servername: this.host })
      : net.connect({ host: this.host, port: this.port });
    this.socket = socket;
    this.reader = new ResponseReader(socket);
    socket.setTimeout(this.timeout);
    socket.on('timeout', () => socket.destroy(new Error('connection timed out')));
    await new Promise((resolve, reject) => {
      socket.once('error', reject);
      if (this.useTls) socket.once('secureConnect', resolve);
      else socket.once('connect', resolve);
    });
    const { line } = await this.reader.readLine();
    const tokens = tokenize(line);
    if (tokens[0] !== '*' || (tokens[1] || '').toUpperCase() !== 'OK') {
      throw new Error(`unexpected IMAP greeting: ${line}`);
    }
    return tokens;
  }

  nextTag() {
    this.tagSeq += 1;
    return `a${String(this.tagSeq).padStart(3, '0')}`;
  }

  /** Send one tagged command and return its parsed response. Throws on non-OK. */
  async command(cmd) {
    if (!this.socket) throw new Error('not connected — call connect() first');
    const tag = this.nextTag();
    this.socket.write(`${tag} ${cmd}\r\n`);
    const res = await this.reader.readResponse(tag);
    if (res.status !== 'OK') {
      throw new Error(`IMAP ${cmd.split(' ')[0]} failed: ${res.status} ${res.text.join(' ')}`);
    }
    return res;
  }

  /** Authenticate with LOGIN (plain credentials). */
  async login() {
    return this.command(`LOGIN ${quote(this.user)} ${quote(this.pass)}`);
  }

  /** List folders. Returns [{ flags, delimiter, name }]. */
  async listFolders(reference = '', pattern = '*') {
    const res = await this.command(`LIST ${quote(reference)} ${quote(pattern)}`);
    return res.untagged
      .filter((u) => u[0] === 'LIST')
      .map((u) => ({
        flags: Array.isArray(u[1]) ? u[1] : [],
        delimiter: u[2] === 'NIL' ? null : u[2],
        name: u[3],
      }));
  }

  /**
   * Select a folder. Returns { exists, recent, unseen, uidValidity, uidNext }.
   */
  async select(folder) {
    const res = await this.command(`SELECT ${quote(folder)}`);
    const info = { exists: 0, recent: 0, unseen: 0, uidValidity: null, uidNext: null };
    for (const u of res.untagged) {
      if (u[1] === 'EXISTS') info.exists = Number(u[0]);
      if (u[1] === 'RECENT') info.recent = Number(u[0]);
      // Response codes arrive as `* OK [UNSEEN 1] ...` — the bracketed
      // code tokenizes as the atoms "[UNSEEN" and "1]".
      if (u[0] === 'OK' && typeof u[1] === 'string' && u[1].startsWith('[')) {
        const code = u[1].slice(1).toUpperCase();
        const value = String(u[2] ?? '').replace(/\]$/, '');
        if (code === 'UNSEEN') info.unseen = Number(value);
        if (code === 'UIDVALIDITY') info.uidValidity = Number(value);
        if (code === 'UIDNEXT') info.uidNext = Number(value);
      }
    }
    return info;
  }

  /** Fetch message summaries (UID, flags, envelope) for a sequence range. */
  async fetchEnvelopes(from = 1, to = '*') {
    const res = await this.command(`FETCH ${from}:${to} (UID FLAGS ENVELOPE)`);
    const out = [];
    for (const u of res.untagged) {
      if (u[1] !== 'FETCH' || !Array.isArray(u[2])) continue;
      const list = u[2];
      const envelope = fetchValue(list, 'ENVELOPE');
      out.push({
        seq: Number(u[0]),
        uid: Number(fetchValue(list, 'UID') ?? 0),
        flags: fetchValue(list, 'FLAGS') ?? [],
        date: envelope?.[0] ?? '',
        subject: envelope?.[1] ?? '',
        from: parseEnvelopeAddresses(envelope?.[2])[0] ?? null,
        to: parseEnvelopeAddresses(envelope?.[5]) ?? [],
        messageId: envelope?.[9] ?? '',
      });
    }
    return out;
  }

  /** Fetch one full message by UID and return its raw RFC 5322 text. */
  async fetchBody(uid) {
    const res = await this.command(`UID FETCH ${uid} (UID BODY[])`);
    for (const u of res.untagged) {
      if (u[1] !== 'FETCH' || !Array.isArray(u[2])) continue;
      const body = fetchValue(u[2], 'BODY[]');
      if (body && typeof body.toString === 'function') return body.toString('utf8');
    }
    throw new Error(`no body returned for UID ${uid}`);
  }

  /** Search the selected folder. Returns an array of UIDs. */
  async search(criteria = 'ALL') {
    const res = await this.command(`UID SEARCH ${criteria}`);
    const uids = [];
    for (const u of res.untagged) {
      if (u[0] === 'SEARCH') {
        for (const tok of u.slice(1)) uids.push(Number(tok));
      }
    }
    return uids;
  }

  /** LOGOUT and close the socket. */
  async logout() {
    try {
      if (this.socket && !this.socket.destroyed) await this.command('LOGOUT');
    } finally {
      if (this.socket) this.socket.end();
      this.socket = null;
      this.reader = null;
    }
  }
}
