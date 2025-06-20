// server.js
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// 環境変数
const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const GPT_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Supabaseクライアント初期化
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

app.use(bodyParser.json());

app.post('/webhook', async (req, res) => {
  const events = req.body.events;
  if (!Array.isArray(events)) return res.sendStatus(200);

  for (const event of events) {
    if (event.type === 'message' && event.message.type === 'text') {
      const userMessage = event.message.text;
      const replyToken = event.replyToken;
      const userId = event.source.userId;

      const userData = extractUserData(userMessage);

      if (userData.name && userData.birthdate && userData.concern) {
        const prompt = generatePrompt(userData);
        const gptResult = await callGPT(prompt);

        // Supabaseへ保存
        await saveToSupabase({
          user_id: userId,
          ...userData,
          diagnosis_result: gptResult
        });

        await replyText(replyToken, gptResult);
      } else {
        await replyText(replyToken, '📝 自己分析を行うために、①お名前、②生年月日、⑥相談内容をご記入ください。');
      }
    }
  }
  res.sendStatus(200);
});

function extractUserData(text) {
  const fields = {};
  const regexMap = {
    name: /①[:：]?\s*(.*?)(?=\n|②|$)/,
    birthdate: /②[:：]?\s*(.*?)(?=\n|③|$)/,
    birthtime: /③[:：]?\s*(.*?)(?=\n|④|$)/,
    mbti: /④[:：]?\s*(.*?)(?=\n|⑤|$)/,
    animal_type: /⑤[:：]?\s*(.*?)(?=\n|⑥|$)/,
    concern: /⑥[:：]?\s*(.*)/
  };

  for (const [key, regex] of Object.entries(regexMap)) {
    const match = text.match(regex);
    fields[key] = match ? match[1].trim() : null;
  }

  return fields;
}

function generatePrompt(data) {
  return `以下の情報をもとに、プロの占い師が監修した自己分析を実施してください。\n
名前：${data.name}
生年月日：${data.birthdate}
生まれた時間：${data.birthtime || '不明'}
MBTI：${data.mbti || '不明'}
動物占い：${data.animal_type || '不明'}
相談内容：${data.concern}

全体で1000文字以内におさめ、やさしい語り口で診断してください。`;
}

async function callGPT(prompt) {
  try {
    const response = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.8
    }, {
      headers: {
        'Authorization': `Bearer ${GPT_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    return response.data.choices[0].message.content.trim();
  } catch (err) {
    console.error('GPT呼び出しエラー:', err.message);
    return '診断中にエラーが発生しました。時間をおいて再試行してください。';
  }
}

async function replyText(replyToken, text) {
  try {
    await axios.post('https://api.line.me/v2/bot/message/reply', {
      replyToken,
      messages: [{ type: 'text', text }]
    }, {
      headers: {
        'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
  } catch (err) {
    console.error('LINE返信エラー:', err.message);
  }
}

async function saveToSupabase(data) {
  try {
    const { error } = await supabase
      .from('diagnosis_logs')
      .insert([data]);

    if (error) throw error;
  } catch (err) {
    console.error('Supabase保存エラー:', err.message);
  }
}

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
