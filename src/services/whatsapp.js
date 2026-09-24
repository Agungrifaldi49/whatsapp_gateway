import pino from 'pino';
import QRCodeTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  delay,
  Browsers,
} from '@whiskeysockets/baileys';
import fs from 'fs';
import path from 'path';
import {
  insertMessageLog,
  updateMessageLogStatus,
  insertIncomingMessage,
  insertSessionEvent,
} from './database.js';
import { dispatchWebhook } from './webhook.js';

/**
 * ════════════════════════════════════════════════════════════════
 * ── MULTI-SESSION WHATSAPP GATEWAY MANAGER ──
 * Memisahkan sesi WhatsApp antara Administrator dan setiap Customer
 * ════════════════════════════════════════════════════════════════
 */

// Map penyimpanan state seluruh sesi: Map<sessionId, SessionState>
const sessions = new Map();

// ── In-Memory Message & Retry Caches (Solusi "Waiting for this message" & Drop Sesi) ──
const messageStore = new Map();
const msgRetryCounterCache = new Map();

const cleanOldMessages = () => {
  if (messageStore.size > 2500) {
    const keysToDelete = Array.from(messageStore.keys()).slice(0, 500);
    keysToDelete.forEach(k => messageStore.delete(k));
  }
};

/**
 * Normalisasi ID Sesi dan pembuatan objek State Sesi
 * - 'admin'   → Folder: 'auth_info_baileys' (Sesi utama admin yang sudah ada)
 * - 'user_X'  → Folder: 'sessions/session_user_X' (Sesi terisolasi milik customer)
 */
export const getOrCreateSession = (sessionId = 'admin') => {
  const sId = String(sessionId || 'admin').trim();
  if (sessions.has(sId)) {
    return sessions.get(sId);
  }

  const isMainAdmin = sId === 'admin' || sId === 'main';
  const authDir = isMainAdmin ? 'auth_info_baileys' : path.join('sessions', `session_${sId}`);
  let parsedUserId = null;
  if (sId.startsWith('user_')) {
    parsedUserId = parseInt(sId.replace('user_', ''), 10) || null;
  } else if (!isMainAdmin && /^\d+$/.test(sId)) {
    parsedUserId = parseInt(sId, 10);
  }

  const sessionObj = {
    id: sId,
    userId: parsedUserId,
    sock: null,
    connectionStatus: 'disconnected', // 'disconnected' | 'connecting' | 'qr_ready' | 'connected'
    qrCodeRaw: null,
    qrCodeBase64: null,
    reconnectTimer: null,
    authDir,
    user: null,
  };

  sessions.set(sId, sessionObj);
  return sessionObj;
};

/**
 * Format Nomor HP ke Format WhatsApp JID (@s.whatsapp.net)
 * Mendukung format: 08xxx, 8xxx, +62xxx, 62xxx
 */
export const formatJID = (phone) => {
  if (!phone) return '';
  const trimmed = String(phone).trim();
  if (trimmed.endsWith('@s.whatsapp.net') || trimmed.endsWith('@g.us')) return trimmed;
  let cleaned = trimmed.replace(/[^0-9]/g, '');
  if (cleaned.startsWith('0')) {
    cleaned = '62' + cleaned.slice(1);
  } else if (cleaned.startsWith('8')) {
    cleaned = '62' + cleaned;
  }
  return `${cleaned}@s.whatsapp.net`;
};

/**
 * Deteksi MIME type berdasarkan ekstensi nama file
 */
export const detectMimeType = (fileName = '', defaultMime = 'application/octet-stream') => {
  if (!fileName) return defaultMime;
  const ext = path.extname(fileName).toLowerCase().replace('.', '');
  const mimeMap = {
    pdf:  'application/pdf',
    doc:  'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls:  'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt:  'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    csv:  'text/csv',
    txt:  'text/plain',
    zip:  'application/zip',
    rar:  'application/x-rar-compressed',
    jpg:  'image/jpeg',
    jpeg: 'image/jpeg',
    png:  'image/png',
    webp: 'image/webp',
    gif:  'image/gif',
    mp3:  'audio/mp3',
    mp4:  'video/mp4',
  };
  return mimeMap[ext] || defaultMime;
};

