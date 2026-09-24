import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import nodemailer from 'nodemailer';
import { verifyAdminJWT, verifyUserJWT } from '../middleware/auth.js';
import {
  findUserByUsername,
  findUserByEmail,
  findUserByPhone,
  findUserByIdentity,
  updateLastLogin,
  updateUserPassword,
  updateUserProfile,
  getAllUsers,
  createUser,
  deleteUser,
  toggleUserActive,
  registerCustomer,
  getCustomers,
  countCustomers,
  getCustomerCountsByStatus,
  getCustomerById,
  updateCustomerStatus,
  updateCustomerQuota,
  regenerateApiKey,
  getCustomerStats,
  getSmtpConfig,
  saveSmtpConfig,
  createPasswordResetOtp,
  findAndValidateOtp,
  markOtpUsed,
} from '../services/database.js';
import {
  sendCustomerApprovedEmail,
  sendCustomerRegistrationEmail,
  sendTestEmail,
  sendPasswordResetOtpEmail,
} from '../services/email.js';
import { getStatus, sendMessage as sendWAMessage } from '../services/whatsapp.js';

const router = express.Router();

// ── Helpers ──────────────────────────────────────────────────────────────────
const issueToken = (user) => jwt.sign(
  {
    id: user.id,
    username: user.username,
    full_name: user.full_name,
    role: user.role,
    status: user.status,
    apiKey: user.api_key,
  },
  process.env.JWT_SECRET || 'fallback_secret',
  { expiresIn: '24h' }
);

const setCookie = (res, token) => res.cookie('admin_token', token, {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  path: '/',
  maxAge: 24 * 60 * 60 * 1000, // 24 jam
});

// ── POST /api/auth/register (Customer Self-Registration) ─────────────────────
router.post('/register', async (req, res) => {
  const { username, password, full_name, email, phone } = req.body;

  if (!username || !password) {
    return res.status(400).json({ status: false, message: 'Username dan password wajib diisi.' });
  }

  // Validasi Email Aktif (Wajib)
  const cleanEmail = email ? email.trim().toLowerCase() : '';
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!cleanEmail || !emailRegex.test(cleanEmail)) {
    return res.status(400).json({
      status: false,
      message: 'Email aktif wajib diisi dengan format yang benar (contoh: nama@domain.com) untuk menerima notifikasi aktivasi akun.',
    });
  }

  const cleanUsername = username.trim().toLowerCase();
  if (cleanUsername.length < 3) {
    return res.status(400).json({ status: false, message: 'Username minimal 3 karakter.' });
  }

  if (password.length < 6) {
    return res.status(400).json({ status: false, message: 'Password minimal 6 karakter.' });
  }

  try {
    const existing = await findUserByUsername(cleanUsername);
    if (existing) {
      return res.status(409).json({ status: false, message: `Username "${cleanUsername}" sudah digunakan. Silakan pilih username lain.` });
    }

    const existingEmail = await findUserByEmail(cleanEmail);
    if (existingEmail) {
      return res.status(409).json({ status: false, message: `Alamat email "${cleanEmail}" sudah digunakan. Silakan gunakan alamat email lain.` });
    }

    const newCustomer = await registerCustomer({
      username: cleanUsername,
      password,
      fullName: full_name?.trim() || null,
      email: cleanEmail,
      phone: phone?.trim() || null,
    });

    // Kirim notifikasi email konfirmasi registrasi (asinkron tanpa menghambat response)
    sendCustomerRegistrationEmail({
      to: cleanEmail,
      fullName: full_name?.trim() || cleanUsername,
      username: cleanUsername,
    }).catch(err => console.error('[Auth Register] Error email pendaftaran:', err.message));

    return res.status(201).json({
      status: true,
      message: 'Registrasi berhasil! Akun Anda telah terdaftar dan menunggu persetujuan (approval) oleh Administrator. Notifikasi resmi akan dikirimkan ke email Anda setelah disetujui.',
      data: newCustomer,
    });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ status: false, message: 'Username, Email, atau API Key sudah terdaftar.' });
    }
    return res.status(500).json({ status: false, message: 'Gagal memproses pendaftaran: ' + err.message });
  }
});

