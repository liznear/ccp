import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { promisify } from "node:util";

export interface ReviewComment {
	file: string;
	line: string;
	side: "old" | "new";
	comment: string;
}

export interface WebReviewServerOptions {
	cwd: string;
	target?: string;
	targetLabel?: string;
	port?: number;
	onSubmit?: (comments: ReviewComment[]) => void | Promise<void>;
}

export interface WebReviewServer {
	port: number;
	url: string;
	server: http.Server;
	close: () => Promise<void>;
}

interface RenderedFile {
	path: string;
	hunks: RenderedHunk[];
}

interface RenderedHunk {
	header: string;
	oldStart: number;
	oldCount: number;
	newStart: number;
	newCount: number;
	lines: RenderedLine[];
}

interface RenderedLine {
	type: "context" | "added" | "removed";
	oldLine?: number;
	newLine?: number;
	content: string;
}

const run = promisify(execFile);

export async function resolveGitTarget(cwd: string, target = "HEAD"): Promise<string | null> {
	const normalizedTarget = target.trim() || "HEAD";
	try {
		return (await run("git", ["rev-parse", "--verify", "--short=8", `${normalizedTarget}^{commit}`], { cwd, maxBuffer: 1024 * 1024 })).stdout.trim();
	} catch {
		return null;
	}
}

export async function getGitDiff(cwd: string, target = "HEAD"): Promise<string> {
	const normalizedTarget = target.trim() || "HEAD";
	try {
		return (await run("git", ["diff", normalizedTarget], { cwd, maxBuffer: 10 * 1024 * 1024 })).stdout;
	} catch {
		return "";
	}
}

export async function createWebReviewServer(options: WebReviewServerOptions): Promise<WebReviewServer> {
	const server = http.createServer((req, res) => {
		void handleRequest(req, res, options);
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port ?? 0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Failed to bind web review server");

	return {
		port: address.port,
		url: `http://localhost:${address.port}`,
		server,
		close: () => new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve())),
	};
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, options: WebReviewServerOptions): Promise<void> {
	res.setHeader("Access-Control-Allow-Origin", "*");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type");

	if (req.method === "OPTIONS") {
		res.writeHead(204);
		res.end();
		return;
	}

	const url = new URL(req.url || "/", "http://localhost");

	if (url.pathname === "/" && req.method === "GET") {
		const diff = await getGitDiff(options.cwd, options.target);
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		res.end(renderReviewPage({
			diff,
			target: options.target || "HEAD",
			targetLabel: options.targetLabel || options.target || "HEAD",
			cwd: options.cwd,
			submitEnabled: Boolean(options.onSubmit),
		}));
		return;
	}

	if (url.pathname === "/context" && req.method === "GET") {
		try {
			const file = String(url.searchParams.get("file") || "");
			const oldStart = Number(url.searchParams.get("oldStart") || "0");
			const oldEnd = Number(url.searchParams.get("oldEnd") || "0");
			const newStart = Number(url.searchParams.get("newStart") || "0");
			const newEnd = Number(url.searchParams.get("newEnd") || "0");
			const rows = await loadGapContext({
				cwd: options.cwd,
				target: options.target || "HEAD",
				file,
				oldStart,
				oldEnd,
				newStart,
				newEnd,
			});
			res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
			res.end(JSON.stringify({ rows }));
		} catch (err) {
			res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
			res.end(JSON.stringify({ error: err instanceof Error ? err.message : "Invalid context request" }));
		}
		return;
	}

	if (url.pathname === "/submit" && req.method === "POST") {
		try {
			const comments = parseComments(await readRequestBody(req));
			if (options.onSubmit) await options.onSubmit(comments);
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ success: true, comments: comments.length }));
		} catch (err) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ success: false, error: err instanceof Error ? err.message : "Invalid request" }));
		}
		return;
	}

	if (url.pathname === "/close" && req.method === "POST") {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ success: true }));
		return;
	}

	res.writeHead(404);
	res.end("Not found");
}

function readRequestBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk.toString();
			if (body.length > 1024 * 1024) {
				reject(new Error("Request body too large"));
				req.destroy();
			}
		});
		req.on("end", () => resolve(body));
		req.on("error", reject);
	});
}

