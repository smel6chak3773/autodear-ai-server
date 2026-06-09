// server/assistant/cacheStore.js

const cache = new Map();

function makeKey(text = "") {
  return text.trim().toLowerCase();
}

function get(text) {
  return cache.get(makeKey(text));
}

function set(text, value) {
  cache.set(makeKey(text), {
    value,
    createdAt: Date.now(),
  });

  return value;
}

function has(text) {
  return cache.has(makeKey(text));
}

function clear() {
  cache.clear();
}

module.exports = {
  get,
  set,
  has,
  clear,
};
