/**
 * AI 服务配置生成对话框（设计文档 2.7）。
 *
 * 两步流程：
 *   第一步（输入）：日志样例（≤50 行 / ≤8KB，实时计数超限红字）+ 用户要求 + 可选服务名提示；
 *   第二步（预览/编辑）：左侧按 12 键分组的受控表单，右侧 explanations/errors/warnings；
 *     编辑防抖 500ms 自动调 /validate；「与 AI 草稿差异」开关；「重新生成」带补充指令；
 *     保存按 canonicalName 撞名自动判定 create/update 并二次确认（「将新增」/「将覆盖」）。
 *
 * 成本承诺：只有点「生成 / 重新生成」才调 LLM（light 档）；编辑、预览、校验零 LLM。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert, App, Button, Card, Col, Collapse, Input, InputNumber, Modal, Row, Select, Space,
  Switch, Table, Tag, Tooltip, Typography,
} from 'antd';
import {
  ArrowLeftOutlined, DeleteOutlined, PlusOutlined, RobotOutlined, SaveOutlined,
} from '@ant-design/icons';
import { api, ApiError } from '../api/client';
import type { AiAnalyzeResponse, ServiceInfo } from '../api/types';

const { Text, Paragraph } = Typography;
const { TextArea } = Input;

const MAX_SAMPLE_LINES = 50;
const MAX_SAMPLE_BYTES = 8192;

interface Props {
  open: boolean;
  onClose: () => void;
  /** 保存成功后回调（父组件刷新服务列表） */
  onSaved: () => void;
  onUnauthorized: () => void;
  /** 已注册服务 canonicalName 列表（判定 create/update） */
  existingServices: string[];
  /** 可用 ES 数据源 id 列表（datasourceId 选项） */
  datasources: { id: string }[];
  /** 行内「AI 重新生成」带入的目标服务（预填提示与现有配置） */
  regenerateTarget?: ServiceInfo | null;
}

// ---------------------------------------------------------------------------
// 草稿读写辅助（不可变更新）
// ---------------------------------------------------------------------------

function getPath(obj: unknown, path: string[]): unknown {
  let cur = obj;
  for (const p of path) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function setPathImmutable(obj: Record<string, unknown>, path: string[], value: unknown): Record<string, unknown> {
  const [head, ...rest] = path;
  if (rest.length === 0) {
    const out = { ...obj };
    if (value === undefined) delete out[head];
    else out[head] = value;
    return out;
  }
  const child = obj[head];
  return {
    ...obj,
    [head]: setPathImmutable(child && typeof child === 'object' && !Array.isArray(child) ? (child as Record<string, unknown>) : {}, rest, value),
  };
}

const asStr = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
const asArr = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x ?? '')).filter(Boolean) : []);

/** 与 AI 草稿的 diff（与服务端 diffObjects 同口径，[{path, from, to}]）。 */
function diffObjects(a: unknown, b: unknown, maxEntries = 50): { path: string; from: unknown; to: unknown }[] {
  const out: { path: string; from: unknown; to: unknown }[] = [];
  const walk = (x: unknown, y: unknown, path: string): void => {
    if (out.length >= maxEntries) return;
    if (JSON.stringify(x) === JSON.stringify(y)) return;
    const bothObj = x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x) && !Array.isArray(y);
    if (bothObj) {
      const keys = new Set([...Object.keys(x as object), ...Object.keys(y as object)]);
      for (const k of keys) {
        walk((x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k], path ? `${path}.${k}` : k);
      }
      return;
    }
    out.push({ path: path || '(root)', from: x ?? null, to: y ?? null });
  };
  walk(a, b, '');
  return out;
}

/** prometheusLabels 对象 ↔ "key=value" 字符串数组互转（tag 编辑器用） */
function labelsToPairs(v: unknown): string[] {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return [];
  return Object.entries(v as Record<string, unknown>).map(([k, val]) => `${k}=${String(val ?? '')}`);
}
function pairsToLabels(pairs: string[]): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const p of pairs) {
    const idx = p.indexOf('=');
    if (idx > 0) out[p.slice(0, idx).trim()] = p.slice(idx + 1).trim();
  }
  return Object.keys(out).length ? out : undefined;
}

