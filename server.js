/*
 * server.js — LINE × Supabase × GPT（堅牢版 / 2025-08）
 * 変更点（要約）
 * - モデル名をENV化（OPENAI_MODEL / *_SELF / *_TAROT）
 * - Buffer raw body対応（署名検証とJSONパースの両立）
 * - JSTをIntlで安全取得
 * - イベント冪等化（重複再送の二重処理防止）
 * - Supabaseの条件付き更新（期待状態を満たす時だけ更新）
 * - QuickReplyの互換（clipboard排除） & 送信リトライ（指数バックオフ＋jitter）
 * - OpenAI/LINE/Supabaseの疎通確認つき /health
 * - ステートを列挙型で明示（マジックナンバー撤廃）
 */

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const winston = require('winston');
require('dotenv').config();

// ====== ENV ======
const PORT = process.env.PORT || 3000;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const GPT_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || null;

// モデル切替（用途別に上書き可）
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5-mini';
const OPENAI_MODEL_SELF = process.env.OPENAI_MODEL_SELF || OPENAI_MODEL;
const OPENAI_MODEL_TAROT = process.env.OPENAI_MODEL_TAROT || OPENAI_MODEL;

// ====== ロガー ======
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'line-ai-bot' },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(winston.format.colorize(), winston.format.simple())
    })
  ]
});

// ====== Supabase ======
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

// ====== Express ======
const app = express();

// セキュリティヘッダ
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// LINE署名検証用に /webhook は raw body、他は通常JSON
app.use('/webhook', bodyParser.raw({ type: 'application/json' }));
app.use(bodyParser.json());

// ====== レート制限（簡易 / 単一インスタンス想定） ======
const rateLimit = new Map();
const RATE_LIMIT_WINDOW = 60_000;
const RATE_LIMIT_MAX = 10;
function checkRateLimit(userId) {
  const now = Date.now();
  const arr = (rateLimit.get(userId) || []).filter(t => now - t < RATE_LIMIT_WINDOW);
  if (arr.length >= RATE_LIMIT_MAX) return false;
  arr.push(now);
  rateLimit.set(userId, arr);
  return true;
}

// ====== イベント冪等化（重複処理防止） ======
const processedEvents = new Map(); // ※将来Redis化推奨
const EVI_TTL_MS = 10 * 60 * 1000;
function isDuplicateEvent(key) {
  const now = Date.now();
  for (const [k, ts] of processedEvents) {
    if (now - ts > EVI_TTL_MS) processedEvents.delete(k);
  }
  if (processedEvents.has(key)) return true;
  processedEvents.set(key, now);
  return false;
}

// ====== ステート（列挙） ======
const ST = {
  NEED_INPUT: 2,     // ①〜⑤の入力待ち
  AFTER_SELF: 1,     // 自己分析済み → 特別プレゼント待ち
  TAROT_WAIT: 0.5,   // タロット相談内容入力待ち
  OFFER_SHOWN: 0.3,  // 特別なご案内表示後 → 終了前
  CLOSED: 0          // セッション終了
};

// ====== 署名検証 ======
function verifyLineSignature(rawBody, signature) {
  if (!LINE_CHANNEL_SECRET) return false;
  const hash = crypto.createHmac('sha256', LINE_CHANNEL_SECRET).update(rawBody).digest('base64');
  return hash === signature;
}

// ====== エラー通知（Slack任意） ======
async function notifyError(error, context = {}) {
  logger.error('Critical error', { err: error.message, ctx: context, stack: error.stack });
  if (!SLACK_WEBHOOK_URL) return;
  try {
    await axios.post(SLACK_WEBHOOK_URL, {
      text: '🚨 LINE Bot Error',
      attachments: [{
        color: 'danger',
        fields: [
          { title: 'Error', value: error.message, short: false },
          { title: 'Context', value: '```' + JSON.stringify(context).slice(0, 1800) + '```', short: false }
        ]
      }]
    });
  } catch (e) {
    logger.error('Slack notify failed', { err: e.message });
  }
}

// ====== 定型文 ======
const TEMPLATE_MSG = `① お名前：
② 生年月日（西暦）：
③ 生まれた時間（不明でもOK）：
④ MBTI（空欄OK）：
⑤ 性別（男性・女性・その他・不明）：

上記5つをコピーしてご記入ください🕊️`;