function parseComments(body: string): ReviewComment[] {
	const parsed = JSON.parse(body);
	if (!Array.isArray(parsed)) throw new Error("Expected an array of comments");
	return parsed.map((item) => ({
		file: String(item.file || ""),
		line: String(item.line || ""),
		side: item.side === "old" ? "old" : "new",
		comment: String(item.comment || ""),
	})).filter((item) => item.file && item.line && item.comment.trim());
}

function renderReviewPage(input: { diff: string; target: string; targetLabel: string; cwd: string; submitEnabled: boolean }): string {
	const files = parseUnifiedDiff(input.diff);
	const encodedFiles = JSON.stringify(files).replace(/</g, "\\u003c");
	const emptyState = files.length === 0
		? `<div class="empty">No diff output for <code>${escapeHtml(input.targetLabel)}</code>.</div>`
		: "";

	return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Review</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/github.min.css" />
  <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/highlight.min.js"></script>
  <style>
    :root {
      --bg: #f6f8fa;
      --card: #fff;
      --border: #d0d7de;
      --muted: #57606a;
      --text: #1f2328;
      --blue: #0969da;
      --green-bg: #e6ffec;
      --red-bg: #ffebe9;
      --hunk-bg: #ddf4ff;
      --gap-bg: #f6f8fa;
      --comment-header-bg: #f6f8fa;
      --comment-body-bg: #fff;
      --comment-text: #1f2328;
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--text);
      background: var(--bg);
      font-family: monospace;
      font-size: 14px;
    }
    code, pre, .diff, .line-code, .line-number, textarea {
      font-family: monospace;
    }
    .page {
      max-width: 1600px;
      margin: 0 auto;
      padding: 16px;
    }
    .toolbar {
      position: sticky;
      top: 0;
      z-index: 20;
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: center;
      margin-bottom: 12px;
      padding: 12px 16px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.96);
      backdrop-filter: blur(8px);
    }
    h1 {
      margin: 0;
      font-size: 18px;
    }
    .meta {
      margin-top: 4px;
      color: var(--muted);
      font-size: 12px;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 8px;
    }
    .btn {
      border: 1px solid rgba(31, 35, 40, 0.15);
      border-radius: 6px;
      background: #f6f8fa;
      color: var(--text);
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
      padding: 6px 12px;
    }
    .btn:hover { background: #eef1f4; }
    .btn-primary {
      background: #1a7f37;
      color: #fff;
    }
    .btn-primary:hover { background: #197935; }
    .btn-danger {
      background: #fff;
      color: #cf222e;
      border-color: #cf222e;
    }
    .file {
      overflow: hidden;
      margin-bottom: 12px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--card);
    }
    .file-header {
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      background: #f6f8fa;
      font-weight: 600;
    }
    table.diff {
      width: 100%;
      border-collapse: collapse;
      border-spacing: 0;
      table-layout: fixed;
    }
    table.diff,
    table.diff tbody,
    table.diff tr,
    table.diff td {
      border: 0;
    }
    col.line-no { width: 56px; }
    col.code { width: calc(50% - 56px); }

    tr.hunk-header td {
      padding: 4px 10px;
      background: var(--hunk-bg);
      border-top: 1px solid var(--border);
      border-bottom: 1px solid var(--border);
      color: #0550ae;
      font-size: 12px;
    }

    tr.diff-row td { border-bottom: 0; vertical-align: top; }
    td.line-number {
      position: relative;
      color: var(--muted);
      text-align: right;
      user-select: none;
      padding: 2px 8px;
      background: transparent;
      white-space: nowrap;
    }
    td.line-code {
      padding: 2px 10px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      line-height: 1.45;
      background: transparent;
    }
    td.line-number.empty,
    td.line-code.empty {
      background: #f6f8fa;
    }

    td.line-number.added,
    td.line-code.added { background: var(--green-bg); }
    td.line-number.removed,
    td.line-code.removed { background: var(--red-bg); }

    .line-prefix {
      display: inline-block;
      width: 14px;
      color: var(--muted);
      user-select: none;
      margin-right: 2px;
    }

    .comment-trigger {
      display: none;
      position: absolute;
      left: 4px;
      top: 50%;
      width: 16px;
      height: 16px;
      transform: translateY(-50%);
      border: 1px solid #1f6feb;
      border-radius: 999px;
      background: #2f81f7;
      color: #fff;
      cursor: pointer;
      font-size: 12px;
      font-weight: 700;
      line-height: 14px;
      padding: 0;
      text-align: center;
    }
    td.line-number:hover .comment-trigger,
    .comment-trigger:focus-visible {
      display: inline-block;
    }

    .review-comment {
      margin-top: 8px;
      border: 1px solid var(--border);
      border-radius: 6px;
      overflow: hidden;
      background: var(--comment-body-bg);
    }
    .review-comment-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      padding: 6px 8px;
      border-bottom: 1px solid var(--border);
      background: var(--comment-header-bg);
      color: var(--muted);
      font-size: 12px;
    }
    .review-comment-author {
      color: var(--text);
      font-weight: 600;
    }
    .review-comment-actions {
      display: flex;
      gap: 6px;
      margin-left: auto;
    }
    .review-comment-btn {
      border: 1px solid var(--border);
      border-radius: 6px;
      background: #fff;
      color: var(--blue);
      cursor: pointer;
      font-size: 11px;
      font-weight: 600;
      line-height: 1;
      padding: 4px 6px;
    }
    .review-comment-btn.delete { color: #cf222e; }
    .review-comment-body {
      padding: 8px;
      color: var(--comment-text);
      font-size: 13px;
      white-space: pre-wrap;
    }

    tr.comment-row td {
      padding: 8px;
      border-top: 1px solid #d4a72c;
      border-bottom: 1px solid #d4a72c;
      vertical-align: top;
    }
    tr.comment-row td.comment-fill {
      background: #f6f8fa;
    }
    tr.comment-row td.comment-cell {
      background: #fff8c5;
    }
    .comment-box {
      width: 100%;
      border: 1px solid #d4a72c;
      border-radius: 6px;
      background: #fff;
      padding: 8px;
    }
    .comment-box textarea {
      width: 100%;
      min-height: 76px;
      resize: vertical;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 8px;
      font: inherit;
      font-size: 13px;
    }
    .comment-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 8px;
    }

    tr.gap-row td {
      background: var(--gap-bg);
      border-top: 1px solid var(--border);
      border-bottom: 1px solid var(--border);
      text-align: center;
      padding: 6px;
    }
    .gap-btn {
      border: 1px solid var(--border);
      border-radius: 6px;
      background: #fff;
      color: var(--blue);
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
      padding: 4px 10px;
    }
    .gap-btn[disabled] { opacity: 0.7; cursor: default; }

    .empty {
      padding: 32px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--card);
      color: var(--muted);
      text-align: center;
    }

    .code-content,
    .code-content.hljs,
    .code-content.hljs * {
      display: inline;
      padding: 0;
      background: transparent;
      font-family: inherit;
    }

    @media (max-width: 900px) {
      .toolbar { align-items: flex-start; flex-direction: column; }
      .actions { justify-content: flex-start; }
      col.line-no { width: 46px; }
      col.code { width: calc(50% - 46px); }
    }
  </style>
