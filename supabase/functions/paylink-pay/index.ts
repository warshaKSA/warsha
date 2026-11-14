// Creates a Paylink invoice for one of the caller's pending payment orders and
// returns the Paylink payment page URL. The amount always comes from the order
// row (set by the set_order_amount trigger), never from the client.
//
// Secrets (Edge Functions > Secrets): PAYLINK_API_ID, PAYLINK_SECRET_KEY
// Optional: PAYLINK_BASE (default https://restapi.paylink.sa; the docs give
// https://restpilot.paylink.sa for testing), APP_URL (where Paylink sends the
// payer back, default https://warshaksa.github.io/warsha/).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const j = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE = (Deno.env.get("PAYLINK_BASE") || "https://restapi.paylink.sa").replace(/\/+$/, "");
const APP_URL = Deno.env.get("APP_URL") || "https://warshaksa.github.io/warsha/";

async function paylinkToken(): Promise<string> {
  const apiId = (Deno.env.get("PAYLINK_API_ID") || "").trim();
  const secretKey = (Deno.env.get("PAYLINK_SECRET_KEY") || "").trim();
  if (!apiId || !secretKey) throw new Error("paylink keys missing");
  const r = await fetch(BASE + "/api/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ apiId, secretKey, persistToken: false }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.id_token) throw new Error("paylink auth failed (" + r.status + ")");
  return d.id_token;
}

// Paylink wants a Saudi mobile like 05XXXXXXXX; workshops store WhatsApp as 9665XXXXXXXX.
const toLocalMobile = (n: string) => {
  const d = String(n || "").replace(/\D/g, "");
  if (d.startsWith("966")) return "0" + d.slice(3);
  if (d.startsWith("5")) return "0" + d;
  return d;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const jwt = (req.headers.get("Authorization") || "").replace("Bearer ", "");
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: u } = await admin.auth.getUser(jwt);
    if (!u?.user) return j({ error: "unauthorized" }, 401);

    const { order_id } = await req.json().catch(() => ({}));
    if (typeof order_id !== "string" || !UUID.test(order_id)) return j({ error: "bad request" }, 400);

    const { data: o } = await admin.from("payment_orders").select("*").eq("id", order_id).single();
    if (!o || o.user_id !== u.user.id) return j({ error: "order mismatch" }, 403);
    if (o.status !== "pending") return j({ error: "order not pending" }, 409);
    const amount = o.amount_halalas / 100;
    if (!(amount >= 5)) return j({ error: "amount too low" }, 400);

    const { data: w } = await admin.from("workshops").select("name, whatsapp").eq("id", o.workshop_id).single();
    if (!w) return j({ error: "workshop not found" }, 404);

    const token = await paylinkToken();
    const r = await fetch(BASE + "/api/addInvoice", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        orderNumber: o.id,
        amount,
        currency: "SAR",
        callBackUrl: APP_URL,
        cancelUrl: APP_URL,
        clientName: String(w.name || "ورشة").slice(0, 100),
        clientMobile: toLocalMobile(w.whatsapp),
        clientEmail: u.user.email || undefined,
        products: [{ title: "اشتراك ورشة - " + o.months + " شهر", price: amount, qty: 1, isDigital: true }],
        note: "warsha:" + o.id,
      }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.url || !d.transactionNo) {
      return j({ error: d.detail || d.title || "paylink invoice failed (" + r.status + ")" }, 502);
    }
    return j({ url: d.url, transaction_no: String(d.transactionNo) });
  } catch (e) {
    return j({ error: (e as Error).message || "server error" }, 500);
  }
});
