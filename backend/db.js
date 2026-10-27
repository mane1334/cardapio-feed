"use strict";
/* Base de dados em ficheiro JSON.
 * - Gravação atómica (ficheiro temporário + rename), com atraso curto para juntar escritas.
 * - Cópia diária automática em backups/ (guarda as últimas 14).
 * Para dezenas de restaurantes chega bem; acima disso, migrar para SQLite/Postgres.
 */
const fs = require("fs");
const path = require("path");

const EMPTY = () => ({
  version: 1,
  restaurants: [],
  users: [],
  sessions: {},
  tables: [],
  orders: [],
  analytics: {} // restaurantId -> dishId -> YYYY-MM-DD -> {views,ms,favs,taps}
});

class DB {
  constructor(file, backupDir, opts = {}) {
    this.file = file;
    this.backupDir = backupDir;
    this.timer = null;
    this.lastBackupDay = null;
    this.onSave = opts.onSave || null;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.mkdirSync(backupDir, { recursive: true });
    this.data = this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      return Object.assign(EMPTY(), JSON.parse(raw));
    } catch (err) {
      if (err.code !== "ENOENT") {
        // Ficheiro corrompido: guarda uma cópia antes de recomeçar, nunca apaga em silêncio.
        const broken = `${this.file}.corrompido-${Date.now()}`;
        try { fs.copyFileSync(this.file, broken); } catch (_) {}
        console.error(`[db] Não foi possível ler ${this.file} (${err.message}). Cópia em ${broken}`);
      }
      return EMPTY();
    }
  }

  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 200);
    if (this.timer.unref) this.timer.unref();
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const tmp = `${this.file}.tmp`;
    const str = JSON.stringify(this.data);
    fs.writeFileSync(tmp, str);
    fs.renameSync(tmp, this.file);
    this.dailyBackup();
    if (this.onSave) {
      try { this.onSave(str, this.data); } catch (_) {}
    }
  }

  dailyBackup() {
    const day = new Date().toISOString().slice(0, 10);
    if (this.lastBackupDay === day) return;
    this.lastBackupDay = day;
    try {
      fs.copyFileSync(this.file, path.join(this.backupDir, `db-${day}.json`));
      const files = fs.readdirSync(this.backupDir).filter((f) => /^db-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
      for (const old of files.slice(0, Math.max(0, files.length - 14))) {
        fs.unlinkSync(path.join(this.backupDir, old));
      }
    } catch (err) {
      console.error("[db] Falha na cópia diária:", err.message);
    }
  }
}

module.exports = { DB };
