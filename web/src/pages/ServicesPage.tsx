/**
 * 服务注册表页。
 *
 * 这一页回答两个问题：
 *   1. 系统"认识"哪些服务？（来自 config.yaml 的 services 段）
 *   2. 每个服务背后的数据源现在通不通？（ES / Prometheus 实时探活）
 *
 * 服务注册表是整个平台的"地图"——AI 诊断时靠它把用户口语化的服务名
 * （"物流那个服务"）映射到真实的 ES 索引、Prometheus 指标和部署主机。
 * 所以这一页配置错了，后面诊断全部跑偏。
 */

import { useState } from 'react';
import { Card, Table, Tag, Space, Typography, Alert, Button, Collapse, Descriptions, Drawer, Row, Col, Tooltip, Divider, App } from 'antd';
import { ReloadOutlined, CheckCircleOutlined, CloseCircleOutlined, LinkOutlined, RobotOutlined, HistoryOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { api, ApiError } from '../api/client';
import type { AiGenerationDetail, AiGenerationListItem, ServiceInfo } from '../api/types';
import { useApi } from '../hooks/useApi';
import AiConfigDialog from '../components/AiConfigDialog';

const { Text, Paragraph } = Typography;

interface Props {
  onUnauthorized: () => void;
}

/** 服务等级 → 中文 + 颜色 */
function tierMeta(tier: string): { text: string; color: string } {
  switch (tier) {
    case 'core':
      return { text: '核心', color: 'red' };
    case 'important':
      return { text: '重要', color: 'orange' };
    case 'edge':
      return { text: '边缘', color: 'default' };
    default:
      return { text: tier, color: 'default' };
  }
}

/** 把 datasourceHealth 的 live 结果压成 id → ok 的映射，方便表格渲染 */
function buildLiveMap(live: Record<string, unknown>): Record<string, { ok: boolean; error?: string; status?: string }> {
  const out: Record<string, { ok: boolean; error?: string; status?: string }> = {};
  const scan = (group: unknown) => {
    if (!group || typeof group !== 'object') return;
    for (const [id, v] of Object.entries(group as Record<string, unknown>)) {
      if (v && typeof v === 'object' && 'ok' in v) {
        const o = v as { ok: boolean; error?: string; status?: string };
        out[id] = { ok: o.ok, error: o.error, status: o.status };
      }
    }
  };
  scan((live as Record<string, unknown>).elasticsearch);
  scan((live as Record<string, unknown>).prometheus);
  return out;
}

/** 数据源连通状态徽标 */
function DsHealthTag({ dsId, liveMap }: { dsId: string; liveMap: Record<string, { ok: boolean; error?: string; status?: string }> }) {
  const h = liveMap[dsId];
  if (!h) {
    return (
      <Tooltip title={`未对数据源 ${dsId} 探活（可能未启用或配置缺失）`}>
        <Tag>未知</Tag>
      </Tooltip>
    );
  }
  if (h.ok) {
    return (
      <Tooltip title={h.status ? `连通（集群状态 ${h.status}）` : '连通'}>
        <Tag color="green" icon={<CheckCircleOutlined />}>连通</Tag>
      </Tooltip>
    );
  }
  return (
    <Tooltip title={`连接失败：${h.error ?? '未知错误'}`}>
      <Tag color="red" icon={<CloseCircleOutlined />}>不通</Tag>
    </Tooltip>
  );
}

/** 「生成记录」抽屉：按服务名查生成谱系，行内可查看单条全文 */
function GenerationsDrawer({ service, onClose, onUnauthorized }: { service: string; onClose: () => void; onUnauthorized: () => void }) {
  const { modal } = App.useApp();
  const { data, loading } = useApi(() => api.listAiGenerations(service, 100), [service], onUnauthorized);

  const showDetail = async (id: string) => {
    try {
      const g: AiGenerationDetail = await api.getAiGeneration(id);
      modal.info({
        title: `生成记录 ${g.id}`,
        width: 760,
        content: (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {dayjs(g.createdAt).format('YYYY-MM-DD HH:mm:ss')} · 操作者 {g.actor} · 模型 {g.model ?? '-'} · 状态 {g.status}
            </Text>
            <div>
              <Text strong style={{ fontSize: 13 }}>用户要求</Text>
              <pre style={{ background: '#f5f5f5', padding: 8, borderRadius: 4, fontSize: 12, maxHeight: 120, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{g.userPrompt}</pre>
            </div>
            <div>
              <Text strong style={{ fontSize: 13 }}>日志样例（已脱敏）</Text>
              <pre style={{ background: '#f5f5f5', padding: 8, borderRadius: 4, fontSize: 12, maxHeight: 160, overflow: 'auto' }}>{g.logSample}</pre>
            </div>
            {g.userEditsDiff && g.userEditsDiff.length > 0 && (
              <div>
                <Text strong style={{ fontSize: 13 }}>用户编辑 diff（{g.userEditsDiff.length} 处）</Text>
                <pre style={{ background: '#f5f5f5', padding: 8, borderRadius: 4, fontSize: 12, maxHeight: 160, overflow: 'auto' }}>
                  {g.userEditsDiff.map((d) => `${d.path}: ${JSON.stringify(d.from)} → ${JSON.stringify(d.to)}`).join('\n')}
                </pre>
              </div>
            )}
            {g.aiRawOutput && (
              <div>
                <Text strong style={{ fontSize: 13 }}>AI 原始输出</Text>
                <pre style={{ background: '#f5f5f5', padding: 8, borderRadius: 4, fontSize: 12, maxHeight: 200, overflow: 'auto' }}>{g.aiRawOutput}</pre>
              </div>
            )}
          </Space>
        ),
      });
    } catch (e) {
      const err = e as ApiError;
      if (err.status === 401) onUnauthorized();
    }
  };

  const columns: ColumnsType<AiGenerationListItem> = [
    { title: '时间', dataIndex: 'createdAt', width: 110, render: (v: string) => dayjs(v).format('MM-DD HH:mm') },
    { title: '操作者', dataIndex: 'actor', width: 80 },
    {
      title: '状态',
      dataIndex: 'status',
      width: 80,
      render: (v: string) => <Tag color={v === 'saved' ? 'green' : v === 'draft' ? 'blue' : 'default'}>{v === 'saved' ? '已保存' : v === 'draft' ? '草稿' : v}</Tag>,
    },
    { title: '模型', dataIndex: 'model', width: 130, render: (v: string | null) => <Text style={{ fontSize: 12 }}>{v ?? '-'}</Text> },
    {
      title: '校验',
      width: 100,
      render: (_: unknown, r) => {
        const errs = r.validation?.errors.length ?? 0;
        const warns = r.validation?.warnings.length ?? 0;
        return (
          <Space size={4}>
            {errs > 0 ? <Tag color="red">{errs} 错</Tag> : <Tag color="green">0 错</Tag>}
            {warns > 0 && <Tag color="orange">{warns} 警</Tag>}
          </Space>
        );
      },
    },
    {
      title: 'tokens',
      width: 80,
      render: (_: unknown, r) => (r.tokensUsed ? r.tokensUsed.prompt + r.tokensUsed.completion : '-'),
    },
    {
      title: '操作',
      width: 80,
      render: (_: unknown, r) => (
        <Button type="link" size="small" onClick={() => void showDetail(r.id)}>
          详情
        </Button>
      ),
    },
  ];

  return (
    <Drawer title={`生成记录 — ${service}`} width={720} open onClose={onClose}>
      <Table<AiGenerationListItem>
        rowKey="id"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={data?.items ?? []}
        pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 条` }}
        locale={{ emptyText: '该服务暂无 AI 生成记录' }}
      />
    </Drawer>
  );
}

export default function ServicesPage({ onUnauthorized }: Props) {
  const { data, loading, error, reload } = useApi(() => api.listServices(), [], onUnauthorized);
  const { data: health } = useApi(() => api.datasourceHealth(), [], onUnauthorized);

  // AI 配置生成对话框与生成记录抽屉
  const [aiDialogOpen, setAiDialogOpen] = useState(false);
  const [regenerateTarget, setRegenerateTarget] = useState<ServiceInfo | null>(null);
  const [drawerService, setDrawerService] = useState<string | null>(null);

  const liveMap = buildLiveMap(health?.live ?? {});
  const dsCfg = health?.config;

  // ES / Prometheus 连通汇总
  const esAll = dsCfg?.elasticsearch ?? [];
  const promAll = dsCfg?.prometheus ?? [];
  const esOk = esAll.filter((d) => liveMap[d.id]?.ok).length;
  const promOk = promAll.filter((d) => liveMap[d.id]?.ok).length;

  const columns: ColumnsType<ServiceInfo> = [
    {
      title: '服务',
      dataIndex: 'canonicalName',
      width: 220,
      render: (v: string, r) => (
        <div>
          <Text strong>{r.displayName || v}</Text>
          {r.displayName && r.displayName !== v && (
            <>
              <br />
              <Text code style={{ fontSize: 12 }}>{v}</Text>
            </>
          )}
          {r.aliases.length > 0 && (
            <div style={{ marginTop: 2 }}>
              {r.aliases.map((a) => (
                <Tag key={a} style={{ fontSize: 11 }}>{a}</Tag>
              ))}
            </div>
          )}
        </div>
      ),
    },
    {
      title: '等级',
      dataIndex: 'tier',
      width: 80,
      filters: [
        { text: '核心', value: 'core' },
        { text: '重要', value: 'important' },
        { text: '边缘', value: 'edge' },
      ],
      onFilter: (value, r) => r.tier === value,
      render: (v: string) => {
        const m = tierMeta(v);
        return <Tag color={m.color}>{m.text}</Tag>;
      },
    },
    {
      title: '技术栈',
      dataIndex: 'stack',
      width: 180,
      render: (v: string) => <Text type="secondary" style={{ fontSize: 13 }}>{v || '-'}</Text>,
    },
    {
      title: '日志数据源',
      dataIndex: 'datasourceId',
      width: 140,
      render: (v: string, r) => (
        <Space direction="vertical" size={2}>
          <DsHealthTag dsId={v} liveMap={liveMap} />
          <Text code style={{ fontSize: 11 }}>{v}</Text>
          {r.indexPatterns.length > 0 && (
            <Tooltip title={r.indexPatterns.join('\n')}>
              <Text type="secondary" style={{ fontSize: 11 }}>
                {r.indexPatterns.length} 个索引
              </Text>
            </Tooltip>
          )}
        </Space>
      ),
    },
    {
      title: '依赖',
      width: 160,
      render: (_: unknown, r) => (
        <Space direction="vertical" size={2}>
          {r.dependsOn.length > 0 && (
            <Text style={{ fontSize: 12 }}>
              <Text type="secondary">依赖→</Text>{' '}
              {r.dependsOn.map((d) => <Tag key={d} style={{ fontSize: 11 }}>{d}</Tag>)}
            </Text>
          )}
          {r.dependedBy.length > 0 && (
            <Text style={{ fontSize: 12 }}>
              <Text type="secondary">被依赖←</Text>{' '}
              {r.dependedBy.map((d) => <Tag key={d} color="blue" style={{ fontSize: 11 }}>{d}</Tag>)}
            </Text>
          )}
          {r.dependsOn.length === 0 && r.dependedBy.length === 0 && (
            <Text type="secondary" style={{ fontSize: 12 }}>无显式依赖</Text>
          )}
        </Space>
      ),
    },
    {
      title: '已知问题',
      dataIndex: 'knownIssueCount',
      width: 90,
      sorter: (a, b) => a.knownIssueCount - b.knownIssueCount,
      render: (v: number) =>
        v > 0 ? <Tag color="orange">{v} 条</Tag> : <Text type="secondary">-</Text>,
    },
    {
      title: '操作',
      width: 190,
      render: (_: unknown, r) => (
        <Space size={4}>
          <Button
            type="link"
            size="small"
            icon={<RobotOutlined />}
            onClick={() => {
              setRegenerateTarget(r);
              setAiDialogOpen(true);
            }}
          >
            AI 重新生成
          </Button>
          <Button type="link" size="small" icon={<HistoryOutlined />} onClick={() => setDrawerService(r.canonicalName)}>
            生成记录
          </Button>
        </Space>
      ),
    },
  ];

  /** 展开行：部署信息 + 已知问题清单 */
  const expandedRowRender = (r: ServiceInfo) => (
    <div style={{ padding: '8px 0' }}>
      <Row gutter={16}>
        <Col xs={24} md={12}>
          <Descriptions size="small" column={1} bordered title="部署信息">
            <Descriptions.Item label="主机">
              {r.deployment.hostIds.length > 0
                ? r.deployment.hostIds.map((h) => <Tag key={h}>{h}</Tag>)
                : <Text type="secondary">未配置</Text>}
            </Descriptions.Item>
            <Descriptions.Item label="容器">
              {r.deployment.containerNames.length > 0
                ? r.deployment.containerNames.map((c) => <Tag key={c} color="cyan">{c}</Tag>)
                : <Text type="secondary">未配置</Text>}
            </Descriptions.Item>
            <Descriptions.Item label="端口">{r.deployment.port ?? '-'}</Descriptions.Item>
            <Descriptions.Item label="Jenkins Job">
              {r.deployment.jenkinsJob ? <Text code>{r.deployment.jenkinsJob}</Text> : '-'}
            </Descriptions.Item>
            <Descriptions.Item label="镜像仓库">
              {r.deployment.registry ? <Text code style={{ fontSize: 12 }}>{r.deployment.registry}</Text> : '-'}
            </Descriptions.Item>
          </Descriptions>
        </Col>
        <Col xs={24} md={12}>
          {r.knownIssues.length > 0 ? (
            <Collapse
              size="small"
              items={r.knownIssues.map((ki, idx) => ({
                key: String(idx),
                label: (
                  <Space>
                    <Tag color={ki.severity === 'critical' ? 'red' : ki.severity === 'warning' ? 'orange' : 'blue'}>
                      {ki.severity}
                    </Tag>
                    <Text style={{ fontSize: 13 }}>{ki.category}</Text>
                  </Space>
                ),
                children: (
                  <Space direction="vertical" size={6} style={{ width: '100%' }}>
                    <div>
                      <Text type="secondary" style={{ fontSize: 12 }}>匹配模式：</Text>
                      <br />
                      <Text code style={{ fontSize: 12 }}>{ki.pattern}</Text>
                    </div>
                    <div>
                      <Text type="secondary" style={{ fontSize: 12 }}>原因：</Text>
                      <Paragraph style={{ margin: 0, fontSize: 13 }}>{ki.cause}</Paragraph>
                    </div>
                    <div>
                      <Text type="secondary" style={{ fontSize: 12 }}>处置 SOP：</Text>
                      <Paragraph style={{ margin: 0, fontSize: 13, whiteSpace: 'pre-wrap' }}>{ki.sop}</Paragraph>
                    </div>
                  </Space>
                ),
              }))}
            />
          ) : (
            <Alert type="info" showIcon message="暂无已知问题记录" description="可在 config.yaml 的 services[].knownIssues 里沉淀常见故障的匹配模式、原因和处置 SOP，AI 诊断时会优先命中这些经验。" />
          )}
        </Col>
      </Row>
    </div>
  );

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {/* 数据源连通性概览 */}
      <Card size="small" title="数据源连通性">
        {health ? (
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Text strong>Elasticsearch</Text>
              <Divider style={{ margin: '8px 0' }} />
              <Space direction="vertical" size={4} style={{ width: '100%' }}>
                {esAll.length === 0 && <Text type="secondary">未配置任何 ES 数据源</Text>}
                {esAll.map((d) => (
                  <Space key={d.id}>
                    <DsHealthTag dsId={d.id} liveMap={liveMap} />
                    <Text code style={{ fontSize: 12 }}>{d.id}</Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>{d.url}</Text>
                    {!d.enabled && <Tag>已禁用</Tag>}
                  </Space>
                ))}
                {esAll.length > 0 && (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    连通 {esOk}/{esAll.length}
                  </Text>
                )}
              </Space>
            </Col>
            <Col xs={24} md={12}>
              <Text strong>Prometheus</Text>
              <Divider style={{ margin: '8px 0' }} />
              <Space direction="vertical" size={4} style={{ width: '100%' }}>
                {promAll.length === 0 && <Text type="secondary">未配置任何 Prometheus 数据源</Text>}
                {promAll.map((d) => (
                  <Space key={d.id}>
                    <DsHealthTag dsId={d.id} liveMap={liveMap} />
                    <Text code style={{ fontSize: 12 }}>{d.id}</Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>{d.url}</Text>
                    {!d.enabled && <Tag>已禁用</Tag>}
                  </Space>
                ))}
                {promAll.length > 0 && (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    连通 {promOk}/{promAll.length}
                  </Text>
                )}
              </Space>
            </Col>
          </Row>
        ) : (
          <Text type="secondary">正在探测数据源连通性…</Text>
        )}
        <Alert
          type="info"
          showIcon
          style={{ marginTop: 12 }}
          message="连通性为实时探测结果，反映后端服务器能否访问到这些数据源。若显示不通，请检查 config.yaml 里的 URL、网络可达性与认证配置。"
        />
      </Card>

      {/* 服务注册表 */}
      <Card
        title={
          <Space>
            服务注册表
            {data && <Tag color="blue">{data.total} 个服务</Tag>}
          </Space>
        }
        extra={
          <Space>
            <Button
              type="primary"
              icon={<RobotOutlined />}
              onClick={() => {
                setRegenerateTarget(null);
                setAiDialogOpen(true);
              }}
            >
              AI 生成配置
            </Button>
            <Button icon={<ReloadOutlined />} onClick={reload}>刷新</Button>
          </Space>
        }
      >
        {error && <Alert type="error" showIcon message="加载失败" description={error} style={{ marginBottom: 16 }} />}

        <Table<ServiceInfo>
          rowKey="canonicalName"
          size="small"
          loading={loading}
          columns={columns}
          dataSource={data?.items ?? []}
          expandable={{ expandedRowRender }}
          scroll={{ x: 900 }}
          pagination={false}
          locale={{ emptyText: '未配置任何服务，请在 config.yaml 的 services 段添加' }}
        />

        <Alert
          type="warning"
          showIcon
          icon={<LinkOutlined />}
          style={{ marginTop: 16 }}
          message="服务注册表是诊断准确性的基础"
          description={
            <span style={{ fontSize: 13 }}>
              AI 诊断时依赖这张表把口语化服务名映射到真实索引/指标/主机。<Text code>aliases</Text> 越全，识别越准；
              <Text code>dependsOn/dependedBy</Text> 帮助 AI 沿依赖链定位上游故障；
              <Text code>knownIssues</Text> 是你沉淀的排障经验，会让 AI 优先命中已知问题而非从零推理。
              手工修改 config.yaml 需重启后端生效；通过「AI 生成配置」保存的条目立即热生效（写前自动备份）。
            </span>
          }
        />
      </Card>

      {/* AI 生成配置对话框（新增 / 行内重新生成共用） */}
      <AiConfigDialog
        open={aiDialogOpen}
        onClose={() => setAiDialogOpen(false)}
        onSaved={reload}
        onUnauthorized={onUnauthorized}
        existingServices={(data?.items ?? []).map((s) => s.canonicalName)}
        datasources={esAll.filter((d) => d.enabled).map((d) => ({ id: d.id }))}
        regenerateTarget={regenerateTarget}
      />

      {/* 生成记录抽屉 */}
      {drawerService && (
        <GenerationsDrawer service={drawerService} onClose={() => setDrawerService(null)} onUnauthorized={onUnauthorized} />
      )}
    </Space>
  );
}
