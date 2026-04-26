#!/usr/bin/env bun
import { execSync } from "node:child_process";
import {
	createWebReviewServer,
	resolveGitTarget,
	type ReviewComment,
	type WebReviewServer,
} from "./web-review.ts";

const args = process.argv.slice(2);
const cwd = process.cwd();
const target = (args[0] || "HEAD").trim();

const resolvedTarget = await resolveGitTarget(cwd, target);
if (!resolvedTarget) {
	console.error(`Invalid git target: ${target}`);
	process.exit(1);
}

let server: WebReviewServer | null = null;
let submitted = false;

const shutdown = async (code: number) => {
	if (server) {
		try {
			await server.close();
		} catch {}
	}
	process.exit(code);
};

server = await createWebReviewServer({
	cwd,
	target: resolvedTarget,
	targetLabel: target,
	onSubmit: async (comments: ReviewComment[]) => {
		submitted = true;
		console.log("=== SHOW-CHANGES COMMENTS (JSON) ===");
		console.log(JSON.stringify(comments, null, 2));
		console.log("=== END SHOW-CHANGES COMMENTS ===");
		setTimeout(() => shutdown(0), 50);
	},
});

console.log(`Web review opened: ${server.url}`);
console.log(`cwd: ${cwd}`);
console.log(`target: ${target} (resolved: ${resolvedTarget})`);

try {
	const startCmd =
		process.platform === "darwin"
			? "open"
			: process.platform === "win32"
				? "start"
				: "xdg-open";
	execSync(`${startCmd} ${server.url}`, { stdio: "ignore" });
} catch {}

console.log("Waiting for comments... (Ctrl+C to cancel)");

process.on("SIGINT", () => {
	if (!submitted) console.log("Cancelled — no comments submitted.");
	void shutdown(submitted ? 0 : 130);
});
process.on("SIGTERM", () => void shutdown(submitted ? 0 : 143));
