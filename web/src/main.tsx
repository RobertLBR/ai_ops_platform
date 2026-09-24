import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider, App as AntdApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import 'dayjs/locale/zh-cn';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import App from './App';

dayjs.extend(relativeTime);
dayjs.locale('zh-cn');

/**
 * 渲染错误边界：捕获子树渲染期异常，避免直接白屏（静默卡在「加载中…」）。
 * 出错时显示可读报错 + 控制台堆栈，便于定位。
 */
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error('前端渲染异常：', error);
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 40, fontFamily: 'sans-serif', color: '#333' }}>
          <h2>页面渲染出错</h2>
          <pre style={{ whiteSpace: 'pre-wrap', color: '#c00', background: '#fff0f0', padding: 12, borderRadius: 8 }}>
            {this.state.error.message}
          </pre>
          <p>请刷新页面重试；若持续出现，错误信息已打印到浏览器控制台（F12 → Console）。</p>
        </div>
      );
    }
    return this.props.children;
  }
}

const rootEl = document.getElementById('root');
if (rootEl) rootEl.innerHTML = '';

ReactDOM.createRoot(rootEl as HTMLElement).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: '#185FA5',
          borderRadius: 8,
          fontSize: 14,
        },
      }}
    >
      <AntdApp>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </AntdApp>
    </ConfigProvider>
  </React.StrictMode>,
);