const FOLLOWUP_MSG = `ここまでお付き合いいただき
ありがとうございました🕊️

もし心に灯がともる言葉があれば、とても嬉しく思います。
気づきや感想があればぜひ教えてくださいね。

────────────

もっと深く自分を知りたくなったときは、いつでもご相談ください。

💫 ココナラ（初回500円〜）
▶︎ https://coconala.com/invite/CR0VNB

🌙 公式LINEでは
・無料タロット診断
・クーポン
・心が軽くなるメッセージ
を不定期でお届けします。

あなたの毎日に優しい光が降り注ぎますように ✨
未来予報士ユメノアイ`;

// ====== 日付/時刻ユーティリティ ======
function getTimeBasedGreeting() {
  const hour = Number(new Intl.DateTimeFormat('ja-JP', {
    hour: '2-digit', hour12: false, timeZone: 'Asia/Tokyo'
  }).format(new Date()));
  if (hour < 10) return 'おはようございます。\n朝の澄んだ空気の中で';
  if (hour < 17) return 'こんにちは。\n穏やかな時間の中で';
  if (hour < 21) return 'こんばんは。\n夕暮れの静寂の中で';
  return 'こんばんは。\n静かな夜の時間に';
}
function getCurrentDateInfo() {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const season = m >= 3 && m <= 5 ? '春' : m >= 6 && m <= 8 ? '夏' : m >= 9 && m <= 11 ? '秋' : '冬';
  return { formatted: `${y}年${m}月`, season };
}
function buildDateSystemPrompt() {
  const { formatted, season } = getCurrentDateInfo();
  return { role: 'system', content: `本日の日付は${formatted}（JST）、季節は${season}です。これを基準に鑑定してください。` };
}

// ====== プロンプト ======
const SELF_ANALYSIS_MESSAGES = (d) => ([
  buildDateSystemPrompt(),
  {
    role: 'system',
    content:
`あなたは未来予報士「アイ」。四柱推命・算命学・九星気学・姓名の響き・MBTIを総合し深層分析します。
# 出力構成
🔹 あなたの真の性格
🔹 宿る星と運命の流れ
🔹 天賦の才能
🔹 気をつけるべきこと
🔹 あなただけの開運の鍵
- 占術名は出さず、整合的で物語性のある文体
- 各項目は1-2文、読後感が明るくなる表現
- ${d.name}さん専用の内容に`
  },
  {
    role: 'user',
    content:
`【診断情報】
名前：${d.name}
生年月日：${d.birthdate}
出生時間：${d.birthtime || '不明'}
性別：${d.gender || '不明'}
MBTI：${d.mbti || '不明'}`
  }
]);

const TAROT_MESSAGES = (concern='相談内容なし') => ([
  buildDateSystemPrompt(),
  {
    role: 'system',
    content:
`あなたは「未来予報士アイ」。大アルカナ22枚から3枚引き、相談内容「${concern}」に答えます。
# 出力
【今回引かれたカード】
過去：カード名 - 正/逆
現在：カード名 - 正/逆
未来：カード名 - 正/逆

【カードが紡ぐあなたの物語】（300-500文字）
- 過去→現在→未来の流れで希望を示す
- ネガティブは学びとして再解釈
【開運アドバイス】
🌙 ラッキーカラー：
🌙 ラッキーアイテム：
🌙 開運アクション：`
  },
  { role: 'user', content: `相談内容：${concern}` }
]);

// ====== ヘルスチェック（依存疎通込み） ======
app.get('/health', async (req, res) => {
  try {
    // Supabase疎通
    const { error: dbErr } = await supabase.from('diagnosis_logs').select('id').limit(1);
    if (dbErr) throw dbErr;
    // OpenAI疎通
    await axios.get('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${GPT_API_KEY}` }, timeout: 3000
    });
    res.json({ status: 'healthy', ts: new Date().toISOString() });
  } catch (e) {
    res.status(503).json({ status: 'degraded', reason: e.message });
  }
});

