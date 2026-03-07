<div align="center">

Community fork (unofficial).<br>
Upstream: (https://github.com/NevaMind-AI/memu-sillytavern-plugin)<br>
Purpose: SillyTavern integration + local memU server routing/build fixes.<br>
Not affiliated with upstream hosted services.<br>
License: see LICENSE (upstream license applies).

![MemUxST Banner](public/banner.png)

### MemU Plugin for SillyTavern

Server plugin to proxy the memu SDK. Required by [MemU-Extension](https://github.com/NevaMind-AI/memu-sillytavern-extension).

</div>

---

## How to install

1. Before you begin, make sure you set a config `enableServerPlugins` to `true` in the config.yaml file of SillyTavern.

2. Open a terminal in your SillyTavern directory, then run the following:

```bash
cd plugins
git clone https://github.com/mekineer-com/memu-sillytavern-extension
```

3. Restart the SillyTavern server.

## How to build

Clone the repository, then run `npm install`.

```bash
# After your edit
npm run build
```


---

## Config: `memu-plugin.config.json`

This plugin stores its settings in a file named `memu-plugin.config.json` in your **SillyTavern root folder** (the same folder that has `config.yaml`).

- The file is **auto-created** the first time the plugin runs.
- The MemU browser extension normally updates it by calling `GET/POST /api/plugins/memu/config`.

### Local mode: how the plugin finds memU

In **local mode**, the plugin uses the external `mcp-memu-server` HTTP service.

- `serverPath` in `memu-plugin.config.json` points to that repo folder (default: `~/apps/mcp-memu-server`).
- The plugin starts `run.py` from that folder when needed.
- The plugin discovers base URL from:
  - `MEMU_SERVER_URL` / `MCP_MEMU_SERVER_URL`, or
  - `<serverPath>/config.json` listen host/port, or
  - fallback `http://127.0.0.1:8099`.

Use `/api/plugins/memu/health` and `/api/plugins/memu/server/status` to verify local runtime health.


## License

AGPLv3


### Build Compatibility Notes

- `buildfix-v0.0.2` requires **custom memU** tag `v0.0.2-buildfix` (based on `v1.2.0`).
- `buildfix-v0.0.3` requires **standard/upstream memU `v1.4.0`**.
- Current development branch (next push) requires:
  - **custom memU** branch `buildfix-v0.0.4-dev` (based on `v1.4.0`), and
  - **custom `mcp-memu-server`**.

For exact commit pins per build, see workspace manifest:
- `release-manifest/builds.yaml`
