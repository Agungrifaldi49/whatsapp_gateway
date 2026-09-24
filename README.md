# WhatsApp Gateway REST API (Self-Hosted)

Aplikasi **WhatsApp Gateway REST API** open-source & self-hosted menggunakan **Node.js**, **Express.js**, dan **@whiskeysockets/baileys**. Aplikasi ini dapat mengirimkan pesan teks WhatsApp secara otomatis melalui endpoint REST API tanpa dependensi pada layanan pihak ketiga berbayar.

---

## 🚀 Fitur Utama

- 🔑 **Multi-File Session State Persistence**: Sesi login disimpan secara lokal di direktori `auth_info_baileys` menggunakan `useMultiFileAuthState`. Server dapat direstart tanpa perlu scan QR ulang.
- 🔄 **Auto Reconnect**: Terhubung kembali secara otomatis apabila koneksi internet terputus secara tidak terduga.
- 📱 **Nomor Telepon Formatting**: Konversi otomatis nomor HP Indonesia (`08...` ➡️ `628...` ➡️ `628...@s.whatsapp.net`).
- 📊 **Status & QR API**: Endpoint `GET /api/status` menyediakan status real-time koneksi beserta QR Code dalam format raw string dan Image Base64 Data URL.
- 🔒 **Proteksi API Key (Opsional)**: Dukungan pengamanan endpoint dengan header `x-api-key`.
- ✉️ **Notifikasi Email Customer**: Pengiriman notifikasi email otomatis via SMTP/Nodemailer saat pendaftaran customer dan ketika akun di-approve oleh Admin.
- 💻 **QR Code Console**: Tampilan QR code langsung di terminal konsol untuk kemudahan setup awal.

---

## 🛠️ Persyaratan Sistem

- **Node.js**: v18.0.0 atau lebih baru
- **npm** atau **yarn**

---

## 📦 Instalasi & Penggunaan Lokal

### 1. Clone & Install Dependensi
```bash
cd whatsapp_gateway
npm install
```

### 2. Konfigurasi Environment (`.env`)
Salin file `.env.example` menjadi `.env`:
```bash
cp .env.example .env
```
Isi konfigurasi pada file `.env`:
```env
PORT=3000
AUTH_DIR=auth_info_baileys
API_KEY=my_secret_api_key_123 # Kosongkan jika tidak ingin proteksi API Key
```

### 3. Menjalankan Aplikasi
- **Mode Production**:
  ```bash
  npm start
  ```
- **Mode Development (Auto-Reload)**:
  ```bash
  npm run dev
  ```

Setelah aplikasi berjalan, buka terminal untuk melihat QR code, lalu scan menggunakan aplikasi WhatsApp pada ponsel Anda (**Linked Devices / Perangkat Tertaut**).

---

## 📑 Dokumentasi Endpoint REST API

### 1. Cek Status Koneksi & QR Code
- **URL**: `/api/status`
- **Method**: `GET`
- **Headers**:
  - `x-api-key`: `my_secret_api_key_123` *(jika API_KEY diisi pada .env)*

#### Contoh Response (Saat QR Code Ready):
```json
{
  "status": true,
  "data": {
    "connection": "qr_ready",
    "qr_raw": "2@...==,...",
    "qr_image": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA..."
  }
}
```

#### Contoh Response (Saat Terhubung):
```json
{
  "status": true,
  "data": {
    "connection": "connected",
    "qr_raw": null,
    "qr_image": null
  }
}
```

#### Contoh Request cURL:
```bash
curl -X GET http://localhost:3000/api/status \
  -H "x-api-key: my_secret_api_key_123"
```

---

### 2. Kirim Pesan Teks WhatsApp
- **URL**: `/api/send-message`
- **Method**: `POST`
- **Headers**:
  - `Content-Type`: `application/json`
  - `x-api-key`: `my_secret_api_key_123` *(jika API_KEY diisi pada .env)*

#### Request Body (JSON):
```json
{
  "phone": "081234567890",
  "message": "Halo! Ini adalah pesan otomatis dari WhatsApp Gateway API."
}
```

> **Catatan Pemformatan Nomor**: Nomor `081234567890`, `+6281234567890`, maupun `6281234567890` akan diformat secara otomatis menjadi `6281234567890@s.whatsapp.net`.

#### Contoh Response (Berhasil):
```json
{
  "status": true,
  "message": "Pesan berhasil dikirim.",
  "data": {
    "target": "6281234567890@s.whatsapp.net",
    "messageId": "3EB0C1F2E4A567890123",
    "timestamp": 1694589000
  }
}
```

#### Contoh Request cURL:
```bash
curl -X POST http://localhost:3000/api/send-message \
  -H "Content-Type: application/json" \
  -H "x-api-key: my_secret_api_key_123" \
  -d '{
    "phone": "081234567890",
    "message": "Halo! Pesan tes dari WhatsApp Gateway API."
  }'
```

---

## 🚀 Tips Implementasi Lanjutan & Deployment VPS

### 1. Pengamanan API (API Key)
Untuk mencegah pihak yang tidak berhak mengakses gateway Anda:
- Tetapkan nilai `API_KEY` di file `.env`.
- Selalu sertakan header `x-api-key: <YOUR_API_KEY>` pada setiap request HTTP dari client/backend Anda.

### 2. Running 24/7 di VPS Linux menggunakan PM2
Agar aplikasi dapat berjalan terus-menerus di latar belakang VPS dan otomatis menyala saat server direboot:

1. **Install PM2 secara global**:
   ```bash
   npm install -g pm2
   ```

2. **Jalankan Aplikasi dengan PM2**:
   ```bash
   pm2 start index.js --name "wa-gateway"
   ```

3. **Simpan Status Process PM2 & Konfigurasi Autostart Server Reboot**:
   ```bash
   pm2 save
   pm2 startup
   ```
   *(Ikuti perintah yang dimunculkan oleh `pm2 startup` di terminal)*.

4. **Perintah Monitoring PM2**:
   - Cek daftar proses: `pm2 list`
   - Cek log real-time: `pm2 logs wa-gateway`
   - Restart aplikasi: `pm2 restart wa-gateway`

### 3. Nginx Reverse Proxy & SSL (Opsional)
Untuk mengakses API secara aman dengan HTTPS (`https://wa.domainanda.com`), konfigurasi block server Nginx:

```nginx
server {
    server_name wa.domainanda.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```
Gunakan **Certbot** untuk mengaktifkan HTTPS gratis dari Let's Encrypt:
```bash
sudo certbot --nginx -d wa.domainanda.com
```

---

## 📄 Lisensi
MIT License - Proyek ini bersifat sumber terbuka (open-source) dan siap digunakan untuk kebutuhan personal maupun komersial.
