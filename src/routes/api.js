import express from 'express';
import {
  getStatus,
  sendMessage,
  sendBulkMessages,
  logoutWASession,
  fixSessionEncryption,
} from '../services/whatsapp.js';
import {
  getMessageLogs,
  countMessageLogs,
  getDashboardStats,
  getIncomingMessages,
  countIncomingMessages,
  getCustomerStats,
  getCustomerMessageLogs,
  countCustomerMessageLogs,
  getCustomerById,
  incrementUserMessageSent,
  getWebhookConfig,
  saveWebhookConfig,
  getMasterApiKey,
  rotateMasterApiKey,
  regenerateApiKey,
} from '../services/database.js';
import { testWebhook } from '../services/webhook.js';
import { verifyHybridAuth, verifyAdminJWT } from '../middleware/auth.js';

const router = express.Router();

/**
 * Helper: Tentukan Session ID WhatsApp berdasarkan siapa yang sedang mengakses
 * - Customer via Web Login / JWT  → 'user_<id>'
 * - Customer via API Key          → 'user_<id>'
 * - Admin / Operator / Master Key → 'admin'
 */
export const resolveSessionId = (req) => {
  if (req.customer) {
    return `user_${req.customer.id}`;
  }
  if (req.user) {
    if (req.user.role === 'admin' || req.user.role === 'operator') {
      return 'admin';
    }
    return `user_${req.user.id}`;
  }
  if (req.isMasterApi) {
    return 'admin';
  }
  return 'admin';
};

/**
 * GET /api/v1/status — Status Koneksi WA
 * Mendukung otentikasi dinamis:
 * - Admin     → Mengembalikan status sesi WhatsApp Admin (auth_info_baileys)
 * - Customer  → Mengembalikan status sesi WhatsApp Customer sendiri (sessions/session_user_X)
 * - Publik    → Mengembalikan status sesi default/admin (untuk indikator live landing page)
 */
router.get('/status', async (req, res) => {
  let sessionId = 'admin';

  try {
    // 1. Cek JWT Token (Authorization header atau cookie)
    const token = req.cookies?.admin_token
      || (req.headers['authorization']?.startsWith('Bearer ') ? req.headers['authorization'].slice(7).trim() : null);

    if (token) {
      const jwt = (await import('jsonwebtoken')).default;
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret');
      if (decoded.role === 'customer') {
        sessionId = `user_${decoded.id}`;
      } else {
        sessionId = 'admin';
      }
    } else {
      // 2. Cek API Key (Header x-api-key atau query param)
      const clientKey = req.headers['x-api-key'] || req.query?.api_key;
      if (clientKey) {
        const { findUserByApiKey, getMasterApiKey } = await import('../services/database.js');
        const masterKey = await getMasterApiKey();
        if (clientKey !== masterKey && clientKey !== process.env.API_KEY) {
          const customer = await findUserByApiKey(clientKey);
          if (customer) {
            sessionId = `user_${customer.id}`;
          }
        }
      }
    }
  } catch {}

  const statusData = getStatus(sessionId);
  return res.status(200).json({ status: true, data: statusData });
});

/**
 * GET /api/v1/stats — Statistik Dashboard (Admin = Seluruh Sistem, Customer = Personal)
 */
router.get('/stats', verifyHybridAuth, async (req, res) => {
  try {
    // Jika customer yang meminta, berikan statistik personal mereka
    if (req.user?.role === 'customer' || req.customer) {
      const customerId = req.customer?.id || req.user.id;
      const stats = await getCustomerStats(customerId);
      return res.status(200).json({ status: true, data: stats });
    }

    // Untuk Admin / Operator / Master API: Statistik Global
    const stats = await getDashboardStats();
    return res.status(200).json({ status: true, data: stats });
  } catch (err) {
    return res.status(500).json({ status: false, message: err.message });
  }
});

/**
 * POST /api/v1/send-message — Kirim Pesan Tunggal (Teks atau Media/Dokumen) via Sesi WhatsApp Masing-masing
 */
