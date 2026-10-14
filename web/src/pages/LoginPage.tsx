/**
 * 登录页：用户名 + 密码 → POST /api/auth/login → 会话令牌存 localStorage。
 *
 * 设计：antd Form 居中卡片，错误提示友好；默认账号 admin（初始密码见部署文档），
 * 登录成功后若后端返回 mustChangePassword=true，由 App 层弹出强制改密框。
 */

import { useState } from 'react';
import { Form, Input, Button, Card, Typography, Alert, App as AntdApp } from 'antd';
import { UserOutlined, LockOutlined, SafetyOutlined } from '@ant-design/icons';
import { api, ApiError, setSession } from '../api/client';

const { Text, Title } = Typography;

interface Props {
  onSuccess: (mustChangePassword: boolean) => void;
}

export default function LoginPage({ onSuccess }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { message } = AntdApp.useApp();

  const onFinish = async (values: { username: string; password: string }) => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.login(values.username.trim(), values.password);
      setSession(r.token);
      message.success('登录成功');
      onSuccess(!!r.mustChangePassword);
    } catch (e) {
      const err = e as ApiError;
      setError(err.status === 401 ? '用户名或密码错误' : err.message || '登录失败，请稍后重试');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(135deg, #f5f7fa 0%, #e8eef5 100%)',
      }}
    >
      <Card style={{ width: 380, boxShadow: '0 4px 24px rgba(0,0,0,0.08)' }} styles={{ body: { padding: '32px 32px 24px' } }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <SafetyOutlined style={{ fontSize: 40, color: '#185FA5' }} />
          <Title level={4} style={{ marginTop: 12, marginBottom: 4 }}>
            AI 运维平台
          </Title>
          <Text type="secondary" style={{ fontSize: 13 }}>
            只读诊断 · 不做自动修复
          </Text>
        </div>

        {error && (
          <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} closable onClose={() => setError(null)} />
        )}

        <Form onFinish={onFinish} layout="vertical" requiredMark={false} autoComplete="off">
          <Form.Item name="username" rules={[{ required: true, message: '请输入用户名' }]} initialValue="admin">
            <Input prefix={<UserOutlined style={{ color: '#bfbfbf' }} />} placeholder="用户名" size="large" autoFocus />
          </Form.Item>
          <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password prefix={<LockOutlined style={{ color: '#bfbfbf' }} />} placeholder="密码" size="large" />
          </Form.Item>
          <Form.Item style={{ marginBottom: 8 }}>
            <Button type="primary" htmlType="submit" block size="large" loading={loading}>
              登 录
            </Button>
          </Form.Item>
        </Form>
      </Card>
    </div>
  );
}
