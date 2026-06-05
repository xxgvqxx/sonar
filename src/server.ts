import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import fs from 'node:fs';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { registerTools } from './tools.ts';
import * as core from './core.ts';
import * as sessions from './sessions.ts';
import * as docs from './docs.ts';
import { spawnWorker, listWorktrees, pruneWorktree, listWorkers, stopWorker } from './spawn.ts';
import { listPanes, wake } from './tmux.ts';
import { startIndexer, reindexAll } from './indexer.ts';
import * as tokens from './tokens.ts';
import { HOST, PORT, VERSION, PID_PATH, getToken, isLoopbackAddr, allowRemoteExec, isExposed, setExposed } from './config.ts';

/** Parse a query param as a finite number, else undefined (so NaN never reaches core/SQL/setTimeout). */
function numQ(v: unknown): number | undefined {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

const transports: Record<string, StreamableHTTPServerTransport> = {};

function buildMcpServer(remoteAddr?: string, relay = false): McpServer {
  const server = new McpServer({ name: 'sonar', version: VERSION });
  // Pass the connecting client's address + whether this is a RELAY session (authenticated with a
  // per-member token, i.e. a remote teammate over a tunnel/LAN). Relay sessions get coordination
  // tools only — host-private tools (search_context/recent_sessions/spawn_worker) are refused, since
  // a tunnel makes a teammate look like loopback and IP alone can't tell them apart from the host.
  registerTools(server, { remoteAddr, relay });
  return server;
}

/** Constant-time token compare (length-guarded so timingSafeEqual gets equal-length buffers). */
function tokenMatches(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Pull a bearer/X-Sonar-Token credential off the request, if present. */
function suppliedToken(req: Request): string | undefined {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  const x = req.headers['x-sonar-token'];
  if (typeof x === 'string' && x.length) return x.trim();
  return undefined;
}

/**
 * Guard for endpoints that run code / kill / mutate the host. Loopback callers always pass.
 * Non-loopback callers are refused (403) unless SONAR_ALLOW_REMOTE_EXEC is truthy.
 * Returns false (and sends 403) when the caller must be blocked.
 */
function requireLocalExec(req: Request, res: Response): boolean {
  if (isLoopbackAddr(req.socket.remoteAddress) || allowRemoteExec()) return true;
  res.status(403).json({ error: 'remote exec disabled: this endpoint runs code on the hub host. Set SONAR_ALLOW_REMOTE_EXEC=1 to permit.' });
  return false;
}

/** Did this request present the ADMIN credential (the single env/config token), or is it a genuinely
 *  local call on a non-exposed hub? Admin gates token management + the expose toggle. Note: in exposed
 *  mode loopback alone is NOT trusted (a tunnel masquerades as loopback) — only the admin token is. */
function isAdminReq(req: Request): boolean {
  const single = getToken();
  const supplied = suppliedToken(req);
  if (single && supplied && tokenMatches(supplied, single)) return true;
  if (isLoopbackAddr(req.socket.remoteAddress) && !isExposed()) return true;
  return false;
}
function requireAdmin(req: Request, res: Response): boolean {
  if (isAdminReq(req)) return true;
  res.status(403).json({ error: 'admin only: run on the hub host or present the admin token (SONAR_TOKEN). Per-member tokens cannot manage the hub.' });
  return false;
}

export function startServer() {
  const app = express();
  app.use(express.json({ limit: '8mb' }));

  // ---- auth (covers /mcp and /api, NOT /health) -------------------------------
  // A request is authed if it presents the admin token (env/config SONAR_TOKEN) or any active
  // per-member token. Modes:
  //  • EXPOSED (tunnel / LAN): every caller must be authed — loopback is NOT exempt, because a
  //    tunnel forwards external traffic to loopback and is otherwise indistinguishable from local.
  //  • not exposed (default, loopback-only bind): local callers are exempt; a remote caller needs a
  //    valid token, or is allowed only when no auth is configured at all (legacy open default).
  app.use(['/mcp', '/api'], (req: Request, res: Response, next: NextFunction) => {
    const supplied = suppliedToken(req);
    const single = getToken();
    const validSingle = !!(single && supplied && tokenMatches(supplied, single));
    const authed = validSingle || (!!supplied && !!tokens.verifyToken(supplied));
    if (isExposed()) {
      if (authed) return next();
      return res.status(401).json({ error: 'unauthorized: present a valid sonar token (Authorization: Bearer <token>)' });
    }
    if (isLoopbackAddr(req.socket.remoteAddress)) return next();
    if (!single && !tokens.anyActive()) return next(); // legacy open default (loopback-only bind)
    if (authed) return next();
    res.status(401).json({ error: 'unauthorized: present a valid sonar token (Authorization: Bearer <token>)' });
  });

  // ---- MCP (Streamable HTTP) — one server connection per client session ----
  app.post('/mcp', async (req: Request, res: Response) => {
    const sid = req.headers['mcp-session-id'] as string | undefined;
    let transport: StreamableHTTPServerTransport;
    if (sid && transports[sid]) {
      transport = transports[sid];
    } else if (!sid && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports[id] = transport;
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) delete transports[transport.sessionId];
      };
      // A session is "full" only if it presents the admin token or is a genuinely local call on a
      // non-exposed hub; everything else (per-member token, any remote) is a coordination-only relay.
      const relay = !isAdminReq(req);
      await buildMcpServer(req.socket.remoteAddress, relay).connect(transport);
    } else {
      res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: no valid session ID' }, id: null });
      return;
    }
    await transport.handleRequest(req, res, req.body);
  });

  const sessionStream = async (req: Request, res: Response) => {
    const sid = req.headers['mcp-session-id'] as string | undefined;
    if (!sid || !transports[sid]) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }
    await transports[sid].handleRequest(req, res);
  };
  app.get('/mcp', sessionStream);
  app.delete('/mcp', sessionStream);

  // ---- REST API (for the sonar CLI and /loop watchers) ----
  const wrap = (fn: (req: Request, res: Response) => any) => async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (e) {
      if (res.headersSent) return; // a response was already (partly) sent — don't double-send
      res.status(400).json({ error: (e as Error).message });
    }
  };

  app.get('/health', (_req, res) => res.json({ ok: true, version: VERSION, exposed: isExposed(), ...core.stats() }));

  // ---- admin: expose toggle + per-member token management (admin-only) ----
  app.post(
    '/api/admin/expose',
    wrap((req, res) => {
      if (!requireAdmin(req, res)) return;
      setExposed(!!(req.body || {}).on);
      res.json({ exposed: isExposed() });
    })
  );
  app.get(
    '/api/admin/tokens',
    wrap((req, res) => {
      if (!requireAdmin(req, res)) return;
      res.json({ exposed: isExposed(), tokens: tokens.listTokens() });
    })
  );
  app.post(
    '/api/admin/tokens',
    wrap((req, res) => {
      if (!requireAdmin(req, res)) return;
      res.json(tokens.createToken(String((req.body || {}).name || '')));
    })
  );
  app.post(
    '/api/admin/tokens/revoke',
    wrap((req, res) => {
      if (!requireAdmin(req, res)) return;
      res.json(tokens.revokeToken(String((req.body || {}).token || '')));
    })
  );

  app.post(
    '/api/links',
    wrap((req, res) => {
      const b = req.body || {};
      res.json(core.createLink({ title: b.title, who: { label: b.label || 'anon', agent: b.agent, repo: b.repo, branch: b.branch, cwd: b.cwd } }));
    })
  );

  app.get(
    '/api/links',
    wrap((_req, res) => res.json(core.listLinks({ activeDays: 30 })))
  );

  app.get(
    '/api/links/:id',
    wrap((req, res) => {
      if (!core.linkExists(req.params.id)) return res.status(404).json({ error: 'no such link' });
      res.json({ link: core.getLink(req.params.id), participants: core.listParticipants(req.params.id) });
    })
  );

  app.post(
    '/api/links/:id/join',
    wrap((req, res) => {
      const b = req.body || {};
      res.json(core.joinLink({ linkId: req.params.id, who: { label: b.label || 'anon', agent: b.agent, repo: b.repo, branch: b.branch, cwd: b.cwd } }));
    })
  );

  app.post(
    '/api/links/:id/messages',
    wrap((req, res) => {
      const b = req.body || {};
      res.json(core.postMessage({ linkId: req.params.id, from: b.from || 'anon', body: b.body || '', agent: b.agent, branch: b.branch, replyTo: b.reply_to }));
    })
  );

  app.get(
    '/api/links/:id/messages',
    wrap((req, res) => {
      res.json(core.readMessages({ linkId: req.params.id, sinceSeq: numQ(req.query.since) ?? 0, limit: numQ(req.query.limit) }));
    })
  );

  app.get(
    '/api/links/:id/wait',
    wrap(async (req, res) => {
      // Cancel the long-poll if the client hangs up, so the waiter is unregistered immediately
      // instead of lingering until timeout. (settle() is idempotent, so a close after a normal
      // response is a harmless no-op.)
      const ac = new AbortController();
      res.on('close', () => ac.abort());
      const r = await core.waitForMessages({
        linkId: req.params.id,
        from: req.query.from as string | undefined,
        afterSeq: numQ(req.query.after) ?? 0,
        timeoutMs: numQ(req.query.timeout),
        signal: ac.signal,
      });
      if (r.aborted || res.headersSent) return; // client gone — nothing to send
      res.json(r);
    })
  );

  app.get(
    '/api/search',
    wrap((req, res) => {
      res.json(
        core.searchContext({
          query: String(req.query.q || ''),
          branch: req.query.branch as string | undefined,
          repo: req.query.repo as string | undefined,
          agent: req.query.agent as string | undefined,
          sessionId: req.query.session_id as string | undefined,
          sinceDays: numQ(req.query.since_days),
          limit: numQ(req.query.limit),
        })
      );
    })
  );

  // ---- session control (for the menu bar app) ----
  app.get(
    '/api/sessions',
    wrap(async (req, res) => {
      res.json(await sessions.listSessions({ recent: numQ(req.query.recent), activeSecs: numQ(req.query.active_secs) }));
    })
  );

  app.get(
    '/api/procs',
    wrap(async (_req, res) => res.json(await sessions.detectAgentProcs()))
  );

  app.post(
    '/api/sessions/kill',
    wrap(async (req, res) => {
      if (!requireLocalExec(req, res)) return;
      const b = req.body || {};
      if (!b.pid) return res.status(400).json({ error: 'pid required' });
      res.json(await sessions.killSession(Number(b.pid), b.signal));
    })
  );

  app.get(
    '/api/repos',
    wrap((req, res) => res.json(sessions.listRepos(numQ(req.query.limit))))
  );

  app.delete(
    '/api/links/:id',
    wrap((req, res) => {
      const r = core.deleteLink(req.params.id);
      docs.removeDoc(req.params.id);
      res.json(r);
    })
  );

  // ---- shared doc + worker spawn ----
  app.get(
    '/api/links/:id/doc',
    wrap((req, res) => {
      if (!core.linkExists(req.params.id)) return res.status(404).json({ error: 'no such link' });
      res.json({ path: docs.docPath(req.params.id), markdown: docs.readDoc(req.params.id) });
    })
  );

  app.post(
    '/api/links/:id/doc/append',
    wrap((req, res) => {
      if (!core.linkExists(req.params.id)) return res.status(404).json({ error: 'no such link' });
      const b = req.body || {};
      docs.appendToSection(req.params.id, b.section || 'Log', b.text || '', b.from);
      if (b.from) core.postMessage({ linkId: req.params.id, from: b.from, body: `📝 updated doc → ${b.section}` });
      res.json({ ok: true, path: docs.docPath(req.params.id) });
    })
  );

  app.post(
    '/api/links/:id/spawn',
    wrap(async (req, res) => {
      if (!requireLocalExec(req, res)) return;
      const b = req.body || {};
      if (!core.linkExists(req.params.id)) return res.status(404).json({ error: 'no such link' });
      res.json(await spawnWorker({ linkId: req.params.id, task: b.task || 'collaborate on the shared doc', agent: b.agent, cwd: b.cwd, headless: b.headless, dryRun: b.dryRun }));
    })
  );

  // ---- claims (read-only; powers `sonar guard` pre-commit enforcement) ----
  app.get(
    '/api/links/:id/claims',
    wrap((req, res) => {
      if (!core.linkExists(req.params.id)) return res.status(404).json({ error: 'no such link' });
      res.json(core.listClaims(req.params.id));
    })
  );

  app.post(
    '/api/links/:id/claims/check',
    wrap((req, res) => {
      if (!core.linkExists(req.params.id)) return res.status(404).json({ error: 'no such link' });
      const b = req.body || {};
      const paths = Array.isArray(b.paths) ? b.paths.map(String) : [];
      res.json({ conflicts: core.checkClaimConflicts({ linkId: req.params.id, holder: b.holder, paths }) });
    })
  );

  app.post(
    '/api/reindex',
    wrap((req, res) => {
      if (!requireLocalExec(req, res)) return; // full-disk rescan of ~/.claude + ~/.codex — host-side work
      reindexAll();
      res.json({ ok: true, ...core.stats() });
    })
  );

  app.get(
    '/api/workers',
    wrap(async (req, res) => res.json(await listWorkers(req.query.link_id as string | undefined)))
  );

  app.post(
    '/api/workers/:id/stop',
    wrap(async (req, res) => {
      if (!requireLocalExec(req, res)) return;
      res.json(await stopWorker(req.params.id));
    })
  );

  // ---- live panes (tmux) + waking a paused agent by typing into its pane ----
  app.get(
    '/api/panes',
    wrap(async (req, res) => res.json(await listPanes(req.query.link_id as string | undefined)))
  );

  app.post(
    '/api/wake',
    wrap(async (req, res) => {
      if (!requireLocalExec(req, res)) return;
      const b = req.body || {};
      if (!b.link_id || !b.label) return res.status(400).json({ ok: false, error: 'link_id and label required' });
      const r = await wake({ linkId: b.link_id, label: b.label, message: b.message, force: b.force });
      if (r.ok) {
        try {
          core.postMessage({ linkId: b.link_id, from: b.from || 'sonar', body: `⏰ woke ${b.label} (typed a prompt into its live pane)` });
        } catch {
          /* non-fatal */
        }
      }
      res.json(r);
    })
  );

  app.get(
    '/api/worktrees',
    wrap(async (_req, res) => res.json(await listWorktrees()))
  );

  app.delete(
    '/api/worktrees/:name',
    wrap(async (req, res) => {
      if (!requireLocalExec(req, res)) return;
      res.json(await pruneWorktree(req.params.name));
    })
  );

  // Terminal error handler: catches errors raised by middleware BEFORE a route runs
  // (e.g. express.json's 413 PayloadTooLarge / 400 malformed-JSON), which wrap() can't see.
  // Without this they hit Express's default handler (plain-text 500 + a stack frame).
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    res.status(err?.status || err?.statusCode || 400).json({ error: err?.message || 'bad request' });
  });

  const server = app.listen(PORT, HOST, () => {
    startIndexer();
    console.log(`sonar hub listening on http://${HOST}:${PORT}  (MCP: /mcp)`);
  });
  server.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`sonar: port ${PORT} is already in use. Run "sonar port auto" to move to a free port.`);
    } else {
      console.error(`sonar server error: ${e.message}`);
    }
    try {
      fs.unlinkSync(PID_PATH);
    } catch {}
    process.exit(1);
  });
  server.requestTimeout = 0; // allow long-poll holds
  return server;
}
