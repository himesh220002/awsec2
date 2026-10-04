const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

const BACKUP_PATH = path.join(__dirname, '..', 'data', 'contact_messages.json');

// Mongoose Schema for contact_messages
const ContactMessageSchema = new mongoose.Schema({
  name: { type: String, required: true },
  handle: { type: String, default: null },
  email: { type: String, default: null },
  message: { type: String, required: true },
  status: { type: String, default: 'unread' },
  createdAt: { type: Date, default: Date.now }
});

const ContactMessage = mongoose.models.ContactMessage || mongoose.model('ContactMessage', ContactMessageSchema, 'contact_messages');

// File backup helpers
function loadBackup() {
  try {
    if (fs.existsSync(BACKUP_PATH)) {
      return JSON.parse(fs.readFileSync(BACKUP_PATH, 'utf8'));
    }
  } catch (err) {
    console.warn('[ContactManager] Error reading contact_messages.json:', err.message);
  }
  return [];
}

function saveBackup(messages) {
  try {
    fs.writeFileSync(BACKUP_PATH, JSON.stringify(messages, null, 2), 'utf8');
  } catch (err) {
    console.error('[ContactManager] Error saving contact_messages.json:', err.message);
  }
}

// Unawaited Discord Webhook Dispatcher
function dispatchDiscordWebhook(payload) {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return;

  try {
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).catch(err => {
      console.warn('[ContactManager] Discord webhook dispatch warning:', err.message);
    });
  } catch (err) {
    console.warn('[ContactManager] Discord webhook error:', err.message);
  }
}

// Save a contact message
async function saveMessage({ name, handle, email, message }) {
  const cleanName = (name || '').trim();
  const cleanHandle = (handle || email || '').trim();
  const cleanMessage = (message || '').trim();

  let savedDoc = null;

  // 1. Try MongoDB
  try {
    if (mongoose.connection.readyState === 1) {
      savedDoc = await ContactMessage.create({
        name: cleanName,
        handle: cleanHandle,
        email: cleanHandle.includes('@') ? cleanHandle : null,
        message: cleanMessage,
        status: 'unread',
        createdAt: new Date()
      });
    }
  } catch (err) {
    console.warn('[ContactManager] MongoDB save failed, using local backup:', err.message);
  }

  // 2. Always maintain local JSON backup
  const backup = loadBackup();
  const item = {
    _id: savedDoc?._id?.toString() || 'msg_' + Date.now(),
    name: cleanName,
    handle: cleanHandle,
    email: cleanHandle.includes('@') ? cleanHandle : null,
    message: cleanMessage,
    status: 'unread',
    createdAt: new Date().toISOString()
  };
  backup.unshift(item);
  saveBackup(backup.slice(0, 50));

  // 3. Fast unawaited Discord webhook execution
  dispatchDiscordWebhook({
    username: 'CypherTech Stream Dispatch',
    avatar_url: 'https://igvictory.com/images/logo.svg',
    embeds: [
      {
        title: '🚨 New Contact Message Transmitted',
        description: 'New signal submitted via the IGVictory Contact Terminal.',
        color: 5814783, // Cyber purple
        fields: [
          { name: '👤 Name / Codename', value: cleanName || 'Anonymous Operator', inline: true },
          { name: '📡 Contact / Handle', value: cleanHandle || 'None provided', inline: true },
          { name: '💬 Transmission', value: cleanMessage || 'No content' }
        ],
        footer: { text: 'IGVictory Node Relay // ap-south-1' },
        timestamp: new Date().toISOString()
      }
    ]
  });

  return savedDoc || item;
}

// Get recent contact messages (HTTP Pull)
async function getRecentMessages(limit = 20) {
  try {
    if (mongoose.connection.readyState === 1) {
      const docs = await ContactMessage.find()
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();
      if (docs && docs.length > 0) return docs;
    }
  } catch (err) {
    console.warn('[ContactManager] MongoDB read error, falling back to local JSON:', err.message);
  }

  return loadBackup().slice(0, limit);
}

module.exports = {
  saveMessage,
  getRecentMessages,
  dispatchDiscordWebhook
};
