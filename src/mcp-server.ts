// Loopback Streamable HTTP MCP server exposing Pi's active tools and skills to `agy acp`.
//
// `agy acp` receives this endpoint per session over JSON-RPC (`session/new` and `session/load`
// `mcpServers` parameter), so no global or workspace MCP config files are modified.
//
// Hardening:
//   - Binds strictly to 127.0.0.1.
//   - Requires a per-process shared secret in `x-bridge-token` (constant-time compare).
//   - Caps request body size at 1 MB.
//   - Clamps newer `mcp-protocol-version` headers to the SDK's latest supported version.

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
	CallToolRequestSchema,
	LATEST_PROTOCOL_VERSION,
	ListToolsRequestSchema,
	SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/sdk/types.js";
import { PI_BRIDGE_SERVER_PREFIX } from "./bridge-catalog.js";

const PACKAGE_VERSION = (() => {
	try {
		const raw = fs.readFileSync(new URL("../package.json", import.meta.url), "utf8");
		const parsed = JSON.parse(raw) as { version?: unknown };
		return typeof parsed.version === "string" && parsed.version.trim()
			? parsed.version.trim()
			: "2.4.2";
	} catch {
		return "2.4.2";
	}
})();

/** Shared-secret header required on every bridge HTTP request. */
export const TOKEN_HEADER = "x-bridge-token";
const MAX_BODY_BYTES = 1_000_000;
const NS_ROUTE_PREFIX = "/mcp/ns/";
const NS_ROUTE_NAME_RE = /^[a-z0-9-]+$/;

export interface McpServerHandle {
	port: number;
	token: string;
	close: () => Promise<void>;
}

export interface McpStartResult {
	ok: boolean;
	port?: number;
	handle?: McpServerHandle;
	reason?: string;
}

export interface McpBridgeDeps {
	listTools(route?: string): Array<{ name: string; description: string; inputSchema: object }>;
	onToolCall(
		callId: string,
		name: string,
		args: Record<string, unknown>,
		signal: AbortSignal,
		route?: string,
	): Promise<import("./provider.js").BridgeCallResultShape>;
	instructions?: string | ((route: string) => string | undefined);
}

function resolveMcpRoute(rawUrl: string | undefined): { route: string; serverName: string } | null {
	if (!rawUrl) return null;
	let pathname: string;
	if (rawUrl.startsWith("/")) {
		const queryIdx = rawUrl.indexOf("?");
		pathname = queryIdx >= 0 ? rawUrl.slice(0, queryIdx) : rawUrl;
	} else {
		try {
			pathname = new URL(rawUrl).pathname;
		} catch {
			return null;
		}
	}
	if (pathname === "/mcp" || pathname === `/mcp/${PI_BRIDGE_SERVER_PREFIX}`) {
		return { route: PI_BRIDGE_SERVER_PREFIX, serverName: PI_BRIDGE_SERVER_PREFIX };
	}
	if (pathname.startsWith(NS_ROUTE_PREFIX)) {
		const routeName = pathname.slice(NS_ROUTE_PREFIX.length);
		if (NS_ROUTE_NAME_RE.test(routeName)) {
			return {
				route: `ns:${routeName}`,
				serverName: `${PI_BRIDGE_SERVER_PREFIX}-${routeName}`,
			};
		}
	}
	return null;
}

export function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

function clampProtocolVersionHeader(req: http.IncomingMessage): void {
	const sent = req.headers["mcp-protocol-version"];
	if (typeof sent !== "string" || SUPPORTED_PROTOCOL_VERSIONS.includes(sent)) return;
	req.headers["mcp-protocol-version"] = LATEST_PROTOCOL_VERSION;
	const raw = req.rawHeaders;
	for (let i = 0; i < raw.length - 1; i += 2) {
		if (raw[i].toLowerCase() === "mcp-protocol-version") {
			raw[i + 1] = LATEST_PROTOCOL_VERSION;
		}
	}
}

