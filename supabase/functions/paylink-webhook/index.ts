// Paylink "Payment Webhook": Paylink POSTs here when an invoice is paid, so the
// subscription is activated even if the payer never returns to the app.
// The body is not trusted: the invoice is fetched from Paylink and checked
// against our order before fulfill_order runs (which ignores repeats).
//
// Deploy with "Verify JWT" turned OFF (Paylink does not send a Supabase token).
// Secrets: PAYLINK_API_ID, PAYLINK_SECRET_KEY, PAYLINK_WEBHOOK_SECRET.
// In my.paylink.sa > Settings > Payment Webhook set this function's URL and
// HTTP Header 1 = X-Webhook-Secret, value = the same PAYLINK_WEBHOOK_SECRET.
// Optional: PAYLINK_BASE (default https://restapi.paylink.sa).
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const j = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
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

// Same checks as verify-payment's settlePaylink, without a caller to match.
async function settlePaylink(admin: SupabaseClient, inv: any, tx: string) {
  if (!inv || String(inv.transactionNo) !== tx) return { ok: false, reason: "payment not found" };
  const orderId = String(inv.gatewayOrderRequest?.orderNumber || "");
  if (!UUID.test(orderId)) return { ok: false, reason: "no order" };
  const { data: o } = await admin.from("payment_orders").select("*").eq("id", orderId).single();
  if (!o) return { ok: false, reason: "order not found" };
  const status = String(inv.orderStatus || "").toLowerCase();
  if (status !== "paid") return { ok: false, reason: "not paid: " + status };
  const currency = String(inv.gatewayOrderRequest?.currency || "SAR").toUpperCase();
  if (currency !== "SAR" || Math.round(Number(inv.amount) * 100) !== o.amount_halalas) return { ok: false, reason: "amount mismatch" };
  const { error } = await admin.rpc("fulfill_order", { p_order: o.id, p_payment: "paylink:" + tx });
  if (error) throw new Error("fulfill failed");
  return { ok: true };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return j({ error: "method not allowed" }, 405);
  const secret = (Deno.env.get("PAYLINK_WEBHOOK_SECRET") || "").trim();
  if (!secret || req.headers.get("x-webhook-secret") !== secret) return j({ error: "unauthorized" }, 401);
  try {
    const b = await req.json().catch(() => ({}));
    const tx = String(b?.transactionNo || "");
    // Acknowledge payloads we cannot use, so Paylink stops retrying them.
    if (!TX.test(tx)) return j({ ok: false, reason: "no transaction" });
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    return j(await settlePaylink(admin, await paylinkInvoice(tx), tx));
  } catch (_e) {
    // Non-200 makes Paylink retry later (up to ten times).
    return j({ error: "server error" }, 500);
  }
});
