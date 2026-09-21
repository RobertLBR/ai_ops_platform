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
        <App />
      </AntdApp>
    </ConfigProvider>
  </React.StrictMode>,
);