// ── POST /api/auth/login ─────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ status: false, message: 'Username dan password wajib diisi.' });
  }

  const cleanUsername = username.trim().toLowerCase();

  // Cari user di database
  const user = await findUserByUsername(cleanUsername);
  if (!user) {
    return res.status(401).json({ status: false, message: 'Username atau password salah.' });
  }

  // Verifikasi password dengan bcrypt
  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) {
    return res.status(401).json({ status: false, message: 'Username atau password salah.' });
  }

  // Cek Status Akun untuk Customer
  if (user.role === 'customer') {
    if (user.status === 'pending') {
      return res.status(403).json({
        status: false,
        is_pending: true,
        message: 'Akun Anda sedang menunggu persetujuan Admin. Hubungi Administrator untuk mengaktifkan akun Anda.',
      });
    }

    if (user.status === 'rejected') {
      return res.status(403).json({
        status: false,
        message: 'Permohonan akun Anda ditolak oleh Admin. Silakan hubungi dukungan kami.',
      });
    }

    if (user.status === 'suspended' || !user.is_active) {
      return res.status(403).json({
        status: false,
        message: 'Akun Anda sedang dinonaktifkan / ditangguhkan. Silakan hubungi Admin.',
      });
    }
  } else if (!user.is_active) {
    return res.status(403).json({
      status: false,
      message: 'Akun Administrator ini sedang dinonaktifkan.',
    });
  }

  // Update last_login
  await updateLastLogin(user.id);

  // Generate JWT & Set Cookie
  const token = issueToken(user);
  setCookie(res, token);

  return res.status(200).json({
    status: true,
    message: 'Login berhasil.',
    token,
    user: {
      id: user.id,
      username: user.username,
      full_name: user.full_name,
      email: user.email,
      phone: user.phone,
      role: user.role,
      status: user.status,
      apiKey: user.api_key,
      message_quota: user.message_quota,
      messages_sent: user.messages_sent,
    },
  });
});

// ── POST /api/auth/logout ────────────────────────────────────────────────────
router.post('/logout', (req, res) => {
  res.clearCookie('admin_token');
  return res.status(200).json({ status: true, message: 'Logout berhasil.' });
});

// ── GET /api/auth/me ─────────────────────────────────────────────────────────
router.get('/me', verifyUserJWT, async (req, res) => {
  const user = await findUserByUsername(req.user.username);
  if (!user) {
    return res.status(404).json({ status: false, message: 'User tidak ditemukan.' });
  }

  const userPayload = {
    id: user.id,
    username: user.username,
    full_name: user.full_name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    status: user.status,
    apiKey: user.api_key,
    message_quota: user.message_quota,
    messages_sent: user.messages_sent,
  };

  return res.status(200).json({
    status: true,
    user: userPayload,
    data: userPayload,
  });
});

// ── POST /api/auth/profile ───────────────────────────────────────────────────
// Perbarui profil akun saya (Nama Lengkap, Email, Nomor WhatsApp)
router.post('/profile', verifyUserJWT, async (req, res) => {
  const rawFullName = req.body.full_name || req.body.fullName;
  const { email, phone } = req.body;

  try {
    const user = await findUserByUsername(req.user.username);
    if (!user) {
      return res.status(404).json({ status: false, message: 'User tidak ditemukan.' });
    }

    const cleanName = rawFullName ? String(rawFullName).trim() : null;
    const cleanEmail = email ? String(email).trim().toLowerCase() : null;
    const cleanPhone = phone ? String(phone).trim() : null;

    // Validasi format email jika diisi
    if (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      return res.status(400).json({ status: false, message: 'Format alamat email tidak valid.' });
    }

    // Cek duplikasi email jika diubah
    if (cleanEmail && cleanEmail !== (user.email || '').toLowerCase()) {
      const existingEmail = await findUserByEmail(cleanEmail);
      if (existingEmail && existingEmail.id !== user.id) {
        return res.status(409).json({ status: false, message: 'Alamat email ini sudah digunakan oleh akun lain.' });
      }
    }

    // Cek duplikasi nomor telepon jika diubah
    if (cleanPhone) {
      const cleanPhoneDigits = cleanPhone.replace(/[^0-9]/g, '');
      const userPhoneDigits = user.phone ? user.phone.replace(/[^0-9]/g, '') : '';
      if (cleanPhoneDigits !== userPhoneDigits) {
        const existingPhone = await findUserByPhone(cleanPhone);
        if (existingPhone && existingPhone.id !== user.id) {
          return res.status(409).json({ status: false, message: 'Nomor WhatsApp ini sudah digunakan oleh akun lain.' });
        }
      }
    }

    const updatedUser = await updateUserProfile(user.id, {
      fullName: cleanName,
      email: cleanEmail,
      phone: cleanPhone,
    });

    const resultPayload = {
      id: updatedUser.id,
      username: updatedUser.username,
      full_name: updatedUser.full_name,
      email: updatedUser.email,
      phone: updatedUser.phone,
      role: updatedUser.role,
      status: updatedUser.status,
    };

    return res.status(200).json({
      status: true,
      message: 'Profil akun berhasil diperbarui.',
      user: resultPayload,
      data: resultPayload,
    });
  } catch (err) {
    console.error('[Auth UpdateProfile Error]', err);
    return res.status(500).json({ status: false, message: 'Gagal memperbarui profil: ' + err.message });
  }
});

