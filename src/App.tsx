import { useCallback, useEffect, useRef, useState } from "react";
import { api, runningInTauri } from "./lib/api";
import { loadDictionary } from "./lib/dictionary";
import { preloadScreens } from "./lib/screenCache";
import DietSwitch from "./components/DietSwitch";
import PlayModeSwitch from "./components/PlayModeSwitch";
import { preloadWordTags } from "./components/PosTags";
import RecipeProvider from "./components/RecipeProvider";
import { playFanfare, warmUpAudio } from "./lib/sfx";
import { loadSpeechCapabilities } from "./lib/speech";
import { touchScreen } from "./lib/touch";
import Exam from "./screens/Exam";
import Favorites from "./screens/Favorites";
import Home from "./screens/Home";
import LexiLink, { type LexiConfig } from "./screens/LexiLink";
import Recipe from "./screens/Recipe";
import Snacks from "./screens/Snacks";
import Stats from "./screens/Stats";
import Study from "./screens/Study";
import { PLAY_MODE_INFO, remainingKcal, type Dashboard, type ExamLevel, type PlayMode, type SessionMode, type TierChoice } from "./types";

type Tab = "home" | "snacks" | "favorites" | "recipe" | "stats";

/** `short`: the name under the icon in a phone's bottom tab bar */
const TABS: Array<{ id: Tab; icon: string; label: string; short: string }> = [
  { id: "home", icon: "🏠", label: "ホーム", short: "ホーム" },
  { id: "snacks", icon: "🍰", label: "お菓子図鑑", short: "図鑑" },
  { id: "favorites", icon: "⭐", label: "お気に入り", short: "お気に入り" },
  { id: "recipe", icon: "📖", label: "レシピ", short: "レシピ" },
  { id: "stats", icon: "📈", label: "記録", short: "記録" },
];

