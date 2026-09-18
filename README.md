# Calorie Quest: Speak & Snack

英語の問題を解くと「今日食べていいお菓子のカロリー」が貯まる、軽量な英語学習ゲームです。
仕様は [docs/spec.md](docs/spec.md) を参照してください。

- バックエンド / コアロジック: **Rust**（Tauri 2, rusqlite）
- フロントエンド: **React + TypeScript**（Vite）
- 音声: Windows 標準の音声機能を Rust から利用（SAPI5 読み上げ、WinRT `SpeechRecognizer`）。モデルは同梱しません。
  ブラウザプレビュー時は Web Speech API を使います。
- データ: **SQLite**（`%APPDATA%\com.calorie-quest.app\calorie_quest.db`）

> **発音判定について**: Tauri が使う WebView2 は Web Speech API の音声認識に対応していない（`network` エラーになる）ため、
> 発音判定は Windows 内蔵の音声認識で行います。**英語（米国）の音声認識パック**が必要です:
> 設定 → 時刻と言語 → 言語と地域 → English (United States) を追加 → 言語のオプション → 「音声認識」をインストール。
> 未導入の環境では、アプリ内に手順を表示し、自己採点にフォールバックします。

## 必要なもの

- Rust（stable, MSVC ツールチェーン）と Visual Studio Build Tools（C++）
- Node.js 20 以上
- WebView2 ランタイム（Windows 11 には標準で入っています）

## 開発

```bash
npm install
npm run tauri dev
```

PowerShell からは `.\dev.cmd` でも起動できます（初回は `npm install` も実行）。
Node.js が未導入なら `winget install OpenJS.NodeJS.LTS` で入れてから、新しいターミナルを開いてください。

ブラウザだけでUIを確認したいときは `npm run dev` で http://localhost:1420 を開きます。
このときはRustの代わりにブラウザ内のモックバックエンド（`src/lib/mockBackend.ts`）が動きます。

## ビルド

```bash
npm run tauri build
```

`src-tauri/target/release/` に実行ファイル、`bundle/` にインストーラーが生成されます。

## テスト

```bash
cd src-tauri && cargo test
```

音声機能の診断ログを出したいときは、環境変数 `VITE_SPEECH_PROBE=1` を付けて `npm run tauri dev` を実行すると、
起動時に TTS / 音声認識の対応状況がターミナルに出力されます。

## ルール（仕様より）

| 難易度 | 内容 | 1問正解あたり | 10問正解 |
| --- | --- | --- | --- |
| 低 | 英単語 | 5 kcal | 50 kcal（クッキー1枚） |
| 中 | フレーズ・文法 | 10 kcal | 100 kcal（チョコ数かけ） |
| 高 | 慣用句・長文 | 25 kcal | 250 kcal（アイス1個） |

- 発音問題は音声認識スコア（0〜100）に応じて按分。60点以上で正解、70点未満は復習に回ります。
- 復習（忘却曲線: 翌日 → 3日後 → 1週間後 → 2週間後 → 1か月後）で正解すると **×1.5**。
- 7日連続学習ごとに **チートデイチケット（+300 kcal）** を発行。
- 選択・記入問題は回答後に英語を自動で読み上げます（学習画面の「自動読み上げ」で切り替え）。

## 問題データ

`src-tauri/data/questions.json` に約340問。難易度（低・中・高）とジャンルで絞り込めます。

| ジャンル | 内容 |
| --- | --- |
| 食べ物 / 日常生活 / 旅行・交通 / 買い物 / 学校・仕事 / 自然・天気 / からだ・健康 / 気持ち・性格 / 時間・数 | 英単語（低）、フレーズ（中）、長文（高） |
| 文法 | 穴埋め4択（中） |
| 慣用句 | イディオム（高） |

追記するときは末尾に新しい `key` で追加し、先頭の `version` を 1 つ上げると次回起動時に取り込まれます。

## 構成

```
src/                 React フロントエンド
  lib/speech.ts      TTS / 音声認識（Tauri ではネイティブ、ブラウザでは Web Speech API）
  lib/scoring.ts     一致度・流暢さのスコア計算、発音のコツ検出
  lib/mockBackend.ts ブラウザプレビュー用のインメモリ実装
  components/        カロリーバー、口の形の図解（SVG）、発音のコツ
  screens/           ホーム / 学習 / お菓子図鑑 / 記録
src-tauri/
  src/db.rs          SQLite スキーマと初期データ投入
  src/srs.rs         カロリー換算と復習スケジュール
  src/commands.rs    フロントから呼ぶコマンド（ユニットテスト付き）
  src/speech.rs      SAPI5 読み上げ / WinRT 音声認識
  data/questions.json 問題データ（key で管理、追記可能）
```