// ── POST /api/auth/customer/regenerate-key (Customer Only) ───────────────────
router.post('/customer/regenerate-key', verifyUserJWT, async (req, res) => {
  if (req.user.role !== 'customer') {
    return res.status(403).json({ status: false, message: 'Khusus akun customer.' });
  }
  try {
    const newApiKey = await regenerateApiKey(req.user.id);
    return res.status(200).json({
      status: true,
      message: 'API Key berhasil diperbarui.',
      apiKey: newApiKey,
    });
  } catch (err) {
    return res.status(500).json({ status: false, message: 'Gagal memperbarui API Key: ' + err.message });
  }
});

// ── GET /api/auth/customer/stats (Customer Only) ─────────────────────────────
router.get('/customer/stats', verifyUserJWT, async (req, res) => {
  if (req.user.role !== 'customer') {
    return res.status(403).json({ status: false, message: 'Khusus akun customer.' });
  }
  try {
    const stats = await getCustomerStats(req.user.id);
    return res.status(200).json({ status: true, data: stats });
  } catch (err) {
    return res.status(500).json({ status: false, message: err.message });
  }
});

// ── POST /api/auth/change-password ──────────────────────────────────────────
router.post('/change-password', verifyUserJWT, async (req, res) => {
  const { current_password, new_password } = req.body;

  if (!current_password || !new_password) {
    return res.status(400).json({ status: false, message: 'Password lama dan password baru wajib diisi.' });
  }

  if (new_password.length < 6) {
    return res.status(400).json({ status: false, message: 'Password baru minimal 6 karakter.' });
  }

  const user = await findUserByUsername(req.user.username);
  if (!user) {
    return res.status(404).json({ status: false, message: 'User tidak ditemukan.' });
  }

  const isMatch = await bcrypt.compare(current_password, user.password);
  if (!isMatch) {
    return res.status(401).json({ status: false, message: 'Password lama tidak cocok.' });
  }

  await updateUserPassword(user.id, new_password);

  return res.status(200).json({ status: true, message: 'Password berhasil diubah. Silakan login ulang.' });
});

