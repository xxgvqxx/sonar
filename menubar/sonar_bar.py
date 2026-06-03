#!/usr/bin/env python3
"""sonar-bar — sleek macOS menu bar panel for sonar.

A native NSStatusItem + NSPopover hosting a WKWebView (ui.html). The web UI talks
to this host over a small JS<->native RPC bridge; the host serves data from the
sonar hub's REST API and performs local OS actions (kill, launch terminal, open).
Auto light/dark (the webview follows the system appearance).

Run:  uv run sonar_bar.py        (or: sonar bar)
Test: uv run sonar_bar.py --selftest
"""
from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

MENUBAR_DIR = Path(__file__).resolve().parent
SONAR_DIR = MENUBAR_DIR.parent
UI_PATH = MENUBAR_DIR / "ui.html"
DATA_DIR = Path(os.path.expanduser(os.environ.get("SONAR_DIR", "~/.sonar")))
CONFIG_PATH = DATA_DIR / "menubar.json"
STATE_PATH = DATA_DIR / "menubar_state.json"   # per-link viewed/notified cursors (owned by the menu bar)
LOG_PATH = DATA_DIR / "daemon.log"
PLIST_PATH = Path(os.path.expanduser("~/Library/LaunchAgents/com.sonar.menubar.plist"))

DEFAULT_CONFIG = {
    "port": 7610,
    "active_secs": 180,
    "recent_count": 22,
    "terminal": "ghostty",       # ghostty | terminal | iterm | custom
    "terminal_custom": "",       # {dir} {cmd}
    "shell": "zsh",
    "agents": ["claude", "codex"],
    "node": "",
}


def load_config() -> dict:
    cfg = dict(DEFAULT_CONFIG)
    try:
        cfg.update(json.loads(CONFIG_PATH.read_text()))
    except Exception:
        pass
    return cfg


