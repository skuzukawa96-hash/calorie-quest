import { useCallback, useEffect, useState } from "react";
import { api, runningInTauri } from "./lib/api";
import PlayModeSwitch from "./components/PlayModeSwitch";
import RecipeProvider from "./components/RecipeProvider";
import { playFanfare } from "./lib/sfx";
import { loadSpeechCapabilities } from "./lib/speech";
import Exam from "./screens/Exam";
import Home from "./screens/Home";
import Recipe from "./screens/Recipe";
import Snacks from "./screens/Snacks";
import Stats from "./screens/Stats";
import Study from "./screens/Study";
import type { Dashboard, ExamLevel, PlayMode, SessionMode, TierChoice } from "./types";

type Tab = "home" | "snacks" | "recipe" | "stats";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "home", label: "🏠 ホーム" },
  { id: "snacks", label: "🍰 お菓子図鑑" },
  { id: "recipe", label: "🧁 お菓子作りレシピ" },
  { id: "stats", label: "📈 記録" },
];

/** 試験: an exam of a level, or the review of exam questions missed */
type ExamSession = { kind: "exam"; level: ExamLevel } | { kind: "review" };

interface SessionConfig {
  mode: SessionMode;
  tier: TierChoice;
  /** genre name or "all" */
  category: string;
}

export default function App() {
  const [tab, setTab] = useState<Tab>("home");
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<SessionConfig | null>(null);
  const [exam, setExam] = useState<ExamSession | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const showToast = useCallback((msg: string, ms = 3000) => {
    setToast(msg);
    window.setTimeout(() => setToast((cur) => (cur === msg ? null : cur)), ms);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const d = await api.getDashboard();
      setDash(d);
      setError(null);
      // The first load after the date changes moves the earlier days' leftover into savings.
      const { justSaved, justIssued, balance, perTicket } = d.savings;
      if (justIssued > 0) {
        playFanfare();
        showToast(`🎟 貯蓄が ${perTicket.toLocaleString()} kcal に達しました！お菓子引換券を ${justIssued} 枚獲得`, 5000);
      } else if (justSaved > 0) {
        showToast(`🐷 前日の残り ${justSaved} kcal を貯蓄しました（${balance.toLocaleString()} / ${perTicket.toLocaleString()} kcal）`, 4000);
      }
    } catch (e) {
      setError(String(e));
    }
  }, [showToast]);

  // がんばり → 通常 → お気軽: what is earned from now on is scaled by it.
  const changePlayMode = useCallback(
    async (mode: PlayMode) => {
      try {
        await api.setPlayMode(mode);
        await refresh();
      } catch (e) {
        setError(String(e));
      }
    },
    [refresh],
  );

  useEffect(() => {
    void refresh();
    void loadSpeechCapabilities();
    if (import.meta.env.VITE_SPEECH_PROBE) {
      import("./lib/probe").then((m) => m.runSpeechProbe()).catch(() => undefined);
    }
  }, [refresh]);


  const go = (t: Tab) => {
    setSession(null);
    setExam(null);
    setTab(t);
    void refresh();
  };

  return (
    <RecipeProvider>
      <div className="app">
        <header className="topbar">
          <button className="brand" onClick={() => go("home")}>
            <span className="brand-icon">🍪</span>
            <span className="brand-name">Calorie Quest</span>
            <span className="brand-sub">Speak &amp; Snack</span>
          </button>
          <nav className="tabs">
            {TABS.map((t) => (
              <button key={t.id} className={tab === t.id && !session && !exam ? "active" : ""} onClick={() => go(t.id)}>
                {t.label}
              </button>
            ))}
          </nav>
          <div className="topbar-stats">
            {dash && (
              <>
                <PlayModeSwitch mode={dash.user.playMode} onChange={(m) => void changePlayMode(m)} />
                <span title="連続学習日数">🔥 {dash.user.currentStreak}日</span>
                {/* What is left to eat today (earned minus eaten) over what was earned. */}
                <span
                  title={`今日の残りカロリー / 獲得カロリー（消費 ${dash.today.kcalConsumed} kcal）`}
                >
                  🍩{" "}
                  <span className={dash.today.kcalEarned - dash.today.kcalConsumed < 0 ? "negative" : "positive"}>
                    {dash.today.kcalEarned - dash.today.kcalConsumed}
                  </span>
                  /{dash.today.kcalEarned}kcal
                </span>
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
          {exam && dash ? (
            <Exam
              kind={exam.kind}
              level={exam.kind === "exam" ? exam.level : undefined}
              overview={dash.exam}
              playMode={dash.user.playMode}
              onExit={() => go("home")}
              onProgress={() => void refresh()}
              toast={showToast}
            />
          ) : session && dash ? (
            <Study
              mode={session.mode}
              tier={session.tier}
              category={session.category}
              rates={dash.kcalRates}
              playMode={dash.user.playMode}
              onExit={() => go("home")}
              onProgress={() => void refresh()}
              toast={showToast}
            />
          ) : tab === "home" ? (
            dash ? (
              <Home
                dash={dash}
                onStart={(mode, tier, category) => setSession({ mode, tier, category })}
                onExam={(level) => setExam({ kind: "exam", level })}
                onExamReview={() => setExam({ kind: "review" })}
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
          ) : tab === "recipe" ? (
            <Recipe playMode={dash?.user.playMode ?? "normal"} onProgress={() => void refresh()} toast={showToast} />
          ) : (
            <Stats onChanged={() => void refresh()} toast={showToast} />
          )}
        </main>

        {toast && <div className="toast">{toast}</div>}
        {!runningInTauri && <div className="dev-note">ブラウザプレビュー（データはこのブラウザ内のモック）</div>}
      </div>
    </RecipeProvider>
  );
}