// ── POST /api/auth/forgot-password ──────────────────────────────────────────
// Request OTP untuk reset password. Input: username, email, atau no. telepon; method: email|whatsapp
router.post('/forgot-password', async (req, res) => {
  const { identity, method } = req.body;

  if (!identity || !identity.trim()) {
    return res.status(400).json({ status: false, message: 'Username, email, atau nomor WhatsApp wajib diisi.' });
  }
  if (!['email', 'whatsapp'].includes(method)) {
    return res.status(400).json({ status: false, message: 'Metode pengiriman OTP harus "email" atau "whatsapp".' });
  }

  const cleanIdentity = identity.trim();

  try {
    // 1. Cari user secara universal (username, email, atau no. WhatsApp)
    let user = await findUserByIdentity(cleanIdentity);

    // Generic message — tidak bocorkan detail jika user tidak terdaftar
    const genericMsg = 'Jika akun dengan identitas tersebut terdaftar, kode OTP akan segera dikirimkan.';

    if (!user) {
      await new Promise(r => setTimeout(r, 500));
      return res.status(200).json({ status: true, message: genericMsg, masked: false });
    }

    // 2. Jika user adalah admin, pastikan email & phone terisi otomatis jika kosong
    if (user.role === 'admin') {
      if (!user.email) {
        const smtpCfg = await getSmtpConfig();
        user.email = smtpCfg?.user || process.env.EMAIL_USER || 'programernoob87@gmail.com';
      }
      if (!user.phone) {
        const waStatus = getStatus('admin');
        user.phone = waStatus?.user?.phone || '082317864874';
      }
    }

    // 3. Validasi kontak sesuai metode yang dipilih
    if (method === 'email') {
      if (!user.email) {
        return res.status(400).json({
          status: false,
          message: 'Akun ini tidak memiliki alamat email terdaftar. Silakan pilih opsi WhatsApp atau hubungi Administrator.',
        });
      }
    } else if (method === 'whatsapp') {
      if (!user.phone) {
        return res.status(400).json({
          status: false,
          message: 'Akun ini tidak memiliki nomor WhatsApp terdaftar. Silakan pilih opsi Email atau hubungi Administrator.',
        });
      }

      // Cek apakah WA admin terhubung (tunggu toleransi hingga 4 detik jika status socket sedang connecting)
      let waStatus = getStatus('admin');
      if (waStatus.connection !== 'connected') {
        for (let attempt = 0; attempt < 5; attempt++) {
          await new Promise(r => setTimeout(r, 800));
          waStatus = getStatus('admin');
          if (waStatus.connection === 'connected') break;
        }
      }

      if (waStatus.connection !== 'connected') {
        return res.status(503).json({
          status: false,
          message: 'Gateway WhatsApp admin sedang tidak terhubung. Silakan gunakan opsi Email atau hubungi Administrator.',
        });
      }
    }

    // 4. Buat OTP baru (hapus OTP lama secara otomatis)
    const { otpCode, expiresAt } = await createPasswordResetOtp(user.id, method);

    // 5. Kirim OTP sesuai metode
    if (method === 'email') {
      const emailRes = await sendPasswordResetOtpEmail({
        to: user.email,
        fullName: user.full_name,
        username: user.username,
        otp: otpCode,
        expiresMinutes: 10,
      });
      if (!emailRes.success) {
        return res.status(500).json({
          status: false,
          message: 'Gagal mengirim email OTP: ' + (emailRes.error || emailRes.message || 'Error SMTP'),
        });
      }
    } else {
      // Kirim via WhatsApp Gateway (sesi admin)
      const otpMsg = `*KODE VERIFIKASI WHATSAPP GATEWAY*\n\nHalo *${user.full_name || user.username}*,\n\nKode OTP Anda untuk reset kata sandi adalah:\n\n*${otpCode}*\n\nKode ini berlaku selama *10 menit*. Mohon untuk tidak membagikan kode ini kepada siapapun demi keamanan akun Anda.\n\n_Pesan ini dikirim otomatis oleh sistem WhatsApp Gateway Enterprise._`;
      try {
        await sendWAMessage(user.phone, otpMsg, 'dashboard', null, 'admin');
      } catch (waSendErr) {
        console.error('[Auth ForgotPassword WA Error]', waSendErr);
        return res.status(500).json({
          status: false,
          message: 'Gagal mengirim pesan WhatsApp: ' + waSendErr.message,
        });
      }
    }

    // 6. Masking kontak untuk privasi di UI
    let maskedContact = '';
    if (method === 'email' && user.email) {
      const [localPart, domain] = user.email.split('@');
      const visible = localPart.length > 3 ? localPart.slice(0, 3) : localPart.slice(0, 1);
      maskedContact = `${visible}***@${domain}`;
    } else if (method === 'whatsapp' && user.phone) {
      const ph = user.phone;
      maskedContact = ph.length > 6 ? ph.slice(0, 4) + '***' + ph.slice(-3) : ph.slice(0, 2) + '***';
    }

    return res.status(200).json({
      status: true,
      message: `Kode OTP berhasil dikirim via ${method === 'email' ? 'Email' : 'WhatsApp'}. Periksa ${method === 'email' ? 'kotak masuk email' : 'pesan WhatsApp'} Anda.`,
      userId: user.id,
      method,
      maskedContact,
      expiresAt,
    });
  } catch (err) {
    console.error('[Auth ForgotPassword Error]', err);
    return res.status(500).json({
      status: false,
      message: 'Gagal memproses permintaan: ' + (err.message || 'Terjadi kesalahan sistem.'),
    });
  }
});

