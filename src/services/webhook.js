import crypto from 'crypto';
import { getWebhookConfig } from './database.js';

/**
 * Dispatch event ke Webhook URL yang dikonfigurasi
 * @param {string} event Nama event ('message_received', 'message_delivered', 'message_read', 'message_failed')
 * @param {object} payload Data event WhatsApp
 */
export const dispatchWebhook = async (event, payload) => {
  try {
    const config = await getWebhookConfig();
    if (!config.enabled || !config.url) return;

    // Filter event jika diatur spesifik
    if (config.events && Array.isArray(config.events) && !config.events.includes(event)) {
      return;
    }

    const timestamp = new Date().toISOString();
    const bodyObj = {
      event,
      timestamp,
      data: payload,
    };
    const bodyString = JSON.stringify(bodyObj);

    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'Enterprise-WhatsApp-Gateway/2.0',
      'X-Webhook-Event': event,
      'X-Webhook-Timestamp': timestamp,
    };

    if (config.secret) {
      headers['X-Webhook-Secret'] = config.secret;
      const signature = crypto
        .createHmac('sha256', config.secret)
        .update(bodyString)
        .digest('hex');
      headers['X-Webhook-Signature'] = signature;
    }

    // Gunakan AbortController dengan timeout 6 detik agar tidak memblokir process
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);

    fetch(config.url, {
      method: 'POST',
      headers,
      body: bodyString,
      signal: controller.signal,
    })
      .then(res => {
        clearTimeout(timer);
        if (!res.ok) {
          console.warn(`[Webhook Warning] Server ${config.url} merespon status ${res.status}`);
        }
      })
      .catch(err => {
        clearTimeout(timer);
        console.error(`[Webhook Error] Gagal mengirim webhook ke ${config.url}:`, err.message);
      });

  } catch (err) {
    console.error('[Webhook System Error]', err.message);
  }
};

/**
 * Uji coba koneksi Webhook (Ping Test) dari Dashboard
 * @param {string} testUrl URL tujuan
 * @param {string} testSecret Secret token (opsional)
 */
export const testWebhook = async (testUrl, testSecret = '') => {
  if (!testUrl || !testUrl.startsWith('http')) {
    throw new Error('URL Webhook tidak valid. Masukkan URL lengkap (contoh: https://domain.com/webhook.php)');
  }

  const timestamp = new Date().toISOString();
  const testPayload = {
    event: 'ping',
    timestamp,
    data: {
      message: 'Uji coba koneksi Webhook dari Enterprise WhatsApp Gateway berhasil!',
      version: '2.0.0',
      gatewayTime: timestamp,
      status: 'OK',
    },
  };

  const bodyString = JSON.stringify(testPayload);
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'Enterprise-WhatsApp-Gateway-Ping/2.0',
    'X-Webhook-Event': 'ping',
    'X-Webhook-Timestamp': timestamp,
  };

  if (testSecret) {
    headers['X-Webhook-Secret'] = testSecret;
    headers['X-Webhook-Signature'] = crypto
      .createHmac('sha256', testSecret)
      .update(bodyString)
      .digest('hex');
  }

  const startTime = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(testUrl, {
      method: 'POST',
      headers,
      body: bodyString,
      signal: controller.signal,
    });
    clearTimeout(timer);

    const elapsed = Date.now() - startTime;
    let resText = '';
    try {
      resText = await res.text();
      if (resText.length > 200) resText = resText.slice(0, 200) + '...';
    } catch {}

    return {
      success: res.ok,
      status: res.status,
      statusText: res.statusText,
      timeMs: elapsed,
      responseBody: resText,
    };
  } catch (err) {
    clearTimeout(timer);
    const elapsed = Date.now() - startTime;
    return {
      success: false,
      status: 0,
      timeMs: elapsed,
      error: err.name === 'AbortError' ? 'Koneksi Timeout (lebih dari 8 detik)' : err.message,
    };
  }
};
