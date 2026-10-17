/**
 * Reliable Zero-Dependency .env Loader
 *
 * Parses `.env` files with support for:
 * - Comments (`# ...`) and blank lines
 * - Optional `export KEY=VALUE` prefix
 * - Single-quoted (`'...'`), double-quoted (`"..."` with `\n` escaping), and unquoted values
 * - Inline comments on unquoted values
 * - Preserves existing `process.env` variables unless `override: true` is passed
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function parseEnvContent(content) {
  const result = {};
  if (!content || typeof content !== 'string') return result;

  const lines = content.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const cleaned = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eqIdx = cleaned.indexOf('=');
    if (eqIdx === -1) continue;

    const key = cleaned.slice(0, eqIdx).trim();
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) continue;

    let val = cleaned.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      const quote = val[0];
      val = val.slice(1, -1);
      if (quote === '"') {
        val = val.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\"/g, '"');
      }
    } else {
      // Strip trailing inline comments (` # ...`) on unquoted values
      const hashIdx = val.indexOf(' #');
      if (hashIdx !== -1) {
        val = val.slice(0, hashIdx).trim();
      }
    }

    result[key] = val;
  }
  return result;
}

function loadDotEnv(options) {
  const opts = Object.assign({
    envPath: path.join(__dirname, '..', '.env'),
    override: false,
    targetEnv: process.env
  }, options || {});

  if (!fs.existsSync(opts.envPath)) {
    return { loaded: false, parsed: {} };
  }

  const content = fs.readFileSync(opts.envPath, 'utf8');
  const parsed = parseEnvContent(content);

  for (const [k, v] of Object.entries(parsed)) {
    if (opts.override || opts.targetEnv[k] === undefined) {
      opts.targetEnv[k] = v;
    }
  }

  return { loaded: true, parsed };
}

module.exports = {
  parseEnvContent,
  loadDotEnv
};