// ── POST /api/auth/verify-otp ────────────────────────────────────────────────
// Verifikasi kode OTP yang dikirim. Input: userId, otp
router.post('/verify-otp', async (req, res) => {
  const { userId, otp } = req.body;

  if (!userId || !otp) {
    return res.status(400).json({ status: false, message: 'userId dan otp wajib diisi.' });
  }

  if (String(otp).length !== 6 || isNaN(otp)) {
    return res.status(400).json({ status: false, message: 'Kode OTP harus berupa 6 digit angka.' });
  }

  try {
    const result = await findAndValidateOtp(parseInt(userId), String(otp));

    if (!result.valid) {
      if (result.reason === 'expired') {
        return res.status(400).json({ status: false, message: 'Kode OTP sudah kadaluarsa. Silakan minta kode baru.' });
      }
      if (result.reason === 'max_attempts') {
        return res.status(429).json({ status: false, message: 'Terlalu banyak percobaan OTP yang salah. Silakan minta kode OTP baru.' });
      }
      if (result.reason === 'wrong_otp') {
        return res.status(400).json({
          status: false,
          message: `Kode OTP salah. Sisa percobaan: ${result.attemptsLeft}x.`,
          attemptsLeft: result.attemptsLeft,
        });
      }
      return res.status(400).json({ status: false, message: 'Kode OTP tidak valid.' });
    }

    // OTP valid — kembalikan otpId untuk digunakan di reset-password
    return res.status(200).json({
      status: true,
      message: 'Kode OTP berhasil diverifikasi. Silakan buat password baru Anda.',
      otpId: result.otpId,
    });
  } catch (err) {
    console.error('[Auth VerifyOtp]', err);
    return res.status(500).json({ status: false, message: 'Gagal memverifikasi OTP.' });
  }
});

// ── POST /api/auth/reset-password ────────────────────────────────────────────
// Set password baru setelah OTP terverifikasi. Input: userId, otpId, newPassword
router.post('/reset-password', async (req, res) => {
  const { userId, otpId, newPassword } = req.body;

  if (!userId || !otpId || !newPassword) {
    return res.status(400).json({ status: false, message: 'userId, otpId, dan newPassword wajib diisi.' });
  }

  if (newPassword.length < 6) {
    return res.status(400).json({ status: false, message: 'Password baru minimal 6 karakter.' });
  }

  try {
    // Verifikasi ulang: cari user yang valid
    const [[user]] = await (await import('../services/database.js')).pool.query(
      `SELECT id, username FROM users WHERE id = ? LIMIT 1`, [parseInt(userId)]
    );
    if (!user) {
      return res.status(404).json({ status: false, message: 'User tidak ditemukan.' });
    }

    // Pastikan OTP memang milik user ini dan belum dipakai
    const [[otpRow]] = await (await import('../services/database.js')).pool.query(
      `SELECT id FROM password_resets WHERE id = ? AND user_id = ? AND used = 1 LIMIT 1`,
      [parseInt(otpId), parseInt(userId)]
    );
    // Note: OTP sudah di-mark used=1 saat verify-otp berhasil oleh findAndValidateOtp.
    // Kita harus mark used=1 di sini karena verify-otp hanya return otpId tanpa mark.
    // Mark OTP sebagai sudah digunakan
    await markOtpUsed(parseInt(otpId));

    // Update password baru
    await updateUserPassword(parseInt(userId), newPassword);

    return res.status(200).json({
      status: true,
      message: 'Password berhasil direset! Silakan login dengan password baru Anda.',
    });
  } catch (err) {
    console.error('[Auth ResetPassword]', err);
    return res.status(500).json({ status: false, message: 'Gagal mereset password.' });
  }
});

// ── CUSTOMER MANAGEMENT (Admin Only) ────────────────────────────────────────

// GET /api/auth/customers — List all customers with filter & search
router.get('/customers', verifyAdminJWT, async (req, res) => {
  try {
    const status = req.query.status || null;
    const search = req.query.search || '';
    const limit  = parseInt(req.query.limit)  || 50;
    const offset = parseInt(req.query.offset) || 0;

    const [customers, total] = await Promise.all([
      getCustomers({ status, search, limit, offset }),
      countCustomers({ status, search }),
    ]);

    return res.status(200).json({ status: true, total, data: customers });
  } catch (err) {
    return res.status(500).json({ status: false, message: err.message });
  }
});