/** Today in the computer's own time, as the backend dates days (util::today). */
function localDay(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

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
  /** LexiLink（英単語の神経衰弱）, started from home */
  const [lexi, setLexi] = useState<LexiConfig | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // お菓子引換券: clicking the badge shows a 引換券 button on each goal (home) and each snack of the
  // 図鑑, and clicking it again hides them. The buttons go away with the last ticket.
  const [ticketMode, setTicketMode] = useState(false);
  const snackTickets = dash?.savings.snackTickets ?? 0;
  useEffect(() => {
    if (snackTickets === 0) setTicketMode(false);
  }, [snackTickets]);

  const showToast = useCallback((msg: string, ms = 3000) => {
    setToast(msg);
    window.setTimeout(() => setToast((cur) => (cur === msg ? null : cur)), ms);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const d = await api.getDashboard();
      setDash(d);
      setError(null);
      // The first load after the date changes moves the earlier days' leftover into savings, and
      // what an over-eaten day ended below zero into today.
      const { justSaved, justIssued, justCarried, balance, perTicket } = d.savings;
      const carried = justCarried < 0 ? `前日までに食べすぎた ${-justCarried} kcal を今日に持ち越しました` : "";
      if (justIssued > 0) {
        playFanfare();
        showToast(`🎟 貯蓄が ${perTicket.toLocaleString()} kcal に達しました！お菓子引換券を ${justIssued} 枚獲得`, 5000);
      } else if (justSaved > 0) {
        showToast(
          `🐷 前日の残り ${justSaved} kcal を貯蓄しました（${balance.toLocaleString()} / ${perTicket.toLocaleString()} kcal）${carried ? `。${carried}` : ""}`,
          4000,
        );
      } else if (carried) {
        showToast(`🍩 ${carried}`, 4000);
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
        // No hover to explain the modes on a phone: what was switched to, said once.
        if (touchScreen) showToast(`${PLAY_MODE_INFO[mode].label}モード: ${PLAY_MODE_INFO[mode].desc}`);
      } catch (e) {
        setError(String(e));
      }
    },
    [refresh, showToast],
  );

  // ダイエット機能: on, the 課題一覧, the 課題 goals and the weight chart come out.
  const changeDietMode = useCallback(
    async (on: boolean) => {
      try {
        await api.setDietMode(on);
        await refresh();
        showToast(
          on
            ? "💪 ダイエット機能をONにしました（お菓子図鑑に課題一覧、ホームの目標に課題、記録に体重・BMIのグラフが出ます）"
            : "ダイエット機能をOFFにしました（課題と体重の記録は残っています）",
          4000,
        );
      } catch (e) {
        setError(String(e));
      }
    },
    [refresh, showToast],
  );

  useEffect(() => {
    void refresh();
    void loadSpeechCapabilities();
    // What the other tabs open with, loaded ahead once the home screen is up (and the notes' tables
    // are built behind it), so that switching to them never blinks 読み込み中; and the sound device
    // opened, so the first sound neither holds the page up nor comes late.
    const ahead = window.setTimeout(() => {
      void loadDictionary();
      preloadWordTags();
      preloadScreens();
      warmUpAudio();
    }, 1500);
    if (import.meta.env.VITE_SPEECH_PROBE) {
      import("./lib/probe").then((m) => m.runSpeechProbe()).catch(() => undefined);
    }
    return () => window.clearTimeout(ahead);
  }, [refresh]);

  // The app left open past midnight loads the new day (which settles the one that ended): checked
  // every minute and whenever the window comes back to the front.
  const day = useRef(localDay());
  useEffect(() => {
    const check = () => {
      const now = localDay();
      if (now === day.current) return;
      day.current = now;
      void refresh();
    };
    const timer = window.setInterval(check, 60_000);
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [refresh]);

  const go = useCallback(
    (t: Tab) => {
      setSession(null);
      setExam(null);
      setLexi(null);
      setTab(t);
      void refresh();
    },
    [refresh],
  );

  // Android's back button (and back gesture) goes to ホーム, and from ホーム closes the app: away
  // from it the page holds one history entry of its own, for the back to take. Coming home another
  // way (← やめる, the ホーム tab) gives the entry up by going back, which lands a moment later:
  // `leaving` says it is on its way, and its popstate settles the entry for wherever the learner
  // is by then (a tab tapped meanwhile holds a new one).
  const away = tab !== "home" || session !== null || exam !== null || lexi !== null;
  const awayNow = useRef(away);
  awayNow.current = away;
  const leaving = useRef(false);
  const held = () => (history.state as { away?: boolean } | null)?.away === true;
  useEffect(() => {
    // A reload keeps the entry while the app starts again at ホーム: given up where it is, since
    // going back to it would load the page once more.
    if (!awayNow.current && held()) history.replaceState(null, "");
  }, []);
  useEffect(() => {
    if (leaving.current) return;
    if (away && !held()) history.pushState({ away: true }, "");
    else if (!away && held()) {
      leaving.current = true;
      history.back();
    }
  }, [away]);
  useEffect(() => {
    const back = () => {
      if (leaving.current) {
        leaving.current = false;
        if (awayNow.current) history.pushState({ away: true }, "");
        return;
      }
      if (awayNow.current) go("home");
    };
    window.addEventListener("popstate", back);
    return () => window.removeEventListener("popstate", back);
  }, [go]);

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
              <button key={t.id} className={tab === t.id && !session && !exam && !lexi ? "active" : ""} onClick={() => go(t.id)}>
                {t.icon} {t.label}
              </button>
            ))}
          </nav>
          <div className="topbar-stats">
            {dash && (
              <>
                <DietSwitch on={dash.user.dietMode} onChange={(on) => void changeDietMode(on)} />
                <PlayModeSwitch mode={dash.user.playMode} onChange={(m) => void changePlayMode(m)} />
                <span title="連続学習日数">🔥 {dash.user.currentStreak}日</span>
                {/* What is left to eat today (earned minus eaten) over what was earned. */}
                <span
                  title={`今日の残りカロリー / 獲得カロリー（消費 ${dash.today.kcalConsumed} kcal${
                    dash.today.carriedKcal < 0 ? `、前日からの持ち越し ${dash.today.carriedKcal} kcal` : ""
                  }）`}
                >
                  🍩{" "}
                  <span className={remainingKcal(dash.today) < 0 ? "negative" : "positive"}>{remainingKcal(dash.today)}</span>
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
          {lexi ? (
            <LexiLink key={JSON.stringify(lexi)} config={lexi} onExit={() => go("home")} onProgress={() => void refresh()} toast={showToast} />
          ) : exam && dash ? (
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
                onLexiLink={setLexi}
                onChanged={() => void refresh()}
                goToSnacks={() => go("snacks")}
                ticketMode={ticketMode}
                onTicketMode={setTicketMode}
                toast={showToast}
              />
            ) : (
              <div className="screen">
                <div className="card loading">読み込み中…</div>
              </div>
            )
          ) : tab === "snacks" ? (
            dash ? (
              <Snacks
                dash={dash}
                onChanged={() => void refresh()}
                ticketMode={ticketMode}
                onTicketMode={setTicketMode}
                toast={showToast}
              />
            ) : null
          ) : tab === "recipe" ? (
            <Recipe playMode={dash?.user.playMode ?? "normal"} onProgress={() => void refresh()} toast={showToast} />
          ) : tab === "favorites" ? (
            dash ? (
              <Favorites
                rates={dash.kcalRates}
                overview={dash.exam}
                playMode={dash.user.playMode}
                onProgress={() => void refresh()}
                toast={showToast}
              />
            ) : null
          ) : (
            <Stats day={dash?.today.date} dietMode={dash?.user.dietMode ?? false} onChanged={() => void refresh()} toast={showToast} />
          )}
        </main>

        {/* A phone has the tabs at the bottom, under the thumb, instead of in the top bar. */}
        <nav className="bottom-tabs">
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id && !session && !exam && !lexi ? "active" : ""} onClick={() => go(t.id)}>
              <span className="bottom-tab-icon">{t.icon}</span>
              <span className="bottom-tab-label">{t.short}</span>
            </button>
          ))}
        </nav>

        {toast && <div className="toast">{toast}</div>}
        {!runningInTauri && <div className="dev-note">ブラウザプレビュー（データはこのブラウザ内のモック）</div>}
      </div>
    </RecipeProvider>
  );
}
