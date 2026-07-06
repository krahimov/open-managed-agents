#!/usr/bin/env node
// clerk-sim — local Clerk stand-in for developing/testing the Clerk
// integration (docs/clerk-integration.md) WITHOUT a Clerk account.
//
// It plays the two Clerk roles main-node talks to:
//   1. The Frontend API: serves a JWKS and mints RS256 session tokens
//      with the same claims Clerk v2 tokens carry (sub/sid/iss/pla/o).
//   2. The webhook sender: svix-signs payloads (whsec_ HMAC) and POSTs
//      them to /clerk/webhook.
//
// Keys + webhook secret persist in data/clerk-sim/ (gitignored), so the
// server env and this tool always agree.
//
// Usage:
//   node scripts/clerk-sim.mjs serve                 # JWKS on :9377 (foreground)
//   node scripts/clerk-sim.mjs env                   # print env vars for main-node
//   node scripts/clerk-sim.mjs token user_1 [u:pro] [org_1]
//   node scripts/clerk-sim.mjs webhook http://localhost:8787 '<json>'
//   node scripts/clerk-sim.mjs demo http://localhost:8787
//
// `demo` runs the full billing lifecycle against a running main-node
// booted with `env`'s variables: sync a user → hit the free-plan session
// cap (402) → upgrade via subscriptionItem.active (201) → cancel (402).

import { createServer } from "node:http";
import {
  createHmac,
  createPrivateKey,
  generateKeyPairSync,
  sign as cryptoSign,
} from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "data", "clerk-sim");
const PORT = Number(process.env.CLERK_SIM_PORT ?? 9377);
const ISSUER = `http://127.0.0.1:${PORT}`;

function ensureKeys() {
  mkdirSync(DIR, { recursive: true });
  if (!existsSync(join(DIR, "priv.pem"))) {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    writeFileSync(join(DIR, "priv.pem"), privateKey.export({ type: "pkcs8", format: "pem" }));
    const jwk = { ...publicKey.export({ format: "jwk" }), kid: "sim-key-1", use: "sig", alg: "RS256" };
    writeFileSync(join(DIR, "jwks.json"), JSON.stringify({ keys: [jwk] }));
  }
  if (!existsSync(join(DIR, "whsec"))) {
    const secret = `whsec_${Buffer.from(`clerk-sim-${Date.now()}-webhook-secret`).toString("base64")}`;
    writeFileSync(join(DIR, "whsec"), secret);
  }
  return {
    jwks: readFileSync(join(DIR, "jwks.json")),
    priv: createPrivateKey(readFileSync(join(DIR, "priv.pem"))),
    // Env override lets a launcher (e.g. .claude/launch.json) pin the
    // secret without reading this tool's state file.
    whsec:
      process.env.CLERK_WEBHOOK_SIGNING_SECRET?.trim() ||
      readFileSync(join(DIR, "whsec"), "utf8").trim(),
  };
}

const b64u = (b) =>
  Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function mintToken(priv, sub, pla, orgId) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: ISSUER,
    sub,
    sid: `sess_sim_${now}`,
    exp: now + 3600,
    nbf: now - 10,
    iat: now,
    v: 2,
    ...(pla ? { pla } : {}),
    ...(orgId ? { o: { id: orgId, slg: "sim-org", rol: "admin" } } : {}),
  };
  const h = b64u(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "sim-key-1" }));
  const p = b64u(JSON.stringify(claims));
  return `${h}.${p}.${b64u(cryptoSign("RSA-SHA256", Buffer.from(`${h}.${p}`), priv))}`;
}