/**
 * Helper: Ambil data info user dari file kredensial jika tersedia
 */
const extractUserFromCreds = (authDir) => {
  try {
    const credsPath = path.join(authDir, 'creds.json');
    if (fs.existsSync(credsPath)) {
      const parsed = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
      if (parsed.me) {
        const rawId = parsed.me.id || '';
        const phone = rawId.split(':')[0]?.split('@')[0] || '';
        return {
          id: rawId,
          phone: phone ? (phone.startsWith('62') ? '0' + phone.slice(2) : phone) : '',
          formattedPhone: phone ? (phone.startsWith('62') ? '+62 ' + phone.slice(2) : phone) : '',
          name: parsed.me.name || '',
        };
      }
    }
  } catch {}
  return null;
};

/**
 * Tunggu hingga sesi siap (grace period jika socket sedang handshake / reconnecting)
 */
export const waitForConnection = async (maxWaitMs = 8000, sessionId = 'admin') => {
  const session = getOrCreateSession(sessionId);
  if (session.connectionStatus === 'connected' && session.sock) return true;
  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    if (session.connectionStatus === 'connected' && session.sock) return true;
    if (session.connectionStatus === 'qr_ready') return false; // Butuh scan QR, jangan tunda
    await delay(350);
  }
  return session.connectionStatus === 'connected' && !!session.sock;
};

/**
 * Inisialisasi & Pengelolaan Socket Baileys per Sesi
 */