def save_config(cfg: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(json.dumps(cfg, indent=2))


def load_state() -> dict:
    """Menu-bar-owned cursors: how far the human has viewed (`seen`) and been
    notified (`notified`) per link, keyed by link id → seq."""
    st = {"seen": {}, "notified": {}, "workers": {}}
    try:
        data = json.loads(STATE_PATH.read_text())
        st["seen"].update(data.get("seen") or {})
        st["notified"].update(data.get("notified") or {})
        st["workers"].update(data.get("workers") or {})
    except Exception:
        pass
    return st


def save_state(st: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(json.dumps(st, indent=2))


def _osa_str(s) -> str:
    """Quote a Python string as an AppleScript string literal."""
    return '"' + str(s).replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ") + '"'


def notify(title: str, message: str) -> None:
    """Fire a macOS notification. Uses osascript so it works without a bundled
    .app or notification entitlements (good enough for a local dev tool)."""
    try:
        script = f"display notification {_osa_str(message)} with title {_osa_str(title)}"
        subprocess.Popen(["osascript", "-e", script])
    except Exception:
        pass


def resolve_port() -> int:
    """Current hub port — source of truth is ~/.sonar/config.json (written by the CLI),
    falling back to menubar.json then the default. Read each call so the menu bar follows
    `sonar port` changes without a relaunch."""
    for p in (DATA_DIR / "config.json", CONFIG_PATH):
        try:
            v = int(json.loads(p.read_text()).get("port"))
            if v > 0:
                return v
        except Exception:
            pass
    return 7610


# --------------------------------------------------------------------------
class Hub:
    def __init__(self, port: int):
        self.base = f"http://127.0.0.1:{port}"

    def _get(self, path: str):
        with urllib.request.urlopen(self.base + path, timeout=2.5) as r:
            return json.loads(r.read().decode())

    def _post(self, path: str, body: dict):
        req = urllib.request.Request(
            self.base + path, data=json.dumps(body).encode(),
            headers={"content-type": "application/json"}, method="POST",
        )
        with urllib.request.urlopen(req, timeout=5) as r:
            return json.loads(r.read().decode())

    def _delete(self, path: str):
        req = urllib.request.Request(self.base + path, method="DELETE")
        with urllib.request.urlopen(req, timeout=5) as r:
            return json.loads(r.read().decode())

    def health(self):
        try:
            return self._get("/health")
        except Exception:
            return None

    def get(self, path, default):
        try:
            return self._get(path)
        except Exception:
            return default


# --------------------------------------------------------------------------
def launch_terminal(cfg: dict, directory: str, cmd: str):
    shell = cfg.get("shell", "zsh")
    term = cfg.get("terminal", "ghostty")
    keepalive = f"{cmd}; exec {shell}"
    if term == "tmux":
        # Launch into a window under the shared `sonar` tmux session so sonar can
        # wake/talk to the live pane, then open Ghostty attached so you can watch.
        name = os.path.basename(directory.rstrip("/")) or "agent"
        has = subprocess.run(["tmux", "has-session", "-t", "sonar"], capture_output=True).returncode == 0
        sub = ["new-window", "-t", "sonar"] if has else ["new-session", "-d", "-s", "sonar"]
        subprocess.run(["tmux", *sub, "-n", name, "-c", directory, keepalive])
        subprocess.Popen(["open", "-na", "Ghostty", "--args", "-e", shell, "-lc", "tmux attach -t sonar"])
    elif term == "ghostty":
        subprocess.Popen(["open", "-na", "Ghostty", "--args", f"--working-directory={directory}", "-e", shell, "-lc", keepalive])
    elif term == "iterm":
        script = ('tell application "iTerm2"\n create window with default profile\n'
                  f' tell current session of current window to write text "cd {shlex.quote(directory)} && {cmd}"\n activate\nend tell')
        subprocess.Popen(["osascript", "-e", script])
    elif term == "custom" and cfg.get("terminal_custom"):
        subprocess.Popen(cfg["terminal_custom"].format(dir=shlex.quote(directory), cmd=cmd), shell=True)
    else:
        script = f'tell application "Terminal" to do script "cd {shlex.quote(directory)} && {cmd}"'
        subprocess.Popen(["osascript", "-e", script, "-e", 'tell application "Terminal" to activate'])


def choose_folder():
    try:
        out = subprocess.run(["osascript", "-e", "POSIX path of (choose folder)"], capture_output=True, text=True, timeout=120)
        return out.stdout.strip() or None
    except Exception:
        return None


def node_path(cfg):
    return cfg.get("node") or shutil.which("node") or "/opt/homebrew/bin/node"


def write_login_plist():
    uv = shutil.which("uv") or "/opt/homebrew/bin/uv"
    plist = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.sonar.menubar</string>
  <key>ProgramArguments</key><array>
    <string>{uv}</string><string>run</string><string>--directory</string><string>{MENUBAR_DIR}</string>
    <string>python</string><string>{MENUBAR_DIR / 'sonar_bar.py'}</string></array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>{DATA_DIR / 'menubar.log'}</string>
  <key>StandardOutPath</key><string>{DATA_DIR / 'menubar.log'}</string>
</dict></plist>"""
    PLIST_PATH.parent.mkdir(parents=True, exist_ok=True)
    PLIST_PATH.write_text(plist)


# --------------------------------------------------------------------------
def gather_state(cfg) -> dict:
    port = resolve_port()
    hub = Hub(port)
    health = hub.health()
    return {
        "health": health,
        "links": hub.get("/api/links", []) if health else [],
        "workers": hub.get("/api/workers", []) if health else [],
        "procs": hub.get("/api/procs", []) if health else [],
        "sessions": hub.get(f"/api/sessions?recent={cfg['recent_count']}&active_secs={cfg['active_secs']}", []) if health else [],
        "repos": hub.get("/api/repos?limit=18", []) if health else [],
        "config": {"terminal": cfg.get("terminal"), "agents": cfg.get("agents"), "port": port,
                   "active_secs": cfg.get("active_secs"), "recent_count": cfg.get("recent_count")},
        "login": PLIST_PATH.exists(),
    }


# --------------------------------------------------------------------------
def run_selftest(cfg):
    st = gather_state(cfg)
    print(f"hub: {'up' if st['health'] else 'DOWN'} · ui: {UI_PATH} (exists={UI_PATH.exists()})")
    print(f"links: {len(st.get('links') or [])}, workers: {len(st.get('workers') or [])}, procs: {len(st['procs'])}, sessions: {len(st['sessions'])}, repos: {len(st['repos'])}")
    for lk in st.get("links") or []:
        print(f"  link {lk.get('id')}  {lk.get('message_count', 0)} msgs  last_seq={lk.get('last_seq')}  [{lk.get('agents') or ''}]")
    for w in st.get("workers") or []:
        print(f"  worker {w.get('id')}  [{w.get('status')}]  {w.get('agent')}  {w.get('task', '')[:48]}")
    for p in st["procs"]:
        print(f"  {p['agent']:6} pid {p['pid']:>7} {p.get('cwd')}")


# --------------------------------------------------------------------------
def run_gui(cfg):
    import objc
    from Foundation import NSObject, NSMakeRect, NSMakeSize
    from AppKit import (NSApplication, NSApp, NSStatusBar, NSVariableStatusItemLength, NSImage,
                        NSPopover, NSViewController, NSView)
    NSImageLeft = 2  # NSCellImagePosition.imageLeft
    from WebKit import WKWebView, WKWebViewConfiguration
    from PyObjCTools import AppHelper

    html = UI_PATH.read_text()

    class Delegate(NSObject):
        def applicationDidFinishLaunching_(self, _n):
            NSApp.setActivationPolicy_(1)  # accessory (no dock icon)
            # status item
            self.item = NSStatusBar.systemStatusBar().statusItemWithLength_(NSVariableStatusItemLength)
            btn = self.item.button()
            img = NSImage.imageWithSystemSymbolName_accessibilityDescription_("dot.radiowaves.left.and.right", "sonar")
            if img is not None:
                img.setTemplate_(True)
                btn.setImage_(img)
                btn.setImagePosition_(NSImageLeft)
            else:
                btn.setTitle_("\U0001F4E1")
            btn.setTarget_(self)
            btn.setAction_("toggle:")

            # popover + webview
            cfgw = WKWebViewConfiguration.alloc().init()
            cfgw.userContentController().addScriptMessageHandler_name_(self, "sonar")
            frame = NSMakeRect(0, 0, 400, 580)
            self.web = WKWebView.alloc().initWithFrame_configuration_(frame, cfgw)
            self.web.loadHTMLString_baseURL_(html, None)
            vc = NSViewController.alloc().init()
            view = NSView.alloc().initWithFrame_(frame)
            view.addSubview_(self.web)
            vc.setView_(view)
            self.pop = NSPopover.alloc().init()
            self.pop.setContentViewController_(vc)
            self.pop.setContentSize_(NSMakeSize(400, 580))
            self.pop.setBehavior_(1)   # NSPopoverBehaviorTransient
            self.pop.setAnimates_(True)
            self.pop.setDelegate_(self)  # for show/close → pause polling when closed

        # NSPopoverDelegate: pause/resume the web UI's polling with popover visibility
        def popoverDidShow_(self, _n):
            self.evaljs("window.__setActive && window.__setActive(true)")

        def popoverDidClose_(self, _n):
            self.evaljs("window.__setActive && window.__setActive(false)")

        def toggle_(self, sender):
            if self.pop.isShown():
                self.pop.close()
            else:
                btn = self.item.button()
                self.pop.showRelativeToRect_ofView_preferredEdge_(btn.bounds(), btn, 1)  # NSMinYEdge
                NSApp.activateIgnoringOtherApps_(True)
                self.web.evaluateJavaScript_completionHandler_("refresh && refresh()", None)

        # JS -> native
        def userContentController_didReceiveScriptMessage_(self, ucc, message):
            # message.body() is an NSString; coerce to a real str before json.loads.
            try:
                msg = json.loads(str(message.body()))
            except Exception as e:
                print(f"[bridge] bad message: {e}", file=sys.stderr, flush=True)
                return
            mid, action, params = msg.get("id"), msg.get("action"), msg.get("params") or {}
            print(f"[bridge] {action}", file=sys.stderr, flush=True)
            try:
                result = self.dispatch(action, params)
                self.evaljs(f"window.__sonarResolve({mid}, {json.dumps(result)})")
            except Exception as e:
                self.evaljs(f"window.__sonarReject({mid}, {json.dumps(str(e))})")

        @objc.python_method
        def evaljs(self, js):
            self.web.evaluateJavaScript_completionHandler_(js, None)

        @objc.python_method
        def setTitleCount(self, n):
            self.item.button().setTitle_(f" {n}" if n else "")

        @objc.python_method
        def maybe_notify(self, links, state):
            """Fire a macOS notification for links that gained messages since we last
            alerted. Seeds `notified` to the current tail on first sighting so we never
            storm the user with the whole backlog on launch."""
            changed = False
            for lk in links:
                lid = lk.get("id")
                if not lid:
                    continue
                last = lk.get("last_seq") or 0
                prev = state["notified"].get(lid)
                if prev is None:
                    state["notified"][lid] = last
                    changed = True
                    continue
                seen = state["seen"].get(lid, 0)
                if last > prev and last > seen:
                    n = last - prev
                    title = lk.get("title") or lid
                    agents = lk.get("agents") or ""
                    body = f"{n} new message" + ("" if n == 1 else "s") + (f" · {agents}" if agents else "")
                    notify(f"sonar · {title}", body)
                if last != prev:
                    state["notified"][lid] = last
                    changed = True
            if changed:
                save_state(state)

        @objc.python_method
        def maybe_notify_workers(self, workers, state):
            """Notify when a worker FINISHES (definitive — its process exited).
            Deliberately does NOT alert on 'stalled': that's a soft log-quiet
            heuristic prone to false positives during long quiet operations, so it
            stays a passive badge in the UI. Seeds on first sighting to avoid
            alerting for workers that were already done before the menu bar started."""
            changed = False
            seen_ids = set()
            for w in workers:
                wid = w.get("id")
                if not wid:
                    continue
                seen_ids.add(wid)
                status = w.get("status")
                prev = state["workers"].get(wid)
                if prev is None:
                    state["workers"][wid] = status
                    changed = True
                    continue
                if status != prev:
                    if status == "finished":
                        notify("sonar · worker done", f"{w.get('agent', 'worker')} worker on {w.get('link_id')} finished")
                    state["workers"][wid] = status
                    changed = True
            # forget cursors for workers that have aged out of the list
            for wid in [k for k in state["workers"] if k not in seen_ids]:
                del state["workers"][wid]
                changed = True
            if changed:
                save_state(state)

        @objc.python_method
        def dispatch(self, action, p):
            if action == "getState":
                st = gather_state(cfg)
                state = load_state()
                total = 0
                for lk in st.get("links") or []:
                    last = lk.get("last_seq") or 0
                    seen = state["seen"].get(lk["id"], 0)
                    lk["unread"] = max(0, last - seen)
                    lk["seen_seq"] = seen
                    total += lk["unread"]
                st["unread_total"] = total
                workers = st.get("workers") or []
                if self.pop.isShown():
                    # user is looking — don't fire notifications; just seed cursors
                    # so closing the popover later won't re-alert for what they saw.
                    for lk in st.get("links") or []:
                        state["notified"][lk["id"]] = lk.get("last_seq") or 0
                    for w in workers:
                        state["workers"][w["id"]] = w.get("status")
                    save_state(state)
                else:
                    self.maybe_notify(st.get("links") or [], state)
                    self.maybe_notify_workers(workers, state)
                self.setTitleCount(total)
                return st
            if action == "linkDoc":
                hub = Hub(resolve_port()); lid = p["id"]
                doc = hub.get(f"/api/links/{lid}/doc", {}) or {}
                info = hub.get(f"/api/links/{lid}", {}) or {}
                msgs = hub.get(f"/api/links/{lid}/messages?limit=300", []) or []
                wks = hub.get(f"/api/workers?link_id={lid}", []) or []
                panes = hub.get(f"/api/panes?link_id={lid}", []) or []
                last_seq = max([m.get("seq", 0) for m in msgs], default=0)
                state = load_state()
                return {"id": lid, "markdown": doc.get("markdown", ""), "path": doc.get("path"),
                        "messages": msgs, "workers": wks, "panes": panes, "last_seq": last_seq, "seen_seq": state["seen"].get(lid, 0),
                        "participants": info.get("participants", []), "link": info.get("link")}
            if action == "stopWorker":
                try:
                    return Hub(resolve_port())._post(f"/api/workers/{p['id']}/stop", {})
                except Exception as e:
                    return {"ok": False, "error": str(e)}
            if action == "wake":
                try:
                    return Hub(resolve_port())._post("/api/wake", {"link_id": p["link_id"], "label": p["label"], "message": p.get("message"), "force": p.get("force"), "from": "menu-bar"})
                except Exception as e:
                    return {"ok": False, "error": str(e)}
            if action == "attachTmux":
                shell = cfg.get("shell", "zsh")
                subprocess.Popen(["open", "-na", "Ghostty", "--args", "-e", shell, "-lc", "tmux attach -t sonar"])
                return {"ok": True}
            if action == "markSeen":
                state = load_state(); seq = int(p.get("seq") or 0)
                state["seen"][p["id"]] = seq; state["notified"][p["id"]] = seq
                save_state(state); return {"ok": True}
            if action == "removeLink":
                try:
                    Hub(resolve_port())._delete(f"/api/links/{p['id']}")
                except Exception as e:
                    return {"ok": False, "error": str(e)}
                state = load_state()
                state["seen"].pop(p["id"], None); state["notified"].pop(p["id"], None)
                save_state(state); return {"ok": True}
            if action == "kill":
                return Hub(resolve_port())._post("/api/sessions/kill", {"pid": int(p["pid"])})
            if action == "startSession":
                launch_terminal(cfg, p["cwd"], p["agent"]); return {"ok": True}
            if action == "chooseFolderStart":
                d = choose_folder()
                if d:
                    launch_terminal(cfg, d, p["agent"])
                return {"ok": bool(d), "dir": d}
            if action == "openPath":
                subprocess.Popen(["open", p["path"]]); return {"ok": True}
            if action == "reveal":
                subprocess.Popen(["open", "-R", p["path"]]); return {"ok": True}
            if action == "copy":
                proc = subprocess.Popen(["pbcopy"], stdin=subprocess.PIPE)
                proc.communicate(str(p.get("text", "")).encode()); return {"ok": True}
            if action == "openLog":
                subprocess.Popen(["open", str(LOG_PATH)]); return {"ok": True}
            if action == "changelog":
                try:
                    md = (SONAR_DIR / "CHANGELOG.md").read_text()
                except Exception:
                    md = ""
                return {"markdown": md}
            if action in ("startHub", "stopHub"):
                subprocess.Popen([node_path(cfg), "--disable-warning=ExperimentalWarning",
                                  str(SONAR_DIR / "src" / "cli.ts"), "start" if action == "startHub" else "stop"])
                return {"ok": True}
            if action == "setTerminal":
                cfg["terminal"] = p["terminal"]; save_config(cfg); return {"ok": True}
            if action == "toggleLogin":
                if PLIST_PATH.exists():
                    subprocess.run(["launchctl", "unload", "-w", str(PLIST_PATH)], capture_output=True)
                    PLIST_PATH.unlink(missing_ok=True)
                else:
                    write_login_plist()
                    subprocess.run(["launchctl", "load", "-w", str(PLIST_PATH)], capture_output=True)
                return gather_state(cfg)
            if action == "update":
                return self.do_update()
            if action == "quit":
                NSApp.terminate_(None); return {"ok": True}
            return {"error": f"unknown action {action}"}

        @objc.python_method
        def do_update(self):
            sd = str(SONAR_DIR)
            # SAFETY: only pull if SONAR_DIR is the TOP of its own git repo — never a parent repo.
            try:
                top = subprocess.run(["git", "-C", sd, "rev-parse", "--show-toplevel"],
                                     capture_output=True, text=True, timeout=8).stdout.strip()
            except Exception as e:
                return {"ok": False, "error": "git not available", "hint": str(e)}
            if not top or os.path.realpath(top) != os.path.realpath(sd):
                return {"ok": False, "error": "sonar isn't its own git repo",
                        "hint": "Clone the sonar repo standalone (or run git init + push to GitHub) so updates pull the right repo."}
            remotes = subprocess.run(["git", "-C", sd, "remote"], capture_output=True, text=True).stdout.strip()
            if not remotes:
                return {"ok": False, "error": "no git remote configured",
                        "hint": "git remote add origin <github-url>"}
            node = node_path(cfg)
            script = (
                "#!/bin/zsh\n"
                'export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.cargo/bin:/usr/bin:/bin:$PATH"\n'
                f"cd {shlex.quote(sd)} || exit 1\n"
                'echo "=== sonar update $(date) ==="\n'
                "git pull --ff-only\n"
                "npm install --no-audit --no-fund\n"
                "( cd menubar && uv sync )\n"
                f"{shlex.quote(node)} --disable-warning=ExperimentalWarning src/cli.ts stop\n"
                f"{shlex.quote(node)} --disable-warning=ExperimentalWarning src/cli.ts start\n"
                "pkill -f sonar_bar.py\n"
                "sleep 1\n"
                f"{shlex.quote(node)} --disable-warning=ExperimentalWarning src/cli.ts bar\n"
            )
            sh = DATA_DIR / "update.sh"
            sh.write_text(script)
            sh.chmod(0o755)
            logf = open(DATA_DIR / "update.log", "a")
            # detached (own session) so it survives this app being pkilled, then relaunches it
            subprocess.Popen(["zsh", str(sh)], stdout=logf, stderr=logf, start_new_session=True)
            return {"ok": True}

    app = NSApplication.sharedApplication()
    delegate = Delegate.alloc().init()
    app.setDelegate_(delegate)
    AppHelper.runEventLoop()


# --------------------------------------------------------------------------
def main():
    cfg = load_config()
    if not CONFIG_PATH.exists():
        save_config(cfg)
    if "--selftest" in sys.argv:
        run_selftest(cfg)
        return
    run_gui(cfg)


if __name__ == "__main__":
    main()