</head>
<body>
  <div class="page">
    <div class="toolbar">
      <div>
        <h1>Changes since ${escapeHtml(input.targetLabel)}</h1>
        <div class="meta">${escapeHtml(input.cwd)} · diff target <code>${escapeHtml(input.target)}</code> (resolved from <code>${escapeHtml(input.targetLabel)}</code>)</div>
      </div>
      <div class="actions">
        <button class="btn" id="reload">Reload diff</button>
        <button class="btn btn-danger" id="close">Close review</button>
        <button class="btn btn-primary" id="submit">${input.submitEnabled ? "Send comments" : "Log comments"}</button>
      </div>
    </div>
    ${emptyState}
    <div id="diff-root"></div>
  </div>
  <script>
    const files = ${encodedFiles};
    const comments = new Map();
    let openEditorKey = null;

    function escapeHtml(input) {
      return String(input || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }

    function rowKey(file, side, line) {
      return file + "::" + side + "::" + line;
    }

    function closeEditor() {
      const existing = document.querySelector("tr.comment-row");
      if (existing) existing.remove();
      openEditorKey = null;
    }

    function detectLanguage(fileName) {
      const lower = String(fileName || "").toLowerCase();
      if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "typescript";
      if (lower.endsWith(".js") || lower.endsWith(".jsx") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "javascript";
      if (lower.endsWith(".json")) return "json";
      if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
      if (lower.endsWith(".nix")) return "nix";
      if (lower.endsWith(".sh") || lower.endsWith(".bash")) return "bash";
      if (lower.endsWith(".yml") || lower.endsWith(".yaml")) return "yaml";
      if (lower.endsWith(".toml")) return "toml";
      if (lower.endsWith(".css")) return "css";
      if (lower.endsWith(".html") || lower.endsWith(".htm")) return "xml";
      return "";
    }

    function applySyntaxHighlighting() {
      if (!window.hljs) return;
      document.querySelectorAll("code.code-content").forEach((node) => {
        try { window.hljs.highlightElement(node); } catch {}
      });
    }

    function makeSide(kind, line, content) {
      return { kind, line, content };
    }

    function buildSplitRows(hunk) {
      const rows = [];
      const lines = hunk.lines || [];
      let i = 0;
      while (i < lines.length) {
        const current = lines[i];

        if (current.type === "removed") {
          const removed = [];
          while (i < lines.length && lines[i].type === "removed") removed.push(lines[i++]);
          const added = [];
          while (i < lines.length && lines[i].type === "added") added.push(lines[i++]);
          const maxRows = Math.max(removed.length, added.length);
          for (let idx = 0; idx < maxRows; idx++) {
            const left = removed[idx] ? makeSide("removed", removed[idx].oldLine, removed[idx].content) : null;
            const right = added[idx] ? makeSide("added", added[idx].newLine, added[idx].content) : null;
            rows.push({ type: "diff", rowKind: added.length > 0 ? "changed" : "removed", left, right });
          }
          continue;
        }

        if (current.type === "added") {
          const added = [];
          while (i < lines.length && lines[i].type === "added") added.push(lines[i++]);
          for (const line of added) {
            rows.push({
              type: "diff",
              rowKind: "added",
              left: null,
              right: makeSide("added", line.newLine, line.content),
            });
          }
          continue;
        }

        rows.push({
          type: "diff",
          rowKind: "context",
          left: makeSide("context", current.oldLine, current.content),
          right: makeSide("context", current.newLine, current.content),
        });
        i++;
      }
      return rows;
    }

    function renderComment(comment, key) {
      if (!comment) return "";
      return '<div class="review-comment" data-comment-key="' + escapeHtml(key) + '">' +
        '<div class="review-comment-header">' +
          '<span><span class="review-comment-author">You</span> commented</span>' +
          '<div class="review-comment-actions">' +
            '<button class="review-comment-btn edit" type="button" data-action="edit-comment" data-key="' + escapeHtml(key) + '">Edit</button>' +
            '<button class="review-comment-btn delete" type="button" data-action="delete-comment" data-key="' + escapeHtml(key) + '">Delete</button>' +
          '</div>' +
        '</div>' +
        '<div class="review-comment-body">' + escapeHtml(comment.comment) + '</div>' +
      '</div>';
    }

    function renderSideCells(filePath, side, data, languageClass) {
      if (!data) {
        return '<td class="line-number empty"></td><td class="line-code empty"></td>';
      }

      const line = String(data.line || "");
      const key = rowKey(filePath, side, line);
      const comment = comments.get(key);
      const marker = data.kind === "added" ? "+" : data.kind === "removed" ? "-" : " ";

      return '<td class="line-number ' + data.kind + '">' +
          '<button class="comment-trigger" type="button" title="Add comment" aria-label="Add comment" data-file="' + escapeHtml(filePath) + '" data-side="' + side + '" data-line="' + escapeHtml(line) + '">+</button>' +
          escapeHtml(line) +
        '</td>' +
        '<td class="line-code ' + data.kind + '">' +
          '<span class="line-prefix">' + marker + '</span><code class="code-content' + languageClass + '">' + escapeHtml(data.content || "") + '</code>' +
          renderComment(comment, key) +
        '</td>';
    }

    function renderDiffRow(filePath, row, languageClass, rowId) {
      if (row.type === "hunk") {
        return '<tr class="hunk-header" data-row-id="' + rowId + '"><td colspan="4">' + escapeHtml(row.header) + '</td></tr>';
      }
      if (row.type === "gap") {
        return '<tr class="gap-row" data-row-id="' + rowId + '" data-file="' + escapeHtml(filePath) + '" data-old-start="' + row.oldStart + '" data-old-end="' + row.oldEnd + '" data-new-start="' + row.newStart + '" data-new-end="' + row.newEnd + '" data-hidden="' + row.hidden + '">' +
          '<td colspan="4"><button class="gap-btn" type="button" data-action="expand-gap">Show ' + row.hidden + ' hidden lines</button></td>' +
        '</tr>';
      }

      return '<tr class="diff-row ' + row.rowKind + '" data-row-id="' + rowId + '">' +
        renderSideCells(filePath, "old", row.left, languageClass) +
        renderSideCells(filePath, "new", row.right, languageClass) +
      '</tr>';
    }

    function collapseContextRows(rows, filePath) {
      const collapsed = [];
      const keepEdge = 3;
      const collapseThreshold = keepEdge * 2 + 1;
      let i = 0;

      while (i < rows.length) {
        const row = rows[i];
        if (row.rowKind !== "context") {
          collapsed.push(row);
          i++;
          continue;
        }

        const runStart = i;
        while (i < rows.length && rows[i].rowKind === "context") i++;
        const run = rows.slice(runStart, i);

        if (run.length < collapseThreshold) {
          collapsed.push(...run);
          continue;
        }

        const left = run[keepEdge];
        const right = run[run.length - keepEdge - 1];
        const oldStart = left?.left?.line || 0;
        const oldEnd = right?.left?.line || 0;
        const newStart = left?.right?.line || 0;
        const newEnd = right?.right?.line || 0;
        const hidden = run.length - keepEdge * 2;

        collapsed.push(...run.slice(0, keepEdge));
        collapsed.push({
          type: "gap",
          file: filePath,
          oldStart,
          oldEnd,
          newStart,
          newEnd,
          hidden,
        });
        collapsed.push(...run.slice(run.length - keepEdge));
      }

      return collapsed;
    }

    function buildRowsForFile(file) {
      const rows = [];
      for (let idx = 0; idx < file.hunks.length; idx++) {
        const hunk = file.hunks[idx];
        rows.push({ type: "hunk", header: hunk.header });
        rows.push(...collapseContextRows(buildSplitRows(hunk), file.path));

        const nextHunk = file.hunks[idx + 1];
        if (nextHunk) {
          const oldStart = hunk.oldStart + hunk.oldCount;
          const oldEnd = nextHunk.oldStart - 1;
          const newStart = hunk.newStart + hunk.newCount;
          const newEnd = nextHunk.newStart - 1;
          const hiddenOld = oldEnd >= oldStart ? (oldEnd - oldStart + 1) : 0;
          const hiddenNew = newEnd >= newStart ? (newEnd - newStart + 1) : 0;
          const hidden = Math.max(hiddenOld, hiddenNew);
          if (hidden > 0) {
            rows.push({ type: "gap", file: file.path, oldStart, oldEnd, newStart, newEnd, hidden });
          }
        }
      }
      return rows;
    }

    function renderDiff() {
      const root = document.getElementById("diff-root");
      root.innerHTML = files.map((file) => {
        const language = detectLanguage(file.path);
        const languageClass = language ? " language-" + language : "";
        const rows = buildRowsForFile(file);
        const rowHtml = rows.map((row, rowIdx) => renderDiffRow(file.path, row, languageClass, rowIdx)).join("");

        return '<section class="file">' +
          '<div class="file-header">' + escapeHtml(file.path) + '</div>' +
          '<table class="diff">' +
            '<colgroup><col class="line-no" /><col class="code" /><col class="line-no" /><col class="code" /></colgroup>' +
            '<tbody>' + rowHtml + '</tbody>' +
          '</table>' +
        '</section>';
      }).join("");

      applySyntaxHighlighting();
    }

    function openEditorAt(row, file, side, line) {
      closeEditor();
      if (!file || !side || !line) return;
      const key = rowKey(file, side, line);
      openEditorKey = key;
      const existing = comments.get(key);
      const editor = document.createElement("tr");
      editor.className = "comment-row";

      const commentBoxHtml = '<div class="comment-box">' +
        '<div class="meta">' + escapeHtml(file) + ' · ' + side + ' line ' + escapeHtml(line) + '</div>' +
        '<textarea id="comment-input" placeholder="Leave a review comment"></textarea>' +
        '<div class="comment-actions">' +
          '<button class="btn" id="cancel-comment">Cancel</button>' +
          '<button class="btn btn-primary" id="save-comment">Save comment</button>' +
        '</div>' +
      '</div>';

      if (side === "old") {
        editor.innerHTML =
          '<td class="line-number comment-fill"></td>' +
          '<td class="line-code comment-cell">' + commentBoxHtml + '</td>' +
          '<td class="line-number comment-fill"></td>' +
          '<td class="line-code comment-fill"></td>';
      } else {
        editor.innerHTML =
          '<td class="line-number comment-fill"></td>' +
          '<td class="line-code comment-fill"></td>' +
          '<td class="line-number comment-fill"></td>' +
          '<td class="line-code comment-cell">' + commentBoxHtml + '</td>';
      }

      row.parentNode.insertBefore(editor, row.nextSibling);

      const input = document.getElementById("comment-input");
      input.value = existing ? existing.comment : "";
      input.focus();
      document.getElementById("cancel-comment").onclick = closeEditor;
      document.getElementById("save-comment").onclick = () => {
        const text = input.value.trim();
        if (!text) return;
        comments.set(key, { file, side, line, comment: text });
        closeEditor();
        renderDiff();
      };
    }

    function openEditorFromTrigger(triggerButton) {
      const file = triggerButton.getAttribute("data-file");
      const side = triggerButton.getAttribute("data-side");
      const line = triggerButton.getAttribute("data-line");
      const row = triggerButton.closest("tr");
      if (!row || !file || !side || !line) return;
      openEditorAt(row, file, side, line);
    }

    async function expandGapRow(row) {
      const button = row.querySelector("button.gap-btn");
      if (!button) return;
      const file = row.getAttribute("data-file");
      if (!file) return;

      const oldStart = row.getAttribute("data-old-start") || "0";
      const oldEnd = row.getAttribute("data-old-end") || "0";
      const newStart = row.getAttribute("data-new-start") || "0";
      const newEnd = row.getAttribute("data-new-end") || "0";
      const hidden = row.getAttribute("data-hidden") || "0";

      const params = new URLSearchParams({ file, oldStart, oldEnd, newStart, newEnd });

      button.disabled = true;
      button.textContent = "Loading context…";

      try {
        const res = await fetch("/context?" + params.toString());
        if (!res.ok) throw new Error("Failed to load context");
        const payload = await res.json();
        const languageClass = "";
        const contextRows = Array.isArray(payload.rows) ? payload.rows : [];
        const groupId = "gap-" + Math.random().toString(36).slice(2);

        const rowsHtml = contextRows.map((ctx, idx) => {
          const split = {
            type: "diff",
            rowKind: "context",
            left: ctx.oldLine ? makeSide("context", ctx.oldLine, ctx.oldContent || "") : null,
            right: ctx.newLine ? makeSide("context", ctx.newLine, ctx.newContent || "") : null,
          };
          return renderDiffRow(file, split, languageClass, "expanded-" + idx)
            .replace('<tr class="diff-row ', '<tr class="diff-row expanded-row ')
            .replace('" data-row-id=', '" data-expanded-group="' + groupId + '" data-row-id=');
        }).join("");

        const collapseHtml = '<tr class="gap-row expanded-row" data-expanded-group="' + groupId + '" data-file="' + escapeHtml(file) + '" data-old-start="' + oldStart + '" data-old-end="' + oldEnd + '" data-new-start="' + newStart + '" data-new-end="' + newEnd + '" data-hidden="' + hidden + '">' +
          '<td colspan="4"><button class="gap-btn" type="button" data-action="collapse-gap">Collapse hidden lines</button></td>' +
        '</tr>';

        row.insertAdjacentHTML("beforebegin", rowsHtml + collapseHtml);
        row.remove();
        applySyntaxHighlighting();
      } catch {
        button.disabled = false;
        button.textContent = "Failed to load context";
      }
    }

    function collapseGapRow(row) {
      const groupId = row.getAttribute("data-expanded-group");
      if (!groupId) return;

      const file = row.getAttribute("data-file") || "";
      const oldStart = row.getAttribute("data-old-start") || "0";
      const oldEnd = row.getAttribute("data-old-end") || "0";
      const newStart = row.getAttribute("data-new-start") || "0";
      const newEnd = row.getAttribute("data-new-end") || "0";
      const hidden = row.getAttribute("data-hidden") || "0";

      const restored = '<tr class="gap-row" data-file="' + escapeHtml(file) + '" data-old-start="' + oldStart + '" data-old-end="' + oldEnd + '" data-new-start="' + newStart + '" data-new-end="' + newEnd + '" data-hidden="' + hidden + '">' +
        '<td colspan="4"><button class="gap-btn" type="button" data-action="expand-gap">Show ' + hidden + ' hidden lines</button></td>' +
      '</tr>';

      row.insertAdjacentHTML("beforebegin", restored);
      document.querySelectorAll('tr[data-expanded-group="' + CSS.escape(groupId) + '"]').forEach((node) => node.remove());
    }

    async function submitComments() {
      const payload = Array.from(comments.values());
      if (payload.length === 0) {
        alert("No comments to submit.");
        return;
      }
      const res = await fetch("/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        alert("Failed to submit comments.");
        return;
      }
      document.body.innerHTML = "<h2 style='text-align:center; margin-top:50px;'>Review submitted. You can close this tab.</h2>";
    }

    document.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;

      if (target.classList.contains("comment-trigger")) {
        openEditorFromTrigger(target);
        return;
      }

      const action = target.getAttribute("data-action");
      if (action === "expand-gap") {
        const gapRow = target.closest("tr.gap-row");
        if (gapRow) void expandGapRow(gapRow);
        return;
      }

      if (action === "collapse-gap") {
        const gapRow = target.closest("tr.gap-row");
        if (gapRow) collapseGapRow(gapRow);
        return;
      }

      const key = target.getAttribute("data-key");
      if (!action || !key) return;

      if (action === "edit-comment") {
        const [file, side, line] = key.split("::");
        if (!file || !side || !line) return;
        const selector = '.comment-trigger[data-file="' + CSS.escape(file) + '"][data-side="' + CSS.escape(side) + '"][data-line="' + CSS.escape(line) + '"]';
        const trigger = document.querySelector(selector);
        if (trigger) openEditorFromTrigger(trigger);
        return;
      }

      if (action === "delete-comment") {
        comments.delete(key);
        if (openEditorKey === key) closeEditor();
        renderDiff();
      }
    });

    document.getElementById("reload").onclick = () => window.location.reload();
    document.getElementById("submit").onclick = () => void submitComments();
    document.getElementById("close").onclick = async () => {
      try { await fetch("/close", { method: "POST" }); } catch {}
      document.body.innerHTML = "<h2 style='text-align:center; margin-top:50px;'>Review closed. You can close this tab.</h2>";
    };

    renderDiff();
  </script>
