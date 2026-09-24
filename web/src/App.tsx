/**
 * 应用框架：侧边导航 + 内容区。
 *
 * 页面路由用简单的 state 切换而非 react-router —— 内网自用工具，
 * 5 个页面，少一个依赖，构建更稳。URL hash 同步，方便刷新和分享链接。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Layout, Menu, Typography, Button, Modal, Input, Space, Tag, Tooltip, Alert } from 'antd';
import {
  DashboardOutlined,
  FileSearchOutlined,
  MessageOutlined,
  ApartmentOutlined,
  AlertOutlined,
  SafetyOutlined,
  KeyOutlined,
  ApiOutlined,
} from '@ant-design/icons';
import { api, ApiError, getToken, setToken } from './api/client';
import { useMonitor } from './hooks/useMonitor';
import MonitorSwitch from './components/MonitorSwitch';
import DiagnosisList from './pages/DiagnosisList';
import DiagnosisDetail from './pages/DiagnosisDetail';
import AskPage from './pages/AskPage';
import MetricsDashboard from './pages/MetricsDashboard';
import ServicesPage from './pages/ServicesPage';
import AlertsPage from './pages/AlertsPage';
import AuditPage from './pages/AuditPage';

const { Sider, Header, Content } = Layout;
const { Text } = Typography;

type PageKey = 'metrics' | 'ask' | 'diagnoses' | 'detail' | 'services' | 'alerts' | 'audit';

const MENU_ITEMS = [
  { key: 'metrics', icon: <DashboardOutlined />, label: '成果看板' },
  { key: 'ask', icon: <MessageOutlined />, label: '发起诊断' },
  { key: 'diagnoses', icon: <FileSearchOutlined />, label: '诊断记录' },
  { key: 'services', icon: <ApartmentOutlined />, label: '服务注册表' },
  { key: 'alerts', icon: <AlertOutlined />, label: '告警流水' },
  { key: 'audit', icon: <SafetyOutlined />, label: '审计日志' },
];

/** 从 URL hash 恢复页面与详情 id */
function parseHash(): { page: PageKey; detailId?: string } {
  const h = window.location.hash.replace(/^#\/?/, '');
  if (!h) return { page: 'metrics' };
  const [page, param] = h.split('/');
  if (page === 'detail' && param) return { page: 'detail', detailId: decodeURIComponent(param) };
  const valid: PageKey[] = ['metrics', 'ask', 'diagnoses', 'services', 'alerts', 'audit'];
  return { page: (valid.includes(page as PageKey) ? page : 'metrics') as PageKey };
}

export default function App() {
  const [state, setState] = useState<{ page: PageKey; detailId?: string }>(() => parseHash());
  const [version, setVersion] = useState('');
  const [backendUp, setBackendUp] = useState<boolean | null>(null);
  const [tokenModalOpen, setTokenModalOpen] = useState(false);
  const [tokenInput, setTokenInput] = useState('');
  const [unauthorized, setUnauthorized] = useState(false);

  const navigate = useCallback((page: PageKey, detailId?: string) => {
    window.location.hash = detailId ? `#/${page}/${encodeURIComponent(detailId)}` : `#/${page}`;
    setState({ page, detailId });
  }, []);

  // hash 变化（浏览器前进后退）时同步
  useEffect(() => {
    const onHash = () => setState(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // 探活 + 拿版本
  useEffect(() => {
    let cancelled = false;
    const ping = async () => {
      try {
        const h = await api.health();
        if (!cancelled) {
          setBackendUp(true);
          setVersion(h.version);
        }
      } catch {
        if (!cancelled) setBackendUp(false);
      }
    };
    void ping();
    const timer = setInterval(ping, 30000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  // 首次进入且已配置 token 校验需求时，提示设置
  useEffect(() => {
    const h = window.location.hash;
    if (!getToken() && h.includes('needToken=1')) {
      setTokenModalOpen(true);
    }
  }, []);

  const onApiUnauthorized = useCallback(() => {
    setUnauthorized(true);
    setTokenModalOpen(true);
  }, []);

  // 实时监控状态引擎（默认 OFF；ON 时仅 leader tab 每 5s 轮询 /monitor/snapshot）
  const monitor = useMonitor(onApiUnauthorized);
  const activeCount = (monitor.snapshot?.activeDiagnoses ?? []).filter(
    (t) => t.status !== 'done' && t.status !== 'failed',
  ).length;
  // 快照版本号：OFF 时恒为 0（页面行为与现状完全一致），ON 时每帧快照 +1 触发页面 reload
  const liveTick = monitor.enabled ? monitor.lastPolledAt ?? 0 : 0;

  const headerRight = useMemo(
    () => (
      <Space size="middle">
        {backendUp === false && (
          <Tooltip title="后端未响应，请确认服务已启动（默认 3000 端口）">
            <Tag color="red">后端离线</Tag>
          </Tooltip>
        )}
        {backendUp === true && <Tag color="green">后端在线 {version && `v${version}`}</Tag>}
        <MonitorSwitch enabled={monitor.enabled} onChange={monitor.setEnabled} activeCount={activeCount} failing={monitor.failing} />
        <Button
          size="small"
          icon={<KeyOutlined />}
          onClick={() => {
            setTokenInput(getToken());
            setTokenModalOpen(true);
          }}
        >
          API Token
        </Button>
        <Button
          size="small"
          icon={<ApiOutlined />}
          onClick={() => window.open('/api/health', '_blank')}
        >
          API
        </Button>
      </Space>
    ),
    [backendUp, version, monitor.enabled, monitor.setEnabled, monitor.failing, activeCount],
  );

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider width={200} theme="light" breakpoint="lg" collapsedWidth={64}>
        <div style={{ padding: '16px 16px 8px' }}>
          <Text strong style={{ fontSize: 15 }}>
            AI 运维平台
          </Text>
          <br />
          <Text type="secondary" style={{ fontSize: 12 }}>
            只读诊断 · 不做自动修复
          </Text>
        </div>
        <Menu
          mode="inline"
          selectedKeys={[state.page === 'detail' ? 'diagnoses' : state.page]}
          items={MENU_ITEMS}
          onClick={({ key }) => navigate(key as PageKey)}
          style={{ borderRight: 0 }}
        />
      </Sider>

      <Layout>
        <Header
          style={{
            background: '#fff',
            padding: '0 24px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            borderBottom: '1px solid #f0f0f0',
            height: 56,
            lineHeight: '56px',
          }}
        >
          {headerRight}
        </Header>

        <Content style={{ padding: 24, background: '#f5f5f5', overflow: 'auto' }}>
          {unauthorized && (
            <Alert
              type="warning"
              showIcon
              closable
              onClose={() => setUnauthorized(false)}
              style={{ marginBottom: 16 }}
              message="接口返回 401：需要 API Token"
              description="后端配置了 server.apiToken。请点右上角「API Token」填入，值来自你 config.yaml 里的 server.apiToken（或环境变量 AIOPS_API_TOKEN）。"
            />
          )}

          {state.page === 'metrics' && <MetricsDashboard onUnauthorized={onApiUnauthorized} onNavigate={navigate} liveTick={liveTick} />}
          {state.page === 'ask' && (
            <AskPage
              onUnauthorized={onApiUnauthorized}
              onCreated={(id) => navigate('detail', id)}
            />
          )}
          {state.page === 'diagnoses' && (
            <DiagnosisList onUnauthorized={onApiUnauthorized} onOpen={(id) => navigate('detail', id)} liveTick={liveTick} />
          )}
          {state.page === 'detail' && state.detailId && (
            <DiagnosisDetail
              id={state.detailId}
              onUnauthorized={onApiUnauthorized}
              onBack={() => navigate('diagnoses')}
              liveTick={liveTick}
            />
          )}
          {state.page === 'services' && <ServicesPage onUnauthorized={onApiUnauthorized} />}
          {state.page === 'alerts' && (
            <AlertsPage onUnauthorized={onApiUnauthorized} onOpen={(id) => navigate('detail', id)} liveTick={liveTick} />
          )}
          {state.page === 'audit' && <AuditPage onUnauthorized={onApiUnauthorized} />}
        </Content>
      </Layout>

      <Modal
        title="设置 API Token"
        open={tokenModalOpen}
        onCancel={() => setTokenModalOpen(false)}
        onOk={() => {
          setToken(tokenInput.trim());
          setTokenModalOpen(false);
          setUnauthorized(false);
        }}
        okText="保存"
        cancelText="取消"
      >
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <Text type="secondary">
            对应配置文件 <Text code>server.apiToken</Text>。若后端未配置 token，这里留空即可。
            Token 只存在浏览器 localStorage，不会上传。
          </Text>
          <Input.Password
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder="粘贴 API Token"
            onPressEnter={() => {
              setToken(tokenInput.trim());
              setTokenModalOpen(false);
              setUnauthorized(false);
            }}
          />
          <Button
            size="small"
            onClick={async () => {
              try {
                await api.metricsSummary();
                Modal.info({ title: '校验通过', content: 'Token 有效，可以正常访问接口。' });
              } catch (e) {
                const err = e as ApiError;
                Modal.error({
                  title: '校验失败',
                  content: err.status === 401 ? 'Token 无效或后端要求鉴权' : err.message,
                });
              }
            }}
          >
            测试连接
          </Button>
        </Space>
      </Modal>
    </Layout>
  );
}
