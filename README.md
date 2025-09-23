<div align="center">

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
git clone https://github.com/NevaMind-AI/memu-sillytavern-extension
```

3. Restart the SillyTavern server.

## How to build

Clone the repository, then run `npm install`.

```bash
# After your edit
npm run build
```

## License

AGPLv3
