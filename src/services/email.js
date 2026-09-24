import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
import { getSmtpConfig } from './database.js';
dotenv.config();

/**
 * Cek apakah konfigurasi SMTP valid & terisi
 */
export const checkSmtpConfig = (cfg) => {
  return Boolean(cfg && cfg.host && cfg.user && cfg.pass);
};

/**
 * Buat instance Nodemailer Transporter dinamis
 */
export const createTransporter = async (customConfig = null) => {
  const config = customConfig || await getSmtpConfig();

  if (!checkSmtpConfig(config)) {
    return { transporter: null, config, isConfigured: false };
  }

  const isGmail = Boolean(
    (config.host && config.host.toLowerCase().includes('gmail')) ||
    (config.user && config.user.toLowerCase().endsWith('@gmail.com')) ||
    (config.user && config.user.toLowerCase().endsWith('@googlemail.com'))
  );
  const cleanPass = config.pass ? String(config.pass).trim().replace(/\s+/g, '') : '';
  const port = parseInt(config.port) || 587;
  const isSecure = config.secure === true || config.secure === 'true' || port === 465;

  let transportOpts;
  if (isGmail) {
    transportOpts = {
      service: 'gmail',
      auth: {
        user: String(config.user).trim(),
        pass: cleanPass,
      },
      connectionTimeout: 12000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
    };
  } else {
    transportOpts = {
      host: config.host,
      port: port,
      secure: isSecure,
      auth: {
        user: String(config.user).trim(),
        pass: cleanPass,
      },
      connectionTimeout: 12000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
    };
  }

  const transporter = nodemailer.createTransport(transportOpts);

  return { transporter, config: { ...config, pass: cleanPass }, isConfigured: true };
};

/**
 * Uji coba koneksi & kirim email test ke alamat yang ditentukan
 */
