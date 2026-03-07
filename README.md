<div align="center">

When you enter a new chat, memU will start to memorize for the entire chat, so be careful not to enter a huge chat or you will have a large token spend.

For any issues or suggestions, please contact mekineer@gmail.com.

REQUIRES:<br>
https://github.com/mekineer-com/memu-sillytavern-extension/<br>
https://github.com/mekineer-com/mcp-memu-server/<br>
[https://github.com/mekineer-com/memU/](https://github.com/mekineer-com/memU/)<br>
Can be run on Python 3.12 by changing versions in the memU config files including pyproject.toml.<br>
Compatibility includes Alpine 3.23.

Community fork (unofficial).<br>
Upstream: (https://github.com/NevaMind-AI/memu-sillytavern-plugin)<br>
Purpose: SillyTavern integration + memU service improvements (Local/API routing, build fixes, etc.).<br>
Not affiliated with upstream.<br>
License: see LICENSE (upstream license applies).

![MemUxST Banner](public/banner.png)

### MemU Plugin for SillyTavern

Server plugin used by [MemU-Extension](https://github.com/mekineer-com/memu-sillytavern-extension/) to talk to a local `mcp-memu-server`.

</div>

---

## How to install

1. Before you begin, make sure you set a config `enableServerPlugins` to `true` in the config.yaml file of SillyTavern.

2. Open a terminal in your SillyTavern directory, then run the following:

```bash
cd plugins
git clone https://github.com/mekineer-com/memu-sillytavern-plugin
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

### Local mode: how the plugin runs

In **local mode**, the plugin talks to an external HTTP service: `mcp-memu-server`.

- `serverPath` points to your `mcp-memu-server` folder (for example: `/path/to/mcp-memu-server`).
- Base URL is resolved in this order:
  1. `MEMU_SERVER_URL` / `MCP_MEMU_SERVER_URL`
  2. `<serverPath>/config.json` listen host/port
  3. fallback `http://127.0.0.1:8099`
- If `autoStartServer` is enabled and `<serverPath>/run.py` exists, the plugin can start the server automatically.
- The plugin chooses Python from `mcp-memu-server` config/venv when available, else falls back to `python3`.

`memU` is still required, but it is loaded by `mcp-memu-server` (not by a plugin-local helper process).


## License

AGPLv3


### memU v1.4+ only
This release targets `memU` >= `1.4.0` via `mcp-memu-server`.