async function sendWebhook(whsec, base, body, id = `msg_sim_${Date.now()}_${Math.floor(Math.random() * 1e6)}`) {
  const ts = Math.floor(Date.now() / 1000);
  const key = Buffer.from(whsec.slice("whsec_".length), "base64");
  const sig = createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
  const res = await fetch(`${base}/clerk/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": id,
      "svix-timestamp": String(ts),
      "svix-signature": `v1,${sig}`,
    },
    body,
  });
  return { status: res.status, body: await res.text() };
}

const [cmd, ...args] = process.argv.slice(2);
const { jwks, priv, whsec } = ensureKeys();

if (cmd === "serve") {
  createServer((req, res) => {
    if (req.url === "/.well-known/jwks.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(jwks);
    } else {
      res.writeHead(404);
      res.end();
    }
  }).listen(PORT, "127.0.0.1", () => {
    console.log(`[clerk-sim] JWKS at ${ISSUER}/.well-known/jwks.json`);
  });
} else if (cmd === "env") {
  console.log(`CLERK_ISSUER=${ISSUER}`);
  console.log(`CLERK_WEBHOOK_SIGNING_SECRET=${whsec}`);
  console.log(`CLERK_BILLING_ENFORCE=1`);
} else if (cmd === "token") {
  const [sub = "user_sim_1", pla, org] = args;
  console.log(mintToken(priv, sub, pla, org));
} else if (cmd === "webhook") {
  const [base = "http://localhost:8787", body] = args;
  const r = await sendWebhook(whsec, base, body);
  console.log(r.status, r.body);
} else if (cmd === "demo") {
  const base = args[0] ?? "http://localhost:8787";
  const uid = `user_demo_${Date.now().toString(36)}`;
  const log = (label, v) => console.log(`${label.padEnd(34)} ${v}`);

  const wh = (obj) => sendWebhook(whsec, base, JSON.stringify(obj));
  const r1 = await wh({
    type: "user.created",
    data: {
      id: uid,
      first_name: "Billing",
      last_name: "Demo",
      primary_email_address_id: "em_1",
      email_addresses: [{ id: "em_1", email_address: `${uid}@example.com` }],
    },
  });
  log("1. user.created webhook", `${r1.status} ${r1.body}`);

  const token = mintToken(priv, uid);
  const H = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const agentRes = await fetch(`${base}/v1/agents`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ name: `billing-demo-${uid}`, model: "claude-haiku-4-5-20251001" }),
  });
  const agent = await agentRes.json();
  log("2. create agent (Bearer token)", `${agentRes.status} ${agent.id ?? JSON.stringify(agent)}`);

  const mkSession = async (title) => {
    const r = await fetch(`${base}/v1/sessions`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ agent: agent.id, environment: "env_local_runtime", title }),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };

  const limit = Number(process.env.CLERK_FREE_PLAN_ACTIVE_SESSION_LIMIT ?? 3);
  for (let i = 1; i <= limit; i++) {
    const s = await mkSession(`demo free #${i}`);
    log(`3.${i} session on free plan`, s.status);
  }
  const capped = await mkSession("demo over cap");
  log("4. session over free cap", `${capped.status} ${capped.body?.error?.type ?? ""} ← expect 402`);

  const r2 = await wh({
    type: "subscriptionItem.active",
    data: { payer: { user_id: uid }, plan: { slug: "pro" }, status: "active" },
  });
  log("5. subscriptionItem.active (pro)", `${r2.status}`);
  const afterUpgrade = await mkSession("demo after upgrade");
  log("6. session on pro plan", `${afterUpgrade.status} ← expect 201`);

  const r3 = await wh({
    type: "subscriptionItem.canceled",
    data: { payer: { user_id: uid }, plan: { slug: "pro" }, status: "canceled" },
  });
  log("7. subscriptionItem.canceled", `${r3.status}`);
  const afterCancel = await mkSession("demo after cancel");
  log("8. session after cancel", `${afterCancel.status} ← expect 402`);
  console.log("\ndemo user:", uid, "— archive its sessions to reset the cap.");
} else {
  console.log("usage: clerk-sim.mjs serve | env | token <sub> [pla] [org] | webhook <base> <json> | demo [base]");
  process.exit(1);
}
