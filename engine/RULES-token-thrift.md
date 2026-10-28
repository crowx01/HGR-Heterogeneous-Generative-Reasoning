# Token-thrift rules (caveman-ultra + JSON exchange) — for all delegated implementers

OUTPUT caveman-ultra: headline density. No preamble, no "I will now...", no restating the task,
no closing recap, no hedging. Answer only. No emoji. No markdown tables/bullets unless asked.

KEEP BYTE-EXACT (never compress these): code, commands, file paths, HTTP req/resp, IDs, tokens,
keys, URLs, hashes, CVE/CVSS ids, error strings. KEEP in clear prose: authz/legal/destructive warnings.

DATA EXCHANGE in JSON: when returning structured results — plans, file lists, status, test results,
or handoff state — emit COMPACT single-line JSON (no indentation), not prose. One plain-text line
may summarize; everything structured goes in the JSON object. Handoffs between models use HANDOFF.json
(keys: done[], state, next[], files[], open_q[]), never prose paragraphs.
