/**
 * Web 登录鉴权模块（会话版）。
 *
 * 设计要点：
 *  1. 凭证持久化在 SQLite（users 表），密码用 node:crypto scrypt 加盐哈希，不存明文。
 *  2. 会话令牌：HMAC 签名的 `payload.timestamp`，无状态、无服务端会话表，
 *     重启不失效（密钥由本进程随机生成一次并持久化到 DB，重启保持不变）。
 *  3. 密码修改后会使全部已签发会话失效（改 auth_secret）。
 *  4. 与既有 Bearer API Token（server.apiToken）共存：两者任一通过即可。
 *  5. 默认账号 admin / adminforops，首次登录后前端强制引导改密（force_change_password）。
 */

import * as crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { Database } from '../storage/database';
import { logger } from '../utils/logger';

const SESSION_TTL_MS = 7 * 24 * 3600 * 1000; // 会话有效期 7 天
const USERNAME = 'admin';

/** 管理员凭证（DB 行） */
interface AdminCredential {
  username: string;
  passwordHash: string; // scrypt 格式 salt:hex
  authSecret: string; // 会话签名密钥（改密时轮换）
  createdAt: string;
}

export interface AuthService {
  login(username: string, password: string): { token: string; mustChangePassword: boolean } | null;
  changePassword(currentPassword: string, newPassword: string): { ok: boolean; error?: string };
  verifySession(token: string): boolean;
  mustChangePassword(): boolean;
}

// ---------------------------------------------------------------------------
// scrypt 密码哈希（node:crypto 内置，无额外依赖）
// ---------------------------------------------------------------------------

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hex] = stored.split(':');
  if (!salt || !hex) return false;
  try {
    const derived = crypto.scryptSync(password, salt, 64);
    const expected = Buffer.from(hex, 'hex');
    // timingSafeEqual 防时序攻击；长度不等时先比对等长哑缓冲
    return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 会话令牌：HMAC-SHA256(payload) ，payload = username.timestamp
// ---------------------------------------------------------------------------

function signPayload(secret: string, payload: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

function makeToken(secret: string): string {
  const payload = `${USERNAME}.${Date.now()}`;
  return `${payload}.${signPayload(secret, payload)}`;
}

function verifyToken(secret: string, token: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [user, ts, sig] = parts;
  if (user !== USERNAME) return false;
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Date.now() - tsNum > SESSION_TTL_MS || tsNum > Date.now() + 60000) {
    return false;
  }
  const expected = signPayload(secret, `${user}.${ts}`);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// AuthService
// ---------------------------------------------------------------------------

export function createAuthService(db: Database): AuthService {
  // 表结构（幂等建表）
  db.execRaw(`
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      auth_secret TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  const getRow = (): AdminCredential | null => {
    const row = db.getOne(
      'SELECT username, password_hash, auth_secret, created_at FROM users WHERE username = ?',
      USERNAME,
    ) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      username: String(row.username),
      passwordHash: String(row.password_hash),
      authSecret: String(row.auth_secret),
      createdAt: String(row.created_at),
    };
  };

  // 首次初始化：写入默认账号 admin / adminforops
  if (!getRow()) {
    const secret = crypto.randomBytes(32).toString('hex');
    db.runRaw(
      'INSERT INTO users (username, password_hash, auth_secret, created_at) VALUES (?, ?, ?, ?)',
      USERNAME,
      hashPassword('adminforops'),
      secret,
      new Date().toISOString(),
    );
    logger.warn('已创建默认管理员账号 admin（初始密码 adminforops），请登录后立即修改密码');
  }

  return {
    login(username, password) {
      const row = getRow();
      if (!row) {
        dummyVerify(password);
        return null;
      }
      if (username !== row.username) {
        // 用户不存在也跑一次 scrypt，抹平与"密码错误"的响应时间差（防用户名枚举）
        dummyVerify(password);
        return null;
      }
      if (!verifyPassword(password, row.passwordHash)) return null;
      return { token: makeToken(row.authSecret), mustChangePassword: isDefaultPassword(row.passwordHash) };
    },

    changePassword(currentPassword, newPassword) {
      const row = getRow();
      if (!row) return { ok: false, error: '管理员账号未初始化' };
      if (!verifyPassword(currentPassword, row.passwordHash)) {
        return { ok: false, error: '当前密码错误' };
      }
      if (typeof newPassword !== 'string' || newPassword.length < 8) {
        return { ok: false, error: '新密码至少 8 位' };
      }
      if (newPassword === currentPassword) {
        return { ok: false, error: '新密码不能与当前密码相同' };
      }
      // 改密时轮换 auth_secret → 所有已签发会话立即失效
      const newSecret = crypto.randomBytes(32).toString('hex');
      db.runRaw('UPDATE users SET password_hash = ?, auth_secret = ? WHERE username = ?', hashPassword(newPassword), newSecret, USERNAME);
      logger.info('管理员密码已修改，全部会话已失效');
      return { ok: true };
    },

    verifySession(token) {
      const row = getRow();
      if (!row) return false;
      return verifyToken(row.authSecret, token);
    },

    mustChangePassword() {
      const row = getRow();
      if (!row) return false;
      return isDefaultPassword(row.passwordHash);
    },
  };

  /** 当前密码是否仍是出厂默认（前端据此强制改密引导） */
  function isDefaultPassword(storedHash: string): boolean {
    return verifyPassword('adminforops', storedHash);
  }

  /** 无凭证时的哑校验：保持与正常校验相同的计算量，防时序侧信道 */
  function dummyVerify(password: string): void {
    verifyPassword(password, `00:${'0'.repeat(128)}`);
  }
}
