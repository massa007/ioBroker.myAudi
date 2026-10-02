'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_SETTINGS = { registrationOpen: true, requireApproval: true };
const EMPTY = () => ({ users: [], sessions: [], seasons: [], events: [], settings: { ...DEFAULT_SETTINGS } });

class Store {
  constructor(file) {
    this.file = file;
    this.data = EMPTY();
    if (file && fs.existsSync(file)) {
      this.data = { ...EMPTY(), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    }
    this.data.settings = { ...DEFAULT_SETTINGS, ...this.data.settings };
    // Sessions werden nur noch gehasht gespeichert – alte Klartext-Sessions verwerfen
    this.data.sessions = this.data.sessions.filter((s) => s.tokenHash);
    // Bestehende Accounts aus der Zeit vor der Freischaltung gelten als freigeschaltet
    for (const u of this.data.users) if (u.approved === undefined) u.approved = true;
  }

  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    // Nur der Dienst-Benutzer darf die Datei lesen (enthält Passwort-Hashes)
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

function newId() {
  return crypto.randomBytes(8).toString('hex');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

// Wird verwendet, wenn es den Benutzer nicht gibt – gleiche Rechenzeit verhindert,
// dass man über die Antwortzeit herausfindet, welche Benutzernamen existieren.
const DUMMY_HASH = hashPassword('dummy-password');

function verifyPassword(password, stored) {
  const [salt, hash] = (stored || DUMMY_HASH).split(':');
  const test = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return !!stored && expected.length === test.length && crypto.timingSafeEqual(expected, test);
}

module.exports = { Store, newId, hashPassword, verifyPassword };
