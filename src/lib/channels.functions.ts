import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { requireSupabaseAuth } from '@/integrations/supabase/auth-middleware';

const platformSchema = z.enum(['whatsapp', 'facebook', 'instagram']);
const originSchema = z.string().url().max(200);

export type ConnectionView = { platform: 'whatsapp' | 'facebook' | 'instagram'; status: 'pending' | 'connected' | 'disconnected' | 'error'; account_name: string; phone_number: string | null; error: string | null; qr_code: string | null; qr_expires_at: string | null; verified_at: string | null; updated_at: string } | null;

const cols = 'platform, status, account_name, phone_number, error, qr_code, qr_expires_at, verified_at, updated_at';

async function ctx(userId: string, email?: string | null) {
  const { ensureClientForUser } = await import('./channels.server');
  return ensureClientForUser(userId, email);
}

export const getConnection = createServerFn({ method: 'POST' })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ platform: platformSchema }).parse(d))
  .handler(async ({ data, context }): Promise<ConnectionView> => {
    const { data: row } = await context.supabase.from('platform_connections').select(cols).eq('platform', data.platform).order('updated_at', { ascending: false }).limit(1).maybeSingle();
    return (row as ConnectionView) ?? null;
  });

/** WhatsApp: create (or reuse) an Evolution instance for this client and return its QR. */
export const whatsappConnect = createServerFn({ method: 'POST' })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ origin: originSchema }).parse(d))
  .handler(async ({ data, context }): Promise<ConnectionView> => {
    const { evolution, allowedOrigin, randomToken } = await import('./channels.server');
    const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
    const origin = allowedOrigin(data.origin);
    if (!origin) throw new Error('عنوان التطبيق غير مسموح');
    const clientId = await ctx(context.userId, context.claims?.email as string | undefined);
    const instanceName = `mf_${clientId.replace(/-/g, '')}`;
        const { data: conn, error } = await supabaseAdmin.from('platform_connections').upsert({ client_id: clientId, user_id: context.userId, platform: 'whatsapp', account_name: 'واتساب', provider_account_id: instanceName, instance_name: instanceName, status: 'pending', error: null, revoked_at: null }, { onConflict: 'client_id,platform' }).select('id').single();
    if (error || !conn) throw new Error('تعذر حفظ الاتصال');
    const { data: sec } = await supabaseAdmin.from('connection_secrets').select('webhook_token').eq('connection_id', conn.id).maybeSingle();
    const token = sec?.webhook_token ?? randomToken();
    await supabaseAdmin.from('connection_secrets').upsert({ connection_id: conn.id, client_id: clientId, webhook_token: token, updated_at: new Date().toISOString() });
    const webhook = { url: `${origin}/api/public/evolution/webhook?token=${token}`, byEvents: false, base64: false, events: ['QRCODE_UPDATED', 'CONNECTION_UPDATE', 'MESSAGES_UPSERT'] };
    let qr: string | null = null;
    try {
      const created = await evolution('/instance/create', { method: 'POST', body: JSON.stringify({ instanceName, qrcode: true, integration: 'WHATSAPP-BAILEYS', webhook }) });
      qr = created?.qrcode?.base64 ?? null;
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status !== 403 && status !== 409) { await supabaseAdmin.from('platform_connections').update({ status: 'error', error: (e as Error).message }).eq('id', conn.id); throw e; }
      // instance already exists: refresh webhook and fetch QR
      await evolution(`/webhook/set/${instanceName}`, { method: 'POST', body: JSON.stringify({ webhook: { enabled: true, ...webhook } }) }).catch(() => null);
    }
    try {
      const state = await evolution(`/instance/connectionState/${instanceName}`);
      if (state?.instance?.state === 'open') {
        await supabaseAdmin.from('platform_connections').update({ status: 'connected', qr_code: null, verified_at: new Date().toISOString() }).eq('id', conn.id);
      } else if (!qr) {
        const c = await evolution(`/instance/connect/${instanceName}`);
        qr = c?.base64 ?? null;
      }
    } catch (e) { await supabaseAdmin.from('platform_connections').update({ status: 'error', error: (e as Error).message }).eq('id', conn.id); throw e; }
    if (qr) await supabaseAdmin.from('platform_connections').update({ qr_code: qr, qr_expires_at: new Date(Date.now() + 45_000).toISOString() }).eq('id', conn.id);
    const { data: row } = await supabaseAdmin.from('platform_connections').select(cols).eq('id', conn.id).single();
    return row as ConnectionView;
  });

