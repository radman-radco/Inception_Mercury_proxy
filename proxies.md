#  Proxy Setup Guide

This proxy automatically routes requests through external IPs to avoid rate limits from Inception Labs. This guide explains how to enable proxies, configure them, and where to find free ones.

---

##  Included Proxy List

The repo ships with a pre-tested proxy list file (`proxies.txt`) containing **192 working, verified proxies**. You can use this straight away without finding your own — just enable proxies in `config.json` and point it at the file.

---

##  config.json Reference

Below is a full breakdown of every field in `config.json`:

```json
{
  "proxy": {
    "enabled": false,
    "path": "./proxies.txt"
  },
  "browser": {
    "type": "chrome"
  }
}
```

| Field | Type | Description |
|---|---|---|
| `proxy.enabled` | `boolean` | Set to `true` to enable proxy routing. When `false`, all requests go through your local IP. |
| `proxy.path` | `string` | Path to your proxy list file (relative to the project root). Default is `./proxies.txt`. |
| `browser.type` | `string` | The browser fingerprint to impersonate. Accepted values: `"chrome"`, `"firefox"`, `"safari"`. Stick with `"chrome"` unless you have a reason to change it. |

---

## 🚀 Enabling Proxies (Step by Step)

**1. Open `config.json`** in the root of the project.

**2. Set `proxy.enabled` to `true`:**
```json
{
  "proxy": {
    "enabled": true,
    "path": "./proxies.txt"
  }
}
```

**3. Make sure your proxy file exists** at the path you specified. The included `proxies.txt` works out of the box.

**4. Start the server** as normal:
```bash
node index.js
```

The proxy list loads on startup. You'll see a log line like:
```
[STARTUP] Loaded 192 proxies from ./proxies.txt
```

---

##  Proxy List Format

Each proxy must be on its own line in the following format:

```
http://IP_ADDRESS:PORT
```

**✅ Valid examples:**
```
http://185.199.228.220:7300
http://103.149.162.195:80
http://47.74.152.29:8888
```

**❌ Invalid (will be ignored or crash):**
```
185.199.228.220:7300        ← missing http://
https://103.149.162.195:80  ← https not supported, must be http://
socks5://47.74.152.29:1080  ← SOCKS not supported
```

> Blank lines and lines that don't match the format are automatically skipped.

---

##  How the Proxy System Works

The proxy manager maintains a pool of clients (one per proxy). It automatically:

- **Picks the best available proxy** — based on successful request count and reachability
- **Marks proxies as rate-limited** if it receives a `429` response (paused for 1 minute)
- **Marks proxies as unreachable** on timeouts or network errors (paused for 1 hour, then retried)
- **Rotates automatically** when the active proxy fails, pulling the next one from the list

You don't need to manage rotation manually — it's all handled in the background.

---

##  Where to Get Free Proxies

If you run out of proxies or want to refresh the list, here are some reliable free sources:

| Site | Notes |
|---|---|
| [free-proxy-list.net](https://free-proxy-list.net) | Large list updated every few minutes, filterable by country and HTTPS support |
| [proxyscrape.com/free-proxy-list](https://proxyscrape.com/free-proxy-list) | Free HTTP/HTTPS proxies with anonymity filter |
| [geonode.com/free-proxy-list](https://geonode.com/free-proxy-list) | Large database with speed and uptime stats |
| [github.com/clarketm/proxy-list](https://github.com/clarketm/proxy-list) | Regularly updated plain-text proxy list on GitHub |
| [github.com/TheSpeedX/PROXY-List](https://github.com/TheSpeedX/PROXY-List) | Very large community-maintained proxy list repo |
| [spys.one/en](https://spys.one/en) | Detailed proxy list with port, type, and country info |

> ⚠️ **Tip:** Free proxies go offline frequently. If you notice lots of `unreachable` errors in the logs, grab a fresh list from one of the sources above and replace your `proxies.txt`.

---

## Using a Custom Proxy File Path

You can store your proxy list anywhere — just update the path in `config.json`:

```json
{
  "proxy": {
    "enabled": true,
    "path": "/home/user/my-proxies.txt"
  }
}
```

Absolute paths work fine too.

---

##  Troubleshooting

**`proxy list is empty or invalid`**
→ Check your file exists at the path in `config.json` and that each line follows `http://IP:PORT` format.

**`proxy list is empty, but config.proxy.enabled is true`**
→ Either disable proxies (`"enabled": false`) or add at least one valid proxy to the file.

**Lots of timeouts / unreachable errors**
→ Your proxies may have gone offline. Download a fresh list from one of the sources above.

**`Error reading proxy file`**
→ The file path is wrong or the server doesn't have permission to read it. Check the path and file permissions.

---

##  Tips

- The included `proxies.txt` has 192 tested, working proxies — a good starting point
- Proxies are consumed from the top of the list; the best-performing ones get prioritised automatically
- Running out of proxies mid-session is handled gracefully — the server will log a warning and fall back
- You can mix the included list with fresh proxies by just appending new lines to `proxies.txt`