</body>
</html>`;
}

function parseUnifiedDiff(raw: string): RenderedFile[] {
	const files: RenderedFile[] = [];
	let currentFile: RenderedFile | null = null;
	let currentHunk: RenderedHunk | null = null;
	let oldLine = 0;
	let newLine = 0;

	for (const line of raw.split("\n")) {
		if (line.startsWith("diff --git ")) {
			currentFile = { path: parseDiffPath(line), hunks: [] };
			files.push(currentFile);
			currentHunk = null;
			continue;
		}

		if (!currentFile) continue;

		if (line.startsWith("+++ ")) {
			const match = line.match(/^\+\+\+\s+([^/]+)\/(.+)$/);
			if (match) currentFile.path = match[2];
			continue;
		}

		const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
		if (hunk) {
			const oldStart = Number(hunk[1]);
			const oldCount = Number(hunk[2] || "1");
			const newStart = Number(hunk[3]);
			const newCount = Number(hunk[4] || "1");
			currentHunk = {
				header: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${hunk[5] || ""}`,
				oldStart,
				oldCount,
				newStart,
				newCount,
				lines: [],
			};
			currentFile.hunks.push(currentHunk);
			oldLine = oldStart;
			newLine = newStart;
			continue;
		}

		if (!currentHunk || line.startsWith("\\ No newline")) continue;

		if (line.startsWith("+")) {
			currentHunk.lines.push({ type: "added", newLine, content: line.slice(1) });
			newLine++;
		} else if (line.startsWith("-")) {
			currentHunk.lines.push({ type: "removed", oldLine, content: line.slice(1) });
			oldLine++;
		} else if (line.startsWith(" ")) {
			currentHunk.lines.push({ type: "context", oldLine, newLine, content: line.slice(1) });
			oldLine++;
			newLine++;
		}
	}

	return files.filter((file) => file.hunks.some((hunk) => hunk.lines.length > 0));
}