router.post('/send-message', verifyHybridAuth, async (req, res) => {
  const { phone, message, caption, mediaUrl, fileBase64, fileName, mediaType, mimetype } = req.body;
  const finalMessage = message !== undefined ? message : (caption || '');

  if (!phone || (!finalMessage && !mediaUrl && !fileBase64)) {
    return res.status(400).json({ status: false, message: 'Parameter "phone" dan "message" atau file media wajib diisi.' });
  }

  // Tentukan apakah pengirim adalah customer (via API Key atau Web Session)
  const customerId = req.customer?.id || (req.user?.role === 'customer' ? req.user.id : null);

  if (customerId) {
    const cust = await getCustomerById(customerId);
    if (!cust || cust.status !== 'active' || !cust.is_active) {
      return res.status(403).json({ status: false, message: 'Akun customer tidak aktif atau belum disetujui.' });
    }
    // Jika message_quota !== -1, periksa kuota (quota -1 adalah Unlimited)
    if (cust.message_quota !== -1 && cust.messages_sent >= cust.message_quota) {
      return res.status(403).json({
        status: false,
        message: 'Batas kuota pesan Anda telah habis. Hubungi Admin untuk upgrade kuota pesan.',
      });
    }
  }

  try {
    const source = req.user ? 'dashboard' : 'api';
    const sessionId = resolveSessionId(req);
    const mediaOptions = (mediaUrl || fileBase64) ? {
      mediaUrl,
      fileBase64,
      fileName,
      mediaType,
      mimetype
    } : null;

    const result = await sendMessage(phone, finalMessage, source, customerId, sessionId, mediaOptions);

    // Tambah counter pesan jika pengirim customer
    if (customerId) {
      await incrementUserMessageSent(customerId);
    }

    return res.status(200).json({ status: true, message: 'Pesan berhasil dikirim.', data: result });
  } catch (err) {
    return res.status(500).json({ status: false, message: err.message });
  }
});

/**
 * POST /api/v1/send-media — Alias untuk Kirim File Media / Dokumen
 */
router.post('/send-media', verifyHybridAuth, async (req, res) => {
  // Alias mengarahkan parameter ke handler yang sama
  const { phone, message, caption, mediaUrl, fileBase64, fileName, mediaType, mimetype } = req.body;
  const finalMessage = message !== undefined ? message : (caption || '');

  if (!phone || (!mediaUrl && !fileBase64)) {
    return res.status(400).json({ status: false, message: 'Parameter "phone" dan media ("mediaUrl" atau "fileBase64") wajib diisi.' });
  }

  const customerId = req.customer?.id || (req.user?.role === 'customer' ? req.user.id : null);

  if (customerId) {
    const cust = await getCustomerById(customerId);
    if (!cust || cust.status !== 'active' || !cust.is_active) {
      return res.status(403).json({ status: false, message: 'Akun customer tidak aktif atau belum disetujui.' });
    }
    if (cust.message_quota !== -1 && cust.messages_sent >= cust.message_quota) {
      return res.status(403).json({
        status: false,
        message: 'Batas kuota pesan Anda telah habis. Hubungi Admin untuk upgrade kuota pesan.',
      });
    }
  }

  try {
    const source = req.user ? 'dashboard' : 'api';
    const sessionId = resolveSessionId(req);
    const mediaOptions = {
      mediaUrl,
      fileBase64,
      fileName,
      mediaType,
      mimetype
    };

    const result = await sendMessage(phone, finalMessage, source, customerId, sessionId, mediaOptions);

    if (customerId) {
      await incrementUserMessageSent(customerId);
    }

    return res.status(200).json({ status: true, message: 'Media berhasil dikirim.', data: result });
  } catch (err) {
    return res.status(500).json({ status: false, message: err.message });
  }
});

/**
 * POST /api/v1/send-bulk — Kirim Pesan Massal (Blast) via Sesi WhatsApp Masing-masing
 */
