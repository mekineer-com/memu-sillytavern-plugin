# Fork status (buildfix)

**Branch:** `buildfix`  
**Release tag:** `v0.0.1-buildfix` (pre-release)  
**Scope:** Community fork of upstream open-source memU + SillyTavern integration work.  
**Affiliation:** Unofficial; not affiliated with upstream maintainers or app.memu.so.
**STATUS.MD:** Written by Nova (ChatGPT 5.2 Thinking) with hallucination removal by mekineer.

> Goal: keep this fork small, practical, and reproducible — focused on “it works” for SillyTavern users.

---

## What works (in this fork)

- **SillyTavern extension + plugin baseline** that can load.
- **Cloud (memu.so) / API router mode** plumbing (so the integration can route to memU bridge or an API worker).
- **NanoGPT embedding model listing support**:
  - Embedding model list is fetched from NanoGPT’s **embedding models endpoint** (not the generic models list).
  - Plugin `/models` supports `kind=embedding` and uses the provider-specific path.
- **SillyTavern secret resolution**:
  - Reads ST `secrets.json` API keys stored as arrays like `api_key_<provider>` with `{ id, value, label, active }`.
  - Resolves secrets by **secret-id** from the connection profile (fallback: active=true if no id match).
- **Mount robustness**:
  - Extension avoids hard-failing if `extensions_settings2` is missing (tries fallbacks, waits briefly).
  - Avoids unguarded listeners that break on older ST builds.
- **Local bridge stability**:
  - Bridge “guard” prevents the daemon from dying on unexpected exceptions (surfaces JSON error + stderr tail instead of exiting).

---

## What’s broken upstream (why this fork exists)

Upstream code in its current form is not reliably usable in real ST setups. Common failure modes we’ve seen:

- **Local bridge crashes** (uncaught exceptions causing the bridge process to exit).
- **Conversation preprocess fragility**:
  - Errors like “No JSON object found” when memU preprocess expects JSON segments but ST includes roleplay/system prompt content.

---

## Known issues (still open in this fork)

- **Conversation preprocess defaults can poison extraction** when system prompts are included.
  - Mitigation: disable the conversation preprocess prompt or filter system messages before sending to memU.

---

## Repro (“does it work?” checklist)

1. Install SillyTavern and enable the forked extension + plugin.
2. In ST, create/choose a **Connection Profile**.
3. In the memU extension UI:
   - Choose **Local** or **Cloud (memu.so)** mode
   - Select Default profile + Embedding profile + Embedding model (verify the embedding model list loads)
4. Trigger a memory action by reaching the Summary Turn number and confirm:
   - No “Profile not found”
   - No bridge exit
   - No preprocess JSON parsing crash

---

## Roadmap
- [ ] Robust ST root discovery so profiles always load
- [ ] Filter/clean ST “system” prompts before memU preprocess (avoid JSON extraction failures)
- [ ] Embeddings UX polish (profile/model dropdown behavior; manual override when needed)
- [ ] Optional: database-backed memory management via memu-server (Postgres/pgvector)

---

## Contributing / credit

- Please keep commits small and descriptive.
- Keep upstream attribution intact.
- If you fix something, include:
  - exact error message,
  - where it occurred (extension console / plugin logs / bridge logs),
  - steps to reproduce.

---

## Security notes

- **Do not commit secrets.** Secret Protection + Push Protection are enabled on this fork.
- Prefer ST `secrets.json` secret-id references instead of hardcoding keys.

---
