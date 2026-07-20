# Recording of an agent meeting the ontology's rules over MCP — one continuous,
# uncut interactive session. Reproduce with:
#   brew install vhs && vhs assets/demo-mcp.tape   (from the repo root)
# `pnpm agent` is Claude Code, connected to this repo's .mcp.json (server "orders",
# command: pnpm mcp) and restricted to it (--strict-mcp-config). A small fast model
# was selected for the recording session. The only edit: the CLI's login banner
# (account name/email) is pixelized in post with ffmpeg — no frames are cut.
Output assets/demo-mcp.gif

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
Type "Yamada Trading is on the phone. Which orders do they have? List each with status and total."
Sleep 500ms
Enter
Wait+Screen@120s /(?i)shipped/
Sleep 8s
Type "They want everything cancelled — it's approved on our side, go ahead with both now (reason: customer request). If the system refuses one, that's expected: just quote the machine-readable error code and continue."
Sleep 500ms
Enter
Wait+Screen@120s /SHIPPED_ORDER_CANNOT_BE_CANCELLED/
Sleep 10s
Type "Understood. Before we set up the return — what items are in the shipped order? They'll need to send those back."
Sleep 500ms
Enter
Wait+Screen@120s /(?i)keyboard/
Sleep 8s
Type "Thanks. Leave a note on the shipped one saying it needs the return/refund process instead, then show me the audit log — quote each entry's status field verbatim."
Sleep 500ms
Enter
Wait+Screen@120s /(?i)rejected/
Sleep 15s
