const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const bodyParser = require('body-parser');
const stripeSDK = require('stripe');

// ─────────────────────────────────────────
// 環境変数
// ─────────────────────────────────────────
const CHANNEL_ACCESS_TOKEN   = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const GPT_API_KEY            = process.env.OPENAI_API_KEY;
const SUPABASE_URL           = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const STRIPE_SECRET_KEY      = process.env.STRIPE_SECRET_KEY;      // 追加
const STRIPE_WEBHOOK_SECRET  = process.env.STRIPE_WEBHOOK_SECRET;

// ─────────────────────────────────────────
// 初期化
// ─────────────────────────────────────────
const app       = express();
const PORT      = process.env.PORT || 3000;
const supabase  = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);
const stripe    = stripeSDK(STRIPE_SECRET_KEY);

// ─────────────────────────────────────────
// 1) Stripe Webhook  ― 先に raw で受け取る
// ─────────────────────────────────────────
app.post(
  '/webhook/stripe',
  express.raw({ type: 'application/json' }),      // 生の Buffer を保持
  async (req, res) => {
    const sig = req.headers['stripe-signature'];

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error('[Stripe] Signature verify failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // ── checkout.session.completed ──────────────────────────
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userId  = session.client_reference_id;   // 決済リンクで埋め込んだ ID

      if (userId) {
        const { error } = await supabase
          .from('users')
          .upsert({ id: userId, extra_credits: 5 }, { onConflict: 'id' });

        if (error) console.error('[Supabase] upsert error:', error);
        else       console.log(`[Stripe] credits +5 for user ${userId}`);
      }
    }

    res.status(200).send('OK');
  }
);

// ─────────────────────────────────────────
// 2) ここから通常 API は JSON で受取
// ─────────────────────────────────────────
app.use(bodyParser.json());

// LINE webhook
app.post('/webhook', async (req, res) => {
  const events = req.body.events || [];
  for (const evt of events) {
    if (evt.type !== 'message' || evt.message.type !== 'text') continue;

    const userId      = evt.source.userId;
    const replyToken  = evt.replyToken;
    const userMessage = evt.message.text;

    // ユーザーデータ
    const userData = extractUserData(userMessage);

    // ユーザーレコード取得 / 作成
    const { data: userRow, error } =
      await supabase.from('users').select('*').eq('id', userId).single();

    let credits = 0;
    if (error && error.code === 'PGRST116') {
      // 新規ユーザーは credits=0 で作成
      await supabase.from('users').insert({ id: userId, extra_credits: 0 });
    } else if (!error) {
      credits = userRow.extra_credits;
    }

    // クレジットが無ければストップ
    if (credits <= 0) {
      await replyText(
        replyToken,
        '⚠️ 無料診断は1回限りです。\nサブスク登録すると追加診断がご利用いただけます。'
      );
      continue;
    }

    // 必須項目が揃っていなければリマインド
    if (!(userData.name && userData.birthdate && userData.concern)) {
      await replyText(
        replyToken,
        '📝 自己分析を行うために、①お名前、②生年月日、⑥相談内容をご記入ください。'
      );
      continue;
    }

    // GPT へ
    const prompt = generatePrompt(userData);
    const gptRes = await callGPT(prompt);
    await replyText(replyToken, gptRes);

    // ログ保存 ＆ クレジット減算
    await supabase.from('diagnosis_logs').insert({
      user_id: userId,
      ...userData,
      diagnosis_result: gptRes,
    });
    await supabase
      .from('users')
      .update({ extra_credits: credits - 1 })
      .eq('id', userId);
  }
  res.sendStatus(200);
});

// ─────────────────────────────────────────
// util
// ─────────────────────────────────────────
function extractUserData(text) {
  const map = {
    name: /①[:：]?\s*(.*?)(?=\n|②|$)/s,
    birthdate: /②[:：]?\s*(.*?)(?=\n|③|$)/s,
    birthtime: /③[:：]?\s*(.*?)(?=\n|④|$)/s,
    mbti: /④[:：]?\s*(.*?)(?=\n|⑤|$)/s,
    animal_type: /⑤[:：]?\s*(.*?)(?=\n|⑥|$)/s,
    concern: /⑥[:：]?\s*(.*)/s,
  };
  const out = {};
  for (const [k, rx] of Object.entries(map)) {
    const m = text.match(rx);
    out[k] = m ? m[1].trim() : null;
  }
  return out;
}

function generatePrompt(d) {
  return `以下の情報をもとに、プロの占い師が監修した自己分析を実施してください。
名前：${d.name}
生年月日：${d.birthdate}
生まれた時間：${d.birthtime || '不明'}
MBTI：${d.mbti || '不明'}
動物占い：${d.animal_type || '不明'}
相談内容：${d.concern}
※全体で 1000 文字以内、やさしい語り口でまとめること`;
}

async function callGPT(prompt) {
  try {
    const { data } = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.8,
      },
      {
        headers: {
          Authorization: `Bearer ${GPT_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );
    return data.choices[0].message.content.trim();
  } catch (e) {
    console.error('[GPT] error:', e.message);
    return '診断中にエラーが発生しました。時間をおいて再試行してください。';
  }
}

async function replyText(token, text) {
  try {
    await axios.post(
      'https://api.line.me/v2/bot/message/reply',
      { replyToken: token, messages: [{ type: 'text', text }] },
      {
        headers: {
          Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (e) {
    console.error('[LINE] reply error:', e.message);
  }
}

// ─────────────────────────────────────────
app.listen(PORT, () => console.log(`Server on ${PORT}`));
{
  "dependencies": {
    "stripe": "^14.6.0"          // 追加
  }
}
