import sqlite3 from "sqlite3";
import { open, Database } from "sqlite";
import path from "path";
import { fileURLToPath } from "url";
import { encrypt, decrypt } from "./utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.resolve(__dirname, "../captoken.db");

let db: Database<sqlite3.Database, sqlite3.Statement>;

export async function initDB() {
  db = await open({
    filename: dbPath,
    driver: sqlite3.Database,
  });

  // Foreign key desteğini aç
  await db.run("PRAGMA foreign_keys = ON");

  // Tabloları oluştur
  await db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      target_api_key TEXT NOT NULL,
      provider TEXT DEFAULT 'openai',
      daily_limit REAL NOT NULL,
      monthly_limit REAL NOT NULL,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS target_keys (
      id TEXT PRIMARY KEY,
      api_key_id TEXT NOT NULL,
      target_api_key TEXT NOT NULL,
      provider TEXT DEFAULT 'openai',
      priority INTEGER DEFAULT 1,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS usage_summary (
      api_key_id TEXT,
      date TEXT,
      tokens_used INTEGER DEFAULT 0,
      cost REAL DEFAULT 0.0,
      request_count INTEGER DEFAULT 0,
      PRIMARY KEY (api_key_id, date),
      FOREIGN KEY(api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS request_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      api_key_id TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      model TEXT,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      cost REAL,
      status_code INTEGER,
      FOREIGN KEY(api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE
    );
  `);

  // Düz metin olarak kalan eski anahtarları şifrele
  await migratePlaintextKeys();
  
  // Eski tekli key yapısını target_keys tablosuna taşı
  await migrateToTargetKeysTable();

  console.log("Database initialized at:", dbPath);
}

async function migratePlaintextKeys() {
  try {
    const keys = await db.all("SELECT id, target_api_key FROM api_keys");
    for (const key of keys) {
      if (key.target_api_key && !key.target_api_key.includes(":")) {
        const encryptedKey = encrypt(key.target_api_key);
        await db.run("UPDATE api_keys SET target_api_key = ? WHERE id = ?", [encryptedKey, key.id]);
        console.log(`[Migration] API key encrypted for ID: ${key.id}`);
      }
    }
  } catch (err) {
    console.error("Migration error:", err);
  }
}

async function migrateToTargetKeysTable() {
  try {
    // target_keys tablosu boşsa, api_keys tablosundaki verileri taşı
    const targetCount = await db.get("SELECT COUNT(*) as count FROM target_keys");
    if (targetCount && targetCount.count === 0) {
      const keys = await db.all("SELECT id, target_api_key, provider FROM api_keys");
      for (const key of keys) {
        if (key.target_api_key) {
          const targetId = `targetkey_${Math.random().toString(36).substring(2, 15)}`;
          await db.run(
            `INSERT INTO target_keys (id, api_key_id, target_api_key, provider, priority, is_active)
             VALUES (?, ?, ?, ?, 1, 1)`,
            [targetId, key.id, key.target_api_key, key.provider]
          );
          console.log(`[Migration] Migrated key ${key.id} to target_keys table`);
        }
      }
    }
  } catch (err) {
    console.error("Migration to target_keys failed:", err);
  }
}

export async function checkLimits(keyId: string): Promise<{ allowed: boolean; reason?: string }> {
  // 1. Anahtar kontrolü
  const key = await db.get("SELECT * FROM api_keys WHERE id = ?", [keyId]);
  if (!key) {
    return { allowed: false, reason: "invalid_key" };
  }
  if (!key.is_active) {
    return { allowed: false, reason: "inactive_key" };
  }

  // 2. Ajan Döngü Koruması (Son 1 dakikadaki istek sayısı)
  const loopCount = await db.get(
    `SELECT COUNT(*) as count FROM request_logs 
     WHERE api_key_id = ? AND timestamp >= datetime('now', '-1 minute')`,
    [keyId]
  );
  
  if (loopCount && loopCount.count >= 30) {
    return { allowed: false, reason: "loop_detected" };
  }

  const today = new Date().toISOString().split("T")[0];
  const thisMonth = today.substring(0, 7); // YYYY-MM

  // 3. Günlük Bütçe Kontrolü
  const dailyUsage = await db.get(
    "SELECT cost FROM usage_summary WHERE api_key_id = ? AND date = ?",
    [keyId, today]
  );
  const dailyCost = dailyUsage ? dailyUsage.cost : 0;
  if (dailyCost >= key.daily_limit) {
    return { allowed: false, reason: "daily_limit_exceeded" };
  }

  // 4. Aylık Bütçe Kontrolü
  const monthlyUsage = await db.get(
    "SELECT SUM(cost) as total FROM usage_summary WHERE api_key_id = ? AND date LIKE ?",
    [keyId, `${thisMonth}%`]
  );
  const monthlyCost = monthlyUsage && monthlyUsage.total ? monthlyUsage.total : 0;
  if (monthlyCost >= key.monthly_limit) {
    return { allowed: false, reason: "monthly_limit_exceeded" };
  }

  return { allowed: true };
}

export async function logRequest(
  keyId: string,
  model: string,
  promptTokens: number,
  completionTokens: number,
  cost: number,
  statusCode: number
) {
  // 1. Log tablosuna ekle
  await db.run(
    `INSERT INTO request_logs (api_key_id, model, prompt_tokens, completion_tokens, cost, status_code)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [keyId, model, promptTokens, completionTokens, cost, statusCode]
  );

  // 2. Günlük özeti güncelle
  const today = new Date().toISOString().split("T")[0];
  await db.run(
    `INSERT INTO usage_summary (api_key_id, date, tokens_used, cost, request_count)
     VALUES (?, ?, ?, ?, 1)
     ON CONFLICT(api_key_id, date) DO UPDATE SET
       tokens_used = tokens_used + excluded.tokens_used,
       cost = cost + excluded.cost,
       request_count = request_count + 1`,
    [keyId, today, promptTokens + completionTokens, cost]
  );
}

// --- CRUD & Dashboard Uç Noktaları İçin SQL Fonksiyonları ---

export async function createApiKey(
  name: string,
  targetApiKey: string,
  provider: string,
  dailyLimit: number,
  monthlyLimit: number
) {
  const newId = `captoken_${Math.random().toString(36).substring(2, 15)}${Math.random().toString(36).substring(2, 15)}`;
  const encryptedKey = encrypt(targetApiKey);
  
  // api_keys tablosuna ekle
  await db.run(
    `INSERT INTO api_keys (id, name, target_api_key, provider, daily_limit, monthly_limit)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [newId, name, encryptedKey, provider, dailyLimit, monthlyLimit]
  );
  
  // target_keys tablosuna da ilk hedef anahtar olarak ekle
  const targetId = `targetkey_${Math.random().toString(36).substring(2, 15)}`;
  await db.run(
    `INSERT INTO target_keys (id, api_key_id, target_api_key, provider, priority, is_active)
     VALUES (?, ?, ?, ?, 1, 1)`,
    [targetId, newId, encryptedKey, provider]
  );
  
  return { id: newId, name, provider, dailyLimit, monthlyLimit };
}

export async function listApiKeys() {
  const today = new Date().toISOString().split("T")[0];
  const keys = await db.all(`
    SELECT k.*, IFNULL(s.cost, 0.0) as spent_today, IFNULL(s.tokens_used, 0) as tokens_today
    FROM api_keys k
    LEFT JOIN usage_summary s ON k.id = s.api_key_id AND s.date = ?
    ORDER BY k.created_at DESC
  `, [today]);

  const keysWithTargets = [];
  for (const k of keys) {
    const targets = await db.all("SELECT * FROM target_keys WHERE api_key_id = ? ORDER BY priority DESC", [k.id]);
    const maskedTargets = targets.map(t => {
      const decrypted = decrypt(t.target_api_key);
      let masked = "••••••••••••";
      if (decrypted.startsWith("sk-")) {
        masked = `sk-••••${decrypted.substring(decrypted.length - 4)}`;
      } else if (decrypted.length > 8) {
        masked = `${decrypted.substring(0, 4)}••••${decrypted.substring(decrypted.length - 4)}`;
      }
      return {
        ...t,
        target_api_key: masked
      };
    });
    
    const { target_api_key, provider, ...rest } = k;
    keysWithTargets.push({
      ...rest,
      targets: maskedTargets
    });
  }
  return keysWithTargets;
}

export async function deleteApiKey(keyId: string) {
  return db.run("DELETE FROM api_keys WHERE id = ?", [keyId]);
}

export async function toggleApiKey(keyId: string, isActive: boolean) {
  return db.run("UPDATE api_keys SET is_active = ? WHERE id = ?", [isActive ? 1 : 0, keyId]);
}

// --- Target Keys CRUD İşlemleri ---

export async function addTargetKey(
  apiKeyId: string,
  targetApiKey: string,
  provider: string,
  priority: number
) {
  const encryptedKey = encrypt(targetApiKey);
  const targetId = `targetkey_${Math.random().toString(36).substring(2, 15)}`;
  await db.run(
    `INSERT INTO target_keys (id, api_key_id, target_api_key, provider, priority, is_active)
     VALUES (?, ?, ?, ?, ?, 1)`,
    [targetId, apiKeyId, encryptedKey, provider, priority]
  );
  return { id: targetId, api_key_id: apiKeyId, provider, priority };
}

export async function deleteTargetKey(targetId: string) {
  return db.run("DELETE FROM target_keys WHERE id = ?", [targetId]);
}

export async function toggleTargetKey(targetId: string, isActive: boolean) {
  return db.run("UPDATE target_keys SET is_active = ? WHERE id = ?", [isActive ? 1 : 0, targetId]);
}

// --- Analytics ---

export async function getAnalytics() {
  const today = new Date().toISOString().split("T")[0];
  
  const summary = await db.get(`
    SELECT 
      SUM(cost) as total_cost,
      SUM(tokens_used) as total_tokens,
      SUM(request_count) as total_requests
    FROM usage_summary
  `);

  const dailyCosts = await db.all(`
    SELECT date, SUM(cost) as cost
    FROM usage_summary
    GROUP BY date
    ORDER BY date DESC
    LIMIT 7
  `);

  const recentLogs = await db.all(`
    SELECT l.*, k.name as key_name
    FROM request_logs l
    JOIN api_keys k ON l.api_key_id = k.id
    ORDER BY l.timestamp DESC
    LIMIT 10
  `);

  return {
    total_cost: summary?.total_cost || 0,
    total_tokens: summary?.total_tokens || 0,
    total_requests: summary?.total_requests || 0,
    daily_costs: dailyCosts.reverse(),
    recent_logs: recentLogs
  };
}

export async function getKeyDetails(keyId: string) {
  const key = await db.get("SELECT * FROM api_keys WHERE id = ?", [keyId]);
  if (key) {
    const targets = await db.all(
      "SELECT * FROM target_keys WHERE api_key_id = ? AND is_active = 1 ORDER BY priority DESC, created_at ASC",
      [keyId]
    );
    key.targets = targets.map(t => ({
      ...t,
      target_api_key: decrypt(t.target_api_key)
    }));
  }
  return key;
}
