/**
 * config.yaml 配置写回器（设计文档 2.5）。
 *
 * 安全性质：
 *   1. 用 yaml 包的 parseDocument 做 CST 级往返编辑 —— 保留注释、锚点与
 *      ${ENV} 占位符字面量（Document 往返不触发 ENV 插值，插值只发生在
 *      loadConfig 的对象化阶段）。
 *   2. 写前备份（保留最近 10 份），失败可直接文件级回滚。
 *   3. tmp + rename 原子替换，杜绝写一半损坏配置。
 *   4. 顺序铁律：先写文件成功，再改内存 config.services（热生效），不能反。
 *   5. 值一律走 doc.createNode（yaml 库负责转义），不拼接文本，防 YAML 注入。
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseDocument, YAMLSeq } from 'yaml';
import type { Node } from 'yaml';
import { AppConfig, ServiceDef } from './schema';
import { logger } from '../utils/logger';

export interface SaveServiceResult {
  backupPath: string;
  /** 当前版本恒为 false（datasourceId 已校验必须属于已启用 ES 源）；
   *  保留该字段为将来"允许新增数据源"留口。 */
  restartRequired: boolean;
}

const MAX_BACKUPS = 10;

/** 递归剔除 undefined 值（zod optional 字段未填时为 undefined，createNode 无法序列化）。 */
function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => stripUndefined(v)) as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) out[k] = stripUndefined(v);
    }
    return out as T;
  }
  return value;
}

function backupTimestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  // 毫秒后缀：同一秒内的连续保存不会互相覆盖备份
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}`
  );
}

/** 备份配置文件并只保留最近 MAX_BACKUPS 份。返回备份文件路径。 */
function backupConfig(configPath: string): string {
  const backupPath = `${configPath}.bak.${backupTimestamp()}`;
  fs.copyFileSync(configPath, backupPath);
  logger.info('配置文件已备份', { backupPath });

  // 清理旧备份：同目录下同前缀的 .bak.* 按名称倒序（时间戳可排序），保留前 N 份
  const dir = path.dirname(configPath);
  const base = path.basename(configPath);
  try {
    const backups = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(`${base}.bak.`))
      .sort()
      .reverse();
    for (const old of backups.slice(MAX_BACKUPS)) {
      fs.unlinkSync(path.join(dir, old));
      logger.debug('已清理过期配置备份', { file: old });
    }
  } catch (e) {
    logger.warn('清理旧配置备份失败（不影响保存）', { error: (e as Error).message });
  }
  return backupPath;
}

/**
 * 把一个服务条目写回 config.yaml 的 services 段并热生效。
 *
 * mode='create'：canonicalName 撞名直接拒绝；
 * mode='update'：目标必须已存在。
 * 写文件成功后才原地更新内存 config.services（所有读取点动态遍历，立即生效）。
 */
export function saveServiceToConfig(
  configPath: string,
  config: AppConfig,
  service: ServiceDef,
  mode: 'create' | 'update',
): SaveServiceResult {
  // --- 1. 解析原始文本为 CST Document（保注释、不触发 ${ENV} 插值）---
  const raw = fs.readFileSync(configPath, 'utf8');
  const doc = parseDocument(raw);
  if (doc.errors.length > 0) {
    throw new Error(`config.yaml 解析失败，已中止写回：${doc.errors[0].message}`);
  }

  let seq = doc.get('services') as YAMLSeq | undefined;
  if (seq === undefined || seq === null) {
    doc.set('services', doc.createNode([]));
    seq = doc.get('services') as YAMLSeq;
  }
  if (!(seq instanceof YAMLSeq)) {
    throw new Error('config.yaml 的 services 段不是数组，已中止写回（请人工检查配置文件）');
  }

  // --- 2. 定位 / 冲突检查 ---
  const items = seq.items as { get?(k: string): unknown }[];
  const existIdx = items.findIndex((it) => it && typeof it.get === 'function' && it.get('canonicalName') === service.canonicalName);

  if (mode === 'create' && existIdx >= 0) {
    throw new Error(`服务 "${service.canonicalName}" 已存在于 config.yaml，新增被拒绝（如需覆盖请用 update 模式）`);
  }
  if (mode === 'update' && existIdx < 0) {
    throw new Error(`服务 "${service.canonicalName}" 在 config.yaml 中不存在，更新被拒绝（如需新增请用 create 模式）`);
  }

  const node = doc.createNode(stripUndefined(service)) as Node;
  if (mode === 'create') {
    seq.items.push(node as never);
  } else {
    // 保留被替换条目上的人工注释：
    // 行尾注释（yaml AST 中挂在首个 Pair 的 value 标量上）与前置注释块（挂在节点自身）
    type WithComment = { comment?: string | null; commentBefore?: string | null };
    const oldNode = seq.items[existIdx] as Node & WithComment;
    if (oldNode && typeof oldNode === 'object') {
      if (oldNode.commentBefore) (node as WithComment).commentBefore = oldNode.commentBefore;
      if (oldNode.comment) (node as WithComment).comment = oldNode.comment;
      const oldFirstValue = (oldNode as { items?: { value?: unknown }[] }).items?.[0]?.value as WithComment | undefined;
      const newFirstValue = (node as { items?: { value?: unknown }[] }).items?.[0]?.value as WithComment | undefined;
      if (oldFirstValue?.comment && newFirstValue && typeof newFirstValue === 'object') {
        newFirstValue.comment = oldFirstValue.comment;
      }
    }
    seq.items[existIdx] = node as never;
  }

  // --- 3. 备份 → 4. 原子写（tmp + rename）---
  const backupPath = backupConfig(configPath);
  const tmpPath = `${configPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, String(doc), 'utf8');
  fs.renameSync(tmpPath, configPath);
  logger.info('服务配置已写回 config.yaml', { service: service.canonicalName, mode, backupPath });

  // --- 5. 文件写成功后，原地更新内存注册表（热生效）---
  if (mode === 'create') {
    config.services.push(service);
  } else {
    const memIdx = config.services.findIndex((s) => s.canonicalName === service.canonicalName);
    if (memIdx >= 0) config.services.splice(memIdx, 1, service);
    else config.services.push(service); // 内存与文件不一致时以文件为准补齐
  }

  return { backupPath, restartRequired: false };
}
