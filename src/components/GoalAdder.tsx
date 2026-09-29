import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { api } from "../lib/api";
import { SNACK_ICONS } from "../lib/snackIcons";
import type { Snack } from "../types";

interface Props {
  /** the whole snack book, searched as the name is typed */
  snacks: Snack[];
  goalIds: Set<number>;
  /** called after a goal was added, so the home screen reloads */
  onAdded: () => void;
  onClose: () => void;
  toast: (msg: string) => void;
}

const MAX_SUGGESTIONS = 8;

/**
 * Folds what is compared so "ぽっぷ", "ﾎﾟｯﾌﾟ" and "ポップ" all find ポップコーン: NFKC for
 * half-width kana and letters, hiragana turned into katakana, case ignored.
 */
function fold(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
}

/** Snacks whose name contains the typed text anywhere ("コーン" finds ポップコーン), best first. */
function suggest(snacks: Snack[], typed: string): Snack[] {
  const q = fold(typed.trim());
  if (!q) return [];
  return snacks
    .map((s) => ({ s, at: fold(s.name).indexOf(q) }))
    .filter((x) => x.at >= 0)
    .sort((a, b) => a.at - b.at || a.s.name.length - b.s.name.length || a.s.calories - b.s.calories)
    .slice(0, MAX_SUGGESTIONS)
    .map((x) => x.s);
}

/** The name with the typed part in bold, when folding kept the name's length (it nearly always does). */
function marked(name: string, typed: string): ReactNode {
  const q = fold(typed.trim());
  const f = fold(name);
  const at = f.indexOf(q);
  if (!q || at < 0 || f.length !== name.length) return name;
  return (
    <>
      {name.slice(0, at)}
      <b>{name.slice(at, at + q.length)}</b>
      {name.slice(at + q.length)}
    </>
  );
}

/**
 * ＋ 目標追加: one line of 名前 / カロリー / アイコン / 追加. Typing a name lists the snacks of the book
 * that contain it, like a browser's search history; picking one fills in its name, kcal and icon
 * and 追加 makes it a goal. A snack the book does not have is registered in the book and made a
 * goal in one go.
 */
