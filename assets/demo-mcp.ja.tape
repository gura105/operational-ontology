# 日本語版: エージェントが MCP 越しにオントロジーのルールに出会う記録 — ノーカットの
# インタラクティブセッション。再現方法:
#   brew install vhs && vhs assets/demo-mcp.ja.tape   （リポジトリルートで）
# `pnpm agent` は Claude Code（このリポジトリの .mcp.json = orders サーバーに接続、
# --strict-mcp-config で他を遮断）。収録セッションは小型の高速モデルを使用。
# 唯一の編集は CLI ログインバナー（アカウント名/メール）の ffmpeg によるピクセル化で、
# フレームのカットは無い。
Output assets/demo-mcp.ja.gif

Set FontSize 18
Set Width 1360
Set Height 800
Set Padding 16
Set Theme "Catppuccin Mocha"
Set TypingSpeed 30ms

Type "pnpm agent"
Sleep 1s
Enter
Sleep 10s
Type "Yamada Trading さんから電話です。注文の一覧を見せてください。各注文のステータスと金額も。"
Sleep 500ms
Enter
Wait+Screen@120s /N-A-1002/
Sleep 10s
Type "全部キャンセルしてほしいそうです。本人確認と社内承認は済んでいます。両方の注文のキャンセルを実行してください（理由: 顧客依頼）。もしシステムに拒否される注文があれば、無理に通さなくて大丈夫です。返ってきた機械可読なエラーコードをそのまま引用して報告してください。"
Sleep 500ms
Enter
Wait+Screen@120s /SHIPPED_ORDER_CANNOT_BE_CANCELLED/
Sleep 10s
Type "了解。返品手配の前に、出荷済みの注文に何が入っているか教えてください。品名と型番（ID）も添えて。"
Sleep 500ms
Enter
Wait+Screen@120s /ITM-/
Sleep 8s
Type `ありがとう。出荷済みの注文に「キャンセル不可・返品/返金プロセスが必要」というメモを残してください（メモの author は "support" で）。最後に監査ログを見せてください。各エントリの status フィールドは原文のまま引用で。`
Sleep 500ms
Enter
Wait+Screen@120s /addOrderNote/
Sleep 14s