function parseDiffPath(line: string): string {
	const parts = line.split(" ");
	const right = parts[parts.length - 1] || "";
	const prefixed = right.match(/^[a-z]\/(.+)$/);
	return prefixed ? prefixed[1] : right;
}

async function loadGapContext(input: {
	cwd: string;
	target: string;
	file: string;
	oldStart: number;
	oldEnd: number;
	newStart: number;
	newEnd: number;
}): Promise<Array<{ oldLine?: number; oldContent?: string; newLine?: number; newContent?: string }>> {
	if (!input.file) throw new Error("Missing file");

	const oldLines = await readFileAtTarget(input.cwd, input.target, input.file);
	const newLines = await readWorkingTreeFile(input.cwd, input.file);

	const oldRange = extractLineRange(oldLines, input.oldStart, input.oldEnd, "old");
	const newRange = extractLineRange(newLines, input.newStart, input.newEnd, "new");

	const rows: Array<{ oldLine?: number; oldContent?: string; newLine?: number; newContent?: string }> = [];
	const maxLen = Math.max(oldRange.length, newRange.length);
	for (let i = 0; i < maxLen; i++) {
		const oldItem = oldRange[i];
		const newItem = newRange[i];
		rows.push({
			oldLine: oldItem?.line,
			oldContent: oldItem?.content,
			newLine: newItem?.line,
			newContent: newItem?.content,
		});
	}

	return rows;
}

