/**
 * 诊断详情页 —— 系统最重要的页面。
 *
 * 核心设计：事实与推断在视觉上强制分离。
 *   - 已确认事实：绿色边框，标题明确写「日志/指标中可直接验证」
 *   - 推断：橙色边框，标题明确写「AI 推测，需人工确认」
 *   - 盲区：灰色，AI 主动声明查不到什么
 *
 * 这不是排版偏好，而是安全设计：运维场景最危险的不是模型不会答，
 * 而是它把推测说得像已确认事实 —— 你会照着错的结论去重启服务。
 * 视觉分离让人在下手前必然看到"这是推断"。
 *
 * 处置命令区永久标注「系统不会自动执行」，强化只读边界认知。
 */

import { useEffect, useState } from 'react';
import {
  Card, Descriptions, Tag, Space, Typography, Button, Alert, Collapse, Table,
  Radio, Input, Divider, Statistic, Row, Col, Tooltip, Empty, App,
} from 'antd';
import {
  ArrowLeftOutlined, CheckCircleOutlined, WarningOutlined,
  QuestionCircleOutlined, CopyOutlined, SafetyOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { api } from '../api/client';
import type { DiagnosisTask, LogTemplate } from '../api/types';
import { useApi, useMutation, severityColor, statusMeta, triggerText, formatDuration, formatTokens } from '../hooks/useApi';

const { Text, Paragraph } = Typography;

interface Props {
  id: string;
  onUnauthorized: () => void;
  onBack: () => void;
  /** 实时监控快照版本号（OFF 时恒为 0，行为与现状一致） */
  liveTick?: number;
}

export default function DiagnosisDetail({ id, onUnauthorized, onBack, liveTick = 0 }: Props) {
  const { message, modal } = App.useApp();
  const [verdict, setVerdict] = useState<'correct' | 'partial' | 'wrong'>('correct');
  const [comment, setComment] = useState('');

  // 仅当任务处于非终态时才跟随实时快照自动刷新（终态任务不再轮询）
  const [tickGate, setTickGate] = useState(0);
  const { data: task, loading, error, reload } = useApi<DiagnosisTask>(() => api.getDiagnosis(id), [id, tickGate], onUnauthorized);
  const isActive = task ? task.status === 'pending' || task.status === 'collecting' || task.status === 'analyzing' : true;
  useEffect(() => {
    if (liveTick && isActive) setTickGate(liveTick);
  }, [liveTick, isActive]);

  const feedbackMut = useMutation(
    (v: 'correct' | 'partial' | 'wrong', c: string) => api.submitFeedback(id, v, c),
    onUnauthorized,
  );

  const caseMut = useMutation(() => api.promoteToCase(id, {}), onUnauthorized);

  if (error) {
    return (
      <Card>
        <Alert type="error" showIcon message="加载失败" description={error} />
        <Button style={{ marginTop: 16 }} onClick={onBack} icon={<ArrowLeftOutlined />}>返回列表</Button>
      </Card>
    );
  }

  if (loading || !task) {
    return <Card loading={loading} title="诊断详情" />;
  }

  const c = task.conclusion;
  const status = statusMeta(task.status);
  const tplColumns: ColumnsType<LogTemplate> = [
    {
      title: '级别',
      dataIndex: 'levels',
      width: 90,
      render: (v: string[]) => (v ?? []).map((l) => <Tag key={l} color={l === 'ERROR' ? 'red' : l === 'WARN' ? 'orange' : 'default'}>{l}</Tag>),
    },
    {
      title: '模板（变量已归一为 <*>）',
      dataIndex: 'template',
      render: (v: string, r) => (
        <div>
          <Text code style={{ fontSize: 12, wordBreak: 'break-all' }}>{v.slice(0, 400)}</Text>
          <Space size={4} style={{ marginTop: 4 }} wrap>
            {r.isNew && <Tag color="magenta">全新模式</Tag>}
            {r.knownIssue && (
              <Tooltip title={r.knownIssue.sop}>
                <Tag color="volcano">已知问题：{r.knownIssue.category}</Tag>
              </Tooltip>
            )}
            {r.baselineCount !== undefined && r.baselineCount !== null && r.baselineCount > 0 && (
              <Tag color="gold">基线 {r.baselineCount} 次</Tag>
            )}
          </Space>
        </div>
      ),
    },
    { title: '次数', dataIndex: 'count', width: 80, sorter: (a, b) => a.count - b.count, defaultSortOrder: 'descend' },
    {
      title: '时间跨度',
      width: 170,
      render: (_: unknown, r) => (
        <Text style={{ fontSize: 12 }}>
          {dayjs(r.firstSeen).format('HH:mm:ss')} ~ {dayjs(r.lastSeen).format('HH:mm:ss')}
        </Text>
      ),
    },
    {
      title: '样本',
      dataIndex: 'samples',
      width: 80,
      render: (v: string[]) =>
        v?.length ? (
          <Button
            size="small"
            type="link"
            onClick={() =>
              modal.info({
                title: '代表性日志样本（已脱敏）',
                width: 760,
                content: (
                  <div style={{ maxHeight: 420, overflow: 'auto' }}>
                    {v.map((s, i) => (
                      <Paragraph key={i} code style={{ fontSize: 12, whiteSpace: 'pre-wrap', marginBottom: 8 }}>
                        {s}
                      </Paragraph>
                    ))}
                  </div>
                ),
              })
            }
          >
            查看 {v.length}
          </Button>
        ) : (
          '-'
        ),
    },
  ];

  const copyText = (text: string, label: string) => {
    navigator.clipboard?.writeText(text).then(
      () => message.success(`${label}已复制`),
      () => message.error('复制失败，请手动选择文本'),
    );
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        title={
          <Space>
            <Button size="small" icon={<ArrowLeftOutlined />} onClick={onBack}>返回</Button>
            <span>诊断详情</span>
            <Tag color={status.color}>{status.text}</Tag>
            {c && <Tag color={severityColor(c.severity)}>{c.severity}</Tag>}
          </Space>
        }
        extra={
          <Space>
            <Text type="secondary" style={{ fontSize: 12 }}>任务 {task.id}</Text>
            <Button size="small" onClick={reload}>刷新</Button>
          </Space>
        }
      >
        <Descriptions size="small" column={{ xs: 1, sm: 2, md: 3 }} bordered>
          <Descriptions.Item label="服务">
            {task.serviceName ? <Tag color="blue">{task.serviceName}</Tag> : <Text type="secondary">未识别</Text>}
          </Descriptions.Item>
          <Descriptions.Item label="触发方式">{triggerText(task.trigger)}</Descriptions.Item>
          <Descriptions.Item label="创建时间">{dayjs(task.createdAt).format('YYYY-MM-DD HH:mm:ss')}</Descriptions.Item>
          <Descriptions.Item label="取证窗口" span={2}>
            {task.timeFrom && task.timeTo
              ? `${dayjs(task.timeFrom).format('MM-DD HH:mm')} ~ ${dayjs(task.timeTo).format('MM-DD HH:mm')}`
              : '-'}
          </Descriptions.Item>
          <Descriptions.Item label="诊断耗时">{formatDuration(task.durationMs)}</Descriptions.Item>
          <Descriptions.Item label="提问 / 告警内容" span={3}>
            <Paragraph style={{ marginBottom: 0, whiteSpace: 'pre-wrap' }}>{task.question}</Paragraph>
          </Descriptions.Item>
        </Descriptions>

        {task.status === 'failed' && task.error && (
          <Alert type="error" showIcon style={{ marginTop: 16 }} message="诊断失败" description={task.error} />
        )}
        {(task.status === 'pending' || task.status === 'collecting' || task.status === 'analyzing') && (
          <Alert type="info" showIcon style={{ marginTop: 16 }} message="诊断进行中，请稍后刷新" />
        )}
      </Card>

      {c && (
        <>
          {/* 结论摘要 */}
          <Card size="small" title="结论摘要">
            <Paragraph style={{ fontSize: 15, marginBottom: 0 }}>{c.summary}</Paragraph>
          </Card>

          {/* 根因候选 */}
          {c.root_cause_candidates.length > 0 && (
            <Card
              size="small"
              title={<><WarningOutlined /> 根因候选（按可能性排序）</>}
            >
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                {c.root_cause_candidates.map((rc) => (
                  <Card key={rc.rank} size="small" type="inner" title={
                    <Space>
                      <Tag color="blue">#{rc.rank}</Tag>
                      <Text strong>{rc.target}</Text>
                      <Tag color={rc.confidence === 'high' ? 'green' : rc.confidence === 'medium' ? 'orange' : 'default'}>
                        置信度 {rc.confidence}
                      </Tag>
                    </Space>
                  }>
                    <Text type="secondary">{rc.evidence}</Text>
                  </Card>
                ))}
              </Space>
            </Card>
          )}

          {/* 事实与推断分离 —— 安全设计的核心 */}
          <Row gutter={16}>
            <Col xs={24} lg={12}>
              <Card
                size="small"
                title={<Space><CheckCircleOutlined style={{ color: '#389e0d' }} /><Text strong style={{ color: '#389e0d' }}>已确认事实</Text></Space>}
                style={{ borderLeft: '3px solid #52c41a', height: '100%' }}
                extra={<Text type="secondary" style={{ fontSize: 12 }}>日志/指标中可直接验证</Text>}
              >
                {c.confirmed_facts.length ? (
                  <ul style={{ paddingLeft: 20, margin: 0 }}>
                    {c.confirmed_facts.map((f, i) => (
                      <li key={i} style={{ marginBottom: 6 }}>{f}</li>
                    ))}
                  </ul>
                ) : (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无可直接验证的事实" />
                )}
              </Card>
            </Col>
            <Col xs={24} lg={12}>
              <Card
                size="small"
                title={<Space><QuestionCircleOutlined style={{ color: '#d46b08' }} /><Text strong style={{ color: '#d46b08' }}>AI 推断</Text></Space>}
                style={{ borderLeft: '3px solid #fa8c16', height: '100%' }}
                extra={<Text type="danger" style={{ fontSize: 12 }}>需人工确认后再行动</Text>}
              >
                {c.inferences.length ? (
                  <ul style={{ paddingLeft: 20, margin: 0 }}>
                    {c.inferences.map((f, i) => (
                      <li key={i} style={{ marginBottom: 6 }}>{f}</li>
                    ))}
                  </ul>
                ) : (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无推断" />
                )}
              </Card>
            </Col>
          </Row>

          {/* 盲区声明 */}
          {c.data_gaps.length > 0 && (
            <Card size="small" title="AI 声明的信息盲区" extra={<Text type="secondary" style={{ fontSize: 12 }}>诚实说明盲区比编造结论更有价值</Text>}>
              <ul style={{ paddingLeft: 20, margin: 0 }}>
                {c.data_gaps.map((g, i) => (
                  <li key={i} style={{ marginBottom: 4 }}><Text type="secondary">{g}</Text></li>
                ))}
              </ul>
            </Card>
          )}

          {/* 检查清单 */}
          {c.checklist.length > 0 && (
            <Card size="small" title="建议检查项（按优先级）">
              <ol style={{ paddingLeft: 20, margin: 0 }}>
                {c.checklist.map((item, i) => (
                  <li key={i} style={{ marginBottom: 6 }}>{item}</li>
                ))}
              </ol>
            </Card>
          )}

          {/* 只读命令 —— 永久标注不会自动执行 */}
          {c.suggested_commands.length > 0 && (
            <Card
              size="small"
              title={<Space><SafetyOutlined /> 建议的只读诊断命令</Space>}
              extra={
                <Tag color="blue" icon={<SafetyOutlined />}>
                  系统只读，不会自动执行
                </Tag>
              }
            >
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 12 }}
                message="以下命令需你人工确认后自行在目标主机执行。系统全程只读，不具备任何写操作能力。"
              />
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                {c.suggested_commands.map((cmd, i) => (
                  <Space key={i} style={{ width: '100%' }} align="start">
                    <Paragraph code copyable={false} style={{ marginBottom: 0, flex: 1, wordBreak: 'break-all' }}>
                      {cmd}
                    </Paragraph>
                    <Button size="small" icon={<CopyOutlined />} onClick={() => copyText(cmd, '命令')}>复制</Button>
                  </Space>
                ))}
              </Space>
            </Card>
          )}

          {/* 证据：压缩后的日志模板 */}
          <Collapse
            items={[
              {
                key: 'templates',
                label: (
                  <Space>
                    <Text strong>证据：日志模板</Text>
                    <Tag>{task.logTemplates?.length ?? 0} 个模板（由原始日志压缩而来）</Tag>
                  </Space>
                ),
                children: (
                  <Table<LogTemplate>
                    rowKey="id"
                    size="small"
                    columns={tplColumns}
                    dataSource={task.logTemplates ?? []}
                    pagination={false}
                    scroll={{ x: 900 }}
                  />
                ),
              },
              {
                key: 'metrics',
                label: <Space><Text strong>证据：监控指标</Text><Tag>{task.metrics?.length ?? 0} 项</Tag></Space>,
                children: task.metrics?.length ? (
                  <Descriptions size="small" column={1} bordered>
                    {task.metrics.map((m, i) => (
                      <Descriptions.Item key={i} label={m.name || m.promql.slice(0, 40)}>
                        {m.error ? (
                          <Text type="danger">{m.error}</Text>
                        ) : (
                          <Space wrap size={4}>
                            {m.values.slice(0, 10).map((v, j) => {
                              const label = Object.entries(v.labels)
                                .filter(([k]) => ['instance', 'name', 'device', 'mountpoint'].includes(k))
                                .map(([k, val]) => `${k}=${val}`)
                                .join(',');
                              return (
                                <Tag key={j}>
                                  {label || '-'}: <Text strong>{Number.isInteger(v.value) ? v.value : v.value.toFixed(2)}</Text>
                                </Tag>
                              );
                            })}
                          </Space>
                        )}
                      </Descriptions.Item>
                    ))}
                  </Descriptions>
                ) : (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="未采集到指标" />
                ),
              },
              {
                key: 'meta',
                label: <Text strong>本次诊断的成本与脱敏审计</Text>,
                children: (
                  <Row gutter={16}>
                    <Col span={6}><Statistic title="Prompt tokens" value={task.tokensUsed?.prompt ?? 0} /></Col>
                    <Col span={6}><Statistic title="Completion tokens" value={task.tokensUsed?.completion ?? 0} /></Col>
                    <Col span={6}><Statistic title="合计" value={formatTokens((task.tokensUsed?.prompt ?? 0) + (task.tokensUsed?.completion ?? 0))} /></Col>
                    <Col span={6}><Statistic title="模型" value={task.tokensUsed?.model ?? '-'} valueStyle={{ fontSize: 14 }} /></Col>
                    <Col span={24}>
                      <Divider style={{ margin: '16px 0' }} />
                      <Text strong>脱敏审计（只记类型与次数，不记原值）：</Text>
                      <div style={{ marginTop: 8 }}>
                        {task.redactionAudit?.length ? (
                          <Space wrap>
                            {task.redactionAudit.map((a) => (
                              <Tag key={a.rule} color="purple">{a.rule}: {a.count} 处</Tag>
                            ))}
                          </Space>
                        ) : (
                          <Text type="secondary">本次未命中脱敏规则（或脱敏未启用）</Text>
                        )}
                      </div>
                    </Col>
                  </Row>
                ),
              },
            ]}
          />

          {/* 人工反馈 —— 准确率度量与知识库迭代的输入 */}
          <Card size="small" title="你的反馈（用于准确率度量与知识库迭代）">
            {task.feedback ? (
              <Alert
                type="success"
                showIcon
                message={
                  <Space>
                    <span>已标记为</span>
                    <Tag color={task.feedback.verdict === 'correct' ? 'green' : task.feedback.verdict === 'partial' ? 'orange' : 'red'}>
                      {{ correct: '准确', partial: '部分准确', wrong: '错误' }[task.feedback.verdict]}
                    </Tag>
                    <Text type="secondary">{dayjs(task.feedback.at).format('YYYY-MM-DD HH:mm')}</Text>
                  </Space>
                }
                description={task.feedback.comment || undefined}
              />
            ) : (
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                <Radio.Group
                  value={verdict}
                  onChange={(e) => setVerdict(e.target.value)}
                  optionType="button"
                  buttonStyle="solid"
                  options={[
                    { label: '准确', value: 'correct' },
                    { label: '部分准确', value: 'partial' },
                    { label: '错误', value: 'wrong' },
                  ]}
                />
                <Input.TextArea
                  rows={2}
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="补充说明（可选）。若标记为「错误」，请务必写下真实根因 —— 这是知识库迭代最有价值的输入。"
                />
                <Space>
                  <Button
                    type="primary"
                    loading={feedbackMut.loading}
                    onClick={async () => {
                      const r = await feedbackMut.run(verdict, comment);
                      if (r) {
                        message.success('反馈已记录');
                        reload();
                      } else if (feedbackMut.error) {
                        message.error(feedbackMut.error);
                      }
                    }}
                  >
                    提交反馈
                  </Button>
                  <Button
                    loading={caseMut.loading}
                    onClick={async () => {
                      const r = await caseMut.run();
                      if (r) message.success(`已沉淀为案例 ${r.caseId}`);
                      else if (caseMut.error) message.error(caseMut.error);
                    }}
                  >
                    沉淀为故障案例
                  </Button>
                </Space>
                {feedbackMut.error && <Alert type="error" showIcon message={feedbackMut.error} />}
              </Space>
            )}
          </Card>
        </>
      )}

      {!c && task.status === 'done' && (
        <Card><Alert type="warning" showIcon message="任务已完成但无结论数据" /></Card>
      )}
    </Space>
  );
}
