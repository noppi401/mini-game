# ミニゲーム集(タンクバトル × スロットカー)

ブラウザで動作する、最大4人参加のパーティーミニゲーム集。
Node.js製サーバーをローカルで起動し、ngrokで外部公開してURLを共有する想定です。

## 現在の進捗

- [x] server/game1.js — ミニゲーム1(タンク×ボンバーマン)のサーバーロジック
- [x] server/game2.js — ミニゲーム2(スロットカー)のサーバーロジック
- [x] server/index.js — ロビー管理・WebSocket・進行管理
- [x] public/index.html, public/css/style.css — 画面の土台
- [ ] public/js/main.js — クライアント側の描画・入力処理(未着手・続きから実装が必要)

## セットアップ

```bash
npm install
npm start
```

http://localhost:3000 が起動します。外部共有する場合:

```bash
ngrok http 3000
```

発行されたURLを参加者に共有してください。

## 続きの実装(Claude Codeでの再開用メモ)

`public/js/main.js` に以下を実装する必要があります:

1. WebSocket接続(`ws://` or `wss://`、`location`から自動判定)
2. ロビー画面の描画・参加/開始ボタンの制御(`join` / `start` メッセージ送受信)
3. ミニゲーム1: `#g1-canvas` に `game1_state` を毎フレーム描画(マップ・プレイヤー・ボム・弾・縮小フィールド)、矢印キー/SHIFT/SPACEの入力を `input` メッセージで送信
4. ミニゲーム2: `#g2-canvas` に `game2_state` を毎フレーム描画(トラック・プレイヤー位置・周回数)、SHIFT押下/解放を `input` メッセージで送信
5. 結果画面(`result1` / `result2` / `final_result`)の描画、ホストのみに「次へ」ボタンを表示

サーバー側メッセージ仕様は `server/index.js` の実装を参照してください。