// ====== Webhook ======
app.post('/webhook', async (req, res) => {
  const start = Date.now();
  const requestId = crypto.randomUUID();

  try {
    const signature = req.headers['x-line-signature'];
    if (!verifyLineSignature(req.body, signature)) {
      logger.warn('Unauthorized webhook', { requestId, ip: req.ip });
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const body = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : req.body);
    const events = body.events || [];
    logger.info('Webhook in', { requestId, count: events.length });

    for (const ev of events) {
      if (ev.type !== 'message' || ev.message.type !== 'text') continue;

      const userId = ev.source.userId;
      const replyToken = ev.replyToken;
      const text = (ev.message.text || '').trim();

      // 冪等化
      const evKey = ev?.message?.id || `${ev.timestamp}:${userId}`;
      if (isDuplicateEvent(evKey)) {
        logger.info('Duplicate event skipped', { requestId, evKey });
        continue;
      }

      // レート制限
      if (!checkRateLimit(userId)) {
        await safeReplyText(replyToken, 'ただいま混雑しています。少し時間をおいてお試しください。');
        continue;
      }

      // ユーザ状態
      const userState = await getOrCreateUserState(userId, requestId);
      if (!userState) { await safeReplyText(replyToken, 'システムエラーです。時間をおいて再試行してください。'); continue; }

      const extraCredits = userState.extra_credits ?? ST.NEED_INPUT;
      if (userState.session_closed) continue;

      // 特別プレゼント（自己分析後のキーワード）
      if (text === '特別プレゼント' && extraCredits === ST.AFTER_SELF) {
        await conditionalUpdate(userId, { extra_credits: ST.TAROT_WAIT, updated_at: new Date().toISOString() }, ST.AFTER_SELF, requestId);
        continue;
      }

      // タロット相談
      if (extraCredits === ST.TAROT_WAIT) {
        await showTypingIndicator(userId, 10000);
        const tarot = await callGPT(TAROT_MESSAGES(text), OPENAI_MODEL_TAROT, requestId);
        const premiumTarot = `あなたの想いに寄り添いながら\n3枚のカードが紡ぐ物語をお伝えします。\n\n${tarot}`;

        await replyWithQuickReply(replyToken, premiumTarot, [
          { type: 'action', action: { type: 'message', label: '💝 特別なご案内を見る', text: '特別なご案内' } }
        ]);

        await supabase.from('diagnosis_logs').update({
          tarot_concern: text,
          tarot_result: tarot,
          extra_credits: ST.OFFER_SHOWN,
          updated_at: new Date().toISOString()
        }).eq('line_user_id', userId);

        continue;
      }

      // 特別なご案内
      if (text === '特別なご案内' && extraCredits === ST.OFFER_SHOWN) {
        const share = '無料の心理診断見つけた！\nhttps://lin.ee/aQZAOEo';
        await replyWithQuickReply(
          replyToken,
          `${FOLLOWUP_MSG}\n\n✨ よければお友達にもどうぞ`,
          [
            { type: 'action', action: { type: 'uri', label: '📱 LINEで共有', uri: `https://line.me/R/msg/text/?${encodeURIComponent(share)}` } },
            { type: 'action', action: { type: 'uri', label: '🐦 Xで共有', uri: `https://twitter.com/intent/tweet?text=${encodeURIComponent(share)}` } },
            // クリップボードは非対応のため message で代替
            { type: 'action', action: { type: 'message', label: '📷 Instagram用文面を表示', text: share } }
          ]
        );

        await supabase.from('diagnosis_logs').update({
          extra_credits: ST.CLOSED,
          session_closed: true,
          updated_at: new Date().toISOString()
        }).eq('line_user_id', userId);

        continue;
      }

      // 自己分析
      const data = extractUserData(text);
      const hasAll = !!(data.name && data.birthdate && data.gender);

      if (text === '診断開始' && extraCredits === ST.NEED_INPUT) {
        // LINE側の自動応答テンプレに任せる（ここでは無言）
        continue;
      }

      if (hasAll && extraCredits === ST.NEED_INPUT) {
        await showTypingIndicator(userId, 10000);
        const report = await callGPT(SELF_ANALYSIS_MESSAGES(data), OPENAI_MODEL_SELF, requestId);

        const diagNo = generateDiagnosisNumber();
        const premium = `${diagNo}\n\n${data.name}さまのために\n心を込めて紡いだ\n特別な診断結果をお届けします。\n\n${report}`;

        await replyWithQuickReply(replyToken, premium, [
          { type: 'action', action: { type: 'message', label: '🎁 特別プレゼントを受け取る', text: '特別プレゼント' } }
        ]);

        // 期待状態を条件に更新（競合防止）
        await conditionalUpdate(userId, {
          name: data.name,
          birthdate: data.birthdate,
          birthtime: data.birthtime || null,
          gender: data.gender,
          mbti: data.mbti || null,
          self_analysis_result: report,
          diagnosis_number: diagNo,
          extra_credits: ST.AFTER_SELF,
          session_closed: false,
          input_error_count: 0,
          updated_at: new Date().toISOString()
        }, ST.NEED_INPUT, requestId);

      } else if (extraCredits === ST.NEED_INPUT && !hasAll && text !== '診断開始') {
        const hasNumFmt = /①|②|③|④|⑤/.test(text);
        const currentErr = userState.input_error_count || 0;

        if (hasNumFmt && currentErr < 2) {
          const miss = [];
          if (!data.name) miss.push('お名前');
          if (!data.birthdate) miss.push('生年月日');
          if (!data.gender) miss.push('性別');

          await supabase.from('diagnosis_logs').update({
            input_error_count: currentErr + 1,
            updated_at: new Date().toISOString()
          }).eq('line_user_id', userId);

          await safeReplyText(
            replyToken,
            `入力内容をご確認ください✨\n不足：\n${miss.map(m=>`・${m}`).join('\n')}\n\n例）\n①田中花子\n②1990/01/01\n③14:30\n④INFP\n⑤女性`
          );

        } else if (hasNumFmt && currentErr >= 2) {
          // 3回目以降は静かに無視
        } else {
          // ①〜⑤形式以外は無反応
        }
      }
    }

    logger.info('Webhook OK', { took_ms: Date.now() - start, requestId });
    res.sendStatus(200);

  } catch (e) {
    logger.error('Webhook error', { requestId, err: e.message, stack: e.stack });
    await notifyError(e, { requestId, op: 'webhook' });
    try {
      const parsed = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : req.body);
      const rt = parsed?.events?.[0]?.replyToken;
      if (rt) await safeReplyText(rt, 'システムエラーが発生しました。しばらく時間をおいて再度お試しください。');
    } catch {}
    res.sendStatus(200);
  }
});

