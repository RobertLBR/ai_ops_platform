/**
 * 发起诊断页 —— 最高频交互入口。
 *
 * 设计要点：
 *   1. 服务名用下拉选择（来自服务注册表），而不是让用户手打。
 *      手打会因"服务名不统一"导致解析失败，下拉直接从注册表取规范名。
 *   2. 时间窗给快捷预设（近15分钟/1小时/今天），也支持自定义。
 *      绝大多数排障是"刚刚发生的"，快捷选项覆盖 90% 场景。
 *   3. 诊断是同步等待的（15-60秒），必须有明确的进度反馈，
 *      否则用户会以为卡死了。这里用分阶段提示。
 *   4. 常用问题模板一键填充，降低使用门槛。
 */

import { useMemo, useState } from 'react';
import {
  Card, Form, Input, Select, Button, Space, Typography, Alert, DatePicker,
  Radio, Tag, Divider, Progress, App, Collapse,
} from 'antd';
import { ThunderboltOutlined, HistoryOutlined } from '@ant-design/icons';
import dayjs, { Dayjs } from 'dayjs';
import { api } from '../api/client';
import type { DiagnosisTask, ServiceInfo } from '../api/types';
import { useApi, useMutation, formatDuration } from '../hooks/useApi';

const { Text, Paragraph } = Typography;
const { RangePicker } = DatePicker;

interface Props {
  onUnauthorized: () => void;
  onCreated: (id: string) => void;
}

/** 诊断进行中的阶段提示（同步等待时的心理安抚） */
const STAGES = [
  { at: 0, text: '正在解析服务与时间窗…', pct: 10 },
  { at: 2000, text: '正在从 ES 拉取日志、从 Prometheus 拉取指标（只读）…', pct: 35 },
  { at: 6000, text: '正在脱敏并做模板提取与聚类去重…', pct: 60 },
  { at: 12000, text: '正在注入服务架构知识，调用大模型推理…', pct: 80 },
  { at: 30000, text: '模型推理中，长上下文可能需要较长时间…', pct: 92 },
];

/** 常用问题模板 */
const QUESTION_TEMPLATES = [
  { label: '服务报错排查', text: '最近有报错，帮我看看是什么原因' },
  { label: '接口超时', text: '接口响应超时，请分析慢在哪里' },
  { label: '容器 OOM', text: '容器内存溢出被重启，请定位原因' },
  { label: '连接池耗尽', text: '数据库连接池耗尽，请分析根因' },
  { label: '配置拉取失败', text: 'Nacos 配置拉取失败，请排查' },
  { label: '巡检', text: '做一次例行巡检，看有没有异常日志' },
];