export default function GoalAdder({ snacks, goalIds, onAdded, onClose, toast }: Props) {
  const [name, setName] = useState("");
  const [calories, setCalories] = useState("");
  const [icon, setIcon] = useState("🍰");
  const [listOpen, setListOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [iconsOpen, setIconsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const iconBox = useRef<HTMLDivElement>(null);

  useEffect(() => nameInput.current?.focus(), []);

  // The icon grid closes when anything else is clicked.
  useEffect(() => {
    if (!iconsOpen) return;
    const away = (e: MouseEvent) => {
      if (!iconBox.current?.contains(e.target as Node)) setIconsOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [iconsOpen]);

  const suggestions = useMemo(() => suggest(snacks, name), [snacks, name]);
  const showList = listOpen && suggestions.length > 0;

  // A name the book already has is that snack, whether it was picked from the list or typed out;
  // the same name with other kcal or icon would only make a confusing twin, so it is refused.
  const kcal = Number(calories);
  const sameName = snacks.find((s) => s.name === name.trim());
  const existing = sameName && sameName.calories === kcal && sameName.icon === icon ? sameName : null;
  const clash = sameName && !existing ? sameName : null;
  const alreadyGoal = existing ? goalIds.has(existing.id) : false;
  const valid = name.trim() !== "" && Number.isInteger(kcal) && kcal >= 1 && kcal <= 5000 && !clash && !alreadyGoal;

  const pick = (s: Snack) => {
    setName(s.name);
    setCalories(String(s.calories));
    setIcon(s.icon);
    setListOpen(false);
    setActive(-1);
  };

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      if (existing) {
        await api.setGoalSnack(existing.id, true);
        toast(`${existing.icon} ${existing.name} を目標に追加しました`);
      } else {
        const s = await api.addSnack(name.trim(), kcal, icon);
        await api.setGoalSnack(s.id, true);
        toast(`${s.icon} ${s.name}（${s.calories} kcal）を図鑑に登録して、目標に追加しました`);
      }
      onAdded();
      onClose();
    } catch (e) {
      toast(String(e));
    } finally {
      setBusy(false);
    }
  };

  const onNameKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" && suggestions.length > 0) {
      e.preventDefault();
      setListOpen(true);
      setActive((i) => (i + 1) % suggestions.length);
    } else if (e.key === "ArrowUp" && suggestions.length > 0) {
      e.preventDefault();
      setListOpen(true);
      setActive((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
    } else if (e.key === "Enter" && showList && active >= 0) {
      e.preventDefault();
      pick(suggestions[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (showList) setListOpen(false);
      else onClose();
    }
  };

  const note = clash
    ? `図鑑に同じ名前の「${clash.icon} ${clash.name}」（${clash.calories} kcal）があります。候補から選ぶか、名前を変えてください`
    : alreadyGoal
      ? "このお菓子はもう目標に入っています"
      : existing
        ? "図鑑のお菓子を目標に追加します"
        : name.trim()
          ? "図鑑にないお菓子は、図鑑にも登録されます"
          : "";

  return (
    <form
      className="goal-adder"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="goal-adder-row">
        <div className="goal-adder-name">
          <input
            ref={nameInput}
            className="goal-adder-input"
            value={name}
            placeholder="名前"
            maxLength={40}
            role="combobox"
            aria-label="お菓子の名前"
            aria-expanded={showList}
            aria-controls="goal-suggest"
            aria-autocomplete="list"
            onChange={(e) => {
              setName(e.target.value);
              setListOpen(true);
              setActive(-1);
            }}
            onFocus={() => setListOpen(true)}
            onBlur={() => setListOpen(false)}
            onKeyDown={onNameKey}
          />
          {showList && (
            <ul className="goal-suggest" id="goal-suggest" role="listbox" aria-label="図鑑のお菓子">
              {suggestions.map((s, i) => (
                <li
                  key={s.id}
                  role="option"
                  aria-selected={i === active}
                  className={i === active ? "active" : ""}
                  // Keep the focus in the name field, so the list does not close before the click lands.
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(s)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    pick(s);
                  }}
                >
                  <span className="goal-suggest-icon">{s.icon}</span>
                  <span className="goal-suggest-name">{marked(s.name, name)}</span>
                  {goalIds.has(s.id) && <span className="goal-suggest-goal">★ 目標中</span>}
                  <span className="goal-suggest-kcal">{s.calories} kcal</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <label className="goal-adder-kcal">
          <input
            className="goal-adder-input"
            type="number"
            inputMode="numeric"
            min={1}
            max={5000}
            value={calories}
            placeholder="カロリー"
            aria-label="カロリー"
            onChange={(e) => setCalories(e.target.value)}
          />
          <span>kcal</span>
        </label>
        <div className="goal-adder-icon" ref={iconBox}>
          <button
            type="button"
            className="goal-adder-icon-btn"
            aria-label={`アイコン（${icon}）を選ぶ`}
            aria-expanded={iconsOpen}
            onClick={() => setIconsOpen((o) => !o)}
          >
            {icon}
            <span className="goal-adder-caret">▾</span>
          </button>
          {iconsOpen && (
            <div className="goal-icon-grid" role="listbox" aria-label="アイコン">
              {SNACK_ICONS.map((i) => (
                <button
                  type="button"
                  key={i}
                  role="option"
                  aria-selected={i === icon}
                  className={i === icon ? "active" : ""}
                  onClick={() => {
                    setIcon(i);
                    setIconsOpen(false);
                  }}
                >
                  {i}
                </button>
              ))}
            </div>
          )}
        </div>
        <button type="submit" className="btn btn-primary goal-adder-submit" disabled={busy || !valid}>
          追加
        </button>
      </div>
      {note && <div className={"goal-adder-note" + (clash || alreadyGoal ? " warn" : "")}>{note}</div>}
    </form>
  );
}