export const connectToWhatsApp = async (sessionId = 'admin') => {
  const session = getOrCreateSession(sessionId);

  if (session.reconnectTimer) {
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
  }

  // Bersihkan socket sebelumnya agar tidak terjadi duplikasi koneksi
  if (session.sock) {
    try {
      session.sock.ev.removeAllListeners();
      session.sock.end(undefined);
    } catch {}
    session.sock = null;
  }

  session.connectionStatus = 'connecting';

  try {
    // Pastikan direktori sesi ada
    if (!fs.existsSync(session.authDir)) {
      fs.mkdirSync(session.authDir, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(session.authDir);
    const { version }          = await fetchLatestBaileysVersion();
    const logger               = pino({ level: 'silent' });

    const sock = makeWASocket({
      version,
      logger,
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      browser: Browsers.ubuntu('Chrome'),
      syncFullHistory: false,
      msgRetryCounterCache,
      getMessage: async (key) => {
        if (key && key.id && messageStore.has(key.id)) {
          return messageStore.get(key.id);
        }
        return { conversation: 'WhatsApp Gateway Notification' };
      },
      defaultQueryTimeoutMs: 60000,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 15000,
      generateHighQualityLinkPreview: true,
      markOnlineOnConnect: true,
    });

    session.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (connection === 'connecting') {
        session.connectionStatus = 'connecting';
      }

      if (qr) {
        session.qrCodeRaw        = qr;
        session.connectionStatus = 'qr_ready';
        try {
          session.qrCodeBase64 = await QRCode.toDataURL(qr);
        } catch {
          session.qrCodeBase64 = null;
        }

        console.log(`\n[WA Sesi: ${session.id}] Scan QR Code baru tersedia:`);
        if (session.id === 'admin') {
          QRCodeTerminal.generate(qr, { small: true });
        }

        await insertSessionEvent('qr_ready', `QR Code sesi [${session.id}] digenerate`).catch(() => {});
      }

      if (connection === 'close') {
        const statusCode      = lastDisconnect?.error?.output?.statusCode;
        const isRestartReq    = statusCode === DisconnectReason.restartRequired || statusCode === 515;
        const isLoggedOut     = statusCode === DisconnectReason.loggedOut;
        const shouldReconnect = !isLoggedOut;

        session.connectionStatus = 'disconnected';
        session.qrCodeRaw        = null;
        session.qrCodeBase64     = null;
        session.user             = null;

        console.log(`[WA Sesi: ${session.id}] Koneksi terputus (Status Code: ${statusCode}).`);
        await insertSessionEvent('disconnected', `Sesi [${session.id}] terputus, code: ${statusCode}`).catch(() => {});

        if (shouldReconnect) {
          const delayMs = isRestartReq ? 500 : 3000;
          console.log(`[WA Sesi: ${session.id}] Reconnect dalam ${delayMs / 1000} detik...`);
          session.reconnectTimer = setTimeout(() => connectToWhatsApp(session.id), delayMs);
        } else {
          console.log(`[WA Sesi: ${session.id}] Session di-logout dari WhatsApp. Menyiapkan QR Code baru...`);
          if (fs.existsSync(session.authDir)) {
            try { fs.rmSync(session.authDir, { recursive: true, force: true }); } catch {}
          }
          session.reconnectTimer = setTimeout(() => connectToWhatsApp(session.id), 1500);
        }

      } else if (connection === 'open') {
        session.connectionStatus = 'connected';
        session.qrCodeRaw        = null;
        session.qrCodeBase64     = null;

        const rawId = sock?.user?.id || '';
        const phone = rawId.split(':')[0]?.split('@')[0] || '';
        session.user = {
          id: rawId,
          phone: phone ? (phone.startsWith('62') ? '0' + phone.slice(2) : phone) : '',
          formattedPhone: phone ? (phone.startsWith('62') ? '+62 ' + phone.slice(2) : phone) : '',
          name: sock?.user?.name || '',
        };

        console.log(`\n[WA Sesi: ${session.id}] TERHUBUNG! Nomor: ${session.user.formattedPhone} (${session.user.name || 'Device'})\n`);
        await insertSessionEvent('connected', `Sesi [${session.id}] terhubung (${session.user.formattedPhone})`).catch(() => {});

        // Set presence 'available' agar server WhatsApp tidak menahan routing pesan (mencegah centang 1)
        sock.sendPresenceUpdate('available').catch(() => {});
      }
    });

    // Message Delivery Receipt / Updates Listener (ACK dari WA Server)
    sock.ev.on('messages.update', async (updates) => {
      for (const update of updates) {
        if (!update.key?.id) continue;
        const msgId = update.key.id;
        const statusVal = update.update?.status; // 2: SERVER_ACK, 3: DELIVERY_ACK, 4: READ
        if (statusVal === 3) {
          await updateMessageLogStatus(msgId, 'DELIVERED').catch(() => {});
          dispatchWebhook('message_delivered', {
            sessionId: session.id,
            userId: session.userId,
            msgId,
            status: 'DELIVERED',
            remoteJid: update.key?.remoteJid,
            timestamp: new Date().toISOString(),
          });
        } else if (statusVal === 4) {
          await updateMessageLogStatus(msgId, 'READ').catch(() => {});
          dispatchWebhook('message_read', {
            sessionId: session.id,
            userId: session.userId,
            msgId,
            status: 'READ',
            remoteJid: update.key?.remoteJid,
            timestamp: new Date().toISOString(),
          });
        }
      }
    });

    // Incoming Messages → Simpan ke DB dengan userId sesi + Trigger Webhook
    sock.ev.on('messages.upsert', async (m) => {
      if (m.type !== 'notify') return;
      for (const msg of m.messages) {
        // Simpan objek pesan untuk retry handler E2EE (mengatasi Waiting for this message)
        if (msg.key?.id && msg.message) {
          messageStore.set(msg.key.id, msg.message);
          cleanOldMessages();
        }

        if (msg.key.fromMe) continue;

        const senderJid   = msg.key.remoteJid || '';
        const senderPhone = senderJid.replace('@s.whatsapp.net', '').replace('@g.us', '');
        const text        = msg.message?.conversation
                         || msg.message?.extendedTextMessage?.text
                         || '';

        // Simpan pesan masuk ke database dengan userId spesifik
        await insertIncomingMessage({
          userId: session.userId,
          senderJid,
          senderPhone,
          message: text,
          rawPayload: msg,
        }).catch(() => {});

        // Dispatch Webhook Real-time
        dispatchWebhook('message_received', {
          sessionId: session.id,
          userId: session.userId,
          msgId: msg.key?.id,
          senderJid,
          senderPhone,
          message: text,
          timestamp: new Date().toISOString(),
        });

        // ── Auto-Responder Cerdas: Kasus Otomasi File Jadwal Pelajaran / Dokumen ──
        const lowerText = text.trim().toLowerCase();
        if (
          lowerText === 'jadwal' ||
          lowerText === '#jadwal' ||
          lowerText === 'minta jadwal' ||
          lowerText.includes('jadwal pelajaran') ||
          lowerText === '#jadwalsiswa'
        ) {
          console.log(`[Auto-Reply Jadwal] Menerima request "${text}" dari ${senderPhone}. Mengirim dokumen jadwal resmi...`);
          const samplePdfPath = path.resolve('public/assets/Jadwal_Pelajaran_Resmi.pdf');
          if (fs.existsSync(samplePdfPath)) {
            const pdfBuffer = fs.readFileSync(samplePdfPath);
            await session.sock.sendMessage(senderJid, {
              document: pdfBuffer,
              fileName: 'Jadwal_Pelajaran_Resmi_2026.pdf',
              mimetype: 'application/pdf',
              caption: '📄 *Halo!* Berikut kami kirimkan file Dokumen Jadwal Pelajaran resmi Anda.\n\nSilakan unduh dokumen PDF di atas untuk melihat jam belajar dan agenda lengkap.',
            }).catch(e => console.warn('[Auto-Reply Jadwal Error]', e.message));
          } else {
            await session.sock.sendMessage(senderJid, {
              text: '📄 *Jadwal Siswa Otomatis*\n\nJadwal pelajaran dapat diunduh di portal web sekolah atau hubungi bagian tata usaha.',
            }).catch(() => {});
          }
        }
      }
    });

  } catch (error) {
    console.error(`[WA Sesi: ${session.id} Error] Socket initialization error:`, error);
    session.connectionStatus = 'disconnected';
    setTimeout(() => connectToWhatsApp(session.id), 5000);
  }
};

