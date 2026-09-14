[English](./README.md) | **日本語**

# 工場：点検で見つかった異常から顧客連絡へ

リポジトリのルートで `pnpm demo:factory` を実行します。架空の MES・WMS と、メモリ上のオントロジーストアを使い、毎回初期状態から始めます。

9月8日の設備点検で PRESS-1 の異常が確認されました。出荷時の検査は合格しており、9月7日に出荷済みです。今回の調査には、9月6日を製造日の対象範囲として与えます。製品への影響は疑いの段階で、既知の不良品を出荷した理由や、故障開始時刻を推定する例ではありません。

**[▶ オントロジーの捜査型分析解説｜工場編（日本語音声・6:16）](https://www.youtube.com/watch?v=p6pljWy4xzg)**

[![オントロジーの捜査型分析解説｜工場編](https://i.ytimg.com/vi/p6pljWy4xzg/mqdefault.jpg)](https://www.youtube.com/watch?v=p6pljWy4xzg)

<img src="./assets/ontology-overview.ja.png" alt="工場のオントロジー全体図。Equipment・Lot・ShipmentLine・Shipment・Customer と、ontology-owned な ContactTask のリンク構造。customerImpact が出荷明細の根拠を集計し、createContactTask が選択内容を検査してタスクと根拠リンクを記録する。">

グレーはソース由来、オレンジはオントロジーが所有する状態です。全オブジェクト型・リンク型を示し、属性は抜粋しています。[編集用 SVG](./assets/ontology-overview.ja.svg)。

`demo.ts` は Runtime の filter と pivot を直接組み合わせます。

| 段階 | 結果 |
| --- | --- |
| 点検で異常があった設備を filter | PRESS-1 |
| 製造履歴へ pivot | L1・L2・L3 |
| 与えられた製造期間で filter | L1・L3 |
| 出荷明細へ pivot | SL1・SL3・SL5・SL4 |
| 出荷へ pivot し、出荷済みを filter | S1・S2 |
| 顧客へ pivot | C1（Aoba）、重複を除いて1件 |

C1 は対象ロットの出荷先なので見つかります。C2 の L2 は9月5日製造なので対象外です。C3 宛ての L1 の残り10単位は未出荷のため除外します。L1 は出荷済みの S1・S2 に含まれますが、各段階で同じ対象の重複を除きます。

モデルの `customerImpact` Function は出荷済みの対象明細だけを保持し、顧客ごとの影響数量を求めます。出荷から明細へ戻る際に、元の対象明細との積集合を取ることで、S1 に同梱された対象外の L4 も除外します。残る根拠は SL1・SL3・SL4 で、C1 は2出荷で50単位です。デモで製品系列別に集計する L1・L3 の製造数量60単位とは異なります。数量は出荷明細の粒度で計算し、重複排除した顧客集合からは求めません。

担当者は `createContactTask` を preview してから実行します。Action は設備の点検結果、製造期間、顧客、出荷済み明細の根拠を検査し、タスクと顧客・設備・ロット・明細へのリンクを原子的に作ります。タスクは ontology-owned です。メッセージは送らず、出荷済み商品を保留にしようともしません。再インデックス後もタスクと根拠リンクを保持しますが、リンクが指すソースレコードの内容を過去のまま固定するものではありません。

## コードと MCP

[`demo.ts`](./demo.ts) から読み、ルールと Function は [`ontology.ts`](./ontology.ts) で確認できます。`fixtures.ts`・`integrate.ts` が既存のソースの事実を供給し、`runtime.ts` がモデルの読み取りとランタイムを接続します。ソースへの書き戻しは [orders](../orders/ontology.ts)、候補と割当は [hospital](../hospital/README.ja.md)、共通項の調査は [finance](../finance/README.ja.md) で扱います。配列用の独自の集合 helper は不要です。

`pnpm mcp:factory` で起動します。リポジトリのルートからは次でも接続できます。

```sh
claude --strict-mcp-config --mcp-config examples/factory/.mcp.json
```

同じモデルから filter・pivot・集合演算・集計のツール、Function、Action を生成します。例えば `customer_impact` が集計と根拠を返し、`create_contact_task` が根拠を再検査します。契約は [IMPLEMENTATION.ja.md](../../IMPLEMENTATION.ja.md) にあります。単一の書き込み元と、判断に関係する全資源が見えることを前提とします。
