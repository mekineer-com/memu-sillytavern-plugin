# ST memU Server Plugin

Keep README.md for people choosing, installing and using this project. Put durable
working guidance here, code navigation in an existing index, and task history in
the relevant plan or audit; do not turn this file into a session log.

This plugin connects the browser extension to mcp-memu-server. Work in `src/`,
not stock SillyTavern core. Credentials resolve on the server, never in the page.

## Memorize and Progress

Memorize uses the saved main chat. The server decides automatic eligibility after
a reply is saved; merely opening a chat does not start paid processing. Waiting,
deferred, publication-only and coalesced requests do not create local tasks.

Progress comes from MCP by owner and Soul, not an expiring plugin task list.
The returned task ID is only a client observation token. Polling errors are
unknown status, not failed Memorize; skipped and cancelled work are not success.
Control requests are bounded without automatically repeating writes.

## Model Mapping

`GET /modelMappings` reloads ordinary server settings and returns key-free
`base_model`, `step_models` and saved ST connection summaries. Opening settings
never posts remembered choices to server config. `POST /modelMappings` patches
only changed rows: `{model}` writes a model name; saved-profile/native choices
resolve credentials backend-side; `null` removes the step and its capacity.
`base_model` replaces the shared reply connection and clears stale optional fields.
Projection-only profile hints match provider, URL, credentials and model, not
derived capacities/limits; they are never saved in server config. Optional
key-free native/SRMM context returns separate match results, including when no
saved native profile exists. Neither the context nor results are persisted.
Config-source choices are no-ops, not deletions; null deletes only explicitly
disabled overrides. Base changes and config-backed SRMM followers resolve in
one config write against the prospective base. Unmatched loaded objects remain
config-authoritative.

Catalog reads never discover provider models or write mappings. Only resolving a
chosen connection without native/profile capacity fetches provider metadata,
using the authenticated user's credentials and the existing five-minute cache.
Only that model's reported capacity is used; unavailable metadata leaves it unset,
never carried over from the previous model. Native capacity takes precedence;
reads leave hand-edited capacities untouched. Known default hosted API endpoints require
credentials before any config write; keyless custom/local connections remain valid.

Turns and Narrative Suggestions carry a key-free ST choice under `srmm`; the
plugin resolves it to top-level `srmm: "config"` or a complete API connection
for MCP. The shared memory/retrieval builder never adds SRMM. Missing saved SRMM
profiles use the live ST selection; unusable existing profiles return an error.

## Checks

Use the existing `scripts/` regression checks for the changed path.
`npm run typecheck` checks types; `npm run build` updates `dist/`. Restart ST
after a plugin build to test the new server code.
