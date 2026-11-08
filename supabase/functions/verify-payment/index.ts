// Confirms a payment with the gateway and activates the subscription through
// fulfill_order (which ignores an order that is already paid).
//
// Body { transaction_no } -> Paylink (the TransactionNo Paylink appends to the callback URL)
// Body { payment_id }     -> Moyasar (kept until the switch to Paylink is complete)
//
// Secrets: PAYLINK_API_ID, PAYLINK_SECRET_KEY (Paylink), MOYASAR_SECRET_KEY (Moyasar).
// Optional: PAYLINK_BASE (default https://restapi.paylink.sa).
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const j = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TX = /^[0-9]{5,30}$/;
const BASE = (Deno.env.get("PAYLINK_BASE") || "https://restapi.paylink.sa").replace(/\/+$/, "");

async function paylinkInvoice(tx: string) {
  const apiId = (Deno.env.get("PAYLINK_API_ID") || "").trim();
  const secretKey = (Deno.env.get("PAYLINK_SECRET_KEY") || "").trim();
  if (!apiId || !secretKey) throw new Error("paylink keys missing");
  const a = await fetch(BASE + "/api/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ apiId, secretKey, persistToken: false }),
  });
  const t = await a.json().catch(() => ({}));
  if (!a.ok || !t.id_token) throw new Error("paylink auth failed (" + a.status + ")");
  const r = await fetch(BASE + "/api/getInvoice/" + encodeURIComponent(tx), {
    headers: { Authorization: "Bearer " + t.id_token, Accept: "application/json", "Content-Type": "application/json" },
  });
  if (!r.ok) return null;
  return await r.json().catch(() => null);
}

// Checks a Paylink invoice against our order and activates it when it is paid.
// userId: the caller when the payer comes back to the app; null for the webhook.
async function settlePaylink(admin: SupabaseClient, inv: any, tx: string, userId: string | null) {
  if (!inv || String(inv.transactionNo) !== tx) return { body: { error: "payment not found" }, status: 400 };
  const orderId = String(inv.gatewayOrderRequest?.orderNumber || "");
  if (!UUID.test(orderId)) return { body: { error: "no order" }, status: 400 };
  const { data: o } = await admin.from("payment_orders").select("*").eq("id", orderId).single();
  if (!o || (userId && o.user_id !== userId)) return { body: { error: "order mismatch" }, status: 403 };

  const status = String(inv.orderStatus || "").toLowerCase();
  if (status !== "paid") return { body: { paid: false, status }, status: 200 };
  const currency = String(inv.gatewayOrderRequest?.currency || "SAR").toUpperCase();
  if (currency !== "SAR" || Math.round(Number(inv.amount) * 100) !== o.amount_halalas) {
    return { body: { error: "amount mismatch" }, status: 400 };
  }
  const { data: end, error } = await admin.rpc("fulfill_order", { p_order: o.id, p_payment: "paylink:" + tx });
  if (error) return { body: { error: "fulfill failed" }, status: 400 };
  return { body: { paid: true, ends: end }, status: 200 };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const jwt = (req.headers.get("Authorization") || "").replace("Bearer ", "");
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: u } = await admin.auth.getUser(jwt);
    if (!u?.user) return j({ error: "unauthorized" }, 401);

    const body = await req.json().catch(() => ({}));

    if (body.transaction_no !== undefined) {
      const tx = String(body.transaction_no);
      if (!TX.test(tx)) return j({ error: "bad request" }, 400);
      const res = await settlePaylink(admin, await paylinkInvoice(tx), tx, u.user.id);
      return j(res.body, res.status);
    }

    const { payment_id } = body;
    if (!payment_id || typeof payment_id !== "string") return j({ error: "bad request" }, 400);

    const key = (Deno.env.get("MOYASAR_SECRET_KEY") || "").trim();
    if (!key) return j({ error: "secret key missing" }, 500);
    const r = await fetch("https://api.moyasar.com/v1/payments/" + encodeURIComponent(payment_id), {
      headers: { Authorization: "Basic " + btoa(key + ":") },
    });
    if (!r.ok) return j({ error: "payment not found (moyasar " + r.status + ")" }, 400);
    const p = await r.json();

    const m = /warsha:([0-9a-f-]{36})/.exec(p.description || "");
    if (!m) return j({ error: "no order" }, 400);
    const { data: o } = await admin.from("payment_orders").select("*").eq("id", m[1]).single();
    if (!o || o.user_id !== u.user.id) return j({ error: "order mismatch" }, 403);

    if (p.status !== "paid") return j({ paid: false, status: p.status });
    if (p.currency !== "SAR" || p.amount !== o.amount_halalas) return j({ error: "amount mismatch" }, 400);

    const { data: end, error } = await admin.rpc("fulfill_order", { p_order: o.id, p_payment: p.id });
    if (error) return j({ error: "fulfill failed" }, 400);
    return j({ paid: true, ends: end });
  } catch (_e) {
    return j({ error: "server error" }, 500);
  }
});
