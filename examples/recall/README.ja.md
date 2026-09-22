[English](./README.md) | **日本語**

# リコール：不良品の発覚から顧客連絡へ

リポジトリのルートで `pnpm demo:recall` を実行します。架空の north・south 注文データベースと、メモリ上のオントロジーストアを使い、毎回初期状態から始めます。

2026年9月10日、メーカーからキーボード ITM-101 のキースイッチに不具合があると連絡があり、対象品は交換することになりました。この例はカスタマーサポート（CS）の視点だけを扱います。販売停止はストアフロント管理、未出荷注文の保留は倉庫、すでに商品を受け取った顧客への連絡は CS の担当で、この例は最後の業務だけを対象にします。9月9日には3社が CS に電話し、それぞれのリコールタスクが記録されています。

モデルは orders 例の Customer・Order・Product を再利用し、ここで使わない `assignee` プロパティと `visibility` 関数は省いています。ontology-owned な RecallTask と、同じく ontology-owned な3つのリンク `customerRecallTasks`・`productRecallTasks`・`recallTaskOrders` を追加します。

| 段階 | 結果 |
| --- | --- |
| キーボード ITM-101 を含む注文を探す | 300注文中48件 |
| 出荷状態で絞る | 出荷済み31件（未出荷14件、キャンセル3件） |
| 出荷済み注文から顧客へ pivot | 27顧客 |
| 顧客ごとに `createRecallTask` を実行 | 24件適用、3件を `ALREADY_CONTACTED` で拒否 |
| リコールタスクを確認 | 27/27顧客にタスクあり |
| 監査ログを読む | 30エントリ |

`createRecallTask` Action は、商品が存在すること（`UNKNOWN_PRODUCT`）、その顧客と商品のタスクがまだないこと（`ALREADY_CONTACTED`）、指定した注文が重複せず、その顧客へ出荷済みで、対象商品を含むこと（`INVALID_EVIDENCE`）を検査します。タスクと根拠リンクは原子的に作りますが、メッセージは送らず、注文や在庫も変更しません。ソースデータを再インデックスしても、ontology-owned なタスクとリンクは保持されます。

> このデモは顧客ごとに Action を 27 回呼びます。最小のリファレンス実装として、1 回の実行が 1 つの監査ログ行になる形を優先したためです。実運用では一括処理の Action にして、全件を検証してから全件を適用する、あるいは 1 件でも拒否があれば全件を止める設計の方が現実的です。どちらを選んでも「拒否が名前付きで返り、試行が記録に残る」性質は変わりません。

## コードと MCP

[`demo.ts`](./demo.ts) から読み、Action とそのルールは [`ontology.ts`](./ontology.ts) で確認できます。`fixtures.ts` が2つの架空のレガシーデータベースを作り、`integrate.ts` がその行とリンクを正規化し、`runtime.ts` がモデルの読み取りとランタイムを接続します。ontology-owned なオブジェクトはスナップショットから読み込めないため、`runtime.ts` は前日のタスクも Action 経由で登録します。ソースへの書き戻しは [orders](../orders/ontology.ts)、根拠の積集合は [factory](../factory/README.ja.md)、候補検索の Function は [hospital](../hospital/README.ja.md)、共通する受取先の調査は [finance](../finance/README.ja.md) で扱います。

`pnpm mcp:recall` で起動します。リポジトリのルートからは次でも接続できます。

```sh
claude --strict-mcp-config --mcp-config examples/recall/.mcp.json
```

サーバーは `get_product`、`traverse_order_products`、`pivot_customer_orders`、`create_recall_task`、`read_audit_log` などのツールをモデルから生成します。エージェントは自身のコード実行環境で取得済みオブジェクトを絞り、選んだ ID を次のツールへ渡します。`scenario.test.ts` の MCP テストは同じ探索を行い、1件のタスク適用と二重連絡の拒否を確認します。契約は [IMPLEMENTATION.ja.md](../../docs/IMPLEMENTATION.ja.md) にあります。単一の書き込み元と、判断に関係する全資源が見えることを前提とします。
