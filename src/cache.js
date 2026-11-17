// Offline message cache — plain JSON files under ~/.config/mailcli/cache/.
// One file per account+folder; messages keyed by UID so repeated syncs
// merge instead of duplicating. No database, no dependencies.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function cacheRoot(baseDir) {
  return baseDir ?? path.join(os.homedir(), '.config', 'mailcli', 'cache');
}

function safeName(name) {
  return String(name).replace(/[^A-Za-z0-9._-]/g, '_');
}

export class MessageCache {
  /**
   * @param {string} account — account name (used as a directory name).
   * @param {string} [baseDir] — override for tests.
   */
  constructor(account, baseDir) {
    this.account = account;
    this.dir = path.join(cacheRoot(baseDir), safeName(account));
  }

  filePath(folder) {
    return path.join(this.dir, `${safeName(folder)}.json`);
  }

  /** Load cached messages for a folder (oldest first). Empty array if none. */
  load(folder) {
    try {
      const data = JSON.parse(fs.readFileSync(this.filePath(folder), 'utf8'));
      return Array.isArray(data.messages) ? data.messages : [];
    } catch {
      return [];
    }
  }

  /**
   * Merge messages into the cache (matched by UID) and persist.
   * Returns the full merged list.
   */
  save(folder, messages) {
    const merged = new Map(this.load(folder).map((m) => [m.uid, m]));
    for (const m of messages) {
      merged.set(m.uid, { ...merged.get(m.uid), ...m, cachedAt: new Date().toISOString() });
    }
    const list = [...merged.values()].sort((a, b) => a.uid - b.uid);
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(
      this.filePath(folder),
      JSON.stringify({ folder, updatedAt: new Date().toISOString(), messages: list }, null, 2),
    );
    return list;
  }

  /** One cached message by UID, or null. */
  get(folder, uid) {
    return this.load(folder).find((m) => m.uid === Number(uid)) ?? null;
  }

  /** Case-insensitive substring search over subject, sender and body text. */
  search(folder, query) {
    const q = String(query).toLowerCase();
    return this.load(folder).filter((m) => {
      const hay = [m.subject, m.from?.email, m.from?.name, m.text, m.snippet]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }

  /** Delete the cached copy of one folder. Returns true if a file existed. */
  clear(folder) {
    try {
      fs.unlinkSync(this.filePath(folder));
      return true;
    } catch {
      return false;
    }
  }
}