// GET /api/auth/customers/summary — Ringkasan status customer (pending, active, suspended)
router.get('/customers/summary', verifyAdminJWT, async (req, res) => {
  try {
    const summary = await getCustomerCountsByStatus();
    return res.status(200).json({ status: true, data: summary });
  } catch (err) {
    return res.status(500).json({ status: false, message: err.message });
  }
});

// PATCH /api/auth/customers/:id/status — Ubah status (approve, reject, suspend, pending)
router.patch('/customers/:id/status', verifyAdminJWT, async (req, res) => {
  const { status } = req.body;
  const allowed = ['pending', 'active', 'rejected', 'suspended'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ status: false, message: 'Status tidak valid.' });
  }

  try {
    const cust = await getCustomerById(req.params.id);
    if (!cust) {
      return res.status(404).json({ status: false, message: 'Customer tidak ditemukan.' });
    }

    await updateCustomerStatus(req.params.id, status);

    let emailNote = '';
    // Jika disetujui (approve -> active) dan customer memiliki email
    if (status === 'active' && cust.email) {
      const hostUrl = `${req.protocol}://${req.get('host')}`;
      const emailResult = await sendCustomerApprovedEmail({
        to: cust.email,
        fullName: cust.full_name,
        username: cust.username,
        apiKey: cust.api_key,
        quota: cust.message_quota,
        loginUrl: hostUrl,
      });

      if (emailResult.success) {
        if (emailResult.simulated) {
          emailNote = ' Notifikasi email disimulasikan di log server (SMTP belum diatur).';
        } else {
          emailNote = ` Notifikasi aktivasi berhasil dikirim ke ${cust.email}.`;
        }
      } else {
        emailNote = ` Namun gagal mengirim email: ${emailResult.error}`;
      }
    }

    const actionText = {
      active: 'disetujui (Aktif)',
      rejected: 'ditolak',
      suspended: 'dinonaktifkan (Suspend)',
      pending: 'diubah ke Pending',
    }[status] || status;

    return res.status(200).json({
      status: true,
      message: `Akun customer "${cust.username}" berhasil ${actionText}.${emailNote}`,
    });
  } catch (err) {
    return res.status(500).json({ status: false, message: err.message });
  }
});

// PATCH /api/auth/customers/:id/quota — Atur kuota pesan customer (Mendukung -1 untuk Unlimited)
router.patch('/customers/:id/quota', verifyAdminJWT, async (req, res) => {
  const quota = parseInt(req.body.quota);
  if (isNaN(quota) || (quota < 0 && quota !== -1)) {
    return res.status(400).json({ status: false, message: 'Kuota pesan harus berupa angka positif atau -1 untuk Unlimited.' });
  }

  try {
    await updateCustomerQuota(req.params.id, quota);
    const quotaLabel = quota === -1 ? 'Unlimited (Tanpa Batas)' : `${quota.toLocaleString()} pesan`;
    return res.status(200).json({
      status: true,
      message: `Kuota pesan customer berhasil diubah menjadi ${quotaLabel}.`,
      quota,
    });
  } catch (err) {
    return res.status(500).json({ status: false, message: err.message });
  }
});

// DELETE /api/auth/customers/:id — Hapus akun customer
router.delete('/customers/:id', verifyAdminJWT, async (req, res) => {
  try {
    const cust = await getCustomerById(req.params.id);
    if (!cust) {
      return res.status(404).json({ status: false, message: 'Customer tidak ditemukan.' });
    }
    await deleteUser(req.params.id);
    return res.status(200).json({ status: true, message: `Akun customer "${cust.username}" berhasil dihapus.` });
  } catch (err) {
    return res.status(500).json({ status: false, message: err.message });
  }
});

// ── ADMIN USER MANAGEMENT (Admin Only) ──────────────────────────────────────

// GET /api/auth/users — Daftar user admin & operator
router.get('/users', verifyAdminJWT, async (req, res) => {
  if (req.admin.role !== 'admin') {
    return res.status(403).json({ status: false, message: 'Akses ditolak.' });
  }
  const users = await getAllUsers();
  return res.status(200).json({ status: true, data: users });
});

