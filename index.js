import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';

import path from 'path';
import { fileURLToPath } from 'url';

import authRoutes from './src/routes/auth.js';
import apiRoutes  from './src/routes/api.js';
import { initAllStoredSessions }            from './src/services/whatsapp.js';
import { initDatabase }                  from './src/services/database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment
dotenv.config({ path: path.join(__dirname, '.env') });

const app     = express();
const PORT    = process.env.PORT    || 3000;
const AUTH_DIR = process.env.AUTH_DIR || 'auth_info_baileys';

// Aktifkan trust proxy agar rate limit mendeteksi IP asli pengguna di balik cPanel / Apache / Reverse Proxy
app.set('trust proxy', 1);

// ── Security Middlewares ──────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(cookieParser());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ── Rate Limiters ─────────────────────────────────────────────────────────────
// Login: maks 10 percobaan / 15 menit → anti brute-force
const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  skipSuccessfulRequests: true, // Hanya hitung percobaan yang GAGAL
  message: { status: false, message: 'Terlalu banyak percobaan login. Coba lagi dalam 15 menit.' },
});

// General API: maks 300 req / menit → anti-DDoS
const generalRateLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 300,
  message: { status: false, message: 'Batas request API terlampaui. Harap perlambat request Anda.' },
});



// ── Web Page Routes ──────────────────────────────────────────────────────────
// Halaman utama (/) diarahkan langsung ke landing.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});

// Halaman login & dashboard control panel
app.get(['/login', '/login.html', '/dashboard', '/app'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Halaman panduan e-book
app.get(['/panduan', '/panduan.html'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'panduan.html'));
});

// ── Static Web Files ──────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/auth/login', loginRateLimiter);
app.use('/api/auth', authRoutes);

// Mount di /api/v1 (primary) dan /api (alias backward-compat)
app.use('/api/v1', generalRateLimiter, apiRoutes);
app.use('/api',    generalRateLimiter, apiRoutes);

// ── Global Error Handler ──────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[Global Error Handler]', err);
  if (err.type === 'entity.too.large') {
    return res.status(413).json({
      status: false,
      message: 'Ukuran berkas melebihi batas yang diizinkan (maksimal 50 MB).'
    });
  }
  res.status(err.status || 500).json({ status: false, message: err.message || 'Internal Server Error' });
});

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ status: false, message: 'Endpoint tidak ditemukan.' });
});

// ── Startup ───────────────────────────────────────────────────────────────────
const start = async () => {
  // 1. Inisialisasi database & tabel MySQL (non-fatal jika XAMPP belum jalan)
  try {
    await initDatabase();
  } catch (dbErr) {
    console.warn('[Database] MySQL tidak tersedia. Jalankan XAMPP lalu restart server.');
    console.warn('[Database] Error:', dbErr.message);
    console.warn('[Database] Server tetap berjalan, fitur log pesan tidak aktif sementara.');
  }

  // 2. Start Express HTTP Server
  app.listen(PORT, () => {
    console.log(`[HTTP Server] Berjalan pada http://localhost:${PORT}`);
  });

  // 3. Init multi-session Baileys (WhatsApp)
  initAllStoredSessions();
};

start().catch((err) => {
  console.error('[FATAL] Gagal menjalankan server:', err);
  process.exit(1);
});