export default function AskPage({ onUnauthorized, onCreated }: Props) {
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [question, setQuestion] = useState('');
  const [serviceName, setServiceName] = useState<string | undefined>();
  const [timeMode, setTimeMode] = useState<'preset' | 'custom'>('preset');
  const [preset, setPreset] = useState<number>(15);
  const [range, setRange] = useState<[Dayjs | null, Dayjs | null] | null>(null);
  const [stageIdx, setStageIdx] = useState(0);

  const { data: servicesData } = useApi<{ total: number; items: ServiceInfo[] }>(
    () => api.listServices(),
    [],
    onUnauthorized,
  );

  const { data: recentData } = useApi(() => api.listDiagnoses({ limit: 5 }), [], onUnauthorized);

  const mut = useMutation(
    (body: { question: string; serviceName?: string; timeFrom?: string; timeTo?: string }) =>
      api.createDiagnosis(body),
    onUnauthorized,
  );

  const services = servicesData?.items ?? [];

  const serviceOptions = useMemo(
    () =>
      services.map((s) => ({
        label: (
          <Space size={4}>
            <span>{s.canonicalName}</span>
            {s.displayName && <Text type="secondary" style={{ fontSize: 12 }}>{s.displayName}</Text>}
            <Tag color={s.tier === 'core' ? 'red' : s.tier === 'important' ? 'orange' : 'default'} style={{ fontSize: 11 }}>
              {s.tier}
            </Tag>
          </Space>
        ),
        value: s.canonicalName,
      })),
    [services],
  );

  const submit = async () => {
    if (!question.trim()) {
      message.warning('请描述问题或粘贴告警内容');
      return;
    }

    let timeFrom: string | undefined;
    let timeTo: string | undefined;
    if (timeMode === 'preset') {
      timeTo = new Date().toISOString();
      timeFrom = new Date(Date.now() - preset * 60000).toISOString();
    } else if (range?.[0] && range?.[1]) {
      timeFrom = range[0].toISOString();
      timeTo = range[1].toISOString();
    }

    // 阶段进度提示
    setStageIdx(0);
    const timers = STAGES.slice(1).map((s, i) => setTimeout(() => setStageIdx(i + 1), s.at));

    const task: DiagnosisTask | null = await mut.run({
      question: question.trim(),
      serviceName,
      timeFrom,
      timeTo,
    });

    timers.forEach(clearTimeout);

    if (task) {
      if (task.status === 'done') {
        message.success(`诊断完成，耗时 ${formatDuration(task.durationMs)}`);
      } else {
        message.warning(`诊断未完成：${task.error ?? task.status}`);
      }
      onCreated(task.id);
    } else if (mut.error) {
      message.error(mut.error);
    }
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card title={<><ThunderboltOutlined /> 发起诊断</>}>
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="系统全程只读"
          description="AI 只会读取 ES 日志与 Prometheus 指标进行分析，给出根因结论和检查建议。所有修复动作需你人工确认后自行执行。"
        />

        <Form form={form} layout="vertical">
          <Form.Item label="问题描述 / 告警内容" required>
            <Input.TextArea
              rows={4}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder={
                '例如：\n' +
                '· order-service 今早 9 点开始一直报 timeout\n' +
                '· 直接粘贴告警群里的告警内容也可以，系统会自动识别服务名\n' +
                '· 容器反复重启，怀疑 OOM'
              }
            />
          </Form.Item>

          <Form.Item label="快捷模板">
            <Space wrap size={4}>
              {QUESTION_TEMPLATES.map((t) => (
                <Tag
                  key={t.label}
                  color="blue"
                  style={{ cursor: 'pointer', padding: '2px 8px' }}
                  onClick={() => setQuestion((q) => (q ? `${q}\n${t.text}` : t.text))}
                >
                  {t.label}
                </Tag>
              ))}
            </Space>
          </Form.Item>

          <Form.Item label="服务（可选，不选则自动从问题描述里识别）">
            <Select
              allowClear
              showSearch
              placeholder={services.length ? '选择服务' : '服务注册表为空，请检查 config.yaml 的 services 配置'}
              style={{ width: 360 }}
              value={serviceName}
              onChange={setServiceName}
              options={serviceOptions}
              filterOption={(input, option) => String(option?.value ?? '').toLowerCase().includes(input.toLowerCase())}
              disabled={services.length === 0}
            />
          </Form.Item>

          <Form.Item label="取证时间窗">
            <Space direction="vertical" size={8}>
              <Radio.Group
                value={timeMode}
                onChange={(e) => setTimeMode(e.target.value)}
                optionType="button"
                buttonStyle="solid"
                options={[
                  { label: '快捷区间', value: 'preset' },
                  { label: '自定义', value: 'custom' },
                ]}
              />
              {timeMode === 'preset' ? (
                <Radio.Group value={preset} onChange={(e) => setPreset(e.target.value)}>
                  {[15, 30, 60, 180, 360, 1440].map((m) => (
                    <Radio.Button key={m} value={m}>
                      {m < 60 ? `近 ${m} 分钟` : m < 1440 ? `近 ${m / 60} 小时` : '近 24 小时'}
                    </Radio.Button>
                  ))}
                </Radio.Group>
              ) : (
                <RangePicker
                  showTime
                  value={range}
                  onChange={(v) => setRange(v as [Dayjs | null, Dayjs | null] | null)}
                  presets={[
                    { label: '今天', value: [dayjs().startOf('day'), dayjs()] },
                    { label: '近 1 小时', value: [dayjs().add(-1, 'hour'), dayjs()] },
                    { label: '近 24 小时', value: [dayjs().add(-24, 'hour'), dayjs()] },
                  ]}
                />
              )}
              <Text type="secondary" style={{ fontSize: 12 }}>
                窗口越大取证越多、耗时越长。建议先用近 15-30 分钟，不够再扩大。
              </Text>
            </Space>
          </Form.Item>

          <Form.Item>
            <Space>
              <Button type="primary" size="large" loading={mut.loading} onClick={submit}>
                开始诊断
              </Button>
              <Button onClick={() => { setQuestion(''); setServiceName(undefined); setRange(null); }} disabled={mut.loading}>
                清空
              </Button>
            </Space>
          </Form.Item>
        </Form>

        {mut.loading && (
          <Card size="small" style={{ background: '#fafafa' }}>
            <Space direction="vertical" style={{ width: '100%' }} size={8}>
              <Progress percent={STAGES[stageIdx].pct} status="active" showInfo={false} />
              <Text>{STAGES[stageIdx].text}</Text>
              <Text type="secondary" style={{ fontSize: 12 }}>
                通常需要 15-60 秒。若长时间无响应，请检查大模型 API 是否可从本机访问。
              </Text>
            </Space>
          </Card>
        )}

        {mut.error && (
          <Alert
            type="error"
            showIcon
            style={{ marginTop: 16 }}
            message="诊断请求失败"
            description={
              <div>
                <div>{mut.error}</div>
                <Divider style={{ margin: '8px 0' }} />
                <Text type="secondary" style={{ fontSize: 12 }}>
                  常见原因：① 大模型 API Key 未配置或本机无法访问公网 API ② ES/Prometheus 不可达
                  ③ 时间窗内无日志 ④ 服务名不在注册表。可访问 /api/datasources/health 查看数据源可达性。
                </Text>
              </div>
            }
          />
        )}
      </Card>

      <Collapse
        items={[
          {
            key: 'recent',
            label: <Space><HistoryOutlined /><Text strong>最近诊断</Text></Space>,
            children: recentData?.items?.length ? (
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                {recentData.items.map((t) => (
                  <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Space size={8}>
                      <Tag color={t.status === 'done' ? 'green' : t.status === 'failed' ? 'red' : 'default'}>
                        {t.status}
                      </Tag>
                      {t.serviceName && <Tag color="blue">{t.serviceName}</Tag>}
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {dayjs(t.createdAt).format('MM-DD HH:mm')}
                      </Text>
                      <Paragraph style={{ marginBottom: 0, maxWidth: 420 }} ellipsis={{ rows: 1 }}>
                        {t.summary ?? t.question}
                      </Paragraph>
                    </Space>
                    <Button size="small" type="link" onClick={() => onCreated(t.id)}>查看</Button>
                  </div>
                ))}
              </Space>
            ) : (
              <Text type="secondary">暂无诊断记录</Text>
            ),
          },
        ]}
      />
    </Space>
  );
}