// ---------------------------------------------------------------------------
// 主组件
// ---------------------------------------------------------------------------

export default function AiConfigDialog({ open, onClose, onSaved, onUnauthorized, existingServices, datasources, regenerateTarget }: Props) {
  const { message, modal } = App.useApp();

  // 第一步（输入）
  const [step, setStep] = useState<'input' | 'preview'>('input');
  const [logSample, setLogSample] = useState('');
  const [userPrompt, setUserPrompt] = useState('');
  const [serviceHint, setServiceHint] = useState('');

  // 第二步（预览/编辑）
  const [generationId, setGenerationId] = useState<string | null>(null);
  const [aiDraft, setAiDraft] = useState<Record<string, unknown> | null>(null);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [explanations, setExplanations] = useState<string[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [usage, setUsage] = useState<AiAnalyzeResponse['usage'] | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [extraInstruction, setExtraInstruction] = useState('');

  const [analyzing, setAnalyzing] = useState(false);
  const [validating, setValidating] = useState(false);
  const [saving, setSaving] = useState(false);
  const lastValidatedRef = useRef('');

  // 打开时按 regenerateTarget 预填；关闭时重置
  useEffect(() => {
    if (!open) return;
    setStep('input');
    setGenerationId(null);
    setAiDraft(null);
    setDraft({});
    setExplanations([]);
    setErrors([]);
    setWarnings([]);
    setUsage(null);
    setShowDiff(false);
    setExtraInstruction('');
    lastValidatedRef.current = '';
    if (regenerateTarget) {
      setServiceHint(regenerateTarget.canonicalName);
      setUserPrompt(
        `请在以下现有配置的基础上重新生成/修正（保留合理的部分，修正明显错误）：\n` +
          JSON.stringify(regenerateTarget, null, 2).slice(0, 3000),
      );
    } else {
      setServiceHint('');
      setUserPrompt('');
    }
  }, [open, regenerateTarget]);

  // 样例行数/字节实时计数
  const sampleLines = useMemo(() => (logSample ? logSample.split('\n').length : 0), [logSample]);
  const sampleBytes = useMemo(() => new Blob([logSample]).size, [logSample]);
  const sampleOverLimit = sampleLines > MAX_SAMPLE_LINES || sampleBytes > MAX_SAMPLE_BYTES;

  // -------------------------------------------------------------------------
  // 编辑防抖 500ms 自动 validate（免费端点）
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (step !== 'preview') return;
    const snapshotJson = JSON.stringify(draft);
    if (snapshotJson === lastValidatedRef.current) return;
    const timer = setTimeout(() => {
      setValidating(true);
      api
        .aiConfigValidate(draft)
        .then((r) => {
          lastValidatedRef.current = snapshotJson;
          setErrors(r.errors);
          setWarnings(r.warnings);
        })
        .catch((e: unknown) => {
          const err = e as ApiError;
          if (err.status === 401) onUnauthorized();
        })
        .finally(() => setValidating(false));
    }, 500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, step]);

  // -------------------------------------------------------------------------
  // 生成 / 重新生成
  // -------------------------------------------------------------------------

  const runAnalyze = useCallback(
    async (prompt: string) => {
      setAnalyzing(true);
      try {
        const r = await api.aiConfigAnalyze({
          logSample,
          userPrompt: prompt,
          serviceHint: serviceHint || undefined,
          actor: 'web',
        });
        setGenerationId(r.generationId);
        setAiDraft(r.draft);
        setDraft(r.draft);
        setExplanations(r.explanations);
        setErrors(r.errors);
        setWarnings(r.warnings);
        setUsage(r.usage);
        lastValidatedRef.current = JSON.stringify(r.draft);
        setStep('preview');
      } catch (e) {
        const err = e as ApiError;
        if (err.status === 401) onUnauthorized();
        else message.error(`AI 生成失败：${err.message}`);
      } finally {
        setAnalyzing(false);
      }
    },
    [logSample, serviceHint, message, onUnauthorized],
  );

  // -------------------------------------------------------------------------
  // 保存
  // -------------------------------------------------------------------------

  const canonicalName = asStr(getPath(draft, ['canonicalName']));
  const mode: 'create' | 'update' = existingServices.includes(canonicalName) ? 'update' : 'create';

  const doSave = useCallback(async () => {
    setSaving(true);
    try {
      const r = await api.aiConfigSave({
        generationId: generationId ?? undefined,
        service: draft,
        mode,
        actor: 'web',
      });
      message.success(`服务 ${canonicalName} 已保存并热生效（备份：${r.backupPath}）`);
      onSaved();
      onClose();
    } catch (e) {
      const err = e as ApiError;
      if (err.status === 401) onUnauthorized();
      else message.error(`保存失败：${err.message}`);
    } finally {
      setSaving(false);
    }
  }, [draft, mode, generationId, canonicalName, message, onSaved, onClose, onUnauthorized]);

  const confirmSave = useCallback(() => {
    modal.confirm({
      title: mode === 'create' ? `将新增服务 ${canonicalName}` : `将覆盖服务 ${canonicalName} 的现有配置`,
      content:
        mode === 'create'
          ? '配置将写入 config.yaml（写前自动备份），保存后立即热生效，无需重启。确认保存？'
          : 'config.yaml 中该服务的现有配置将被覆盖（写前自动备份，可从 .bak 文件回滚），保存后立即热生效。确认覆盖？',
      okText: '确认保存',
      cancelText: '再想想',
      onOk: doSave,
    });
  }, [modal, mode, canonicalName, doSave]);

  // -------------------------------------------------------------------------
  // 表单字段渲染辅助
  // -------------------------------------------------------------------------

  const setDraftPath = (path: string[], value: unknown) => setDraft((d) => setPathImmutable(d, path, value));

  const strField = (label: string, path: string[], placeholder = '') => (
    <div style={{ marginBottom: 10 }}>
      <Text type="secondary" style={{ fontSize: 12 }}>{label}</Text>
      <Input size="small" value={asStr(getPath(draft, path))} placeholder={placeholder} onChange={(e) => setDraftPath(path, e.target.value || undefined)} />
    </div>
  );

  const tagsField = (label: string, path: string[], placeholder = '回车添加') => (
    <div style={{ marginBottom: 10 }}>
      <Text type="secondary" style={{ fontSize: 12 }}>{label}</Text>
      <Select
        size="small"
        mode="tags"
        style={{ width: '100%' }}
        open={false}
        placeholder={placeholder}
        value={asArr(getPath(draft, path))}
        onChange={(v) => setDraftPath(path, v.length ? v : undefined)}
        tokenSeparators={[',', ' ']}
      />
    </div>
  );

  const knownIssues = (Array.isArray(getPath(draft, ['knownIssues'])) ? (getPath(draft, ['knownIssues']) as Record<string, unknown>[]) : []);

  const setKi = (idx: number, key: string, value: unknown) => {
    const next = knownIssues.map((ki, i) => (i === idx ? { ...ki, [key]: value } : ki));
    setDraftPath(['knownIssues'], next);
  };

  // 与 AI 草稿的 diff
  const diffEntries = useMemo(() => (showDiff && aiDraft ? diffObjects(aiDraft, draft) : []), [showDiff, aiDraft, draft]);

  // -------------------------------------------------------------------------
  // 渲染
  // -------------------------------------------------------------------------

  const inputStep = (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message="只有点击「生成」才会调用 AI（light 档，输入已脱敏、限 50 行 / 8KB）。日志样例是字段映射的依据，必填。"
      />
      <div>
        <Space style={{ width: '100%', justifyContent: 'space-between' }}>
          <Text strong>日志样例</Text>
          <Text type={sampleOverLimit ? 'danger' : 'secondary'} style={{ fontSize: 12 }}>
            {sampleLines} / {MAX_SAMPLE_LINES} 行 · {(sampleBytes / 1024).toFixed(1)} / 8 KB
            {sampleOverLimit && '（超限，提交时服务端会截断）'}
          </Text>
        </Space>
        <TextArea
          rows={10}
          value={logSample}
          onChange={(e) => setLogSample(e.target.value)}
          placeholder='粘贴真实日志（JSON 行或文本均可），例如：{"@timestamp":"...","level":"ERROR","message":"..."}'
          style={{ fontFamily: 'monospace', fontSize: 12 }}
        />
      </div>
      <div>
        <Text strong>你的要求</Text>
        <TextArea
          rows={3}
          value={userPrompt}
          onChange={(e) => setUserPrompt(e.target.value)}
          placeholder="例如：这是订单服务的日志，帮我生成服务注册表配置，别名要包含「订单」"
        />
      </div>
      <div>
        <Text strong>服务名提示（可选）</Text>
        <Input value={serviceHint} onChange={(e) => setServiceHint(e.target.value)} placeholder="如 order-service；更新现有服务时自动带入" />
      </div>
    </Space>
  );

  const previewLeft = (
    <Collapse
      size="small"
      defaultActiveKey={['base', 'mapping']}
      items={[
        {
          key: 'base',
          label: '基础信息',
          children: (
            <>
              {strField('canonicalName（小写字母开头，仅小写/数字/中划线）', ['canonicalName'], 'order-service')}
              {strField('displayName（中文名）', ['displayName'], '订单服务')}
              {tagsField('aliases（必须包含中文名）', ['aliases'])}
              <div style={{ marginBottom: 10 }}>
                <Text type="secondary" style={{ fontSize: 12 }}>tier（服务等级）</Text>
                <Select
                  size="small"
                  style={{ width: '100%' }}
                  value={asStr(getPath(draft, ['tier'])) || undefined}
                  options={[
                    { label: 'core（核心）', value: 'core' },
                    { label: 'important（重要）', value: 'important' },
                    { label: 'edge（边缘）', value: 'edge' },
                  ]}
                  onChange={(v) => setDraftPath(['tier'], v)}
                />
              </div>
              <div style={{ marginBottom: 10 }}>
                <Text type="secondary" style={{ fontSize: 12 }}>datasourceId（只能选择已启用的 ES 数据源）</Text>
                <Select
                  size="small"
                  style={{ width: '100%' }}
                  value={asStr(getPath(draft, ['datasourceId'])) || undefined}
                  options={datasources.map((d) => ({ label: d.id, value: d.id }))}
                  onChange={(v) => setDraftPath(['datasourceId'], v)}
                />
              </div>
              {tagsField('indexPatterns（覆盖数据源默认索引，非合并）', ['indexPatterns'], 'app-log-prod-*')}
              {strField('stack（技术栈）', ['stack'], 'Spring Boot 3.x + Nacos + Docker')}
            </>
          ),
        },
        {
          key: 'mapping',
          label: '字段映射 fieldMapping（第 1 候选是唯一参与 ES 查询的字段）',
          children: (
            <>
              {tagsField('timestamp（时间字段候选，第 1 个必须真实存在于样例）', ['fieldMapping', 'timestamp'], '@timestamp')}
              {tagsField('level（级别字段候选，第 1 个必须真实存在于样例）', ['fieldMapping', 'level'], 'level')}
              {tagsField('message（正文字段候选）', ['fieldMapping', 'message'], 'message')}
              {tagsField('traceId（可选）', ['fieldMapping', 'traceId'])}
              {tagsField('logger（可选）', ['fieldMapping', 'logger'])}
            </>
          ),
        },
        {
          key: 'deployment',
          label: '部署 deployment',
          children: (
            <>
              {tagsField('hostIds（SSH 主机 id）', ['deployment', 'hostIds'])}
              {tagsField('containerNames（容器名）', ['deployment', 'containerNames'])}
              <div style={{ marginBottom: 10 }}>
                <Text type="secondary" style={{ fontSize: 12 }}>port</Text>
                <InputNumber
                  size="small"
                  style={{ width: '100%' }}
                  min={1}
                  max={65535}
                  value={typeof getPath(draft, ['deployment', 'port']) === 'number' ? (getPath(draft, ['deployment', 'port']) as number) : undefined}
                  onChange={(v) => setDraftPath(['deployment', 'port'], v ?? undefined)}
                />
              </div>
              {strField('jenkinsJob', ['deployment', 'jenkinsJob'])}
              {strField('registry', ['deployment', 'registry'])}
            </>
          ),
        },
        {
          key: 'deps',
          label: '依赖与 Prometheus 标签',
          children: (
            <>
              {tagsField('dependsOn（下游依赖）', ['dependsOn'])}
              {tagsField('dependedBy（上游调用方）', ['dependedBy'])}
              <div style={{ marginBottom: 10 }}>
                <Text type="secondary" style={{ fontSize: 12 }}>prometheusLabels（key=value 形式，instance 不得含反斜杠）</Text>
                <Select
                  size="small"
                  mode="tags"
                  style={{ width: '100%' }}
                  open={false}
                  placeholder="如 application=order-service"
                  value={labelsToPairs(getPath(draft, ['prometheusLabels']))}
                  onChange={(v) => setDraftPath(['prometheusLabels'], pairsToLabels(v))}
                />
              </div>
            </>
          ),
        },
        {
          key: 'knownIssues',
          label: `已知问题 knownIssues（${knownIssues.length} 条）`,
          children: (
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              {knownIssues.map((ki, i) => (
                <Card
                  key={i}
                  size="small"
                  title={`已知问题 #${i + 1}`}
                  extra={
                    <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => setDraftPath(['knownIssues'], knownIssues.filter((_x, j) => j !== i))} />
                  }
                >
                  <Input size="small" addonBefore="pattern" style={{ marginBottom: 6 }} value={asStr(ki.pattern)} onChange={(e) => setKi(i, 'pattern', e.target.value)} />
                  <Space style={{ marginBottom: 6, width: '100%' }}>
                    <Input size="small" addonBefore="category" value={asStr(ki.category)} onChange={(e) => setKi(i, 'category', e.target.value)} />
                    <Select
                      size="small"
                      value={asStr(ki.severity) || 'medium'}
                      options={['low', 'medium', 'high', 'critical'].map((s) => ({ label: s, value: s }))}
                      onChange={(v) => setKi(i, 'severity', v)}
                    />
                  </Space>
                  <TextArea rows={2} placeholder="cause（原因）" style={{ marginBottom: 6 }} value={asStr(ki.cause)} onChange={(e) => setKi(i, 'cause', e.target.value)} />
                  <TextArea rows={2} placeholder="sop（处置步骤）" value={asStr(ki.sop)} onChange={(e) => setKi(i, 'sop', e.target.value)} />
                </Card>
              ))}
              <Button size="small" icon={<PlusOutlined />} onClick={() => setDraftPath(['knownIssues'], [...knownIssues, { pattern: '', severity: 'medium', category: '', cause: '', sop: '' }])}>
                添加已知问题
              </Button>
            </Space>
          ),
        },
      ]}
    />
  );

  const previewRight = (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {usage && (
        <Text type="secondary" style={{ fontSize: 12 }}>
          模型 {usage.model} · tokens {usage.prompt + usage.completion}（prompt {usage.prompt} / completion {usage.completion}）
          {validating && ' · 校验中…'}
        </Text>
      )}
      {errors.length > 0 && (
        <Alert
          type="error"
          showIcon
          message={`${errors.length} 个错误（必须全部解决才能保存）`}
          description={
            <ul style={{ margin: 0, paddingLeft: 18, maxHeight: 200, overflow: 'auto' }}>
              {errors.map((e, i) => (
                <li key={i} style={{ fontSize: 12 }}>{e}</li>
              ))}
            </ul>
          }
        />
      )}
      {warnings.length > 0 && (
        <Alert
          type="warning"
          showIcon
          message={`${warnings.length} 个警告（不阻断保存，请人工确认）`}
          description={
            <ul style={{ margin: 0, paddingLeft: 18, maxHeight: 160, overflow: 'auto' }}>
              {warnings.map((w, i) => (
                <li key={i} style={{ fontSize: 12 }}>{w}</li>
              ))}
            </ul>
          }
        />
      )}
      {errors.length === 0 && warnings.length === 0 && <Alert type="success" showIcon message="校验通过，可以保存" />}
      {explanations.length > 0 && (
        <Card size="small" title="AI 说明（每个字段的取值依据）">
          <ul style={{ margin: 0, paddingLeft: 18, maxHeight: 220, overflow: 'auto' }}>
            {explanations.map((e, i) => (
              <li key={i} style={{ fontSize: 12 }}>{e}</li>
            ))}
          </ul>
        </Card>
      )}
      <Space>
        <Text style={{ fontSize: 13 }}>与 AI 草稿差异</Text>
        <Switch size="small" checked={showDiff} onChange={setShowDiff} />
        {showDiff && <Tag>{diffEntries.length} 处</Tag>}
      </Space>
      {showDiff && (
        <Table
          size="small"
          rowKey={(r) => r.path}
          pagination={false}
          scroll={{ y: 240 }}
          columns={[
            { title: '路径', dataIndex: 'path', width: 160, render: (v: string) => <Text code style={{ fontSize: 11 }}>{v}</Text> },
            { title: 'AI 草稿', dataIndex: 'from', render: (v: unknown) => <Text type="secondary" style={{ fontSize: 11 }}>{JSON.stringify(v)?.slice(0, 80) ?? 'null'}</Text> },
            { title: '当前编辑', dataIndex: 'to', render: (v: unknown) => <Text style={{ fontSize: 11 }}>{JSON.stringify(v)?.slice(0, 80) ?? 'null'}</Text> },
          ]}
          dataSource={diffEntries}
          locale={{ emptyText: '与 AI 草稿完全一致' }}
        />
      )}
      <Card size="small" title="重新生成（带补充指令）">
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <TextArea
            rows={2}
            value={extraInstruction}
            onChange={(e) => setExtraInstruction(e.target.value)}
            placeholder="例如：level 字段应该是 log.level；别名加上「订单中心」"
          />
          <Button
            size="small"
            icon={<RobotOutlined />}
            loading={analyzing}
            disabled={!extraInstruction.trim()}
            onClick={() => void runAnalyze(`${userPrompt}\n补充要求：${extraInstruction.trim()}`)}
          >
            重新生成
          </Button>
        </Space>
      </Card>
    </Space>
  );

  return (
    <Modal
      title={step === 'input' ? 'AI 生成服务配置 — 第 1 步：提供样例与要求' : 'AI 生成服务配置 — 第 2 步：预览 / 编辑 / 保存'}
      open={open}
      width={880}
      onCancel={onClose}
      footer={
        step === 'input' ? (
          <Space>
            <Button onClick={onClose}>取消</Button>
            <Tooltip title={analyzing ? 'AI 生成通常需要 15-60 秒，请耐心等待' : ''}>
              <Button
                type="primary"
                icon={<RobotOutlined />}
                loading={analyzing}
                disabled={!logSample.trim() || !userPrompt.trim()}
                onClick={() => void runAnalyze(userPrompt)}
              >
                {analyzing ? '生成中（15-60 秒）…' : '生成'}
              </Button>
            </Tooltip>
          </Space>
        ) : (
          <Space>
            <Button icon={<ArrowLeftOutlined />} onClick={() => setStep('input')}>
              上一步
            </Button>
            <Button onClick={onClose}>取消</Button>
            <Tooltip title={errors.length > 0 ? '存在校验错误，无法保存' : mode === 'create' ? `将新增服务 ${canonicalName || '(未命名)'}` : `将覆盖服务 ${canonicalName} 的现有配置`}>
              <Button
                type="primary"
                icon={<SaveOutlined />}
                loading={saving}
                disabled={errors.length > 0 || !canonicalName}
                onClick={confirmSave}
              >
                {mode === 'create' ? '确认保存（新增）' : '确认保存（覆盖）'}
              </Button>
            </Tooltip>
          </Space>
        )
      }
    >
      {step === 'input' ? (
        inputStep
      ) : (
        <Row gutter={16}>
          <Col span={13}>{previewLeft}</Col>
          <Col span={11}>{previewRight}</Col>
        </Row>
      )}
      {step === 'preview' && (
        <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 12, marginBottom: 0 }}>
          保存 = 备份 config.yaml → 写回 → 立即热生效（无需重启）；编辑与校验不调用 AI。
        </Paragraph>
      )}
    </Modal>
  );
}
