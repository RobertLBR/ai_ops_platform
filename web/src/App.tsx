/**
 * 应用框架：侧边导航 + 内容区。
 *
 * 页面路由用简单的 state 切换而非 react-router —— 内网自用工具，
 * 5 个页面，少一个依赖，构建更稳。URL hash 同步，方便刷新和分享链接。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Layout, Menu, Typography, Button, Modal, Input, Space, Tag, Tooltip, Alert, Form, App as AntdApp } from 'antd';
import {
  DashboardOutlined,
  FileSearchOutlined,
  MessageOutlined,
  ApartmentOutlined,
  AlertOutlined,
  SafetyOutlined,
  KeyOutlined,
  LockOutlined,
  LogoutOutlined,
} from '@ant-design/icons';
import { api, ApiError, getToken, setToken, getSession, setSession, isLoggedIn } from './api/client';
import { useMonitor } from './hooks/useMonitor';
import MonitorSwitch from './components/MonitorSwitch';
import LoginPage from './pages/LoginPage';
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
  // Web 登录态：null = 校验中，false = 未登录（显示登录页），true = 已登录
  const [loggedIn, setLoggedIn] = useState<boolean | null>(() => (isLoggedIn() ? null : false));
  const [forceChangePwd, setForceChangePwd] = useState(false);
  const [pwdModalOpen, setPwdModalOpen] = useState(false);

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
    // 会话/令牌失效：优先回登录页（若登录体系启用），否则弹 Token 设置
    if (isLoggedIn()) {
      setSession('');
      setLoggedIn(false);
    } else {
      setUnauthorized(true);
      setTokenModalOpen(true);
    }
  }, []);

  // 启动时校验登录会话（/auth/status），无效则进入登录页
  useEffect(() => {
    if (!isLoggedIn()) {
      setLoggedIn(false);
      return;
    }
    let cancelled = false;
    api
      .authStatus()
      .then((s) => {
        if (cancelled) return;
        if (s.authenticated) {
          setLoggedIn(true);
          if (s.mustChangePassword) setForceChangePwd(true);
        } else {
          setSession('');
          setLoggedIn(false);
        }
      })
      .catch(() => {
        // 网络异常时不强制登出，保持会话（后端离线时页面仍有提示）
        if (!cancelled) setLoggedIn(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 登录成功回调：进入工作台；若仍在用默认密码则强制改密
  const onLoginSuccess = useCallback((mustChange: boolean) => {
    setLoggedIn(true);
    if (mustChange) setForceChangePwd(true);
  }, []);

  // 退出登录：清会话回登录页
  const onLogout = useCallback(() => {
    setSession('');
    setLoggedIn(false);
    setForceChangePwd(false);
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
          <Tooltip title="后端未响应，请确认服务已启动（默认 3003 端口）">
            <Tag color="red">后端离线</Tag>
          </Tooltip>
        )}
        {backendUp === true && <Tag color="green">后端在线 {version && `v${version}`}</Tag>}
        <MonitorSwitch enabled={monitor.enabled} onChange={monitor.setEnabled} activeCount={activeCount} failing={monitor.failing} />
        <Button size="small" icon={<LockOutlined />} onClick={() => setPwdModalOpen(true)}>
          修改密码
        </Button>
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
        <Button size="small" icon={<LogoutOutlined />} onClick={onLogout}>
          退出
        </Button>
      </Space>
    ),
    [backendUp, version, monitor.enabled, monitor.setEnabled, monitor.failing, activeCount, onLogout],
  );

  // 启动期会话校验中：不渲染任何内容，避免闪登录页
  if (loggedIn === null) return null;

  // 未登录：只渲染登录页
  if (!loggedIn) return <LoginPage onSuccess={onLoginSuccess} />;

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
          {forceChangePwd && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 16 }}
              message="安全提示：当前仍在使用默认密码"
              description={
                <Space>
                  <Text>系统检测到管理员密码仍为初始默认值，存在被猜解风险，请尽快修改。</Text>
                  <Button size="small" type="primary" onClick={() => setPwdModalOpen(true)}>
                    立即修改
                  </Button>
                </Space>
              }
            />
          )}

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

      <ChangePasswordModal
        open={pwdModalOpen}
        onClose={() => setPwdModalOpen(false)}
        onNeedRelogin={() => {
          setPwdModalOpen(false);
          onLogout();
        }}
      />
    </Layout>
  );
}

/** 修改密码弹窗：校验旧密码，成功后后端使全部会话失效 → 需重新登录。 */
function ChangePasswordModal({
  open,
  onClose,
  onNeedRelogin,
}: {
  open: boolean;
  onClose: () => void;
  onNeedRelogin: () => void;
}) {
  const [form] = Form.useForm<{ currentPassword: string; newPassword: string; confirm: string }>();
  const [loading, setLoading] = useState(false);
  const { message } = AntdApp.useApp();

  const submit = async () => {
    try {
      const values = await form.validateFields();
      if (values.newPassword !== values.confirm) {
        message.error('两次输入的新密码不一致');
        return;
      }
      setLoading(true);
      const r = await api.changePassword(values.currentPassword, values.newPassword);
      if (r.ok) {
        message.success('密码已修改，请使用新密码重新登录');
        form.resetFields();
        onNeedRelogin();
      }
    } catch (e) {
      if (e && typeof e === 'object' && 'errorFields' in e) return; // 表单校验错误
      const err = e as ApiError;
      message.error(err.message || '修改失败，请稍后重试');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      title="修改管理员密码"
      open={open}
      onCancel={() => {
        form.resetFields();
        onClose();
      }}
      onOk={submit}
      okText="确认修改"
      cancelText="取消"
      confirmLoading={loading}
      destroyOnClose
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="修改成功后所有登录会话立即失效，需要用新密码重新登录。"
      />
      <Form form={form} layout="vertical" requiredMark={false} autoComplete="new-password">
        <Form.Item name="currentPassword" label="当前密码" rules={[{ required: true, message: '请输入当前密码' }]}>
          <Input.Password placeholder="当前密码" autoComplete="current-password" />
        </Form.Item>
        <Form.Item
          name="newPassword"
          label="新密码"
          rules={[
            { required: true, message: '请输入新密码' },
            { min: 8, message: '新密码至少 8 位' },
          ]}
        >
          <Input.Password placeholder="至少 8 位" autoComplete="new-password" />
        </Form.Item>
        <Form.Item name="confirm" label="确认新密码" rules={[{ required: true, message: '请再次输入新密码' }]}>
          <Input.Password placeholder="再次输入新密码" autoComplete="new-password" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