async function readFileAtTarget(cwd: string, target: string, file: string): Promise<string[] | null> {
	try {
		const out = await run("git", ["show", `${target}:${file}`], { cwd, maxBuffer: 5 * 1024 * 1024 });
		return splitLines(out.stdout);
	} catch {
		return null;
	}
}

async function readWorkingTreeFile(cwd: string, file: string): Promise<string[] | null> {
	const root = path.resolve(cwd);
	const abs = path.resolve(root, file);
	if (!(abs === root || abs.startsWith(root + path.sep))) return null;
	try {
		const text = await readFile(abs, "utf8");
		return splitLines(text);
	} catch {
		return null;
	}
}

function splitLines(text: string): string[] {
	const lines = text.replace(/\r/g, "").split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

function extractLineRange(
	lines: string[] | null,
	start: number,
	end: number,
	side: "old" | "new",
): Array<{ side: "old" | "new"; line: number; content: string }> {
	if (!lines || !Number.isFinite(start) || !Number.isFinite(end) || end < start || end < 1) return [];

	const clampedStart = Math.max(1, start);
	const clampedEnd = Math.min(lines.length, end);
	if (clampedEnd < clampedStart) return [];

	const out: Array<{ side: "old" | "new"; line: number; content: string }> = [];
	for (let lineNo = clampedStart; lineNo <= clampedEnd; lineNo++) {
		out.push({ side, line: lineNo, content: lines[lineNo - 1] ?? "" });
	}
	return out;
}

function escapeHtml(input: string): string {
	return input
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}