export const sendTestEmail = async ({ to, customConfig = null }) => {
  if (!to) {
    return { success: false, message: 'Alamat email tujuan pengujian wajib diisi.' };
  }

  const { transporter, config, isConfigured } = await createTransporter(customConfig);

  if (!isConfigured || !transporter) {
    return {
      success: false,
      message: 'Konfigurasi SMTP belum lengkap. Mohon isi SMTP Host, Email/User, dan Password/App Password.',
    };
  }

  const fromAddress = config.from || `"WhatsApp Gateway" <${config.user}>`;

  const html = `
<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0b0f19; color: #e2e8f0; margin: 0; padding: 25px; }
    .card { max-width: 540px; margin: 0 auto; background: #111827; border: 1px solid #10b981; border-radius: 12px; padding: 26px; box-shadow: 0 8px 20px rgba(0,0,0,0.5); }
    .title { color: #34d399; font-size: 20px; font-weight: bold; margin: 0 0 10px; }
    .box { background: #1e293b; border-radius: 8px; padding: 14px; margin: 16px 0; font-size: 13px; line-height: 1.6; }
    .footer { font-size: 12px; color: #64748b; margin-top: 20px; border-top: 1px solid #1e293b; padding-top: 12px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="title">✅ Koneksi SMTP Berhasil Terhubung!</div>
    <p style="color: #94a3b8; font-size: 14px;">
      Ini adalah email uji coba dari server <strong>WhatsApp Gateway API</strong>. Jika Anda menerima email ini, berarti konfigurasi SMTP Anda sudah berjalan normal.
    </p>
    <div class="box">
      <strong>Detail Pengujian:</strong><br>
      • SMTP Host: <code>${config.host}:${config.port}</code><br>
      • Pengirim: <code>${fromAddress}</code><br>
      • Penerima: <code>${to}</code><br>
      • Waktu Kirim: ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB
    </div>
    <p style="color: #38bdf8; font-size: 13px;">
      Notifikasi persetujuan (approval) customer sekarang akan terkirim secara otomatis ke email customer yang mendaftar.
    </p>
    <div class="footer">
      WhatsApp Gateway Enterprise &bull; Sistem Otomatis
    </div>
  </div>
</body>
</html>
  `;

  try {
    // Verifikasi handshake SMTP
    await transporter.verify();

    // Kirim email test
    const info = await transporter.sendMail({
      from: fromAddress,
      to,
      subject: '✅ Uji Coba Koneksi SMTP WhatsApp Gateway Berhasil!',
      text: `Halo!\n\nKoneksi SMTP WhatsApp Gateway berhasil tersambung.\nHost: ${config.host}:${config.port}\nPengirim: ${fromAddress}\nPenerima: ${to}\n\nSistem siap mengirimkan notifikasi aktivasi customer secara otomatis.`,
      html,
    });

    const previewUrl = nodemailer.getTestMessageUrl(info);
    let successMessage = `Email uji coba berhasil dikirim ke ${to}. Silakan cek kotak masuk (atau folder spam).`;
    if (previewUrl) {
      successMessage = `Email uji coba berhasil terkirim! Klik tautan preview untuk melihat email: ${previewUrl}`;
    }

    return {
      success: true,
      message: successMessage,
      messageId: info.messageId,
      previewUrl: previewUrl || null,
    };
  } catch (err) {
    console.error('[EmailService Test Error]', err);
    let userFriendlyErr = err.message;
    const isGmail = Boolean(config.host && config.host.toLowerCase().includes('gmail'));
    const rawPass = config.pass ? String(config.pass).trim().replace(/\s+/g, '') : '';

    if (err.message.includes('Invalid login') || err.message.includes('535') || err.message.includes('Username and Password not accepted')) {
      if (isGmail) {
        if (rawPass.length !== 16) {
          userFriendlyErr = `Google menolak login karena panjang password saat ini adalah ${rawPass.length} karakter. Google TIDAK mengizinkan password login biasa Gmail. Anda WAJIB membuat "Sandi Aplikasi" (App Password) yang panjangnya tepat 16 karakter di https://myaccount.google.com/apppasswords.`;
        } else {
          userFriendlyErr = `Google menolak autentikasi dengan Sandi Aplikasi 16 karakter ini. Pastikan akun Gmail "${config.user}" telah mengaktifkan Verifikasi 2 Langkah dan buat Sandi Aplikasi baru di https://myaccount.google.com/apppasswords.`;
        }
      } else {
        userFriendlyErr = 'Autentikasi gagal (Username atau Password ditolak oleh server email). Silakan periksa kembali email dan kata sandi Anda.';
      }
    } else if (err.message.includes('ETIMEDOUT') || err.message.includes('ECONNREFUSED')) {
      userFriendlyErr = `Koneksi ke host ${config.host}:${config.port} batas waktu habis / ditolak. Periksa Host dan Port (Port 587 untuk TLS atau Port 465 untuk SSL).`;
    }
    return {
      success: false,
      message: `Gagal mengirim email uji coba: ${userFriendlyErr}`,
      error: err.message,
    };
  }
};

/**
 * Kirim Notifikasi Email: Akun Customer Disetujui (Approved)
 */
