# ミニゲーム集(タンクバトル × スロットカー)

ブラウザで動作する、最大4人参加のパーティーミニゲーム集。
Node.js製サーバーをローカルで起動し、ngrokで外部公開してURLを共有する想定です。

## 現在の進捗

- [x] server/game1.js — ミニゲーム1(タンク×ボンバーマン)のサーバーロジック
- [x] server/game2.js — ミニゲーム2(スロットカー)のサーバーロジック
- [x] server/index.js — ロビー管理・WebSocket・進行管理
- [x] public/index.html, public/css/style.css — 画面の土台(ロビー/ゲーム選択/観戦/結果)
- [x] public/js/main.js — クライアント側の描画・入力処理(**PixiJS(WebGL)で実装済み**)
- [x] public/js/vendor/pixi.min.mjs — 同梱した PixiJS 本体(CDN非依存・自前サーバーで配信)

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

## クライアント / 描画について

`public/js/main.js`(実装済み)がカバーする範囲:

1. WebSocket接続(`ws://` or `wss://` を `location` から自動判定)
2. ロビー・**ゲーム選択画面**・**観戦モード**・結果画面のUI制御(`join` / `spectate` / `to_select` / `to_lobby` / `pick` / `back_to_select`)
3. ミニゲーム1: `#g1-canvas` に `game1_state` を描画、矢印キー/SHIFT/SPACE を `input` で送信
4. ミニゲーム2: `#g2-canvas` に `game2_state` を描画(＋タコメーター `#g2-tacho`)、SHIFT押下/解放(＋モバイル向けにキャンバス長押し)を `input` で送信

サーバー側メッセージ仕様は `server/index.js` を参照してください。

### 描画技術(PixiJS + Canvas 2D ハイブリッド)

ゲーム画面は **PixiJS(WebGL)** でGPU描画します。

- **スプライト**: 精密なベクター戦車/レーシングカー(Canvas 2Dで描いた図形)を、プレイヤー色ごとに **一度だけGPUテクスチャへ焼き込み**、以降は PixiJS のスプライトとして合成します。
- **状態補間**: サーバーは約30Hzで状態を配信。クライアント側で位置・角度を指数スムージングし、ディスプレイのリフレッシュレート(60fps等)で滑らかに描画。
- **エフェクト**: ボム爆発の加算合成グロー、スピンアウト時の火花、戦車/車の影・カラーグローなど。
- **マップ/トラック/ボム/弾** は `PIXI.Graphics`、**タコメーター** は専用の Canvas 2D ゲージで描画。

PixiJS は `public/js/vendor/pixi.min.mjs` に同梱し、自前サーバーから配信します(CDN非依存・オフライン動作可)。`main.js` は ES モジュールとして読み込まれ(`<script type="module">`)、サーバーは `.mjs` を `text/javascript` で配信します。
