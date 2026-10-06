# Re-recording the README demo (`docs/demo.gif`)

`docs/demo.gif` (780x470, about 21 s, about 1 MB) is rendered from a **real** Claude Code session
(`claude -p`, model `sonnet`) driving this server over stdio against alza.cz. Date of the committed
recording: 2026-10-06. Verification label: `live-verified` for `search_products` and `get_product`
(live mobile API); `find_pickup_points` is `source-confirmed` and reads the bundled showroom list in
`src/data/branches.ts` (no network call), so its output is real tool output but not live data.

## Prompt

> Find me the best pro-grade wheel cleaner under 600 Kč and tell me where I can pick it up in Prague. Use only the alza tools. Be brief.

## Constraints that keep it catalog-only and PII-free

- `ALZA_TOKEN_FILE=none`: no account session is loaded, so no personal data can appear.
- `--strict-mcp-config` with only this server; `--allowedTools` limited to `search_products`,
  `get_product`, `find_pickup_points`; shell, file and web tools are disallowed.
- Only the default `catalog` toolset is used (no `set_toolset` call was made).

## Reproduce

```bash
npm ci && npm run build
pip install Pillow                          # the only renderer dependency
export ALZA_CF_PYTHON=/path/to/venv/bin/python   # optional: curl_cffi sidecar, see README
scripts/record-demo-session.sh /tmp/session.jsonl   # real run, writes the stream-json transcript
python3 scripts/render-demo-gif.py /tmp/session.jsonl docs/demo.gif
```

The recording tool is the `claude` CLI in print/stream-json mode; the renderer
(`scripts/render-demo-gif.py`, Pillow, DejaVu Sans Mono) draws a terminal-style frame sequence from
that transcript. Tool names, arguments, result summaries and the final answer all come from the
transcript. Two things are intentionally left out of the animation:

- Claude Code's internal `ToolSearch` bootstrap call (it only loads tool schemas).
- Two `get_product_reviews` calls that the permission mode denied (review tool is outside the
  allow-list); the model's closing caveat about that is dropped from the answer.

The answer text differs slightly between runs (live prices and model wording), so re-record rather
than edit the GIF by hand.