export const sendCustomerApprovedEmail = async ({
  to,
  fullName,
  username,
  apiKey,
  quota = 100,
  loginUrl,
}) => {
  const { transporter, config, isConfigured } = await createTransporter();
  const appUrl = loginUrl || config.appUrl || 'http://localhost:3000';
  const fromAddress = config.from || `"WhatsApp Gateway" <${config.user || 'no-reply@whatsapp-gateway.local'}>`;
  const name = fullName || username;

  const htmlContent = `
<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Akun WhatsApp Gateway Anda Telah Disetujui</title>
  <style>
    body {
      margin: 0;
      padding: 0;
      background-color: #0b0f19;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      color: #e2e8f0;
      -webkit-font-smoothing: antialiased;
    }
    .wrapper {
      width: 100%;
      table-layout: fixed;
      background-color: #0b0f19;
      padding: 30px 10px;
    }
    .email-container {
      max-width: 580px;
      margin: 0 auto;
      background: #111827;
      border: 1px solid #1e293b;
      border-radius: 14px;
      overflow: hidden;
      box-shadow: 0 10px 25px rgba(0, 0, 0, 0.5);
    }
    .header {
      background: linear-gradient(135deg, #059669 0%, #10b981 50%, #047857 100%);
      padding: 32px 24px;
      text-align: center;
    }
    .header h1 {
      margin: 0;
      color: #ffffff;
      font-size: 24px;
      font-weight: 700;
      letter-spacing: -0.5px;
    }
    .header p {
      margin: 8px 0 0;
      color: #d1fae5;
      font-size: 14px;
    }
    .badge {
      display: inline-block;
      background: #065f46;
      border: 1px solid #34d399;
      color: #a7f3d0;
      padding: 4px 12px;
      border-radius: 9999px;
      font-size: 12px;
      font-weight: 600;
      margin-top: 10px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .body-content {
      padding: 28px 24px;
    }
    .greeting {
      font-size: 16px;
      color: #f8fafc;
      margin-bottom: 16px;
    }
    .text {
      font-size: 14px;
      line-height: 1.6;
      color: #94a3b8;
      margin: 0 0 20px;
    }
    .info-card {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 10px;
      padding: 18px;
      margin: 20px 0;
    }
    .api-key-box {
      background: #0f172a;
      border: 1px dashed #38bdf8;
      border-radius: 8px;
      padding: 12px;
      margin-top: 14px;
      font-family: 'Courier New', Courier, monospace;
      font-size: 13px;
      color: #38bdf8;
      word-break: break-all;
      text-align: center;
      letter-spacing: 0.5px;
    }
    .btn-container {
      text-align: center;
      margin: 28px 0 16px;
    }
    .btn {
      display: inline-block;
      background: #10b981;
      color: #ffffff !important;
      text-decoration: none;
      padding: 12px 30px;
      border-radius: 8px;
      font-weight: 600;
      font-size: 14px;
      box-shadow: 0 4px 12px rgba(16, 185, 129, 0.35);
    }
    .note-box {
      background: rgba(56, 189, 248, 0.08);
      border-left: 3px solid #38bdf8;
      padding: 12px 14px;
      border-radius: 0 6px 6px 0;
      font-size: 12px;
      color: #93c5fd;
      line-height: 1.5;
      margin-top: 20px;
    }
    .footer {
      border-top: 1px solid #1e293b;
      padding: 20px 24px;
      text-align: center;
      font-size: 12px;
      color: #64748b;
      line-height: 1.5;
    }
  </style>
</head>
<body>
  <div class="wrapper">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
      <tr>
        <td align="center">
          <div class="email-container">
            <!-- HEADER -->
            <div class="header">
              <h1>WhatsApp Gateway</h1>
              <p>Notifikasi Persetujuan Akun Customer</p>
              <div class="badge">Akun Telah Aktif</div>
            </div>

            <!-- CONTENT -->
            <div class="body-content">
              <div class="greeting">Halo, <strong>${name}</strong>! 👋</div>
              <p class="text">
                Kabar gembira! Permohonan pendaftaran akun Anda di sistem <strong>WhatsApp Gateway API</strong> telah berhasil <strong>disetujui (approved)</strong> oleh Administrator. Akun Anda kini aktif dan siap digunakan untuk pengiriman pesan WhatsApp secara otomatis.
              </p>

              <!-- DETAIL AKUN -->
              <div class="info-card">
                <table width="100%" cellspacing="0" cellpadding="6" style="font-size: 13px;">
                  <tr>
                    <td style="color: #94a3b8;">Username</td>
                    <td align="right" style="color: #f1f5f9; font-weight: bold;">${username}</td>
                  </tr>
                  <tr>
                    <td style="color: #94a3b8;">Status Akun</td>
                    <td align="right" style="color: #34d399; font-weight: bold;">Aktif (Approved)</td>
                  </tr>
                  <tr>
                    <td style="color: #94a3b8;">Kuota Pesan Awal</td>
                    <td align="right" style="color: #f1f5f9; font-weight: bold;">${Number(quota).toLocaleString()} Pesan</td>
                  </tr>
                </table>

                <div style="margin-top: 12px; font-size: 12px; color: #94a3b8;">REST API Key Anda:</div>
                <div class="api-key-box">${apiKey}</div>
              </div>

              <!-- BUTTON -->
              <div class="btn-container">
                <a href="${appUrl}" class="btn" target="_blank">Login ke Dashboard Customer</a>
              </div>

              <!-- PETUNJUK SINGKAT -->
              <div class="note-box">
                💡 <strong>Tips Memulai:</strong> Gunakan API Key di atas pada header HTTP <code>x-api-key: ${apiKey}</code> saat mengirim pesan melalui REST API <code>POST /api/send-message</code>, atau pantau penggunaan pesan langsung melalui Dashboard.
              </div>
            </div>

            <!-- FOOTER -->
            <div class="footer">
              Email ini dikirim secara otomatis oleh sistem Enterprise WhatsApp Gateway.<br>
              Jika Anda tidak merasa mendaftar akun ini, silakan abaikan email ini.<br>
              &copy; ${new Date().getFullYear()} WhatsApp Gateway Enterprise. All rights reserved.
            </div>
          </div>
        </td>
      </tr>
    </table>
  </div>
</body>
</html>
  `;

  const textContent = `
Halo, ${name}!

Permohonan pendaftaran akun Anda di WhatsApp Gateway API telah DISETUJUI oleh Administrator.
Akun Anda saat ini telah AKTIF.

Detail Akun:
- Username: ${username}
- Status: Aktif
- Kuota Pesan: ${quota} pesan
- API Key: ${apiKey}

Login ke Dashboard: ${appUrl}

Gunakan API Key di atas pada header 'x-api-key' saat mengirim pesan melalui endpoint REST API.

Terima kasih,
WhatsApp Gateway Team
  `.trim();

  // Jika SMTP belum diisi
  if (!isConfigured || !transporter) {
    console.log(`\n======================================================`);
    console.log(`[EmailService - SIMULASI PENGIRIMAN EMAIL APPROVED]`);
    console.log(`Kepada: ${to}`);
    console.log(`Subjek: Akun WhatsApp Gateway Anda Telah Disetujui & Aktif!`);
    console.log(`Username: ${username} | API Key: ${apiKey}`);
    console.log(`Catatan: Atur konfigurasi SMTP di Dashboard > Pengaturan untuk mengirim email nyata.`);
    console.log(`======================================================\n`);
    return {
      success: true,
      simulated: true,
      message: 'SMTP belum dikonfigurasi. Pengiriman disimulasikan di log server.',
    };
  }

  try {
    const info = await transporter.sendMail({
      from: fromAddress,
      to: to,
      subject: '🎉 Akun WhatsApp Gateway Anda Telah Disetujui & Aktif!',
      text: textContent,
      html: htmlContent,
    });

    console.log(`[EmailService] Email notifikasi approval berhasil dikirim ke ${to} (MsgId: ${info.messageId})`);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error(`[EmailService] Gagal mengirim email approval ke ${to}:`, err.message);
    return { success: false, error: err.message };
  }
};