router.post('/send-bulk', verifyHybridAuth, async (req, res) => {
  const { phones, message, caption, mediaUrl, fileBase64, fileName, mediaType, mimetype } = req.body;
  const finalMessage = message !== undefined ? message : (caption || '');

  if (!Array.isArray(phones) || phones.length === 0 || (!finalMessage && !mediaUrl && !fileBase64)) {
    return res.status(400).json({ status: false, message: 'Parameter "phones" (array) dan "message" atau file media wajib diisi.' });
  }

  const customerId = req.customer?.id || (req.user?.role === 'customer' ? req.user.id : null);

  if (customerId) {
    const cust = await getCustomerById(customerId);
    if (!cust || cust.status !== 'active' || !cust.is_active) {
      return res.status(403).json({ status: false, message: 'Akun customer tidak aktif atau belum disetujui.' });
    }
    // Jika bukan unlimited (-1), periksa sisa kuota
    if (cust.message_quota !== -1) {
      const remaining = Math.max(0, cust.message_quota - cust.messages_sent);
      if (phones.length > remaining) {
        return res.status(403).json({
          status: false,
          message: `Sisa kuota pesan Anda (${remaining}) tidak mencukupi untuk mengirim ke ${phones.length} nomor. Hubungi Admin untuk top-up kuota.`,
        });
      }
    }
  }

  try {
    const sessionId = resolveSessionId(req);
    const mediaOptions = (mediaUrl || fileBase64) ? {
      mediaUrl,
      fileBase64,
      fileName,
      mediaType,
      mimetype
    } : null;

    const results = await sendBulkMessages(phones, finalMessage, customerId, sessionId, mediaOptions);

    // Tambah counter untuk setiap pesan sukses
    if (customerId) {
      const successCount = results.filter(r => r.status === 'SUCCESS').length;
      for (let i = 0; i < successCount; i++) {
        await incrementUserMessageSent(customerId);
      }
    }

    return res.status(200).json({ status: true, message: 'Pengiriman broadcast selesai.', data: results });
  } catch (err) {
    return res.status(500).json({ status: false, message: err.message });
  }
});

/**
 * GET /api/v1/logs — Riwayat Log Pesan Keluar
 * Customer hanya melihat log pesan miliknya sendiri, Admin melihat seluruhnya
 */
router.get('/logs', verifyHybridAuth, async (req, res) => {
  try {
    const limit  = parseInt(req.query.limit)  || 10;
    const offset = parseInt(req.query.offset) || 0;

    // Jika customer login
    if (req.user?.role === 'customer' || req.customer) {
      const customerId = req.customer?.id || req.user.id;
      const [logs, total] = await Promise.all([
        getCustomerMessageLogs(customerId, limit, offset),
        countCustomerMessageLogs(customerId),
      ]);
      return res.status(200).json({ status: true, total, limit, offset, data: logs });
    }

    // Untuk Admin / Operator: Semua pesan
    const [logs, total] = await Promise.all([
      getMessageLogs(limit, offset),
      countMessageLogs(),
    ]);
    return res.status(200).json({ status: true, total, limit, offset, data: logs });
  } catch (err) {
    return res.status(500).json({ status: false, message: err.message });
  }
});

/**
 * GET /api/v1/incoming — Pesan WA Masuk
 * Customer melihat pesan masuk ke nomor WA miliknya, Admin melihat seluruhnya
 */
router.get('/incoming', verifyHybridAuth, async (req, res) => {
  try {
    const limit  = parseInt(req.query.limit)  || 10;
    const offset = parseInt(req.query.offset) || 0;
    const isCustomer = req.user?.role === 'customer' || req.customer;
    const targetUserId = isCustomer ? (req.customer?.id || req.user.id) : null;

    const [rows, total] = await Promise.all([
      getIncomingMessages(limit, offset, targetUserId),
      countIncomingMessages(targetUserId),
    ]);
    return res.status(200).json({ status: true, total, limit, offset, data: rows });
  } catch (err) {
    return res.status(500).json({ status: false, message: err.message });
  }
});

/**
 * POST /api/v1/logout-wa — Logout Sesi WA Terpilih (Sesi Admin atau Sesi Customer Terkait)
 */
router.post('/logout-wa', verifyHybridAuth, async (req, res) => {
  try {
    const sessionId = resolveSessionId(req);
    await logoutWASession(sessionId);
    return res.status(200).json({ status: true, message: `Sesi WhatsApp [${sessionId}] berhasil di-logout.` });
  } catch (err) {
    return res.status(500).json({ status: false, message: 'Gagal logout sesi WhatsApp.' });
  }
});

/**
 * POST /api/v1/fix-session — Perbaiki Kunci Enkripsi (Solusi "Waiting for this message" & Centang 1)
 */
