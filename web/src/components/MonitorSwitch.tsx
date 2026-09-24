/**
 * 实时监控开关（App Header 右侧）。
 *
 * Switch + Badge：ON 且有进行中诊断时显示 processing 态；
 * 连续失败（退避中）显示 warning 态。Tooltip 明确承诺「不产生任何 AI 调用」。
 */

import { Badge, Space, Switch, Tooltip, Typography } from 'antd';

const { Text } = Typography;

interface Props {
  enabled: boolean;
  onChange: (v: boolean) => void;
  /** 进行中（非终态）的诊断数量，用于 Badge processing 态 */
  activeCount: number;
  /** 连续失败退避中 */
  failing: boolean;
}

export default function MonitorSwitch({ enabled, onChange, activeCount, failing }: Props) {
  const badgeStatus = !enabled ? 'default' : failing ? 'warning' : activeCount > 0 ? 'processing' : 'success';
  const badgeText = !enabled ? '实时监控' : failing ? '实时监控（重连中）' : '实时监控';

  return (
    <Tooltip title="开启后每 5 秒自动刷新告警与诊断状态，不产生任何 AI 调用">
      <Space size={6}>
        <Badge status={badgeStatus} text={<Text style={{ fontSize: 13 }}>{badgeText}</Text>} />
        <Switch size="small" checked={enabled} onChange={onChange} />
      </Space>
    </Tooltip>
  );
}
