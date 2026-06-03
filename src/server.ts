import express from 'express';
import type { Request, Response } from 'express';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
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
import { HOST, PORT, VERSION, PID_PATH } from './config.ts';

const transports: Record<string, StreamableHTTPServerTransport> = {};

function buildMcpServer(): McpServer {
  const server = new McpServer({ name: 'sonar', version: VERSION });
  registerTools(server);
  return server;
}

export function startServer() {
  const app = express();
  app.use(express.json({ limit: '8mb' }));

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
      await buildMcpServer().connect(transport);
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
      res.status(400).json({ error: (e as Error).message });
    }
  };

  app.get('/health', (_req, res) => res.json({ ok: true, version: VERSION, ...core.stats() }));

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
      const since = req.query.since ? Number(req.query.since) : 0;
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      res.json(core.readMessages({ linkId: req.params.id, sinceSeq: since, limit }));
    })
  );

  app.get(
    '/api/links/:id/wait',
    wrap(async (req, res) => {
      const r = await core.waitForMessages({
        linkId: req.params.id,
        from: req.query.from as string | undefined,
        afterSeq: req.query.after ? Number(req.query.after) : 0,
        timeoutMs: req.query.timeout ? Number(req.query.timeout) : undefined,
      });
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
          sinceDays: req.query.since_days ? Number(req.query.since_days) : undefined,
          limit: req.query.limit ? Number(req.query.limit) : undefined,
        })
      );
    })
  );

  // ---- session control (for the menu bar app) ----
  app.get(
    '/api/sessions',
    wrap(async (req, res) => {
      const recent = req.query.recent ? Number(req.query.recent) : undefined;
      const activeSecs = req.query.active_secs ? Number(req.query.active_secs) : undefined;
      res.json(await sessions.listSessions({ recent, activeSecs }));
    })
  );

  app.get(
    '/api/procs',
    wrap(async (_req, res) => res.json(await sessions.detectAgentProcs()))
  );

  app.post(
    '/api/sessions/kill',
    wrap(async (req, res) => {
      const b = req.body || {};
      if (!b.pid) return res.status(400).json({ error: 'pid required' });
      res.json(await sessions.killSession(Number(b.pid), b.signal));
    })
  );

  app.get(
    '/api/repos',
    wrap((req, res) => res.json(sessions.listRepos(req.query.limit ? Number(req.query.limit) : undefined)))
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
      const b = req.body || {};
      if (!core.linkExists(req.params.id)) return res.status(404).json({ error: 'no such link' });
      res.json(await spawnWorker({ linkId: req.params.id, task: b.task || 'collaborate on the shared doc', agent: b.agent, cwd: b.cwd, headless: b.headless, dryRun: b.dryRun }));
    })
  );

  app.post(
    '/api/reindex',
    wrap((_req, res) => {
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
    wrap(async (req, res) => res.json(await stopWorker(req.params.id)))
  );

  // ---- live panes (tmux) + waking a paused agent by typing into its pane ----
  app.get(
    '/api/panes',
    wrap(async (req, res) => res.json(await listPanes(req.query.link_id as string | undefined)))
  );

  app.post(
    '/api/wake',
    wrap(async (req, res) => {
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
    wrap(async (req, res) => res.json(await pruneWorktree(req.params.name)))
  );

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
