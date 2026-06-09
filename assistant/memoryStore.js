// server/assistant/memoryStore.js

const sessions = new Map();

function getSession(userId = "guest_demo") {
  if (!sessions.has(userId)) {
    sessions.set(userId, {
      userId,
      messages: [],
      facts: {},
      updatedAt: Date.now(),
    });
  }

  return sessions.get(userId);
}

function addMessage(userId, role, content) {
  const session = getSession(userId);

  session.messages.push({
    role,
    content,
    createdAt: new Date().toISOString(),
  });

  session.messages = session.messages.slice(-20);
  session.updatedAt = Date.now();

  return session;
}

function rememberFact(userId, key, value) {
  const session = getSession(userId);
  session.facts[key] = value;
  session.updatedAt = Date.now();
  return session;
}

module.exports = {
  getSession,
  addMessage,
  rememberFact,
};