/**
 * Ambil Status & QR Code untuk Sesi Tertentu
 * Jika sesi belum aktif, otomatis trigger koneksi agar QR Code segera terbuat
 */
export const getStatus = (sessionId = 'admin') => {
  const session = getOrCreateSession(sessionId);

  // Jika sesi belum aktif (belum ada socket), jalankan sekarang
  if (!session.sock && session.connectionStatus === 'disconnected') {
    connectToWhatsApp(session.id);
  }

  let userInfo = session.user;
  if (!userInfo && session.sock?.user) {
    const userObj = session.sock.user;
    const rawId = userObj.id || '';
    const phone = rawId.split(':')[0]?.split('@')[0] || '';
    userInfo = {
      id: rawId,
      phone: phone ? (phone.startsWith('62') ? '0' + phone.slice(2) : phone) : '',
      formattedPhone: phone ? (phone.startsWith('62') ? '+62 ' + phone.slice(2) : phone) : '',
      name: userObj.name || '',
    };
    session.user = userInfo;
  }

  if (!userInfo && session.connectionStatus === 'connected') {
    userInfo = extractUserFromCreds(session.authDir);
    if (userInfo) session.user = userInfo;
  }

  return {
    connection: session.connectionStatus,
    session_id: session.id,
    user_id:    session.userId,
    user:       userInfo,
    qr_raw:     session.connectionStatus === 'qr_ready' ? session.qrCodeRaw    : null,
    qr_image:   session.connectionStatus === 'qr_ready' ? session.qrCodeBase64 : null,
  };
};

