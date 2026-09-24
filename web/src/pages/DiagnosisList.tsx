/**
 * 诊断记录列表页。
 *
 * 用 antd Table 的 columns 配置驱动 —— 写数据结构而不是 JSX，
 * 这对不熟 React 的人是决定性差异：心智模型和写 YAML/PromQL 一样。
 */

import { useMemo, useState } from 'react';
import { Card, Table, Tag, Button, Space, Select, Tooltip, Typography, Alert } from 'antd';
import { ReloadOutlined, EyeOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { api } from '../api/client';
import type { DiagnosisListItem } from '../api/types';
import { useApi, severityColor, statusMeta, triggerText, formatDuration } from '../hooks/useApi';

const { Text } = Typography;

interface Props {
  onUnauthorized: () => void;
  onOpen: (id: string) => void;
  /** 实时监控快照版本号（OFF 时恒为 0，行为与现状一致） */
  liveTick?: number;
}

export default function DiagnosisList({ onUnauthorized, onOpen, liveTick = 0 }: Props) {
  const [status, setStatus] = useState<string | undefined>();
  const [service, setService] = useState<string | undefined>();
  const [page, setPage] = useState(1);
  const pageSize = 20;

  const { data, loading, error, reload } = useApi(
    () => api.listDiagnoses({ limit: pageSize, offset: (page - 1) * pageSize, status, service }),
    [page, status, service, liveTick],
    onUnauthorized,
  );

  // 服务下拉选项：从数据里提取，避免额外请求
  const serviceOptions = useMemo(() => {
    const set = new Set<string>();
    for (const it of data?.items ?? []) if (it.serviceName) set.add(it.serviceName);
    return [...set].map((s) => ({ label: s, value: s }));
  }, [data]);

  const columns: ColumnsType<DiagnosisListItem> = [
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      width: 160,
      render: (v: string) => (
        <Tooltip title={dayjs(v).format('YYYY-MM-DD HH:mm:ss')}>
          <Text style={{ fontSize: 13 }}>{dayjs(v).format('MM-DD HH:mm')}</Text>
        </Tooltip>
      ),
    },
    {
      title: '服务',
      dataIndex: 'serviceName',
      width: 180,
      render: (v: string | null) =>
        v ? <Tag color="blue">{v}</Tag> : <Text type="secondary">未识别</Text>,
    },
    {
      title: '触发',
      dataIndex: 'trigger',
      width: 90,
      render: (v: string) => <Text type="secondary">{triggerText(v)}</Text>,
    },
    {
      title: '问题 / 结论',
      dataIndex: 'question',
      render: (_: unknown, r) => (
        <div>
          <div style={{ marginBottom: 2 }}>{r.question}</div>
          {r.summary && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              ↳ {r.summary}
            </Text>
          )}
          {r.error && (
            <Text type="danger" style={{ fontSize: 12 }}>
              ✗ {r.error.slice(0, 120)}
            </Text>
          )}
        </div>
      ),
    },
    {
      title: '级别',
      dataIndex: 'severity',
      width: 90,
      render: (v: string | null) => (v ? <Tag color={severityColor(v)}>{v}</Tag> : '-'),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (v: string) => {
        const m = statusMeta(v);
        return <Tag color={m.color}>{m.text}</Tag>;
      },
    },
    {
      title: '耗时',
      dataIndex: 'durationMs',
      width: 80,
      render: (v: number | null) => formatDuration(v),
    },
    {
      title: '反馈',
      dataIndex: 'feedbackVerdict',
      width: 80,
      render: (v: string | null) => {
        if (!v) return <Text type="secondary">未评</Text>;
        const map: Record<string, { t: string; c: string }> = {
          correct: { t: '准确', c: 'green' },
          partial: { t: '部分', c: 'orange' },
          wrong: { t: '错误', c: 'red' },
        };
        const m = map[v] ?? { t: v, c: 'default' };
        return <Tag color={m.c}>{m.t}</Tag>;
      },
    },
    {
      title: '操作',
      width: 70,
      fixed: 'right',
      render: (_: unknown, r) => (
        <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => onOpen(r.id)}>
          详情
        </Button>
      ),
    },
  ];

  return (
    <Card
      title="诊断记录"
      extra={
        <Space>
          <Select
            allowClear
            placeholder="状态"
            style={{ width: 120 }}
            value={status}
            onChange={(v) => {
              setStatus(v);
              setPage(1);
            }}
            options={[
              { label: '已完成', value: 'done' },
              { label: '失败', value: 'failed' },
              { label: '分析中', value: 'analyzing' },
            ]}
          />
          <Select
            allowClear
            showSearch
            placeholder="按服务筛选"
            style={{ width: 200 }}
            value={service}
            onChange={(v) => {
              setService(v);
              setPage(1);
            }}
            options={serviceOptions}
            filterOption={(input, option) => String(option?.value ?? '').toLowerCase().includes(input.toLowerCase())}
          />
          <Button icon={<ReloadOutlined />} onClick={reload}>
            刷新
          </Button>
        </Space>
      }
    >
      {error && <Alert type="error" showIcon message="加载失败" description={error} style={{ marginBottom: 16 }} />}

      <Table<DiagnosisListItem>
        rowKey="id"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={data?.items ?? []}
        scroll={{ x: 1200 }}
        pagination={{
          current: page,
          pageSize,
          total: data?.total ?? 0,
          showSizeChanger: false,
          showTotal: (t) => `共 ${t} 条`,
          onChange: setPage,
        }}
        onRow={(r) => ({
          onClick: (e) => {
            // 点操作列的按钮时不重复跳转
            if ((e.target as HTMLElement).closest('button')) return;
            onOpen(r.id);
          },
          style: { cursor: 'pointer' },
        })}
      />
    </Card>
  );
}