export async function startMcpServer(
	deps: McpBridgeDeps,
	opts: {
		preferredPort?: number;
		log?: (s: string, d?: unknown) => void;
	} = {},
): Promise<McpStartResult> {
	const log = opts.log ?? (() => {});

	const listHandler = async (route: string) => {
		const tools = deps.listTools(route);
		log("list-tools", { route, count: tools.length });
		return { tools };
	};

	const callHandler = async (
		route: string,
		request: { params: { name: string; arguments?: unknown } },
		signal?: AbortSignal,
	) => {
		const { name, arguments: args } = request.params;
		const meta = (request.params as { _meta?: { progressToken?: unknown } })._meta;
		if (meta && meta.progressToken !== undefined) {
			log("progress-token", { route, name, token: String(meta.progressToken) });
		}
		const callId = crypto.randomUUID();
		log("call-tool", { route, name, callId });
		try {
			const r = await deps.onToolCall(
				callId,
				name,
				(args && typeof args === "object" ? args : {}) as Record<string, unknown>,
				signal ?? new AbortController().signal,
				route,
			);
			const content =
				r.content && r.content.length > 0 ? r.content : [{ type: "text", text: JSON.stringify(r) }];
			log("call-tool-ok", { route, name, callId });
			return { content, isError: r.isError ?? false };
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			log("call-tool-fail", { route, name, callId, msg });
			return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
		}
	};

	const resolveInstructions = (route: string): string | undefined => {
		const raw =
			typeof deps.instructions === "function" ? deps.instructions(route) : deps.instructions;
		return typeof raw === "string" && raw.trim().length > 0 ? raw : undefined;
	};

	const makeServer = (route: string, serverName: string, signal: AbortSignal) => {
		const instructions = resolveInstructions(route);
		const s = new Server(
			{ name: serverName, version: PACKAGE_VERSION },
			{ capabilities: { tools: {} }, ...(instructions ? { instructions } : {}) },
		);
		s.setRequestHandler(ListToolsRequestSchema, () => listHandler(route));
		s.setRequestHandler(CallToolRequestSchema, (request) => callHandler(route, request, signal));
		return s;
	};

	const token = crypto.randomUUID();
	const tokenOk = (req: http.IncomingMessage): boolean => {
		const received = req.headers[TOKEN_HEADER];
		return (
			typeof received === "string" &&
			received.length === token.length &&
			crypto.timingSafeEqual(Buffer.from(received), Buffer.from(token))
		);
	};

	return new Promise<McpStartResult>((resolve) => {
		const httpServer = http.createServer(async (req, res) => {
			req.on("error", (e) => {
				log("request-error", e instanceof Error ? e.message : String(e));
				try {
					if (!res.headersSent) res.writeHead(400).end();
					else res.end();
				} catch {
					// Socket already gone.
				}
			});
			try {
				if (req.url?.includes("/.well-known/")) {
					res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not found"}');
					return;
				}
				if (req.method !== "POST") {
					res.writeHead(405).end();
					return;
				}
				if (!tokenOk(req)) {
					log("unauthorized", { url: req.url });
					res.writeHead(403, { "content-type": "application/json" }).end('{"error":"forbidden"}');
					return;
				}
				const resolvedRoute = resolveMcpRoute(req.url);
				if (!resolvedRoute) {
					res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not found"}');
					return;
				}
				let body = "";
				let bytes = 0;
				let tooLarge = false;
				for await (const chunk of req) {
					body += chunk;
					bytes += chunk.length;
					if (bytes > MAX_BODY_BYTES) {
						tooLarge = true;
						break;
					}
				}
				if (tooLarge) {
					res
						.writeHead(413, { "content-type": "application/json", connection: "close" })
						.end('{"error":"payload too large"}');
					return;
				}
				let parsed: { id?: unknown; method?: string; params?: { protocolVersion?: string } };
				try {
					parsed = JSON.parse(body);
				} catch {
					res.writeHead(400).end("invalid json");
					return;
				}
				if (
					parsed &&
					typeof parsed === "object" &&
					!Array.isArray(parsed) &&
					parsed.method === "server/discover"
				) {
					res.writeHead(200, { "content-type": "application/json" }).end(
						JSON.stringify({
							jsonrpc: "2.0",
							id: (parsed as { id?: unknown }).id ?? null,
							error: { code: -32601, message: "Method not found" },
						}),
					);
					return;
				}
				clampProtocolVersionHeader(req);
				const ac = new AbortController();
				req.on("aborted", () => ac.abort());
				res.on("close", () => {
					if (!res.writableEnded) ac.abort();
				});
				try {
					const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
					transport.onerror = (e: Error) => log("transport-error", e.message);
					const server = makeServer(resolvedRoute.route, resolvedRoute.serverName, ac.signal);
					await server.connect(transport);
					await transport.handleRequest(req, res, parsed as object);
				} catch (e) {
					log("handleRequest-error", e instanceof Error ? e.message : String(e));
					if (!res.headersSent) res.writeHead(500).end();
				}
			} catch (e) {
				log("request-handler-error", e instanceof Error ? e.message : String(e));
				try {
					if (!res.headersSent) res.writeHead(500).end();
				} catch {
					// Socket gone.
				}
			}
		});

		httpServer.on("error", (e) => {
			log("http-error", e instanceof Error ? e.message : String(e));
			resolve({
				ok: false,
				reason: `http server error: ${e instanceof Error ? e.message : String(e)}`,
			});
		});

		httpServer.listen(opts.preferredPort ?? 0, "127.0.0.1", () => {
			const addr = httpServer.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			if (!port) {
				resolve({ ok: false, reason: "failed to bind" });
				return;
			}
			log("listening", { port });
			resolve({
				ok: true,
				port,
				handle: {
					port,
					token,
					close: async () => {
						await new Promise<void>((r) => httpServer.close(() => r()));
						log("closed", { port });
					},
				},
			});
		});
	});
}
