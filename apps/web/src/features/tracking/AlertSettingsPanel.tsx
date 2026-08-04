import type { AlertSensitivity, AlertSettings } from "./alertSettings";
import { ALERT_PROFILES, normalizeAlertSettings } from "./alertSettings";

type Props = { settings: AlertSettings; onChange: (settings: AlertSettings) => void };

const profiles: Array<[Exclude<AlertSensitivity, "custom">, string]> = [
  ["high", "灵敏"], ["standard", "标准"], ["low", "宽松"]
];

export function AlertSettingsPanel({ settings, onChange }: Props) {
  const setNumeric = (key: "pointQualityWarning" | "registrationErrorWarningPx" | "pauseInvalidRatio", value: number) =>
    onChange(normalizeAlertSettings({ ...settings, sensitivity: "custom", [key]: value }));
  return <section className="alert-settings" data-testid="alert-settings">
    <div className="panel-title"><h3>预警敏感度</h3><span>{settings.sensitivity === "custom" ? "自定义" : profiles.find(([key]) => key === settings.sensitivity)?.[1]}</span></div>
    <div className="alert-profile-switch" role="group" aria-label="预警敏感度">
      {profiles.map(([value, label]) => <button key={value} type="button" aria-pressed={settings.sensitivity === value} className={settings.sensitivity === value ? "active" : ""} onClick={() => onChange(ALERT_PROFILES[value])}>{label}</button>)}
    </div>
    <label><span>点质量提示 <output>{Math.round(settings.pointQualityWarning * 100)}%</output></span><input aria-label="点质量提示阈值" type="range" min="10" max="80" step="5" value={Math.round(settings.pointQualityWarning * 100)} onChange={event => setNumeric("pointQualityWarning", Number(event.target.value) / 100)} /></label>
    <label><span>配准误差提示 <output>{settings.registrationErrorWarningPx.toFixed(1)} px</output></span><input aria-label="配准误差提示阈值" type="range" min="1" max="10" step="0.5" value={settings.registrationErrorWarningPx} onChange={event => setNumeric("registrationErrorWarningPx", Number(event.target.value))} /></label>
    <label><span>失锁自动暂停 <output>{Math.round(settings.pauseInvalidRatio * 100)}%</output></span><input aria-label="失锁自动暂停阈值" type="range" min="10" max="60" step="5" value={Math.round(settings.pauseInvalidRatio * 100)} onChange={event => setNumeric("pauseInvalidRatio", Number(event.target.value) / 100)} /></label>
    <p>仅调整软预警和自动暂停灵敏度，不改变坐标结果；身份冲突、候选歧义和几何硬错误始终拦截。</p>
  </section>;
}
