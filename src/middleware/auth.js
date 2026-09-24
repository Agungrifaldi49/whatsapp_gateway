import jwt from 'jsonwebtoken';
import { findUserByApiKey, getMasterApiKey } from '../services/database.js';

/**
 * Middleware: Verify Admin & Operator JWT (Full Admin Access)
 */
export const verifyAdminJWT = (req, res, next) => {
  const token = req.cookies?.admin_token || req.headers['authorization']?.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({
      status: false,
      message: 'Unauthorized: Harap login sebagai Admin terlebih dahulu.',
    });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret');
    if (decoded.role !== 'admin' && decoded.role !== 'operator') {
      return res.status(403).json({
        status: false,
        message: 'Akses ditolak: Fitur ini khusus untuk Admin & Operator.',
      });
    }
    req.admin = decoded;
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({
      status: false,
      message: 'Unauthorized: Sesi token tidak valid atau telah kadaluarsa.',
    });
  }
};

/**
 * Middleware: Verify Any Authenticated User JWT (Admin, Operator, atau Customer Aktif)
 */
export const verifyUserJWT = (req, res, next) => {
  const token = req.cookies?.admin_token || req.headers['authorization']?.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({
      status: false,
      message: 'Unauthorized: Harap login terlebih dahulu.',
    });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret');
    req.admin = decoded;
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({
      status: false,
      message: 'Unauthorized: Sesi token tidak valid atau telah kadaluarsa.',
    });
  }
};

/**
 * Helper: Ambil API Key dari request (x-api-key header, api_key query, atau Bearer token non-JWT)
 */
export const extractApiKey = (req) => {
  if (req.headers['x-api-key']) return String(req.headers['x-api-key']).trim();
  if (req.query?.api_key) return String(req.query.api_key).trim();
  const authHeader = req.headers['authorization'] || '';
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  return null;
};

/**
 * Middleware: Verify External API Key (Master atau Customer API Key)
 */
export const verifyApiKey = async (req, res, next) => {
  const masterApiKey = await getMasterApiKey();
  const clientKey = extractApiKey(req);

  // 1. Cek Master API Key (dari DB atau .env)
  if (clientKey && (clientKey === masterApiKey || clientKey === process.env.API_KEY)) {
    req.isMasterApi = true;
    return next();
  }

  // 2. Cek apakah ini Customer API Key yang aktif di database
  if (clientKey) {
    const customer = await findUserByApiKey(clientKey);
    if (customer) {
      if (customer.message_quota !== -1 && customer.messages_sent >= customer.message_quota) {
        return res.status(403).json({
          status: false,
          message: 'Kuota pengiriman pesan Anda telah habis. Hubungi Admin untuk upgrade kuota.',
        });
      }
      req.customer = customer;
      req.userId = customer.id;
      return next();
    }
  }

  // Jika tanpa proteksi API_KEY dan tidak ada clientKey
  if (!masterApiKey && !clientKey) {
    return next();
  }

  return res.status(401).json({
    status: false,
    message: 'Unauthorized: API Key tidak valid atau tidak ditemukan. Gunakan Header x-api-key atau Authorization: Bearer <TOKEN>.',
  });
};

/**
 * Middleware: Hybrid Auth (JWT Cookie OR API Key allowed)
 * Mendukung Master API Key, Customer API Key, dan Sesi Login (Admin / Customer)
 */
export const verifyHybridAuth = async (req, res, next) => {
  const masterApiKey = await getMasterApiKey();
  const clientKey = extractApiKey(req);

  // 1. Cek Master API Key
  if (clientKey && (clientKey === masterApiKey || clientKey === process.env.API_KEY)) {
    req.isMasterApi = true;
    return next();
  }

  // 2. Cek Customer API Key dari database
  if (clientKey) {
    const customer = await findUserByApiKey(clientKey);
    if (customer) {
      if (customer.message_quota !== -1 && customer.messages_sent >= customer.message_quota) {
        return res.status(403).json({
          status: false,
          message: 'Kuota pengiriman pesan Anda telah habis. Hubungi Admin untuk penambahan kuota.',
        });
      }
      req.customer = customer;
      req.userId = customer.id;
      return next();
    }
  }

  // 3. Cek JWT Token (Session Cookie atau Bearer Header)
  const token = req.cookies?.admin_token || (req.headers['authorization']?.startsWith('Bearer ') ? req.headers['authorization'].slice(7).trim() : null);
  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret');
      req.admin = decoded;
      req.user = decoded;
      if (decoded.role === 'customer') {
        req.userId = decoded.id;
      }
      return next();
    } catch (e) {}
  }

  // Jika tanpa API_KEY di .env dan tidak ada token
  if (!masterApiKey && !clientKey) {
    return next();
  }

  return res.status(401).json({
    status: false,
    message: 'Unauthorized: Diperlukan login akun atau Token API yang valid (Header x-api-key atau Authorization: Bearer <TOKEN>).',
  });
};
