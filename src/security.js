'use strict';

const crypto = require('crypto');

/**
 * Einfacher In-Memory-Rate-Limiter (Sliding Window).
 */
class RateLimiter {
  constructor(max, windowMs) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = new Map();
  }

  _recent(key, now) {
    const list = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }

  /** true, wenn das Limit bereits erreicht ist */
  blocked(key) {
    return this._recent(key, Date.now()).length >= this.max;
  }

  hit(key) {
    const now = Date.now();
    const list = this._recent(key, now);
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > 20000) {
      for (const k of this.hits.keys()) this._recent(k, now);
    }
    return list.length;
  }

  reset(key) {
    this.hits.delete(key);
  }

  retryAfter(key) {
    const list = this._recent(key, Date.now());
    if (!list.length) return 0;
    return Math.ceil((list[0] + this.windowMs - Date.now()) / 1000);
  }
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function securityHeaders(res, { https }) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  if (https) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

/**
 * Client-IP. Hinter einem Reverse Proxy (TRUST_PROXY=1) zählt der letzte Eintrag
 * in X-Forwarded-For – den hat der eigene Proxy gesetzt und ist nicht fälschbar.
 */
function clientIp(req, trustProxy) {
  if (trustProxy) {
    const xff = String(req.headers['x-forwarded-for'] || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (xff.length) return xff[xff.length - 1];
  }
  return req.socket.remoteAddress || 'unknown';
}

function isHttps(req, trustProxy) {
  if (req.socket.encrypted) return true;
  return !!trustProxy && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

/**
 * Schutz gegen Cross-Site-Requests: Origin (bzw. Referer) muss zum Host passen.
 */
function sameOrigin(req, trustProxy) {
  const source = req.headers.origin || req.headers.referer;
  if (!source) return true; // z. B. curl/CLI – Browser senden bei POST immer Origin
  const host = (trustProxy && req.headers['x-forwarded-host']) || req.headers.host;
  try {
    return new URL(source).host === String(host).split(',')[0].trim();
  } catch {
    return false;
  }
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

module.exports = { RateLimiter, securityHeaders, clientIp, isHttps, sameOrigin, hashToken, safeEqual, CSP };
