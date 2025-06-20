const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// 環境変数
const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const GPT_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// LINE用
app.use(bodyParser.json());

// Stripe用（生のリクエストを保持）
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed.', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.client_reference_id;

    if (userId) {
      const { error } = await supabase
        .from('users')
        .update({ extra_credits: 5 })
        .eq('id', userId);

      if (error) console.error('Supabase update error:', error);
    }
  }

  res.status(200).send('Received');
});

// LINE webhook
app.post('/webhook', async (req, res) => {
  const events = req.body.events;
  if (!Array.isArray(events)) return res.sendStatus(200);

  for (const event of events) {
    if (event.type === 'message' && event.message.type === 'text') {
      const userMessage = event.message.text;
      const replyToken = event.replyToken;
      const userId = event.source.userId;

      const userData = extractUserData(userMessage);
      const { data: user, error } = await supabase.from('users').select('*').eq('id', userId).single();

      if (error) {
        await supabase.from('users').insert({ id: userId, extra_credits: 0 });
        return await replyText(replyToken, 'まずは診断を始めましょう。①〜⑥を入力してください。');
      }

      if (user.extra_credits <= 0) {
        return await replyText(replyToken, '⚠️ 無料診断は1回限りです。サブスク登録で追加の診断が可能です。');
      }

      if (userData.name && userData.birthdate && userData.concern) {
        const prompt = generatePrompt(userData);
        const gptResult = await callGPT(prompt);

        await replyText(replyToken, gptResult);

        // 保存とクレジット減算
        await supabase.from('diagnosis_logs').insert({
          user_id: userId,
          ...userData,
          diagnosis_result: gptResult,
        });

        await supabase.from('users').update({ extra_credits: user.extra_credits - 1 }).eq('id', userId);
      } else {
        await replyText(replyToken, '📝 自己分析を行うために、①お名前、②生年月日、⑥相談内容をご記入ください。');
      }
    }
  }

  res.sendStatus(200);
});

// ユーザーデータ抽出
function extractUserData(text) {
  const fields = {};
  const regexMap = {
    name: /①[:：]?\s*(.*?)(?=\n|②|$)/,
    birthdate: /②[:：]?\s*(.*?)(?=\n|③|$)/,
    birthtime: /③[:：]?\s*(.*?)(?=\n|④|$)/,
    mbti: /④[:：]?\s*(.*?)(?=\n|⑤|$)/,
    animal_type: /⑤[:：]?\s*(.*?)(?=\n|⑥|$)/,
    concern: /⑥[:：]?\s*(.*)/,
  };
  for (const [key, regex] of Object.entries(regexMap)) {
    const match = text.match(regex);
    fields[key] = match ? match[1].trim() : null;
  }
  return fields;
}

// GPTへプロンプト送信
function generatePrompt(data) {
  return `以下の情報をもとに、プロの占い師が監修した自己分析を実施してください。\n
名前：${data.name}\n
生年月日：${data.birthdate}\n
生まれた時間：${data.birthtime || '不明'}\n
MBTI：${data.mbti || '不明'}\n
動物占い：${data.animal_type || '不明'}\n
相談内容：${data.concern}\n
\n全体で1000文字以内におさめ、やさしい語り口で診断してください。`;
}

async function callGPT(prompt) {
  try {
    const res = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.8,
    }, {
      headers: {
        Authorization: `Bearer ${GPT_API_KEY}`,
        'Content-Type': 'application/json',
      },
    });
    return res.data.choices[0].message.content.trim();
  } catch (err) {
    console.error('GPT呼び出しエラー:', err.message);
    return '診断中にエラーが発生しました。時間をおいて再試行してください。';
  }
}

async function replyText(replyToken, text) {
  try {
    await axios.post('https://api.line.me/v2/bot/message/reply', {
      replyToken,
      messages: [{ type: 'text', text }],
    }, {
      headers: {
        Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
  } catch (err) {
    console.error('LINE返信エラー:', err.message);
  }
}

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