/** WhatsApp: poll live state from Evolution and sync it. */
export const whatsappRefresh = createServerFn({ method: 'POST' })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<ConnectionView> => {
    const { evolution } = await import('./channels.server');
    const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
    const { data: mine } = await context.supabase.from('platform_connections').select('id, instance_name, status').eq('platform', 'whatsapp').limit(1).maybeSingle();
    if (!mine?.instance_name) return null;
    try {
      const s = await evolution(`/instance/connectionState/${mine.instance_name}`);
      const state = s?.instance?.state;
      if (state === 'open' && mine.status !== 'connected') await supabaseAdmin.from('platform_connections').update({ status: 'connected', qr_code: null, error: null, verified_at: new Date().toISOString() }).eq('id', mine.id);
      if (state === 'close' && mine.status === 'connected') await supabaseAdmin.from('platform_connections').update({ status: 'disconnected', verified_at: null }).eq('id', mine.id);
    } catch (e) {
      if ((e as { status?: number }).status === 404) await supabaseAdmin.from('platform_connections').update({ status: 'disconnected', qr_code: null, verified_at: null, error: 'الجلسة غير موجودة على الخادم، أعد الربط.' }).eq('id', mine.id);
    }
    const { data: row } = await supabaseAdmin.from('platform_connections').select(cols).eq('id', mine.id).single();
    return row as ConnectionView;
  });

/** Disconnect any platform for the caller's client. */
export const disconnectPlatform = createServerFn({ method: 'POST' })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ platform: platformSchema }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
    const { data: mine } = await context.supabase.from('platform_connections').select('id, client_id, instance_name, page_id').eq('platform', data.platform).limit(1).maybeSingle();
    if (!mine) return { ok: true };
    const { data: allowed } = await context.supabase.rpc('has_client_role', { p_client_id: mine.client_id, p_roles: ['owner', 'admin'] });
    if (!allowed) throw new Error('لا تملك صلاحية فصل هذا الحساب');
    if (data.platform === 'whatsapp' && mine.instance_name) {
      const { evolution } = await import('./channels.server');
      await evolution(`/instance/logout/${mine.instance_name}`, { method: 'DELETE' }).catch(() => null);
      await evolution(`/instance/delete/${mine.instance_name}`, { method: 'DELETE' }).catch(() => null);
    } else if (mine.page_id) {
      const { data: sec } = await supabaseAdmin.from('connection_secrets').select('access_token').eq('connection_id', mine.id).maybeSingle();
      if (sec?.access_token) await fetch(`https://graph.facebook.com/v21.0/${mine.page_id}/subscribed_apps?access_token=${encodeURIComponent(sec.access_token)}`, { method: 'DELETE' }).catch(() => null);
    }
    await supabaseAdmin.from('connection_secrets').update({ access_token: null }).eq('connection_id', mine.id);
    await supabaseAdmin.from('platform_connections').update({ status: 'disconnected', qr_code: null, verified_at: null, revoked_at: new Date().toISOString(), error: null }).eq('id', mine.id);
    return { ok: true };
  });

/** Meta: build the OAuth dialog URL for Facebook or Instagram. */
export const metaStartOAuth = createServerFn({ method: 'POST' })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ platform: z.enum(['facebook', 'instagram']), origin: originSchema }).parse(d))
  .handler(async ({ data, context }) => {
    const { allowedOrigin, randomToken } = await import('./channels.server');
    const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
    const appId = process.env['META_APP_ID'];
    if (!appId) throw new Error('تطبيق Meta غير مُعدّ');
    const origin = allowedOrigin(data.origin);
    if (!origin) throw new Error('عنوان التطبيق غير مسموح');
    const clientId = await ctx(context.userId, context.claims?.email as string | undefined);
    const state = randomToken();
    const redirectUri = `${origin}/api/public/meta/callback`;
    await supabaseAdmin.from('oauth_states').insert({ state, user_id: context.userId, client_id: clientId, platform: data.platform, redirect_uri: redirectUri, return_origin: origin });
    const scope = ['pages_show_list', 'pages_messaging', 'pages_manage_metadata', 'pages_read_engagement', 'business_management', ...(data.platform === 'instagram' ? ['instagram_basic', 'instagram_manage_messages'] : [])].join(',');
    const url = `https://www.facebook.com/v21.0/dialog/oauth?client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&response_type=code&scope=${scope}`;
    return { url };
  });
