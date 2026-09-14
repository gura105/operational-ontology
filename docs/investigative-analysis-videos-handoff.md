# オントロジーの捜査型分析 — ブランチ担当者への引き継ぎ

2026-09-14 / 対象ブランチ: `feat/investigative-analysis`

工場・金融・病院の本編を日英1本ずつ、計6本、[@gura105](https://www.youtube.com/@gura105) に投稿しました。各事例の日本語READMEには日本語版、英語READMEには英語版へのテキストリンクとクリック可能なサムネイルを追加しています。

## 動画一覧

| 事例 | 日本語 | English |
| --- | --- | --- |
| 工場 | [オントロジーの捜査型分析解説｜工場編 — 6:16](https://www.youtube.com/watch?v=p6pljWy4xzg) | [Ontology: Investigative Analysis Explained \| Factory — 6:02](https://www.youtube.com/watch?v=kQFvOResIvI) |
| 金融 | [オントロジーの捜査型分析解説｜金融編 — 6:40](https://www.youtube.com/watch?v=8JwF0oU-idc) | [Ontology: Investigative Analysis Explained \| Finance — 6:36](https://www.youtube.com/watch?v=4urBRngmnuA) |
| 病院 | [オントロジーの捜査型分析解説｜病院編 — 5:48](https://www.youtube.com/watch?v=rDBCEIlDfhE) | [Ontology: Investigative Analysis Explained \| Hospital — 5:48](https://www.youtube.com/watch?v=cXEIbE-2abs) |

全動画を Unlisted（限定公開）、埋め込み許可あり、登録者への投稿通知なしで投稿しています。日英でタイトル・説明文・音声言語の設定を分けています。チャンネルIDは `UCZ2WK2xPA3JJ0h_LqP3LL7g` です。通常のチャンネル動画一覧への掲載も必要になった場合は、所有者が公開範囲を Public に変更してください。

説明文には、動画の概要、リポジトリと公開済み開発ブランチのREADME、言語ごとのチャプター、制作・音声クレジットを入れています。字幕は映像内に表示されています。別途選択できる字幕トラックのAPI投稿は行っていません。

## 変更したファイル

| 挿入先README | 対応する動画 |
| --- | --- |
| [工場・日本語](../examples/factory/README.ja.md) | [p6pljWy4xzg](https://www.youtube.com/watch?v=p6pljWy4xzg) |
| [工場・English](../examples/factory/README.md) | [kQFvOResIvI](https://www.youtube.com/watch?v=kQFvOResIvI) |
| [金融・日本語](../examples/finance/README.ja.md) | [8JwF0oU-idc](https://www.youtube.com/watch?v=8JwF0oU-idc) |
| [金融・English](../examples/finance/README.md) | [4urBRngmnuA](https://www.youtube.com/watch?v=4urBRngmnuA) |
| [病院・日本語](../examples/hospital/README.ja.md) | [rDBCEIlDfhE](https://www.youtube.com/watch?v=rDBCEIlDfhE) |
| [病院・English](../examples/hospital/README.md) | [cXEIbE-2abs](https://www.youtube.com/watch?v=cXEIbE-2abs) |

上記6ファイルと、この引き継ぎ資料が対象です。READMEからYouTubeへのリンクは利用できます。YouTube説明欄からGitHubへ戻る外部リンクの審査状況は、後述の別項目に記録しています。

各READMEでは、シナリオ背景、オントロジー全体図と説明、動画、探索手順・コードの順に配置しています。画像はYouTubeの高解像度版 `maxresdefault.jpg`（1280 × 720 px）を参照し、表示幅を640 pxに指定しています。README内でのインライン再生ではなく、サムネイルまたはタイトルをクリックしてYouTubeへ移動する構成です。既存の本文、図、コードは変更していません。MP4や認証情報はこのリポジトリへ追加していません。

## 各動画が解説すること

### 工場

設備・ロット・出荷明細・出荷・顧客の構造と、スキーマ／インスタンスの違いから説明します。Filter・Pivot・Transformで異常設備から出荷先へ進み、対象明細と出荷済み明細の積集合を取り、対象外の同梱品と未出荷分を除きます。C1への50単位を根拠付きの連絡タスクにするところまでを扱います。

### 金融

午前中に入金件数が増えたA・B・Cについて、午後の出金を調べる背景から始めます。受取先集合の積集合でXを発見し、4件・510万円の根拠を確認します。集計FunctionとFilterの役割も説明し、請求書・送金目的の確認に向けて調査ケースを残します。

入金の異常検知はシナリオの前提です。共通の受取先を不正と断定する動画ではなく、Xが共通の決済事業者である可能性も確認します。金融本編は、ユーザーが改定したREADMEのストーリーに合わせて更新済みです。

### 病院

受入確認済み患者の集合からP1を選び、病床の設備・予約状況と看護師の勤務・受入枠を評価します。Previewは資源を予約せず、Actionが仮割当と3本のリンクを保存する違いを説明します。保存後の再検索と、以前のPreviewを使ったP4の実行時の拒否によって、計画の消費と再検査を示します。実際の入院処理は範囲外です。

## ソースとの対応

| 動画 | 制作時の参照リビジョン |
| --- | --- |
| 工場本編 | `6370f6a40425933293682530b2727c587cfbc0f1` |
| 金融本編 | `86033219179d8375ca0fd041dd3e71daeb219f41` |
| 病院本編 | `96a9f0f52423aed9ac37777f77ef273f994eea77` |

READMEへの挿入前HEADは `86033219179d8375ca0fd041dd3e71daeb219f41`。工場・病院について、動画参照時からこのHEADまでの各examplesディレクトリの差分はREADMEと全体図のみで、実装変更はありません。制作時の参照リビジョンは上表の記録として保持します。金融・病院の固定リビジョンURLは外部から404になったため、説明欄のREADMEリンクを公開済みの `feat/investigative-analysis` ブランチへ変更しました。説明欄の冒頭には短いリポジトリURLも追加しています。URLは省略記号を含まない完全な文字列で保存しています。

確認時のリモートブランチは `6370f6a40425933293682530b2727c587cfbc0f1`、ローカルは3コミット先です。差分はREADMEと全体図であり、金融の改定ストーリーもこの未push分に含まれます。動画・README追加とあわせて、担当者が内容を確認して公開してください。公開済みのREADMEリンクはブランチを追随するため、マージ後にはリンクの参照先を改めて確認してください。

## 検証

- 6本すべて、YouTube APIで処理成功・HD・限定公開・チャンネル一致を確認しました。
- タイトル・説明文・カテゴリ・メタデータ言語・音声言語が投稿データと一致することを確認しました。
- 未認証のYouTube oEmbedとREADME用サムネイルを取得できることを確認しました。
- オントロジー表記への改定後、6本すべてのタイトル・説明文の一致と公開範囲の維持をAPIで再確認しました。説明欄の8種類のURLはすべてHTTP 200でした。
- READMEの言語と動画IDの対応、既存本文が保持されていること、差分の空白エラーがないことを確認しました。
- 今回はドキュメントへのリンク追加のみです。実装の再テストやマージは行っていません。マージ前には `AGENTS.md` に従って必要なチェックを実行してください。

## 制作物と再投稿

制作物は別リポジトリ `x-playbook` の `article/20260909_ontology_link_analysis/assets/` にあります。

- 工場本編: `factory-video-v3/`
- 金融本編: `investigation-videos/finance/`
- 病院本編: `investigation-videos/hospital/`
- 投稿タイトル・説明文: `investigation-videos/youtube-upload-draft.md`
- 投稿対象ファイル・SHA-256: `investigation-videos/youtube/manifest.json`
- YouTube動画ID・投稿結果: `investigation-videos/youtube/uploads.json`
- 外部からの取得確認: `investigation-videos/youtube/verification.json`
- 認証・投稿・確認の手順: `investigation-videos/youtube/README.md`
- 日英6枚のサムネイル・生成プロンプト: `investigation-videos/youtube/thumbnails/`
- タイトル・説明文・サムネイルの更新記録: `investigation-videos/youtube/presentation-updates.json`
- 説明欄URLの到達確認: `investigation-videos/youtube/description-link-check.json`

各 `output/` にMP4とSRTがあります。MP4・音声はGit管理外です。完成動画を保持したまま作業し、必要に応じて別途バックアップしてください。短編6本は今回の投稿対象に含めていません。

動画の右上には常時 `@gura105` と提供アイコンを表示しています。日本語音声は AivisSpeech / 阿井田 茂（Calm）、モデル制作・CVは古山キリヲ。英語音声は macOS Samantha です。説明欄にも対応するクレジットを記載しています。

タイトル・説明文・公開範囲はYouTube Studioから同じURLのまま変更できます。映像そのものを差し替える場合は新しい動画IDになるため、対応READMEのタイトルリンク、サムネイルの画像URL、そのクリック先、および投稿記録を更新してください。旧動画の扱いは所有者と決めます。

## サムネイルの設定完了

暗い背景と集合図で統一した日英6枚を作成しました。各画像に「オントロジー / ONTOLOGY」、事例名、`@gura105` と提供アイコンが入っています。PNGは1672 × 941 px、各2 MB未満です。所有者の電話番号認証後、`thumbnails.set` が6本すべて成功しました。APIで `hasCustomThumbnail: true`、タイトル・説明文の一致、限定公開の維持を確認済みです。当初のHTTP 403は解消しています。READMEは同じYouTube画像URLからカスタムサムネイルを参照します。

再設定には制作側の `update_presentation.py --apply` を使用できます。設定済み画像はSHA-256で判定し、同じ画像の再送を省略します。OAuthによるメタデータ更新権限と、チャンネルの電話番号認証は完了しています。

## 説明欄のURL表示・クリック機能の確認待ち

APIに保存された6本の説明文には完全なURLがあり、リンク先のHTTP 200も確認済みです。ただし、視聴者向けの公開ページではYouTubeがURLの表示を `...` に短縮し、外部URLのクリック先を付けていないことを追加確認しました。保存本文の一致・リンク先の到達確認と、視聴画面での表示・クリック動作は別々に検証する必要があります。

[公式ヘルプ](https://support.google.com/youtube/answer/13748639?hl=en)によると、通常動画の説明欄の外部リンクをクリック可能にするには **Advanced features** が必要です。所有者が **Settings → Channel → Feature eligibility → Advanced features** を確認し、現在は審査中であると回答しました。承認後に6本すべての公開ページで外部リンクのクリック先を再確認する作業が残っています。電話番号認証によるサムネイル機能の有効化は完了していますが、この機能とは別です。Advanced featuresの有効化後もURLの見た目の短縮がなくなるとは限らないため、クリック先と表示を再確認してください。確認記録は制作側の `investigation-videos/youtube/description-render-check.json` です。

## 次の担当者へ

この変更は `feat/investigative-analysis` の作業ツリーに反映した状態で、コミット・pushはしていません。

1. 上表の6つのREADMEと、この引き継ぎ資料を確認して既存ブランチの作業に取り込んでください。ローカルにある既存の3コミットも、内容を確認して公開してください。
2. `AGENTS.md` に従って `pnpm typecheck`・`pnpm test`・`pnpm demo` を実行し、通常のPRは `next` を対象にしてください。
3. ブランチをマージ・削除するときは、YouTube説明欄のREADMEリンクを公開先のブランチまたは到達可能な固定リビジョンへ更新し、到達を確認してください。
4. 所有者から Advanced features の承認連絡が来たら、6本すべてで説明欄のGitHubリンクのクリック先を確認してください。READMEへの動画リンク追加は、この審査の完了を待つ必要はありません。

今回の動画追加に伴うバージョン更新やRelease作成はありません。
