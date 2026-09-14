[English](./README.md) | **日本語**

# 病院：事実を辿り、候補を評価し、仮割当を記録する

`pnpm demo:hospital` で実行します。データは架空で、毎回初期状態に戻ります。設備 K や看護師の受入枠は説明用のルールであり、医療上の判断基準ではありません。

入院調整の担当者は、病院 H から入院待ち患者、その受入確認へ進みます。確認済みの記録を filter して患者へ戻ると、全患者ではなく P1・P4 が得られます。P2 は確認待ち、P3 は入院中です。入院待ち患者の入力要件は全員分を用意しています。P4 は、P1 自身の仮割当状態と資源の消費を分けて確かめるために追加した確認済み患者です。

**[▶ オントロジーの捜査型分析解説｜病院編（日本語音声・5:48）](https://www.youtube.com/watch?v=rDBCEIlDfhE)**

[![オントロジーの捜査型分析解説｜病院編](https://i.ytimg.com/vi/rDBCEIlDfhE/mqdefault.jpg)](https://www.youtube.com/watch?v=rDBCEIlDfhE)

<img src="./assets/ontology-overview.ja.png" alt="病院のオントロジー全体図。Hospital から Patient・Bed・Nurse、Patient から Admission へリンクする。bedSearch・nurseSearch が候補を評価し、allocate が選択内容を再検査して ontology-owned な Allocation と患者・病床・看護師へのリンクを作る。">

グレーはソース由来、オレンジはオントロジーが所有する状態です。全オブジェクト型・リンク型を示し、属性は抜粋しています。[編集用 SVG](./assets/ontology-overview.ja.svg)。

オレンジの仮割当リンクは最初は存在せず、候補検索ではなく割当の Action が作ります。

P1 に対する `bedSearch` は、病床の ObjectSet と、同じ病院の全病床の評価を返します。

| 病床 | 評価 |
| --- | --- |
| B101 | 候補：受入可能、設備 K、区域 A、予約なし。 |
| B102 | 清掃中。 |
| B103 | 設備 K がない。 |
| B104 | ソース側ですでに予約されている。 |

B101 を選んだ後の `nurseSearch` は N1 を返します。N2 は枠がなく、N3 は夜勤です。両 Function は `{ set, assessments }` を返し、各評価には対象と、該当するすべての `{ code, message }` の理由が入ります。選択や Function 呼び出しでは、リンクの作成、資源の予約、監査の追記はしません。

```ts
const beds = rt.run('bedSearch', { patientId: 'P1' }, { actor })
const bed = beds.set.objects[0]
const nurses = rt.run('nurseSearch', { patientId: 'P1', bedId: bed.pk }, { actor })
```

患者・病床・看護師の評価関数を、モデル内で `allocate` と共有します。入力がすべて揃った Action は preview してから実行できます。選択した組み合わせを再検査し、ontology-owned な Allocation と3本のリンクを原子的に作ります。患者・病床・看護師への参照はリンクに置き、外部キー属性として重複させません。

ソースの患者は `waiting`、病床は受入可能、N1 のソースの枠は1のままです。保存した計画が追加の業務状態になります。候補評価ではソースの予約・準備状態に既存の計画を合わせ、計画済み病床を除外し、看護師の枠から計画数を差し引きます。再検索すると、P1 は計画済みなので候補がなく、P4 は資源が消費されたので候補がありません。割当前なら P1・P4 は同じ資源でそれぞれ preview を通りますが、P1 の確定後に以前 preview した P4 の計画を実行すると拒否されます。取得済みの候補や preview は予約ではありません。ソースの再読み込み後も計画とリンクを保持します。

## 範囲とコード

[`demo.ts`](./demo.ts) から読み、[`ontology.ts`](./ontology.ts) でルールを確認できます。`fixtures.ts`・`integrate.ts` がソースの事実を表し、`runtime.ts` が型付きの読み取りをモデルへ接続します。Action のコンテキストにメソッドは増やしません。

9月8日の日勤という固定の計画範囲を扱い、単一の書き込み元と、関係する全資源の可視性を前提とします。複数患者の最適配分、時間帯の重なり、計画の取り消し、源泉の入院情報への書き戻し、源泉が計画を受理した後の照合は扱いません。再検査の対象は現在のインデックスであり、病院システムへの都度照会ではありません。実際の入院処理は別途ソース側で行う業務です。

`pnpm mcp:hospital` で起動するか、リポジトリのルートから次で接続できます。

```sh
claude --strict-mcp-config --mcp-config examples/hospital/.mcp.json
```

モデルから `bed_search`・`nurse_search`・`allocate` と探索ツールを生成します。呼び出し元は患者や病床を選び、適合条件を実装せずに使えます。共通 API と失敗時の契約は [IMPLEMENTATION.ja.md](../../IMPLEMENTATION.ja.md) にあります。
