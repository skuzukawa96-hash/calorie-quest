# Calorie Quest: Speak & Snack

英語の問題を解くと「今日食べていいお菓子のカロリー」が貯まる Windows デスクトップの学習ゲーム。
仕様は `docs/spec.md`。ユーザーとのやり取りは日本語で行う。

## スタック

- Tauri 2 + Rust（`src-tauri/`）: SQLite（rusqlite bundled）、ゲームロジック、ネイティブ音声
- React 19 + TypeScript + Vite 6（`src/`）: UI。ブラウザ単体では `src/lib/mockBackend.ts` が Rust の代わりになる
- 音声: Tauri 内では Windows 標準機能を Rust から使う（`src-tauri/src/speech.rs`）。**WebView2 は Web Speech API の音声認識に非対応**（`network` エラー）なので、フロントで `SpeechRecognition` を使おうとしないこと

## コマンド

```powershell
npm run tauri dev          # 開発起動（.\dev.cmd でも可）
npm run build              # tsc --noEmit + vite build
cd src-tauri; cargo test   # Rust ユニットテスト（ルール・SRS・ストリーク・出題）
npm run tauri build        # 配布ビルド
```

- `VITE_SPEECH_PROBE=1` を付けて起動すると、起動時に音声機能の診断をターミナルへ出力し `window.__cq` を公開する
- 実機を自動操作したいときは `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` で起動し、CDP（Node の WebSocket）で `Runtime.evaluate` / `Page.captureScreenshot` を叩く

## 構成と責務

| 場所 | 役割 |
| --- | --- |
| `src-tauri/src/srs.rs` | kcal 換算（低2/中4/高10、発音はスコア按分）、復習倍率 1.5、ヒント開示1語ごとに半減、SRS 間隔 [1,3,7,14,30] 日 |
| `src-tauri/src/commands.rs` | Tauri コマンド。コアロジックは `session_questions` / `record_answer` / `redeem_ticket` に分離され、`Connection` だけでテストできる |
| `src-tauri/src/db.rs` | スキーマ、`ensure_column` によるマイグレーション、`questions.json` / お菓子の初期投入 |
| `src-tauri/src/speech.rs` | SAPI5 で英語 TTS → WAV（フロントで再生）、WinRT `SpeechRecognizer` のリスト文法で発音判定 |
| `src-tauri/data/*.json` | 問題データ（20,167問・20ジャンル・442意味グループ）、`glossary.json`（補助語彙5,379語）、`grammar-notes.json`（文法解説82件）。`questions.json` が `version` を持ち、追加パック（`words-2a.json` など120ファイル）は `build.rs` と `mockBackend.ts` の `import.meta.glob` が**このディレクトリから自動で拾う**（`questions.json` / `glossary.json` / `grammar-notes.json` は除外）。`version` を上げると起動時に key 単位で upsert される |
| `src/lib/speech.ts` | TTS/STT の切り替え（Tauri=native、ブラウザ=web）、`INSTALL_STT_GUIDE` |
| `src/lib/scoring.ts` | 一致度・流暢さ・発音のコツ検出（`detectTrickySounds`） |
| `src/lib/dictionary.ts` | 単語ポップアップの辞書引き。`tokenize` / `lemmas` は `util.rs` の同名関数と、`buildPhraseIndex` / `phraseSpans` は `util.rs` の `PhraseIndex` と挙動を合わせる |
| `src/components/GlossedText.tsx` | 英文の各単語にホバーで意味を出し、クリックでその単語を読み上げる（読み上げは「単語の意味」トグルとは独立で、辞書にない語でも鳴る）。熟語・慣用句の範囲は一続きの実線で示し、熟語の意味と語自体の意味を2行で出す。選択問題の回答前は `withhold` で正解と同じ訳を伏せる |
| `src/screens/` | Home（ジャンル・難易度選択）、Study（4モード＋回答後の自動読み上げ＋単語の意味）、Snacks、Stats |

## データの約束