/**
 * Kirim Notifikasi Email: Pendaftaran Customer Diterima (Pending Approval)
 */
export const sendCustomerRegistrationEmail = async ({
  to,
  fullName,
  username,
}) => {
  if (!to) return { success: false, message: 'Email tidak tersedia' };

  const { transporter, config, isConfigured } = await createTransporter();
  const name = fullName || username;
  const fromAddress = config.from || `"WhatsApp Gateway" <${config.user || 'no-reply@whatsapp-gateway.local'}>`;

  const htmlContent = `
<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <title>Pendaftaran Akun WhatsApp Gateway Diterima</title>
  <style>
    body { background-color: #0b0f19; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #e2e8f0; margin: 0; padding: 30px 10px; }
    .card { max-width: 560px; margin: 0 auto; background: #111827; border: 1px solid #1e293b; border-radius: 12px; padding: 28px; }
    .h1 { color: #38bdf8; font-size: 20px; font-weight: bold; margin-top: 0; }
    .badge { display: inline-block; background: #075985; color: #bae6fd; font-size: 11px; font-weight: 600; padding: 3px 10px; border-radius: 9999px; margin-bottom: 16px; }
    .p { color: #94a3b8; font-size: 14px; line-height: 1.6; }
    .box { background: #1e293b; border-radius: 8px; padding: 14px; margin: 18px 0; font-size: 13px; color: #e2e8f0; }
    .footer { font-size: 12px; color: #64748b; margin-top: 24px; border-top: 1px solid #1e293b; padding-top: 14px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="h1">WhatsApp Gateway</div>
    <div class="badge">Pendaftaran Diterima (Pending Approval)</div>
    <p class="p">Halo <strong>${name}</strong>,</p>
    <p class="p">
      Terima kasih telah mendaftar di sistem WhatsApp Gateway. Data pendaftaran akun Anda dengan username <strong>${username}</strong> telah kami terima.
    </p>
    <div class="box">
      ⏳ <strong>Status: Menunggu Persetujuan Admin</strong><br>
      Saat ini akun Anda sedang dalam proses peninjauan oleh Administrator. Kami akan mengirimkan notifikasi ke email ini setelah akun Anda disetujui dan aktif.
    </div>
    <p class="p">
      Pastikan email ini tetap aktif untuk menerima API Key dan informasi akses akun Anda.
    </p>
    <div class="footer">
      &copy; ${new Date().getFullYear()} WhatsApp Gateway Enterprise. All rights reserved.
    </div>
  </div>
</body>
</html>
  `;

  if (!isConfigured || !transporter) {
    console.log(`[EmailService - SIMULASI] Email registrasi terkirim ke ${to} (Menunggu Approval)`);
    return { success: true, simulated: true };
  }

  try {
    const info = await transporter.sendMail({
      from: fromAddress,
      to: to,
      subject: '⏳ Pendaftaran Akun WhatsApp Gateway Diterima (Menunggu Persetujuan)',
      text: `Halo ${name},\n\nPendaftaran akun Anda (${username}) telah kami terima dan saat ini sedang menunggu persetujuan Admin.\nKami akan mengirimkan notifikasi email saat akun Anda telah di-approve.\n\nWhatsApp Gateway Team`,
      html: htmlContent,
    });
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error(`[EmailService] Gagal mengirim email registrasi ke ${to}:`, err.message);
    return { success: false, error: err.message };
  }
};

