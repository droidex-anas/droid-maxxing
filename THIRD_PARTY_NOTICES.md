# Third-party notices

Portions of the DROIDEX multi-provider runtime are derived from [T3 Code](https://github.com/pingdotgg/t3code) under the MIT License. This attribution does not imply endorsement by T3 Tools Inc., and T3 trademarks and assets are not used as DROIDEX branding.

## T3 Code (MIT)

| Field | Value |
| --- | --- |
| Upstream repository | `pingdotgg/t3code` |
| Pinned commit | `4c51b4c9b6a85d96a22e0df41d5cfd2d8fc9901d` |
| License file | [`third_party/t3-code/LICENSE`](third_party/t3-code/LICENSE) |

### MIT License

```
MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Source map

Each row links an upstream T3 Code path to the DROIDEX module that ports its behavior. Adapter slices update the `DROIDEX path` cell when they land derived code.

| Upstream path | Concern | DROIDEX path |
| --- | --- | --- |
| `packages/effect-acp/src/protocol.ts` | ACP JSON-RPC 2.0 NDJSON framing | not yet ported |
| `packages/effect-acp/src/client.ts` | ACP client request/notification handling | not yet ported |
| `apps/server/src/provider/acp/AcpSessionRuntime.ts` | one ACP session: initialize, authenticate, session/new, session/load, session/prompt, session/cancel | not yet ported |
| `apps/server/src/provider/acp/AcpRuntimeModel.ts` | ACP `session/update` normalization, tool-call coalescing and output bounds | not yet ported |
| `apps/server/src/provider/acp/CursorAcpSupport.ts` | Cursor ACP spawn arguments and client capabilities | not yet ported |
| `apps/server/src/provider/acp/CursorAcpExtension.ts` | Cursor extension methods (`cursor/ask_question`, `cursor/create_plan`, `cursor/update_todos`, `cursor/list_available_models`) | not yet ported |
| `apps/server/src/provider/acp/GrokAcpSupport.ts` | Grok ACP spawn arguments and permission-mode flags | not yet ported |
| `apps/server/src/provider/acp/XAiAcpExtension.ts` | xAI extension methods (`x.ai/ask_user_question`, `x.ai/exit_plan_mode`, prompt-complete) | not yet ported |
| `apps/server/src/provider/Layers/CursorAdapter.ts` | Cursor adapter behavior | not yet ported |
| `apps/server/src/provider/Layers/CursorProvider.ts` | Cursor discovery, version, auth, model catalog | not yet ported |
| `apps/server/src/provider/Layers/GrokAdapter.ts` | Grok adapter behavior | not yet ported |
| `apps/server/src/provider/Layers/GrokProvider.ts` | Grok discovery and model catalog | not yet ported |
| `apps/server/src/provider/Layers/CodexSessionRuntime.ts` | Codex app-server session runtime | not yet ported |
| `apps/server/src/provider/Layers/CodexProvider.ts` | Codex discovery and initialize parameters | not yet ported |
| `packages/effect-codex-app-server/src/protocol.ts` | Codex app-server JSONL protocol | not yet ported |
| `apps/server/src/provider/Layers/ClaudeAdapter.ts` | Claude Agent SDK query lifecycle and permissions | not yet ported |
| `packages/contracts/src/providerRuntime.ts` | normalized provider runtime event union | not yet ported |

### Provenance headers

Substantially derived files under `src/` or `sidecar/src/` must begin with this leading comment block (adjust only the upstream path line):

```ts
// @derived-from t3code@4c51b4c9b6a85d96a22e0df41d5cfd2d8fc9901d apps/server/src/provider/acp/AcpRuntimeModel.ts
// Portions derived from T3 Code, MIT License, Copyright (c) 2026 T3 Tools Inc.
// See THIRD_PARTY_NOTICES.md.
```

The `@derived-from` line names the pinned upstream commit and the exact upstream path from the source map. `npm run quality:provenance` rejects any `@derived-from` reference that is not listed in the source map, and any source-map `DROIDEX path` that is not `not yet ported` but missing on disk.

### Upstream synchronization

Deliberate upstream updates follow this procedure:

1. Fetch a candidate T3 Code commit SHA.
2. Diff only the mapped provider files against the previous pin.
3. Review behavioral and protocol changes in that diff.
4. Port relevant behavior and tests into DROIDEX idioms.
5. Update the pinned SHA and source map in the same commit as the port.
6. Run adapter, provenance, and packaged-app validation gates.
7. Never merge T3 Code wholesale into DROIDEX.

## Codex generated protocol (Apache-2.0)

Any ported official Codex app-server generated protocol types retain their applicable Apache-2.0 license notice and upstream reference. No such material has been ported yet; the exact upstream reference and notice text are pending verification.