- 問題の `key` は不変（`w###` 単語 / `p###` フレーズ / `g###` 文法 / `i###` 慣用句 / `s###` 長文 / `d###` 会話）。学習履歴は id 経由で key に紐づくので、既存 key の意味を変えない。新規は末尾に追加
- 必須フィールド: `kind` / `difficulty`（low|mid|high）/ `category`（ジャンル名。アイコンは `src/types.ts` の `CATEGORY_ICON`）/ `group`（意味グループ）/ `en` / `ja` / `modes`
- 文法問題は `prompt`（`___` が空欄）と `choices`（正解 `en` を含む4つ）を持ち、`modes` は `["choice"]`。`en` は選択肢と**大文字小文字まで一致**させること（文頭に来る語は "The" のように書く）
- 文法問題は `point`（`present-perfect` / `relative-pronoun` など82種）も必須。解説文そのものは問題に書かず、`grammar-notes.json` に**ポイントごとに1件だけ**置く（同じ論点が何十問も出るため）。回答後に `commands.rs` の `grammar_note_for` が引いて表示する。`cargo test` が「解説のないポイント」と「どの問題も使っていない解説」の両方を検査する
- 会話問題（`kind: "dialogue"`）は `prompt`（聞こえる英語）・`en`（正しい応答）・`choices`（応答4つ）・`ja`（promptの訳）を持ち、`modes` は `["listening"]`
- ただし会話の誤答は出題時に `english_distractors` が**同ジャンルの他の会話の `en` から引く**ので、`choices` はジャンルが小さくて3つ揃わないときのフォールバックにしか使われない。データに書く誤答を一定のテンプレート（「He plays chess.」など）で埋めると、聞かなくても浮いている選択肢が正解だと分かってしまうため、フォールバック用でも実在の応答文にすること
- **4択の誤答は同じ `group` の `ja` から自動生成される**。だから**単語問題では**グループ内で `ja` が重複してはいけないし、1グループに4問以上必要（`cargo test` が両方検査する）。ジャンルより細かい単位（果物・乗り物・感情…）にすること
- 単語以外は `ja` が重複しても良い（同義の慣用句など）。記入問題は `accepted_answers` が同じ `ja` を持つ同グループの `en` をすべて正解として返すので、学習者がどちらの表現を書いても正解になる
- 日本語は単数・複数を書き分けないので、記入問題でどちらかを強制できない。`accepted_answers` は `util.rs` の `number_variants` で**もう一方の数の言い方も正解に加える**（`mockBackend.ts` に同じ規則の写しがある。両方直すこと）。共通の条件は「two-way な限定詞（the/his/my…）の直後」「後ろが前置詞・限定詞・副詞・分詞・文末、または知覚動詞の後の原形（"watched the lizard(s) bask"）」「`all the` / `one of the` のように数を強制する語が手前にない」。慣用句（`kind: "idiom"`）は語順が固定なので対象外
  - 複数→単数は `ALWAYS_PLURAL`（glasses, scissors, hands…）を除外する。**メガネを単数で答えたら不正解のまま**
  - 単数→複数は、その語が可算名詞だという**データ上の根拠**が要る（`db::is_countable_noun`）。根拠は「問題集のどこかで a/an/one/each/every の主要語になっている」か「その複数形が問題集で使われている」のいずれか。`information` / `paperwork` を複数形にする誤りは日本人学習者の典型なので、**通さない**
- それでも届かない文（"fed the horses fresh hay" のように名詞の後ろが形容詞）は、**日本語側に「馬たち」のように複数を書く**。ただし総称の文（「サメが人間を襲う」）に「たち」を付けると日本語が壊れるので、特定の群れを指す文だけ
- ヒアリングは `modes` に `listening` か `speaking` を含む問題が対象。単語・フレーズ・慣用句・長文は「聞いて意味を選ぶ」、会話は「聞いて英語で応答を選ぶ」
- 慣用句（`kind: "idiom"`）は `example`（その慣用句を使った英文）と `exampleJa`（訳）が必須。テストが例文中に慣用句の主要語が出ているかまで検査する
- **辞書の熟語**: 複数語の単語問題（"doggy bag"）と慣用句は、`db::dictionary` が英文まるごとをキーに入れる。**構成語に熟語の意味を配ってはいけない**（"doggy" が 持ち帰り用の袋 になる。`phrase_meanings_stay_with_the_phrase` が検査する）。構成語の意味は `glossary.json` に語単体で書く。慣用句は辞書形（"keep your fingers crossed"）で書けば、文中の活用（kept）と代名詞（my / him）は `PhraseIndex` が吸収する
- 英文に出てくる単語はすべて辞書に載っている必要がある（単語問題 or `glossary.json`、または文中で熟語の一部として検出される）。`dictionary_covers_words_used_in_sentences` が未収録語を列挙する。不規則動詞は `util.rs` の `IRREGULAR` と `dictionary.ts` の同名テーブルで解決する（両方を更新すること）
- 新しいデータファイルは `src-tauri/data/` に置くだけでよい（`build.rs` が Rust 側の一覧を生成し、`mockBackend.ts` は `import.meta.glob` で拾う）。登録漏れで片方のプラットフォームだけ問題数が変わる事故を防ぐため、手書きの一覧は持たない。問題以外のデータファイルを足すときは `build.rs` の `is_pack` と `mockBackend.ts` の除外リストの両方に名前を足すこと
- スキーマ変更は `SCHEMA` に列を足すだけでなく `ensure_column` で既存 DB にも追加する（`group` は SQL 予約語なので列名は `word_group`）

## 検証の流儀

- Rust を触ったら `cargo test`、TS を触ったら `npx tsc --noEmit`。両方通してからコミット
- UI の見た目はブラウザプレビュー（`npm run dev`、モックデータ）か CDP 経由の実機スクリーンショットで確認する
- 発音判定の実機確認には Windows の英語音声認識パック（設定 → 言語 → English (United States) → 音声認識）が必要。無い環境では自己採点にフォールバックする設計。このPCには導入済みで、`cargo test native_english -- --ignored --nocapture` で確認できる

## 環境の注意（このPC）

- ユーザーのシェルは Windows PowerShell 5.1: `&&` は使えない。`;` か複数行で案内する
- `npm` は `npm.ps1` が優先されるため実行ポリシーが Restricted だと動かない。`RemoteSigned`（CurrentUser）にするか `npm.cmd` を使う
- Claude デスクトップアプリは MSIX パッケージで、そこから起動したシェルの AppData / HKCU 書き込みは仮想化される。ツール類のインストールや PATH 変更はユーザー自身のターミナルで行ってもらう
