'use strict';

const MAX_ENTRIES = 500;
const entries = [];

function push(level, args) {
  const message = args
    .map((a) => (typeof a === 'string' ? a : safeStringify(a)))
    .join(' ');
  entries.push({ ts: Date.now(), level, message });
  if (entries.length > MAX_ENTRIES) entries.shift();
}

function safeStringify(value) {
  if (value instanceof Error) return value.stack || value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Wrap console methods so every log line (from anywhere in the app) lands in the buffer too. */
function attachConsole() {
  const original = { log: console.log, warn: console.warn, error: console.error };

  console.log = (...args) => {
    push('info', args);
    original.log(...args);
  };
  console.warn = (...args) => {
    push('warn', args);
    original.warn(...args);
  };
  console.error = (...args) => {
    push('error', args);
    original.error(...args);
  };

  process.on('uncaughtException', (err) => push('error', [`Uncaught exception: ${err.stack || err.message}`]));
  process.on('unhandledRejection', (reason) => push('error', [`Unhandled rejection: ${reason?.stack || reason}`]));
}

function getAll(sinceTs) {
  return sinceTs ? entries.filter((e) => e.ts > sinceTs) : entries.slice();
}

function clear() {
  entries.length = 0;
}

module.exports = { attachConsole, getAll, clear, push };
