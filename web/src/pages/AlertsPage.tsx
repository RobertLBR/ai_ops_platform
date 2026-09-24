/**
 * 告警流水页。
 *
 * 展示所有入站告警（Alertmanager / 飞书 / 企微 webhook），
 * 已关联诊断的可点击跳转详情。含 webhook 接入配置说明。
 */

import { Card, Table, Tag, Space, Typography, Alert, Button, Tooltip, Divider } from 'antd';
import { ReloadOutlined, FileSearchOutlined, ApiOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { api } from '../api/client';
import type { InboundAlert } from '../api/types';
import { useApi, severityColor } from '../hooks/useApi';

const { Text, Paragraph } = Typography;

interface Props {
  onUnauthorized: () => void;
  onOpen: (id: string) => void;
  /** 实时监控快照版本号（OFF 时恒为 0，行为与现状一致） */
  liveTick?: number;
}

/** 告警来源 → 中文 */
function sourceText(source: string): string {
  switch (source) {
    case 'alertmanager':
      return 'Alertmanager';
    case 'feishu':
      return '飞书';
    case 'wecom':
      return '企微';
    case 'manual':
      return '手动';
    default:
      return source;
  }
}

/** 告警状态 → 中文 + 颜色 */
function statusMeta(status: string): { text: string; color: string } {
  switch (status) {
    case 'firing':
      return { text: '告警中', color: 'red' };
    case 'resolved':
      return { text: '已恢复', color: 'green' };
    default:
      return { text: status, color: 'default' };
  }
}

export default function AlertsPage({ onUnauthorized, onOpen, liveTick = 0 }: Props) {
  const { data, loading, error, reload } = useApi(() => api.listAlerts(100), [liveTick], onUnauthorized);

  const columns: ColumnsType<InboundAlert> = [
    {
      title: '触发时间',
      dataIndex: 'firedAt',
      width: 130,
      sorter: (a, b) => dayjs(a.firedAt).unix() - dayjs(b.firedAt).unix(),
      defaultSortOrder: 'descend',
      render: (v: string) => (
        <Tooltip title={dayjs(v).format('YYYY-MM-DD HH:mm:ss')}>
          <Text style={{ fontSize: 13 }}>{dayjs(v).format('MM-DD HH:mm')}</Text>
        </Tooltip>
      ),
    },
    {
      title: '来源',
      dataIndex: 'source',
      width: 110,
      filters: [
        { text: 'Alertmanager', value: 'alertmanager' },
        { text: '飞书', value: 'feishu' },
        { text: '企微', value: 'wecom' },
        { text: '手动', value: 'manual' },
      ],
      onFilter: (value, r) => r.source === value,
      render: (v: string) => <Tag>{sourceText(v)}</Tag>,
    },
    {
      title: '级别',
      dataIndex: 'severity',
      width: 90,
      filters: [
        { text: 'Critical', value: 'critical' },
        { text: 'Warning', value: 'warning' },
        { text: 'Info', value: 'info' },
      ],
      onFilter: (value, r) => r.severity === value,
      render: (v: string) => <Tag color={severityColor(v)}>{v.toUpperCase()}</Tag>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      filters: [
        { text: '告警中', value: 'firing' },
        { text: '已恢复', value: 'resolved' },
      ],
      onFilter: (value, r) => r.status === value,
      render: (v: string) => {
        const m = statusMeta(v);
        return <Tag color={m.color}>{m.text}</Tag>;
      },
    },
    {
      title: '服务',
      dataIndex: 'service',
      width: 160,
      render: (v: string | null) =>
        v ? <Tag color="blue">{v}</Tag> : <Text type="secondary">未识别</Text>,
    },
    {
      title: '标题 / 描述',
      render: (_: unknown, r) => (
        <div>
          <Text strong>{r.title}</Text>
          {r.deduped && (
            <Tooltip title="降噪窗口内合并的重复告警，未触发新诊断">
              <Tag color="orange" style={{ marginLeft: 6, fontSize: 11 }}>已降噪</Tag>
            </Tooltip>
          )}
          {r.description && (
            <>
              <br />
              <Text type="secondary" style={{ fontSize: 12 }}>{r.description.slice(0, 150)}</Text>
            </>
          )}
        </div>
      ),
    },
    {
      title: '诊断',
      dataIndex: 'diagnosisId',
      width: 90,
      render: (v: string | null | undefined) =>
        v ? (
          <Button type="link" size="small" icon={<FileSearchOutlined />} onClick={() => onOpen(v)}>
            查看
          </Button>
        ) : (
          <Text type="secondary" style={{ fontSize: 12 }}>未触发</Text>
        ),
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        title={
          <Space>
            告警流水
            {data && <Tag color="blue">{data.items.length} 条</Tag>}
          </Space>
        }
        extra={
          <Button icon={<ReloadOutlined />} onClick={reload}>刷新</Button>
        }
      >
        {error && <Alert type="error" showIcon message="加载失败" description={error} style={{ marginBottom: 16 }} />}

        <Table<InboundAlert>
          rowKey="id"
          size="small"
          loading={loading}
          columns={columns}
          dataSource={data?.items ?? []}
          scroll={{ x: 900 }}
          pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 条` }}
          locale={{ emptyText: '暂无告警记录' }}
        />
      </Card>

      {/* Webhook 接入配置说明 */}
      <Card size="small" title={<><ApiOutlined /> Webhook 接入配置</>}>
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Alert
            type="info"
            showIcon
            message="接入方式"
            description={
              <span style={{ fontSize: 13 }}>
                系统通过 HTTP POST webhook 接收告警，支持 Alertmanager、飞书机器人、企微机器人三种来源格式自动识别。
              </span>
            }
          />
          <Divider style={{ margin: '8px 0' }} />
          <Text strong>Alertmanager 接入</Text>
          <Paragraph style={{ margin: 0, fontSize: 13 }}>
            在 Alertmanager 的 <Text code>webhook_configs</Text> 里添加：
          </Paragraph>
          <pre style={{ background: '#f5f5f5', padding: 12, borderRadius: 4, fontSize: 12, overflow: 'auto' }}>
{`receivers:
  - name: 'ai-ops'
    webhook_configs:
      - url: 'http://<your-host>:3000/api/webhook/alertmanager?secret=<your-secret>'
        send_resolved: true`}
          </pre>
          <Divider style={{ margin: '8px 0' }} />
          <Text strong>飞书 / 企微机器人接入</Text>
          <Paragraph style={{ margin: 0, fontSize: 13 }}>
            将 webhook URL 改为 <Text code>/api/webhook/feishu</Text> 或 <Text code>/api/webhook/wecom</Text>，
            系统会自动识别消息格式并解析告警内容。
          </Paragraph>
          <Divider style={{ margin: '8px 0' }} />
          <Text strong>降噪与自动诊断</Text>
          <Paragraph style={{ margin: 0, fontSize: 13 }}>
            • <Text code>alerts.webhook.dedupWindowSeconds</Text>：降噪窗口（秒），同服务在此时间内的重复告警只记录不触发新诊断。<br />
            • <Text code>alerts.webhook.autoDiagnose</Text>：是否自动触发 AI 诊断（默认 true）。<br />
            • <Text code>alerts.webhook.minSeverity</Text>：最低触发级别（info/warning/critical），低于此级别的告警只记录不诊断。
          </Paragraph>
          <Divider style={{ margin: '8px 0' }} />
          <Text strong>密钥校验（可选）</Text>
          <Paragraph style={{ margin: 0, fontSize: 13 }}>
            在 <Text code>alerts.webhook.secret</Text> 配置密钥后，webhook 请求需携带 header：
            <br />
            <Text code>X-Webhook-Secret: &lt;your-secret&gt;</Text>
            <br />
            或通过 URL 参数 <Text code>?secret=&lt;your-secret&gt;</Text> 传递。未配置则不校验（仅限内网环境）。
          </Paragraph>
        </Space>
      </Card>
    </Space>
  );
}
