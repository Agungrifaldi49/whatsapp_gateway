import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const dbHost = process.env.DB_HOST || 'localhost';
const dbPort = parseInt(process.env.DB_PORT) || 3306;
const dbName = process.env.DB_NAME || 'wa_gateway_db';
const dbPass = process.env.DB_PASSWORD || '';

// Deteksi otomatis jika DB_NAME memiliki prefix cPanel (misal: smkmuth3_...)
// tetapi DB_USER ditulis tanpa prefix (misal: 'admin' padahal di cPanel adalah 'smkmuth3_admin')
let dbUser = process.env.DB_USER || 'root';
if (dbName.includes('_') && !dbUser.includes('_') && dbUser !== 'root') {
  const prefix = dbName.split('_')[0] + '_';
  if (!dbUser.startsWith(prefix)) {
    console.log(`[Database] Auto-prefixing DB_USER '${dbUser}' -> '${prefix}${dbUser}'`);
    dbUser = prefix + dbUser;
  }
}

// ── Connection Pool ──────────────────────────────────────────────────────────
export const pool = mysql.createPool({
  host:            dbHost,
  port:            dbPort,
  user:            dbUser,
  password:        dbPass,
  database:        dbName,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit:      0,
  charset:         'utf8mb4',
});

// ── Auto-Initialize Database & Tables ────────────────────────────────────────
export const initDatabase = async () => {
  // Coba buat database jika user memiliki izin (misal di local XAMPP)
  // Di cPanel / production hosting, database dibuat manual lewat menu MySQL cPanel
  try {
    const bootstrap = await mysql.createConnection({
      host:     dbHost,
      port:     dbPort,
      user:     dbUser,
      password: dbPass,
    });
    await bootstrap.query(
      `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    await bootstrap.end();
    console.log(`[Database] Database "${dbName}" siap.`);
  } catch (bootstrapErr) {
    console.log(`[Database] Lewati CREATE DATABASE (menggunakan database "${dbName}" yang sudah ada).`);
  }

  // Buat tabel-tabel jika belum ada
  const conn = await pool.getConnection();

  // Tabel: message_logs
  await conn.query(`
    CREATE TABLE IF NOT EXISTS message_logs (
      id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_id      INT UNSIGNED                       NULL,
      msg_id       VARCHAR(64)                        NOT NULL,
      phone        VARCHAR(30)                        NOT NULL,
      target_jid   VARCHAR(50)                        NOT NULL,
      message      TEXT                               NOT NULL,
      status       VARCHAR(20)                        NOT NULL DEFAULT 'SUCCESS',
      error_msg    TEXT                               NULL,
      source       ENUM('dashboard','api','bulk')     NOT NULL DEFAULT 'api',
      created_at   DATETIME                           NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_user_id   (user_id),
      INDEX idx_phone      (phone),
      INDEX idx_created_at (created_at),
      INDEX idx_status     (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // Auto-migration: Pastikan status di message_logs kompatibel dengan DELIVERED & READ
  try {
    await conn.query(`ALTER TABLE message_logs MODIFY status VARCHAR(20) NOT NULL DEFAULT 'SUCCESS'`);
    await conn.query(`UPDATE message_logs SET status = 'DELIVERED' WHERE status = '' OR status IS NULL`);
  } catch {}

  // Tabel: wa_sessions (Tracking status koneksi & statistik uptime)
  await conn.query(`
    CREATE TABLE IF NOT EXISTS wa_sessions (
      id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      event        VARCHAR(50)  NOT NULL,
      description  TEXT         NULL,
      created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_event      (event),
      INDEX idx_created_at (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // Tabel: incoming_messages (Pesan WA Masuk / Webhook)
  await conn.query(`
    CREATE TABLE IF NOT EXISTS incoming_messages (
      id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_id      INT UNSIGNED NULL,
      sender_jid   VARCHAR(50)  NOT NULL,
      sender_phone VARCHAR(30)  NOT NULL,
      message      TEXT         NOT NULL,
      raw_payload  JSON         NULL,
      created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_user_id    (user_id),
      INDEX idx_sender     (sender_jid),
      INDEX idx_created_at (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // Auto-migration: Tambahkan kolom user_id pada incoming_messages jika belum ada
  try {
    await conn.query(`ALTER TABLE incoming_messages ADD COLUMN user_id INT UNSIGNED NULL AFTER id`);
    await conn.query(`ALTER TABLE incoming_messages ADD INDEX idx_user_id (user_id)`);
  } catch {}

  // Tabel: users (Admin & Customer Login)
  await conn.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      username      VARCHAR(80)   NOT NULL UNIQUE,
      full_name     VARCHAR(100)  NULL,
      email         VARCHAR(100)  NULL,
      phone         VARCHAR(30)   NULL,
      password      VARCHAR(255)  NOT NULL COMMENT 'bcrypt hash',
      role          ENUM('admin','operator','customer') NOT NULL DEFAULT 'customer',
      status        ENUM('pending','active','rejected','suspended') NOT NULL DEFAULT 'pending',
      api_key       VARCHAR(64)   NULL UNIQUE,
      message_quota INT           NOT NULL DEFAULT 100,
      messages_sent INT           NOT NULL DEFAULT 0,
      is_active     TINYINT(1)    NOT NULL DEFAULT 1,
      last_login    DATETIME      NULL,
      created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_username (username),
      INDEX idx_email    (email),
      INDEX idx_status   (status),
      INDEX idx_role     (role),
      INDEX idx_api_key  (api_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // Tabel: system_settings (Pengaturan dinamis sistem termasuk SMTP)
  await conn.query(`
    CREATE TABLE IF NOT EXISTS system_settings (
      setting_key   VARCHAR(80)  PRIMARY KEY,
      setting_value TEXT         NULL,
      updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // Tabel: password_resets (OTP untuk reset password via Email/WhatsApp)
  await conn.query(`
    CREATE TABLE IF NOT EXISTS password_resets (
      id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_id      INT UNSIGNED NOT NULL,
      otp_code     VARCHAR(6)   NOT NULL,
      method       ENUM('email','whatsapp') NOT NULL DEFAULT 'email',
      attempts     TINYINT      NOT NULL DEFAULT 0,
      used         TINYINT(1)   NOT NULL DEFAULT 0,
      expires_at   DATETIME     NOT NULL,
      created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_user_id   (user_id),
      INDEX idx_otp_code  (otp_code),
      INDEX idx_expires_at (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // ── Auto-Migration untuk tabel yang sudah ada ──────────────────────────────
  try {
    const [userCols] = await conn.query(`SHOW COLUMNS FROM users`);
    const colNames = userCols.map(c => c.Field);

    if (!colNames.includes('full_name')) {
      await conn.query(`ALTER TABLE users ADD COLUMN full_name VARCHAR(100) NULL AFTER username`);
    }
    if (!colNames.includes('email')) {
      await conn.query(`ALTER TABLE users ADD COLUMN email VARCHAR(100) NULL AFTER full_name`);
    }
    if (!colNames.includes('phone')) {
      await conn.query(`ALTER TABLE users ADD COLUMN phone VARCHAR(30) NULL AFTER email`);
    }
    if (!colNames.includes('status')) {
      await conn.query(`ALTER TABLE users ADD COLUMN status ENUM('pending','active','rejected','suspended') NOT NULL DEFAULT 'pending' AFTER role`);
    }
    if (!colNames.includes('api_key')) {
      await conn.query(`ALTER TABLE users ADD COLUMN api_key VARCHAR(64) NULL UNIQUE AFTER status`);
    }
    if (!colNames.includes('message_quota')) {
      await conn.query(`ALTER TABLE users ADD COLUMN message_quota INT NOT NULL DEFAULT 100 AFTER api_key`);
    }
    if (!colNames.includes('messages_sent')) {
      await conn.query(`ALTER TABLE users ADD COLUMN messages_sent INT NOT NULL DEFAULT 0 AFTER message_quota`);
    }

    // Pastikan enum role mendukung 'customer'
    await conn.query(`ALTER TABLE users MODIFY COLUMN role ENUM('admin','operator','customer') NOT NULL DEFAULT 'customer'`);
    // Set status active untuk admin/operator lama
    await conn.query(`UPDATE users SET status = 'active' WHERE role IN ('admin','operator') AND (status IS NULL OR status = 'pending')`);

    // Migrasi message_logs untuk user_id jika belum ada
    const [logCols] = await conn.query(`SHOW COLUMNS FROM message_logs`);
    const logColNames = logCols.map(c => c.Field);
    if (!logColNames.includes('user_id')) {
      await conn.query(`ALTER TABLE message_logs ADD COLUMN user_id INT UNSIGNED NULL AFTER id, ADD INDEX idx_user_id (user_id)`);
    }
  } catch (migErr) {
    console.warn('[Database Migration Notice]', migErr.message);
  }

  conn.release();

  // ── Seed Admin Default jika tabel users masih kosong ──────────────────────
  const defaultUser = process.env.ADMIN_DEFAULT_USERNAME || 'admin';
  const defaultPass = process.env.ADMIN_DEFAULT_PASSWORD || 'Admin#12345';
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM users`);

  if (total === 0) {
    const hashed = await bcrypt.hash(defaultPass, 12);
    await pool.query(
      `INSERT INTO users (username, password, role, status, is_active) VALUES (?, ?, 'admin', 'active', 1)`,
      [defaultUser, hashed]
    );
    console.log(`[Database] Admin default "${defaultUser}" berhasil dibuat.`);
    console.log(`[Database] Segera ganti password melalui Dashboard > Pengaturan Akun.`);
  }

  // Pastikan akun admin memiliki email dan nomor telepon (diambil dari SMTP / default)
  try {
    const [[adminRow]] = await pool.query(`SELECT id, email, phone FROM users WHERE role = 'admin' LIMIT 1`);
    if (adminRow && (!adminRow.email || !adminRow.phone)) {
      const [[smtpSetting]] = await pool.query(`SELECT setting_value FROM system_settings WHERE setting_key = 'smtp_user' LIMIT 1`).catch(() => [[null]]);
      const fallbackEmail = smtpSetting?.setting_value || process.env.EMAIL_USER || 'programernoob87@gmail.com';
      const fallbackPhone = '082317864874';
      await pool.query(
        `UPDATE users SET email = COALESCE(email, ?), phone = COALESCE(phone, ?), full_name = COALESCE(full_name, 'Administrator') WHERE id = ?`,
        [fallbackEmail, fallbackPhone, adminRow.id]
      );
    }
  } catch {}

  console.log('[Database] Semua tabel siap.');
};

// ── Query Helpers ─────────────────────────────────────────────────────────────

/**
 * Simpan log pengiriman pesan ke database
 */
export const insertMessageLog = async ({ msgId, phone, targetJid, message, status = 'SUCCESS', errorMsg = null, source = 'api', userId = null }) => {
  const [result] = await pool.query(
    `INSERT INTO message_logs (user_id, msg_id, phone, target_jid, message, status, error_msg, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, msgId, phone, targetJid, message, status, errorMsg, source]
  );
  return result.insertId;
};

/**
 * Update status pesan berdasarkan msg_id
 */
export const updateMessageLogStatus = async (msgId, status = 'SUCCESS', errorMsg = null) => {
  try {
    await pool.query(
      `UPDATE message_logs SET status = ?, error_msg = COALESCE(?, error_msg) WHERE msg_id = ?`,
      [status, errorMsg, msgId]
    );
  } catch {}
};

/**
 * Ambil log pesan terkirim (dengan pagination)
 */
export const getMessageLogs = async (limit = 100, offset = 0) => {
  try {
    const [rows] = await pool.query(
      `SELECT * FROM message_logs ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [limit, offset]
    );
    return rows;
  } catch { return []; }
};

/**
 * Hitung total log pesan
 */
export const countMessageLogs = async () => {
  try {
    const [[row]] = await pool.query(`SELECT COUNT(*) AS total FROM message_logs`);
    return row.total;
  } catch { return 0; }
};

/**
 * Statistik dashboard (total sukses, total gagal, 7 hari terakhir)
 */
export const getDashboardStats = async () => {
  try {
    const [[totals]] = await pool.query(`
      SELECT
        COUNT(*)                                                         AS total_sent,
        COALESCE(SUM(status != 'FAILED'), 0)                             AS total_success,
        COALESCE(SUM(status = 'FAILED'), 0)                              AS total_failed,
        COUNT(CASE WHEN DATE(created_at) = CURDATE() THEN 1 END)         AS today_sent,
        COUNT(CASE WHEN DATE(created_at) = CURDATE() AND status != 'FAILED' THEN 1 END) AS today_success,
        COUNT(CASE WHEN DATE(created_at) = CURDATE() AND status = 'FAILED' THEN 1 END)  AS today_failed
      FROM message_logs
    `);

    const [[incomingTotals]] = await pool.query(`
      SELECT
        COUNT(*)                                                 AS total_incoming,
        COUNT(CASE WHEN DATE(created_at) = CURDATE() THEN 1 END) AS today_incoming
      FROM incoming_messages
    `);

    const [[customerTotals]] = await pool.query(`
      SELECT
        COUNT(*) AS total_customers,
        COUNT(CASE WHEN status = 'active' AND is_active = 1 THEN 1 END) AS active_customers
      FROM users WHERE role = 'customer'
    `);

    const [statusRows] = await pool.query(`
      SELECT status, COUNT(*) AS count
      FROM message_logs
      GROUP BY status
    `);
    const statusMap = { READ: 0, DELIVERED: 0, SENT: 0, SUCCESS: 0, FAILED: 0, PENDING: 0 };
    for (const r of statusRows) {
      statusMap[r.status] = Number(r.count);
    }

    const [sourceRows] = await pool.query(`
      SELECT COALESCE(NULLIF(source, ''), 'dashboard') AS source, COUNT(*) AS count
      FROM message_logs
      GROUP BY source
    `);
    const sourceMap = { api: 0, dashboard: 0, bulk: 0 };
    for (const r of sourceRows) {
      const k = String(r.source).toLowerCase();
      if (k === 'api') sourceMap.api += Number(r.count);
      else if (k === 'bulk' || k === 'broadcast') sourceMap.bulk += Number(r.count);
      else sourceMap.dashboard += Number(r.count);
    }

    const [dailyRows] = await pool.query(`
      SELECT 
        DATE(created_at) AS date,
        COUNT(*) AS total,
        COUNT(CASE WHEN status != 'FAILED' THEN 1 END) AS success,
        COUNT(CASE WHEN status = 'FAILED' THEN 1 END)  AS failed
      FROM message_logs
      WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 13 DAY)
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `);

    const [hourlyRows] = await pool.query(`
      SELECT HOUR(created_at) AS hour, COUNT(*) AS total
      FROM message_logs
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
      GROUP BY HOUR(created_at)
      ORDER BY hour ASC
    `);
    const hourlyTraffic = Array.from({ length: 24 }, (_, i) => {
      const found = hourlyRows.find(h => Number(h.hour) === i);
      return { hour: i, count: found ? Number(found.total) : 0 };
    });

    const [recentLogs] = await pool.query(`
      SELECT id, phone, message, status, source, created_at
      FROM message_logs
      ORDER BY created_at DESC
      LIMIT 5
    `);

    const totalSent = Number(totals.total_sent) || 0;
    const totalSuccess = Number(totals.total_success) || 0;
    const successRate = totalSent > 0 ? Number(((totalSuccess / totalSent) * 100).toFixed(1)) : 100;

    return {
      total_sent: totalSent,
      total_success: totalSuccess,
      total_failed: Number(totals.total_failed) || 0,
      today_sent: Number(totals.today_sent) || 0,
      today_success: Number(totals.today_success) || 0,
      today_failed: Number(totals.today_failed) || 0,
      success_rate: successRate,
      total_incoming: Number(incomingTotals.total_incoming) || 0,
      today_incoming: Number(incomingTotals.today_incoming) || 0,
      total_customers: Number(customerTotals.total_customers) || 0,
      active_customers: Number(customerTotals.active_customers) || 0,
      status_breakdown: statusMap,
      source_breakdown: sourceMap,
      daily_chart: dailyRows,
      hourly_traffic: hourlyTraffic,
      recent_logs: recentLogs,
    };
  } catch (err) {
    console.error('[getDashboardStats Error]', err);
    return {
      total_sent: 0,
      total_success: 0,
      total_failed: 0,
      today_sent: 0,
      today_success: 0,
      today_failed: 0,
      success_rate: 100,
      total_incoming: 0,
      today_incoming: 0,
      total_customers: 0,
      active_customers: 0,
      status_breakdown: { READ: 0, DELIVERED: 0, SENT: 0, SUCCESS: 0, FAILED: 0 },
      source_breakdown: { api: 0, dashboard: 0, bulk: 0 },
      daily_chart: [],
      hourly_traffic: [],
      recent_logs: [],
    };
  }
};

/**
 * Simpan pesan masuk ke database (Webhook Incoming)
 */
export const insertIncomingMessage = async ({ userId = null, senderJid, senderPhone, message, rawPayload }) => {
  try {
    const [result] = await pool.query(
      `INSERT INTO incoming_messages (user_id, sender_jid, sender_phone, message, raw_payload) VALUES (?, ?, ?, ?, ?)`,
      [userId, senderJid, senderPhone, message, JSON.stringify(rawPayload)]
    );
    return result.insertId;
  } catch { return null; }
};

/**
 * Ambil pesan masuk (dengan limit & pagination, opsional filter userId)
 */
export const getIncomingMessages = async (limit = 10, offset = 0, userId = null) => {
  try {
    if (userId) {
      const [rows] = await pool.query(
        `SELECT * FROM incoming_messages WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        [userId, limit, offset]
      );
      return rows;
    }
    const [rows] = await pool.query(
      `SELECT * FROM incoming_messages ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [limit, offset]
    );
    return rows;
  } catch { return []; }
};

/**
 * Hitung total pesan masuk (opsional filter userId)
 */
export const countIncomingMessages = async (userId = null) => {
  try {
    if (userId) {
      const [[row]] = await pool.query(`SELECT COUNT(*) AS total FROM incoming_messages WHERE user_id = ?`, [userId]);
      return row.total;
    }
    const [[row]] = await pool.query(`SELECT COUNT(*) AS total FROM incoming_messages`);
    return row.total;
  } catch { return 0; }
};

/**
 * Catat event sesi WA (connected, disconnected, qr_ready, dll.)
 */
export const insertSessionEvent = async (event, description = '') => {
  try {
    await pool.query(
      `INSERT INTO wa_sessions (event, description) VALUES (?, ?)`,
      [event, description]
    );
  } catch { /* Abaikan jika DB tidak tersedia */ }
};

// ── User Management (Admin & Customer Auth dari Database) ───────────────────

/**
 * Generate Secure API Key
 */
export const generateApiKey = () => {
  return 'wag_' + crypto.randomBytes(24).toString('hex');
};

/**
 * Cari user berdasarkan username (mengembalikan data lengkap untuk validasi status)
 */
export const findUserByUsername = async (username) => {
  try {
    const [[user]] = await pool.query(
      `SELECT * FROM users WHERE username = ? LIMIT 1`,
      [username]
    );
    return user || null;
  } catch { return null; }
};

/**
 * Cari user berdasarkan email
 */
export const findUserByEmail = async (email) => {
  try {
    const [[user]] = await pool.query(
      `SELECT * FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1`,
      [email]
    );
    return user || null;
  } catch { return null; }
};

/**
 * Cari user berdasarkan nomor telepon / WhatsApp
 * Mendukung format: 08xxx, +628xxx, 628xxx, 8xxx
 */
export const findUserByPhone = async (phone) => {
  if (!phone) return null;
  const digits = String(phone).replace(/[^0-9]/g, '');
  if (digits.length < 5) return null;

  // Siapkan variasi nomor
  const variants = new Set();
  variants.add(digits);
  if (digits.startsWith('0')) {
    variants.add('62' + digits.slice(1));
    variants.add(digits.slice(1));
  } else if (digits.startsWith('62')) {
    variants.add('0' + digits.slice(2));
    variants.add(digits.slice(2));
  } else if (digits.startsWith('8')) {
    variants.add('0' + digits);
    variants.add('62' + digits);
  }

  const list = Array.from(variants);
  const placeholders = list.map(() => '?').join(', ');
  try {
    const [rows] = await pool.query(
      `SELECT * FROM users WHERE phone IN (${placeholders}) LIMIT 1`,
      list
    );
    return rows[0] || null;
  } catch (err) {
    console.error('[Database] findUserByPhone error:', err.message);
    return null;
  }
};

/**
 * Cari user secara universal berdasarkan username, email, atau nomor HP
 */
export const findUserByIdentity = async (identity) => {
  if (!identity) return null;
  const clean = String(identity).trim();

  // 1. Coba cari via username
  let user = await findUserByUsername(clean);
  if (user) return user;

  // 2. Coba cari via email jika mengandung '@'
  if (clean.includes('@')) {
    user = await findUserByEmail(clean.toLowerCase());
    if (user) return user;
  }

  // 3. Coba cari via nomor telepon jika memiliki minimal 8 digit angka
  const digits = clean.replace(/[^0-9]/g, '');
  if (digits.length >= 8) {
    user = await findUserByPhone(clean);
    if (user) return user;
  }

  // 4. Coba email lagi tanpa syarat '@'
  user = await findUserByEmail(clean.toLowerCase());
  if (user) return user;

  return null;
};

/**
 * Cari user berdasarkan API Key (khusus customer aktif)
 */
export const findUserByApiKey = async (apiKey) => {
  try {
    const [[user]] = await pool.query(
      `SELECT id, username, full_name, email, phone, role, status, api_key, message_quota, messages_sent 
       FROM users WHERE api_key = ? AND status = 'active' AND is_active = 1 LIMIT 1`,
      [apiKey]
    );
    return user || null;
  } catch { return null; }
};

/**
 * Update last_login user
 */
export const updateLastLogin = async (userId) => {
  try {
    await pool.query(
      `UPDATE users SET last_login = NOW() WHERE id = ?`,
      [userId]
    );
  } catch {}
};

/**
 * Update password user (dengan hashing bcrypt)
 */
export const updateUserPassword = async (userId, newPassword) => {
  const hashed = await bcrypt.hash(newPassword, 12);
  await pool.query(
    `UPDATE users SET password = ? WHERE id = ?`,
    [hashed, userId]
  );
};

/**
 * Update informasi profil user (Nama lengkap, Email, Phone)
 */
export const updateUserProfile = async (userId, { fullName = null, email = null, phone = null } = {}) => {
  await pool.query(
    `UPDATE users SET full_name = ?, email = ?, phone = ?, updated_at = NOW() WHERE id = ?`,
    [fullName, email, phone, userId]
  );
  const [[user]] = await pool.query(`SELECT * FROM users WHERE id = ?`, [userId]);
  return user;
};

/**
 * Daftar semua user admin & operator (termasuk email & nomor telepon)
 */
export const getAllUsers = async () => {
  try {
    const [rows] = await pool.query(
      `SELECT id, username, full_name, email, phone, role, status, is_active, last_login, created_at 
       FROM users 
       WHERE role IN ('admin', 'operator') 
       ORDER BY created_at ASC`
    );
    return rows;
  } catch { return []; }
};

/**
 * Buat user admin/operator baru (dengan profil lengkap)
 */
export const createUser = async (usernameOrObj, password, role = 'admin', fullName = null, email = null, phone = null) => {
  let uName, uPass, uRole, uFull, uMail, uTel;
  if (typeof usernameOrObj === 'object' && usernameOrObj !== null) {
    uName = usernameOrObj.username;
    uPass = usernameOrObj.password;
    uRole = usernameOrObj.role || 'operator';
    uFull = usernameOrObj.fullName || null;
    uMail = usernameOrObj.email || null;
    uTel  = usernameOrObj.phone || null;
  } else {
    uName = usernameOrObj;
    uPass = password;
    uRole = role || 'admin';
    uFull = fullName || null;
    uMail = email || null;
    uTel  = phone || null;
  }

  const hashed = await bcrypt.hash(uPass, 12);
  const [result] = await pool.query(
    `INSERT INTO users (username, password, full_name, email, phone, role, status, is_active) VALUES (?, ?, ?, ?, ?, ?, 'active', 1)`,
    [uName, hashed, uFull, uMail, uTel, uRole]
  );
  return result.insertId;
};

/**
 * Hapus user berdasarkan ID
 */
export const deleteUser = async (userId) => {
  await pool.query(`DELETE FROM users WHERE id = ?`, [userId]);
};

/**
 * Toggle aktif/nonaktif user
 */
export const toggleUserActive = async (userId, isActive) => {
  await pool.query(
    `UPDATE users SET is_active = ? WHERE id = ?`,
    [isActive ? 1 : 0, userId]
  );
};

// ── Customer Management (Pendaftaran & Kontrol Admin) ────────────────────────

/**
 * Registrasi Customer Baru (Self-Register)
 */
export const registerCustomer = async ({ username, password, fullName, email, phone }) => {
  const hashed = await bcrypt.hash(password, 12);
  const apiKey = generateApiKey();

  const [result] = await pool.query(
    `INSERT INTO users (username, password, full_name, email, phone, role, status, api_key, message_quota, messages_sent, is_active)
     VALUES (?, ?, ?, ?, ?, 'customer', 'pending', ?, 100, 0, 1)`,
    [username, hashed, fullName || null, email || null, phone || null, apiKey]
  );

  return { id: result.insertId, username, apiKey, status: 'pending' };
};

/**
 * Ambil daftar customer untuk panel admin (dengan filter status & pencarian)
 */
export const getCustomers = async ({ status = null, search = '', limit = 50, offset = 0 } = {}) => {
  try {
    let sql = `SELECT id, username, full_name, email, phone, role, status, api_key, message_quota, messages_sent, is_active, last_login, created_at 
               FROM users WHERE role = 'customer'`;
    const params = [];

    if (status && status !== 'all') {
      sql += ` AND status = ?`;
      params.push(status);
    }

    if (search) {
      sql += ` AND (username LIKE ? OR full_name LIKE ? OR phone LIKE ? OR email LIKE ?)`;
      const s = `%${search}%`;
      params.push(s, s, s, s);
    }

    sql += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const [rows] = await pool.query(sql, params);
    return rows;
  } catch { return []; }
};

/**
 * Hitung jumlah customer (untuk pagination & status badges di dashboard)
 */
export const countCustomers = async ({ status = null, search = '' } = {}) => {
  try {
    let sql = `SELECT COUNT(*) AS total FROM users WHERE role = 'customer'`;
    const params = [];

    if (status && status !== 'all') {
      sql += ` AND status = ?`;
      params.push(status);
    }

    if (search) {
      sql += ` AND (username LIKE ? OR full_name LIKE ? OR phone LIKE ? OR email LIKE ?)`;
      const s = `%${search}%`;
      params.push(s, s, s, s);
    }

    const [[row]] = await pool.query(sql, params);
    return row.total;
  } catch { return 0; }
};

/**
 * Ambil ringkasan total customer per status (pending, active, suspended)
 */
export const getCustomerCountsByStatus = async () => {
  try {
    const [rows] = await pool.query(`
      SELECT 
        status, 
        COUNT(*) AS count 
      FROM users 
      WHERE role = 'customer' 
      GROUP BY status
    `);
    const summary = { pending: 0, active: 0, suspended: 0, rejected: 0, total: 0 };
    rows.forEach(r => {
      summary[r.status] = r.count;
      summary.total += r.count;
    });
    return summary;
  } catch {
    return { pending: 0, active: 0, suspended: 0, rejected: 0, total: 0 };
  }
};

/**
 * Ambil detail satu customer
 */
export const getCustomerById = async (userId) => {
  try {
    const [[user]] = await pool.query(
      `SELECT id, username, full_name, email, phone, role, status, api_key, message_quota, messages_sent, is_active, last_login, created_at 
       FROM users WHERE id = ? AND role = 'customer' LIMIT 1`,
      [userId]
    );
    return user || null;
  } catch { return null; }
};

/**
 * Update status customer (approve -> 'active', reject -> 'rejected', suspend -> 'suspended')
 */
export const updateCustomerStatus = async (userId, status) => {
  const isActive = status === 'active' ? 1 : 0;
  await pool.query(
    `UPDATE users SET status = ?, is_active = ? WHERE id = ? AND role = 'customer'`,
    [status, isActive, userId]
  );
};

/**
 * Update kuota pesan customer
 */
export const updateCustomerQuota = async (userId, quota) => {
  await pool.query(
    `UPDATE users SET message_quota = ? WHERE id = ? AND role = 'customer'`,
    [quota, userId]
  );
};

/**
 * Regenerate API Key Customer
 */
export const regenerateApiKey = async (userId) => {
  const newApiKey = generateApiKey();
  await pool.query(
    `UPDATE users SET api_key = ? WHERE id = ?`,
    [newApiKey, userId]
  );
  return newApiKey;
};

/**
 * Tambah counter pengiriman pesan customer
 */
export const incrementUserMessageSent = async (userId) => {
  try {
    await pool.query(
      `UPDATE users SET messages_sent = messages_sent + 1 WHERE id = ?`,
      [userId]
    );
  } catch {}
};

/**
 * Ambil log pesan milik customer tertentu
 */
export const getCustomerMessageLogs = async (userId, limit = 50, offset = 0) => {
  try {
    const [rows] = await pool.query(
      `SELECT * FROM message_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [userId, limit, offset]
    );
    return rows;
  } catch { return []; }
};

/**
 * Hitung total pesan terkirim customer tertentu
 */
export const countCustomerMessageLogs = async (userId) => {
  try {
    const [[row]] = await pool.query(
      `SELECT COUNT(*) AS total FROM message_logs WHERE user_id = ?`,
      [userId]
    );
    return row.total;
  } catch { return 0; }
};

/**
 * Ambil statistik dashboard khusus customer
 */
export const getCustomerStats = async (userId) => {
  try {
    const [[user]] = await pool.query(
      `SELECT message_quota, messages_sent FROM users WHERE id = ? LIMIT 1`,
      [userId]
    );
    const quota = user?.message_quota ?? 0;
    const sent = user?.messages_sent ?? 0;
    const remaining = quota === -1 ? 'Unlimited' : Math.max(0, quota - sent);
    const quotaPercent = quota > 0 ? Math.min(100, Number(((sent / quota) * 100).toFixed(1))) : (quota === -1 ? 0 : 100);

    const [[totals]] = await pool.query(`
      SELECT
        COUNT(*)                                                         AS total_sent,
        COALESCE(SUM(status != 'FAILED'), 0)                             AS total_success,
        COALESCE(SUM(status = 'FAILED'), 0)                              AS total_failed,
        COUNT(CASE WHEN DATE(created_at) = CURDATE() THEN 1 END)         AS today_sent,
        COUNT(CASE WHEN DATE(created_at) = CURDATE() AND status != 'FAILED' THEN 1 END) AS today_success,
        COUNT(CASE WHEN DATE(created_at) = CURDATE() AND status = 'FAILED' THEN 1 END)  AS today_failed
      FROM message_logs
      WHERE user_id = ?
    `, [userId]);

    const [[incomingTotals]] = await pool.query(`
      SELECT
        COUNT(*) AS total_incoming,
        COUNT(CASE WHEN DATE(created_at) = CURDATE() THEN 1 END) AS today_incoming
      FROM incoming_messages
      WHERE user_id = ?
    `, [userId]);

    const [statusRows] = await pool.query(`
      SELECT status, COUNT(*) AS count
      FROM message_logs
      WHERE user_id = ?
      GROUP BY status
    `, [userId]);
    const statusMap = { READ: 0, DELIVERED: 0, SENT: 0, SUCCESS: 0, FAILED: 0, PENDING: 0 };
    for (const r of statusRows) {
      statusMap[r.status] = Number(r.count);
    }

    const [sourceRows] = await pool.query(`
      SELECT COALESCE(NULLIF(source, ''), 'dashboard') AS source, COUNT(*) AS count
      FROM message_logs
      WHERE user_id = ?
      GROUP BY source
    `, [userId]);
    const sourceMap = { api: 0, dashboard: 0, bulk: 0 };
    for (const r of sourceRows) {
      const k = String(r.source).toLowerCase();
      if (k === 'api') sourceMap.api += Number(r.count);
      else if (k === 'bulk' || k === 'broadcast') sourceMap.bulk += Number(r.count);
      else sourceMap.dashboard += Number(r.count);
    }

    const [dailyRows] = await pool.query(`
      SELECT 
        DATE(created_at) AS date,
        COUNT(*) AS total,
        COUNT(CASE WHEN status != 'FAILED' THEN 1 END) AS success,
        COUNT(CASE WHEN status = 'FAILED' THEN 1 END)  AS failed
      FROM message_logs
      WHERE user_id = ? AND created_at >= DATE_SUB(CURDATE(), INTERVAL 13 DAY)
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `, [userId]);

    const [hourlyRows] = await pool.query(`
      SELECT HOUR(created_at) AS hour, COUNT(*) AS total
      FROM message_logs
      WHERE user_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
      GROUP BY HOUR(created_at)
      ORDER BY hour ASC
    `, [userId]);
    const hourlyTraffic = Array.from({ length: 24 }, (_, i) => {
      const found = hourlyRows.find(h => Number(h.hour) === i);
      return { hour: i, count: found ? Number(found.total) : 0 };
    });

    const [recentLogs] = await pool.query(`
      SELECT id, phone, message, status, source, created_at
      FROM message_logs
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT 5
    `, [userId]);

    const totalSent = Number(totals.total_sent) || 0;
    const totalSuccess = Number(totals.total_success) || 0;
    const successRate = totalSent > 0 ? Number(((totalSuccess / totalSent) * 100).toFixed(1)) : 100;

    return {
      quota,
      messages_sent: sent,
      remaining,
      quota_percent: quotaPercent,
      total_sent: totalSent,
      total_success: totalSuccess,
      total_failed: Number(totals.total_failed) || 0,
      today_sent: Number(totals.today_sent) || 0,
      today_success: Number(totals.today_success) || 0,
      today_failed: Number(totals.today_failed) || 0,
      success_rate: successRate,
      total_incoming: Number(incomingTotals.total_incoming) || 0,
      today_incoming: Number(incomingTotals.today_incoming) || 0,
      status_breakdown: statusMap,
      source_breakdown: sourceMap,
      daily_chart: dailyRows,
      hourly_traffic: hourlyTraffic,
      recent_logs: recentLogs,
    };
  } catch (err) {
    console.error('[getCustomerStats Error]', err);
    return {
      quota: 0,
      messages_sent: 0,
      remaining: 0,
      quota_percent: 0,
      total_sent: 0,
      total_success: 0,
      total_failed: 0,
      today_sent: 0,
      today_success: 0,
      today_failed: 0,
      success_rate: 100,
      total_incoming: 0,
      today_incoming: 0,
      status_breakdown: { READ: 0, DELIVERED: 0, SENT: 0, SUCCESS: 0, FAILED: 0 },
      source_breakdown: { api: 0, dashboard: 0, bulk: 0 },
      daily_chart: [],
      recent_logs: [],
    };
  }
};

// ── System Settings Management (SMTP, Brand, System Config) ──────────────────

/**
 * Ambil satu nilai setting dari database
 */
export const getSystemSetting = async (key, defaultValue = null) => {
  try {
    const [[row]] = await pool.query(
      `SELECT setting_value FROM system_settings WHERE setting_key = ? LIMIT 1`,
      [key]
    );
    return row ? row.setting_value : defaultValue;
  } catch {
    return defaultValue;
  }
};

/**
 * Simpan atau perbarui nilai setting di database
 */
export const setSystemSetting = async (key, value) => {
  await pool.query(
    `INSERT INTO system_settings (setting_key, setting_value) 
     VALUES (?, ?) 
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
    [key, value]
  );
};

/**
 * Ambil konfigurasi SMTP lengkap (dari database dengan fallback ke .env)
 */
export const getSmtpConfig = async () => {
  try {
    const [rows] = await pool.query(`SELECT setting_key, setting_value FROM system_settings WHERE setting_key LIKE 'smtp_%' OR setting_key = 'app_url'`);
    const dbMap = {};
    rows.forEach(r => { dbMap[r.setting_key] = r.setting_value; });

    return {
      host: dbMap['smtp_host'] || process.env.SMTP_HOST || '',
      port: parseInt(dbMap['smtp_port'] || process.env.SMTP_PORT) || 587,
      secure: (dbMap['smtp_secure'] !== undefined ? dbMap['smtp_secure'] === 'true' : process.env.SMTP_SECURE === 'true'),
      user: dbMap['smtp_user'] || process.env.SMTP_USER || '',
      pass: dbMap['smtp_pass'] || process.env.SMTP_PASS || '',
      from: dbMap['smtp_from'] || process.env.EMAIL_FROM || '"WhatsApp Gateway" <no-reply@whatsapp-gateway.local>',
      appUrl: dbMap['app_url'] || process.env.APP_URL || 'http://localhost:3000',
    };
  } catch (err) {
    return {
      host: process.env.SMTP_HOST || '',
      port: parseInt(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      user: process.env.SMTP_USER || '',
      pass: process.env.SMTP_PASS || '',
      from: process.env.EMAIL_FROM || '"WhatsApp Gateway" <no-reply@whatsapp-gateway.local>',
      appUrl: process.env.APP_URL || 'http://localhost:3000',
    };
  }
};

/**
 * Simpan konfigurasi SMTP ke database
 */
export const saveSmtpConfig = async ({ host, port, secure, user, pass, from, appUrl }) => {
  if (host !== undefined) await setSystemSetting('smtp_host', host.trim());
  if (port !== undefined) await setSystemSetting('smtp_port', String(port).trim());
  if (secure !== undefined) await setSystemSetting('smtp_secure', String(Boolean(secure)));
  if (user !== undefined) await setSystemSetting('smtp_user', user.trim());
  // Jika password diberikan (bukan kosong), bersihkan spasi jika Gmail dan update passwordnya
  if (pass !== undefined && pass !== '') {
    const isGmail = host && host.toLowerCase().includes('gmail');
    const cleanPass = isGmail ? String(pass).trim().replace(/\s+/g, '') : String(pass).trim();
    await setSystemSetting('smtp_pass', cleanPass);
  }
  if (from !== undefined) await setSystemSetting('smtp_from', from.trim());
  if (appUrl !== undefined) await setSystemSetting('app_url', appUrl.trim());
};

/**
 * Ambil konfigurasi Webhook dari database (dengan fallback ke .env)
 */
export const getWebhookConfig = async () => {
  const url       = await getSystemSetting('webhook_url', process.env.WEBHOOK_URL || '');
  const secret    = await getSystemSetting('webhook_secret', '');
  const eventsRaw = await getSystemSetting('webhook_events', '["message_received","message_delivered","message_read"]');
  const enabled   = await getSystemSetting('webhook_enabled', '1');

  let events = ['message_received', 'message_delivered', 'message_read'];
  try {
    events = JSON.parse(eventsRaw);
  } catch {}

  return {
    url: url ? url.trim() : '',
    secret: secret ? secret.trim() : '',
    events: Array.isArray(events) ? events : ['message_received'],
    enabled: enabled === '1' || enabled === 'true' || enabled === true,
  };
};

/**
 * Simpan konfigurasi Webhook ke database
 */
export const saveWebhookConfig = async ({ url, secret, events, enabled }) => {
  if (url !== undefined) await setSystemSetting('webhook_url', (url || '').trim());
  if (secret !== undefined) await setSystemSetting('webhook_secret', (secret || '').trim());
  if (events !== undefined) {
    const arr = Array.isArray(events) ? events : [];
    await setSystemSetting('webhook_events', JSON.stringify(arr));
  }
  if (enabled !== undefined) await setSystemSetting('webhook_enabled', enabled ? '1' : '0');
  return await getWebhookConfig();
};

/**
 * Ambil Master API Key yang aktif (prioritas dari database, fallback ke .env)
 */
export const getMasterApiKey = async () => {
  const dbKey = await getSystemSetting('master_api_key', null);
  if (dbKey && dbKey.trim()) return dbKey.trim();
  return process.env.API_KEY || 'my_secret_api_key_123';
};

/**
 * Regenerasi Master API Key baru & simpan ke database
 */
export const rotateMasterApiKey = async () => {
  const newKey = 'wag_' + crypto.randomBytes(24).toString('hex');
  await setSystemSetting('master_api_key', newKey);
  return newKey;
};

// ── Password Reset OTP Management ───────────────────────────────────────────

/**
 * Generate OTP 6 digit acak
 */
export const generateOtpCode = () => {
  return String(Math.floor(100000 + Math.random() * 900000));
};

/**
 * Buat OTP baru untuk reset password dan simpan ke DB
 * Hapus OTP lama milik user yang belum dipakai terlebih dahulu
 */
export const createPasswordResetOtp = async (userId, method = 'email') => {
  // Hapus OTP lama yang belum dipakai milik user ini
  await pool.query(
    `DELETE FROM password_resets WHERE user_id = ? AND used = 0`,
    [userId]
  );

  const otpCode  = generateOtpCode();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 menit

  const [result] = await pool.query(
    `INSERT INTO password_resets (user_id, otp_code, method, attempts, used, expires_at)
     VALUES (?, ?, ?, 0, 0, ?)`,
    [userId, otpCode, method, expiresAt]
  );

  return { id: result.insertId, otpCode, expiresAt };
};

/**
 * Cari OTP yang masih valid (belum expired, belum dipakai, attempts < 3)
 * Jika OTP cocok → return data OTP
 * Jika attempts >= 3 → throw error
 */
export const findAndValidateOtp = async (userId, otpCode) => {
  const [[otp]] = await pool.query(
    `SELECT * FROM password_resets
     WHERE user_id = ? AND used = 0 AND expires_at > NOW()
     ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );

  if (!otp) {
    return { valid: false, reason: 'expired' };
  }

  // Tambah counter attempts
  await pool.query(
    `UPDATE password_resets SET attempts = attempts + 1 WHERE id = ?`,
    [otp.id]
  );

  if (otp.attempts + 1 >= 3 && otp.otp_code !== otpCode) {
    // Invalidate OTP setelah 3x salah
    await pool.query(`UPDATE password_resets SET used = 1 WHERE id = ?`, [otp.id]);
    return { valid: false, reason: 'max_attempts' };
  }

  if (otp.otp_code !== otpCode) {
    return { valid: false, reason: 'wrong_otp', attemptsLeft: 3 - (otp.attempts + 1) };
  }

  return { valid: true, otpId: otp.id };
};

/**
 * Tandai OTP sebagai sudah digunakan (setelah reset password berhasil)
 */
export const markOtpUsed = async (otpId) => {
  await pool.query(`UPDATE password_resets SET used = 1 WHERE id = ?`, [otpId]);
};

/**
 * Hapus semua OTP yang sudah kadaluarsa (cleanup rutin)
 */
export const deleteExpiredOtps = async () => {
  try {
    await pool.query(`DELETE FROM password_resets WHERE expires_at < NOW() OR used = 1`);
  } catch {}
};

export default pool;