// ====== ヘルパー関数群 ======
function extractUserData(text) {
  const rx = {
    name: /①.*?[:：]?\s*(.*?)(?=\n|$)/s,
    birthdate: /②.*?[:：]?\s*(.*?)(?=\n|$)/s,
    birthtime: /③.*?[:：]?\s*(.*?)(?=\n|$)/s,
    mbti: /④.*?[:：]?\s*(.*?)(?=\n|$)/s,
    gender: /⑤.*?[:：]?\s*(.*?)(?=\n|$)/s,
  };
  const obj = {};
  for (const [k, r] of Object.entries(rx)) {
    const m = text.match(r);
    obj[k] = m ? m[1].trim().replace(/^(お名前|生年月日.*?|生まれた時間.*?|MBTI.*?|性別.*?)[:：]?\s*/i, '') || null : null;
  }
  return obj;
}

function generateDiagnosisNumber() {
  const d = new Date();
  const y = String(d.getFullYear()).slice(-2);
  const m = String(d.getMonth() + 1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  const r = Math.floor(Math.random()*9000)+1000;
  return `診断番号: ${y}${m}${day}/${r}`;
}

// 期待状態を満たすときだけ更新（行競合の軽減）
async function conditionalUpdate(userId, patch, expectedState, requestId='unknown') {
  const { data: row, error: selErr } = await supabase
    .from('diagnosis_logs').select('extra_credits').eq('line_user_id', userId).single();

  if (selErr) { logger.error('select error', { requestId, err: selErr.message }); return; }
  if (row?.extra_credits !== expectedState) {
    logger.info('state changed, skip update', { requestId, expectedState, got: row?.extra_credits });
    return;
  }

  const { error: upErr } = await supabase.from('diagnosis_logs')
    .update(patch).eq('line_user_id', userId).eq('extra_credits', expectedState);

  if (upErr) logger.error('conditional update error', { requestId, err: upErr.message });
}

// 汎用バックオフ
const sleep = ms => new Promise(r=>setTimeout(r, ms));
async function withRetry(fn, tries=3, base=500) {
  let last;
  for (let i=0;i<tries;i++){
    try { return await fn(); }
    catch(e){ last=e; const j = Math.random()*base; await sleep(Math.min(base*(2**i)+j, 5000)); }
  }
  throw last;
}

// OpenAI呼び出し
async function callGPT(input, model, requestId='unknown') {
  const payload = Array.isArray(input) ? { messages: input } : { messages: [{ role:'user', content: input }] };
  return await withRetry(async () => {
    logger.info('GPT call', { requestId, model, msgCount: payload.messages.length });
    const { data } = await axios.post('https://api.openai.com/v1/chat/completions', {
      model,
      temperature: 0.7,
      max_tokens: 1500,
      ...payload
    }, {
      headers: { Authorization: `Bearer ${GPT_API_KEY}`,'Content-Type':'application/json' },
      timeout: 30_000
    });
    const content = data.choices?.[0]?.message?.content?.trim() || '';
    logger.info('GPT ok', { requestId, tokens: data.usage?.total_tokens || 'n/a', len: content.length });
    return content;
  });
}

// LINE返信（安全版）
async function safeReplyText(replyToken, text) {
  return await withRetry(async () => {
    await axios.post('https://api.line.me/v2/bot/message/reply', {
      replyToken, messages: [{ type: 'text', text }]
    }, {
      headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,'Content-Type':'application/json' },
      timeout: 10_000
    });
  });
}
async function replyWithQuickReply(replyToken, text, quickReplyItems=[]) {
  // LINE互換：clipboard等の非対応タイプを除外
  const items = quickReplyItems.filter(i => ['message','postback','uri','location','camera','cameraRoll','richmenuswitch'].includes(i?.action?.type));
  return await withRetry(async () => {
    await axios.post('https://api.line.me/v2/bot/message/reply', {
      replyToken,
      messages: [{ type: 'text', text, quickReply: { items } }]
    }, {
      headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,'Content-Type':'application/json' },
      timeout: 10_000
    });
  });
}

