// A stand-in for kervan-mcp (SPEC §3.5, §4) built with the SDK's server
// classes: the four customer tools over Streamable HTTP, Bearer required,
// answers shaped like core's and search's.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { addDays } from "../../src/agent/scripted/extract.js";

export interface FakeShipment {
  trackingNo: string;
  status: "CREATED" | "IN_TRANSIT" | "OUT_FOR_DELIVERY" | "DELIVERED" | "RETURNED";
  originCity: string;
  destinationCity: string;
  estimatedDelivery: string | null;
  lastEvent: { at: string; description: string } | null;
  /** Last four digits of the recipient's phone. */
  phoneLast4: string;
}

/** The staging seed the eval scenarios assume (kervan-voice-evals/scenarios/README.md), plus KRV10000009. */
export function seedShipments(today: string): FakeShipment[] {
  const day = (n: number) => addDays(today, n);
  const ship = (
    no: number,
    status: FakeShipment["status"],
    phoneLast4: string,
    estimatedDelivery: string,
    event: string,
  ): FakeShipment => ({
    trackingNo: `KRV1000000${no}`,
    status,
    originCity: "Istanbul",
    destinationCity: "Ankara",
    estimatedDelivery,
    lastEvent: { at: `${day(-1)}T08:15:00Z`, description: event },
    phoneLast4,
  });
  return [
    ship(1, "IN_TRANSIT", "4321", day(2), "Departed Istanbul hub"),
    ship(2, "IN_TRANSIT", "4821", day(5), "Arrived at Ankara hub"),
    ship(3, "IN_TRANSIT", "7310", day(2), "Departed Istanbul hub"),
    ship(4, "DELIVERED", "5066", day(-2), "Delivered"),
    ship(5, "DELIVERED", "0505", day(-1), "Delivered"),
    ship(6, "IN_TRANSIT", "0606", day(-5), "Departed Istanbul hub"),
    ship(7, "IN_TRANSIT", "2290", day(3), "Departed Istanbul hub"),
    ship(8, "IN_TRANSIT", "6142", day(4), "Departed Istanbul hub"),
    ship(9, "OUT_FOR_DELIVERY", "1111", day(0), "Out for delivery"),
  ];
}

export const HELP_ARTICLES = [
  { id: "kb-returns", title: "Returning a parcel", snippet: "You can return a parcel within 14 days at any Kervan branch.", score: 0.91 },
  {
    id: "kb-address",
    title: "Changing the delivery address",
    snippet: "You can change the address until the parcel is out for delivery.",
    score: 0.88,
  },
];

export interface ToolCallLog {
  name: string;
  args: Record<string, unknown>;
}

export interface FakeMcp {
  url: string;
  calls: ToolCallLog[];
  /** Bearer tokens seen, one entry per HTTP request. */
  tokens: string[];
  /** X-Trace-Id headers seen. */
  traceIds: string[];
  close(): Promise<void>;
}

export async function startFakeMcp(isValidToken: (token: string) => boolean, today = "2026-10-09"): Promise<FakeMcp> {
  const calls: ToolCallLog[] = [];
  const tokens: string[] = [];
  const traceIds: string[] = [];
  const shipments = seedShipments(today);
  let ticketSeq = 0;
  let url = "";

  const ok = (value: Record<string, unknown>): CallToolResult => ({
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  });
  const err = (text: string): CallToolResult => ({ content: [{ type: "text", text }], isError: true });
  const find = (no: string) => shipments.find((s) => s.trackingNo === no);
  const publicShipment = ({ phoneLast4: _p, ...s }: FakeShipment) => s;

  function buildServer(): McpServer {
    const server = new McpServer({ name: "fake-kervan-mcp", version: "0.0.0" });
    const trackingNo = z.string().regex(/^KRV[0-9]{8}$/);

    server.registerTool(
      "get_shipment",
      { description: "Look up a shipment by tracking number.", inputSchema: { tracking_no: trackingNo } },
      async (args) => {
        calls.push({ name: "get_shipment", args });
        const s = find(args.tracking_no);
        return s ? ok(publicShipment(s)) : err("404 not_found");
      },
    );

    server.registerTool(
      "reschedule_delivery",
      {
        description: "Move a delivery to a new date.",
        inputSchema: {
          tracking_no: trackingNo,
          new_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          verification_code: z.string().regex(/^\d{4}$/),
          reason: z.string().optional(),
        },
      },
      async (args) => {
        calls.push({ name: "reschedule_delivery", args });
        const s = find(args.tracking_no);
        if (!s) return err("404 not_found");
        if (args.verification_code !== s.phoneLast4) return err("403 verification_failed");
        if (["DELIVERED", "RETURNED", "OUT_FOR_DELIVERY"].includes(s.status)) return err("409 not_reschedulable");
        if (args.new_date < addDays(today, 1) || args.new_date > addDays(today, 14)) return err("400 invalid_date");
        return ok({ trackingNo: s.trackingNo, deliveryDate: args.new_date, window: "MORNING", status: "RESCHEDULED", attempts: 0 });
      },
    );

    server.registerTool(
      "open_ticket",
      {
        description: "Open a customer ticket.",
        inputSchema: {
          tracking_no: trackingNo.optional(),
          category: z.enum(["DAMAGED", "LOST", "DELAY", "OTHER"]),
          description: z.string().max(2000),
        },
      },
      async (args) => {
        calls.push({ name: "open_ticket", args });
        if (args.tracking_no && !find(args.tracking_no)) return err("404 not_found");
        ticketSeq += 1;
        return ok({
          ticketId: `TCK-${String(ticketSeq).padStart(6, "0")}`,
          trackingNo: args.tracking_no ?? null,
          category: args.category,
          description: args.description,
          status: "OPEN",
          channel: "agent",
          createdAt: "2026-10-09T12:00:00Z",
        });
      },
    );

    server.registerTool(
      "search_help",
      { description: "Search the help center.", inputSchema: { query: z.string().max(500) } },
      async (args) => {
        calls.push({ name: "search_help", args });
        const words = args.query.toLowerCase().match(/[a-z]{5,}/g) ?? [];
        const score = (a: (typeof HELP_ARTICLES)[number]) =>
          words.filter((w) => `${a.title} ${a.snippet}`.toLowerCase().includes(w)).length;
        const hits = HELP_ARTICLES.filter((a) => score(a) > 0).sort((a, b) => score(b) - score(a));
        return ok({ results: hits.slice(0, 3) });
      },
    );
    return server;
  }

  const http: Server = createServer(async (req, res) => {
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const prm = `${new URL(url).origin}/.well-known/oauth-protected-resource`;
    if (!token || !isValidToken(token)) {
      res.writeHead(401, {
        "www-authenticate": token
          ? `Bearer resource_metadata="${prm}", error="invalid_token"`
          : `Bearer resource_metadata="${prm}"`,
      });
      return res.end();
    }
    tokens.push(token);
    const traceId = req.headers["x-trace-id"];
    if (typeof traceId === "string") traceIds.push(traceId);

    let body: unknown;
    if (req.method === "POST") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      body = raw ? JSON.parse(raw) : undefined;
    }
    // Stateless: one server and transport per request.
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });

  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;

  return {
    url,
    calls,
    tokens,
    traceIds,
    close: () =>
      new Promise((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
}