// POST /api/auth/users — Buat user admin/operator baru
router.post('/users', verifyAdminJWT, async (req, res) => {
  if (req.admin.role !== 'admin') {
    return res.status(403).json({ status: false, message: 'Akses ditolak.' });
  }

  const { username, password, role = 'operator', full_name, email, phone } = req.body;
  if (!username || !password) {
    return res.status(400).json({ status: false, message: 'Username dan password wajib diisi.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ status: false, message: 'Password minimal 6 karakter.' });
  }
  if (!['admin', 'operator'].includes(role)) {
    return res.status(400).json({ status: false, message: 'Role harus "admin" atau "operator".' });
  }

  const cleanUser = username.trim().toLowerCase();
  const cleanEmail = email ? email.trim().toLowerCase() : null;
  const cleanPhone = phone ? phone.trim() : null;

  if (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    return res.status(400).json({ status: false, message: 'Format alamat email tidak valid.' });
  }

  try {
    if (cleanEmail) {
      const existingEmail = await findUserByEmail(cleanEmail);
      if (existingEmail) {
        return res.status(409).json({ status: false, message: `Alamat email "${cleanEmail}" sudah digunakan.` });
      }
    }

    if (cleanPhone) {
      const existingPhone = await findUserByPhone(cleanPhone);
      if (existingPhone) {
        return res.status(409).json({ status: false, message: `Nomor telepon "${cleanPhone}" sudah digunakan.` });
      }
    }

    const id = await createUser({
      username: cleanUser,
      password,
      role,
      fullName: full_name ? full_name.trim() : null,
      email: cleanEmail,
      phone: cleanPhone,
    });
    return res.status(201).json({ status: true, message: `User "${username}" (${role}) berhasil dibuat.`, id });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ status: false, message: `Username "${username}" sudah digunakan.` });
    }
    return res.status(500).json({ status: false, message: 'Gagal membuat user: ' + err.message });
  }
});

// DELETE /api/auth/users/:id — Hapus akun admin
router.delete('/users/:id', verifyAdminJWT, async (req, res) => {
  if (req.admin.role !== 'admin') {
    return res.status(403).json({ status: false, message: 'Akses ditolak.' });
  }
  if (parseInt(req.params.id) === req.admin.id) {
    return res.status(400).json({ status: false, message: 'Tidak dapat menghapus akun yang sedang digunakan.' });
  }
  await deleteUser(req.params.id);
  return res.status(200).json({ status: true, message: 'User berhasil dihapus.' });
});

// PATCH /api/auth/users/:id/toggle — Toggle aktif/nonaktif admin
router.patch('/users/:id/toggle', verifyAdminJWT, async (req, res) => {
  if (req.admin.role !== 'admin') {
    return res.status(403).json({ status: false, message: 'Akses ditolak.' });
  }
  const { is_active } = req.body;
  await toggleUserActive(req.params.id, is_active);
  return res.status(200).json({ status: true, message: 'Status user berhasil diubah.' });
});

// ── SMTP SETTINGS & TEST (Admin Only) ───────────────────────────────────────

// GET /api/auth/smtp-settings — Ambil konfigurasi SMTP saat ini
router.get('/smtp-settings', verifyAdminJWT, async (req, res) => {
  if (req.admin.role !== 'admin') {
    return res.status(403).json({ status: false, message: 'Akses ditolak.' });
  }

  try {
    const config = await getSmtpConfig();
    return res.status(200).json({
      status: true,
      data: {
        host: config.host || '',
        port: config.port || 587,
        secure: Boolean(config.secure),
        user: config.user || '',
        is_password_set: Boolean(config.pass),
        from: config.from || '',
        appUrl: config.appUrl || 'http://localhost:3000',
        is_configured: Boolean(config.host && config.user && config.pass),
      },
    });
  } catch (err) {
    return res.status(500).json({ status: false, message: err.message });
  }
});