/**
 * Kirim Pesan Tunggal via Sesi WhatsApp Tertentu (Mendukung Teks, Media Dokumen PDF, Gambar, Audio, Video)
 */
export const sendMessage = async (
  phone,
  message,
  source = 'api',
  userId = null,
  sessionId = 'admin',
  mediaOptions = null
) => {
  const session = getOrCreateSession(sessionId);

  // Langsung cek koneksi — TIDAK ada blocking wait agar pengiriman instan
  if (session.connectionStatus !== 'connected' || !session.sock) {
    if (session.connectionStatus === 'qr_ready') {
      const isCust = session.id !== 'admin';
      throw new Error(
        isCust
          ? 'WhatsApp Anda belum terhubung. Silakan scan QR Code di menu "Status & Scan QR WA".'
          : 'WhatsApp Gateway Admin belum terhubung. Silakan scan QR Code di menu "Status & Scan QR WA".'
      );
    }
    if (session.connectionStatus === 'connecting') {
      throw new Error('WhatsApp sedang dalam proses koneksi. Tunggu sebentar lalu coba kirim ulang.');
    }
    throw new Error('WhatsApp belum terhubung. Pastikan status CONNECTED di menu "Status & Scan QR WA".');
  }

  let jid = formatJID(phone);
  if (!jid) {
    throw new Error('Nomor tujuan tidak valid. Masukkan nomor HP aktif (contoh: 08123456789).');
  }

  // Verifikasi nomor di WhatsApp untuk memastikan nomor aktif & inisialisasi handshake enkripsi
  try {
    if (session.sock && !jid.endsWith('@g.us')) {
      const [contact] = await session.sock.onWhatsApp(jid);
      if (contact && contact.exists && contact.jid) {
        jid = contact.jid;
      }
    }
  } catch {}

  try {
    let result;
    let logMessageText = message || '';

    // Pengiriman File / Media (PDF, Dokumen, Gambar, Video, Audio)
    if (mediaOptions && (mediaOptions.mediaUrl || mediaOptions.fileBase64)) {
      const cleanFileName = mediaOptions.fileName || (mediaOptions.mediaUrl ? path.basename(mediaOptions.mediaUrl.split('?')[0]) : 'dokumen.pdf');
      const cleanMime = mediaOptions.mimetype || detectMimeType(cleanFileName);

      let mediaBuffer = null;
      if (mediaOptions.fileBase64) {
        const cleanBase64 = mediaOptions.fileBase64.replace(/^data:[^;]+;base64,/, '');
        mediaBuffer = Buffer.from(cleanBase64, 'base64');
      } else if (mediaOptions.mediaUrl) {
        // Jika berkas berada di public/ secara lokal
        if (mediaOptions.mediaUrl.startsWith('/')) {
          const localPath = path.join(process.cwd(), 'public', mediaOptions.mediaUrl);
          if (fs.existsSync(localPath)) {
            mediaBuffer = fs.readFileSync(localPath);
          }
        } else if (mediaOptions.mediaUrl.includes('localhost') || mediaOptions.mediaUrl.includes('127.0.0.1')) {
          try {
            const urlObj = new URL(mediaOptions.mediaUrl);
            const localPath = path.join(process.cwd(), 'public', urlObj.pathname);
            if (fs.existsSync(localPath)) {
              mediaBuffer = fs.readFileSync(localPath);
            }
          } catch {}
        }
      }

      const mediaSource = mediaBuffer || { url: mediaOptions.mediaUrl };
      const explicitType = mediaOptions.mediaType;

      if (explicitType === 'image' || cleanMime.startsWith('image/')) {
        result = await session.sock.sendMessage(jid, {
          image: mediaSource,
          caption: message || '',
        });
        logMessageText = `[GAMBAR: ${cleanFileName}] ${message || ''}`.trim();
      } else if (explicitType === 'video' || cleanMime.startsWith('video/')) {
        result = await session.sock.sendMessage(jid, {
          video: mediaSource,
          caption: message || '',
        });
        logMessageText = `[VIDEO: ${cleanFileName}] ${message || ''}`.trim();
      } else if (explicitType === 'audio' || cleanMime.startsWith('audio/')) {
        result = await session.sock.sendMessage(jid, {
          audio: mediaSource,
          mimetype: cleanMime || 'audio/mp4',
        });
        logMessageText = `[AUDIO: ${cleanFileName}] ${message || ''}`.trim();
      } else {
        // Default Dokumen (PDF, Excel, Word, Zip, dll.)
        result = await session.sock.sendMessage(jid, {
          document: mediaSource,
          fileName: cleanFileName,
          mimetype: cleanMime,
          caption: message || '',
        });
        logMessageText = `[FILE: ${cleanFileName}] ${message || ''}`.trim();
      }
    } else {
      // Pesan Teks Standar
      result = await session.sock.sendMessage(jid, { text: message });
    }

    const msgId = result?.key?.id || `LOCAL-${Date.now()}`;

    // Simpan objek pesan untuk menjawab permintaan retry Signal Protocol (mengatasi "Waiting for this message")
    if (result?.message && result?.key?.id) {
      messageStore.set(result.key.id, result.message);
      cleanOldMessages();
    }

    await insertMessageLog({
      msgId,
      phone,
      targetJid: jid,
      message: logMessageText,
      status: 'SUCCESS',
      source,
      userId,
    }).catch(() => {});

    const senderRaw = session.sock?.user?.id?.split(':')[0]?.split('@')[0] || session.user?.phone || '';
    const senderFormatted = senderRaw ? (senderRaw.startsWith('62') ? '0' + senderRaw.slice(2) : senderRaw) : 'Gateway';

    return {
      id: msgId,
      target: jid,
      phone,
      sender: senderFormatted,
      message: logMessageText,
      status: 'SUCCESS',
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    await insertMessageLog({
      msgId: `FAILED-${Date.now()}`,
      phone,
      targetJid: jid,
      message: message || 'Pesan gagal',
      status: 'FAILED',
      errorMsg: err.message,
      source,
      userId,
    }).catch(() => {});
    throw err;
  }
};

/**
 * Kirim Pesan Massal (Broadcast) dengan delay anti-banned via Sesi Tertentu
 */
export const sendBulkMessages = async (
  recipients,
  message,
  userId = null,
  sessionId = 'admin',
  mediaOptions = null
) => {
  const session = getOrCreateSession(sessionId);

  // Langsung cek koneksi — TIDAK ada blocking wait
  if (session.connectionStatus !== 'connected' || !session.sock) {
    throw new Error('WhatsApp belum terhubung. Pastikan status WhatsApp CONNECTED pada menu Status & Scan QR WA.');
  }

  const results = [];
  for (let i = 0; i < recipients.length; i++) {
    const phone = recipients[i].trim();
    try {
      const res = await sendMessage(phone, message, 'bulk', userId, sessionId, mediaOptions);
      results.push({ phone, status: 'SUCCESS', id: res.id });
    } catch (err) {
      await insertMessageLog({
        msgId:   `FAILED-${Date.now()}-${i}`,
        phone,
        targetJid: formatJID(phone),
        message: message || 'Broadcast gagal',
        status:  'FAILED',
        errorMsg: err.message,
        source:  'bulk',
        userId,
      }).catch(() => {});

      results.push({ phone, status: 'FAILED', error: err.message });
    }

    // Delay acak 2000–4000 ms untuk proteksi anti-ban WA
    if (i < recipients.length - 1) {
      const randomDelay = Math.floor(Math.random() * 2000) + 2000;
      await delay(randomDelay);
    }
  }

  return results;
};

/**
 * Logout Sesi WA & Hapus Folder Kredensial Sesi Terpilih Saja
 */
export const logoutWASession = async (sessionId = 'admin') => {
  const session = getOrCreateSession(sessionId);

  if (session.sock) {
    try {
      await session.sock.logout();
    } catch {}
  }

  session.connectionStatus = 'disconnected';
  session.qrCodeRaw        = null;
  session.qrCodeBase64     = null;
  session.user             = null;

  if (fs.existsSync(session.authDir)) {
    try {
      fs.rmSync(session.authDir, { recursive: true, force: true });
    } catch {}
  }

  await insertSessionEvent('logout', `Sesi WA [${session.id}] di-logout secara manual`).catch(() => {});
  setTimeout(() => connectToWhatsApp(session.id), 2000);
  return true;
};

/**
 * Boot Seluruh Sesi yang Tersimpan pada Saat Server Menyala
 */
export const initAllStoredSessions = async () => {
  console.log('[Multi-Session] Memulai sesi WhatsApp Admin utama...');
  connectToWhatsApp('admin');

  const sessionsDir = 'sessions';
  if (fs.existsSync(sessionsDir)) {
    try {
      const items = fs.readdirSync(sessionsDir, { withFileTypes: true });
      for (const item of items) {
        if (item.isDirectory() && item.name.startsWith('session_')) {
          const sId = item.name.replace('session_', '');
          const credsPath = path.join(sessionsDir, item.name, 'creds.json');
          if (fs.existsSync(credsPath)) {
            console.log(`[Multi-Session] Memulihkan sesi customer tersimpan: [${sId}]...`);
            connectToWhatsApp(sId);
          }
        }
      }
    } catch (err) {
      console.warn('[Multi-Session] Gagal memindai direktori sessions:', err.message);
    }
  }
};

/**
 * Perbaiki Kunci Enkripsi Sesi (Solusi Tuntas "Waiting for this message" & Centang 1)
 * Membersihkan session ratchets yang out-of-sync dan meminta pre-keys segar ke server WhatsApp
 */
export const fixSessionEncryption = async (targetPhone = null, sessionId = 'admin') => {
  const session = getOrCreateSession(sessionId);
  if (!fs.existsSync(session.authDir)) {
    return { success: false, message: 'Direktori sesi belum dibuat.' };
  }

  let deletedCount = 0;
  const files = fs.readdirSync(session.authDir);

  if (targetPhone) {
    const cleanPhone = String(targetPhone).replace(/[^0-9]/g, '');
    let targetNum = cleanPhone;
    if (targetNum.startsWith('0')) targetNum = '62' + targetNum.slice(1);

    const targetFiles = files.filter(f => f.startsWith(`session-${targetNum}`));
    targetFiles.forEach(f => {
      try {
        fs.unlinkSync(path.join(session.authDir, f));
        deletedCount++;
      } catch {}
    });

    const jid = `${targetNum}@s.whatsapp.net`;
    if (session.sock && typeof session.sock.assertSessions === 'function') {
      try {
        await session.sock.assertSessions([jid], true);
      } catch {}
    }

    return {
      success: true,
      deletedSessions: deletedCount,
      message: `Kunci sesi untuk kontak ${targetPhone} berhasil disegarkan. Pre-key baru telah dinegosiasi ulang dengan server WhatsApp.`,
    };
  } else {
    // Bersihkan semua file session-* yang kadaluarsa (tanpa menghapus creds.json login)
    const sessionFiles = files.filter(f => f.startsWith('session-'));
    sessionFiles.forEach(f => {
      try {
        fs.unlinkSync(path.join(session.authDir, f));
        deletedCount++;
      } catch {}
    });

    // Upload kumpulan Pre-Keys baru ke server WhatsApp jika socket terhubung
    if (session.sock && typeof session.sock.uploadPreKeysToServerIfRequired === 'function') {
      try {
        await session.sock.uploadPreKeysToServerIfRequired();
      } catch {}
    }

    return {
      success: true,
      deletedSessions: deletedCount,
      message: `Berhasil membersihkan ${deletedCount} cache sesi enkripsi lama. Seluruh kunci Pre-Key WhatsApp telah disegarkan ke server.`,
    };
  }
};
