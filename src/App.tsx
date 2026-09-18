import { useCallback, useEffect, useState } from "react";
import { api, runningInTauri } from "./lib/api";
import { loadSpeechCapabilities } from "./lib/speech";
import Home from "./screens/Home";
import Snacks from "./screens/Snacks";
import Stats from "./screens/Stats";
import Study from "./screens/Study";
import type { Dashboard, Difficulty, Mode } from "./types";

type Tab = "home" | "snacks" | "stats";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "home", label: "🏠 ホーム" },
  { id: "snacks", label: "🍰 お菓子図鑑" },
  { id: "stats", label: "📈 記録" },
];

interface SessionConfig {
  mode: Mode;
  difficulty: Difficulty;
  /** genre name or "all" */
  category: string;
}

export default function App() {
  const [tab, setTab] = useState<Tab>("home");
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<SessionConfig | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setDash(await api.getDashboard());
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    void loadSpeechCapabilities();
    if (import.meta.env.VITE_SPEECH_PROBE) {
      import("./lib/probe").then((m) => m.runSpeechProbe()).catch(() => undefined);
    }
  }, [refresh]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((cur) => (cur === msg ? null : cur)), 3000);
  }, []);

  const go = (t: Tab) => {
    setSession(null);
    setTab(t);
    void refresh();
  };

  return (
    <div className="app">
      <header className="topbar">
        <button className="brand" onClick={() => go("home")}>
          <span className="brand-icon">🍪</span>
          <span className="brand-name">Calorie Quest</span>
          <span className="brand-sub">Speak &amp; Snack</span>
        </button>
        <nav className="tabs">
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id && !session ? "active" : ""} onClick={() => go(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
        <div className="topbar-stats">
          {dash && (
            <>
              <span title="連続学習日数">🔥 {dash.user.currentStreak}日</span>
              <span title="今日の獲得カロリー">🍩 {dash.today.kcalEarned} kcal</span>
            </>
          )}
        </div>
      </header>

      <main>
        {error && (
          <div className="notice warn">
            バックエンドに接続できません: {error}
            <button className="btn-link" onClick={() => void refresh()}>
              再試行
            </button>
          </div>
        )}
        {session && dash ? (
          <Study
            mode={session.mode}
            difficulty={session.difficulty}
            category={session.category}
            rates={dash.kcalRates}
            onExit={() => go("home")}
            onProgress={() => void refresh()}
            toast={showToast}
          />
        ) : tab === "home" ? (
          dash ? (
            <Home
              dash={dash}
              onStart={(mode, difficulty, category) => setSession({ mode, difficulty, category })}
              onChanged={() => void refresh()}
              goToSnacks={() => go("snacks")}
              toast={showToast}
            />
          ) : (
            <div className="screen">
              <div className="card loading">読み込み中…</div>
            </div>
          )
        ) : tab === "snacks" ? (
          dash ? (
            <Snacks dash={dash} onChanged={() => void refresh()} toast={showToast} />
          ) : null
        ) : (
          <Stats onChanged={() => void refresh()} toast={showToast} />
        )}
      </main>

      {toast && <div className="toast">{toast}</div>}
      {!runningInTauri && <div className="dev-note">ブラウザプレビュー（データはこのブラウザ内のモック）</div>}
    </div>
  );
}