// タイピング表示
async function showTypingIndicator(userId, duration=10000) {
  const actual = Math.min(duration, 20000);
  try {
    await axios.post('https://api.line.me/v2/bot/chat/loading/start', {
      chatId: userId, loadingSeconds: Math.floor(actual/1000)
    }, {
      headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,'Content-Type':'application/json' },
      timeout: 5000
    });
    await sleep(actual);
  } catch (e) {
    logger.warn('typing indicator failed', { err: e.message });
  }
}

// === ユーザー状態の取得/作成 ===
async function getOrCreateUserState(userId, requestId = 'unknown') {
  try {
    // 既存レコードの取得
    const { data: existing, error: selErr } = await supabase
      .from('diagnosis_logs')
      .select('*')
      .eq('line_user_id', userId)
      .single();

    // 行が無い場合（PGRST116）
    if (selErr?.code === 'PGRST116') {
      logger.info('No user record: creating new', { requestId, userId: userId.slice(0,8)+'***' });

      const { data: inserted, error: insErr } = await supabase
        .from('diagnosis_logs')
        .insert([{
          line_user_id: userId,
          extra_credits: ST.NEED_INPUT,   // 2：入力待ち
          session_closed: false,
          input_error_count: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }])
        .select()
        .single();

      if (insErr) {
        logger.error('create user failed', { requestId, err: insErr.message });
        await notifyError(insErr, { requestId, op: 'createNewUser', userId });
        return null;
      }
      return inserted;
    }

    // 取得時の別エラーはアラート
    if (selErr) {
      logger.error('select user failed', { requestId, err: selErr.message });
      await notifyError(selErr, { requestId, op: 'getUserState', userId });
      return null;
    }

    // 既存ユーザーを返す
    return existing;

  } catch (e) {
    logger.error('getOrCreateUserState exception', { requestId, err: e.message });
    await notifyError(e, { requestId, op: 'getOrCreateUserState', userId });
    return null;
  }
}

// ====== 起動 ======
app.listen(PORT, () => {
  logger.info('Server started', { port: PORT, env: process.env.NODE_ENV || 'development' });
});

// グレースフル
process.on('SIGTERM', ()=>{ logger.info('SIGTERM'); process.exit(0); });
process.on('SIGINT', ()=>{ logger.info('SIGINT'); process.exit(0); });
