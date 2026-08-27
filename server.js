const express = require('express');
const session = require('express-session');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_CODE = process.env.ADMIN_CODE || 'CRYPTO2026';
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const DB_PATH = path.join(__dirname, 'data', 'db.json');

function loadDB() {
  try {
    if (fs.existsSync(DB_PATH)) {
      return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    }
  } catch (e) {}
  return { users: [], transactions: [], crypto_balances: {} };
}

function saveDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: 'crypto-enterprise-secret-2026',
  resave: false,
  saveUninitialized: true,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

app.use(express.static(path.join(__dirname, 'public')));

// ===== CRYPTO PRICE API =====
function fetchCryptoPrices() {
  return new Promise((resolve, reject) => {
    const url = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,usdt,usdc,solana,cardano,dogecoin,xrp,tron,litecoin&vs_currencies=usd&include_24hr_change=true';
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

function fetchCryptoHistory(coinId) {
  return new Promise((resolve, reject) => {
    const url = `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currency=usd&days=30`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

// ===== STEAM OPENID =====
const STEAM_API_KEY = process.env.STEAM_API_KEY || '';

app.get('/auth/steam', (req, res) => {
  const returnTo = `${BASE_URL}/auth/steam/callback`;
  const params = new URLSearchParams({
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'checkid_setup',
    'openid.return_to': returnTo,
    'openid.set_claim_url': 'http://steamcommunity.com/openid/id',
    'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select'
  });
  res.redirect(`https://steamcommunity.com/openid/login?${params.toString()}`);
});

app.get('/auth/steam/callback', (req, res) => {
  const claimedId = req.query['openid.identity'];
  if (claimedId) {
    const steamId = claimedId.split('/').pop();
    const db = loadDB();
    let user = db.users.find(u => u.steamId === steamId);
    if (!user) {
      user = {
        id: uuidv4(),
        steamId: steamId,
        username: `Steam_${steamId.slice(-6)}`,
        avatar: `https://avatars.steamstatic.com/${steamId}_full.jpg`,
        role: 'user',
        createdAt: new Date().toISOString()
      };
      db.users.push(user);
      saveDB(db);
    }
    req.session.userId = user.id;
    req.session.steamId = steamId;
    res.redirect('/');
  } else {
    res.redirect('/?error=auth_failed');
  }
});

app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.json({ logged: false });
  const db = loadDB();
  const user = db.users.find(u => u.id === req.session.userId);
  if (!user) return res.json({ logged: false });
  
  const balances = db.crypto_balances[user.id] || {};
  const frozen = db.frozen_balances ? db.frozen_balances[user.id] || {} : {};
  res.json({ 
    logged: true, 
    user: { 
      id: user.id, 
      username: user.username, 
      avatar: user.avatar,
      steamId: user.steamId,
      role: user.role 
    },
    balances,
    frozen
  });
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// ===== CRYPTO API =====
app.get('/api/prices', async (req, res) => {
  try {
    const prices = await fetchCryptoPrices();
    res.json(prices);
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch prices' });
  }
});

app.get('/api/history/:coinId', async (req, res) => {
  try {
    const history = await fetchCryptoHistory(req.params.coinId);
    res.json(history);
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

// ===== PORTFOLIO =====
app.get('/api/portfolio', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  const db = loadDB();
  const balances = db.crypto_balances[req.session.userId] || {};
  const frozen = db.frozen_balances ? db.frozen_balances[req.session.userId] || {} : {};
  res.json({ balances, frozen });
});

app.post('/api/portfolio/add', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  const { coin, amount } = req.body;
  if (!coin || !amount || amount <= 0) return res.status(400).json({ error: 'Invalid' });
  
  const db = loadDB();
  if (!db.crypto_balances[req.session.userId]) db.crypto_balances[req.session.userId] = {};
  const current = db.crypto_balances[req.session.userId][coin] || 0;
  db.crypto_balances[req.session.userId][coin] = current + parseFloat(amount);
  
  db.transactions.push({
    id: uuidv4(),
    userId: req.session.userId,
    type: 'buy',
    coin,
    amount: parseFloat(amount),
    date: new Date().toISOString()
  });
  
  saveDB(db);
  res.json({ success: true, balance: db.crypto_balances[req.session.userId][coin] });
});

app.post('/api/portfolio/remove', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  const { coin, amount } = req.body;
  if (!coin || !amount || amount <= 0) return res.status(400).json({ error: 'Invalid' });
  
  const db = loadDB();
  const balances = db.crypto_balances[req.session.userId] || {};
  const current = balances[coin] || 0;
  if (current < parseFloat(amount)) return res.status(400).json({ error: 'Insufficient balance' });
  
  balances[coin] = current - parseFloat(amount);
  db.crypto_balances[req.session.userId] = balances;
  
  db.transactions.push({
    id: uuidv4(),
    userId: req.session.userId,
    type: 'sell',
    coin,
    amount: parseFloat(amount),
    date: new Date().toISOString()
  });
  
  saveDB(db);
  res.json({ success: true, balance: balances[coin] });
});

// ===== ADMIN =====
app.post('/api/admin/login', (req, res) => {
  const { code } = req.body;
  if (code === ADMIN_CODE) {
    req.session.isAdmin = true;
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Code invalide' });
  }
});

app.get('/api/admin/users', (req, res) => {
  if (!req.session.isAdmin) return res.status(401).json({ error: 'Not admin' });
  const db = loadDB();
  const users = db.users.map(u => ({
    id: u.id,
    username: u.username,
    steamId: u.steamId,
    avatar: u.avatar,
    role: u.role,
    createdAt: u.createdAt,
    balances: db.crypto_balances[u.id] || {},
    frozen: db.frozen_balances ? db.frozen_balances[u.id] || {} : {}
  }));
  res.json({ users });
});

app.post('/api/admin/add-crypto', (req, res) => {
  if (!req.session.isAdmin) return res.status(401).json({ error: 'Not admin' });
  const { userId, coin, amount } = req.body;
  if (!userId || !coin || !amount) return res.status(400).json({ error: 'Invalid' });
  
  const db = loadDB();
  if (!db.crypto_balances[userId]) db.crypto_balances[userId] = {};
  const current = db.crypto_balances[userId][coin] || 0;
  db.crypto_balances[userId][coin] = current + parseFloat(amount);
  
  db.transactions.push({
    id: uuidv4(),
    userId,
    type: 'admin_add',
    coin,
    amount: parseFloat(amount),
    date: new Date().toISOString(),
    admin: true
  });
  
  saveDB(db);
  res.json({ success: true });
});

app.post('/api/admin/remove-crypto', (req, res) => {
  if (!req.session.isAdmin) return res.status(401).json({ error: 'Not admin' });
  const { userId, coin, amount } = req.body;
  if (!userId || !coin || !amount) return res.status(400).json({ error: 'Invalid' });
  
  const db = loadDB();
  const balances = db.crypto_balances[userId] || {};
  const current = balances[coin] || 0;
  if (current < parseFloat(amount)) return res.status(400).json({ error: 'Insufficient' });
  
  balances[coin] = current - parseFloat(amount);
  db.crypto_balances[userId] = balances;
  
  db.transactions.push({
    id: uuidv4(),
    userId,
    type: 'admin_remove',
    coin,
    amount: parseFloat(amount),
    date: new Date().toISOString(),
    admin: true
  });
  
  saveDB(db);
  res.json({ success: true });
});

app.post('/api/admin/freeze', (req, res) => {
  if (!req.session.isAdmin) return res.status(401).json({ error: 'Not admin' });
  const { userId, coin } = req.body;
  if (!userId || !coin) return res.status(400).json({ error: 'Invalid' });
  
  const db = loadDB();
  if (!db.frozen_balances) db.frozen_balances = {};
  if (!db.frozen_balances[userId]) db.frozen_balances[userId] = {};
  
  const balances = db.crypto_balances[userId] || {};
  const amount = balances[coin] || 0;
  
  if (amount <= 0) return res.status(400).json({ error: 'No balance to freeze' });
  
  db.frozen_balances[userId][coin] = (db.frozen_balances[userId][coin] || 0) + amount;
  db.crypto_balances[userId][coin] = 0;
  
  db.transactions.push({
    id: uuidv4(),
    userId,
    type: 'freeze',
    coin,
    amount,
    date: new Date().toISOString(),
    admin: true
  });
  
  saveDB(db);
  res.json({ success: true });
});

app.post('/api/admin/unfreeze', (req, res) => {
  if (!req.session.isAdmin) return res.status(401).json({ error: 'Not admin' });
  const { userId, coin } = req.body;
  if (!userId || !coin) return res.status(400).json({ error: 'Invalid' });
  
  const db = loadDB();
  if (!db.frozen_balances || !db.frozen_balances[userId]) return res.status(400).json({ error: 'No frozen balance' });
  
  const frozen = db.frozen_balances[userId][coin] || 0;
  if (frozen <= 0) return res.status(400).json({ error: 'No frozen balance' });
  
  if (!db.crypto_balances[userId]) db.crypto_balances[userId] = {};
  db.crypto_balances[userId][coin] = (db.crypto_balances[userId][coin] || 0) + frozen;
  db.frozen_balances[userId][coin] = 0;
  
  db.transactions.push({
    id: uuidv4(),
    userId,
    type: 'unfreeze',
    coin,
    amount: frozen,
    date: new Date().toISOString(),
    admin: true
  });
  
  saveDB(db);
  res.json({ success: true });
});

app.post('/api/admin/delete-user', (req, res) => {
  if (!req.session.isAdmin) return res.status(401).json({ error: 'Not admin' });
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'Invalid' });
  
  const db = loadDB();
  db.users = db.users.filter(u => u.id !== userId);
  delete db.crypto_balances[userId];
  if (db.frozen_balances) delete db.frozen_balances[userId];
  
  saveDB(db);
  res.json({ success: true });
});

app.get('/api/admin/transactions', (req, res) => {
  if (!req.session.isAdmin) return res.status(401).json({ error: 'Not admin' });
  const db = loadDB();
  res.json({ transactions: db.transactions.slice(-100).reverse() });
});

// ===== BACKUP/RESTORE =====
app.get('/api/admin/backup', (req, res) => {
  if (!req.session.isAdmin) return res.status(401).json({ error: 'Not admin' });
  const db = loadDB();
  res.setHeader('Content-Disposition', 'attachment; filename=crypto-enterprise-backup.json');
  res.json(db);
});

app.post('/api/admin/restore', (req, res) => {
  if (!req.session.isAdmin) return res.status(401).json({ error: 'Not admin' });
  try {
    saveDB(req.body);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: 'Invalid backup' });
  }
});

app.listen(PORT, () => {
  console.log(`Crypto Enterprise running on port ${PORT}`);
});
