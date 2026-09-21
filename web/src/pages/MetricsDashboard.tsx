/**
 * 成果看板 —— 谈判弹药页。
 *
 * 设计目标：让"为什么值 2.65 万/月"这件事有数据支撑。
 * 核心叙事不是"AI 多聪明"，而是三个可量化的事实：
 *   1. 省了多少时间（MTTR 降幅 × 处理次数 = 累计节省工时）
 *   2. 结论有多准（人工反馈的有用率）
 *   3. 告警降噪多少（减少的无效打扰）
 *
 * 这三条都来自 config.metrics.manualBaselineMinutes 这个人工基线，
 * 所以基线必须按真实经验填写，否则数字没有说服力。
 */

import { Card, Row, Col, Statistic, Typography, Space, Tag, Alert, Button, Table, Progress, Divider, Tooltip } from 'antd';
import {
  ClockCircleOutlined, CheckCircleOutlined, AlertOutlined,
  DollarOutlined, BookOutlined, RiseOutlined, ReloadOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { api } from '../api/client';
import type { MetricsSummary, DiagnosisListItem } from '../api/types';
import { useApi, severityColor, statusMeta, formatDuration } from '../hooks/useApi';

const { Text, Title, Paragraph } = Typography;

interface Props {
  onUnauthorized: () => void;
  onNavigate: (page: 'ask' | 'diagnoses') => void;
}

export default function MetricsDashboard({ onUnauthorized, onNavigate }: Props) {
  const { data, loading, error, reload } = useApi<MetricsSummary>(() => api.metricsSummary(), [], onUnauthorized);
  const { data: recent } = useApi(() => api.listDiagnoses({ limit: 8 }), [], onUnauthorized);

  if (error) {
    return (
      <Card>
        <Alert type="error" showIcon message="加载失败" description={error} action={<Button size="small" onClick={reload}>重试</Button>} />
      </Card>
    );
  }

  if (!data) return <Card loading />;

  const s = data;
  const usefulRate = s.accuracy.usefulRate;
  const savedHours = s.speed.savedHours ?? 0;
  const speedup =
    s.speed.avgDurationMinutes !== null && s.speed.manualBaselineMinutes > 0
      ? s.speed.manualBaselineMinutes / Math.max(s.speed.avgDurationMinutes, 0.01)
      : null;

  const recentColumns: ColumnsType<DiagnosisListItem> = [
    { title: '时间', dataIndex: 'createdAt', width: 110, render: (v: string) => dayjs(v).format('MM-DD HH:mm') },
    { title: '服务', dataIndex: 'serviceName', width: 160, render: (v: string | null) => (v ? <Tag color="blue">{v}</Tag> : <Text type="secondary">未识别</Text>) },
    {
      title: '结论',
      dataIndex: 'summary',
      ellipsis: true,
      render: (v: string | null, r) => (
        <Tooltip title={v ?? r.error ?? r.question}>
          <Text type={r.status === 'failed' ? 'danger' : undefined}>{v ?? r.error ?? r.question}</Text>
        </Tooltip>
      ),
    },
    { title: '级别', dataIndex: 'severity', width: 90, render: (v: string | null) => (v ? <Tag color={severityColor(v)}>{v}</Tag> : '-') },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (v: string) => {
        const m = statusMeta(v);
        return <Tag color={m.color}>{m.text}</Tag>;
      },
    },
    { title: '耗时', dataIndex: 'durationMs', width: 80, render: (v: number | null) => formatDuration(v) },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {/* 一句话价值陈述 —— 汇报/谈判时可直接引用 */}
      <Card style={{ background: 'linear-gradient(90deg, #e6f1fb 0%, #ffffff 100%)' }}>
        <Space direction="vertical" size={4}>
          <Title level={4} style={{ margin: 0 }}>运维提效成果</Title>
          {s.tasks.done > 0 ? (
            <Paragraph style={{ margin: 0, fontSize: 15 }}>
              系统已累计完成 <Text strong>{s.tasks.done}</Text> 次故障诊断，
              平均耗时 <Text strong>{s.speed.avgDurationMinutes ?? '-'} 分钟</Text>
              {s.speed.manualBaselineMinutes ? <>（人工基线 {s.speed.manualBaselineMinutes} 分钟）</> : null}
              {speedup && speedup > 1 && <>，定位速度提升约 <Text strong>{speedup.toFixed(1)} 倍</Text></>}
              ，累计节省人工 <Text strong>{savedHours} 小时</Text>
              {usefulRate !== null && <>，结论有用率 <Text strong>{usefulRate}%</Text></>}。
            </Paragraph>
          ) : (
            <Text type="secondary">
              尚无已完成的诊断记录。数据需要真实使用后才会积累 —— 建议先用「发起诊断」跑几次历史故障验证效果。
            </Text>
          )}
          {s.accuracy.feedbackCount === 0 && s.tasks.done > 0 && (
            <Alert
              type="warning"
              showIcon
              style={{ marginTop: 8 }}
              message="准确率数据缺失"
              description="还没有任何人工反馈记录。每次诊断后请标记「准确/部分准确/错误」，否则无法证明结论质量，也无法迭代知识库。"
            />
          )}
        </Space>
      </Card>

      {/* 三大核心指标 */}
      <Row gutter={16}>
        <Col xs={24} md={8}>
          <Card>
            <Statistic
              title="累计节省人工"
              value={savedHours}
              suffix="小时"
              precision={1}
              valueStyle={{ color: '#389e0d' }}
              prefix={<ClockCircleOutlined />}
            />
            <Divider style={{ margin: '12px 0' }} />
            <Space direction="vertical" size={2} style={{ width: '100%' }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                平均诊断耗时：{s.speed.avgDurationMinutes ?? '-'} 分钟
              </Text>
              <Text type="secondary" style={{ fontSize: 12 }}>
                人工基线：{s.speed.manualBaselineMinutes} 分钟
                <Tooltip title="来自 config.yaml 的 metrics.manualBaselineMinutes，请按真实经验填写，否则节省工时的数字没有说服力">
                  <Tag style={{ marginLeft: 6, fontSize: 11 }}>可配置</Tag>
                </Tooltip>
              </Text>
              {speedup && speedup > 1 && (
                <Text style={{ fontSize: 12, color: '#389e0d' }}>
                  <RiseOutlined /> 提速 {speedup.toFixed(1)} 倍
                </Text>
              )}
            </Space>
          </Card>
        </Col>

        <Col xs={24} md={8}>
          <Card>
            <Statistic
              title="结论有用率"
              value={usefulRate ?? 0}
              suffix="%"
              precision={1}
              valueStyle={{ color: usefulRate !== null && usefulRate >= 60 ? '#389e0d' : '#d46b08' }}
              prefix={<CheckCircleOutlined />}
            />
            <Divider style={{ margin: '12px 0' }} />
            <Space direction="vertical" size={4} style={{ width: '100%' }}>
              <Progress
                percent={usefulRate ?? 0}
                showInfo={false}
                strokeColor={usefulRate !== null && usefulRate >= 60 ? '#52c41a' : '#fa8c16'}
                size="small"
              />
              <Text type="secondary" style={{ fontSize: 12 }}>
                完全准确 {s.accuracy.correct} / 部分准确 {s.accuracy.partial} / 错误 {s.accuracy.wrong}
              </Text>
              <Text type="secondary" style={{ fontSize: 12 }}>
                样本数 {s.accuracy.feedbackCount}（口径：完全+部分准确算有用）
              </Text>
            </Space>
          </Card>
        </Col>

        <Col xs={24} md={8}>
          <Card>
            <Statistic
              title="告警降噪率"
              value={s.alerts.noiseReductionRate ?? 0}
              suffix="%"
              precision={1}
              valueStyle={{ color: '#185FA5' }}
              prefix={<AlertOutlined />}
            />
            <Divider style={{ margin: '12px 0' }} />
            <Space direction="vertical" size={2} style={{ width: '100%' }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                收到告警 {s.alerts.total} 条
              </Text>
              <Text type="secondary" style={{ fontSize: 12 }}>
                降噪窗口内合并 {s.alerts.deduped} 条
              </Text>
              <Text type="secondary" style={{ fontSize: 12 }}>
                减少的无效打扰与重复排查
              </Text>
            </Space>
          </Card>
        </Col>
      </Row>

      {/* 运行与成本 */}
      <Row gutter={16}>
        <Col xs={24} md={12}>
          <Card size="small" title="诊断任务">
            <Row gutter={16}>
              <Col span={6}><Statistic title="累计" value={s.tasks.total} /></Col>
              <Col span={6}><Statistic title="完成" value={s.tasks.done} valueStyle={{ color: '#389e0d' }} /></Col>
              <Col span={6}><Statistic title="失败" value={s.tasks.failed} valueStyle={{ color: s.tasks.failed > 0 ? '#cf1322' : undefined }} /></Col>
              <Col span={6}><Statistic title="进行中" value={s.tasks.pending} /></Col>
            </Row>
            {s.tasks.total > 0 && (
              <>
                <Divider style={{ margin: '12px 0' }} />
                <Text type="secondary" style={{ fontSize: 12 }}>
                  成功率 {((s.tasks.done / s.tasks.total) * 100).toFixed(1)}%
                  {s.tasks.failed > 0 && ' — 失败通常是数据源不可达或时间窗内无日志，可查看详情页的错误信息'}
                </Text>
              </>
            )}
          </Card>
        </Col>

        <Col xs={24} md={12}>
          <Card size="small" title={<><DollarOutlined /> 成本与知识资产</>}>
            <Row gutter={16}>
              <Col span={8}>
                <Statistic
                  title="累计 token"
                  value={s.cost.totalTokens}
                  formatter={(v) => {
                    const n = Number(v);
                    if (n < 1000) return String(n);
                    if (n < 1000000) return `${(n / 1000).toFixed(1)}k`;
                    return `${(n / 1000000).toFixed(2)}M`;
                  }}
                />
              </Col>
              <Col span={8}>
                <Statistic
                  title="单次平均 token"
                  value={s.tasks.done > 0 ? Math.round(s.cost.totalTokens / s.tasks.done) : 0}
                />
              </Col>
              <Col span={8}>
                <Statistic title="沉淀案例" value={s.knowledge.caseCount} prefix={<BookOutlined />} />
              </Col>
            </Row>
            <Divider style={{ margin: '12px 0' }} />
            <Text type="secondary" style={{ fontSize: 12 }}>
              Prompt {s.cost.promptTokens.toLocaleString()} / Completion {s.cost.completionTokens.toLocaleString()}。
              日志压缩层把送入模型的量压低了 1-2 个数量级，这是成本可控的关键。
            </Text>
          </Card>
        </Col>
      </Row>

      {/* 最近诊断 */}
      <Card
        size="small"
        title="最近诊断"
        extra={
          <Space>
            <Button size="small" icon={<ReloadOutlined />} onClick={reload}>刷新</Button>
            <Button size="small" type="primary" onClick={() => onNavigate('ask')}>发起诊断</Button>
            <Button size="small" onClick={() => onNavigate('diagnoses')}>查看全部</Button>
          </Space>
        }
      >
        <Table<DiagnosisListItem>
          rowKey="id"
          size="small"
          loading={loading}
          columns={recentColumns}
          dataSource={recent?.items ?? []}
          pagination={false}
          locale={{ emptyText: '暂无诊断记录，点右上角「发起诊断」开始' }}
        />
      </Card>

      {/* 谈判口径说明 */}
      <Card size="small" title="数据口径说明（对外汇报时请参考）">
        <Space direction="vertical" size={6}>
          <Text style={{ fontSize: 13 }}>
            <Text strong>节省工时</Text> = 已完成诊断次数 × (人工基线 − AI 实际平均耗时)。
            人工基线取自 <Text code>metrics.manualBaselineMinutes</Text>，需按你的真实排障经验填写（默认 30 分钟）。
          </Text>
          <Text style={{ fontSize: 13 }}>
            <Text strong>结论有用率</Text> = (完全准确 + 部分准确) / 有反馈的样本数。
            采用这个口径而非"完全准确率"，是因为排障结论通常能指出正确方向但细节需人工补充，
            部分准确同样产生了实际价值。
          </Text>
          <Text style={{ fontSize: 13 }}>
            <Text strong>告警降噪率</Text> = 降噪窗口内合并的告警数 / 总告警数。
            反映减少的重复排查与无效打扰。
          </Text>
          <Alert
            type="warning"
            showIcon
            style={{ marginTop: 8 }}
            message="使用建议"
            description={
              <span style={{ fontSize: 13 }}>
                ① 这些数字的可信度取决于是否从上线第一天就开始记录，事后补的数据缺少基线对比，说服力弱。
                ② 对外汇报前请先积累足够样本（建议 ≥ 30 次诊断且有反馈），小样本的百分比容易失真。
                ③ 系统全程只读、不做自动修复，这一点在汇报时应主动说明 —— 它是风险可控的证据，不是能力不足。
              </span>
            }
          />
        </Space>
      </Card>
    </Space>
  );
}