/**
 * Kirim OTP Reset Password via Email (Optimasi Anti-Spam Inbox Gmail)
 */
export const sendPasswordResetOtpEmail = async ({
  to,
  fullName,
  username,
  otp,
  expiresMinutes = 10,
}) => {
  if (!to) return { success: false, message: 'Email tidak tersedia' };

  const { transporter, config, isConfigured } = await createTransporter();
  const name = fullName || username;
  const fromEmail = config.user || 'no-reply@whatsapp-gateway.local';
  const fromAddress = config.from || `"WhatsApp Gateway" <${fromEmail}>`;
  const formattedDate = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });

  // Template HTML Email Standar Korporat Bersih (Light Theme dengan Inlined Styles agar tidak masuk Spam)
  const htmlContent = `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Kode Verifikasi Reset Password</title>
</head>
<body style="margin:0; padding:0; background-color:#f4f6f9; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing:antialiased;">
  <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color:#f4f6f9; padding:40px 15px;">
    <tr>
      <td align="center">
        <!-- Container Card -->
        <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width:540px; background-color:#ffffff; border:1px solid #e2e8f0; border-radius:10px; overflow:hidden; box-shadow:0 4px 12px rgba(0,0,0,0.05);">
          
          <!-- Top Accent Line -->
          <tr>
            <td style="height:4px; background-color:#2563eb;"></td>
          </tr>

          <!-- Header -->
          <tr>
            <td style="padding:28px 32px 20px; border-bottom:1px solid #f1f5f9;">
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
                <tr>
                  <td>
                    <div style="font-size:18px; font-weight:700; color:#0f172a; letter-spacing:-0.2px;">WhatsApp Gateway</div>
                    <div style="font-size:12px; color:#64748b; margin-top:2px;">Layanan Otomasi &amp; Notifikasi Pesan</div>
                  </td>
                  <td align="right">
                    <span style="display:inline-block; padding:4px 10px; background-color:#eff6ff; color:#2563eb; border:1px solid #dbeafe; border-radius:6px; font-size:11px; font-weight:600;">Verifikasi Akun</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Main Content -->
          <tr>
            <td style="padding:28px 32px;">
              <div style="font-size:15px; font-weight:600; color:#1e293b; margin-bottom:12px;">Halo, ${name}</div>
              <p style="font-size:14px; color:#475569; line-height:1.6; margin:0 0 20px;">
                Kami menerima permintaan untuk mengatur ulang kata sandi (reset password) pada akun WhatsApp Gateway Anda (<strong>${username}</strong>). Silakan gunakan kode One-Time Password (OTP) berikut untuk menyelesaikan verifikasi:
              </p>

              <!-- OTP Box -->
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="margin:24px 0;">
                <tr>
                  <td align="center" style="background-color:#f8fafc; border:2px dashed #93c5fd; border-radius:8px; padding:20px 24px;">
                    <div style="font-size:11px; font-weight:600; color:#64748b; text-transform:uppercase; letter-spacing:1px; margin-bottom:6px;">Kode Verifikasi (OTP)</div>
                    <div style="font-family:'Courier New', Consolas, monospace; font-size:36px; font-weight:800; color:#1d4ed8; letter-spacing:10px; line-height:1.2;">${otp}</div>
                    <div style="font-size:12px; color:#94a3b8; margin-top:8px;">Berlaku selama <strong>${expiresMinutes} menit</strong></div>
                  </td>
                </tr>
              </table>

              <!-- Security Notice -->
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color:#fffbeb; border-left:4px solid #f59e0b; border-radius:4px; margin:20px 0;">
                <tr>
                  <td style="padding:12px 14px; font-size:12px; color:#92400e; line-height:1.5;">
                    <strong>Perhatian Keamanan:</strong> Demi keamanan akun Anda, jangan pernah membagikan kode OTP ini kepada pihak manapun, termasuk staf atau administrator WhatsApp Gateway.
                  </td>
                </tr>
              </table>

              <p style="font-size:13px; color:#64748b; line-height:1.5; margin:16px 0 0;">
                Jika Anda tidak merasa mengajukan permintaan reset kata sandi, abaikan email ini. Akun Anda tetap aman dan kata sandi Anda saat ini tidak akan berubah.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color:#f8fafc; border-top:1px solid #f1f5f9; padding:20px 32px; text-align:center;">
              <p style="font-size:12px; color:#94a3b8; margin:0 0 6px; line-height:1.4;">
                Email keamanan ini dikirimkan ke <strong>${to}</strong> pada ${formattedDate} WIB.
              </p>
              <p style="font-size:11px; color:#94a3b8; margin:0; line-height:1.4;">
                &copy; ${new Date().getFullYear()} WhatsApp Gateway Enterprise Platform. Seluruh hak cipta dilindungi.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const textContent = `Halo ${name},\n\nKami menerima permintaan untuk mengatur ulang kata sandi akun WhatsApp Gateway Anda (${username}).\n\nKode Verifikasi (OTP) Anda:\n>>> ${otp} <<<\n\nKode ini berlaku selama ${expiresMinutes} menit.\n\nPERHATIAN: Jangan berikan kode ini kepada siapapun demi keamanan akun Anda.\nJika Anda tidak meminta pengaturan ulang kata sandi, abaikan pesan ini.\n\n---\nWhatsApp Gateway Enterprise Security Team\nEmail terkirim ke: ${to} pada ${formattedDate} WIB`;

  if (!isConfigured || !transporter) {
    console.log(`\n======================================================`);
    console.log(`[EmailService - SIMULASI OTP RESET PASSWORD]`);
    console.log(`Kepada: ${to} | Username: ${username}`);
    console.log(`Kode OTP: ${otp} | Berlaku: ${expiresMinutes} menit`);
    console.log(`Catatan: Atur konfigurasi SMTP di Dashboard > Pengaturan.`);
    console.log(`======================================================\n`);
    return { success: true, simulated: true, message: 'SMTP belum dikonfigurasi. OTP ditampilkan di log server.' };
  }

  try {
    const info = await transporter.sendMail({
      from: fromAddress,
      to: to,
      replyTo: fromEmail,
      subject: `Kode Verifikasi Reset Password Akun WhatsApp Gateway`,
      text: textContent,
      html: htmlContent,
      headers: {
        'X-Priority': '1',
        'X-MSMail-Priority': 'High',
        'Importance': 'high',
        'Auto-Submitted': 'auto-generated',
        'X-Auto-Response-Suppress': 'OOF, AutoReply',
      },
    });
    console.log(`[EmailService] OTP reset password terkirim ke ${to} (MsgId: ${info.messageId})`);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error(`[EmailService] Gagal kirim OTP ke ${to}:`, err.message);
    return { success: false, error: err.message };
  }
};