router.post('/fix-session', verifyHybridAuth, async (req, res) => {
  try {
    const sessionId = resolveSessionId(req);
    const { phone } = req.body || {};
    const result = await fixSessionEncryption(phone, sessionId);
    return res.status(200).json({
      status: true,
      message: result.message,
      data: result,
    });
  } catch (err) {
    return res.status(500).json({ status: false, message: err.message || 'Gagal memperbaiki kunci sesi.' });
  }
});

/**
 * GET /api/v1/token — Ambil Token API Aktif (Admin = Master Key, Customer = Personal API Key)
 */
router.get('/token', verifyHybridAuth, async (req, res) => {
  try {
    if (req.user?.role === 'customer' || req.customer) {
      const customerId = req.customer?.id || req.user.id;
      const cust = await getCustomerById(customerId);
      return res.status(200).json({
        status: true,
        data: {
          token: cust?.api_key || '',
          role: 'customer',
          quota: cust?.message_quota || 0,
          used: cust?.messages_sent || 0,
        },
      });
    }

    const masterKey = await getMasterApiKey();
    return res.status(200).json({
      status: true,
      data: {
        token: masterKey,
        role: req.user?.role || 'admin',
      },
    });
  } catch (err) {
    return res.status(500).json({ status: false, message: err.message });
  }
});

/**
 * POST /api/v1/token/rotate — Regenerasi Token API Baru
 */
router.post('/token/rotate', verifyHybridAuth, async (req, res) => {
  try {
    if (req.user?.role === 'customer' || req.customer) {
      const customerId = req.customer?.id || req.user.id;
      const newToken = await regenerateApiKey(customerId);
      return res.status(200).json({
        status: true,
        message: 'Token API Anda berhasil di-regenerasi.',
        data: { token: newToken },
      });
    }

    const newMasterKey = await rotateMasterApiKey();
    return res.status(200).json({
      status: true,
      message: 'Master Token API berhasil di-regenerasi.',
      data: { token: newMasterKey },
    });
  } catch (err) {
    return res.status(500).json({ status: false, message: err.message });
  }
});

/**
 * GET /api/v1/webhook — Ambil Konfigurasi Webhook (Admin Only)
 */
router.get('/webhook', verifyHybridAuth, async (req, res) => {
  if (req.user?.role === 'customer' || req.customer) {
    return res.status(403).json({ status: false, message: 'Akses ditolak: Fitur ini khusus untuk Admin & Operator.' });
  }
  try {
    const config = await getWebhookConfig();
    return res.status(200).json({ status: true, data: config });
  } catch (err) {
    return res.status(500).json({ status: false, message: err.message });
  }
});

/**
 * POST /api/v1/webhook — Simpan Konfigurasi Webhook (Admin Only)
 */
router.post('/webhook', verifyHybridAuth, async (req, res) => {
  if (req.user?.role === 'customer' || req.customer) {
    return res.status(403).json({ status: false, message: 'Akses ditolak: Fitur ini khusus untuk Admin & Operator.' });
  }
  try {
    const { url, secret, events, enabled } = req.body;
    const updated = await saveWebhookConfig({ url, secret, events, enabled });
    return res.status(200).json({
      status: true,
      message: 'Konfigurasi Webhook berhasil disimpan.',
      data: updated,
    });
  } catch (err) {
    return res.status(500).json({ status: false, message: err.message });
  }
});

/**
 * POST /api/v1/webhook/test — Uji Coba Webhook (Ping Test)
 */
router.post('/webhook/test', verifyHybridAuth, async (req, res) => {
  if (req.user?.role === 'customer' || req.customer) {
    return res.status(403).json({ status: false, message: 'Akses ditolak: Fitur ini khusus untuk Admin & Operator.' });
  }
  try {
    const { url, secret } = req.body;
    const currentConfig = await getWebhookConfig();
    const testUrl = url ? url.trim() : currentConfig.url;
    const testSecret = secret !== undefined ? secret.trim() : currentConfig.secret;

    if (!testUrl) {
      return res.status(400).json({ status: false, message: 'URL Webhook belum diisi. Masukkan URL tujuan untuk pengujian.' });
    }

    const result = await testWebhook(testUrl, testSecret);
    return res.status(200).json({ status: true, data: result });
  } catch (err) {
    return res.status(400).json({ status: false, message: err.message });
  }
});

export default router;
