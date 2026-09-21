/**
 * 审计日志页。
 *
 * 这一页的存在意义不是"好看"，而是合规与信任：
 *   - 证明系统全程只读、没有偷偷改过任何生产配置
 *   - 记录每一次数据源访问、AI 建议的命令（不执行）、人工反馈
 *   - 向甲方/领导汇报时可作为"风险可控"的客观证据
 *
 * 所有 action 类型都在下方图例里解释，避免看到英文 action 一头雾水。
 */

import { useState } from 'react';
import { Card, Table, Tag, Space, Typography, Alert, Button, Tooltip, Drawer, Descriptions } from 'antd';
import { ReloadOutlined, SafetyOutlined, InfoCircleOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { api } from '../api/client';
import type { AuditEntry } from '../api/types';
import { useApi } from '../hooks/useApi';

const { Text, Paragraph } = Typography;

interface Props {
  onUnauthorized: () => void;
}

/**
 * action → 中文说明 + 颜色。
 *
 * 严格对齐后端实际产生的 action（server/src 里 insertAudit/this.audit 的调用点）：
 *   diagnosis.start / diagnosis.done / diagnosis.failed  —— diagnosis-engine.ts
 *   diagnosis.feedback                                    —— routes.ts
 *   llm.call                                              —— diagnosis-engine.ts
 *   daily_report.sent                                     —— scheduler.ts
 * 未列出的 action 会回退到原始英文名 + 灰色标签，不会丢数据。
 */
const ACTION_META: Record<string, { text: string; color: string; desc: string }> = {
  'diagnosis.start': { text: '发起诊断', color: 'geekblue', desc: '创建一次诊断任务，开始只读取证（ES 日志 + Prometheus 指标）' },
  'diagnosis.done': { text: '诊断完成', color: 'green', desc: '诊断成功产出结论，记录耗时、模板数、token 与脱敏命中数' },
  'diagnosis.failed': { text: '诊断失败', color: 'volcano', desc: '诊断执行失败（数据源不可达 / 时间窗内无日志等），记录错误原因' },
  'diagnosis.feedback': { text: '人工反馈', color: 'lime', desc: '对诊断结论标记准确 / 部分准确 / 错误，用于迭代知识库与统计有用率' },
  'llm.call': { text: 'LLM 调用', color: 'purple', desc: '向大模型发送一次请求。只记录 token 数与送入字符数，绝不记录 prompt 内容（内容已脱敏）' },
  'daily_report.sent': { text: '日报推送', color: 'default', desc: '调度器生成并推送每日运维报告，记录统计周期内的任务数与失败数' },
};

function actionMeta(action: string): { text: string; color: string; desc: string } {
  return ACTION_META[action] ?? { text: action, color: 'default', desc: '未归类的审计动作' };
}

/** actor → 颜色。后端实际产生的 actor：system（诊断引擎）/ user（人工反馈）/ scheduler（日报） */
function actorColor(actor: string): string {
  switch (actor) {
    case 'system':
      return 'blue';
    case 'scheduler':
      return 'purple';
    case 'user':
      return 'green';
    default:
      return 'default';
  }
}

export default function AuditPage({ onUnauthorized }: Props) {
  const { data, loading, error, reload } = useApi(() => api.listAudit(300), [], onUnauthorized);
  const [detail, setDetail] = useState<AuditEntry | null>(null);

  const columns: ColumnsType<AuditEntry> = [
    {
      title: '时间',
      dataIndex: 'at',
      width: 160,
      sorter: (a, b) => dayjs(a.at).unix() - dayjs(b.at).unix(),
      defaultSortOrder: 'descend',
      render: (v: string) => (
        <Tooltip title={dayjs(v).format('YYYY-MM-DD HH:mm:ss.SSS')}>
          <Text style={{ fontSize: 13, fontFamily: 'monospace' }}>{dayjs(v).format('MM-DD HH:mm:ss')}</Text>
        </Tooltip>
      ),
    },
    {
      title: '执行者',
      dataIndex: 'actor',
      width: 100,
      filters: [
        { text: 'system', value: 'system' },
        { text: 'scheduler', value: 'scheduler' },
        { text: 'user', value: 'user' },
      ],
      onFilter: (value, r) => r.actor === value,
      render: (v: string) => <Tag color={actorColor(v)}>{v}</Tag>,
    },
    {
      title: '动作',
      dataIndex: 'action',
      width: 140,
      render: (v: string) => {
        const m = actionMeta(v);
        return (
          <Tooltip title={m.desc}>
            <Tag color={m.color}>{m.text}</Tag>
          </Tooltip>
        );
      },
    },
    {
      title: '对象',
      dataIndex: 'target',
      ellipsis: true,
      render: (v: string) => <Text code style={{ fontSize: 12 }}>{v || '-'}</Text>,
    },
    {
      title: '操作',
      width: 80,
      fixed: 'right',
      render: (_: unknown, r) => (
        <Button type="link" size="small" onClick={() => setDetail(r)}>
          详情
        </Button>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        title={
          <Space>
            <SafetyOutlined />
            审计日志
            {data && <Tag color="blue">{data.items.length} 条</Tag>}
          </Space>
        }
        extra={
          <Button icon={<ReloadOutlined />} onClick={reload}>刷新</Button>
        }
      >
        <Alert
          type="success"
          showIcon
          icon={<SafetyOutlined />}
          style={{ marginBottom: 16 }}
          message="只读边界证明"
          description={
            <span style={{ fontSize: 13 }}>
              系统全程<Text strong>只读</Text>：诊断流水线只做"取证 → 脱敏 → 压缩 → 模型分析 → 产出结论"，
              <Text strong>不包含任何自动修复动作</Text>，AI 给出的建议命令仅展示、需人工确认后自行执行。
              审计日志完整留痕每一次诊断与模型调用，可作为向甲方/领导汇报"风险可控"的客观证据。
              其中 <Tag color="purple" style={{ fontSize: 11 }}>LLM 调用</Tag> 记录只含 token 数与送入字符数、不含 prompt 内容，
              佐证"数据先脱敏再出网"这一合规闸口确实生效。
            </span>
          }
        />

        {error && <Alert type="error" showIcon message="加载失败" description={error} style={{ marginBottom: 16 }} />}

        <Table<AuditEntry>
          rowKey="id"
          size="small"
          loading={loading}
          columns={columns}
          dataSource={data?.items ?? []}
          scroll={{ x: 800 }}
          pagination={{ pageSize: 30, showTotal: (t) => `共 ${t} 条` }}
          locale={{ emptyText: '暂无审计记录（审计功能由 security.audit.enabled 控制）' }}
        />
      </Card>

      {/* 动作类型图例 */}
      <Card size="small" title={<><InfoCircleOutlined /> 动作类型说明</>}>
        <Space direction="vertical" size={6} style={{ width: '100%' }}>
          {Object.entries(ACTION_META).map(([action, m]) => (
            <Space key={action} size={8} align="start">
              <Tag color={m.color} style={{ minWidth: 100, textAlign: 'center' }}>{m.text}</Tag>
              <Text code style={{ fontSize: 11 }}>{action}</Text>
              <Text type="secondary" style={{ fontSize: 12 }}>— {m.desc}</Text>
            </Space>
          ))}
        </Space>
      </Card>

      {/* 详情抽屉 */}
      <Drawer
        title="审计详情"
        open={!!detail}
        onClose={() => setDetail(null)}
        width={560}
      >
        {detail && (
          <Descriptions column={1} bordered size="small">
            <Descriptions.Item label="记录 ID">
              <Text code>{detail.id}</Text>
            </Descriptions.Item>
            <Descriptions.Item label="时间">
              {dayjs(detail.at).format('YYYY-MM-DD HH:mm:ss.SSS')}
            </Descriptions.Item>
            <Descriptions.Item label="执行者">
              <Tag color={actorColor(detail.actor)}>{detail.actor}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="动作">
              <Tag color={actionMeta(detail.action).color}>{actionMeta(detail.action).text}</Tag>
              <br />
              <Text code style={{ fontSize: 11 }}>{detail.action}</Text>
            </Descriptions.Item>
            <Descriptions.Item label="对象">
              <Text code>{detail.target || '-'}</Text>
            </Descriptions.Item>
            <Descriptions.Item label="详情">
              <Paragraph style={{ margin: 0 }}>
                <pre style={{ background: '#f5f5f5', padding: 12, borderRadius: 4, fontSize: 12, overflow: 'auto', maxHeight: 320, margin: 0 }}>
                  {JSON.stringify(detail.detail ?? {}, null, 2)}
                </pre>
              </Paragraph>
            </Descriptions.Item>
          </Descriptions>
        )}
      </Drawer>
    </Space>
  );
}
