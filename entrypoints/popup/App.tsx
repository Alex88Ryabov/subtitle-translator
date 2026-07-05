import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { settingsItem } from '@/lib/settings';
import type { DisplayMode, EngineId, Settings, TargetLang } from '@/lib/types';

export default function App() {
  const [settings, setSettings] = useState<Settings | null>(null);

  // Загружаем настройки при открытии popup и следим за внешними изменениями,
  // чтобы устаревший снапшот не затёр чужую запись.
  useEffect(() => {
    settingsItem
      .getValue()
      .then(setSettings)
      .catch((err) => console.error('[course-translator] failed to load settings:', err));
    const unwatch = settingsItem.watch((next) => {
      if (next) setSettings(next);
    });
    return unwatch;
  }, []);

  /** Оптимистичное обновление + сохранение (fire-and-forget). */
  function update(patch: Partial<Settings>) {
    setSettings((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...patch };
      settingsItem
        .setValue(next)
        .catch((err) => console.error('[course-translator] failed to save settings:', err));
      return next;
    });
  }

  if (!settings) {
    return <div className="app loading">Загрузка…</div>;
  }

  return (
    <div className="app">
      <header className="header">
        <h1 className="title">Subtitle Translator</h1>
        <label className="switch" title="Перевод включён">
          <input
            type="checkbox"
            checked={settings.enabled}
            onChange={(e) => update({ enabled: e.target.checked })}
          />
          <span className="slider" />
        </label>
      </header>
      <div className="master-label">Перевод включён</div>

      <section className="section">
        <h2 className="section-title">Язык перевода</h2>
        <select
          className="select"
          value={settings.targetLang}
          onChange={(e) => update({ targetLang: e.target.value as TargetLang })}
        >
          <option value="uk">Українська</option>
          <option value="ru">Русский</option>
        </select>
      </section>

      <section className="section">
        <h2 className="section-title">Режим отображения</h2>
        <label className="radio">
          <input
            type="radio"
            name="displayMode"
            value="dual"
            checked={settings.displayMode === 'dual'}
            onChange={() => update({ displayMode: 'dual' satisfies DisplayMode })}
          />
          <span>Двойные субтитры (оригинал + перевод)</span>
        </label>
        <label className="radio">
          <input
            type="radio"
            name="displayMode"
            value="translation-only"
            checked={settings.displayMode === 'translation-only'}
            onChange={() => update({ displayMode: 'translation-only' satisfies DisplayMode })}
          />
          <span>Только перевод</span>
        </label>
      </section>

      <section className="section">
        <h2 className="section-title">Движок перевода</h2>
        <label className="radio">
          <input
            type="radio"
            name="engine"
            value="google-free"
            checked={settings.engine === 'google-free'}
            onChange={() => update({ engine: 'google-free' satisfies EngineId })}
          />
          <span>Google Translate (бесплатно)</span>
        </label>
        <label className="radio">
          <input
            type="radio"
            name="engine"
            value="chrome-local"
            checked={settings.engine === 'chrome-local'}
            onChange={() => update({ engine: 'chrome-local' satisfies EngineId })}
          />
          <span>Локальный Chrome AI</span>
        </label>
        <div className="hint">Chrome 138+, модель загружается при первом использовании</div>
      </section>

      <section className="section">
        <h2 className="section-title">Размер шрифта</h2>
        <div className="range-row">
          <input
            type="range"
            min={14}
            max={32}
            step={1}
            value={settings.fontSizePx}
            onChange={(e) => update({ fontSizePx: Number(e.target.value) })}
          />
          <span className="range-value">{settings.fontSizePx}px</span>
        </div>
      </section>

      <footer className="footer">Alex Apps · v{browser.runtime.getManifest().version}</footer>
    </div>
  );
}