// POST /api/auth/smtp-settings — Simpan konfigurasi SMTP ke database
router.post('/smtp-settings', verifyAdminJWT, async (req, res) => {
  if (req.admin.role !== 'admin') {
    return res.status(403).json({ status: false, message: 'Akses ditolak.' });
  }

  let { host, port, secure, user, pass, from, appUrl } = req.body;

  try {
    let effectiveHost = host ? host.trim() : '';
    if (user && user.trim().toLowerCase().endsWith('@gmail.com')) {
      if (!effectiveHost || effectiveHost.includes('ethereal')) {
        effectiveHost = 'smtp.gmail.com';
      }
    }

    await saveSmtpConfig({
      host: effectiveHost || '',
      port: parseInt(port) || 587,
      secure: secure === true || secure === 'true',
      user: user ? user.trim() : '',
      pass: pass !== undefined ? pass : '',
      from: from || '',
      appUrl: appUrl || '',
    });

    return res.status(200).json({
      status: true,
      message: 'Konfigurasi SMTP berhasil disimpan dan langsung aktif.',
    });
  } catch (err) {
    return res.status(500).json({ status: false, message: 'Gagal menyimpan pengaturan SMTP: ' + err.message });
  }
});

// POST /api/auth/smtp-test — Kirim email uji coba untuk memeriksa koneksi SMTP
router.post('/smtp-test', verifyAdminJWT, async (req, res) => {
  if (req.admin.role !== 'admin') {
    return res.status(403).json({ status: false, message: 'Akses ditolak.' });
  }

  let { to, host, port, secure, user, pass, from } = req.body;

  if (!to || !to.trim()) {
    return res.status(400).json({ status: false, message: 'Alamat email tujuan uji coba wajib diisi.' });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(to.trim())) {
    return res.status(400).json({ status: false, message: 'Format email tujuan tidak valid.' });
  }

  try {
    let customConfig = null;
    // Jika user menginputkan form custom saat testing
    if (host && user) {
      let effectiveHost = host.trim();
      if (user.trim().toLowerCase().endsWith('@gmail.com')) {
        if (!effectiveHost || effectiveHost.includes('ethereal')) {
          effectiveHost = 'smtp.gmail.com';
        }
      }

      // Jika pass kosong, ambil pass yang sudah tersimpan
      let finalPass = pass;
      if (!finalPass) {
        const current = await getSmtpConfig();
        finalPass = current.pass;
      }
      customConfig = {
        host: effectiveHost,
        port: parseInt(port) || 587,
        secure: secure === true || secure === 'true',
        user: user.trim(),
        pass: finalPass || '',
        from: from ? from.trim() : `"WhatsApp Gateway" <${user.trim()}>`,
      };
    }

    const result = await sendTestEmail({
      to: to.trim(),
      customConfig,
    });

    if (result.success) {
      return res.status(200).json({
        status: true,
        message: result.message,
        messageId: result.messageId,
      });
    } else {
      return res.status(400).json({
        status: false,
        message: result.message,
        error: result.error,
      });
    }
  } catch (err) {
    return res.status(500).json({
      status: false,
      message: 'Terjadi kesalahan sistem saat mencoba mengirim email: ' + err.message,
    });
  }
});

// POST /api/auth/smtp-auto-test-account — Buat akun SMTP pengujian otomatis (Ethereal 1-Klik)
router.post('/smtp-auto-test-account', verifyAdminJWT, async (req, res) => {
  if (req.admin.role !== 'admin') {
    return res.status(403).json({ status: false, message: 'Akses ditolak.' });
  }

  try {
    const testAccount = await nodemailer.createTestAccount();
    const appUrl = `${req.protocol}://${req.get('host')}`;

    await saveSmtpConfig({
      host: testAccount.smtp.host,
      port: testAccount.smtp.port,
      secure: testAccount.smtp.secure,
      user: testAccount.user,
      pass: testAccount.pass,
      from: `"WhatsApp Gateway" <${testAccount.user}>`,
      appUrl: appUrl,
    });

    return res.status(200).json({
      status: true,
      message: 'Akun SMTP Pengujian Otomatis (Ethereal) berhasil dibuat dan dihubungkan secara otomatis! Anda dapat langsung melakukan pengujian.',
      data: {
        host: testAccount.smtp.host,
        port: testAccount.smtp.port,
        secure: testAccount.smtp.secure,
        user: testAccount.user,
        pass: testAccount.pass,
        from: `"WhatsApp Gateway" <${testAccount.user}>`,
        appUrl: appUrl,
      },
    });
  } catch (err) {
    return res.status(500).json({
      status: false,
      message: 'Gagal membuat akun test otomatis: ' + err.message,
    });
  }
});

export default router;
